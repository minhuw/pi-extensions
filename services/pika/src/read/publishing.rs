//! Project publication is an opt-in setting, independent of derived session tables.
use std::collections::{BTreeMap, BTreeSet};

use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;

use super::{ReadError, ReadResult, bad};

pub const KEY: &str = "published_projects";
/// JSON arrays are stored as BLOBs in settings; cast explicitly for SQLite JSON functions.
pub const PROJECTS_SQL: &str =
    "SELECT value FROM json_each(CAST(COALESCE((SELECT value FROM settings WHERE key = 'published_projects'), x'5b5d') AS TEXT))";
pub const SESSION_FILTER: &str = "s.project IN (SELECT value FROM json_each(CAST(COALESCE((SELECT value FROM settings WHERE key = 'published_projects'), x'5b5d') AS TEXT)))";

#[derive(Serialize)]
pub struct Publishing {
    pub projects: Vec<Project>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub project: String,
    pub session_count: i64,
    pub published: bool,
}

fn selected(conn: &Connection) -> ReadResult<BTreeSet<String>> {
    let bytes: Option<Vec<u8>> = conn.query_row("SELECT value FROM settings WHERE key = ?1", [KEY], |r| r.get(0)).optional()?;
    Ok(match bytes {
        Some(bytes) => serde_json::from_slice(&bytes).map_err(anyhow::Error::from)?,
        None => BTreeSet::new(),
    })
}

pub fn settings(conn: &Connection) -> ReadResult<Publishing> {
    let selected = selected(conn)?;
    let mut counts: BTreeMap<String, i64> = conn
        .prepare_cached("SELECT project, COUNT(*) FROM sessions WHERE project IS NOT NULL AND project <> '' GROUP BY project")?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    for project in &selected {
        counts.entry(project.clone()).or_default();
    }
    Ok(Publishing {
        projects: counts
            .into_iter()
            .map(|(project, session_count)| {
                let published = selected.contains(&project);
                Project { project, session_count, published }
            })
            .collect(),
    })
}

/// Caller holds the store's IMMEDIATE write transaction, so concurrent project changes are preserved.
pub fn update(conn: &Connection, project: &str, published: bool) -> ReadResult<Publishing> {
    let mut selections = selected(conn)?;
    if published {
        if project.is_empty()
            || project.len() > 1024
            || project.trim().is_empty()
            || project.chars().any(|c| c.is_control() || c == '/' || c == '\\')
            || matches!(project, "." | "..")
        {
            return Err(bad("invalid project"));
        }
        let exists: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM sessions WHERE project = ?1)", [project], |r| r.get(0))?;
        if !exists {
            return Err(bad("unknown project"));
        }
        selections.insert(project.to_owned());
    } else {
        selections.remove(project);
    }
    let bytes = serde_json::to_vec(&selections).map_err(anyhow::Error::from)?;
    conn.execute("INSERT OR REPLACE INTO settings (key, value) VALUES (?1, ?2)", params![KEY, bytes])?;
    settings(conn)
}

pub fn visible(conn: &Connection, id: &str) -> ReadResult<bool> {
    Ok(conn.query_row(&format!("SELECT EXISTS(SELECT 1 FROM sessions s WHERE s.id = ?1 AND {SESSION_FILTER})"), [id], |r| r.get(0))?)
}

pub fn require(conn: &Connection, id: &str) -> ReadResult<()> {
    if visible(conn, id)? { Ok(()) } else { Err(ReadError::NotFound) }
}

pub fn summary(conn: &Connection, summary: &mut super::sessions::SessionSummary) -> ReadResult<()> {
    if let Some(parent) = &summary.parent_session_id {
        if !visible(conn, parent)? {
            summary.parent_session_id = None;
        }
    }
    summary.link = None;
    summary.herder_run_id = None;
    summary.child_count = conn.query_row(
        &format!("SELECT COUNT(*) FROM sessions s WHERE s.parent_session_id = ?1 AND {SESSION_FILTER}"),
        [&summary.id],
        |r| r.get(0),
    )?;
    Ok(())
}

pub fn detail(conn: &Connection, detail: &mut super::sessions::SessionDetail) -> ReadResult<()> {
    summary(conn, &mut detail.summary)?;
    let mut children = Vec::new();
    for mut child in detail.children.drain(..) {
        if visible(conn, &child.summary.id)? {
            summary(conn, &mut child.summary)?;
            children.push(child);
        }
    }
    detail.children = children;
    Ok(())
}

pub fn trace(conn: &Connection, trace: &mut super::trace::Trace) -> ReadResult<()> {
    let mut children = Vec::new();
    for child in trace.children.drain(..) {
        if visible(conn, &child.session_id)? {
            children.push(child);
        }
    }
    trace.children = children;
    for record in &mut trace.records {
        match record {
            super::trace::Record::Llm(record) => record.request_id = None,
            super::trace::Record::Tool(record) => {
                if let Some(child) = &record.child_session_id {
                    if !visible(conn, child)? {
                        record.child_session_id = None;
                    }
                }
            }
            _ => {}
        }
    }
    Ok(())
}
