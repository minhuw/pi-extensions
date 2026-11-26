//! Agent memory (spec "Memory"): short notes that pi agents save for the user and for a project, shared by every
//! device, with a revision on each note for compare-and-swap writes and a history row per save and forget. A forgotten
//! note keeps its row and history. Scope keys are computed here from what the request names and the device that sends
//! it, never taken from the client. The tables are not derived: `pika reindex` leaves them alone. Dreams, which
//! consolidate a project's notes from its sessions under a lease, are in `dream`.

pub mod dream;

use std::collections::{BTreeSet, HashMap, HashSet};

use rusqlite::{Connection, OptionalExtension, Transaction, params};
use serde::{Deserialize, Serialize, Serializer};

use crate::redact::scrub_text;
use crate::util::{format_iso_ms, now_ms, random_bytes, valid_project, valid_repository};

/// The note categories, in index order.
pub const CATEGORIES: [&str; 4] = ["user", "feedback", "project", "reference"];
/// The note tiers: `pinned` notes render in the prompt index and count against the per-scope budget; `archival` notes
/// are kept out of the prompt index and budget and retrieved via search.
pub const TIERS: [&str; 2] = ["pinned", "archival"];
pub const PINNED: &str = "pinned";
pub const ARCHIVAL: &str = "archival";
pub const SEARCH_DEFAULT_LIMIT: usize = 20;
pub const SEARCH_MAX_LIMIT: usize = 100;
/// Maximum number of live `archival` notes allowed in a single scope (user scope or each project scope).
pub const MAX_ARCHIVAL_NOTES_PER_SCOPE: usize = 500;
/// The most bytes and lines a save may grow a scope's own rendered index part to (the user scope and each project
/// scope each have an independent budget).
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

/// A scope's rendered index part a write would grow past its independent budget: that scope's size after the write,
/// and the project scope that overflowed, `None` for the user scope.
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
    pub tier: String,
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
    pub tier: String,
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
    /// Live pinned notes.
    pub pinned_count: i64,
    /// Live archival notes.
    pub archival_count: i64,
    /// Rendered pinned index bytes for this scope.
    pub index_bytes: usize,
    /// Rendered pinned index lines for this scope.
    pub index_lines: usize,
    /// Per-scope byte limit (`LIMIT_BYTES`).
    pub limit_bytes: usize,
    /// Per-scope line limit (`LIMIT_LINES`).
    pub limit_lines: usize,
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

/// What `GET memory` returns: `Full` includes every live note (`pinned` and `archival`); `Index` skips loading
/// archival bodies and returns `notes: []` with only the rendered pinned index and archival counts.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum ViewMode {
    #[default]
    Full,
    Index,
}

/// Live archival note counts across the scopes of a `GET memory` response.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
pub struct ArchivalCounts {
    pub user: usize,
    pub project: usize,
}

/// `GET memory`: the request's scopes, their live notes in index order (empty when `view=index`), their rendered
/// pinned index, capability marker, and archival note counts.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct View {
    pub scopes: Vec<Scope>,
    pub notes: Vec<Note>,
    #[serde(flatten)]
    pub index: Index,
    pub tiers: bool,
    pub archival_count: usize,
    pub archival_counts: ArchivalCounts,
}

/// `GET memory/search`: matched live notes across the request's scopes, the search mode used, and total live notes.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchView {
    pub scopes: Vec<Scope>,
    pub notes: Vec<Note>,
    pub mode: String,
    pub total: usize,
}

/// Parameters for [`search`].
#[derive(Debug, Default)]
pub struct SearchQuery<'a> {
    pub q: &'a str,
    pub project: Option<&'a str>,
    pub repository: Option<&'a str>,
    pub scope: Option<&'a str>,
    pub category: Option<&'a str>,
    pub tier: Option<&'a str>,
    pub limit: Option<usize>,
}

/// What a save or forget wrote, the combined index of the request's scopes after it, and the written note's own scope
/// index size.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Written {
    pub note: Note,
    #[serde(flatten)]
    pub index: Index,
    pub scope_index_bytes: usize,
    pub scope_index_lines: usize,
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
    #[serde(default)]
    pub tier: Option<String>,
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
        let mut notes: Vec<&Note> = notes.iter().filter(|n| n.deleted_at.is_none() && n.tier == PINNED).collect();
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
    n.updated_at, n.deleted_at, n.device_id, n.session_id, s.key, s.kind, s.label, n.sources, n.last_used_at, n.tier
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
        tier: r.get(17)?,
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

