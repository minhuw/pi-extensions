//! Project publication is an opt-in setting, independent of derived session tables.
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::sync::LazyLock;

use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;

use super::{ReadError, ReadResult, bad};

pub const KEY: &str = "published_projects";
/// JSON arrays are stored as BLOBs in settings; cast explicitly for SQLite JSON functions.
pub const PROJECTS_SQL: &str =
    "SELECT value FROM json_each(CAST(COALESCE((SELECT value FROM settings WHERE key = 'published_projects'), x'5b5d') AS TEXT))";
/// A session is public when its project is selected and neither it nor a recorded ancestor is hidden (`crate::hidden`).
pub const SESSION_FILTER: &str = "s.project IN (SELECT value FROM json_each(CAST(COALESCE((SELECT value FROM settings WHERE key = 'published_projects'), x'5b5d') AS TEXT))) AND s.sid NOT IN (SELECT sid FROM session_hidden)";

static VISIBLE_SQL: LazyLock<String> = LazyLock::new(|| {
    format!("SELECT EXISTS(SELECT 1 FROM sessions s WHERE s.id = ?1 AND {SESSION_FILTER})")
});

const BATCH_VISIBLE_SQL: &str =
    "SELECT s.id, s.sid, s.project FROM json_each(?1) j CROSS JOIN sessions s ON s.id = j.value";
const CHILD_COUNT_SQL: &str = "SELECT COUNT(*) FROM sessions s \
     WHERE s.parent_session_id = ?1 AND s.project IN (SELECT value FROM json_each(?2))";
const CHILD_COUNT_HIDDEN_SQL: &str = "SELECT COUNT(*) FROM sessions s \
     WHERE s.parent_session_id = ?1 AND s.project IN (SELECT value FROM json_each(?2)) \
     AND s.sid NOT IN (SELECT sid FROM session_hidden)";
const BATCH_CHILD_COUNTS_SQL: &str = "SELECT s.parent_session_id, COUNT(*) \
     FROM json_each(?1) j CROSS JOIN sessions s ON s.parent_session_id = j.value \
     WHERE s.project IN (SELECT value FROM json_each(?2)) \
     GROUP BY s.parent_session_id";
const BATCH_CHILD_COUNTS_HIDDEN_SQL: &str = "SELECT s.parent_session_id, COUNT(*) \
     FROM json_each(?1) j CROSS JOIN sessions s ON s.parent_session_id = j.value \
     WHERE s.project IN (SELECT value FROM json_each(?2)) \
     AND s.sid NOT IN (SELECT sid FROM session_hidden) \
     GROUP BY s.parent_session_id";

#[derive(Serialize)]
pub struct Publishing {
    pub projects: Vec<Project>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub project: String,
    pub session_count: i64,
    /// How many of `session_count` are hidden from the public view, themselves or through an ancestor.
    pub hidden_count: i64,
    pub published: bool,
}

/// Whether `project` is in the publishing selection.
pub fn is_selected(conn: &Connection, project: &str) -> ReadResult<bool> {
    Ok(selected(conn)?.contains(project))
}

fn selected(conn: &Connection) -> ReadResult<BTreeSet<String>> {
    let bytes: Option<Vec<u8>> = conn
        .prepare_cached("SELECT value FROM settings WHERE key = ?1")?
        .query_row([KEY], |r| r.get(0))
        .optional()?;
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
    let hidden: BTreeMap<String, i64> = conn
        .prepare_cached(
            "SELECT s.project, COUNT(*) FROM session_hidden h JOIN sessions s USING (sid)
             WHERE s.project IS NOT NULL AND s.project <> '' GROUP BY s.project",
        )?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    Ok(Publishing {
        projects: counts
            .into_iter()
            .map(|(project, session_count)| {
                let published = selected.contains(&project);
                let hidden_count = hidden.get(&project).copied().unwrap_or(0);
                Project { project, session_count, hidden_count, published }
            })
            .collect(),
    })
}

