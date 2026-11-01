use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::types::Value as Sql;
use rusqlite::{Connection, OptionalExtension, Statement as Prepared, params_from_iter};
use serde::Serialize;
use serde_json::json;

use super::sessions::MAX_TREE_DEPTH;
use super::{Page, Params, ReadResult, bad, cursor_int, iso, page};
use crate::derive::search::{MARK_END, MARK_START, SID_MASK, SID_SHIFT};
use crate::redact::Scope;
use crate::util::escape_html;

pub const SEARCH_LIMIT: i64 = 50;
pub const MAX_SEARCH_LIMIT: i64 = 200;
pub const MAX_RELEVANCE_LIMIT: i64 = 100;
const SNIPPET_TOKENS: i64 = 24;
/// `sort=relevance` and `group=session` rank this many of the newest filtered matches: scoring every match of a
/// common term takes too long.
pub const RELEVANCE_WINDOW: i64 = 20_000;
/// `group=session` returns this many sessions by default, at most `MAX_RELEVANCE_LIMIT`.
pub const GROUP_LIMIT: i64 = 20;
/// `group=session` returns at most this many hits for each session.
pub const GROUP_HITS: usize = 3;
/// With `prefix=true`, the last word matches as a prefix only when it ends in at least this many letters or digits.
/// The index's prefix index holds every 3-character prefix; for a shorter one FTS5 would merge the matches of every
/// term it starts, and those of 1 or 2 characters start too many.
pub const MIN_PREFIX_CHARS: usize = 3;
/// `group=session` with `sort=relevance` divides a session's best bm25 by `1 + age / RECENCY_SECS`, where age is the
/// time since its newest match: one this much older needs twice the score to rank level.
const RECENCY_SECS: f64 = 30.0 * 86_400.0;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hit {
    pub session_id: String,
    pub session_title: String,
    pub seq: i64,
    pub entry_id: Option<String>,
    pub kind: String,
    pub snippet: String,
    pub at: Option<String>,
    #[serde(skip)]
    rowid: i64,
}

/// Turns user input into an FTS5 query: each whitespace-separated word, or `"quoted phrase"`, becomes a quoted FTS5
/// string, and all of them must match. Operators and special characters lose their meaning, so no input is invalid.
/// Control characters, which the tokenizer treats as separators anyway, become spaces: SQLite ends a query at NUL.
///
/// With `prefix`, for search as you type, the word still being typed also matches as a prefix (`refac` matches
/// `refactor`): the last word when the input ends in it, or the last word of a phrase whose quote is still open. A
/// trailing space or a closing quote marks it finished. It needs `MIN_PREFIX_CHARS` letters or digits at its end.
pub fn fts_query(q: &str, prefix: bool) -> Option<String> {
    let q: String = q.chars().map(|c| if c.is_control() { ' ' } else { c }).collect();
    let mut phrases = Vec::new();
    let mut typing = None;
    let mut rest = q.as_str();
    loop {
        rest = rest.trim_start();
        if rest.is_empty() {
            break;
        }
        let (phrase, after, closed) = match rest.strip_prefix('"') {
            Some(quoted) => match quoted.find('"') {
                Some(end) => (&quoted[..end], &quoted[end + 1..], true),
                None => (quoted, "", false),
            },
            None => {
                let end = rest.find(|c: char| c.is_whitespace() || c == '"').unwrap_or(rest.len());
                let (word, after) = rest.split_at(end);
                (word, after, false)
            }
        };
        if !phrase.trim().is_empty() {
            phrases.push(format!("\"{}\"", phrase.replace('"', "\"\"")));
            typing = (!closed && after.is_empty()).then_some(phrase);
        }
        rest = after;
    }
    if prefix
        && let Some(word) = typing
        && word.chars().rev().take_while(|c| c.is_alphanumeric()).count() >= MIN_PREFIX_CHARS
        && let Some(last) = phrases.last_mut()
    {
        last.push('*');
    }
    (!phrases.is_empty()).then(|| phrases.join(" "))
}

/// The `sort` parameter: whether results go by relevance rather than newest first.
fn by_relevance(p: &Params) -> ReadResult<bool> {
    match p.get("sort") {
        None | Some("newest") => Ok(false),
        Some("relevance") => Ok(true),
        Some(_) => Err(bad("sort must be newest or relevance")),
    }
}

/// The FTS5 query for `q` and `prefix`, or `None` when it has no terms.
fn query(p: &Params) -> ReadResult<Option<String>> {
    let prefix = p.bool("prefix")?;
    Ok(p.get("q").and_then(|q| fts_query(q, prefix)))
}

fn render_snippet(raw: &str) -> String {
    escape_html(raw).replace(MARK_START, "<mark>").replace(MARK_END, "</mark>")
}

pub(crate) struct Statement {
    pub sql: String,
    pub args: Vec<Sql>,
    limit: i64,
    /// With `sort=relevance`, the statement selects the best document ids, whose hits this looks up.
    lookup: Option<Lookup>,
}

/// The `device` and `project` filters as conditions on `sessions s`, with their arguments; in the public namespace,
/// also publication, so no snippet or title of an unpublished session can match.
fn session_filters(p: &Params, public: bool) -> (String, Vec<Sql>) {
    let mut filters = String::new();
    let mut args = Vec::new();
    if public {
        filters.push_str(&format!(" AND {}", super::publishing::SESSION_FILTER));
    }
    if let Some(device) = p.get("device") {
        filters.push_str(" AND s.device = ?");
        args.push(Sql::Text(device.to_owned()));
    }
    if let Some(project) = p.get("project") {
        filters.push_str(" AND s.project = ?");
        args.push(Sql::Text(project.to_owned()));
    }
    (filters, args)
}

