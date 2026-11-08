//! The agent read API, `{base}/api/agent/v1/`: device tokens with read access, a per-device switch that is on by
//! default, read every recorded session, published or not, hidden or not, scrubbed as public responses are. Also the
//! grant itself (devices routes, pairing, CLI) and `group=session` search's `exclude`, `project`, and `lastAt`. Every
//! credential here is made up.

mod common;

use std::process::Command;

use axum::Router;
use axum::body::Body;
use axum::http::{Method, Request, StatusCode, header};
use common::*;
use pika::config::{AuthMode, ServerConfig};
use pika::http::{AppState, router};
use serde_json::{Value, json};
use tower::ServiceExt;

const PASSWORD: &str = "correct horse battery";
const SESSION: &str = "a9e47000-0000-4000-8000-000000000001";
const CHILD: &str = "a9e47000-0000-4000-8000-0000000000c1";
const OTHER: &str = "a9e47000-0000-4000-8000-000000000002";
/// A Herder run in `widgets` that `SESSION` orchestrated and whose step ran in `CHILD`.
const RUN: &str = "20261020-090010-a9e4";

const GITHUB_TOKEN: &str = "ghp_FAKEagentFAKEagentFAKEagentFAKEagent";
const ENV_SECRET: &str = "s3cr3t-Value-91827364";
const CREDENTIALS: [&str; 2] = [GITHUB_TOKEN, ENV_SECRET];
/// In the child's session link: its description assigns one, and its spawner's data names the other a token and
/// repeats it in a title.
const LINK_SECRET: &str = "FAKElinkPass0042";
const LINK_TOKEN: &str = "FAKElinkTicketToken0042";

struct Reply {
    status: StatusCode,
    headers: header::HeaderMap,
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
    /// The token of the device that uploads, whose read access the owner turned off.
    token: String,
}

impl App {
    fn new(auth: AuthMode) -> App {
        let env = env();
        let token = device(&env.store, DEVICE);
        env.store.write(|tx| tx.execute("UPDATE devices SET read_access = 0 WHERE id = ?1", [DEVICE])).unwrap();
        let mut config = ServerConfig::new(env.dir.path().join("data"));
        config.auth = auth;
        config.password = Some(PASSWORD.into());
        let app = router(AppState::new(env.store.clone(), config).unwrap());
        App { env, app, token }
    }

    async fn send(&self, request: Request<Body>) -> Reply {
        let response = self.app.clone().oneshot(request).await.unwrap();
        let status = response.status();
        let headers = response.headers().clone();
        let body = axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap().to_vec();
        Reply { status, headers, body }
    }

    async fn json(&self, method: Method, path: &str, body: Value) -> Reply {
        let request = Request::builder()
            .method(method)
            .uri(path)
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(body.to_string()))
            .unwrap();
        self.send(request).await
    }

    /// `GET {path}` with `token` as the bearer, if any.
    async fn get_as(&self, path: &str, token: Option<&str>) -> Reply {
        let mut request = Request::get(path);
        if let Some(token) = token {
            request = request.header(header::AUTHORIZATION, format!("Bearer {token}"));
        }
        self.send(request.body(Body::empty()).unwrap()).await
    }

    /// An agent's `GET {base}/api/agent/v1/{path}`, which must succeed and not be cached.
    async fn agent(&self, token: &str, path: &str) -> Reply {
        let reply = self.get_as(&format!("/api/agent/v1/{path}"), Some(token)).await;
        assert_eq!(reply.status, StatusCode::OK, "{path}: {}", reply.text());
        assert_eq!(reply.headers[header::CACHE_CONTROL], "no-store", "{path}");
        assert!(reply.headers.get(header::ACCESS_CONTROL_ALLOW_ORIGIN).is_none(), "{path}");
        reply
    }

    /// The owner's `GET {base}/api/v1/{path}`; the app must not ask for a password.
    async fn owner(&self, path: &str) -> Reply {
        let reply = self.get_as(&format!("/api/v1/{path}"), None).await;
        assert_eq!(reply.status, StatusCode::OK, "{path}: {}", reply.text());
        reply
    }

    async fn upload(&self, id: &str, lines: &[String]) {
        self.ingest(json!({ "streams": [stream(&format!("session:{id}"), "session", 0, lines)] })).await;
    }

    async fn ingest(&self, batch: Value) {
        let request = Request::post("/api/ingest/v1/batch")
            .header(header::CONTENT_TYPE, "application/json")
            .header(header::AUTHORIZATION, format!("Bearer {}", self.token))
            .body(Body::from(batch.to_string()))
            .unwrap();
        let reply = self.send(request).await;
        assert_eq!(reply.status, StatusCode::OK, "{}", reply.text());
    }

    /// A new device named `id`, whose agents may read by default, and its token.
    fn reader(&self, id: &str) -> String {
        device(&self.env.store, id)
    }

    fn read_access(&self, id: &str) -> Value {
        one(&self.env.store, &format!("SELECT read_access FROM devices WHERE id = '{id}'"))["read_access"].clone()
    }
}

fn message(id: &str, parent: Option<&str>, at: &str, message: Value) -> Value {
    json!({ "type": "message", "id": id, "parentId": parent, "timestamp": at, "message": message })
}

fn assistant(content: Value, stop: &str, ts: i64) -> Value {
    json!({ "role": "assistant", "content": content, "api": "openai-responses", "provider": "openai", "model": "gpt-5",
            "usage": { "input": 100, "output": 20, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 120, "cost": { "total": 0.002 } },
            "stopReason": stop, "timestamp": ts })
}

fn header_line(id: &str, at: &str, cwd: &str) -> Value {
    json!({ "type": "session", "version": 3, "id": id, "timestamp": at, "cwd": cwd })
}

