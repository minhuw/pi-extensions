//! Aggregate usage, including unpublished and hidden sessions by default. Public project names follow publication.
//! Reads use derived, time-indexed rows only; no trajectory content is loaded or serialized.
use rusqlite::{Connection, params};
use serde::Serialize;

use super::{Params, ReadResult, bad, publishing};
use crate::util::{format_iso_ms, now_ms};

mod breakdown;
pub mod usage;
pub use breakdown::{Breakdown, RequestMetrics};

const DAY_MS: i64 = 86_400_000;
// The response dates have four-digit years. Ignore timestamps outside that representable range.
const FIRST_MS: i64 = -62_167_219_200_000; // 0000-01-01 UTC

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Tokens {
    pub input: i64,
    pub output: i64,
    pub cache_read: i64,
    pub cache_write: i64,
}

#[derive(Default, Serialize)]
pub struct Counts {
    pub sessions: i64,
    pub requests: i64,
    pub tokens: Tokens,
    pub cost: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Totals {
    #[serde(flatten)]
    pub counts: Counts,
    pub active_days: i64,
    /// The part of `cost` that pika estimated for model calls that recorded none (`crate::pricing`).
    pub estimated_cost: f64,
    /// Model calls that used tokens without a recorded cost or a known price; they add nothing to `cost`.
    pub unpriced_requests: i64,
}

#[derive(Serialize)]
pub struct Day {
    pub date: String,
    #[serde(flatten)]
    pub counts: Counts,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Statistics {
    pub from: String,
    pub to: String,
    pub exclude_unpublished: bool,
    pub totals: Totals,
    pub daily: Vec<Day>,
    pub projects: Vec<Breakdown>,
    pub models: Vec<Breakdown>,
    pub request_metrics: RequestMetrics,
}

fn date(ms: i64) -> String {
    format_iso_ms(ms)[..10].to_owned()
}

/// The UTC day of the oldest dated usage or entry in scope before `end`, or `today` when there is none.
fn oldest_day(conn: &Connection, filter: &str, end: i64, today: i64) -> ReadResult<i64> {
    let oldest: Option<i64> = conn.query_row(
        &format!(
            "SELECT MIN(at) FROM (
            SELECT MIN(u.at) AS at FROM usage_events u JOIN sessions s ON s.sid = u.sid
            WHERE u.at >= ?1 AND u.at < ?2 AND {filter}
            UNION ALL
            SELECT MIN(e.ts) AS at FROM entries e JOIN sessions s ON s.sid = e.sid
            WHERE e.ts >= ?1 AND e.ts < ?2 AND {filter}
        )"
        ),
        params![FIRST_MS, end],
        |r| r.get(0),
    )?;
    Ok(oldest.map(|at| at.div_euclid(DAY_MS) * DAY_MS).unwrap_or(today))
}

pub fn statistics(conn: &Connection, params: &Params) -> ReadResult<Statistics> {
    at_time(conn, params, now_ms())
}

pub fn statistics_scoped(conn: &Connection, params: &Params, public: bool) -> ReadResult<Statistics> {
    at_time_scoped(conn, params, now_ms(), public)
}

/// One snapshot covers the date range, publishing selection, hidden ancestors, and every aggregate.
fn at_time(conn: &Connection, p: &Params, now: i64) -> ReadResult<Statistics> {
    at_time_scoped(conn, p, now, false)
}

pub(super) fn statistics_sql(filter: &str, public: bool) -> String {
    format!(
        "{ctes}
         SELECT 0 AS tag, day AS k, NULL AS name, 0 AS sessions,
                SUM(requests), SUM(input), SUM(output), SUM(cache_read), SUM(cache_write),
                SUM(cost), SUM(estimated_cost), SUM(unpriced_requests),
                0, 0, 0, 0, 0.0, 0, 0.0, 0.0, 0
         FROM u_agg
         GROUP BY day
         UNION ALL
         SELECT 1 AS tag, day AS k, NULL AS name, COUNT(*) AS sessions,
                0, 0, 0, 0, 0, 0.0, 0.0, 0,
                0, 0, 0, 0, 0.0, 0, 0.0, 0.0, 0
         FROM activity
         GROUP BY day
         UNION ALL
         SELECT 1 AS tag, -1 AS k, NULL AS name, COUNT(DISTINCT sid) AS sessions,
                0, 0, 0, 0, 0, 0.0, 0.0, 0,
                0, 0, 0, 0, 0.0, 0, 0.0, 0.0, 0
         FROM activity
         UNION ALL
         {arms}",
        ctes = breakdown::ctes_sql(true, filter, public),
        arms = breakdown::BREAKDOWN_ARMS_SQL,
    )
}

#[cfg(test)]
pub(super) fn breakdown_sql(filter: &str, public: bool) -> String {
    breakdown::breakdown_sql(filter, public)
}

fn at_time_scoped(conn: &Connection, p: &Params, now: i64, public: bool) -> ReadResult<Statistics> {
    let days = match p.0.get("days").map(String::as_str) {
        None => Some(30),
        Some("all") => None,
        Some(raw) => Some(
            raw.parse::<i64>()
                .ok()
                .filter(|d| raw.bytes().all(|b| b.is_ascii_digit()) && (1..=366).contains(d))
                .ok_or_else(|| bad("days must be an integer from 1 to 366 or all"))?,
        ),
    };
    let exclude_unpublished = p.bool("excludeUnpublished")?;
    let filter = if exclude_unpublished {
        publishing::SESSION_FILTER
    } else {
        "1"
    };
    let today = now.div_euclid(DAY_MS) * DAY_MS;
    let end = today + DAY_MS;
    let tx = conn.unchecked_transaction()?;
    let from = match days {
        Some(days) => today - (days - 1) * DAY_MS,
        None => oldest_day(&tx, filter, end, today)?.max(today - (usage::MAX_DAYS - 1) * DAY_MS),
    };
    let mut daily: Vec<Day> = (0..(end - from) / DAY_MS)
        .map(|i| Day {
            date: date(from + i * DAY_MS),
            counts: Counts::default(),
        })
        .collect();
    let mut totals = Totals {
        counts: Counts::default(),
        active_days: 0,
        estimated_cost: 0.0,
        unpriced_requests: 0,
    };
    let mut breakdown = breakdown::BreakdownBuilder::default();
    // Single pass over `usage_events` and `entries` in `[from, end)`: SQL aggregates daily totals, session activity,
    // project/model breakdowns, and request metrics so only compact summary rows cross FFI.
    let mut statement = tx.prepare(&statistics_sql(filter, public))?;
    let rows = statement.query_map(params![from, end], |r| {
        let tag: i64 = r.get(0)?;
        let key: i64 = r.get(1)?;
        match tag {
            0 => Ok((
                tag,
                key,
                None,
                breakdown::read_counts(r, 3)?,
                r.get::<_, f64>(10)?,
                r.get::<_, i64>(11)?,
                breakdown::Metrics::default(),
            )),
            1 => Ok((
                tag,
                key,
                None,
                Counts {
                    sessions: r.get(3)?,
                    ..Counts::default()
                },
                0.0,
                0,
                breakdown::Metrics::default(),
            )),
            2 => Ok((
                tag,
                key,
                r.get(2)?,
                Counts {
                    sessions: r.get(3)?,
                    ..Counts::default()
                },
                0.0,
                0,
                breakdown::Metrics::default(),
            )),
            3 | 4 => Ok((
                tag,
                key,
                r.get(2)?,
                breakdown::read_counts(r, 3)?,
                0.0,
                0,
                breakdown::read_metrics(r, 12)?,
            )),
            _ => unreachable!("unexpected statistics row tag {tag}"),
        }
    })?;
    for row in rows {
        let (tag, key, name, counts, estimated, unpriced, metrics) = row?;
        match tag {
            0 => {
                let slot = &mut daily[key as usize].counts;
                slot.requests = counts.requests;
                slot.tokens = counts.tokens;
                slot.cost = counts.cost;
                totals.estimated_cost += estimated;
                totals.unpriced_requests += unpriced;
            }
            1 => {
                if key == -1 {
                    totals.counts.sessions = counts.sessions;
                } else {
                    daily[key as usize].counts.sessions = counts.sessions;
                    totals.active_days += 1;
                }
            }
            2 => breakdown.add_project_sessions(key, name, counts.sessions),
            3 => breakdown.add_project_usage(key, name, counts, metrics),
            4 => breakdown.add_model(key, name, counts, metrics),
            _ => unreachable!("unexpected statistics row tag {tag}"),
        }
    }
    for day in &daily {
        totals.counts.requests += day.counts.requests;
        totals.counts.tokens.input += day.counts.tokens.input;
        totals.counts.tokens.output += day.counts.tokens.output;
        totals.counts.tokens.cache_read += day.counts.tokens.cache_read;
        totals.counts.tokens.cache_write += day.counts.tokens.cache_write;
        totals.counts.cost += day.counts.cost;
    }
    let breakdown = breakdown.finish();
    Ok(Statistics {
        from: date(from),
        to: date(today),
        exclude_unpublished,
        totals,
        daily,
        projects: breakdown.projects,
        models: breakdown.models,
        request_metrics: breakdown.metrics,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::Store;
    use crate::util::parse_iso_ms;
    use serde_json::{Value, json};

    fn read(store: &Store, days: Option<&str>, now: &str) -> Value {
        let mut params = Params::default();
        if let Some(days) = days {
            params.0.insert("days".into(), days.into());
        }
        serde_json::to_value(store.read(|c| at_time(c, &params, parse_iso_ms(now).unwrap())).unwrap()).unwrap()
    }

    #[test]
    fn empty_ranges_are_inclusive_ordered_and_zero_filled() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        let now = "2026-11-02T16:20:00Z";
        let default = read(&store, None, now);
        assert_eq!(default["from"], "2026-10-04");
        assert_eq!(default["to"], "2026-11-02");
        assert_eq!(default["daily"].as_array().unwrap().len(), 30);
        assert_eq!(
            default["totals"],
            json!({ "sessions": 0, "requests": 0,
            "tokens": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }, "cost": 0.0, "activeDays": 0,
            "estimatedCost": 0.0, "unpricedRequests": 0 })
        );
        let one = read(&store, Some("1"), now);
        assert_eq!(one, read(&store, Some("all"), now));
        assert_eq!(one["from"], "2026-11-02");
        assert_eq!(
            one["daily"],
            json!([{ "date": "2026-11-02", "sessions": 0, "requests": 0,
            "tokens": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }, "cost": 0.0 }])
        );
        assert_eq!(read(&store, Some("366"), now)["daily"].as_array().unwrap().len(), 366);
        store
            .write(|tx| {
                tx.execute_batch(
                    "INSERT INTO sessions (sid, id, device) VALUES (1, 'future', 'd');
            INSERT INTO entries (sid, seq, offset, type, ts) VALUES (1, 0, 0, 'session', 1793664000000);",
                )
            })
            .unwrap();
        assert_eq!(read(&store, Some("all"), now), one);
    }

