mod common;

use std::collections::BTreeMap;

use axum::Router;
use axum::body::Body;
use axum::http::{Request, StatusCode, header};
use common::*;
use pika::config::{AuthMode, ServerConfig};
use pika::http::{AppState, router};
use pika::util::encode_path_segment;
use serde_json::{Value, json};
use tower::ServiceExt;

const BASE: &str = "/pika";
const DESKTOP: &str = "desktop";
/// The devices' names, which sort the other way round from their ids.
const DEVICE_NAME: &str = "Laptop";
const DESKTOP_NAME: &str = "Zed's desk";
const DESK_SESSION: &str = "d0000000-0000-0000-0000-00000000000d";
const HEADER_CHILD: &str = "c4ild000-0000-0000-0000-000000000001";
const LINKED_CHILD: &str = "c4ild000-0000-0000-0000-000000000003";
const STEP_SESSION: &str = "step-s2";
const REVIEW_SESSION: &str = "step-r1";
const RUN2: &str = "20261022-090000-ef01";
const IMAGE_B64: &str = "iVBORw0KGgr7/78=";
const IMAGE_BYTES: &[u8] = b"\x89PNG\r\n\x1a\n\xfb\xff\xbf";
const GOAL: &str = "# Goal\n\nAdd pagination to the widget list.\n";
const PLAN: &str = "# Plan\n\n- T1: cursor pagination\n";

struct Reply {
    status: StatusCode,
    headers: header::HeaderMap,
    body: Vec<u8>,
}

impl Reply {
    fn json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap_or_else(|_| panic!("not JSON: {}", String::from_utf8_lossy(&self.body)))
    }
    fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }
}

struct App {
    env: Env,
    app: Router,
    tokens: BTreeMap<String, String>,
}

fn app(password: Option<&str>) -> App {
    let env = env();
    let tokens = [(DEVICE, DEVICE_NAME), (DESKTOP, DESKTOP_NAME)]
        .iter()
        .map(|(d, name)| (d.to_string(), common::device_named(&env.store, d, name)))
        .collect();
    let mut config = ServerConfig::new(env.dir.path().join("data"));
    config.base_path = BASE.into();
    match password {
        Some(password) => config.password = Some(password.to_owned()),
        None => config.auth = AuthMode::None,
    }
    let app = router(AppState::new(env.store.clone(), config).unwrap());
    App { env, app, tokens }
}

/// Percent-encodes a query parameter value.
fn q(value: &str) -> String {
    encode_path_segment(value)
}

impl App {
    async fn send(&self, request: Request<Body>) -> Reply {
        let response = self.app.clone().oneshot(request).await.unwrap();
        let status = response.status();
        let headers = response.headers().clone();
        let body = axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap().to_vec();
        Reply { status, headers, body }
    }

    /// GETs an absolute path.
    async fn get_abs(&self, path: &str, cookie: Option<&str>) -> Reply {
        let mut request = Request::get(path);
        if let Some(cookie) = cookie {
            request = request.header(header::COOKIE, cookie);
        }
        self.send(request.body(Body::empty()).unwrap()).await
    }

    /// GETs a read API path relative to `{base}/api/v1/`.
    async fn get(&self, path: &str) -> Reply {
        self.get_abs(&format!("{BASE}/api/v1/{path}"), None).await
    }

    async fn json(&self, path: &str) -> Value {
        let r = self.get(path).await;
        assert_eq!(r.status, StatusCode::OK, "{path}: {}", r.text());
        r.json()
    }

    async fn status(&self, path: &str) -> StatusCode {
        self.get(path).await.status
    }

    async fn ingest(&self, device: &str, batch: Value) -> Value {
        let request = Request::post(format!("{BASE}/api/ingest/v1/batch"))
            .header(header::CONTENT_TYPE, "application/json")
            .header(header::AUTHORIZATION, format!("Bearer {}", self.tokens[device]))
            .body(Body::from(batch.to_string()))
            .unwrap();
        let r = self.send(request).await;
        assert_eq!(r.status, StatusCode::OK, "{}", r.text());
        r.json()
    }

    async fn append(&self, device: &str, key: &str, kind: &str, offset: u64, lines: &[String]) {
        self.ingest(device, json!({ "streams": [stream(key, kind, offset, lines)] })).await;
    }

    async fn upload(&self, device: &str, key: &str, kind: &str, lines: &[String]) {
        self.append(device, key, kind, 0, lines).await;
    }

    /// Every item of a paged list, following `nextCursor` with `limit` items per page.
    async fn all_pages(&self, path: &str, limit: usize) -> Vec<Value> {
        let sep = if path.contains('?') { '&' } else { '?' };
        let mut items = Vec::new();
        let mut cursor: Option<String> = None;
        loop {
            let url = match &cursor {
                Some(c) => format!("{path}{sep}limit={limit}&cursor={c}"),
                None => format!("{path}{sep}limit={limit}"),
            };
            let page = self.json(&url).await;
            let got = page["items"].as_array().unwrap();
            assert!(got.len() <= limit);
            items.extend(got.iter().cloned());
            match page["nextCursor"].as_str() {
                Some(next) => cursor = Some(next.to_owned()),
                None => return items,
            }
        }
    }
}

fn lines(values: &[Value]) -> Vec<String> {
    values.iter().map(Value::to_string).collect()
}

fn skey(id: &str) -> String {
    format!("session:{id}")
}

fn assistant(text: &str, model: &str, ts: i64) -> Value {
    json!({ "role": "assistant", "content": [{ "type": "text", "text": text }], "api": "openai-responses",
            "provider": "openai", "model": model,
            "usage": { "input": 10, "output": 5, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 15, "cost": { "total": 0.001 } },
            "stopReason": "stop", "timestamp": ts })
}

fn header_child() -> Vec<String> {
    let parent_file = format!("/home/me/.pi/agent/sessions/--x--/2026-10-20T09-00-00-000Z_{SESSION_ID}.jsonl");
    lines(&[json!({ "type": "session", "version": 3, "id": HEADER_CHILD, "timestamp": "2026-10-20T10:00:00.000Z",
                    "cwd": "/home/me/code/widgets", "parentSession": parent_file })])
}

fn linked_child() -> Vec<String> {
    lines(&[
        json!({ "type": "session", "version": 3, "id": LINKED_CHILD, "timestamp": "2026-10-20T09:00:06.000Z", "cwd": "/home/me/code/widgets" }),
        json!({ "type": "custom", "id": "l0000001", "parentId": null, "timestamp": "2026-10-20T09:00:06.100Z",
                "customType": "pi-extensions.session-link",
                "data": { "kind": "subagent", "parentSessionId": SESSION_ID, "parentToolCallId": "call_1", "agentId": "agent-3",
                          "agentType": "recon", "description": "Look around" } }),
        json!({ "type": "message", "id": "l0000002", "parentId": "l0000001", "timestamp": "2026-10-20T09:00:06.200Z",
                "message": { "role": "user", "content": "Inspect the spin test", "timestamp": 1 } }),
        json!({ "type": "message", "id": "l0000003", "parentId": "l0000002", "timestamp": "2026-10-20T09:00:06.900Z",
                "message": assistant("The spin test sleeps for ten milliseconds.", "claude-haiku-4-5", 2) }),
    ])
}

fn step_session(id: &str, at: &str, step: &str, role: &str, (launch, attempt): (i64, i64), prompt: &str) -> Vec<String> {
    lines(&[
        json!({ "type": "session", "version": 3, "id": id, "timestamp": at, "cwd": "/home/me/.git/herder/worktrees/r1/x" }),
        json!({ "type": "custom", "id": "s0000001", "parentId": null, "timestamp": at, "customType": "pi-extensions.session-link",
                "data": { "kind": "herder-step", "parentSessionId": "orch-1",
                          "herder": { "runId": RUN_ID, "stepKey": step, "stepId": step, "task": "T1", "role": role,
                                      "attempt": attempt, "launch": launch, "repo": "widgets" } } }),
        json!({ "type": "message", "id": "s0000002", "parentId": "s0000001", "timestamp": at,
                "message": { "role": "user", "content": prompt, "timestamp": 1 } }),
    ])
}

fn desk_session() -> Vec<String> {
    lines(&[
        json!({ "type": "session", "version": 3, "id": DESK_SESSION, "timestamp": "2026-10-22T08:00:00.000Z", "cwd": "/srv/gadgets" }),
        json!({ "type": "message", "id": "d0000001", "parentId": null, "timestamp": "2026-10-22T08:00:01.000Z",
                "message": { "role": "user", "content": "Render <script>alert(\"x\")</script> & check the gadgets 🌀", "timestamp": 1 } }),
        json!({ "type": "message", "id": "d0000002", "parentId": "d0000001", "timestamp": "2026-10-22T08:00:03.000Z",
                "message": { "role": "assistant", "content": [{ "type": "text", "text": "Rendering gadgets now." },
                             { "type": "toolCall", "id": "call_d", "name": "bash", "arguments": { "command": "render --all\n--verbose" } }],
                             "api": "openai-responses", "provider": "openai", "model": "gpt-5", "stopReason": "toolUse", "timestamp": 2 } }),
        json!({ "type": "message", "id": "d0000003", "parentId": "d0000002", "timestamp": "2026-10-22T08:00:04.000Z",
                "message": { "role": "toolResult", "toolCallId": "call_d", "toolName": "bash", "isError": false, "timestamp": 3,
                             "content": [{ "type": "text", "text": "rendered 3 gadgets" }, { "type": "image", "data": IMAGE_B64, "mimeType": "image/png" }] } }),
        json!({ "type": "message", "id": "d0000004", "parentId": "d0000003", "timestamp": "2026-10-22T08:00:06.000Z",
                "message": assistant(&format!("Gadget log: {}", "é".repeat(70_000)), "gpt-5", 4) }),
    ])
}

fn run2_journal() -> Vec<String> {
    lines(&[
        json!({ "v": 1, "t": "run.started", "at": "2026-10-22T09:00:00.000Z", "runId": RUN2, "title": "Speed up gadgets", "base": "b1", "repo": "/srv/gadgets" }),
        json!({ "v": 1, "t": "step.started", "at": "2026-10-22T09:01:00.000Z", "key": "impl-T9", "id": "impl-T9", "attempt": 1, "role": "worker", "task": "T9", "launch": 1 }),
    ])
}

/// A captured model request as sent by the extension.
fn payload() -> Value {
    json!({
        "model": "claude-sonnet-4-5",
        "max_tokens": 1024,
        "system": [{ "type": "text", "text": "You are an expert coding assistant." }],
        "instructions": "Be careful. ".repeat(300),
        "messages": [
            { "role": "user", "content": "Why does `test_widget_spin` fail intermittently?" },
            { "role": "assistant", "content": [{ "type": "text", "text": "Let me run it." }] },
        ],
        "stream": true,
    })
}

fn request_batch(id: &str, ts: i64, payload: &Value, skip_blob: Option<usize>) -> (Value, Vec<(String, String)>) {
    let (skeleton, blocks) = pika::requests::split(payload);
    let blobs: Vec<Value> = blocks
        .iter()
        .enumerate()
        .filter(|(i, _)| Some(*i) != skip_blob)
        .map(|(_, (hash, data))| json!({ "hash": hash, "data": data }))
        .collect();
    let batch = json!({
        "blobs": blobs,
        "requests": [{ "id": id, "sessionId": SESSION_ID, "seq": 1, "at": "2026-10-20T09:00:02.400Z", "fidelity": "payload",
                       "provider": "anthropic", "api": "anthropic-messages", "model": "claude-sonnet-4-5",
                       "assistant": { "timestamp": ts, "responseId": "msg_01" }, "skeleton": skeleton,
                       "blocks": blocks.iter().map(|(h, _)| h.clone()).collect::<Vec<_>>() }],
    });
    (batch, blocks)
}

/// Uploads every fixture through the ingest API: a subagent parent with two children, Herder runs with their step
/// sessions and documents, a second device, and a captured request. Children arrive before and after their parent.
async fn load(app: &App) {
    app.upload(DEVICE, &skey(HEADER_CHILD), "session", &header_child()).await;
    app.upload(DEVICE, &skey(SESSION_ID), "session", &fixture("session.jsonl")).await;
    app.upload(DEVICE, &skey(LINKED_CHILD), "session", &linked_child()).await;
    app.upload(DEVICE, &format!("herder:{RUN_ID}"), "herder-journal", &fixture("herder-journal.jsonl")).await;
    let step = step_session(STEP_SESSION, "2026-10-21T10:05:31.000Z", "impl-T1", "worker", (1, 2), "Implement T1");
    app.upload(DEVICE, &skey(STEP_SESSION), "session", &step).await;
    let review = step_session(REVIEW_SESSION, "2026-10-21T10:09:11.000Z", "review-T1", "reviewer", (1, 1), "Review T1");
    app.upload(DEVICE, &skey(REVIEW_SESSION), "session", &review).await;
    app.ingest(
        DEVICE,
        json!({ "documents": [
            { "key": format!("herder:{RUN_ID}:goal.md"), "kind": "herder-goal", "runId": RUN_ID, "content": GOAL },
            { "key": format!("herder:{RUN_ID}:plan.md"), "kind": "herder-plan", "runId": RUN_ID, "content": PLAN },
        ] }),
    )
    .await;
    app.upload(DESKTOP, &skey(DESK_SESSION), "session", &desk_session()).await;
    app.upload(DESKTOP, &format!("herder:{RUN2}"), "herder-journal", &run2_journal()).await;
    let (batch, _) = request_batch("req-1", 1792486802500, &payload(), None);
    let r = app.ingest(DEVICE, batch).await;
    assert_eq!(r["missingBlobs"], json!([]));
}

async fn world() -> App {
    let app = app(None);
    load(&app).await;
    app
}

fn ids(items: &[Value], field: &str) -> Vec<String> {
    items.iter().map(|i| i[field].as_str().unwrap().to_owned()).collect()
}

async fn session_ids(app: &App, query: &str) -> Vec<String> {
    ids(app.json(&format!("sessions{query}")).await["items"].as_array().unwrap(), "id")
}

#[tokio::test]
async fn facets_and_session_list_filters() {
    let app = world().await;
    assert_eq!(
        app.json("facets").await,
        json!({ "devices": [{ "id": DEVICE, "name": DEVICE_NAME }, { "id": DESKTOP, "name": DESKTOP_NAME }],
                "projects": ["gadgets", "widgets"], "models": ["claude-haiku-4-5", "claude-sonnet-4-5", "gpt-5"] })
    );

    let newest_first = [DESK_SESSION, REVIEW_SESSION, STEP_SESSION, HEADER_CHILD, SESSION_ID, LINKED_CHILD];
    assert_eq!(session_ids(&app, "").await, newest_first);
    // Root sessions include children whose parent is not recorded: `parent-0001` and the steps' `orch-1`.
    assert_eq!(session_ids(&app, "?root=true").await, [DESK_SESSION, REVIEW_SESSION, STEP_SESSION, SESSION_ID]);
    assert_eq!(session_ids(&app, "?root=false").await, newest_first);
    assert_eq!(session_ids(&app, &format!("?device={DESKTOP}")).await, [DESK_SESSION]);
    assert_eq!(session_ids(&app, &format!("?device={DEVICE}")).await, newest_first[1..]);
    assert_eq!(session_ids(&app, "?project=gadgets").await, [DESK_SESSION]);
    assert_eq!(session_ids(&app, "?project=widgets").await, newest_first[1..]);
    assert_eq!(session_ids(&app, "?model=gpt-5").await, [DESK_SESSION, SESSION_ID]);
    assert_eq!(session_ids(&app, "?model=claude-haiku-4-5").await, [LINKED_CHILD]);
    assert_eq!(session_ids(&app, "?from=2026-10-21").await, [DESK_SESSION, REVIEW_SESSION, STEP_SESSION]);
    assert_eq!(session_ids(&app, "?to=2026-10-20T23:59:59.999Z").await, [HEADER_CHILD, SESSION_ID, LINKED_CHILD]);
    let from_ms = pika::util::parse_iso_ms("2026-10-20T09:01:00Z").unwrap();
    assert_eq!(session_ids(&app, &format!("?from={from_ms}&to=2026-10-20T12:00:00%2B02:00")).await, [HEADER_CHILD, SESSION_ID]);
    assert_eq!(session_ids(&app, &format!("?device={DEVICE}&project=widgets&model=gpt-5")).await, [SESSION_ID]);
    assert_eq!(session_ids(&app, &format!("?root=true&device={DEVICE}")).await, [REVIEW_SESSION, STEP_SESSION, SESSION_ID]);
    assert_eq!(session_ids(&app, "?root=true&project=gadgets&model=gpt-5&from=2026-10-22").await, [DESK_SESSION]);
    assert_eq!(session_ids(&app, "?device=nobody").await, Vec::<String>::new());
    assert_eq!(session_ids(&app, "?device=&project=").await, newest_first);

    for bad in ["?from=yesterday", "?to=2026-13-01", "?root=maybe", "?cursor=%%%", "?cursor=bm90IGpzb24", "?limit=many"] {
        let r = app.get(&format!("sessions{bad}")).await;
        assert_eq!((r.status, &r.json()["error"]), (StatusCode::BAD_REQUEST, &json!("bad_request")), "{bad}");
    }

    let paged = app.all_pages("sessions", 2).await;
    assert_eq!(ids(&paged, "id"), newest_first);
    let page = app.json("sessions?limit=6").await;
    assert_eq!(page["nextCursor"], Value::Null);
    assert_eq!(ids(&app.all_pages(&format!("sessions?device={DEVICE}&project=widgets"), 1).await, "id"), newest_first[1..]);
}