/// The search statement, or `None` when the query has no terms.
///
/// With filters, matches are first checked against the filtered sessions' sid bits in the document id, from a set
/// SQLite builds once: joining every match of a common word to its document and session reads most of the index's
/// documents. The bits identify the session while every sid is below 2^20 (`wide_sids` is false); otherwise matches
/// that pass them are joined for the exact check. Every hit passes the exact filters in its final join, or with
/// `sort=relevance` in its lookup, as well.
pub(crate) fn statement(p: &Params, wide_sids: bool, public: bool) -> ReadResult<Option<Statement>> {
    let relevance = by_relevance(p)?;
    let limit = if relevance { p.limit(SEARCH_LIMIT, MAX_RELEVANCE_LIMIT)? } else { p.limit(SEARCH_LIMIT, MAX_SEARCH_LIMIT)? };
    let cursor = p.cursor()?;
    if relevance && cursor.is_some() {
        return Err(bad("sort=relevance returns one page"));
    }
    let Some(query) = query(p)? else { return Ok(None) };
    let (filters, filter_args) = session_filters(p, public);
    let prefilter = prefilter(&filters);
    let hit_columns = hit_columns();
    let mut args = Vec::new();
    let sql = if relevance {
        // One pass over the newest filtered matches scores them; only the best are looked up, joined, and get
        // snippets. The exact filters in the lookup cost at most `limit` lookups, where in `ranked` they would cost
        // one per match.
        let (exact, exact_filters) = if wide_sids && !filters.is_empty() {
            (" JOIN search_docs d ON d.id = search_fts.rowid JOIN sessions s ON s.sid = d.sid", filters.as_str())
        } else {
            ("", "")
        };
        args.push(Sql::Text(query.clone()));
        if !prefilter.is_empty() {
            args.extend(filter_args.iter().cloned());
        }
        if !exact_filters.is_empty() {
            args.extend(filter_args.iter().cloned());
        }
        args.push(Sql::Integer(RELEVANCE_WINDOW));
        args.push(Sql::Integer(limit));
        format!(
            "WITH ranked AS (
                 SELECT search_fts.rowid AS id, bm25(search_fts) AS rank FROM search_fts{exact}
                 WHERE search_fts MATCH ?{prefilter}{exact_filters}
                 ORDER BY search_fts.rowid DESC LIMIT ?
             )
             SELECT id FROM ranked ORDER BY rank, id DESC LIMIT ?"
        )
    } else {
        args.push(Sql::Text(query.clone()));
        if !prefilter.is_empty() {
            args.extend(filter_args.iter().cloned());
        }
        args.extend(filter_args);
        let mut after = String::new();
        if let Some(key) = &cursor {
            after.push_str(" AND search_fts.rowid < ?");
            args.push(Sql::Integer(cursor_int(key, 0)?));
        }
        args.push(Sql::Integer(limit + 1));
        format!(
            "SELECT {hit_columns}
             FROM search_fts
             JOIN search_docs d ON d.id = search_fts.rowid
             JOIN sessions s ON s.sid = d.sid
             LEFT JOIN entries e ON e.sid = d.sid AND e.seq = d.seq
             WHERE search_fts MATCH ?{prefilter}{filters}{after}
             ORDER BY search_fts.rowid DESC LIMIT ?"
        )
    };
    let lookup = relevance.then(|| Lookup::new(&query, p, public));
    Ok(Some(Statement { sql, args, limit, lookup }))
}

/// The test of a match's sid bits against the sessions that pass `filters`, or nothing without filters.
fn prefilter(filters: &str) -> String {
    if filters.is_empty() {
        return String::new();
    }
    format!(" AND ((search_fts.rowid >> {SID_SHIFT}) & {SID_MASK}) IN (SELECT s.sid & {SID_MASK} FROM sessions s WHERE 1{filters})")
}

/// The columns of a `Hit`, from `search_fts`, its document `d`, session `s`, and entry `e`.
fn hit_columns() -> String {
    format!(
        "search_fts.rowid, snippet(search_fts, 0, char({}), char({}), '…', {SNIPPET_TOKENS}),
         d.seq, d.kind, d.at, s.id, s.title, e.entry_id",
        MARK_START as u32, MARK_END as u32
    )
}

fn hit(r: &rusqlite::Row) -> rusqlite::Result<Hit> {
    Ok(Hit {
        rowid: r.get(0)?,
        snippet: r.get(1)?,
        seq: r.get(2)?,
        kind: r.get(3)?,
        at: iso(r.get(4)?),
        session_id: r.get(5)?,
        session_title: r.get::<_, Option<String>>(6)?.unwrap_or_default(),
        entry_id: r.get(7)?,
    })
}

/// Whether any session passes the filters (a search with none finds nothing), and whether a
/// sid reaches past the sid bits of document ids.
fn sessions_for_filters(conn: &Connection, p: &Params, public: bool) -> ReadResult<(bool, bool)> {
    let (filters, args) = session_filters(p, public);
    Ok(conn
        .prepare_cached(&format!(
            "SELECT EXISTS (SELECT 1 FROM sessions s WHERE 1{filters}), COALESCE((SELECT MAX(sid) FROM sessions), 0) > {SID_MASK}"
        ))?
        .query_row(params_from_iter(args), |r| Ok((r.get(0)?, r.get(1)?)))?)
}

/// Full-text search over session entries. `sort=newest` (the default) walks the index from the newest document and
/// stops at `limit`; `sort=relevance` returns the best `limit` by bm25 of the newest `RELEVANCE_WINDOW` filtered
/// matches as one page. Relevance does not page because bm25 scores change with every indexed document.
pub fn search(conn: &Connection, p: &Params) -> ReadResult<Page<Hit>> {
    search_scoped(conn, p, false)
}

/// `search`, in the public namespace only over published sessions, and only once the index's text is scrubbed under
/// the current rules (see `store::SEARCH_RULES`): until then it finds nothing. Run it in one snapshot: publication
/// and the rules' version are read with the matches.
pub fn search_scoped(conn: &Connection, p: &Params, public: bool) -> ReadResult<Page<Hit>> {
    // Relevance looks its hits up in a second statement. The public HTTP scope may already hold a snapshot.
    let _tx = conn.is_autocommit().then(|| conn.unchecked_transaction()).transpose()?;
    if public && !crate::store::search_rules_current(conn)? {
        return Ok(Page { items: Vec::new(), next_cursor: None });
    }
    let (any, wide_sids) = sessions_for_filters(conn, p, public)?;
    match statement(p, wide_sids, public)? {
        Some(statement) if any => run(conn, statement),
        _ => Ok(Page { items: Vec::new(), next_cursor: None }),
    }
}

/// Quoting leaves no syntax to get wrong, but a query FTS5 still rejects finds nothing rather than failing.
fn unless_rejected<T: Default>(rows: rusqlite::Result<T>) -> ReadResult<T> {
    match rows {
        Ok(rows) => Ok(rows),
        Err(rusqlite::Error::SqliteFailure(_, Some(message))) if message.starts_with("fts5:") => Ok(T::default()),
        Err(e) => Err(e.into()),
    }
}

fn run(conn: &Connection, Statement { sql, args, limit, lookup }: Statement) -> ReadResult<Page<Hit>> {
    let mut stmt = conn.prepare_cached(&sql)?;
    let mut response = if let Some(lookup) = lookup {
        let ids: Vec<i64> = unless_rejected(stmt.query_map(params_from_iter(args), |r| r.get(0)).and_then(|rows| rows.collect()))?;
        let mut hits = lookup.hits(conn, &ids)?;
        Page { items: ids.iter().filter_map(|id| hits.remove(id)).collect(), next_cursor: None }
    } else {
        let items = unless_rejected(stmt.query_map(params_from_iter(args), hit).and_then(|rows| rows.collect()))?;
        page(items, limit, |h| vec![json!(h.rowid)])
    };
    scrub_response(std::iter::empty(), response.items.iter_mut());
    Ok(response)
}

/// Scrub every displayed title and snippet in one scope, for grouped and flat search alike. FTS marks may split
/// a credential, so discovery sees unmarked text; unchanged snippets regain their escaped highlighting afterwards.
fn scrub_response<'a>(titles: impl IntoIterator<Item = &'a mut String>, hits: impl IntoIterator<Item = &'a mut Hit>) {
    let mut hits: Vec<_> = hits.into_iter().collect();
    let marked: Vec<String> = hits.iter_mut().map(|hit| {
        let raw = std::mem::take(&mut hit.snippet);
        hit.snippet = raw.replace([MARK_START, MARK_END], "");
        raw
    }).collect();
    let mut scope = Scope::new();
    for title in titles {
        scope.cut_text(title, 120);
    }
    for hit in &mut hits {
        scope.cut_text(&mut hit.session_title, 120);
        scope.text(&mut hit.snippet);
    }
    scope.finish();
    for (hit, marked) in hits.into_iter().zip(marked) {
        hit.snippet = if hit.snippet == marked.replace([MARK_START, MARK_END], "") {
            render_snippet(&marked)
        } else {
            escape_html(&hit.snippet)
        };
    }
}

