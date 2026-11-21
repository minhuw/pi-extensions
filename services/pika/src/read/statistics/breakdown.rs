//! Usage attribution over the same dated ledger as the totals. No source lines or request payloads are read.
use std::collections::BTreeMap;

use rusqlite::Row;
#[cfg(test)]
use rusqlite::{Connection, params};
use serde::Serialize;

#[cfg(test)]
use super::ReadResult;
use super::{Counts, DAY_MS, Tokens, publishing};

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestMetrics {
    pub completed: i64,
    pub failed: i64,
    pub aborted: i64,
    pub unknown: i64,
    pub ttft_ms: Option<f64>,
    pub tokens_per_second: Option<f64>,
    pub ttft_calls: i64,
    pub rate_calls: i64,
}

#[derive(Serialize)]
pub struct Breakdown {
    pub kind: &'static str,
    pub name: Option<String>,
    #[serde(flatten)]
    pub counts: Counts,
    pub metrics: RequestMetrics,
}

#[derive(Clone, PartialEq, Eq, PartialOrd, Ord)]
struct Key(&'static str, Option<String>);

#[derive(Default)]
pub(super) struct Metrics {
    pub completed: i64,
    pub failed: i64,
    pub aborted: i64,
    pub unknown: i64,
    pub ttft: f64,
    pub ttft_calls: i64,
    pub output: f64,
    pub elapsed: f64,
    pub rate_calls: i64,
}

impl Metrics {
    pub(super) fn add_agg(&mut self, other: &Metrics) {
        self.completed += other.completed;
        self.failed += other.failed;
        self.aborted += other.aborted;
        self.unknown += other.unknown;
        self.ttft += other.ttft;
        self.ttft_calls += other.ttft_calls;
        self.output += other.output;
        self.elapsed += other.elapsed;
        self.rate_calls += other.rate_calls;
    }

    pub(super) fn finish(self) -> RequestMetrics {
        RequestMetrics {
            completed: self.completed,
            failed: self.failed,
            aborted: self.aborted,
            unknown: self.unknown,
            ttft_ms: (self.ttft_calls > 0).then(|| self.ttft / self.ttft_calls as f64),
            tokens_per_second: (self.elapsed > 0.0).then(|| self.output * 1000.0 / self.elapsed),
            ttft_calls: self.ttft_calls,
            rate_calls: self.rate_calls,
        }
    }
}

#[derive(Default)]
struct Group {
    counts: Counts,
    metrics: Metrics,
}

fn kind_str(code: i64) -> &'static str {
    match code {
        0 => "project",
        1 => "unpublished",
        2 => "model",
        _ => "other-usage",
    }
}

fn finish(groups: BTreeMap<Key, Group>) -> Vec<Breakdown> {
    let mut rows: Vec<_> = groups
        .into_iter()
        .map(|(Key(kind, name), group)| Breakdown {
            kind,
            name,
            counts: group.counts,
            metrics: group.metrics.finish(),
        })
        .collect();
    rows.sort_by(|a, b| {
        let tokens = |row: &Breakdown| {
            row.counts.tokens.input
                + row.counts.tokens.output
                + row.counts.tokens.cache_read
                + row.counts.tokens.cache_write
        };
        tokens(b)
            .cmp(&tokens(a))
            .then_with(|| a.kind.cmp(b.kind))
            .then_with(|| a.name.cmp(&b.name))
    });
    rows
}

pub struct Breakdowns {
    pub projects: Vec<Breakdown>,
    pub models: Vec<Breakdown>,
    pub metrics: RequestMetrics,
}

#[derive(Default)]
pub(super) struct BreakdownBuilder {
    projects: BTreeMap<Key, Group>,
    models: BTreeMap<Key, Group>,
    metrics: Metrics,
}

impl BreakdownBuilder {
    pub(super) fn add_project_sessions(&mut self, kind_code: i64, name: Option<String>, sessions: i64) {
        let entry = self.projects.entry(Key(kind_str(kind_code), name)).or_default();
        entry.counts.sessions += sessions;
    }

    pub(super) fn add_project_usage(
        &mut self,
        kind_code: i64,
        name: Option<String>,
        counts: Counts,
        metrics: Metrics,
    ) {
        let entry = self.projects.entry(Key(kind_str(kind_code), name)).or_default();
        entry.counts.requests += counts.requests;
        entry.counts.tokens.input += counts.tokens.input;
        entry.counts.tokens.output += counts.tokens.output;
        entry.counts.tokens.cache_read += counts.tokens.cache_read;
        entry.counts.tokens.cache_write += counts.tokens.cache_write;
        entry.counts.cost += counts.cost;
        entry.metrics.add_agg(&metrics);
    }

    pub(super) fn add_model(
        &mut self,
        kind_code: i64,
        name: Option<String>,
        counts: Counts,
        metrics: Metrics,
    ) {
        let entry = self.models.entry(Key(kind_str(kind_code), name)).or_default();
        entry.counts.sessions += counts.sessions;
        entry.counts.requests += counts.requests;
        entry.counts.tokens.input += counts.tokens.input;
        entry.counts.tokens.output += counts.tokens.output;
        entry.counts.tokens.cache_read += counts.tokens.cache_read;
        entry.counts.tokens.cache_write += counts.tokens.cache_write;
        entry.counts.cost += counts.cost;
        entry.metrics.add_agg(&metrics);
        self.metrics.add_agg(&metrics);
    }

