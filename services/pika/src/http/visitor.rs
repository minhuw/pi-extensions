//! Anonymous, bounded public view counters. No raw address or user agent is persisted.
use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::time::Instant;

use axum::Json;
use axum::body::to_bytes;
use axum::extract::{ConnectInfo, Request, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use rusqlite::{OptionalExtension, params};
use serde::Deserialize;
use serde_json::{Value, json};

use super::{AppState, auth::Client, error, internal_error};
use crate::config::VisitorAnalytics;
use crate::store::Store;

/// Maximum per-day rows, including the overflow bucket. Views still count when this bound is reached.
const MAX_DAILY_VISITOR_ROWS: i64 = 20_000;

#[derive(Deserialize)]
#[serde(tag = "page", deny_unknown_fields)]
enum View {
    #[serde(rename = "gallery")]
    Gallery { project: Option<String> },
    #[serde(rename = "session")]
    Session {
        #[serde(rename = "sessionId")]
        session_id: String,
    },
}

fn single<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    let mut values = headers.get_all(name).iter();
    let value = values.next()?.to_str().ok()?;
    if values.next().is_some() {
        return None;
    }
    Some(value)
}

fn source(
    mode: VisitorAnalytics,
    headers: &HeaderMap,
    peer: Option<IpAddr>,
    trust_proxy: bool,
) -> (Option<IpAddr>, Option<String>) {
    let cloudflare_ip = single(headers, "cf-connecting-ip")
        .and_then(|s| s.parse::<IpAddr>().ok())
        .map(|ip| ip.to_canonical());
    let (ip, use_country) = match mode {
        VisitorAnalytics::Off => (None, false),
        VisitorAnalytics::Direct => (peer, false),
        VisitorAnalytics::Proxy => (Client::new(headers, peer, true).ip, false),
        VisitorAnalytics::Cloudflare => (cloudflare_ip, true),
        VisitorAnalytics::Auto if !trust_proxy => (peer, false),
        VisitorAnalytics::Auto => {
            // Without a forwarded address, a Cloudflare header cannot establish its own provenance.
            // Keep the existing trusted-proxy rule for the IP used by visitor and rate-limit counts.
            let forwarded = Client::new(headers, None, true).ip.map(|ip| ip.to_canonical());
            let matches_cloudflare = forwarded.is_some() && forwarded == cloudflare_ip;
            (forwarded.or(peer), matches_cloudflare)
        }
    };
    let ip = ip.map(|ip| ip.to_canonical());
    let country = if use_country {
        single(headers, "cf-ipcountry")
            .filter(|s| {
                s.len() == 2
                    && s.bytes().all(|b| b.is_ascii_uppercase())
                    && *s != "XX"
                    && *s != "T1"
            })
            .map(str::to_owned)
    } else {
        None
    };
    (ip, country)
}

/// Tailscale's (and Headscale's default) addresses: 100.64.0.0/10 and fd7a:115c:a1e0::/48. Views from the owner's
/// tailnet are not public visitors. Loopback and LAN addresses still count: without `--trust-proxy` they are often
/// a local proxy's address, which every visitor shares.
fn tailnet(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            let [a, b, ..] = ip.octets();
            a == 100 && b & 0xc0 == 64
        }
        IpAddr::V6(ip) => ip.segments()[..3] == [0xfd7a, 0x115c, 0xa1e0],
    }
}

fn clean_for_day(tx: &rusqlite::Transaction<'_>, day: &str) -> rusqlite::Result<()> {
    tx.execute("DELETE FROM visitor_day_key WHERE day <> ?1", [day])?;
    tx.execute(
        "DELETE FROM visitor_views WHERE day < date(?1, '-29 days') OR day > ?1",
        [day],
    )?;
    Ok(())
}

pub(super) fn cleanup(store: &Store) -> anyhow::Result<()> {
    store.write(|tx| {
        let day: String = tx.query_row("SELECT date('now')", [], |row| row.get(0))?;
        clean_for_day(tx, &day)
    })?;
    Ok(())
}