/// Looks hits up by document id, each only if it passes the exact filters.
///
/// FTS5 evaluates the query afresh for every lookup. For whole words and phrases a lookup by id seeks in each term's
/// matches, but a prefix that the prefix index does not hold (one of 4 or more characters) first merges the matches of
/// every term it starts, so a prefix query looks every id up in one statement over their range.
pub(crate) struct Lookup {
    query: String,
    filters: String,
    filter_args: Vec<Sql>,
}

impl Lookup {
    pub(crate) fn new(query: &str, p: &Params, public: bool) -> Lookup {
        let (filters, filter_args) = session_filters(p, public);
        Lookup { query: query.to_owned(), filters, filter_args }
    }

    fn by_range(&self) -> bool {
        self.query.ends_with('*')
    }

    /// The statement, after the query: by one id, or by the lowest and highest id and all of them as a JSON array.
    pub(crate) fn sql(&self) -> String {
        // The unary plus keeps the list from FTS5, which would evaluate the query once for each id.
        let ids = if self.by_range() {
            "search_fts.rowid >= ? AND search_fts.rowid <= ? AND +search_fts.rowid IN (SELECT value FROM json_each(?))"
        } else {
            "search_fts.rowid = ?"
        };
        format!(
            "SELECT {}
             FROM search_fts
             JOIN search_docs d ON d.id = search_fts.rowid
             JOIN sessions s ON s.sid = d.sid
             LEFT JOIN entries e ON e.sid = d.sid AND e.seq = d.seq
             WHERE search_fts MATCH ? AND {ids}{}",
            hit_columns(),
            self.filters
        )
    }

    /// The hits of `ids` that pass the filters, by id.
    pub(crate) fn hits(&self, conn: &Connection, ids: &[i64]) -> ReadResult<HashMap<i64, Hit>> {
        let mut found = HashMap::new();
        let (Some(&low), Some(&high)) = (ids.iter().min(), ids.iter().max()) else { return Ok(found) };
        let mut stmt = conn.prepare_cached(&self.sql())?;
        let query = Sql::Text(self.query.clone());
        if self.by_range() {
            let mut args = vec![query, Sql::Integer(low), Sql::Integer(high), Sql::Text(json!(ids).to_string())];
            args.extend(self.filter_args.iter().cloned());
            let hits: Vec<Hit> = unless_rejected(stmt.query_map(params_from_iter(args), hit).and_then(|rows| rows.collect()))?;
            found.extend(hits.into_iter().map(|h| (h.rowid, h)));
        } else {
            for &id in ids {
                let mut args = vec![query.clone(), Sql::Integer(id)];
                args.extend(self.filter_args.iter().cloned());
                if let Some(hit) = unless_rejected(stmt.query_row(params_from_iter(args), hit).optional())? {
                    found.insert(id, hit);
                }
            }
        }
        Ok(found)
    }
}

/// The results of `GET search`: entries, or with `group=session`, sessions.
#[derive(Debug, Serialize)]
#[serde(untagged)]
pub enum Results {
    Entries(Page<Hit>),
    Sessions(Page<SessionMatches>),
}

/// `GET search`, by its `group` parameter.
pub fn results_scoped(conn: &Connection, p: &Params, public: bool) -> ReadResult<Results> {
    match p.get("group") {
        None | Some("entry") => search_scoped(conn, p, public).map(Results::Entries),
        Some("session") => {
            let now = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs() as i64);
            sessions_at(conn, p, public, now).map(Results::Sessions)
        }
        Some(_) => Err(bad("group must be entry or session")),
    }
}

/// A session in `group=session` results: its matches and those of its descendants.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionMatches {
    pub session_id: String,
    pub session_title: String,
    /// How many of the ranked matches are in the session or its descendants.
    pub matches: i64,
    /// Up to `GROUP_HITS`: the newest, or by relevance the best. Each names the session it is in.
    pub hits: Vec<Hit>,
}

/// The window's matches of one root session: (document id, bm25) pairs in the window's order, newest first.
struct Group {
    root: i64,
    newest: i64,
    best: f64,
    members: Vec<(i64, f64)>,
}

/// `group=session`: the newest `RELEVANCE_WINDOW` filtered matches, grouped by the topmost recorded (and, in public,
/// published) ancestor of their session, so a subagent's or Herder step's matches count for the session that started
/// it. `sort=newest` orders sessions by their newest match; `sort=relevance` by their best bm25 divided by
/// `1 + age / RECENCY_SECS`, with `now` in Unix seconds. One page.
///
/// The window reads only document ids (and bm25 scores): while every sid is below 2^20, a match's sid bits are its
/// session, as the prefilter assumes. Only the hits returned are joined, each passing the exact filters.
pub fn sessions_at(conn: &Connection, p: &Params, public: bool, now: i64) -> ReadResult<Page<SessionMatches>> {
    let empty = Page { items: Vec::new(), next_cursor: None };
    let Some(grouped) = Grouped::new(p)? else { return Ok(empty) };
    // One snapshot for every statement. The public HTTP scope may already hold one for authorization.
    let _tx = conn.is_autocommit().then(|| conn.unchecked_transaction()).transpose()?;
    if public && !crate::store::search_rules_current(conn)? {
        return Ok(empty);
    }
    let (any, wide_sids) = sessions_for_filters(conn, p, public)?;
    if !any {
        return Ok(empty);
    }
    grouped.run(conn, p, public, now, wide_sids)
}

/// A `group=session` search's parameters.
pub(crate) struct Grouped {
    query: String,
    relevance: bool,
    limit: i64,
}

impl Grouped {
    /// The parameters, or `None` when the query has no terms.
    pub(crate) fn new(p: &Params) -> ReadResult<Option<Grouped>> {
        let relevance = by_relevance(p)?;
        let limit = p.limit(GROUP_LIMIT, MAX_RELEVANCE_LIMIT)?;
        if p.cursor()?.is_some() {
            return Err(bad("group=session returns one page"));
        }
        Ok(query(p)?.map(|query| Grouped { query, relevance, limit }))
    }

