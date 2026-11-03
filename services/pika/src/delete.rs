//! Deleting sessions, Herder runs, and projects (spec "Deleting and hiding"). A deleted session takes its recorded
//! descendants with it; a deleted project takes its sessions, their descendants, and its Herder runs. Everything they
//! own goes in one transaction: stream and lines, captured requests, derived rows, search documents, session links,
//! hidden flags, and the blob rows nothing else references. A tombstone per deleted stream key (`deleted_streams`)
//! makes ingest discard what a running client keeps uploading, and a session recorded later whose parent or Herder
//! run is tombstoned is deleted on arrival (`delete_orphans`). Blob files are removed after the commit, in a second
//! transaction that skips any blob ingest stored again meanwhile; ingest rewrites a blob file it finds missing (see
//! `ingest::apply`), so the database never references a missing file. An interrupted removal leaves orphan files,
//! which nothing reads.

use std::collections::{BTreeSet, HashSet};

use anyhow::Result;
use rusqlite::{Connection, OptionalExtension, Transaction, params};
use serde::Serialize;

use crate::store::Store;
use crate::util::now_ms;

/// What a deletion removed, or would remove.
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Deleted {
    pub deleted_sessions: u64,
    pub deleted_herder_runs: u64,
}

/// The sessions and Herder runs a deletion covers.
#[derive(Debug, Default)]
pub struct Plan {
    pub sessions: BTreeSet<String>,
    pub herder_runs: BTreeSet<String>,
}

impl Plan {
    pub fn counts(&self) -> Deleted {
        Deleted { deleted_sessions: self.sessions.len() as u64, deleted_herder_runs: self.herder_runs.len() as u64 }
    }
}

/// The stream key of a session.
pub fn session_key(id: &str) -> String {
    format!("session:{id}")
}

/// The stream key of a Herder run.
pub fn run_key(run_id: &str) -> String {
    format!("herder:{run_id}")
}

/// Whether the stream with this key was deleted.
pub fn tombstoned(conn: &Connection, key: &str) -> rusqlite::Result<bool> {
    Ok(conn.prepare_cached("SELECT 1 FROM deleted_streams WHERE key = ?1")?.query_row([key], |_| Ok(())).optional()?.is_some())
}

/// `roots` and every recorded descendant, following `sessions.parent_session_id` down; each session once, whatever
/// cycles the links form.
fn with_descendants(conn: &Connection, roots: impl IntoIterator<Item = String>) -> rusqlite::Result<BTreeSet<String>> {
    let mut found = BTreeSet::new();
    let mut stack: Vec<String> = roots.into_iter().collect();
    let mut children = conn.prepare_cached("SELECT id FROM sessions WHERE parent_session_id = ?1")?;
    while let Some(id) = stack.pop() {
        if !found.insert(id.clone()) {
            continue;
        }
        for child in children.query_map([&id], |r| r.get::<_, String>(0))? {
            stack.push(child?);
        }
    }
    Ok(found)
}

fn recorded(conn: &Connection, id: &str) -> rusqlite::Result<bool> {
    Ok(conn.prepare_cached(crate::read::SESSION_SID_SQL)?.query_row([id], |_| Ok(())).optional()?.is_some())
}

/// What deleting the session `id` covers: it and its recorded descendants. `None` when it is not recorded.
pub fn plan_session(conn: &Connection, id: &str) -> rusqlite::Result<Option<Plan>> {
    if !recorded(conn, id)? {
        return Ok(None);
    }
    Ok(Some(Plan { sessions: with_descendants(conn, [id.to_owned()])?, herder_runs: BTreeSet::new() }))
}

