//! The bench client: sequential GETs over one keep-alive HTTP/1.1 connection, with randomized parameters from a
//! fixed seed, timed from the first request byte to the last response byte.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, anyhow, bail, ensure};
use pika::util::{encode_path_segment, format_iso_ms};
use serde_json::{Value, json};

use crate::rng::Rng;

const SEED: u64 = 0x6265_6e63_6870_696b;
pub const SAMPLES: usize = 400;
const WARMUP: usize = 40;
/// Sections of the bench, for `--only`.
pub const SECTIONS: &[&str] = &["list", "session", "search"];

struct Client {
    addr: String,
    prefix: String,
    conn: Option<BufReader<TcpStream>>,
}

pub struct Reply {
    pub status: u16,
    pub body: Vec<u8>,
    pub elapsed: Duration,
}

impl Reply {
    pub fn json(&self) -> Result<Value> {
        serde_json::from_slice(&self.body).context("response is not JSON")
    }
}

impl Client {
    fn connect(&mut self) -> Result<&mut BufReader<TcpStream>> {
        if self.conn.is_none() {
            let stream = TcpStream::connect(&self.addr).with_context(|| format!("connecting to {}", self.addr))?;
            stream.set_nodelay(true)?;
            stream.set_read_timeout(Some(Duration::from_secs(60)))?;
            self.conn = Some(BufReader::with_capacity(1 << 16, stream));
        }
        Ok(self.conn.as_mut().unwrap())
    }

    fn exchange(&mut self, path: &str) -> Result<Reply> {
        let request = format!("GET {path} HTTP/1.1\r\nHost: {}\r\nAccept: application/json\r\n\r\n", self.addr);
        let conn = self.connect()?;
        let started = Instant::now();
        conn.get_mut().write_all(request.as_bytes())?;
        let mut line = String::new();
        if conn.read_line(&mut line)? == 0 {
            bail!("connection closed");
        }
        let status: u16 = line.split_whitespace().nth(1).and_then(|s| s.parse().ok()).ok_or_else(|| anyhow!("bad status line {line:?}"))?;
        let (mut length, mut chunked, mut close) = (None, false, false);
        loop {
            line.clear();
            conn.read_line(&mut line)?;
            let header = line.trim_end();
            if header.is_empty() {
                break;
            }
            let (name, value) = header.split_once(':').ok_or_else(|| anyhow!("bad header {header:?}"))?;
            let value = value.trim();
            match name.to_ascii_lowercase().as_str() {
                "content-length" => length = Some(value.parse::<usize>()?),
                "transfer-encoding" => chunked = value.eq_ignore_ascii_case("chunked"),
                "connection" => close = value.eq_ignore_ascii_case("close"),
                _ => {}
            }
        }
        let mut body = Vec::new();
        if chunked {
            loop {
                line.clear();
                conn.read_line(&mut line)?;
                let size = usize::from_str_radix(line.trim().split(';').next().unwrap_or(""), 16)?;
                if size == 0 {
                    line.clear();
                    conn.read_line(&mut line)?;
                    break;
                }
                let start = body.len();
                body.resize(start + size, 0);
                conn.read_exact(&mut body[start..])?;
                let mut crlf = [0u8; 2];
                conn.read_exact(&mut crlf)?;
            }
        } else if let Some(length) = length {
            body.resize(length, 0);
            conn.read_exact(&mut body)?;
        } else {
            conn.read_to_end(&mut body)?;
            close = true;
        }
        let elapsed = started.elapsed();
        if close {
            self.conn = None;
        }
        Ok(Reply { status, body, elapsed })
    }

    /// GETs a read API path relative to `{base}/api/v1/`; a stale keep-alive connection is retried once.
    fn get(&mut self, rel: &str) -> Result<Reply> {
        let path = format!("{}/api/v1/{rel}", self.prefix);
        let reply = match self.exchange(&path) {
            Ok(reply) => reply,
            Err(_) => {
                self.conn = None;
                self.exchange(&path)?
            }
        };
        ensure!(reply.status == 200, "GET {path}: {} {}", reply.status, String::from_utf8_lossy(&reply.body));
        Ok(reply)
    }
}

