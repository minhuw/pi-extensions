use rusqlite::types::Value as Sql;
use rusqlite::{Connection, Row, params_from_iter};
use serde::Serialize;
use serde_json::{Value, json};

use super::{Page, Params, ReadError, ReadResult, cursor_int, cursor_str, iso, page, session_sid};

pub const LIST_LIMIT: i64 = 50;
pub const MAX_LIST_LIMIT: i64 = 500;
pub const TURN_LIMIT: i64 = 100;
pub const MAX_TURN_LIMIT: i64 = 1000;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Facets {
    pub devices: Vec<String>,
    pub projects: Vec<String>,
    pub models: Vec<String>,
}

#[derive(Debug, Serialize, Clone, Copy, Default)]
#[serde(rename_all = "camelCase")]
pub struct Tokens {
    pub input: i64,
    pub output: i64,
    pub cache_read: i64,
    pub cache_write: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    pub id: String,
    pub device: String,
    pub project: String,
    pub cwd: String,
    pub title: String,
    pub started_at: Option<String>,
    pub last_at: Option<String>,
    pub duration_ms: i64,
    pub entry_count: i64,
    pub models: Vec<String>,
    pub tokens: Tokens,
    pub cost: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub link: Option<Value>,
    pub child_count: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub herder_run_id: Option<String>,
    /// The raw sort key, for cursors.
    #[serde(skip)]
    last_at_ms: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChildSession {
    #[serde(flatten)]
    pub summary: SessionSummary,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_tool_call_id: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct SessionDetail {
    #[serde(flatten)]
    pub summary: SessionSummary,
    pub children: Vec<ChildSession>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Turn {
    pub index: i64,
    pub start_seq: i64,
    pub end_seq: i64,
    pub user_text: String,
    pub at: Option<String>,
    pub duration_ms: i64,
    pub model_calls: i64,
    pub tool_calls: i64,
    pub tool_errors: i64,
    pub cost: f64,
    pub tokens: Tokens,
    pub final_text: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Updates {
    pub last_seq: i64,
    pub last_at: Option<String>,
}

const SUMMARY_COLUMNS: &str = "s.id, s.device, s.project, s.cwd, s.title, s.started_at, s.last_at, s.entry_count, \
     s.models, s.input, s.output, s.cache_read, s.cache_write, s.cost, s.parent_session_id, s.link, s.child_count, \
     s.herder_run_id";

fn summary(r: &Row) -> rusqlite::Result<SessionSummary> {
    let entry_count: i64 = r.get(7)?;
    let last_at: i64 = r.get(6)?;
    let started_at: Option<i64> = r.get(5)?;
    let has_time = entry_count > 0 && (started_at.is_some() || last_at != 0);
    let last = has_time.then_some(last_at);
    let started = if has_time { started_at.or(last) } else { None };
    Ok(SessionSummary {
        id: r.get(0)?,
        device: r.get(1)?,
        project: r.get::<_, Option<String>>(2)?.unwrap_or_default(),
        cwd: r.get::<_, Option<String>>(3)?.unwrap_or_default(),
        title: r.get::<_, Option<String>>(4)?.unwrap_or_default(),
        started_at: iso(started),
        last_at: iso(last),
        duration_ms: started.zip(last).map_or(0, |(s, l)| (l - s).max(0)),
        entry_count,
        models: serde_json::from_str(&r.get::<_, String>(8)?).unwrap_or_default(),
        tokens: Tokens { input: r.get(9)?, output: r.get(10)?, cache_read: r.get(11)?, cache_write: r.get(12)? },
        cost: r.get(13)?,
        parent_session_id: r.get(14)?,
        link: r.get::<_, Option<String>>(15)?.and_then(|s| serde_json::from_str(&s).ok()),
        child_count: r.get(16)?,
        herder_run_id: r.get(17)?,
        last_at_ms: last_at,
    })
}

fn distinct(conn: &Connection, sql: &str) -> ReadResult<Vec<String>> {
    Ok(conn.prepare_cached(sql)?.query_map([], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?)
}

pub fn facets(conn: &Connection) -> ReadResult<Facets> {
    Ok(Facets {
        devices: distinct(conn, "SELECT DISTINCT device FROM sessions ORDER BY device")?,
        projects: distinct(conn, "SELECT DISTINCT project FROM sessions WHERE project IS NOT NULL ORDER BY project")?,
        models: distinct(conn, "SELECT DISTINCT model FROM session_models ORDER BY model")?,
    })
}

/// The session list statement and its arguments. `from` and `to` bound `lastAt` (inclusive). Each combination of the
/// device, project, and root filters walks an index in `lastAt` order; `model` and the time bounds filter along it.
fn list_query(p: &Params, limit: i64) -> ReadResult<(String, Vec<Sql>)> {
    let (root, device, project) = (p.bool("root")?, p.get("device"), p.get("project"));
    // Without statistics SQLite may prefer sessions_parent for `root` and then sort, so name the index.
    let index = match (root, device.is_some(), project.is_some()) {
        (false, false, false) => "sessions_last",
        (false, true, false) => "sessions_device",
        (false, false, true) => "sessions_project",
        (false, true, true) => "sessions_device_project",
        (true, false, false) => "sessions_root",
        (true, true, false) => "sessions_root_device",
        (true, false, true) => "sessions_root_project",
        (true, true, true) => "sessions_root_device_project",
    };
    let mut sql = format!("SELECT {SUMMARY_COLUMNS} FROM sessions s INDEXED BY {index} WHERE 1");
    let mut args: Vec<Sql> = Vec::new();
    if root {
        sql.push_str(" AND s.parent_session_id IS NULL");
    }
    if let Some(device) = device {
        sql.push_str(" AND s.device = ?");
        args.push(Sql::Text(device.to_owned()));
    }
    if let Some(project) = project {
        sql.push_str(" AND s.project = ?");
        args.push(Sql::Text(project.to_owned()));
    }
    if let Some(model) = p.get("model") {
        sql.push_str(" AND EXISTS (SELECT 1 FROM session_models m WHERE m.model = ? AND m.sid = s.sid)");
        args.push(Sql::Text(model.to_owned()));
    }
    if let Some(from) = p.time("from")? {
        sql.push_str(" AND s.last_at >= ?");
        args.push(Sql::Integer(from));
    }
    if let Some(to) = p.time("to")? {
        sql.push_str(" AND s.last_at <= ?");
        args.push(Sql::Integer(to));
    }
    if let Some(key) = p.cursor()? {
        let (last_at, id) = (cursor_int(&key, 0)?, cursor_str(&key, 1)?);
        sql.push_str(" AND s.last_at <= ? AND (s.last_at < ? OR s.id < ?)");
        args.extend([Sql::Integer(last_at), Sql::Integer(last_at), Sql::Text(id.to_owned())]);
    }
    sql.push_str(" ORDER BY s.last_at DESC, s.id DESC LIMIT ?");
    args.push(Sql::Integer(limit + 1));
    Ok((sql, args))
}

/// The session list, newest `lastAt` first.
pub fn list(conn: &Connection, p: &Params) -> ReadResult<Page<SessionSummary>> {
    let limit = p.limit(LIST_LIMIT, MAX_LIST_LIMIT)?;
    let (sql, args) = list_query(p, limit)?;
    let items = conn
        .prepare_cached(&sql)?
        .query_map(params_from_iter(args), summary)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(page(items, limit, |s| vec![json!(s.last_at_ms), json!(s.id)]))
}

pub fn detail(conn: &Connection, id: &str) -> ReadResult<SessionDetail> {
    let session = conn
        .prepare_cached(&format!("SELECT {SUMMARY_COLUMNS} FROM sessions s WHERE s.id = ?1"))?
        .query_row([id], summary)
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => ReadError::NotFound,
            e => e.into(),
        })?;
    let children = conn
        .prepare_cached(&format!(
            "SELECT {SUMMARY_COLUMNS}, l.parent_tool_call_id FROM sessions s LEFT JOIN session_links l USING (sid)
             WHERE s.parent_session_id = ?1 ORDER BY s.started_at, s.id"
        ))?
        .query_map([id], |r| Ok(ChildSession { summary: summary(r)?, parent_tool_call_id: r.get(18)? }))?
        .collect::<rusqlite::Result<_>>()?;
    Ok(SessionDetail { summary: session, children })
}

pub fn turns(conn: &Connection, id: &str, p: &Params) -> ReadResult<Page<Turn>> {
    let sid = session_sid(conn, id)?;
    let limit = p.limit(TURN_LIMIT, MAX_TURN_LIMIT)?;
    let after = match p.cursor()? {
        Some(key) => cursor_int(&key, 0)?,
        None => -1,
    };
    let items = conn
        .prepare_cached(
            "SELECT idx, start_seq, end_seq, user_text, at, duration_ms, model_calls, tool_calls, tool_errors, cost,
                    input, output, cache_read, cache_write, final_text
             FROM turns WHERE sid = ?1 AND idx > ?2 ORDER BY idx LIMIT ?3",
        )?
        .query_map(rusqlite::params![sid, after, limit + 1], |r| {
            Ok(Turn {
                index: r.get(0)?,
                start_seq: r.get(1)?,
                end_seq: r.get(2)?,
                user_text: r.get(3)?,
                at: iso(r.get(4)?),
                duration_ms: r.get(5)?,
                model_calls: r.get(6)?,
                tool_calls: r.get(7)?,
                tool_errors: r.get(8)?,
                cost: r.get(9)?,
                tokens: Tokens { input: r.get(10)?, output: r.get(11)?, cache_read: r.get(12)?, cache_write: r.get(13)? },
                final_text: r.get::<_, Option<String>>(14)?.unwrap_or_default(),
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(page(items, limit, |t| vec![json!(t.index)]))
}

/// The session's latest entry, for polling. `since` (the caller's last seq) only needs to be an integer.
pub fn updates(conn: &Connection, id: &str, p: &Params) -> ReadResult<Updates> {
    p.int("since")?;
    let (entry_count, last_at): (i64, i64) = conn
        .prepare_cached("SELECT entry_count, last_at FROM sessions WHERE id = ?1")?
        .query_row([id], |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => ReadError::NotFound,
            e => e.into(),
        })?;
    Ok(Updates { last_seq: entry_count - 1, last_at: iso((entry_count > 0 && last_at != 0).then_some(last_at)) })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every filter combination walks an index in `lastAt` order: no full scan and no sort.
    #[test]
    fn every_filter_combination_uses_an_ordered_index() {
        let dir = tempfile::tempdir().unwrap();
        let store = crate::store::Store::open(dir.path()).unwrap();
        store
            .read(|conn| {
                for mask in 0..64u32 {
                    let mut p = Params::default();
                    let mut set = |bit: u32, key: &str, value: &str| {
                        if mask & (1 << bit) != 0 {
                            p.0.insert(key.into(), value.into());
                        }
                    };
                    set(0, "root", "true");
                    set(1, "device", "d");
                    set(2, "project", "p");
                    set(3, "model", "m");
                    set(4, "from", "1000");
                    set(5, "cursor", &crate::read::encode_cursor(&[json!(5), json!("x")]));
                    let (sql, args) = list_query(&p, 50).unwrap();
                    let plan: Vec<String> = conn
                        .prepare(&format!("EXPLAIN QUERY PLAN {sql}"))?
                        .query_map(params_from_iter(args), |r| r.get::<_, String>(3))?
                        .collect::<rusqlite::Result<_>>()?;
                    let plan = plan.join("\n");
                    assert!(!plan.contains("TEMP B-TREE"), "{mask:#b}: {plan}");
                    assert!(plan.contains("SEARCH s USING INDEX") || plan.contains("SCAN s USING INDEX"), "{mask:#b}: {plan}");
                }
                Ok::<_, rusqlite::Error>(())
            })
            .unwrap();
    }
}