/// What deleting the project `name` covers: its sessions, its Herder runs (by `repo`) and their step sessions, and
/// every recorded descendant of those sessions, whatever their project.
pub fn plan_project(conn: &Connection, name: &str) -> rusqlite::Result<Plan> {
    let mut roots: Vec<String> = conn
        .prepare_cached("SELECT id FROM sessions WHERE project = ?1")?
        .query_map([name], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    let herder_runs: BTreeSet<String> = conn
        .prepare_cached("SELECT run_id FROM herder_runs WHERE repo = ?1")?
        .query_map([name], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    for run in &herder_runs {
        let steps = conn
            .prepare_cached(
                "SELECT id FROM sessions WHERE herder_run_id = ?1
                 UNION SELECT s.id FROM herder_steps t JOIN herder_runs r ON r.rid = t.rid JOIN sessions s ON s.id = t.session_id
                     WHERE r.run_id = ?1",
            )?
            .query_map([run], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        roots.extend(steps);
    }
    Ok(Plan { sessions: with_descendants(conn, roots)?, herder_runs })
}

/// Deletes the session `id` and its recorded descendants. `None` when it is not recorded.
pub fn delete_session(store: &Store, id: &str) -> Result<Option<Deleted>> {
    let done = store.write(|tx| {
        let Some(plan) = plan_session(tx, id)? else { return Ok::<_, anyhow::Error>(None) };
        let blobs = apply(tx, &plan)?;
        Ok(Some((plan.counts(), blobs)))
    })?;
    let Some((deleted, blobs)) = done else { return Ok(None) };
    remove_blob_files(store, blobs)?;
    Ok(Some(deleted))
}

/// Deletes the project `name` (see `plan_project`) and removes it from the publishing selection, so a later project
/// of that name starts private. `None` when nothing was recorded under the name and it was not selected either.
pub fn delete_project(store: &Store, name: &str) -> Result<Option<Deleted>> {
    let done = store.write(|tx| {
        let plan = plan_project(tx, name)?;
        let selected = crate::read::publishing::is_selected(tx, name).map_err(read_error)?;
        if selected {
            crate::read::publishing::update(tx, name, false).map_err(read_error)?;
        }
        if plan.sessions.is_empty() && plan.herder_runs.is_empty() {
            return Ok::<_, anyhow::Error>(selected.then(|| (Deleted::default(), Vec::new())));
        }
        let blobs = apply(tx, &plan)?;
        Ok(Some((plan.counts(), blobs)))
    })?;
    let Some((deleted, blobs)) = done else { return Ok(None) };
    remove_blob_files(store, blobs)?;
    Ok(Some(deleted))
}

/// Whether the recorded session `id` names a deleted parent session or a deleted Herder run. The parent is the
/// derived `parent_session_id`, which already resolves the link's `parentSessionId` or `parentSessionFile` and the
/// header's `parentSession` path to a session id; the run is the link's `herder.runId`.
fn orphaned(conn: &Connection, id: &str) -> rusqlite::Result<bool> {
    conn.prepare_cached(
        "SELECT EXISTS(SELECT 1 FROM sessions s WHERE s.id = ?1 AND (
             EXISTS(SELECT 1 FROM deleted_streams WHERE key = 'session:' || s.parent_session_id)
             OR EXISTS(SELECT 1 FROM deleted_streams WHERE key = 'herder:' || s.herder_run_id)))",
    )?
    .query_row([id], |r| r.get(0))
}

/// Deletes those of the sessions `ids` whose recorded parent or Herder run was deleted, with their recorded
/// descendants, as deleting the parent or run would have: a session recorded after its parent or run was deleted
/// (a late child, a spooled upload, or a step of a running Herder run) is deleted on arrival, and one whose parent
/// becomes known later is deleted then. Ingest calls it in its transaction once a batch is derived. Returns the
/// hashes of the blob rows it deleted, whose files the caller removes after the commit (`remove_blob_files`).
pub fn delete_orphans<'a>(tx: &Transaction, ids: impl IntoIterator<Item = &'a str>) -> Result<Vec<String>> {
    let mut roots = Vec::new();
    for id in ids {
        if orphaned(tx, id)? {
            roots.push(id.to_owned());
        }
    }
    if roots.is_empty() {
        return Ok(Vec::new());
    }
    let plan = Plan { sessions: with_descendants(tx, roots)?, herder_runs: BTreeSet::new() };
    apply(tx, &plan)
}

