//! Dreaming (spec "Dreaming" under "Memory"): a device leases a project scope, reads the scope's sessions past their
//! checkpoints, and commits its note changes as one batch that also advances those checkpoints. A lease is live until
//! it is released or expires; at most one is live per scope, and `auto` leases also wait out a cooldown after a
//! completed dream, a daily quota, and new activity. Every function takes the time, so tests can move it. The tables
//! are not derived: `pika reindex` leaves them alone.

use std::collections::BTreeSet;

use rusqlite::{Connection, OptionalExtension, Transaction, params};
use serde::{Deserialize, Serialize};

use super::{
    Author, Index, LIMIT_BYTES, LIMIT_LINES, MemoryError, Note, Scope, Source, bad, check_revision, fields, groups, iso,
    iso_opt, note, project_scope, put, reason, remove, request_scopes, scrubbed, session_id, stored,
};
use crate::redact::scrub_cut_text;
use crate::util::random_bytes;

/// How long a lease lives after its grant or its last renewal.
pub const LEASE_TTL_MS: i64 = 15 * 60_000;
/// How long after a scope's latest `completed` dream an `auto` lease is refused.
pub const AUTO_COOLDOWN_MS: i64 = 4 * 3_600_000;
/// The most `auto` leases granted per scope per UTC day.
pub const AUTO_DAILY_LIMIT: i64 = 3;
/// The most sessions a lease lists.
pub const DREAM_SESSION_LIMIT: usize = 50;
/// The most changes per commit.
pub const MAX_CHANGES: usize = 50;
/// The most sources per change.
pub const MAX_SOURCES: usize = 20;
const MAX_SUMMARY: usize = 1000;
const DAY_MS: i64 = 86_400_000;
/// The session-link `agentType` of a dream's own session, which with its descendants is never a scope session.
pub const AGENT_TYPE: &str = "memory-dream";
/// The provenance of what a commit writes.
const DREAM: &str = "dream";
const OUTCOMES: [&str; 3] = ["completed", "aborted", "failed"];

#[derive(Debug)]
pub enum DreamError {
    BadRequest(String),
    /// A live lease holds the scope until `expires_at`.
    Busy { expires_at: i64 },
    /// An `auto` lease is refused for `reason` (`cooldown`, `quota`, or `no_activity`) until `retry_at`, if known.
    NotDue { reason: &'static str, retry_at: Option<i64> },
    /// The lease is unknown, released, expired, or another device's.
    LeaseLost,
    /// The stored note of the change at index `change`, whose revision differs from its `expectedRevision`.
    Conflict { note: Box<Note>, change: usize },
    /// The index the commit would produce.
    Full { bytes: usize, lines: usize },
    Internal(anyhow::Error),
}

impl From<rusqlite::Error> for DreamError {
    fn from(e: rusqlite::Error) -> Self {
        DreamError::Internal(e.into())
    }
}

impl From<MemoryError> for DreamError {
    fn from(e: MemoryError) -> Self {
        DreamError::in_change(None, e)
    }
}

impl DreamError {
    /// A note error, for the change at index `change` if any.
    fn in_change(change: Option<usize>, e: MemoryError) -> DreamError {
        let at = |message: String| match change {
            Some(i) => DreamError::BadRequest(format!("changes[{i}]: {message}")),
            None => DreamError::BadRequest(message),
        };
        match e {
            MemoryError::BadRequest(message) => at(message),
            MemoryError::NotFound => at("no live note with this id in the user scope or the lease's scope".into()),
            MemoryError::Conflict(note) => DreamError::Conflict { note, change: change.unwrap_or_default() },
            MemoryError::Full { bytes, lines } => DreamError::Full { bytes, lines },
            MemoryError::Internal(e) => DreamError::Internal(e),
        }
    }
}

/// A session of a lease's snapshot: its entries `from_seq` through `to_seq` are new to the scope.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Leased {
    pub id: String,
    pub from_seq: i64,
    pub to_seq: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Lease {
    pub id: String,
    pub scope: Scope,
    /// `auto` or `manual`.
    pub mode: String,
    pub device_id: String,
    pub session_id: Option<String>,
    #[serde(serialize_with = "iso")]
    pub granted_at: i64,
    #[serde(serialize_with = "iso")]
    pub expires_at: i64,
    #[serde(serialize_with = "iso_opt")]
    pub released_at: Option<i64>,
    /// `completed`, `aborted`, or `failed` once released.
    pub outcome: Option<String>,
    /// The snapshot of sessions it was granted with.
    #[serde(skip)]
    pub sessions: Vec<Leased>,
}

impl Lease {
    fn live(&self, now: i64) -> bool {
        self.released_at.is_none() && self.expires_at > now
    }
}

/// A scope session with entries past its checkpoint, as a lease lists it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DreamSession {
    pub id: String,
    pub title: Option<String>,
    pub project: Option<String>,
    pub from_seq: i64,
    pub to_seq: i64,
    #[serde(serialize_with = "iso")]
    pub last_at: i64,
}