    pub(super) fn finish(self) -> Breakdowns {
        Breakdowns {
            projects: finish(self.projects),
            models: finish(self.models),
            metrics: self.metrics.finish(),
        }
    }
}

pub(super) fn read_counts(row: &Row<'_>, offset: usize) -> rusqlite::Result<Counts> {
    Ok(Counts {
        sessions: row.get(offset)?,
        requests: row.get(offset + 1)?,
        tokens: Tokens {
            input: row.get(offset + 2)?,
            output: row.get(offset + 3)?,
            cache_read: row.get(offset + 4)?,
            cache_write: row.get(offset + 5)?,
        },
        cost: row.get(offset + 6)?,
    })
}

pub(super) fn read_metrics(row: &Row<'_>, offset: usize) -> rusqlite::Result<Metrics> {
    Ok(Metrics {
        completed: row.get(offset)?,
        failed: row.get(offset + 1)?,
        aborted: row.get(offset + 2)?,
        unknown: row.get(offset + 3)?,
        ttft: row.get(offset + 4)?,
        ttft_calls: row.get(offset + 5)?,
        output: row.get(offset + 6)?,
        elapsed: row.get(offset + 7)?,
        rate_calls: row.get(offset + 8)?,
    })
}

/// SQL expressions for `(p_kind, p_name)` matching `project_key(s.project, visible, public)`.
/// `0` is `"project"`, `1` is `"unpublished"`.
fn project_exprs(filter: &str, public: bool) -> (String, String) {
    if public && filter != publishing::SESSION_FILTER {
        let visible = publishing::SESSION_FILTER;
        (
            format!("CASE WHEN ({visible}) THEN 0 ELSE 1 END"),
            format!("CASE WHEN ({visible}) THEN NULLIF(s.project, '') ELSE NULL END"),
        )
    } else {
        ("0".to_owned(), "NULLIF(s.project, '')".to_owned())
    }
}

