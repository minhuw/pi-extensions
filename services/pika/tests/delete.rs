//! Deleting sessions and projects, tombstoned ingest, blob collection, and hiding sessions from the public view.
mod common;

use axum::Router;
use axum::body::Body;
use axum::http::{Method, Request, StatusCode, header};
use common::*;
use pika::config::{AuthMode, ServerConfig};
use pika::http::{AppState, router};
use serde_json::{Value, json};
use tower::ServiceExt;

const PARENT: &str = "p0000000-0000-0000-0000-000000000001";
const CHILD: &str = "c0000000-0000-0000-0000-000000000002";
const GRANDCHILD: &str = "g0000000-0000-0000-0000-000000000003";
const OTHER: &str = "o0000000-0000-0000-0000-000000000004";
const RUN: &str = "20261030-100000-beef";
const STEP: &str = "s0000000-0000-0000-0000-000000000005";
const IMAGE_B64: &str = "iVBORw0KGgr7/78=";

struct App {
    env: Env,
    app: Router,
    token: String,
    cookie: Option<String>,
}

struct Reply {
    status: StatusCode,
    body: Vec<u8>,
}

impl Reply {
    fn json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap_or_else(|_| panic!("not JSON: {}", String::from_utf8_lossy(&self.body)))
    }
}

fn app_with(password: Option<&str>) -> App {
    let env = env();
    let token = device(&env.store, DEVICE);
    let mut config = ServerConfig::new(env.dir.path().join("data"));
    match password {
        Some(password) => config.password = Some(password.to_owned()),
        None => config.auth = AuthMode::None,
    }
    let app = router(AppState::new(env.store.clone(), config).unwrap());
    App { env, app, token, cookie: None }
}

fn app() -> App {
    app_with(None)
}

impl App {
    async fn send(&self, method: Method, path: &str, body: Option<Value>) -> Reply {
        let mut request = Request::builder().method(method).uri(path);
        if let Some(cookie) = &self.cookie {
            request = request.header(header::COOKIE, cookie);
        }
        let request = match body {
            Some(body) => request.header(header::CONTENT_TYPE, "application/json").body(Body::from(body.to_string())),
            None => request.body(Body::empty()),
        };
        let response = self.app.clone().oneshot(request.unwrap()).await.unwrap();
        let status = response.status();
        let body = axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap().to_vec();
        Reply { status, body }
    }

    async fn get(&self, path: &str) -> Reply {
        self.send(Method::GET, &format!("/api/v1/{path}"), None).await
    }

    async fn json(&self, path: &str) -> Value {
        let r = self.get(path).await;
        assert_eq!(r.status, StatusCode::OK, "{path}: {}", String::from_utf8_lossy(&r.body));
        r.json()
    }

    async fn public(&self, path: &str) -> Reply {
        self.send(Method::GET, &format!("/api/public/v1/{path}"), None).await
    }

    async fn public_json(&self, path: &str) -> Value {
        let r = self.public(path).await;
        assert_eq!(r.status, StatusCode::OK, "{path}: {}", String::from_utf8_lossy(&r.body));
        r.json()
    }

    async fn delete(&self, path: &str) -> Reply {
        self.send(Method::DELETE, &format!("/api/v1/{path}"), None).await
    }

    async fn hide(&self, id: &str, hidden: bool) -> Reply {
        self.send(Method::PATCH, &format!("/api/v1/sessions/{id}"), Some(json!({ "hidden": hidden }))).await
    }

    async fn ingest(&self, batch: Value) -> Reply {
        let request = Request::post("/api/ingest/v1/batch")
            .header(header::CONTENT_TYPE, "application/json")
            .header(header::AUTHORIZATION, format!("Bearer {}", self.token))
            .body(Body::from(batch.to_string()))
            .unwrap();
        let response = self.app.clone().oneshot(request).await.unwrap();
        let status = response.status();
        let body = axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap().to_vec();
        Reply { status, body }
    }

    async fn ok_ingest(&self, batch: Value) -> Value {
        let r = self.ingest(batch).await;
        assert_eq!(r.status, StatusCode::OK, "{}", String::from_utf8_lossy(&r.body));
        r.json()
    }

    async fn upload(&self, id: &str, project: &str, lines: &[String]) {
        let batch = json!({ "streams": [{ "key": format!("session:{id}"), "kind": "session", "offset": 0, "lines": lines,
                                           "meta": { "sessionId": id, "cwd": "/x", "project": project } }] });
        self.ok_ingest(batch).await;
    }

    async fn publish(&self, project: &str) {
        let r = self.send(Method::PATCH, "/api/v1/settings/publishing", Some(json!({ "project": project, "published": true }))).await;
        assert_eq!(r.status, StatusCode::OK, "{}", String::from_utf8_lossy(&r.body));
    }

    fn count(&self, sql: &str) -> i64 {
        one(&self.env.store, sql).into_values().next().unwrap().as_i64().unwrap()
    }
}

/// A session: its header, an optional link to `parent`, a prompt with `word`, an answer, and a tool result with an
/// image.
fn session(id: &str, parent: Option<&str>, word: &str, at: &str) -> Vec<String> {
    let mut values = vec![json!({ "type": "session", "version": 3, "id": id, "timestamp": at, "cwd": "/x" })];
    // Every session has the same layout, so its image is at seq 4.
    values.push(match parent {
        Some(parent) => json!({ "type": "custom", "id": "l1", "parentId": null, "timestamp": at, "customType": "pi-extensions.session-link",
                                "data": { "kind": "subagent", "parentSessionId": parent, "parentToolCallId": "call_1" } }),
        None => json!({ "type": "custom", "id": "l1", "parentId": null, "timestamp": at, "customType": "note", "data": {} }),
    });
    values.push(json!({ "type": "message", "id": "m1", "parentId": null, "timestamp": at,
                        "message": { "role": "user", "content": format!("Explain {word} please"), "timestamp": 1 } }));
    values.push(json!({ "type": "message", "id": "m2", "parentId": "m1", "timestamp": at,
                        "message": { "role": "assistant", "content": [{ "type": "text", "text": format!("{word} is fine") }],
                                     "model": "codex/gpt-6", "stopReason": "stop", "timestamp": 2 } }));
    values.push(json!({ "type": "message", "id": "m3", "parentId": "m2", "timestamp": at,
                        "message": { "role": "toolResult", "toolCallId": "call_1", "toolName": "bash", "isError": false, "timestamp": 3,
                                     "content": [{ "type": "text", "text": "ok" }, { "type": "image", "data": IMAGE_B64, "mimeType": "image/png" }] } }));
    values.iter().map(Value::to_string).collect()
}