    #[test]
    fn all_starts_at_the_oldest_activity_in_the_requested_scope() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        store
            .write(|tx| {
                tx.execute_batch(
                    "INSERT INTO sessions (sid, id, device, project) VALUES
                (1, 'private', 'd', 'private'), (2, 'hidden', 'd', 'published'), (3, 'public', 'd', 'published');",
                )?;
                for (sid, time) in [
                    (1, "2026-10-01T00:00:00Z"),
                    (2, "2026-10-02T00:00:00Z"),
                    (3, "2026-10-03T00:00:00Z"),
                ] {
                    tx.execute(
                        "INSERT INTO entries (sid, seq, offset, type, ts) VALUES (?1, 0, 0, 'session', ?2)",
                        params![sid, parse_iso_ms(time)],
                    )?;
                }
                publishing::update(tx, "published", true).unwrap();
                crate::hidden::set(tx, "hidden", true, 1).unwrap();
                Ok::<_, rusqlite::Error>(())
            })
            .unwrap();
        let now = "2026-10-04T12:00:00Z";
        let all = read(&store, Some("all"), now);
        assert_eq!(all["from"], "2026-10-01");
        assert_eq!(all["totals"]["sessions"], 3);
        assert_eq!(all["totals"]["requests"], 0);
        assert_eq!(all["totals"]["activeDays"], 3);
        let params = Params(std::collections::BTreeMap::from([
            ("days".into(), "all".into()),
            ("excludeUnpublished".into(), "true".into()),
        ]));
        let public = store.read(|c| at_time(c, &params, parse_iso_ms(now).unwrap())).unwrap();
        assert_eq!(public.from, "2026-10-03");
        assert_eq!(public.totals.counts.sessions, 1);
        assert_eq!(public.totals.active_days, 1);
        assert_eq!(public.daily.len(), 2);
        assert_eq!(public.daily[1].counts.sessions, 0);
        store.write(|tx| publishing::update(tx, "published", false)).unwrap();
        let empty = store.read(|c| at_time(c, &params, parse_iso_ms(now).unwrap())).unwrap();
        assert_eq!(empty.from, "2026-10-04");
        assert_eq!(empty.totals.counts.sessions, 0);
    }

    #[test]
    fn utc_days_use_activity_time_distinct_sessions_and_exclude_future_days() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        store
            .write(|tx| {
                tx.execute_batch(
                    "INSERT INTO sessions (sid, id, device, last_at) VALUES
                (1, 'secret', 'secret', 9999999999999), (2, 'user-only', 'secret', 0), (3, 'future', 'secret', 0);",
                )?;
                // The first event is one millisecond outside the requested range; the last is on a future day.
                for (seq, time) in [
                    "2026-10-30T23:59:59.999Z",
                    "2026-11-01T01:30:00+02:00",
                    "2026-11-02T00:00:00Z",
                    "2026-11-02T23:59:59.999Z",
                    "2026-11-03T00:00:00Z",
                ]
                .iter()
                .enumerate()
                {
                    tx.execute(
                        "INSERT INTO usage_events (sid, seq, at, requests, input, cache_read, cache_write, cost)
                    VALUES (1, ?1, ?2, 1, 10, 20, 30, 0.25)",
                        params![seq as i64, parse_iso_ms(time)],
                    )?;
                }
                tx.execute(
                    "INSERT INTO entries (sid, seq, offset, type, ts) VALUES (2, 0, 0, 'message', ?1)",
                    [parse_iso_ms("2026-11-01T05:00:00Z")],
                )?;
                tx.execute(
                    "INSERT INTO entries (sid, seq, offset, type, ts) VALUES (3, 0, 0, 'session', ?1)",
                    [parse_iso_ms("2026-11-03T00:00:00Z")],
                )?;
                // An out-of-range integer timestamp must not create an unbounded all-days response.
                tx.execute(
                    "INSERT INTO usage_events (sid, seq, at, requests) VALUES (1, 99, ?1, 1)",
                    [i64::MIN],
                )?;
                Ok::<_, rusqlite::Error>(())
            })
            .unwrap();
        let stats = read(&store, Some("3"), "2026-11-02T12:00:00Z");
        assert_eq!(stats["from"], "2026-10-31");
        assert_eq!(
            stats["totals"],
            json!({ "sessions": 2, "requests": 3,
            "tokens": { "input": 30, "output": 0, "cacheRead": 60, "cacheWrite": 90 }, "cost": 0.75, "activeDays": 3,
            "estimatedCost": 0.0, "unpricedRequests": 0 })
        );
        let daily = stats["daily"].as_array().unwrap();
        assert_eq!(
            daily.iter().map(|d| d["sessions"].as_i64().unwrap()).collect::<Vec<_>>(),
            [1, 1, 1]
        );
        assert_eq!(
            daily.iter().map(|d| d["requests"].as_i64().unwrap()).collect::<Vec<_>>(),
            [1, 0, 2]
        );
        assert_eq!(
            daily.iter().map(|d| d["date"].as_str().unwrap()).collect::<Vec<_>>(),
            ["2026-10-31", "2026-11-01", "2026-11-02"]
        );
        let all = read(&store, Some("all"), "2026-11-02T12:00:00Z");
        assert_eq!(all["from"], "2026-10-30");
        assert_eq!(all["totals"]["requests"], 4);
        // A gap day is retained even when the next day has usage.
        let gap = read(&store, Some("5"), "2026-11-02T12:00:00Z");
        assert_eq!(gap["daily"][0]["sessions"], 0);
        assert_eq!(gap["daily"][0]["requests"], 0);
    }

    #[test]
    fn all_clamps_ancient_timestamps_to_usage_max_days() {
        let now_ms = parse_iso_ms("2026-11-02T12:00:00Z").unwrap();
        let today = now_ms.div_euclid(DAY_MS) * DAY_MS;
        let expected_from = date(today - (usage::MAX_DAYS - 1) * DAY_MS);
        let expected_to = date(today);
        let params = Params(std::collections::BTreeMap::from([(
            "days".into(),
            "all".into(),
        )]));

        for (label, ancient_ts) in [
            ("epoch-1970-01-01", 0_i64),
            ("year-0000-01-01", FIRST_MS),
            (
                "one-ms-before-window",
                today - (usage::MAX_DAYS - 1) * DAY_MS - 1,
            ),
        ] {
            let dir = tempfile::tempdir().unwrap();
            let store = Store::open(dir.path()).unwrap();
            store
                .write(|tx| {
                    tx.execute(
                        "INSERT INTO sessions (sid, id, device) VALUES (1, 'ancient', 'd')",
                        [],
                    )?;
                    tx.execute(
                        "INSERT INTO entries (sid, seq, offset, type, ts) VALUES (1, 0, 0, 'session', ?1)",
                        [ancient_ts],
                    )?;
                    tx.execute(
                        "INSERT INTO usage_events (sid, seq, at, requests, input) VALUES (1, 0, ?1, 1, 10)",
                        [ancient_ts],
                    )?;
                    tx.execute(
                        "INSERT INTO usage_events (sid, seq, at, requests, input) VALUES (1, 1, ?1, 2, 20)",
                        [today],
                    )?;
                    Ok::<_, rusqlite::Error>(())
                })
                .unwrap();

            for public in [false, true] {
                let stats = store
                    .read(|c| at_time_scoped(c, &params, now_ms, public))
                    .unwrap();
                assert_eq!(stats.daily.len(), usage::MAX_DAYS as usize, "{label} public={public}");
                assert_eq!(stats.from, expected_from, "{label} public={public}");
                assert_eq!(stats.to, expected_to, "{label} public={public}");
                assert_eq!(stats.daily[0].date, expected_from, "{label} public={public}");
                assert_eq!(
                    stats.daily.last().unwrap().date,
                    expected_to,
                    "{label} public={public}"
                );
                assert_eq!(stats.totals.counts.requests, 2, "{label} public={public}");
                assert_eq!(stats.totals.counts.tokens.input, 20, "{label} public={public}");
                assert_eq!(stats.totals.active_days, 1, "{label} public={public}");
            }
        }
    }

    #[test]
    fn single_scan_statistics_matches_reference_across_devices_projects_models_pricing_and_visibility() {
        use std::collections::{BTreeMap, BTreeSet};

        let now_ms = parse_iso_ms("2026-11-05T12:00:00Z").unwrap();
        let today = now_ms.div_euclid(DAY_MS) * DAY_MS;
        let day = |offset: i64| today - offset * DAY_MS + 3_600_000;

        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        store
            .write(|tx| {
                // Multi-device, published/unpublished/hidden/empty/null projects.
                tx.execute_batch(
                    "INSERT INTO sessions (sid, id, device, project) VALUES
                        (1, 'pub-a-1', 'laptop', 'pub-a'),
                        (2, 'pub-a-hidden', 'desktop', 'pub-a'),
                        (3, 'pub-b-prompt', 'workstation', 'pub-b'),
                        (4, 'secret-1', 'laptop', 'secret-x'),
                        (5, 'empty-proj', 'desktop', ''),
                        (6, 'null-proj', 'workstation', NULL),
                        (7, 'secret-prompt', 'laptop', 'secret-y');",
                )?;
                publishing::update(tx, "pub-a", true).unwrap();
                publishing::update(tx, "pub-b", true).unwrap();
                crate::hidden::set(tx, "pub-a-hidden", true, 1).unwrap();

                tx.execute_batch(
                    "INSERT INTO request_sessions (id, session_id) VALUES (1, 'pub-a-1'), (2, 'secret-1');
                     INSERT INTO requests (id, session_id, rs, device, fidelity, skeleton, block_count, complete, received_at, timing) VALUES
                        ('r1', 'pub-a-1', 1, 'laptop', 'payload', '{}', 0, 1, 0, '{\"sentAt\":1100,\"firstTokenAt\":1500}'),
                        ('r2', 'secret-1', 2, 'laptop', 'payload', '{}', 0, 1, 0, '{\"sentAt\":2000,\"firstTokenAt\":2300}'),
                        ('r3', 'secret-1', 2, 'laptop', 'payload', '{}', 0, 1, 0, 'not-json');",
                )?;

                // (sid, seq, at, requests, in, out, cr, cw, cost, pricing, model, stop, err, m_ts, m_at, req_id)
                let usage_rows: &[(i64, i64, i64, i64, i64, i64, i64, i64, f64, i64, Option<&str>, Option<&str>, Option<&str>, Option<i64>, Option<i64>, Option<&str>)] = &[
                    // In 3-day window (offsets 0, 1, 2):
                    (1, 1, day(2), 1, 100, 40, 20, 10, 0.25, 0, Some("relay/gpt-6-luna"), Some("stop"), None, Some(1000), Some(2500), Some("r1")),
                    (1, 2, day(0), 1, 200, 80, 30, 5, 0.5, 1, Some("gpt-6-luna@1m"), Some("toolUse"), None, Some(1000), Some(3000), None),
                    (1, 3, day(0), 0, 50, 0, 10, 0, 0.125, 0, None, None, None, None, None, None),
                    // Hidden session inside published project (excluded by excludeUnpublished, anonymized in public view):
                    (2, 1, day(1), 1, 60, 20, 0, 0, 0.0, 2, Some("claude-opus-5-5"), Some("error"), Some("boom"), Some(1000), Some(2000), None),
                    // Unpublished project across two days + aborted + malformed timing:
                    (4, 1, day(2), 1, 80, 100, 10, 20, 0.5, 1, Some("claude-opus-5-5"), Some("length"), None, Some(1900), Some(4000), Some("r2")),
                    (4, 2, day(0), 1, 40, 50, 5, 5, 0.0, 2, Some("codex/gpt-6-luna"), Some("aborted"), Some("cancelled"), Some(1000), Some(2000), Some("r3")),
                    // Empty and NULL projects + empty/NULL models:
                    (5, 1, day(1), 1, 30, 10, 0, 0, 0.25, 0, Some(""), Some("stop"), None, Some(1000), Some(2000), None),
                    (6, 1, day(0), 1, 25, 15, 0, 0, 0.125, 0, None, None, None, None, None, None),
                    // Older than 3 days, within 30 days (offset 10):
                    (1, 4, day(10), 1, 300, 120, 40, 10, 1.0, 0, Some("gpt-6-luna"), Some("stop"), None, Some(1000), Some(2200), None),
                    // Ancient row beyond MAX_DAYS (clamped on days=all):
                    (4, 9, today - usage::MAX_DAYS * DAY_MS - 1000, 1, 999, 999, 0, 0, 9.0, 0, Some("ancient-model"), Some("stop"), None, Some(1000), Some(2000), None),
                    // Future row (always excluded):
                    (1, 9, today + DAY_MS + 1000, 1, 777, 777, 0, 0, 7.0, 0, Some("future-model"), Some("stop"), None, Some(1000), Some(2000), None),
                ];
                for &(sid, seq, at, req, inp, out, cr, cw, cost, pricing, model, stop, err, mts, mat, req_id) in usage_rows {
                    tx.execute(
                        "INSERT INTO usage_events (sid, seq, at, requests, input, output, cache_read, cache_write, cost, pricing)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                        params![sid, seq, at, req, inp, out, cr, cw, cost, pricing],
                    )?;
                    if model.is_some() || stop.is_some() || err.is_some() || mts.is_some() || mat.is_some() || req_id.is_some() {
                        tx.execute(
                            "INSERT INTO model_calls (sid, seq, model, stop_reason, error_message, ts, at, request_id)
                             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                            params![sid, seq, model, stop, err, mts, mat, req_id],
                        )?;
                    }
                }
                // Entries: prompt-only published (sid=3), prompt-only secret (sid=7), plus overlapping entries on sid=1,6.
                for (sid, seq, ts) in [
                    (1, 0, day(2)),
                    (1, 1, day(1)), // active day via entry only on day(1)
                    (3, 0, day(1)), // prompt-only in published project
                    (6, 0, day(2)), // prompt entry for null-proj on day(2)
                    (7, 0, day(0)), // prompt-only in unpublished project
                    (7, 1, today + DAY_MS), // future entry (excluded)
                ] {
                    tx.execute(
                        "INSERT INTO entries (sid, seq, offset, type, ts) VALUES (?1, ?2, 0, 'message', ?3)",
                        params![sid, seq, ts],
                    )?;
                }
                Ok::<_, rusqlite::Error>(())
            })
            .unwrap();

        // Independent reference implementation using the original separate-query + per-row Rust streaming logic.
        let reference = |conn: &Connection, days_param: &str, exclude_unpublished: bool, public: bool| -> Value {
            let filter = if exclude_unpublished { publishing::SESSION_FILTER } else { "1" };
            let end = today + DAY_MS;
            let from = match days_param {
                "all" => oldest_day(conn, filter, end, today).unwrap().max(today - (usage::MAX_DAYS - 1) * DAY_MS),
                raw => today - (raw.parse::<i64>().unwrap() - 1) * DAY_MS,
            };
            let n_days = ((end - from) / DAY_MS) as usize;
            let mut daily: Vec<Day> = (0..n_days)
                .map(|i| Day { date: date(from + i as i64 * DAY_MS), counts: Counts::default() })
                .collect();
            let mut day_sids: Vec<BTreeSet<i64>> = vec![BTreeSet::new(); n_days];
            let mut total_sids: BTreeSet<i64> = BTreeSet::new();
            let mut estimated_cost = 0.0_f64;
            let mut unpriced_requests = 0_i64;

            let mut stmt = conn
                .prepare(&format!(
                    "SELECT (u.at - ?1) / {DAY_MS}, u.sid, u.requests, u.input, u.output, u.cache_read, u.cache_write,
                            u.cost, u.pricing
                     FROM usage_events u JOIN sessions s ON s.sid = u.sid
                     WHERE u.at >= ?1 AND u.at < ?2 AND {filter}"
                ))
                .unwrap();
            for r in stmt
                .query_map(params![from, end], |r| {
                    Ok((
                        r.get::<_, i64>(0)?,
                        r.get::<_, i64>(1)?,
                        r.get::<_, i64>(2)?,
                        r.get::<_, i64>(3)?,
                        r.get::<_, i64>(4)?,
                        r.get::<_, i64>(5)?,
                        r.get::<_, i64>(6)?,
                        r.get::<_, f64>(7)?,
                        r.get::<_, i64>(8)?,
                    ))
                })
                .unwrap()
            {
                let (d, sid, req, inp, out, cr, cw, cost, pricing) = r.unwrap();
                let slot = &mut daily[d as usize].counts;
                slot.requests += req;
                slot.tokens.input += inp;
                slot.tokens.output += out;
                slot.tokens.cache_read += cr;
                slot.tokens.cache_write += cw;
                slot.cost += cost;
                if pricing == 1 {
                    estimated_cost += cost;
                }
                if pricing == 2 {
                    unpriced_requests += 1;
                }
                day_sids[d as usize].insert(sid);
                total_sids.insert(sid);
            }
            let mut stmt = conn
                .prepare(&format!(
                    "SELECT (e.ts - ?1) / {DAY_MS}, e.sid
                     FROM entries e JOIN sessions s ON s.sid = e.sid
                     WHERE e.ts >= ?1 AND e.ts < ?2 AND {filter}"
                ))
                .unwrap();
            for r in stmt.query_map(params![from, end], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?))).unwrap() {
                let (d, sid) = r.unwrap();
                day_sids[d as usize].insert(sid);
                total_sids.insert(sid);
            }
            let mut totals = Totals {
                counts: Counts { sessions: total_sids.len() as i64, ..Counts::default() },
                active_days: 0,
                estimated_cost,
                unpriced_requests,
            };
            for (d, sids) in daily.iter_mut().zip(&day_sids) {
                d.counts.sessions = sids.len() as i64;
                if !sids.is_empty() {
                    totals.active_days += 1;
                }
                totals.counts.requests += d.counts.requests;
                totals.counts.tokens.input += d.counts.tokens.input;
                totals.counts.tokens.output += d.counts.tokens.output;
                totals.counts.tokens.cache_read += d.counts.tokens.cache_read;
                totals.counts.tokens.cache_write += d.counts.tokens.cache_write;
                totals.counts.cost += d.counts.cost;
            }
            let bd = breakdown::query(conn, from, end, filter, public).unwrap();
            serde_json::to_value(Statistics {
                from: date(from),
                to: date(today),
                exclude_unpublished,
                totals,
                daily,
                projects: bd.projects,
                models: bd.models,
                request_metrics: bd.metrics,
            })
            .unwrap()
        };

        for days_param in ["3", "30", "all"] {
            for exclude_unpublished in [false, true] {
                for public in [false, true] {
                    let params = Params(BTreeMap::from([
                        ("days".into(), days_param.into()),
                        ("excludeUnpublished".into(), exclude_unpublished.to_string()),
                    ]));
                    let (actual, expected) = store
                        .read(|conn| {
                            let actual = serde_json::to_value(at_time_scoped(conn, &params, now_ms, public).unwrap()).unwrap();
                            let expected = reference(conn, days_param, exclude_unpublished, public);
                            Ok::<_, rusqlite::Error>((actual, expected))
                        })
                        .unwrap();
                    assert_eq!(
                        actual, expected,
                        "mismatch for days={days_param} excludeUnpublished={exclude_unpublished} public={public}"
                    );
                    if public {
                        let serialized = actual.to_string();
                        assert!(!serialized.contains("secret-x"), "{serialized}");
                        assert!(!serialized.contains("secret-y"), "{serialized}");
                    }
                }
            }
        }
    }

    #[test]
    fn sql_aggregation_returns_compact_summary_rows_not_raw_events() {
        let now_ms = parse_iso_ms("2026-11-05T12:00:00Z").unwrap();
        let today = now_ms.div_euclid(DAY_MS) * DAY_MS;
        let from = today - 2 * DAY_MS;
        let end = today + DAY_MS;

        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        store
            .write(|tx| {
                tx.execute(
                    "INSERT INTO sessions (sid, id, device, project) VALUES (1, 's1', 'd', 'p1'), (2, 's2', 'd', 'p2')",
                    [],
                )?;
                for i in 0..500_i64 {
                    let sid = (i % 2) + 1;
                    let ts = from + (i % 3) * DAY_MS + i * 10;
                    tx.execute(
                        "INSERT INTO usage_events (sid, seq, at, requests, input, output, cost) VALUES (?1, ?2, ?3, 1, 10, 5, 0.125)",
                        params![sid, i, ts],
                    )?;
                    tx.execute(
                        "INSERT INTO model_calls (sid, seq, model, stop_reason, ts, at) VALUES (?1, ?2, ?3, 'stop', ?4, ?5)",
                        params![sid, i, if i % 2 == 0 { "m1" } else { "m2" }, ts, ts + 500],
                    )?;
                    tx.execute(
                        "INSERT INTO entries (sid, seq, offset, type, ts) VALUES (?1, ?2, 0, 'message', ?3)",
                        params![sid, i, ts],
                    )?;
                }
                Ok::<_, rusqlite::Error>(())
            })
            .unwrap();

        let (stats, row_count) = store
            .read(|conn| {
                let mut stmt = conn.prepare(&statistics_sql("1", true))?;
                let rows = stmt
                    .query_map(params![from, end], |r| r.get::<_, i64>(0))?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                let p = Params(std::collections::BTreeMap::from([("days".into(), "3".into())]));
                let stats = at_time_scoped(conn, &p, now_ms, true).unwrap();
                Ok::<_, rusqlite::Error>((stats, rows.len()))
            })
            .unwrap();

        // 500 usage_events + 500 entries collapse to at most 3 daily usage + 4 session + 2 project + 2 model rows.
        assert!(row_count <= 15, "expected compact SQL summary rows, got {row_count}");
        assert_eq!(stats.totals.counts.requests, 500);
        assert_eq!(stats.totals.counts.sessions, 2);
        assert_eq!(stats.totals.counts.tokens.input, 5000);
        assert_eq!(stats.request_metrics.completed, 500);
    }
}