/// Builds the single-scan CTEs shared by `statistics` (`with_day = true`) and `breakdown::query` (`with_day = false`).
///
/// Scans `usage_events` once through `usage_events_at(at, sid)` and `entries` once through the covering index
/// `entries_activity(ts, sid)`, aggregating counts, cost, pricing flags, and request metrics in SQL.
pub(super) fn ctes_sql(with_day: bool, filter: &str, public: bool) -> String {
    let (p_kind, p_name) = project_exprs(filter, public);
    let u_day_sel = if with_day {
        format!("(u.at - ?1) / {DAY_MS} AS day,")
    } else {
        "0 AS day,".to_owned()
    };
    let e_day_sel = if with_day {
        format!("(e.ts - ?1) / {DAY_MS} AS day,")
    } else {
        "0 AS day,".to_owned()
    };
    let group_by = if with_day { "1, 2, 3, 4" } else { "2, 3, 4" };
    // Valid JSON object where optional `sentAt` and `firstTokenAt` are integers (matching `serde_json` for `Timing`).
    let valid_timing = "u.requests <> 0 AND r.timing IS NOT NULL AND json_valid(r.timing, 1) \
        AND json_type(r.timing) = 'object' \
        AND COALESCE(json_type(r.timing, '$.sentAt'), 'null') IN ('null', 'integer') \
        AND COALESCE(json_type(r.timing, '$.firstTokenAt'), 'null') IN ('null', 'integer')";
    // Same plausibility window as trace timing, avoiding i64 overflow on saturating_sub(60_000) / saturating_add(1_000).
    let plausible = |col: &str| {
        format!(
            "{col} IS NOT NULL AND {col} >= 0 \
             AND (t.start_at IS NULL OR t.start_at <= 60000 OR {col} >= t.start_at - 60000) \
             AND (t.end_at IS NULL OR t.end_at >= 9223372036854774807 OR {col} <= t.end_at + 1000)"
        )
    };
    let plausible_sent = plausible("t.raw_sent");
    let plausible_first = plausible("t.raw_first");
    let agg_body = |join_sessions: &str, outer_extra: &str, inner_extra: &str, where_extra: &str| {
        format!(
            "SELECT
                u.day,
                u.sid,
                u.has_req,
                u.raw_model,
                {outer_extra}
                SUM(u.requests) AS requests,
                SUM(u.input) AS input,
                SUM(u.output) AS output,
                SUM(u.cache_read) AS cache_read,
                SUM(u.cache_write) AS cache_write,
                SUM(u.cost) AS cost,
                SUM(u.estimated_cost) AS estimated_cost,
                SUM(u.unpriced_request) AS unpriced_requests,
                SUM(CASE WHEN u.has_req = 1 AND u.outcome = 1 THEN u.requests ELSE 0 END) AS completed,
                SUM(CASE WHEN u.has_req = 1 AND u.outcome = 2 THEN u.requests ELSE 0 END) AS failed,
                SUM(CASE WHEN u.has_req = 1 AND u.outcome = 3 THEN u.requests ELSE 0 END) AS aborted,
                SUM(CASE WHEN u.has_req = 1 AND u.outcome = 4 THEN u.requests ELSE 0 END) AS unknown,
                SUM(CASE
                    WHEN u.has_req = 1
                     AND u.req_at IS NOT NULL
                     AND u.first_at IS NOT NULL
                     AND u.first_at >= u.req_at
                     AND (u.end_at IS NULL OR u.end_at >= u.first_at)
                    THEN CAST(u.first_at AS REAL) - CAST(u.req_at AS REAL)
                    ELSE 0.0
                END) AS ttft,
                SUM(CASE
                    WHEN u.has_req = 1
                     AND u.req_at IS NOT NULL
                     AND u.first_at IS NOT NULL
                     AND u.first_at >= u.req_at
                     AND (u.end_at IS NULL OR u.end_at >= u.first_at)
                    THEN 1
                    ELSE 0
                END) AS ttft_calls,
                SUM(CASE
                    WHEN u.has_req = 1
                     AND u.outcome NOT IN (2, 3)
                     AND u.output > 0
                     AND u.req_at IS NOT NULL
                     AND u.end_at IS NOT NULL
                     AND u.end_at > u.req_at
                    THEN CAST(u.output AS REAL)
                    ELSE 0.0
                END) AS rate_output,
                SUM(CASE
                    WHEN u.has_req = 1
                     AND u.outcome NOT IN (2, 3)
                     AND u.output > 0
                     AND u.req_at IS NOT NULL
                     AND u.end_at IS NOT NULL
                     AND u.end_at > u.req_at
                    THEN CAST(u.end_at AS REAL) - CAST(u.req_at AS REAL)
                    ELSE 0.0
                END) AS rate_elapsed,
                SUM(CASE
                    WHEN u.has_req = 1
                     AND u.outcome NOT IN (2, 3)
                     AND u.output > 0
                     AND u.req_at IS NOT NULL
                     AND u.end_at IS NOT NULL
                     AND u.end_at > u.req_at
                    THEN 1
                    ELSE 0
                END) AS rate_calls
             FROM (
                SELECT
                    t.*,
                    CASE WHEN {plausible_sent} THEN t.raw_sent ELSE t.start_at END AS req_at,
                    CASE WHEN {plausible_first} THEN t.raw_first ELSE NULL END AS first_at
                FROM (
                    SELECT
                        {u_day_sel}
                        u.sid AS sid,
                        CASE WHEN u.requests = 0 THEN 0 ELSE 1 END AS has_req,
                        CASE WHEN u.requests = 0 THEN NULL ELSE m.model END AS raw_model,
                        {inner_extra}
                        u.requests AS requests,
                        u.input AS input,
                        u.output AS output,
                        u.cache_read AS cache_read,
                        u.cache_write AS cache_write,
                        u.cost AS cost,
                        CASE WHEN u.pricing = 1 THEN u.cost ELSE 0.0 END AS estimated_cost,
                        CASE WHEN u.pricing = 2 THEN 1 ELSE 0 END AS unpriced_request,
                        CASE
                            WHEN m.stop_reason = 'aborted' THEN 3
                            WHEN m.stop_reason = 'error'
                              OR (m.error_message IS NOT NULL
                                  AND TRIM(m.error_message, char(9, 10, 11, 12, 13, 32)) <> '') THEN 2
                            WHEN m.stop_reason IN ('stop', 'toolUse', 'length') THEN 1
                            ELSE 4
                        END AS outcome,
                        m.ts AS start_at,
                        m.at AS end_at,
                        CASE WHEN {valid_timing} THEN json_extract(r.timing, '$.sentAt') END AS raw_sent,
                        CASE WHEN {valid_timing} THEN json_extract(r.timing, '$.firstTokenAt') END AS raw_first
                    FROM usage_events u
                    {join_sessions}
                    LEFT JOIN model_calls m ON u.requests <> 0 AND m.sid = u.sid AND m.seq = u.seq
                    LEFT JOIN requests r ON r.id = m.request_id
                    WHERE u.at >= ?1 AND u.at < ?2 {where_extra}
                ) t
             ) u
             GROUP BY {group_by}"
        )
    };

    // When filtering out unpublished sessions, join `sessions` before `model_calls`/`requests` so excluded rows skip
    // those lookups. Otherwise, group `usage_events` first so `sessions` and public visibility are evaluated once per
    // `(day, sid, model)` group instead of once per raw usage event.
    let u_ctes = if filter == "1" {
        let raw = agg_body("", "", "", "");
        format!(
            "u_raw AS NOT MATERIALIZED ({raw}),
             u_agg AS MATERIALIZED (
                SELECT
                    ur.day,
                    ur.sid,
                    {p_kind} AS p_kind,
                    {p_name} AS p_name,
                    ur.has_req,
                    ur.raw_model,
                    ur.requests,
                    ur.input,
                    ur.output,
                    ur.cache_read,
                    ur.cache_write,
                    ur.cost,
                    ur.estimated_cost,
                    ur.unpriced_requests,
                    ur.completed,
                    ur.failed,
                    ur.aborted,
                    ur.unknown,
                    ur.ttft,
                    ur.ttft_calls,
                    ur.rate_output,
                    ur.rate_elapsed,
                    ur.rate_calls
                FROM u_raw ur
                CROSS JOIN sessions s ON s.sid = ur.sid
             )"
        )
    } else {
        let filtered = agg_body(
            "CROSS JOIN sessions s ON s.sid = u.sid",
            "u.p_kind, u.p_name,",
            &format!("{p_kind} AS p_kind, {p_name} AS p_name,"),
            &format!("AND {filter}"),
        );
        format!("u_agg AS MATERIALIZED ({filtered})")
    };

    let activity_mat = if with_day { "MATERIALIZED " } else { "" };
    // Normalize distinct raw model ids in SQL identically to `crate::util::bare_model` so `COUNT(DISTINCT sid)` merges
    // routes such as `relay/gpt-6-luna` and `gpt-6-luna` without per-row streaming.
    format!(
        "WITH RECURSIVE {u_ctes},
         e_days AS NOT MATERIALIZED (
            SELECT DISTINCT {e_day_sel} e.sid AS sid
            FROM entries e
            WHERE e.ts >= ?1 AND e.ts < ?2
         ),
         e_act AS (
            SELECT d.day, d.sid, {p_kind} AS p_kind, {p_name} AS p_name
            FROM e_days d
            CROSS JOIN sessions s ON s.sid = d.sid
            WHERE {filter}
         ),
         activity AS {activity_mat}(
            SELECT day, sid, p_kind, p_name FROM e_act
            UNION
            SELECT day, sid, p_kind, p_name FROM u_agg
         ),
         raw_models(raw) AS (
            SELECT DISTINCT raw_model FROM u_agg WHERE has_req = 1 AND raw_model IS NOT NULL AND raw_model <> ''
         ),
         strip_slash(raw, trimmed, rest) AS (
            SELECT raw,
                   TRIM(raw, char(9, 10, 11, 12, 13, 32)),
                   TRIM(raw, char(9, 10, 11, 12, 13, 32))
            FROM raw_models
            UNION ALL
            SELECT raw, trimmed, SUBSTR(rest, INSTR(rest, '/') + 1)
            FROM strip_slash
            WHERE INSTR(rest, '/') > 0
         ),
         model_map(raw, bare) AS (
            SELECT raw,
                   COALESCE(
                       NULLIF(
                           TRIM(
                               CASE WHEN INSTR(rest, '@') > 0 THEN SUBSTR(rest, 1, INSTR(rest, '@') - 1) ELSE rest END,
                               char(9, 10, 11, 12, 13, 32)
                           ),
                           ''
                       ),
                       trimmed
                   )
            FROM strip_slash
            WHERE INSTR(rest, '/') = 0
         )"
    )
}