fn more(word: &str) -> Vec<String> {
    vec![json!({ "type": "message", "id": "m9", "parentId": "m3", "timestamp": "2026-10-30T12:00:00.000Z",
                 "message": { "role": "user", "content": format!("And {word}?"), "timestamp": 9 } }).to_string()]
}

/// A captured request of `session` whose payload holds `messages`; returns the batch and its block hashes.
fn request(id: &str, session: &str, messages: &[&str], send_blobs: bool) -> (Value, Vec<String>) {
    let payload = json!({ "model": "gpt-6", "messages": messages.iter().map(|m| json!({ "role": "user", "content": m })).collect::<Vec<_>>() });
    let (skeleton, blocks) = pika::requests::split(&payload);
    let hashes: Vec<String> = blocks.iter().map(|(h, _)| h.clone()).collect();
    let blobs: Vec<Value> = if send_blobs { blocks.iter().map(|(h, d)| json!({ "hash": h, "data": d })).collect() } else { vec![] };
    let batch = json!({ "blobs": blobs, "requests": [{ "id": id, "sessionId": session, "fidelity": "payload", "skeleton": skeleton,
                                                        "blocks": hashes }] });
    (batch, hashes)
}

async fn family(app: &App) {
    app.upload(PARENT, "widgets", &session(PARENT, None, "zebra", "2026-10-30T09:00:00.000Z")).await;
    app.upload(CHILD, "widgets", &session(CHILD, Some(PARENT), "yak", "2026-10-30T09:01:00.000Z")).await;
    app.upload(GRANDCHILD, "widgets", &session(GRANDCHILD, Some(CHILD), "xerus", "2026-10-30T09:02:00.000Z")).await;
    app.upload(OTHER, "widgets", &session(OTHER, None, "walrus", "2026-10-30T09:03:00.000Z")).await;
}

fn ids(page: &Value) -> Vec<String> {
    let mut ids: Vec<String> = page["items"].as_array().unwrap().iter().map(|i| i["id"].as_str().unwrap().to_owned()).collect();
    ids.sort();
    ids
}

fn sids(app: &App, ids: &[&str]) -> Vec<i64> {
    ids.iter().map(|id| app.count(&format!("SELECT id FROM streams WHERE key = 'session:{id}'"))).collect()
}

/// No row of any table that holds per-session data refers to these sessions.
fn assert_gone(app: &App, ids: &[&str], sids: &[i64]) {
    let sid_list = sids.iter().map(i64::to_string).collect::<Vec<_>>().join(",");
    let id_list = ids.iter().map(|id| format!("'{id}'")).collect::<Vec<_>>().join(",");
    for (table, column) in [
        ("sessions", "sid"),
        ("session_models", "sid"),
        ("session_links", "sid"),
        ("entries", "sid"),
        ("turns", "sid"),
        ("model_calls", "sid"),
        ("usage_events", "sid"),
        ("tool_calls", "sid"),
        ("search_docs", "sid"),
        ("session_hidden", "sid"),
        ("lines", "stream_id"),
        ("streams", "id"),
    ] {
        assert_eq!(app.count(&format!("SELECT COUNT(*) FROM {table} WHERE {column} IN ({sid_list})")), 0, "{table}");
    }
    for (table, column) in [("requests", "session_id"), ("request_sessions", "session_id"), ("hidden_sessions", "id")] {
        assert_eq!(app.count(&format!("SELECT COUNT(*) FROM {table} WHERE {column} IN ({id_list})")), 0, "{table}");
    }
    assert_eq!(
        app.count("SELECT COUNT(*) FROM request_dict WHERE rs NOT IN (SELECT id FROM request_sessions)"),
        0,
        "request_dict"
    );
    assert_eq!(app.count("SELECT COUNT(*) FROM request_missing WHERE request_id NOT IN (SELECT id FROM requests)"), 0);
    // The full-text index holds exactly the remaining documents.
    assert_eq!(
        app.count("SELECT COUNT(*) FROM search_fts"),
        app.count("SELECT COUNT(*) FROM search_docs"),
    );
    store_integrity(app);
}

fn store_integrity(app: &App) {
    app.env.store.write(|tx| tx.execute("INSERT INTO search_fts (search_fts, rank) VALUES ('integrity-check', 1)", [])).unwrap();
}

