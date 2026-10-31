//! Generates the dataset on worker threads and loads it in plan order through `pika::ingest::apply`, as devices
//! upload: each batch holds one device's next chunk of every stream it has open, so a session's lines interleave
//! with the other sessions active at the same time.

use std::collections::{BTreeMap, HashSet, VecDeque};
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Condvar, Mutex, mpsc};
use std::time::Instant;

use anyhow::{Context, Result, ensure};
use pika::ingest::{self, Assistant, Batch, Blob, Document, Request, StreamBatch};
use pika::store::Store;
use pika::util::sha256_hex;
use serde_json::json;

use crate::dataset::{self, Config, FamilyOut, Generator, Plan, RequestOut, StreamOut};
use crate::text::{IDIOMS, Vocab};

/// Streams open at once across all devices.
const ACTIVE_STREAMS: usize = 12;
const CHUNK_LINES: usize = 64;
/// The extension keeps batches under 8 MiB.
const MAX_BATCH_BYTES: usize = 8 << 20;
/// Families generated ahead of the loader.
const AHEAD: usize = 64;

struct Open {
    device: usize,
    stream: StreamOut,
    next: usize,
    offset: u64,
}

#[derive(Default)]
struct Totals {
    entries: u64,
    line_bytes: u64,
    batches: u64,
    requests: u64,
    blobs: u64,
    blob_bytes: u64,
}

struct Loader<'a> {
    store: &'a Store,
    sent_blobs: HashSet<String>,
    totals: Totals,
}

impl Loader<'_> {
    fn apply(&mut self, device: usize, batch: &Batch) -> Result<ingest::BatchResponse> {
        self.totals.batches += 1;
        ingest::apply(self.store, dataset::DEVICES[device], batch).map_err(|e| anyhow::anyhow!("ingest failed: {e}"))
    }

    /// Sends the next chunk of every open stream, one batch per device.
    fn round(&mut self, open: &mut [Open]) -> Result<()> {
        for device in 0..dataset::DEVICES.len() {
            let mut batch = Batch::default();
            let mut bytes = 0;
            let mut sent = Vec::new();
            for (i, o) in open.iter().enumerate().filter(|(_, o)| o.device == device) {
                if bytes >= MAX_BATCH_BYTES {
                    break;
                }
                let mut lines = Vec::new();
                let mut end = o.next;
                while end < o.stream.lines.len() && lines.len() < CHUNK_LINES && bytes < MAX_BATCH_BYTES {
                    bytes += o.stream.lines[end].len() + 1;
                    lines.push(o.stream.lines[end].clone());
                    end += 1;
                }
                let length: u64 = lines.iter().map(|l| l.len() as u64 + 1).sum();
                batch.streams.push(StreamBatch {
                    key: o.stream.key.clone(),
                    kind: o.stream.kind.to_owned(),
                    offset: o.offset,
                    lines,
                    path: (o.next == 0).then(|| o.stream.path.clone()),
                    meta: None,
                });
                sent.push((i, end, o.offset + length));
            }
            if batch.streams.is_empty() {
                continue;
            }
            let response = self.apply(device, &batch)?;
            for (i, end, length) in sent {
                let o = &mut open[i];
                let got = response.streams[&o.stream.key].length;
                ensure!(got == length, "{} has length {got}, expected {length}", o.stream.key);
                self.totals.entries += (end - o.next) as u64;
                self.totals.line_bytes += length - o.offset;
                o.next = end;
                o.offset = length;
            }
        }
        Ok(())
    }

    /// Sends a finished session's captured requests with the blocks the server has not acknowledged.
    fn requests(&mut self, device: usize, session_id: &str, requests: Vec<RequestOut>) -> Result<()> {
        let mut batch = Batch::default();
        let mut bytes = 0;
        for r in requests {
            for (hash, data) in r.blocks {
                if self.sent_blobs.insert(hash.clone()) {
                    bytes += data.len();
                    self.totals.blobs += 1;
                    self.totals.blob_bytes += data.len() as u64;
                    batch.blobs.push(Blob { hash, data });
                }
            }
            bytes += r.skeleton.to_string().len();
            batch.requests.push(Request {
                id: r.id,
                session_id: session_id.to_owned(),
                seq: Some(r.seq),
                at: Some(r.at),
                fidelity: r.fidelity.to_owned(),
                provider: Some(dataset::MODELS[r.model].provider.to_owned()),
                api: Some(dataset::MODELS[r.model].api.to_owned()),
                model: Some(dataset::MODELS[r.model].id.to_owned()),
                assistant: Some(Assistant { timestamp: Some(r.assistant_ts), response_id: Some(r.response_id) }),
                skeleton: r.skeleton,
                blocks: r.hashes,
                timing: Some(r.timing),
            });
            self.totals.requests += 1;
            if bytes >= MAX_BATCH_BYTES / 2 {
                self.flush_requests(device, &mut batch)?;
                bytes = 0;
            }
        }
        self.flush_requests(device, &mut batch)
    }

    fn flush_requests(&mut self, device: usize, batch: &mut Batch) -> Result<()> {
        if batch.requests.is_empty() && batch.blobs.is_empty() {
            return Ok(());
        }
        let response = self.apply(device, batch)?;
        ensure!(response.missing_blobs.is_empty(), "the server misses blobs {:?}", response.missing_blobs);
        *batch = Batch::default();
        Ok(())
    }
}

