//! Dreaming (spec "Dreaming" under "Memory"): leases on a project scope through `{base}/api/agent/v1/memory/dream`,
//! the scope's sessions past their checkpoints, renewal, release, and the gates on `auto` leases, and commits that
//! apply every change, advance checkpoints, and record one batch, or write nothing; dream sessions hidden from the
//! public view and from search, with the dream tools scrubbed; and the owner's batch list and revert. Time moves by
//! rewriting the leases' times in the database.

mod common;

use std::collections::BTreeMap;

use axum::Router;
use axum::body::Body;
use axum::http::{Method, Request, StatusCode, header};
use common::*;
use pika::config::{AuthMode, ServerConfig};
use pika::http::{AppState, router};
use pika::store::Store;
use pika::util::{format_iso_ms, now_ms, parse_iso_ms};
use serde_json::{Value, json};
use tower::ServiceExt;

const REPO: &str = "https://github.com/me/widgets";
const KEY: &str = "repo:https://github.com/me/widgets";
const LOCAL: &str = "local:gadgets@laptop";
const MINUTE: i64 = 60_000;
const HOUR: i64 = 60 * MINUTE;
const DAY: i64 = 24 * HOUR;
/// 2026-10-20T00:00:00Z.
const BASE: i64 = 1_792_454_400_000;
const PASSWORD: &str = "correct horse battery";
/// The tables a failed commit must leave alone.
const TABLES: [&str; 6] =
    ["memory_scopes", "memory_notes", "memory_revisions", "memory_dream_leases", "memory_dream_batches", "memory_checkpoints"];

struct Reply {
    status: StatusCode,
    body: Vec<u8>,
}

impl Reply {
    fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }
    fn json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap_or_else(|_| panic!("not JSON: {}", self.text()))
    }
}

struct App {
    env: Env,
    app: Router,
    /// The token of device `laptop` (`DEVICE`), which records the sessions.
    a: String,
    /// Device `b`'s token.
    b: String,
}

impl App {
    fn new() -> App {
        App::with_auth(AuthMode::None)
    }

    fn with_auth(auth: AuthMode) -> App {
        let env = env();
        let a = device(&env.store, DEVICE);
        let b = device(&env.store, "b");
        let mut config = ServerConfig::new(env.dir.path().join("data"));
        config.auth = auth;
        config.password = Some(PASSWORD.into());
        let app = router(AppState::new(env.store.clone(), config).unwrap());
        App { env, app, a, b }
    }

    async fn call(&self, method: Method, path: &str, token: Option<&str>, body: Option<Value>) -> Reply {
        let mut request = Request::builder().method(method).uri(path);
        if let Some(token) = token {
            request = request.header(header::AUTHORIZATION, format!("Bearer {token}"));
        }
        let body = match body {
            Some(body) => {
                request = request.header(header::CONTENT_TYPE, "application/json");
                Body::from(body.to_string())
            }
            None => Body::empty(),
        };
        let response = self.app.clone().oneshot(request.body(body).unwrap()).await.unwrap();
        let status = response.status();
        let body = axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap().to_vec();
        Reply { status, body }
    }

    /// `POST {base}/api/agent/v1/{path}` as `token`.
    async fn post(&self, token: &str, path: &str, body: Value) -> Reply {
        self.call(Method::POST, &format!("/api/agent/v1/{path}"), Some(token), Some(body)).await
    }

    /// A lease request for the widgets repository as `token`.
    async fn lease(&self, token: &str, mode: &str) -> Reply {
        self.post(token, "memory/dream/lease", json!({ "project": "widgets", "repository": REPO, "sessionId": "main", "mode": mode }))
            .await
    }

    /// A lease request as device `laptop` that must be granted.
    async fn granted(&self, mode: &str) -> Value {
        let r = self.lease(&self.a, mode).await;
        assert_eq!(r.status, StatusCode::OK, "{}", r.text());
        r.json()
    }

    async fn commit(&self, token: &str, lease: &Value, body: Value) -> Reply {
        self.post(token, &format!("memory/dream/{}/commit", lease["lease"]["id"].as_str().unwrap()), body).await
    }

    async fn committed(&self, lease: &Value, body: Value) -> Value {
        let r = self.commit(&self.a, lease, body).await;
        assert_eq!(r.status, StatusCode::OK, "{}", r.text());
        r.json()
    }

    async fn renew(&self, token: &str, id: &str) -> Reply {
        self.post(token, &format!("memory/dream/{id}/renew"), json!({})).await
    }

    async fn release(&self, token: &str, id: &str, outcome: &str) -> Reply {
        self.post(token, &format!("memory/dream/{id}/release"), json!({ "outcome": outcome })).await
    }

    async fn released(&self, lease: &Value, outcome: &str) -> Value {
        let r = self.release(&self.a, lease["lease"]["id"].as_str().unwrap(), outcome).await;
        assert_eq!(r.status, StatusCode::OK, "{}", r.text());
        r.json()["lease"].clone()
    }

    /// A v1 save as device `laptop` that must succeed; its note.
    async fn saved(&self, body: Value) -> Value {
        let r = self.post(&self.a, "memory/notes", body).await;
        assert_eq!(r.status, StatusCode::OK, "{}", r.text());
        r.json()["note"].clone()
    }

    /// The agent's `GET memory` for the widgets repository.
    async fn memory(&self) -> Value {
        let r = self.call(Method::GET, &format!("/api/agent/v1/memory?project=widgets&repository={}", encode(REPO)), Some(&self.a), None).await;
        assert_eq!(r.status, StatusCode::OK, "{}", r.text());
        r.json()
    }

    /// The owner's `GET {base}/api/v1/{path}`, which must succeed.
    async fn owner(&self, path: &str) -> Value {
        let r = self.call(Method::GET, &format!("/api/v1/{path}"), None, None).await;
        assert_eq!(r.status, StatusCode::OK, "{path}: {}", r.text());
        r.json()
    }

    fn exec(&self, sql: &str) {
        self.env.store.write(|tx| tx.execute_batch(sql)).unwrap();
    }

    fn count(&self, sql: &str) -> i64 {
        one(&self.env.store, sql).into_values().next().unwrap().as_i64().unwrap()
    }

    fn dump(&self) -> Vec<Vec<BTreeMap<String, Value>>> {
        TABLES.iter().map(|t| query(&self.env.store, &format!("SELECT * FROM {t} ORDER BY 1, 2"))).collect()
    }

    fn checkpoints(&self) -> Vec<(String, String, i64)> {
        query(&self.env.store, "SELECT scope_key, session_id, seq FROM memory_checkpoints ORDER BY 1, 2")
            .into_iter()
            .map(|r| (r["scope_key"].as_str().unwrap().into(), r["session_id"].as_str().unwrap().into(), r["seq"].as_i64().unwrap()))
            .collect()
    }

    /// Moves the lease's times by rewriting its row.
    fn set_lease(&self, lease: &Value, column: &str, value: i64) {
        self.exec(&format!("UPDATE memory_dream_leases SET {column} = {value} WHERE id = '{}'", lease["lease"]["id"].as_str().unwrap()));
    }
}

/// Percent-encodes a query parameter value.
fn encode(s: &str) -> String {
    s.bytes()
        .map(|b| if b.is_ascii_alphanumeric() || b"-._~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") })
        .collect()
}

/// A session's header at `at`, and its session-link entry when `link` is given.
fn header(id: &str, at: i64, link: Option<Value>) -> Vec<String> {
    let mut lines = vec![json!({ "type": "session", "version": 3, "id": id, "timestamp": format_iso_ms(at), "cwd": "/home/me/widgets" }).to_string()];
    if let Some(data) = link {
        lines.push(
            json!({ "type": "custom", "id": "link", "parentId": null, "timestamp": format_iso_ms(at),
                    "customType": "pi-extensions.session-link", "data": data })
            .to_string(),
        );
    }
    lines
}

/// User prompts `from` to `from + n - 1`, prompt `i` at `at + i + 1` seconds.
fn prompts(at: i64, from: usize, n: usize) -> Vec<String> {
    (from..from + n)
        .map(|i| {
            let ts = at + (i as i64 + 1) * 1000;
            json!({ "type": "message", "id": format!("m{i}"), "parentId": null, "timestamp": format_iso_ms(ts),
                    "message": { "role": "user", "content": format!("Prompt {i}"), "timestamp": ts } })
            .to_string()
        })
        .collect()
}

/// Uploads `lines` to the session's stream after `before`, which is already uploaded, as `device` with `meta`.
fn upload_as(store: &Store, device: &str, id: &str, before: &[String], lines: &[String], meta: Value) {
    let mut part = stream(&format!("session:{id}"), "session", byte_len(before), lines);
    part["meta"] = meta;
    let batch: pika::ingest::Batch = serde_json::from_value(json!({ "streams": [part] })).unwrap();
    pika::ingest::apply(store, device, &batch).unwrap();
}

fn repo_meta(id: &str, repository: &str) -> Value {
    json!({ "sessionId": id, "cwd": "/home/me/widgets", "project": "widgets", "repository": repository })
}

/// Records a session of the widgets repository with `n` prompts from `at`; its lines, the last at seq `n`.
fn repo_session(store: &Store, id: &str, at: i64, n: usize) -> Vec<String> {
    let lines = [header(id, at, None), prompts(at, 0, n)].concat();
    upload_as(store, DEVICE, id, &[], &lines, repo_meta(id, REPO));
    lines
}

/// Appends `n` prompts to a session of the widgets repository; its lines after.
fn append(store: &Store, id: &str, lines: Vec<String>, at: i64, n: usize) -> Vec<String> {
    let more = prompts(at, lines.len() - 1, n);
    upload_as(store, DEVICE, id, &lines, &more, repo_meta(id, REPO));
    [lines, more].concat()
}

fn source(session: &str, seq: i64) -> Value {
    json!({ "sessionId": session, "seq": seq })
}

fn save(scope: &str, title: &str, sources: Value) -> Value {
    json!({ "op": "save", "expectedRevision": 0, "scope": scope, "category": "project", "title": title,
            "hook": format!("when {title}"), "body": "", "sources": sources })
}

fn ids(sessions: &Value) -> Vec<String> {
    sessions.as_array().unwrap().iter().map(|s| s["id"].as_str().unwrap().to_owned()).collect()
}

fn ms(value: &Value) -> i64 {
    parse_iso_ms(value.as_str().unwrap()).unwrap()
}

