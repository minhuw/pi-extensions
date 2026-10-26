//! Query plans of the read API's hot queries: each must keep using its intended index, so a regression fails
//! `cargo test` and not only `scripts/perf.sh`. SQLite plans these without statistics, as the server does.

use rusqlite::types::Value as Sql;
use rusqlite::{Connection, params_from_iter};
use serde_json::json;

use super::{Params, encode_cursor};

fn plan(conn: &Connection, sql: &str, args: Option<Vec<Sql>>) -> Vec<String> {
    let mut stmt = conn.prepare(&format!("EXPLAIN QUERY PLAN {sql}")).unwrap();
    let args = args.unwrap_or_else(|| vec![Sql::Null; stmt.parameter_count()]);
    stmt.query_map(params_from_iter(args), |r| r.get::<_, String>(3)).unwrap().collect::<rusqlite::Result<_>>().unwrap()
}

fn with_conn(f: impl FnOnce(&Connection)) {
    let dir = tempfile::tempdir().unwrap();
    let store = crate::store::Store::open(dir.path()).unwrap();
    store
        .read(|conn| {
            f(conn);
            Ok::<_, rusqlite::Error>(())
        })
        .unwrap();
}

fn params(pairs: &[(&str, &str)]) -> Params {
    Params(pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect())
}

#[test]
fn session_lookups_use_the_id_index() {
    with_conn(|conn| {
        assert_eq!(plan(conn, super::SESSION_SID_SQL, None), ["SEARCH sessions USING COVERING INDEX sqlite_autoindex_sessions_1 (id=?)"]);
        assert_eq!(plan(conn, &super::sessions::detail_sql(), None), ["SEARCH s USING INDEX sqlite_autoindex_sessions_1 (id=?)"]);
        assert_eq!(
            plan(conn, &super::sessions::children_sql(), None),
            [
                "SEARCH s USING INDEX sessions_parent (parent_session_id=?)",
                "SEARCH l USING INTEGER PRIMARY KEY (rowid=?) LEFT-JOIN",
                "USE TEMP B-TREE FOR ORDER BY",
            ]
        );
    });
}

#[test]
fn session_lists_walk_the_index_of_their_filters() {
    with_conn(|conn| {
        let cursor = encode_cursor(&[json!(5), json!("x")]);
        for (pairs, index) in [
            (vec![], "sessions_last"),
            (vec![("root", "true")], "sessions_root"),
            (vec![("device", "d"), ("model", "m"), ("from", "2026-01-01")], "sessions_device"),
            (vec![("project", "p"), ("cursor", cursor.as_str())], "sessions_project"),
            (vec![("root", "true"), ("device", "d"), ("project", "p"), ("to", "2026-01-01")], "sessions_root_device_project"),
        ] {
            let (sql, args) = super::sessions::list_query(&params(&pairs), 50).unwrap();
            let plan = plan(conn, &sql, Some(args));
            assert!(plan[0].starts_with(&format!("SEARCH s USING INDEX {index} (")) || plan[0] == format!("SCAN s USING INDEX {index}"), "{pairs:?}: {plan:?}");
            assert!(!plan.iter().any(|p| p.contains("TEMP B-TREE")), "{pairs:?}: {plan:?}");
        }
    });
}

#[test]
fn the_first_page_of_a_session_reads_primary_keys() {
    with_conn(|conn| {
        assert_eq!(plan(conn, &super::sessions::turns_sql(), None), ["SEARCH turns USING PRIMARY KEY (sid=? AND idx>?)"]);
        assert_eq!(
            plan(conn, super::entries::LIST_SQL, None),
            [
                "SEARCH e USING PRIMARY KEY (sid=? AND seq>? AND seq<?)",
                "SEARCH l USING INDEX lines_position (stream_id=? AND offset=?)",
                "SEARCH m USING PRIMARY KEY (sid=? AND seq=?) LEFT-JOIN",
            ]
        );
    });
}

/// Filtered matches pass the sid-bit set before any join, and newest-first reads the index in descending rowid order
/// (index flag 192): no sort.
#[test]
fn newest_first_search_filters_before_joining() {
    with_conn(|conn| {
        let cursor = encode_cursor(&[json!(5)]);
        let p = params(&[("q", "x"), ("device", "d"), ("project", "p"), ("cursor", &cursor)]);
        let statement = super::search::statement(&p, false).unwrap().unwrap();
        let plan = plan(conn, &statement.sql, Some(statement.args));
        assert_eq!(
            plan,
            [
                "SCAN search_fts VIRTUAL TABLE INDEX 192:M1<",
                "LIST SUBQUERY 1",
                "SEARCH s USING COVERING INDEX sessions_device_project (device=? AND project=?)",
                "CREATE BLOOM FILTER",
                "SEARCH d USING INTEGER PRIMARY KEY (rowid=?)",
                "SEARCH s USING INTEGER PRIMARY KEY (rowid=?)",
                "SEARCH e USING PRIMARY KEY (sid=? AND seq=?) LEFT-JOIN",
            ]
        );
    });
}

/// Relevance scores the newest filtered matches in one pass without joins, then joins only the best ones, looking
/// each up by rowid.
#[test]
fn relevance_search_joins_only_the_best() {
    with_conn(|conn| {
        let p = params(&[("q", "x"), ("project", "p"), ("sort", "relevance")]);
        let statement = super::search::statement(&p, false).unwrap().unwrap();
        let plan = plan(conn, &statement.sql, Some(statement.args));
        assert_eq!(
            plan,
            [
                "CO-ROUTINE best",
                "CO-ROUTINE ranked",
                "SCAN search_fts VIRTUAL TABLE INDEX 192:M1",
                "LIST SUBQUERY 1",
                "SEARCH s USING COVERING INDEX sessions_project (project=?)",
                "CREATE BLOOM FILTER",
                "SCAN ranked",
                "USE TEMP B-TREE FOR ORDER BY",
                "SCAN best",
                "SCAN search_fts VIRTUAL TABLE INDEX 0:=M1",
                "SEARCH d USING INTEGER PRIMARY KEY (rowid=?)",
                "SEARCH s USING INTEGER PRIMARY KEY (rowid=?)",
                "SEARCH e USING PRIMARY KEY (sid=? AND seq=?) LEFT-JOIN",
            ]
        );
    });
}
