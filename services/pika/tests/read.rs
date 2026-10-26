mod common;

use std::collections::BTreeMap;

use axum::Router;
use axum::body::Body;
use axum::http::{Request, StatusCode, header};
use common::*;
use pika::config::ServerConfig;
use pika::http::{AppState, router};
use pika::util::encode_path_segment;
use serde_json::{Value, json};
use tower::ServiceExt;

const BASE: &str = "/pika";
const DESKTOP: &str = "desktop";
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
    let tokens = [DEVICE, DESKTOP]
        .iter()
        .map(|d| (d.to_string(), pika::auth::create_token(&env.store, d).unwrap()))
        .collect();
    let mut config = ServerConfig::new(env.dir.path().join("data"));
    config.base_path = BASE.into();
    config.password = password.map(str::to_owned);
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

fn step_session(id: &str, at: &str, step: &str, role: &str, attempt: i64, prompt: &str) -> Vec<String> {
    lines(&[
        json!({ "type": "session", "version": 3, "id": id, "timestamp": at, "cwd": "/home/me/.git/herder/worktrees/r1/x" }),
        json!({ "type": "custom", "id": "s0000001", "parentId": null, "timestamp": at, "customType": "pi-extensions.session-link",
                "data": { "kind": "herder-step", "parentSessionId": "orch-1",
                          "herder": { "runId": RUN_ID, "stepKey": step, "stepId": step, "task": "T1", "role": role,
                                      "attempt": attempt, "launch": 1, "repo": "widgets" } } }),
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
    let step = step_session(STEP_SESSION, "2026-10-21T10:05:31.000Z", "impl-T1", "worker", 2, "Implement T1");
    app.upload(DEVICE, &skey(STEP_SESSION), "session", &step).await;
    let review = step_session(REVIEW_SESSION, "2026-10-21T10:09:11.000Z", "review-T1", "reviewer", 1, "Review T1");
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
        json!({ "devices": [DESKTOP, DEVICE], "projects": ["gadgets", "widgets"],
                "models": ["claude-haiku-4-5", "claude-sonnet-4-5", "gpt-5"] })
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
            "id": SESSION_ID, "device": DEVICE, "project": "widgets", "cwd": "/home/me/code/widgets",
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

    assert_eq!(app.status("sessions/nope").await, StatusCode::NOT_FOUND);
    assert_eq!(app.status("sessions/nope/turns").await, StatusCode::NOT_FOUND);
    assert_eq!(app.status("sessions/nope/entries").await, StatusCode::NOT_FOUND);
    assert_eq!(app.status("sessions/nope/updates").await, StatusCode::NOT_FOUND);
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
            { "runId": RUN2, "device": DESKTOP, "repo": "gadgets", "title": "Speed up gadgets", "status": "running",
              "startedAt": "2026-10-22T09:00:00.000Z", "lastAt": "2026-10-22T09:01:00.000Z", "stepCount": 1 },
            { "runId": RUN_ID, "device": DEVICE, "repo": "widgets", "title": "Add pagination", "status": "delivered",
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
        for sub in ["", "/turns", "/turns?limit=1", "/entries", "/entries?from=3&limit=2", "/updates", "/entries/0/raw", "/export"] {
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
    conn.execute_batch(
        "DROP TABLE search_fts; DROP TABLE search_docs; DROP INDEX sessions_device_project; DROP INDEX sessions_root_device;
         DROP INDEX sessions_root_project; DROP INDEX sessions_root_device_project; PRAGMA user_version = 1;",
    )
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
    conn.execute_batch(
        "DROP TABLE search_fts; DROP TABLE search_docs; DROP INDEX sessions_device_project; DROP INDEX sessions_root_device;
         DROP INDEX sessions_root_project; DROP INDEX sessions_root_device_project; PRAGMA user_version = 1;",
    )
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