/// `POST memory/dream/lease`: the lease and its sessions.
#[derive(Debug, Serialize)]
pub struct Granted {
    pub lease: Lease,
    pub sessions: Vec<DreamSession>,
}

/// A revision a batch wrote.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchChange {
    pub note_id: String,
    pub revision: i64,
    /// `save` or `forget`.
    pub action: String,
    pub title: String,
    /// Whether the save created the note.
    pub created: bool,
}

/// One committed dream.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Batch {
    pub id: String,
    pub lease_id: String,
    pub scope: Scope,
    pub mode: String,
    #[serde(serialize_with = "iso")]
    pub at: i64,
    pub device_id: String,
    pub session_id: Option<String>,
    pub dream_session_id: Option<String>,
    pub summary: Option<String>,
    /// The sessions whose checkpoints it advanced.
    pub sessions: Vec<String>,
    /// The revisions it wrote, in order.
    pub changes: Vec<BatchChange>,
    #[serde(serialize_with = "iso_opt")]
    pub reverted_at: Option<i64>,
}

/// `POST memory/dream/:id/commit`: the batch and the index of the user scope and the lease's scope after it.
#[derive(Debug, Serialize)]
pub struct Committed {
    pub batch: Batch,
    #[serde(flatten)]
    pub index: Index,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LeaseRequest {
    pub project: Option<String>,
    pub repository: Option<String>,
    pub session_id: Option<String>,
    pub mode: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Release {
    pub outcome: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Commit {
    pub dream_session_id: Option<String>,
    pub summary: Option<String>,
    #[serde(default)]
    pub sessions: Vec<String>,
    #[serde(default)]
    pub changes: Vec<Change>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "op", rename_all = "lowercase")]
pub enum Change {
    Save(SaveChange),
    Forget(ForgetChange),
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveChange {
    pub id: Option<String>,
    pub expected_revision: i64,
    /// `user`, or `project` for the lease's scope.
    pub scope: String,
    pub category: String,
    pub title: String,
    pub hook: String,
    #[serde(default)]
    pub body: String,
    pub reason: Option<String>,
    #[serde(default)]
    pub sources: Vec<Source>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForgetChange {
    pub id: String,
    pub expected_revision: i64,
    pub reason: Option<String>,
    #[serde(default)]
    pub sources: Vec<Source>,
}

/// A new id for `table`: 16 lowercase hex digits, unused there.
fn new_id(tx: &Transaction, table: &str) -> rusqlite::Result<String> {
    loop {
        let id = hex::encode(random_bytes::<8>());
        let used = tx.prepare_cached(&format!("SELECT 1 FROM {table} WHERE id = ?1"))?.query_row([&id], |_| Ok(())).optional()?;
        if used.is_none() {
            return Ok(id);
        }
    }
}

const LEASE_SELECT: &str = "SELECT l.id, l.mode, l.device_id, l.session_id, l.granted_at, l.expires_at, l.released_at,
    l.outcome, l.sessions, s.key, s.kind, s.label
    FROM memory_dream_leases l JOIN memory_scopes s ON s.key = l.scope_key";

fn lease_row(r: &rusqlite::Row) -> rusqlite::Result<Lease> {
    Ok(Lease {
        id: r.get(0)?,
        mode: r.get(1)?,
        device_id: r.get(2)?,
        session_id: r.get(3)?,
        granted_at: r.get(4)?,
        expires_at: r.get(5)?,
        released_at: r.get(6)?,
        outcome: r.get(7)?,
        sessions: serde_json::from_str(&r.get::<_, String>(8)?).unwrap_or_default(),
        scope: Scope { key: r.get(9)?, kind: r.get(10)?, label: r.get(11)? },
    })
}

fn load_lease(conn: &Connection, id: &str) -> rusqlite::Result<Option<Lease>> {
    conn.prepare_cached(&format!("{LEASE_SELECT} WHERE l.id = ?1"))?.query_row([id], lease_row).optional()
}

/// The lease `id` when it is live and `device`'s.
fn held(conn: &Connection, device: &str, id: &str, now: i64) -> Result<Lease, DreamError> {
    load_lease(conn, id)?.filter(|l| l.device_id == device && l.live(now)).ok_or(DreamError::LeaseLost)
}

/// The scope's sessions with entries past their checkpoint, oldest activity first, at most `DREAM_SESSION_LIMIT`:
/// for a `repo:` scope the sessions whose repository normalizes to its URL, for a `local:` scope the sessions of its
/// project recorded from its device. Dream sessions (session-link `agentType` `memory-dream`) and their descendants
/// are never scope sessions.
pub fn scope_sessions(conn: &Connection, key: &str) -> rusqlite::Result<Vec<DreamSession>> {
    let (filter, repository, local) = if let Some(url) = key.strip_prefix("repo:") {
        ("s.repository IS NOT NULL", Some(url), None)
    } else if let Some((project, device)) = key.strip_prefix("local:").and_then(|rest| rest.rsplit_once('@')) {
        ("s.project = ?3 AND s.device = ?4", None, Some((project, device)))
    } else {
        return Ok(Vec::new());
    };
    let (project, device) = local.unzip();
    let sql = format!(
        "WITH RECURSIVE dream(id) AS (
             SELECT s.id FROM session_links l JOIN sessions s ON s.sid = l.sid WHERE l.agent_type = ?2
             UNION SELECT c.id FROM sessions c JOIN dream d ON c.parent_session_id = d.id
         )
         SELECT id, title, project, last_at, repository, to_seq, checkpoint FROM (
             SELECT s.id, s.title, s.project, s.last_at, s.repository,
                 (SELECT MAX(e.seq) FROM entries e WHERE e.sid = s.sid) AS to_seq,
                 COALESCE((SELECT c.seq FROM memory_checkpoints c WHERE c.scope_key = ?1 AND c.session_id = s.id), -1)
                     AS checkpoint
             FROM sessions s WHERE {filter} AND s.id NOT IN (SELECT id FROM dream)
         ) WHERE to_seq > checkpoint ORDER BY last_at, id"
    );
    let mut stmt = conn.prepare_cached(&sql)?;
    let mut rows = match local {
        Some(_) => stmt.query(params![key, AGENT_TYPE, project, device])?,
        None => stmt.query(params![key, AGENT_TYPE])?,
    };
    let mut sessions = Vec::new();
    while sessions.len() < DREAM_SESSION_LIMIT
        && let Some(r) = rows.next()?
    {
        if let Some(url) = repository {
            let theirs: String = r.get(4)?;
            if super::normalize_repository(&theirs).as_deref() != Some(url) {
                continue;
            }
        }
        let title: Option<String> = r.get(1)?;
        let checkpoint: i64 = r.get(6)?;
        sessions.push(DreamSession {
            id: r.get(0)?,
            title: title.map(|t| scrub_cut_text(&t).into_owned()),
            project: r.get(2)?,
            last_at: r.get(3)?,
            from_seq: checkpoint + 1,
            to_seq: r.get(5)?,
        });
    }
    Ok(sessions)
}

/// `POST memory/dream/lease`: grants `device` a lease on the project scope the request names, unless a live lease
/// holds it, or, for `auto`, the scope is cooling down after a completed dream, has used its daily quota, or has no
/// session with entries past its checkpoint. The checks and the grant are one write transaction, so of concurrent
/// requests at most one is granted. Stores the scope if it is not yet, so deleting its project finds the lease.
pub fn lease(tx: &Transaction, device: &str, request: LeaseRequest, now: i64) -> Result<Granted, DreamError> {
    let auto = match request.mode.as_str() {
        "auto" => true,
        "manual" => false,
        _ => return Err(DreamError::BadRequest("mode must be auto or manual".into())),
    };
    let session_id = session_id(request.session_id.as_deref())?;
    let scope = project_scope(request.project.as_deref(), request.repository.as_deref(), device)?
        .ok_or_else(|| DreamError::BadRequest("project or repository is required".into()))?;
    let scope = stored(tx, scope)?;
    let busy: Option<i64> = tx
        .prepare_cached(
            "SELECT MAX(expires_at) FROM memory_dream_leases WHERE scope_key = ?1 AND released_at IS NULL AND expires_at > ?2",
        )?
        .query_row(params![scope.key, now], |r| r.get(0))?;
    if let Some(expires_at) = busy {
        return Err(DreamError::Busy { expires_at });
    }
    if auto {
        let completed: Option<i64> = tx
            .prepare_cached("SELECT MAX(released_at) FROM memory_dream_leases WHERE scope_key = ?1 AND outcome = 'completed'")?
            .query_row([&scope.key], |r| r.get(0))?;
        if let Some(retry_at) = completed.map(|at| at + AUTO_COOLDOWN_MS).filter(|retry_at| now < *retry_at) {
            return Err(DreamError::NotDue { reason: "cooldown", retry_at: Some(retry_at) });
        }
        let today = now - now.rem_euclid(DAY_MS);
        let granted: i64 = tx
            .prepare_cached(
                "SELECT COUNT(*) FROM memory_dream_leases WHERE scope_key = ?1 AND mode = 'auto' AND granted_at >= ?2",
            )?
            .query_row(params![scope.key, today], |r| r.get(0))?;
        if granted >= AUTO_DAILY_LIMIT {
            return Err(DreamError::NotDue { reason: "quota", retry_at: Some(today + DAY_MS) });
        }
    }
    let sessions = scope_sessions(tx, &scope.key)?;
    if auto && sessions.is_empty() {
        return Err(DreamError::NotDue { reason: "no_activity", retry_at: None });
    }
    tx.prepare_cached(
        "INSERT INTO memory_scopes (key, kind, label, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)
         ON CONFLICT (key) DO NOTHING",
    )?
    .execute(params![scope.key, scope.kind, scope.label, now])?;
    let lease = Lease {
        id: new_id(tx, "memory_dream_leases")?,
        scope,
        mode: request.mode,
        device_id: device.to_owned(),
        session_id,
        granted_at: now,
        expires_at: now + LEASE_TTL_MS,
        released_at: None,
        outcome: None,
        sessions: sessions.iter().map(|s| Leased { id: s.id.clone(), from_seq: s.from_seq, to_seq: s.to_seq }).collect(),
    };
    tx.prepare_cached(
        "INSERT INTO memory_dream_leases (id, scope_key, mode, device_id, session_id, granted_at, expires_at, sessions)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
    )?
    .execute(params![
        lease.id,
        lease.scope.key,
        lease.mode,
        lease.device_id,
        lease.session_id,
        lease.granted_at,
        lease.expires_at,
        serde_json::to_string(&lease.sessions).expect("sessions serialize")
    ])?;
    Ok(Granted { lease, sessions })
}

/// `POST memory/dream/:id/renew`: extends `device`'s live lease to `LEASE_TTL_MS` from now.
pub fn renew(tx: &Transaction, device: &str, id: &str, now: i64) -> Result<Lease, DreamError> {
    let lease = held(tx, device, id, now)?;
    let expires_at = now + LEASE_TTL_MS;
    tx.prepare_cached("UPDATE memory_dream_leases SET expires_at = ?2 WHERE id = ?1")?.execute(params![id, expires_at])?;
    Ok(Lease { expires_at, ..lease })
}

/// `POST memory/dream/:id/release`: ends `device`'s lease with `outcome`, also an expired one. Releasing a released
/// lease changes nothing.
pub fn release(tx: &Transaction, device: &str, id: &str, request: Release, now: i64) -> Result<Lease, DreamError> {
    if !OUTCOMES.contains(&request.outcome.as_str()) {
        return Err(DreamError::BadRequest(format!("outcome must be one of {}", OUTCOMES.join(", "))));
    }
    let lease = load_lease(tx, id)?.filter(|l| l.device_id == device).ok_or(DreamError::LeaseLost)?;
    if lease.released_at.is_some() {
        return Ok(lease);
    }
    tx.prepare_cached("UPDATE memory_dream_leases SET released_at = ?2, outcome = ?3 WHERE id = ?1")?
        .execute(params![id, now, request.outcome])?;
    Ok(Lease { released_at: Some(now), outcome: Some(request.outcome), ..lease })
}

/// Checks a change's sources: `min` to `MAX_SOURCES` of them, each naming an entry of a recorded session.
fn check_sources(conn: &Connection, sources: &[Source], min: usize) -> Result<(), MemoryError> {
    if sources.len() < min || sources.len() > MAX_SOURCES {
        return Err(bad(format!("sources must be {min} to {MAX_SOURCES} entries")));
    }
    let mut entry = conn.prepare_cached(
        "SELECT 1 FROM sessions s JOIN entries e ON e.sid = s.sid WHERE s.id = ?1 AND e.seq = ?2",
    )?;
    for source in sources {
        if entry.query_row(params![source.session_id, source.seq], |_| Ok(())).optional()?.is_none() {
            return Err(bad(format!("source {}#{} names no entry of a recorded session", source.session_id, source.seq)));
        }
    }
    Ok(())
}

/// `POST memory/dream/:id/commit`: in one transaction with the caller (`Store::write`), applies the changes in order
/// to the user scope and the lease's scope with v1's validation, scrubbing, and revisions, checks the budget of the
/// final index when a change saves, advances each listed session's checkpoint to the lease's `toSeq` for it (never
/// back), and records one batch. Writes before it fails, so the caller must commit only on `Ok`.
pub fn commit(tx: &Transaction, device: &str, id: &str, request: Commit, now: i64) -> Result<Committed, DreamError> {
    let lease = held(tx, device, id, now)?;
    if request.sessions.is_empty() && request.changes.is_empty() {
        return Err(DreamError::BadRequest("a commit needs sessions or changes".into()));
    }
    if request.changes.len() > MAX_CHANGES {
        return Err(DreamError::BadRequest(format!("a commit has at most {MAX_CHANGES} changes")));
    }
    let dream_session_id = session_id(request.dream_session_id.as_deref())
        .map_err(|_| DreamError::BadRequest("dreamSessionId must be at most 256 bytes without control characters".into()))?;
    let summary = request.summary.as_deref().map(|s| scrubbed(s, true)).filter(|s| !s.is_empty());
    if summary.as_ref().is_some_and(|s| s.chars().count() > MAX_SUMMARY) {
        return Err(DreamError::BadRequest(format!("summary must be at most {MAX_SUMMARY} characters")));
    }
    let mut seen = BTreeSet::new();
    let mut sessions = Vec::new();
    for session in request.sessions {
        let Some(leased) = lease.sessions.iter().find(|l| l.id == session) else {
            return Err(DreamError::BadRequest(format!("session {session} is not in the lease")));
        };
        if seen.insert(session.clone()) {
            sessions.push(leased);
        }
    }
    let batch_id = new_id(tx, "memory_dream_batches")?;
    let project = stored(tx, lease.scope.clone())?;
    let mut changes = Vec::new();
    let mut saved = false;
    for (i, change) in request.changes.into_iter().enumerate() {
        let at = |e: MemoryError| DreamError::in_change(Some(i), e);
        let mut author = Author {
            device,
            session_id: dream_session_id.clone().or_else(|| lease.session_id.clone()),
            provenance: DREAM,
            sources: Vec::new(),
            batch_id: Some(&batch_id),
            reason: None,
            now,
        };
        // A note forgotten since the dream read it has a newer revision than the dream expects.
        let forgotten = |id: &str| -> Result<(), DreamError> {
            match note(tx, id)? {
                Some(n) if n.deleted_at.is_some() && (n.scope.key == super::USER || n.scope.key == project.key) => {
                    Err(DreamError::Conflict { note: Box::new(n), change: i })
                }
                _ => Ok(()),
            }
        };
        let note = match change {
            Change::Save(save) => {
                check_revision(save.expected_revision).map_err(at)?;
                let fields = fields(&save.category, &save.title, &save.hook, &save.body).map_err(at)?;
                author.reason = reason(save.reason.as_deref()).map_err(at)?;
                check_sources(tx, &save.sources, 1).map_err(at)?;
                author.sources = save.sources;
                let target = match save.scope.as_str() {
                    "user" => stored(tx, Scope::user())?,
                    "project" => project.clone(),
                    _ => return Err(at(bad("scope must be user or project"))),
                };
                if let Some(id) = &save.id {
                    forgotten(id)?;
                }
                saved = true;
                put(tx, target, save.id.as_deref(), save.expected_revision, fields, &author).map_err(at)?
            }
            Change::Forget(forget) => {
                check_revision(forget.expected_revision).map_err(at)?;
                author.reason = reason(forget.reason.as_deref()).map_err(at)?;
                check_sources(tx, &forget.sources, 0).map_err(at)?;
                author.sources = forget.sources;
                forgotten(&forget.id)?;
                remove(tx, &forget.id, forget.expected_revision, Some(&project), &author).map_err(at)?
            }
        };
        let action = if note.deleted_at.is_some() { "forget" } else { "save" };
        changes.push(BatchChange {
            note_id: note.id,
            revision: note.revision,
            action: action.into(),
            title: note.title,
            created: action == "save" && note.revision == 1,
        });
    }
    let index = Index::new(&groups(tx, request_scopes(tx, Some(project.clone()))?)?);
    if saved && (index.index_bytes > LIMIT_BYTES || index.index_lines > LIMIT_LINES) {
        return Err(DreamError::Full { bytes: index.index_bytes, lines: index.index_lines });
    }
    for leased in &sessions {
        tx.prepare_cached(
            "INSERT INTO memory_checkpoints (scope_key, session_id, seq) VALUES (?1, ?2, ?3)
             ON CONFLICT (scope_key, session_id) DO UPDATE SET seq = MAX(seq, excluded.seq)",
        )?
        .execute(params![project.key, leased.id, leased.to_seq])?;
    }
    let batch = Batch {
        id: batch_id,
        lease_id: lease.id,
        scope: project,
        mode: lease.mode,
        at: now,
        device_id: device.to_owned(),
        session_id: lease.session_id,
        dream_session_id,
        summary,
        sessions: sessions.into_iter().map(|l| l.id.clone()).collect(),
        changes,
        reverted_at: None,
    };
    tx.prepare_cached(
        "INSERT INTO memory_dream_batches (id, lease_id, scope_key, mode, at, device_id, session_id, dream_session_id,
             summary, sessions, changes) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
    )?
    .execute(params![
        batch.id,
        batch.lease_id,
        batch.scope.key,
        batch.mode,
        batch.at,
        batch.device_id,
        batch.session_id,
        batch.dream_session_id,
        batch.summary,
        serde_json::to_string(&batch.sessions).expect("sessions serialize"),
        serde_json::to_string(&batch.changes).expect("changes serialize")
    ])?;
    Ok(Committed { batch, index })
}

const BATCH_SELECT: &str = "SELECT b.id, b.lease_id, b.mode, b.at, b.device_id, b.session_id, b.dream_session_id,
    b.summary, b.sessions, b.changes, b.reverted_at, s.key, s.kind, s.label
    FROM memory_dream_batches b JOIN memory_scopes s ON s.key = b.scope_key";

fn batch_row(r: &rusqlite::Row) -> rusqlite::Result<Batch> {
    Ok(Batch {
        id: r.get(0)?,
        lease_id: r.get(1)?,
        mode: r.get(2)?,
        at: r.get(3)?,
        device_id: r.get(4)?,
        session_id: r.get(5)?,
        dream_session_id: r.get(6)?,
        summary: r.get(7)?,
        sessions: serde_json::from_str(&r.get::<_, String>(8)?).unwrap_or_default(),
        changes: serde_json::from_str(&r.get::<_, String>(9)?).unwrap_or_default(),
        reverted_at: r.get(10)?,
        scope: Scope { key: r.get(11)?, kind: r.get(12)?, label: r.get(13)? },
    })
}

/// The batch `id`, if any.
pub fn batch(conn: &Connection, id: &str) -> rusqlite::Result<Option<Batch>> {
    conn.prepare_cached(&format!("{BATCH_SELECT} WHERE b.id = ?1"))?.query_row([id], batch_row).optional()
}

/// The batches of the stored scope `key`, newest first; `None` for an unknown scope.
pub fn batches(conn: &Connection, key: &str) -> rusqlite::Result<Option<Vec<Batch>>> {
    let tx = conn.unchecked_transaction()?;
    if tx.prepare_cached("SELECT 1 FROM memory_scopes WHERE key = ?1")?.query_row([key], |_| Ok(())).optional()?.is_none() {
        return Ok(None);
    }
    tx.prepare_cached(&format!("{BATCH_SELECT} WHERE b.scope_key = ?1 ORDER BY b.at DESC, b.id DESC"))?
        .query_map([key], batch_row)?
        .collect::<rusqlite::Result<_>>()
        .map(Some)
}

/// Deletes the scope's leases, batches, and checkpoints.
pub(super) fn delete_scope(tx: &Transaction, key: &str) -> rusqlite::Result<()> {
    for table in ["memory_dream_leases", "memory_dream_batches", "memory_checkpoints"] {
        tx.prepare_cached(&format!("DELETE FROM {table} WHERE scope_key = ?1"))?.execute([key])?;
    }
    Ok(())
}

/// Deletes the session's checkpoints in every scope.
pub fn delete_checkpoints(tx: &Transaction, session_id: &str) -> rusqlite::Result<()> {
    tx.prepare_cached("DELETE FROM memory_checkpoints WHERE session_id = ?1")?.execute([session_id])?;
    Ok(())
}
