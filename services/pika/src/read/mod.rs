//! Read API queries (spec "Read API"). Each function runs on a pooled read connection and returns a serializable
//! response. Lists page with keyset cursors: an opaque base64url encoding of the last item's sort key.

pub mod entries;
pub mod herder;
pub mod search;
pub mod sessions;

use std::collections::BTreeMap;

use rusqlite::{Connection, OptionalExtension};
use serde_json::Value;

use crate::util::{base64_decode, base64url_encode, format_iso_ms, parse_iso_ms};

#[derive(Debug)]
pub enum ReadError {
    BadRequest(String),
    NotFound,
    Internal(anyhow::Error),
}

impl From<rusqlite::Error> for ReadError {
    fn from(e: rusqlite::Error) -> Self {
        ReadError::Internal(e.into())
    }
}

impl From<anyhow::Error> for ReadError {
    fn from(e: anyhow::Error) -> Self {
        ReadError::Internal(e)
    }
}

impl std::fmt::Display for ReadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ReadError::BadRequest(m) => write!(f, "bad request: {m}"),
            ReadError::NotFound => write!(f, "not found"),
            ReadError::Internal(e) => write!(f, "{e:#}"),
        }
    }
}

pub type ReadResult<T> = Result<T, ReadError>;

pub fn bad(message: impl Into<String>) -> ReadError {
    ReadError::BadRequest(message.into())
}

/// Query string parameters; empty values count as absent.
#[derive(Clone, Debug, Default)]
pub struct Params(pub BTreeMap<String, String>);

impl Params {
    pub fn get(&self, key: &str) -> Option<&str> {
        self.0.get(key).map(String::as_str).filter(|v| !v.is_empty())
    }

    pub fn int(&self, key: &str) -> ReadResult<Option<i64>> {
        self.get(key).map(|v| v.parse::<i64>().map_err(|_| bad(format!("{key} must be an integer")))).transpose()
    }

    /// `limit`, defaulting to `default` and clamped to `1..=max`.
    pub fn limit(&self, default: i64, max: i64) -> ReadResult<i64> {
        Ok(self.int("limit")?.unwrap_or(default).clamp(1, max))
    }

    /// A time as Unix milliseconds, an ISO 8601 date-time, or a `YYYY-MM-DD` date (UTC midnight).
    pub fn time(&self, key: &str) -> ReadResult<Option<i64>> {
        let Some(raw) = self.get(key) else { return Ok(None) };
        let parsed = raw
            .parse::<i64>()
            .ok()
            .or_else(|| parse_iso_ms(raw))
            .or_else(|| (raw.len() == 10).then(|| parse_iso_ms(&format!("{raw}T00:00:00Z"))).flatten());
        parsed.map(Some).ok_or_else(|| bad(format!("{key} must be a time")))
    }

    pub fn bool(&self, key: &str) -> ReadResult<bool> {
        match self.get(key) {
            None | Some("false" | "0") => Ok(false),
            Some("true" | "1") => Ok(true),
            Some(_) => Err(bad(format!("{key} must be true or false"))),
        }
    }

    /// The decoded `cursor` parameter: a JSON array of the sort key.
    pub fn cursor(&self) -> ReadResult<Option<Vec<Value>>> {
        let Some(raw) = self.get("cursor") else { return Ok(None) };
        base64_decode(raw)
            .and_then(|bytes| serde_json::from_slice::<Vec<Value>>(&bytes).ok())
            .map(Some)
            .ok_or_else(|| bad("invalid cursor"))
    }
}

pub fn encode_cursor(key: &[Value]) -> String {
    base64url_encode(serde_json::to_string(key).expect("cursor keys serialize").as_bytes())
}

pub fn cursor_int(key: &[Value], index: usize) -> ReadResult<i64> {
    key.get(index).and_then(Value::as_i64).ok_or_else(|| bad("invalid cursor"))
}

pub fn cursor_str(key: &[Value], index: usize) -> ReadResult<&str> {
    key.get(index).and_then(Value::as_str).ok_or_else(|| bad("invalid cursor"))
}

pub fn iso(ms: Option<i64>) -> Option<String> {
    ms.map(format_iso_ms)
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Page<T> {
    pub items: Vec<T>,
    pub next_cursor: Option<String>,
}

/// Builds a page from up to `limit + 1` rows; `key` gives the cursor of the last returned item.
pub fn page<T>(mut items: Vec<T>, limit: i64, key: impl Fn(&T) -> Vec<Value>) -> Page<T> {
    let more = items.len() as i64 > limit;
    items.truncate(limit as usize);
    let next_cursor = if more { items.last().map(|last| encode_cursor(&key(last))) } else { None };
    Page { items, next_cursor }
}

/// The derived row id (`streams.id`) of a session.
pub fn session_sid(conn: &Connection, session_id: &str) -> ReadResult<i64> {
    conn.prepare_cached("SELECT sid FROM sessions WHERE id = ?1")?
        .query_row([session_id], |r| r.get(0))
        .optional()?
        .ok_or(ReadError::NotFound)
}

/// A stored line's text: inline, or from the blob store.
pub fn line_text(blobs: &crate::blobs::BlobStore, data: Option<String>, blob: Option<String>) -> ReadResult<String> {
    Ok(match (data, blob) {
        (Some(data), _) => data,
        (None, Some(hash)) => blobs.get_string(&hash)?,
        (None, None) => String::new(),
    })
}