fn q(value: &str) -> String {
    encode_path_segment(value)
}

struct Plan {
    devices: Vec<String>,
    projects: Vec<String>,
    models: Vec<String>,
    start_ms: i64,
    end_ms: i64,
    big: Vec<String>,
    huge: Vec<String>,
    common: Vec<String>,
    mid: Vec<String>,
    rare: Vec<String>,
    idioms: Vec<String>,
}

fn strings(v: &Value, key: &str) -> Result<Vec<String>> {
    v[key]
        .as_array()
        .ok_or_else(|| anyhow!("plan lacks {key}"))?
        .iter()
        .map(|s| s.as_str().map(str::to_owned).ok_or_else(|| anyhow!("plan {key} holds a non-string")))
        .collect()
}

impl Plan {
    fn read(path: &Path) -> Result<Plan> {
        let v: Value = serde_json::from_slice(&std::fs::read(path)?)?;
        Ok(Plan {
            devices: strings(&v, "devices")?,
            projects: strings(&v, "projects")?,
            models: strings(&v, "models")?,
            start_ms: v["startMs"].as_i64().ok_or_else(|| anyhow!("plan lacks startMs"))?,
            end_ms: v["endMs"].as_i64().ok_or_else(|| anyhow!("plan lacks endMs"))?,
            big: strings(&v, "bigSessions")?,
            huge: strings(&v, "hugeSessions")?,
            common: strings(&v, "commonWords")?,
            mid: strings(&v, "midWords")?,
            rare: strings(&v, "rareWords")?,
            idioms: strings(&v, "idioms")?,
        })
    }
}

/// One measured query class: samples tagged with their subclasses, and the p95 limit when it gates the result.
struct Class {
    name: &'static str,
    limit_ms: Option<f64>,
    samples: Vec<(Vec<String>, f64)>,
    empty: usize,
}

impl Class {
    fn new(name: &'static str, limit_ms: Option<f64>) -> Class {
        Class { name, limit_ms, samples: Vec::new(), empty: 0 }
    }

    fn stats(values: &mut [f64]) -> (f64, f64, f64) {
        values.sort_by(f64::total_cmp);
        let at = |p: f64| values[((values.len() as f64 * p).ceil() as usize).clamp(1, values.len()) - 1];
        (at(0.50), at(0.95), *values.last().unwrap())
    }

    fn summary(&self) -> Value {
        let mut all: Vec<f64> = self.samples.iter().map(|(_, ms)| *ms).collect();
        let (p50, p95, max) = Class::stats(&mut all);
        let mut subclasses: Vec<&str> = self.samples.iter().flat_map(|(tags, _)| tags.iter().map(String::as_str)).collect();
        subclasses.sort();
        subclasses.dedup();
        let sub: serde_json::Map<String, Value> = subclasses
            .iter()
            .map(|name| {
                let mut values: Vec<f64> =
                    self.samples.iter().filter(|(tags, _)| tags.iter().any(|t| t == name)).map(|(_, ms)| *ms).collect();
                let n = values.len();
                let (p50, p95, max) = Class::stats(&mut values);
                (name.to_string(), json!({ "n": n, "p50": p50, "p95": p95, "max": max }))
            })
            .collect();
        json!({ "n": all.len(), "p50": p50, "p95": p95, "max": max, "limitP95": self.limit_ms,
                "pass": self.limit_ms.is_none_or(|limit| p95 < limit), "emptyResults": self.empty, "subclasses": sub })
    }
}

fn time_param(rng: &mut Rng, ms: i64) -> String {
    match rng.below(3) {
        0 => ms.to_string(),
        1 => format_iso_ms(ms)[..10].to_owned(),
        _ => format_iso_ms(ms),
    }
}