fn lines(values: &[Value]) -> Vec<String> {
    values.iter().map(Value::to_string).collect()
}

/// A session in project `widgets` whose prompt (and so title), reply, tool call, and tool result hold credentials,
/// with a screenshot in its prompt.
fn session() -> Vec<String> {
    lines(&[
        header_line(SESSION, "2026-10-20T09:00:00.000Z", "/home/me/code/widgets"),
        message("e1", None, "2026-10-20T09:00:01.000Z", json!({ "role": "user", "timestamp": 1792486801000_i64, "content": [
            { "type": "text", "text": format!("Deploy the zebra widgets; my GitHub token is {GITHUB_TOKEN}") },
            { "type": "image", "data": "iVBORw0KGgo=", "mimeType": "image/png" },
        ] })),
        message("e2", Some("e1"), "2026-10-20T09:00:03.000Z", assistant(json!([
            { "type": "text", "text": format!("Using {GITHUB_TOKEN} for the zebra deploy.") },
            { "type": "toolCall", "id": "call_1", "name": "bash", "arguments": { "command": format!("DB_PASSWORD={ENV_SECRET} npm run deploy") } },
        ]), "toolUse", 1792486803000)),
        message("e3", Some("e2"), "2026-10-20T09:00:04.000Z", json!({ "role": "toolResult", "toolCallId": "call_1", "toolName": "bash",
            "isError": false, "timestamp": 1792486804000_i64, "content": [{ "type": "text", "text": format!("DB_PASSWORD={ENV_SECRET} accepted") }] })),
        message("e4", Some("e3"), "2026-10-20T09:00:05.000Z", assistant(json!([
            { "type": "text", "text": format!("Deployed. Revoke {GITHUB_TOKEN} later.") },
        ]), "stop", 1792486805000)),
    ])
}

/// A subagent of `SESSION`, whose link's description and spawner data hold credentials.
fn child() -> Vec<String> {
    lines(&[
        header_line(CHILD, "2026-10-20T09:00:06.000Z", "/home/me/code/widgets"),
        json!({ "type": "custom", "id": "c1", "parentId": null, "timestamp": "2026-10-20T09:00:06.100Z", "customType": "pi-extensions.session-link",
                "data": { "kind": "subagent", "parentSessionId": SESSION, "parentToolCallId": "call_1", "agentType": "recon",
                          "description": format!("Check the zebra with DB_PASSWORD={LINK_SECRET}"),
                          "ticket": { "title": format!("Rotate {LINK_TOKEN}"), "branch": "fix/zebra", "token": LINK_TOKEN } } }),
        message("c2", Some("c1"), "2026-10-20T09:00:06.200Z", json!({ "role": "user", "content": "Check the zebra pen", "timestamp": 1792486806200_i64 })),
        message("c3", Some("c2"), "2026-10-20T09:00:07.000Z", assistant(json!([{ "type": "text", "text": "The zebra is fine." }]), "stop", 1792486807000)),
    ])
}

/// `RUN`'s journal: its title, a check's command and log, and the step's reply and structured output hold credentials.
fn journal() -> Vec<String> {
    let at = |s: u32| format!("2026-10-20T09:{:02}:{:02}.000Z", 10 + s / 60, s % 60);
    lines(&[
        json!({ "v": 1, "t": "run.started", "at": at(0), "runId": RUN, "title": format!("Rotate {GITHUB_TOKEN}"), "base": "abc1234",
                "runtime": "1.0.0", "repo": "/home/me/code/widgets", "sessionId": SESSION }),
        json!({ "v": 1, "t": "goal.approved", "at": at(1), "sha256": "9a1f", "approvedBy": "user",
                "checks": [{ "id": "test", "command": format!("DB_PASSWORD={ENV_SECRET} npm test"), "timeoutMs": 600000 }] }),
        json!({ "v": 1, "t": "script.launched", "at": at(2), "launch": 1, "scriptSha256": "5d5d", "head": "abc1234",
                "args": { "api_key": "FAKEargsKey0042" } }),
        json!({ "v": 1, "t": "step.started", "at": at(3), "key": "impl-T1", "id": "impl-T1", "occurrence": 0, "fingerprint": "f1",
                "attempt": 1, "role": "worker", "write": true, "base": "abc1234", "task": "T1", "launch": 1, "label": "Implement T1",
                "sessionId": CHILD }),
        json!({ "v": 1, "t": "step.completed", "at": at(64), "key": "impl-T1", "fingerprint": "f1", "status": "ok", "commit": "c0ffee1234",
                "text": format!("Rotated {GITHUB_TOKEN}."), "data": { "token": LINK_TOKEN, "files": 2 }, "sessionId": CHILD }),
        json!({ "v": 1, "t": "check.completed", "at": at(65), "checkId": "test", "commit": "d00d1234", "exitCode": 0, "timedOut": false,
                "durationMs": 900, "logRef": "logs/test.log", "tail": format!("DB_PASSWORD={ENV_SECRET} ok"), "purpose": "integrate" }),
        json!({ "v": 1, "t": "integrate.completed", "at": at(66), "key": "impl-T1", "from": "abc1234", "source": "c0ffee1234",
                "head": "d00d1234", "tree": "7ree", "message": "fix: rotate the token", "task": "T1", "checks": [] }),
        json!({ "v": 1, "t": "verify.completed", "at": at(67), "head": "d00d1234", "checks": [], "verdict": "met", "verifierRan": true,
                "criteria": [{ "id": "C1", "status": "met", "evidence": "tests pass" }] }),
        json!({ "v": 1, "t": "run.finished", "at": at(68), "status": "delivered", "reason": "done" }),
    ])
}