/// AC-1: a grant lists the scope's sessions with new entries, oldest activity first, at most 50, each with `fromSeq`
/// and `toSeq`, leaving out other repositories and dream sessions with their descendants.
#[tokio::test]
async fn a_lease_lists_the_scopes_sessions_oldest_first() {
    let app = App::new();
    let store = &app.env.store;
    // Uploaded newest first, so the order is the sessions' activity, not their arrival.
    for i in (0..52).rev() {
        repo_session(store, &format!("s{i:02}"), BASE + i as i64 * HOUR, 2);
    }
    // A clone URL of the same repository, oldest of all.
    let git = [header("s-git", BASE - DAY, None), prompts(BASE - DAY, 0, 2)].concat();
    upload_as(store, DEVICE, "s-git", &[], &git, repo_meta("s-git", "https://GitHub.com/me/widgets.git"));
    // A dream's own session and a session it started, both older still, and another repository.
    let link = json!({ "kind": "subagent", "agentType": "memory-dream", "parentSessionId": "s00", "description": "memory dream" });
    let dream = [header("dream", BASE - 2 * DAY, Some(link)), prompts(BASE - 2 * DAY, 0, 2)].concat();
    upload_as(store, DEVICE, "dream", &[], &dream, repo_meta("dream", REPO));
    let link = json!({ "kind": "subagent", "agentType": "worker", "parentSessionId": "dream" });
    let child = [header("dream-child", BASE - 2 * DAY, Some(link)), prompts(BASE - 2 * DAY, 0, 2)].concat();
    upload_as(store, DEVICE, "dream-child", &[], &child, repo_meta("dream-child", REPO));
    let other = [header("other", BASE - 3 * DAY, None), prompts(BASE - 3 * DAY, 0, 2)].concat();
    upload_as(store, DEVICE, "other", &[], &other, repo_meta("other", "https://github.com/me/gadgets"));
    assert_eq!(app.count("SELECT COUNT(*) FROM session_links WHERE agent_type = 'memory-dream'"), 1);

    let before = now_ms();
    let granted = app.granted("auto").await;
    let lease = &granted["lease"];
    assert_eq!(lease["scope"], json!({ "key": KEY, "kind": "project", "label": "widgets" }));
    assert_eq!((&lease["mode"], &lease["deviceId"], &lease["sessionId"]), (&json!("auto"), &json!(DEVICE), &json!("main")));
    assert_eq!((&lease["releasedAt"], &lease["outcome"]), (&Value::Null, &Value::Null));
    assert!(ms(&lease["grantedAt"]) >= before);
    assert_eq!(ms(&lease["expiresAt"]) - ms(&lease["grantedAt"]), 15 * MINUTE);

    let sessions = &granted["sessions"];
    let expected: Vec<String> = std::iter::once("s-git".to_owned()).chain((0..49).map(|i| format!("s{i:02}"))).collect();
    assert_eq!(ids(sessions), expected);
    let mut last = i64::MIN;
    for session in sessions.as_array().unwrap() {
        assert_eq!((&session["fromSeq"], &session["toSeq"]), (&json!(0), &json!(2)), "{session}");
        assert_eq!((&session["title"], &session["project"]), (&json!("Prompt 0"), &json!("widgets")));
        assert!(ms(&session["lastAt"]) > last);
        last = ms(&session["lastAt"]);
    }
    // The snapshot is stored with the lease.
    let stored: Value = serde_json::from_str(one(store, "SELECT sessions FROM memory_dream_leases")["sessions"].as_str().unwrap()).unwrap();
    assert_eq!(stored.as_array().unwrap().len(), 50);
    assert_eq!(stored[0], json!({ "id": "s-git", "fromSeq": 0, "toSeq": 2 }));
}

/// AC-1: a local scope lists only its project's sessions recorded from its device.
#[tokio::test]
async fn a_local_scope_lists_its_devices_sessions() {
    let app = App::new();
    let store = &app.env.store;
    let meta = |id: &str, project: &str| json!({ "sessionId": id, "cwd": "/x", "project": project });
    for (device, id, project) in [(DEVICE, "mine", "gadgets"), ("b", "theirs", "gadgets"), (DEVICE, "elsewhere", "widgets")] {
        let lines = [header(id, BASE, None), prompts(BASE, 0, 1)].concat();
        upload_as(store, device, id, &[], &lines, meta(id, project));
    }
    let r = app.post(&app.a, "memory/dream/lease", json!({ "project": "gadgets", "mode": "auto" })).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    let granted = r.json();
    assert_eq!(granted["lease"]["scope"]["key"], LOCAL);
    assert_eq!(ids(&granted["sessions"]), ["mine"]);
    assert_eq!((&granted["sessions"][0]["fromSeq"], &granted["sessions"][0]["toSeq"]), (&json!(0), &json!(1)));
}

/// AC-1 and AC-2: of concurrent lease requests exactly one is granted; the rest, and any later request while the lease
/// lives, are 409 `dream_busy` with its expiry.
#[tokio::test]
async fn concurrent_lease_requests_grant_exactly_one() {
    let app = App::new();
    repo_session(&app.env.store, "s1", BASE, 1);
    let tasks: Vec<_> = (0..8)
        .map(|n| {
            let router = app.app.clone();
            let mode = if n % 2 == 0 { "auto" } else { "manual" };
            let body = json!({ "project": "widgets", "repository": REPO, "mode": mode });
            let request = Request::post("/api/agent/v1/memory/dream/lease")
                .header(header::AUTHORIZATION, format!("Bearer {}", app.a))
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(body.to_string()))
                .unwrap();
            tokio::spawn(async move {
                let response = router.oneshot(request).await.unwrap();
                let status = response.status();
                let body = axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap();
                (status, serde_json::from_slice::<Value>(&body).unwrap())
            })
        })
        .collect();
    let mut replies = Vec::new();
    for task in tasks {
        replies.push(task.await.unwrap());
    }
    let granted: Vec<_> = replies.iter().filter(|(status, _)| *status == StatusCode::OK).collect();
    assert_eq!(granted.len(), 1, "{replies:?}");
    let expires = granted[0].1["lease"]["expiresAt"].clone();
    for (status, body) in replies.iter().filter(|(status, _)| *status != StatusCode::OK) {
        assert_eq!((*status, body), (StatusCode::CONFLICT, &json!({ "error": "dream_busy", "expiresAt": expires })));
    }
    for (token, mode) in [(&app.a, "manual"), (&app.b, "auto"), (&app.b, "manual")] {
        let r = app.lease(token, mode).await;
        assert_eq!((r.status, r.json()), (StatusCode::CONFLICT, json!({ "error": "dream_busy", "expiresAt": expires })));
    }
    assert_eq!(app.count("SELECT COUNT(*) FROM memory_dream_leases"), 1);
}

/// AC-2: `auto` requests wait for activity, a cooldown after a completed dream, and the daily quota; `manual` ones skip
/// all three.
#[tokio::test]
async fn auto_leases_need_activity_a_cooldown_and_quota() {
    let app = App::new();
    let r = app.lease(&app.a, "auto").await;
    assert_eq!(
        (r.status, r.json()),
        (StatusCode::CONFLICT, json!({ "error": "dream_not_due", "reason": "no_activity", "retryAt": null }))
    );
    let manual = app.granted("manual").await;
    assert_eq!(manual["sessions"], json!([]));
    app.released(&manual, "aborted").await;

    repo_session(&app.env.store, "s1", BASE, 2);
    let first = app.granted("auto").await;
    let released = app.released(&first, "completed").await;
    let r = app.lease(&app.a, "auto").await;
    let retry = format_iso_ms(ms(&released["releasedAt"]) + 4 * HOUR);
    assert_eq!((r.status, r.json()), (StatusCode::CONFLICT, json!({ "error": "dream_not_due", "reason": "cooldown", "retryAt": retry })));
    let manual = app.granted("manual").await;
    assert_eq!(ids(&manual["sessions"]), ["s1"]);
    app.released(&manual, "completed").await;
    // Both completed leases are past the cooldown; an aborted one starts none.
    app.exec(&format!("UPDATE memory_dream_leases SET released_at = {} WHERE outcome = 'completed'", now_ms() - 4 * HOUR - 1));
    let second = app.granted("auto").await;
    app.released(&second, "aborted").await;
    let third = app.granted("auto").await;
    app.released(&third, "failed").await;

    // Three `auto` leases today: the fourth waits for the next UTC day; manual leases do not count.
    let granted_at = ms(&third["lease"]["grantedAt"]);
    let r = app.lease(&app.a, "auto").await;
    let tomorrow = format_iso_ms(granted_at - granted_at.rem_euclid(DAY) + DAY);
    assert_eq!((r.status, r.json()), (StatusCode::CONFLICT, json!({ "error": "dream_not_due", "reason": "quota", "retryAt": tomorrow })));
    let manual = app.granted("manual").await;
    app.released(&manual, "aborted").await;
    // Yesterday's leases leave today's quota alone.
    app.set_lease(&first, "granted_at", granted_at - granted_at.rem_euclid(DAY) - 1);
    let fourth = app.granted("auto").await;
    assert_eq!(ids(&fourth["sessions"]), ["s1"]);
}