/// The three compact `UNION ALL` arms shared by `statistics` and `breakdown::query`:
/// - `tag = 2`: project session counts (including prompt-only sessions from `entries`)
/// - `tag = 3`: project usage and request metrics
/// - `tag = 4`: model breakdown (distinct sessions, usage, and request metrics)
pub(super) const BREAKDOWN_ARMS_SQL: &str = "
    SELECT 2 AS tag, p_kind AS k, p_name AS name, COUNT(DISTINCT sid) AS sessions,
           0, 0, 0, 0, 0, 0.0, 0.0, 0,
           0, 0, 0, 0, 0.0, 0, 0.0, 0.0, 0
    FROM activity
    GROUP BY p_kind, p_name
    UNION ALL
    SELECT 3 AS tag, p_kind AS k, p_name AS name, 0 AS sessions,
           SUM(requests), SUM(input), SUM(output), SUM(cache_read), SUM(cache_write),
           SUM(cost), 0.0, 0,
           SUM(completed), SUM(failed), SUM(aborted), SUM(unknown),
           SUM(ttft), SUM(ttft_calls), SUM(rate_output), SUM(rate_elapsed), SUM(rate_calls)
    FROM u_agg
    GROUP BY p_kind, p_name
    UNION ALL
    SELECT 4 AS tag,
           CASE WHEN ua.has_req = 0 THEN 3 ELSE 2 END AS k,
           CASE WHEN ua.has_req = 0 THEN NULL ELSE mm.bare END AS name,
           COUNT(DISTINCT ua.sid) AS sessions,
           SUM(ua.requests), SUM(ua.input), SUM(ua.output), SUM(ua.cache_read), SUM(ua.cache_write),
           SUM(ua.cost), 0.0, 0,
           SUM(ua.completed), SUM(ua.failed), SUM(ua.aborted), SUM(ua.unknown),
           SUM(ua.ttft), SUM(ua.ttft_calls), SUM(ua.rate_output), SUM(ua.rate_elapsed), SUM(ua.rate_calls)
    FROM u_agg ua
    LEFT JOIN model_map mm ON ua.has_req = 1 AND mm.raw = ua.raw_model
    GROUP BY 2, 3";

#[cfg(test)]
pub(super) fn breakdown_sql(filter: &str, public: bool) -> String {
    format!("{}{BREAKDOWN_ARMS_SQL}", ctes_sql(false, filter, public))
}

