use rusqlite::types::Value as Sql;
use rusqlite::{Connection, params_from_iter};
use serde::Serialize;
use serde_json::json;

use super::{Page, Params, ReadResult, bad, cursor_int, iso, page};
use crate::derive::search::{MARK_END, MARK_START, SID_MASK, SID_SHIFT};
use crate::util::escape_html;

pub const SEARCH_LIMIT: i64 = 50;
pub const MAX_SEARCH_LIMIT: i64 = 200;
pub const MAX_RELEVANCE_LIMIT: i64 = 100;
const SNIPPET_TOKENS: i64 = 24;
/// `sort=relevance` ranks this many of the newest filtered matches: scoring every match of a common term takes too
/// long.
pub const RELEVANCE_WINDOW: i64 = 20_000;

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
pub fn fts_query(q: &str) -> Option<String> {
    let q: String = q.chars().map(|c| if c.is_control() { ' ' } else { c }).collect();
    let mut phrases = Vec::new();
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
            phrases.push(format!("\"{}\"", phrase.replace('"', "\"\"")));
        }
        rest = after;
    }
    (!phrases.is_empty()).then(|| phrases.join(" "))
}

fn render_snippet(raw: &str) -> String {
    escape_html(raw).replace(MARK_START, "<mark>").replace(MARK_END, "</mark>")
}

pub(crate) struct Statement {
    pub sql: String,
    pub args: Vec<Sql>,
    limit: i64,
    relevance: bool,
}

/// The `device` and `project` filters as conditions on `sessions s`, with their arguments.
fn session_filters(p: &Params) -> (String, Vec<Sql>) {
    let mut filters = String::new();
    let mut args = Vec::new();
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
/// that pass them are joined for the exact check.
pub(crate) fn statement(p: &Params, wide_sids: bool) -> ReadResult<Option<Statement>> {
    let relevance = match p.get("sort") {
        None | Some("newest") => false,
        Some("relevance") => true,
        Some(_) => return Err(bad("sort must be newest or relevance")),
    };
    let limit = if relevance { p.limit(SEARCH_LIMIT, MAX_RELEVANCE_LIMIT)? } else { p.limit(SEARCH_LIMIT, MAX_SEARCH_LIMIT)? };
    let cursor = p.cursor()?;
    if relevance && cursor.is_some() {
        return Err(bad("sort=relevance returns one page"));
    }
    let Some(query) = p.get("q").and_then(fts_query) else { return Ok(None) };
    let (filters, filter_args) = session_filters(p);
    let mut prefilter = String::new();
    if !filters.is_empty() {
        prefilter = format!(
            " AND ((search_fts.rowid >> {SID_SHIFT}) & {SID_MASK}) IN (SELECT s.sid & {SID_MASK} FROM sessions s WHERE 1{filters})"
        );
    }
    let hit_columns = format!(
        "search_fts.rowid, snippet(search_fts, 0, char({}), char({}), '…', {SNIPPET_TOKENS}),
         d.seq, d.kind, d.at, s.id, s.title, e.entry_id",
        MARK_START as u32, MARK_END as u32
    );
    let mut args = Vec::new();
    let sql = if relevance {
        // One pass over the newest filtered matches scores them; only the best are joined and get snippets. The
        // CROSS JOIN keeps `best` the outer loop: otherwise SQLite may walk every match of the query instead.
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
            args.extend(filter_args);
        }
        args.push(Sql::Integer(RELEVANCE_WINDOW));
        args.push(Sql::Integer(limit));
        args.push(Sql::Text(query));
        format!(
            "WITH ranked AS (
                 SELECT search_fts.rowid AS id, bm25(search_fts) AS rank FROM search_fts{exact}
                 WHERE search_fts MATCH ?{prefilter}{exact_filters}
                 ORDER BY search_fts.rowid DESC LIMIT ?
             ),
             best AS (SELECT id, rank FROM ranked ORDER BY rank, id DESC LIMIT ?)
             SELECT {hit_columns}
             FROM best
             CROSS JOIN search_fts ON search_fts.rowid = best.id
             JOIN search_docs d ON d.id = best.id
             JOIN sessions s ON s.sid = d.sid
             LEFT JOIN entries e ON e.sid = d.sid AND e.seq = d.seq
             WHERE search_fts MATCH ?
             ORDER BY best.rank, best.id DESC"
        )
    } else {
        args.push(Sql::Text(query));
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
    Ok(Some(Statement { sql, args, limit, relevance }))
}