/// AC-3: the holder renews and releases its lease; another device's, an unknown, a released, or an expired lease is
/// 409 `lease_lost`, and an expired lease blocks no new grant.
#[tokio::test]
async fn leases_renew_release_and_get_lost() {
    let app = App::new();
    repo_session(&app.env.store, "s1", BASE, 1);
    let granted = app.granted("manual").await;
    let id = granted["lease"]["id"].as_str().unwrap().to_owned();
    app.set_lease(&granted, "expires_at", now_ms() + MINUTE);
    let before = now_ms();
    let r = app.renew(&app.a, &id).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    let renewed = r.json()["lease"].clone();
    let expires = ms(&renewed["expiresAt"]);
    assert!(expires >= before + 15 * MINUTE && expires <= now_ms() + 15 * MINUTE, "{renewed}");
    assert_eq!(app.count("SELECT expires_at FROM memory_dream_leases"), expires);
    assert_eq!((&renewed["id"], &renewed["grantedAt"]), (&granted["lease"]["id"], &granted["lease"]["grantedAt"]));

    let lost = json!({ "error": "lease_lost" });
    let commit = json!({ "sessions": ["s1"], "changes": [] });
    for (token, id) in [(&app.b, id.as_str()), (&app.a, "unknown")] {
        let r = app.renew(token, id).await;
        assert_eq!((r.status, r.json()), (StatusCode::CONFLICT, lost.clone()), "renew {id}");
        let r = app.post(token, &format!("memory/dream/{id}/commit"), commit.clone()).await;
        assert_eq!((r.status, r.json()), (StatusCode::CONFLICT, lost.clone()), "commit {id}");
        let r = app.release(token, id, "aborted").await;
        assert_eq!((r.status, r.json()), (StatusCode::CONFLICT, lost.clone()), "release {id}");
    }
    let r = app.release(&app.a, &id, "done").await;
    assert_eq!((r.status, &r.json()["error"]), (StatusCode::BAD_REQUEST, &json!("bad_request")));
    assert_eq!(one(&app.env.store, "SELECT released_at FROM memory_dream_leases")["released_at"], Value::Null);

    // Expired: lost to its holder, and no longer in the way.
    app.set_lease(&granted, "expires_at", now_ms() - 1);
    let r = app.renew(&app.a, &id).await;
    assert_eq!((r.status, r.json()), (StatusCode::CONFLICT, lost.clone()));
    let r = app.commit(&app.a, &granted, commit.clone()).await;
    assert_eq!((r.status, r.json()), (StatusCode::CONFLICT, lost.clone()));
    let next = app.granted("auto").await;
    assert_ne!(next["lease"]["id"], granted["lease"]["id"]);
    // Releasing the expired lease records the outcome; releasing again changes nothing.
    let released = app.released(&granted, "failed").await;
    assert_eq!(released["outcome"], "failed");
    assert!(released["releasedAt"].is_string());
    assert_eq!(app.released(&granted, "completed").await, released);

    let released = app.released(&next, "aborted").await;
    assert_eq!((&released["outcome"], &released["mode"]), (&json!("aborted"), &json!("auto")));
    for r in [app.renew(&app.a, next["lease"]["id"].as_str().unwrap()).await, app.commit(&app.a, &next, commit.clone()).await] {
        assert_eq!((r.status, r.json()), (StatusCode::CONFLICT, lost.clone()));
    }
    assert_eq!(app.count("SELECT COUNT(*) FROM memory_checkpoints"), 0);
    // A released lease no longer blocks either.
    app.granted("manual").await;
}

/// AC-2 with the contract's 400s: a lease request names a project scope and a mode.
#[tokio::test]
async fn bad_lease_requests_are_bad_requests() {
    let app = App::new();
    for body in [
        json!({ "mode": "manual" }),
        json!({ "project": "", "repository": "", "mode": "manual" }),
        json!({ "project": "widgets" }),
        json!({ "project": "widgets", "mode": "nightly" }),
        json!({ "project": "a/b", "mode": "manual" }),
        json!({ "repository": "git@github.com:me/widgets.git", "mode": "manual" }),
    ] {
        let r = app.post(&app.a, "memory/dream/lease", body.clone()).await;
        assert_eq!((r.status, &r.json()["error"]), (StatusCode::BAD_REQUEST, &json!("bad_request")), "{body}");
    }
    assert_eq!(app.count("SELECT COUNT(*) FROM memory_dream_leases"), 0);
}

/// AC-4, AC-5, AC-6: a commit applies its changes as `dream` revisions of one batch with their sources, advances the
/// listed sessions' checkpoints to the lease's `toSeq`, never back, and a later lease lists only newer entries.
#[tokio::test]
async fn commits_write_dream_revisions_and_advance_checkpoints() {
    let app = App::new();
    let store = &app.env.store;
    let tabs = app
        .saved(json!({ "expectedRevision": 0, "scope": "user", "category": "feedback", "title": "Tabs", "hook": "indent with tabs" }))
        .await;
    let old = app
        .saved(json!({ "expectedRevision": 0, "scope": "project", "project": "widgets", "repository": REPO,
                       "category": "project", "title": "Old", "hook": "stale" }))
        .await;
    let s1 = repo_session(store, "s1", BASE, 3);
    repo_session(store, "s2", BASE + HOUR, 1);
    let granted = app.granted("auto").await;
    assert_eq!(ids(&granted["sessions"]), ["s1", "s2"]);

    let mut update = save("user", "Tabs always", json!([source("s2", 1)]));
    update["id"] = tabs["id"].clone();
    update["expectedRevision"] = json!(1);
    update["category"] = json!("feedback");
    let committed = app
        .committed(
            &granted,
            json!({ "dreamSessionId": "dream-1", "summary": "Merged notes", "sessions": ["s1", "s2"], "changes": [
                save("project", "Build", json!([source("s1", 1), source("s1", 2)])),
                update,
                { "op": "forget", "id": old["id"], "expectedRevision": 1, "reason": "stale", "sources": [source("s1", 3)] },
            ] }),
        )
        .await;
    let batch = &committed["batch"];
    let build_id = batch["changes"][0]["noteId"].clone();
    assert_eq!(
        batch,
        &json!({ "id": batch["id"], "leaseId": granted["lease"]["id"], "scope": granted["lease"]["scope"], "mode": "auto",
                 "at": batch["at"], "deviceId": DEVICE, "sessionId": "main", "dreamSessionId": "dream-1",
                 "summary": "Merged notes", "sessions": ["s1", "s2"], "revertedAt": null, "changes": [
                     { "noteId": build_id, "revision": 1, "action": "save", "title": "Build", "created": true },
                     { "noteId": tabs["id"], "revision": 2, "action": "save", "title": "Tabs always", "created": false },
                     { "noteId": old["id"], "revision": 2, "action": "forget", "title": "Old", "created": false },
                 ] })
    );
    let batch_id = batch["id"].as_str().unwrap();
    let index = format!(
        "# User memory\n## feedback\n- Tabs always — when Tabs always [{}]\n# Project memory: widgets\n## project\n- Build — when Build [{}]\n",
        tabs["id"].as_str().unwrap(),
        build_id.as_str().unwrap()
    );
    assert_eq!((&committed["index"], &committed["indexLines"]), (&json!(index), &json!(6)));

    // The agent's and the owner's views carry provenance and sources.
    let memory = app.memory().await;
    assert_eq!(memory["index"], json!(index));
    let notes = memory["notes"].as_array().unwrap();
    assert_eq!((&notes[0]["title"], &notes[0]["provenance"]), (&json!("Tabs always"), &json!("dream")));
    assert_eq!(notes[0]["sources"], json!([source("s2", 1)]));
    assert_eq!((&notes[1]["provenance"], &notes[1]["sessionId"]), (&json!("dream"), &json!("dream-1")));
    assert_eq!(notes[1]["sources"], json!([source("s1", 1), source("s1", 2)]));
    let owner = app.owner(&format!("memory/notes?scope={}", encode(KEY))).await;
    assert_eq!(owner["notes"], json!([notes[1]]));
    let revisions = app.owner(&format!("memory/notes/{}/revisions", tabs["id"].as_str().unwrap())).await["revisions"].clone();
    let summary = |r: &Value| (r["action"].clone(), r["provenance"].clone(), r["sources"].clone(), r["batchId"].clone());
    assert_eq!(summary(&revisions[0]), (json!("save"), json!("agent"), json!([]), Value::Null));
    assert_eq!(summary(&revisions[1]), (json!("save"), json!("dream"), json!([source("s2", 1)]), json!(batch_id)));
    let revisions = app.owner(&format!("memory/notes/{}/revisions", old["id"].as_str().unwrap())).await["revisions"].clone();
    assert_eq!(summary(&revisions[1]), (json!("forget"), json!("dream"), json!([source("s1", 3)]), json!(batch_id)));
    assert_eq!(revisions[1]["reason"], "stale");
    assert_eq!(app.count(&format!("SELECT COUNT(*) FROM memory_revisions WHERE batch_id = '{batch_id}'")), 3);

    assert_eq!(app.checkpoints(), [(KEY.into(), "s1".into(), 3), (KEY.into(), "s2".into(), 1)]);
    // Committing does not end the lease.
    let r = app.renew(&app.a, granted["lease"]["id"].as_str().unwrap()).await;
    assert_eq!(r.status, StatusCode::OK);
    app.released(&granted, "completed").await;
    let past_cooldown = |app: &App| app.exec(&format!("UPDATE memory_dream_leases SET released_at = {}", now_ms() - 5 * HOUR));

    // New entries in s1 only: the next lease lists them alone.
    let s1 = append(store, "s1", s1, BASE + DAY, 2);
    past_cooldown(&app);
    let next = app.granted("auto").await;
    assert_eq!(next["sessions"].as_array().unwrap().len(), 1);
    assert_eq!((&next["sessions"][0]["id"], &next["sessions"][0]["fromSeq"], &next["sessions"][0]["toSeq"]), (&json!("s1"), &json!(4), &json!(5)));
    // A commit of sessions alone records a batch without changes.
    let committed = app.committed(&next, json!({ "sessions": ["s1"] })).await;
    assert_eq!((&committed["batch"]["changes"], &committed["batch"]["sessions"]), (&json!([]), &json!(["s1"])));
    assert_eq!(app.checkpoints()[0], (KEY.into(), "s1".into(), 5));
    app.released(&next, "completed").await;
    past_cooldown(&app);
    let r = app.lease(&app.a, "auto").await;
    assert_eq!((r.status, &r.json()["reason"]), (StatusCode::CONFLICT, &json!("no_activity")));

    // A checkpoint never moves back, even when a lease's snapshot is behind it.
    append(store, "s1", s1, BASE + 2 * DAY, 1);
    let behind = app.granted("manual").await;
    assert_eq!(behind["sessions"][0]["toSeq"], 6);
    app.exec(&format!("UPDATE memory_checkpoints SET seq = 100 WHERE scope_key = '{KEY}' AND session_id = 's1'"));
    app.committed(&behind, json!({ "sessions": ["s1"] })).await;
    assert_eq!(app.checkpoints(), [(KEY.into(), "s1".into(), 100), (KEY.into(), "s2".into(), 1)]);
    assert_eq!(app.count("SELECT COUNT(*) FROM memory_dream_batches"), 3);
}