/// Another root session, in project `gadgets`, a day later.
fn other() -> Vec<String> {
    lines(&[
        header_line(OTHER, "2026-10-21T09:00:00.000Z", "/home/me/code/gadgets"),
        message("o1", None, "2026-10-21T09:00:01.000Z", json!({ "role": "user", "content": "Paint the zebra gadget", "timestamp": 1792573201000_i64 })),
        message("o2", Some("o1"), "2026-10-21T09:00:02.000Z", assistant(json!([{ "type": "text", "text": "Painted." }]), "stop", 1792573202000)),
    ])
}

async fn world(auth: AuthMode) -> App {
    let app = App::new(auth);
    app.upload(SESSION, &session()).await;
    app.upload(CHILD, &child()).await;
    app.upload(OTHER, &other()).await;
    let key = format!("herder:{RUN}");
    app.ingest(json!({
        "streams": [stream(&key, "herder-journal", 0, &journal())],
        "documents": [
            { "key": format!("{key}:goal.md"), "kind": "herder-goal", "runId": RUN, "content": format!("# Goal\nRevoke {GITHUB_TOKEN}.") },
            { "key": format!("{key}:plan.md"), "kind": "herder-plan", "runId": RUN, "content": format!("# Plan\n- T1: replace {GITHUB_TOKEN}") },
        ],
    }))
    .await;
    app
}

const ROUTES: [&str; 10] = [
    "facets", "sessions", "sessions/{id}", "sessions/{id}/tree", "sessions/{id}/turns", "sessions/{id}/entries", "sessions/{id}/trace",
    "search?q=zebra", "herder/runs", "herder/runs/{run}",
];

fn route(path: &str) -> String {
    path.replace("{id}", SESSION).replace("{run}", RUN)
}

#[tokio::test]
async fn new_databases_and_devices_start_with_read_access() {
    let app = App::new(AuthMode::None);
    assert_eq!(one(&app.env.store, "PRAGMA user_version")["user_version"], json!(15));
    app.reader("fresh");
    assert_eq!(app.read_access("fresh"), json!(1));
    let devices = app.owner("devices").await.json();
    let listed: Vec<_> = devices["items"].as_array().unwrap().iter().map(|d| (d["id"].clone(), d["readAccess"].clone())).collect();
    assert_eq!(listed, [(json!("fresh"), json!(true)), (json!(DEVICE), json!(false))]);

    // A database from before version 13 keeps its devices, all of them with read access.
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");
    {
        let store = pika::store::Store::open(&data).unwrap();
        device(&store, DEVICE);
    }
    let conn = rusqlite::Connection::open(data.join("pika.db")).unwrap();
    conn.execute_batch(&format!("{UNDO_V13} PRAGMA user_version = 12;")).unwrap();
    drop(conn);
    let store = pika::store::Store::open(&data).unwrap();
    assert_eq!(one(&store, "PRAGMA user_version")["user_version"], json!(15));
    assert_eq!(store.setting("needs_reindex").unwrap(), None);
    assert_eq!(one(&store, "SELECT id, read_access FROM devices"), one(&store, &format!("SELECT '{DEVICE}' AS id, 1 AS read_access")));
}

#[tokio::test]
async fn patching_a_device_grants_and_withdraws_read_access() {
    let app = App::new(AuthMode::None);
    let patch = |id: &str, body: Value| {
        let path = format!("/api/v1/devices/{id}");
        let app = &app;
        async move { app.json(Method::PATCH, &path, body).await }
    };

    let r = patch(DEVICE, json!({ "readAccess": true })).await;
    assert_eq!((r.status, r.json()), (StatusCode::OK, json!({ "id": DEVICE, "name": DEVICE, "readAccess": true })));
    assert_eq!(app.owner("devices").await.json()["items"][0]["readAccess"], json!(true));
    // Both fields apply together; a name alone leaves the grant.
    let r = patch(DEVICE, json!({ "name": " Laptop ", "readAccess": false })).await;
    assert_eq!((r.status, r.json()), (StatusCode::OK, json!({ "id": DEVICE, "name": "Laptop", "readAccess": false })));
    patch(DEVICE, json!({ "readAccess": true })).await;
    let r = patch(DEVICE, json!({ "name": "Laptop 2" })).await;
    assert_eq!(r.json(), json!({ "id": DEVICE, "name": "Laptop 2", "readAccess": true }));

    // An invalid field changes nothing, even when the other is valid.
    for (body, code) in [
        (json!({}), "invalid_name"),
        (json!({ "name": "" }), "invalid_name"),
        (json!({ "name": "", "readAccess": false }), "invalid_name"),
        (json!({ "name": null }), "invalid_name"),
        (json!({ "readAccess": "false" }), "invalid_body"),
        (json!({ "readAccess": 0 }), "invalid_body"),
        (json!({ "readAccess": null }), "invalid_body"),
        (json!({ "name": "Fine", "readAccess": "no" }), "invalid_body"),
    ] {
        let r = patch(DEVICE, body.clone()).await;
        assert_eq!((r.status, r.json()), (StatusCode::BAD_REQUEST, json!({ "error": code })), "{body}");
    }
    assert_eq!(one(&app.env.store, &format!("SELECT name, read_access FROM devices WHERE id = '{DEVICE}'")), one(&app.env.store, "SELECT 'Laptop 2' AS name, 1 AS read_access"));
    for id in ["nobody", "not%20an%20id"] {
        let r = patch(id, json!({ "readAccess": true })).await;
        assert_eq!((r.status, r.json()), (StatusCode::NOT_FOUND, json!({ "error": "unknown_device" })), "{id}");
    }

    // Turning it off answers the device's agents 403 at once, and turning it on lets them read again.
    let reader = app.reader("reader");
    assert_eq!(app.agent(&reader, "facets").await.status, StatusCode::OK);
    patch("reader", json!({ "readAccess": false })).await;
    let r = app.get_as("/api/agent/v1/facets", Some(&reader)).await;
    assert_eq!((r.status, r.json()), (StatusCode::FORBIDDEN, json!({ "error": "read_access_denied" })));
    patch("reader", json!({ "readAccess": true })).await;
    assert_eq!(app.agent(&reader, "facets").await.status, StatusCode::OK);

    // Revoking the token leaves the switch as it was, on or off.
    patch("reader", json!({ "readAccess": false })).await;
    for (id, access) in [(DEVICE, 1), ("reader", 0)] {
        let r = app.send(Request::delete(format!("/api/v1/devices/{id}")).body(Body::empty()).unwrap()).await;
        assert_eq!(r.status, StatusCode::NO_CONTENT);
        assert_eq!(app.read_access(id), json!(access), "{id}");
    }
}