/// Generates families on `threads` workers and hands them to `consume` in plan order.
fn generate_in_order(plan: &Plan, vocab: &Vocab, threads: usize, mut consume: impl FnMut(FamilyOut) -> Result<()>) -> Result<()> {
    let generator = Generator { plan, vocab };
    let next = AtomicUsize::new(0);
    // The index the consumer waits for; workers stay within AHEAD of it.
    let consumed = (Mutex::new(0usize), Condvar::new());
    let (tx, rx) = mpsc::sync_channel::<(usize, FamilyOut)>(AHEAD);
    std::thread::scope(|scope| {
        for _ in 0..threads {
            let tx = tx.clone();
            let (next, consumed, generator) = (&next, &consumed, &generator);
            scope.spawn(move || {
                loop {
                    let i = next.fetch_add(1, Ordering::Relaxed);
                    if i >= plan.families.len() {
                        break;
                    }
                    {
                        let mut done = consumed.0.lock().unwrap();
                        while i >= *done + AHEAD {
                            done = consumed.1.wait(done).unwrap();
                        }
                    }
                    let out = generator.family(&plan.families[i]);
                    if tx.send((i, out)).is_err() {
                        break;
                    }
                }
            });
        }
        drop(tx);
        let mut waiting = BTreeMap::new();
        let mut want = 0;
        let result = (|| {
            for (i, out) in rx.iter() {
                waiting.insert(i, out);
                while let Some(out) = waiting.remove(&want) {
                    want += 1;
                    *consumed.0.lock().unwrap() = want;
                    consumed.1.notify_all();
                    consume(out)?;
                }
            }
            ensure!(want == plan.families.len(), "generated {want} of {} families", plan.families.len());
            Ok(())
        })();
        if result.is_err() {
            // Release the workers so the scope can end.
            *consumed.0.lock().unwrap() = usize::MAX / 2;
            consumed.1.notify_all();
            drop(rx);
        }
        result
    })
}