/// AC-4, AC-5: a commit with a conflicting, invalid, or over-budget change, or a session outside its lease, writes
/// nothing and moves no checkpoint.
#[tokio::test]
async fn failed_commits_write_nothing() {
    let app = App::new();
    let store = &app.env.store;
    let tabs = app
        .saved(json!({ "expectedRevision": 0, "scope": "user", "category": "feedback", "title": "Tabs", "hook": "indent with tabs" }))
        .await;
    repo_session(store, "s1", BASE, 2);
    repo_session(store, "s2", BASE + HOUR, 1);
    let granted = app.granted("manual").await;
    // Recorded, but not in the lease.
    repo_session(store, "s3", BASE + 2 * HOUR, 1);
    let before = app.dump();
    let ok = save("project", "Build", json!([source("s1", 1)]));

    let mut stale = save("user", "Spaces", json!([source("s1", 2)]));
    stale["id"] = tabs["id"].clone();
    stale["expectedRevision"] = json!(5);
    let r = app.commit(&app.a, &granted, json!({ "sessions": ["s1"], "changes": [ok, stale] })).await;
    assert_eq!((r.status, r.json()), (StatusCode::CONFLICT, json!({ "error": "revision_conflict", "note": tabs, "change": 1 })));
    assert_eq!(app.dump(), before);
    let forget = json!({ "op": "forget", "id": tabs["id"], "expectedRevision": 0 });
    let r = app.commit(&app.a, &granted, json!({ "sessions": ["s1", "s2"], "changes": [forget] })).await;
    assert_eq!((r.status, r.json()), (StatusCode::CONFLICT, json!({ "error": "revision_conflict", "note": tabs, "change": 0 })));
    assert_eq!(app.dump(), before);

    let with = |change: Value| json!({ "sessions": ["s1"], "changes": [ok, change] });
    let mut bad_category = save("project", "X", json!([source("s1", 1)]));
    bad_category["category"] = json!("misc");
    let mut bad_scope = save("project", "X", json!([source("s1", 1)]));
    bad_scope["scope"] = json!("team");
    let mut unknown = save("project", "X", json!([source("s1", 1)]));
    unknown["id"] = json!("000000000000");
    unknown["expectedRevision"] = json!(1);
    let many: Vec<Value> = (0..21).map(|seq| source("s1", seq % 3)).collect();
    let cases = [
        ("nothing to commit", json!({ "sessions": [], "changes": [] })),
        ("51 changes", json!({ "sessions": ["s1"], "changes": vec![ok.clone(); 51] })),
        ("a session outside the lease", json!({ "sessions": ["s1", "s3"], "changes": [ok] })),
        ("an unknown session", json!({ "sessions": ["nope"] })),
        ("a bad category", with(bad_category)),
        ("a bad scope", with(bad_scope)),
        ("an unknown note", with(unknown)),
        ("a save without sources", with(save("project", "X", json!([])))),
        ("a save with 21 sources", with(save("project", "X", json!(many)))),
        ("an unrecorded source session", with(save("project", "X", json!([source("nope", 0)])))),
        ("a source seq past the session", with(save("project", "X", json!([source("s1", 3)])))),
        ("a negative source seq", with(save("project", "X", json!([source("s1", -1)])))),
        ("a forget with 21 sources", with(json!({ "op": "forget", "id": tabs["id"], "expectedRevision": 1, "sources": many }))),
        ("an unknown op", with(json!({ "op": "rename", "id": tabs["id"] }))),
        ("a long summary", json!({ "summary": "s".repeat(1001), "sessions": ["s1"] })),
    ];
    for (name, body) in cases {
        let r = app.commit(&app.a, &granted, body).await;
        assert_eq!((r.status, &r.json()["error"]), (StatusCode::BAD_REQUEST, &json!("bad_request")), "{name}: {}", r.text());
        assert_eq!(app.dump(), before, "{name}");
    }

    // 30 long index lines pass 8 KiB.
    let long: Vec<Value> = (0..30)
        .map(|n| {
            let mut change = save("project", &format!("{n:02}{}", "t".repeat(118)), json!([source("s2", 1)]));
            change["hook"] = json!("h".repeat(150));
            change
        })
        .collect();
    let r = app.commit(&app.a, &granted, json!({ "sessions": ["s1", "s2"], "changes": long })).await;
    let body = r.json();
    assert_eq!((r.status, &body["error"]), (StatusCode::UNPROCESSABLE_ENTITY, &json!("memory_full")), "{body}");
    assert!(body["indexBytes"].as_u64().unwrap() > 8192);
    assert_eq!((&body["limitBytes"], &body["limitLines"]), (&json!(8192), &json!(200)));
    assert_eq!(app.dump(), before);

    // The lease survives the failures.
    app.committed(&granted, json!({ "sessions": ["s1"], "changes": [ok] })).await;
    assert_eq!(app.checkpoints(), [(KEY.into(), "s1".into(), 2)]);
}

/// AC-6: `pika reindex` keeps leases, batches, checkpoints, and dream revisions.
#[tokio::test]
async fn reindex_keeps_leases_batches_and_checkpoints() {
    let app = App::new();
    repo_session(&app.env.store, "s1", BASE, 2);
    let granted = app.granted("auto").await;
    app.committed(&granted, json!({ "sessions": ["s1"], "changes": [save("project", "Build", json!([source("s1", 1)]))] })).await;
    app.released(&granted, "completed").await;
    let before = app.dump();
    assert!(before.iter().all(|rows| !rows.is_empty()));
    pika::reindex::reindex(&app.env.store).unwrap();
    assert_eq!(app.dump(), before);
    assert!(!pika::store::DERIVED_TABLES.iter().any(|t| t.starts_with("memory_")));
    // The checkpoint still applies: nothing new to dream about.
    app.exec(&format!("UPDATE memory_dream_leases SET released_at = {}", now_ms() - 5 * HOUR));
    let r = app.lease(&app.a, "auto").await;
    assert_eq!((r.status, &r.json()["reason"]), (StatusCode::CONFLICT, &json!("no_activity")));
}

/// AC-9: deleting a project deletes its scopes' leases, batches, and checkpoints; deleting a session deletes its
/// checkpoints.
#[tokio::test]
async fn deletes_take_leases_batches_and_checkpoints() {
    let app = App::new();
    let store = &app.env.store;
    repo_session(store, "s1", BASE, 2);
    let local = |id: &str| {
        let lines = [header(id, BASE, None), prompts(BASE, 0, 1)].concat();
        upload_as(store, DEVICE, id, &[], &lines, json!({ "sessionId": id, "cwd": "/x", "project": "gadgets" }));
    };
    local("g1");
    local("g2");
    let granted = app.granted("auto").await;
    app.committed(&granted, json!({ "sessions": ["s1"], "changes": [save("project", "Build", json!([source("s1", 1)]))] })).await;
    let r = app.post(&app.a, "memory/dream/lease", json!({ "project": "gadgets", "mode": "manual" })).await;
    let gadgets = r.json();
    assert_eq!(ids(&gadgets["sessions"]), ["g1", "g2"]);
    app.committed(&gadgets, json!({ "sessions": ["g1", "g2"] })).await;
    // The same session consolidated in another scope too.
    app.exec("INSERT INTO memory_checkpoints (scope_key, session_id, seq) VALUES ('user', 'g1', 1)");
    let rows = |key: &str| {
        ["memory_dream_leases", "memory_dream_batches", "memory_checkpoints"]
            .map(|t| app.count(&format!("SELECT COUNT(*) FROM {t} WHERE scope_key = '{key}'")))
    };
    assert_eq!((rows(KEY), rows(LOCAL)), ([1, 1, 1], [1, 1, 2]));

    let r = app.call(Method::DELETE, "/api/v1/sessions/g1", None, None).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    assert_eq!(
        app.checkpoints(),
        [(LOCAL.into(), "g2".into(), 1), (KEY.into(), "s1".into(), 2)]
    );
    assert_eq!(rows(LOCAL), [1, 1, 1]);

    let r = app.call(Method::DELETE, "/api/v1/projects/widgets", None, None).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    assert_eq!((rows(KEY), rows(LOCAL)), ([0, 0, 0], [1, 1, 1]));
    assert_eq!(app.count("SELECT COUNT(*) FROM memory_revisions WHERE batch_id IS NOT NULL"), 0);
    // The scope starts over: a new lease is granted.
    repo_session(store, "s4", BASE, 1);
    assert_eq!(ids(&app.granted("auto").await["sessions"]), ["s4"]);
}

/// Schema version 15 adds the dream tables and columns to a version 14 database without a reindex; existing notes and
/// revisions are the agents', without sources.
#[test]
fn an_older_database_gains_the_dream_tables() {
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");
    {
        let store = Store::open(&data).unwrap();
        device(&store, DEVICE);
        let request = serde_json::from_value(json!({ "expectedRevision": 0, "scope": "user", "category": "user",
                                                     "title": "Role", "hook": "a developer" }))
        .unwrap();
        store.write(|tx| pika::memory::save(tx, DEVICE, request)).unwrap();
    }
    let conn = rusqlite::Connection::open(data.join("pika.db")).unwrap();
    conn.execute_batch(&format!("{UNDO_V15} PRAGMA user_version = 14;")).unwrap();
    drop(conn);
    let store = Store::open(&data).unwrap();
    assert_eq!(one(&store, "PRAGMA user_version")["user_version"], json!(15));
    assert_eq!(store.setting("needs_reindex").unwrap(), None);
    assert_eq!(one(&store, "SELECT sources FROM memory_notes")["sources"], json!("[]"));
    let revision = one(&store, "SELECT provenance, sources, batch_id FROM memory_revisions");
    assert_eq!((&revision["provenance"], &revision["sources"], &revision["batch_id"]), (&json!("agent"), &json!("[]"), &Value::Null));
    assert_eq!(
        one(&store, "SELECT COUNT(*) AS n FROM memory_dream_leases, memory_dream_batches, memory_checkpoints")["n"],
        json!(0)
    );
}

/// The dream routes need a device token with read access, like the other memory routes.
#[tokio::test]
async fn dream_routes_need_read_access() {
    let app = App::new();
    pika::auth::update_device(&app.env.store, "b", None, Some(false)).unwrap();
    let paths = ["memory/dream/lease", "memory/dream/x/renew", "memory/dream/x/commit", "memory/dream/x/release"];
    for path in paths {
        let path = format!("/api/agent/v1/{path}");
        let r = app.call(Method::POST, &path, None, Some(json!({}))).await;
        assert_eq!((r.status, r.json()), (StatusCode::UNAUTHORIZED, json!({ "error": "unauthorized" })), "{path}");
        let r = app.call(Method::POST, &path, Some(&app.b), Some(json!({}))).await;
        assert_eq!((r.status, r.json()), (StatusCode::FORBIDDEN, json!({ "error": "read_access_denied" })), "{path}");
    }
}

