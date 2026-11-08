//! Sessions hidden from the public view (spec "Project publishing"). The owner's flags live in `hidden_sessions`, by
//! session id, outside the derived tables. A dream's own session (session-link `agentType` `memory-dream`) hides
//! itself, without a flag. `session_hidden` derives from both and the parent links: it holds the sid of every session
//! that is flagged or a dream's, or has such a recorded ancestor, so the public namespace filters hidden sessions in
//! SQL (`crate::read::publishing::SESSION_FILTER`). Derivation keeps it current when a session is recorded, its parent
//! changes, or its link is recorded; `set` when the owner hides or unhides one. A dream's family is never searched:
//! refreshing it also removes the search documents its sessions had before the link arrived.

use std::collections::{HashMap, HashSet};

use anyhow::Result;
use rusqlite::{Connection, OptionalExtension, params};

use crate::memory::dream::AGENT_TYPE as DREAM;

/// Whether any session is flagged or derived as hidden, or `id` is a dream's; without either, nothing needs
/// refreshing.
fn any(conn: &Connection, id: &str) -> rusqlite::Result<bool> {
    let any: bool = conn
        .prepare_cached("SELECT EXISTS(SELECT 1 FROM hidden_sessions) OR EXISTS(SELECT 1 FROM session_hidden)")?
        .query_row([], |r| r.get(0))?;
    Ok(any || dream(conn, id)?)
}

fn flagged(conn: &Connection, id: &str) -> rusqlite::Result<bool> {
    Ok(conn.prepare_cached("SELECT 1 FROM hidden_sessions WHERE id = ?1")?.query_row([id], |_| Ok(())).optional()?.is_some())
}

/// Whether the recorded session is a dream's own session, by its derived link.
fn dream(conn: &Connection, id: &str) -> rusqlite::Result<bool> {
    Ok(conn
        .prepare_cached("SELECT 1 FROM sessions s JOIN session_links l ON l.sid = s.sid WHERE s.id = ?1 AND l.agent_type = ?2")?
        .query_row(params![id, DREAM], |_| Ok(()))
        .optional()?
        .is_some())
}

/// The session's sid and its recorded parent's id, when the session is recorded.
fn node(conn: &Connection, id: &str) -> rusqlite::Result<Option<(i64, Option<String>)>> {
    conn.prepare_cached("SELECT sid, parent_session_id FROM sessions WHERE id = ?1")?
        .query_row([id], |r| Ok((r.get(0)?, r.get(1)?)))
        .optional()
}

/// The nearest session among `id` and its recorded ancestors for which `hides` holds, stopping at a cycle.
fn nearest(
    conn: &Connection,
    id: &str,
    hides: impl Fn(&Connection, &str) -> rusqlite::Result<bool>,
) -> rusqlite::Result<Option<String>> {
    let mut seen = HashSet::new();
    let mut current = Some(id.to_owned());
    while let Some(id) = current.take() {
        if !seen.insert(id.clone()) {
            break;
        }
        if hides(conn, &id)? {
            return Ok(Some(id));
        }
        // Only a recorded session leads further up.
        current = node(conn, &id)?.and_then(|(_, parent)| parent);
    }
    Ok(None)
}

/// The nearest session among `id` and its recorded ancestors that hides itself: flagged, or a dream's.
pub fn hidden_by(conn: &Connection, id: &str) -> rusqlite::Result<Option<String>> {
    nearest(conn, id, |conn, id| Ok(flagged(conn, id)? || dream(conn, id)?))
}

/// Whether `id` is a dream's session or a recorded descendant of one, which search never indexes. Only a session in
/// `session_hidden`, kept current by derivation, can be.
pub fn in_dream(conn: &Connection, id: &str) -> rusqlite::Result<bool> {
    let hidden = conn
        .prepare_cached("SELECT 1 FROM sessions s JOIN session_hidden h ON h.sid = s.sid WHERE s.id = ?1")?
        .query_row([id], |_| Ok(()))
        .optional()?;
    Ok(hidden.is_some() && nearest(conn, id, dream)?.is_some())
}

/// Recomputes `session_hidden` for `id` and its recorded descendants, after `id` was recorded, changed its parent,
/// recorded its link, or was hidden or unhidden, and removes the search documents of those in a dream's family.
/// Cycle-safe.
pub fn refresh(conn: &Connection, id: &str) -> Result<()> {
    if !any(conn, id)? {
        return Ok(());
    }
    let Some((_, parent)) = node(conn, id)? else { return Ok(()) };
    let (inherited, in_dream) = match parent {
        Some(parent) if parent != id => (hidden_by(conn, &parent)?.is_some(), nearest(conn, &parent, dream)?.is_some()),
        _ => (false, false),
    };
    let mut seen = HashSet::new();
    let mut stack = vec![(id.to_owned(), inherited, in_dream)];
    let mut children = conn.prepare_cached("SELECT id FROM sessions WHERE parent_session_id = ?1")?;
    while let Some((id, inherited, in_dream)) = stack.pop() {
        if !seen.insert(id.clone()) {
            continue;
        }
        let Some((sid, _)) = node(conn, &id)? else { continue };
        let in_dream = in_dream || dream(conn, &id)?;
        let hidden = inherited || in_dream || flagged(conn, &id)?;
        if hidden {
            conn.prepare_cached("INSERT OR IGNORE INTO session_hidden (sid) VALUES (?1)")?.execute([sid])?;
        } else {
            conn.prepare_cached("DELETE FROM session_hidden WHERE sid = ?1")?.execute([sid])?;
        }
        if in_dream {
            crate::derive::search::remove(conn, sid)?;
        }
        for child in children.query_map([&id], |r| r.get::<_, String>(0))? {
            stack.push((child?, hidden, in_dream));
        }
    }
    Ok(())
}

/// Rebuilds `session_hidden` from the flags and the dreams' links, as `pika reindex` does after deriving every stream.
pub fn rebuild(conn: &Connection) -> Result<()> {
    conn.execute("DELETE FROM session_hidden", [])?;
    let roots: Vec<String> = conn
        .prepare(
            "SELECT id FROM hidden_sessions
             UNION SELECT s.id FROM session_links l JOIN sessions s ON s.sid = l.sid WHERE l.agent_type = ?1",
        )?
        .query_map([DREAM], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    for id in roots {
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