pub(super) async fn view(State(state): State<AppState>, request: Request) -> Response {
    let (parts, body) = request.into_parts();
    let json_type = parts
        .headers
        .get(header::CONTENT_TYPE)
        .and_then(|h| h.to_str().ok())
        .is_some_and(|s| {
            s.split(';')
                .next()
                .is_some_and(|v| v.trim().eq_ignore_ascii_case("application/json"))
        });
    if !json_type {
        return error(StatusCode::BAD_REQUEST, "invalid_body");
    }
    let bytes = match to_bytes(body, 4096).await {
        Ok(v) => v,
        Err(_) => return error(StatusCode::BAD_REQUEST, "invalid_body"),
    };
    let view: View = match serde_json::from_slice(&bytes) {
        Ok(v) => v,
        Err(_) => return error(StatusCode::BAD_REQUEST, "invalid_body"),
    };
    let valid = match &view {
        View::Gallery { project } => project
            .as_ref()
            .is_none_or(|p| crate::util::valid_project(p)),
        View::Session { session_id } => {
            !session_id.is_empty()
                && session_id.len() <= 1024
                && !session_id.chars().any(char::is_control)
        }
    };
    if !valid {
        return error(StatusCode::BAD_REQUEST, "invalid_body");
    }
    let mode = state.config.visitor_analytics;
    if mode == VisitorAnalytics::Off {
        return StatusCode::NO_CONTENT.into_response();
    }
    let peer = parts
        .extensions
        .get::<ConnectInfo<SocketAddr>>()
        .map(|c| c.0.ip());
    let (ip, country) = source(mode, &parts.headers, peer, state.config.trust_proxy);
    // Ignored outright, before any rate limit or write, as if collection were off.
    if ip.is_some_and(tailnet) {
        return StatusCode::NO_CONTENT.into_response();
    }
    // Analytics is best effort; never allow a backlog of writes to monopolize the shared writer.
    let Ok(permit) = state.limits.visitor_writes.clone().try_acquire_owned() else {
        return error(StatusCode::TOO_MANY_REQUESTS, "rate_limited");
    };
    // A rejected client must not spend the global allowance of other visitors.
    let now = Instant::now();
    let key = crate::ratelimit::client_key(ip);
    {
        let mut per_ip = state
            .limits
            .visitor_ip
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if per_ip.try_record(&key, now).is_err() {
            return error(StatusCode::TOO_MANY_REQUESTS, "rate_limited");
        }
        if state
            .limits
            .visitor_global
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .try_record("all", now)
            .is_err()
        {
            per_ip.forget(&key, now);
            return error(StatusCode::TOO_MANY_REQUESTS, "rate_limited");
        }
    }
    let store = state.store.clone();
    match tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
        // Keep the permit even if the request is cancelled after the work is scheduled.
        let _permit = permit;
        store.write(|tx| -> anyhow::Result<()> {
            let day: String = tx.query_row("SELECT date('now')", [], |r| r.get(0))?;
            clean_for_day(tx, &day)?;
            let project: Option<String> = match view {
                View::Gallery { project: None } => Some(String::new()),
                View::Gallery { project: Some(p) } => tx.query_row(
                    &format!("SELECT s.project FROM sessions s WHERE s.project = ?1 AND {} LIMIT 1", crate::read::publishing::SESSION_FILTER), [&p], |r| r.get(0)).optional()?,
                View::Session { session_id } => tx.query_row(
                    &format!("SELECT s.project FROM sessions s WHERE s.id = ?1 AND {}", crate::read::publishing::SESSION_FILTER), [&session_id], |r| r.get(0)).optional()?,
            };
            let Some(mut project) = project else { return Ok(()); };
            let mut country = country.unwrap_or_default();
            // The counter includes unidentified buckets as well as visitor digests. Keeping it in the
            // current-day key row makes the check and insert atomic with every view.
            let current: Option<(Vec<u8>, i64)> = tx.query_row(
                "SELECT key, row_count FROM visitor_day_key WHERE day = ?1", [&day],
                |r| Ok((r.get(0)?, r.get(1)?)),
            ).optional()?;
            let (key, row_count) = match current {
                Some(current) => current,
                None => {
                    let mut key = vec![0; 32];
                    getrandom::fill(&mut key).map_err(|e| anyhow::anyhow!("visitor key generation: {e}"))?;
                    tx.execute("INSERT INTO visitor_day_key (day, key) VALUES (?1, ?2)", params![day, key])?;
                    (key, 0)
                }
            };
            let mut digest = ip.map(|ip| crate::util::hmac_sha256(&key, ip.to_string().as_bytes()).to_vec()).unwrap_or_default();
            if row_count >= MAX_DAILY_VISITOR_ROWS - 1 {
                let exists = tx.query_row(
                    "SELECT 1 FROM visitor_views WHERE day=?1 AND country=?2 AND project=?3 AND visitor=?4",
                    params![day, country, project, digest], |_| Ok(()),
                ).optional()?.is_some();
                if !exists {
                    // Reserve the last slot for an unidentified, unfiltered overflow bucket.
                    // Existing groups retain their dimensions; new groups contribute views only.
                    country.clear();
                    project.clear();
                    digest.clear();
                }
            }
            let inserted = tx.execute(
                "INSERT INTO visitor_views VALUES (?1, ?2, ?3, ?4, 1) ON CONFLICT(day,country,project,visitor) DO NOTHING",
                params![day, country, project, digest],
            )?;
            if inserted == 0 {
                tx.execute("UPDATE visitor_views SET views=views+1 WHERE day=?1 AND country=?2 AND project=?3 AND visitor=?4", params![day, country, project, digest])?;
            } else {
                tx.execute("UPDATE visitor_day_key SET row_count=row_count+1 WHERE day=?1", [&day])?;
            }
            // Do not retain even the temporary digest buffer for the duration of the task.
            digest.fill(0);
            Ok(())
        })
    }).await {
        Ok(Ok(())) => StatusCode::NO_CONTENT.into_response(),
        Ok(Err(e)) => internal_error(e),
        Err(e) => internal_error(e),
    }
}

fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719468;
    let era = z.div_euclid(146097);
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { yoe + era * 400 + 1 } else { yoe + era * 400 }, m, d)
}

fn parse_day(s: &str) -> anyhow::Result<i64> {
    let b = s.as_bytes();
    if b.len() != 10
        || !b.iter().enumerate().all(|(i, c)| {
            if i == 4 || i == 7 {
                *c == b'-'
            } else {
                c.is_ascii_digit()
            }
        })
    {
        anyhow::bail!("invalid SQLite day: {s:?}");
    }
    let year: i64 = s[0..4].parse()?;
    let month: i64 = s[5..7].parse()?;
    let day: i64 = s[8..10].parse()?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        anyhow::bail!("out-of-range SQLite day: {s:?}");
    }
    let serial = days_from_civil(year, month, day);
    if civil_from_days(serial) != (year, month, day) {
        anyhow::bail!("non-existent SQLite day: {s:?}");
    }
    Ok(serial)
}

fn format_day(serial: i64) -> String {
    let (y, m, d) = civil_from_days(serial);
    format!("{y:04}-{m:02}-{d:02}")
}

fn day_window(today: &str, count: usize) -> anyhow::Result<Vec<String>> {
    if count == 0 {
        return Ok(Vec::new());
    }
    let end = parse_day(today)?;
    let start = end - (count as i64 - 1);
    Ok((start..=end).map(format_day).collect())
}