/// AC-4, AC-6: a commit advances a checkpoint to the lease's `toSeq`, not to entries recorded after the grant, so the
/// next lease lists those; sessions the commit leaves out keep their old checkpoint.
#[tokio::test]
async fn checkpoints_advance_to_the_snapshot_not_the_live_stream() {
    let app = App::new();
    let store = &app.env.store;
    let s1 = repo_session(store, "s1", BASE, 2);
    repo_session(store, "s2", BASE + HOUR, 1);
    let granted = app.granted("manual").await;
    assert_eq!(granted["sessions"][0]["toSeq"], 2);
    // s1 grows while the dream runs.
    append(store, "s1", s1, BASE + 2 * HOUR, 2);
    app.committed(&granted, json!({ "sessions": ["s1"] })).await;
    assert_eq!(app.checkpoints(), [(KEY.into(), "s1".into(), 2)]);
    app.released(&granted, "completed").await;

    let next = app.granted("manual").await;
    let sessions: Vec<_> = next["sessions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| (s["id"].as_str().unwrap().to_owned(), s["fromSeq"].as_i64().unwrap(), s["toSeq"].as_i64().unwrap()))
        .collect();
    assert_eq!(sessions, [("s2".to_owned(), 0, 1), ("s1".to_owned(), 3, 4)]);
}

/// AC-1, AC-6: the 50-session limit applies to sessions with new entries, so once a commit consolidates the first 50
/// the next lease lists the rest.
#[tokio::test]
async fn the_next_lease_lists_the_sessions_past_the_limit() {
    let app = App::new();
    for i in 0..53 {
        repo_session(&app.env.store, &format!("s{i:02}"), BASE + i as i64 * HOUR, 1);
    }
    let granted = app.granted("manual").await;
    let listed = ids(&granted["sessions"]);
    assert_eq!(listed.len(), 50);
    app.committed(&granted, json!({ "sessions": listed })).await;
    app.released(&granted, "completed").await;
    let next = app.granted("manual").await;
    assert_eq!(ids(&next["sessions"]), ["s50", "s51", "s52"]);
}

/// AC-1: every descendant of a dream session is left out, not just its children; a repository scope lists the
/// repository's sessions from every device.
#[tokio::test]
async fn dream_descendants_are_excluded_and_repo_scopes_span_devices() {
    let app = App::new();
    let store = &app.env.store;
    repo_session(store, "s1", BASE, 1);
    let chain = [
        ("dream", json!({ "kind": "subagent", "agentType": "memory-dream", "parentSessionId": "s1", "description": "memory dream" })),
        ("child", json!({ "kind": "subagent", "agentType": "worker", "parentSessionId": "dream" })),
        ("grandchild", json!({ "kind": "subagent", "agentType": "worker", "parentSessionId": "child" })),
    ];
    for (id, link) in chain {
        let lines = [header(id, BASE + HOUR, Some(link)), prompts(BASE + HOUR, 0, 1)].concat();
        upload_as(store, DEVICE, id, &[], &lines, repo_meta(id, REPO));
    }
    let lines = [header("theirs", BASE + 2 * HOUR, None), prompts(BASE + 2 * HOUR, 0, 1)].concat();
    upload_as(store, "b", "theirs", &[], &lines, repo_meta("theirs", REPO));
    let granted = app.granted("manual").await;
    assert_eq!(ids(&granted["sessions"]), ["s1", "theirs"]);
}

/// AC-2: leases, cooldowns, and quotas are per scope: a live or completed lease on one project leaves another alone.
#[tokio::test]
async fn gates_are_per_scope() {
    let app = App::new();
    let store = &app.env.store;
    repo_session(store, "s1", BASE, 1);
    let lines = [header("g1", BASE, None), prompts(BASE, 0, 1)].concat();
    upload_as(store, DEVICE, "g1", &[], &lines, json!({ "sessionId": "g1", "cwd": "/x", "project": "gadgets" }));
    let widgets = app.granted("auto").await;
    let gadgets = json!({ "project": "gadgets", "mode": "auto" });
    let r = app.post(&app.a, "memory/dream/lease", gadgets.clone()).await;
    assert_eq!(r.status, StatusCode::OK, "a live widgets lease blocks gadgets: {}", r.text());
    app.post(&app.a, &format!("memory/dream/{}/release", r.json()["lease"]["id"].as_str().unwrap()), json!({ "outcome": "aborted" }))
        .await;
    app.released(&widgets, "completed").await;
    let r = app.post(&app.a, "memory/dream/lease", gadgets).await;
    assert_eq!(r.status, StatusCode::OK, "a completed widgets dream cools gadgets down: {}", r.text());
}

/// AC-4: changes apply in order, so a later change sees the revision an earlier one wrote; a later change that expects
/// the old revision conflicts and the whole commit writes nothing.
#[tokio::test]
async fn changes_in_a_commit_apply_in_order() {
    let app = App::new();
    let tabs = app
        .saved(json!({ "expectedRevision": 0, "scope": "user", "category": "feedback", "title": "Tabs", "hook": "indent with tabs" }))
        .await;
    repo_session(&app.env.store, "s1", BASE, 2);
    let granted = app.granted("manual").await;
    let update = |title: &str, expected: i64| {
        let mut change = save("user", title, json!([source("s1", 1)]));
        change["id"] = tabs["id"].clone();
        change["category"] = json!("feedback");
        change["expectedRevision"] = json!(expected);
        change
    };
    let before = app.dump();
    let r = app.commit(&app.a, &granted, json!({ "sessions": ["s1"], "changes": [update("Two", 1), update("Again", 1)] })).await;
    let body = r.json();
    assert_eq!((r.status, &body["error"], &body["change"], &body["note"]["revision"]),
               (StatusCode::CONFLICT, &json!("revision_conflict"), &json!(1), &json!(2)), "{body}");
    assert_eq!(app.dump(), before);

    let committed = app
        .committed(&granted, json!({ "sessions": ["s1"], "changes": [update("Two", 1), update("Three", 2), {
            "op": "forget", "id": tabs["id"], "expectedRevision": 3 }] }))
        .await;
    let revisions: Vec<_> = committed["batch"]["changes"].as_array().unwrap().iter().map(|c| (c["revision"].clone(), c["action"].clone())).collect();
    assert_eq!(revisions, [(json!(2), json!("save")), (json!(3), json!("save")), (json!(4), json!("forget"))]);
    assert_eq!(app.count("SELECT revision FROM memory_notes"), 4);
}

/// AC-4: a commit edits only the user scope and the lease's scope; naming a note of another project is a 400 that
/// writes nothing.
#[tokio::test]
async fn commits_cannot_touch_other_scopes() {
    let app = App::new();
    let other = app
        .saved(json!({ "expectedRevision": 0, "scope": "project", "project": "gadgets", "category": "project",
                       "title": "Gadget", "hook": "elsewhere" }))
        .await;
    let user = app
        .saved(json!({ "expectedRevision": 0, "scope": "user", "category": "feedback", "title": "Tabs", "hook": "indent with tabs" }))
        .await;
    repo_session(&app.env.store, "s1", BASE, 1);
    let granted = app.granted("manual").await;
    let before = app.dump();
    let mut into_other = save("project", "Moved", json!([source("s1", 1)]));
    into_other["id"] = other["id"].clone();
    into_other["expectedRevision"] = json!(1);
    let mut user_as_project = save("project", "Tabs", json!([source("s1", 1)]));
    user_as_project["id"] = user["id"].clone();
    user_as_project["expectedRevision"] = json!(1);
    for (name, change) in [
        ("forget another project's note", json!({ "op": "forget", "id": other["id"], "expectedRevision": 1 })),
        ("update another project's note", into_other),
        ("update a user note as a project note", user_as_project),
    ] {
        let r = app.commit(&app.a, &granted, json!({ "sessions": ["s1"], "changes": [save("project", "Ok", json!([source("s1", 1)])), change] })).await;
        assert_eq!((r.status, &r.json()["error"]), (StatusCode::BAD_REQUEST, &json!("bad_request")), "{name}: {}", r.text());
        assert_eq!(app.dump(), before, "{name}");
    }
}

/// AC-4, AC-5: exactly 50 changes, 20 sources, and a 1000-character summary are within the limits.
#[tokio::test]
async fn commits_at_the_limits_are_accepted() {
    let app = App::new();
    repo_session(&app.env.store, "s1", BASE, 20);
    let granted = app.granted("manual").await;
    let twenty: Vec<Value> = (1..=20).map(|seq| source("s1", seq)).collect();
    let mut changes: Vec<Value> = (0..49).map(|n| save("project", &format!("N{n:02}"), json!([source("s1", 1)]))).collect();
    changes.push(save("project", "Twenty", json!(twenty)));
    let committed = app.committed(&granted, json!({ "summary": "s".repeat(1000), "sessions": ["s1"], "changes": changes })).await;
    assert_eq!(committed["batch"]["changes"].as_array().unwrap().len(), 50);
    assert_eq!(committed["batch"]["summary"].as_str().unwrap().chars().count(), 1000);
    let note = app.memory().await["notes"].as_array().unwrap().iter().find(|n| n["title"] == "Twenty").unwrap().clone();
    assert_eq!(note["sources"], json!(twenty));
}

/// AC-4: the 200-line budget applies to the final index of a commit too; over it, nothing is written.
#[tokio::test]
async fn commits_past_the_line_budget_write_nothing() {
    let app = App::new();
    for n in 0..160 {
        app.saved(json!({ "expectedRevision": 0, "scope": "user", "category": "user", "title": format!("u{n:03}"), "hook": "h" })).await;
    }
    repo_session(&app.env.store, "s1", BASE, 1);
    let granted = app.granted("manual").await;
    let before = app.dump();
    let changes: Vec<Value> = (0..45).map(|n| save("project", &format!("p{n:02}"), json!([source("s1", 1)]))).collect();
    let r = app.commit(&app.a, &granted, json!({ "sessions": ["s1"], "changes": changes })).await;
    let body = r.json();
    assert_eq!((r.status, &body["error"]), (StatusCode::UNPROCESSABLE_ENTITY, &json!("memory_full")), "{body}");
    assert!(body["indexLines"].as_u64().unwrap() > 200 && body["indexBytes"].as_u64().unwrap() <= 8192, "{body}");
    assert_eq!(app.dump(), before);
}

/// AC-4: dream saves, reasons, and the summary are scrubbed like v1 writes before they are stored or returned.
#[tokio::test]
async fn dream_writes_are_scrubbed() {
    let app = App::new();
    repo_session(&app.env.store, "s1", BASE, 1);
    let granted = app.granted("manual").await;
    let token = format!("pika_{}", "0123456789abcdef".repeat(4));
    let mut change = save("project", &format!("Token {token}"), json!([source("s1", 1)]));
    change["hook"] = json!(format!("deploy with {token}"));
    change["body"] = json!(format!("Token: {token}\n"));
    change["reason"] = json!(format!("saw {token}"));
    let committed = app.committed(&granted, json!({ "summary": format!("found {token}"), "sessions": ["s1"], "changes": [change] })).await;
    assert!(!committed.to_string().contains(&token), "{committed}");
    assert!(committed["batch"]["summary"].as_str().unwrap().contains("[REDACTED"), "{committed}");
    let stored = TABLES.iter().map(|t| query(&app.env.store, &format!("SELECT * FROM {t}"))).collect::<Vec<_>>();
    let stored = serde_json::to_string(&stored).unwrap();
    assert!(!stored.contains(&token), "{stored}");
    assert!(!app.memory().await.to_string().contains(&token));
}

/// AC-5: a v1 save after a dream makes the note the agent's again, without the dream's sources.
#[tokio::test]
async fn a_v1_save_after_a_dream_drops_its_sources() {
    let app = App::new();
    repo_session(&app.env.store, "s1", BASE, 1);
    let granted = app.granted("manual").await;
    let committed = app.committed(&granted, json!({ "sessions": ["s1"], "changes": [save("user", "Tabs", json!([source("s1", 1)]))] })).await;
    let id = committed["batch"]["changes"][0]["noteId"].clone();
    let note = app
        .saved(json!({ "id": id, "expectedRevision": 1, "scope": "user", "category": "project", "title": "Tabs", "hook": "indent" }))
        .await;
    assert_eq!((&note["provenance"], &note["sources"]), (&json!("agent"), &json!([])), "{note}");
    let memory = app.memory().await;
    assert_eq!((&memory["notes"][0]["provenance"], &memory["notes"][0]["sources"]), (&json!("agent"), &json!([])));
    let revisions = app.owner(&format!("memory/notes/{}/revisions", id.as_str().unwrap())).await["revisions"].clone();
    assert_eq!((&revisions[1]["provenance"], &revisions[1]["sources"], &revisions[1]["batchId"]), (&json!("agent"), &json!([]), &Value::Null));
}

/// AC-4 with the contract's 400s: malformed bodies are 400 `bad_request` and write nothing.
#[tokio::test]
async fn malformed_dream_bodies_are_bad_requests() {
    let app = App::new();
    repo_session(&app.env.store, "s1", BASE, 1);
    let granted = app.granted("manual").await;
    let id = granted["lease"]["id"].as_str().unwrap().to_owned();
    let before = app.dump();
    for (path, body) in [
        ("memory/dream/lease".to_owned(), json!("lease")),
        ("memory/dream/lease".to_owned(), json!({ "project": "widgets", "mode": 1 })),
        (format!("memory/dream/{id}/commit"), json!({ "sessions": "s1" })),
        (format!("memory/dream/{id}/commit"), json!({ "sessions": ["s1"], "changes": [{ "op": "save" }] })),
        (format!("memory/dream/{id}/commit"), json!({ "sessions": ["s1"], "changes": [save("project", "X", json!([{ "sessionId": "s1" }]))] })),
        (format!("memory/dream/{id}/release"), json!({})),
    ] {
        let r = app.post(&app.a, &path, body.clone()).await;
        assert_eq!((r.status, &r.json()["error"]), (StatusCode::BAD_REQUEST, &json!("bad_request")), "{path} {body}: {}", r.text());
        assert_eq!(app.dump(), before, "{path} {body}");
    }
    let r = app.call(Method::POST, &format!("/api/agent/v1/memory/dream/{id}/commit"), Some(&app.a), None).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST, "{}", r.text());
    assert_eq!(app.dump(), before);
}

