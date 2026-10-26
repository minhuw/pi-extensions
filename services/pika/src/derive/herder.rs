use anyhow::Result;
use rusqlite::{OptionalExtension, Transaction, params};
use serde_json::Value;

use super::{Line, StreamInfo, int_field, str_field, string_field, time_field};
use crate::util::{basename, parse_json_lenient};

struct RunRow {
    rid: i64,
    repo_path: Option<String>,
    title: Option<String>,
    base: Option<String>,
    session_id: Option<String>,
    verdict: Option<String>,
    goal_sha256: Option<String>,
    plan_sha256: Option<String>,
    goal_approved: bool,
    delivered: bool,
    finished_status: Option<String>,
    started_at: Option<i64>,
    last_at: i64,
    event_count: i64,
    step_count: i64,
}

#[derive(Default)]
struct StepRow {
    id: Option<String>,
    task: Option<String>,
    role: Option<String>,
    label: Option<String>,
    phase: Option<String>,
    status: String,
    attempts: i64,
    launch: Option<i64>,
    session_id: Option<String>,
    session_file: Option<String>,
    commit_sha: Option<String>,
    error: Option<String>,
    started_at: Option<i64>,
    ended_at: Option<i64>,
    first_seq: i64,
}

pub fn create(tx: &Transaction, info: &StreamInfo) -> Result<()> {
    tx.prepare_cached("INSERT INTO herder_runs (rid, run_id, device, status) VALUES (?1, ?2, ?3, 'drafting')")?
        .execute(params![info.id, info.name, info.device])?;
    Ok(())
}

fn load_run(tx: &Transaction, rid: i64) -> Result<RunRow> {
    Ok(tx
        .prepare_cached(
            "SELECT repo_path, title, base, session_id, verdict, goal_sha256, plan_sha256, goal_approved, delivered,
                    finished_status, started_at, last_at, event_count, step_count
             FROM herder_runs WHERE rid = ?1",
        )?
        .query_row([rid], |r| {
            Ok(RunRow {
                rid,
                repo_path: r.get(0)?,
                title: r.get(1)?,
                base: r.get(2)?,
                session_id: r.get(3)?,
                verdict: r.get(4)?,
                goal_sha256: r.get(5)?,
                plan_sha256: r.get(6)?,
                goal_approved: r.get(7)?,
                delivered: r.get(8)?,
                finished_status: r.get(9)?,
                started_at: r.get(10)?,
                last_at: r.get(11)?,
                event_count: r.get(12)?,
                step_count: r.get(13)?,
            })
        })?)
}

fn save_run(tx: &Transaction, run: &RunRow) -> Result<()> {
    let status = run.finished_status.as_deref().unwrap_or(if run.delivered {
        "delivered"
    } else if run.goal_approved {
        "approved"
    } else {
        "drafting"
    });
    tx.prepare_cached(
        "UPDATE herder_runs SET repo = ?2, repo_path = ?3, title = ?4, base = ?5, session_id = ?6, status = ?7,
             verdict = ?8, goal_sha256 = ?9, plan_sha256 = ?10, goal_approved = ?11, delivered = ?12,
             finished_status = ?13, started_at = ?14, last_at = ?15, event_count = ?16, step_count = ?17
         WHERE rid = ?1",
    )?
    .execute(params![
        run.rid,
        run.repo_path.as_deref().map(basename),
        run.repo_path,
        run.title,
        run.base,
        run.session_id,
        status,
        run.verdict,
        run.goal_sha256,
        run.plan_sha256,
        run.goal_approved,
        run.delivered,
        run.finished_status,
        run.started_at,
        run.last_at,
        run.event_count,
        run.step_count,
    ])?;
    Ok(())
}

fn load_step(tx: &Transaction, rid: i64, key: &str) -> Result<Option<StepRow>> {
    Ok(tx
        .prepare_cached(
            "SELECT id, task, role, label, phase, status, attempts, launch, session_id, session_file, commit_sha, error,
                    started_at, ended_at, first_seq
             FROM herder_steps WHERE rid = ?1 AND key = ?2",
        )?
        .query_row(params![rid, key], |r| {
            Ok(StepRow {
                id: r.get(0)?,
                task: r.get(1)?,
                role: r.get(2)?,
                label: r.get(3)?,
                phase: r.get(4)?,
                status: r.get(5)?,
                attempts: r.get(6)?,
                launch: r.get(7)?,
                session_id: r.get(8)?,
                session_file: r.get(9)?,
                commit_sha: r.get(10)?,
                error: r.get(11)?,
                started_at: r.get(12)?,
                ended_at: r.get(13)?,
                first_seq: r.get(14)?,
            })
        })
        .optional()?)
}