#[tokio::test]
async fn session_summary_detail_and_children() {
    let app = world().await;
    let detail = app.json(&format!("sessions/{SESSION_ID}")).await;
    let mut summary = detail.clone();
    let children = summary.as_object_mut().unwrap().remove("children").unwrap();
    let cost = summary.as_object_mut().unwrap().remove("cost").unwrap().as_f64().unwrap();
    assert!((cost - 0.0458).abs() < 1e-9, "{cost}");
    let link: Value = serde_json::from_str(&fixture("session.jsonl")[1]).unwrap();
    assert_eq!(
        summary,
        json!({
            "id": SESSION_ID, "device": DEVICE, "deviceName": DEVICE_NAME, "project": "widgets", "cwd": "/home/me/code/widgets",
            "title": "Fix flaky widget test", "startedAt": "2026-10-20T09:00:00.000Z", "lastAt": "2026-10-20T09:02:11.000Z",
            "durationMs": 131_000, "entryCount": 16, "models": ["claude-sonnet-4-5", "gpt-5"],
            "tokens": { "input": 8300, "output": 730, "cacheRead": 9900, "cacheWrite": 100 },
            "parentSessionId": "parent-0001", "link": link["data"], "childCount": 2, "hidden": false,
        })
    );
    // The list item is the same summary.
    let listed = app.json(&format!("sessions?model=gpt-5&device={DEVICE}")).await;
    let mut detail_summary = detail.clone();
    detail_summary.as_object_mut().unwrap().remove("children");
    assert_eq!(listed["items"][0], detail_summary);

    let children = children.as_array().unwrap();
    assert_eq!(ids(children, "id"), [LINKED_CHILD, HEADER_CHILD]);
    assert_eq!(children[0]["parentToolCallId"], "call_1");
    assert_eq!(children[0]["link"]["agentType"], "recon");
    assert_eq!(children[0]["title"], "Inspect the spin test");
    assert_eq!(children[0]["parentSessionId"], SESSION_ID);
    assert_eq!(children[0]["deviceName"], DEVICE_NAME);
    assert!(children[1].get("parentToolCallId").is_none() && children[1].get("link").is_none());
    assert_eq!((&children[1]["parentSessionId"], &children[1]["title"], &children[1]["entryCount"]), (&json!(SESSION_ID), &json!(""), &json!(1)));

    let step = app.json(&format!("sessions/{STEP_SESSION}")).await;
    assert_eq!((&step["herderRunId"], &step["project"], &step["parentSessionId"]), (&json!(RUN_ID), &json!("widgets"), &json!("orch-1")));
    assert_eq!(step["link"]["herder"]["stepKey"], "impl-T1");
    assert_eq!(step["children"], json!([]));
    let desk = app.json(&format!("sessions/{DESK_SESSION}")).await;
    for absent in ["parentSessionId", "link", "herderRunId"] {
        assert!(desk.get(absent).is_none(), "{absent}");
    }
    assert_eq!((&desk["device"], &desk["project"], &desk["childCount"]), (&json!(DESKTOP), &json!("gadgets"), &json!(0)));
    assert_eq!(desk["deviceName"], DESKTOP_NAME);

    assert_eq!(app.status("sessions/nope").await, StatusCode::NOT_FOUND);
    assert_eq!(app.status("sessions/nope/turns").await, StatusCode::NOT_FOUND);
    assert_eq!(app.status("sessions/nope/entries").await, StatusCode::NOT_FOUND);
    assert_eq!(app.status("sessions/nope/updates").await, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn device_names_follow_renames_and_fall_back_to_the_id() {
    let app = world().await;
    app.env.store.write(|tx| tx.execute("UPDATE devices SET name = 'alpha' WHERE id = ?1", [DESKTOP])).unwrap();
    // Uploads from a device without a row, such as one written by an older server in between.
    let batch = json!({ "streams": [stream("session:ghost-1", "session", 0, &fixture("session.jsonl")[..1])] });
    pika::ingest::apply(&app.env.store, "ghost", &serde_json::from_value(batch).unwrap()).unwrap();

    let facets = app.json("facets").await;
    assert_eq!(
        facets["devices"],
        json!([{ "id": DESKTOP, "name": "alpha" }, { "id": "ghost", "name": "ghost" }, { "id": DEVICE, "name": DEVICE_NAME }])
    );
    assert_eq!(summary_of(&app, DESK_SESSION).await["deviceName"], "alpha");
    assert_eq!(updates(&app, DESK_SESSION, "").await["session"]["deviceName"], "alpha");
    assert_eq!(app.json(&format!("herder/runs/{RUN2}")).await["run"]["deviceName"], "alpha");
    let ghost = app.json("sessions?device=ghost").await;
    assert_eq!((&ghost["items"][0]["device"], &ghost["items"][0]["deviceName"]), (&json!("ghost"), &json!("ghost")));
    // Filters take the id, not the name.
    assert_eq!(session_ids(&app, &format!("?device={DESKTOP}")).await, [DESK_SESSION]);
    assert_eq!(session_ids(&app, "?device=alpha").await, Vec::<String>::new());
    let hits = search(&app, &format!("gadgets&device={DESKTOP}")).await;
    assert!(!hits.is_empty() && hits.iter().all(|h| h["sessionId"] == DESK_SESSION), "{hits:?}");
    assert!(search(&app, "gadgets&device=alpha").await.is_empty());
}

#[tokio::test]
async fn turns_and_updates() {
    let app = world().await;
    let turns = app.json(&format!("sessions/{SESSION_ID}/turns")).await;
    assert_eq!(turns["nextCursor"], Value::Null);
    let items = turns["items"].as_array().unwrap();
    assert_eq!(items.len(), 2);
    let mut first = items[0].clone();
    let cost = first.as_object_mut().unwrap().remove("cost").unwrap().as_f64().unwrap();
    assert!((cost - 0.0428).abs() < 1e-9);
    assert_eq!(
        first,
        json!({ "index": 0, "startSeq": 5, "endSeq": 12,
                "userText": "Why does `test_widget_spin` fail intermittently?\nIt passes locally — sometimes. 🌀",
                "at": "2026-10-20T09:00:02.000Z", "durationMs": 58_000, "modelCalls": 3, "toolCalls": 2, "toolErrors": 1,
                "tokens": { "input": 7400, "output": 650, "cacheRead": 9900, "cacheWrite": 100 },
                "finalText": "The test depends on wall-clock timing; I pinned the clock." })
    );
    assert_eq!((&items[1]["index"], &items[1]["userText"], &items[1]["finalText"]), (&json!(1), &json!("Now add a regression test"), &json!("Added `test_spin_clock`.")));
    assert_eq!(app.all_pages(&format!("sessions/{SESSION_ID}/turns"), 1).await, *items);
    let child_turns = app.json(&format!("sessions/{HEADER_CHILD}/turns")).await;
    assert_eq!(child_turns, json!({ "items": [], "nextCursor": null }));
}

#[tokio::test]
async fn turns_started_by_an_extension_message_name_its_type() {
    let app = app(None);
    let id = "relayed";
    let relayed = "[relay] Message m1 from your user in the pika web UI:\n\nhello";
    let values = [
        json!({ "type": "session", "version": 3, "id": id, "timestamp": "2026-10-23T08:00:00.000Z", "cwd": "/w/x" }),
        json!({ "type": "message", "id": "u1", "parentId": null, "timestamp": "2026-10-23T08:00:01.000Z",
                "message": { "role": "user", "content": "A prompt", "timestamp": 1 } }),
        json!({ "type": "message", "id": "a1", "parentId": "u1", "timestamp": "2026-10-23T08:00:02.000Z",
                "message": assistant("Done.", "gpt-5", 2) }),
        json!({ "type": "custom_message", "id": "c1", "parentId": "a1", "timestamp": "2026-10-23T08:01:00.000Z",
                "customType": "relay-message", "content": relayed, "display": true, "details": { "id": "m1" } }),
        json!({ "type": "message", "id": "a2", "parentId": "c1", "timestamp": "2026-10-23T08:01:01.000Z",
                "message": assistant("Hello back.", "gpt-5", 3) }),
    ];
    app.upload(DEVICE, &skey(id), "session", &lines(&values)).await;
    let turns = app.json(&format!("sessions/{id}/turns")).await["items"].clone();
    let turns = turns.as_array().unwrap();
    assert_eq!(turns.len(), 2);
    assert_eq!((&turns[0]["userText"], turns[0].get("customType")), (&json!("A prompt"), None));
    assert_eq!(
        (&turns[1]["startSeq"], &turns[1]["userText"], &turns[1]["customType"], &turns[1]["finalText"]),
        (&json!(3), &json!(relayed), &json!("relay-message"), &json!("Hello back."))
    );
    // Updates list the same turns.
    assert_eq!(updates(&app, id, "").await["turns"], json!(turns));
}

/// A `superagent-report` turn's trace lists every report's header, read from the whole text, also in public.
#[tokio::test]
async fn trace_turns_list_superagent_reports() {
    let app = app(None);
    let id = "router";
    let filler = "Long summary. ".repeat(30);
    let batch = format!(
        "#3 ready · Fix the parser\n{filler}\n\n#4 question · Which API?\n{filler}\n\n#5 merged · Bump deps sk-ant-api03-{}\nMerged.",
        "A".repeat(40)
    );
    let values = [
        json!({ "type": "session", "version": 3, "id": id, "timestamp": "2026-10-23T08:00:00.000Z", "cwd": "/w/reports" }),
        json!({ "type": "custom_message", "id": "c1", "parentId": null, "timestamp": "2026-10-23T08:01:00.000Z",
                "customType": "superagent-report", "content": batch, "display": true,
                "details": { "batch": [{ "ticketId": 3, "kind": "ready" }] } }),
        json!({ "type": "message", "id": "a1", "parentId": "c1", "timestamp": "2026-10-23T08:01:01.000Z",
                "message": assistant("Noted.", "gpt-5", 2) }),
        json!({ "type": "custom_message", "id": "c2", "parentId": "a1", "timestamp": "2026-10-23T08:02:00.000Z",
                "customType": "relay-message", "content": "#7 ready · not a report", "display": true }),
        json!({ "type": "message", "id": "a2", "parentId": "c2", "timestamp": "2026-10-23T08:02:01.000Z",
                "message": assistant("Ok.", "gpt-5", 3) }),
    ];
    app.upload(DEVICE, &skey(id), "session", &lines(&values)).await;
    let trace = app.json(&format!("sessions/{id}/trace")).await;
    let turns = trace["turns"].as_array().unwrap();
    assert_eq!(turns.len(), 2);
    assert_eq!(turns[0]["customType"], "superagent-report");
    assert_eq!(turns[0]["userText"].as_str().unwrap().chars().count(), 200);
    let key = format!("sk-ant-api03-{}", "A".repeat(40));
    assert_eq!(
        turns[0]["reports"],
        json!([
            { "ticketId": 3, "kind": "ready", "title": "Fix the parser" },
            { "ticketId": 4, "kind": "question", "title": "Which API?" },
            { "ticketId": 5, "kind": "merged", "title": format!("Bump deps {key}") },
        ])
    );
    assert!(turns[1].get("reports").is_none());
    assert_eq!(publish(&app, "reports", true, None).await.status, StatusCode::OK);
    let public = public_json(&app, &format!("sessions/{id}/trace")).await;
    let reports = public["turns"][0]["reports"].as_array().unwrap();
    assert_eq!(reports.len(), 3);
    assert_eq!(reports[2]["title"], "Bump deps [REDACTED:API_KEY]");
}

/// `GET sessions/:id` without `children`.
async fn summary_of(app: &App, id: &str) -> Value {
    let mut detail = app.json(&format!("sessions/{id}")).await;
    detail.as_object_mut().unwrap().remove("children");
    detail
}

async fn updates(app: &App, id: &str, query: &str) -> Value {
    app.json(&format!("sessions/{id}/updates{query}")).await
}

fn turn_indexes(updates: &Value) -> Vec<i64> {
    updates["turns"].as_array().unwrap().iter().map(|t| t["index"].as_i64().unwrap()).collect()
}

#[tokio::test]
async fn updates_return_the_summary_and_changed_turns() {
    let app = world().await;
    let unchanged = json!({ "lastSeq": 15, "lastAt": "2026-10-20T09:02:11.000Z" });
    assert_eq!(updates(&app, SESSION_ID, "?since=15").await, unchanged);
    assert_eq!(updates(&app, SESSION_ID, "?since=99").await, unchanged);

    // A missing or invalid `since` counts as -1.
    let turns = app.json(&format!("sessions/{SESSION_ID}/turns")).await["items"].clone();
    let everything = json!({ "lastSeq": 15, "lastAt": "2026-10-20T09:02:11.000Z", "session": summary_of(&app, SESSION_ID).await,
                             "turns": turns });
    for since in ["", "?since=", "?since=x", "?since=-1"] {
        assert_eq!(updates(&app, SESSION_ID, since).await, everything, "{since}");
    }
    // Turn 0 covers seqs 5..=12 and turn 1 covers 13..=15.
    assert_eq!(turn_indexes(&updates(&app, SESSION_ID, "?since=11").await), [0, 1]);
    assert_eq!(turn_indexes(&updates(&app, SESSION_ID, "?since=12").await), [1]);
    let tail = updates(&app, SESSION_ID, "?since=14").await;
    assert_eq!(tail["turns"], json!([turns[1]]));
    assert!(tail.get("truncated").is_none());

    // The last turn grows.
    let source = fixture("session.jsonl");
    let grown = lines(&[json!({ "type": "message", "id": "a0000016", "parentId": "a0000015", "timestamp": "2026-10-24T09:05:00.000Z",
                                "message": assistant("One more note.", "gpt-5", 5) })]);
    app.append(DEVICE, &skey(SESSION_ID), "session", byte_len(&source), &grown).await;
    let r = updates(&app, SESSION_ID, "?since=15").await;
    assert_eq!((&r["lastSeq"], &r["lastAt"]), (&json!(16), &json!("2026-10-24T09:05:00.000Z")));
    assert_eq!(r["session"], summary_of(&app, SESSION_ID).await);
    assert_eq!(r["session"]["entryCount"], 17);
    assert_eq!(turn_indexes(&r), [1]);
    assert_eq!((&r["turns"][0]["endSeq"], &r["turns"][0]["modelCalls"], &r["turns"][0]["finalText"]), (&json!(16), &json!(2), &json!("One more note.")));

    // New turns.
    let more = lines(&[
        json!({ "type": "message", "id": "a0000017", "parentId": "a0000016", "timestamp": "2026-10-24T09:06:00.000Z",
                "message": { "role": "user", "content": "Thanks", "timestamp": 6 } }),
        json!({ "type": "message", "id": "a0000018", "parentId": "a0000017", "timestamp": "2026-10-24T09:06:01.000Z",
                "message": assistant("You are welcome.", "gpt-5", 7) }),
        json!({ "type": "message", "id": "a0000019", "parentId": "a0000018", "timestamp": "2026-10-24T09:07:00.000Z",
                "message": { "role": "user", "content": "Bye", "timestamp": 8 } }),
    ]);
    app.append(DEVICE, &skey(SESSION_ID), "session", byte_len(&source) + byte_len(&grown), &more).await;
    let r = updates(&app, SESSION_ID, "?since=16").await;
    assert_eq!((&r["lastSeq"], &r["session"]["entryCount"]), (&json!(19), &json!(20)));
    assert_eq!(r["turns"], app.json(&format!("sessions/{SESSION_ID}/turns?cursor={}", pika::read::encode_cursor(&[json!(1)]))).await["items"]);
    assert_eq!(turn_indexes(&r), [2, 3]);
    assert_eq!((&r["turns"][0]["userText"], &r["turns"][1]["userText"]), (&json!("Thanks"), &json!("Bye")));
    assert_eq!(turn_indexes(&updates(&app, SESSION_ID, "?since=15").await), [1, 2, 3]);

    assert_eq!(app.status("sessions/nope/updates?since=3").await, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn updates_list_at_most_50_turns() {
    let app = world().await;
    let id = "many-turns";
    let mut values = vec![json!({ "type": "session", "version": 3, "id": id, "timestamp": "2026-10-23T08:00:00.000Z", "cwd": "/w/x" })];
    values.extend((0..60).map(|i| {
        json!({ "type": "message", "id": format!("m{i}"), "parentId": null, "timestamp": "2026-10-23T08:00:01.000Z",
                "message": { "role": "user", "content": format!("prompt {i}"), "timestamp": i } })
    }));
    app.upload(DEVICE, &skey(id), "session", &lines(&values)).await;
    // Turn i is seq i + 1 alone.
    for since in [-1, 9] {
        let r = updates(&app, id, &format!("?since={since}")).await;
        assert_eq!(r["truncated"], true, "{since}");
        assert_eq!(turn_indexes(&r), (10..60).collect::<Vec<_>>(), "{since}");
    }
    let r = updates(&app, id, "?since=10").await;
    assert!(r.get("truncated").is_none());
    assert_eq!(turn_indexes(&r), (10..60).collect::<Vec<_>>());
    assert_eq!(turn_indexes(&updates(&app, id, "?since=58").await), [58, 59]);
    assert!(updates(&app, id, "?since=60").await.get("turns").is_none());
}

#[tokio::test]
async fn entries_truncate_rewrite_images_and_link_requests() {
    let app = world().await;
    let source = fixture("session.jsonl");
    let entries = app.json(&format!("sessions/{SESSION_ID}/entries")).await;
    let items = entries["items"].as_array().unwrap();
    assert_eq!(items.len(), 16);
    assert_eq!(entries.as_object().unwrap().len(), 1);
    for (seq, item) in items.iter().enumerate() {
        assert_eq!(item["seq"], seq);
        assert_eq!(item["offset"], byte_len(&source[..seq]));
        assert!(item.get("truncated").is_none());
        if seq != 13 {
            assert_eq!(item["raw"], serde_json::from_str::<Value>(&source[seq]).unwrap(), "{seq}");
        }
    }
    assert_eq!(
        items[6],
        json!({ "seq": 6, "offset": byte_len(&source[..6]), "id": "a0000006", "parentId": "a0000005", "type": "message",
                "timestamp": "2026-10-20T09:00:05.000Z", "raw": serde_json::from_str::<Value>(&source[6]).unwrap(),
                "requestId": "req-1" })
    );
    assert!(items[8].get("requestId").is_none());
    assert_eq!((&items[0]["id"], &items[0]["parentId"], &items[0]["type"]), (&json!(SESSION_ID), &Value::Null, &json!("session")));

    // Image data moves behind a URL under the base path.
    let image = &items[13]["raw"]["message"]["content"][1];
    let src = format!("{BASE}/api/v1/sessions/{SESSION_ID}/entries/13/image/0");
    assert_eq!(image, &json!({ "type": "image", "data": "", "mimeType": "image/png", "src": src }));
    let r = app.get_abs(&src, None).await;
    assert_eq!((r.status, r.body.as_slice()), (StatusCode::OK, b"hello".as_slice()));
    assert_eq!(r.headers[header::CONTENT_TYPE], "image/png");
    assert_eq!(r.headers[header::X_CONTENT_TYPE_OPTIONS], "nosniff");

    let desk = app.json(&format!("sessions/{DESK_SESSION}/entries?from=3&to=4")).await;
    let desk = desk["items"].as_array().unwrap();
    assert_eq!(desk.iter().map(|e| e["seq"].as_i64().unwrap()).collect::<Vec<_>>(), [3, 4]);
    let src = desk[0]["raw"]["message"]["content"][1]["src"].as_str().unwrap();
    assert_eq!(src, format!("{BASE}/api/v1/sessions/{DESK_SESSION}/entries/3/image/0"));
    let r = app.get_abs(src, None).await;
    assert_eq!(r.body, IMAGE_BYTES);
    assert!(desk[0].get("truncated").is_none());
    // Strings over 65,536 characters are cut by characters, not bytes.
    assert_eq!(desk[1]["truncated"], true);
    let text = desk[1]["raw"]["message"]["content"][0]["text"].as_str().unwrap();
    assert_eq!(text.chars().count(), 65_536);
    assert!(text.starts_with("Gadget log: éé"));
    // The raw line stays verbatim.
    let r = app.get(&format!("sessions/{DESK_SESSION}/entries/4/raw")).await;
    assert_eq!((r.status, r.text()), (StatusCode::OK, desk_session()[4].clone()));
    assert!(r.headers[header::CONTENT_TYPE].to_str().unwrap().starts_with("application/json"));
    let r = app.get(&format!("sessions/{SESSION_ID}/entries/0/raw")).await;
    assert_eq!(r.text(), source[0]);

    let seqs = |v: &Value| v["items"].as_array().unwrap().iter().map(|e| e["seq"].as_i64().unwrap()).collect::<Vec<_>>();
    assert_eq!(seqs(&app.json(&format!("sessions/{SESSION_ID}/entries?from=5&to=7")).await), [5, 6, 7]);
    assert_eq!(seqs(&app.json(&format!("sessions/{SESSION_ID}/entries?from=14&limit=5")).await), [14, 15]);
    assert_eq!(seqs(&app.json(&format!("sessions/{SESSION_ID}/entries?from=2&limit=3")).await), [2, 3, 4]);
    assert_eq!(seqs(&app.json(&format!("sessions/{SESSION_ID}/entries?from=99")).await), Vec::<i64>::new());
    assert_eq!(seqs(&app.json(&format!("sessions/{SESSION_ID}/entries?limit=5000")).await).len(), 16);

    for (path, status) in [
        (format!("sessions/{SESSION_ID}/entries?from=x"), StatusCode::BAD_REQUEST),
        (format!("sessions/{SESSION_ID}/entries/x/raw"), StatusCode::BAD_REQUEST),
        (format!("sessions/{SESSION_ID}/entries/99/raw"), StatusCode::NOT_FOUND),
        (format!("sessions/{SESSION_ID}/entries/13/image/1"), StatusCode::NOT_FOUND),
        (format!("sessions/{SESSION_ID}/entries/6/image/0"), StatusCode::NOT_FOUND),
        (format!("sessions/{SESSION_ID}/entries/13/image/x"), StatusCode::BAD_REQUEST),
        ("sessions/nope/entries/0/raw".to_owned(), StatusCode::NOT_FOUND),
    ] {
        assert_eq!(app.status(&path).await, status, "{path}");
    }
}

#[tokio::test]
async fn requests_reconstruct_and_complete_when_blobs_arrive() {
    let app = world().await;
    let r = app.json("requests/req-1").await;
    assert_eq!(
        r,
        json!({ "id": "req-1", "sessionId": SESSION_ID, "fidelity": "payload",
                "api": "anthropic-messages", "model": "claude-sonnet-4-5", "at": "2026-10-20T09:00:02.400Z",
                "complete": true, "payload": payload() })
    );

    // A later capture of the same call lacks one block until it is sent.
    let mut later = payload();
    later["messages"].as_array_mut().unwrap().push(json!({ "role": "user", "content": "And now?" }));
    let (batch, blocks) = request_batch("req-2", 1792486808000, &later, Some(4));
    let missing = &blocks[4].0;
    let response = app.ingest(DEVICE, batch).await;
    assert_eq!(response["missingBlobs"], json!([missing]));
    let r = app.json("requests/req-2").await;
    assert_eq!(r["complete"], false);
    assert_eq!(r["payload"]["messages"][2], json!({ "$pika": missing }));
    let entries = app.json(&format!("sessions/{SESSION_ID}/entries?from=8&to=8")).await;
    assert_eq!(entries["items"][0]["requestId"], "req-2");

    app.ingest(DEVICE, json!({ "blobs": [{ "hash": missing, "data": blocks[4].1 }] })).await;
    let r = app.json("requests/req-2").await;
    assert_eq!((&r["complete"], &r["payload"]), (&json!(true), &later));
    assert_eq!(app.status("requests/nope").await, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn herder_runs_and_run_detail() {
    let app = world().await;
    let runs = app.json("herder/runs").await;
    assert_eq!(runs["nextCursor"], Value::Null);
    assert_eq!(
        runs["items"],
        json!([
            { "runId": RUN2, "device": DESKTOP, "deviceName": DESKTOP_NAME, "repo": "gadgets", "title": "Speed up gadgets", "status": "running",
              "startedAt": "2026-10-22T09:00:00.000Z", "lastAt": "2026-10-22T09:01:00.000Z", "stepCount": 1 },
            { "runId": RUN_ID, "device": DEVICE, "deviceName": DEVICE_NAME, "repo": "widgets", "title": "Add pagination", "status": "delivered",
              "verdict": "met", "startedAt": "2026-10-21T10:00:00.000Z", "lastAt": "2026-10-21T10:14:00.000Z", "stepCount": 2,
              "sessionId": "orch-1" },
        ])
    );
    assert_eq!(app.all_pages("herder/runs", 1).await, *runs["items"].as_array().unwrap());

    let detail = app.json(&format!("herder/runs/{RUN_ID}")).await;
    assert_eq!(detail["run"], runs["items"][1]);
    assert_eq!((&detail["goal"], &detail["plan"]), (&json!(GOAL), &json!(PLAN)));
    let journal = fixture("herder-journal.jsonl");
    let events = detail["events"].as_array().unwrap();
    assert_eq!(events.len(), journal.len());
    for (seq, (event, line)) in events.iter().zip(&journal).enumerate() {
        let data: Value = serde_json::from_str(line).unwrap();
        assert_eq!(event, &json!({ "seq": seq, "t": data["t"], "at": data["at"], "data": data }));
    }
    // The review step's session comes from its link entry; the journal names none.
    assert_eq!(
        detail["steps"],
        json!([
            { "key": "impl-T1", "id": "impl-T1", "task": "T1", "role": "worker", "label": "Implement T1", "phase": "build",
              "status": "ok", "attempts": 2, "sessionId": STEP_SESSION, "commit": "c0ffee",
              "startedAt": "2026-10-21T10:03:01.000Z", "endedAt": "2026-10-21T10:09:00.000Z" },
            { "key": "review-T1", "id": "review-T1", "task": "T1", "role": "reviewer", "status": "stopped", "attempts": 1,
              "sessionId": REVIEW_SESSION, "startedAt": "2026-10-21T10:09:10.000Z", "endedAt": "2026-10-21T10:10:00.000Z" },
        ])
    );

    let running = app.json(&format!("herder/runs/{RUN2}")).await;
    assert!(running.get("goal").is_none() && running.get("plan").is_none());
    assert_eq!(running["steps"][0]["status"], "running");
    assert!(running["steps"][0].get("sessionId").is_none() && running["steps"][0].get("endedAt").is_none());
    assert_eq!(app.status("herder/runs/nope").await, StatusCode::NOT_FOUND);
    assert_eq!(app.status("herder/runs?cursor=WzFd").await, StatusCode::BAD_REQUEST);
}

/// A resumed launch restarts attempt numbering: a step's linked session is the newest launch's, not the highest
/// attempt's.
#[tokio::test]
async fn step_sessions_from_links_prefer_the_newest_launch() {
    let app = app(None);
    let journal = lines(&[
        json!({ "v": 1, "t": "run.started", "at": "2026-10-21T10:00:00.000Z", "runId": RUN_ID, "title": "Resume", "repo": "/home/me/code/widgets" }),
        json!({ "v": 1, "t": "step.started", "at": "2026-10-21T10:01:00.000Z", "key": "impl-T5", "id": "impl-T5", "attempt": 1, "role": "worker", "launch": 1 }),
        json!({ "v": 1, "t": "step.failed", "at": "2026-10-21T10:02:00.000Z", "key": "impl-T5", "attempt": 1, "errorClass": "transient", "final": false }),
        json!({ "v": 1, "t": "step.started", "at": "2026-10-21T10:03:00.000Z", "key": "impl-T5", "id": "impl-T5", "attempt": 2, "role": "worker", "launch": 1 }),
        json!({ "v": 1, "t": "step.failed", "at": "2026-10-21T10:04:00.000Z", "key": "impl-T5", "attempt": 2, "errorClass": "interrupted", "final": true }),
        json!({ "v": 1, "t": "script.launched", "at": "2026-10-21T11:00:00.000Z", "launch": 2 }),
        json!({ "v": 1, "t": "step.started", "at": "2026-10-21T11:01:00.000Z", "key": "impl-T5", "id": "impl-T5", "attempt": 1, "role": "worker", "launch": 2 }),
    ]);
    app.upload(DEVICE, &format!("herder:{RUN_ID}"), "herder-journal", &journal).await;
    for (id, at, launch_attempt) in [
        ("t5-l1a1", "2026-10-21T10:01:01.000Z", (1, 1)),
        ("t5-l2a1", "2026-10-21T11:01:01.000Z", (2, 1)),
        ("t5-l1a2", "2026-10-21T10:03:01.000Z", (1, 2)),
    ] {
        app.upload(DEVICE, &skey(id), "session", &step_session(id, at, "impl-T5", "worker", launch_attempt, "Implement T5")).await;
    }
    let detail = app.json(&format!("herder/runs/{RUN_ID}")).await;
    assert_eq!((&detail["steps"][0]["key"], &detail["steps"][0]["sessionId"]), (&json!("impl-T5"), &json!("t5-l2a1")));
}

async fn search(app: &App, query: &str) -> Vec<Value> {
    app.json(&format!("search?q={query}")).await["items"].as_array().unwrap().clone()
}

fn hit_keys(hits: &[Value]) -> Vec<(String, i64, String)> {
    hits.iter()
        .map(|h| (h["sessionId"].as_str().unwrap().to_owned(), h["seq"].as_i64().unwrap(), h["kind"].as_str().unwrap().to_owned()))
        .collect()
}

#[tokio::test]
async fn search_snippets_kinds_filters_and_odd_input() {
    let app = world().await;

    let hits = search(&app, "flaky").await;
    assert_eq!(
        hits,
        [json!({ "sessionId": SESSION_ID, "sessionTitle": "Fix flaky widget test", "seq": 4, "entryId": "a0000004",
                 "kind": "title", "snippet": "Fix <mark>flaky</mark> widget test", "at": "2026-10-20T09:00:01.500Z" })]
    );
    let key = |id: &str, seq: i64, kind: &str| (id.to_owned(), seq, kind.to_owned());
    assert_eq!(hit_keys(&search(&app, "pytest").await), [key(SESSION_ID, 6, "tool-call")]);
    assert_eq!(hit_keys(&search(&app, "ENOENT").await), [key(SESSION_ID, 9, "tool-result")]);
    assert_eq!(hit_keys(&search(&app, &q("\"pinned the clock\"")).await), [key(SESSION_ID, 10, "assistant")]);
    assert_eq!(hit_keys(&search(&app, &q("clock pinned")).await), [key(SESSION_ID, 10, "assistant")]);
    assert_eq!(hit_keys(&search(&app, &q("\"clock pinned\"")).await), []);
    // Tool call arguments are searchable by value, including after escaped newlines.
    assert_eq!(hit_keys(&search(&app, "verbose").await), [key(DESK_SESSION, 2, "tool-call")]);
    assert_eq!(hit_keys(&search(&app, "test_widget_spin").await), [key(SESSION_ID, 5, "user")]);

    // Newest first across sessions and kinds.
    let spin = search(&app, "spin").await;
    assert_eq!(
        hit_keys(&spin),
        [
            key(SESSION_ID, 14, "assistant"),
            key(LINKED_CHILD, 3, "assistant"),
            key(LINKED_CHILD, 2, "user"),
            key(SESSION_ID, 6, "tool-call"),
            key(SESSION_ID, 5, "user"),
        ]
    );
    assert_eq!(app.all_pages("search?q=spin", 1).await, spin);
    let relevance = app.json("search?q=spin&sort=relevance").await["items"].as_array().unwrap().clone();
    assert_eq!(relevance.len(), 5);
    // Relevance results are one page.
    let top = app.json("search?q=spin&sort=relevance&limit=2").await;
    assert_eq!((&top["items"], &top["nextCursor"]), (&json!(relevance[..2]), &Value::Null));
    let cursor = app.json("search?q=spin&limit=1").await["nextCursor"].as_str().unwrap().to_owned();
    assert_eq!(app.status(&format!("search?q=spin&sort=relevance&cursor={cursor}")).await, StatusCode::BAD_REQUEST);

    // Snippets escape HTML and mark matches.
    let hits = search(&app, "script").await;
    assert_eq!(hits.len(), 1);
    assert_eq!(
        hits[0]["snippet"],
        "Render &lt;<mark>script</mark>&gt;alert(&quot;x&quot;)&lt;/<mark>script</mark>&gt; &amp; check the gadgets 🌀"
    );
    assert_eq!(hit_keys(&search(&app, &q("🌀")).await), [key(DESK_SESSION, 1, "user"), key(SESSION_ID, 5, "user")]);
    assert_eq!(hit_keys(&search(&app, "cafe").await), []);

    // Device and project filters.
    assert_eq!(hit_keys(&search(&app, &format!("gadgets&device={DESKTOP}")).await).len(), 3);
    assert_eq!(search(&app, &format!("gadgets&device={DEVICE}")).await, Vec::<Value>::new());
    assert_eq!(hit_keys(&search(&app, "spin&project=widgets").await).len(), 5);
    assert_eq!(search(&app, "spin&project=gadgets").await, Vec::<Value>::new());
    assert_eq!(hit_keys(&search(&app, &format!("spin&project=widgets&device={DEVICE}")).await).len(), 5);

    // Odd input never fails.
    for odd in [
        "\"", "\"\"", "\"unbalanced", "AND", "OR NOT", "a OR", "foo*", "*", "NEAR(", "NEAR(a b, 2)", "text:spin", "^spin",
        "-spin", "+", "(", ")(", "'", "\\", "{a b}", "spin AND", "🌀🌀", "👩‍💻", "%", "a\u{2}b\u{3}", "\u{0}",
    ] {
        let r = app.get(&format!("search?q={}", q(odd))).await;
        assert_eq!(r.status, StatusCode::OK, "{odd:?}: {}", r.text());
        assert!(r.json()["items"].is_array());
    }
    assert_eq!(hit_keys(&search(&app, &q("spin AND")).await), []);
    assert_eq!(hit_keys(&search(&app, &q("\"spin")).await).len(), 5);
    assert_eq!(app.json("search").await, json!({ "items": [], "nextCursor": null }));
    assert_eq!(app.json("search?q=%20").await, json!({ "items": [], "nextCursor": null }));
    assert_eq!(app.status("search?q=spin&sort=oldest").await, StatusCode::BAD_REQUEST);
    assert_eq!(app.status("search?q=spin&cursor=abc").await, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn search_groups_sessions_and_matches_prefixes() {
    let app = world().await;
    let key = |id: &str, seq: i64, kind: &str| (id.to_owned(), seq, kind.to_owned());
    let entries = search(&app, "spin").await;

    // The linked child's matches count for the main session, which carries its newest hits in the entry shape.
    let grouped = app.json("search?q=spin&group=session").await;
    assert_eq!(grouped["nextCursor"], Value::Null);
    let items = grouped["items"].as_array().unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(
        (&items[0]["sessionId"], &items[0]["sessionTitle"], &items[0]["matches"]),
        (&json!(SESSION_ID), &json!("Fix flaky widget test"), &json!(5))
    );
    assert_eq!(items[0]["hits"], json!(entries[..3]));
    let relevance = app.json("search?q=spin&group=session&sort=relevance&limit=1").await;
    assert_eq!((&relevance["items"][0]["sessionId"], &relevance["items"][0]["matches"]), (&json!(SESSION_ID), &json!(5)));
    let gadgets = app.json(&format!("search?q=gadgets&group=session&device={DESKTOP}")).await;
    assert_eq!(
        gadgets["items"].as_array().unwrap().iter().map(|g| (&g["sessionId"], &g["matches"])).collect::<Vec<_>>(),
        [(&json!(DESK_SESSION), &json!(3))]
    );
    assert_eq!(app.json(&format!("search?q=gadgets&group=session&device={DEVICE}")).await["items"], json!([]));

    // The word being typed matches as a prefix with `prefix=true`, in both shapes.
    assert_eq!(search(&app, "spi").await, Vec::<Value>::new());
    assert_eq!(search(&app, "spi&prefix=true").await, entries);
    assert_eq!(search(&app, &format!("{}&prefix=true", q("spi "))).await, Vec::<Value>::new());
    assert_eq!(hit_keys(&search(&app, "pinned%20the%20clo&prefix=true").await), [key(SESSION_ID, 10, "assistant")]);
    assert_eq!(hit_keys(&search(&app, &format!("{}&prefix=true", q("\"pinned the clo"))).await), [key(SESSION_ID, 10, "assistant")]);
    assert_eq!(app.json("search?q=spi&prefix=true&group=session").await, grouped);

    for bad in ["q=spin&group=turn", "q=spin&group=session&cursor=abc", "q=spin&prefix=maybe", "q=spin&group=session&sort=oldest"] {
        assert_eq!(app.status(&format!("search?{bad}")).await, StatusCode::BAD_REQUEST, "{bad}");
    }
    assert_eq!(app.json("search?q=%20&group=session").await, json!({ "items": [], "nextCursor": null }));
}

#[tokio::test]
async fn pages_stay_stable_while_data_arrives() {
    let app = world().await;
    let before = ids(&app.all_pages("sessions", 2).await, "id");
    let first = app.json("sessions?limit=2").await;
    let spin_before = app.all_pages("search?q=spin", 1).await;
    let spin_first = app.json("search?q=spin&limit=1").await;
    let turns_first = app.json(&format!("sessions/{SESSION_ID}/turns?limit=1")).await;

    // A new session, newer than everything, and a new turn at the end of the main session.
    let newest = "e0000000-0000-0000-0000-00000000000e";
    let new_session = lines(&[
        json!({ "type": "session", "version": 3, "id": newest, "timestamp": "2026-10-23T08:00:00.000Z", "cwd": "/srv/gadgets" }),
        json!({ "type": "message", "id": "e1", "parentId": null, "timestamp": "2026-10-23T08:00:01.000Z",
                "message": { "role": "user", "content": "Spin it again", "timestamp": 1 } }),
    ]);
    app.upload(DESKTOP, &skey(newest), "session", &new_session).await;
    // The main session, not yet listed, gets a new entry newer than everything and moves to the top.
    let next_turn = lines(&[json!({ "type": "message", "id": "a0000016", "parentId": "a0000015", "timestamp": "2026-10-23T09:00:00.000Z",
                                   "message": { "role": "user", "content": "One more thing", "timestamp": 1 } })]);
    app.append(DEVICE, &skey(SESSION_ID), "session", byte_len(&fixture("session.jsonl")), &next_turn).await;

    let mut rest = Vec::new();
    let mut cursor = first["nextCursor"].as_str().map(str::to_owned);
    while let Some(c) = cursor {
        let page = app.json(&format!("sessions?limit=2&cursor={c}")).await;
        rest.extend(ids(page["items"].as_array().unwrap(), "id"));
        cursor = page["nextCursor"].as_str().map(str::to_owned);
    }
    // Later pages repeat nothing; the moved session is on a fresh first page instead.
    let mut seen = ids(first["items"].as_array().unwrap(), "id");
    seen.extend(rest);
    let unmoved: Vec<String> = before.iter().filter(|id| *id != SESSION_ID).cloned().collect();
    assert_eq!(seen, unmoved);
    assert_eq!(session_ids(&app, "?limit=2").await, [SESSION_ID, newest]);

    let next = app.json(&format!("search?q=spin&limit=10&cursor={}", spin_first["nextCursor"].as_str().unwrap())).await;
    let mut spin_seen = spin_first["items"].as_array().unwrap().clone();
    spin_seen.extend(next["items"].as_array().unwrap().iter().cloned());
    assert_eq!(spin_seen, spin_before);
    assert_eq!(search(&app, "spin").await[0]["sessionId"], newest);

    let turns_rest = app.all_pages(&format!("sessions/{SESSION_ID}/turns?cursor={}", turns_first["nextCursor"].as_str().unwrap()), 1).await;
    assert_eq!(turns_rest.iter().map(|t| t["index"].as_i64().unwrap()).collect::<Vec<_>>(), [1, 2]);
    assert_eq!(turns_rest[1]["userText"], "One more thing");
}

/// Every read route the fixtures exercise, with the pages that follow each list's first page.
async fn snapshot(app: &App) -> BTreeMap<String, (u16, Vec<u8>)> {
    let mut paths: Vec<String> = [
        "facets", "sessions", "sessions?root=true", "sessions?model=gpt-5", "sessions?project=widgets&device=laptop",
        "sessions?from=2026-10-21", "herder/runs", "search?q=spin", "search?q=gadgets&device=desktop",
        "search?q=spin&sort=relevance", "search?q=test", "requests/req-1",
        "herder/runs/20261021-100000-abcd", "herder/runs/20261022-090000-ef01",
    ]
    .iter()
    .map(|p| p.to_string())
    .collect();
    for id in [SESSION_ID, DESK_SESSION, HEADER_CHILD, LINKED_CHILD, STEP_SESSION, REVIEW_SESSION] {
        for sub in ["", "/turns", "/turns?limit=1", "/entries", "/entries?from=3&limit=2", "/updates", "/entries/0/raw", "/export", "/trace"] {
            paths.push(format!("sessions/{id}{sub}"));
        }
    }
    paths.push(format!("sessions/{SESSION_ID}/entries/13/image/0"));
    paths.push(format!("sessions/{DESK_SESSION}/entries/3/image/0"));
    for list in ["sessions?limit=2", "herder/runs?limit=1", "search?q=spin&limit=1", "search?q=spin&sort=relevance&limit=2"] {
        let mut url = list.to_owned();
        loop {
            paths.push(url.clone());
            let page = app.json(&url).await;
            let Some(next) = page["nextCursor"].as_str() else { break };
            url = format!("{list}&cursor={next}");
        }
    }
    let mut out = BTreeMap::new();
    for path in paths {
        let r = app.get(&path).await;
        assert!(r.status == StatusCode::OK, "{path}: {}", r.text());
        out.insert(path, (r.status.as_u16(), r.body));
    }
    out
}

#[tokio::test]
async fn reindex_keeps_every_response_identical() {
    let app = world().await;
    let before = snapshot(&app).await;
    assert!(before.len() > 60);
    pika::reindex::reindex(&app.env.store).unwrap();
    let after = snapshot(&app).await;
    assert_eq!(before.keys().collect::<Vec<_>>(), after.keys().collect::<Vec<_>>());
    for (path, response) in &before {
        assert!(after[path] == *response, "{path} changed:\n{}\n{}", String::from_utf8_lossy(&response.1), String::from_utf8_lossy(&after[path].1));
    }
}

#[tokio::test]
async fn read_routes_require_the_login_cookie() {
    let app = app(Some("hunter2"));
    load(&app).await;
    let routes = [
        "facets".to_owned(),
        "sessions".into(),
        format!("sessions/{SESSION_ID}"),
        format!("sessions/{SESSION_ID}/turns"),
        format!("sessions/{SESSION_ID}/entries"),
        format!("sessions/{SESSION_ID}/entries/1/raw"),
        format!("sessions/{SESSION_ID}/entries/13/image/0"),
        format!("sessions/{SESSION_ID}/updates"),
        format!("sessions/{SESSION_ID}/trace"),
        format!("sessions/{SESSION_ID}/export"),
        "requests/req-1".into(),
        "herder/runs".into(),
        format!("herder/runs/{RUN_ID}"),
        "search?q=spin".into(),
    ];
    for route in &routes {
        let r = app.get(route).await;
        assert_eq!((r.status, r.json()), (StatusCode::UNAUTHORIZED, json!({ "error": "unauthorized" })), "{route}");
    }
    let login = Request::post(format!("{BASE}/api/v1/login"))
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(json!({ "password": "hunter2" }).to_string()))
        .unwrap();
    let r = app.send(login).await;
    let cookie = r.headers[header::SET_COOKIE].to_str().unwrap().split(';').next().unwrap().to_owned();
    for route in &routes {
        let r = app.get_abs(&format!("{BASE}/api/v1/{route}"), Some(&cookie)).await;
        assert_eq!(r.status, StatusCode::OK, "{route}: {}", r.text());
    }
}

#[test]
fn opening_a_version_1_database_builds_the_search_index() {
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");
    {
        let store = pika::store::Store::open(&data).unwrap();
        upload(&store, &skey(SESSION_ID), "session", &fixture("session.jsonl"), 100);
    }
    let conn = rusqlite::Connection::open(data.join("pika.db")).unwrap();
    // Dropping the full-text index needs its tokenizer.
    pika::tokenizer::register(&conn).unwrap();
    conn.execute_batch(&format!(
        "DROP TABLE search_fts; DROP TABLE search_docs; DROP INDEX sessions_device_project; DROP INDEX sessions_root_device;
         DROP INDEX sessions_root_project; DROP INDEX sessions_root_device_project; {UNDO_V8} {UNDO_V6} {UNDO_V5} {UNDO_V4} PRAGMA user_version = 1;"
    ))
    .unwrap();
    drop(conn);
    let store = pika::store::Store::open(&data).unwrap();
    let mut params = pika::read::Params::default();
    params.0.insert("q".into(), "flaky".into());
    let hits = store.read(|conn| pika::read::search::search(conn, &params)).unwrap();
    assert_eq!(hits.items.len(), 1);
    assert_eq!(hits.items[0].seq, 4);
}

const CJK_SESSION: &str = "c0000000-0000-0000-0000-00000000000c";

/// A session in Chinese, with some English: a prompt and an answer.
fn cjk_session() -> Vec<String> {
    lines(&[
        json!({ "type": "session", "version": 3, "id": CJK_SESSION, "timestamp": "2026-10-23T10:00:00.000Z", "cwd": "/home/me/code/widgets" }),
        json!({ "type": "message", "id": "z0000001", "parentId": null, "timestamp": "2026-10-23T10:00:01.000Z",
                "message": { "role": "user", "content": "请检查缓存测试为什么失败，跑一下 pytest", "timestamp": 1 } }),
        json!({ "type": "message", "id": "z0000002", "parentId": "z0000001", "timestamp": "2026-10-23T10:00:05.000Z",
                "message": assistant("数据库连接超时，缓存未命中。Fixed in widgets.py", "gpt-5", 2) }),
    ])
}

/// Words inside Chinese text match wherever their characters appear together, alone or with English words, and are
/// marked in snippets; a single character matches only where it stands alone.
#[tokio::test]
async fn search_finds_words_in_cjk_text() {
    let app = world().await;
    app.upload(DEVICE, &skey(CJK_SESSION), "session", &cjk_session()).await;
    let key = |seq: i64, kind: &str| (CJK_SESSION.to_owned(), seq, kind.to_owned());
    assert_eq!(hit_keys(&search(&app, &q("缓存")).await), [key(2, "assistant"), key(1, "user")]);
    let hits = search(&app, &q("数据库连接")).await;
    assert_eq!(hits[0]["snippet"], "<mark>数据库连接</mark>超时，缓存未命中。Fixed in widgets.py");
    assert_eq!(search(&app, &q("缓存测试")).await[0]["snippet"], "请检查<mark>缓存测试</mark>为什么失败，跑一下 pytest");
    assert_eq!(hit_keys(&search(&app, &q("检查 pytest")).await), [key(1, "user")]);
    assert_eq!(hit_keys(&search(&app, &q("命中 widgets")).await), [key(2, "assistant")]);
    assert_eq!(hit_keys(&search(&app, &q("连接失败")).await), []);
    assert_eq!(hit_keys(&search(&app, &q("缓")).await), []);
    assert_eq!(hit_keys(&search(&app, &format!("{}&prefix=true", q("缓存测"))).await), [key(1, "user")]);
    let grouped = app.json(&format!("search?q={}&group=session", q("缓存"))).await;
    assert_eq!((&grouped["items"][0]["sessionId"], &grouped["items"][0]["matches"]), (&json!(CJK_SESSION), &json!(2)));
}

/// Opening a version 6 database rebuilds the full-text index with the prefix index and the CJK tokenizer: it finds
/// what the old index found, and words inside CJK text, which the old index could not.
#[test]
fn opening_a_version_6_database_rebuilds_the_search_index() {
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");
    let search = |store: &pika::store::Store, pairs: &[(&str, &str)]| -> Vec<(String, i64)> {
        let mut params = pika::read::Params::default();
        for (k, v) in pairs {
            params.0.insert((*k).into(), (*v).into());
        }
        let hits = store.read(|conn| pika::read::search::search(conn, &params)).unwrap();
        hits.items.into_iter().map(|h| (h.session_id, h.seq)).collect()
    };
    let before = {
        let store = pika::store::Store::open(&data).unwrap();
        upload(&store, &skey(SESSION_ID), "session", &fixture("session.jsonl"), 100);
        upload(&store, &skey(CJK_SESSION), "session", &cjk_session(), 100);
        ["flaky", "spin", "pytest"].map(|q| search(&store, &[("q", q)]))
    };
    let conn = rusqlite::Connection::open(data.join("pika.db")).unwrap();
    pika::tokenizer::register(&conn).unwrap();
    conn.execute_batch(&format!("{UNDO_V8} {UNDO_V7} PRAGMA user_version = 6;")).unwrap();
    let count = |q: &str| conn.query_row("SELECT count(*) FROM search_fts WHERE search_fts MATCH ?1", [q], |r| r.get::<_, i64>(0)).unwrap();
    assert_eq!((count("\"缓存\""), count("\"spin\"")), (0, before[1].len() as i64));
    drop(conn);

    let store = pika::store::Store::open(&data).unwrap();
    let sql: String =
        store.read(|conn| conn.query_row("SELECT sql FROM sqlite_master WHERE name = 'search_fts'", [], |r| r.get(0))).unwrap();
    assert!(sql.contains("prefix = '3'") && sql.contains("pika_cjk"), "{sql}");
    assert_eq!(["flaky", "spin", "pytest"].map(|q| search(&store, &[("q", q)])), before);
    assert_eq!(search(&store, &[("q", "缓存")]), [(CJK_SESSION.to_owned(), 2), (CJK_SESSION.to_owned(), 1)]);
    assert_eq!(search(&store, &[("q", "spi"), ("prefix", "true")]), before[1]);
    assert_eq!(store.setting("needs_reindex").unwrap(), None);
}

/// More than `RELEVANCE_WINDOW` newer matches on another device do not hide a device's own matches.
#[tokio::test]
async fn relevance_ranks_the_newest_matches_after_filters() {
    let app = world().await;
    let flood = "f1000000-0000-0000-0000-00000000000f";
    let mut values = vec![json!({ "type": "session", "version": 3, "id": flood, "timestamp": "2026-10-24T08:00:00.000Z", "cwd": "/srv/widgets" })];
    let window = pika::read::search::RELEVANCE_WINDOW as usize;
    let start = pika::util::parse_iso_ms("2026-10-24T08:00:01.000Z").unwrap();
    values.extend((0..window + 10).map(|i| {
        json!({ "type": "message", "id": format!("f{i}"), "parentId": null, "timestamp": pika::util::format_iso_ms(start + i as i64 * 1000),
                "message": assistant(&format!("gadgets report {i}"), "gpt-5", i as i64) })
    }));
    app.upload(DEVICE, &skey(flood), "session", &lines(&values)).await;

    let newest = search(&app, &format!("gadgets&device={DESKTOP}")).await;
    assert_eq!(newest.len(), 3);
    for filter in [format!("device={DESKTOP}"), "project=gadgets".to_owned()] {
        let r = app.json(&format!("search?q=gadgets&sort=relevance&{filter}")).await;
        assert_eq!(r["nextCursor"], Value::Null);
        let mut got = hit_keys(r["items"].as_array().unwrap());
        got.sort();
        let mut want = hit_keys(&newest);
        want.sort();
        assert_eq!(got, want, "{filter}");
    }
    let r = app.json("search?q=gadgets&sort=relevance&limit=500").await;
    assert_eq!((r["items"].as_array().unwrap().len(), &r["nextCursor"]), (100, &Value::Null));
}

/// A context request whose message holds a lone surrogate escape comes back with the escape intact.
#[tokio::test]
async fn context_requests_keep_lone_surrogate_escapes() {
    let app = world().await;
    let blocks = [
        r#"{"role":"user","content":"find the smile","timestamp":1}"#,
        r#"{"role":"toolResult","toolCallId":"call_g","content":[{"type":"text","text":"a.txt: smile \ud83d... [truncated] C:\\udc00 \udc00x"}],"isError":false}"#,
    ];
    let hashes: Vec<String> = blocks.iter().map(|b| pika::util::sha256_hex(b.as_bytes())).collect();
    let request = |id: &str| {
        json!({ "id": id, "sessionId": SESSION_ID, "seq": 2, "at": "2026-10-20T09:00:03.000Z", "fidelity": "context",
                "skeleton": { "messages": hashes.iter().map(|h| json!({ "$pika": h })).collect::<Vec<_>>(), "n": 1 },
                "blocks": hashes })
    };
    let blobs: Vec<Value> = blocks.iter().zip(&hashes).map(|(b, h)| json!({ "hash": h, "data": b })).collect();
    let r = app.ingest(DEVICE, json!({ "blobs": blobs, "requests": [request("req-lone")] })).await;
    assert_eq!(r["missingBlobs"], json!([]));

    #[derive(serde::Deserialize)]
    struct Stored<'a> {
        fidelity: &'a str,
        complete: bool,
        #[serde(borrow)]
        payload: &'a serde_json::value::RawValue,
    }
    let reply = app.get("requests/req-lone").await;
    assert_eq!(reply.status, StatusCode::OK);
    let stored: Stored = serde_json::from_slice(&reply.body).unwrap();
    assert_eq!((stored.fidelity, stored.complete), ("context", true));
    assert_eq!(stored.payload.get(), format!(r#"{{"messages":[{},{}],"n":1}}"#, blocks[0], blocks[1]));
}

#[test]
fn an_interrupted_upgrade_reindexes_on_the_next_open() {
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");
    let mut source = fixture("session.jsonl");
    let big = json!({ "type": "custom", "id": "big", "parentId": null, "timestamp": "2026-10-20T09:03:00.000Z",
                      "customType": "big", "data": "x".repeat(pika::ingest::LINE_BLOB_THRESHOLD) });
    source.push(big.to_string());
    {
        let store = pika::store::Store::open(&data).unwrap();
        upload(&store, &skey(SESSION_ID), "session", &source, 100);
    }
    let conn = rusqlite::Connection::open(data.join("pika.db")).unwrap();
    conn.execute_batch(&format!("{UNDO_V11} PRAGMA user_version = 10;")).unwrap();
    drop(conn);

    // The large line's blob is unreadable, so the reindex after the upgrade fails.
    let hash: String = rusqlite::Connection::open(data.join("pika.db"))
        .unwrap()
        .query_row("SELECT blob FROM lines WHERE blob IS NOT NULL", [], |r| r.get(0))
        .unwrap();
    let blob = data.join("blobs").join(&hash[..2]).join(&hash[2..4]).join(format!("{hash}.zst"));
    let aside = dir.path().join("aside.zst");
    std::fs::rename(&blob, &aside).unwrap();
    assert!(pika::store::Store::open(&data).is_err());
    let conn = rusqlite::Connection::open(data.join("pika.db")).unwrap();
    assert_eq!(conn.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)).unwrap(), 18);
    assert_eq!(conn.query_row("SELECT COUNT(*) FROM settings WHERE key = 'needs_reindex'", [], |r| r.get::<_, i64>(0)).unwrap(), 1);
    assert_eq!(conn.query_row("SELECT COUNT(*) FROM usage_events", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
    drop(conn);

    std::fs::rename(&aside, &blob).unwrap();
    let store = pika::store::Store::open(&data).unwrap();
    let mut params = pika::read::Params::default();
    params.0.insert("q".into(), "flaky".into());
    let hits = store.read(|conn| pika::read::search::search(conn, &params)).unwrap();
    assert_eq!(hits.items.len(), 1);
    assert_eq!(store.setting("needs_reindex").unwrap(), None);
    assert!(one(&store, "SELECT COUNT(*) AS n FROM usage_events")["n"].as_i64().unwrap() > 0);
}

/// Removes `key` from `v` and returns it as a float, for comparing sums with a tolerance.
fn take_f64(v: &mut Value, key: &str) -> f64 {
    v.as_object_mut().unwrap().remove(key).unwrap().as_f64().unwrap()
}

#[tokio::test]
async fn trace_of_a_session_with_children() {
    let app = world().await;
    let mut trace = app.json(&format!("sessions/{SESSION_ID}/trace")).await;
    let ms = |iso: &str| pika::util::parse_iso_ms(iso).unwrap();
    assert_eq!(
        (&trace["sessionId"], &trace["startedAt"], &trace["lastAt"]),
        (&json!(SESSION_ID), &json!(ms("2026-10-20T09:00:00Z")), &json!(ms("2026-10-20T09:02:11Z")))
    );
    let turns = trace["turns"].as_array_mut().unwrap();
    assert!((take_f64(&mut turns[0], "cost") - 0.0428).abs() < 1e-9);
    assert_eq!(
        turns[0],
        json!({ "index": 0, "startSeq": 5, "endSeq": 12, "at": ms("2026-10-20T09:00:02Z"), "durationMs": 58_000,
                "userText": "Why does `test_widget_spin` fail intermittently?\nIt passes locally — sometimes. 🌀",
                "modelCalls": 3, "toolCalls": 2, "toolErrors": 1,
                "tokens": { "input": 7400, "output": 650, "cacheRead": 9900, "cacheWrite": 100 } })
    );
    assert_eq!((&turns[1]["index"], &turns[1]["startSeq"], &turns[1]["userText"]), (&json!(1), &json!(13), &json!("Now add a regression test")));
    let records = trace["records"].as_array().unwrap();
    let kinds: Vec<(&str, i64)> = records.iter().map(|r| (r["kind"].as_str().unwrap(), r["seq"].as_i64().unwrap())).collect();
    assert_eq!(kinds, [("llm", 6), ("tool", 6), ("llm", 8), ("tool", 8), ("llm", 10), ("compaction", 12), ("llm", 14)]);
    // No `durationMs` in the fixture: the call ends at its entry's time.
    assert_eq!(
        records[0],
        json!({ "kind": "llm", "seq": 6, "turn": 0, "start": 1792486802500_i64, "end": ms("2026-10-20T09:00:05Z"),
                "model": "claude-sonnet-4-5", "stopReason": "toolUse",
                "input": 1200, "output": 150, "cacheRead": 800, "cacheWrite": 100, "cost": 0.0123, "requestId": "req-1",
                "text": "Let me run it.", "thinking": true, "toolCalls": 1 })
    );
    assert_eq!(
        records[1],
        json!({ "kind": "tool", "seq": 6, "resultSeq": 7, "turn": 0, "callId": "call_1", "name": "bash",
                "start": ms("2026-10-20T09:00:05Z"), "end": ms("2026-10-20T09:00:07Z"), "durationMs": 2000, "isError": false,
                "summary": "pytest -k spin", "outputSize": 8, "childSessionId": LINKED_CHILD })
    );
    assert_eq!((&records[3]["isError"], &records[3]["summary"], records[3].get("childSessionId")), (&json!(true), &json!("missing.py"), None));
    for absent in ["text", "thinking", "requestId", "error"] {
        assert!(records[2].get(absent).is_none(), "{absent}");
    }
    assert_eq!(records[5], json!({ "kind": "compaction", "seq": 12, "turn": 0, "at": ms("2026-10-20T09:01:00Z"), "tokensBefore": 9000 }));
    assert_eq!(
        trace["children"],
        json!([
            { "sessionId": LINKED_CHILD, "parentToolCallId": "call_1", "agentType": "recon", "description": "Look around",
              "kind": "subagent", "startedAt": ms("2026-10-20T09:00:06Z"), "lastAt": ms("2026-10-20T09:00:06.900Z"),
              "entryCount": 4, "tokens": { "input": 10, "output": 5, "cacheRead": 0, "cacheWrite": 0 }, "cost": 0.001,
              "title": "Inspect the spin test" },
            { "sessionId": HEADER_CHILD, "kind": "subagent", "startedAt": ms("2026-10-20T10:00:00Z"),
              "lastAt": ms("2026-10-20T10:00:00Z"), "entryCount": 1,
              "tokens": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }, "cost": 0.0, "title": "" },
        ])
    );

    // A Herder step session is a `herder-step` child of its orchestrator.
    let orchestrator = lines(&[json!({ "type": "session", "version": 3, "id": "orch-1", "timestamp": "2026-10-21T10:00:00.000Z", "cwd": "/w" })]);
    app.upload(DEVICE, &skey("orch-1"), "session", &orchestrator).await;
    let orch = app.json("sessions/orch-1/trace").await;
    let kinds: Vec<(&str, &str)> =
        orch["children"].as_array().unwrap().iter().map(|c| (c["sessionId"].as_str().unwrap(), c["kind"].as_str().unwrap())).collect();
    assert_eq!(kinds, [(STEP_SESSION, "herder-step"), (REVIEW_SESSION, "herder-step")]);
    assert_eq!((&orch["turns"], &orch["records"]), (&json!([]), &json!([])));

    assert_eq!(app.status("sessions/nope/trace").await, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn trace_records_summaries_order_and_missing_times() {
    let app = app(None);
    let id = "traced";
    let call = |id: &str, name: &str, args: Value| json!({ "type": "toolCall", "id": id, "name": name, "arguments": args });
    let result = |seq: usize, call_id: &str, at: &str, is_error: bool| {
        json!({ "type": "message", "id": format!("r{seq}"), "parentId": null, "timestamp": at,
                "message": { "role": "toolResult", "toolCallId": call_id, "toolName": "x", "isError": is_error,
                             "content": [{ "type": "text", "text": "out" }], "timestamp": 1 } })
    };
    let big_code = format!("const r = await tools.bash({{}});\n{}", "x".repeat(400));
    let values = [
        json!({ "type": "session", "version": 3, "id": id, "timestamp": "2026-10-23T08:00:00.000Z", "cwd": "/w/x" }),
        json!({ "type": "message", "id": "u1", "parentId": null, "timestamp": "2026-10-23T08:00:01.000Z",
                "message": { "role": "user", "content": "Do the things", "timestamp": 1 } }),
        // Calls in message order, which is not the order of their ids.
        json!({ "type": "message", "id": "a1", "parentId": "u1", "timestamp": "2026-10-23T08:00:05.000Z",
                "message": { "role": "assistant", "api": "anthropic-messages", "provider": "anthropic", "model": "auto/m1@500k",
                             "stopReason": "toolUse", "timestamp": 1792742402000_i64, "durationMs": 2500.4,
                             "usage": { "input": 1, "output": 2, "cacheRead": 3, "cacheWrite": 4, "totalTokens": 10, "cost": { "total": 0.5 } },
                             "content": [
                                 { "type": "text", "text": "\n Working\ton\u{1}it\n" },
                                 call("z1", "bash", json!({ "command": "cargo test --locked\necho done" })),
                                 call("y2", "read", json!({ "path": "src/lib.rs", "offset": 10, "limit": 40 })),
                                 call("x3", "grep", json!({ "pattern": "fn main", "path": "src" })),
                                 call("w4", "find", json!({ "pattern": "*.rs" })),
                                 call("v5", "web_search", json!({ "query": "sqlite index" })),
                                 call("u6", "web_fetch", json!({ "url": "https://sqlite.org/lang.html" })),
                                 call("t7", "edit", json!({ "path": "src/a.rs", "edits": [{ "oldText": "a", "newText": "b" }] })),
                                 call("s8", "write", json!({ "path": "notes/é.md", "content": "hello" })),
                                 call("r9", "Agent", json!({ "subagent_type": "recon", "description": "Map the code", "prompt": "Go" })),
                                 call("q10", "mcp__rea__decompile", json!({ "depth": 2, "target": "libfoo.so", "notes": "long" })),
                                 call("p11", "codemode", json!({ "code": big_code })),
                                 call("o12", "bash", json!({ "command": format!("echo {}", "é".repeat(300)) })),
                             ] } }),
        result(3, "z1", "2026-10-23T08:00:06.000Z", false),
        result(4, "y2", "2026-10-23T08:00:07.000Z", true),
        // A model call without times, and a call that never gets a result.
        json!({ "type": "message", "id": "a2", "parentId": "r4",
                "message": { "role": "assistant", "content": [call("n13", "ls", json!({ "path": "/tmp" }))], "stopReason": "toolUse" } }),
        // A result without its call.
        result(6, "ghost", "2026-10-23T08:00:09.000Z", false),
        json!({ "type": "branch_summary", "id": "b1", "parentId": "r6", "timestamp": "2026-10-23T08:00:10.000Z", "summary": "s", "fromId": "a1" }),
        json!({ "type": "compaction", "id": "c1", "parentId": "b1", "summary": "s", "firstKeptEntryId": "a1" }),
    ];
    app.upload(DEVICE, &skey(id), "session", &lines(&values)).await;
    // Two children of the Agent call: the tool record names the first.
    for (child, at) in [("kid-2", "2026-10-23T08:00:09.000Z"), ("kid-1", "2026-10-23T08:00:08.000Z")] {
        let child_lines = lines(&[
            json!({ "type": "session", "version": 3, "id": child, "timestamp": at, "cwd": "/w/x" }),
            json!({ "type": "custom", "id": "l1", "parentId": null, "timestamp": at, "customType": "pi-extensions.session-link",
                    "data": { "kind": "subagent", "parentSessionId": id, "parentToolCallId": "r9", "agentType": "recon" } }),
        ]);
        app.upload(DEVICE, &skey(child), "session", &child_lines).await;
    }

    let trace = app.json(&format!("sessions/{id}/trace")).await;
    let records = trace["records"].as_array().unwrap();
    let order: Vec<(i64, &str)> =
        records.iter().map(|r| (r["seq"].as_i64().unwrap(), r["callId"].as_str().unwrap_or(r["kind"].as_str().unwrap()))).collect();
    assert_eq!(
        order,
        [
            (2, "llm"), (2, "z1"), (2, "y2"), (2, "x3"), (2, "w4"), (2, "v5"), (2, "u6"), (2, "t7"), (2, "s8"), (2, "r9"),
            (2, "q10"), (2, "p11"), (2, "o12"), (5, "llm"), (5, "n13"), (6, "ghost"), (7, "branch-summary"), (8, "compaction"),
        ]
    );
    let ms = |iso: &str| pika::util::parse_iso_ms(iso).unwrap();
    // `durationMs` gives the end: the request started at `timestamp`.
    assert_eq!(
        records[0],
        json!({ "kind": "llm", "seq": 2, "turn": 0, "start": 1792742402000_i64, "end": 1792742404500_i64, "model": "m1",
                "stopReason": "toolUse", "input": 1, "output": 2, "cacheRead": 3, "cacheWrite": 4,
                "cost": 0.5, "text": "Working on it", "toolCalls": 12 })
    );
    let summaries: Vec<&str> = records[1..13].iter().map(|r| r["summary"].as_str().unwrap()).collect();
    let long_echo = format!("echo {}", "é".repeat(155));
    assert_eq!(
        summaries,
        [
            "cargo test --locked", "src/lib.rs:10-40", "fn main in src", "*.rs", "sqlite index", "https://sqlite.org/lang.html",
            "src/a.rs", "notes/é.md", "recon: Map the code", "libfoo.so", "const r = await tools.bash({});", &long_echo,
        ]
    );
    assert_eq!(
        records[1],
        json!({ "kind": "tool", "seq": 2, "resultSeq": 3, "turn": 0, "callId": "z1", "name": "bash",
                "start": ms("2026-10-23T08:00:05Z"), "end": ms("2026-10-23T08:00:06Z"), "durationMs": 1000, "isError": false,
                "summary": "cargo test --locked", "outputSize": 3 })
    );
    assert_eq!(records[2]["isError"], true);
    assert_eq!(records[9]["childSessionId"], "kid-1");
    // Missing times are omitted, never invented.
    assert_eq!(
        records[13],
        json!({ "kind": "llm", "seq": 5, "turn": 0, "stopReason": "toolUse", "input": 0, "output": 0, "cacheRead": 0,
                "cacheWrite": 0, "cost": 0.0, "toolCalls": 1 })
    );
    assert_eq!(records[14], json!({ "kind": "tool", "seq": 5, "turn": 0, "callId": "n13", "name": "ls", "isError": false, "summary": "/tmp" }));
    assert_eq!(
        records[15],
        json!({ "kind": "tool", "seq": 6, "resultSeq": 6, "turn": 0, "callId": "ghost", "name": "x",
                "end": ms("2026-10-23T08:00:09Z"), "isError": false, "summary": "", "outputSize": 3 })
    );
    assert_eq!(records[16], json!({ "kind": "branch-summary", "seq": 7, "turn": 0, "at": ms("2026-10-23T08:00:10Z") }));
    assert_eq!(records[17], json!({ "kind": "compaction", "seq": 8, "turn": 0 }));
    let children: Vec<(&str, &str)> = trace["children"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| (c["sessionId"].as_str().unwrap(), c["parentToolCallId"].as_str().unwrap()))
        .collect();
    assert_eq!(children, [("kid-1", "r9"), ("kid-2", "r9")]);
}

#[tokio::test]
async fn trace_is_gzipped_when_accepted() {
    let app = world().await;
    let path = format!("{BASE}/api/v1/sessions/{SESSION_ID}/trace");
    let plain = app.get_abs(&path, None).await;
    assert_eq!(plain.status, StatusCode::OK);
    assert!(plain.headers.get(header::CONTENT_ENCODING).is_none());
    assert_eq!(plain.headers[header::VARY], "accept-encoding");
    let cases = [
        ("gzip", true),
        ("br, gzip;q=0.5", true),
        ("br, gzip; q=0.5", true),
        ("deflate, GZIP", true),
        ("*", true),
        ("br, *;q=0.1", true),
        ("gzip;q=0", false),
        ("gzip; q = 0.0", false),
        ("*;q=0", false),
        ("gzip;q=0, *", false),
        ("*, gzip; q=0", false),
        ("gzip;q=1, *;q=0", true),
        ("br", false),
        ("identity", false),
    ];
    for (accept, gzipped) in cases {
        let request = Request::get(&path).header(header::ACCEPT_ENCODING, accept).body(Body::empty()).unwrap();
        let r = app.send(request).await;
        assert_eq!(r.status, StatusCode::OK);
        assert_eq!(r.headers[header::CONTENT_TYPE], "application/json");
        let body = if gzipped {
            assert_eq!(r.headers[header::CONTENT_ENCODING], "gzip", "{accept}");
            let mut out = Vec::new();
            std::io::Read::read_to_end(&mut flate2::read::GzDecoder::new(&r.body[..]), &mut out).unwrap();
            out
        } else {
            assert!(r.headers.get(header::CONTENT_ENCODING).is_none(), "{accept}");
            r.body
        };
        assert_eq!(body, plain.body, "{accept}");
    }
}

/// GETs the trace with optional `Accept-Encoding` and `If-None-Match` headers.
async fn get_trace(app: &App, id: &str, gzip: bool, if_none_match: Option<&str>) -> Reply {
    let mut request = Request::get(format!("{BASE}/api/v1/sessions/{id}/trace"));
    if gzip {
        request = request.header(header::ACCEPT_ENCODING, "gzip");
    }
    if let Some(tag) = if_none_match {
        request = request.header(header::IF_NONE_MATCH, tag);
    }
    app.send(request.body(Body::empty()).unwrap()).await
}

fn etag(r: &Reply) -> String {
    r.headers[header::ETAG].to_str().unwrap().to_owned()
}

#[tokio::test]
async fn trace_is_revalidated_by_etag() {
    let app = world().await;
    let first = get_trace(&app, SESSION_ID, false, None).await;
    assert_eq!(first.status, StatusCode::OK);
    assert_eq!(first.headers[header::CACHE_CONTROL], "no-cache");
    let tag = etag(&first);
    assert!(tag.starts_with('"') && tag.ends_with('"'), "{tag}");
    for if_none_match in [tag.clone(), format!("W/{tag}"), format!("\"nope\", {tag}"), "*".into()] {
        let r = get_trace(&app, SESSION_ID, false, Some(&if_none_match)).await;
        assert_eq!(r.status, StatusCode::NOT_MODIFIED, "{if_none_match}");
        assert!(r.body.is_empty());
        assert_eq!(etag(&r), tag);
        assert_eq!(r.headers[header::CACHE_CONTROL], "no-cache");
        assert_eq!(r.headers[header::VARY], "accept-encoding");
    }
    assert_eq!(get_trace(&app, SESSION_ID, false, Some("\"nope\"")).await.status, StatusCode::OK);

    // The gzipped body is another representation with its own tag.
    let gzipped = get_trace(&app, SESSION_ID, true, None).await;
    let gzip_tag = etag(&gzipped);
    assert_ne!(gzip_tag, tag);
    assert_eq!(gzipped.headers[header::CONTENT_ENCODING], "gzip");
    assert_eq!(get_trace(&app, SESSION_ID, true, Some(&tag)).await.status, StatusCode::OK);
    let r = get_trace(&app, SESSION_ID, true, Some(&gzip_tag)).await;
    assert_eq!((r.status, etag(&r)), (StatusCode::NOT_MODIFIED, gzip_tag.clone()));
    assert_eq!(get_trace(&app, SESSION_ID, false, Some(&gzip_tag)).await.status, StatusCode::OK);

    // Every change the trace shows changes the tag: a request that arrives after its model call sets `requestId`, ...
    let mut tags = vec![tag];
    let changed = |r: Reply, tags: &mut Vec<String>| {
        assert_eq!(r.status, StatusCode::OK);
        let tag = etag(&r);
        assert!(!tags.contains(&tag), "{tag} is not new");
        tags.push(tag);
        r.json()
    };
    let (batch, _) = request_batch("req-9", 1792486802500, &payload(), None);
    app.ingest(DEVICE, batch).await;
    let trace = changed(get_trace(&app, SESSION_ID, false, Some(&tags[0])).await, &mut tags);
    assert_eq!(trace["records"][0]["requestId"], "req-9");
    // ... an entry of the session, ...
    let next_turn = lines(&[json!({ "type": "message", "id": "a0000016", "parentId": "a0000015", "timestamp": "2026-10-23T09:00:00.000Z",
                                   "message": { "role": "user", "content": "One more thing", "timestamp": 1 } })]);
    app.append(DEVICE, &skey(SESSION_ID), "session", byte_len(&fixture("session.jsonl")), &next_turn).await;
    let trace = changed(get_trace(&app, SESSION_ID, false, Some(tags.last().unwrap())).await, &mut tags);
    assert_eq!(trace["turns"].as_array().unwrap().last().unwrap()["userText"], "One more thing");
    // ... an entry of a child, ...
    let child_entry = lines(&[json!({ "type": "session_info", "id": "l0000009", "parentId": "l0000002",
                                     "timestamp": "2026-10-20T09:00:07.000Z", "name": "Renamed" })]);
    app.append(DEVICE, &skey(LINKED_CHILD), "session", byte_len(&linked_child()), &child_entry).await;
    let trace = changed(get_trace(&app, SESSION_ID, false, Some(tags.last().unwrap())).await, &mut tags);
    assert_eq!(trace["children"][0]["entryCount"], 5);
    // ... a new child, ...
    let late = lines(&[json!({ "type": "session", "version": 3, "id": "late-child", "timestamp": "2026-10-20T11:00:00.000Z",
                               "cwd": "/w", "parentSession": format!("/x/2026-10-20T09-00-00-000Z_{SESSION_ID}.jsonl") })]);
    app.upload(DEVICE, &skey("late-child"), "session", &late).await;
    let trace = changed(get_trace(&app, SESSION_ID, false, Some(tags.last().unwrap())).await, &mut tags);
    assert_eq!(trace["children"].as_array().unwrap().len(), 3);
    // ... and a reindex, which can derive other rows from the same lines.
    let before = get_trace(&app, SESSION_ID, false, None).await;
    pika::reindex::reindex(&app.env.store).unwrap();
    let after = changed(get_trace(&app, SESSION_ID, false, Some(tags.last().unwrap())).await, &mut tags);
    assert_eq!(after, before.json());

    assert_eq!(get_trace(&app, "nope", false, Some("*")).await.status, StatusCode::NOT_FOUND);
}

const TIMING_KEYS: [&str; 4] = ["sentAt", "responseAt", "firstTokenAt", "firstToken"];

/// The timing keys of a trace record that has any.
fn timing_of(record: &Value) -> Value {
    TIMING_KEYS.iter().filter_map(|k| record.get(*k).map(|v| (k.to_string(), v.clone()))).collect::<serde_json::Map<_, _>>().into()
}

#[tokio::test]
async fn trace_shows_the_linked_request_timing() {
    let app = world().await;
    let (start, end) = (1792486802500_i64, pika::util::parse_iso_ms("2026-10-20T09:00:05Z").unwrap());
    // `req-1` has no timing, and the other model calls no request.
    let first = get_trace(&app, SESSION_ID, false, None).await;
    let records = first.json()["records"].as_array().unwrap().clone();
    assert_eq!((&records[0]["requestId"], &records[0]["start"], &records[0]["end"]), (&json!("req-1"), &json!(start), &json!(end)));
    assert!(records.iter().all(|r| timing_of(r) == json!({})), "{records:?}");

    // A later request for the call, which the call now links to, brings its timing and a new tag.
    let timing = json!({ "sentAt": start + 12, "responseAt": start + 400, "firstTokenAt": start + 900, "firstToken": "thinking" });
    let (mut batch, _) = request_batch("req-9", start, &payload(), None);
    batch["requests"][0]["timing"] = timing.clone();
    app.ingest(DEVICE, batch).await;
    let timed = get_trace(&app, SESSION_ID, false, Some(&etag(&first))).await;
    assert_eq!(timed.status, StatusCode::OK);
    assert_ne!(etag(&timed), etag(&first));
    let records = timed.json()["records"].as_array().unwrap().clone();
    assert_eq!((&records[0]["requestId"], timing_of(&records[0])), (&json!("req-9"), timing.clone()));
    assert!(records[1..].iter().all(|r| timing_of(r) == json!({})));

    // A resend with other timing is a no-op: neither the trace nor its tag changes.
    let (mut batch, _) = request_batch("req-9", start, &payload(), None);
    batch["requests"][0]["timing"] = json!({ "sentAt": start + 1 });
    app.ingest(DEVICE, batch).await;
    assert_eq!(get_trace(&app, SESSION_ID, false, Some(&etag(&timed))).await.status, StatusCode::NOT_MODIFIED);

    // Times more than a minute before the start or a second after the end are left out; `firstToken` goes with its time.
    let (mut batch, _) = request_batch("req-z", start, &payload(), None);
    batch["requests"][0]["timing"] =
        json!({ "sentAt": start - 60_000, "responseAt": start - 60_001, "firstTokenAt": end + 1_001, "firstToken": "text" });
    app.ingest(DEVICE, batch).await;
    let trace = get_trace(&app, SESSION_ID, false, Some(&etag(&timed))).await;
    assert_eq!(trace.status, StatusCode::OK);
    let record = &trace.json()["records"][0];
    assert_eq!((&record["requestId"], timing_of(record)), (&json!("req-z"), json!({ "sentAt": start - 60_000 })));
    let (mut batch, _) = request_batch("req-zz", start, &payload(), None);
    batch["requests"][0]["timing"] = json!({ "sentAt": start, "firstTokenAt": end + 1_000, "firstToken": "toolCall" });
    app.ingest(DEVICE, batch).await;
    let record = &app.json(&format!("sessions/{SESSION_ID}/trace")).await["records"][0];
    assert_eq!(timing_of(record), json!({ "sentAt": start, "firstTokenAt": end + 1_000, "firstToken": "toolCall" }));

    // A published trace keeps the timing and drops the request id.
    assert_eq!(publish(&app, "widgets", true, None).await.status, StatusCode::OK);
    let record = &public_json(&app, &format!("sessions/{SESSION_ID}/trace")).await["records"][0];
    assert_eq!((record.get("requestId"), timing_of(record)), (None, json!({ "sentAt": start, "firstTokenAt": end + 1_000, "firstToken": "toolCall" })));
}

#[tokio::test]
async fn trace_reads_blob_lines_and_survives_missing_blobs() {
    let app = app(None);
    let id = "blobby";
    let big = "x".repeat(pika::ingest::LINE_BLOB_THRESHOLD);
    let assistant = |eid: &str, at: &str, ts: Value, duration: Value, text: &str, padding: &str| {
        json!({ "type": "message", "id": eid, "parentId": null, "timestamp": at,
                "message": { "role": "assistant", "provider": "p", "model": "m", "stopReason": "stop", "timestamp": ts,
                             "durationMs": duration,
                             "content": [{ "type": "thinking", "thinking": padding }, { "type": "text", "text": text }] } })
    };
    let at = |s: u32| format!("2026-10-24T08:00:{s:02}.000Z");
    let ms = |s: u32| pika::util::parse_iso_ms(&at(s)).unwrap();
    let values = [
        json!({ "type": "session", "version": 3, "id": id, "timestamp": at(0), "cwd": "/w" }),
        json!({ "type": "message", "id": "u1", "parentId": null, "timestamp": at(1),
                "message": { "role": "user", "content": "Go", "timestamp": 1 } }),
        // Stored in the blob store.
        assistant("a1", &at(5), json!(ms(2)), json!(1000), "Big one", &big),
        assistant("a2", &at(9), json!(ms(6)), json!(1000), "Lost", &format!("{big}y")),
        // Implausible times and durations are left out.
        assistant("a3", &at(10), json!(i64::MAX), json!(1e300), "a3", ""),
        assistant("a4", &at(11), json!(ms(10)), json!(-5), "a4", ""),
        assistant("a5", &at(12), json!(ms(11)), json!(8.0 * 86_400_000.0), "a5", ""),
        assistant("a6", &at(13), json!(-1), json!(5), "a6", ""),
        json!({ "type": "compaction", "id": "c1", "parentId": null, "timestamp": at(14), "summary": big,
                "firstKeptEntryId": "a1", "tokensBefore": 1234 }),
    ];
    app.upload(DEVICE, &skey(id), "session", &lines(&values)).await;
    let blobs: Vec<String> = app.env.store.read(|conn| {
        let mut stmt = conn.prepare("SELECT blob FROM lines WHERE blob IS NOT NULL ORDER BY offset").unwrap();
        stmt.query_map([], |r| r.get(0)).unwrap().collect::<rusqlite::Result<Vec<String>>>()
    }).unwrap();
    assert_eq!(blobs.len(), 3);

    let records = |trace: &Value| trace["records"].as_array().unwrap().clone();
    let trace = app.json(&format!("sessions/{id}/trace")).await;
    let r = records(&trace);
    assert_eq!((&r[0]["text"], &r[0]["thinking"], &r[0]["start"], &r[0]["end"]), (&json!("Big one"), &json!(true), &json!(ms(2)), &json!(ms(2) + 1000)));
    assert_eq!((&r[1]["text"], &r[1]["end"]), (&json!("Lost"), &json!(ms(6) + 1000)));
    assert_eq!(r[6], json!({ "kind": "compaction", "seq": 8, "turn": 0, "at": ms(14), "tokensBefore": 1234 }));

    // An unreadable blob leaves its record without the line's facts instead of failing the trace.
    std::fs::remove_file(app.env.store.blobs.path(&blobs[1])).unwrap();
    std::fs::write(app.env.store.blobs.path(&blobs[2]), b"not zstd").unwrap();
    let trace = app.json(&format!("sessions/{id}/trace")).await;
    let r = records(&trace);
    assert_eq!((&r[0]["text"], &r[0]["end"]), (&json!("Big one"), &json!(ms(2) + 1000)));
    assert_eq!(
        r[1],
        json!({ "kind": "llm", "seq": 3, "turn": 0, "start": ms(6), "end": ms(9), "model": "m", "stopReason": "stop",
                "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "cost": 0.0, "toolCalls": 0 })
    );
    let times: Vec<(Option<i64>, Option<i64>)> = r[2..6].iter().map(|r| (r["start"].as_i64(), r["end"].as_i64())).collect();
    assert_eq!(times, [(None, Some(ms(10))), (Some(ms(10)), Some(ms(11))), (Some(ms(11)), Some(ms(12))), (None, Some(ms(13)))]);
    assert_eq!(r[6], json!({ "kind": "compaction", "seq": 8, "turn": 0, "at": ms(14) }));
}

#[tokio::test]
async fn trace_children_kinds_and_order() {
    let app = app(None);
    let id = "parent";
    let values = [
        json!({ "type": "session", "version": 3, "id": id, "timestamp": "2026-10-24T08:00:00.000Z", "cwd": "/w" }),
        json!({ "type": "message", "id": "a1", "parentId": null, "timestamp": "2026-10-24T08:00:05.000Z",
                "message": { "role": "assistant", "stopReason": "toolUse",
                             "content": [{ "type": "toolCall", "id": "k1", "name": "SubagentWorkflow", "arguments": { "name": "w" } }] } }),
    ];
    app.upload(DEVICE, &skey(id), "session", &lines(&values)).await;
    let link = |data: Value| json!({ "type": "custom", "id": "l1", "parentId": null, "customType": "pi-extensions.session-link", "data": data });
    // Without any time, so with no `startedAt`: listed last and not the tool's child, though its id sorts first.
    let timeless = lines(&[
        json!({ "type": "session", "version": 3, "id": "a-timeless", "cwd": "/w" }),
        link(json!({ "kind": "subagent", "parentSessionId": id, "parentToolCallId": "k1" })),
    ]);
    // A Herder step known only by its link kind, without a run id.
    let step = lines(&[
        json!({ "type": "session", "version": 3, "id": "b-step", "timestamp": "2026-10-24T08:00:07.000Z", "cwd": "/w" }),
        link(json!({ "kind": "herder-step", "parentSessionId": id })),
    ]);
    let timed = lines(&[
        json!({ "type": "session", "version": 3, "id": "c-timed", "timestamp": "2026-10-24T08:00:06.000Z", "cwd": "/w" }),
        link(json!({ "kind": "subagent", "parentSessionId": id, "parentToolCallId": "k1" })),
    ]);
    for (child, child_lines) in [("a-timeless", &timeless), ("b-step", &step), ("c-timed", &timed)] {
        app.upload(DEVICE, &skey(child), "session", child_lines).await;
    }
    let trace = app.json(&format!("sessions/{id}/trace")).await;
    let children: Vec<(&str, &str, bool)> = trace["children"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| (c["sessionId"].as_str().unwrap(), c["kind"].as_str().unwrap(), c.get("startedAt").is_some()))
        .collect();
    assert_eq!(children, [("c-timed", "subagent", true), ("b-step", "herder-step", true), ("a-timeless", "subagent", false)]);
    assert_eq!(trace["records"][1]["childSessionId"], "c-timed");
}

/// A ticket child's link `superagent` data reaches the owner's trace as `ticket`, validated; public traces never carry it.
#[tokio::test]
async fn trace_children_carry_ticket_metadata_for_the_owner_only() {
    let app = app(None);
    let id = "main";
    let values = [
        json!({ "type": "session", "version": 3, "id": id, "timestamp": "2026-10-24T08:00:00.000Z", "cwd": "/home/me/tickets" }),
        json!({ "type": "message", "id": "a1", "parentId": null, "timestamp": "2026-10-24T08:00:05.000Z",
                "message": { "role": "assistant", "stopReason": "toolUse",
                             "content": [{ "type": "toolCall", "id": "tc1", "name": "ticket_create", "arguments": { "title": "Fix it" } }] } }),
        json!({ "type": "message", "id": "r1", "parentId": "a1", "timestamp": "2026-10-24T08:00:06.000Z",
                "message": { "role": "toolResult", "toolCallId": "tc1", "toolName": "ticket_create", "isError": false,
                             "content": [{ "type": "text", "text": "#3 created" }] } }),
    ];
    app.upload(DEVICE, &skey(id), "session", &lines(&values)).await;
    let child = |child: &str, at: &str, superagent: Value| {
        lines(&[
            json!({ "type": "session", "version": 3, "id": child, "timestamp": at, "cwd": "/home/me/tickets" }),
            json!({ "type": "custom", "id": "l1", "parentId": null, "customType": "pi-extensions.session-link",
                    "data": { "kind": "subagent", "parentSessionId": id, "parentToolCallId": "tc1", "agentType": "ticket",
                              "description": "#3 Fix it", "superagent": superagent } }),
        ])
    };
    let long = "x".repeat(300);
    let children = [
        ("t1-good", "2026-10-24T08:00:05.500Z", json!({ "ticketId": 3, "branch": "pi/3-fix-it", "title": " Fix\nit " })),
        ("t2-string-id", "2026-10-24T08:00:06.000Z", json!({ "ticketId": "3", "branch": "pi/3", "title": "t" })),
        ("t3-float-id", "2026-10-24T08:00:07.000Z", json!({ "ticketId": 1.5, "branch": "pi/1" })),
        ("t4-negative", "2026-10-24T08:00:08.000Z", json!({ "ticketId": -1 })),
        ("t5-not-object", "2026-10-24T08:00:09.000Z", json!([3, "pi/3"])),
        ("t6-bad-fields", "2026-10-24T08:00:10.000Z", json!({ "ticketId": 6, "branch": long, "title": 42 })),
        ("t7-long-title", "2026-10-24T08:00:11.000Z", json!({ "ticketId": 7, "branch": 7, "title": long })),
    ];
    for (child_id, at, superagent) in &children {
        app.upload(DEVICE, &skey(child_id), "session", &child(child_id, at, superagent.clone())).await;
    }
    let trace = app.json(&format!("sessions/{id}/trace")).await;
    let tickets: Vec<(&str, Option<&Value>)> = trace["children"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| (c["sessionId"].as_str().unwrap(), c.get("ticket")))
        .collect();
    let x200 = "x".repeat(200);
    assert_eq!(
        tickets,
        [
            ("t1-good", Some(&json!({ "id": 3, "branch": "pi/3-fix-it", "title": "Fix it" }))),
            ("t2-string-id", None),
            ("t3-float-id", None),
            ("t4-negative", None),
            ("t5-not-object", None),
            ("t6-bad-fields", Some(&json!({ "id": 6 }))),
            ("t7-long-title", Some(&json!({ "id": 7, "title": x200 }))),
        ]
    );
    // The owner's summary keeps the whole link.
    let detail = app.json("sessions/t1-good").await;
    assert_eq!(detail["link"]["superagent"]["ticketId"], 3);

    assert_eq!(publish(&app, "tickets", true, None).await.status, StatusCode::OK);
    let trace = public_json(&app, &format!("sessions/{id}/trace")).await;
    assert_eq!(trace["children"].as_array().unwrap().len(), children.len());
    assert!(trace["children"].as_array().unwrap().iter().all(|c| c.get("ticket").is_none()));
    assert!(!trace.to_string().contains("pi/3-fix-it"));
    let detail = public_json(&app, "sessions/t1-good").await;
    assert!(detail.get("link").is_none());
    let tree = public_json(&app, &format!("sessions/{id}/tree")).await;
    assert!(!tree.to_string().contains("pi/3-fix-it"));
}

async fn public(app: &App, path: &str) -> Reply {
    let reply = app.get_abs(&format!("{BASE}/api/public/v1/{path}"), None).await;
    assert_eq!(reply.headers[header::CACHE_CONTROL], "no-store", "{path}");
    reply
}

async fn public_json(app: &App, path: &str) -> Value {
    let reply = public(app, path).await;
    assert_eq!(reply.status, StatusCode::OK, "{path}: {}", reply.text());
    reply.json()
}

async fn publish(app: &App, project: &str, published: bool, cookie: Option<&str>) -> Reply {
    let mut request = Request::patch(format!("{BASE}/api/v1/settings/publishing")).header(header::CONTENT_TYPE, "application/json");
    if let Some(cookie) = cookie {
        request = request.header(header::COOKIE, cookie);
    }
    app.send(request.body(Body::from(json!({ "project": project, "published": published }).to_string())).unwrap()).await
}

#[tokio::test]
async fn publication_is_opt_in_and_settings_require_login() {
    let app = app(Some("publishing-password"));
    load(&app).await;
    assert_eq!(app.get("settings/publishing").await.status, StatusCode::UNAUTHORIZED);
    assert_eq!(publish(&app, "widgets", true, None).await.status, StatusCode::UNAUTHORIZED);
    assert_eq!(public_json(&app, "sessions").await, json!({ "items": [], "nextCursor": null }));
    assert_eq!(public_json(&app, "facets").await, json!({ "devices": [], "projects": [], "models": [] }));
    for id in [SESSION_ID, "missing"] {
        for suffix in ["", "/tree", "/turns", "/entries", "/entries/0/raw", "/entries/13/image/0", "/trace", "/updates"] {
            let reply = public(&app, &format!("sessions/{id}{suffix}")).await;
            assert_eq!((reply.status, reply.json()), (StatusCode::NOT_FOUND, json!({ "error": "not_found" })));
        }
    }
    let reply = app
        .send(
            Request::post(format!("{BASE}/api/v1/login"))
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(json!({ "password": "publishing-password" }).to_string()))
                .unwrap(),
        )
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.text());
    let cookie = reply.headers[header::SET_COOKIE].to_str().unwrap().split(';').next().unwrap();
    let settings = app.get_abs(&format!("{BASE}/api/v1/settings/publishing"), Some(cookie)).await;
    assert_eq!(
        settings.json(),
        json!({ "projects": [
        { "project": "gadgets", "sessionCount": 1, "hiddenCount": 0, "published": false },
        { "project": "widgets", "sessionCount": 5, "hiddenCount": 0, "published": false }
    ] })
    );
    let private_model = lines(&[json!({ "type": "message", "id": "private-model", "parentId": "d0000004",
        "timestamp": "2026-10-22T08:00:07Z", "message": assistant("hidden spin", "private-model", 5) })]);
    app.append(DESKTOP, &skey(DESK_SESSION), "session", byte_len(&desk_session()), &private_model).await;
    let empty = json!({ "items": [], "nextCursor": null });
    assert_eq!(public_json(&app, "search?q=spin").await, empty);
    assert_eq!(publish(&app, "widgets", true, Some(cookie)).await.status, StatusCode::OK);
    // Public search finds only published sessions' matches; the owner's search still finds the private one.
    let sessions_of = |hits: &Value| {
        let mut ids: Vec<String> = hits["items"].as_array().unwrap().iter().map(|h| h["sessionId"].as_str().unwrap().to_owned()).collect();
        ids.sort();
        ids.dedup();
        ids
    };
    let owner = app.get_abs(&format!("{BASE}/api/v1/search?q=spin"), Some(cookie)).await.json();
    assert!(sessions_of(&owner).contains(&DESK_SESSION.to_owned()));
    let published = public_json(&app, "search?q=spin").await;
    assert_eq!(sessions_of(&published), [SESSION_ID, LINKED_CHILD]);
    assert_eq!(published["items"].as_array().unwrap().len(), owner["items"].as_array().unwrap().len() - 1);
    let relevance = public_json(&app, "search?q=spin&sort=relevance").await;
    assert_eq!(sessions_of(&relevance), [SESSION_ID, LINKED_CHILD]);
    // Grouped, the published child folds into its published parent, and the private session is left out.
    let grouped = public_json(&app, "search?q=spi&prefix=true&group=session").await;
    let groups = grouped["items"].as_array().unwrap();
    assert_eq!(groups.iter().map(|g| (&g["sessionId"], &g["matches"])).collect::<Vec<_>>(), [(&json!(SESSION_ID), &json!(5))]);
    let owner_grouped = app.get_abs(&format!("{BASE}/api/v1/search?q=spin&group=session"), Some(cookie)).await.json();
    assert!(owner_grouped["items"].as_array().unwrap().iter().any(|g| g["sessionId"] == DESK_SESSION));
    assert_eq!(public_json(&app, "search?q=hidden&group=session").await, empty);
    assert_eq!(public_json(&app, "search?q=hidden").await, empty);
    assert_eq!(public_json(&app, "search?q=spin&project=gadgets").await, empty);
    assert_eq!(
        public_json(&app, "facets").await,
        json!({
            "devices": [{ "id": DEVICE, "name": DEVICE_NAME }],
            "projects": ["widgets"], "models": ["claude-haiku-4-5", "claude-sonnet-4-5", "gpt-5"]
        })
    );
    for suffix in ["", "/turns", "/entries", "/entries/0/raw", "/entries/13/image/0", "/trace", "/updates"] {
        assert_eq!(public(&app, &format!("sessions/{SESSION_ID}{suffix}")).await.status, StatusCode::OK);
        assert_eq!(public(&app, &format!("sessions/{DESK_SESSION}{suffix}")).await.status, StatusCode::NOT_FOUND);
    }
    // There is no provider context route or any other private API in this namespace.
    for path in ["requests/req-1", "sessions/nope/export", "herder/runs", "devices", "relay", "settings/publishing"] {
        let reply = public(&app, path).await;
        assert_eq!((reply.status, reply.json()), (StatusCode::NOT_FOUND, json!({ "error": "not_found" })), "{path}");
    }
    let entries = public_json(&app, &format!("sessions/{SESSION_ID}/entries")).await;
    assert!(entries["items"].as_array().unwrap().iter().all(|e| e.get("requestId").is_none()));
    let image = entries["items"][13]["raw"]["message"]["content"][1]["src"].as_str().unwrap();
    assert_eq!(image, format!("{BASE}/api/public/v1/sessions/{SESSION_ID}/entries/13/image/0"));
    let reply = app.get_abs(image, None).await;
    assert_eq!(reply.body, b"hello");
    assert_eq!(reply.headers[header::CACHE_CONTROL], "no-store");
    // Published raw session content is retained, including its original relationship entry.
    assert_eq!(public(&app, &format!("sessions/{SESSION_ID}/entries/1/raw")).await.text(), fixture("session.jsonl")[1]);
    let trace = public_json(&app, &format!("sessions/{SESSION_ID}/trace")).await;
    assert!(trace["records"].as_array().unwrap().iter().all(|r| r.get("requestId").is_none()));
    let reply = app
        .send(
            Request::get(format!("{BASE}/api/public/v1/sessions/{SESSION_ID}/trace"))
                .header(header::ACCEPT_ENCODING, "gzip")
                .header(header::IF_NONE_MATCH, "*")
                .body(Body::empty())
                .unwrap(),
        )
        .await;
    assert_eq!(reply.status, StatusCode::OK);
    assert_eq!(reply.headers[header::CONTENT_ENCODING], "gzip");
    assert_eq!(reply.headers[header::CACHE_CONTROL], "no-store");
    let mut decoder = flate2::read::GzDecoder::new(reply.body.as_slice());
    let decoded: Value = serde_json::from_reader(&mut decoder).unwrap();
    assert_eq!(decoded, trace);
    assert_eq!(publish(&app, "widgets", false, Some(cookie)).await.status, StatusCode::OK);
    assert_eq!(app.get_abs(image, None).await.status, StatusCode::NOT_FOUND);
    assert_eq!(public_json(&app, "search?q=spin").await, empty);
    for suffix in ["", "/turns", "/entries", "/entries/0/raw", "/entries/13/image/0", "/trace", "/updates"] {
        assert_eq!(public(&app, &format!("sessions/{SESSION_ID}{suffix}")).await.status, StatusCode::NOT_FOUND);
    }
    let reply = app
        .send(
            Request::get(format!("{BASE}/api/public/v1/sessions/{SESSION_ID}/trace"))
                .header(header::IF_NONE_MATCH, "*")
                .body(Body::empty())
                .unwrap(),
        )
        .await;
    assert_eq!(reply.status, StatusCode::NOT_FOUND);
    assert_eq!(reply.headers[header::CACHE_CONTROL], "no-store");
}

#[tokio::test]
async fn public_pagination_filters_before_limiting_and_preserves_private_read_behavior() {
    let app = world().await;
    assert_eq!(publish(&app, "widgets", true, None).await.status, StatusCode::OK);
    let private = app.json("sessions?limit=1").await;
    assert_eq!(private["items"][0]["id"], DESK_SESSION);
    let expected = [REVIEW_SESSION, STEP_SESSION, HEADER_CHILD, SESSION_ID, LINKED_CHILD];
    let mut got = Vec::new();
    let mut cursor = None;
    loop {
        let path = match cursor {
            Some(ref c) => format!("sessions?limit=1&cursor={c}"),
            None => "sessions?limit=1".to_owned(),
        };
        let page = public_json(&app, &path).await;
        assert_eq!(page["items"].as_array().unwrap().len(), 1);
        got.push(page["items"][0]["id"].as_str().unwrap().to_owned());
        cursor = page["nextCursor"].as_str().map(str::to_owned);
        if cursor.is_none() {
            break;
        }
    }
    assert_eq!(got, expected);
    assert_eq!(public_json(&app, "sessions?project=gadgets").await["items"], json!([]));
    assert_eq!(public_json(&app, &format!("sessions?device={DESKTOP}")).await["items"], json!([]));
    assert_eq!(ids(public_json(&app, "sessions?model=gpt-5").await["items"].as_array().unwrap(), "id"), [SESSION_ID]);
    assert_eq!(public_json(&app, "sessions?from=2026-10-22").await["items"], json!([]));
    let roots = public_json(&app, "sessions?root=true").await;
    assert_eq!(ids(roots["items"].as_array().unwrap(), "id"), [REVIEW_SESSION, STEP_SESSION, SESSION_ID]);
    for summary in roots["items"].as_array().unwrap() {
        for field in ["parentSessionId", "link", "herderRunId"] {
            assert!(summary.get(field).is_none(), "{field}: {summary}");
        }
    }
    let reply = public(&app, "sessions?cursor=bad").await;
    assert_eq!(reply.status, StatusCode::BAD_REQUEST);
    let reply = app.send(Request::patch(format!("{BASE}/api/public/v1/sessions/{SESSION_ID}")).body(Body::empty()).unwrap()).await;
    assert_eq!(reply.status, StatusCode::METHOD_NOT_ALLOWED);
    assert_eq!(reply.headers[header::CACHE_CONTROL], "no-store");
}

#[tokio::test]
async fn public_relationships_include_only_published_targets() {
    let app = app(None);
    app.upload(DEVICE, &skey(SESSION_ID), "session", &fixture("session.jsonl")).await;
    let child: Vec<String> = linked_child().into_iter().map(|s| s.replace("/home/me/code/widgets", "/home/me/code/secret")).collect();
    app.upload(DEVICE, &skey(LINKED_CHILD), "session", &child).await;
    app.upload(DEVICE, &skey(HEADER_CHILD), "session", &header_child()).await;
    let parent = lines(&[json!({ "type": "session", "version": 3, "id": "parent-0001",
        "timestamp": "2026-10-20T08:00:00Z", "cwd": "/private" })]);
    app.upload(DEVICE, &skey("parent-0001"), "session", &parent).await;
    assert_eq!(publish(&app, "widgets", true, None).await.status, StatusCode::OK);
    let detail = public_json(&app, &format!("sessions/{SESSION_ID}")).await;
    assert_eq!(detail["childCount"], 1);
    assert_eq!(ids(detail["children"].as_array().unwrap(), "id"), [HEADER_CHILD]);
    assert!(detail.get("parentSessionId").is_none());
    assert!(detail.get("link").is_none());
    let trace = public_json(&app, &format!("sessions/{SESSION_ID}/trace")).await;
    assert_eq!(ids(trace["children"].as_array().unwrap(), "sessionId"), [HEADER_CHILD]);
    assert!(trace["records"].as_array().unwrap().iter().all(|r| r.get("childSessionId").is_none()));
    let updates = public_json(&app, &format!("sessions/{SESSION_ID}/updates")).await;
    assert_eq!(updates["session"]["childCount"], 1);
    assert!(updates["session"].get("parentSessionId").is_none());
    let private = app.json(&format!("sessions/{SESSION_ID}")).await;
    assert_eq!(private["childCount"], 2);
    assert_eq!(private["parentSessionId"], "parent-0001");
    assert!(private.get("link").is_some());
    assert_eq!(publish(&app, "private", true, None).await.status, StatusCode::OK);
    assert_eq!(public_json(&app, &format!("sessions/{SESSION_ID}")).await["parentSessionId"], "parent-0001");
    let roots = public_json(&app, "sessions?root=true").await;
    assert_eq!(ids(roots["items"].as_array().unwrap(), "id"), ["parent-0001"]);
    assert_eq!(publish(&app, "secret", true, None).await.status, StatusCode::OK);
    let detail = public_json(&app, &format!("sessions/{SESSION_ID}")).await;
    assert_eq!(detail["childCount"], 2);
    let trace = public_json(&app, &format!("sessions/{SESSION_ID}/trace")).await;
    assert!(trace["records"].as_array().unwrap().iter().any(|r| r["childSessionId"] == LINKED_CHILD));
}

#[tokio::test]
async fn publishing_settings_are_atomic_persistent_and_keep_missing_selections() {
    let app = world().await;
    for project in ["", " ", ".", "..", "a/b", "a\\b", "x\n", "unknown", &"x".repeat(1025)] {
        assert_eq!(publish(&app, project, true, None).await.status, StatusCode::BAD_REQUEST, "{project:?}");
    }
    let (a, b) = tokio::join!(publish(&app, "widgets", true, None), publish(&app, "gadgets", true, None));
    assert_eq!(a.status, StatusCode::OK);
    assert_eq!(b.status, StatusCode::OK);
    assert!(app.json("settings/publishing").await["projects"].as_array().unwrap().iter().all(|p| p["published"] == true));
    // The same basename on another device belongs to the same publication selection.
    let another = lines(&[json!({ "type": "session", "version": 3, "id": "another-widget",
        "timestamp": "2026-10-23T08:00:00Z", "cwd": "/other/widgets" })]);
    app.upload(DESKTOP, &skey("another-widget"), "session", &another).await;
    assert_eq!(public(&app, "sessions/another-widget").await.status, StatusCode::OK);
    pika::reindex::reindex(&app.env.store).unwrap();
    let reopened = pika::store::Store::open(app.env.dir.path().join("data")).unwrap();
    assert_eq!(
        serde_json::from_slice::<Value>(&reopened.setting("published_projects").unwrap().unwrap()).unwrap(),
        json!(["gadgets", "widgets"])
    );
    assert_eq!(public(&app, &format!("sessions/{SESSION_ID}")).await.status, StatusCode::OK);
    // A selection remains manageable after all its current derived sessions disappear.
    app.env.store.write(|tx| tx.execute("DELETE FROM sessions WHERE project = 'gadgets'", [])).unwrap();
    assert_eq!(app.json("settings/publishing").await["projects"][0], json!({ "project": "gadgets", "sessionCount": 0, "hiddenCount": 0, "published": true }));
    assert_eq!(publish(&app, "gadgets", false, None).await.status, StatusCode::OK);
    assert_eq!(app.json("settings/publishing").await["projects"].as_array().unwrap().len(), 1);
    let (a, b) = tokio::join!(publish(&app, "widgets", false, None), publish(&app, "widgets", false, None));
    assert_eq!(a.status, StatusCode::OK);
    assert_eq!(b.status, StatusCode::OK);
    assert_eq!(public_json(&app, "sessions").await["items"], json!([]));
}

/// A session in `cwd`, linked to `parent` by the tool call `call` when given; without `at` it has no time.
fn family_member(id: &str, at: Option<&str>, cwd: &str, parent: Option<&str>, call: Option<&str>) -> Vec<String> {
    let mut header = json!({ "type": "session", "version": 3, "id": id, "cwd": cwd });
    if let Some(at) = at {
        header["timestamp"] = json!(at);
    }
    let mut values = vec![header];
    if let Some(parent) = parent {
        let mut data = json!({ "kind": "subagent", "parentSessionId": parent });
        if let Some(call) = call {
            data["parentToolCallId"] = json!(call);
        }
        values.push(json!({ "type": "custom", "id": "l1", "parentId": null, "customType": "pi-extensions.session-link", "data": data }));
    }
    lines(&values)
}

/// `(id, at, cwd, parent, call)`, as `family_member` takes them.
type Member<'a> = (&'a str, Option<&'a str>, &'a str, Option<&'a str>, Option<&'a str>);

async fn upload_family(app: &App, members: &[Member<'_>]) {
    for &(id, at, cwd, parent, call) in members {
        app.upload(DEVICE, &skey(id), "session", &family_member(id, at, cwd, parent, call)).await;
    }
}

fn tree_nodes(tree: &Value) -> Vec<(String, i64)> {
    tree["nodes"].as_array().unwrap().iter().map(|n| (n["id"].as_str().unwrap().to_owned(), n["depth"].as_i64().unwrap())).collect()
}

fn tree_of(app: &App, id: &str, public: bool, max_nodes: usize, max_depth: usize) -> Value {
    let tree = app.env.store.read(|conn| pika::read::sessions::tree_limited(conn, id, public, max_nodes, max_depth)).unwrap();
    serde_json::to_value(tree).unwrap()
}

/// A child whose parent is not recorded is a root session until its parent arrives, in every filter combination.
#[tokio::test]
async fn a_child_is_a_root_session_until_its_parent_is_recorded() {
    let app = app(None);
    upload_family(&app, &[
        ("orphan", Some("2026-10-24T08:05:00.000Z"), "/w/widgets", Some("late"), Some("k-o")),
        ("orphan-child", Some("2026-10-24T08:06:00.000Z"), "/w/widgets", Some("orphan"), Some("k-c")),
        ("main", Some("2026-10-24T08:00:00.000Z"), "/w/widgets", None, None),
    ]).await;
    for query in ["?root=true", &format!("?root=true&device={DEVICE}"), "?root=true&project=widgets"] {
        assert_eq!(session_ids(&app, query).await, ["orphan", "main"], "{query}");
    }
    let tree = app.json("sessions/orphan-child/tree").await;
    assert_eq!(tree["rootId"], "orphan");
    assert_eq!(tree_nodes(&tree), [("orphan".to_owned(), 0), ("orphan-child".to_owned(), 1)]);

    upload_family(&app, &[("late", Some("2026-10-24T07:59:00.000Z"), "/w/widgets", None, None)]).await;
    assert_eq!(session_ids(&app, "?root=true").await, ["main", "late"]);
    assert_eq!(app.json("sessions/orphan-child/tree").await["rootId"], "late");
}

#[tokio::test]
async fn tree_lists_the_whole_family_in_pre_order() {
    let app = app(None);
    upload_family(&app, &[
        ("root", Some("2026-10-24T08:00:00.000Z"), "/w/widgets", None, None),
        // Without a time, so listed last, though its id sorts first.
        ("a-timeless", None, "/w/widgets", Some("root"), Some("k-t")),
        ("child-b", Some("2026-10-24T08:03:00.000Z"), "/w/widgets", Some("root"), None),
        ("child-a", Some("2026-10-24T08:01:00.000Z"), "/w/widgets", Some("root"), Some("k-a")),
        ("grand-a1", Some("2026-10-24T08:02:00.000Z"), "/w/widgets", Some("child-a"), Some("k-a1")),
    ]).await;
    let expected = [("root", 0), ("child-a", 1), ("grand-a1", 2), ("child-b", 1), ("a-timeless", 1)]
        .map(|(id, depth)| (id.to_owned(), depth));
    for id in ["grand-a1", "root", "child-b"] {
        let tree = app.json(&format!("sessions/{id}/tree")).await;
        assert_eq!(tree["rootId"], "root", "{id}");
        assert_eq!(tree_nodes(&tree), expected, "{id}");
        assert!(tree.get("truncated").is_none(), "{id}");
    }
    let tree = app.json("sessions/grand-a1/tree").await;
    let nodes = tree["nodes"].as_array().unwrap();
    assert!(nodes[0].get("parentToolCallId").is_none() && nodes[0].get("parentSessionId").is_none());
    assert_eq!((&nodes[1]["parentToolCallId"], &nodes[1]["parentSessionId"]), (&json!("k-a"), &json!("root")));
    assert_eq!(nodes[2]["parentToolCallId"], "k-a1");
    assert!(nodes[3].get("parentToolCallId").is_none());
    assert_eq!((&nodes[4]["parentToolCallId"], &nodes[4]["startedAt"]), (&json!("k-t"), &Value::Null));
    assert_eq!((&nodes[0]["childCount"], &nodes[0]["deviceName"], &nodes[1]["link"]["kind"]), (&json!(3), &json!(DEVICE_NAME), &json!("subagent")));
    // The nodes are the sessions' summaries, as `GET sessions/:id` lists its children.
    let detail = app.json("sessions/root").await;
    let mut child = detail["children"].as_array().unwrap().iter().find(|c| c["id"] == "child-a").unwrap().clone();
    child["depth"] = json!(1);
    assert_eq!(nodes[1], child);

    upload_family(&app, &[("alone", Some("2026-10-24T09:00:00.000Z"), "/w/widgets", None, None)]).await;
    assert_eq!(app.json("sessions/alone/tree").await["rootId"], "alone");
    assert_eq!(tree_nodes(&app.json("sessions/alone/tree").await), [("alone".to_owned(), 0)]);
    // A recorded parent that is missing stops the walk below it.
    upload_family(&app, &[("orphan", Some("2026-10-24T09:00:00.000Z"), "/w/widgets", Some("gone"), Some("k"))]).await;
    let tree = app.json("sessions/orphan/tree").await;
    assert_eq!((&tree["rootId"], &tree["nodes"][0]["parentSessionId"]), (&json!("orphan"), &json!("gone")));
    assert_eq!(tree_nodes(&tree), [("orphan".to_owned(), 0)]);
    assert_eq!(app.status("sessions/nope/tree").await, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn tree_lists_each_session_of_a_cycle_once() {
    let app = app(None);
    upload_family(&app, &[
        ("cycle-x", Some("2026-10-24T08:00:00.000Z"), "/w/widgets", Some("cycle-y"), None),
        ("cycle-y", Some("2026-10-24T08:01:00.000Z"), "/w/widgets", Some("cycle-x"), None),
        ("cycle-z", Some("2026-10-24T08:02:00.000Z"), "/w/widgets", Some("cycle-x"), None),
    ]).await;
    let tree = app.json("sessions/cycle-x/tree").await;
    assert_eq!(tree["rootId"], "cycle-y");
    assert_eq!(tree_nodes(&tree), [("cycle-y".to_owned(), 0), ("cycle-x".to_owned(), 1), ("cycle-z".to_owned(), 2)]);
    let tree = app.json("sessions/cycle-z/tree").await;
    assert_eq!(tree["rootId"], "cycle-y");
    assert_eq!(tree_nodes(&tree).len(), 3);
    let tree = app.json("sessions/cycle-y/tree").await;
    assert_eq!(tree["rootId"], "cycle-x");
    assert_eq!(tree_nodes(&tree), [("cycle-x".to_owned(), 0), ("cycle-y".to_owned(), 1), ("cycle-z".to_owned(), 1)]);
}

#[tokio::test]
async fn tree_limits_keep_the_path_to_the_session() {
    let app = app(None);
    let at = |minute: u32| format!("2026-10-24T08:{minute:02}:00.000Z");
    let times: Vec<String> = (0..8).map(at).collect();
    upload_family(&app, &[
        ("root", Some(&times[0]), "/w/widgets", None, None),
        ("c1", Some(&times[1]), "/w/widgets", Some("root"), None),
        ("c2", Some(&times[2]), "/w/widgets", Some("root"), None),
        ("c3", Some(&times[3]), "/w/widgets", Some("root"), None),
        ("c4", Some(&times[4]), "/w/widgets", Some("root"), None),
        ("c5", Some(&times[5]), "/w/widgets", Some("root"), None),
        ("g4", Some(&times[6]), "/w/widgets", Some("c4"), None),
        ("gg4", Some(&times[7]), "/w/widgets", Some("g4"), None),
    ]).await;
    let names = |ids: &[(&str, i64)]| ids.iter().map(|&(id, depth)| (id.to_owned(), depth)).collect::<Vec<_>>();

    // The node limit: past it only the path from the root to the session is walked.
    let tree = tree_of(&app, "g4", false, 2, 32);
    assert_eq!(tree_nodes(&tree), names(&[("root", 0), ("c1", 1), ("c4", 1), ("g4", 2)]));
    assert_eq!(tree["truncated"], true);
    let tree = tree_of(&app, "root", false, 3, 32);
    assert_eq!(tree_nodes(&tree), names(&[("root", 0), ("c1", 1), ("c2", 1)]));
    assert_eq!(tree["truncated"], true);
    let tree = tree_of(&app, "root", false, 8, 32);
    assert_eq!(tree_nodes(&tree).len(), 8);
    assert!(tree.get("truncated").is_none());

    // The depth limit, downward and on the walk up.
    let tree = tree_of(&app, "root", false, 100, 1);
    assert_eq!(tree_nodes(&tree), names(&[("root", 0), ("c1", 1), ("c2", 1), ("c3", 1), ("c4", 1), ("c5", 1)]));
    assert_eq!(tree["truncated"], true);
    let tree = tree_of(&app, "gg4", false, 100, 2);
    assert_eq!(tree["rootId"], "c4");
    assert_eq!(tree_nodes(&tree), names(&[("c4", 0), ("g4", 1), ("gg4", 2)]));
    assert_eq!(tree["truncated"], true);
    let tree = tree_of(&app, "g4", false, 100, 2);
    assert_eq!(tree["rootId"], "root");
    assert_eq!(tree_nodes(&tree).len(), 7);
    assert_eq!(tree["truncated"], true);
    let tree = tree_of(&app, "g4", false, 100, 3);
    assert_eq!(tree_nodes(&tree).len(), 8);
    assert!(tree.get("truncated").is_none());

    // The default depth limit of 32, through the API.
    let chain: Vec<String> = (0..34).map(|i| format!("deep-{i:02}")).collect();
    for (i, id) in chain.iter().enumerate() {
        let parent = i.checked_sub(1).map(|p| chain[p].as_str());
        app.upload(DEVICE, &skey(id), "session", &family_member(id, Some(&times[0]), "/w/widgets", parent, None)).await;
    }
    let tree = app.json("sessions/deep-00/tree").await;
    assert_eq!(tree_nodes(&tree).len(), 33);
    assert_eq!((&tree["nodes"][32]["id"], &tree["nodes"][32]["depth"], &tree["truncated"]), (&json!("deep-32"), &json!(32), &json!(true)));
    let tree = app.json("sessions/deep-33/tree").await;
    assert_eq!((&tree["rootId"], &tree["truncated"]), (&json!("deep-01"), &json!(true)));
    assert_eq!(tree_nodes(&tree).len(), 33);
}

#[tokio::test]
async fn public_tree_includes_only_published_sessions() {
    let app = app(None);
    upload_family(&app, &[
        ("top", Some("2026-10-24T07:00:00.000Z"), "/w/private", None, None),
        ("root", Some("2026-10-24T08:00:00.000Z"), "/w/widgets", Some("top"), Some("k-r")),
        ("child-a", Some("2026-10-24T08:01:00.000Z"), "/w/widgets", Some("root"), Some("k-a")),
        ("grand-a1", Some("2026-10-24T08:02:00.000Z"), "/w/widgets", Some("child-a"), Some("k-a1")),
        ("child-b", Some("2026-10-24T08:03:00.000Z"), "/w/secret", Some("root"), None),
        // Published, but below an unpublished child.
        ("grand-b1", Some("2026-10-24T08:04:00.000Z"), "/w/widgets", Some("child-b"), None),
    ]).await;
    let step = lines(&[
        json!({ "type": "session", "version": 3, "id": "step-c", "timestamp": "2026-10-24T08:05:00.000Z", "cwd": "/w/x" }),
        json!({ "type": "custom", "id": "l1", "parentId": null, "customType": "pi-extensions.session-link",
                "data": { "kind": "herder-step", "parentSessionId": "root",
                          "herder": { "runId": RUN_ID, "stepKey": "impl-T1", "stepId": "impl-T1", "repo": "widgets" } } }),
    ]);
    app.upload(DEVICE, &skey("step-c"), "session", &step).await;
    let private = app.json("sessions/grand-a1/tree").await;
    assert_eq!(private["rootId"], "top");
    assert_eq!(
        tree_nodes(&private).into_iter().map(|(id, _)| id).collect::<Vec<_>>(),
        ["top", "root", "child-a", "grand-a1", "child-b", "grand-b1", "step-c"]
    );
    assert_eq!(private["nodes"][6]["herderRunId"], RUN_ID);

    for id in ["grand-a1", "top", "nope"] {
        let reply = public(&app, &format!("sessions/{id}/tree")).await;
        assert_eq!((reply.status, reply.json()), (StatusCode::NOT_FOUND, json!({ "error": "not_found" })), "{id}");
    }
    assert_eq!(publish(&app, "widgets", true, None).await.status, StatusCode::OK);
    for id in ["grand-a1", "root", "step-c"] {
        let tree = public_json(&app, &format!("sessions/{id}/tree")).await;
        assert_eq!(tree["rootId"], "root", "{id}");
        assert_eq!(
            tree_nodes(&tree),
            [("root", 0), ("child-a", 1), ("grand-a1", 2), ("step-c", 1)].map(|(id, depth)| (id.to_owned(), depth)),
            "{id}"
        );
        let nodes = tree["nodes"].as_array().unwrap();
        assert!(nodes.iter().all(|n| n.get("link").is_none() && n.get("herderRunId").is_none()), "{id}");
        // The root's parent `top` is unpublished, so neither it nor its tool call is named.
        assert!(nodes[0].get("parentSessionId").is_none() && nodes[0].get("parentToolCallId").is_none(), "{id}");
        assert_eq!(nodes[0]["childCount"], json!(2));
        assert_eq!((&nodes[1]["parentSessionId"], &nodes[1]["parentToolCallId"]), (&json!("root"), &json!("k-a")));
    }
    let reply = public(&app, "sessions/grand-b1/tree").await;
    assert_eq!(reply.status, StatusCode::OK);
    let tree = reply.json();
    assert_eq!(tree["rootId"], "grand-b1");
    assert!(tree["nodes"][0].get("parentSessionId").is_none() && tree["nodes"][0].get("parentToolCallId").is_none());
    assert_eq!(public(&app, "sessions/child-b/tree").await.status, StatusCode::NOT_FOUND);
}

/// A session's repository link appears in every summary that lists it, owner's and public alike, and is absent for
/// sessions without one.
#[tokio::test]
async fn summaries_carry_the_repository() {
    let app = world().await;
    const COPY: &str = "c0py0000-0000-0000-0000-000000000001";
    const URL: &str = "https://github.com/me/widgets";
    let session = lines(&[
        json!({ "type": "session", "version": 3, "id": COPY, "timestamp": "2026-10-20T09:00:07.000Z", "cwd": "/tmp/pi-agent-1234-abcd" }),
        json!({ "type": "custom", "id": "k0000001", "parentId": null, "timestamp": "2026-10-20T09:00:07.100Z",
                "customType": "pi-extensions.session-link",
                "data": { "kind": "subagent", "parentSessionId": SESSION_ID, "parentToolCallId": "call_1", "agentId": "agent-4" } }),
    ]);
    let meta = json!({ "sessionId": COPY, "cwd": "/tmp/pi-agent-1234-abcd", "project": "widgets", "repository": URL });
    app.ingest(DEVICE, json!({ "streams": [{ "key": skey(COPY), "kind": "session", "offset": 0, "lines": session, "meta": meta }] })).await;

    let repository_of = |items: &[Value], id: &str| items.iter().find(|i| i["id"] == id).unwrap().get("repository").cloned();
    let listed = app.json("sessions?project=widgets").await;
    let items = listed["items"].as_array().unwrap();
    assert_eq!((repository_of(items, COPY), repository_of(items, SESSION_ID)), (Some(json!(URL)), None));
    let detail = app.json(&format!("sessions/{COPY}")).await;
    assert_eq!((&detail["project"], &detail["cwd"], &detail["repository"]), (&json!("widgets"), &json!("/tmp/pi-agent-1234-abcd"), &json!(URL)));
    let parent = app.json(&format!("sessions/{SESSION_ID}")).await;
    assert!(parent.get("repository").is_none());
    assert_eq!(repository_of(parent["children"].as_array().unwrap(), COPY), Some(json!(URL)));
    let tree = app.json(&format!("sessions/{COPY}/tree")).await;
    assert_eq!(repository_of(tree["nodes"].as_array().unwrap(), COPY), Some(json!(URL)));

    assert_eq!(publish(&app, "widgets", true, None).await.status, StatusCode::OK);
    assert_eq!(public_json(&app, &format!("sessions/{COPY}")).await["repository"], URL);
    let public_items = public_json(&app, "sessions").await;
    assert_eq!(repository_of(public_items["items"].as_array().unwrap(), COPY), Some(json!(URL)));
}

/// A session whose model calls name routed model ids, as Magpie's routes do.
fn routed_session(id: &str, at: &str, models: &[&str]) -> Vec<String> {
    let mut values = vec![
        json!({ "type": "session", "version": 3, "id": id, "timestamp": at, "cwd": "/home/me/code/routes" }),
        json!({ "type": "message", "id": "r0", "parentId": null, "timestamp": at, "message": { "role": "user", "content": "Go", "timestamp": 1 } }),
    ];
    for (i, model) in models.iter().enumerate() {
        let mut message = assistant(&format!("Reply {i}"), model, 1_000 + i as i64);
        message["provider"] = json!("magpie-internal");
        values.push(json!({ "type": "message", "id": format!("r{}", i + 1), "parentId": format!("r{i}"), "timestamp": at, "message": message }));
    }
    lines(&values)
}

/// Every model the read API reports is a bare name, in the owner's and the public namespaces, and no response names
/// the provider; the stored lines and the captured payload keep the ids as pi sent them.
#[tokio::test]
async fn models_read_as_bare_names_without_providers() {
    let app = app(None);
    const ROUTED: &str = "routed-1";
    const PLAIN: &str = "routed-2";
    let routed = ["codex/gpt-6.1-sol", "auto/claude-opus-5-5", "mercerrouter/claude-opus-5-5", "grok-4.7@500k", "kimi/k3.1-pro"];
    app.upload(DEVICE, &skey(ROUTED), "session", &routed_session(ROUTED, "2026-10-23T08:00:00.000Z", &routed)).await;
    let plain = ["gpt-6.1-sol", "google/gemini-3.5-flash"];
    app.upload(DESKTOP, &skey(PLAIN), "session", &routed_session(PLAIN, "2026-10-24T08:00:00.000Z", &plain)).await;
    let (skeleton, blocks) = pika::requests::split(&json!({ "model": "codex/gpt-6.1-sol", "input": [] }));
    app.ingest(DEVICE, json!({
        "blobs": blocks.iter().map(|(hash, data)| json!({ "hash": hash, "data": data })).collect::<Vec<_>>(),
        "requests": [{ "id": "req-routed", "sessionId": ROUTED, "seq": 2, "at": "2026-10-23T08:00:00.000Z", "fidelity": "payload",
                       "provider": "magpie-internal", "api": "openai-responses", "model": "codex/gpt-6.1-sol",
                       "assistant": { "timestamp": 1_000 }, "skeleton": skeleton,
                       "blocks": blocks.iter().map(|(h, _)| h.clone()).collect::<Vec<_>>() }],
    })).await;

    let bare = json!(["gpt-6.1-sol", "claude-opus-5-5", "grok-4.7", "k3.1-pro"]);
    let merged = json!(["claude-opus-5-5", "gemini-3.5-flash", "gpt-6.1-sol", "grok-4.7", "k3.1-pro"]);
    assert_eq!(app.json("facets").await["models"], merged);
    assert_eq!(app.json(&format!("sessions/{ROUTED}")).await["models"], bare);
    let listed = app.json("sessions").await;
    assert_eq!(listed["items"][1]["models"], bare);
    assert_eq!(listed["items"][0]["models"], json!(["gpt-6.1-sol", "gemini-3.5-flash"]));
    // A filter by a route, as older links have, means the route's model.
    for model in ["gpt-6.1-sol", "codex/gpt-6.1-sol", "magpie/codex/gpt-6.1-sol", " gpt-6.1-sol@1m "] {
        assert_eq!(session_ids(&app, &format!("?model={}", q(model))).await, [PLAIN, ROUTED], "{model}");
    }
    assert_eq!(session_ids(&app, &format!("?model={}", q("auto/claude-opus-5-5"))).await, [ROUTED]);
    assert_eq!(session_ids(&app, &format!("?model={}", q("grok-4.7@500k"))).await, [ROUTED]);
    assert_eq!(session_ids(&app, &format!("?model={}", q("google/gemini-3.5-flash"))).await, [PLAIN]);

    let trace = app.json(&format!("sessions/{ROUTED}/trace")).await;
    let models: Vec<&str> = trace["records"].as_array().unwrap().iter().filter(|r| r["kind"] == "llm").map(|r| r["model"].as_str().unwrap()).collect();
    assert_eq!(models, ["gpt-6.1-sol", "claude-opus-5-5", "claude-opus-5-5", "grok-4.7", "k3.1-pro"]);
    assert_eq!(trace["records"][0]["requestId"], "req-routed");

    let request = app.json("requests/req-routed").await;
    assert_eq!((request.get("provider"), &request["model"], &request["api"]), (None, &json!("gpt-6.1-sol"), &json!("openai-responses")));
    assert_eq!(request["payload"], json!({ "model": "codex/gpt-6.1-sol", "input": [] }));

    // The stored lines are verbatim.
    let entries = app.json(&format!("sessions/{ROUTED}/entries")).await;
    assert_eq!(entries["items"][2]["raw"]["message"]["model"], "codex/gpt-6.1-sol");
    assert_eq!(entries["items"][2]["raw"]["message"]["provider"], "magpie-internal");
    let raw = app.get(&format!("sessions/{ROUTED}/entries/2/raw")).await.text();
    assert!(raw.contains(r#""model":"codex/gpt-6.1-sol""#) && raw.contains("magpie-internal"), "{raw}");

    // The derived responses name no provider.
    for path in ["facets".to_owned(), "sessions".into(), format!("sessions/{ROUTED}"), format!("sessions/{ROUTED}/trace"),
                 format!("sessions/{ROUTED}/tree"), format!("sessions/{ROUTED}/turns"), "requests/req-routed".into()] {
        let text = app.get(&path).await.text();
        assert!(!text.contains("magpie-internal") && !text.contains("\"provider\""), "{path}: {text}");
    }

    assert_eq!(publish(&app, "routes", true, None).await.status, StatusCode::OK);
    assert_eq!(public_json(&app, "facets").await["models"], merged);
    assert_eq!(public_json(&app, &format!("sessions/{ROUTED}")).await["models"], bare);
    let public_ids = |v: Value| ids(v["items"].as_array().unwrap(), "id");
    assert_eq!(public_ids(public_json(&app, &format!("sessions?model={}", q("codex/gpt-6.1-sol"))).await), [PLAIN, ROUTED]);
    let trace = public(&app, &format!("sessions/{ROUTED}/trace")).await.text();
    assert!(trace.contains(r#""model":"gpt-6.1-sol""#) && !trace.contains("codex/") && !trace.contains("\"provider\""), "{trace}");
}

/// Usage sources share identical arithmetic, but only assistant messages count as requests.
fn statistics_session(id: &str, project: &str, at: i64, parent: Option<&str>) -> Vec<String> {
    let mut header = json!({ "type": "session", "id": id, "cwd": format!("/private/{project}"), "timestamp": at });
    if let Some(parent) = parent {
        header["parentSession"] = json!(format!("/private/2026-01-01T00-00-00Z_{parent}.jsonl"));
    }
    let usage = json!({ "input": 10, "output": 20, "cacheRead": 30, "cacheWrite": 40, "cost": { "total": 0.25 } });
    lines(&[
        header,
        json!({ "type": "message", "timestamp": at, "message": { "role": "user", "content": "private prompt" } }),
        json!({ "type": "message", "timestamp": at, "message": { "role": "assistant", "model": "private-model",
            "content": "private reply", "usage": usage } }),
        json!({ "type": "message", "timestamp": at, "message": { "role": "assistant", "stopReason": "error" } }),
        json!({ "type": "usage", "timestamp": at, "usage": usage }),
        json!({ "type": "compaction", "timestamp": at, "usage": usage }),
        json!({ "type": "branch_summary", "timestamp": at, "usage": usage }),
        json!({ "type": "compaction", "timestamp": at, "usage": "invalid" }),
    ])
}

#[tokio::test]
async fn statistics_are_anonymous_include_private_and_hidden_and_support_public_exclusion() {
    let owner = app(None);
    let app = app(Some("stats-password"));
    let at = pika::util::now_ms();
    for (id, project, parent) in [
        ("private-root", "private-project", None),
        ("public-root", "public-project", None),
        ("hidden-root", "public-project", None),
        ("hidden-child", "public-project", Some("hidden-root")),
        ("public-child", "public-project", Some("public-root")),
    ] {
        let source = statistics_session(id, project, at, parent);
        app.upload(DEVICE, &skey(id), "session", &source).await;
        // Repeated delivery does not create extra usage events.
        app.upload(DEVICE, &skey(id), "session", &source).await;
    }
    app.env.store.write(|tx| pika::read::publishing::update(tx, "public-project", true)).unwrap();
    app.env.store.write(|tx| pika::hidden::set(tx, "hidden-root", true, at)).unwrap();
    let stats = public_json(&app, "statistics?days=1").await;
    assert_eq!(stats["excludeUnpublished"], false);
    assert_eq!(stats["totals"], json!({ "sessions": 5, "requests": 10,
        "tokens": { "input": 200, "output": 400, "cacheRead": 600, "cacheWrite": 800 }, "cost": 5.0, "activeDays": 1,
        "estimatedCost": 0.0, "unpricedRequests": 0 }));
    assert_eq!(stats["daily"].as_array().unwrap().len(), 1);
    assert_eq!(stats["daily"][0]["sessions"], 5);
    let text = stats.to_string();
    for secret in ["private-project", "private-root", "hidden-root", "hidden-child", "laptop", DEVICE_NAME, "private prompt", "private reply", "cwd", "device", "sid", "seq"] {
        assert!(!text.contains(secret), "leaked {secret}: {text}");
    }
    // Exact field allowlists prevent future identifier or content additions slipping into this public response.
    let keys = |v: &Value| -> Vec<String> { let mut k: Vec<_> = v.as_object().unwrap().keys().cloned().collect(); k.sort(); k };
    assert_eq!(keys(&stats), ["daily", "excludeUnpublished", "from", "models", "projects", "requestMetrics", "to", "totals"]);
    assert_eq!(stats["projects"].as_array().unwrap().len(), 2);
    assert_eq!(stats["projects"][0]["kind"], "unpublished");
    assert_eq!(stats["projects"][0]["name"], Value::Null);
    assert_eq!(stats["projects"][0]["sessions"], 3);
    assert_eq!(stats["projects"][1]["name"], "public-project");
    assert_eq!(stats["requestMetrics"]["failed"], 5);
    assert_eq!(stats["requestMetrics"]["unknown"], 5);
    assert_eq!(stats["models"][0]["kind"], "other-usage");
    assert_eq!(stats["models"][1]["name"], "private-model");
    for field in ["projects", "models"] {
        let rows = stats[field].as_array().unwrap();
        assert_eq!(rows.iter().map(|r| r["requests"].as_i64().unwrap()).sum::<i64>(), 10);
        assert_eq!(rows.iter().map(|r| r["tokens"]["input"].as_i64().unwrap()).sum::<i64>(), 200);
        assert_eq!(rows.iter().map(|r| r["cost"].as_f64().unwrap()).sum::<f64>(), 5.0);
    }
    assert_eq!(keys(&stats["totals"]), ["activeDays", "cost", "estimatedCost", "requests", "sessions", "tokens", "unpricedRequests"]);
    assert_eq!(keys(&stats["daily"][0]), ["cost", "date", "requests", "sessions", "tokens"]);
    assert_eq!(keys(&stats["totals"]["tokens"]), ["cacheRead", "cacheWrite", "input", "output"]);
    let excluded = public_json(&app, "statistics?days=1&excludeUnpublished=true").await;
    assert_eq!(excluded["excludeUnpublished"], true);
    assert_eq!(excluded["totals"], json!({ "sessions": 2, "requests": 4,
        "tokens": { "input": 80, "output": 160, "cacheRead": 240, "cacheWrite": 320 }, "cost": 2.0, "activeDays": 1,
        "estimatedCost": 0.0, "unpricedRequests": 0 }));
    assert_eq!(excluded["daily"][0]["sessions"], 2);
    assert_eq!(excluded["projects"].as_array().unwrap().len(), 1);
    assert_eq!(excluded["projects"][0]["name"], "public-project");
    assert_eq!(excluded["requestMetrics"]["failed"], 2);
    assert_eq!(public_json(&app, "statistics?days=all&excludeUnpublished=true").await["from"], stats["from"]);
    for id in ["private-root", "hidden-root", "hidden-child"] {
        for suffix in ["", "/entries", "/entries/2/raw", "/trace", "/turns", "/updates", "/tree"] {
            assert_eq!(public(&app, &format!("sessions/{id}{suffix}")).await.status, StatusCode::NOT_FOUND);
        }
    }
    assert_eq!(app.status("statistics").await, StatusCode::UNAUTHORIZED);
    assert_eq!(public(&app, "settings/publishing").await.status, StatusCode::NOT_FOUND);
    pika::reindex::reindex(&app.env.store).unwrap();
    pika::reindex::reindex(&app.env.store).unwrap();
    assert_eq!(public_json(&app, "statistics?days=1").await, stats);
    assert_eq!(public_json(&app, "statistics?days=1&excludeUnpublished=true").await, excluded);
    // Owner routes have the same arithmetic and scope options when accessible.
    owner.upload(DEVICE, &skey("s"), "session", &statistics_session("s", "p", at, None)).await;
    let named = owner.json("statistics?days=1").await;
    let anonymous = public_json(&owner, "statistics?days=1").await;
    assert_eq!(named["totals"], anonymous["totals"]);
    assert_eq!(named["models"], anonymous["models"]);
    assert_eq!(named["projects"][0]["name"], "p");
    assert_eq!(anonymous["projects"][0]["kind"], "unpublished");
    assert_eq!(anonymous["projects"][0]["name"], Value::Null);
    assert_eq!(owner.json("statistics?days=1&excludeUnpublished=true").await["totals"]["sessions"], 0);
    pika::delete::delete_session(&owner.env.store, "s").unwrap().unwrap();
    assert_eq!(owner.json("statistics?days=1").await["totals"]["sessions"], 0);
    assert_eq!(owner.json("statistics?days=1").await["totals"]["requests"], 0);
    assert_eq!(one(&owner.env.store, "SELECT COUNT(*) AS n FROM usage_events")["n"], 0);
    pika::reindex::reindex(&owner.env.store).unwrap();
    assert_eq!(public_json(&owner, "statistics?days=all").await["totals"]["cost"], 0.0);
}

#[tokio::test]
async fn usage_api_is_anonymous_cross_origin_and_groups_without_naming_private_projects() {
    let app = app(Some("usage-password"));
    let at = pika::util::now_ms();
    for (id, project) in [("private-root", "private-project"), ("public-root", "public-project")] {
        app.upload(DEVICE, &skey(id), "session", &statistics_session(id, project, at, None)).await;
    }
    app.env.store.write(|tx| pika::read::publishing::update(tx, "public-project", true)).unwrap();
    let keys = |v: &Value| -> Vec<String> { let mut k: Vec<_> = v.as_object().unwrap().keys().cloned().collect(); k.sort(); k };

    let reply = public(&app, "usage?days=1&by=model").await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.text());
    assert_eq!(reply.headers[header::ACCESS_CONTROL_ALLOW_ORIGIN], "*");
    let models = reply.json();
    assert_eq!(keys(&models), ["by", "excludeUnpublished", "from", "groups", "interval", "periods", "to", "total"]);
    assert_eq!(models["total"], json!({ "requests": 4, "tokens": 800, "input": 80, "output": 160, "cacheRead": 240,
        "cacheWrite": 320, "cost": 2.0 }));
    // Summaries and the failed call without a model are the unnamed group.
    let groups: Vec<_> = models["groups"].as_array().unwrap().iter().map(|g| (g["name"].clone(), g["requests"].clone(), g["tokens"].clone())).collect();
    assert_eq!(groups, [(Value::Null, json!(2), json!(600)), (json!("private-model"), json!(2), json!(200))]);
    assert_eq!(models["periods"].as_array().unwrap().len(), 1);
    assert_eq!(keys(&models["periods"][0]), ["cacheRead", "cacheWrite", "cost", "end", "groups", "input", "output", "requests", "start", "tokens"]);
    assert_eq!(models["periods"][0]["tokens"], 800);

    let projects = public_json(&app, "usage?days=7&by=project&interval=week").await;
    let text = projects.to_string();
    for secret in ["private-project", "private-root", "public-root", DEVICE_NAME, "private prompt", "private reply", "cwd", "sid"] {
        assert!(!text.contains(secret), "leaked {secret}: {text}");
    }
    let names: Vec<_> = projects["groups"].as_array().unwrap().iter().map(|g| g["name"].clone()).collect();
    assert_eq!(names, [json!("public-project"), Value::Null]);
    let excluded = public_json(&app, "usage?days=1&excludeUnpublished=true").await;
    assert_eq!(excluded["total"]["tokens"], 400);
    assert!(excluded.get("groups").is_none());

    // Errors and the other aggregate endpoint are readable across origins too; nothing else public is.
    let bad = public(&app, "usage?interval=year").await;
    assert_eq!(bad.status, StatusCode::BAD_REQUEST);
    assert_eq!(bad.headers[header::ACCESS_CONTROL_ALLOW_ORIGIN], "*");
    assert_eq!(public(&app, "statistics?days=1").await.headers[header::ACCESS_CONTROL_ALLOW_ORIGIN], "*");
    for path in ["facets", "sessions", "search?q=prompt"] {
        assert!(public(&app, path).await.headers.get(header::ACCESS_CONTROL_ALLOW_ORIGIN).is_none(), "{path}");
    }
    let preflight = app
        .send(
            Request::options(format!("{BASE}/api/public/v1/usage?days=7"))
                .header(header::ORIGIN, "https://example.com")
                .header(header::ACCESS_CONTROL_REQUEST_METHOD, "GET")
                .body(Body::empty())
                .unwrap(),
        )
        .await;
    assert_eq!(preflight.status, StatusCode::NO_CONTENT);
    assert_eq!(preflight.headers[header::ACCESS_CONTROL_ALLOW_ORIGIN], "*");
    assert_eq!(preflight.headers[header::ACCESS_CONTROL_ALLOW_METHODS], "GET, OPTIONS");

    // The owner's copy names every project, but stays behind the login and same-origin.
    let owner = app.get("usage?days=1").await;
    assert_eq!(owner.status, StatusCode::UNAUTHORIZED);
    assert!(owner.headers.get(header::ACCESS_CONTROL_ALLOW_ORIGIN).is_none());
}

#[tokio::test]
async fn statistics_reject_bad_ranges_and_flags_and_do_not_offer_named_filters() {
    let app = app(None);
    for query in ["days=0", "days=-1", "days=367", "days=1.5", "days=wat", "days=ALL", "days=", "days=999999999999999999999",
        "days=%2B1", "excludeUnpublished=yes"] {
        assert_eq!(app.status(&format!("statistics?{query}")).await, StatusCode::BAD_REQUEST, "{query}");
        assert_eq!(public(&app, &format!("statistics?{query}")).await.status, StatusCode::BAD_REQUEST, "{query}");
    }
    let stats = public_json(&app, "statistics").await;
    assert_eq!(stats["daily"].as_array().unwrap().len(), 30);
    assert_eq!(stats, public_json(&app, "statistics?project=unknown&model=unknown&device=unknown").await);
}

#[tokio::test]
async fn statistics_timestamp_fallbacks_and_incremental_ingest_match_reindex() {
    let app = app(None);
    let at = pika::util::now_ms();
    let source = lines(&[
        json!({ "type": "session", "id": "fallback", "cwd": "/private/project" }),
        // No prior time: excluded from dated totals, but retained in the ledger.
        json!({ "type": "message", "message": { "role": "assistant", "usage": { "input": 99 } } }),
        // Assistant timestamp fallback, then an entry time establishes the session fallback.
        json!({ "type": "message", "message": { "role": "assistant", "timestamp": at, "usage": { "input": 1 } } }),
        json!({ "type": "message", "timestamp": at, "message": { "role": "user", "content": "prompt" } }),
        json!({ "type": "message", "message": { "role": "assistant", "usage": { "input": 2 } } }),
        json!({ "type": "compaction", "usage": { "input": 3 } }),
        json!({ "type": "branch_summary", "usage": {} }),
        json!({ "type": "usage" }),
    ]);
    // One line per batch exercises persisted fallback state.
    for (offset, line) in source.iter().scan(0, |offset, line| {
        let out = (*offset, line.clone()); *offset += byte_len(std::slice::from_ref(line)); Some(out)
    }) {
        app.append(DEVICE, &skey("fallback"), "session", offset, &[line]).await;
    }
    let before = public_json(&app, "statistics?days=1").await;
    assert_eq!(before["totals"]["requests"], 2);
    assert_eq!(before["totals"]["tokens"]["input"], 6);
    assert_eq!(before["totals"]["sessions"], 1);
    assert_eq!(one(&app.env.store, "SELECT COUNT(*) AS n FROM usage_events")["n"], 5);
    assert_eq!(one(&app.env.store, "SELECT COUNT(*) AS n FROM usage_events WHERE at IS NULL")["n"], 1);
    assert_eq!(one(&app.env.store, "SELECT input FROM sessions")["input"], 105);
    let derived = dump_derived(&app.env.store);
    pika::reindex::reindex(&app.env.store).unwrap();
    assert_eq!(dump_derived(&app.env.store), derived);
    assert_eq!(public_json(&app, "statistics?days=1").await, before);
}

#[test]
fn statistics_version_10_upgrade_backfills_ledger_without_changing_source_lines() {
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");
    let expected = {
        let store = pika::store::Store::open(&data).unwrap();
        let source = statistics_session("legacy", "legacy-project", pika::util::now_ms(), None);
        upload(&store, &skey("legacy"), "session", &source, 2);
        dump_derived(&store)
    };
    let conn = rusqlite::Connection::open(data.join("pika.db")).unwrap();
    conn.execute_batch(&format!("{UNDO_V11} PRAGMA user_version = 10;")).unwrap();
    // Replaying the source must leave it intact.
    conn.execute_batch("CREATE TRIGGER no_source_updates BEFORE UPDATE ON lines
        BEGIN SELECT RAISE(ABORT, 'source modified'); END;
        CREATE TRIGGER no_source_deletes BEFORE DELETE ON lines
        BEGIN SELECT RAISE(ABORT, 'source deleted'); END;").unwrap();
    drop(conn);
    let store = pika::store::Store::open(&data).unwrap();
    assert_eq!(one(&store, "PRAGMA user_version")["user_version"], 18);
    assert_eq!(dump_derived(&store), expected);
    assert!(store.setting(pika::store::NEEDS_REINDEX).unwrap().is_none());
    assert!(store.setting(pika::store::DERIVED_GENERATION).unwrap().is_some());
    let params = pika::read::Params(BTreeMap::from([("days".into(), "1".into())]));
    let stats = store.read(|c| pika::read::statistics::statistics(c, &params)).unwrap();
    assert_eq!(stats.totals.counts.requests, 2);
    assert_eq!(stats.totals.counts.tokens.input, 40);
    // A later open must not replay the source again.
    store.write(|tx| tx.execute_batch("CREATE TRIGGER no_repeated_reindex BEFORE DELETE ON usage_events
        BEGIN SELECT RAISE(ABORT, 'reindexed twice'); END;")).unwrap();
    drop(store);
    let store = pika::store::Store::open(&data).unwrap();
    assert_eq!(dump_derived(&store), expected);
}

fn spokesman_rewrite(id: &str, target: &str, original: &str, rewritten: &str) -> Value {
    json!({ "type": "custom", "id": id, "customType": "spokesman-rewrite",
        "data": { "targetEntryId": target, "originalText": original, "rewrittenText": rewritten } })
}

fn spokesman_message(id: &str, content: Value) -> Value {
    json!({ "type": "message", "id": id, "message": content })
}

fn spokesman_header(id: &str) -> Value {
    json!({ "type": "session", "version": 3, "id": id, "cwd": "/home/me/code/widgets" })
}

#[tokio::test]
async fn spokesman_projects_auto_and_manual_rewrites_without_reindexing() {
    let app = app(None);
    let id = "spokesman-auto-manual";
    let mut auto = spokesman_rewrite("r-auto", "a-auto", "Original automatic answer", "Automatic rewrite");
    auto["data"]["originalModel"] = json!("codex/gpt-6@1m");
    auto["data"]["spokesmanModel"] = json!("google/gemini@500k");
    auto["data"]["spokesmanProvider"] = json!("magpie");
    let mut malformed = spokesman_rewrite("bad", "a-manual", "Bad", "Bad");
    malformed["data"]["rewrittenText"] = json!(42);
    let input = lines(&[
        spokesman_header(id),
        spokesman_message("u-auto", json!({ "role": "user", "content": "Automatic" })),
        spokesman_message("a-auto", assistant("<!-- spokesman:rewritten -->\nAutomatic rewrite", "gpt-6", 1)),
        auto,
        spokesman_message("u-manual", json!({ "role": "user", "content": "Manual" })),
        spokesman_message("a-manual", assistant("Original manual answer", "gpt-6", 2)),
        spokesman_rewrite("r-old", "a-manual", "Original manual answer", "Old manual rewrite"),
        spokesman_rewrite("r-latest", "a-manual", "Original manual answer", "Latest manual rewrite"),
        malformed,
        spokesman_rewrite("orphan", "missing", "Orphan", "Orphan"),
        spokesman_rewrite("not-assistant", "u-manual", "User", "User"),
        json!({ "type": "custom", "customType": "spokesman-rewrite", "data": {
            "originalText": "Legacy targetless", "rewrittenText": "Legacy targetless rewrite" } }),
        spokesman_rewrite("empty-original", "a-manual", " \n ", "Invalid"),
        spokesman_rewrite("empty-rewrite", "a-manual", "Original manual answer", " \n "),
        json!({ "type": "custom", "customType": "spokesman-rewrite", "data": null }),
        spokesman_message("u-marker", json!({ "role": "user", "content": "Marker without a valid record" })),
        spokesman_message("a-marker", assistant("<!-- spokesman:rewritten -->\nVisible answer", "gpt-6", 3)),
    ]);
    app.upload(DEVICE, &skey(id), "session", &input).await;
    let foreign = lines(&[
        spokesman_header("spokesman-other-session"),
        spokesman_message("foreign-user", json!({ "role": "user", "content": "Other session" })),
        spokesman_message("foreign-answer", assistant("Visible answer", "gpt-6", 1)),
    ]);
    app.upload(DEVICE, &skey("spokesman-other-session"), "session", &foreign).await;
    let orphan = lines(&[spokesman_rewrite("foreign-target", "foreign-answer", "Foreign original", "Foreign rewrite")]);
    app.append(DEVICE, &skey(id), "session", byte_len(&input), &orphan).await;
    let before = dump_derived(&app.env.store);
    let version = one(&app.env.store, "PRAGMA user_version");
    let path = format!("sessions/{id}");
    let turns = app.json(&format!("{path}/turns")).await;
    assert_eq!(turns["items"][0]["finalText"], "Automatic rewrite");
    assert_eq!(turns["items"][0]["spokesman"], json!({
        "seq": 3, "targetSeq": 2, "originalText": "Original automatic answer", "rewrittenText": "Automatic rewrite",
        "originalModel": "gpt-6", "spokesmanModel": "gemini",
    }));
    assert_eq!(turns["items"][1]["finalText"], "Original manual answer");
    assert_eq!(turns["items"][1]["spokesman"], json!({
        "seq": 7, "targetSeq": 5, "originalText": "Original manual answer", "rewrittenText": "Latest manual rewrite",
    }));
    assert_eq!(turns["items"][2]["finalText"], "Visible answer");
    assert!(turns["items"][2].get("spokesman").is_none());
    let updates = app.json(&format!("{path}/updates")).await;
    assert_eq!(updates["turns"], turns["items"]);
    let trace = app.json(&format!("{path}/trace")).await;
    let records = trace["records"].as_array().unwrap();
    assert_eq!(records.len(), 3, "rewrites are not additional model calls");
    assert_eq!(records[0]["spokesmanSeq"], 3);
    assert_eq!(records[1]["spokesmanSeq"], 7);
    assert!(records[2].get("spokesmanSeq").is_none());
    assert_eq!(records[0]["text"], "Automatic rewrite");
    assert_eq!(records[1]["text"], "Original manual answer");
    assert_eq!(records[2]["text"], "Visible answer");
    for record in records {
        assert_eq!(record["model"], "gpt-6");
        assert_eq!(record["input"], 10);
        assert_eq!(record["output"], 5);
        assert_eq!(record["cost"], 0.001);
        assert!(record.get("originalText").is_none());
    }
    assert_eq!(app.json(&format!("{path}/entries?from=7&to=7")).await["items"][0]["raw"]["data"]["rewrittenText"], "Latest manual rewrite");
    assert_eq!(dump_derived(&app.env.store), before, "reads must not change existing derived data");
    assert_eq!(one(&app.env.store, "PRAGMA user_version"), version);
    // Reopening an existing database must expose the enhancement without running reindex.
    let reopened = pika::store::Store::open(app.env.dir.path().join("data")).unwrap();
    let persisted = reopened.read(|conn| pika::read::sessions::turns(conn, &reopened.blobs, id, &Default::default())).unwrap();
    assert_eq!(serde_json::to_value(persisted).unwrap(), turns);
    assert_eq!(dump_derived(&app.env.store), before);
}

#[tokio::test]
async fn spokesman_associates_only_the_final_nonempty_assistant_and_polls_late_rewrites() {
    let app = app(None);
    let id = "spokesman-final-target";
    let input = lines(&[
        spokesman_header(id),
        spokesman_message("u1", json!({ "role": "user", "content": "First turn" })),
        spokesman_message("earlier", assistant("<!-- spokesman:rewritten -->\nEarlier rewrite", "gpt-6", 1)),
        spokesman_rewrite("r1", "earlier", "Earlier original", "Earlier rewrite"),
        spokesman_message("final", assistant("Final answer", "gpt-6", 2)),
        spokesman_message("empty", assistant(" \n ", "gpt-6", 3)),
        spokesman_rewrite("r2", "earlier", "Earlier original", "New earlier rewrite"),
    ]);
    app.upload(DEVICE, &skey(id), "session", &input).await;
    let path = format!("sessions/{id}");
    let turns = app.json(&format!("{path}/turns")).await;
    assert_eq!(turns["items"][0]["finalText"], "Final answer");
    assert!(turns["items"][0].get("spokesman").is_none());
    let trace = app.json(&format!("{path}/trace")).await;
    assert_eq!(trace["records"][0]["spokesmanSeq"], 6);
    assert!(trace["records"][1].get("spokesmanSeq").is_none());
    let next = lines(&[
        spokesman_message("u2", json!({ "role": "user", "content": "Second turn" })),
        // Identical answer text in a different turn must not participate in matching.
        spokesman_message("second-final", assistant("Final answer", "gpt-6", 4)),
    ]);
    app.append(DEVICE, &skey(id), "session", byte_len(&input), &next).await;
    let rewrite = lines(&[spokesman_rewrite("late", "final", "Final answer", "Manual rewrite of the first turn")]);
    app.append(DEVICE, &skey(id), "session", byte_len(&input) + byte_len(&next), &rewrite).await;
    let turns = app.json(&format!("{path}/turns")).await;
    assert_eq!(turns["items"][0]["spokesman"]["seq"], 9);
    assert_eq!(turns["items"][0]["spokesman"]["targetSeq"], 4);
    assert_eq!(turns["items"][0]["finalText"], "Final answer");
    assert!(turns["items"][1].get("spokesman").is_none());
    let updates = app.json(&format!("{path}/updates?since=8")).await;
    assert_eq!(updates["turns"], turns["items"], "polling must refresh the older target turn too");
    let trace = app.json(&format!("{path}/trace")).await;
    assert_eq!(trace["records"][1]["spokesmanSeq"], 9);
    assert!(trace["records"][3].get("spokesmanSeq").is_none());
    let unchanged = app.json(&format!("{path}/updates?since=9")).await;
    assert!(unchanged.get("turns").is_none());
}

#[tokio::test]
async fn spokesman_reads_blob_backed_rewrites_and_assistants_without_cutting_text() {
    let app = app(None);
    let id = "spokesman-blobs";
    let original = format!("{}\nOriginal end", "原".repeat(400_000));
    let rewritten = format!("{}\nRewrite end", "é".repeat(530_000));
    let input = lines(&[
        spokesman_header(id),
        spokesman_message("user", json!({ "role": "user", "content": "Long response" })),
        spokesman_message("answer", assistant(&format!("<!-- spokesman:rewritten -->\n{rewritten}"), "gpt-6", 1)),
        spokesman_rewrite("rewrite", "answer", &original, &rewritten),
    ]);
    app.upload(DEVICE, &skey(id), "session", &input).await;
    assert_eq!(one(&app.env.store, "SELECT count(*) AS n FROM lines WHERE data IS NULL AND blob IS NOT NULL")["n"], 2);
    let path = format!("sessions/{id}");
    let turns = app.json(&format!("{path}/turns")).await;
    let turn = &turns["items"][0];
    assert_eq!(turn["finalText"], rewritten);
    assert_eq!(turn["spokesman"]["originalText"], original);
    assert_eq!(turn["spokesman"]["rewrittenText"], rewritten);
    assert_eq!(turn["spokesman"]["targetSeq"], 2);
    assert_eq!(app.json(&format!("{path}/updates")).await["turns"], turns["items"]);
    let trace = app.json(&format!("{path}/trace")).await;
    assert_eq!(trace["records"][0]["spokesmanSeq"], 3);
    assert!(!trace.to_string().contains("<!-- spokesman:rewritten -->"));
    assert!(trace.to_string().len() < 5000, "trace must stay compact");
    let raw = app.get(&format!("{path}/entries/3/raw")).await.json();
    assert_eq!(raw["data"]["originalText"], original);
    assert_eq!(raw["data"]["rewrittenText"], rewritten);
}
