use rusqlite::types::Value as Sql;
use rusqlite::{Connection, Row, params_from_iter};
use serde::Serialize;
use serde_json::{Value, json};

use super::{DeviceNames, Page, Params, ReadError, ReadResult, cursor_int, cursor_str, iso, page, session_sid};

pub const LIST_LIMIT: i64 = 50;
pub const MAX_LIST_LIMIT: i64 = 500;
pub const TURN_LIMIT: i64 = 100;
pub const MAX_TURN_LIMIT: i64 = 1000;
/// `updates` lists at most this many turns.
pub const UPDATE_TURN_LIMIT: usize = 50;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Facets {
    pub devices: Vec<FacetDevice>,
    pub projects: Vec<String>,
    pub models: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct FacetDevice {
    pub id: String,
    pub name: String,
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
    /// Filled from the device's row after the query; see `DeviceNames`.
    pub device_name: String,
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
    /// The `customType` of the `custom_message` that started the turn; absent for a user prompt.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub custom_type: Option<String>,
}

/// `session`, `turns`, and `truncated` are present only when the session has entries after `since`.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Updates {
    pub last_seq: i64,
    pub last_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session: Option<SessionSummary>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turns: Option<Vec<Turn>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub truncated: Option<bool>,
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
        device_name: String::new(),
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

const TURN_COLUMNS: &str = "t.idx, t.start_seq, t.end_seq, t.user_text, t.at, t.duration_ms, t.model_calls, \
     t.tool_calls, t.tool_errors, t.cost, t.input, t.output, t.cache_read, t.cache_write, t.final_text, e.custom_type";

/// Turns with the entry that started each, when that is an extension message, so no reindex is needed for its type.
const TURN_FROM: &str =
    "turns t LEFT JOIN entries e ON e.sid = t.sid AND e.seq = t.start_seq AND e.type = 'custom_message'";

fn turn(r: &Row) -> rusqlite::Result<Turn> {
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
        custom_type: r.get(15)?,
    })
}

fn not_found(e: rusqlite::Error) -> ReadError {
    match e {
        rusqlite::Error::QueryReturnedNoRows => ReadError::NotFound,
        e => e.into(),
    }
}

