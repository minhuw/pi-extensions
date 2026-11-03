//! The usage query API: tokens, requests, and cost per day, week, or month, optionally split by model or project.
//! Built from the same dated ledger as the statistics totals, so the two always agree. Public responses never name an
//! unpublished or hidden project; that activity is the group without a name.
use std::cmp::Reverse;
use std::collections::BTreeMap;

use rusqlite::{Connection, params};
use serde::Serialize;

use super::{DAY_MS, date, oldest_day};
use crate::read::{Params, ReadResult, bad, publishing};
use crate::util::{now_ms, parse_iso_ms};

/// The longest range one response covers: about ten years of days.
pub const MAX_DAYS: i64 = 3660;

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub requests: i64,
    /// Input, output, cache read, and cache write together.
    pub tokens: i64,
    pub input: i64,
    pub output: i64,
    pub cache_read: i64,
    pub cache_write: i64,
    pub cost: f64,
}

impl Usage {
    fn add(&mut self, other: &Usage) {
        self.requests += other.requests;
        self.tokens += other.tokens;
        self.input += other.input;
        self.output += other.output;
        self.cache_read += other.cache_read;
        self.cache_write += other.cache_write;
        self.cost += other.cost;
    }
}

#[derive(Serialize)]
pub struct Group {
    /// A bare model name or a project; `null` is usage without a recorded model, or a project that is unnamed,
    /// unpublished, or hidden (public responses).
    pub name: Option<String>,
    #[serde(flatten)]
    pub usage: Usage,
}