/// Whether any session passes the `device` and `project` filters (a search with none finds nothing), and whether a
/// sid reaches past the sid bits of document ids.
fn sessions_for_filters(conn: &Connection, p: &Params) -> ReadResult<(bool, bool)> {
    let (filters, args) = session_filters(p);
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
    let (any, wide_sids) = sessions_for_filters(conn, p)?;
    match statement(p, wide_sids)? {
        Some(statement) if any => run(conn, statement),
        _ => Ok(Page { items: Vec::new(), next_cursor: None }),
    }
}

fn run(conn: &Connection, Statement { sql, args, limit, relevance }: Statement) -> ReadResult<Page<Hit>> {
    let mut stmt = conn.prepare_cached(&sql)?;
    let rows = stmt.query_map(params_from_iter(args), |r| {
        Ok(Hit {
            rowid: r.get(0)?,
            snippet: render_snippet(&r.get::<_, String>(1)?),
            seq: r.get(2)?,
            kind: r.get(3)?,
            at: iso(r.get(4)?),
            session_id: r.get(5)?,
            session_title: r.get::<_, Option<String>>(6)?.unwrap_or_default(),
            entry_id: r.get(7)?,
        })
    });
    let items = match rows.and_then(|rows| rows.collect::<rusqlite::Result<Vec<_>>>()) {
        Ok(items) => items,
        // Quoting leaves no syntax to get wrong, but a query FTS5 still rejects finds nothing rather than failing.
        Err(rusqlite::Error::SqliteFailure(_, Some(message))) if message.starts_with("fts5:") => Vec::new(),
        Err(e) => return Err(e.into()),
    };
    Ok(if relevance {
        Page { items, next_cursor: None }
    } else {
        page(items, limit, |h| vec![json!(h.rowid)])
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::read::ReadError;

    #[test]
    fn queries_are_quoted() {
        assert_eq!(fts_query("  "), None);
        assert_eq!(fts_query("flaky test").as_deref(), Some(r#""flaky" "test""#));
        assert_eq!(fts_query(r#"say "hello world" NOT x*"#).as_deref(), Some(r#""say" "hello world" "NOT" "x*""#));
        assert_eq!(fts_query(r#"open "quote"#).as_deref(), Some(r#""open" "quote""#));
        assert_eq!(fts_query(r#"a"b"#).as_deref(), Some(r#""a" "b""#));
        assert_eq!(fts_query(r#""""#), None);
        assert_eq!(fts_query("🌀 NEAR(a b)").as_deref(), Some(r#""🌀" "NEAR(a" "b)""#));
        assert_eq!(fts_query("\"a\u{0}b").as_deref(), Some(r#""a b""#));
        assert_eq!(fts_query("\u{0}\u{2}"), None);
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
                            let hits = run(conn, statement(&p, wide_sids)?.unwrap())?.items;
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

    /// Newest-first search reads the index in rowid order and stops at the limit: no sort.
    #[test]
    fn newest_first_needs_no_sort() {
        let dir = tempfile::tempdir().unwrap();
        let store = crate::store::Store::open(dir.path()).unwrap();
        let mut p = Params::default();
        for (key, value) in [("q", "x"), ("device", "d"), ("project", "p"), ("cursor", &crate::read::encode_cursor(&[json!(5)]))] {
            p.0.insert(key.into(), value.into());
        }
        let Statement { sql, args, .. } = statement(&p, false).unwrap().unwrap();
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
}