/// The scope's live pinned notes in index order (never loads archival note bodies).
fn pinned_notes(conn: &Connection, key: &str) -> rusqlite::Result<Vec<Note>> {
    conn.prepare_cached(&format!(
        "{NOTE_SELECT} WHERE n.scope_key = ?1 AND n.deleted_at IS NULL AND n.tier = 'pinned' {INDEX_ORDER}"
    ))?
    .query_map([key], note_row)?
    .collect()
}

/// Live archival note count for `key` without loading note bodies.
fn archival_count(conn: &Connection, key: &str) -> rusqlite::Result<usize> {
    let count: i64 = conn
        .prepare_cached("SELECT COUNT(*) FROM memory_notes WHERE scope_key = ?1 AND deleted_at IS NULL AND tier = 'archival'")?
        .query_row([key], |r| r.get(0))?;
    Ok(count.max(0) as usize)
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

fn pinned_groups(conn: &Connection, scopes: Vec<Scope>) -> rusqlite::Result<Vec<(Scope, Vec<Note>)>> {
    scopes
        .into_iter()
        .map(|scope| {
            let notes = pinned_notes(conn, &scope.key)?;
            Ok((scope, notes))
        })
        .collect()
}

/// `GET memory`: the user scope and the project scope the parameters name.
pub fn view(
    conn: &Connection,
    device: &str,
    project: Option<&str>,
    repository: Option<&str>,
    mode: ViewMode,
) -> Result<View, MemoryError> {
    let project = project_scope(project, repository, device)?;
    let tx = conn.unchecked_transaction()?;
    let scopes = request_scopes(&tx, project)?;
    let (notes, index, archival_counts) = match mode {
        ViewMode::Full => {
            let groups = groups(&tx, scopes.clone())?;
            let index = Index::new(&groups);
            let mut counts = ArchivalCounts::default();
            for (scope, scope_notes) in &groups {
                let count = scope_notes.iter().filter(|n| n.tier == ARCHIVAL).count();
                if scope.kind == USER {
                    counts.user = count;
                } else {
                    counts.project = count;
                }
            }
            (groups.into_iter().flat_map(|(_, notes)| notes).collect(), index, counts)
        }
        ViewMode::Index => {
            let groups = pinned_groups(&tx, scopes.clone())?;
            let index = Index::new(&groups);
            let mut counts = ArchivalCounts::default();
            for scope in &scopes {
                let count = archival_count(&tx, &scope.key)?;
                if scope.kind == USER {
                    counts.user = count;
                } else {
                    counts.project = count;
                }
            }
            (Vec::new(), index, counts)
        }
    };
    let archival_count = archival_counts.user + archival_counts.project;
    Ok(View { scopes, notes, index, tiers: true, archival_count, archival_counts })
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
    tier: Option<String>,
    title: String,
    hook: String,
    body: String,
}

fn parse_tier(tier: Option<&str>) -> Result<Option<String>, MemoryError> {
    let Some(tier) = tier else {
        return Ok(None);
    };
    if !TIERS.contains(&tier) {
        return Err(bad(format!("tier must be one of {}", TIERS.join(", "))));
    }
    Ok(Some(tier.to_owned()))
}

fn fields(category: &str, tier: Option<&str>, title: &str, hook: &str, body: &str) -> Result<Fields, MemoryError> {
    if !CATEGORIES.contains(&category) {
        return Err(bad(format!("category must be one of {}", CATEGORIES.join(", "))));
    }
    let tier = parse_tier(tier)?;
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
    Ok(Fields { category: category.to_owned(), tier, title, hook, body })
}

/// Writes the note's current state, its revision row, its FTS5 entry, and its scope's `updated_at` (creating the scope).
fn record(tx: &Transaction, note: &Note, action: &str, author: &Author) -> rusqlite::Result<()> {
    tx.prepare_cached(
        "INSERT INTO memory_scopes (key, kind, label, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)
         ON CONFLICT (key) DO UPDATE SET updated_at = excluded.updated_at",
    )?
    .execute(params![note.scope.key, note.scope.kind, note.scope.label, note.updated_at])?;
    let sources = serde_json::to_string(&note.sources).expect("sources serialize");
    tx.prepare_cached(
        "INSERT OR REPLACE INTO memory_notes (id, scope_key, category, title, hook, body, provenance, revision, created_at,
             updated_at, deleted_at, device_id, session_id, sources, last_used_at, tier)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
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
        note.last_used_at,
        note.tier
    ])?;
    tx.prepare_cached(
        "INSERT INTO memory_revisions (note_id, revision, action, category, title, hook, body, at, device_id, session_id,
             reason, provenance, sources, batch_id, tier)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
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
        author.batch_id,
        note.tier
    ])?;
    tx.prepare_cached("DELETE FROM memory_notes_fts WHERE note_id = ?1")?.execute([&note.id])?;
    if note.deleted_at.is_none() {
        tx.prepare_cached("INSERT INTO memory_notes_fts (note_id, title, hook, body) VALUES (?1, ?2, ?3, ?4)")?
            .execute(params![note.id, note.title, note.hook, note.body])?;
    }
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
            let tier = fields.tier.unwrap_or_else(|| current.tier.clone());
            Note {
                category: fields.category,
                tier,
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
                tier: fields.tier.unwrap_or_else(|| PINNED.to_owned()),
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
    /// Whether a write made it larger than `before` in bytes or in lines, past the limit of that measure.
    fn overgrown(self, before: Size) -> bool {
        (self.bytes > LIMIT_BYTES && self.bytes > before.bytes) || (self.lines > LIMIT_LINES && self.lines > before.lines)
    }
}