/// One interval of the range. `start` and `end` are inclusive UTC days, clipped to the range, so the first and last
/// weeks or months can be partial.
#[derive(Serialize)]
pub struct Period {
    pub start: String,
    pub end: String,
    #[serde(flatten)]
    pub usage: Usage,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub groups: Option<Vec<Group>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageReport {
    pub from: String,
    pub to: String,
    pub interval: &'static str,
    pub by: Option<&'static str>,
    pub exclude_unpublished: bool,
    pub total: Usage,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub groups: Option<Vec<Group>>,
    pub periods: Vec<Period>,
}

#[derive(Clone, Copy, PartialEq)]
enum Interval {
    Day,
    Week,
    Month,
    Total,
}

#[derive(Clone, Copy, PartialEq)]
enum By {
    Model,
    Project,
}

pub fn usage_scoped(conn: &Connection, params: &Params, public: bool) -> ReadResult<UsageReport> {
    at_time(conn, params, now_ms(), public)
}

/// A strict `YYYY-MM-DD` calendar date as UTC midnight.
fn day_param(params: &Params, key: &str) -> ReadResult<Option<i64>> {
    let Some(raw) = params.get(key) else {
        return Ok(None);
    };
    let ms = (raw.len() == 10)
        .then(|| parse_iso_ms(&format!("{raw}T00:00:00Z")))
        .flatten()
        .filter(|ms| date(*ms) == raw)
        .ok_or_else(|| bad(format!("{key} must be a date such as 2026-11-03")))?;
    Ok(Some(ms))
}

/// The first day of the calendar interval that contains `day`. Weeks start on Monday (ISO 8601).
fn interval_start(day: i64, interval: Interval, from: i64) -> i64 {
    match interval {
        Interval::Day => day,
        // 1970-01-01 was a Thursday, three days after a Monday.
        Interval::Week => day - (day.div_euclid(DAY_MS) + 3).rem_euclid(7) * DAY_MS,
        Interval::Month => {
            parse_iso_ms(&format!("{}-01T00:00:00Z", &date(day)[..7])).unwrap_or(day)
        }
        Interval::Total => from,
    }
}

fn sorted(groups: BTreeMap<Option<String>, Usage>) -> Vec<Group> {
    let mut groups: Vec<_> = groups
        .into_iter()
        .map(|(name, usage)| Group { name, usage })
        .collect();
    groups.sort_by(|a, b| {
        (Reverse(a.usage.tokens), a.name.is_none(), &a.name).cmp(&(
            Reverse(b.usage.tokens),
            b.name.is_none(),
            &b.name,
        ))
    });
    groups
}

fn at_time(conn: &Connection, p: &Params, now: i64, public: bool) -> ReadResult<UsageReport> {
    let (interval, interval_name) = match p.get("interval").unwrap_or("day") {
        "day" => (Interval::Day, "day"),
        "week" => (Interval::Week, "week"),
        "month" => (Interval::Month, "month"),
        "total" => (Interval::Total, "total"),
        _ => return Err(bad("interval must be day, week, month, or total")),
    };
    let by = match p.get("by") {
        None => None,
        Some("model") => Some((By::Model, "model")),
        Some("project") => Some((By::Project, "project")),
        Some(_) => return Err(bad("by must be model or project")),
    };
    let exclude_unpublished = p.bool("excludeUnpublished")?;
    let filter = if exclude_unpublished {
        publishing::SESSION_FILTER
    } else {
        "1"
    };
    let today = now.div_euclid(DAY_MS) * DAY_MS;
    let (start, finish) = (day_param(p, "from")?, day_param(p, "to")?);
    let tx = conn.unchecked_transaction()?;
    let (from, to) = match (p.get("days"), start, finish) {
        (Some(_), Some(_), _) | (Some(_), _, Some(_)) => {
            return Err(bad("use days, or from and to, not both"));
        }
        (Some("all"), ..) => (
            oldest_day(&tx, filter, today + DAY_MS, today)?.max(today - (MAX_DAYS - 1) * DAY_MS),
            today,
        ),
        (Some(raw), ..) => {
            let days = raw
                .parse::<i64>()
                .ok()
                .filter(|d| raw.bytes().all(|b| b.is_ascii_digit()) && (1..=MAX_DAYS).contains(d))
                .ok_or_else(|| {
                    bad(format!(
                        "days must be an integer from 1 to {MAX_DAYS} or all"
                    ))
                })?;
            (today - (days - 1) * DAY_MS, today)
        }
        (None, None, None) => (today - 29 * DAY_MS, today),
        (None, start, finish) => {
            // Days after today have no usage yet, so the range ends today at the latest.
            let to = finish.unwrap_or(today).min(today);
            let from = start.unwrap_or(to - 29 * DAY_MS);
            if from > to {
                return Err(bad("from must not be after to or today"));
            }
            if (to - from) / DAY_MS + 1 > MAX_DAYS {
                return Err(bad(format!("a range covers at most {MAX_DAYS} days")));
            }
            (from, to)
        }
    };
    let end = to + DAY_MS;

    // Each day of the range belongs to one period, in order.
    let mut periods: Vec<Period> = Vec::new();
    let mut period_of: Vec<usize> = Vec::new();
    let mut current = None;
    for day in (from..end).step_by(DAY_MS as usize) {
        let key = interval_start(day, interval, from);
        if current != Some(key) {
            current = Some(key);
            periods.push(Period {
                start: date(day),
                end: date(day),
                usage: Usage::default(),
                groups: None,
            });
        }
        periods.last_mut().expect("a period was pushed").end = date(day);
        period_of.push(periods.len() - 1);
    }

    // The group's raw name, and whether its session is public (only consulted for projects).
    let (name, join) = match by.map(|(by, _)| by) {
        None => ("NULL, 1".to_owned(), ""),
        Some(By::Model) => (
            "m.model, 1".to_owned(),
            "LEFT JOIN model_calls m ON m.sid = u.sid AND m.seq = u.seq",
        ),
        Some(By::Project) => (
            format!(
                "s.project, CASE WHEN ({}) THEN 1 ELSE 0 END",
                publishing::SESSION_FILTER
            ),
            "",
        ),
    };
    let mut statement = tx.prepare(&format!(
        "SELECT (u.at - ?1) / {DAY_MS}, {name}, SUM(u.requests), SUM(u.input), SUM(u.output),
                SUM(u.cache_read), SUM(u.cache_write), SUM(u.cost)
         FROM usage_events u JOIN sessions s ON s.sid = u.sid {join}
         WHERE u.at >= ?1 AND u.at < ?2 AND {filter}
         GROUP BY 1, 2, 3"
    ))?;
    let rows = statement.query_map(params![from, end], |r| {
        let (input, output, cache_read, cache_write) = (r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?);
        Ok((
            r.get::<_, i64>(0)?,
            r.get::<_, Option<String>>(1)?,
            r.get::<_, bool>(2)?,
            Usage {
                requests: r.get(3)?,
                tokens: input + output + cache_read + cache_write,
                input,
                output,
                cache_read,
                cache_write,
                cost: r.get(8)?,
            },
        ))
    })?;
    let mut total = Usage::default();
    let mut groups: BTreeMap<Option<String>, Usage> = BTreeMap::new();
    let mut period_groups: Vec<BTreeMap<Option<String>, Usage>> =
        periods.iter().map(|_| BTreeMap::new()).collect();
    for row in rows {
        let (day, raw, visible, usage) = row?;
        let index = period_of[day as usize];
        total.add(&usage);
        periods[index].usage.add(&usage);
        let Some((by, _)) = by else { continue };
        let name = match by {
            By::Model => raw
                .filter(|name| !name.trim().is_empty())
                .map(|name| crate::util::bare_model(&name).to_owned()),
            By::Project => raw.filter(|name| !name.is_empty() && (visible || !public)),
        };
        groups.entry(name.clone()).or_default().add(&usage);
        period_groups[index].entry(name).or_default().add(&usage);
    }
    if by.is_some() {
        for (period, groups) in periods.iter_mut().zip(period_groups) {
            period.groups = Some(sorted(groups));
        }
    }
    Ok(UsageReport {
        from: date(from),
        to: date(to),
        interval: interval_name,
        by: by.map(|(_, name)| name),
        exclude_unpublished,
        total,
        groups: by.map(|_| sorted(groups)),
        periods,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::Store;
    use serde_json::{Value, json};

    const NOW: &str = "2026-11-04T12:00:00Z";

    fn store() -> (tempfile::TempDir, std::sync::Arc<Store>) {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        store
            .write(|tx| {
                tx.execute_batch(
                    "INSERT INTO sessions (sid, id, device, project) VALUES
                        (1, 'a', 'd', 'secret-project'), (2, 'b', 'd', 'published'), (3, 'c', 'd', 'published');",
                )?;
                // (sid, seq, day, requests, input, model): routes of one model merge; summaries have no model.
                for (sid, seq, day, requests, input, model) in [
                    (1, 1, "2026-10-30", 1, 10, Some("relay/gpt-6-luna")),
                    (1, 2, "2026-11-02", 1, 20, Some("gpt-6-luna@1m")),
                    (1, 3, "2026-11-02", 0, 30, None),
                    (2, 1, "2026-11-03", 1, 40, Some("claude-opus-5-5")),
                    (3, 1, "2026-11-04", 1, 50, Some("gpt-6-luna")),
                    (3, 2, "2026-10-01", 1, 60, Some("gpt-6-luna")),
                ] {
                    let at = parse_iso_ms(&format!("{day}T10:00:00Z")).unwrap();
                    tx.execute(
                        "INSERT INTO usage_events (sid, seq, at, requests, input, output, cache_read, cache_write, cost)
                         VALUES (?1, ?2, ?3, ?4, ?5, 1, 2, 3, 0.5)",
                        params![sid, seq, at, requests, input],
                    )?;
                    if let Some(model) = model {
                        tx.execute(
                            "INSERT INTO model_calls (sid, seq, model, ts, at) VALUES (?1, ?2, ?3, ?4, ?4)",
                            params![sid, seq, model, at],
                        )?;
                    }
                }
                Ok::<_, rusqlite::Error>(())
            })
            .unwrap();
        store
            .write(|tx| publishing::update(tx, "published", true))
            .unwrap();
        store
            .write(|tx| crate::hidden::set(tx, "c", true, 1))
            .unwrap();
        (dir, store)
    }

    fn read(store: &Store, query: &str, public: bool) -> ReadResult<Value> {
        let params = Params(
            query
                .split('&')
                .filter(|pair| !pair.is_empty())
                .map(|pair| {
                    let (k, v) = pair.split_once('=').unwrap();
                    (k.to_owned(), v.to_owned())
                })
                .collect(),
        );
        store
            .read(|c| at_time(c, &params, parse_iso_ms(NOW).unwrap(), public))
            .map(|report| serde_json::to_value(report).unwrap())
    }

    fn ok(store: &Store, query: &str, public: bool) -> Value {
        read(store, query, public).unwrap()
    }

    #[test]
    fn days_are_zero_filled_and_agree_with_the_statistics_totals() {
        let (_dir, store) = store();
        let report = ok(&store, "from=2026-10-30&to=2026-11-04", true);
        assert_eq!(
            (report["from"].as_str(), report["to"].as_str()),
            (Some("2026-10-30"), Some("2026-11-04"))
        );
        assert_eq!(report["interval"], "day");
        assert_eq!(report["by"], Value::Null);
        assert!(report.get("groups").is_none());
        let periods = report["periods"].as_array().unwrap();
        assert_eq!(periods.len(), 6);
        assert_eq!(
            periods[1],
            json!({ "start": "2026-10-31", "end": "2026-10-31", "requests": 0, "tokens": 0,
            "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "cost": 0.0 })
        );
        assert_eq!(periods[3]["input"], 50);
        assert_eq!(periods[3]["requests"], 1);
        assert_eq!(
            report["total"],
            json!({ "requests": 4, "tokens": 150 + 5 * 6, "input": 150, "output": 5,
            "cacheRead": 10, "cacheWrite": 15, "cost": 2.5 })
        );
        let statistics = store
            .read(|c| {
                super::super::at_time(
                    c,
                    &Params(BTreeMap::from([("days".into(), "6".into())])),
                    parse_iso_ms(NOW).unwrap(),
                )
            })
            .unwrap();
        assert_eq!(statistics.totals.counts.tokens.input, 150);
        assert_eq!(statistics.totals.counts.requests, 4);
    }

    #[test]
    fn weeks_start_on_monday_and_months_on_the_first_clipped_to_the_range() {
        let (_dir, store) = store();
        // 2026-10-30 is a Friday; 2026-11-02 a Monday.
        let weeks = ok(&store, "from=2026-10-30&to=2026-11-04&interval=week", true);
        let spans: Vec<_> = weeks["periods"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| (p["start"].clone(), p["end"].clone(), p["input"].clone()))
            .collect();
        assert_eq!(
            spans,
            [
                (json!("2026-10-30"), json!("2026-11-01"), json!(10)),
                (json!("2026-11-02"), json!("2026-11-04"), json!(140))
            ]
        );
        let months = ok(&store, "from=2026-09-15&to=2026-11-04&interval=month", true);
        let spans: Vec<_> = months["periods"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| (p["start"].clone(), p["end"].clone(), p["input"].clone()))
            .collect();
        assert_eq!(
            spans,
            [
                (json!("2026-09-15"), json!("2026-09-30"), json!(0)),
                (json!("2026-10-01"), json!("2026-10-31"), json!(70)),
                (json!("2026-11-01"), json!("2026-11-04"), json!(140)),
            ]
        );
        let total = ok(&store, "days=all&interval=total", true);
        assert_eq!(total["from"], "2026-10-01");
        assert_eq!(total["periods"].as_array().unwrap().len(), 1);
        assert_eq!(total["periods"][0]["end"], "2026-11-04");
        assert_eq!(total["periods"][0]["input"], 210);
    }

    #[test]
    fn groups_merge_model_routes_and_never_name_private_projects_publicly() {
        let (_dir, store) = store();
        let models = ok(&store, "days=7&by=model", true);
        assert_eq!(models["by"], "model");
        let names: Vec<_> = models["groups"]
            .as_array()
            .unwrap()
            .iter()
            .map(|g| (g["name"].clone(), g["input"].clone()))
            .collect();
        assert_eq!(
            names,
            [
                (json!("gpt-6-luna"), json!(80)),
                (json!("claude-opus-5-5"), json!(40)),
                (Value::Null, json!(30))
            ]
        );
        let day = &models["periods"][4];
        assert_eq!(day["start"], "2026-11-02");
        assert_eq!(day["groups"].as_array().unwrap().len(), 2);
        assert_eq!(models["periods"][2]["groups"], json!([]));

        let public = ok(&store, "days=7&by=project", true);
        let text = public.to_string();
        assert!(!text.contains("secret-project"), "{text}");
        let names: Vec<_> = public["groups"]
            .as_array()
            .unwrap()
            .iter()
            .map(|g| (g["name"].clone(), g["input"].clone()))
            .collect();
        // The hidden session's usage joins the unnamed group, even within a published project.
        assert_eq!(
            names,
            [(Value::Null, json!(110)), (json!("published"), json!(40))]
        );
        let owner = ok(&store, "days=7&by=project", false);
        let names: Vec<_> = owner["groups"]
            .as_array()
            .unwrap()
            .iter()
            .map(|g| g["name"].clone())
            .collect();
        assert_eq!(names, [json!("published"), json!("secret-project")]);
        let excluded = ok(&store, "days=7&by=project&excludeUnpublished=true", true);
        assert_eq!(excluded["total"]["input"], 40);
        assert_eq!(
            excluded["groups"],
            json!([{ "name": "published", "requests": 1, "tokens": 46, "input": 40,
            "output": 1, "cacheRead": 2, "cacheWrite": 3, "cost": 0.5 }])
        );
    }

    #[test]
    fn ranges_are_validated_and_end_today_at_the_latest() {
        let (_dir, store) = store();
        let default = ok(&store, "", true);
        assert_eq!(
            (default["from"].as_str(), default["to"].as_str()),
            (Some("2026-10-06"), Some("2026-11-04"))
        );
        assert_eq!(ok(&store, "to=2026-12-31", true)["to"], "2026-11-04");
        assert_eq!(
            ok(&store, "from=2026-11-01", true)["periods"]
                .as_array()
                .unwrap()
                .len(),
            4
        );
        assert_eq!(ok(&store, "to=2026-11-01", true)["from"], "2026-10-03");
        assert_eq!(
            ok(&store, "days=3660", true)["periods"]
                .as_array()
                .unwrap()
                .len(),
            3660
        );
        assert_eq!(ok(&store, "days=all", true)["from"], "2026-10-01");
        for query in [
            "days=0",
            "days=3661",
            "days=1.5",
            "days=%2B1",
            "days=7&from=2026-11-01",
            "days=7&to=2026-11-01",
            "from=2026-11-05",
            "from=2026-11-03&to=2026-11-02",
            "from=2026-02-30",
            "from=2026-1-01",
            "from=today",
            "from=1990-01-01&to=2026-01-01",
            "interval=year",
            "interval=Day",
            "by=device",
            "by=session",
            "excludeUnpublished=yes",
        ] {
            assert!(
                matches!(
                    read(&store, query, true),
                    Err(crate::read::ReadError::BadRequest(_))
                ),
                "{query}"
            );
        }
    }
}
