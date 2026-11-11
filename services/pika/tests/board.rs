mod common;

use axum::Router;
use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use common::*;
use pika::config::{AuthMode, ServerConfig};
use pika::http::{AppState, router};
use pika::ingest::Batch;
use pika::store::Store;
use serde_json::{Value, json};
use tower::ServiceExt;

const OTHER: &str = "desktop";
const PASSWORD: &str = "correct horse battery";
const COORDINATOR: &str = "coord-1";

struct App {
    env: Env,
    app: Router,
    laptop: String,
    desktop: String,
}

fn app_with(configure: impl FnOnce(&mut ServerConfig)) -> App {
    let env = env();
    let laptop = common::device(&env.store, DEVICE);
    let desktop = common::device(&env.store, OTHER);
    let mut config = ServerConfig::new(env.dir.path().join("data"));
    config.auth = AuthMode::Password;
    config.password = Some(PASSWORD.into());
    configure(&mut config);
    let app = router(AppState::new(env.store.clone(), config).unwrap());
    App { env, app, laptop, desktop }
}

fn app() -> App {
    app_with(|_| {})
}

/// Records session `id` for `device`, named `name`, as an upload would.
fn record(store: &Store, id: &str, device: &str, name: &str) {
    let lines = [
        json!({ "type": "session", "version": 3, "id": id, "timestamp": "2026-10-20T09:00:00.000Z",
            "cwd": "/home/me/code/widgets" })
        .to_string(),
        json!({ "type": "session_info", "id": "i1", "parentId": null, "timestamp": "2026-10-20T09:00:01.000Z",
            "name": name })
        .to_string(),
    ];
    let batch: Batch =
        serde_json::from_value(json!({ "streams": [stream(&format!("session:{id}"), "session", 0, &lines)] }))
            .unwrap();
    pika::ingest::apply(store, device, &batch).unwrap();
}

struct Reply {
    status: StatusCode,
    body: Value,
}

async fn send(app: &Router, request: Request<Body>) -> Reply {
    let response = app.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap();
    Reply { status, body: serde_json::from_slice(&bytes).unwrap_or(Value::Null) }
}

fn request(method: Method, path: &str, token: Option<&str>, cookie: Option<&str>, body: Option<String>) -> Request<Body> {
    let mut request = Request::builder().method(method).uri(path);
    if let Some(token) = token {
        request = request.header("authorization", format!("Bearer {token}"));
    }
    if let Some(cookie) = cookie {
        request = request.header("cookie", cookie);
    }
    match body {
        Some(body) => request.header("content-type", "application/json").body(Body::from(body)).unwrap(),
        None => request.body(Body::empty()).unwrap(),
    }
}

async fn put_board(app: &Router, token: &str, session: &str, body: &Value) -> Reply {
    put_raw(app, token, session, body.to_string()).await
}

async fn put_raw(app: &Router, token: &str, session: &str, body: String) -> Reply {
    send(app, request(Method::PUT, &format!("/api/relay/v1/boards/{session}"), Some(token), None, Some(body))).await
}

async fn browser_get(app: &Router, path: &str, cookie: &str) -> Reply {
    send(app, request(Method::GET, &format!("/api/v1/{path}"), None, Some(cookie), None)).await
}

async fn login(app: &Router) -> String {
    let body = json!({ "password": PASSWORD }).to_string();
    let response = app.clone().oneshot(request(Method::POST, "/api/v1/login", None, None, Some(body))).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let cookie = response.headers().get("set-cookie").unwrap().to_str().unwrap();
    cookie.split(';').next().unwrap().to_owned()
}

fn card(id: &str, status: &str) -> Value {
    json!({ "id": id, "title": format!("task {id}"), "status": status, "agentId": "a-1", "agent": "worker",
        "note": "halfway", "createdBy": "coordinator", "updatedBy": "a-1",
        "createdAt": 1_790_000_000_000_i64, "updatedAt": 1_790_000_060_000_i64, "extra": "dropped" })
}

fn snapshot(session: &str, updated_at: i64, cards: Vec<Value>) -> Value {
    json!({ "version": 1, "sessionId": session, "updatedAt": updated_at, "cards": cards, "members": [] })
}

#[tokio::test]
async fn the_owning_device_uploads_a_board_and_the_browser_reads_it() {
    let a = app();
    record(&a.env.store, COORDINATOR, DEVICE, "coordinator");
    let r = put_board(&a.app, &a.laptop, COORDINATOR, &snapshot(COORDINATOR, 1_790_000_100_000, vec![
        card("c1", "todo"),
        card("c2", "doing"),
    ]))
    .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert_eq!(r.body, json!({ "sessionId": COORDINATOR, "status": "stored", "updatedAt": "2026-09-21T14:15:00.000Z" }));

    let cookie = login(&a.app).await;
    let r = browser_get(&a.app, &format!("relay/boards/{COORDINATOR}"), &cookie).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert_eq!(r.body["sessionId"], COORDINATOR);
    assert_eq!((&r.body["device"], &r.body["deviceName"], &r.body["name"]), (&json!(DEVICE), &json!(DEVICE), &json!("coordinator")));
    assert_eq!(r.body["updatedAt"], "2026-09-21T14:15:00.000Z");
    assert!(r.body["receivedAt"].is_string());
    assert_eq!(r.body["cards"][0], json!({ "id": "c1", "title": "task c1", "status": "todo", "agentId": "a-1",
        "agent": "worker", "note": "halfway", "createdBy": "coordinator", "updatedBy": "a-1",
        "createdAt": "2026-09-21T14:13:20.000Z", "updatedAt": "2026-09-21T14:14:20.000Z" }));
    assert_eq!(r.body["cards"][1]["status"], "doing");

    let r = browser_get(&a.app, "relay/boards/nobody", &cookie).await;
    assert_eq!((r.status, r.body), (StatusCode::NOT_FOUND, json!({ "error": "not_found" })));
}