#[tokio::test]
async fn a_pairing_that_continues_a_device_keeps_its_read_access() {
    let app = App::new(AuthMode::None);
    let token = app.reader("desk");
    let start = |bearer: Option<String>, name: &'static str| {
        let app = &app;
        async move {
            let mut request = Request::post("/api/pair/v1/start").header(header::CONTENT_TYPE, "application/json");
            if let Some(token) = bearer {
                request = request.header(header::AUTHORIZATION, format!("Bearer {token}"));
            }
            let r = app.send(request.body(Body::from(json!({ "device": name }).to_string())).unwrap()).await;
            assert_eq!(r.status, StatusCode::OK, "{}", r.text());
            r.json()
        }
    };
    let pair = |started: Value| {
        let app = &app;
        async move {
            let code = started["code"].as_str().unwrap();
            let r = app.json(Method::POST, &format!("/api/v1/pairings/{code}/approve"), json!({})).await;
            assert_eq!(r.status, StatusCode::OK, "{}", r.text());
            let r = app.json(Method::POST, "/api/pair/v1/poll", json!({ "pairingId": started["pairingId"] })).await;
            assert_eq!(r.json()["status"], "approved", "{}", r.text());
            r.json()
        }
    };

    // Recognized by its token: the device continues, with a new token and its read access.
    let paired = pair(start(Some(token.clone()), "desk").await).await;
    assert_eq!((&paired["device"], &paired["continued"]), (&json!("desk"), &json!(true)));
    assert_eq!(app.read_access("desk"), json!(1));
    let new_token = paired["token"].as_str().unwrap().to_owned();
    assert_eq!(app.get_as("/api/agent/v1/facets", Some(&token)).await.status, StatusCode::UNAUTHORIZED);
    assert_eq!(app.agent(&new_token, "facets").await.status, StatusCode::OK);

    // Turned off, it stays off when the device continues.
    pika::auth::update_device(&app.env.store, "desk", None, Some(false)).unwrap();
    let paired = pair(start(Some(new_token), "desk").await).await;
    assert_eq!((&paired["device"], &paired["continued"]), (&json!("desk"), &json!(true)));
    assert_eq!(app.read_access("desk"), json!(0));
    let r = app.get_as("/api/agent/v1/facets", paired["token"].as_str()).await;
    assert_eq!((r.status, r.json()), (StatusCode::FORBIDDEN, json!({ "error": "read_access_denied" })));

    // A new device starts with it.
    let paired = pair(start(None, "phone").await).await;
    assert_eq!(paired["continued"], json!(false));
    assert_eq!(app.read_access(paired["device"].as_str().unwrap()), json!(1));
    assert_eq!(app.agent(paired["token"].as_str().unwrap(), "facets").await.status, StatusCode::OK);
}

#[tokio::test]
async fn agents_authenticate_with_a_reading_device_token_in_every_auth_mode() {
    for auth in [AuthMode::Password, AuthMode::Proxy, AuthMode::None] {
        let app = world(auth).await;
        let reader = app.reader("reader");
        let mode = auth.as_str();
        for path in ROUTES.map(route) {
            let path = format!("/api/agent/v1/{path}");
            let unauthorized = (StatusCode::UNAUTHORIZED, json!({ "error": "unauthorized" }));
            for token in [None, Some("pika_unknown"), Some("")] {
                let r = app.get_as(&path, token).await;
                assert_eq!((r.status, r.json()), unauthorized.clone(), "{mode} {path} {token:?}");
                assert_eq!(r.headers[header::CACHE_CONTROL], "no-store", "{mode} {path}");
            }
            let r = app.send(Request::get(&path).header(header::AUTHORIZATION, format!("Basic {reader}")).body(Body::empty()).unwrap()).await;
            assert_eq!((r.status, r.json()), unauthorized, "{mode} {path}: Basic");
            // The uploading device's token is valid, but its read access is off.
            let r = app.get_as(&path, Some(&app.token)).await;
            assert_eq!((r.status, r.json()), (StatusCode::FORBIDDEN, json!({ "error": "read_access_denied" })), "{mode} {path}");
            assert_eq!(r.headers[header::CACHE_CONTROL], "no-store", "{mode} {path}");
            let r = app.get_as(&path, Some(&reader)).await;
            assert_eq!(r.status, StatusCode::OK, "{mode} {path}: {}", r.text());
        }
        // Read access turned off by the CLI's path is refused at once, as is a token revoked by it, which leaves the
        // switch alone.
        pika::auth::update_device(&app.env.store, "reader", None, Some(false)).unwrap();
        let r = app.get_as("/api/agent/v1/sessions", Some(&reader)).await;
        assert_eq!((r.status, r.json()), (StatusCode::FORBIDDEN, json!({ "error": "read_access_denied" })), "{mode}");
        pika::auth::update_device(&app.env.store, "reader", None, Some(true)).unwrap();
        assert_eq!(app.get_as("/api/agent/v1/sessions", Some(&reader)).await.status, StatusCode::OK, "{mode}");
        pika::auth::revoke_token(&app.env.store, "reader").unwrap();
        assert_eq!(app.get_as("/api/agent/v1/sessions", Some(&reader)).await.status, StatusCode::UNAUTHORIZED, "{mode}");
        assert_eq!(app.read_access("reader"), json!(1), "{mode}");
    }
}