#[cfg(test)]
pub fn query(
    conn: &Connection,
    from: i64,
    end: i64,
    filter: &str,
    public: bool,
) -> ReadResult<Breakdowns> {
    let mut statement = conn.prepare(&breakdown_sql(filter, public))?;
    let mut builder = BreakdownBuilder::default();
    let rows = statement.query_map(params![from, end], |row| {
        let tag: i64 = row.get(0)?;
        let kind: i64 = row.get(1)?;
        let name: Option<String> = row.get(2)?;
        match tag {
            2 => Ok((tag, kind, name, row.get::<_, i64>(3)?, Counts::default(), Metrics::default())),
            3 | 4 => Ok((tag, kind, name, 0, read_counts(row, 3)?, read_metrics(row, 12)?)),
            _ => unreachable!("unexpected breakdown row tag {tag}"),
        }
    })?;
    for row in rows {
        let (tag, kind, name, sessions, counts, metrics) = row?;
        match tag {
            2 => builder.add_project_sessions(kind, name, sessions),
            3 => builder.add_project_usage(kind, name, counts, metrics),
            4 => builder.add_model(kind, name, counts, metrics),
            _ => unreachable!("unexpected breakdown row tag {tag}"),
        }
    }
    Ok(builder.finish())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::Store;
    use serde::Deserialize;

    #[derive(Default, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Timing {
        sent_at: Option<i64>,
        first_token_at: Option<i64>,
    }

    struct Event {
        #[allow(dead_code)]
        sid: i64,
        #[allow(dead_code)]
        project: Key,
        #[allow(dead_code)]
        model: Key,
        requests: i64,
        counts: Counts,
        stop: Option<String>,
        error: Option<String>,
        start: Option<i64>,
        end: Option<i64>,
        timing: Option<String>,
    }

    impl Metrics {
        fn add(&mut self, event: &Event) {
            if event.requests == 0 {
                return;
            }
            let aborted = event.stop.as_deref() == Some("aborted");
            let failed = !aborted
                && (event.stop.as_deref() == Some("error")
                    || event.error.as_ref().is_some_and(|v| !v.trim().is_empty()));
            match event.stop.as_deref() {
                _ if aborted => self.aborted += event.requests,
                _ if failed => self.failed += event.requests,
                Some("stop" | "toolUse" | "length") => self.completed += event.requests,
                _ => self.unknown += event.requests,
            }
            let timing: Timing = event
                .timing
                .as_deref()
                .and_then(|text| serde_json::from_str(text).ok())
                .unwrap_or_default();
            let plausible = |at: &i64| {
                *at >= 0
                    && event
                        .start
                        .is_none_or(|start| *at >= start.saturating_sub(60_000))
                    && event.end.is_none_or(|end| *at <= end.saturating_add(1_000))
            };
            let request = timing.sent_at.filter(plausible).or(event.start);
            if let (Some(sent), Some(first)) = (request, timing.first_token_at.filter(plausible))
                && first >= sent
                && event.end.is_none_or(|end| end >= first)
            {
                self.ttft += (first - sent) as f64;
                self.ttft_calls += 1;
            }
            if !failed
                && !aborted
                && event.counts.tokens.output > 0
                && let (Some(sent), Some(end)) = (request, event.end)
                && end > sent
            {
                self.elapsed += (end - sent) as f64;
                self.output += event.counts.tokens.output as f64;
                self.rate_calls += 1;
            }
        }
    }

    fn event() -> Event {
        Event {
            sid: 1,
            project: Key("project", Some("p".into())),
            model: Key("model", Some("m".into())),
            requests: 1,
            counts: Counts {
                tokens: Tokens {
                    output: 100,
                    ..Tokens::default()
                },
                ..Counts::default()
            },
            stop: Some("stop".into()),
            error: None,
            start: Some(1000),
            end: Some(2500),
            timing: Some(r#"{"sentAt":1100,"firstTokenAt":1500}"#.into()),
        }
    }

    #[test]
    fn the_rate_spans_whole_calls_weighted_by_time_and_ttft_needs_a_first_token() {
        let mut totals = Metrics::default();
        // 100 tokens over 1.4 s, from the request at 1100 to the end at 2500.
        totals.add(&event());
        // 150 tokens over 3.2 s.
        let mut other = event();
        other.counts.tokens.output = 150;
        other.end = Some(4300);
        other.timing = Some(r#"{"sentAt":1100,"firstTokenAt":1300}"#.into());
        totals.add(&other);
        // Without captured timing the call's own start begins it: 50 tokens over 3.3 s, and no TTFT rather than zero.
        other.timing = None;
        other.counts.tokens.output = 50;
        totals.add(&other);
        let result = totals.finish();
        assert_eq!(result.completed, 3);
        assert_eq!(result.ttft_ms, Some(300.0));
        assert_eq!(result.tokens_per_second, Some(300.0 * 1000.0 / 7900.0));
        assert_eq!((result.ttft_calls, result.rate_calls), (2, 3));
    }

    #[test]
    fn bursts_and_hidden_reasoning_do_not_read_as_fast_streams() {
        let rate = |output, timing: &str, end| {
            let mut call = event();
            call.counts.tokens.output = output;
            call.timing = Some(timing.into());
            call.end = Some(end);
            let mut totals = Metrics::default();
            totals.add(&call);
            totals.finish().tokens_per_second
        };
        // A finished response delivered in one burst: 1,440 tokens 4 ms after a first token that took 24 s. The time
        // after the first token gave 360,000 tok/s; the whole call gives 60.
        assert_eq!(rate(1440, r#"{"sentAt":1000,"firstTokenAt":24996}"#, 25_000), Some(60.0));
        // 48 s of hidden reasoning counted in the output, then a one-second answer: 50 tok/s, not 2,450.
        assert_eq!(rate(2450, r#"{"sentAt":1000,"firstTokenAt":49000}"#, 50_000), Some(50.0));
    }

    #[test]
    fn outcomes_keep_errors_aborts_and_unknown_distinct_and_exclude_failed_speed() {
        let mut totals = Metrics::default();
        for stop in [
            Some("stop"),
            Some("toolUse"),
            Some("length"),
            Some("error"),
            Some("aborted"),
            None,
        ] {
            let mut call = event();
            call.stop = stop.map(str::to_owned);
            if matches!(stop, Some("error" | "aborted")) {
                call.error = Some("not exposed".into());
            }
            totals.add(&call);
        }
        let mut usage = event();
        usage.requests = 0;
        totals.add(&usage);
        let result = totals.finish();
        assert_eq!(
            (
                result.completed,
                result.failed,
                result.aborted,
                result.unknown
            ),
            (3, 1, 1, 1)
        );
        assert_eq!(result.ttft_calls, 6);
        assert_eq!(result.rate_calls, 4);
        assert_eq!(result.tokens_per_second, Some(100.0 * 1000.0 / 1400.0));
    }

    #[test]
    fn malformed_out_of_order_and_implausible_timing_gives_no_ttft_and_the_rate_falls_back_to_the_call_start() {
        for timing in [
            "not json",
            r#"{"firstTokenAt":500}"#,
            r#"{"sentAt":1600,"firstTokenAt":1500}"#,
            r#"{"firstTokenAt":2501}"#,
            r#"{"firstTokenAt":-1}"#,
            r#"{"firstTokenAt":"1500"}"#,
        ] {
            let mut call = event();
            call.timing = Some(timing.into());
            let mut totals = Metrics::default();
            totals.add(&call);
            let result = totals.finish();
            assert_eq!(result.ttft_ms, None, "{timing}");
            let sent = if timing.contains("1600") { 1600.0 } else { 1000.0 };
            assert_eq!(result.tokens_per_second, Some(100.0 * 1000.0 / (2500.0 - sent)), "{timing}");
        }
        let mut call = event();
        call.end = Some(1500);
        let mut totals = Metrics::default();
        totals.add(&call);
        let result = totals.finish();
        assert_eq!(result.ttft_ms, Some(400.0));
        assert_eq!(result.tokens_per_second, Some(250.0));
        // A call that ends before its request has no rate.
        call.end = Some(1100);
        let mut totals = Metrics::default();
        totals.add(&call);
        assert_eq!(totals.finish().tokens_per_second, None);
    }

    #[test]
    fn breakdowns_reconcile_model_changes_summary_usage_and_prompt_only_sessions() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        store.write(|tx| tx.execute_batch(
            "INSERT INTO sessions (sid,id,device,project) VALUES (1,'private','d','secret-project'),(2,'public','d','published'),(3,'prompt','d','published');
             INSERT INTO usage_events (sid,seq,at,requests,input,output,cache_read,cost) VALUES
                (1,1,2000,1,10,100,20,0.25),(1,2,2000,1,20,150,30,0.5),(1,3,2000,0,30,0,40,0.75),(2,1,2000,1,40,10,50,1.0);
             INSERT INTO entries(sid,seq,offset,type,ts) VALUES (3,0,0,'message',2000);
             INSERT INTO model_calls(sid,seq,model,stop_reason,ts,at) VALUES
                (1,1,'relay/gpt-6-luna','stop',1000,2500),(1,2,'gpt-6-luna','error',1000,3000),(2,1,'claude-opus-5-5','toolUse',1000,2500);
             INSERT INTO request_sessions(id,session_id) VALUES(1,'private');
             INSERT INTO requests(id,session_id,rs,device,fidelity,skeleton,block_count,complete,received_at,timing)
                VALUES('request','private',1,'d','payload','{}',0,1,0,'{\"sentAt\":1100,\"firstTokenAt\":1500}');
             UPDATE model_calls SET request_id='request' WHERE sid=1 AND seq=1;"
        )).unwrap();
        store
            .write(|tx| publishing::update(tx, "published", true))
            .unwrap();
        let read = |public, filter| {
            store
                .read(|conn| query(conn, 0, 5000, filter, public))
                .unwrap()
        };
        let owner = read(false, "1");
        assert_eq!(owner.projects.len(), 2);
        assert_eq!(
            owner
                .projects
                .iter()
                .map(|r| r.counts.sessions)
                .sum::<i64>(),
            3
        );
        assert!(
            owner
                .projects
                .iter()
                .any(|r| r.name.as_deref() == Some("secret-project"))
        );
        let model = owner
            .models
            .iter()
            .find(|r| r.name.as_deref() == Some("gpt-6-luna"))
            .unwrap();
        assert_eq!(model.counts.requests, 2);
        assert_eq!(model.counts.sessions, 1);
        assert_eq!(model.metrics.failed, 1);
        assert_eq!(model.metrics.ttft_ms, Some(400.0));
        assert_eq!(model.metrics.tokens_per_second, Some(100.0 * 1000.0 / 1400.0));
        let summary = owner
            .models
            .iter()
            .find(|r| r.kind == "other-usage")
            .unwrap();
        assert_eq!(
            (summary.counts.requests, summary.counts.tokens.input),
            (0, 30)
        );
        for groups in [&owner.projects, &owner.models] {
            assert_eq!(
                groups.iter().map(|r| r.counts.tokens.input).sum::<i64>(),
                100
            );
            assert_eq!(groups.iter().map(|r| r.counts.requests).sum::<i64>(), 3);
            assert_eq!(groups.iter().map(|r| r.counts.cost).sum::<f64>(), 2.5);
        }
        let public = read(true, "1");
        let text = serde_json::to_string(&public.projects).unwrap();
        assert!(!text.contains("secret-project"));
        assert!(text.contains("unpublished"));
        assert!(text.contains("published"));
        let filtered = read(true, publishing::SESSION_FILTER);
        assert_eq!(filtered.projects.len(), 1);
        assert_eq!(filtered.projects[0].name.as_deref(), Some("published"));
        assert_eq!(filtered.projects[0].counts.sessions, 2);
        assert_eq!(filtered.models.len(), 1);
        assert_eq!(filtered.metrics.completed, 1);
        assert_eq!(filtered.metrics.ttft_ms, None);
    }

    #[test]
    fn sql_metrics_match_reference_on_all_timing_and_outcome_edges() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        let cases: Vec<(i64, i64, Option<&str>, Option<&str>, Option<i64>, Option<i64>, Option<&str>, bool)> = vec![
            // (requests, output, stop_reason, error_message, start, end, timing, has_model_call)
            (1, 100, Some("stop"), None, Some(1000), Some(2500), Some(r#"{"sentAt":1100,"firstTokenAt":1500,"firstToken":"text","responseAt":1200}"#), true),
            (1, 150, Some("toolUse"), Some("   \t\n\r "), Some(1000), Some(4300), Some(r#"{"sentAt":1100,"firstTokenAt":1300}"#), true),
            (1, 50, Some("length"), Some(""), Some(1000), Some(4300), None, true),
            // Error message overrides `stop` into failed and excludes from rate, but still counts TTFT.
            (1, 80, Some("stop"), Some("rate limit"), Some(1000), Some(2500), Some(r#"{"sentAt":1100,"firstTokenAt":1500}"#), true),
            (1, 80, Some("error"), None, Some(1000), Some(2500), Some(r#"{"sentAt":1100,"firstTokenAt":1500}"#), true),
            // Aborted takes precedence over error_message.
            (1, 80, Some("aborted"), Some("cancelled"), Some(1000), Some(2500), Some(r#"{"sentAt":1100,"firstTokenAt":1500}"#), true),
            (1, 60, None, None, Some(1000), Some(2500), Some(r#"{"sentAt":1100,"firstTokenAt":1500}"#), true),
            (1, 60, Some("other"), None, Some(1000), Some(2500), Some(r#"{"sentAt":null,"firstTokenAt":1500}"#), true),
            // Multi-request event: outcomes add `requests`, while ttft_calls/rate_calls add 1.
            (2, 120, Some("stop"), None, Some(1000), Some(2200), Some(r#"{"sentAt":1000,"firstTokenAt":1200}"#), true),
            // Summary usage (`requests = 0`): ignored by metrics even if a model_call row exists.
            (0, 500, Some("stop"), None, Some(1000), Some(2000), Some(r#"{"sentAt":1000,"firstTokenAt":1100}"#), true),
            // Usage event with requests > 0 and no matching model_calls row -> unknown, no timing.
            (1, 90, None, None, None, None, None, false),
            // Malformed, wrong-typed, out-of-order, and implausible timing payloads.
            (1, 100, Some("stop"), None, Some(1000), Some(2500), Some("not json"), true),
            (1, 100, Some("stop"), None, Some(1000), Some(2500), Some(""), true),
            (1, 100, Some("stop"), None, Some(1000), Some(2500), Some("123"), true),
            (1, 100, Some("stop"), None, Some(1000), Some(2500), Some(r#"{"firstTokenAt":500}"#), true),
            (1, 100, Some("stop"), None, Some(1000), Some(2500), Some(r#"{"sentAt":1600,"firstTokenAt":1500}"#), true),
            (1, 100, Some("stop"), None, Some(1000), Some(2500), Some(r#"{"firstTokenAt":2501}"#), true),
            (1, 100, Some("stop"), None, Some(1000), Some(2500), Some(r#"{"firstTokenAt":-1}"#), true),
            (1, 100, Some("stop"), None, Some(1000), Some(2500), Some(r#"{"firstTokenAt":"1500"}"#), true),
            (1, 100, Some("stop"), None, Some(1000), Some(2500), Some(r#"{"sentAt":1100,"firstTokenAt":"1500"}"#), true),
            (1, 100, Some("stop"), None, Some(1000), Some(2500), Some(r#"{"sentAt":1100,"firstTokenAt":1500.5}"#), true),
            // Plausibility boundaries: start - 60_000 (ok) vs start - 60_001 (rejected), end + 1_000 vs end + 1_001.
            (1, 100, Some("stop"), None, Some(100_000), Some(105_000), Some(r#"{"sentAt":40000,"firstTokenAt":105000}"#), true),
            (1, 100, Some("stop"), None, Some(100_000), Some(105_000), Some(r#"{"sentAt":39999,"firstTokenAt":106001}"#), true),
            // Zero output, end == sent, end < sent, missing start/end.
            (1, 0, Some("stop"), None, Some(1000), Some(2500), Some(r#"{"sentAt":1100,"firstTokenAt":1500}"#), true),
            (1, 100, Some("stop"), None, Some(1000), Some(1100), Some(r#"{"sentAt":1100,"firstTokenAt":1100}"#), true),
            (1, 100, Some("stop"), None, Some(1000), Some(1050), Some(r#"{"sentAt":1100,"firstTokenAt":1500}"#), true),
            (1, 100, Some("stop"), None, None, Some(2500), Some(r#"{"sentAt":1100,"firstTokenAt":1500}"#), true),
            (1, 100, Some("stop"), None, Some(1000), None, Some(r#"{"sentAt":1100,"firstTokenAt":1500}"#), true),
        ];

        let mut expected = Metrics::default();
        store
            .write(|tx| {
                tx.execute("INSERT INTO sessions (sid, id, device, project) VALUES (1, 's1', 'd', 'p')", [])?;
                tx.execute("INSERT INTO request_sessions (id, session_id) VALUES (1, 's1')", [])?;
                for (i, &(requests, output, stop, error, start, end, timing, has_mc)) in cases.iter().enumerate() {
                    let seq = (i + 1) as i64;
                    tx.execute(
                        "INSERT INTO usage_events (sid, seq, at, requests, input, output, cost) VALUES (1, ?1, 2000, ?2, 10, ?3, 0.25)",
                        params![seq, requests, output],
                    )?;
                    let req_id = if let Some(timing) = timing {
                        let id = format!("req-{seq}");
                        tx.execute(
                            "INSERT INTO requests (id, session_id, rs, device, fidelity, skeleton, block_count, complete, received_at, timing)
                             VALUES (?1, 's1', 1, 'd', 'payload', '{}', 0, 1, 0, ?2)",
                            params![id, timing],
                        )?;
                        Some(id)
                    } else {
                        None
                    };
                    if has_mc {
                        tx.execute(
                            "INSERT INTO model_calls (sid, seq, model, stop_reason, error_message, ts, at, request_id)
                             VALUES (1, ?1, 'm', ?2, ?3, ?4, ?5, ?6)",
                            params![seq, stop, error, start, end, req_id],
                        )?;
                    }
                    let ev = Event {
                        sid: 1,
                        project: Key("project", Some("p".into())),
                        model: if requests == 0 { Key("other-usage", None) } else { Key("model", Some("m".into())) },
                        requests,
                        counts: Counts {
                            sessions: 0,
                            requests,
                            tokens: Tokens { input: 10, output, cache_read: 0, cache_write: 0 },
                            cost: 0.25,
                        },
                        stop: has_mc.then_some(stop).flatten().map(str::to_owned),
                        error: has_mc.then_some(error).flatten().map(str::to_owned),
                        start: has_mc.then_some(start).flatten(),
                        end: has_mc.then_some(end).flatten(),
                        timing: has_mc.then_some(timing).flatten().map(str::to_owned),
                    };
                    expected.add(&ev);
                }
                Ok::<_, rusqlite::Error>(())
            })
            .unwrap();

        let actual = store.read(|conn| query(conn, 0, 5000, "1", false)).unwrap();
        assert_eq!(
            serde_json::to_value(&actual.metrics).unwrap(),
            serde_json::to_value(expected.finish()).unwrap()
        );
        assert_eq!(
            serde_json::to_value(&actual.projects[0].metrics).unwrap(),
            serde_json::to_value(&actual.metrics).unwrap()
        );
    }

    #[test]
    fn sql_bare_model_matches_util_bare_model_and_deduplicates_sessions() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        let samples: &[Option<&str>] = &[
            Some("codex/gpt-6.1-sol"),
            Some("  codex/ gpt-6.1-sol  "),
            Some("gpt-6.1-sol@1m"),
            Some("magpie/codex/gpt-6-luna"),
            Some("grok/grok-4.7@500k"),
            Some("model@a@b"),
            Some("仓库/模型"),
            Some("codex/"),
            Some(" @500k "),
            Some("a/@x"),
            Some("/"),
            Some(""),
            Some("   "),
            None,
        ];
        store
            .write(|tx| {
                tx.execute("INSERT INTO sessions (sid, id, device, project) VALUES (1, 's1', 'd', 'p'), (2, 's2', 'd', 'p')", [])?;
                for (i, &model) in samples.iter().enumerate() {
                    let seq = (i + 1) as i64;
                    tx.execute(
                        "INSERT INTO usage_events (sid, seq, at, requests, input, cost) VALUES (1, ?1, 2000, 1, 10, 0.25)",
                        [seq],
                    )?;
                    tx.execute(
                        "INSERT INTO model_calls (sid, seq, model, stop_reason) VALUES (1, ?1, ?2, 'stop')",
                        params![seq, model],
                    )?;
                }
                // Second session uses a different route of gpt-6.1-sol -> sessions for gpt-6.1-sol must be 2, not 4.
                tx.execute("INSERT INTO usage_events (sid, seq, at, requests, input, cost) VALUES (2, 1, 2000, 1, 10, 0.25)", [])?;
                tx.execute("INSERT INTO model_calls (sid, seq, model, stop_reason) VALUES (2, 1, 'gpt-6.1-sol', 'stop')", [])?;
                Ok::<_, rusqlite::Error>(())
            })
            .unwrap();

        let actual = store.read(|conn| query(conn, 0, 5000, "1", false)).unwrap();
        let by_name: BTreeMap<Option<String>, (i64, i64)> = actual
            .models
            .iter()
            .map(|row| (row.name.clone(), (row.counts.sessions, row.counts.requests)))
            .collect();
        // Three routes on sid=1 + one on sid=2 => 2 distinct sessions, 4 requests.
        assert_eq!(by_name.get(&Some("gpt-6.1-sol".into())), Some(&(2, 4)));
        // Empty string and NULL both map to None (2 requests, 1 session).
        assert_eq!(by_name.get(&None), Some(&(1, 2)));
        for raw in samples.iter().flatten().filter(|s| !s.is_empty()) {
            let expected = crate::util::bare_model(raw).to_owned();
            assert!(
                by_name.contains_key(&Some(expected.clone())),
                "missing normalized model `{expected}` for raw `{raw:?}` in {by_name:?}"
            );
        }
    }
}