/// The size of the scope's part of an index: its live pinned notes rendered alone.
fn part(conn: &Connection, scope: &Scope) -> rusqlite::Result<Size> {
    let text = render_index(&[(scope.clone(), pinned_notes(conn, &scope.key)?)]);
    Ok(Size { bytes: text.len(), lines: text.lines().count() })
}

/// The scope index parts and archival note counts a write may change, measured before it: the user scope's and that of
/// the project scope the write names (the request's, or a dream lease's), if any. The user scope and each project
/// scope each have an independent pinned budget (`LIMIT_BYTES` and `LIMIT_LINES`) and archival cap
/// (`MAX_ARCHIVAL_NOTES_PER_SCOPE`): saving a user note never fails because of any project scope, and saving a project
/// note never fails because of the user scope. A scope already past a limit (e.g., after a revert) may shrink or stay
/// as it is, so a write that grows nothing over budget always fits.
struct Budget {
    project: Option<Scope>,
    user: Size,
    own: Size,
    user_archival: usize,
    own_archival: usize,
}

impl Budget {
    /// Measures before the write; `project` as stored.
    fn measure(conn: &Connection, project: Option<Scope>) -> rusqlite::Result<Budget> {
        let user = part(conn, &Scope::user())?;
        let own = project.as_ref().map(|p| part(conn, p)).transpose()?.unwrap_or_default();
        let user_archival = archival_count(conn, USER)?;
        let own_archival = project.as_ref().map(|p| archival_count(conn, &p.key)).transpose()?.unwrap_or(0);
        Ok(Budget { project, user, own, user_archival, own_archival })
    }

    /// Checks each scope's rendered pinned part and archival cap independently after the write; `Full` with the first
    /// scope it grew past its pinned budget (the user scope first, then the named project scope), or `BadRequest` when
    /// a scope grows past `MAX_ARCHIVAL_NOTES_PER_SCOPE`.
    fn check(&self, conn: &Connection) -> Result<(), MemoryError> {
        let user = part(conn, &Scope::user())?;
        if user.overgrown(self.user) {
            return Err(MemoryError::Full(Overfull { bytes: user.bytes, lines: user.lines, project: None }));
        }
        if let Some(project) = &self.project {
            let own = part(conn, project)?;
            if own.overgrown(self.own) {
                return Err(MemoryError::Full(Overfull { bytes: own.bytes, lines: own.lines, project: Some(project.clone()) }));
            }
        }
        let user_archival = archival_count(conn, USER)?;
        if user_archival > MAX_ARCHIVAL_NOTES_PER_SCOPE && user_archival > self.user_archival {
            return Err(bad(format!(
                "archival limit reached ({MAX_ARCHIVAL_NOTES_PER_SCOPE} notes per scope); forget obsolete archival notes first"
            )));
        }
        if let Some(project) = &self.project {
            let own_archival = archival_count(conn, &project.key)?;
            if own_archival > MAX_ARCHIVAL_NOTES_PER_SCOPE && own_archival > self.own_archival {
                return Err(bad(format!(
                    "archival limit reached ({MAX_ARCHIVAL_NOTES_PER_SCOPE} notes per scope); forget obsolete archival notes first"
                )));
            }
        }
        Ok(())
    }
}