#[tokio::test]
async fn the_agent_namespace_is_an_allowlist() {
    let app = world(AuthMode::Password).await;
    let reader = app.reader("reader");
    for path in [
        "/api/agent/v1/",
        "/api/agent/v1/statistics",
        "/api/agent/v1/usage",
        "/api/agent/v1/sessions/{id}/updates",
        "/api/agent/v1/sessions/{id}/export",
        "/api/agent/v1/sessions/{id}/entries/1/raw",
        "/api/agent/v1/sessions/{id}/entries/1/image/0",
        "/api/agent/v1/requests/req-1",
        "/api/agent/v1/herder",
        "/api/agent/v1/herder/runs/{run}/events",
        "/api/agent/v1/devices",
        "/api/agent/v1/index.html",
    ] {
        let path = route(path);
        for token in [None, Some(reader.as_str())] {
            let r = app.get_as(&path, token).await;
            assert_eq!((r.status, r.json()), (StatusCode::NOT_FOUND, json!({ "error": "not_found" })), "{path} {token:?}");
            // The namespace's bare root is not routed into it; the server's JSON 404 for API paths answers it.
            let no_store = (path != "/api/agent/v1/").then_some("no-store");
            assert_eq!(r.headers.get(header::CACHE_CONTROL).map(|v| v.to_str().unwrap()), no_store, "{path}");
        }
    }
    let r = app.json(Method::PATCH, &format!("/api/agent/v1/sessions/{SESSION}"), json!({ "hidden": true })).await;
    assert_eq!(r.status, StatusCode::UNAUTHORIZED);

    let health = app.get_as("/api/health", None).await.json();
    assert_eq!(health["features"], json!(["relay", "agent"]));
}

#[tokio::test]
async fn agents_read_unpublished_and_hidden_sessions() {
    let app = world(AuthMode::None).await;
    let reader = app.reader("reader");
    let r = app.json(Method::PATCH, &format!("/api/v1/sessions/{SESSION}"), json!({ "hidden": true })).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    // Nothing is published: the public namespace has none of it.
    assert_eq!(app.get_as(&format!("/api/public/v1/sessions/{SESSION}"), None).await.status, StatusCode::NOT_FOUND);

    let sessions = app.agent(&reader, "sessions").await.json();
    let ids: Vec<&str> = sessions["items"].as_array().unwrap().iter().map(|s| s["id"].as_str().unwrap()).collect();
    assert_eq!(ids, [OTHER, CHILD, SESSION]);
    let facets = app.agent(&reader, "facets").await.json();
    assert_eq!(facets["projects"], json!(["gadgets", "widgets"]));
    // Summaries keep the owner's fields.
    let detail = app.agent(&reader, &format!("sessions/{SESSION}")).await.json();
    assert_eq!((&detail["hidden"], &detail["hiddenBy"], &detail["childCount"]), (&json!(true), &json!(SESSION), &json!(1)));
    assert_eq!(detail["children"][0]["link"]["agentType"], "recon");
    let tree = app.agent(&reader, &format!("sessions/{CHILD}/tree")).await.json();
    assert_eq!((&tree["rootId"], tree["nodes"].as_array().unwrap().len()), (&json!(SESSION), 2));
    assert_eq!(app.agent(&reader, &format!("sessions/{CHILD}/turns")).await.json()["items"][0]["userText"], "Check the zebra pen");
    let trace = app.agent(&reader, &format!("sessions/{SESSION}/trace")).await.json();
    assert_eq!(trace["children"][0]["sessionId"], CHILD);
    let search = app.agent(&reader, "search?q=zebra&group=session").await.json();
    let found: Vec<&str> = search["items"].as_array().unwrap().iter().map(|s| s["sessionId"].as_str().unwrap()).collect();
    assert_eq!(found, [OTHER, SESSION]);

    let r = app.get_as("/api/agent/v1/sessions/nope", Some(&reader)).await;
    assert_eq!((r.status, r.json()), (StatusCode::NOT_FOUND, json!({ "error": "not_found" })));
}

/// Asserts that `agent` is `owner` with only credentials replaced, bar the fields the agent namespace leaves out.
fn assert_only_scrubbed(owner: &Value, agent: &Value, at: &str) {
    match (owner, agent) {
        (Value::Object(o), Value::Object(a)) => {
            for key in a.keys() {
                assert!(o.contains_key(key), "{at}.{key}: only in the agent's");
            }
            for (key, value) in o {
                match a.get(key) {
                    Some(agent) => assert_only_scrubbed(value, agent, &format!("{at}.{key}")),
                    None => assert!(["requestId", "src"].contains(&key.as_str()), "{at}.{key}: missing in the agent's"),
                }
            }
        }
        (Value::Array(o), Value::Array(a)) => {
            assert_eq!(o.len(), a.len(), "{at}: length");
            for (i, (o, a)) in o.iter().zip(a).enumerate() {
                assert_only_scrubbed(o, a, &format!("{at}[{i}]"));
            }
        }
        (Value::String(o), Value::String(a)) if o != a => assert!(a.contains("[REDACTED"), "{at}: {o:?} became {a:?}"),
        _ => assert_eq!(owner, agent, "{at}"),
    }
}