fn distinct(conn: &Connection, sql: &str) -> ReadResult<Vec<String>> {
    Ok(conn.prepare_cached(sql)?.query_map([], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?)
}

impl SessionSummary {
    fn named(mut self, names: &DeviceNames) -> SessionSummary {
        self.device_name = names.of(&self.device);
        self
    }
}

/// The devices of recorded sessions, by name case-insensitively, then id.
pub fn facets(conn: &Connection) -> ReadResult<Facets> {
    facets_scoped(conn, false)
}

pub fn facets_scoped(conn: &Connection, public: bool) -> ReadResult<Facets> {
    let scope = if public { format!(" WHERE {}", super::publishing::SESSION_FILTER) } else { String::new() };
    let names = DeviceNames::load(conn)?;
    let mut devices: Vec<FacetDevice> = distinct(conn, &format!("SELECT DISTINCT s.device FROM sessions s{scope} ORDER BY s.device"))?
        .into_iter()
        .map(|id| FacetDevice { name: names.of(&id), id })
        .collect();
    devices.sort_by(|a, b| crate::auth::by_name((&a.id, &a.name), (&b.id, &b.name)));
    Ok(Facets {
        devices,
        projects: distinct(conn, &format!(
            "SELECT DISTINCT s.project FROM sessions s{scope}{} s.project IS NOT NULL ORDER BY s.project",
            if public { " AND" } else { " WHERE" },
        ))?,
        models: distinct(conn, &format!(
            "SELECT DISTINCT m.model FROM session_models m JOIN sessions s USING (sid){scope} ORDER BY m.model",
        ))?,
    })
}

/// The session list statement and its arguments. `from` and `to` bound `lastAt` (inclusive). Each combination of the
/// device, project, and root filters walks an index in `lastAt` order; `model` and the time bounds filter along it.
pub(crate) fn list_query(p: &Params, limit: i64) -> ReadResult<(String, Vec<Sql>)> {
    list_query_scoped(p, limit, false)
}

fn list_query_scoped(p: &Params, limit: i64, public: bool) -> ReadResult<(String, Vec<Sql>)> {
    let (root, device, project) = (p.bool("root")?, p.get("device"), p.get("project"));
    // Without statistics SQLite may prefer sessions_parent for `root` and then sort, so name the index.
    let index = match (root && !public, device.is_some(), project.is_some()) {
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
    if public {
        sql.push_str(&format!(" AND {}", super::publishing::SESSION_FILTER));
    }
    if root {
        if public {
            sql.push_str(&format!(
                " AND NOT EXISTS (SELECT 1 FROM sessions parent WHERE parent.id = s.parent_session_id \
                 AND parent.project IN ({}))",
                super::publishing::PROJECTS_SQL,
            ));
        } else {
            sql.push_str(" AND s.parent_session_id IS NULL");
        }
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
    list_scoped(conn, p, false)
}

pub fn list_scoped(conn: &Connection, p: &Params, public: bool) -> ReadResult<Page<SessionSummary>> {
    let limit = p.limit(LIST_LIMIT, MAX_LIST_LIMIT)?;
    let (sql, args) = if public { list_query_scoped(p, limit, true)? } else { list_query(p, limit)? };
    let items = conn
        .prepare_cached(&sql)?
        .query_map(params_from_iter(args), summary)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let names = DeviceNames::load(conn)?;
    let items = items
        .into_iter()
        .map(|s| s.named(&names))
        .map(|mut s| {
            if public {
                super::publishing::summary(conn, &mut s)?;
            }
            Ok(s)
        })
        .collect::<ReadResult<Vec<_>>>()?;
    Ok(page(items, limit, |s| vec![json!(s.last_at_ms), json!(s.id)]))
}

pub(crate) fn detail_sql() -> String {
    format!("SELECT {SUMMARY_COLUMNS} FROM sessions s WHERE s.id = ?1")
}

pub(crate) fn children_sql() -> String {
    format!(
        "SELECT {SUMMARY_COLUMNS}, l.parent_tool_call_id FROM sessions s LEFT JOIN session_links l USING (sid)
         WHERE s.parent_session_id = ?1 ORDER BY s.started_at, s.id"
    )
}

pub(crate) fn turns_sql() -> String {
    format!("SELECT {TURN_COLUMNS} FROM {TURN_FROM} WHERE t.sid = ?1 AND t.idx > ?2 ORDER BY t.idx LIMIT ?3")
}

fn update_turns_sql() -> String {
    format!("SELECT {TURN_COLUMNS} FROM {TURN_FROM} WHERE t.sid = ?1 ORDER BY t.idx DESC")
}

pub fn detail(conn: &Connection, id: &str) -> ReadResult<SessionDetail> {
    let session = conn.prepare_cached(&detail_sql())?.query_row([id], summary).map_err(not_found)?;
    let names = DeviceNames::load(conn)?;
    let children = conn
        .prepare_cached(&children_sql())?
        .query_map([id], |r| {
            Ok(ChildSession { summary: summary(r)?.named(&names), parent_tool_call_id: r.get(18)? })
        })?
        .collect::<rusqlite::Result<_>>()?;
    Ok(SessionDetail { summary: session.named(&names), children })
}

pub fn turns(conn: &Connection, id: &str, p: &Params) -> ReadResult<Page<Turn>> {
    let sid = session_sid(conn, id)?;
    let limit = p.limit(TURN_LIMIT, MAX_TURN_LIMIT)?;
    let after = match p.cursor()? {
        Some(key) => cursor_int(&key, 0)?,
        None => -1,
    };
    let items = conn
        .prepare_cached(&turns_sql())?
        .query_map(rusqlite::params![sid, after, limit + 1], turn)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(page(items, limit, |t| vec![json!(t.index)]))
}

/// What changed after the caller's last seq `since` (missing or invalid counts as -1), for polling an active
/// session: its summary and every turn that ends after `since`. Turns end in index order, so the walk goes down
/// from the newest turn and stops at the first that ends at or before `since`.
pub fn updates(conn: &Connection, id: &str, p: &Params) -> ReadResult<Updates> {
    let since = p.int("since").ok().flatten().unwrap_or(-1);
    // One snapshot for the summary and the turns.
    // The public HTTP scope may already hold a snapshot for authorization.
    let _tx = conn.is_autocommit().then(|| conn.unchecked_transaction()).transpose()?;
    let tx = conn;
    let (session, sid) = tx
        .prepare_cached(&format!("SELECT {SUMMARY_COLUMNS}, s.sid FROM sessions s WHERE s.id = ?1"))?
        .query_row([id], |r| Ok((summary(r)?, r.get::<_, i64>(18)?)))
        .map_err(not_found)?;
    let session = session.named(&DeviceNames::load(tx)?);
    let last_seq = session.entry_count - 1;
    let last_at = iso((session.entry_count > 0 && session.last_at_ms != 0).then_some(session.last_at_ms));
    if last_seq <= since {
        return Ok(Updates { last_seq, last_at, session: None, turns: None, truncated: None });
    }
    let mut turns = Vec::new();
    let mut truncated = None;
    let mut stmt = tx.prepare_cached(&update_turns_sql())?;
    let mut rows = stmt.query([sid])?;
    while let Some(row) = rows.next()? {
        if row.get::<_, i64>(2)? <= since {
            break;
        }
        if turns.len() == UPDATE_TURN_LIMIT {
            truncated = Some(true);
            break;
        }
        turns.push(turn(row)?);
    }
    turns.reverse();
    Ok(Updates { last_seq, last_at, session: Some(session), turns: Some(turns), truncated })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `updates` walks a session's turns down the primary key: no sort.
    #[test]
    fn update_turns_walk_the_primary_key() {
        let dir = tempfile::tempdir().unwrap();
        let store = crate::store::Store::open(dir.path()).unwrap();
        let plan: Vec<String> = store
            .read(|conn| {
                conn.prepare(&format!("EXPLAIN QUERY PLAN {}", update_turns_sql()))?
                    .query_map([1], |r| r.get::<_, String>(3))?
                    .collect()
            })
            .unwrap();
        assert_eq!(
            plan,
            ["SEARCH t USING PRIMARY KEY (sid=?)", "SEARCH e USING PRIMARY KEY (sid=? AND seq=?) LEFT-JOIN"],
            "{plan:?}"
        );
    }

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