fn written(tx: &Transaction, note: Note, project: Option<Scope>) -> rusqlite::Result<Written> {
    let groups = pinned_groups(tx, request_scopes(tx, project)?)?;
    let index = Index::new(&groups);
    let scope_size = groups
        .iter()
        .find(|(s, _)| s.key == note.scope.key)
        .map(|group| {
            let text = render_index(std::slice::from_ref(group));
            Size { bytes: text.len(), lines: text.lines().count() }
        })
        .unwrap_or_default();
    Ok(Written { note, index, scope_index_bytes: scope_size.bytes, scope_index_lines: scope_size.lines })
}

/// `POST memory/notes`: creates a note (no `id`, `expectedRevision` 0) or updates a live one of the scope the request
/// resolves to, at `expectedRevision`. Writes before checking the budget (see `Budget`), so the caller must commit
/// only on `Ok`, as `Store::write` does: the check, the comparison, and the write are one transaction.
pub fn save(tx: &Transaction, device: &str, request: Save) -> Result<Written, MemoryError> {
    check_revision(request.expected_revision)?;
    let fields = fields(&request.category, request.tier.as_deref(), &request.title, &request.hook, &request.body)?;
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
    Ok(written(tx, note, project)?)
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
    Ok(written(tx, note, project)?)
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

/// Splits a user search string into safely quoted FTS5 terms/phrases.
fn fts_terms(q: &str) -> Vec<String> {
    let q: String = q.chars().map(|c| if c.is_control() { ' ' } else { c }).collect();
    let mut terms = Vec::new();
    let mut rest = q.as_str();
    loop {
        rest = rest.trim_start();
        if rest.is_empty() {
            break;
        }
        let (phrase, after) = match rest.strip_prefix('"') {
            Some(quoted) => match quoted.find('"') {
                Some(end) => (&quoted[..end], &quoted[end + 1..]),
                None => (quoted, ""),
            },
            None => {
                let end = rest.find(|c: char| c.is_whitespace() || c == '"').unwrap_or(rest.len());
                rest.split_at(end)
            }
        };
        if !phrase.trim().is_empty() {
            terms.push(format!("\"{}\"", phrase.replace('"', "\"\"")));
        }
        rest = after;
    }
    terms
}

fn fts_match_candidates(
    conn: &Connection,
    expr: &str,
    by_id: &HashMap<String, usize>,
    limit: usize,
) -> rusqlite::Result<Vec<String>> {
    let mut stmt = conn.prepare_cached(
        "SELECT note_id FROM memory_notes_fts WHERE memory_notes_fts MATCH ?1 ORDER BY bm25(memory_notes_fts), note_id",
    )?;
    let mut rows = stmt.query([expr])?;
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    while let Some(row) = rows.next()? {
        let id: String = row.get(0)?;
        if by_id.contains_key(&id) && seen.insert(id.clone()) {
            out.push(id);
            if out.len() >= limit {
                break;
            }
        }
    }
    Ok(out)
}

/// `GET memory/search`: FTS5 (`pika_cjk`) lexical search (AND, falling back to OR) with case-insensitive substring
/// fallback over live notes.
pub fn search(conn: &Connection, device: &str, query: SearchQuery<'_>) -> Result<SearchView, MemoryError> {
    let q = query.q.trim();
    if q.is_empty() {
        return Err(bad("q is required"));
    }
    let scope_filter = match query.scope.filter(|s| !s.is_empty()) {
        None => None,
        Some(s @ ("user" | "project")) => Some(s),
        Some(_) => return Err(bad("scope must be user or project")),
    };
    let category_filter = match query.category.filter(|c| !c.is_empty()) {
        None => None,
        Some(c) if CATEGORIES.contains(&c) => Some(c),
        Some(_) => return Err(bad(format!("category must be one of {}", CATEGORIES.join(", ")))),
    };
    let tier_filter = parse_tier(query.tier.filter(|t| !t.is_empty()))?;
    let limit = query.limit.unwrap_or(SEARCH_DEFAULT_LIMIT);
    if !(1..=SEARCH_MAX_LIMIT).contains(&limit) {
        return Err(bad(format!("limit must be 1 to {SEARCH_MAX_LIMIT}")));
    }
    let project = project_scope(query.project, query.repository, device)?;

    let tx = conn.unchecked_transaction()?;
    let scopes = request_scopes(&tx, project)?;
    let groups = groups(&tx, scopes.clone())?;
    let all_notes: Vec<Note> = groups.into_iter().flat_map(|(_, notes)| notes).collect();
    let total = all_notes.len();
    let candidates: Vec<Note> = all_notes
        .into_iter()
        .filter(|n| scope_filter.is_none_or(|s| n.scope.kind == s))
        .filter(|n| category_filter.is_none_or(|c| n.category == c))
        .filter(|n| tier_filter.as_deref().is_none_or(|t| n.tier == t))
        .collect();
    if candidates.is_empty() {
        return Ok(SearchView { scopes, notes: Vec::new(), mode: "lexical".into(), total });
    }
    let by_id: HashMap<String, usize> =
        candidates.iter().enumerate().map(|(idx, n)| (n.id.clone(), idx)).collect();

    // Lexical search: FTS5 AND first, then OR fallback for multi-term natural-language queries.
    let terms = fts_terms(q);
    let mut lexical_ids = Vec::new();
    if !terms.is_empty() {
        let and_expr = terms.join(" ");
        lexical_ids = fts_match_candidates(&tx, &and_expr, &by_id, limit)?;
        if lexical_ids.is_empty() && terms.len() > 1 {
            let or_expr = terms.join(" OR ");
            lexical_ids = fts_match_candidates(&tx, &or_expr, &by_id, limit)?;
        }
    }

    let (notes, mode) = if !lexical_ids.is_empty() {
        let notes = lexical_ids
            .into_iter()
            .take(limit)
            .filter_map(|id| by_id.get(&id).map(|&idx| candidates[idx].clone()))
            .collect();
        (notes, "lexical")
    } else {
        let needle = q.to_lowercase();
        let notes = candidates
            .into_iter()
            .filter(|n| {
                n.title.to_lowercase().contains(&needle)
                    || n.hook.to_lowercase().contains(&needle)
                    || n.body.to_lowercase().contains(&needle)
            })
            .take(limit)
            .collect();
        (notes, "substring")
    };

    Ok(SearchView { scopes, notes, mode: mode.into(), total })
}

/// Every stored scope with its live note count, tier breakdown, and pinned index budget usage: the user scope first,
/// then by label and key.
pub fn scopes(conn: &Connection) -> rusqlite::Result<Vec<ScopeSummary>> {
    let tx = conn.unchecked_transaction()?;
    let rows: Vec<(Scope, Option<i64>)> = tx
        .prepare_cached(
            "SELECT s.key, s.kind, s.label, s.updated_at
             FROM memory_scopes s ORDER BY s.kind != 'user', s.label, s.key",
        )?
        .query_map([], |r| {
            Ok((Scope { key: r.get(0)?, kind: r.get(1)?, label: r.get(2)? }, r.get(3)?))
        })?
        .collect::<rusqlite::Result<_>>()?;
    let mut out = Vec::with_capacity(rows.len());
    for (scope, updated_at) in rows {
        let pinned = pinned_notes(&tx, &scope.key)?;
        let pinned_count = pinned.len() as i64;
        let archival_count = archival_count(&tx, &scope.key)? as i64;
        let note_count = pinned_count + archival_count;
        let rendered = render_index(&[(scope.clone(), pinned)]);
        let index_bytes = rendered.len();
        let index_lines = rendered.lines().count();
        out.push(ScopeSummary {
            scope,
            note_count,
            pinned_count,
            archival_count,
            index_bytes,
            index_lines,
            limit_bytes: LIMIT_BYTES,
            limit_lines: LIMIT_LINES,
            updated_at,
        });
    }
    Ok(out)
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
             batch_id, tier FROM memory_revisions WHERE note_id = ?1 ORDER BY revision",
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
            tier: r.get(13)?,
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
            "DELETE FROM memory_notes_fts WHERE note_id IN (SELECT id FROM memory_notes WHERE scope_key = ?1)",
        )?
        .execute([key])?;
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
            tier: PINNED.into(),
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