fn save_step(tx: &Transaction, rid: i64, key: &str, s: &StepRow) -> Result<()> {
    tx.prepare_cached(
        "INSERT OR REPLACE INTO herder_steps (rid, key, id, task, role, label, phase, status, attempts, launch,
             session_id, session_file, commit_sha, error, started_at, ended_at, first_seq)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)",
    )?
    .execute(params![
        rid,
        key,
        s.id,
        s.task,
        s.role,
        s.label,
        s.phase,
        s.status,
        s.attempts,
        s.launch,
        s.session_id,
        s.session_file,
        s.commit_sha,
        s.error,
        s.started_at,
        s.ended_at,
        s.first_seq,
    ])?;
    Ok(())
}

fn step_event(tx: &Transaction, run: &mut RunRow, seq: i64, at: Option<i64>, t: &str, v: &Value) -> Result<()> {
    let Some(key) = str_field(v, "key") else { return Ok(()) };
    let mut step = match load_step(tx, run.rid, key)? {
        Some(step) => step,
        None => {
            run.step_count += 1;
            StepRow { first_seq: seq, ..StepRow::default() }
        }
    };
    if let Some(session_id) = string_field(v, "sessionId") {
        step.session_id = Some(session_id);
    }
    if let Some(session_file) = string_field(v, "sessionFile") {
        step.session_file = Some(session_file);
    }
    let attempt = int_field(v, "attempt");
    step.attempts = step.attempts.max(attempt.unwrap_or(0));
    match t {
        "step.started" => {
            step.id = string_field(v, "id").or(step.id);
            step.task = string_field(v, "task").or(step.task);
            step.role = string_field(v, "role").or(step.role);
            step.label = string_field(v, "label").or(step.label);
            step.phase = string_field(v, "phase").or(step.phase);
            step.launch = int_field(v, "launch").or(step.launch);
            step.status = "running".into();
            step.error = None;
            step.ended_at = None;
            step.started_at = step.started_at.or(at);
        }
        "step.completed" => {
            step.status = string_field(v, "status").unwrap_or_else(|| "ok".into());
            step.commit_sha = string_field(v, "commit").or(step.commit_sha);
            step.error = None;
            step.ended_at = at;
        }
        _ => {
            let stopped = str_field(v, "errorClass") == Some("stopped");
            step.status = if stopped { "stopped" } else { "failed" }.into();
            step.error = string_field(v, "message");
            step.ended_at = at;
        }
    }
    save_step(tx, run.rid, key, &step)
}

pub fn apply(tx: &Transaction, info: &StreamInfo, lines: &[Line]) -> Result<()> {
    let mut run = load_run(tx, info.id)?;
    for line in lines {
        let v: Value = parse_json_lenient(line.text).ok().filter(Value::is_object).unwrap_or(Value::Null);
        let t = str_field(&v, "t");
        let at = time_field(&v, "at");
        tx.prepare_cached("INSERT OR REPLACE INTO herder_events (rid, seq, offset, t, at) VALUES (?1, ?2, ?3, ?4, ?5)")?
            .execute(params![info.id, line.seq, line.offset, t, at])?;
        run.event_count = line.seq + 1;
        if let Some(at) = at {
            run.last_at = run.last_at.max(at);
            run.started_at.get_or_insert(at);
        }
        match t.unwrap_or("") {
            "run.started" => {
                if run.title.is_none() {
                    run.title = string_field(&v, "title");
                    run.repo_path = string_field(&v, "repo");
                    run.base = string_field(&v, "base");
                }
                if let Some(session_id) = string_field(&v, "sessionId") {
                    run.session_id = Some(session_id);
                }
            }
            "goal.approved" => {
                run.goal_approved = true;
                run.goal_sha256 = string_field(&v, "sha256");
            }
            "plan.updated" => run.plan_sha256 = string_field(&v, "sha256"),
            t @ ("step.started" | "step.completed" | "step.failed") => step_event(tx, &mut run, line.seq, at, t, &v)?,
            "verify.completed" => run.verdict = string_field(&v, "verdict"),
            "delivery.completed" => run.delivered = true,
            "run.finished" => run.finished_status = string_field(&v, "status"),
            _ => {}
        }
    }
    save_run(tx, &run)
}