#[tokio::test]
async fn every_agent_route_scrubs_credentials() {
    let app = world(AuthMode::None).await;
    let reader = app.reader("reader");
    for path in ROUTES.map(route).into_iter().chain(["search?q=zebra&group=session".into()]) {
        let owner = app.owner(&path).await;
        let agent = app.agent(&reader, &path).await;
        let body = agent.text();
        for credential in CREDENTIALS {
            assert!(!body.contains(credential), "{path} shows {credential}: {body}");
        }
        if path != "facets" {
            assert!(body.contains("[REDACTED:API_KEY]"), "{path}: {body}");
        }
        if path != "facets" && !path.starts_with("search") {
            assert!(owner.text().contains(GITHUB_TOKEN), "the owner's {path}");
            assert_only_scrubbed(&owner.json(), &agent.json(), &path);
        }
    }

    let detail = app.agent(&reader, &format!("sessions/{SESSION}")).await.json();
    assert_eq!(detail["title"], "Deploy the zebra widgets; my GitHub token is [REDACTED:API_KEY]");
    let turns = app.agent(&reader, &format!("sessions/{SESSION}/turns")).await.json();
    assert_eq!(turns["items"][0]["finalText"], "Deployed. Revoke [REDACTED:API_KEY] later.");
    let trace = app.agent(&reader, &format!("sessions/{SESSION}/trace")).await.json();
    let tool = trace["records"].as_array().unwrap().iter().find(|r| r["kind"] == "tool").unwrap();
    assert_eq!(tool["summary"], "DB_PASSWORD=[REDACTED:SECRET] npm run deploy");

    // Entries: scrubbed, without `requestId`, and images without bytes or a `src`, as there is no agent image route.
    let entries = app.agent(&reader, &format!("sessions/{SESSION}/entries")).await.json();
    let image = &entries["items"][1]["raw"]["message"]["content"][1];
    assert_eq!(image, &json!({ "type": "image", "data": "", "mimeType": "image/png" }));
    let owner = app.owner(&format!("sessions/{SESSION}/entries")).await.json();
    let src = owner["items"][1]["raw"]["message"]["content"][1]["src"].as_str().unwrap();
    assert!(src.starts_with("/api/v1/"), "{src}");
    assert_eq!(entries["items"][3]["raw"]["message"]["content"][0]["text"], "DB_PASSWORD=[REDACTED:SECRET] accepted");
    assert!(entries["items"].as_array().unwrap().iter().all(|e| e.get("requestId").is_none()));

    // A scrubbed trace is gzipped on request and never revalidated.
    let request = Request::get(format!("/api/agent/v1/sessions/{SESSION}/trace"))
        .header(header::AUTHORIZATION, format!("Bearer {reader}"))
        .header(header::ACCEPT_ENCODING, "gzip")
        .header(header::IF_NONE_MATCH, "*")
        .body(Body::empty())
        .unwrap();
    let r = app.send(request).await;
    assert_eq!((r.status, &r.headers[header::CONTENT_ENCODING]), (StatusCode::OK, &header::HeaderValue::from_static("gzip")));
    assert_eq!(r.headers[header::CACHE_CONTROL], "no-store");
    assert!(r.headers.get(header::ETAG).is_none());
    let mut text = String::new();
    std::io::Read::read_to_string(&mut flate2::read::GzDecoder::new(&r.body[..]), &mut text).unwrap();
    assert!(!text.contains(GITHUB_TOKEN) && text.contains("[REDACTED:API_KEY]"), "{text}");
}

/// Herder runs: the owner's list and detail, with the `repo` filter and the orchestrating session, scrubbed as session
/// text; journal events keep Herder's own fields, and only a step's `data` and a launch's `args` are session content.
#[tokio::test]
async fn agents_read_herder_runs_scrubbed() {
    let app = world(AuthMode::None).await;
    let reader = app.reader("reader");
    let runs = app.agent(&reader, "herder/runs").await.json();
    assert_eq!(runs["items"].as_array().unwrap().len(), 1);
    let run = &runs["items"][0];
    assert_eq!((&run["runId"], &run["repo"], &run["sessionId"]), (&json!(RUN), &json!("widgets"), &json!(SESSION)));
    assert_eq!((&run["title"], &run["status"], &run["verdict"]), (&json!("Rotate [REDACTED:API_KEY]"), &json!("delivered"), &json!("met")));
    for (base, token) in [("/api/v1/", None), ("/api/agent/v1/", Some(reader.as_str()))] {
        for (repo, count) in [("widgets", 1), ("gadgets", 0), ("", 1)] {
            let r = app.get_as(&format!("{base}herder/runs?repo={repo}"), token).await;
            assert_eq!(r.json()["items"].as_array().map(Vec::len), Some(count), "{base} {repo}");
        }
    }

    let owner = app.owner(&format!("herder/runs/{RUN}")).await.json();
    let detail = app.agent(&reader, &format!("herder/runs/{RUN}")).await.json();
    assert_only_scrubbed(&owner, &detail, "run");
    assert_eq!(detail["run"]["sessionId"], SESSION);
    assert_eq!(detail["goal"], "# Goal\nRevoke [REDACTED:API_KEY].");
    assert_eq!(detail["plan"], "# Plan\n- T1: replace [REDACTED:API_KEY]");
    let event = |t: &str| detail["events"].as_array().unwrap().iter().find(|e| e["t"] == t).unwrap()["data"].clone();
    assert_eq!(event("goal.approved")["checks"][0]["command"], "DB_PASSWORD=[REDACTED:SECRET] npm test");
    assert_eq!(event("script.launched")["args"], json!({ "api_key": "[REDACTED]" }));
    let completed = event("step.completed");
    assert_eq!((&completed["key"], &completed["commit"]), (&json!("impl-T1"), &json!("c0ffee1234")));
    assert_eq!((&completed["text"], &completed["data"]), (&json!("Rotated [REDACTED:API_KEY]."), &json!({ "token": "[REDACTED]", "files": 2 })));
    assert_eq!(event("check.completed")["tail"], "DB_PASSWORD=[REDACTED:SECRET] ok");
    let step = &detail["steps"][0];
    assert_eq!((&step["key"], &step["status"], &step["commit"], &step["sessionId"]), (&json!("impl-T1"), &json!("ok"), &json!("c0ffee1234"), &json!(CHILD)));
    let body = serde_json::to_string(&detail).unwrap();
    for secret in [GITHUB_TOKEN, ENV_SECRET, LINK_TOKEN, "FAKEargsKey0042"] {
        assert!(!body.contains(secret), "the run shows {secret}: {body}");
    }

    let r = app.get_as("/api/agent/v1/herder/runs/nope", Some(&reader)).await;
    assert_eq!((r.status, r.json()), (StatusCode::NOT_FOUND, json!({ "error": "not_found" })));
    // The public namespace has no runs.
    for path in ["/api/public/v1/herder/runs".to_owned(), format!("/api/public/v1/herder/runs/{RUN}")] {
        assert_eq!(app.get_as(&path, None).await.status, StatusCode::NOT_FOUND, "{path}");
    }
}