/// A random session list query and its subclasses: each filter it uses, or `no filter`, and `combination` for two or
/// more.
fn session_list_query(rng: &mut Rng, plan: &Plan) -> (String, Vec<String>) {
    let mut params = vec!["limit=50".to_owned()];
    let mut parts = Vec::new();
    if rng.chance(0.4) {
        params.push("root=true".into());
        parts.push("root");
    }
    if rng.chance(0.35) {
        params.push(format!("device={}", q(rng.pick(&plan.devices))));
        parts.push("device");
    }
    if rng.chance(0.35) {
        params.push(format!("project={}", q(rng.pick(&plan.projects))));
        parts.push("project");
    }
    if rng.chance(0.3) {
        params.push(format!("model={}", q(rng.pick(&plan.models))));
        parts.push("model");
    }
    if rng.chance(0.35) {
        let span = plan.end_ms - plan.start_ms;
        let from = plan.start_ms + (rng.f64() * span as f64) as i64;
        let to = from + rng.range(1, 60) * 86_400_000;
        match rng.below(3) {
            0 => params.push(format!("from={}", q(&time_param(rng, from)))),
            1 => params.push(format!("to={}", q(&time_param(rng, to)))),
            _ => {
                params.push(format!("from={}", q(&time_param(rng, from))));
                params.push(format!("to={}", q(&time_param(rng, to))));
            }
        }
        parts.push("dates");
    }
    let mut tags: Vec<String> = parts.iter().map(|p| p.to_string()).collect();
    match parts.len() {
        0 => tags.push("no filter".into()),
        1 => {}
        _ => tags.push("combination".into()),
    }
    (format!("sessions?{}", params.join("&")), tags)
}

/// A random search and its subclasses: the kind of query with its sort, and its filters.
fn search_query(rng: &mut Rng, plan: &Plan) -> (String, Vec<String>) {
    let (q_text, kind) = match rng.below(4) {
        0 => (rng.pick(&plan.common).clone(), "common"),
        1 => (rng.pick(&plan.rare).clone(), "rare"),
        2 => {
            let first = if rng.chance(0.5) { rng.pick(&plan.common) } else { rng.pick(&plan.mid) };
            (format!("{first} {}", rng.pick(&plan.mid)), "two-word")
        }
        _ => {
            if rng.chance(0.5) {
                (format!("\"{}\"", rng.pick(&plan.idioms)), "phrase")
            } else {
                (format!("\"{} {}\"", rng.pick(&plan.common[..30]), rng.pick(&plan.common[..30])), "phrase")
            }
        }
    };
    let mut params = vec![format!("q={}", q(&q_text))];
    let filter = match rng.below(4) {
        0 => "all",
        1 => {
            params.push(format!("device={}", q(rng.pick(&plan.devices))));
            "device"
        }
        2 => {
            params.push(format!("project={}", q(rng.pick(&plan.projects))));
            "project"
        }
        _ => {
            params.push(format!("device={}", q(rng.pick(&plan.devices))));
            params.push(format!("project={}", q(rng.pick(&plan.projects))));
            "device+project"
        }
    };
    let sort = if rng.chance(0.35) {
        params.push("sort=relevance".into());
        "relevance"
    } else {
        "newest"
    };
    (format!("search?{}", params.join("&")), vec![format!("{kind} {sort}"), format!("filter {filter}")])
}

fn items(reply: &Reply) -> Result<usize> {
    Ok(reply.json()?["items"].as_array().map_or(0, Vec::len))
}

/// Samples the server's resident set size every 100 ms with `ps`.
fn watch_rss(pid: u32, stop: Arc<AtomicBool>, peak: Arc<AtomicU64>) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        while !stop.load(Ordering::Relaxed) {
            if let Ok(out) = std::process::Command::new("ps").args(["-o", "rss=", "-p", &pid.to_string()]).output()
                && let Ok(kib) = String::from_utf8_lossy(&out.stdout).trim().parse::<u64>()
            {
                peak.fetch_max(kib * 1024, Ordering::Relaxed);
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    })
}

fn dir_bytes(path: &Path) -> u64 {
    let Ok(entries) = std::fs::read_dir(path) else { return 0 };
    entries
        .flatten()
        .map(|e| match e.file_type() {
            Ok(t) if t.is_dir() => dir_bytes(&e.path()),
            _ => e.metadata().map_or(0, |m| m.len()),
        })
        .sum()
}

