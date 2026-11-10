//! Agent memory (spec "Memory"): short notes that pi agents save for the user and for a project, shared by every
//! device, with a revision on each note for compare-and-swap writes and a history row per save and forget. A forgotten
//! note keeps its row and history. Scope keys are computed here from what the request names and the device that sends
//! it, never taken from the client. The tables are not derived: `pika reindex` leaves them alone. Dreams, which
//! consolidate a project's notes from its sessions under a lease, are in `dream`.

pub mod dream;

use std::collections::BTreeSet;

use rusqlite::{Connection, OptionalExtension, Transaction, params};
use serde::{Deserialize, Serialize, Serializer};

use crate::redact::scrub_text;
use crate::util::{format_iso_ms, now_ms, random_bytes, valid_project, valid_repository};

/// The note categories, in index order.
pub const CATEGORIES: [&str; 4] = ["user", "feedback", "project", "reference"];
/// The most bytes and lines a save may grow the index of the user scope with a project scope, or alone, to.
pub const LIMIT_BYTES: usize = 8192;
pub const LIMIT_LINES: usize = 200;
const MAX_TITLE: usize = 120;
const MAX_HOOK: usize = 150;
const MAX_BODY: usize = 8192;
const MAX_REASON: usize = 500;
const MAX_SESSION_ID: usize = 256;
/// The most note ids one `POST memory/used` may name.
const MAX_USED: usize = 50;
/// The key, and label, of the one user scope.
pub const USER: &str = "user";
/// The provenance of what agents write through the memory routes.
const AGENT: &str = "agent";
/// The pi tools that read and write notes, a dream's included. Their arguments and results are memory: only the owner
/// namespace shows them, and search never indexes them (spec "Scrubbing" under "Memory").
pub const TOOL_NAMES: [&str; 6] = ["memory_read", "memory_save", "memory_forget", "dream_save", "dream_forget", "dream_commit"];
/// The `customType` of the `custom` session entry that holds a session's pinned memory index.
pub const CUSTOM_TYPE: &str = "pika-memory";

/// Whether `name` is one of the memory tools, exactly.
pub fn is_tool(name: &str) -> bool {
    TOOL_NAMES.contains(&name)
}

#[derive(Debug)]
pub enum MemoryError {
    BadRequest(String),
    NotFound,
    /// The stored note, whose revision differs from the request's `expectedRevision`.
    Conflict(Box<Note>),
    /// The index the save would grow past the budget.
    Full(Overfull),
    Internal(anyhow::Error),
}

/// An index a write would grow past the budget: its size after the write, and the project scope whose index with the
/// user scope it is, `None` for the user scope's alone.
#[derive(Debug)]
pub struct Overfull {
    pub bytes: usize,
    pub lines: usize,
    pub project: Option<Scope>,
}

impl From<rusqlite::Error> for MemoryError {
    fn from(e: rusqlite::Error) -> Self {
        MemoryError::Internal(e.into())
    }
}

fn bad(message: impl Into<String>) -> MemoryError {
    MemoryError::BadRequest(message.into())
}

fn iso<S: Serializer>(ms: &i64, s: S) -> Result<S::Ok, S::Error> {
    s.serialize_str(&format_iso_ms(*ms))
}