/// Caller holds the store's IMMEDIATE write transaction, so concurrent project changes are preserved.
pub fn update(conn: &Connection, project: &str, published: bool) -> ReadResult<Publishing> {
    let mut selections = selected(conn)?;
    if published {
        if !crate::util::valid_project(project) {
            return Err(bad("invalid project"));
        }
        let exists: bool = conn
            .prepare_cached("SELECT EXISTS(SELECT 1 FROM sessions WHERE project = ?1)")?
            .query_row([project], |r| r.get(0))?;
        if !exists {
            return Err(bad("unknown project"));
        }
        selections.insert(project.to_owned());
    } else {
        selections.remove(project);
    }
    let bytes = serde_json::to_vec(&selections).map_err(anyhow::Error::from)?;
    conn.prepare_cached("INSERT OR REPLACE INTO settings (key, value) VALUES (?1, ?2)")?.execute(params![KEY, bytes])?;
    settings(conn)
}

/// Preloaded publishing and hidden state for a single read snapshot.
pub struct Published {
    projects: BTreeSet<String>,
    projects_json: String,
    hidden: HashSet<i64>,
    visible_cache: HashMap<String, bool>,
}

impl Published {
    /// Loads the published project selection and hidden session set once for the current read snapshot.
    pub fn load(conn: &Connection) -> ReadResult<Published> {
        let projects = selected(conn)?;
        if projects.is_empty() {
            return Ok(Published {
                projects,
                projects_json: "[]".to_owned(),
                hidden: HashSet::new(),
                visible_cache: HashMap::new(),
            });
        }
        let projects_json = serde_json::to_string(&projects).map_err(anyhow::Error::from)?;
        let hidden = conn
            .prepare_cached("SELECT sid FROM session_hidden")?
            .query_map([], |r| r.get(0))?
            .collect::<rusqlite::Result<HashSet<i64>>>()?;
        Ok(Published { projects, projects_json, hidden, visible_cache: HashMap::new() })
    }

    fn row_visible(&self, sid: i64, project: Option<&str>) -> bool {
        !self.hidden.contains(&sid) && project.is_some_and(|p| self.projects.contains(p))
    }

    /// Records a session whose visibility is already known in this snapshot (for example, a row returned by a query
    /// already filtered with `SESSION_FILTER`).
    pub fn record_visible(&mut self, id: &str, visible: bool) {
        self.visible_cache.insert(id.to_owned(), visible);
    }

    /// Whether `id` is publicly visible, reusing preloaded projects/hidden state and caching the lookup.
    pub fn is_visible(&mut self, conn: &Connection, id: &str) -> ReadResult<bool> {
        if self.projects.is_empty() {
            return Ok(false);
        }
        if let Some(&visible) = self.visible_cache.get(id) {
            return Ok(visible);
        }
        let row: Option<(i64, Option<String>)> = conn
            .prepare_cached("SELECT sid, project FROM sessions WHERE id = ?1")?
            .query_row([id], |r| Ok((r.get(0)?, r.get(1)?)))
            .optional()?;
        let visible = row.is_some_and(|(sid, project)| self.row_visible(sid, project.as_deref()));
        self.visible_cache.insert(id.to_owned(), visible);
        Ok(visible)
    }

