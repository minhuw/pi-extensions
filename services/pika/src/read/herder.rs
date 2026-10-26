use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::Serialize;
use serde_json::{Value, json};

use super::{Page, Params, ReadError, ReadResult, cursor_int, cursor_str, iso, line_text, page};
use crate::blobs::BlobStore;
use crate::util::parse_json_lenient;

pub const RUN_LIMIT: i64 = 50;
pub const MAX_RUN_LIMIT: i64 = 500;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunSummary {
    pub run_id: String,
    pub device: String,
    pub repo: String,
    pub title: String,
    /// `running` until `run.finished`, then that event's status.
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub verdict: Option<String>,
    pub started_at: Option<String>,
    pub last_at: Option<String>,
    pub step_count: i64,
    #[serde(skip)]
    last_at_ms: i64,
}

#[derive(Debug, Serialize)]
pub struct Event {
    pub seq: i64,
    pub t: Option<String>,
    pub at: Option<String>,
    pub data: Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Step {
    pub key: String,
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task: Option<String>,
    pub role: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub phase: Option<String>,
    pub status: String,
    pub attempts: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub commit: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct RunDetail {
    pub run: RunSummary,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub goal: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plan: Option<String>,
    pub events: Vec<Event>,
    pub steps: Vec<Step>,
}

const RUN_COLUMNS: &str = "run_id, device, repo, title, finished_status, verdict, started_at, last_at, event_count, step_count";

fn run_summary(r: &Row) -> rusqlite::Result<RunSummary> {
    let last_at: i64 = r.get(7)?;
    let has_time = r.get::<_, i64>(8)? > 0 && last_at != 0;
    let started_at: Option<i64> = r.get(6)?;
    Ok(RunSummary {
        run_id: r.get(0)?,
        device: r.get(1)?,
        repo: r.get::<_, Option<String>>(2)?.unwrap_or_default(),
        title: r.get::<_, Option<String>>(3)?.unwrap_or_default(),
        status: r.get::<_, Option<String>>(4)?.unwrap_or_else(|| "running".into()),
        verdict: r.get(5)?,
        started_at: iso(if has_time { started_at } else { None }),
        last_at: iso(has_time.then_some(last_at)),
        step_count: r.get(9)?,
        last_at_ms: last_at,
    })
}

pub fn list(conn: &Connection, p: &Params) -> ReadResult<Page<RunSummary>> {
    let limit = p.limit(RUN_LIMIT, MAX_RUN_LIMIT)?;
    let items = match p.cursor()? {
        Some(key) => {
            let (last_at, run_id) = (cursor_int(&key, 0)?, cursor_str(&key, 1)?);
            conn.prepare_cached(&format!(
                "SELECT {RUN_COLUMNS} FROM herder_runs WHERE last_at <= ?1 AND (last_at < ?1 OR run_id < ?2)
                 ORDER BY last_at DESC, run_id DESC LIMIT ?3"
            ))?
            .query_map(params![last_at, run_id, limit + 1], run_summary)?
            .collect::<rusqlite::Result<Vec<_>>>()?
        }
        None => conn
            .prepare_cached(&format!("SELECT {RUN_COLUMNS} FROM herder_runs ORDER BY last_at DESC, run_id DESC LIMIT ?1"))?
            .query_map([limit + 1], run_summary)?
            .collect::<rusqlite::Result<Vec<_>>>()?,
    };
    Ok(page(items, limit, |r| vec![json!(r.last_at_ms), json!(r.run_id)]))
}

fn document(conn: &Connection, key: &str) -> ReadResult<Option<String>> {
    Ok(conn.prepare_cached("SELECT content FROM documents WHERE key = ?1")?.query_row([key], |r| r.get(0)).optional()?)
}

pub fn detail(conn: &Connection, blobs: &BlobStore, run_id: &str) -> ReadResult<RunDetail> {
    let (rid, run) = conn
        .prepare_cached(&format!("SELECT {RUN_COLUMNS}, rid FROM herder_runs WHERE run_id = ?1"))?
        .query_row([run_id], |r| Ok((r.get::<_, i64>(10)?, run_summary(r)?)))
        .optional()?
        .ok_or(ReadError::NotFound)?;

    let rows = conn
        .prepare_cached(
            "SELECT e.seq, e.t, e.at, l.data, l.blob FROM herder_events e
             JOIN lines l ON l.stream_id = e.rid AND l.offset = e.offset
             WHERE e.rid = ?1 ORDER BY e.seq",
        )?
        .query_map([rid], |r| {
            Ok((r.get::<_, i64>(0)?, r.get(1)?, r.get(2)?, r.get::<_, Option<String>>(3)?, r.get::<_, Option<String>>(4)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut events = Vec::with_capacity(rows.len());
    for (seq, t, at, data, blob) in rows {
        let text = line_text(blobs, data, blob)?;
        events.push(Event { seq, t, at: iso(at), data: parse_json_lenient(&text).unwrap_or(Value::String(text)) });
    }

    let mut steps: Vec<Step> = conn
        .prepare_cached(
            "SELECT key, id, task, role, label, phase, status, attempts, session_id, commit_sha, started_at, ended_at
             FROM herder_steps WHERE rid = ?1 ORDER BY first_seq",
        )?
        .query_map([rid], |r| {
            let key: String = r.get(0)?;
            Ok(Step {
                id: r.get::<_, Option<String>>(1)?.unwrap_or_else(|| key.clone()),
                key,
                task: r.get(2)?,
                role: r.get::<_, Option<String>>(3)?.unwrap_or_default(),
                label: r.get(4)?,
                phase: r.get(5)?,
                status: r.get(6)?,
                attempts: r.get(7)?,
                session_id: r.get(8)?,
                commit: r.get(9)?,
                started_at: iso(r.get(10)?),
                ended_at: iso(r.get(11)?),
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    // Older journals carry no session ids; the step sessions' link entries name their step.
    let mut linked = conn.prepare_cached(
        "SELECT s.id FROM session_links l JOIN sessions s USING (sid)
         WHERE l.herder_run_id = ?1 AND l.herder_step_key = ?2
         ORDER BY l.herder_attempt DESC, l.herder_launch DESC, s.started_at DESC, s.id DESC LIMIT 1",
    )?;
    for step in steps.iter_mut().filter(|s| s.session_id.is_none()) {
        step.session_id = linked.query_row(params![run_id, step.key], |r| r.get(0)).optional()?;
    }

    Ok(RunDetail {
        goal: document(conn, &format!("herder:{run_id}:goal.md"))?,
        plan: document(conn, &format!("herder:{run_id}:plan.md"))?,
        run,
        events,
        steps,
    })
}