    /// The statement that reads the window: each match's document id, its sid unless `wide_sids` is false (the sid
    /// bits then stand for it), and its bm25 score for relevance; with its arguments.
    pub(crate) fn window(&self, p: &Params, public: bool, wide_sids: bool) -> (String, Vec<Sql>) {
        let (filters, filter_args) = session_filters(p, public);
        let (sid, exact, exact_filters) = match (wide_sids, filters.is_empty()) {
            (false, _) => ("0", "", ""),
            (true, true) => ("d.sid", " JOIN search_docs d ON d.id = search_fts.rowid", ""),
            (true, false) => (
                "d.sid",
                " JOIN search_docs d ON d.id = search_fts.rowid JOIN sessions s ON s.sid = d.sid",
                filters.as_str(),
            ),
        };
        let rank = if self.relevance { "bm25(search_fts)" } else { "0.0" };
        let prefilter = prefilter(&filters);
        let mut args = vec![Sql::Text(self.query.clone())];
        if !prefilter.is_empty() {
            args.extend(filter_args.iter().cloned());
        }
        if !exact_filters.is_empty() {
            args.extend(filter_args.iter().cloned());
        }
        args.push(Sql::Integer(RELEVANCE_WINDOW));
        let sql = format!(
            "SELECT search_fts.rowid, {sid}, {rank} FROM search_fts{exact}
             WHERE search_fts MATCH ?{prefilter}{exact_filters}
             ORDER BY search_fts.rowid DESC LIMIT ?"
        );
        (sql, args)
    }

    pub(crate) fn run(&self, conn: &Connection, p: &Params, public: bool, now: i64, wide_sids: bool) -> ReadResult<Page<SessionMatches>> {
        let (window_sql, args) = self.window(p, public, wide_sids);
        let mut window = conn.prepare_cached(&window_sql)?;
        let matches: Vec<(i64, i64, f64)> = unless_rejected(
            window
                .query_map(params_from_iter(args), |r| {
                    let id: i64 = r.get(0)?;
                    let sid = if wide_sids { r.get(1)? } else { (id >> SID_SHIFT) & SID_MASK };
                    Ok((id, sid, r.get(2)?))
                })
                .and_then(|rows| rows.collect()),
        )?;

        let mut parent = conn.prepare_cached(&parent_sql(public))?;
        let mut roots = HashMap::new();
        let mut index = HashMap::new();
        let mut groups: Vec<Group> = Vec::new();
        for (id, sid, rank) in matches {
            let root = root_of(&mut parent, sid, &mut roots)?;
            let at = *index.entry(root).or_insert_with(|| {
                groups.push(Group { root, newest: id, best: rank, members: Vec::new() });
                groups.len() - 1
            });
            let group = &mut groups[at];
            group.best = group.best.min(rank);
            group.members.push((id, rank));
        }
        // The window is newest first, so the groups already are.
        if self.relevance {
            let score = |g: &Group| g.best / (1.0 + (now - (g.newest >> 32)).max(0) as f64 / RECENCY_SECS);
            groups.sort_by(|a, b| score(a).total_cmp(&score(b)).then(b.newest.cmp(&a.newest)));
            for group in &mut groups {
                group.members.sort_by(|a, b| a.1.total_cmp(&b.1).then(b.0.cmp(&a.0)));
            }
        }

        let lookup = Lookup::new(&self.query, p, public);
        let mut session = conn.prepare_cached("SELECT id, title FROM sessions WHERE sid = ?1")?;
        let mut items = Vec::new();
        let mut groups = groups.into_iter().peekable();
        // A session's hits are its first `GROUP_HITS` members, looked up together for as many sessions as are left to
        // fill. Only documents whose sid bits are not their session's can fail the exact filters, and so lose every hit
        // of a session, which leaves its place to the next.
        while groups.peek().is_some() && (items.len() as i64) < self.limit {
            let batch: Vec<Group> = groups.by_ref().take(self.limit as usize - items.len()).collect();
            let ids: Vec<i64> = batch.iter().flat_map(|g| g.members.iter().take(GROUP_HITS).map(|m| m.0)).collect();
            let mut found = lookup.hits(conn, &ids)?;
            for group in batch {
                let hits: Vec<Hit> = group.members.iter().take(GROUP_HITS).filter_map(|m| found.remove(&m.0)).collect();
                if hits.is_empty() {
                    continue;
                }
                let Some((session_id, title)) = session
                    .query_row([group.root], |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?)))
                    .optional()?
                else {
                    continue;
                };
                items.push(SessionMatches {
                    session_id,
                    session_title: title.unwrap_or_default(),
                    matches: group.members.len() as i64,
                    hits,
                });
            }
        }
        let mut titles = Vec::new();
        let mut hits = Vec::new();
        for group in &mut items {
            titles.push(&mut group.session_title);
            hits.extend(group.hits.iter_mut());
        }
        scrub_response(titles, hits);
        Ok(Page { items, next_cursor: None })
    }
}

/// The sid of a session's recorded parent, as `s`; in public, only a published one.
pub(crate) fn parent_sql(public: bool) -> String {
    let published = if public { format!(" AND {}", super::publishing::SESSION_FILTER) } else { String::new() };
    format!("SELECT s.sid FROM sessions c JOIN sessions s ON s.id = c.parent_session_id WHERE c.sid = ?1{published}")
}