#[tokio::test]
async fn an_older_snapshot_is_ignored() {
    let a = app();
    record(&a.env.store, COORDINATOR, DEVICE, "coordinator");
    let newer = snapshot(COORDINATOR, 2_000, vec![card("c1", "done")]);
    assert_eq!(put_board(&a.app, &a.laptop, COORDINATOR, &newer).await.body["status"], "stored");
    let older = snapshot(COORDINATOR, 1_000, vec![card("c1", "todo")]);
    let r = put_board(&a.app, &a.laptop, COORDINATOR, &older).await;
    assert_eq!((r.status, &r.body["status"], &r.body["updatedAt"]), (StatusCode::OK, &json!("stale"), &json!("1970-01-01T00:00:02.000Z")));
    let row = one(&a.env.store, "SELECT updated_at, cards_json FROM relay_boards");
    assert_eq!(row["updated_at"], json!(2_000));
    assert!(row["cards_json"].as_str().unwrap().contains("\"done\""));
    // The same time replaces it, so a retried upload of the latest snapshot is harmless.
    let same = snapshot(COORDINATOR, 2_000, vec![card("c1", "failed")]);
    assert_eq!(put_board(&a.app, &a.laptop, COORDINATOR, &same).await.body["status"], "stored");
}

#[tokio::test]
async fn only_the_sessions_device_may_upload() {
    let a = app();
    record(&a.env.store, COORDINATOR, DEVICE, "coordinator");
    let body = snapshot(COORDINATOR, 1_000, vec![]);
    let r = put_board(&a.app, &a.desktop, COORDINATOR, &body).await;
    assert_eq!((r.status, r.body), (StatusCode::FORBIDDEN, json!({ "error": "not_owner" })));
    let r = put_board(&a.app, &a.laptop, "nobody", &snapshot("nobody", 1_000, vec![])).await;
    assert_eq!((r.status, r.body), (StatusCode::BAD_REQUEST, json!({ "error": "unknown_session" })));
    let r = put_board(&a.app, "pika_wrong", COORDINATOR, &body).await;
    assert_eq!((r.status, r.body), (StatusCode::UNAUTHORIZED, json!({ "error": "unauthorized" })));
    assert!(query(&a.env.store, "SELECT * FROM relay_boards").is_empty());
}