/// A summary's `link`, the whole session-link entry, is session content: scrubbed in the sessions list, a session's
/// detail and children, and its tree, with the secret-name rule and cross-field replacement.
#[tokio::test]
async fn session_links_are_scrubbed_as_session_content() {
    let app = world(AuthMode::None).await;
    let reader = app.reader("reader");
    let scrubbed = json!({ "kind": "subagent", "parentSessionId": SESSION, "parentToolCallId": "call_1", "agentType": "recon",
                           "description": "Check the zebra with DB_PASSWORD=[REDACTED:SECRET]",
                           "ticket": { "title": "Rotate [REDACTED:SECRET]", "branch": "fix/zebra", "token": "[REDACTED]" } });
    let links = [
        ("sessions".to_owned(), "/items/1/link"),
        (format!("sessions/{SESSION}"), "/children/0/link"),
        (format!("sessions/{CHILD}"), "/link"),
        (format!("sessions/{SESSION}/tree"), "/nodes/1/link"),
        (format!("sessions/{CHILD}/tree"), "/nodes/1/link"),
    ];
    for (path, pointer) in links {
        let owner = app.owner(&path).await;
        assert!(owner.text().contains(LINK_SECRET) && owner.text().contains(LINK_TOKEN), "the owner's {path}");
        assert_eq!(owner.json().pointer(pointer).unwrap()["ticket"]["token"], LINK_TOKEN, "the owner's {path}");
        let agent = app.agent(&reader, &path).await;
        let body = agent.text();
        assert!(!body.contains(LINK_SECRET) && !body.contains(LINK_TOKEN), "{path} shows the link's credentials: {body}");
        assert_eq!(agent.json().pointer(pointer), Some(&scrubbed), "{path}");
        assert_only_scrubbed(&owner.json(), &agent.json(), &path);
    }
}

/// Until the search index's text is scrubbed under the current rules, agent search finds nothing, in either grouping,
/// as public search does; the owner's search still answers.
#[tokio::test]
async fn agent_search_waits_for_the_index_to_be_rescrubbed() {
    let app = world(AuthMode::None).await;
    let reader = app.reader("reader");
    let stale = (pika::redact::RULES_VERSION - 1).to_string().into_bytes();
    let set = rusqlite::params![pika::store::SEARCH_RULES, stale];
    app.env.store.write(|tx| tx.execute("INSERT OR REPLACE INTO settings (key, value) VALUES (?1, ?2)", set)).unwrap();
    assert!(!app.env.store.read(pika::store::search_rules_current).unwrap());
    for query in ["", "&group=session", "&sort=relevance", "&group=session&sort=relevance", "&prefix=true"] {
        let path = format!("search?q=zebra{query}");
        assert_eq!(app.agent(&reader, &path).await.json()["items"], json!([]), "{path}");
        assert!(!app.owner(&path).await.json()["items"].as_array().unwrap().is_empty(), "the owner's {path}");
    }
}

