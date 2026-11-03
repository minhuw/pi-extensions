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
        None => oldest_day(&tx, filter, end, today)?,
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
    // Relative offsets stay nonnegative even for dates before the Unix epoch.
    let mut statement = tx.prepare(&format!(
        "SELECT (u.at - ?1) / {DAY_MS}, SUM(u.requests), SUM(u.input), SUM(u.output),
                SUM(u.cache_read), SUM(u.cache_write), SUM(u.cost),
                SUM(CASE WHEN u.pricing = 1 THEN u.cost ELSE 0 END), SUM(u.pricing = 2)
         FROM usage_events u JOIN sessions s ON s.sid = u.sid
         WHERE u.at >= ?1 AND u.at < ?2 AND {filter}
         GROUP BY 1"
    ))?;
    let rows = statement.query_map(params![from, end], |r| {
        Ok((
            r.get::<_, i64>(0)?,
            Counts {
                requests: r.get(1)?,
                tokens: Tokens {
                    input: r.get(2)?,
                    output: r.get(3)?,
                    cache_read: r.get(4)?,
                    cache_write: r.get(5)?,
                },
                cost: r.get(6)?,
                ..Counts::default()
            },
            r.get::<_, f64>(7)?,
            r.get::<_, i64>(8)?,
        ))
    })?;
    for row in rows {
        let (day, counts, estimated, unpriced) = row?;
        daily[day as usize].counts = counts;
        totals.estimated_cost += estimated;
        totals.unpriced_requests += unpriced;
    }
    // UNION deduplicates each (day, sid), including entries that also have a usage row. Children are
    // independent sessions, never recursively added to a parent's usage. The total deduplicates across days too.
    let mut statement = tx.prepare(&format!(
        "WITH activity AS (
            SELECT (e.ts - ?1) / {DAY_MS} AS day, e.sid
            FROM entries e JOIN sessions s ON s.sid = e.sid
            WHERE e.ts >= ?1 AND e.ts < ?2 AND {filter}
            UNION
            SELECT (u.at - ?1) / {DAY_MS} AS day, u.sid
            FROM usage_events u JOIN sessions s ON s.sid = u.sid
            WHERE u.at >= ?1 AND u.at < ?2 AND {filter}
         )
         SELECT day, COUNT(*) FROM activity GROUP BY day
         UNION ALL SELECT -1, COUNT(DISTINCT sid) FROM activity"
    ))?;
    let rows = statement.query_map(params![from, end], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)))?;
    for row in rows {
        let (day, sessions) = row?;
        if day == -1 {
            totals.counts.sessions = sessions;
        } else {
            daily[day as usize].counts.sessions = sessions;
            totals.active_days += 1;
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
    let breakdown = breakdown::query(&tx, from, end, filter, public)?;
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
}
