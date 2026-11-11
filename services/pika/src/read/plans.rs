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

/// Rewrite source resolution reads a single second/sid block through the primary key. Rows elsewhere must not
/// add VM steps to a lookup; a sid/seq predicate without this bound would scan all of them on schema 6.
#[test]
fn rewrite_probes_are_bounded_to_one_id_block() {
    use crate::derive::search::PROBE_BLOCK_SQL;
    use rusqlite::{StatementStatus, params};
    let dir = tempfile::tempdir().unwrap();
    let store = crate::store::Store::open(dir.path()).unwrap();
    store.write(|tx| {
        assert_eq!(plan(tx, PROBE_BLOCK_SQL, None), ["SEARCH search_docs USING INTEGER PRIMARY KEY (rowid>? AND rowid<?)"]);
        let base = (100_i64 << 32) | (7 << 12);
        for i in 0..16 {
            tx.execute("INSERT INTO search_docs (id, sid, seq, kind, at, text) VALUES (?1, 7, 1, 'tool-call', 100000, 'fake')", [base + i])?;
        }
        // Keep a row beyond the upper bound in both runs, so both execute SQLite's range-end check.
        tx.execute("INSERT INTO search_docs (id, sid, seq, kind, at, text) VALUES (?1, 8, 1, 'tool-call', 100000, 'fake')", [base + 4096])?;
        let measure = || -> rusqlite::Result<i32> {
            let mut stmt = tx.prepare(PROBE_BLOCK_SQL)?;
            let rows = stmt.query_map(params![base, base + 4095], |r| r.get::<_, i64>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
            assert_eq!(rows.len(), 16);
            assert_eq!(stmt.get_status(StatementStatus::FullscanStep), 0);
            Ok(stmt.get_status(StatementStatus::VmStep))
        };
        let before = measure()?;
        for i in 0..20_000_i64 {
            // Both unrelated sessions within this second and unrelated seconds with the same session bits.
            for id in [(100 << 32) | ((i + 100) << 12), ((i + 200) << 32) | (7 << 12)] {
                tx.execute("INSERT INTO search_docs (id, sid, seq, kind, at, text) VALUES (?1, 7, 1, 'tool-call', 100000, 'fake')", [id])?;
            }
        }
        assert_eq!(measure()?, before, "unrelated rows must not enlarge a source lookup");
        Ok::<_, rusqlite::Error>(())
    }).unwrap();
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

/// Every device/project combination walks its own index, with and without `root`, a `model` filter, and a time range;
/// `root` looks each session's parent up by id and `model` looks each session up by the `session_models` primary
/// key. No sort, and no scan beyond the index walk.
#[test]
fn session_lists_walk_the_index_of_their_filters() {
    with_conn(|conn| {
        let cursor = encode_cursor(&[json!(5), json!("x")]);
        for (device, project, index) in [
            (false, false, "sessions_last"),
            (true, false, "sessions_device"),
            (false, true, "sessions_project"),
            (true, true, "sessions_device_project"),
        ] {
            for (root, model) in [(false, false), (false, true), (true, false), (true, true)] {
                for (range, bound) in [
                    (vec![], None),
                    (vec![("from", "2026-01-01")], Some("last_at>?")),
                    (vec![("to", "2026-01-01"), ("cursor", cursor.as_str())], Some("last_at<?")),
                ] {
                    let mut pairs = Vec::new();
                    let mut columns = Vec::new();
                    if root {
                        pairs.push(("root", "true"));
                    }
                    if device {
                        pairs.push(("device", "d"));
                        columns.push("device=?");
                    }
                    if project {
                        pairs.push(("project", "p"));
                        columns.push("project=?");
                    }
                    if model {
                        pairs.push(("model", "m"));
                    }
                    pairs.extend(range);
                    columns.extend(bound);
                    let mut want = vec![if columns.is_empty() {
                        format!("SCAN s USING INDEX {index}")
                    } else {
                        format!("SEARCH s USING INDEX {index} ({})", columns.join(" AND "))
                    }];
                    if root {
                        want.push("CORRELATED SCALAR SUBQUERY 1".into());
                        want.push("SEARCH parent USING COVERING INDEX sqlite_autoindex_sessions_1 (id=?)".into());
                    }
                    if model {
                        want.push("SEARCH m EXISTS USING PRIMARY KEY (model=? AND sid=?)".into());
                    }
                    let (sql, args) = super::sessions::list_query(&params(&pairs), 50).unwrap();
                    let plan = plan(conn, &sql, Some(args));
                    assert_eq!(plan, want, "{pairs:?}");
                    assert!(!plan.iter().any(|p| p.contains("TEMP B-TREE")), "{pairs:?}: {plan:?}");
                    assert!(!plan[1..].iter().any(|p| p.starts_with("SCAN")), "{pairs:?}: {plan:?}");
                }
            }
        }
    });
}

#[test]
fn the_first_page_of_a_session_reads_primary_keys() {
    with_conn(|conn| {
        assert_eq!(
            plan(conn, &super::sessions::turns_sql(), None),
            ["SEARCH t USING PRIMARY KEY (sid=? AND idx>?)", "SEARCH e USING PRIMARY KEY (sid=? AND seq=?) LEFT-JOIN"]
        );
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
        let statement = super::search::statement(&p, false, false).unwrap().unwrap();
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

/// Public search builds the published sessions' sid bits once from the project index and checks each hit's session
/// against publication and the hidden sessions' primary key; it still reads the index newest first, with no sort.
#[test]
fn public_search_checks_publication_without_sorting() {
    with_conn(|conn| {
        let statement = super::search::statement(&params(&[("q", "x")]), false, true).unwrap().unwrap();
        assert_eq!(
            plan(conn, &statement.sql, Some(statement.args)),
            [
                "SCAN search_fts VIRTUAL TABLE INDEX 192:M1",
                "LIST SUBQUERY 4",
                "SEARCH s USING COVERING INDEX sessions_project (project=?)",
                "LIST SUBQUERY 2",
                "SCAN json_each VIRTUAL TABLE INDEX 1:",
                "SCALAR SUBQUERY 1",
                "SEARCH settings USING PRIMARY KEY (key=?)",
                // Hidden sessions (`crate::hidden`): one primary-key probe of the small table per session.
                "USING ROWID SEARCH ON TABLE session_hidden FOR IN-OPERATOR",
                "CREATE BLOOM FILTER",
                "SEARCH d USING INTEGER PRIMARY KEY (rowid=?)",
                "SEARCH s USING INTEGER PRIMARY KEY (rowid=?)",
                "LIST SUBQUERY 6",
                "SCAN json_each VIRTUAL TABLE INDEX 1:",
                "SCALAR SUBQUERY 5",
                "SEARCH settings USING PRIMARY KEY (key=?)",
                "CREATE BLOOM FILTER",
                "USING ROWID SEARCH ON TABLE session_hidden FOR IN-OPERATOR",
                "SEARCH e USING PRIMARY KEY (sid=? AND seq=?) LEFT-JOIN",
            ]
        );
    });
}

/// Relevance scores the newest filtered matches in one pass without joins and selects the best ids; only those are
/// looked up.
#[test]
fn relevance_search_scores_the_window_without_joins() {
    with_conn(|conn| {
        let p = params(&[("q", "x"), ("project", "p"), ("sort", "relevance")]);
        let statement = super::search::statement(&p, false, false).unwrap().unwrap();
        assert_eq!(
            plan(conn, &statement.sql, Some(statement.args)),
            [
                "CO-ROUTINE ranked",
                "SCAN search_fts VIRTUAL TABLE INDEX 192:M1",
                "LIST SUBQUERY 1",
                "SEARCH s USING COVERING INDEX sessions_project (project=?)",
                "CREATE BLOOM FILTER",
                "SCAN ranked",
                "USE TEMP B-TREE FOR ORDER BY",
            ]
        );
    });
}

/// A hit is looked up by its rowid; a prefix query's hits by their range, evaluating the query once, with each match in
/// the range tested against the ids before it is joined.
#[test]
fn hits_are_looked_up_by_rowid_or_by_their_range() {
    use super::search::Lookup;
    with_conn(|conn| {
        let p = params(&[("q", "x"), ("project", "p")]);
        let one = Lookup::new("\"x\"", &p, false);
        let args = vec![Sql::Text("\"x\"".into()), Sql::Integer(5), Sql::Text("p".into())];
        assert_eq!(
            plan(conn, &one.sql(), Some(args)),
            [
                "SCAN search_fts VIRTUAL TABLE INDEX 0:=M1",
                "SEARCH d USING INTEGER PRIMARY KEY (rowid=?)",
                "SEARCH s USING INTEGER PRIMARY KEY (rowid=?)",
                "SEARCH e USING PRIMARY KEY (sid=? AND seq=?) LEFT-JOIN",
            ]
        );
        let range = Lookup::new("\"x\"*", &p, false);
        let args = vec![Sql::Text("\"x\"*".into()), Sql::Integer(5), Sql::Integer(9), Sql::Text("[5,9]".into()), Sql::Text("p".into())];
        assert_eq!(
            plan(conn, &range.sql(), Some(args)),
            [
                "SCAN search_fts VIRTUAL TABLE INDEX 0:M1><",
                "LIST SUBQUERY 1",
                "SCAN json_each VIRTUAL TABLE INDEX 1:",
                "CREATE BLOOM FILTER",
                "SEARCH d USING INTEGER PRIMARY KEY (rowid=?)",
                "SEARCH s USING INTEGER PRIMARY KEY (rowid=?)",
                "SEARCH e USING PRIMARY KEY (sid=? AND seq=?) LEFT-JOIN",
            ]
        );
    });
}

/// Grouped search reads the window newest first from the index alone, testing the sid bits against the filtered
/// sessions with no join and no sort; it walks each session's parents by primary key and the id index.
#[test]
fn grouped_search_reads_the_window_without_joins() {
    use super::search::{Grouped, parent_sql};
    with_conn(|conn| {
        for sort in ["newest", "relevance"] {
            let p = params(&[("q", "x"), ("device", "d"), ("project", "p"), ("sort", sort), ("prefix", "true")]);
            let (sql, args) = Grouped::new(&p).unwrap().unwrap().window(&p, false, false);
            assert_eq!(
                plan(conn, &sql, Some(args)),
                [
                    "SCAN search_fts VIRTUAL TABLE INDEX 192:M1",
                    "LIST SUBQUERY 1",
                    "SEARCH s USING COVERING INDEX sessions_device_project (device=? AND project=?)",
                    "CREATE BLOOM FILTER",
                ],
                "{sort}"
            );
        }
        assert_eq!(
            plan(conn, &parent_sql(false), None),
            ["SEARCH c USING INTEGER PRIMARY KEY (rowid=?)", "SEARCH s USING COVERING INDEX sqlite_autoindex_sessions_1 (id=?)"]
        );
        assert_eq!(
            plan(conn, &parent_sql(true), None),
            [
                "SEARCH c USING INTEGER PRIMARY KEY (rowid=?)",
                "SEARCH s USING INDEX sqlite_autoindex_sessions_1 (id=?)",
                "USING ROWID SEARCH ON TABLE session_hidden FOR IN-OPERATOR",
                "LIST SUBQUERY 2",
                "SCAN json_each VIRTUAL TABLE INDEX 1:",
                "SCALAR SUBQUERY 1",
                "SEARCH settings USING PRIMARY KEY (key=?)",
                "CREATE BLOOM FILTER",
            ]
        );
    });
}

/// The trace reads every table of one session by primary key or by its own index, each line by its position, and each
/// linked request by its id. Its compactions walk the session's entries without a type index, which reads only the
/// small derived rows. Its fingerprint counts the session's requests from a covering index and its children from the
/// parent index.
#[test]
fn the_trace_reads_primary_keys() {
    use super::trace::*;
    with_conn(|conn| {
        assert_eq!(plan(conn, SESSION_SQL, None), ["SEARCH sessions USING INDEX sqlite_autoindex_sessions_1 (id=?)"]);
        assert_eq!(
            plan(conn, TURNS_SQL, None),
            ["SEARCH t USING PRIMARY KEY (sid=?)", "SEARCH e USING PRIMARY KEY (sid=? AND seq=?) LEFT-JOIN"]
        );
        assert_eq!(
            plan(conn, MODEL_CALLS_SQL, None),
            [
                "SEARCH m USING PRIMARY KEY (sid=?)",
                "SEARCH e USING PRIMARY KEY (sid=? AND seq=?) LEFT-JOIN",
                "SEARCH l USING INDEX lines_position (stream_id=? AND offset=?) LEFT-JOIN",
                "SEARCH r USING INDEX sqlite_autoindex_requests_1 (id=?) LEFT-JOIN",
            ]
        );
        assert_eq!(plan(conn, TOOL_CALLS_SQL, None), ["SEARCH tool_calls USING PRIMARY KEY (sid=?)"]);
        // Public and agent traces, entry pages, and raw lines find calls that are memory through their results.
        assert_eq!(
            plan(conn, crate::derive::MEMORY_CALLS_SQL, None),
            [
                "SEARCH t USING INDEX tool_calls_seq (sid=? AND call_seq>? AND call_seq<?)",
                "SEARCH e USING PRIMARY KEY (sid=? AND seq=?)",
            ]
        );
        assert_eq!(
            plan(conn, SUMMARIES_SQL, None),
            [
                "SEARCH e USING PRIMARY KEY (sid=?)",
                "SEARCH l USING INDEX lines_position (stream_id=? AND offset=?) LEFT-JOIN",
            ]
        );
        assert_eq!(
            plan(conn, CHILDREN_SQL, None),
            [
                "SEARCH s USING INDEX sessions_parent (parent_session_id=?)",
                "SEARCH l USING INTEGER PRIMARY KEY (rowid=?) LEFT-JOIN",
                "USE TEMP B-TREE FOR ORDER BY",
            ]
        );
        assert_eq!(
            plan(conn, FINGERPRINT_SQL, None),
            [
                "CO-ROUTINE c",
                "SEARCH sessions USING INDEX sessions_parent (parent_session_id=?)",
                "SEARCH s USING INDEX sqlite_autoindex_sessions_1 (id=?)",
                "SCAN c",
                "CORRELATED SCALAR SUBQUERY 1",
                "SEARCH r USING COVERING INDEX requests_assistant (session_id=?)",
                "SCALAR SUBQUERY 2",
                "SEARCH settings USING PRIMARY KEY (key=?)",
            ]
        );
    });
}

#[test]
fn extension_usage_reads_its_window_through_indexes() {
    use super::extension_usage::{COMMANDS_SQL, TOOLS_SQL};
    with_conn(|conn| {
        let plan = |sql| plan(conn, sql, None).join("\n");
        let tools = plan(TOOLS_SQL);
        assert!(tools.contains("USING INDEX tool_calls_started (started_at>?)"), "{tools}");
        let commands = plan(COMMANDS_SQL);
        assert!(commands.contains("SEARCH e USING INDEX entries_custom_type (custom_type=? AND ts>?)"), "{commands}");
        assert!(commands.contains("SEARCH l USING INDEX lines_position (stream_id=? AND offset=?)"), "{commands}");
    });
}