/// `delete_orphans` over every recorded session, as `pika reindex` runs it after deriving every stream.
pub fn delete_all_orphans(tx: &Transaction) -> Result<Vec<String>> {
    let ids: Vec<String> =
        tx.prepare("SELECT id FROM sessions")?.query_map([], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?;
    delete_orphans(tx, ids.iter().map(String::as_str))
}

fn read_error(e: crate::read::ReadError) -> anyhow::Error {
    anyhow::anyhow!("{e}")
}

/// Deletes everything the plan covers and records the tombstones. Returns the hashes of the blob rows it deleted,
/// whose files the caller removes after the commit.
fn apply(tx: &Transaction, plan: &Plan) -> Result<Vec<String>> {
    let now = now_ms();
    let mut candidates: BTreeSet<String> = BTreeSet::new();
    let mut parents: HashSet<String> = HashSet::new();
    for id in &plan.sessions {
        delete_session_rows(tx, id, &mut candidates, &mut parents)?;
        tx.prepare_cached("INSERT OR REPLACE INTO deleted_streams (key, deleted_at) VALUES (?1, ?2)")?
            .execute(params![session_key(id), now])?;
    }
    for run in &plan.herder_runs {
        delete_run_rows(tx, run, &mut candidates)?;
        tx.prepare_cached("INSERT OR REPLACE INTO deleted_streams (key, deleted_at) VALUES (?1, ?2)")?
            .execute(params![run_key(run), now])?;
    }
    // The surviving parents of deleted children count their children again.
    for parent in parents.iter().filter(|p| !plan.sessions.contains(*p)) {
        tx.prepare_cached(
            "UPDATE sessions SET child_count = (SELECT COUNT(*) FROM sessions WHERE parent_session_id = ?1) WHERE id = ?1",
        )?
        .execute([parent])?;
    }
    let mut unreferenced = Vec::new();
    for hash in candidates {
        let bytes = hex::decode(&hash)?;
        let referenced: bool = tx
            .prepare_cached(
                "SELECT EXISTS(SELECT 1 FROM lines WHERE blob = ?1) OR EXISTS(SELECT 1 FROM request_dict WHERE hash = ?2)",
            )?
            .query_row(params![hash, bytes], |r| r.get(0))?;
        if !referenced && tx.prepare_cached("DELETE FROM blobs WHERE hash = ?1")?.execute([&hash])? > 0 {
            unreferenced.push(hash);
        }
    }
    Ok(unreferenced)
}

fn delete_session_rows(
    tx: &Transaction,
    id: &str,
    candidates: &mut BTreeSet<String>,
    parents: &mut HashSet<String>,
) -> Result<()> {
    let sid: Option<i64> =
        tx.prepare_cached("SELECT id FROM streams WHERE key = ?1")?.query_row([session_key(id)], |r| r.get(0)).optional()?;
    // A session row without a stream cannot be ingested, but its sid is the stream id; use whichever exists.
    let sid = match sid {
        Some(sid) => Some(sid),
        None => tx.prepare_cached(crate::read::SESSION_SID_SQL)?.query_row([id], |r| r.get(0)).optional()?,
    };
    if let Some(sid) = sid {
        let row: Option<(Option<String>, String)> = tx
            .prepare_cached("SELECT parent_session_id, models FROM sessions WHERE sid = ?1")?
            .query_row([sid], |r| Ok((r.get(0)?, r.get(1)?)))
            .optional()?;
        if let Some((parent, models)) = row {
            parents.extend(parent);
            let models: Vec<String> = serde_json::from_str(&models).unwrap_or_default();
            for model in models {
                tx.prepare_cached("DELETE FROM session_models WHERE model = ?1 AND sid = ?2")?.execute(params![model, sid])?;
            }
        }
        for row in tx.prepare_cached("SELECT blob FROM lines WHERE stream_id = ?1 AND blob IS NOT NULL")?.query_map([sid], |r| r.get(0))? {
            candidates.insert(row?);
        }
        // The full-text index has external content: each document leaves it with the text it was indexed with.
        tx.prepare_cached(
            "INSERT INTO search_fts (search_fts, rowid, text) SELECT 'delete', id, text FROM search_docs WHERE sid = ?1",
        )?
        .execute([sid])?;
        for sql in [
            "DELETE FROM search_docs WHERE sid = ?1",
            "DELETE FROM entries WHERE sid = ?1",
            "DELETE FROM turns WHERE sid = ?1",
            "DELETE FROM model_calls WHERE sid = ?1",
            "DELETE FROM usage_events WHERE sid = ?1",
            "DELETE FROM tool_calls WHERE sid = ?1",
            "DELETE FROM session_links WHERE sid = ?1",
            "DELETE FROM session_hidden WHERE sid = ?1",
            "DELETE FROM sessions WHERE sid = ?1",
            "DELETE FROM lines WHERE stream_id = ?1",
            "DELETE FROM streams WHERE id = ?1",
        ] {
            tx.prepare_cached(sql)?.execute([sid])?;
        }
    }
    // Captured requests, also those that arrived for a session whose stream never did.
    let rs: Option<i64> =
        tx.prepare_cached("SELECT id FROM request_sessions WHERE session_id = ?1")?.query_row([id], |r| r.get(0)).optional()?;
    if let Some(rs) = rs {
        for row in tx.prepare_cached("SELECT hash FROM request_dict WHERE rs = ?1")?.query_map([rs], |r| r.get::<_, Vec<u8>>(0))? {
            candidates.insert(hex::encode(row?));
        }
        tx.prepare_cached("DELETE FROM request_dict WHERE rs = ?1")?.execute([rs])?;
        tx.prepare_cached("DELETE FROM request_sessions WHERE id = ?1")?.execute([rs])?;
    }
    tx.prepare_cached("DELETE FROM request_missing WHERE request_id IN (SELECT id FROM requests WHERE session_id = ?1)")?
        .execute([id])?;
    tx.prepare_cached("DELETE FROM requests WHERE session_id = ?1")?.execute([id])?;
    tx.prepare_cached("DELETE FROM hidden_sessions WHERE id = ?1")?.execute([id])?;
    Ok(())
}

fn delete_run_rows(tx: &Transaction, run: &str, candidates: &mut BTreeSet<String>) -> Result<()> {
    let rid: Option<i64> =
        tx.prepare_cached("SELECT id FROM streams WHERE key = ?1")?.query_row([run_key(run)], |r| r.get(0)).optional()?;
    let rid = match rid {
        Some(rid) => Some(rid),
        None => tx.prepare_cached("SELECT rid FROM herder_runs WHERE run_id = ?1")?.query_row([run], |r| r.get(0)).optional()?,
    };
    if let Some(rid) = rid {
        for row in tx.prepare_cached("SELECT blob FROM lines WHERE stream_id = ?1 AND blob IS NOT NULL")?.query_map([rid], |r| r.get(0))? {
            candidates.insert(row?);
        }
        for sql in [
            "DELETE FROM herder_events WHERE rid = ?1",
            "DELETE FROM herder_steps WHERE rid = ?1",
            "DELETE FROM herder_runs WHERE rid = ?1",
            "DELETE FROM lines WHERE stream_id = ?1",
            "DELETE FROM streams WHERE id = ?1",
        ] {
            tx.prepare_cached(sql)?.execute([rid])?;
        }
    }
    let key = run_key(run);
    tx.prepare_cached("DELETE FROM documents WHERE run_id = ?1 OR key IN (?2, ?3)")?
        .execute(params![run, format!("{key}:goal.md"), format!("{key}:plan.md")])?;
    Ok(())
}

/// Removes the files of blobs whose rows a deletion removed, under the write lock, skipping any that ingest stored
/// again since the deletion committed. A file that cannot be removed stays as an orphan; nothing reads it.
pub fn remove_blob_files(store: &Store, hashes: Vec<String>) -> Result<()> {
    if hashes.is_empty() {
        return Ok(());
    }
    store.write(|tx| {
        for hash in &hashes {
            let stored = tx.prepare_cached("SELECT 1 FROM blobs WHERE hash = ?1")?.query_row([hash], |_| Ok(())).optional()?.is_some();
            if stored {
                continue;
            }
            let path = store.blobs.path(hash);
            if let Err(e) = std::fs::remove_file(&path)
                && e.kind() != std::io::ErrorKind::NotFound
            {
                tracing::warn!("could not remove blob file {}: {e}", path.display());
            }
        }
        Ok::<_, rusqlite::Error>(())
    })?;
    Ok(())
}
