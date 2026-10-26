use rusqlite::types::Value as Sql;
use rusqlite::{Connection, params_from_iter};
use serde::Serialize;
use serde_json::json;

use super::{Page, Params, ReadResult, bad, cursor_int, iso, page};
use crate::derive::search::{MARK_END, MARK_START};
use crate::util::escape_html;

pub const SEARCH_LIMIT: i64 = 50;
pub const MAX_SEARCH_LIMIT: i64 = 200;
const SNIPPET_TOKENS: i64 = 24;
/// `sort=relevance` ranks this many of the newest matches: scoring every match of a common term takes too long.
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
    #[serde(skip)]
    score: f64,
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

struct Statement {
    sql: String,
    args: Vec<Sql>,
    limit: i64,
    relevance: bool,
}

/// The search statement, or `None` when the query has no terms.
fn statement(p: &Params) -> ReadResult<Option<Statement>> {
    let limit = p.limit(SEARCH_LIMIT, MAX_SEARCH_LIMIT)?;
    let relevance = match p.get("sort") {
        None | Some("newest") => false,
        Some("relevance") => true,
        Some(_) => return Err(bad("sort must be newest or relevance")),
    };
    let cursor = p.cursor()?;
    let Some(query) = p.get("q").and_then(fts_query) else { return Ok(None) };
    let mut sql = format!(
        "SELECT search_fts.rowid, bm25(search_fts), snippet(search_fts, 0, char({}), char({}), '…', {SNIPPET_TOKENS}),
                d.seq, d.kind, d.at, s.id, s.title, e.entry_id
         FROM search_fts
         JOIN search_docs d ON d.id = search_fts.rowid
         JOIN sessions s ON s.sid = d.sid
         LEFT JOIN entries e ON e.sid = d.sid AND e.seq = d.seq
         WHERE search_fts MATCH ?",
        MARK_START as u32, MARK_END as u32
    );
    let mut args = vec![Sql::Text(query.clone())];
    if let Some(device) = p.get("device") {
        sql.push_str(" AND s.device = ?");
        args.push(Sql::Text(device.to_owned()));
    }
    if let Some(project) = p.get("project") {
        sql.push_str(" AND s.project = ?");
        args.push(Sql::Text(project.to_owned()));
    }
    if relevance {
        sql.push_str(
            " AND search_fts.rowid >= (SELECT MIN(rowid) FROM
                 (SELECT rowid FROM search_fts WHERE search_fts MATCH ? ORDER BY rowid DESC LIMIT ?))",
        );
        args.extend([Sql::Text(query), Sql::Integer(RELEVANCE_WINDOW)]);
        if let Some(key) = &cursor {
            let score = key.first().and_then(|v| v.as_f64()).ok_or_else(|| bad("invalid cursor"))?;
            sql.push_str(" AND (bm25(search_fts) > ? OR (bm25(search_fts) = ? AND search_fts.rowid < ?))");
            args.extend([Sql::Real(score), Sql::Real(score), Sql::Integer(cursor_int(key, 1)?)]);
        }
        sql.push_str(" ORDER BY bm25(search_fts), search_fts.rowid DESC LIMIT ?");
    } else {
        if let Some(key) = &cursor {
            sql.push_str(" AND search_fts.rowid < ?");
            args.push(Sql::Integer(cursor_int(key, 0)?));
        }
        sql.push_str(" ORDER BY search_fts.rowid DESC LIMIT ?");
    }
    args.push(Sql::Integer(limit + 1));
    Ok(Some(Statement { sql, args, limit, relevance }))
}

/// Full-text search over session entries. `sort=newest` (the default) walks the index from the newest document and
/// stops at `limit`; `sort=relevance` orders the newest `RELEVANCE_WINDOW` matches by bm25.
pub fn search(conn: &Connection, p: &Params) -> ReadResult<Page<Hit>> {
    let Some(Statement { sql, args, limit, relevance }) = statement(p)? else {
        return Ok(Page { items: Vec::new(), next_cursor: None });
    };
    let mut stmt = conn.prepare_cached(&sql)?;
    let rows = stmt.query_map(params_from_iter(args), |r| {
        Ok(Hit {
            rowid: r.get(0)?,
            score: r.get(1)?,
            snippet: render_snippet(&r.get::<_, String>(2)?),
            seq: r.get(3)?,
            kind: r.get(4)?,
            at: iso(r.get(5)?),
            session_id: r.get(6)?,
            session_title: r.get::<_, Option<String>>(7)?.unwrap_or_default(),
            entry_id: r.get(8)?,
        })
    });
    let items = match rows.and_then(|rows| rows.collect::<rusqlite::Result<Vec<_>>>()) {
        Ok(items) => items,
        // Quoting leaves no syntax to get wrong, but a query FTS5 still rejects finds nothing rather than failing.
        Err(rusqlite::Error::SqliteFailure(_, Some(message))) if message.starts_with("fts5:") => Vec::new(),
        Err(e) => return Err(e.into()),
    };
    Ok(if relevance {
        page(items, limit, |h| vec![json!(h.score), json!(h.rowid)])
    } else {
        page(items, limit, |h| vec![json!(h.rowid)])
    })
}

#[cfg(test)]
mod tests {
    use super::*;

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

    /// Newest-first search reads the index in rowid order and stops at the limit: no sort.
    #[test]
    fn newest_first_needs_no_sort() {
        let dir = tempfile::tempdir().unwrap();
        let store = crate::store::Store::open(dir.path()).unwrap();
        let mut p = Params::default();
        for (key, value) in [("q", "x"), ("device", "d"), ("project", "p"), ("cursor", &crate::read::encode_cursor(&[json!(5)]))] {
            p.0.insert(key.into(), value.into());
        }
        let Statement { sql, args, .. } = statement(&p).unwrap().unwrap();
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