/// Text that only the dream sessions' prompts and replies hold.
const TEXT_MARK: &str = "quokkadream";
/// Text that only a `dream_save` call's arguments and its result hold.
const ARG_MARK: &str = "narwhalsave";
/// Text that only a session whose dream link arrives after its content holds.
const LATE_MARK: &str = "axolotllate";

fn dream_link(parent: &str) -> Value {
    json!({ "kind": "subagent", "agentType": "memory-dream", "parentSessionId": parent,
            "parentSessionFile": format!("/home/me/.pi/sessions/2026-10-20T00-00-00-000Z_{parent}.jsonl"),
            "description": "memory dream" })
}

/// A user prompt, an assistant reply with text and a `dream_save` call, and the call's result, all at `at`.
fn dream_turn(at: i64, text: &str, args: &str) -> Vec<String> {
    let message = |id: &str, parent: &str, message: Value| {
        json!({ "type": "message", "id": id, "parentId": parent, "timestamp": format_iso_ms(at), "message": message }).to_string()
    };
    vec![
        message("d1", "link", json!({ "role": "user", "content": format!("Consolidate {text}"), "timestamp": at })),
        message("d2", "d1", json!({ "role": "assistant", "api": "openai-responses", "provider": "openai", "model": "gpt-5",
            "stopReason": "toolUse", "timestamp": at,
            "usage": { "input": 10, "output": 2, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 12, "cost": { "total": 0.0 } },
            "content": [
                { "type": "text", "text": format!("Saving {text}") },
                { "type": "toolCall", "id": "call_dream", "name": "dream_save", "arguments": { "title": format!("Remember {args}") } },
            ] })),
        message("d3", "d2", json!({ "role": "toolResult", "toolCallId": "call_dream", "toolName": "dream_save", "isError": false,
            "timestamp": at, "content": [{ "type": "text", "text": format!("Staged {args}") }] })),
    ]
}

impl App {
    /// `GET {base}/api/{namespace}/{path}`, as device `laptop` in `agent/v1`.
    async fn get_in(&self, namespace: &str, path: &str) -> Reply {
        let token = (namespace == "agent/v1").then_some(self.a.as_str());
        self.call(Method::GET, &format!("/api/{namespace}/{path}"), token, None).await
    }

    async fn read_in(&self, namespace: &str, path: &str) -> Value {
        let r = self.get_in(namespace, path).await;
        assert_eq!(r.status, StatusCode::OK, "{namespace} {path}: {}", r.text());
        r.json()
    }

    /// The search hits for `q` in a namespace, in both groupings.
    async fn hits_in(&self, namespace: &str, q: &str) -> Vec<Value> {
        let mut hits = Vec::new();
        for group in ["entry", "session"] {
            let found = self.read_in(namespace, &format!("search?q={q}&group={group}")).await;
            hits.extend(found["items"].as_array().unwrap().iter().cloned());
        }
        hits
    }
}

/// AC-7: a dream's session and its descendants are hidden in the public namespace and never searched, its dream tool
/// calls are scrubbed outside the owner namespace, and the owner still reads everything, before and after a reindex,
/// also when the dream link arrives after the session's content.
#[tokio::test]
async fn dream_sessions_are_hidden_unsearched_and_scrubbed() {
    let app = App::new();
    let store = &app.env.store;
    repo_session(store, "p1", BASE, 1);
    let dream = [header("dream", BASE + HOUR, Some(dream_link("p1"))), dream_turn(BASE + HOUR, TEXT_MARK, ARG_MARK)].concat();
    upload_as(store, DEVICE, "dream", &[], &dream, repo_meta("dream", REPO));
    let link = json!({ "kind": "subagent", "agentType": "worker", "parentSessionId": "dream" });
    let child = [header("child", BASE + HOUR, Some(link)), dream_turn(BASE + HOUR, TEXT_MARK, ARG_MARK)].concat();
    upload_as(store, DEVICE, "child", &[], &child, repo_meta("child", REPO));
    let link = json!({ "kind": "subagent", "agentType": "worker", "parentSessionId": "child" });
    let grandchild = [header("grandchild", BASE + HOUR, Some(link)), dream_turn(BASE + HOUR, TEXT_MARK, ARG_MARK)].concat();
    upload_as(store, DEVICE, "grandchild", &[], &grandchild, repo_meta("grandchild", REPO));
    // Content first, its dream link in a later batch.
    let late = [header("late", BASE + 2 * HOUR, None), dream_turn(BASE + 2 * HOUR, LATE_MARK, LATE_MARK)].concat();
    upload_as(store, DEVICE, "late", &[], &late, repo_meta("late", REPO));
    assert!(!app.hits_in("v1", LATE_MARK).await.is_empty(), "searched before its link");
    let link = header("late", BASE + 2 * HOUR, Some(dream_link("p1"))).split_off(1);
    upload_as(store, DEVICE, "late", &late, &link, repo_meta("late", REPO));
    let r = app.call(Method::PATCH, "/api/v1/settings/publishing", None, Some(json!({ "project": "widgets", "published": true }))).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    let dreams = ["dream", "child", "grandchild", "late"];

    for reindexed in [false, true] {
        if reindexed {
            pika::reindex::reindex(store).unwrap();
        }
        let at = format!("reindexed: {reindexed}");
        // No owner flag hides them.
        assert_eq!(app.count("SELECT COUNT(*) FROM hidden_sessions"), 0, "{at}");
        let docs = "SELECT COUNT(*) FROM search_docs d JOIN sessions s ON s.sid = d.sid WHERE s.id IN ('dream', 'child', 'grandchild', 'late')";
        assert_eq!(app.count(docs), 0, "{at}");

        // The public namespace: 404s, and absent from lists, children, and trees.
        for id in dreams {
            for path in ["", "/entries", "/tree", "/trace", "/turns", "/entries/1/raw"] {
                let r = app.get_in("public/v1", &format!("sessions/{id}{path}")).await;
                assert_eq!(r.status, StatusCode::NOT_FOUND, "{id}{path} {at}: {}", r.text());
            }
        }
        let list = app.read_in("public/v1", "sessions").await;
        assert_eq!(ids(&list["items"]), ["p1"], "{at}");
        let parent = app.read_in("public/v1", "sessions/p1").await;
        assert_eq!((&parent["children"], &parent["childCount"]), (&json!([]), &json!(0)), "{at}");
        let tree = app.read_in("public/v1", "sessions/p1/tree").await;
        assert_eq!(ids(&tree["nodes"]), ["p1"], "{at}");

        // No namespace's search finds them; the parent is still found.
        for namespace in ["v1", "public/v1", "agent/v1"] {
            for mark in [TEXT_MARK, ARG_MARK, LATE_MARK, "Consolidate"] {
                assert_eq!(app.hits_in(namespace, mark).await, Vec::<Value>::new(), "{namespace} {mark} {at}");
            }
            assert!(!app.hits_in(namespace, "Prompt").await.is_empty(), "{namespace} {at}");
        }

        // The owner reads everything: listed, hidden by the dream session, every entry.
        let owner = app.read_in("v1", "sessions").await;
        let mut listed = ids(&owner["items"]);
        listed.sort();
        assert_eq!(listed, ["child", "dream", "grandchild", "late", "p1"], "{at}");
        for (id, by) in [("dream", "dream"), ("child", "dream"), ("grandchild", "dream"), ("late", "late")] {
            let summary = app.read_in("v1", &format!("sessions/{id}")).await;
            assert_eq!((&summary["hidden"], &summary["hiddenBy"]), (&json!(true), &json!(by)), "{id} {at}");
        }
        let parent = app.read_in("v1", "sessions/p1").await;
        assert_eq!((&parent["hidden"], &parent["childCount"]), (&json!(false), &json!(2)), "{at}");
        let tree = app.read_in("v1", "sessions/p1/tree").await;
        assert_eq!(ids(&tree["nodes"]).len(), 5, "{at}");
        for id in ["dream", "grandchild"] {
            let entries = app.read_in("v1", &format!("sessions/{id}/entries")).await.to_string();
            assert!(entries.contains(TEXT_MARK) && entries.contains(ARG_MARK), "{id} {at}: {entries}");
            let trace = app.read_in("v1", &format!("sessions/{id}/trace")).await.to_string();
            assert!(trace.contains(ARG_MARK), "{id} {at}: {trace}");
        }

        // The agent namespace reads them with the dream tools scrubbed.
        for id in ["dream", "grandchild"] {
            let entries = app.read_in("agent/v1", &format!("sessions/{id}/entries")).await;
            let text = entries.to_string();
            assert!(text.contains(TEXT_MARK) && !text.contains(ARG_MARK), "{id} {at}: {text}");
            let raw = |seq: usize| entries["items"][seq]["raw"].clone();
            assert_eq!(
                raw(3)["message"]["content"],
                json!([
                    { "type": "text", "text": format!("Saving {TEXT_MARK}") },
                    { "type": "toolCall", "id": "call_dream", "name": "dream_save", "arguments": { "omitted": "memory" } },
                ]),
                "{id} {at}"
            );
            assert_eq!(raw(4)["message"]["content"], json!([{ "type": "text", "text": "[memory tool result omitted]" }]), "{id} {at}");
            let trace = app.read_in("agent/v1", &format!("sessions/{id}/trace")).await;
            assert!(!trace.to_string().contains(ARG_MARK), "{id} {at}: {trace}");
        }
    }
}

