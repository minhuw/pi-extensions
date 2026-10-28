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
    assert_eq!(session_ids(&app, "?root=true").await, [DESK_SESSION]);
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
    assert_eq!(session_ids(&app, &format!("?root=true&device={DEVICE}")).await, Vec::<String>::new());
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
            "parentSessionId": "parent-0001", "link": link["data"], "childCount": 2,
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
        json!({ "id": "req-1", "sessionId": SESSION_ID, "fidelity": "payload", "provider": "anthropic",
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
              "verdict": "met", "startedAt": "2026-10-21T10:00:00.000Z", "lastAt": "2026-10-21T10:14:00.000Z", "stepCount": 2 },
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
    conn.execute_batch(&format!(
        "DROP TABLE search_fts; DROP TABLE search_docs; DROP INDEX sessions_device_project; DROP INDEX sessions_root_device;
         DROP INDEX sessions_root_project; DROP INDEX sessions_root_device_project; {UNDO_V5} {UNDO_V4} PRAGMA user_version = 1;"
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
    conn.execute_batch(&format!(
        "DROP TABLE search_fts; DROP TABLE search_docs; DROP INDEX sessions_device_project; DROP INDEX sessions_root_device;
         DROP INDEX sessions_root_project; DROP INDEX sessions_root_device_project; {UNDO_V5} {UNDO_V4} PRAGMA user_version = 1;"
    ))
    .unwrap();
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

    std::fs::rename(&aside, &blob).unwrap();
    let store = pika::store::Store::open(&data).unwrap();
    let mut params = pika::read::Params::default();
    params.0.insert("q".into(), "flaky".into());
    let hits = store.read(|conn| pika::read::search::search(conn, &params)).unwrap();
    assert_eq!(hits.items.len(), 1);
    assert_eq!(store.setting("needs_reindex").unwrap(), None);
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
                "model": "claude-sonnet-4-5", "provider": "anthropic", "stopReason": "toolUse",
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
                "message": { "role": "assistant", "api": "anthropic-messages", "provider": "anthropic", "model": "m1",
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
                "provider": "anthropic", "stopReason": "toolUse", "input": 1, "output": 2, "cacheRead": 3, "cacheWrite": 4,
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
        json!({ "kind": "llm", "seq": 3, "turn": 0, "start": ms(6), "end": ms(9), "model": "m", "provider": "p", "stopReason": "stop",
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
        for suffix in ["", "/turns", "/entries", "/entries/0/raw", "/entries/13/image/0", "/trace", "/updates"] {
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
        { "project": "gadgets", "sessionCount": 1, "published": false },
        { "project": "widgets", "sessionCount": 5, "published": false }
    ] })
    );
    let private_model = lines(&[json!({ "type": "message", "id": "private-model", "parentId": "d0000004",
        "timestamp": "2026-10-22T08:00:07Z", "message": assistant("hidden", "private-model", 5) })]);
    app.append(DESKTOP, &skey(DESK_SESSION), "session", byte_len(&desk_session()), &private_model).await;
    assert_eq!(publish(&app, "widgets", true, Some(cookie)).await.status, StatusCode::OK);
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
    for path in ["requests/req-1", "sessions/nope/export", "herder/runs", "search?q=test", "devices", "relay", "settings/publishing"] {
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
    assert_eq!(app.json("settings/publishing").await["projects"][0], json!({ "project": "gadgets", "sessionCount": 0, "published": true }));
    assert_eq!(publish(&app, "gadgets", false, None).await.status, StatusCode::OK);
    assert_eq!(app.json("settings/publishing").await["projects"].as_array().unwrap().len(), 1);
    let (a, b) = tokio::join!(publish(&app, "widgets", false, None), publish(&app, "widgets", false, None));
    assert_eq!(a.status, StatusCode::OK);
    assert_eq!(b.status, StatusCode::OK);
    assert_eq!(public_json(&app, "sessions").await["items"], json!([]));
}
