//! Usage attribution over the same dated ledger as the totals. No source lines or request payloads are read.
use std::collections::{BTreeMap, BTreeSet};

use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};

use super::{Counts, ReadResult, Tokens, publishing};

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
struct Metrics {
    completed: i64,
    failed: i64,
    aborted: i64,
    unknown: i64,
    ttft: f64,
    ttft_calls: i64,
    output: f64,
    elapsed: f64,
    rate_calls: i64,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Timing {
    sent_at: Option<i64>,
    first_token_at: Option<i64>,
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
        // The same plausibility window as trace timing, followed by ordering checks rather than invented/clamped times.
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
        // The rate spans the whole call, from the request to the last token. Many responses arrive in one burst once the
        // model has finished, and hidden reasoning counts in `output` but streams nothing, so the time after the first
        // token says nothing about how fast the output was written; the whole call's time always includes it.
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

    fn finish(self) -> RequestMetrics {
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

struct Event {
    sid: i64,
    project: Key,
    model: Key,
    requests: i64,
    counts: Counts,
    stop: Option<String>,
    error: Option<String>,
    start: Option<i64>,
    end: Option<i64>,
    timing: Option<String>,
}

#[derive(Default)]
struct Group {
    counts: Counts,
    sessions: BTreeSet<i64>,
    metrics: Metrics,
}

impl Group {
    fn add(&mut self, event: &Event) {
        self.sessions.insert(event.sid);
        self.counts.requests += event.requests;
        self.counts.tokens.input += event.counts.tokens.input;
        self.counts.tokens.output += event.counts.tokens.output;
        self.counts.tokens.cache_read += event.counts.tokens.cache_read;
        self.counts.tokens.cache_write += event.counts.tokens.cache_write;
        self.counts.cost += event.counts.cost;
        self.metrics.add(event);
    }
}

fn project_key(name: Option<String>, visible: bool, public: bool) -> Key {
    if public && !visible {
        Key("unpublished", None)
    } else {
        Key("project", name.filter(|name| !name.is_empty()))
    }
}

fn finish(groups: BTreeMap<Key, Group>) -> Vec<Breakdown> {
    let mut rows: Vec<_> = groups
        .into_iter()
        .map(|(Key(kind, name), mut group)| {
            group.counts.sessions = group.sessions.len() as i64;
            Breakdown {
                kind,
                name,
                counts: group.counts,
                metrics: group.metrics.finish(),
            }
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

pub fn query(
    conn: &Connection,
    from: i64,
    end: i64,
    filter: &str,
    public: bool,
) -> ReadResult<Breakdowns> {
    let mut projects = BTreeMap::<Key, Group>::new();
    let mut models = BTreeMap::<Key, Group>::new();
    let mut metrics = Metrics::default();
    let mut query = conn.prepare(&format!(
        "SELECT u.sid, s.project, CASE WHEN ({visible}) THEN 1 ELSE 0 END, u.requests,
                u.input, u.output, u.cache_read, u.cache_write, u.cost,
                m.model, m.stop_reason, m.error_message, m.ts, m.at, r.timing
         FROM usage_events u JOIN sessions s ON s.sid = u.sid
         LEFT JOIN model_calls m ON m.sid = u.sid AND m.seq = u.seq
         LEFT JOIN requests r ON r.id = m.request_id
         WHERE u.at >= ?1 AND u.at < ?2 AND {filter}",
        visible = publishing::SESSION_FILTER
    ))?;
    let rows = query.query_map(params![from, end], |row| {
        let requests: i64 = row.get(3)?;
        let model: Option<String> = row.get(9)?;
        let model = if requests == 0 {
            Key("other-usage", None)
        } else {
            Key(
                "model",
                model
                    .filter(|name| !name.is_empty())
                    .map(|name| crate::util::bare_model(&name).to_owned()),
            )
        };
        Ok(Event {
            sid: row.get(0)?,
            project: project_key(row.get(1)?, row.get(2)?, public),
            model,
            requests,
            counts: Counts {
                sessions: 0,
                requests,
                tokens: Tokens {
                    input: row.get(4)?,
                    output: row.get(5)?,
                    cache_read: row.get(6)?,
                    cache_write: row.get(7)?,
                },
                cost: row.get(8)?,
            },
            stop: row.get(10)?,
            error: row.get(11)?,
            start: row.get(12)?,
            end: row.get(13)?,
            timing: row.get(14)?,
        })
    })?;
    for row in rows {
        let event = row?;
        projects
            .entry(event.project.clone())
            .or_default()
            .add(&event);
        models.entry(event.model.clone()).or_default().add(&event);
        metrics.add(&event);
    }
    // Include prompt-only trajectories in project session counts, just as the top-level activity totals do.
    let mut query = conn.prepare(&format!(
        "SELECT DISTINCT e.sid, s.project, CASE WHEN ({visible}) THEN 1 ELSE 0 END
         FROM entries e JOIN sessions s ON s.sid = e.sid
         WHERE e.ts >= ?1 AND e.ts < ?2 AND {filter}",
        visible = publishing::SESSION_FILTER
    ))?;
    let rows = query.query_map(params![from, end], |row| {
        Ok((
            row.get::<_, i64>(0)?,
            project_key(row.get(1)?, row.get(2)?, public),
        ))
    })?;
    for row in rows {
        let (sid, key) = row?;
        projects.entry(key).or_default().sessions.insert(sid);
    }
    Ok(Breakdowns {
        projects: finish(projects),
        models: finish(models),
        metrics: metrics.finish(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::Store;

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
}
