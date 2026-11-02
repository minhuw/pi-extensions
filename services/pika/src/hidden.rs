//! Sessions hidden from the public view (spec "Project publishing"). The owner's flags live in `hidden_sessions`, by
//! session id, outside the derived tables. `session_hidden` derives from them and the parent links: it holds the sid
//! of every session that is flagged or has a flagged recorded ancestor, so the public namespace filters hidden
//! sessions in SQL (`crate::read::publishing::SESSION_FILTER`). Derivation keeps it current when a session is
//! recorded or its parent changes; `set` when the owner hides or unhides one.

use std::collections::{HashMap, HashSet};

use anyhow::Result;
use rusqlite::{Connection, OptionalExtension, params};

/// Whether any session is flagged or derived as hidden; without either, nothing needs refreshing.
fn any(conn: &Connection) -> rusqlite::Result<bool> {
    conn.prepare_cached(
        "SELECT EXISTS(SELECT 1 FROM hidden_sessions) OR EXISTS(SELECT 1 FROM session_hidden)",
    )?
    .query_row([], |r| r.get(0))
}

fn flagged(conn: &Connection, id: &str) -> rusqlite::Result<bool> {
    Ok(conn.prepare_cached("SELECT 1 FROM hidden_sessions WHERE id = ?1")?.query_row([id], |_| Ok(())).optional()?.is_some())
}

/// The session's sid and its recorded parent's id, when the session is recorded.
fn node(conn: &Connection, id: &str) -> rusqlite::Result<Option<(i64, Option<String>)>> {
    conn.prepare_cached("SELECT sid, parent_session_id FROM sessions WHERE id = ?1")?
        .query_row([id], |r| Ok((r.get(0)?, r.get(1)?)))
        .optional()
}

/// The nearest flagged session among `id` and its recorded ancestors, stopping at a cycle.
pub fn hidden_by(conn: &Connection, id: &str) -> rusqlite::Result<Option<String>> {
    let mut seen = HashSet::new();
    let mut current = Some(id.to_owned());
    while let Some(id) = current.take() {
        if !seen.insert(id.clone()) {
            break;
        }
        if flagged(conn, &id)? {
            return Ok(Some(id));
        }
        // Only a recorded session leads further up.
        current = node(conn, &id)?.and_then(|(_, parent)| parent);
    }
    Ok(None)
}

/// Recomputes `session_hidden` for `id` and its recorded descendants, after `id` was recorded, changed its parent, or
/// was hidden or unhidden. Cycle-safe.
pub fn refresh(conn: &Connection, id: &str) -> Result<()> {
    if !any(conn)? {
        return Ok(());
    }
    let Some((_, parent)) = node(conn, id)? else { return Ok(()) };
    let inherited = match parent {
        Some(parent) if parent != id => hidden_by(conn, &parent)?.is_some(),
        _ => false,
    };
    let mut seen = HashSet::new();
    let mut stack = vec![(id.to_owned(), inherited)];
    let mut children = conn.prepare_cached("SELECT id FROM sessions WHERE parent_session_id = ?1")?;
    while let Some((id, inherited)) = stack.pop() {
        if !seen.insert(id.clone()) {
            continue;
        }
        let Some((sid, _)) = node(conn, &id)? else { continue };
        let hidden = inherited || flagged(conn, &id)?;
        if hidden {
            conn.prepare_cached("INSERT OR IGNORE INTO session_hidden (sid) VALUES (?1)")?.execute([sid])?;
        } else {
            conn.prepare_cached("DELETE FROM session_hidden WHERE sid = ?1")?.execute([sid])?;
        }
        for child in children.query_map([&id], |r| r.get::<_, String>(0))? {
            stack.push((child?, hidden));
        }
    }
    Ok(())
}

/// Rebuilds `session_hidden` from the flags, as `pika reindex` does after deriving every stream.
pub fn rebuild(conn: &Connection) -> Result<()> {
    conn.execute("DELETE FROM session_hidden", [])?;
    let flags: Vec<String> =
        conn.prepare("SELECT id FROM hidden_sessions")?.query_map([], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?;
    for id in flags {
        refresh(conn, &id)?;
    }
    Ok(())
}

/// Hides or unhides a recorded session and refreshes its subtree. Returns false for a session that is not recorded.
pub fn set(conn: &Connection, id: &str, hidden: bool, now: i64) -> Result<bool> {
    if node(conn, id)?.is_none() {
        return Ok(false);
    }
    if hidden {
        conn.execute("INSERT OR IGNORE INTO hidden_sessions (id, hidden_at) VALUES (?1, ?2)", params![id, now])?;
    } else {
        conn.execute("DELETE FROM hidden_sessions WHERE id = ?1", [id])?;
    }
    refresh(conn, id)?;
    Ok(true)
}

/// The owner's view of which sessions are hidden, loaded once per request from the two small tables and applied in
/// Rust, so the read queries keep their plans (as `crate::read::DeviceNames` does).
pub struct Marks {
    hidden: HashSet<String>,
    by: HashMap<String, Option<String>>,
}

impl Marks {
    pub fn load(conn: &Connection) -> rusqlite::Result<Marks> {
        let hidden = conn
            .prepare_cached("SELECT s.id FROM session_hidden h JOIN sessions s USING (sid)")?
            .query_map([], |r| r.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        Ok(Marks { hidden, by: HashMap::new() })
    }

    /// Sets the summary's `hidden` and `hiddenBy`.
    pub fn mark(&mut self, conn: &Connection, summary: &mut crate::read::sessions::SessionSummary) -> rusqlite::Result<()> {
        let hidden = self.hidden.contains(&summary.id);
        summary.hidden = Some(hidden);
        summary.hidden_by = None;
        if hidden {
            if !self.by.contains_key(&summary.id) {
                self.by.insert(summary.id.clone(), hidden_by(conn, &summary.id)?);
            }
            summary.hidden_by = self.by[&summary.id].clone();
        }
        Ok(())
    }
}
