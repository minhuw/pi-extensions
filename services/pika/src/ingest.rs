use std::collections::{BTreeMap, BTreeSet};

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

/// Validates the batch and writes blob files outside the write lock; the database work runs in one transaction.
pub fn apply(store: &Store, device: &str, batch: &Batch) -> Result<BatchResponse, IngestError> {
    let mut blob_rows = Vec::new();
    for blob in &batch.blobs {
        if !is_hash(&blob.hash) {
            return Err(bad(format!("invalid blob hash {:?}", blob.hash)));
        }
        if sha256_hex(blob.data.as_bytes()) != blob.hash {
            return Err(bad(format!("blob {} does not match its hash", blob.hash)));
        }
        let stored = store.blobs.put(&blob.hash, blob.data.as_bytes())?;
        blob_rows.push((blob.hash.clone(), blob.data.len() as i64, stored as i64));
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
                let hash = sha256_hex(line.as_bytes());
                let stored = store.blobs.put(&hash, line.as_bytes())?;
                blob_rows.push((hash.clone(), line.len() as i64, stored as i64));
                lines.push(Stored::Blob(hash));
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

    store.write(|tx| {
        let now = now_ms();
        let mut new_blob = tx.prepare_cached("INSERT OR IGNORE INTO blobs (hash, size, stored) VALUES (?1, ?2, ?3)")?;
        for (hash, size, stored) in &blob_rows {
            if new_blob.execute(params![hash, size, stored])? > 0 {
                crate::requests::blob_arrived(tx, hash)?;
            }
        }
        let mut lengths = BTreeMap::new();
        for ((stream, kind), lines) in batch.streams.iter().zip(&kinds).zip(&stored_lines) {
            let length = append_stream(tx, device, stream, *kind, lines, now)?;
            lengths.insert(stream.key.clone(), StreamLength { length });
        }
        for document in &batch.documents {
            upsert_document(tx, device, document, now)?;
        }
        let mut missing = BTreeSet::new();
        for r in &batch.requests {
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
        Ok(BatchResponse { streams: lengths, missing_blobs: missing.into_iter().collect() })
    })
}

fn append_stream(
    tx: &Transaction,
    device: &str,
    stream: &StreamBatch,
    kind: StreamKind,
    lines: &[Stored],
    now: i64,
) -> Result<u64, IngestError> {
    let existing: Option<(i64, String, String, i64, i64)> = tx
        .prepare_cached("SELECT id, kind, device, length, line_count FROM streams WHERE key = ?1")?
        .query_row([&stream.key], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))
        .optional()?;
    let name = stream.key[kind.key_prefix().len()..].to_owned();
    let (info, length, mut line_count) = match existing {
        Some((id, existing_kind, device, length, line_count)) => {
            if existing_kind != kind.as_str() {
                return Err(bad(format!("stream {} is a {existing_kind} stream", stream.key)));
            }
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
        stream.meta.as_ref().map(Value::to_string),
    ])?;
    let lines: Vec<Line> = appended
        .iter()
        .map(|(seq, offset, text)| Line { seq: *seq, offset: *offset as i64, text })
        .collect();
    derive::apply_lines(tx, &info, &lines)?;
    Ok(new_length)
}

fn upsert_document(tx: &Transaction, device: &str, d: &Document, now: i64) -> Result<(), IngestError> {
    let sha256 = d.sha256.clone().unwrap_or_else(|| sha256_hex(d.content.as_bytes()));
    let run_id = d.run_id.clone().or_else(|| {
        d.key.strip_prefix("herder:").and_then(|rest| rest.split_once(':')).map(|(run, _)| run.to_owned())
    });
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