/// AC-7: a dream tool call is scrubbed and unsearched in any session, like the v1 memory tools.
#[test]
fn dream_tools_are_memory_tools() {
    for name in ["memory_read", "memory_save", "memory_forget", "dream_save", "dream_forget", "dream_commit"] {
        assert!(pika::memory::is_tool(name), "{name}");
    }
    assert!(!pika::memory::is_tool("dream"));
}

impl App {
    /// `POST {base}/api/v1/memory/batches/:id/revert` with `{}` and without a login, for `AuthMode::None`.
    async fn revert(&self, id: &Value) -> Reply {
        self.call(Method::POST, &format!("/api/v1/memory/batches/{}/revert", id.as_str().unwrap()), None, Some(json!({}))).await
    }

    /// The owner's view of a note: its current state and its revisions.
    async fn note(&self, id: &Value) -> (Value, Vec<Value>) {
        let revisions = self.owner(&format!("memory/notes/{}/revisions", id.as_str().unwrap())).await["revisions"].clone();
        let row = one(&self.env.store, &format!("SELECT * FROM memory_notes WHERE id = '{}'", id.as_str().unwrap()));
        (serde_json::to_value(row).unwrap(), revisions.as_array().unwrap().clone())
    }
}

/// AC-8: reverting a batch restores each note it touched as an owner's `revert` revision: a created note is
/// forgotten, an updated one has its previous content, a forgotten one is live again; the batch is marked reverted.
/// A second revert, a batch whose notes changed since, and an unknown batch write nothing. Batches list newest first.
#[tokio::test]
async fn reverting_a_batch_restores_its_notes() {
    let app = App::new();
    let tabs = app
        .saved(json!({ "expectedRevision": 0, "scope": "user", "category": "feedback", "title": "Tabs", "hook": "indent with tabs",
                       "body": "Always tabs." }))
        .await;
    let old = app
        .saved(json!({ "expectedRevision": 0, "scope": "project", "project": "widgets", "repository": REPO,
                       "category": "reference", "title": "Old", "hook": "stale", "body": "See the wiki." }))
        .await;
    repo_session(&app.env.store, "s1", BASE, 2);
    let granted = app.granted("manual").await;
    let mut update = save("user", "Tabs always", json!([source("s1", 1)]));
    update["id"] = tabs["id"].clone();
    update["expectedRevision"] = json!(1);
    let first = app
        .committed(&granted, json!({ "sessions": ["s1"], "changes": [
            save("project", "Build", json!([source("s1", 1)])),
            update,
            { "op": "forget", "id": old["id"], "expectedRevision": 1, "sources": [source("s1", 2)] },
        ] }))
        .await["batch"]
        .clone();
    let build = first["changes"][0]["noteId"].clone();
    let listed = app.owner(&format!("memory/batches?scope={}", encode(KEY))).await;
    assert_eq!(listed, json!({ "batches": [first] }));

    let before = now_ms();
    let r = app.revert(&first["id"]).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    let reverted = r.json()["batch"].clone();
    assert!(ms(&reverted["revertedAt"]) >= before);
    let mut expected = first.clone();
    expected["revertedAt"] = reverted["revertedAt"].clone();
    assert_eq!(reverted, expected);

    let owner_revert = |revision: &Value, n: i64| {
        assert_eq!(
            (&revision["revision"], &revision["action"], &revision["provenance"], &revision["sources"], &revision["batchId"]),
            (&json!(n), &json!("revert"), &json!("owner"), &json!([]), &Value::Null),
            "{revision}"
        );
    };
    let (note, revisions) = app.note(&build).await;
    assert_eq!((&note["revision"], &note["provenance"], &note["sources"]), (&json!(2), &json!("owner"), &json!("[]")));
    assert!(!note["deleted_at"].is_null(), "{note}");
    owner_revert(&revisions[1], 2);
    assert_eq!(revisions[1]["title"], "Build");
    let (note, revisions) = app.note(&tabs["id"]).await;
    assert_eq!((&note["title"], &note["hook"], &note["body"], &note["category"]), (&json!("Tabs"), &json!("indent with tabs"), &json!("Always tabs."), &json!("feedback")));
    assert_eq!((&note["revision"], &note["deleted_at"], &note["device_id"]), (&json!(3), &Value::Null, &Value::Null));
    owner_revert(&revisions[2], 3);
    let (note, revisions) = app.note(&old["id"]).await;
    assert_eq!((&note["title"], &note["body"], &note["category"]), (&json!("Old"), &json!("See the wiki."), &json!("reference")));
    assert_eq!((&note["revision"], &note["deleted_at"]), (&json!(3), &Value::Null));
    owner_revert(&revisions[2], 3);
    let memory = app.memory().await;
    let titles: Vec<&str> = memory["notes"].as_array().unwrap().iter().map(|n| n["title"].as_str().unwrap()).collect();
    assert_eq!(titles, ["Tabs", "Old"]);
    // The checkpoint stays.
    assert_eq!(app.checkpoints(), [(KEY.into(), "s1".into(), 2)]);

    let state = app.dump();
    let r = app.revert(&first["id"]).await;
    assert_eq!((r.status, r.json()), (StatusCode::CONFLICT, json!({ "error": "already_reverted" })));
    let r = app.revert(&json!("0000000000000000")).await;
    assert_eq!((r.status, r.json()), (StatusCode::NOT_FOUND, json!({ "error": "not_found" })));
    assert_eq!(app.dump(), state);

    // A second batch whose notes change afterwards conflicts, listing exactly those notes.
    let mut update = save("user", "Tabs again", json!([source("s1", 1)]));
    update["id"] = tabs["id"].clone();
    update["expectedRevision"] = json!(3);
    let second = app
        .committed(&granted, json!({ "sessions": ["s1"], "changes": [
            save("project", "Alpha", json!([source("s1", 1)])),
            save("project", "Beta", json!([source("s1", 1)])),
            update,
        ] }))
        .await["batch"]
        .clone();
    let alpha = second["changes"][0]["noteId"].clone();
    app.saved(json!({ "id": alpha, "expectedRevision": 1, "scope": "project", "project": "widgets", "repository": REPO,
                      "category": "project", "title": "Alpha 2", "hook": "edited" }))
        .await;
    let r = app.post(&app.a, &format!("memory/notes/{}/forget", tabs["id"].as_str().unwrap()), json!({ "expectedRevision": 4 })).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    let state = app.dump();
    let r = app.revert(&second["id"]).await;
    assert_eq!((r.status, r.json()), (StatusCode::CONFLICT, json!({ "error": "revert_conflict", "notes": [alpha, tabs["id"]] })));
    assert_eq!(app.dump(), state);

    let listed = app.owner(&format!("memory/batches?scope={}", encode(KEY))).await;
    assert_eq!(listed, json!({ "batches": [second, reverted] }));
    let r = app.call(Method::GET, "/api/v1/memory/batches?scope=repo:https://example.com/none", None, None).await;
    assert_eq!((r.status, r.json()), (StatusCode::NOT_FOUND, json!({ "error": "not_found" })));
    let r = app.call(Method::GET, "/api/v1/memory/batches", None, None).await;
    assert_eq!((r.status, &r.json()["error"]), (StatusCode::BAD_REQUEST, &json!("bad_request")));
    assert_eq!(app.owner("memory/batches?scope=user").await, json!({ "batches": [] }));
}