#[tokio::test]
async fn deleting_a_session_takes_its_descendants_and_leaves_the_rest() {
    let app = app();
    family(&app).await;
    let (batch, _) = request("r-child", CHILD, &["child only", "shared block"], true);
    app.ok_ingest(batch).await;
    let gone = sids(&app, &[CHILD, GRANDCHILD]);
    assert_eq!(app.json(&format!("sessions/{PARENT}")).await["childCount"], 1);
    assert_eq!(app.json(&format!("sessions/{CHILD}/deletion")).await, json!({ "deletedSessions": 2, "deletedHerderRuns": 0 }));

    let r = app.delete(&format!("sessions/{CHILD}")).await;
    assert_eq!((r.status, r.json()), (StatusCode::OK, json!({ "deletedSessions": 2, "deletedHerderRuns": 0 })));
    for id in [CHILD, GRANDCHILD] {
        assert_eq!(app.get(&format!("sessions/{id}")).await.status, StatusCode::NOT_FOUND);
    }
    let parent = app.json(&format!("sessions/{PARENT}")).await;
    assert_eq!((parent["childCount"].clone(), parent["children"].clone()), (json!(0), json!([])));
    assert_eq!(ids(&app.json("sessions").await), [OTHER, PARENT]);
    assert_gone(&app, &[CHILD, GRANDCHILD], &gone);
    assert_eq!(app.count("SELECT COUNT(*) FROM deleted_streams"), 2);
    assert!(app.json("search?q=yak").await["items"].as_array().unwrap().is_empty());
    assert_eq!(app.json("search?q=zebra").await["items"].as_array().unwrap().len(), 2);

    // Unknown and already deleted sessions are 404.
    assert_eq!(app.delete(&format!("sessions/{CHILD}")).await.status, StatusCode::NOT_FOUND);
    assert_eq!(app.delete("sessions/nope").await.status, StatusCode::NOT_FOUND);
    assert_eq!(app.get("sessions/nope/deletion").await.status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn deleting_a_session_in_a_link_cycle_ends() {
    let app = app();
    app.upload(PARENT, "widgets", &session(PARENT, Some(CHILD), "zebra", "2026-10-30T09:00:00.000Z")).await;
    app.upload(CHILD, "widgets", &session(CHILD, Some(PARENT), "yak", "2026-10-30T09:01:00.000Z")).await;
    app.upload(OTHER, "widgets", &session(OTHER, None, "walrus", "2026-10-30T09:03:00.000Z")).await;
    let gone = sids(&app, &[PARENT, CHILD]);
    let r = app.delete(&format!("sessions/{CHILD}")).await;
    assert_eq!(r.json(), json!({ "deletedSessions": 2, "deletedHerderRuns": 0 }));
    assert_gone(&app, &[PARENT, CHILD], &gone);
    assert_eq!(ids(&app.json("sessions").await), [OTHER]);
}

#[tokio::test]
async fn shared_blobs_stay_while_referenced() {
    let app = app();
    family(&app).await;
    let (batch, child_hashes) = request("r-child", CHILD, &["child only", "shared block"], true);
    app.ok_ingest(batch).await;
    let (batch, other_hashes) = request("r-other", OTHER, &["shared block"], true);
    app.ok_ingest(batch).await;
    // A line over 1 MiB lives in the blob store too.
    let big = json!({ "type": "message", "id": "big", "parentId": "m3", "timestamp": "2026-10-30T12:00:00.000Z",
                      "message": { "role": "user", "content": "q".repeat((1 << 20) + 10), "timestamp": 9 } }).to_string();
    let offset = byte_len(&session(GRANDCHILD, Some(CHILD), "xerus", "2026-10-30T09:02:00.000Z"));
    app.ok_ingest(json!({ "streams": [stream(&format!("session:{GRANDCHILD}"), "session", offset, std::slice::from_ref(&big))] })).await;
    let line_hash = pika::util::sha256_hex(big.as_bytes());
    let (child_only, shared) = (&child_hashes[0], &other_hashes[0]);
    assert_eq!(&child_hashes[1], shared);
    let blobs = &app.env.store.blobs;
    for hash in [child_only, shared, &line_hash] {
        assert!(blobs.path(hash).exists());
    }

    app.delete(&format!("sessions/{CHILD}")).await;
    let have = |hash: &str| app.count(&format!("SELECT COUNT(*) FROM blobs WHERE hash = '{hash}'")) == 1;
    assert!(!have(child_only) && !blobs.path(child_only).exists());
    assert!(!have(&line_hash) && !blobs.path(&line_hash).exists());
    assert!(have(shared) && blobs.path(shared).exists());
    let r = app.json("requests/r-other").await;
    assert_eq!((r["complete"].clone(), r["payload"]["messages"][0]["content"].clone()), (json!(true), json!("shared block")));

    app.delete(&format!("sessions/{OTHER}")).await;
    assert!(!have(shared) && !blobs.path(shared).exists());
    assert_eq!(app.count("SELECT COUNT(*) FROM blobs"), 0);
}

#[tokio::test]
async fn ingest_asks_again_for_a_collected_blob() {
    let app = app();
    family(&app).await;
    let (batch, hashes) = request("r-child", CHILD, &["remembered block"], true);
    app.ok_ingest(batch).await;
    app.delete(&format!("sessions/{CHILD}")).await;
    assert!(!app.env.store.blobs.path(&hashes[0]).exists());
    // The client's cache still lists the block as acknowledged, so it sends the request alone.
    let (batch, _) = request("r-other", OTHER, &["remembered block"], false);
    assert_eq!(app.ok_ingest(batch).await["missingBlobs"], json!(hashes));
    assert_eq!(app.json("requests/r-other").await["complete"], false);
    let (batch, _) = request("r-other", OTHER, &["remembered block"], true);
    assert_eq!(app.ok_ingest(batch).await["missingBlobs"], json!([]));
    let r = app.json("requests/r-other").await;
    assert_eq!((r["complete"].clone(), r["payload"]["messages"][0]["content"].clone()), (json!(true), json!("remembered block")));
    assert!(app.env.store.blobs.path(&hashes[0]).exists());
}

#[tokio::test]
async fn deleted_streams_stay_deleted() {
    let app = app();
    family(&app).await;
    let lines = session(CHILD, Some(PARENT), "yak", "2026-10-30T09:01:00.000Z");
    let length = byte_len(&lines);
    app.delete(&format!("sessions/{CHILD}")).await;

    // A running client continues from its acknowledged offset: accepted, discarded, and acknowledged.
    let key = format!("session:{CHILD}");
    let next = more("yak");
    let r = app.ok_ingest(json!({ "streams": [stream(&key, "session", length, &next)] })).await;
    assert_eq!(r["streams"][&key]["length"], length + byte_len(&next));
    // A client that starts over from offset 0 does not bring it back either.
    let r = app.ok_ingest(json!({ "streams": [stream(&key, "session", 0, &lines)] })).await;
    assert_eq!(r["streams"][&key]["length"], length);
    // Its requests are discarded, and so are blobs only they need.
    let (batch, hashes) = request("r-late", CHILD, &["late block"], true);
    assert_eq!(app.ok_ingest(batch).await["missingBlobs"], json!([]));
    assert_eq!(app.count("SELECT COUNT(*) FROM requests"), 0);
    assert_eq!(app.count(&format!("SELECT COUNT(*) FROM blobs WHERE hash = '{}'", hashes[0])), 0);
    // A gap is no 409 for a deleted stream.
    let r = app.ingest(json!({ "streams": [stream(&key, "session", length * 10, &next)] })).await;
    assert_eq!(r.status, StatusCode::OK);

    assert_eq!(app.get(&format!("sessions/{CHILD}")).await.status, StatusCode::NOT_FOUND);
    assert_eq!(app.count(&format!("SELECT COUNT(*) FROM streams WHERE key = '{key}'")), 0);
    assert_eq!(app.json(&format!("sessions/{PARENT}")).await["childCount"], 0);
    pika::reindex::reindex(&app.env.store).unwrap();
    assert_eq!(app.get(&format!("sessions/{CHILD}")).await.status, StatusCode::NOT_FOUND);
    assert_eq!(app.count("SELECT COUNT(*) FROM deleted_streams"), 2);
    assert_eq!(ids(&app.json("sessions").await), [OTHER, PARENT]);
}

fn journal(steps: bool) -> Vec<String> {
    let mut values = vec![json!({ "v": 1, "t": "run.started", "at": "2026-10-30T10:00:00.000Z", "runId": RUN, "title": "Ship it",
                                  "base": "b", "repo": "/home/me/code/widgets", "sessionId": PARENT })];
    if steps {
        values.push(json!({ "v": 1, "t": "step.started", "at": "2026-10-30T10:01:00.000Z", "key": "impl-T1", "id": "impl-T1",
                            "attempt": 1, "role": "worker", "task": "T1", "launch": 1, "sessionId": STEP }));
    }
    values.iter().map(Value::to_string).collect()
}

#[tokio::test]
async fn deleting_a_project_takes_its_sessions_runs_and_selection() {
    let app = app();
    family(&app).await;
    // A child filed under another project goes with its parent; the other project's own session stays.
    app.upload("elsewhere", "gadgets", &session("elsewhere", Some(OTHER), "vole", "2026-10-30T09:05:00.000Z")).await;
    app.upload("gadget", "gadgets", &session("gadget", None, "urial", "2026-10-30T09:06:00.000Z")).await;
    // A Herder step session without a link, known only from the journal, filed under no project of these.
    app.upload(STEP, "steps", &session(STEP, None, "tapir", "2026-10-30T10:01:00.000Z")).await;
    let run_key = format!("herder:{RUN}");
    let journal_lines = journal(true);
    app.ok_ingest(json!({
        "streams": [stream(&run_key, "herder-journal", 0, &journal_lines)],
        "documents": [
            { "key": format!("{run_key}:goal.md"), "kind": "herder-goal", "runId": RUN, "content": "# Goal" },
            { "key": format!("{run_key}:plan.md"), "kind": "herder-plan", "runId": RUN, "content": "# Plan" },
        ],
    }))
    .await;
    app.publish("widgets").await;
    app.publish("gadgets").await;
    assert_eq!(app.json("herder/runs").await["items"][0]["repo"], "widgets");
    assert_eq!(
        app.json("projects/widgets/deletion").await,
        json!({ "deletedSessions": 6, "deletedHerderRuns": 1 })
    );

    let r = app.delete("projects/widgets").await;
    assert_eq!((r.status, r.json()), (StatusCode::OK, json!({ "deletedSessions": 6, "deletedHerderRuns": 1 })));
    assert_eq!(ids(&app.json("sessions").await), ["gadget"]);
    assert_eq!(app.json("herder/runs").await["items"], json!([]));
    assert_eq!(app.get(&format!("herder/runs/{RUN}")).await.status, StatusCode::NOT_FOUND);
    assert_eq!(app.count("SELECT COUNT(*) FROM documents"), 0);
    for table in ["herder_runs", "herder_events", "herder_steps"] {
        assert_eq!(app.count(&format!("SELECT COUNT(*) FROM {table}")), 0, "{table}");
    }
    let settings = app.json("settings/publishing").await;
    assert_eq!(
        settings["projects"],
        json!([{ "project": "gadgets", "sessionCount": 1, "hiddenCount": 0, "published": true }])
    );
    // The run is tombstoned: its journal, its documents, and its steps' sessions are discarded.
    let r = app.ok_ingest(json!({
        "streams": [stream(&run_key, "herder-journal", 0, &journal_lines)],
        "documents": [{ "key": format!("{run_key}:plan.md"), "kind": "herder-plan", "runId": RUN, "content": "# Plan 2" }],
    }))
    .await;
    assert_eq!(r["streams"][&run_key]["length"], byte_len(&journal_lines));
    assert_eq!(app.count("SELECT COUNT(*) FROM documents"), 0);
    assert_eq!(app.json("herder/runs").await["items"], json!([]));
    // A new project of the same name starts private.
    app.upload("fresh", "widgets", &session("fresh", None, "sloth", "2026-10-31T09:00:00.000Z")).await;
    assert_eq!(ids(&app.public_json("sessions").await), ["gadget"]);

    // Nothing under a name is a 404; a dangling selection is cleared with zero counts.
    app.delete("sessions/fresh").await;
    assert_eq!(app.delete("projects/widgets").await.status, StatusCode::NOT_FOUND);
    app.delete("sessions/gadget").await;
    let r = app.delete("projects/gadgets").await;
    assert_eq!((r.status, r.json()), (StatusCode::OK, json!({ "deletedSessions": 0, "deletedHerderRuns": 0 })));
    assert_eq!(app.json("settings/publishing").await["projects"], json!([]));
    assert_eq!(app.delete("projects/gadgets").await.status, StatusCode::NOT_FOUND);
    for name in ["..", "a%2Fb", "%20"] {
        assert_eq!(app.delete(&format!("projects/{name}")).await.status, StatusCode::BAD_REQUEST, "{name}");
    }
}

#[tokio::test]
async fn project_names_are_percent_decoded() {
    let app = app();
    app.upload(PARENT, "my widgets ü", &session(PARENT, None, "zebra", "2026-10-30T09:00:00.000Z")).await;
    let r = app.delete("projects/my%20widgets%20%C3%BC").await;
    assert_eq!(r.json(), json!({ "deletedSessions": 1, "deletedHerderRuns": 0 }));
}

/// Every public resource of the session is a 404, and no public list or search names it.
async fn assert_private(app: &App, id: &str, word: &str) {
    for path in [
        format!("sessions/{id}"),
        format!("sessions/{id}/tree"),
        format!("sessions/{id}/turns"),
        format!("sessions/{id}/entries"),
        format!("sessions/{id}/entries/1/raw"),
        format!("sessions/{id}/entries/4/image/0"),
        format!("sessions/{id}/trace"),
        format!("sessions/{id}/updates"),
    ] {
        assert_eq!(app.public(&path).await.status, StatusCode::NOT_FOUND, "{path}");
    }
    for query in ["", "?root=true", "?project=widgets"] {
        assert!(!ids(&app.public_json(&format!("sessions{query}")).await).contains(&id.to_owned()), "{query}");
    }
    for query in [format!("q={word}"), format!("q={word}&sort=relevance"), format!("q={word}&group=session")] {
        assert_eq!(app.public_json(&format!("search?{query}")).await["items"], json!([]), "{query}");
    }
}

async fn assert_public(app: &App, id: &str, word: &str) {
    for path in [format!("sessions/{id}"), format!("sessions/{id}/trace"), format!("sessions/{id}/entries/4/image/0")] {
        assert_eq!(app.public(&path).await.status, StatusCode::OK, "{path}");
    }
    assert!(ids(&app.public_json("sessions").await).contains(&id.to_owned()));
    assert!(!app.public_json(&format!("search?q={word}")).await["items"].as_array().unwrap().is_empty());
}

#[tokio::test]
async fn hidden_sessions_and_their_descendants_leave_the_public_view() {
    let app = app();
    family(&app).await;
    app.publish("widgets").await;
    for (id, word) in [(PARENT, "zebra"), (CHILD, "yak"), (GRANDCHILD, "xerus")] {
        assert_public(&app, id, word).await;
    }

    // Hiding the child hides the grandchild; the parent stays public without them.
    let r = app.hide(CHILD, true).await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!((r.json()["id"].clone(), r.json()["hidden"].clone(), r.json()["hiddenBy"].clone()), (json!(CHILD), json!(true), json!(CHILD)));
    for (id, word) in [(CHILD, "yak"), (GRANDCHILD, "xerus")] {
        assert_private(&app, id, word).await;
    }
    assert_public(&app, PARENT, "zebra").await;
    let parent = app.public_json(&format!("sessions/{PARENT}")).await;
    assert_eq!((parent["childCount"].clone(), parent["children"].clone()), (json!(0), json!([])));
    assert!(parent.get("hidden").is_none());
    let tree = app.public_json(&format!("sessions/{PARENT}/tree")).await;
    assert_eq!(tree["nodes"].as_array().unwrap().len(), 1);
    let trace = app.public_json(&format!("sessions/{PARENT}/trace")).await;
    assert_eq!(trace["children"], json!([]));
    assert_eq!(app.public_json("search?q=zebra&group=session").await["items"].as_array().unwrap().len(), 1);
    // The owner sees them all, marked.
    let owner = app.json(&format!("sessions/{PARENT}")).await;
    assert_eq!((owner["hidden"].clone(), owner["childCount"].clone()), (json!(false), json!(1)));
    assert_eq!(owner["children"][0]["hidden"], true);
    let grandchild = app.json(&format!("sessions/{GRANDCHILD}")).await;
    assert_eq!((grandchild["hidden"].clone(), grandchild["hiddenBy"].clone()), (json!(true), json!(CHILD)));
    let tree = app.json(&format!("sessions/{PARENT}/tree")).await;
    let marks: Vec<(Value, Value)> = tree["nodes"].as_array().unwrap().iter().map(|n| (n["hidden"].clone(), n["hiddenBy"].clone())).collect();
    assert_eq!(marks, [(json!(false), Value::Null), (json!(true), json!(CHILD)), (json!(true), json!(CHILD))]);
    let list = app.json("sessions").await;
    assert!(list["items"].as_array().unwrap().iter().all(|s| s["hidden"].is_boolean()));
    assert_eq!(app.json(&format!("sessions/{GRANDCHILD}/updates")).await["session"]["hidden"], true);
    assert_eq!(
        app.json("settings/publishing").await["projects"],
        json!([{ "project": "widgets", "sessionCount": 4, "hiddenCount": 2, "published": true }])
    );

    // A descendant recorded after hiding is hidden too, as is one whose link arrives later.
    let late = "l0000000-0000-0000-0000-000000000009";
    app.upload(late, "widgets", &session(late, Some(GRANDCHILD), "vicuna", "2026-10-30T09:09:00.000Z")).await;
    assert_private(&app, late, "vicuna").await;
    let relinked = "r0000000-0000-0000-0000-00000000000a";
    let lines = session(relinked, None, "urchin", "2026-10-30T09:10:00.000Z");
    app.upload(relinked, "widgets", &lines[..1]).await;
    assert_eq!(app.public(&format!("sessions/{relinked}")).await.status, StatusCode::OK);
    let mut rest = lines[2..].to_vec();
    rest.insert(0, json!({ "type": "custom", "id": "l1", "parentId": null, "timestamp": "2026-10-30T09:10:00.000Z",
                           "customType": "pi-extensions.session-link", "data": { "kind": "subagent", "parentSessionId": CHILD } }).to_string());
    app.ok_ingest(json!({ "streams": [stream(&format!("session:{relinked}"), "session", byte_len(&lines[..1]), &rest)] })).await;
    assert_private(&app, relinked, "urchin").await;
    // A child recorded before its hidden parent is hidden once the parent is recorded.
    let orphan = "o0000000-0000-0000-0000-00000000000b";
    let hidden_parent = "h0000000-0000-0000-0000-00000000000c";
    app.upload(orphan, "widgets", &session(orphan, Some(hidden_parent), "tarsier", "2026-10-30T09:11:00.000Z")).await;
    assert_public(&app, orphan, "tarsier").await;
    assert!(ids(&app.public_json("sessions?root=true").await).contains(&orphan.to_owned()));
    app.upload(hidden_parent, "widgets", &session(hidden_parent, None, "saki", "2026-10-30T09:12:00.000Z")).await;
    app.hide(hidden_parent, true).await;
    assert_private(&app, orphan, "tarsier").await;
    assert_private(&app, hidden_parent, "saki").await;

    // Hidden flags survive a reindex.
    pika::reindex::reindex(&app.env.store).unwrap();
    for (id, word) in [(CHILD, "yak"), (GRANDCHILD, "xerus"), (late, "vicuna"), (relinked, "urchin"), (orphan, "tarsier")] {
        assert_private(&app, id, word).await;
    }
    assert_public(&app, PARENT, "zebra").await;

    // Unhiding brings the subtree back.
    let r = app.hide(CHILD, false).await;
    assert_eq!((r.json()["hidden"].clone(), r.json().get("hiddenBy").cloned()), (json!(false), None));
    for (id, word) in [(CHILD, "yak"), (GRANDCHILD, "xerus"), (late, "vicuna"), (relinked, "urchin")] {
        assert_public(&app, id, word).await;
    }
    assert_eq!(app.public_json(&format!("sessions/{PARENT}")).await["childCount"], 1);
    assert_eq!(app.hide("nope", true).await.status, StatusCode::NOT_FOUND);
    let r = app.send(Method::PATCH, &format!("/api/v1/sessions/{CHILD}"), Some(json!({ "hidden": "yes" }))).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn a_project_of_hidden_sessions_leaves_the_gallery() {
    let app = app();
    family(&app).await;
    app.upload("gadget", "gadgets", &session("gadget", None, "urial", "2026-10-30T09:06:00.000Z")).await;
    app.publish("widgets").await;
    app.publish("gadgets").await;
    assert_eq!(app.public_json("facets").await["projects"], json!(["gadgets", "widgets"]));
    app.hide(PARENT, true).await;
    app.hide(OTHER, true).await;
    let facets = app.public_json("facets").await;
    assert_eq!((facets["projects"].clone(), facets["models"].clone()), (json!(["gadgets"]), json!(["gpt-6"])));
    assert_eq!(ids(&app.public_json("sessions").await), ["gadget"]);
    assert_eq!(ids(&app.public_json("sessions?root=true").await), ["gadget"]);
    assert_eq!(app.json("facets").await["projects"], json!(["gadgets", "widgets"]));
}

#[tokio::test]
async fn owner_routes_need_a_signed_in_session() {
    let mut app = app_with(Some("correct horse battery"));
    family(&app).await;
    for (method, path, body) in [
        (Method::DELETE, format!("/api/v1/sessions/{PARENT}"), None),
        (Method::PATCH, format!("/api/v1/sessions/{PARENT}"), Some(json!({ "hidden": true }))),
        (Method::GET, format!("/api/v1/sessions/{PARENT}/deletion"), None),
        (Method::DELETE, "/api/v1/projects/widgets".into(), None),
        (Method::GET, "/api/v1/projects/widgets/deletion".into(), None),
    ] {
        let r = app.send(method.clone(), &path, body.clone()).await;
        assert_eq!(r.status, StatusCode::UNAUTHORIZED, "{method} {path}");
        // The public namespace has none of them.
        let public = path.replace("/api/v1/", "/api/public/v1/");
        let r = app.send(method.clone(), &public, body).await;
        assert!(matches!(r.status, StatusCode::NOT_FOUND | StatusCode::METHOD_NOT_ALLOWED), "{method} {public}: {}", r.status);
    }
    assert_eq!(app.count("SELECT COUNT(*) FROM sessions"), 4);
    // A form post cannot hide a session.
    let response = app
        .app
        .clone()
        .oneshot(Request::post("/api/v1/login").header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(json!({ "password": "correct horse battery" }).to_string())).unwrap())
        .await
        .unwrap();
    let cookie = response.headers()[header::SET_COOKIE].to_str().unwrap().split(';').next().unwrap().to_owned();
    app.cookie = Some(cookie);
    let form = app.app.clone().oneshot(
        Request::patch(format!("/api/v1/sessions/{PARENT}"))
            .header(header::COOKIE, app.cookie.clone().unwrap())
            .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded")
            .body(Body::from("hidden=true")).unwrap(),
    ).await.unwrap();
    assert_eq!(form.status(), StatusCode::UNSUPPORTED_MEDIA_TYPE);
    assert_eq!(app.hide(PARENT, true).await.status, StatusCode::OK);
    let r = app.delete(&format!("sessions/{CHILD}")).await;
    assert_eq!(r.json(), json!({ "deletedSessions": 2, "deletedHerderRuns": 0 }));
}

#[test]
fn version_9_databases_gain_tombstones_and_hidden_sessions() {
    let env = env();
    let token = device(&env.store, DEVICE);
    drop(token);
    upload(&env.store, &format!("session:{PARENT}"), "session", &session(PARENT, None, "zebra", "2026-10-30T09:00:00.000Z"), 2);
    let path = env.dir.path().join("data");
    drop(env.store);
    let conn = rusqlite::Connection::open(path.join("pika.db")).unwrap();
    conn.execute_batch(&format!("{UNDO_V10} PRAGMA user_version = 9;")).unwrap();
    drop(conn);
    let store = pika::store::Store::open(&path).unwrap();
    assert_eq!(one(&store, "PRAGMA user_version")["user_version"], json!(20));
    for table in ["deleted_streams", "hidden_sessions", "session_hidden"] {
        assert_eq!(one(&store, &format!("SELECT COUNT(*) AS n FROM {table}"))["n"], json!(0), "{table}");
    }
    assert_eq!(one(&store, "SELECT COUNT(*) AS n FROM sessions")["n"], json!(1));
    assert!(store.setting(pika::store::NEEDS_REINDEX).unwrap().is_none());
    let deleted = pika::delete::delete_session(&store, PARENT).unwrap().unwrap();
    assert_eq!(deleted.deleted_sessions, 1);
}

/// Every owner and public resource of the session is a 404, and no list names it.
async fn assert_deleted(app: &App, id: &str, word: &str) {
    for path in [
        format!("sessions/{id}"),
        format!("sessions/{id}/tree"),
        format!("sessions/{id}/turns"),
        format!("sessions/{id}/entries"),
        format!("sessions/{id}/trace"),
        format!("sessions/{id}/deletion"),
    ] {
        assert_eq!(app.get(&path).await.status, StatusCode::NOT_FOUND, "{path}");
    }
    for query in ["", "?root=true", "?project=widgets"] {
        assert!(!ids(&app.json(&format!("sessions{query}")).await).contains(&id.to_owned()), "{query}");
    }
    assert_eq!(app.json(&format!("search?q={word}")).await["items"], json!([]));
    assert_private(app, id, word).await;
    assert_eq!(app.count(&format!("SELECT COUNT(*) FROM streams WHERE key = 'session:{id}'")), 0);
    assert_eq!(app.count(&format!("SELECT COUNT(*) FROM deleted_streams WHERE key = 'session:{id}'")), 1);
}

#[tokio::test]
async fn late_children_of_a_deleted_session_are_deleted_on_arrival() {
    let app = app();
    app.upload(PARENT, "widgets", &session(PARENT, None, "zebra", "2026-10-30T09:00:00.000Z")).await;
    app.upload(OTHER, "widgets", &session(OTHER, None, "walrus", "2026-10-30T09:03:00.000Z")).await;
    app.publish("widgets").await;
    app.delete(&format!("sessions/{PARENT}")).await;

    // A child the running parent creates afterwards, with a request and a large line, goes on arrival.
    let lines = session(CHILD, Some(PARENT), "yak", "2026-10-30T09:01:00.000Z");
    let big = json!({ "type": "message", "id": "big", "parentId": "m3", "timestamp": "2026-10-30T12:00:00.000Z",
                      "message": { "role": "user", "content": "q".repeat((1 << 20) + 10), "timestamp": 9 } }).to_string();
    let mut child_lines = lines.clone();
    child_lines.push(big.clone());
    let (mut batch, hashes) = request("r-child", CHILD, &["late child block"], true);
    let key = format!("session:{CHILD}");
    batch["streams"] = json!([stream(&key, "session", 0, &child_lines)]);
    let r = app.ok_ingest(batch).await;
    let length = byte_len(&child_lines);
    assert_eq!((r["streams"][&key]["length"].clone(), r["missingBlobs"].clone()), (json!(length), json!([])));
    assert_deleted(&app, CHILD, "yak").await;
    assert_eq!(app.count("SELECT COUNT(*) FROM requests"), 0);
    assert_eq!(app.count("SELECT COUNT(*) FROM blobs"), 0);
    for hash in [&hashes[0], &pika::util::sha256_hex(big.as_bytes())] {
        assert!(!app.env.store.blobs.path(hash).exists());
    }
    // Its client continues from where it was: accepted and discarded, no 409.
    let next = more("yak");
    let r = app.ok_ingest(json!({ "streams": [stream(&key, "session", length, &next)] })).await;
    assert_eq!(r["streams"][&key]["length"], length + byte_len(&next));
    let (batch, _) = request("r-child-2", CHILD, &["later block"], true);
    assert_eq!(app.ok_ingest(batch).await["missingBlobs"], json!([]));
    assert_eq!(app.count("SELECT COUNT(*) FROM requests"), 0);

    // Its own child goes in turn.
    app.upload(GRANDCHILD, "widgets", &session(GRANDCHILD, Some(CHILD), "xerus", "2026-10-30T09:02:00.000Z")).await;
    assert_deleted(&app, GRANDCHILD, "xerus").await;
    // A child that names the deleted parent by the header's session file path, without a link.
    let forked = "f0000000-0000-0000-0000-00000000000d";
    let mut header = vec![json!({ "type": "session", "version": 3, "id": forked, "timestamp": "2026-10-30T09:04:00.000Z", "cwd": "/x",
                                  "parentSession": format!("/x/sessions/2026-10-30T09-00-00-000Z_{PARENT}.jsonl") }).to_string()];
    header.extend(session(forked, None, "vole", "2026-10-30T09:04:00.000Z")[1..].iter().cloned());
    app.upload(forked, "widgets", &header).await;
    assert_deleted(&app, forked, "vole").await;
    // A descendant recorded before its late parent goes with it.
    let early = "e0000000-0000-0000-0000-00000000000e";
    let late = "l0000000-0000-0000-0000-00000000000f";
    app.upload(early, "widgets", &session(early, Some(late), "urial", "2026-10-30T09:05:00.000Z")).await;
    assert!(ids(&app.public_json("sessions").await).contains(&early.to_owned()));
    app.upload(late, "widgets", &session(late, Some(PARENT), "tapir", "2026-10-30T09:06:00.000Z")).await;
    assert_deleted(&app, late, "tapir").await;
    assert_deleted(&app, early, "urial").await;

    assert_eq!(ids(&app.json("sessions").await), [OTHER]);
    assert_eq!(ids(&app.public_json("sessions").await), [OTHER]);
    assert_eq!(app.count("SELECT COUNT(*) FROM deleted_streams"), 6);
    assert_gone(&app, &[CHILD, GRANDCHILD, forked, early, late], &[]);
    pika::reindex::reindex(&app.env.store).unwrap();
    for (id, word) in [(CHILD, "yak"), (GRANDCHILD, "xerus"), (forked, "vole"), (early, "urial"), (late, "tapir")] {
        assert_deleted(&app, id, word).await;
    }
    assert_eq!(app.count("SELECT COUNT(*) FROM deleted_streams"), 6);
    assert_eq!(ids(&app.public_json("sessions").await), [OTHER]);
}

#[tokio::test]
async fn a_late_child_of_a_hidden_deleted_session_stays_out_of_the_public_view() {
    let app = app();
    app.upload(PARENT, "widgets", &session(PARENT, None, "zebra", "2026-10-30T09:00:00.000Z")).await;
    app.upload(OTHER, "widgets", &session(OTHER, None, "walrus", "2026-10-30T09:03:00.000Z")).await;
    app.hide(PARENT, true).await;
    app.delete(&format!("sessions/{PARENT}")).await;
    app.publish("widgets").await;
    app.upload(CHILD, "widgets", &session(CHILD, Some(PARENT), "yak", "2026-10-30T09:01:00.000Z")).await;
    assert_deleted(&app, CHILD, "yak").await;
    assert_eq!(ids(&app.public_json("sessions?root=true").await), [OTHER]);
}

#[tokio::test]
async fn a_child_whose_link_arrives_later_is_deleted_then() {
    let app = app();
    app.upload(PARENT, "widgets", &session(PARENT, None, "zebra", "2026-10-30T09:00:00.000Z")).await;
    app.publish("widgets").await;
    app.delete(&format!("sessions/{PARENT}")).await;
    let lines = session(CHILD, Some(PARENT), "yak", "2026-10-30T09:01:00.000Z");
    let key = format!("session:{CHILD}");
    // The header alone records a root session.
    app.upload(CHILD, "widgets", &lines[..1]).await;
    assert_eq!(ids(&app.public_json("sessions?root=true").await), [CHILD]);
    let r = app.ok_ingest(json!({ "streams": [stream(&key, "session", byte_len(&lines[..1]), &lines[1..])] })).await;
    assert_eq!(r["streams"][&key]["length"], byte_len(&lines));
    assert_deleted(&app, CHILD, "yak").await;
    let next = more("yak");
    let r = app.ok_ingest(json!({ "streams": [stream(&key, "session", byte_len(&lines), &next)] })).await;
    assert_eq!(r["streams"][&key]["length"], byte_len(&lines) + byte_len(&next));
    pika::reindex::reindex(&app.env.store).unwrap();
    assert_deleted(&app, CHILD, "yak").await;
}

#[tokio::test]
async fn a_new_step_session_of_a_deleted_herder_run_is_deleted_on_arrival() {
    let app = app();
    app.upload(PARENT, "widgets", &session(PARENT, None, "zebra", "2026-10-30T09:00:00.000Z")).await;
    app.upload("gadget", "gadgets", &session("gadget", None, "urial", "2026-10-30T09:06:00.000Z")).await;
    let run_key = format!("herder:{RUN}");
    app.ok_ingest(json!({ "streams": [stream(&run_key, "herder-journal", 0, &journal(false))] })).await;
    app.publish("gadgets").await;
    app.delete("projects/widgets").await;

    // A step the run starts afterwards, filed under another project and linked to no session, names only the run.
    let mut lines = session(STEP, None, "tapir", "2026-10-30T10:01:00.000Z");
    lines[1] = json!({ "type": "custom", "id": "l1", "parentId": null, "timestamp": "2026-10-30T10:01:00.000Z",
                       "customType": "pi-extensions.session-link",
                       "data": { "kind": "herder", "herder": { "runId": RUN, "stepKey": "impl-T2", "role": "worker" } } }).to_string();
    let key = format!("session:{STEP}");
    let r = app.ok_ingest(json!({ "streams": [{ "key": key, "kind": "session", "offset": 0, "lines": lines,
                                                "meta": { "sessionId": STEP, "cwd": "/x", "project": "gadgets" } }] })).await;
    assert_eq!(r["streams"][&key]["length"], byte_len(&lines));
    assert_deleted(&app, STEP, "tapir").await;
    assert_eq!(ids(&app.json("sessions").await), ["gadget"]);
    pika::reindex::reindex(&app.env.store).unwrap();
    assert_deleted(&app, STEP, "tapir").await;
    assert_eq!(ids(&app.public_json("sessions").await), ["gadget"]);
}

#[tokio::test]
async fn a_descendant_stays_hidden_while_any_ancestor_is() {
    let app = app();
    family(&app).await;
    app.publish("widgets").await;
    app.hide(PARENT, true).await;
    app.hide(CHILD, true).await;
    app.hide(CHILD, false).await;
    assert_private(&app, GRANDCHILD, "xerus").await;
    assert_eq!(app.json(&format!("sessions/{GRANDCHILD}")).await["hiddenBy"], PARENT);
    app.hide(PARENT, true).await;
    app.hide(CHILD, true).await;
    app.hide(PARENT, false).await;
    assert_private(&app, GRANDCHILD, "xerus").await;
    assert_eq!(app.json(&format!("sessions/{GRANDCHILD}")).await["hiddenBy"], CHILD);
    app.hide(CHILD, false).await;
    for (id, word) in [(PARENT, "zebra"), (CHILD, "yak"), (GRANDCHILD, "xerus")] {
        assert_public(&app, id, word).await;
    }
}

#[tokio::test]
async fn a_flag_kept_before_the_session_is_recorded_hides_it_from_its_first_upload() {
    let app = app();
    app.upload(OTHER, "widgets", &session(OTHER, None, "walrus", "2026-10-30T09:03:00.000Z")).await;
    app.publish("widgets").await;
    // As `pika reindex` keeps flags while it records every session again: the flag is there before the session.
    app.env.store.write(|tx| tx.execute(&format!("INSERT INTO hidden_sessions (id, hidden_at) VALUES ('{PARENT}', 1)"), [])).unwrap();
    app.upload(PARENT, "widgets", &session(PARENT, None, "zebra", "2026-10-30T09:00:00.000Z")).await;
    assert_private(&app, PARENT, "zebra").await;
    // A descendant of a hidden ancestor is hidden from its first upload on, whatever arrives first.
    app.upload(GRANDCHILD, "widgets", &session(GRANDCHILD, Some(CHILD), "xerus", "2026-10-30T09:02:00.000Z")).await;
    assert_public(&app, GRANDCHILD, "xerus").await;
    app.upload(CHILD, "widgets", &session(CHILD, Some(PARENT), "yak", "2026-10-30T09:01:00.000Z")).await;
    for (id, word) in [(CHILD, "yak"), (GRANDCHILD, "xerus")] {
        assert_private(&app, id, word).await;
    }
    let late = "l0000000-0000-0000-0000-000000000009";
    app.upload(late, "widgets", &session(late, Some(GRANDCHILD), "vicuna", "2026-10-30T09:09:00.000Z")).await;
    assert_private(&app, late, "vicuna").await;
    assert_eq!(app.json(&format!("sessions/{late}")).await["hiddenBy"], PARENT);
}