    /// Resolves and caches visibility for every uncached id in `ids` with at most one prepared batch query.
    pub fn preload_visible<'a>(&mut self, conn: &Connection, ids: impl IntoIterator<Item = &'a str>) -> ReadResult<()> {
        let mut missing: Vec<&str> = Vec::new();
        let mut seen: HashSet<&str> = HashSet::new();
        for id in ids {
            if !self.visible_cache.contains_key(id) && seen.insert(id) {
                missing.push(id);
            }
        }
        if missing.is_empty() {
            return Ok(());
        }
        if self.projects.is_empty() {
            for id in missing {
                self.visible_cache.insert(id.to_owned(), false);
            }
            return Ok(());
        }
        if missing.len() == 1 {
            self.is_visible(conn, missing[0])?;
            return Ok(());
        }
        for &id in &missing {
            self.visible_cache.insert(id.to_owned(), false);
        }
        let ids_json = serde_json::to_string(&missing).map_err(anyhow::Error::from)?;
        let mut stmt = conn.prepare_cached(BATCH_VISIBLE_SQL)?;
        let mut rows = stmt.query([ids_json])?;
        while let Some(row) = rows.next()? {
            let id: String = row.get(0)?;
            let sid: i64 = row.get(1)?;
            let project: Option<String> = row.get(2)?;
            let visible = self.row_visible(sid, project.as_deref());
            self.visible_cache.insert(id, visible);
        }
        Ok(())
    }

    /// Visible direct child count for a single parent session.
    pub fn child_count(&self, conn: &Connection, parent_id: &str) -> ReadResult<i64> {
        if self.projects.is_empty() {
            return Ok(0);
        }
        let sql = if self.hidden.is_empty() { CHILD_COUNT_SQL } else { CHILD_COUNT_HIDDEN_SQL };
        Ok(conn.prepare_cached(sql)?.query_row(params![parent_id, &self.projects_json], |r| r.get(0))?)
    }

    /// Visible direct child counts for a batch of parent sessions, keyed by parent id (absent entries have 0).
    pub fn child_counts<'a>(
        &self,
        conn: &Connection,
        parent_ids: impl IntoIterator<Item = &'a str>,
    ) -> ReadResult<HashMap<String, i64>> {
        if self.projects.is_empty() {
            return Ok(HashMap::new());
        }
        let mut unique: Vec<&str> = Vec::new();
        let mut seen: HashSet<&str> = HashSet::new();
        for id in parent_ids {
            if seen.insert(id) {
                unique.push(id);
            }
        }
        if unique.is_empty() {
            return Ok(HashMap::new());
        }
        if unique.len() == 1 {
            let count = self.child_count(conn, unique[0])?;
            let mut counts = HashMap::new();
            if count > 0 {
                counts.insert(unique[0].to_owned(), count);
            }
            return Ok(counts);
        }
        let ids_json = serde_json::to_string(&unique).map_err(anyhow::Error::from)?;
        let sql = if self.hidden.is_empty() { BATCH_CHILD_COUNTS_SQL } else { BATCH_CHILD_COUNTS_HIDDEN_SQL };
        let mut stmt = conn.prepare_cached(sql)?;
        let counts = stmt
            .query_map(params![ids_json, &self.projects_json], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?
            .collect::<rusqlite::Result<HashMap<_, _>>>()?;
        Ok(counts)
    }

    /// Scrubs private fields, clears an invisible `parent_session_id`, and sets `child_count`.
    pub fn apply_summary(
        &mut self,
        conn: &Connection,
        summary: &mut super::sessions::SessionSummary,
        child_count: i64,
    ) -> ReadResult<()> {
        if let Some(parent) = &summary.parent_session_id {
            if !self.is_visible(conn, parent)? {
                summary.parent_session_id = None;
            }
        }
        summary.link = None;
        summary.herder_run_id = None;
        summary.hidden = None;
        summary.hidden_by = None;
        summary.child_count = child_count;
        Ok(())
    }

    pub fn summary(&mut self, conn: &Connection, summary: &mut super::sessions::SessionSummary) -> ReadResult<()> {
        let count = self.child_count(conn, &summary.id)?;
        self.apply_summary(conn, summary, count)
    }

    /// Batches parent visibility checks and visible child counts for a slice of summaries.
    pub fn summaries(&mut self, conn: &Connection, summaries: &mut [super::sessions::SessionSummary]) -> ReadResult<()> {
        if summaries.is_empty() {
            return Ok(());
        }
        self.preload_visible(conn, summaries.iter().filter_map(|s| s.parent_session_id.as_deref()))?;
        let counts = self.child_counts(conn, summaries.iter().map(|s| s.id.as_str()))?;
        for summary in summaries {
            let count = counts.get(&summary.id).copied().unwrap_or(0);
            self.apply_summary(conn, summary, count)?;
        }
        Ok(())
    }

    pub fn detail(&mut self, conn: &Connection, detail: &mut super::sessions::SessionDetail) -> ReadResult<()> {
        self.preload_visible(
            conn,
            detail
                .summary
                .parent_session_id
                .as_deref()
                .into_iter()
                .chain(detail.children.iter().map(|c| c.summary.id.as_str()))
                .chain(detail.children.iter().filter_map(|c| c.summary.parent_session_id.as_deref())),
        )?;
        let mut children = Vec::with_capacity(detail.children.len());
        for child in detail.children.drain(..) {
            if self.is_visible(conn, &child.summary.id)? {
                children.push(child);
            }
        }
        detail.children = children;
        let counts = self.child_counts(
            conn,
            std::iter::once(detail.summary.id.as_str()).chain(detail.children.iter().map(|c| c.summary.id.as_str())),
        )?;
        let root_count = counts.get(&detail.summary.id).copied().unwrap_or(0);
        self.apply_summary(conn, &mut detail.summary, root_count)?;
        for child in &mut detail.children {
            let count = counts.get(&child.summary.id).copied().unwrap_or(0);
            self.apply_summary(conn, &mut child.summary, count)?;
        }
        Ok(())
    }

    pub fn trace(&mut self, conn: &Connection, trace: &mut super::trace::Trace) -> ReadResult<()> {
        self.preload_visible(conn, trace.children.iter().map(|c| c.session_id.as_str()))?;
        let mut children = Vec::with_capacity(trace.children.len());
        let mut visible_children: HashSet<String> = HashSet::new();
        for mut child in trace.children.drain(..) {
            child.ticket = None;
            if self.is_visible(conn, &child.session_id)? {
                visible_children.insert(child.session_id.clone());
                children.push(child);
            }
        }
        trace.children = children;
        for record in &mut trace.records {
            match record {
                super::trace::Record::Llm(record) => record.request_id = None,
                super::trace::Record::Tool(record) => {
                    if let Some(child) = &record.child_session_id {
                        if !visible_children.contains(child) && !self.is_visible(conn, child)? {
                            record.child_session_id = None;
                        }
                    }
                }
                _ => {}
            }
        }
        Ok(())
    }
}