/// AC-8: a batch that changes a note several times, forgetting it last, reverts it to its live state before the first
/// change.
#[tokio::test]
async fn reverting_restores_the_state_before_the_batchs_first_change() {
    let app = App::new();
    let tabs = app
        .saved(json!({ "expectedRevision": 0, "scope": "user", "category": "feedback", "title": "Tabs", "hook": "indent with tabs" }))
        .await;
    repo_session(&app.env.store, "s1", BASE, 1);
    let granted = app.granted("manual").await;
    let update = |title: &str, expected: i64| {
        let mut change = save("user", title, json!([source("s1", 1)]));
        change["id"] = tabs["id"].clone();
        change["expectedRevision"] = json!(expected);
        change
    };
    let mut created = save("project", "Short-lived", json!([source("s1", 1)]));
    created["category"] = json!("reference");
    let batch = app
        .committed(&granted, json!({ "sessions": ["s1"], "changes": [
            update("Two", 1), update("Three", 2), { "op": "forget", "id": tabs["id"], "expectedRevision": 3 }, created,
        ] }))
        .await["batch"]
        .clone();
    let short = batch["changes"][3]["noteId"].clone();
    let r = app.revert(&batch["id"]).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    let (note, revisions) = app.note(&tabs["id"]).await;
    assert_eq!((&note["title"], &note["revision"], &note["deleted_at"]), (&json!("Tabs"), &json!(5), &Value::Null));
    assert_eq!(revisions.iter().map(|r| r["action"].as_str().unwrap()).collect::<Vec<_>>(), ["save", "save", "save", "forget", "revert"]);
    let (note, _) = app.note(&short).await;
    assert_eq!((&note["revision"], &note["provenance"]), (&json!(2), &json!("owner")));
    assert!(!note["deleted_at"].is_null(), "{note}");
    assert_eq!(app.memory().await["notes"].as_array().unwrap().len(), 1);
}

/// AC-8: the batch routes need the owner's login; a device token counts for nothing.
#[tokio::test]
async fn batch_routes_need_the_owners_login() {
    let app = App::with_auth(AuthMode::Password);
    repo_session(&app.env.store, "s1", BASE, 1);
    let granted = app.granted("manual").await;
    let batch = app.committed(&granted, json!({ "sessions": ["s1"], "changes": [save("project", "Build", json!([source("s1", 1)]))] })).await;
    let id = batch["batch"]["id"].as_str().unwrap().to_owned();
    let list = format!("/api/v1/memory/batches?scope={}", encode(KEY));
    let revert = format!("/api/v1/memory/batches/{id}/revert");
    let state = app.dump();
    for token in [None, Some(app.a.as_str())] {
        for (method, path) in [(Method::GET, &list), (Method::POST, &revert)] {
            let r = app.call(method.clone(), path, token, None).await;
            assert_eq!((r.status, r.json()), (StatusCode::UNAUTHORIZED, json!({ "error": "unauthorized" })), "{method} {path} {token:?}");
        }
    }
    assert_eq!(app.dump(), state);
    // Not in the agent namespace.
    let r = app.call(Method::GET, &format!("/api/agent/v1/memory/batches?scope={}", encode(KEY)), Some(&app.a), None).await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);

    let login = Request::post("/api/v1/login")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(json!({ "password": PASSWORD }).to_string()))
        .unwrap();
    let response = app.app.clone().oneshot(login).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let cookie = response.headers()[header::SET_COOKIE].to_str().unwrap().split(';').next().unwrap().to_owned();
    let send = |method: Method, path: &str| {
        let post = method == Method::POST;
        let request = Request::builder().method(method).uri(path).header(header::COOKIE, &cookie);
        let request = if post {
            request.header(header::CONTENT_TYPE, "application/json").body(Body::from("{}"))
        } else {
            request.body(Body::empty())
        };
        app.app.clone().oneshot(request.unwrap())
    };
    let response = send(Method::GET, &list).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let response = send(Method::POST, &revert).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(app.count("SELECT COUNT(*) FROM memory_revisions WHERE action = 'revert'"), 1);
}

/// C2 in a commit: a dream's user-scope saves must fit every project's index too, and the 422 names the project.
#[tokio::test]
async fn dream_user_saves_fit_every_projects_index() {
    let app = App::new();
    let long = |n: usize| format!("{n:03}{}", "t".repeat(117));
    // Long notes in device laptop's local gadgets project until one more does not fit.
    loop {
        let r = app
            .post(&app.a, "memory/notes", json!({ "expectedRevision": 0, "scope": "project", "project": "gadgets",
                                                  "category": "project", "title": long(0), "hook": "h".repeat(150) }))
            .await;
        if r.status != StatusCode::OK {
            assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY, "{}", r.text());
            break;
        }
    }
    repo_session(&app.env.store, "s1", BASE, 1);
    let granted = app.granted("manual").await;
    let before = app.dump();
    let mut change = save("user", &long(1), json!([source("s1", 1)]));
    change["hook"] = json!("h".repeat(150));
    let r = app.commit(&app.a, &granted, json!({ "sessions": ["s1"], "changes": [change.clone()] })).await;
    let body = r.json();
    assert_eq!((r.status, &body["error"]), (StatusCode::UNPROCESSABLE_ENTITY, &json!("memory_full")), "{body}");
    assert_eq!(body["project"], json!({ "key": LOCAL, "kind": "project", "label": "gadgets" }));
    assert!(body["indexBytes"].as_u64().unwrap() > 8192, "{body}");
    assert_eq!(app.dump(), before);
    // The same note fits the widgets project.
    change["scope"] = json!("project");
    app.committed(&granted, json!({ "sessions": ["s1"], "changes": [change] })).await;
}

/// S3: a session deleted while a lease lists it gets no checkpoint back from a commit, which still succeeds and lists
/// only the sessions it advanced.
#[tokio::test]
async fn commits_skip_sessions_deleted_during_the_lease() {
    let app = App::new();
    let store = &app.env.store;
    repo_session(store, "s1", BASE, 3);
    repo_session(store, "s2", BASE + HOUR, 1);
    let granted = app.granted("manual").await;
    assert_eq!(ids(&granted["sessions"]), ["s1", "s2"]);
    let r = app.call(Method::DELETE, "/api/v1/sessions/s1", None, None).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    let committed = app
        .committed(&granted, json!({ "sessions": ["s1", "s2"], "changes": [save("project", "Build", json!([source("s2", 1)]))] }))
        .await;
    assert_eq!(committed["batch"]["sessions"], json!(["s2"]));
    assert_eq!(app.checkpoints(), [(KEY.into(), "s2".into(), 1)]);
    // The deleted session alone: a batch that advanced nothing.
    let committed = app.committed(&granted, json!({ "sessions": ["s1"] })).await;
    assert_eq!(committed["batch"]["sessions"], json!([]));
    assert_eq!(app.checkpoints(), [(KEY.into(), "s2".into(), 1)]);
}

/// S4: deleting a project keeps what its dreams wrote to user notes as ordinary edits: those revisions, and a note
/// whose current revision is one of them, lose the batch and sources that named the deleted batch and sessions, and
/// keep their `dream` provenance. Another project's dream edits keep theirs.
#[tokio::test]
async fn deleting_a_project_detaches_its_dreams_user_edits() {
    let app = App::new();
    let store = &app.env.store;
    repo_session(store, "s1", BASE, 2);
    let lines = [header("g1", BASE, None), prompts(BASE, 0, 1)].concat();
    upload_as(store, DEVICE, "g1", &[], &lines, json!({ "sessionId": "g1", "cwd": "/x", "project": "gadgets" }));
    let widgets = app.granted("manual").await;
    let committed = app
        .committed(&widgets, json!({ "sessions": ["s1"], "changes": [
            save("user", "Tabs", json!([source("s1", 1)])),
            save("user", "Lint", json!([source("s1", 2)])),
            save("project", "Build", json!([source("s1", 1)])),
        ] }))
        .await;
    let tabs = committed["batch"]["changes"][0]["noteId"].clone();
    let lint = committed["batch"]["changes"][1]["noteId"].clone();
    app.saved(json!({ "id": lint, "expectedRevision": 1, "scope": "user", "category": "project", "title": "Lint", "hook": "run clippy" }))
        .await;
    let gadgets = app.post(&app.a, "memory/dream/lease", json!({ "project": "gadgets", "mode": "manual" })).await.json();
    let other = app.committed(&gadgets, json!({ "sessions": ["g1"], "changes": [save("user", "Spaces", json!([source("g1", 1)]))] })).await;
    let spaces = other["batch"]["changes"][0]["noteId"].clone();

    let r = app.call(Method::DELETE, "/api/v1/projects/widgets", None, None).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    let (note, revisions) = app.note(&tabs).await;
    assert_eq!((&note["sources"], &note["provenance"], &note["deleted_at"]), (&json!("[]"), &json!("dream"), &Value::Null));
    assert_eq!(
        (&revisions[0]["batchId"], &revisions[0]["sources"], &revisions[0]["provenance"]),
        (&Value::Null, &json!([]), &json!("dream"))
    );
    let (note, revisions) = app.note(&lint).await;
    assert_eq!((&note["sources"], &note["provenance"]), (&json!("[]"), &json!("agent")));
    assert_eq!((&revisions[0]["batchId"], &revisions[0]["sources"], revisions.len()), (&Value::Null, &json!([]), 2));
    let (note, revisions) = app.note(&spaces).await;
    assert_eq!(note["sources"], json!(json!([source("g1", 1)]).to_string()));
    assert_eq!((&revisions[0]["batchId"], &revisions[0]["sources"]), (&other["batch"]["id"], &json!([source("g1", 1)])));
    assert_eq!(app.count("SELECT COUNT(*) FROM memory_revisions WHERE batch_id IS NOT NULL"), 1);
    let r = app.revert(&other["batch"]["id"]).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
}

/// S5: the owner's revert takes a JSON body, as the owner's other mutations do; a form post is 415 and reverts nothing.
#[tokio::test]
async fn reverts_refuse_form_posts() {
    let app = App::new();
    repo_session(&app.env.store, "s1", BASE, 2);
    let granted = app.granted("auto").await;
    let committed = app.committed(&granted, json!({ "sessions": ["s1"], "changes": [save("project", "Build", json!([source("s1", 1)]))] })).await;
    let batch = committed["batch"]["id"].clone();
    let state = app.dump();
    let form = Request::post(format!("/api/v1/memory/batches/{}/revert", batch.as_str().unwrap()))
        .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded")
        .body(Body::from("a=b"))
        .unwrap();
    let response = app.app.clone().oneshot(form).await.unwrap();
    assert_eq!(response.status(), StatusCode::UNSUPPORTED_MEDIA_TYPE);
    assert_eq!(app.dump(), state);
    let r = app.revert(&batch).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
}
