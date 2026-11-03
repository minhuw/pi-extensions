use std::collections::{BTreeMap, BTreeSet, HashSet};

use rusqlite::{OptionalExtension, Transaction, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::derive::{self, Line, StreamInfo, StreamKind};
use crate::store::Store;
use crate::util::{is_hash, now_ms, sha256_hex};

/// Lines longer than this are kept in the blob store.
pub const LINE_BLOB_THRESHOLD: usize = 1 << 20;

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Batch {
    #[serde(default)]
    pub client: Option<Value>,
    #[serde(default)]
    pub streams: Vec<StreamBatch>,
    #[serde(default)]
    pub documents: Vec<Document>,
    #[serde(default)]
    pub blobs: Vec<Blob>,
    #[serde(default)]
    pub requests: Vec<Request>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamBatch {
    pub key: String,
    pub kind: String,
    pub offset: u64,
    #[serde(default)]
    pub lines: Vec<String>,
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub meta: Option<Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Document {
    pub key: String,
    pub kind: String,
    #[serde(default)]
    pub run_id: Option<String>,
    pub content: String,
    #[serde(default)]
    pub sha256: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct Blob {
    pub hash: String,
    pub data: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    pub id: String,
    pub session_id: String,
    #[serde(default)]
    pub seq: Option<i64>,
    #[serde(default)]
    pub at: Option<String>,
    pub fidelity: String,
    #[serde(default)]
    pub provider: Option<String>,
    #[serde(default)]
    pub api: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub assistant: Option<Assistant>,
    pub skeleton: Value,
    #[serde(default)]
    pub blocks: Vec<String>,
    /// Kept as a `Value` so that invalid keys are dropped rather than rejecting the request (see `requests::timing`).
    #[serde(default)]
    pub timing: Option<Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Assistant {
    #[serde(default)]
    pub timestamp: Option<i64>,
    #[serde(default)]
    pub response_id: Option<String>,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct StreamLength {
    pub length: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchResponse {
    pub streams: BTreeMap<String, StreamLength>,
    pub missing_blobs: Vec<String>,
}

#[derive(Debug)]
pub enum IngestError {
    BadRequest(String),
    Conflict { key: String, length: u64 },
    Gap { key: String, length: u64 },
    Internal(anyhow::Error),
}

impl From<rusqlite::Error> for IngestError {
    fn from(e: rusqlite::Error) -> Self {
        IngestError::Internal(e.into())
    }
}

impl From<anyhow::Error> for IngestError {
    fn from(e: anyhow::Error) -> Self {
        IngestError::Internal(e)
    }
}

impl std::fmt::Display for IngestError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            IngestError::BadRequest(m) => write!(f, "bad request: {m}"),
            IngestError::Conflict { key, length } => write!(f, "conflict in {key} below {length}"),
            IngestError::Gap { key, length } => write!(f, "gap in {key}: committed length is {length}"),
            IngestError::Internal(e) => write!(f, "{e:#}"),
        }
    }
}

fn bad(message: impl Into<String>) -> IngestError {
    IngestError::BadRequest(message.into())
}

/// A line's stored form: inline text, or the hash of its blob.
enum Stored<'a> {
    Inline(&'a str),
    Blob(String),
}

/// The stream keys of a batch's streams, requests' sessions, and documents' Herder runs that were deleted
/// (`crate::delete`): ingest accepts and discards what it sends for them.
fn tombstones(conn: &rusqlite::Connection, batch: &Batch) -> rusqlite::Result<HashSet<String>> {
    let keys = batch
        .streams
        .iter()
        .map(|s| s.key.clone())
        .chain(batch.requests.iter().map(|r| crate::delete::session_key(&r.session_id)))
        .chain(batch.documents.iter().filter_map(document_run).map(|run| crate::delete::run_key(&run)));
    let mut dead = HashSet::new();
    for key in keys {
        if !dead.contains(&key) && crate::delete::tombstoned(conn, &key)? {
            dead.insert(key);
        }
    }
    Ok(dead)
}

/// The blocks that only discarded requests reference, so the batch need not store them.
fn discarded_blocks<'a>(batch: &'a Batch, dead: &HashSet<String>) -> HashSet<&'a str> {
    let discarded = |r: &Request| dead.contains(&crate::delete::session_key(&r.session_id));
    let kept: HashSet<&str> =
        batch.requests.iter().filter(|r| !discarded(r)).flat_map(|r| r.blocks.iter().map(String::as_str)).collect();
    batch
        .requests
        .iter()
        .filter(|r| discarded(r))
        .flat_map(|r| r.blocks.iter().map(String::as_str))
        .filter(|hash| !kept.contains(hash))
        .collect()
}

/// Validates the batch and writes blob files outside the write lock; the database work runs in one transaction.
/// Lines of deleted streams, requests of deleted sessions, and documents of deleted Herder runs are accepted and
/// discarded: a deleted stream's `length` is the end of the lines sent, so its client moves on without resending it.
/// A session whose recorded parent or Herder run was deleted is deleted with its descendants once the batch is
/// derived (`crate::delete::delete_orphans`); its `length` is the one it reached, and later batches are discarded.
pub fn apply(store: &Store, device: &str, batch: &Batch) -> Result<BatchResponse, IngestError> {
    for blob in &batch.blobs {
        if !is_hash(&blob.hash) {
            return Err(bad(format!("invalid blob hash {:?}", blob.hash)));
        }
        if sha256_hex(blob.data.as_bytes()) != blob.hash {
            return Err(bad(format!("blob {} does not match its hash", blob.hash)));
        }
    }
    let mut kinds = Vec::new();
    let mut stored_lines: Vec<Vec<Stored>> = Vec::new();
    for stream in &batch.streams {
        let kind = StreamKind::parse(&stream.kind).ok_or_else(|| bad(format!("unknown stream kind {:?}", stream.kind)))?;
        match stream.key.strip_prefix(kind.key_prefix()) {
            Some(name) if !name.is_empty() => {}
            _ => return Err(bad(format!("stream key {:?} does not match kind {}", stream.key, kind.as_str()))),
        }
        let mut lines = Vec::new();
        for line in &stream.lines {
            if line.contains('\n') {
                return Err(bad(format!("a line of {} contains a newline", stream.key)));
            }
            if line.len() > LINE_BLOB_THRESHOLD {
                lines.push(Stored::Blob(sha256_hex(line.as_bytes())));
            } else {
                lines.push(Stored::Inline(line));
            }
        }
        kinds.push(kind);
        stored_lines.push(lines);
    }
    for request in &batch.requests {
        if request.id.is_empty() || request.session_id.is_empty() {
            return Err(bad("request without id or sessionId"));
        }
        if !matches!(request.fidelity.as_str(), "payload" | "context") {
            return Err(bad(format!("unknown fidelity {:?}", request.fidelity)));
        }
        if let Some(hash) = request.blocks.iter().find(|h| !is_hash(h)) {
            return Err(bad(format!("invalid block hash {hash:?}")));
        }
    }
    for document in &batch.documents {
        if document.key.is_empty() || document.kind.is_empty() {
            return Err(bad("document without key or kind"));
        }
    }
    // Compress and write blob files before taking the write lock, except those only discarded data needs. The
    // transaction checks the tombstones again and writes any file it needs that is missing, also one a concurrent
    // deletion removed.
    let dead = store.read(|conn| tombstones(conn, batch))?;
    let discarded = discarded_blocks(batch, &dead);
    for blob in batch.blobs.iter().filter(|b| !discarded.contains(b.hash.as_str())) {
        store.blobs.put(&blob.hash, blob.data.as_bytes())?;
    }
    for ((stream, lines), stored) in batch.streams.iter().map(|s| (s, &s.lines)).zip(&stored_lines) {
        if dead.contains(&stream.key) {
            continue;
        }
        for (line, stored) in lines.iter().zip(stored) {
            if let Stored::Blob(hash) = stored {
                store.blobs.put(hash, line.as_bytes())?;
            }
        }
    }

    let (response, collected) = store.write(|tx| {
        let now = now_ms();
        // Taken under the writer, so a price change (`Store::set_prices`) is either all before this batch or all after.
        let prices = store.prices();
        let dead = tombstones(tx, batch)?;
        let discarded = discarded_blocks(batch, &dead);
        let mut new_blob = tx.prepare_cached("INSERT OR IGNORE INTO blobs (hash, size, stored) VALUES (?1, ?2, ?3)")?;
        let mut awaited = tx.prepare_cached("SELECT 1 FROM request_missing WHERE hash = ?1 LIMIT 1")?;
        for blob in &batch.blobs {
            if discarded.contains(blob.hash.as_str()) && awaited.query_row([&blob.hash], |_| Ok(())).optional()?.is_none() {
                continue;
            }
            // A stat when the file exists; it may not, after a deletion removed it (see `crate::delete`).
            let stored = store.blobs.put(&blob.hash, blob.data.as_bytes())?;
            if new_blob.execute(params![blob.hash, blob.data.len() as i64, stored as i64])? > 0 {
                crate::requests::blob_arrived(tx, &blob.hash)?;
            }
        }
        let mut lengths = BTreeMap::new();
        for ((stream, kind), lines) in batch.streams.iter().zip(&kinds).zip(&stored_lines) {
            if dead.contains(&stream.key) {
                let length = stream.offset + stream.lines.iter().map(|l| l.len() as u64 + 1).sum::<u64>();
                lengths.insert(stream.key.clone(), StreamLength { length });
                continue;
            }
            for (line, stored) in stream.lines.iter().zip(lines) {
                if let Stored::Blob(hash) = stored {
                    let size = store.blobs.put(hash, line.as_bytes())?;
                    if new_blob.execute(params![hash, line.len() as i64, size as i64])? > 0 {
                        crate::requests::blob_arrived(tx, hash)?;
                    }
                }
            }
            let length = append_stream(tx, device, stream, *kind, lines, now, &prices)?;
            lengths.insert(stream.key.clone(), StreamLength { length });
        }
        for document in &batch.documents {
            if document_run(document).is_some_and(|run| dead.contains(&crate::delete::run_key(&run))) {
                continue;
            }
            upsert_document(tx, device, document, now)?;
        }
        let mut missing = BTreeSet::new();
        for r in &batch.requests {
            if dead.contains(&crate::delete::session_key(&r.session_id)) {
                continue;
            }
            let timing = r.timing.as_ref().and_then(crate::requests::timing);
            let new = crate::requests::NewRequest {
                id: &r.id,
                session_id: &r.session_id,
                device,
                seq: r.seq,
                at: r.at.as_deref(),
                fidelity: &r.fidelity,
                provider: r.provider.as_deref(),
                api: r.api.as_deref(),
                model: r.model.as_deref(),
                assistant_ts: r.assistant.as_ref().and_then(|a| a.timestamp),
                response_id: r.assistant.as_ref().and_then(|a| a.response_id.as_deref()),
                timing: timing.as_deref(),
                skeleton: &r.skeleton,
            };
            let lacking = crate::requests::store(tx, &new, now).map_err(|e| match e.downcast::<rusqlite::Error>() {
                Ok(e) => IngestError::from(e),
                Err(e) => bad(format!("request {}: {e:#}", r.id)),
            })?;
            missing.extend(lacking);
        }
        // A session whose recorded parent or Herder run was deleted goes too, now that its lines are derived and its
        // requests stored: from then on it is tombstoned, and its client moves on past the lengths reported above.
        let sessions = batch
            .streams
            .iter()
            .zip(&kinds)
            .filter(|(s, kind)| **kind == StreamKind::Session && !dead.contains(&s.key))
            .map(|(s, kind)| &s.key[kind.key_prefix().len()..]);
        let collected = crate::delete::delete_orphans(tx, sessions)?;
        if !collected.is_empty() {
            // Only the requests that remain still await their blocks.
            let mut still = BTreeSet::new();
            for hash in missing {
                if awaited.query_row([&hash], |_| Ok(())).optional()?.is_some() {
                    still.insert(hash);
                }
            }
            missing = still;
        }
        Ok::<_, IngestError>((BatchResponse { streams: lengths, missing_blobs: missing.into_iter().collect() }, collected))
    })?;
    // As a deletion does, after the commit (see `crate::delete`). The batch is stored either way.
    if let Err(e) = crate::delete::remove_blob_files(store, collected) {
        tracing::warn!("removing the blob files of deleted sessions: {e:#}");
    }
    Ok(response)
}

fn append_stream(
    tx: &Transaction,
    device: &str,
    stream: &StreamBatch,
    kind: StreamKind,
    lines: &[Stored],
    now: i64,
    prices: &crate::pricing::PriceTable,
) -> Result<u64, IngestError> {
    let existing: Option<(i64, String, String, i64, i64, Option<String>)> = tx
        .prepare_cached("SELECT id, kind, device, length, line_count, meta FROM streams WHERE key = ?1")?
        .query_row([&stream.key], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)))
        .optional()?;
    let name = stream.key[kind.key_prefix().len()..].to_owned();
    let meta = stream.meta.as_ref().map(Value::to_string);
    let mut meta_changed = false;
    let (info, length, mut line_count) = match existing {
        Some((id, existing_kind, device, length, line_count, old_meta)) => {
            if existing_kind != kind.as_str() {
                return Err(bad(format!("stream {} is a {existing_kind} stream", stream.key)));
            }
            meta_changed = meta.is_some() && meta != old_meta;
            (StreamInfo { id, kind, name, device }, length as u64, line_count)
        }
        None => {
            if stream.offset > 0 {
                return Err(IngestError::Gap { key: stream.key.clone(), length: 0 });
            }
            tx.prepare_cached(
                "INSERT INTO streams (key, kind, device, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)",
            )?
            .execute(params![stream.key, kind.as_str(), device, now])?;
            let info = StreamInfo { id: tx.last_insert_rowid(), kind, name, device: device.to_owned() };
            derive::create_stream(tx, &info)?;
            (info, 0, 0)
        }
    };
    if stream.offset > length {
        return Err(IngestError::Gap { key: stream.key.clone(), length });
    }
    let conflict = || IngestError::Conflict { key: stream.key.clone(), length };
    let mut offset = stream.offset;
    let mut appended: Vec<(i64, u64, &str)> = Vec::new();
    for (line, stored) in stream.lines.iter().zip(lines) {
        let end = offset + line.len() as u64 + 1;
        if end <= length {
            let existing: Option<(Option<String>, Option<String>)> = tx
                .prepare_cached("SELECT data, blob FROM lines WHERE stream_id = ?1 AND offset = ?2")?
                .query_row(params![info.id, offset as i64], |r| Ok((r.get(0)?, r.get(1)?)))
                .optional()?;
            let same = match existing {
                Some((Some(data), _)) => data == *line,
                Some((None, Some(hash))) => hash == sha256_hex(line.as_bytes()),
                _ => false,
            };
            if !same {
                return Err(conflict());
            }
        } else if offset < length {
            return Err(conflict());
        } else {
            let mut insert = tx.prepare_cached("INSERT INTO lines (stream_id, offset, data, blob) VALUES (?1, ?2, ?3, ?4)")?;
            match stored {
                Stored::Inline(text) => insert.execute(params![info.id, offset as i64, text, None::<String>])?,
                Stored::Blob(hash) => insert.execute(params![info.id, offset as i64, None::<String>, hash])?,
            };
            appended.push((line_count, offset, line.as_str()));
            line_count += 1;
        }
        offset = end;
    }
    let new_length = length.max(offset);
    tx.prepare_cached(
        "UPDATE streams SET length = ?2, line_count = ?3, updated_at = ?4, path = COALESCE(?5, path),
             meta = COALESCE(?6, meta)
         WHERE id = ?1",
    )?
    .execute(params![
        info.id,
        new_length as i64,
        line_count,
        now,
        stream.path,
        meta,
    ])?;
    let lines: Vec<Line> = appended
        .iter()
        .map(|(seq, offset, text)| Line { seq: *seq, offset: *offset as i64, text })
        .collect();
    derive::apply_lines(tx, &info, &lines)?;
    if info.kind == StreamKind::Session && !lines.is_empty() {
        crate::pricing::reprice(tx, prices, Some(info.id))?;
    }
    if lines.is_empty() && meta_changed {
        derive::refresh(tx, &info)?;
    }
    Ok(new_length)
}

/// The Herder run a document belongs to: its `runId`, else the run its key names.
fn document_run(d: &Document) -> Option<String> {
    d.run_id.clone().or_else(|| {
        d.key.strip_prefix("herder:").and_then(|rest| rest.split_once(':')).map(|(run, _)| run.to_owned())
    })
}

fn upsert_document(tx: &Transaction, device: &str, d: &Document, now: i64) -> Result<(), IngestError> {
    let sha256 = d.sha256.clone().unwrap_or_else(|| sha256_hex(d.content.as_bytes()));
    let run_id = document_run(d);
    tx.prepare_cached(
        "INSERT INTO documents (key, kind, run_id, content, sha256, device, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT (key) DO UPDATE SET kind = excluded.kind, run_id = excluded.run_id, content = excluded.content,
             sha256 = excluded.sha256, device = excluded.device, updated_at = excluded.updated_at
         WHERE documents.sha256 != excluded.sha256",
    )?
    .execute(params![d.key, d.kind, run_id, d.content, sha256, device, now])?;
    Ok(())
}