pub fn run(data_dir: &Path, plan_path: &Path, stats_path: &Path, config: Config) -> Result<()> {
    ensure!(!data_dir.join("pika.db").exists(), "{} already holds a database", data_dir.display());
    let started = Instant::now();
    let vocab = Vocab::new();
    let plan = Plan::new(config, &vocab);
    write_plan(&plan, &vocab, plan_path)?;
    eprintln!(
        "perf: generating and loading {} sessions in {} families ({} planned entries)",
        plan.sessions.len(),
        plan.families.len(),
        plan.sessions.iter().map(|s| s.size).sum::<usize>()
    );
    let store = Store::open(data_dir)?;
    let mut loader = Loader { store: &store, sent_blobs: HashSet::new(), totals: Totals::default() };
    let mut open: Vec<Open> = Vec::new();
    let mut queue: VecDeque<(usize, StreamOut)> = VecDeque::new();
    let threads = std::thread::available_parallelism().map_or(4, |n| n.get()).saturating_sub(1).max(2);
    let mut families = 0usize;
    let mut last_report = Instant::now();

    let drain = |loader: &mut Loader, open: &mut Vec<Open>, queue: &mut VecDeque<(usize, StreamOut)>, all: bool| -> Result<()> {
        loop {
            while open.len() < ACTIVE_STREAMS
                && let Some((device, stream)) = queue.pop_front()
            {
                open.push(Open { device, stream, next: 0, offset: 0 });
            }
            if open.is_empty() || (!all && open.len() < ACTIVE_STREAMS) {
                return Ok(());
            }
            loader.round(open)?;
            let mut i = 0;
            while i < open.len() {
                if open[i].next == open[i].stream.lines.len() {
                    let done = open.remove(i);
                    let requests = done.stream.requests;
                    if !requests.is_empty() {
                        let id = done.stream.key.trim_start_matches("session:").to_owned();
                        loader.requests(done.device, &id, requests)?;
                    }
                } else {
                    i += 1;
                }
            }
        }
    };

    generate_in_order(&plan, &vocab, threads, |family| {
        families += 1;
        if !family.documents.is_empty() {
            let documents = family
                .documents
                .into_iter()
                .map(|d| Document {
                    sha256: Some(sha256_hex(d.content.as_bytes())),
                    key: d.key,
                    kind: d.kind.to_owned(),
                    run_id: Some(d.run_id),
                    content: d.content,
                })
                .collect();
            loader.apply(family.device, &Batch { documents, ..Batch::default() })?;
        }
        queue.extend(family.streams.into_iter().map(|s| (family.device, s)));
        drain(&mut loader, &mut open, &mut queue, false)?;
        if last_report.elapsed().as_secs() >= 15 {
            last_report = Instant::now();
            eprintln!(
                "perf: {families}/{} families, {} entries, {:.0} s",
                plan.families.len(),
                loader.totals.entries,
                started.elapsed().as_secs_f64()
            );
        }
        Ok(())
    })?;
    drain(&mut loader, &mut open, &mut queue, true)?;

    let seconds = started.elapsed().as_secs_f64();
    let t = loader.totals;
    // Closing the last connection checkpoints the WAL into the database.
    drop(store);
    let stats = json!({
        "loadSeconds": seconds,
        "entries": t.entries,
        "entriesPerSecond": t.entries as f64 / seconds,
        "lineBytes": t.line_bytes,
        "batches": t.batches,
        "requests": t.requests,
        "blocks": t.blobs,
        "blockBytes": t.blob_bytes,
        "threads": threads,
    });
    std::fs::write(stats_path, stats.to_string()).with_context(|| format!("writing {}", stats_path.display()))?;
    eprintln!("perf: loaded {} entries in {seconds:.1} s ({:.0} entries/s)", t.entries, t.entries as f64 / seconds);
    Ok(())
}

/// What the bench needs to know about the dataset: filter values, the large sessions, and search terms by rank.
fn write_plan(plan: &Plan, vocab: &Vocab, path: &Path) -> Result<()> {
    let generator = Generator { plan, vocab };
    let ids = |size: usize| -> Vec<String> {
        plan.sessions.iter().enumerate().filter(|(_, s)| s.size == size).map(|(i, _)| generator.session_id(i)).collect()
    };
    let value = json!({
        "devices": dataset::DEVICES,
        "projects": plan.projects,
        "models": dataset::MODELS.iter().map(|m| m.id).collect::<Vec<_>>(),
        "startMs": dataset::START_MS,
        "endMs": dataset::START_MS + plan.config.days * dataset::DAY_MS,
        "sessions": plan.sessions.len(),
        "entries": plan.sessions.iter().map(|s| s.size as u64).sum::<u64>(),
        "herderRuns": plan.runs.len(),
        "requestSessions": plan.sessions.iter().filter(|s| s.requests).count(),
        "bigSessions": ids(dataset::BIG_SIZE),
        "hugeSessions": ids(dataset::HUGE_SIZE),
        "commonWords": vocab.words[..100],
        "midWords": vocab.words[1_000..5_000],
        "rareWords": vocab.words[12_000..],
        "idioms": IDIOMS,
    });
    std::fs::write(path, value.to_string()).with_context(|| format!("writing {}", path.display()))
}
