//! Derived tables. Ingest calls `apply_lines` with each batch's new lines and `pika reindex` replays every stream
//! through the same code, so both paths produce identical tables. All per-stream state lives in the derived rows.

mod herder;
pub mod search;
mod session;

use anyhow::Result;
use rusqlite::{OptionalExtension, Transaction};
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

/// Re-derives what the stream's row takes from its `meta`, for a batch that changed `meta` without adding lines.
pub fn refresh(tx: &Transaction, info: &StreamInfo) -> Result<()> {
    match info.kind {
        StreamKind::Session => session::refresh(tx, info.id),
        StreamKind::HerderJournal => herder::refresh(tx, info.id),
    }
}

/// Re-derives the sessions whose stream `meta` names a repository; see `store::migrate`.
pub fn refresh_repositories(tx: &Transaction) -> Result<()> {
    let sids: Vec<i64> = tx
        .prepare(
            "SELECT s.sid FROM sessions s JOIN streams t ON t.id = s.sid
             WHERE json_valid(t.meta) AND (json_type(t.meta, '$.project') IS NOT NULL
                 OR json_type(t.meta, '$.repository') IS NOT NULL)",
        )?
        .query_map([], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    for sid in sids {
        session::refresh(tx, sid)?;
    }
    Ok(())
}

/// Repairs projects from older clients whose cwd identifies a managed worktree. Metadata still takes precedence.
pub fn refresh_worktree_projects(tx: &Transaction) -> Result<()> {
    let rows: Vec<(i64, String)> = tx
        .prepare("SELECT sid, cwd FROM sessions WHERE instr(cwd, '.git') > 0")?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    for (sid, cwd) in rows {
        if crate::util::worktree_project(&cwd).is_some() {
            session::refresh(tx, sid)?;
        }
    }
    Ok(())
}

/// Rewrites the model ids of sessions derived before pika showed bare model names (`crate::util::bare_model`): each
/// session's `models`, in first-seen order without repeats, `session_models`, and `model_calls.model`. Rows derived
/// since already hold bare names, as do the rows `pika reindex` derives. Returns whether any row changed; see
/// `store::migrate`.
pub fn normalize_models(tx: &Transaction) -> Result<bool> {
    let mut changed = false;
    let sessions: Vec<(i64, String)> = tx
        .prepare("SELECT sid, models FROM sessions WHERE models <> '[]'")?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    for (sid, models) in sessions {
        let Ok(models) = serde_json::from_str::<Vec<String>>(&models) else { continue };
        let mut bare: Vec<String> = Vec::with_capacity(models.len());
        for model in &models {
            let name = crate::util::bare_model(model);
            if !bare.iter().any(|b| b == name) {
                bare.push(name.to_owned());
            }
        }
        if bare != models {
            tx.prepare_cached("UPDATE sessions SET models = ?1 WHERE sid = ?2")?
                .execute(rusqlite::params![serde_json::to_string(&bare)?, sid])?;
            changed = true;
        }
    }
    let renames = |sql: &str| -> Result<Vec<(String, String)>> {
        let models: Vec<String> = tx.prepare(sql)?.query_map([], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?;
        Ok(models
            .into_iter()
            .filter_map(|m| {
                let bare = crate::util::bare_model(&m);
                (bare != m).then(|| (m.clone(), bare.to_owned()))
            })
            .collect())
    };
    // Routes of one model merge into one row per session.
    for (old, new) in renames("SELECT DISTINCT model FROM session_models")? {
        tx.execute(
            "INSERT OR IGNORE INTO session_models (model, sid) SELECT ?2, sid FROM session_models WHERE model = ?1",
            rusqlite::params![old, new],
        )?;
        tx.execute("DELETE FROM session_models WHERE model = ?1", [&old])?;
        changed = true;
    }
    // One pass over the model calls, renaming by a JSON object of old to new ids.
    let calls: serde_json::Map<String, Value> = renames("SELECT DISTINCT model FROM model_calls WHERE model IS NOT NULL")?
        .into_iter()
        .map(|(old, new)| (old, Value::String(new)))
        .collect();
    if !calls.is_empty() {
        tx.execute(
            "UPDATE model_calls SET model = (SELECT value FROM json_each(?1) WHERE key = model_calls.model)
             WHERE model IN (SELECT key FROM json_each(?1))",
            [Value::Object(calls).to_string()],
        )?;
        changed = true;
    }
    Ok(changed)
}

/// The stream's `meta` object, or `Null` when it has none or it is not JSON.
fn stream_meta(tx: &Transaction, id: i64) -> Result<Value> {
    let meta: Option<String> =
        tx.prepare_cached("SELECT meta FROM streams WHERE id = ?1")?.query_row([id], |r| r.get(0)).optional()?.flatten();
    Ok(meta.and_then(|m| serde_json::from_str(&m).ok()).unwrap_or(Value::Null))
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