/// `GET search` with `group=session` in a namespace: each session's id, project, and lastAt.
async fn grouped(app: &App, base: &str, token: Option<&str>, query: &str) -> Vec<(String, Value, Value)> {
    let r = app.get_as(&format!("{base}search?q=zebra&group=session{query}"), token).await;
    assert_eq!(r.status, StatusCode::OK, "{base} {query}: {}", r.text());
    r.json()["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| (s["sessionId"].as_str().unwrap().to_owned(), s["project"].clone(), s["lastAt"].clone()))
        .collect()
}

#[tokio::test]
async fn grouped_search_names_projects_and_excludes_a_family() {
    let app = world(AuthMode::None).await;
    let reader = app.reader("reader");
    // The root's lastAt, not its child's, whose matches it counts.
    let widgets = (SESSION.to_owned(), json!("widgets"), json!("2026-10-20T09:00:05.000Z"));
    let gadgets = (OTHER.to_owned(), json!("gadgets"), json!("2026-10-21T09:00:02.000Z"));
    let token = Some(reader.as_str());
    for (base, token) in [("/api/v1/", None), ("/api/agent/v1/", token)] {
        assert_eq!(grouped(&app, base, token, "").await, [gadgets.clone(), widgets.clone()], "{base}");
        assert_eq!(grouped(&app, base, token, "&sort=relevance").await.len(), 2, "{base}");
        // A session, or its child, excludes the whole family; an unknown id excludes nothing.
        for exclude in [SESSION, CHILD] {
            assert_eq!(grouped(&app, base, token, &format!("&exclude={exclude}")).await, vec![gadgets.clone()], "{base} {exclude}");
        }
        assert_eq!(grouped(&app, base, token, &format!("&exclude={OTHER}&sort=relevance")).await, vec![widgets.clone()], "{base}");
        assert_eq!(grouped(&app, base, token, "&exclude=nope").await.len(), 2, "{base}");
        // Exclusion comes before the limit.
        assert_eq!(grouped(&app, base, token, &format!("&exclude={OTHER}&limit=1")).await, vec![widgets.clone()], "{base}");
        for query in [format!("&group=entry&exclude={SESSION}"), format!("&exclude={SESSION}")] {
            let r = app.get_as(&format!("{base}search?q=zebra{query}"), token).await;
            assert_eq!((r.status, &r.json()["error"]), (StatusCode::BAD_REQUEST, &json!("bad_request")), "{base}{query}");
        }
        // Without `group=session` the bad grouping wins over the missing one; `exclude=` is no parameter.
        assert_eq!(app.get_as(&format!("{base}search?q=zebra&exclude="), token).await.status, StatusCode::OK, "{base}");
    }

    // In public, the family is walked through published sessions, and an unpublished id excludes nothing.
    let publish = |project: &str| app.json(Method::PATCH, "/api/v1/settings/publishing", json!({ "project": project, "published": true }));
    publish("widgets").await;
    assert_eq!(grouped(&app, "/api/public/v1/", None, "").await, vec![widgets.clone()]);
    assert_eq!(grouped(&app, "/api/public/v1/", None, &format!("&exclude={CHILD}")).await, []);
    assert_eq!(grouped(&app, "/api/public/v1/", None, &format!("&exclude={OTHER}")).await, vec![widgets.clone()]);
    let r = app.get_as(&format!("/api/public/v1/search?q=zebra&exclude={SESSION}"), None).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn a_session_without_a_project_has_no_project_in_search() {
    let app = App::new(AuthMode::None);
    let id = "a9e47000-0000-4000-8000-0000000000f0";
    app.upload(id, &lines(&[
        json!({ "type": "session", "version": 3, "id": id, "timestamp": "2026-10-20T09:00:00.000Z" }),
        message("u1", None, "2026-10-20T09:00:01.000Z", json!({ "role": "user", "content": "find the zebra", "timestamp": 1792486801000_i64 })),
    ]))
    .await;
    let found = grouped(&app, "/api/v1/", None, "").await;
    assert_eq!(found, [(id.to_owned(), Value::Null, json!("2026-10-20T09:00:01.000Z"))]);
}

fn pika(data: &std::path::Path) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_pika"));
    for (key, _) in std::env::vars_os() {
        if key.to_string_lossy().starts_with("PIKA_") {
            command.env_remove(key);
        }
    }
    command.arg("--data-dir").arg(data).env("PIKA_PRICES", "off");
    command
}

/// Runs `pika token ...`; returns its exit success, stdout, and stderr.
fn token_cli(data: &std::path::Path, args: &[&str]) -> (bool, String, String) {
    let out = pika(data).arg("token").args(args).output().unwrap();
    (out.status.success(), String::from_utf8(out.stdout).unwrap(), String::from_utf8(out.stderr).unwrap())
}

#[test]
fn the_token_cli_switches_and_lists_read_access() {
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");
    let (ok, _, created) = token_cli(&data, &["create", "Reader"]);
    assert!(ok, "{created}");
    let reader = created.split(' ').nth(2).unwrap().to_owned();
    let (ok, _, created) = token_cli(&data, &["create", "Plain", "--no-read-access"]);
    assert!(ok, "{created}");
    let plain = created.split(' ').nth(2).unwrap().to_owned();

    let columns = |listing: &str| -> Vec<(String, String)> {
        listing
            .lines()
            .map(|l| {
                let fields: Vec<&str> = l.split('\t').collect();
                assert_eq!(fields.len(), 7, "{l}");
                (fields[1].to_owned(), fields[6].to_owned())
            })
            .collect()
    };
    let (_, listing, _) = token_cli(&data, &["list"]);
    assert_eq!(columns(&listing), [("Plain".into(), "-".into()), ("Reader".into(), "read".into())]);

    let (ok, _, said) = token_cli(&data, &["read-access", "Plain", "on"]);
    assert_eq!((ok, said), (true, format!("read access on for Plain ({plain})\n")));
    let (ok, _, said) = token_cli(&data, &["read-access", &reader, "off"]);
    assert_eq!((ok, said), (true, format!("read access off for Reader ({reader})\n")));
    let (_, listing, _) = token_cli(&data, &["list"]);
    assert_eq!(columns(&listing), [("Plain".into(), "read".into()), ("Reader".into(), "-".into())]);

    let (ok, _, error) = token_cli(&data, &["read-access", "nobody", "on"]);
    assert_eq!((ok, error.as_str()), (false, "pika: no device \"nobody\"\n"));
    let (ok, _, error) = token_cli(&data, &["read-access", "Plain", "maybe"]);
    assert!(!ok && error.contains("invalid value 'maybe'"), "{error}");
    token_cli(&data, &["create", "Plain"]);
    let (ok, _, error) = token_cli(&data, &["read-access", "Plain", "off"]);
    assert!(!ok && error.ends_with("; read-access by id\n"), "{error}");
    let (ok, _, error) = token_cli(&data, &["create", "Old", "--read-access"]);
    assert!(!ok && error.contains("--read-access"), "{error}");

    // Revoking leaves the switch as it was, on or off; the device keeps its row.
    for id in [&plain, &reader] {
        let (ok, _, _) = token_cli(&data, &["revoke", id]);
        assert!(ok);
    }
    let store = pika::store::Store::open(&data).unwrap();
    let access = |id: &str| one(&store, &format!("SELECT read_access FROM devices WHERE id = '{id}'"))["read_access"].clone();
    assert_eq!((access(&plain), access(&reader)), (json!(1), json!(0)));
}
