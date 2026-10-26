//! Derived tables. Ingest calls `apply_lines` with each batch's new lines and `pika reindex` replays every stream
//! through the same code, so both paths produce identical tables. All per-stream state lives in the derived rows.

mod herder;
pub mod search;
mod session;

use anyhow::Result;
use rusqlite::Transaction;
use serde_json::Value;

pub use session::LINK_CUSTOM_TYPE;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StreamKind {
    Session,
    HerderJournal,
}

impl StreamKind {
    pub fn parse(kind: &str) -> Option<Self> {
        match kind {
            "session" => Some(Self::Session),
            "herder-journal" => Some(Self::HerderJournal),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Session => "session",
            Self::HerderJournal => "herder-journal",
        }
    }

    pub fn key_prefix(self) -> &'static str {
        match self {
            Self::Session => "session:",
            Self::HerderJournal => "herder:",
        }
    }
}

#[derive(Clone, Debug)]
pub struct StreamInfo {
    pub id: i64,
    pub kind: StreamKind,
    /// The key without its kind prefix: the session id or Herder run id.
    pub name: String,
    pub device: String,
}

pub struct Line<'a> {
    pub seq: i64,
    pub offset: i64,
    pub text: &'a str,
}

/// Creates the stream's derived row; called once when the stream is first seen.
pub fn create_stream(tx: &Transaction, info: &StreamInfo) -> Result<()> {
    match info.kind {
        StreamKind::Session => session::create(tx, info),
        StreamKind::HerderJournal => herder::create(tx, info),
    }
}

pub fn apply_lines(tx: &Transaction, info: &StreamInfo, lines: &[Line]) -> Result<()> {
    if lines.is_empty() {
        return Ok(());
    }
    match info.kind {
        StreamKind::Session => session::apply(tx, info, lines),
        StreamKind::HerderJournal => herder::apply(tx, info, lines),
    }
}

/// Points the model calls with this assistant timestamp at their best matching request (latest `at`, then id).
pub fn link_requests(tx: &Transaction, session_id: &str, assistant_ts: i64) -> Result<()> {
    tx.prepare_cached(
        "UPDATE model_calls SET request_id = (
             SELECT id FROM requests WHERE session_id = ?1 AND assistant_ts = ?2 ORDER BY at_ms DESC, id DESC LIMIT 1)
         WHERE sid = (SELECT sid FROM sessions WHERE id = ?1) AND ts = ?2",
    )?
    .execute(rusqlite::params![session_id, assistant_ts])?;
    Ok(())
}

pub(crate) fn str_field<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(Value::as_str)
}

pub(crate) fn string_field(v: &Value, key: &str) -> Option<String> {
    str_field(v, key).map(str::to_owned)
}

pub(crate) fn int_field(v: &Value, key: &str) -> Option<i64> {
    let value = v.get(key)?;
    value.as_i64().or_else(|| value.as_f64().filter(|f| f.is_finite()).map(|f| f.round() as i64))
}

pub(crate) fn time_field(v: &Value, key: &str) -> Option<i64> {
    match v.get(key)? {
        Value::String(s) => crate::util::parse_iso_ms(s),
        Value::Number(_) => int_field(v, key),
        _ => None,
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub(crate) struct Usage {
    pub input: i64,
    pub output: i64,
    pub cache_read: i64,
    pub cache_write: i64,
    pub total_tokens: i64,
    pub cost: f64,
}

impl Usage {
    pub fn parse(v: Option<&Value>) -> Option<Usage> {
        let v = v.filter(|v| v.is_object())?;
        let field = |key| int_field(v, key).unwrap_or(0);
        Some(Usage {
            input: field("input"),
            output: field("output"),
            cache_read: field("cacheRead"),
            cache_write: field("cacheWrite"),
            total_tokens: field("totalTokens"),
            cost: v.get("cost").and_then(|c| c.get("total")).and_then(Value::as_f64).unwrap_or(0.0),
        })
    }

    pub fn add(&mut self, other: &Usage) {
        self.input += other.input;
        self.output += other.output;
        self.cache_read += other.cache_read;
        self.cache_write += other.cache_write;
        self.total_tokens += other.total_tokens;
        self.cost += other.cost;
    }
}