pub fn visible(conn: &Connection, id: &str) -> ReadResult<bool> {
    Ok(conn.prepare_cached(&VISIBLE_SQL)?.query_row([id], |r| r.get(0))?)
}

pub fn require(conn: &Connection, id: &str) -> ReadResult<()> {
    if visible(conn, id)? { Ok(()) } else { Err(ReadError::NotFound) }
}

pub fn summary(conn: &Connection, summary: &mut super::sessions::SessionSummary) -> ReadResult<()> {
    Published::load(conn)?.summary(conn, summary)
}

pub fn detail(conn: &Connection, detail: &mut super::sessions::SessionDetail) -> ReadResult<()> {
    Published::load(conn)?.detail(conn, detail)
}

pub(crate) fn trace(conn: &Connection, trace: &mut super::trace::Trace) -> ReadResult<()> {
    Published::load(conn)?.trace(conn, trace)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::read::Params;
    use crate::read::sessions::{Tokens, detail as load_detail, list_scoped, tree_scoped};
    use crate::read::trace::{LlmRecord, Record, ToolRecord, Trace, TraceChild, TraceTicket};

    fn insert_session(
        conn: &Connection,
        sid: i64,
        id: &str,
        project: Option<&str>,
        parent: Option<&str>,
        last_at: i64,
    ) {
        conn.prepare_cached(
            "INSERT INTO sessions (sid, id, device, project, last_at, parent_session_id, link, herder_run_id, child_count)
             VALUES (?1, ?2, 'dev-1', ?3, ?4, ?5, '{\"kind\":\"subagent\"}', 'run-1', 99)",
        )
        .unwrap()
        .execute(params![sid, id, project, last_at, parent])
        .unwrap();
    }

    fn tool_record(seq: i64, child_session_id: Option<&str>) -> Record {
        Record::Tool(ToolRecord {
            seq,
            result_seq: None,
            turn: Some(0),
            call_id: format!("call-{seq}"),
            name: Some("Agent".to_owned()),
            start: None,
            end: None,
            duration_ms: None,
            is_error: false,
            summary: String::new(),
            arguments: None,
            output_size: None,
            child_session_id: child_session_id.map(str::to_owned),
        })
    }

    fn trace_child(session_id: &str) -> TraceChild {
        TraceChild {
            session_id: session_id.to_owned(),
            parent_tool_call_id: Some("call-1".to_owned()),
            agent_type: Some("worker".to_owned()),
            description: None,
            kind: "subagent",
            started_at: None,
            last_at: None,
            entry_count: 1,
            tokens: Tokens::default(),
            cost: 0.0,
            title: session_id.to_owned(),
            ticket: Some(TraceTicket { id: 42, branch: Some("b".to_owned()), title: Some("t".to_owned()) }),
        }
    }

    #[test]
    fn visibility_and_hidden_ancestor_exclusion() {
        let dir = tempfile::tempdir().unwrap();
        let store = crate::store::Store::open(dir.path()).unwrap();
        store
            .write(|tx| {
                insert_session(tx, 1, "pub-ok", Some("pub-a"), None, 100);
                insert_session(tx, 2, "priv-only", Some("priv-b"), None, 101);
                insert_session(tx, 3, "no-project", None, None, 102);
                insert_session(tx, 4, "anc", Some("pub-a"), None, 103);
                insert_session(tx, 5, "anc-child", Some("pub-a"), Some("anc"), 104);
                insert_session(tx, 6, "anc-grand", Some("pub-a"), Some("anc-child"), 105);

                // Nothing published yet.
                assert!(!visible(tx, "pub-ok").unwrap());
                assert!(matches!(require(tx, "pub-ok"), Err(ReadError::NotFound)));
                let mut empty = Published::load(tx).unwrap();
                assert!(!empty.is_visible(tx, "pub-ok").unwrap());

                // Publish `pub-a` and hide `anc` (which cascades to `anc-child` and `anc-grand`).
                update(tx, "pub-a", true).unwrap();
                crate::hidden::set(tx, "anc", true, 1000).unwrap();

                let mut published = Published::load(tx).unwrap();
                published
                    .preload_visible(tx, ["pub-ok", "priv-only", "no-project", "anc", "anc-child", "anc-grand", "missing"])
                    .unwrap();

                for (id, want) in [
                    ("pub-ok", true),
                    ("priv-only", false),
                    ("no-project", false),
                    ("anc", false),
                    ("anc-child", false),
                    ("anc-grand", false),
                    ("missing", false),
                ] {
                    assert_eq!(visible(tx, id).unwrap(), want, "visible({id})");
                    assert_eq!(published.is_visible(tx, id).unwrap(), want, "Published::is_visible({id})");
                }
                assert!(require(tx, "pub-ok").is_ok());
                assert!(matches!(require(tx, "anc-grand"), Err(ReadError::NotFound)));
                Ok::<_, anyhow::Error>(())
            })
            .unwrap();
    }

    #[test]
    fn summaries_detail_tree_and_list_clear_parents_and_count_visible_children() {
        let dir = tempfile::tempdir().unwrap();
        let store = crate::store::Store::open(dir.path()).unwrap();
        store
            .write(|tx| {
                insert_session(tx, 1, "priv-parent", Some("priv"), None, 100);
                insert_session(tx, 2, "pub-root", Some("pub-a"), Some("priv-parent"), 200);
                insert_session(tx, 3, "vis-child-1", Some("pub-a"), Some("pub-root"), 300);
                insert_session(tx, 4, "vis-child-2", Some("pub-a"), Some("pub-root"), 400);
                insert_session(tx, 5, "priv-child", Some("priv"), Some("pub-root"), 500);
                insert_session(tx, 6, "hidden-child", Some("pub-a"), Some("pub-root"), 600);
                insert_session(tx, 7, "hidden-grand", Some("pub-a"), Some("hidden-child"), 700);
                insert_session(tx, 8, "vis-grand", Some("pub-a"), Some("vis-child-1"), 800);
                insert_session(tx, 9, "priv-grand", Some("priv"), Some("vis-child-1"), 900);

                update(tx, "pub-a", true).unwrap();
                crate::hidden::set(tx, "hidden-child", true, 1000).unwrap();

                // Batched `summaries`: clears unpublished parent, scrubs private fields, counts visible children.
                let mut rows = vec![
                    load_detail(tx, "pub-root").unwrap().summary,
                    load_detail(tx, "vis-child-1").unwrap().summary,
                    load_detail(tx, "vis-child-2").unwrap().summary,
                ];
                rows[0].hidden = Some(false);
                rows[0].hidden_by = Some("owner-flag".to_owned());
                Published::load(tx).unwrap().summaries(tx, &mut rows).unwrap();

                assert_eq!(rows[0].parent_session_id, None);
                assert_eq!(rows[0].link, None);
                assert_eq!(rows[0].herder_run_id, None);
                assert_eq!(rows[0].hidden, None);
                assert_eq!(rows[0].hidden_by, None);
                assert_eq!(rows[0].child_count, 2);

                assert_eq!(rows[1].parent_session_id.as_deref(), Some("pub-root"));
                assert_eq!(rows[1].child_count, 1);

                assert_eq!(rows[2].parent_session_id.as_deref(), Some("pub-root"));
                assert_eq!(rows[2].child_count, 0);

                // `detail`: filters out unpublished & hidden children and computes exact child counts.
                let mut d = load_detail(tx, "pub-root").unwrap();
                detail(tx, &mut d).unwrap();
                assert_eq!(d.summary.parent_session_id, None);
                assert_eq!(d.summary.child_count, 2);
                let child_ids: Vec<&str> = d.children.iter().map(|c| c.summary.id.as_str()).collect();
                assert_eq!(child_ids, ["vis-child-1", "vis-child-2"]);
                assert_eq!(d.children[0].summary.parent_session_id.as_deref(), Some("pub-root"));
                assert_eq!(d.children[0].summary.child_count, 1);
                assert_eq!(d.children[1].summary.child_count, 0);

                // `list_scoped`: truncates limit + 1 lookahead before enriching and preserves exact counts/parents.
                let mut p = Params::default();
                p.0.insert("limit".into(), "2".into());
                let page1 = list_scoped(tx, &p, true).unwrap();
                assert_eq!(page1.items.len(), 2);
                assert!(page1.next_cursor.is_some());
                assert_eq!(page1.items[0].id, "vis-grand");
                assert_eq!(page1.items[0].parent_session_id.as_deref(), Some("vis-child-1"));
                assert_eq!(page1.items[0].child_count, 0);
                assert_eq!(page1.items[1].id, "vis-child-2");
                assert_eq!(page1.items[1].parent_session_id.as_deref(), Some("pub-root"));
                assert_eq!(page1.items[1].child_count, 0);

                p.0.insert("cursor".into(), page1.next_cursor.unwrap());
                let page2 = list_scoped(tx, &p, true).unwrap();
                assert_eq!(page2.items.len(), 2);
                assert!(page2.next_cursor.is_none());
                assert_eq!(page2.items[0].id, "vis-child-1");
                assert_eq!(page2.items[0].child_count, 1);
                assert_eq!(page2.items[1].id, "pub-root");
                assert_eq!(page2.items[1].parent_session_id, None);
                assert_eq!(page2.items[1].child_count, 2);

                // `tree_scoped`: reuses preloaded visibility and counts only visible children.
                let t = tree_scoped(tx, "vis-grand", true).unwrap();
                assert_eq!(t.root_id, "pub-root");
                let node_summary: Vec<(&str, Option<&str>, i64)> = t
                    .nodes
                    .iter()
                    .map(|n| (n.summary.id.as_str(), n.summary.parent_session_id.as_deref(), n.summary.child_count))
                    .collect();
                assert_eq!(
                    node_summary,
                    [
                        ("pub-root", None, 2),
                        ("vis-child-1", Some("pub-root"), 1),
                        ("vis-grand", Some("vis-child-1"), 0),
                        ("vis-child-2", Some("pub-root"), 0),
                    ]
                );
                Ok::<_, anyhow::Error>(())
            })
            .unwrap();
    }

    #[test]
    fn trace_reuses_visible_children_and_filters_tool_links() {
        let dir = tempfile::tempdir().unwrap();
        let store = crate::store::Store::open(dir.path()).unwrap();
        store
            .write(|tx| {
                insert_session(tx, 1, "root", Some("pub-a"), None, 100);
                insert_session(tx, 2, "vis-child", Some("pub-a"), Some("root"), 200);
                insert_session(tx, 3, "priv-child", Some("priv"), Some("root"), 300);
                insert_session(tx, 4, "hidden-child", Some("pub-a"), Some("root"), 400);
                insert_session(tx, 5, "hidden-desc", Some("pub-a"), Some("hidden-child"), 500);
                insert_session(tx, 6, "unlisted-vis", Some("pub-a"), None, 600);
                insert_session(tx, 7, "unlisted-priv", Some("priv"), None, 700);

                update(tx, "pub-a", true).unwrap();
                crate::hidden::set(tx, "hidden-child", true, 1000).unwrap();

                let mut tr = Trace {
                    session_id: "root".to_owned(),
                    started_at: None,
                    last_at: None,
                    turns: Vec::new(),
                    children: vec![trace_child("vis-child"), trace_child("priv-child"), trace_child("hidden-child")],
                    records: vec![
                        Record::Llm(LlmRecord {
                            seq: 1,
                            turn: Some(0),
                            start: None,
                            end: None,
                            sent_at: None,
                            response_at: None,
                            first_token_at: None,
                            first_token: None,
                            model: None,
                            stop_reason: None,
                            error: None,
                            input: 0,
                            output: 0,
                            cache_read: 0,
                            cache_write: 0,
                            cost: 0.0,
                            request_id: Some("req-secret".to_owned()),
                            text: None,
                            thinking: None,
                            tool_calls: 0,
                            spokesman_seq: None,
                        }),
                        tool_record(2, Some("vis-child")),
                        tool_record(3, Some("priv-child")),
                        tool_record(4, Some("hidden-child")),
                        tool_record(5, Some("unlisted-vis")),
                        tool_record(6, Some("unlisted-priv")),
                        tool_record(7, Some("hidden-desc")),
                        tool_record(8, Some("missing-child")),
                    ],
                };

                trace(tx, &mut tr).unwrap();

                assert_eq!(tr.children.len(), 1);
                assert_eq!(tr.children[0].session_id, "vis-child");
                assert_eq!(tr.children[0].ticket, None);

                match &tr.records[0] {
                    Record::Llm(r) => assert_eq!(r.request_id, None),
                    other => panic!("expected Llm record, got {other:?}"),
                }

                let tool_links: Vec<Option<&str>> = tr.records[1..]
                    .iter()
                    .map(|r| match r {
                        Record::Tool(t) => t.child_session_id.as_deref(),
                        other => panic!("expected Tool record, got {other:?}"),
                    })
                    .collect();
                assert_eq!(
                    tool_links,
                    [Some("vis-child"), None, None, Some("unlisted-vis"), None, None, None]
                );
                Ok::<_, anyhow::Error>(())
            })
            .unwrap();
    }

    #[test]
    fn batched_queries_use_session_indexes() {
        let dir = tempfile::tempdir().unwrap();
        let store = crate::store::Store::open(dir.path()).unwrap();
        store
            .read(|conn| {
                let ids = json!(["a", "b"]).to_string();
                let projects = json!(["p"]).to_string();

                let check = |sql: &str, args: &[&str], expected_index: &str| {
                    let mut stmt = conn.prepare(&format!("EXPLAIN QUERY PLAN {sql}")).unwrap();
                    let plan: Vec<String> = stmt
                        .query_map(rusqlite::params_from_iter(args), |r| r.get::<_, String>(3))
                        .unwrap()
                        .collect::<rusqlite::Result<_>>()
                        .unwrap();
                    assert!(
                        plan.iter().any(|line| line.contains(expected_index)),
                        "expected {expected_index} in plan for `{sql}`: {plan:?}"
                    );
                    assert!(
                        !plan.iter().any(|line| line.starts_with("SCAN s")),
                        "unexpected full scan of sessions for `{sql}`: {plan:?}"
                    );
                };

                check(&VISIBLE_SQL, &["a"], "sqlite_autoindex_sessions_1");
                check(BATCH_VISIBLE_SQL, &[&ids], "sqlite_autoindex_sessions_1");
                check(CHILD_COUNT_SQL, &["a", &projects], "sessions_parent");
                check(CHILD_COUNT_HIDDEN_SQL, &["a", &projects], "sessions_parent");
                check(BATCH_CHILD_COUNTS_SQL, &[&ids, &projects], "sessions_parent");
                check(BATCH_CHILD_COUNTS_HIDDEN_SQL, &[&ids, &projects], "sessions_parent");
                Ok::<_, rusqlite::Error>(())
            })
            .unwrap();
    }
}