pub struct Options<'a> {
    pub addr: String,
    pub base_path: String,
    pub plan: &'a Path,
    pub data_dir: &'a Path,
    pub pid: Option<u32>,
    pub load_stats: Option<&'a Path>,
    pub shape: Option<&'a Path>,
    /// The sections to run; a partial run never passes.
    pub only: Vec<String>,
    pub samples: usize,
}

/// Runs every class and prints the table and a JSON line; returns whether every gated class met its limit.
pub fn run(options: Options) -> Result<bool> {
    let plan = Plan::read(options.plan)?;
    let prefix = options.base_path.trim_end_matches('/').to_owned();
    let mut client = Client { addr: options.addr.clone(), prefix, conn: None };
    let stop = Arc::new(AtomicBool::new(false));
    let peak = Arc::new(AtomicU64::new(0));
    let watcher = options.pid.map(|pid| watch_rss(pid, stop.clone(), peak.clone()));
    let mut rng = Rng::new(SEED);
    let mut failures: Vec<String> = Vec::new();
    let run_section = |name: &str| options.only.is_empty() || options.only.iter().any(|o| o == name);
    let samples = options.samples;
    if !options.only.is_empty() || samples < SAMPLES {
        failures.push(format!("a partial run ({:?}, {samples} samples) does not count", options.only));
    }

    let mut list = Class::new("session list", Some(100.0));
    let mut detail = Class::new("5k session: sessions/:id", Some(200.0));
    let mut turns = Class::new("5k session: turns", Some(200.0));
    let mut entries = Class::new("5k session: entries", Some(200.0));
    let mut huge_detail = Class::new("20k session: sessions/:id", None);
    let mut huge_turns = Class::new("20k session: turns", None);
    let mut huge_entries = Class::new("20k session: entries", None);
    let mut search = Class::new("search", Some(300.0));

    // Session list, with a second page through the cursor after some first pages.
    for i in 0..if run_section("list") { WARMUP + samples } else { 0 } {
        let (path, tags) = session_list_query(&mut rng, &plan);
        let reply = client.get(&path)?;
        let page = reply.json()?;
        let measured = i >= WARMUP;
        if measured {
            let broad = tags == ["no filter"] || tags == ["root"];
            list.samples.push((tags, reply.elapsed.as_secs_f64() * 1e3));
            if page["items"].as_array().is_none_or(Vec::is_empty) {
                list.empty += 1;
                if broad {
                    failures.push(format!("{path} returned no sessions"));
                }
            }
        }
        if let Some(cursor) = page["nextCursor"].as_str()
            && rng.chance(0.3)
        {
            let reply = client.get(&format!("{path}&cursor={}", q(cursor)))?;
            if measured {
                list.samples.push((vec!["second page".into()], reply.elapsed.as_secs_f64() * 1e3));
            }
        }
    }

    // The first page of the large sessions: the summary with children, the turns, and the first entries.
    for (ids, d, t, e, n) in [
        (&plan.big, &mut detail, &mut turns, &mut entries, samples),
        (&plan.huge, &mut huge_detail, &mut huge_turns, &mut huge_entries, samples / 4),
    ] {
        ensure!(!ids.is_empty(), "the plan names no large sessions");
        for i in 0..if run_section("session") { WARMUP / 4 + n } else { 0 } {
            let id = q(rng.pick(ids));
            let measured = i >= WARMUP / 4;
            let reply = client.get(&format!("sessions/{id}"))?;
            if measured {
                d.samples.push((Vec::new(), reply.elapsed.as_secs_f64() * 1e3));
            }
            let reply = client.get(&format!("sessions/{id}/turns"))?;
            if measured {
                t.samples.push((Vec::new(), reply.elapsed.as_secs_f64() * 1e3));
                if items(&reply)? == 0 {
                    t.empty += 1;
                    failures.push(format!("sessions/{id}/turns returned no turns"));
                }
            }
            let reply = client.get(&format!("sessions/{id}/entries?from=0&limit=200"))?;
            if measured {
                e.samples.push((Vec::new(), reply.elapsed.as_secs_f64() * 1e3));
                if items(&reply)? != 200 {
                    e.empty += 1;
                    failures.push(format!("sessions/{id}/entries did not return 200 entries"));
                }
            }
        }
    }

    for i in 0..if run_section("search") { WARMUP + samples } else { 0 } {
        let (path, tags) = search_query(&mut rng, &plan);
        let reply = client.get(&path)?;
        if i >= WARMUP {
            let broad = tags[0].starts_with("common") && tags[1] == "filter all";
            search.samples.push((tags, reply.elapsed.as_secs_f64() * 1e3));
            if items(&reply)? == 0 {
                search.empty += 1;
                if broad {
                    failures.push(format!("{path} found nothing"));
                }
            }
        }
    }

    stop.store(true, Ordering::Relaxed);
    if let Some(watcher) = watcher {
        let _ = watcher.join();
    }

    let classes = [&list, &detail, &turns, &entries, &huge_detail, &huge_turns, &huge_entries, &search];
    println!();
    println!("{:<28} {:>5} {:>9} {:>9} {:>9} {:>9}  result", "query class", "n", "p50 ms", "p95 ms", "max ms", "limit");
    let mut summaries = serde_json::Map::new();
    let mut pass = failures.is_empty();
    for class in classes.into_iter().filter(|c| !c.samples.is_empty()) {
        let s = class.summary();
        let limit = class.limit_ms.map_or("-".to_owned(), |l| format!("< {l:.0}"));
        let ok = s["pass"].as_bool().unwrap_or(false);
        pass &= ok;
        println!(
            "{:<28} {:>5} {:>9.1} {:>9.1} {:>9.1} {:>9}  {}",
            class.name,
            s["n"],
            s["p50"].as_f64().unwrap_or(0.0),
            s["p95"].as_f64().unwrap_or(0.0),
            s["max"].as_f64().unwrap_or(0.0),
            limit,
            if class.limit_ms.is_none() { "info" } else if ok { "ok" } else { "FAIL" }
        );
        summaries.insert(class.name.to_owned(), s);
    }
    println!();
    println!("{:<34} {:>5} {:>9} {:>9} {:>9}", "subclass", "n", "p50 ms", "p95 ms", "max ms");
    for class in [&list, &search] {
        if let Some(sub) = summaries.get(class.name).and_then(|s| s["subclasses"].as_object()) {
            for (name, s) in sub {
                println!(
                    "{:<34} {:>5} {:>9.1} {:>9.1} {:>9.1}",
                    format!("{}: {name}", class.name),
                    s["n"],
                    s["p50"].as_f64().unwrap_or(0.0),
                    s["p95"].as_f64().unwrap_or(0.0),
                    s["max"].as_f64().unwrap_or(0.0)
                );
            }
        }
    }

    let read_json = |path: Option<&Path>| -> Value {
        path.and_then(|p| std::fs::read(p).ok()).and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or(Value::Null)
    };
    let load = read_json(options.load_stats);
    let db_bytes: u64 = ["pika.db", "pika.db-wal", "pika.db-shm"]
        .iter()
        .filter_map(|f| std::fs::metadata(options.data_dir.join(f)).ok())
        .map(|m| m.len())
        .sum();
    let blob_bytes = dir_bytes(&options.data_dir.join("blobs"));
    let peak_rss = peak.load(Ordering::Relaxed);
    let mib = |b: u64| b as f64 / (1 << 20) as f64;
    println!();
    if !load.is_null() {
        println!(
            "load: {:.1} s, {} entries, {:.0} entries/s, {:.0} MiB of lines",
            load["loadSeconds"].as_f64().unwrap_or(0.0),
            load["entries"],
            load["entriesPerSecond"].as_f64().unwrap_or(0.0),
            mib(load["lineBytes"].as_u64().unwrap_or(0))
        );
    }
    println!("database: {:.0} MiB, blob store: {:.0} MiB, server peak RSS: {:.0} MiB", mib(db_bytes), mib(blob_bytes), mib(peak_rss));
    for failure in &failures {
        println!("FAIL: {failure}");
    }
    println!(
        "{}",
        json!({ "pikaPerf": { "pass": pass, "classes": summaries, "load": load, "shape": read_json(options.shape),
                              "dbBytes": db_bytes, "blobBytes": blob_bytes, "peakRssBytes": peak_rss, "failures": failures } })
    );
    Ok(pass)
}