#[tokio::test]
async fn uploads_are_validated_and_capped() {
    let a = app();
    record(&a.env.store, COORDINATOR, DEVICE, "coordinator");
    let invalid = |r: &Reply| r.status == StatusCode::BAD_REQUEST && r.body["error"] == "invalid";
    let mut unknown = card("c1", "todo");
    unknown["status"] = json!("someday");
    let mut no_title = card("c1", "todo");
    no_title.as_object_mut().unwrap().remove("title");
    let mut bad_time = card("c1", "todo");
    bad_time["updatedAt"] = json!("yesterday");
    for body in [
        snapshot(COORDINATOR, 1, vec![unknown]),
        snapshot(COORDINATOR, 1, vec![no_title]),
        snapshot(COORDINATOR, 1, vec![bad_time]),
        snapshot(COORDINATOR, 1, vec![card("c1", "todo"), card("c1", "done")]),
        snapshot("someone-else", 1, vec![]),
        json!({ "version": 2, "sessionId": COORDINATOR, "updatedAt": 1, "cards": [] }),
        json!({ "version": 1, "sessionId": COORDINATOR, "updatedAt": -1, "cards": [] }),
        json!({ "version": 1, "sessionId": COORDINATOR, "updatedAt": 1 }),
        json!([]),
    ] {
        let r = put_board(&a.app, &a.laptop, COORDINATOR, &body).await;
        assert!(invalid(&r), "{body} → {} {}", r.status, r.body);
        assert!(r.body["message"].is_string());
    }
    assert!(invalid(&put_raw(&a.app, &a.laptop, COORDINATOR, "{".into()).await));

    let many: Vec<Value> = (0..201).map(|i| json!({ "id": format!("{i}"), "title": "", "status": "todo",
        "createdBy": "c", "updatedBy": "c", "createdAt": 1, "updatedAt": 1 })).collect();
    let r = put_board(&a.app, &a.laptop, COORDINATOR, &snapshot(COORDINATOR, 1, many)).await;
    assert_eq!((r.status, &r.body["error"]), (StatusCode::PAYLOAD_TOO_LARGE, &json!("too_large")));
    let mut big = card("c1", "todo");
    big["note"] = json!("x".repeat(65 * 1024));
    let r = put_board(&a.app, &a.laptop, COORDINATOR, &snapshot(COORDINATOR, 1, vec![big])).await;
    assert_eq!((r.status, &r.body["error"]), (StatusCode::PAYLOAD_TOO_LARGE, &json!("too_large")));
    assert!(query(&a.env.store, "SELECT * FROM relay_boards").is_empty());

    // 200 cards fit.
    let full: Vec<Value> = (0..200).map(|i| json!({ "id": format!("{i}"), "title": "t", "status": "blocked",
        "createdBy": "c", "updatedBy": "c", "createdAt": 1, "updatedAt": 1 })).collect();
    let r = put_board(&a.app, &a.laptop, COORDINATOR, &snapshot(COORDINATOR, 1, full)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
}

#[tokio::test]
async fn a_room_lists_the_boards_of_its_members() {
    let a = app();
    record(&a.env.store, COORDINATOR, DEVICE, "coordinator");
    record(&a.env.store, "coord-2", OTHER, "second");
    record(&a.env.store, "plain", DEVICE, "no board");
    record(&a.env.store, "outsider", DEVICE, "not a member");
    let cookie = login(&a.app).await;
    let room = json!({ "name": "swarm", "members": [COORDINATOR, "plain", "coord-2"] }).to_string();
    let r = send(&a.app, request(Method::POST, "/api/v1/relay/rooms", None, Some(&cookie), Some(room))).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    for (token, session) in [(&a.laptop, COORDINATOR), (&a.desktop, "coord-2"), (&a.laptop, "outsider")] {
        let r = put_board(&a.app, token, session, &snapshot(session, 5_000, vec![card("c1", "doing")])).await;
        assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    }

    let r = browser_get(&a.app, "relay/rooms/swarm/boards", &cookie).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert_eq!(r.body["room"], "swarm");
    let items = r.body["items"].as_array().unwrap();
    let sessions: Vec<_> = items.iter().map(|b| (b["sessionId"].as_str().unwrap(), b["name"].as_str().unwrap(),
        b["deviceName"].as_str().unwrap(), b["online"].as_bool().unwrap())).collect();
    assert_eq!(sessions, [(COORDINATOR, "coordinator", DEVICE, false), ("coord-2", "second", OTHER, false)]);
    assert_eq!(items[0]["cards"][0]["title"], "task c1");

    let r = browser_get(&a.app, "relay/rooms/nowhere/boards", &cookie).await;
    assert_eq!((r.status, r.body), (StatusCode::NOT_FOUND, json!({ "error": "not_found" })));
}

#[tokio::test]
async fn browser_board_routes_need_login_and_relay() {
    let a = app();
    for path in ["/api/v1/relay/boards/x", "/api/v1/relay/rooms/swarm/boards"] {
        let r = send(&a.app, request(Method::GET, path, None, None, None)).await;
        assert_eq!(r.status, StatusCode::UNAUTHORIZED, "{path}");
    }
    let a = app_with(|c| c.relay.enabled = false);
    let disabled = json!({ "error": "relay_disabled" });
    let r = put_board(&a.app, &a.laptop, COORDINATOR, &snapshot(COORDINATOR, 1, vec![])).await;
    assert_eq!((r.status, &r.body), (StatusCode::NOT_FOUND, &disabled));
    let r = send(&a.app, request(Method::GET, "/api/v1/relay/boards/x", None, None, None)).await;
    assert_eq!((r.status, &r.body), (StatusCode::NOT_FOUND, &disabled));
}

#[tokio::test]
async fn deleting_a_session_deletes_its_board() {
    let a = app();
    record(&a.env.store, COORDINATOR, DEVICE, "coordinator");
    put_board(&a.app, &a.laptop, COORDINATOR, &snapshot(COORDINATOR, 1, vec![card("c1", "todo")])).await;
    assert_eq!(query(&a.env.store, "SELECT * FROM relay_boards").len(), 1);
    let cookie = login(&a.app).await;
    let r = send(&a.app, request(Method::DELETE, &format!("/api/v1/sessions/{COORDINATOR}"), None, Some(&cookie), None)).await;
    assert!(r.status.is_success(), "{} {}", r.status, r.body);
    assert!(query(&a.env.store, "SELECT * FROM relay_boards").is_empty());
}

#[test]
fn schema_v20_adds_relay_boards_without_a_reindex() {
    let env = env();
    let data = env.dir.path().join("data");
    let conn = rusqlite::Connection::open(data.join("pika.db")).unwrap();
    conn.execute_batch(&format!("{UNDO_V20} PRAGMA user_version = 19;")).unwrap();
    drop(conn);
    let store = Store::open(&data).unwrap();
    assert_eq!(one(&store, "PRAGMA user_version")["user_version"], 20);
    assert_eq!(store.setting(pika::store::NEEDS_REINDEX).unwrap(), None);
    assert!(query(&store, "SELECT * FROM relay_boards").is_empty());
}