fn iso_opt<S: Serializer>(ms: &Option<i64>, s: S) -> Result<S::Ok, S::Error> {
    match ms {
        Some(ms) => iso(ms, s),
        None => s.serialize_none(),
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Scope {
    pub key: String,
    /// `user` or `project`.
    pub kind: String,
    pub label: String,
}

impl Scope {
    pub fn user() -> Scope {
        Scope { key: USER.into(), kind: "user".into(), label: USER.into() }
    }
}

/// An entry of a recorded session that a dream's change rests on: `seq` is the entry's 0-based line index.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    pub session_id: String,
    pub seq: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Note {
    pub id: String,
    pub scope: Scope,
    pub category: String,
    pub title: String,
    pub hook: String,
    pub body: String,
    /// The latest revision's: `agent`, `dream`, or `owner`.
    pub provenance: String,
    /// The latest revision's; empty for what agents save.
    pub sources: Vec<Source>,
    pub revision: i64,
    #[serde(serialize_with = "iso")]
    pub created_at: i64,
    #[serde(serialize_with = "iso")]
    pub updated_at: i64,
    #[serde(serialize_with = "iso_opt")]
    pub deleted_at: Option<i64>,
    pub device_id: Option<String>,
    pub session_id: Option<String>,
    /// When `POST memory/used` last named it; no revision records it.
    #[serde(serialize_with = "iso_opt")]
    pub last_used_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Revision {
    pub revision: i64,
    /// `save`, `forget`, or `revert`.
    pub action: String,
    pub category: String,
    pub title: String,
    pub hook: String,
    pub body: String,
    #[serde(serialize_with = "iso")]
    pub at: i64,
    pub device_id: Option<String>,
    pub session_id: Option<String>,
    pub reason: Option<String>,
    pub provenance: String,
    pub sources: Vec<Source>,
    /// The dream batch that wrote it, if any.
    pub batch_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScopeSummary {
    #[serde(flatten)]
    pub scope: Scope,
    /// Live notes only.
    pub note_count: i64,
    #[serde(serialize_with = "iso_opt")]
    pub updated_at: Option<i64>,
}

/// A rendered index and its size.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Index {
    pub index: String,
    pub index_bytes: usize,
    pub index_lines: usize,
}

impl Index {
    pub fn new(groups: &[(Scope, Vec<Note>)]) -> Index {
        let index = render_index(groups);
        Index { index_bytes: index.len(), index_lines: index.lines().count(), index }
    }
}

/// `GET memory`: the request's scopes, their live notes in index order, and their index.
#[derive(Debug, Serialize)]
pub struct View {
    pub scopes: Vec<Scope>,
    pub notes: Vec<Note>,
    #[serde(flatten)]
    pub index: Index,
}

/// What a save or forget wrote, and the index of the request's scopes after it.
#[derive(Debug, Serialize)]
pub struct Written {
    pub note: Note,
    #[serde(flatten)]
    pub index: Index,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Save {
    pub id: Option<String>,
    pub expected_revision: i64,
    pub scope: String,
    pub project: Option<String>,
    pub repository: Option<String>,
    pub session_id: Option<String>,
    pub category: String,
    pub title: String,
    pub hook: String,
    #[serde(default)]
    pub body: String,
    pub reason: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Forget {
    pub expected_revision: i64,
    pub project: Option<String>,
    pub repository: Option<String>,
    pub session_id: Option<String>,
    pub reason: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Used {
    pub ids: Vec<String>,
    pub project: Option<String>,
    pub repository: Option<String>,
    pub session_id: Option<String>,
}

/// `POST memory/used`: how many live notes it marked.
#[derive(Debug, Serialize)]
pub struct Marked {
    pub used: usize,
}

fn category_rank(category: &str) -> usize {
    CATEGORIES.iter().position(|c| *c == category).unwrap_or(CATEGORIES.len())
}

/// Index lines are single lines whatever a title holds.
fn one_line(s: &str) -> String {
    s.replace(['\r', '\n'], " ")
}

/// Renders the index of the scopes' live notes: the user scope first, then project scopes in the given order; within
/// a scope by category (`CATEGORIES` order), then creation time, then id. Empty categories and scopes are left out, and
/// no notes render as the empty string. Identical notes give byte-identical text.
pub fn render_index(groups: &[(Scope, Vec<Note>)]) -> String {
    let mut scopes: Vec<&(Scope, Vec<Note>)> = groups.iter().collect();
    scopes.sort_by_key(|(scope, _)| scope.kind != "user");
    let mut out = String::new();
    for (scope, notes) in scopes {
        let mut notes: Vec<&Note> = notes.iter().filter(|n| n.deleted_at.is_none()).collect();
        if notes.is_empty() {
            continue;
        }
        notes.sort_by(|a, b| {
            (category_rank(&a.category), &a.category, a.created_at, &a.id).cmp(&(
                category_rank(&b.category),
                &b.category,
                b.created_at,
                &b.id,
            ))
        });
        if scope.kind == "user" {
            out.push_str("# User memory\n");
        } else {
            out.push_str(&format!("# Project memory: {}\n", one_line(&scope.label)));
        }
        let mut category = None;
        for note in notes {
            if category != Some(&note.category) {
                out.push_str(&format!("## {}\n", note.category));
                category = Some(&note.category);
            }
            out.push_str(&format!("- {} — {} [{}]\n", one_line(&note.title), one_line(&note.hook), note.id));
        }
    }
    out
}

/// A repository URL as a scope key holds it: `http(s)` without user info, scheme and host in lower case, without a
/// trailing `/` or `.git`. `None` for anything else.
pub fn normalize_repository(url: &str) -> Option<String> {
    let (scheme, rest) = url.trim().split_once("://")?;
    let scheme = scheme.to_ascii_lowercase();
    if scheme != "https" && scheme != "http" {
        return None;
    }
    let (authority, path) = rest.split_at(rest.find(['/', '?', '#']).unwrap_or(rest.len()));
    if authority.contains('@') {
        return None;
    }
    let mut path = path.trim_end_matches('/');
    if let Some(stripped) = path.strip_suffix(".git") {
        path = stripped.trim_end_matches('/');
    }
    let url = format!("{scheme}://{}{path}", authority.to_ascii_lowercase());
    valid_repository(&url).then_some(url)
}

/// The label of a repository scope whose request named no project: the URL's last path segment, else its host.
fn repository_label(url: &str) -> String {
    let rest = url.split_once("://").map_or(url, |(_, rest)| rest);
    let path = rest.split(['?', '#']).next().unwrap_or_default();
    path.rsplit('/').find(|s| valid_project(s)).unwrap_or(path).to_owned()
}

/// The project scope a request names: by repository when it has one, else by project name and the device. `None` when
/// it names neither; an empty string names nothing.
pub fn project_scope(project: Option<&str>, repository: Option<&str>, device: &str) -> Result<Option<Scope>, MemoryError> {
    let project = project.filter(|p| !p.is_empty());
    let repository = repository.filter(|r| !r.is_empty());
    if project.is_some_and(|p| !valid_project(p)) {
        return Err(bad("invalid project"));
    }
    if let Some(repository) = repository {
        let url = normalize_repository(repository)
            .ok_or_else(|| bad("repository must be an http(s) URL without user info"))?;
        let label = project.map_or_else(|| repository_label(&url), str::to_owned);
        return Ok(Some(Scope { key: format!("repo:{url}"), kind: "project".into(), label }));
    }
    Ok(project.map(|p| Scope { key: format!("local:{p}@{device}"), kind: "project".into(), label: p.to_owned() }))
}

/// The scope as stored: a stored scope keeps the label it was created with.
fn stored(conn: &Connection, scope: Scope) -> rusqlite::Result<Scope> {
    let label: Option<String> = conn
        .prepare_cached("SELECT label FROM memory_scopes WHERE key = ?1")?
        .query_row([&scope.key], |r| r.get(0))
        .optional()?;
    Ok(match label {
        Some(label) => Scope { label, ..scope },
        None => scope,
    })
}

/// The user scope and the request's project scope, if any, as stored.
fn request_scopes(conn: &Connection, project: Option<Scope>) -> rusqlite::Result<Vec<Scope>> {
    std::iter::once(Scope::user()).chain(project).map(|scope| stored(conn, scope)).collect()
}

const NOTE_SELECT: &str = "SELECT n.id, n.category, n.title, n.hook, n.body, n.provenance, n.revision, n.created_at,
    n.updated_at, n.deleted_at, n.device_id, n.session_id, s.key, s.kind, s.label, n.sources, n.last_used_at
    FROM memory_notes n JOIN memory_scopes s ON s.key = n.scope_key";
const INDEX_ORDER: &str = "ORDER BY CASE n.category WHEN 'user' THEN 0 WHEN 'feedback' THEN 1 WHEN 'project' THEN 2
    WHEN 'reference' THEN 3 ELSE 4 END, n.category, n.created_at, n.id";

/// A JSON column of sources; anything unreadable is none.
fn sources_column(text: String) -> Vec<Source> {
    serde_json::from_str(&text).unwrap_or_default()
}

fn note_row(r: &rusqlite::Row) -> rusqlite::Result<Note> {
    Ok(Note {
        id: r.get(0)?,
        category: r.get(1)?,
        title: r.get(2)?,
        hook: r.get(3)?,
        body: r.get(4)?,
        provenance: r.get(5)?,
        revision: r.get(6)?,
        created_at: r.get(7)?,
        updated_at: r.get(8)?,
        deleted_at: r.get(9)?,
        device_id: r.get(10)?,
        session_id: r.get(11)?,
        scope: Scope { key: r.get(12)?, kind: r.get(13)?, label: r.get(14)? },
        sources: sources_column(r.get(15)?),
        last_used_at: r.get(16)?,
    })
}

fn note(conn: &Connection, id: &str) -> rusqlite::Result<Option<Note>> {
    conn.prepare_cached(&format!("{NOTE_SELECT} WHERE n.id = ?1"))?.query_row([id], note_row).optional()
}

/// The scope's live notes in index order.
fn live_notes(conn: &Connection, key: &str) -> rusqlite::Result<Vec<Note>> {
    conn.prepare_cached(&format!("{NOTE_SELECT} WHERE n.scope_key = ?1 AND n.deleted_at IS NULL {INDEX_ORDER}"))?
        .query_map([key], note_row)?
        .collect()
}

fn groups(conn: &Connection, scopes: Vec<Scope>) -> rusqlite::Result<Vec<(Scope, Vec<Note>)>> {
    scopes
        .into_iter()
        .map(|scope| {
            let notes = live_notes(conn, &scope.key)?;
            Ok((scope, notes))
        })
        .collect()
}

/// `GET memory`: the user scope and the project scope the parameters name.
pub fn view(conn: &Connection, device: &str, project: Option<&str>, repository: Option<&str>) -> Result<View, MemoryError> {
    let project = project_scope(project, repository, device)?;
    let tx = conn.unchecked_transaction()?;
    let scopes = request_scopes(&tx, project)?;
    let groups = groups(&tx, scopes.clone())?;
    let index = Index::new(&groups);
    Ok(View { scopes, notes: groups.into_iter().flat_map(|(_, notes)| notes).collect(), index })
}

/// Scrubbed of credentials, then trimmed when `trim`.
fn scrubbed(s: &str, trim: bool) -> String {
    let s = scrub_text(s);
    if trim { s.trim().to_owned() } else { s.into_owned() }
}

fn check_revision(expected: i64) -> Result<(), MemoryError> {
    if expected < 0 {
        return Err(bad("expectedRevision must be a non-negative integer"));
    }
    Ok(())
}

/// The reason, scrubbed, and `None` when empty.
fn reason(reason: Option<&str>) -> Result<Option<String>, MemoryError> {
    let reason = reason.map(|r| scrubbed(r, true)).filter(|r| !r.is_empty());
    if reason.as_ref().is_some_and(|r| r.chars().count() > MAX_REASON) {
        return Err(bad(format!("reason must be at most {MAX_REASON} characters")));
    }
    Ok(reason)
}

fn session_id(id: Option<&str>) -> Result<Option<String>, MemoryError> {
    let id = id.filter(|id| !id.is_empty());
    if id.is_some_and(|id| id.len() > MAX_SESSION_ID || id.chars().any(char::is_control)) {
        return Err(bad(format!("sessionId must be at most {MAX_SESSION_ID} bytes without control characters")));
    }
    Ok(id.map(str::to_owned))
}

/// A new note id: 12 lowercase hex digits, unused by any note.
fn new_id(tx: &Transaction) -> rusqlite::Result<String> {
    loop {
        let id = hex::encode(random_bytes::<6>());
        if tx.prepare_cached("SELECT 1 FROM memory_notes WHERE id = ?1")?.query_row([&id], |_| Ok(())).optional()?.is_none() {
            return Ok(id);
        }
    }
}

/// Who writes a revision, when, why, and on what: what each revision row records beside the note.
struct Author<'a> {
    device: &'a str,
    session_id: Option<String>,
    provenance: &'a str,
    sources: Vec<Source>,
    batch_id: Option<&'a str>,
    reason: Option<String>,
    now: i64,
}

/// A note's validated, scrubbed content.
struct Fields {
    category: String,
    title: String,
    hook: String,
    body: String,
}

fn fields(category: &str, title: &str, hook: &str, body: &str) -> Result<Fields, MemoryError> {
    if !CATEGORIES.contains(&category) {
        return Err(bad(format!("category must be one of {}", CATEGORIES.join(", "))));
    }
    let title = scrubbed(title, true);
    if title.is_empty() || title.chars().count() > MAX_TITLE {
        return Err(bad(format!("title must be 1 to {MAX_TITLE} characters")));
    }
    let hook = scrubbed(hook, true);
    if hook.is_empty() || hook.chars().count() > MAX_HOOK || hook.contains(['\n', '\r']) {
        return Err(bad(format!("hook must be one line of 1 to {MAX_HOOK} characters")));
    }
    let body = scrubbed(body, false);
    if body.len() > MAX_BODY {
        return Err(bad(format!("body must be at most {MAX_BODY} bytes")));
    }
    Ok(Fields { category: category.to_owned(), title, hook, body })
}

/// Writes the note's current state, its revision row, and its scope's `updated_at` (creating the scope).
fn record(tx: &Transaction, note: &Note, action: &str, author: &Author) -> rusqlite::Result<()> {
    tx.prepare_cached(
        "INSERT INTO memory_scopes (key, kind, label, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)
         ON CONFLICT (key) DO UPDATE SET updated_at = excluded.updated_at",
    )?
    .execute(params![note.scope.key, note.scope.kind, note.scope.label, note.updated_at])?;
    let sources = serde_json::to_string(&note.sources).expect("sources serialize");
    tx.prepare_cached(
        "INSERT OR REPLACE INTO memory_notes (id, scope_key, category, title, hook, body, provenance, revision, created_at,
             updated_at, deleted_at, device_id, session_id, sources, last_used_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
    )?
    .execute(params![
        note.id,
        note.scope.key,
        note.category,
        note.title,
        note.hook,
        note.body,
        note.provenance,
        note.revision,
        note.created_at,
        note.updated_at,
        note.deleted_at,
        note.device_id,
        note.session_id,
        sources,
        note.last_used_at
    ])?;
    tx.prepare_cached(
        "INSERT INTO memory_revisions (note_id, revision, action, category, title, hook, body, at, device_id, session_id,
             reason, provenance, sources, batch_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
    )?
    .execute(params![
        note.id,
        note.revision,
        action,
        note.category,
        note.title,
        note.hook,
        note.body,
        note.updated_at,
        note.device_id,
        note.session_id,
        author.reason,
        note.provenance,
        sources,
        author.batch_id
    ])?;
    Ok(())
}

/// Creates a note in `target` (no `id`, `expected` 0) or updates a live one of `target` at revision `expected`.
fn put(tx: &Transaction, target: Scope, id: Option<&str>, expected: i64, fields: Fields, author: &Author) -> Result<Note, MemoryError> {
    let note = match id {
        Some(id) => {
            let current = note(tx, id)?
                .filter(|n| n.deleted_at.is_none() && n.scope.key == target.key)
                .ok_or(MemoryError::NotFound)?;
            if current.revision != expected {
                return Err(MemoryError::Conflict(Box::new(current)));
            }
            Note {
                category: fields.category,
                title: fields.title,
                hook: fields.hook,
                body: fields.body,
                provenance: author.provenance.to_owned(),
                sources: author.sources.clone(),
                revision: current.revision + 1,
                updated_at: author.now,
                device_id: Some(author.device.to_owned()),
                session_id: author.session_id.clone(),
                ..current
            }
        }
        None => {
            if expected != 0 {
                return Err(bad("a new note needs expectedRevision 0"));
            }
            Note {
                id: new_id(tx)?,
                scope: target,
                category: fields.category,
                title: fields.title,
                hook: fields.hook,
                body: fields.body,
                provenance: author.provenance.to_owned(),
                sources: author.sources.clone(),
                revision: 1,
                created_at: author.now,
                updated_at: author.now,
                deleted_at: None,
                device_id: Some(author.device.to_owned()),
                session_id: author.session_id.clone(),
                last_used_at: None,
            }
        }
    };
    record(tx, &note, "save", author)?;
    Ok(note)
}

/// Forgets the live note `id` of the user scope or `project` at revision `expected`.
fn remove(tx: &Transaction, id: &str, expected: i64, project: Option<&Scope>, author: &Author) -> Result<Note, MemoryError> {
    let current = note(tx, id)?
        .filter(|n| n.deleted_at.is_none())
        .filter(|n| n.scope.key == USER || project.is_some_and(|p| p.key == n.scope.key))
        .ok_or(MemoryError::NotFound)?;
    if current.revision != expected {
        return Err(MemoryError::Conflict(Box::new(current)));
    }
    let note = Note {
        provenance: author.provenance.to_owned(),
        sources: author.sources.clone(),
        revision: current.revision + 1,
        updated_at: author.now,
        deleted_at: Some(author.now),
        device_id: Some(author.device.to_owned()),
        session_id: author.session_id.clone(),
        ..current
    };
    record(tx, &note, "forget", author)?;
    Ok(note)
}

/// The size of an index, or of one scope's part of it: an index is its scopes' parts one after another.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct Size {
    bytes: usize,
    lines: usize,
}

impl Size {
    fn plus(self, other: Size) -> Size {
        Size { bytes: self.bytes + other.bytes, lines: self.lines + other.lines }
    }

    /// Whether a write made it larger than `before` in bytes or in lines.
    fn grew(self, before: Size) -> bool {
        self.bytes > before.bytes || self.lines > before.lines
    }

    /// Whether a write made it larger than `before` in bytes or in lines, past the limit of that measure.
    fn overgrown(self, before: Size) -> bool {
        (self.bytes > LIMIT_BYTES && self.bytes > before.bytes) || (self.lines > LIMIT_LINES && self.lines > before.lines)
    }
}

/// The size of the scope's part of an index: its live notes rendered alone.
fn part(conn: &Connection, scope: &Scope) -> rusqlite::Result<Size> {
    let text = render_index(&[(scope.clone(), live_notes(conn, &scope.key)?)]);
    Ok(Size { bytes: text.len(), lines: text.lines().count() })
}

/// The stored project scopes with live notes other than `except`, by key.
fn other_project_scopes(conn: &Connection, except: Option<&str>) -> rusqlite::Result<Vec<Scope>> {
    conn.prepare_cached(
        "SELECT s.key, s.kind, s.label FROM memory_scopes s WHERE s.kind = 'project' AND s.key IS NOT ?1
             AND EXISTS (SELECT 1 FROM memory_notes n WHERE n.scope_key = s.key AND n.deleted_at IS NULL)
         ORDER BY s.key",
    )?
    .query_map([except], |r| Ok(Scope { key: r.get(0)?, kind: r.get(1)?, label: r.get(2)? }))?
    .collect()
}

/// The parts of the index a write may change, measured before it: the user scope's and that of the project scope the
/// write names (the request's, or a dream lease's), if any. Every project's index holds the user scope's notes, so a
/// write may grow none past the budget: not the user scope's with the named project scope's (alone without one), and,
/// when the user scope's part grew, neither the user scope's alone nor its index with any other project scope. An
/// index already past the budget may shrink or stay as it is, so a write that grows nothing always fits.
struct Budget {
    project: Option<Scope>,
    user: Size,
    own: Size,
}

impl Budget {
    /// Measures before the write; `project` as stored.
    fn measure(conn: &Connection, project: Option<Scope>) -> rusqlite::Result<Budget> {
        let user = part(conn, &Scope::user())?;
        let own = project.as_ref().map(|p| part(conn, p)).transpose()?.unwrap_or_default();
        Ok(Budget { project, user, own })
    }

    /// Checks the indexes after the write; `Full` with the first one it grew past the budget, in the order above, other
    /// project scopes by key.
    fn check(&self, conn: &Connection) -> Result<(), MemoryError> {
        let user = part(conn, &Scope::user())?;
        let own = self.project.as_ref().map(|p| part(conn, p)).transpose()?.unwrap_or_default();
        let full = |size: Size, project: Option<&Scope>| {
            MemoryError::Full(Overfull { bytes: size.bytes, lines: size.lines, project: project.cloned() })
        };
        if user.plus(own).overgrown(self.user.plus(self.own)) {
            return Err(full(user.plus(own), self.project.as_ref()));
        }
        if !user.grew(self.user) {
            return Ok(());
        }
        if user.overgrown(self.user) {
            return Err(full(user, None));
        }
        for scope in other_project_scopes(conn, self.project.as_ref().map(|p| p.key.as_str()))? {
            let theirs = part(conn, &scope)?;
            if user.plus(theirs).overgrown(self.user.plus(theirs)) {
                return Err(full(user.plus(theirs), Some(&scope)));
            }
        }
        Ok(())
    }
}

/// `POST memory/notes`: creates a note (no `id`, `expectedRevision` 0) or updates a live one of the scope the request
/// resolves to, at `expectedRevision`. Writes before checking the budget (see `Budget`), so the caller must commit
/// only on `Ok`, as `Store::write` does: the check, the comparison, and the write are one transaction.
pub fn save(tx: &Transaction, device: &str, request: Save) -> Result<Written, MemoryError> {
    check_revision(request.expected_revision)?;
    let fields = fields(&request.category, &request.title, &request.hook, &request.body)?;
    let reason = reason(request.reason.as_deref())?;
    let session_id = session_id(request.session_id.as_deref())?;
    let project = project_scope(request.project.as_deref(), request.repository.as_deref(), device)?
        .map(|p| stored(tx, p))
        .transpose()?;
    let target = match request.scope.as_str() {
        "user" => Scope::user(),
        "project" => project.clone().ok_or_else(|| bad("scope project needs project or repository"))?,
        _ => return Err(bad("scope must be user or project")),
    };
    let target = stored(tx, target)?;
    let budget = Budget::measure(tx, project.clone())?;
    let author = Author { device, session_id, provenance: AGENT, sources: Vec::new(), batch_id: None, reason, now: now_ms() };
    let note = put(tx, target, request.id.as_deref(), request.expected_revision, fields, &author)?;
    budget.check(tx)?;
    let index = Index::new(&groups(tx, request_scopes(tx, project)?)?);
    Ok(Written { note, index })
}

/// `POST memory/notes/:id/forget`: soft-deletes a live note of the user scope or the request's project scope, at
/// `expectedRevision`. Never fails the budget.
pub fn forget(tx: &Transaction, device: &str, id: &str, request: Forget) -> Result<Written, MemoryError> {
    check_revision(request.expected_revision)?;
    let reason = reason(request.reason.as_deref())?;
    let session_id = session_id(request.session_id.as_deref())?;
    let project = project_scope(request.project.as_deref(), request.repository.as_deref(), device)?;
    let author = Author { device, session_id, provenance: AGENT, sources: Vec::new(), batch_id: None, reason, now: now_ms() };
    let note = remove(tx, id, request.expected_revision, project.as_ref(), &author)?;
    let index = Index::new(&groups(tx, request_scopes(tx, project)?)?);
    Ok(Written { note, index })
}

/// `POST memory/used`: sets `last_used_at` to now on each named live note of the user scope or the request's project
/// scope, without a revision or history row; other ids are ignored. Counts each note once.
pub fn used(tx: &Transaction, device: &str, request: Used) -> Result<Marked, MemoryError> {
    if request.ids.len() > MAX_USED {
        return Err(bad(format!("ids must hold at most {MAX_USED} note ids")));
    }
    session_id(request.session_id.as_deref())?;
    let project = project_scope(request.project.as_deref(), request.repository.as_deref(), device)?;
    let project = project.as_ref().map(|p| p.key.as_str());
    let now = now_ms();
    let mut mark = tx.prepare_cached(
        "UPDATE memory_notes SET last_used_at = ?2
         WHERE id = ?1 AND deleted_at IS NULL AND (scope_key = ?3 OR scope_key IS ?4)",
    )?;
    let mut used = 0;
    for id in request.ids.iter().collect::<BTreeSet<_>>() {
        used += mark.execute(params![id, now, USER, project])?;
    }
    Ok(Marked { used })
}

/// Every stored scope with its live note count: the user scope first, then by label and key.
pub fn scopes(conn: &Connection) -> rusqlite::Result<Vec<ScopeSummary>> {
    conn.prepare_cached(
        "SELECT s.key, s.kind, s.label, s.updated_at,
             (SELECT COUNT(*) FROM memory_notes n WHERE n.scope_key = s.key AND n.deleted_at IS NULL)
         FROM memory_scopes s ORDER BY s.kind != 'user', s.label, s.key",
    )?
    .query_map([], |r| {
        Ok(ScopeSummary {
            scope: Scope { key: r.get(0)?, kind: r.get(1)?, label: r.get(2)? },
            updated_at: r.get(3)?,
            note_count: r.get(4)?,
        })
    })?
    .collect()
}

/// The live notes of the stored scope `key` in index order; `None` for an unknown scope.
pub fn scope_notes(conn: &Connection, key: &str) -> rusqlite::Result<Option<Vec<Note>>> {
    let tx = conn.unchecked_transaction()?;
    if tx.prepare_cached("SELECT 1 FROM memory_scopes WHERE key = ?1")?.query_row([key], |_| Ok(())).optional()?.is_none() {
        return Ok(None);
    }
    live_notes(&tx, key).map(Some)
}

/// The note's revisions, oldest first; `None` for an unknown note.
pub fn revisions(conn: &Connection, id: &str) -> rusqlite::Result<Option<Vec<Revision>>> {
    let tx = conn.unchecked_transaction()?;
    if note(&tx, id)?.is_none() {
        return Ok(None);
    }
    tx.prepare_cached(
        "SELECT revision, action, category, title, hook, body, at, device_id, session_id, reason, provenance, sources,
             batch_id FROM memory_revisions WHERE note_id = ?1 ORDER BY revision",
    )?
    .query_map([id], |r| {
        Ok(Revision {
            revision: r.get(0)?,
            action: r.get(1)?,
            category: r.get(2)?,
            title: r.get(3)?,
            hook: r.get(4)?,
            body: r.get(5)?,
            at: r.get(6)?,
            device_id: r.get(7)?,
            session_id: r.get(8)?,
            reason: r.get(9)?,
            provenance: r.get(10)?,
            sources: sources_column(r.get(11)?),
            batch_id: r.get(12)?,
        })
    })?
    .collect::<rusqlite::Result<_>>()
    .map(Some)
}

/// The keys of the project scopes labeled `name`, which deleting the project deletes.
pub fn project_scope_keys(conn: &Connection, name: &str) -> rusqlite::Result<Vec<String>> {
    conn.prepare_cached("SELECT key FROM memory_scopes WHERE kind = 'project' AND label = ?1 ORDER BY key")?
        .query_map([name], |r| r.get(0))?
        .collect()
}

/// Deletes the scopes with their notes, the notes' revisions, and their dream leases, batches, and checkpoints. Their
/// batches' edits of user notes stay as ordinary edits (see `dream::delete_scope`).
pub fn delete_scopes<'a>(tx: &Transaction, keys: impl IntoIterator<Item = &'a String>) -> rusqlite::Result<()> {
    for key in keys {
        dream::delete_scope(tx, key)?;
        tx.prepare_cached(
            "DELETE FROM memory_revisions WHERE note_id IN (SELECT id FROM memory_notes WHERE scope_key = ?1)",
        )?
        .execute([key])?;
        tx.prepare_cached("DELETE FROM memory_notes WHERE scope_key = ?1")?.execute([key])?;
        tx.prepare_cached("DELETE FROM memory_scopes WHERE key = ?1")?.execute([key])?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn note(id: &str, scope: &Scope, category: &str, created_at: i64, title: &str) -> Note {
        Note {
            id: id.into(),
            scope: scope.clone(),
            category: category.into(),
            title: title.into(),
            hook: format!("hook of {id}"),
            body: String::new(),
            provenance: AGENT.into(),
            sources: Vec::new(),
            revision: 1,
            created_at,
            updated_at: created_at,
            deleted_at: None,
            device_id: None,
            session_id: None,
            last_used_at: None,
        }
    }

    #[test]
    fn renders_scopes_categories_and_order() {
        let user = Scope::user();
        let project = Scope { key: "repo:https://example.com/a/widgets".into(), kind: "project".into(), label: "widgets".into() };
        let mut forgotten = note("f0", &user, "user", 1, "Gone");
        forgotten.deleted_at = Some(2);
        let groups = vec![
            (
                project.clone(),
                vec![note("p2", &project, "reference", 5, "Docs"), note("p1", &project, "project", 9, "Build")],
            ),
            (
                user.clone(),
                vec![
                    note("b", &user, "feedback", 3, "Terse"),
                    note("a", &user, "feedback", 3, "Tabs"),
                    forgotten,
                    note("c", &user, "user", 7, "Role"),
                ],
            ),
        ];
        let expected = "# User memory\n## user\n- Role — hook of c [c]\n## feedback\n- Tabs — hook of a [a]\n- Terse — hook of b [b]\n\
                        # Project memory: widgets\n## project\n- Build — hook of p1 [p1]\n## reference\n- Docs — hook of p2 [p2]\n";
        assert_eq!(render_index(&groups), expected);
        let mut reversed = groups.clone();
        reversed.reverse();
        reversed.iter_mut().for_each(|(_, notes)| notes.reverse());
        assert_eq!(render_index(&reversed), expected);
        let index = Index::new(&groups);
        assert_eq!((index.index_bytes, index.index_lines), (expected.len(), 11));
    }

    #[test]
    fn renders_nothing_without_live_notes() {
        let user = Scope::user();
        let mut gone = note("x", &user, "user", 1, "Gone");
        gone.deleted_at = Some(1);
        assert_eq!(render_index(&[(user.clone(), vec![gone]), (user, vec![])]), "");
        assert_eq!(Index::new(&[]), Index { index: String::new(), index_bytes: 0, index_lines: 0 });
    }

    #[test]
    fn titles_render_on_one_line() {
        let user = Scope::user();
        let text = render_index(&[(user.clone(), vec![note("a", &user, "user", 1, "two\nlines")])]);
        assert_eq!(text, "# User memory\n## user\n- two lines — hook of a [a]\n");
    }

    #[test]
    fn normalizes_repositories() {
        assert_eq!(normalize_repository("HTTPS://GitHub.COM/Me/Repo.git/").as_deref(), Some("https://github.com/Me/Repo"));
        assert_eq!(normalize_repository("http://example.com:8080/a/b/").as_deref(), Some("http://example.com:8080/a/b"));
        assert_eq!(normalize_repository("https://user:pw@github.com/me/repo"), None);
        assert_eq!(normalize_repository("git@github.com:me/repo.git"), None);
        assert_eq!(normalize_repository("ssh://github.com/me/repo"), None);
        assert_eq!(normalize_repository("https://"), None);
    }

    #[test]
    fn resolves_project_scopes() {
        let repo = project_scope(Some("widgets"), Some("https://GitHub.com/me/widgets.git"), "d1").unwrap().unwrap();
        assert_eq!(repo, Scope { key: "repo:https://github.com/me/widgets".into(), kind: "project".into(), label: "widgets".into() });
        let unnamed = project_scope(None, Some("https://github.com/me/gadgets"), "d1").unwrap().unwrap();
        assert_eq!(unnamed.label, "gadgets");
        let local = project_scope(Some("widgets"), Some(""), "d1").unwrap().unwrap();
        assert_eq!(local.key, "local:widgets@d1");
        assert!(project_scope(None, None, "d1").unwrap().is_none());
        assert!(matches!(project_scope(Some("a/b"), None, "d1"), Err(MemoryError::BadRequest(_))));
        assert!(matches!(project_scope(Some(".."), None, "d1"), Err(MemoryError::BadRequest(_))));
        assert!(matches!(project_scope(None, Some("file:///tmp/x"), "d1"), Err(MemoryError::BadRequest(_))));
    }
}
