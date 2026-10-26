//! Checks the loaded dataset's shape against the required one, from the database's own counts.

use std::path::Path;

use anyhow::{Result, bail};
use rusqlite::{Connection, OpenFlags};
use serde_json::{Map, Value, json};

use crate::dataset::{BIG_SESSIONS, BIG_SIZE, Config, DAY_MS, DEVICES, HUGE_SESSIONS, HUGE_SIZE, MODELS, TOOLS};

pub const REQUIRED_ENTRIES: i64 = 2_500_000;
pub const REQUIRED_SESSIONS: i64 = 10_000;

fn int(conn: &Connection, sql: &str) -> Result<i64> {
    Ok(conn.query_row(sql, [], |r| r.get::<_, Option<i64>>(0))?.unwrap_or(0))
}

/// Returns the measured shape; fails listing every requirement the dataset misses.
pub fn run(data_dir: &Path, config: &Config, full: bool) -> Result<Value> {
    let conn = Connection::open_with_flags(data_dir.join("pika.db"), OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let mut shape = Map::new();
    let mut failures = Vec::new();
    let mut check = |name: &str, value: i64, ok: bool, want: String| {
        shape.insert(name.to_owned(), json!(value));
        if !ok {
            failures.push(format!("{name} = {value}, want {want}"));
        }
    };

    let sessions = int(&conn, "SELECT COUNT(*) FROM sessions")?;
    let want_sessions = if full { REQUIRED_SESSIONS } else { config.sessions as i64 };
    check("sessions", sessions, sessions >= want_sessions, format!(">= {want_sessions}"));
    let entries = int(&conn, "SELECT SUM(entry_count) FROM sessions")?;
    let want_entries = if full { REQUIRED_ENTRIES } else { config.entries as i64 * 97 / 100 };
    check("entries", entries, entries >= want_entries, format!(">= {want_entries}"));
    let derived = int(&conn, "SELECT COUNT(*) FROM entries")?;
    check("derivedEntries", derived, derived == entries, format!("{entries}"));
    // The fixed 5,000 and 20,000-entry sessions dominate a scaled-down dataset's average and the few sessions there
    // may not reach the year's ends or every project.
    let average = entries / sessions.max(1);
    check("averageEntries", average, !full || (200..=300).contains(&average), "about 250".into());
    let devices = int(&conn, "SELECT COUNT(DISTINCT device) FROM sessions")?;
    check("devices", devices, devices == DEVICES.len() as i64, format!("{}", DEVICES.len()));
    let projects = int(&conn, "SELECT COUNT(DISTINCT project) FROM sessions")?;
    check("projects", projects, !full || (35..=45).contains(&projects), "about 40".into());
    let models = int(&conn, "SELECT COUNT(DISTINCT model) FROM session_models")?;
    check("models", models, models == MODELS.len() as i64, format!("{}", MODELS.len()));
    let days = int(&conn, "SELECT (MAX(last_at) - MIN(started_at)) FROM sessions")? / DAY_MS;
    check("days", days, !full || (config.days - 5..=config.days + 30).contains(&days), format!("about {}", config.days));
    let big = int(&conn, &format!("SELECT COUNT(*) FROM sessions WHERE entry_count = {BIG_SIZE}"))?;
    check("sessionsOf5000", big, big >= BIG_SESSIONS as i64, format!(">= {BIG_SESSIONS}"));
    let huge = int(&conn, &format!("SELECT COUNT(*) FROM sessions WHERE entry_count = {HUGE_SIZE}"))?;
    check("sessionsOf20000", huge, huge >= HUGE_SESSIONS as i64, format!(">= {HUGE_SESSIONS}"));

    let children = int(&conn, "SELECT COUNT(*) FROM sessions WHERE parent_session_id IS NOT NULL")?;
    let percent = children * 100 / sessions.max(1);
    check("childPercent", percent, (27..=33).contains(&percent), "about 30".into());
    let linked = int(&conn, "SELECT COUNT(*) FROM session_links WHERE source = 'entry'")?;
    check("linkEntries", linked, linked * 100 >= children * 80, ">= 80% of children".into());
    let header_only = int(&conn, "SELECT COUNT(*) FROM session_links WHERE source = 'header'")?;
    check("headerParents", header_only, header_only > 0, "> 0".into());
    let nested = int(
        &conn,
        "SELECT COUNT(*) FROM sessions c JOIN sessions p ON p.id = c.parent_session_id WHERE p.parent_session_id IS NOT NULL
             AND c.herder_run_id IS NULL",
    )?;
    check("nestedChildren", nested, nested > 0, "> 0".into());
    let workflows = int(&conn, "SELECT COUNT(*) FROM session_links WHERE workflow_id IS NOT NULL")?;
    check("workflowChildren", workflows, workflows > 0, "> 0".into());
    let runs = int(&conn, "SELECT COUNT(*) FROM herder_runs")?;
    check("herderRuns", runs, runs >= config.herder_runs as i64, format!(">= {}", config.herder_runs));
    let documents = int(&conn, "SELECT COUNT(*) FROM documents")?;
    check("herderDocuments", documents, documents == runs * 2, format!("{}", runs * 2));
    let steps = int(&conn, "SELECT COUNT(*) FROM sessions WHERE herder_run_id IS NOT NULL")?;
    check("herderStepSessions", steps, steps >= runs * 4, format!(">= {}", runs * 4));
    let request_sessions = int(&conn, "SELECT COUNT(DISTINCT session_id) FROM requests")?;
    let want = config.request_sessions as i64;
    check("requestSessions", request_sessions, request_sessions >= want, format!(">= {want}"));
    let incomplete = int(&conn, "SELECT COUNT(*) FROM requests WHERE NOT complete")?;
    check("incompleteRequests", incomplete, incomplete == 0, "0".into());
    let requests = int(&conn, "SELECT COUNT(*) FROM requests")?;
    check("requests", requests, requests > 0, "> 0".into());
    let linked_calls = int(&conn, "SELECT COUNT(*) FROM model_calls WHERE request_id IS NOT NULL")?;
    check("modelCallsWithRequests", linked_calls, linked_calls == requests, format!("{requests}"));

    for ty in ["message", "model_change", "compaction", "session_info", "custom", "custom_message", "usage", "label"] {
        let n = int(&conn, &format!("SELECT COUNT(*) FROM entries WHERE type = '{ty}'"))?;
        check(&format!("type:{ty}"), n, n > 0, "> 0".into());
    }
    for role in ["user", "assistant", "toolResult"] {
        let n = int(&conn, &format!("SELECT COUNT(*) FROM entries WHERE role = '{role}'"))?;
        check(&format!("role:{role}"), n, n > 0, "> 0".into());
    }
    // Displayed notices arrive during runs, so each turn starts at a user prompt.
    let turns = int(&conn, "SELECT SUM(turn_count) FROM sessions")?;
    let prompts = int(&conn, "SELECT COUNT(*) FROM entries WHERE role = 'user'")?;
    check("turns", turns, turns == prompts, format!("{prompts}"));
    for tool in TOOLS {
        let n = int(&conn, &format!("SELECT COUNT(*) FROM tool_calls WHERE name = '{tool}'"))?;
        check(&format!("tool:{tool}"), n, n > 0, "> 0".into());
    }
    let results = int(&conn, "SELECT COUNT(*) FROM tool_calls WHERE output_size IS NOT NULL")?;
    let median = int(
        &conn,
        &format!("SELECT output_size FROM tool_calls WHERE output_size IS NOT NULL ORDER BY output_size LIMIT 1 OFFSET {}", results / 2),
    )?;
    check("toolResultMedianBytes", median, (700..=1_500).contains(&median), "about 1024".into());
    let large = int(&conn, "SELECT COUNT(*) FROM tool_calls WHERE output_size BETWEEN 40000 AND 70000")?;
    check("toolResultsAround50KiB", large, large >= 10, ">= 10".into());
    let titles = int(&conn, "SELECT COUNT(*) FROM sessions WHERE name IS NOT NULL")?;
    check("namedSessions", titles, titles > 0, "> 0".into());
    let docs = int(&conn, "SELECT MAX(id) IS NOT NULL FROM search_docs")?;
    check("searchIndexed", docs, docs == 1, "1".into());

    let shape = Value::Object(shape);
    if !failures.is_empty() {
        eprintln!("perf: the dataset falls short of the required shape:");
        for failure in &failures {
            eprintln!("  {failure}");
        }
        eprintln!("{shape}");
        bail!("{} shape requirements failed", failures.len());
    }
    Ok(shape)
}