pub(super) async fn origins(State(state): State<AppState>) -> Response {
    let store = state.store.clone();
    let mode = state.config.visitor_analytics;
    match tokio::task::spawn_blocking(move || -> anyhow::Result<Value> {
        store.read(|conn| -> anyhow::Result<Value> {
            // Keep all report queries on one read snapshot without holding the ingest writer.
            let tx = conn.unchecked_transaction()?;
            let today: String = tx.query_row("SELECT date('now')", [], |r| r.get(0))?;
            let days = day_window(&today, 30)?;
            let first_day = days.first().map(String::as_str).unwrap_or(today.as_str());
            let mut by_day: HashMap<String, (i64, i64)> = HashMap::new();
            {
                let mut stmt = tx.prepare(
                    "SELECT day, COALESCE(SUM(views), 0), COUNT(DISTINCT NULLIF(visitor, x'')) \
                     FROM visitor_views \
                     WHERE day BETWEEN ?1 AND ?2 \
                     GROUP BY day",
                )?;
                let rows = stmt.query_map(params![first_day, &today], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, i64>(1)?,
                        r.get::<_, i64>(2)?,
                    ))
                })?;
                for row in rows {
                    let (day, views, visitors) = row?;
                    by_day.insert(day, (views, visitors));
                }
            }
            let mut daily = Vec::with_capacity(days.len());
            let mut views: i64 = 0;
            let mut visitors: i64 = 0;
            for date in days {
                let (day_views, day_visitors) = by_day.get(&date).copied().unwrap_or((0, 0));
                views += day_views;
                visitors += day_visitors;
                daily.push(json!({"date": date, "views": day_views, "dailyVisitors": day_visitors}));
            }
            fn groups(tx: &rusqlite::Transaction<'_>, today: &str, column: &str, filter: &str, label: &str) -> rusqlite::Result<Vec<Value>> {
                let sql = format!("SELECT {column}, SUM(views), SUM(visitors) FROM (SELECT {column}, day, SUM(views) AS views, COUNT(DISTINCT NULLIF(visitor,x'')) AS visitors FROM visitor_views WHERE {filter} GROUP BY {column}, day) GROUP BY {column} ORDER BY SUM(views) DESC, {column}");
                let mut stmt = tx.prepare(&sql)?;
                let rows = stmt.query_map([today], |r| { let name: String = r.get(0)?; let name = if label == "country" && name.is_empty() { Value::Null } else { json!(name) }; Ok(json!({label: name, "views": r.get::<_, i64>(1)?, "dailyVisitors": r.get::<_, i64>(2)?})) })?;
                rows.collect()
            }
            Ok(json!({"mode":mode,"days":30,"views":views,"dailyVisitors":visitors,"daily":daily,
                "countries":groups(&tx,&today,"country","day BETWEEN date(?1, '-29 days') AND ?1","country")?, "projects":groups(&tx,&today,"project","project <> '' AND day BETWEEN date(?1, '-29 days') AND ?1","project")?}))
        })
    }).await {
        Ok(Ok(v)) => Json(v).into_response(),
        Ok(Err(e)) => internal_error(e),
        Err(e) => internal_error(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn day_window_matches_sqlite_across_calendar_boundaries() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        for today in [
            "2024-02-29", // leap day itself
            "2024-03-01", // leap year day after Feb 29
            "2024-03-15", // leap year window straddling Feb 29
            "2025-03-01", // non-leap year day after Feb 28
            "2025-01-10", // year boundary into December
            "2025-05-01", // 30-day month boundary (April)
            "2025-08-01", // 31-day month boundary (July)
            "2000-03-01", // 400-year leap century
            "2100-03-01", // 100-year non-leap century
        ] {
            let expected: Vec<String> = (0..30)
                .rev()
                .map(|offset| {
                    let modifier = format!("-{offset} days");
                    conn.query_row("SELECT date(?1, ?2)", params![today, modifier], |r| r.get(0))
                        .unwrap()
                })
                .collect();
            assert_eq!(day_window(today, 30).unwrap(), expected, "anchor {today}");
        }
    }

    #[test]
    fn parse_day_rejects_invalid_dates() {
        for bad in ["2025-02-29", "2100-02-29", "2025-04-31", "2025-13-01", "2025-00-10", "+025-01-01", "2025-1-1", ""] {
            assert!(parse_day(bad).is_err(), "expected error for {bad:?}");
        }
    }
}