/// The topmost ancestor of `sid` that `parent` finds, at most `MAX_TREE_DEPTH` hops up and stopping at a cycle, as
/// `tree` walks; `roots` remembers every session on the way.
fn root_of(parent: &mut Prepared, sid: i64, roots: &mut HashMap<i64, i64>) -> rusqlite::Result<i64> {
    if let Some(&root) = roots.get(&sid) {
        return Ok(root);
    }
    let mut path = vec![sid];
    let root = loop {
        let current = *path.last().unwrap();
        if path.len() > MAX_TREE_DEPTH {
            break current;
        }
        let Some(up) = parent.query_row([current], |r| r.get::<_, i64>(0)).optional()? else { break current };
        if let Some(&root) = roots.get(&up) {
            break root;
        }
        if path.contains(&up) {
            break current;
        }
        path.push(up);
    };
    for sid in path {
        roots.insert(sid, root);
    }
    Ok(root)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::read::ReadError;

    #[test]
    fn queries_are_quoted() {
        assert_eq!(fts_query("  ", false), None);
        assert_eq!(fts_query("flaky test", false).as_deref(), Some(r#""flaky" "test""#));
        assert_eq!(fts_query(r#"say "hello world" NOT x*"#, false).as_deref(), Some(r#""say" "hello world" "NOT" "x*""#));
        assert_eq!(fts_query(r#"open "quote"#, false).as_deref(), Some(r#""open" "quote""#));
        assert_eq!(fts_query(r#"a"b"#, false).as_deref(), Some(r#""a" "b""#));
        assert_eq!(fts_query(r#""""#, false), None);
        assert_eq!(fts_query("🌀 NEAR(a b)", false).as_deref(), Some(r#""🌀" "NEAR(a" "b)""#));
        assert_eq!(fts_query("\"a\u{0}b", false).as_deref(), Some(r#""a b""#));
        assert_eq!(fts_query("\u{0}\u{2}", false), None);
    }

    /// With `prefix`, only the word still being typed is a prefix, and only when it ends in enough letters or digits.
    #[test]
    fn the_word_being_typed_is_a_prefix() {
        let q = |input: &str| fts_query(input, true);
        assert_eq!(q("flaky refac").as_deref(), Some(r#""flaky" "refac"*"#));
        assert_eq!(q("refac flaky").as_deref(), Some(r#""refac" "flaky"*"#));
        assert_eq!(q("refac ").as_deref(), Some(r#""refac""#));
        assert_eq!(q("refac\u{0}").as_deref(), Some(r#""refac""#));
        assert_eq!(q("re").as_deref(), Some(r#""re""#));
        assert_eq!(q("refac.").as_deref(), Some(r#""refac.""#));
        // The tokens of `test_wid` are `test` and `wid`: the last one must be long enough.
        assert_eq!(q("test_wid").as_deref(), Some(r#""test_wid"*"#));
        assert_eq!(q("test_wi").as_deref(), Some(r#""test_wi""#));
        assert_eq!(q("数据库").as_deref(), Some(r#""数据库"*"#));
        // An open quote's last word is being typed; a closed one's is finished.
        assert_eq!(q(r#""pinned the clo"#).as_deref(), Some(r#""pinned the clo"*"#));
        assert_eq!(q(r#""pinned the clock""#).as_deref(), Some(r#""pinned the clock""#));
        assert_eq!(q(r#""pinned the "#).as_deref(), Some(r#""pinned the ""#));
        assert_eq!(q(r#"refac""#).as_deref(), Some(r#""refac""#));
        assert_eq!(q(r#"say "hello world" refac"#).as_deref(), Some(r#""say" "hello world" "refac"*"#));
        assert_eq!(q("  "), None);
    }

    #[test]
    fn snippets_escape_html_around_marks() {
        assert_eq!(render_snippet("<b>\u{2}x&y\u{3}</b>"), "&lt;b&gt;<mark>x&amp;y</mark>&lt;/b&gt;");
    }

    fn session(id: &str, cwd: &str, texts: &[&str]) -> Vec<String> {
        let mut lines = vec![json!({ "type": "session", "version": 3, "id": id, "timestamp": "2026-10-20T09:00:00.000Z", "cwd": cwd })];
        for (i, text) in texts.iter().enumerate() {
            lines.push(json!({ "type": "message", "id": format!("{id}-{i}"), "parentId": null, "timestamp": "2026-10-20T09:00:01.000Z",
                               "message": { "role": "user", "content": text, "timestamp": 1 } }));
        }
        lines.iter().map(|l| l.to_string()).collect()
    }

    /// The sid-bit prefilter and the exact join find the same matches: those of the sessions that pass the filters.
    #[test]
    fn filtered_search_with_and_without_the_exact_join() {
        let dir = tempfile::tempdir().unwrap();
        let store = crate::store::Store::open(dir.path()).unwrap();
        let sessions = [("s0", "a", "/x/p"), ("s1", "b", "/x/p"), ("s2", "a", "/x/q"), ("s3", "b", "/x/q")];
        for (id, device, cwd) in sessions {
            let lines = session(id, cwd, &["alpha beta", "gamma alpha", "beta only", "alpha"]);
            let batch = serde_json::from_value(json!({ "streams": [{ "key": format!("session:{id}"), "kind": "session", "offset": 0, "lines": lines }] }));
            crate::ingest::apply(&store, device, &batch.unwrap()).unwrap();
        }
        store
            .read(|conn| {
                for filters in [vec![], vec![("device", "a")], vec![("project", "q")], vec![("device", "b"), ("project", "p")], vec![("device", "c")]] {
                    let want: Vec<&str> = sessions
                        .iter()
                        .filter(|(_, device, cwd)| {
                            filters.iter().all(|(k, v)| if *k == "device" { device == v } else { cwd.ends_with(v) })
                        })
                        .map(|(id, ..)| *id)
                        .collect();
                    for sort in ["newest", "relevance"] {
                        let mut p = Params::default();
                        for (k, v) in filters.iter().copied().chain([("q", "alpha"), ("sort", sort)]) {
                            p.0.insert(k.into(), v.into());
                        }
                        let mut found = Vec::new();
                        for wide_sids in [false, true] {
                            let hits = run(conn, statement(&p, wide_sids, false)?.unwrap())?.items;
                            let mut ids: Vec<String> = hits.iter().map(|h| h.session_id.clone()).collect();
                            ids.sort();
                            ids.dedup();
                            assert_eq!(hits.len(), want.len() * 3, "{filters:?} {sort} {wide_sids}");
                            found.push(ids);
                        }
                        assert_eq!(found[0], want, "{filters:?} {sort}");
                        assert_eq!(found[1], want, "{filters:?} {sort}");
                    }
                }
                Ok::<_, ReadError>(())
            })
            .unwrap();
    }

    /// A session whose lines have no `timestamp` indexes every part in one second. Past the 4,096 ids of that second
    /// its documents keep their sid bits, so filters on either session find exactly that session's matches.
    #[test]
    fn filters_hold_when_one_second_runs_out_of_ids() {
        let dir = tempfile::tempdir().unwrap();
        let store = crate::store::Store::open(dir.path()).unwrap();
        let header = |id: &str, cwd: &str| {
            json!({ "type": "session", "version": 3, "id": id, "timestamp": "2026-10-20T09:00:00.000Z", "cwd": cwd }).to_string()
        };
        let mut busy = vec![header("s0", "/x/p")];
        busy.extend((0..4_200).map(|i| {
            json!({ "type": "message", "id": format!("s0-{i}"), "parentId": null,
                    "message": { "role": "user", "content": format!("alpha {i}") } })
            .to_string()
        }));
        let neighbour = session("s1", "/x/q", &["alpha", "alpha beta", "gamma alpha"]);
        for (id, device, lines) in [("s0", "a", busy), ("s1", "b", neighbour)] {
            let batch = serde_json::from_value(json!({ "streams": [{ "key": format!("session:{id}"), "kind": "session", "offset": 0, "lines": lines }] }));
            crate::ingest::apply(&store, device, &batch.unwrap()).unwrap();
        }
        store
            .read(|conn| {
                for (filters, want) in [
                    (vec![("device", "a")], vec![("s0", 4_200)]),
                    (vec![("project", "p")], vec![("s0", 4_200)]),
                    (vec![("device", "b")], vec![("s1", 3)]),
                    (vec![("device", "b"), ("project", "q")], vec![("s1", 3)]),
                    (vec![], vec![("s0", 4_200), ("s1", 3)]),
                ] {
                    let params = |sort: &str, cursor: Option<&str>| {
                        let mut p = Params::default();
                        for (k, v) in filters.iter().copied().chain([("q", "alpha"), ("sort", sort), ("limit", "100")]) {
                            p.0.insert(k.into(), v.into());
                        }
                        if let Some(cursor) = cursor {
                            p.0.insert("cursor".into(), cursor.into());
                        }
                        p
                    };
                    let mut newest: Vec<(String, usize)> = Vec::new();
                    let mut cursor = None;
                    loop {
                        let page = search(conn, &params("newest", cursor.as_deref()))?;
                        for hit in page.items {
                            match newest.iter_mut().find(|(id, _)| *id == hit.session_id) {
                                Some((_, n)) => *n += 1,
                                None => newest.push((hit.session_id, 1)),
                            }
                        }
                        cursor = page.next_cursor;
                        if cursor.is_none() {
                            break;
                        }
                    }
                    newest.sort();
                    let want: Vec<(String, usize)> = want.iter().map(|(id, n)| (id.to_string(), *n)).collect();
                    assert_eq!(newest, want, "newest {filters:?}");

                    let relevance = search(conn, &params("relevance", None))?.items;
                    let total: usize = want.iter().map(|(_, n)| n).sum();
                    assert_eq!(relevance.len(), total.min(100), "relevance {filters:?}");
                    assert!(relevance.iter().all(|h| want.iter().any(|(id, _)| *id == h.session_id)), "relevance {filters:?}");
                }
                Ok::<_, ReadError>(())
            })
            .unwrap();
    }

    /// A document whose id carries another session's sid bits passes the prefilter for that session, but no filtered
    /// search returns it under that session's filters.
    #[test]
    fn hits_pass_the_exact_filters_whatever_their_sid_bits() {
        let dir = tempfile::tempdir().unwrap();
        let store = crate::store::Store::open(dir.path()).unwrap();
        for (id, device, cwd) in [("s0", "a", "/x/p"), ("s1", "b", "/x/q")] {
            let lines = session(id, cwd, &["alpha", "alpha beta"]);
            let batch = serde_json::from_value(json!({ "streams": [{ "key": format!("session:{id}"), "kind": "session", "offset": 0, "lines": lines }] }));
            crate::ingest::apply(&store, device, &batch.unwrap()).unwrap();
        }
        store
            .write(|tx| {
                let sid = |id: &str| tx.query_row("SELECT sid FROM sessions WHERE id = ?1", [id], |r| r.get::<_, i64>(0));
                let forged = 1 << 32 | (sid("s1")? & SID_MASK) << SID_SHIFT | 5;
                tx.execute(
                    "INSERT INTO search_docs (id, sid, seq, kind, at, text) VALUES (?1, ?2, 1, 'user', 1000, 'alpha forged')",
                    [forged, sid("s0")?],
                )?;
                tx.execute("INSERT INTO search_fts (rowid, text) VALUES (?1, 'alpha forged')", [forged])?;
                Ok::<_, rusqlite::Error>(())
            })
            .unwrap();
        store
            .read(|conn| {
                for filters in [vec![("device", "b")], vec![("project", "q")], vec![("device", "b"), ("project", "q")], vec![]] {
                    let unfiltered = filters.is_empty();
                    for (q, want) in [("alpha", if unfiltered { 5 } else { 2 }), ("forged", if unfiltered { 1 } else { 0 })] {
                        for sort in ["newest", "relevance"] {
                            let mut p = Params::default();
                            for (k, v) in filters.iter().copied().chain([("q", q), ("sort", sort)]) {
                                p.0.insert(k.into(), v.into());
                            }
                            for wide_sids in [false, true] {
                                let hits = run(conn, statement(&p, wide_sids, false)?.unwrap())?.items;
                                assert_eq!(hits.len(), want, "{filters:?} {q} {sort} {wide_sids}");
                                if !unfiltered {
                                    assert!(hits.iter().all(|h| h.session_id == "s1"), "{filters:?} {q} {sort} {wide_sids}");
                                }
                            }
                        }
                    }
                }
                Ok::<_, ReadError>(())
            })
            .unwrap();
    }

    /// Public search finds only published sessions' matches, with every filter, sort, and sid-bit path, including a
    /// document whose id carries a published session's sid bits but belongs to an unpublished one.
    #[test]
    fn public_search_finds_only_published_sessions() {
        let dir = tempfile::tempdir().unwrap();
        let store = crate::store::Store::open(dir.path()).unwrap();
        let sessions = [("s0", "a", "/x/p"), ("s1", "b", "/x/p"), ("s2", "a", "/x/q"), ("s3", "b", "/x/q")];
        for (id, device, cwd) in sessions {
            let lines = session(id, cwd, &["alpha beta", "gamma alpha", "beta only", "alpha"]);
            let batch = serde_json::from_value(json!({ "streams": [{ "key": format!("session:{id}"), "kind": "session", "offset": 0, "lines": lines }] }));
            crate::ingest::apply(&store, device, &batch.unwrap()).unwrap();
        }
        let hits = |public: bool, filters: &[(&str, &str)], sort: &str, wide_sids: Option<bool>| {
            let mut p = Params::default();
            for (k, v) in filters.iter().copied().chain([("q", "alpha"), ("sort", sort)]) {
                p.0.insert(k.into(), v.into());
            }
            store
                .read(|conn| match wide_sids {
                    Some(wide_sids) => Ok(run(conn, statement(&p, wide_sids, public)?.unwrap())?.items),
                    None => Ok::<_, ReadError>(search_scoped(conn, &p, public)?.items),
                })
                .unwrap()
                .into_iter()
                .map(|h| h.session_id)
                .collect::<Vec<_>>()
        };
        // Nothing is published yet: the owner finds every session, a visitor none.
        assert_eq!(hits(false, &[], "newest", None).len(), 12);
        assert!(hits(true, &[], "newest", None).is_empty());

        store
            .write(|tx| {
                crate::read::publishing::update(tx, "q", true)?;
                let sid = |id: &str| tx.query_row("SELECT sid FROM sessions WHERE id = ?1", [id], |r| r.get::<_, i64>(0));
                let forged = 1 << 32 | (sid("s2")? & SID_MASK) << SID_SHIFT | 5;
                tx.execute(
                    "INSERT INTO search_docs (id, sid, seq, kind, at, text) VALUES (?1, ?2, 1, 'user', 1000, 'alpha forged')",
                    [forged, sid("s0")?],
                )?;
                tx.execute("INSERT INTO search_fts (rowid, text) VALUES (?1, 'alpha forged')", [forged])?;
                Ok::<_, ReadError>(())
            })
            .unwrap();
        for filters in [vec![], vec![("device", "a")], vec![("project", "q")], vec![("project", "p")], vec![("device", "b"), ("project", "q")]] {
            let want: Vec<&str> = sessions
                .iter()
                .filter(|(_, device, cwd)| {
                    cwd.ends_with('q') && filters.iter().all(|(k, v)| if *k == "device" { device == v } else { cwd.ends_with(v) })
                })
                .map(|(id, ..)| *id)
                .collect();
            for sort in ["newest", "relevance"] {
                for wide_sids in [None, Some(false), Some(true)] {
                    let mut ids = hits(true, &filters, sort, wide_sids);
                    assert_eq!(ids.len(), want.len() * 3, "{filters:?} {sort} {wide_sids:?}");
                    ids.sort();
                    ids.dedup();
                    assert_eq!(ids, want, "{filters:?} {sort} {wide_sids:?}");
                }
            }
        }
        // The owner's search is unchanged, the forged document included.
        assert_eq!(hits(false, &[], "newest", None).len(), 13);
    }

    /// Newest-first search reads the index in rowid order and stops at the limit: no sort.
    #[test]
    fn newest_first_needs_no_sort() {
        let dir = tempfile::tempdir().unwrap();
        let store = crate::store::Store::open(dir.path()).unwrap();
        let mut p = Params::default();
        for (key, value) in [("q", "x"), ("device", "d"), ("project", "p"), ("cursor", &crate::read::encode_cursor(&[json!(5)]))] {
            p.0.insert(key.into(), value.into());
        }
        let Statement { sql, args, .. } = statement(&p, false, false).unwrap().unwrap();
        let plan: Vec<String> = store
            .read(|conn| {
                conn.prepare(&format!("EXPLAIN QUERY PLAN {sql}"))?
                    .query_map(params_from_iter(args), |r| r.get::<_, String>(3))?
                    .collect()
            })
            .unwrap();
        assert!(plan[0].starts_with("SCAN search_fts VIRTUAL TABLE"), "{plan:?}");
        assert!(!plan.iter().any(|p| p.contains("TEMP B-TREE")), "{plan:?}");
    }

    /// A session of user messages one second apart from `start`, linked to `parent` as its subagent.
    fn family(id: &str, cwd: &str, start: &str, parent: Option<&str>, texts: &[&str]) -> Vec<String> {
        let start = crate::util::parse_iso_ms(start).unwrap();
        let at = |i: usize| crate::util::format_iso_ms(start + i as i64 * 1000);
        let mut lines = vec![json!({ "type": "session", "version": 3, "id": id, "timestamp": at(0), "cwd": cwd })];
        if let Some(parent) = parent {
            lines.push(json!({ "type": "custom", "id": format!("{id}-link"), "parentId": null, "timestamp": at(0),
                               "customType": "pi-extensions.session-link",
                               "data": { "kind": "subagent", "parentSessionId": parent, "parentToolCallId": "call_1" } }));
        }
        for (i, text) in texts.iter().enumerate() {
            lines.push(json!({ "type": "message", "id": format!("{id}-{i}"), "parentId": null, "timestamp": at(i + 1),
                               "message": { "role": "user", "content": text, "timestamp": 1 } }));
        }
        lines.iter().map(|l| l.to_string()).collect()
    }

    fn upload(store: &crate::store::Store, device: &str, id: &str, lines: Vec<String>) {
        let batch = json!({ "streams": [{ "key": format!("session:{id}"), "kind": "session", "offset": 0, "lines": lines }] });
        crate::ingest::apply(store, device, &serde_json::from_value(batch).unwrap()).unwrap();
    }

    fn params(pairs: &[(&str, &str)]) -> Params {
        let mut p = Params::default();
        for (k, v) in pairs {
            p.0.insert((*k).into(), (*v).into());
        }
        p
    }

    type Grouping = Vec<(String, i64, Vec<(String, i64)>)>;

    /// A `group=session` search with `wide_sids` as given: each session, its match count, and its hits' sessions and
    /// seqs.
    fn grouping(conn: &Connection, pairs: &[(&str, &str)], public: bool, now: i64, wide_sids: bool) -> ReadResult<Grouping> {
        let mut pairs = pairs.to_vec();
        pairs.push(("group", "session"));
        let p = params(&pairs);
        let Some(grouped) = Grouped::new(&p)? else { return Ok(Vec::new()) };
        Ok(grouped
            .run(conn, &p, public, now, wide_sids)?
            .items
            .into_iter()
            .map(|g| (g.session_id, g.matches, g.hits.into_iter().map(|h| (h.session_id, h.seq)).collect()))
            .collect())
    }

    /// `grouping` by sid bits and by joined sids, which must agree.
    fn grouped(store: &crate::store::Store, pairs: &[(&str, &str)], public: bool, now: i64) -> Grouping {
        store
            .read(|conn| {
                let by_bits = grouping(conn, pairs, public, now, false)?;
                assert_eq!(by_bits, grouping(conn, pairs, public, now, true)?, "{pairs:?}");
                Ok::<_, ReadError>(by_bits)
            })
            .unwrap()
    }

    fn group(id: &str, matches: i64, hits: &[(&str, i64)]) -> (String, i64, Vec<(String, i64)>) {
        (id.into(), matches, hits.iter().map(|(id, seq)| (id.to_string(), *seq)).collect())
    }

    /// Matches of children and grandchildren count for their topmost recorded ancestor, whichever arrived first; a
    /// child whose parent is not recorded is its own root. Sessions go by their newest match, each with its newest hits.
    #[test]
    fn grouped_search_folds_descendants_into_their_root() {
        let dir = tempfile::tempdir().unwrap();
        let store = crate::store::Store::open(dir.path()).unwrap();
        upload(&store, "a", "grand", family("grand", "/x/p", "2026-10-20T09:02:00Z", Some("child"), &["alpha grand"]));
        upload(&store, "a", "child", family("child", "/x/p", "2026-10-20T09:01:00Z", Some("root"), &["alpha child"]));
        let texts = ["alpha one", "alpha two", "beta", "alpha three", "alpha four"];
        upload(&store, "a", "root", family("root", "/x/p", "2026-10-20T09:00:00Z", None, &texts));
        upload(&store, "b", "other", family("other", "/x/q", "2026-10-20T09:03:00Z", None, &["alpha other"]));
        upload(&store, "b", "orphan", family("orphan", "/x/r", "2026-10-20T09:04:00Z", Some("missing"), &["alpha orphan"]));

        let root = group("root", 6, &[("grand", 2), ("child", 2), ("root", 5)]);
        let other = group("other", 1, &[("other", 1)]);
        let orphan = group("orphan", 1, &[("orphan", 2)]);
        assert_eq!(grouped(&store, &[("q", "alpha")], false, 0), [orphan.clone(), other.clone(), root.clone()]);
        assert_eq!(grouped(&store, &[("q", "alpha"), ("limit", "2")], false, 0), [orphan.clone(), other.clone()]);
        assert_eq!(grouped(&store, &[("q", "alpha"), ("device", "b")], false, 0), [orphan.clone(), other.clone()]);
        assert_eq!(grouped(&store, &[("q", "alpha"), ("device", "a")], false, 0), vec![root.clone()]);
        assert_eq!(grouped(&store, &[("q", "alpha"), ("project", "p"), ("device", "a")], false, 0), vec![root.clone()]);
        assert_eq!(grouped(&store, &[("q", "alpha"), ("device", "c")], false, 0), []);
        assert_eq!(grouped(&store, &[("q", "beta")], false, 0), [group("root", 1, &[("root", 3)])]);
        // Only a child's own match passes a filter it alone passes, and still counts for its root.
        assert_eq!(grouped(&store, &[("q", "grand")], false, 0), [group("root", 1, &[("grand", 2)])]);
        // The word being typed matches as a prefix only with `prefix`.
        assert_eq!(grouped(&store, &[("q", "alph"), ("prefix", "true")], false, 0), [orphan, other, root]);
        assert_eq!(grouped(&store, &[("q", "alph")], false, 0), []);
        assert_eq!(grouped(&store, &[("q", "alph "), ("prefix", "true")], false, 0), []);
        store
            .read(|conn| {
                let entries = |pairs: &[(&str, &str)]| search(conn, &params(pairs)).map(|page| page.items.len());
                assert_eq!(entries(&[("q", "alph"), ("prefix", "true")])?, 8);
                assert_eq!(entries(&[("q", "alph"), ("prefix", "1"), ("sort", "relevance")])?, 8);
                assert_eq!(entries(&[("q", "alph")])?, 0);
                assert!(matches!(entries(&[("q", "alph"), ("prefix", "yes")]), Err(ReadError::BadRequest(_))));
                Ok::<_, ReadError>(())
            })
            .unwrap();
    }

    /// By relevance, a session's best bm25 is divided by `1 + age / 30 days`: a better match in an old session ranks
    /// below a weaker, recent one, and above it when both are recent. Hits go best first.
    #[test]
    fn grouped_relevance_decays_with_age() {
        let dir = tempfile::tempdir().unwrap();
        let store = crate::store::Store::open(dir.path()).unwrap();
        let filler = ["nothing here", "nothing there", "still nothing", "more of nothing"];
        upload(&store, "a", "filler", family("filler", "/x/p", "2026-07-01T00:00:00Z", None, &filler));
        upload(&store, "a", "old", family("old", "/x/p", "2026-08-01T00:00:00Z", None, &["delta delta delta"]));
        let weaker = ["delta and some other words", "delta and some more other words"];
        upload(&store, "a", "new", family("new", "/x/p", "2026-10-20T00:00:00Z", None, &weaker));
        let secs = |iso: &str| crate::util::parse_iso_ms(iso).unwrap() / 1000;
        let old = group("old", 1, &[("old", 1)]);
        let new = |hits: &[(&str, i64)]| group("new", 2, hits);
        let relevance = |now: &str| grouped(&store, &[("q", "delta"), ("sort", "relevance")], false, secs(now));
        assert_eq!(relevance("2026-10-20T00:00:00Z"), [new(&[("new", 1), ("new", 2)]), old.clone()]);
        assert_eq!(relevance("2026-08-01T00:00:00Z"), [old.clone(), new(&[("new", 1), ("new", 2)])]);
        assert_eq!(grouped(&store, &[("q", "delta")], false, secs("2026-08-01T00:00:00Z")), [new(&[("new", 2), ("new", 1)]), old]);
    }

    /// In public, a session folds only into published ancestors, so no unpublished session's title or match is shown;
    /// the owner sees the whole family.
    #[test]
    fn public_grouped_search_folds_only_into_published_sessions() {
        let dir = tempfile::tempdir().unwrap();
        let store = crate::store::Store::open(dir.path()).unwrap();
        upload(&store, "a", "parent", family("parent", "/x/p", "2026-10-20T09:00:00Z", None, &["alpha parent"]));
        upload(&store, "a", "kid", family("kid", "/x/q", "2026-10-20T09:01:00Z", Some("parent"), &["alpha kid"]));
        upload(&store, "a", "pub", family("pub", "/x/q", "2026-10-20T09:02:00Z", None, &["alpha pub"]));
        store.write(|tx| crate::read::publishing::update(tx, "q", true).map(drop)).unwrap();
        let public = grouped(&store, &[("q", "alpha")], true, 0);
        assert_eq!(public, [group("pub", 1, &[("pub", 1)]), group("kid", 1, &[("kid", 2)])]);
        assert_eq!(grouped(&store, &[("q", "parent")], true, 0), []);
        let owner = grouped(&store, &[("q", "alpha")], false, 0);
        assert_eq!(owner, [group("pub", 1, &[("pub", 1)]), group("parent", 2, &[("kid", 2), ("parent", 1)])]);
        store
            .read(|conn| {
                let p = params(&[("q", "alpha"), ("group", "session")]);
                let Results::Sessions(page) = results_scoped(conn, &p, true)? else { panic!("sessions") };
                assert_eq!(page.items.iter().map(|g| g.session_id.as_str()).collect::<Vec<_>>(), ["pub", "kid"]);
                Ok::<_, ReadError>(())
            })
            .unwrap();
    }

    /// A document whose id carries another session's sid bits joins that session's group, but no hit that fails the
    /// exact filters is returned.
    #[test]
    fn grouped_hits_pass_the_exact_filters_whatever_their_sid_bits() {
        let dir = tempfile::tempdir().unwrap();
        let store = crate::store::Store::open(dir.path()).unwrap();
        upload(&store, "a", "s0", family("s0", "/x/p", "2026-10-20T09:00:00Z", None, &["alpha", "alpha beta"]));
        upload(&store, "b", "s1", family("s1", "/x/q", "2026-10-20T09:01:00Z", None, &["alpha", "alpha beta"]));
        store
            .write(|tx| {
                let sid = |id: &str| tx.query_row("SELECT sid FROM sessions WHERE id = ?1", [id], |r| r.get::<_, i64>(0));
                let forged = 1 << 32 | (sid("s1")? & SID_MASK) << SID_SHIFT | 5;
                tx.execute(
                    "INSERT INTO search_docs (id, sid, seq, kind, at, text) VALUES (?1, ?2, 1, 'user', 1000, 'alpha forged')",
                    [forged, sid("s0")?],
                )?;
                tx.execute("INSERT INTO search_fts (rowid, text) VALUES (?1, 'alpha forged')", [forged])?;
                Ok::<_, rusqlite::Error>(())
            })
            .unwrap();
        store
            .read(|conn| {
                for filters in [vec![("device", "b")], vec![("project", "q")], vec![("device", "b"), ("project", "q")]] {
                    for sort in ["newest", "relevance"] {
                        for q in ["alpha", "forged"] {
                            for wide_sids in [false, true] {
                                let mut pairs = filters.clone();
                                pairs.extend([("q", q), ("sort", sort)]);
                                let groups = grouping(conn, &pairs, false, 0, wide_sids)?;
                                let hits: Vec<_> = groups.iter().flat_map(|g| g.2.iter().map(|h| h.0.as_str())).collect();
                                assert_eq!(hits, if q == "alpha" { vec!["s1", "s1"] } else { vec![] }, "{pairs:?} {wide_sids}");
                            }
                        }
                    }
                }
                Ok::<_, ReadError>(())
            })
            .unwrap();
    }

    #[test]
    fn grouped_parameters() {
        let dir = tempfile::tempdir().unwrap();
        let store = crate::store::Store::open(dir.path()).unwrap();
        upload(&store, "a", "s0", family("s0", "/x/p", "2026-10-20T09:00:00Z", None, &["alpha"]));
        store
            .read(|conn| {
                let results = |pairs: &[(&str, &str)]| results_scoped(conn, &params(pairs), false);
                let bad = |pairs: &[(&str, &str)]| matches!(results(pairs), Err(ReadError::BadRequest(_)));
                let cursor = crate::read::encode_cursor(&[json!(5)]);
                assert!(bad(&[("q", "alpha"), ("group", "session"), ("cursor", &cursor)]));
                assert!(bad(&[("q", "alpha"), ("group", "turn")]));
                assert!(bad(&[("q", "alpha"), ("group", "session"), ("sort", "oldest")]));
                assert!(bad(&[("q", "alpha"), ("group", "session"), ("prefix", "maybe")]));
                assert!(matches!(results(&[("q", "alpha"), ("group", "entry")])?, Results::Entries(p) if p.items.len() == 1));
                assert!(matches!(results(&[("q", " "), ("group", "session")])?, Results::Sessions(p) if p.items.is_empty()));
                let Results::Sessions(page) = results(&[("q", "alpha"), ("group", "session")])? else { panic!("sessions") };
                assert_eq!(serde_json::to_value(&page).unwrap()["items"][0]["matches"], 1);
                assert_eq!(page.next_cursor, None);
                Ok::<_, ReadError>(())
            })
            .unwrap();
    }
}
