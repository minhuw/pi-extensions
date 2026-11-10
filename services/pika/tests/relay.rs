mod common;

use std::io::{BufRead, BufReader, Read, Write};
use std::net::SocketAddr;
use std::process::{Command, Stdio};
use std::time::Duration;

use axum::Router;
use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use common::*;
use futures_util::{SinkExt, StreamExt};
use pika::config::{AuthMode, ServerConfig};
use pika::http::{AppState, router};
use pika::ingest::Batch;
use pika::store::Store;
use serde_json::{Value, json};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::{self, Message};
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};
use tower::ServiceExt;

const OTHER: &str = "desktop";
const PASSWORD: &str = "correct horse battery";
const WAIT: Duration = Duration::from_secs(5);

struct Server {
    env: Env,
    state: AppState,
    app: Router,
    addr: SocketAddr,
    base: String,
    laptop: String,
    desktop: String,
    serve_task: tokio::task::JoinHandle<()>,
}

async fn start_on(
    env: Env,
    laptop: String,
    desktop: String,
    configure: impl FnOnce(&mut ServerConfig),
) -> Server {
    let mut config = ServerConfig::new(env.dir.path().join("data"));
    config.auth = AuthMode::None;
    configure(&mut config);
    let base = config.prefix().to_owned();
    let state = AppState::new(env.store.clone(), config).unwrap();
    let app = router(state.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let served = app.clone().into_make_service_with_connect_info::<SocketAddr>();
    let serve_task = tokio::spawn(async move { axum::serve(listener, served).await.unwrap() });
    Server { env, state, app, addr, base, laptop, desktop, serve_task }
}

/// A served router with tokens for `laptop` and `desktop`, `PIKA_AUTH=none` unless `configure` says otherwise.
async fn server_with(configure: impl FnOnce(&mut ServerConfig)) -> Server {
    let env = env();
    let laptop = common::device(&env.store, DEVICE);
    let desktop = common::device(&env.store, OTHER);
    start_on(env, laptop, desktop, configure).await
}

impl Server {
    /// Stops this server, drops `AppState` and `Store` (so `Drop for Relay` flushes and joins the writer thread),
    /// reopens `Store` from disk, and starts a fresh `AppState` and listener.
    async fn restart(self, configure: impl FnOnce(&mut ServerConfig)) -> Server {
        let Server { env, state, app, laptop, desktop, serve_task, .. } = self;
        state.relay.close_all(pika::relay::close::GOING_AWAY, "server stopping");
        let _ = state.relay.drained(Duration::from_secs(2)).await;
        serve_task.abort();
        let _ = serve_task.await;
        drop(app);
        drop(state);
        let Env { dir, store } = env;
        drop(store);
        let store = Store::open(dir.path().join("data")).unwrap();
        start_on(Env { dir, store }, laptop, desktop, configure).await
    }
}

async fn server() -> Server {
    server_with(|_| {}).await
}

/// Records session `id` for `device` in pika's sessions table, as an upload would.
fn record(store: &Store, id: &str, device: &str) {
    let line = json!({ "type": "session", "version": 3, "id": id, "timestamp": "2026-10-20T09:00:00.000Z",
        "cwd": "/home/me/code/widgets" })
    .to_string();
    let batch: Batch =
        serde_json::from_value(json!({ "streams": [stream(&format!("session:{id}"), "session", 0, &[line])] }))
            .unwrap();
    pika::ingest::apply(store, device, &batch).unwrap();
}

struct Reply {
    status: StatusCode,
    body: Vec<u8>,
}

impl Reply {
    fn json(&self) -> Value {
        serde_json::from_slice(&self.body)
            .unwrap_or_else(|_| panic!("not JSON: {}", String::from_utf8_lossy(&self.body)))
    }
}

async fn http(app: &Router, request: Request<Body>) -> Reply {
    let response = app.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let body = axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap().to_vec();
    Reply { status, body }
}

fn get(path: &str, token: Option<&str>, cookie: Option<&str>) -> Request<Body> {
    let mut request = Request::get(path);
    if let Some(token) = token {
        request = request.header("authorization", format!("Bearer {token}"));
    }
    if let Some(cookie) = cookie {
        request = request.header("cookie", cookie);
    }
    request.body(Body::empty()).unwrap()
}

fn post(path: &str, body: Value, cookie: Option<&str>) -> Request<Body> {
    with_body(Method::POST, path, body, cookie)
}

fn patch(path: &str, body: Value, cookie: Option<&str>) -> Request<Body> {
    with_body(Method::PATCH, path, body, cookie)
}

fn with_body(method: Method, path: &str, body: Value, cookie: Option<&str>) -> Request<Body> {
    let mut request = Request::builder().method(method).uri(path).header("content-type", "application/json");
    if let Some(cookie) = cookie {
        request = request.header("cookie", cookie);
    }
    request.body(Body::from(body.to_string())).unwrap()
}

/// The device route's list of online sessions.
async fn sessions(s: &Server) -> Vec<Value> {
    let r = http(&s.app, get(&format!("{}/api/relay/v1/sessions", s.base), Some(&s.desktop), None)).await;
    assert_eq!(r.status, StatusCode::OK);
    r.json()["items"].as_array().unwrap().clone()
}

fn ids(items: &[Value]) -> Vec<&str> {
    items.iter().map(|i| i["id"].as_str().unwrap()).collect()
}

/// Polls the session list until `check` holds.
async fn sessions_until(s: &Server, check: impl Fn(&[Value]) -> bool) -> Vec<Value> {
    let deadline = tokio::time::Instant::now() + WAIT;
    loop {
        let items = sessions(s).await;
        if check(&items) {
            return items;
        }
        assert!(tokio::time::Instant::now() < deadline, "the session list never matched: {items:?}");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

async fn events(s: &Server, query: &str) -> Vec<Value> {
    let r = http(&s.app, get(&format!("{}/api/v1/relay/events{query}", s.base), None, None)).await;
    assert_eq!(r.status, StatusCode::OK);
    r.json()["items"].as_array().unwrap().clone()
}

type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;

async fn open(s: &Server, token: Option<&str>) -> Result<Socket, tungstenite::Error> {
    let mut request = format!("ws://{}{}/api/relay/v1/connect", s.addr, s.base).into_client_request().unwrap();
    if let Some(token) = token {
        request.headers_mut().insert("authorization", format!("Bearer {token}").parse().unwrap());
    }
    tokio_tungstenite::connect_async(request).await.map(|(ws, _)| ws)
}

/// The status and JSON body of a refused upgrade.
async fn refused(s: &Server, token: Option<&str>) -> (u16, Value) {
    match open(s, token).await {
        Err(tungstenite::Error::Http(response)) => {
            let body = serde_json::from_slice(response.body().as_deref().unwrap_or_default()).unwrap();
            (response.status().as_u16(), body)
        }
        other => panic!("expected a refused upgrade, got {other:?}"),
    }
}

fn hello(id: &str) -> Value {
    json!({ "type": "hello", "session": {
        "id": id, "name": format!("name-{id}"), "cwd": "/home/me/code/widgets", "project": "widgets",
        "host": "laptop.local", "model": "faux/model", "state": "idle", "piVersion": "1.4.0", "relayVersion": "0.1.0",
    } })
}

fn send(client_id: &str, to: &str, text: &str) -> Value {
    json!({ "type": "send", "clientId": client_id, "to": to, "text": text, "hops": 1 })
}

struct Client {
    ws: Socket,
}

impl Client {
    async fn connect(s: &Server, token: &str) -> Client {
        Client { ws: open(s, Some(token)).await.unwrap() }
    }

    /// Connects, says `hello` as session `id`, and returns the client and its `welcome`.
    async fn online(s: &Server, token: &str, id: &str) -> (Client, Value) {
        let mut client = Client::connect(s, token).await;
        client.send(hello(id)).await;
        let welcome = client.next().await;
        assert_eq!(welcome["type"], "welcome", "{welcome}");
        (client, welcome)
    }

    async fn send(&mut self, frame: Value) {
        self.ws.send(Message::text(frame.to_string())).await.unwrap();
    }

    async fn raw(&mut self, message: Message) {
        self.ws.send(message).await.unwrap();
    }

    /// The next JSON frame, `ping` included.
    async fn next_any(&mut self) -> Value {
        loop {
            match tokio::time::timeout(WAIT, self.ws.next()).await.expect("no frame in time") {
                Some(Ok(Message::Text(text))) => return serde_json::from_str(text.as_str()).unwrap(),
                Some(Ok(Message::Close(frame))) => panic!("closed: {frame:?}"),
                Some(Ok(_)) => {}
                other => panic!("connection ended: {other:?}"),
            }
        }
    }

    /// The next JSON frame other than `ping`.
    async fn next(&mut self) -> Value {
        loop {
            let frame = self.next_any().await;
            if frame["type"] != "ping" {
                return frame;
            }
        }
    }

    /// Sends and returns the `sent` answer.
    async fn relay(&mut self, frame: Value) -> Value {
        self.send(frame).await;
        let sent = self.next().await;
        assert_eq!(sent["type"], "sent", "{sent}");
        sent
    }

    /// Reads until the server closes and returns the close code.
    async fn closed(&mut self) -> u16 {
        loop {
            match tokio::time::timeout(WAIT, self.ws.next()).await.expect("not closed in time") {
                Some(Ok(Message::Close(Some(frame)))) => return frame.code.into(),
                Some(Ok(Message::Close(None))) => panic!("closed without a code"),
                Some(Ok(_)) => {}
                other => panic!("connection ended without a close frame: {other:?}"),
            }
        }
    }
}

#[tokio::test]
async fn connecting_needs_a_live_device_token() {
    let s = server().await;
    let unauthorized = (401, json!({ "error": "unauthorized" }));
    assert_eq!(refused(&s, None).await, unauthorized);
    assert_eq!(refused(&s, Some("pika_unknown")).await, unauthorized);
    pika::auth::revoke_token(&s.env.store, OTHER).unwrap();
    assert_eq!(refused(&s, Some(&s.desktop)).await, unauthorized);

    let list = http(&s.app, get("/api/relay/v1/sessions", None, None)).await;
    assert_eq!((list.status, list.json()), (StatusCode::UNAUTHORIZED, json!({ "error": "unauthorized" })));
    let list = http(&s.app, get("/api/relay/v1/sessions", Some(&s.laptop), None)).await;
    assert_eq!((list.status, list.json()), (StatusCode::OK, json!({ "items": [] })));
    // A token without a WebSocket upgrade is refused by the upgrade, not let through.
    let plain = http(&s.app, get("/api/relay/v1/connect", Some(&s.laptop), None)).await;
    assert!(plain.status.is_client_error(), "{}", plain.status);
    // Every device token may connect.
    Client::online(&s, &s.laptop, "sess-a").await;
}

#[tokio::test]
async fn hello_is_answered_with_welcome_and_lists_the_session() {
    let s = server().await;
    let (mut a, welcome) = Client::online(&s, &s.laptop, "sess-a").await;
    assert_eq!(
        welcome,
        json!({ "type": "welcome", "device": "laptop", "deviceName": "laptop", "serverVersion": env!("CARGO_PKG_VERSION"),
            "limits": { "ttlSeconds": 300, "heartbeatSeconds": 20, "maxTextBytes": 32768, "maxHops": 128 } })
    );
    let items = sessions(&s).await;
    let item = &items[0];
    for key in ["connectedAt", "stateSince", "lastSeenAt"] {
        assert!(item[key].as_str().unwrap().ends_with('Z'), "{key}: {item}");
    }
    let mut fixed = item.clone();
    for key in ["connectedAt", "stateSince", "lastSeenAt"] {
        fixed.as_object_mut().unwrap().remove(key);
    }
    assert_eq!(
        fixed,
        json!({ "id": "sess-a", "device": "laptop", "deviceName": "laptop", "host": "laptop.local", "name": "name-sess-a",
            "cwd": "/home/me/code/widgets", "project": "widgets", "model": "faux/model", "state": "idle",
            "piVersion": "1.4.0", "recorded": false })
    );

    tokio::time::sleep(Duration::from_millis(5)).await;
    a.send(json!({ "type": "state", "state": "busy", "title": "Fixing tests", "model": "faux/other" })).await;
    let items = sessions_until(&s, |items| items[0]["state"] == "busy").await;
    assert_eq!(
        (&items[0]["title"], &items[0]["model"], &items[0]["name"]),
        (&json!("Fixing tests"), &json!("faux/other"), &json!("name-sess-a"))
    );
    assert!(items[0]["stateSince"].as_str() > items[0]["connectedAt"].as_str());

    // Long fields are cut.
    let mut long = hello("sess-long");
    long["session"]["name"] = json!("n".repeat(300));
    long["session"]["cwd"] = json!("c".repeat(2000));
    let mut b = Client::connect(&s, &s.laptop).await;
    b.send(long).await;
    assert_eq!(b.next().await["type"], "welcome");
    let items = sessions(&s).await;
    let item = items.iter().find(|i| i["id"] == "sess-long").unwrap();
    assert_eq!((item["name"].as_str().unwrap().len(), item["cwd"].as_str().unwrap().len()), (200, 1024));
}

#[tokio::test]
async fn bad_frames_close_with_4400() {
    let s = server().await;
    let big = json!({ "type": "pong", "pad": "x".repeat(65 * 1024) }).to_string();
    let before_hello: Vec<Message> = vec![
        Message::text(json!({ "type": "state", "state": "busy" }).to_string()),
        Message::text(json!({ "type": "pong" }).to_string()),
        Message::text("not json"),
        Message::text("[1, 2]"),
        Message::text("{}"),
        Message::text(json!({ "type": 4 }).to_string()),
        Message::text(
            json!({ "type": "hello", "session": { "id": "has space", "cwd": "/", "project": "p", "host": "h",
            "state": "idle", "relayVersion": "1" } })
            .to_string(),
        ),
        Message::text(
            json!({ "type": "hello", "session": { "id": "s", "cwd": "/", "project": "p", "host": "h",
            "state": "sleeping", "relayVersion": "1" } })
            .to_string(),
        ),
        Message::binary(b"{}".to_vec()),
    ];
    for message in before_hello {
        let mut c = Client::connect(&s, &s.laptop).await;
        c.raw(message.clone()).await;
        assert_eq!(c.closed().await, 4400, "{message:?}");
    }
    let after_hello: Vec<Message> = vec![
        Message::text(json!({ "type": "nonsense" }).to_string()),
        hello_message("sess-a"),
        Message::text(json!({ "type": "send", "to": "sess-b", "text": "no client id", "hops": 1 }).to_string()),
        Message::text(
            json!({ "type": "send", "clientId": "c".repeat(65), "to": "b", "text": "x", "hops": 1 }).to_string(),
        ),
        Message::text(json!({ "type": "ack", "id": 5 }).to_string()),
        Message::text(json!({ "type": "state", "state": "asleep" }).to_string()),
        Message::text(big),
        Message::binary(vec![0; 16]),
    ];
    for message in after_hello {
        let (mut c, _) = Client::online(&s, &s.laptop, "sess-a").await;
        c.raw(message.clone()).await;
        assert_eq!(c.closed().await, 4400, "{message:?}");
    }
    // A frame of exactly 64 KiB is fine, and unknown acks are ignored.
    let (mut c, _) = Client::online(&s, &s.laptop, "sess-a").await;
    let pad = 64 * 1024 - json!({ "type": "pong", "pad": "" }).to_string().len();
    c.send(json!({ "type": "pong", "pad": "x".repeat(pad) })).await;
    c.send(json!({ "type": "ack", "id": "unknown" })).await;
    let sent = c.relay(send("c1", "nobody", "hi")).await;
    assert_eq!(sent["reason"], "unknown_session");
}

fn hello_message(id: &str) -> Message {
    Message::text(hello(id).to_string())
}

#[tokio::test]
async fn hello_must_arrive_in_time() {
    let s = server_with(|c| c.relay.hello_timeout = Duration::from_millis(150)).await;
    let mut late = Client::connect(&s, &s.laptop).await;
    assert_eq!(late.closed().await, 4408);
    let (mut on_time, _) = Client::online(&s, &s.laptop, "sess-a").await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(on_time.relay(send("c1", "nobody", "hi")).await["reason"], "unknown_session");
}

#[tokio::test]
async fn sessions_belong_to_one_device() {
    let s = server().await;
    record(&s.env.store, SESSION_ID, DEVICE);
    // Recorded for the laptop: the desktop may not claim it.
    let mut c = Client::connect(&s, &s.desktop).await;
    c.send(hello(SESSION_ID)).await;
    assert_eq!(c.closed().await, 4403);
    let (_recorded, _) = Client::online(&s, &s.laptop, SESSION_ID).await;
    tokio::time::sleep(Duration::from_millis(5)).await;
    // Nor while the laptop holds it online: the recorded owner decides first.
    let mut c = Client::connect(&s, &s.desktop).await;
    c.send(hello(SESSION_ID)).await;
    assert_eq!(c.closed().await, 4403);

    // Online from the laptop: the desktop may not take it over.
    let (mut first, _) = Client::online(&s, &s.laptop, "sess-a").await;
    let mut c = Client::connect(&s, &s.desktop).await;
    c.send(hello("sess-a")).await;
    assert_eq!(c.closed().await, 4409);

    // The same device replaces its older connection.
    let (mut second, _) = Client::online(&s, &s.laptop, "sess-a").await;
    assert_eq!(first.closed().await, 4410);
    let items = sessions(&s).await;
    assert_eq!(ids(&items), ["sess-a", SESSION_ID]);
    assert_eq!(second.relay(send("c1", "nobody", "hi")).await["reason"], "unknown_session");
    assert_eq!(items.iter().find(|i| i["id"] == SESSION_ID).unwrap()["recorded"], true);
}

#[tokio::test]
async fn a_message_acknowledged_in_time_is_delivered() {
    let s = server().await;
    let (mut a, _) = Client::online(&s, &s.laptop, "sess-a").await;
    let (mut b, _) = Client::online(&s, &s.desktop, "sess-b").await;
    a.send(json!({ "type": "send", "clientId": "c1", "to": "sess-b", "text": "hello b", "urgent": true,
        "replyTo": "earlier-id", "hops": 2 }))
        .await;
    let message = b.next().await;
    let id = message["id"].as_str().unwrap().to_owned();
    assert!(id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_'), "{id}");
    assert!(message["sentAt"].as_str().unwrap().ends_with('Z'));
    let mut fixed = message.clone();
    fixed.as_object_mut().unwrap().remove("sentAt");
    assert_eq!(
        fixed,
        json!({ "type": "message", "id": id, "text": "hello b", "urgent": true, "replyTo": "earlier-id", "hops": 2,
            "from": { "kind": "session", "sessionId": "sess-a", "device": "laptop", "deviceName": "laptop",
                "name": "name-sess-a", "project": "widgets" } })
    );
    b.send(json!({ "type": "ack", "id": id })).await;
    let sent = a.next().await;
    assert_eq!(
        sent,
        json!({ "type": "sent", "clientId": "c1", "id": id, "status": "delivered",
            "to": { "sessionId": "sess-b", "device": "desktop", "deviceName": "desktop", "name": "name-sess-b",
                "project": "widgets" } })
    );
    // A second ack is ignored, and no status follows a delivered `sent`.
    b.send(json!({ "type": "ack", "id": id })).await;
    assert_eq!(a.relay(send("c2", "nobody", "x")).await["clientId"], "c2");
    let events = events(&s, "").await;
    let event = events.iter().find(|e| e["id"] == id.as_str()).unwrap();
    assert_eq!((&event["status"], &event["hops"], &event["urgent"]), (&json!("delivered"), &json!(2), &json!(true)));
    assert!(event["deliveredAt"].as_str().unwrap().ends_with('Z'));
    assert_eq!(s.state.relay.queued(), 0);
}

#[tokio::test]
async fn a_late_ack_answers_queued_then_reports_delivered() {
    let s = server_with(|c| c.relay.ack_wait = Duration::from_millis(100)).await;
    let (mut a, _) = Client::online(&s, &s.laptop, "sess-a").await;
    let (mut b, _) = Client::online(&s, &s.desktop, "sess-b").await;
    a.send(send("c1", "sess-b", "are you there")).await;
    let id = b.next().await["id"].as_str().unwrap().to_owned();
    let sent = a.next().await;
    assert_eq!((&sent["status"], &sent["id"]), (&json!("queued"), &json!(id)));
    // Only the target may acknowledge.
    a.send(json!({ "type": "ack", "id": id })).await;
    assert_eq!(a.relay(send("c2", "nobody", "x")).await["clientId"], "c2");
    assert_eq!(s.state.relay.queued(), 1);
    b.send(json!({ "type": "ack", "id": id })).await;
    let status = a.next().await;
    assert_eq!(
        (&status["type"], &status["id"], &status["status"]),
        (&json!("status"), &json!(id), &json!("delivered"))
    );
    assert_eq!(status["to"]["sessionId"], "sess-b");
    assert!(status["at"].as_str().unwrap().ends_with('Z'));
}

#[tokio::test]
async fn an_offline_target_gets_its_messages_on_reconnect() {
    let s = server().await;
    record(&s.env.store, SESSION_ID, DEVICE);
    let (mut a, _) = Client::online(&s, &s.desktop, "sess-a").await;
    let mut sent_ids = Vec::new();
    for (n, text) in ["one", "two", "three"].iter().enumerate() {
        let sent = a.relay(send(&format!("c{n}"), SESSION_ID, text)).await;
        assert_eq!(sent["status"], "queued");
        assert_eq!(sent["to"], json!({ "sessionId": SESSION_ID, "device": "laptop", "deviceName": "laptop", "project": "widgets" }));
        sent_ids.push(sent["id"].as_str().unwrap().to_owned());
    }
    // The sender reconnects; status goes to its current connection.
    let (mut a2, _) = Client::online(&s, &s.desktop, "sess-a").await;
    assert_eq!(a.closed().await, 4410);

    let (mut t, _) = Client::online(&s, &s.laptop, SESSION_ID).await;
    let mut pushed = Vec::new();
    for _ in 0..3 {
        let message = t.next().await;
        assert_eq!(message["type"], "message");
        pushed.push((message["id"].as_str().unwrap().to_owned(), message["text"].as_str().unwrap().to_owned()));
    }
    let expected: Vec<(String, String)> =
        sent_ids.iter().cloned().zip(["one", "two", "three"].map(String::from)).collect();
    assert_eq!(pushed, expected);
    for id in &sent_ids {
        t.send(json!({ "type": "ack", "id": id })).await;
        let status = a2.next().await;
        assert_eq!(
            (&status["type"], &status["id"], &status["status"]),
            (&json!("status"), &json!(id), &json!("delivered"))
        );
    }
    assert_eq!(s.state.relay.queued(), 0);
    let events = events(&s, "").await;
    assert!(events.iter().all(|e| e["status"] == "delivered" && e["deliveredAt"].is_string()), "{events:?}");
}

#[tokio::test]
async fn unacknowledged_messages_expire_and_tell_the_sender() {
    let s = server_with(|c| {
        c.relay.ttl = Duration::from_millis(300);
        c.relay.ack_wait = Duration::from_millis(50);
    })
    .await;
    record(&s.env.store, SESSION_ID, DEVICE);
    let (mut a, _) = Client::online(&s, &s.desktop, "sess-a").await;
    let offline = a.relay(send("c1", SESSION_ID, "to nobody")).await;
    assert_eq!(offline["status"], "queued");
    // An online target that never acknowledges.
    let (mut b, _) = Client::online(&s, &s.laptop, "sess-b").await;
    let online = a.relay(send("c2", "sess-b", "ignored")).await;
    assert_eq!((&online["status"], &b.next().await["id"]), (&json!("queued"), &online["id"]));
    let mut expired = Vec::new();
    for _ in 0..2 {
        let status = a.next().await;
        assert_eq!((&status["type"], &status["status"]), (&json!("status"), &json!("expired")), "{status}");
        expired.push(status["id"].clone());
    }
    expired.sort_by_key(|id| id.to_string());
    let mut want = vec![offline["id"].clone(), online["id"].clone()];
    want.sort_by_key(|id| id.to_string());
    assert_eq!(expired, want);
    assert_eq!(s.state.relay.queued(), 0);
    let events = events(&s, "").await;
    assert!(events.iter().all(|e| e["status"] == "expired" && e.get("deliveredAt").is_none()), "{events:?}");
    // Nothing is pushed again, and a late ack is ignored.
    b.send(json!({ "type": "ack", "id": online["id"] })).await;
    let (mut t, _) = Client::online(&s, &s.laptop, SESSION_ID).await;
    assert_eq!(t.relay(send("c3", "nobody", "x")).await["reason"], "unknown_session");
}

#[tokio::test]
async fn an_unacknowledged_message_is_pushed_again_after_a_dropped_connection() {
    let s = server_with(|c| c.relay.ack_wait = Duration::from_millis(50)).await;
    let (mut a, _) = Client::online(&s, &s.laptop, "sess-a").await;
    let (mut b, _) = Client::online(&s, &s.desktop, "sess-b").await;
    let sent = a.relay(send("c1", "sess-b", "please ack")).await;
    assert_eq!(sent["status"], "queued");
    let first = b.next().await;
    assert_eq!(first["id"], sent["id"]);
    // The connection drops without a close handshake; the session goes offline.
    drop(b);
    sessions_until(&s, |items| ids(items) == ["sess-a"]).await;
    // The same message, with the same id, comes again exactly once.
    let (mut b, _) = Client::online(&s, &s.desktop, "sess-b").await;
    let again = b.next().await;
    assert_eq!(again, first);
    b.send(json!({ "type": "ack", "id": again["id"] })).await;
    assert_eq!(a.next().await["status"], "delivered");
    let (mut b, _) = Client::online(&s, &s.desktop, "sess-b").await;
    assert_eq!(b.relay(send("c2", "nobody", "x")).await["reason"], "unknown_session");
}

#[tokio::test]
async fn sends_are_rejected_in_order() {
    let s = server_with(|c| c.relay.max_queued_per_target = 1).await;
    record(&s.env.store, SESSION_ID, DEVICE);
    let (mut a, _) = Client::online(&s, &s.laptop, "sess-a").await;
    let big = "é".repeat(16 * 1024 + 1);
    let exact = "x".repeat(32 * 1024);
    let frame = |to: &str, text: &str, hops: Value| {
        json!({ "type": "send", "clientId": "c", "to": to, "text": text, "hops": hops })
    };
    let cases = [
        (frame("sess-a", "", json!(1)), "invalid"),
        (frame("bad id", "x", json!(1)), "invalid"),
        (frame("nobody", "x", json!(0)), "invalid"),
        (frame("nobody", "x", json!("1")), "invalid"),
        (json!({ "type": "send", "clientId": "c", "to": "nobody", "text": "x" }), "invalid"),
        (json!({ "type": "send", "clientId": "c", "to": "nobody", "text": 5, "hops": 1 }), "invalid"),
        (frame("sess-a", &big, json!(129)), "self"),
        (frame("nobody", &big, json!(129)), "too_large"),
        (frame("nobody", "x", json!(129)), "hop_limit"),
        (frame("nobody", "x", json!(1)), "unknown_session"),
        (frame(SESSION_ID, &exact, json!(128)), "queued"),
        (frame("nobody", "x", json!(1)), "unknown_session"),
        (frame(SESSION_ID, "x", json!(1)), "mailbox_full"),
    ];
    for (frame, want) in &cases {
        let sent = a.relay(frame.clone()).await;
        assert_eq!(sent["clientId"], "c");
        match *want {
            "queued" => assert_eq!(sent["status"], "queued", "{sent}"),
            reason => {
                assert_eq!(sent, json!({ "type": "sent", "clientId": "c", "status": "rejected", "reason": reason }));
            }
        }
    }
    let events = events(&s, "").await;
    assert_eq!(events.len(), cases.len());
    let reasons: Vec<&Value> = events.iter().rev().map(|e| e.get("reason").unwrap_or(&e["status"])).collect();
    let want: Vec<Value> = cases.iter().map(|(_, w)| json!(w)).collect();
    assert_eq!(reasons, want.iter().collect::<Vec<_>>());
    let mut ids: Vec<&str> = events.iter().map(|e| e["id"].as_str().unwrap()).collect();
    ids.sort();
    ids.dedup();
    assert_eq!(ids.len(), cases.len(), "rejected sends get their own ids");
    let too_large = &events[events.len() - 8];
    assert_eq!((&too_large["status"], &too_large["reason"]), (&json!("rejected"), &json!("too_large")));
    assert!(too_large["text"].as_str().unwrap().len() <= 32 * 1024);
}

#[tokio::test]
async fn each_session_may_send_60_a_minute() {
    let s = server().await;
    record(&s.env.store, SESSION_ID, DEVICE);
    let (mut a, _) = Client::online(&s, &s.laptop, "sess-a").await;
    let (mut b, _) = Client::online(&s, &s.laptop, "sess-b").await;
    // Rejections before the rate check do not count.
    assert_eq!(a.relay(send("bad", "sess-a", "self")).await["reason"], "self");
    for n in 0..60 {
        assert_eq!(a.relay(send(&format!("c{n}"), SESSION_ID, "x")).await["status"], "queued", "{n}");
    }
    assert_eq!(a.relay(send("c60", SESSION_ID, "x")).await["reason"], "rate_limited");
    let mut over = send("c61", "nobody", "x");
    over["hops"] = json!(129);
    assert_eq!(a.relay(over).await["reason"], "rate_limited", "the rate is checked before the hops");
    assert_eq!(a.relay(send("c62", "sess-a", "x")).await["reason"], "self", "self is checked first");
    // Another session has its own budget.
    assert_eq!(b.relay(send("b0", SESSION_ID, "x")).await["status"], "queued");
}

#[tokio::test]
async fn the_mailbox_holds_100_per_target_and_a_global_maximum() {
    let s = server().await;
    record(&s.env.store, SESSION_ID, DEVICE);
    record(&s.env.store, "other-recorded", DEVICE);
    let (mut a, _) = Client::online(&s, &s.laptop, "sess-a").await;
    let (mut b, _) = Client::online(&s, &s.laptop, "sess-b").await;
    for n in 0..50 {
        assert_eq!(a.relay(send(&format!("a{n}"), SESSION_ID, "x")).await["status"], "queued");
        assert_eq!(b.relay(send(&format!("b{n}"), SESSION_ID, "x")).await["status"], "queued");
    }
    assert_eq!(s.state.relay.queued(), 100);
    assert_eq!(a.relay(send("full", SESSION_ID, "x")).await["reason"], "mailbox_full");
    assert_eq!(a.relay(send("other", "other-recorded", "x")).await["status"], "queued");
    let web = http(&s.app, post("/api/v1/relay/messages", json!({ "to": SESSION_ID, "text": "x" }), None)).await;
    assert_eq!((web.status, web.json()), (StatusCode::TOO_MANY_REQUESTS, json!({ "error": "mailbox_full" })));

    let s = server_with(|c| c.relay.max_queued = 2).await;
    record(&s.env.store, SESSION_ID, DEVICE);
    let (mut a, _) = Client::online(&s, &s.laptop, "sess-a").await;
    let (mut b, _) = Client::online(&s, &s.desktop, "sess-b").await;
    assert_eq!(a.relay(send("c1", SESSION_ID, "x")).await["status"], "queued");
    a.send(send("c2", "sess-b", "x")).await;
    let pushed = b.next().await;
    assert_eq!(a.relay(send("c3", SESSION_ID, "x")).await["reason"], "mailbox_full");
    assert_eq!(a.relay(send("c3", "nobody", "x")).await["reason"], "unknown_session", "unknown is checked first");
    // An ack frees room.
    b.send(json!({ "type": "ack", "id": pushed["id"] })).await;
    let delivered = a.next().await;
    assert_eq!((&delivered["clientId"], &delivered["status"]), (&json!("c2"), &json!("delivered")));
    assert_eq!(a.relay(send("c4", SESSION_ID, "x")).await["status"], "queued");
}

#[tokio::test]
async fn silent_connections_are_closed_and_go_offline() {
    let s = server_with(|c| {
        c.relay.heartbeat = Duration::from_millis(100);
        c.relay.dead_after = Duration::from_millis(500);
    })
    .await;
    let (mut a, welcome) = Client::online(&s, &s.laptop, "sess-a").await;
    assert_eq!(welcome["limits"]["heartbeatSeconds"], 0);
    // Answering pings keeps the connection past the dead time.
    let started = tokio::time::Instant::now();
    let mut pings = 0;
    while started.elapsed() < Duration::from_millis(800) {
        let frame = a.next_any().await;
        assert_eq!(frame["type"], "ping");
        assert!(frame["at"].as_str().unwrap().ends_with('Z'));
        pings += 1;
        a.send(json!({ "type": "pong" })).await;
    }
    assert!(pings >= 5, "{pings} pings");
    assert_eq!(ids(&sessions(&s).await), ["sess-a"]);
    // Silence closes it.
    assert_eq!(a.closed().await, 1001);
    assert!(started.elapsed() >= Duration::from_millis(1200), "{:?}", started.elapsed());
    assert!(sessions(&s).await.is_empty());
}

#[tokio::test]
async fn revoking_a_device_closes_its_connections_with_4401() {
    let s = server().await;
    let (mut a, _) = Client::online(&s, &s.laptop, "sess-a").await;
    let mut waiting = Client::connect(&s, &s.laptop).await;
    let (mut b, _) = Client::online(&s, &s.desktop, "sess-b").await;
    let r = http(&s.app, Request::delete("/api/v1/devices/laptop").body(Body::empty()).unwrap()).await;
    assert_eq!(r.status, StatusCode::NO_CONTENT);
    assert_eq!(a.closed().await, 4401);
    assert_eq!(waiting.closed().await, 4401);
    assert_eq!(ids(&sessions(&s).await), ["sess-b"]);
    assert_eq!(b.relay(send("c1", "sess-a", "x")).await["reason"], "unknown_session");
    assert_eq!(refused(&s, Some(&s.laptop)).await.0, 401);

    // `pika token revoke` runs in another process: the connection closes within one heartbeat.
    let s = server_with(|c| c.relay.heartbeat = Duration::from_millis(100)).await;
    let (mut a, _) = Client::online(&s, &s.laptop, "sess-a").await;
    let (mut b, _) = Client::online(&s, &s.desktop, "sess-b").await;
    pika::auth::revoke_token(&s.env.store, DEVICE).unwrap();
    let started = tokio::time::Instant::now();
    assert_eq!(a.closed().await, 4401);
    assert!(started.elapsed() < Duration::from_millis(500), "{:?}", started.elapsed());
    assert_eq!(b.next_any().await["type"], "ping");
}

#[tokio::test]
async fn connections_and_online_sessions_are_limited() {
    let s = server_with(|c| c.relay.max_online = 2).await;
    let mut held = Vec::new();
    for _ in 0..64 {
        held.push(Client::connect(&s, &s.laptop).await);
    }
    let mut extra = Client::connect(&s, &s.laptop).await;
    assert_eq!(extra.closed().await, 4429);
    let (_a, _) = Client::online(&s, &s.desktop, "sess-a").await;
    let (_b, _) = Client::online(&s, &s.desktop, "sess-b").await;
    let mut c = Client::connect(&s, &s.desktop).await;
    c.send(hello("sess-c")).await;
    assert_eq!(c.closed().await, 4429);
    // Replacing a session does not add one.
    tokio::time::sleep(Duration::from_millis(5)).await;
    let (_a2, _) = Client::online(&s, &s.desktop, "sess-a").await;
    assert_eq!(ids(&sessions(&s).await), ["sess-a", "sess-b"]);
}

#[tokio::test]
async fn relay_off_disables_every_route() {
    let s = server().await;
    let health = http(&s.app, get("/api/health", None, None)).await;
    assert_eq!(health.json()["features"], json!(["relay", "agent"]));

    let s = server_with(|c| {
        c.relay.enabled = false;
        c.auth = AuthMode::Password;
        c.password = Some(PASSWORD.into());
    })
    .await;
    let health = http(&s.app, get("/api/health", None, None)).await;
    assert_eq!(
        (health.json()["features"].clone(), health.json()["version"].clone()),
        (json!(["agent"]), json!(env!("CARGO_PKG_VERSION")))
    );
    let disabled = (404, json!({ "error": "relay_disabled" }));
    assert_eq!(refused(&s, Some(&s.laptop)).await, disabled);
    assert_eq!(refused(&s, None).await, disabled);
    for request in [
        get("/api/relay/v1/sessions", Some(&s.laptop), None),
        get("/api/v1/relay/sessions", None, None),
        get("/api/v1/relay/events", None, None),
        post("/api/v1/relay/messages", json!({ "to": "a", "text": "b" }), None),
    ] {
        let r = http(&s.app, request).await;
        assert_eq!((r.status.as_u16(), r.json()), disabled);
    }
}

#[tokio::test]
async fn relay_routes_follow_the_base_path() {
    let s = server_with(|c| c.base_path = "/pika".into()).await;
    let (mut a, _) = Client::online(&s, &s.laptop, "sess-a").await;
    assert_eq!(ids(&sessions(&s).await), ["sess-a"]);
    assert_eq!(a.relay(send("c", "nobody", "x")).await["reason"], "unknown_session");
    assert_eq!(events(&s, "").await.len(), 1);
}

async fn login(app: &Router) -> String {
    let response = app.clone().oneshot(post("/api/v1/login", json!({ "password": PASSWORD }), None)).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let cookie = response.headers().get("set-cookie").unwrap().to_str().unwrap();
    cookie.split(';').next().unwrap().to_owned()
}

#[tokio::test]
async fn the_browser_lists_sessions_and_sends_as_the_web() {
    let s = server_with(|c| {
        c.auth = AuthMode::Password;
        c.password = Some(PASSWORD.into());
    })
    .await;
    record(&s.env.store, SESSION_ID, DEVICE);
    record(&s.env.store, "offline-recorded", OTHER);
    for request in [
        get("/api/v1/relay/sessions", None, None),
        get("/api/v1/relay/events", None, None),
        post("/api/v1/relay/messages", json!({ "to": "sess-b", "text": "x" }), None),
    ] {
        assert_eq!(http(&s.app, request).await.status, StatusCode::UNAUTHORIZED);
    }
    let cookie = login(&s.app).await;

    let (_a, _) = Client::online(&s, &s.laptop, "sess-a").await;
    tokio::time::sleep(Duration::from_millis(5)).await;
    let (_t, _) = Client::online(&s, &s.laptop, SESSION_ID).await;
    let (mut b, _) = Client::online(&s, &s.desktop, "sess-b").await;
    let list = http(&s.app, get("/api/v1/relay/sessions", None, Some(&cookie))).await;
    assert_eq!(list.status, StatusCode::OK);
    let items = list.json()["items"].as_array().unwrap().clone();
    assert_eq!(ids(&items), ["sess-b", SESSION_ID, "sess-a"], "by device name, then newest first");
    assert_eq!(items.iter().map(|i| i["recorded"].as_bool().unwrap()).collect::<Vec<_>>(), [false, true, false]);
    assert_eq!(items, sessions(&s).await);

    // An online target that acknowledges at once.
    let request = post(
        "/api/v1/relay/messages",
        json!({ "to": "sess-b", "text": "from the web", "urgent": true, "hops": 7 }),
        Some(&cookie),
    );
    let app = s.app.clone();
    let posted = tokio::spawn(async move { http(&app, request).await });
    let message = b.next().await;
    assert_eq!(
        (&message["from"], &message["hops"], &message["urgent"]),
        (&json!({ "kind": "web" }), &json!(0), &json!(true))
    );
    assert!(message.get("replyTo").is_none());
    b.send(json!({ "type": "ack", "id": message["id"] })).await;
    let posted = posted.await.unwrap();
    assert_eq!(posted.status, StatusCode::OK);
    assert_eq!(
        posted.json(),
        json!({ "id": message["id"], "status": "delivered",
            "to": { "sessionId": "sess-b", "device": "desktop", "deviceName": "desktop", "name": "name-sess-b",
                "project": "widgets" } })
    );

    // A recorded session that is offline.
    let queued = http(
        &s.app,
        post("/api/v1/relay/messages", json!({ "to": "offline-recorded", "text": "later" }), Some(&cookie)),
    )
    .await;
    assert_eq!((queued.status, &queued.json()["status"]), (StatusCode::OK, &json!("queued")));
    assert_eq!(
        queued.json()["to"],
        json!({ "sessionId": "offline-recorded", "device": "desktop", "deviceName": "desktop", "project": "widgets" })
    );

    for (body, status, reason) in [
        (json!({ "to": "nobody", "text": "x" }), StatusCode::BAD_REQUEST, "unknown_session"),
        (json!({ "to": "sess-b", "text": "" }), StatusCode::BAD_REQUEST, "invalid"),
        (json!({ "to": "sess-b" }), StatusCode::BAD_REQUEST, "invalid"),
        (json!("text"), StatusCode::BAD_REQUEST, "invalid"),
        (json!({ "to": "sess-b", "text": "x".repeat(32 * 1024 + 1) }), StatusCode::BAD_REQUEST, "too_large"),
    ] {
        let r = http(&s.app, post("/api/v1/relay/messages", body, Some(&cookie))).await;
        assert_eq!((r.status, r.json()), (status, json!({ "error": reason })));
    }
    let malformed = Request::post("/api/v1/relay/messages")
        .header("content-type", "application/json")
        .header("cookie", &cookie)
        .body(Body::from("{"))
        .unwrap();
    assert_eq!(http(&s.app, malformed).await.json(), json!({ "error": "invalid" }));
    let form = Request::post("/api/v1/relay/messages")
        .header("content-type", "application/x-www-form-urlencoded")
        .header("cookie", &cookie)
        .body(Body::from("to=sess-b&text=x"))
        .unwrap();
    assert_eq!(http(&s.app, form).await.status, StatusCode::UNSUPPORTED_MEDIA_TYPE);

    let all = http(&s.app, get("/api/v1/relay/events", None, Some(&cookie))).await.json()["items"]
        .as_array()
        .unwrap()
        .clone();
    assert_eq!(all.len(), 8);
    let statuses: Vec<&str> = all.iter().map(|e| e["status"].as_str().unwrap()).collect();
    assert_eq!(
        statuses,
        ["rejected", "rejected", "rejected", "rejected", "rejected", "rejected", "queued", "delivered"]
    );
    let delivered = &all[7];
    assert_eq!(delivered["id"], message["id"]);
    let mut fixed = delivered.clone();
    for key in ["at", "deliveredAt"] {
        assert!(fixed[key].as_str().unwrap().ends_with('Z'));
        fixed.as_object_mut().unwrap().remove(key);
    }
    assert_eq!(
        fixed,
        json!({ "id": message["id"], "from": { "kind": "web" }, "status": "delivered", "urgent": true, "hops": 0,
            "text": "from the web",
            "to": { "sessionId": "sess-b", "device": "desktop", "deviceName": "desktop", "name": "name-sess-b",
                "project": "widgets" } })
    );
    assert_eq!((&all[0]["reason"], &all[0]["to"]), (&json!("invalid"), &json!({ "sessionId": "" })));
    let two = http(&s.app, get("/api/v1/relay/events?limit=2", None, Some(&cookie))).await.json();
    assert_eq!(two["items"].as_array().unwrap()[..], all[..2]);
    assert_eq!(
        http(&s.app, get("/api/v1/relay/events?limit=999", None, Some(&cookie))).await.json()["items"]
            .as_array()
            .unwrap()
            .len(),
        8
    );
    assert_eq!(
        http(&s.app, get("/api/v1/relay/events?limit=many", None, Some(&cookie))).await.status,
        StatusCode::BAD_REQUEST
    );
}

#[tokio::test]
async fn web_sends_share_one_rate_limit_and_the_event_ring_keeps_500() {
    let s = server().await;
    record(&s.env.store, SESSION_ID, DEVICE);
    for _ in 0..60 {
        let r = http(&s.app, post("/api/v1/relay/messages", json!({ "to": SESSION_ID, "text": "x" }), None)).await;
        assert_eq!(r.status, StatusCode::OK);
    }
    let r = http(&s.app, post("/api/v1/relay/messages", json!({ "to": SESSION_ID, "text": "x" }), None)).await;
    assert_eq!((r.status, r.json()), (StatusCode::TOO_MANY_REQUESTS, json!({ "error": "rate_limited" })));
    for _ in 0..500 {
        http(&s.app, post("/api/v1/relay/messages", json!({ "to": SESSION_ID, "text": "" }), None)).await;
    }
    assert_eq!(events(&s, "").await.len(), 100);
    let ring = events(&s, "?limit=500").await;
    assert_eq!(ring.len(), 500);
    assert!(ring.iter().all(|e| e["reason"] == "invalid"));
}

/// Starts the `pika` binary with `env`; returns it and its address, or its exit status and error output.
fn spawn(data: &std::path::Path, env: &[(&str, &str)]) -> Result<(std::process::Child, String), String> {
    let mut command = Command::new(env!("CARGO_BIN_EXE_pika"));
    for (key, _) in std::env::vars_os() {
        if key.to_string_lossy().starts_with("PIKA_") {
            command.env_remove(key);
        }
    }
    command.args(["--data-dir", data.to_str().unwrap(), "serve", "--bind", "127.0.0.1:0"]).env("PIKA_AUTH", "none");
    // Offline: no price catalog fetch.
    command.env("PIKA_PRICES", "off");
    let mut child = command.envs(env.iter().copied()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
    let listening =
        BufReader::new(child.stdout.take().unwrap()).lines().map_while(Result::ok).find(|l| l.contains("listening on"));
    match listening {
        Some(line) => {
            let addr = line.split("http://").nth(1).unwrap().split('/').next().unwrap().to_owned();
            Ok((child, addr))
        }
        None => {
            let out = child.wait_with_output().unwrap();
            Err(format!("{:?}: {}", out.status.code(), String::from_utf8_lossy(&out.stderr)))
        }
    }
}

fn health_of(addr: &str) -> Value {
    let mut stream = std::net::TcpStream::connect(addr).unwrap();
    stream.write_all(b"GET /api/health HTTP/1.1\r\nHost: pika\r\nConnection: close\r\n\r\n").unwrap();
    let mut response = String::new();
    stream.read_to_string(&mut response).unwrap();
    serde_json::from_str(response.split("\r\n\r\n").nth(1).unwrap()).unwrap()
}

#[tokio::test]
async fn the_server_reads_relay_settings_from_the_environment() {
    let env = env();
    let data = env.dir.path().join("data");
    let token = common::device(&env.store, DEVICE);
    let cases = [
        ("off", json!(["agent"])),
        ("OFF", json!(["agent"])),
        ("on", json!(["relay", "agent"])),
        ("1", json!(["relay", "agent"])),
        ("", json!(["relay", "agent"])),
    ];
    for (value, features) in cases {
        let (mut child, addr) = spawn(&data, &[("PIKA_RELAY", value)]).unwrap();
        assert_eq!(health_of(&addr)["features"], features, "{value}");
        child.kill().unwrap();
        child.wait().unwrap();
    }
    let e = spawn(&data, &[("PIKA_RELAY", "maybe")]).unwrap_err();
    assert!(e.starts_with("Some(2): ") && e.contains("'--relay"), "{e}");
    let e = spawn(&data, &[("PIKA_RELAY_TTL_SECS", "0")]).unwrap_err();
    assert!(e.starts_with("Some(2): "), "{e}");

    let (mut child, addr) = spawn(&data, &[("PIKA_RELAY_TTL_SECS", "7"), ("PIKA_RELAY_HEARTBEAT_SECS", "3")]).unwrap();
    assert_eq!(health_of(&addr)["features"], json!(["relay", "agent"]));
    let mut request = format!("ws://{addr}/api/relay/v1/connect").into_client_request().unwrap();
    request.headers_mut().insert("authorization", format!("Bearer {token}").parse().unwrap());
    let (mut ws, _) = tokio_tungstenite::connect_async(request).await.unwrap();
    ws.send(Message::text(hello("sess-a").to_string())).await.unwrap();
    let Some(Ok(Message::Text(welcome))) = ws.next().await else { panic!("no welcome") };
    let welcome: Value = serde_json::from_str(welcome.as_str()).unwrap();
    assert_eq!((&welcome["limits"]["ttlSeconds"], &welcome["limits"]["heartbeatSeconds"]), (&json!(7), &json!(3)));
    // Stopping the server closes relay connections instead of waiting for them.
    Command::new("kill").args(["-TERM", &child.id().to_string()]).status().unwrap();
    let closed = tokio::time::timeout(WAIT, async {
        loop {
            match ws.next().await {
                Some(Ok(Message::Close(frame))) => return frame.map(|f| u16::from(f.code)),
                Some(Ok(_)) => {}
                other => panic!("no close frame: {other:?}"),
            }
        }
    });
    assert_eq!(closed.await.unwrap(), Some(1001));
    let deadline = std::time::Instant::now() + WAIT;
    while child.try_wait().unwrap().is_none() {
        assert!(std::time::Instant::now() < deadline, "the server did not stop");
        std::thread::sleep(Duration::from_millis(20));
    }
    // The test-only settings stay out of `--help`.
    let help = Command::new(env!("CARGO_BIN_EXE_pika")).args(["serve", "--help"]).output().unwrap();
    let help = String::from_utf8_lossy(&help.stdout);
    assert!(help.contains("--relay") && !help.contains("TTL_SECS") && !help.contains("HEARTBEAT"), "{help}");
}

/// A client whose socket receives into a 4 KiB buffer, so the server's writes stall as soon as it stops reading.
async fn slow_client(s: &Server, token: &str) -> Client {
    let socket = tokio::net::TcpSocket::new_v4().unwrap();
    socket.set_recv_buffer_size(4096).unwrap();
    let stream = socket.connect(s.addr).await.unwrap();
    let mut request = format!("ws://{}{}/api/relay/v1/connect", s.addr, s.base).into_client_request().unwrap();
    request.headers_mut().insert("authorization", format!("Bearer {token}").parse().unwrap());
    let (ws, _) = tokio_tungstenite::client_async(request, MaybeTlsStream::Plain(stream)).await.unwrap();
    Client { ws }
}

impl Client {
    /// Reads until the server closes; returns the close code and the frames before it, `ping` excluded.
    async fn frames_until_closed(&mut self) -> (u16, Vec<Value>) {
        let mut frames = Vec::new();
        loop {
            match tokio::time::timeout(WAIT, self.ws.next()).await.expect("not closed in time") {
                Some(Ok(Message::Close(Some(frame)))) => return (frame.code.into(), frames),
                Some(Ok(Message::Text(text))) => {
                    let frame: Value = serde_json::from_str(text.as_str()).unwrap();
                    if frame["type"] != "ping" {
                        frames.push(frame);
                    }
                }
                Some(Ok(_)) => {}
                other => panic!("connection ended without a close frame: {other:?}"),
            }
        }
    }
}

/// Limits that let the web UI send a slow reader as much as a test needs, answering `queued` after 1 ms.
fn roomy(c: &mut pika::config::RelayConfig) {
    c.sends_per_minute = 100_000;
    c.sends_per_minute_per_device = 100_000;
    c.max_queued_per_target = 100_000;
    c.max_queued = 100_000;
    c.ack_wait = Duration::from_millis(1);
}

/// Sends 32 KiB messages from the web UI to `to` until `done` holds, and returns their ids.
async fn flood(s: &Server, to: &str, done: impl Fn(&Server) -> bool) -> Vec<String> {
    let text = "x".repeat(32 * 1024);
    let mut ids = Vec::new();
    while !done(s) {
        assert!(ids.len() < 1000, "the reader never fell behind");
        let r = http(&s.app, post("/api/v1/relay/messages", json!({ "to": to, "text": text }), None)).await;
        assert_eq!((r.status, &r.json()["status"]), (StatusCode::OK, &json!("queued")));
        ids.push(r.json()["id"].as_str().unwrap().to_owned());
    }
    ids
}

/// Whether the writer to `session` is stuck: far more is queued for it than a socket takes at once.
fn stalled(s: &Server, session: &str) -> bool {
    s.state.relay.outgoing_bytes(session).is_some_and(|bytes| bytes >= 256 << 10)
}

/// A slow reader online as `id` from the laptop.
async fn slow_online(s: &Server, id: &str) -> Client {
    let mut client = slow_client(s, &s.laptop).await;
    client.send(hello(id)).await;
    sessions_until(s, |items| ids(items).contains(&id)).await;
    client
}

async fn connections_until(s: &Server, n: usize, within: Duration) {
    let deadline = tokio::time::Instant::now() + within;
    while s.state.relay.connections() != n {
        assert!(tokio::time::Instant::now() < deadline, "{} connections, not {n}", s.state.relay.connections());
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
}

#[tokio::test]
async fn a_reader_that_stops_reading_still_goes_offline_when_silent() {
    let dead_after = Duration::from_millis(1500);
    let s = server_with(|c| {
        roomy(&mut c.relay);
        c.relay.dead_after = dead_after;
    })
    .await;
    let Client { ws } = slow_online(&s, "sess-t").await;
    // It keeps talking while the flood fills the socket buffers, which on Linux take megabytes and outlast the
    // timeout, and falls silent once a write waits.
    let (mut sink, stream) = ws.split();
    let (stop, mut stopped) = tokio::sync::oneshot::channel::<()>();
    let talking = tokio::spawn(async move {
        loop {
            sink.send(Message::text(json!({ "type": "pong" }).to_string())).await.unwrap();
            let last = tokio::time::Instant::now();
            tokio::select! {
                _ = &mut stopped => return (sink, last),
                _ = tokio::time::sleep(Duration::from_millis(100)) => {}
            }
        }
    });
    let ids = flood(&s, "sess-t", |s| stalled(s, "sess-t")).await;
    stop.send(()).unwrap();
    let (sink, silent) = talking.await.unwrap();
    let mut t = Client { ws: stream.reunite(sink).unwrap() };
    assert!(stalled(&s, "sess-t") && silent.elapsed() < dead_after, "{:?}", silent.elapsed());
    // The silence timeout runs while a write waits, and takes the connection out at once.
    sessions_until(&s, |items| items.is_empty()).await;
    assert!(silent.elapsed() >= dead_after, "{:?}", silent.elapsed());
    assert_eq!(s.state.relay.connections(), 0);
    assert_eq!(s.state.relay.queued(), ids.len(), "unacknowledged messages stay queued");
    // Once it reads again, the close frame follows what the socket already held.
    assert_eq!(t.closed().await, 1001);
}

#[tokio::test]
async fn revoking_a_device_closes_a_stalled_connection_at_once() {
    let s = server_with(|c| roomy(&mut c.relay)).await;
    let mut t = slow_online(&s, "sess-t").await;
    flood(&s, "sess-t", |s| stalled(s, "sess-t")).await;
    let started = tokio::time::Instant::now();
    let r = http(&s.app, Request::delete("/api/v1/devices/laptop").body(Body::empty()).unwrap()).await;
    assert_eq!(r.status, StatusCode::NO_CONTENT);
    assert!(sessions(&s).await.is_empty());
    connections_until(&s, 0, Duration::from_secs(1)).await;
    assert!(started.elapsed() < Duration::from_secs(1), "{:?}", started.elapsed());
    assert_eq!(t.closed().await, 4401);
}

#[tokio::test]
async fn an_outgoing_queue_over_its_maximum_closes_with_1008() {
    let s = server_with(|c| {
        roomy(&mut c.relay);
        c.relay.max_outgoing_bytes = 256 << 10;
    })
    .await;
    let mut t = slow_online(&s, "sess-t").await;
    let ids = flood(&s, "sess-t", |s| s.state.relay.outgoing_bytes("sess-t").is_none()).await;
    assert!(sessions(&s).await.is_empty());
    connections_until(&s, 0, Duration::from_secs(1)).await;
    // Every message stays queued, for the session's next connection.
    assert_eq!(s.state.relay.queued(), ids.len());
    assert!(events(&s, "?limit=500").await.iter().all(|e| e["status"] == "queued"));
    let (code, frames) = t.frames_until_closed().await;
    assert_eq!(code, 1008);
    assert!(frames.len() < ids.len() + 1, "queued frames are skipped once it closes");
}

#[tokio::test]
async fn an_offline_session_stays_with_its_device() {
    let s = server().await;
    let (mut a, _) = Client::online(&s, &s.desktop, "sess-a").await;
    let (mut t, _) = Client::online(&s, &s.laptop, "sess-t").await;
    a.send(send("c1", "sess-t", "for the laptop only")).await;
    let pushed = t.next().await;
    drop(t);
    sessions_until(&s, |items| ids(items) == ["sess-a"]).await;
    assert_eq!(a.next().await["status"], "queued");
    // Another device may not take the unrecorded session over, and gets none of its messages.
    let mut thief = Client::connect(&s, &s.desktop).await;
    thief.send(hello("sess-t")).await;
    assert_eq!(thief.frames_until_closed().await, (4403, vec![]));
    assert_eq!(ids(&sessions(&s).await), ["sess-a"]);
    // The owner comes back and gets its message.
    let (mut t, _) = Client::online(&s, &s.laptop, "sess-t").await;
    assert_eq!(t.next().await, pushed);
    t.send(json!({ "type": "ack", "id": pushed["id"] })).await;
    let status = a.next().await;
    assert_eq!((&status["type"], &status["status"]), (&json!("status"), &json!("delivered")));

    // A message is bound to the device that owned its target when it was accepted, even if another device records
    // the session later.
    let (mut t, _) = Client::online(&s, &s.laptop, "sess-u").await;
    a.send(send("c2", "sess-u", "still for the laptop")).await;
    assert_eq!(t.next().await["text"], "still for the laptop");
    drop(t);
    sessions_until(&s, |items| !ids(items).contains(&"sess-u")).await;
    record(&s.env.store, "sess-u", OTHER);
    let (mut other, _) = Client::online(&s, &s.desktop, "sess-u").await;
    assert_eq!(other.relay(send("c3", "nobody", "x")).await["reason"], "unknown_session", "nothing was pushed");

    // Without queued messages the owner is remembered for the TTL only.
    let ttl = Duration::from_secs(1);
    let s = server_with(|c| c.relay.ttl = ttl).await;
    let (t, _) = Client::online(&s, &s.laptop, "sess-t").await;
    drop(t);
    sessions_until(&s, |items| items.is_empty()).await;
    let offline = tokio::time::Instant::now();
    let mut thief = Client::connect(&s, &s.desktop).await;
    thief.send(hello("sess-t")).await;
    assert_eq!(thief.closed().await, 4403);
    assert!(offline.elapsed() < ttl, "{:?}", offline.elapsed());
    tokio::time::sleep_until(offline + ttl).await;
    Client::online(&s, &s.desktop, "sess-t").await;
}

#[tokio::test]
async fn each_device_has_a_rate_limit_across_its_sessions() {
    let s = server_with(|c| {
        c.relay.sends_per_minute = 3;
        c.relay.sends_per_minute_per_device = 5;
    })
    .await;
    record(&s.env.store, SESSION_ID, DEVICE);
    let mut laptop = Vec::new();
    for id in ["sess-a", "sess-b", "sess-c"] {
        laptop.push(Client::online(&s, &s.laptop, id).await.0);
    }
    let (mut d, _) = Client::online(&s, &s.desktop, "sess-d").await;
    let mut statuses = Vec::new();
    for (n, client) in [0, 0, 0, 0, 1, 1, 1, 2].into_iter().enumerate() {
        let sent = laptop[client].relay(send(&format!("c{n}"), SESSION_ID, "x")).await;
        statuses.push(sent.get("reason").unwrap_or(&sent["status"]).as_str().unwrap().to_owned());
    }
    // The first session hits its own limit; the device's limit then stops the others.
    let want = ["queued", "queued", "queued", "rate_limited", "queued", "queued", "rate_limited", "rate_limited"];
    assert_eq!(statuses, want);
    // Another device has its own budget.
    assert_eq!(d.relay(send("d0", SESSION_ID, "x")).await["status"], "queued");
}

#[tokio::test]
async fn a_sender_that_reconnects_during_the_ack_wait_gets_status() {
    let s = server_with(|c| c.relay.ack_wait = Duration::from_secs(30)).await;
    let (mut a, _) = Client::online(&s, &s.desktop, "sess-a").await;
    let (mut b, _) = Client::online(&s, &s.laptop, "sess-b").await;
    a.send(send("c1", "sess-b", "hi")).await;
    let message = b.next().await;
    let (mut a2, _) = Client::online(&s, &s.desktop, "sess-a").await;
    assert_eq!(a.closed().await, 4410);
    b.send(json!({ "type": "ack", "id": message["id"] })).await;
    let status = a2.next().await;
    assert_eq!(
        (&status["type"], &status["id"], &status["status"], &status["to"]["sessionId"]),
        (&json!("status"), &message["id"], &json!("delivered"), &json!("sess-b"))
    );
    assert_eq!(s.state.relay.pending_timers(), 0);
}

#[tokio::test]
async fn a_token_revoked_before_hello_closes_with_4401() {
    let s = server().await;
    let mut c = Client::connect(&s, &s.laptop).await;
    pika::auth::revoke_token(&s.env.store, DEVICE).unwrap();
    c.send(hello("sess-a")).await;
    assert_eq!(c.frames_until_closed().await, (4401, vec![]));
    assert!(sessions(&s).await.is_empty());
    connections_until(&s, 0, Duration::from_secs(1)).await;
}

#[tokio::test]
async fn continuing_a_device_closes_the_old_tokens_connections_at_once() {
    let s = server().await;
    let (mut old, _) = Client::online(&s, &s.laptop, "sess-a").await;
    let (_other, _) = Client::online(&s, &s.desktop, "sess-b").await;
    let started = http(&s.app, post("/api/pair/v1/start", json!({ "device": "Laptop" }), None)).await.json();
    let code = started["code"].as_str().unwrap();
    let r = http(&s.app, post(&format!("/api/v1/pairings/{code}/approve"), json!({ "continues": DEVICE }), None)).await;
    assert_eq!((r.status, r.json()), (StatusCode::OK, json!({ "device": DEVICE, "name": DEVICE, "continued": true })));
    // The old token works until the device collects the new one.
    assert_eq!(old.relay(send("c1", "nobody", "x")).await["reason"], "unknown_session");
    let polled = http(&s.app, post("/api/pair/v1/poll", json!({ "pairingId": started["pairingId"] }), None)).await;
    let token = polled.json()["token"].as_str().unwrap().to_owned();
    let collected = tokio::time::Instant::now();
    assert_eq!(old.closed().await, 4401);
    assert!(collected.elapsed() < Duration::from_secs(1), "{:?}", collected.elapsed());
    assert_eq!(ids(&sessions(&s).await), ["sess-b"]);
    // Ownership stays with the device id: the new token takes the session back.
    Client::online(&s, &token, "sess-a").await;
}

#[tokio::test]
async fn a_replacing_pairing_approved_before_the_upgrade_closes_the_old_tokens_connections_at_once() {
    let s = server().await;
    let (mut old, _) = Client::online(&s, &s.laptop, "sess-a").await;
    let (_other, _) = Client::online(&s, &s.desktop, "sess-b").await;
    // Approved under schema version 4: no target, the name is the device id, and `replace` takes over its token.
    let sql = "INSERT INTO pairings (id_hash, code, device, requested_at, expires_at, status, name, replace)
               VALUES (?1, 'ABCDEFGK', 'laptop again', 1, 9999999999999, 'approved', ?2, 1)";
    s.env.store.write(|tx| tx.execute(sql, [pika::util::sha256_hex(b"replace-id"), DEVICE.to_owned()])).unwrap();
    let polled = http(&s.app, post("/api/pair/v1/poll", json!({ "pairingId": "replace-id" }), None)).await.json();
    assert_eq!((&polled["status"], &polled["device"], &polled["continued"]), (&json!("approved"), &json!(DEVICE), &json!(true)));
    let collected = tokio::time::Instant::now();
    assert_eq!(old.closed().await, 4401);
    assert!(collected.elapsed() < Duration::from_secs(1), "{:?}", collected.elapsed());
    assert_eq!(ids(&sessions(&s).await), ["sess-b"]);
    Client::online(&s, polled["token"].as_str().unwrap(), "sess-a").await;
}

#[tokio::test]
async fn relay_objects_carry_device_names_that_follow_renames() {
    let s = server().await;
    // Named so that they sort the other way round from their ids.
    s.env.store.write(|tx| tx.execute_batch("UPDATE devices SET name = 'A laptop' WHERE id = 'laptop';
        UPDATE devices SET name = 'desk' WHERE id = 'desktop'")).unwrap();
    let (mut a, welcome) = Client::online(&s, &s.laptop, "sess-a").await;
    assert_eq!((&welcome["device"], &welcome["deviceName"]), (&json!(DEVICE), &json!("A laptop")));
    let (mut b, _) = Client::online(&s, &s.desktop, "sess-b").await;
    let items = sessions(&s).await;
    assert_eq!(ids(&items), ["sess-a", "sess-b"]);
    assert_eq!((&items[1]["device"], &items[1]["deviceName"]), (&json!(OTHER), &json!("desk")));

    a.send(send("c1", "sess-b", "hi")).await;
    let message = b.next().await;
    assert_eq!((&message["from"]["device"], &message["from"]["deviceName"]), (&json!(DEVICE), &json!("A laptop")));
    b.send(json!({ "type": "ack", "id": message["id"] })).await;
    let sent = a.next().await;
    assert_eq!((&sent["to"]["device"], &sent["to"]["deviceName"]), (&json!(OTHER), &json!("desk")));

    // A rename through the Devices route shows at once, in lists and in frames sent after it.
    let r = http(&s.app, patch(&format!("/api/v1/devices/{DEVICE}"), json!({ "name": "Zed laptop" }), None)).await;
    assert_eq!(r.status, StatusCode::OK);
    let items = sessions(&s).await;
    assert_eq!(ids(&items), ["sess-b", "sess-a"]);
    assert_eq!(items[1]["deviceName"], "Zed laptop");
    let event = &events(&s, "").await[0];
    assert_eq!((&event["from"]["deviceName"], &event["to"]["deviceName"]), (&json!("Zed laptop"), &json!("desk")));
    a.send(send("c2", "sess-b", "again")).await;
    assert_eq!(b.next().await["from"]["deviceName"], "Zed laptop");

    // So does one from `pika token rename` in another process, from the next list or send on.
    s.env.store.write(|tx| tx.execute("UPDATE devices SET name = 'Desk 2' WHERE id = 'desktop'", [])).unwrap();
    assert_eq!(sessions(&s).await[0]["deviceName"], "Desk 2");
    b.send(send("c3", "sess-a", "back")).await;
    assert_eq!(a.next().await["from"]["deviceName"], "Desk 2");

    // Equal names sort by device id.
    s.env.store.write(|tx| tx.execute("UPDATE devices SET name = 'same'", [])).unwrap();
    assert_eq!(ids(&sessions(&s).await), ["sess-b", "sess-a"]);
}

#[tokio::test]
async fn reply_to_must_be_a_message_id() {
    let s = server().await;
    let (mut a, _) = Client::online(&s, &s.laptop, "sess-a").await;
    for (reply_to, want) in [
        (json!("x".repeat(65)), "invalid"),
        (json!("not an id"), "invalid"),
        (json!("a.b"), "invalid"),
        (json!(""), "invalid"),
        (json!(7), "invalid"),
        (json!("Az09_-".repeat(10) + "abcd"), "unknown_session"),
        (Value::Null, "unknown_session"),
    ] {
        let mut frame = send("c", "nobody", "hi");
        frame["replyTo"] = reply_to.clone();
        assert_eq!(a.relay(frame).await["reason"], want, "{reply_to}");
    }
}

async fn timers_until(s: &Server, n: usize) {
    let deadline = tokio::time::Instant::now() + WAIT;
    while s.state.relay.pending_timers() != n {
        assert!(tokio::time::Instant::now() < deadline, "{} timers, not {n}", s.state.relay.pending_timers());
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
}

#[tokio::test]
async fn timers_end_with_their_messages() {
    let s = server().await;
    record(&s.env.store, SESSION_ID, DEVICE);
    let (mut a, _) = Client::online(&s, &s.desktop, "sess-a").await;
    let (mut b, _) = Client::online(&s, &s.laptop, "sess-b").await;
    // A send in its ack wait has two timers: its expiry and its ack wait.
    a.send(send("c", "sess-b", "x")).await;
    let message = b.next().await;
    assert_eq!((s.state.relay.queued(), s.state.relay.pending_timers()), (1, 2));
    b.send(json!({ "type": "ack", "id": message["id"] })).await;
    assert_eq!(a.next().await["status"], "delivered");
    timers_until(&s, 0).await;
    for n in 0..50 {
        a.send(send(&format!("c{n}"), "sess-b", "x")).await;
        let message = b.next().await;
        b.send(json!({ "type": "ack", "id": message["id"] })).await;
        assert_eq!(a.next().await["status"], "delivered");
    }
    timers_until(&s, 0).await;
    // A queued message has one: its expiry.
    for n in 0..5 {
        assert_eq!(a.relay(send(&format!("q{n}"), SESSION_ID, "x")).await["status"], "queued");
    }
    assert_eq!((s.state.relay.queued(), s.state.relay.pending_timers()), (5, 5));
    let (mut t, _) = Client::online(&s, &s.laptop, SESSION_ID).await;
    for _ in 0..5 {
        let message = t.next().await;
        t.send(json!({ "type": "ack", "id": message["id"] })).await;
        assert_eq!(a.next().await["status"], "delivered");
    }
    timers_until(&s, 0).await;
    assert_eq!(s.state.relay.queued(), 0);
}

/// `controls` control characters, which JSON escapes as six bytes each, then `pad` ASCII letters.
fn escaped_text(controls: usize, pad: usize) -> String {
    format!("{}{}", "\u{1}".repeat(controls), "x".repeat(pad))
}

#[tokio::test]
async fn a_message_frame_over_64_kib_is_too_large() {
    let s = server().await;
    let (mut a, _) = Client::online(&s, &s.laptop, "sess-a").await;
    let (mut b, _) = Client::online(&s, &s.desktop, "sess-b").await;
    // 32 KiB of text, but about 192 KiB once escaped.
    let controls = escaped_text(32 * 1024, 0);
    let web = http(&s.app, post("/api/v1/relay/messages", json!({ "to": "sess-b", "text": controls }), None)).await;
    assert_eq!((web.status, web.json()), (StatusCode::BAD_REQUEST, json!({ "error": "too_large" })));
    // A `send` frame within 64 KiB whose `message` frame, with the sender's details, is over it.
    // Sized for the longest frame below, the one with `hops` over the limit.
    let mut longest = send("c1", "sess-b", "");
    longest["hops"] = json!(129);
    let controls = escaped_text((64 * 1024 - longest.to_string().len()) / 6, 0);
    assert!(send("c1", "sess-b", &controls).to_string().len() <= 64 * 1024);
    assert_eq!(a.relay(send("c1", "sess-b", &controls)).await["reason"], "too_large");
    // In the same place in the order: after `self`, before the hops and the target.
    assert_eq!(a.relay(send("c2", "sess-a", &controls)).await["reason"], "self");
    let mut far = send("c3", "nobody", &controls);
    far["hops"] = json!(129);
    assert_eq!(a.relay(far).await["reason"], "too_large");
    let events = events(&s, "").await;
    assert_eq!(events.len(), 4);
    assert!(events.iter().all(|e| e["status"] == "rejected"), "{events:?}");

    // Escaped text that fits is delivered as it was sent, from a session and from the web.
    let fits = escaped_text(10 * 1024, 0);
    a.send(send("c4", "sess-b", &fits)).await;
    let message = b.next().await;
    assert_eq!((&message["type"], &message["text"]), (&json!("message"), &json!(fits)));
    b.send(json!({ "type": "ack", "id": message["id"] })).await;
    assert_eq!(a.next().await["status"], "delivered");
    let request = post("/api/v1/relay/messages", json!({ "to": "sess-b", "text": fits }), None);
    let app = s.app.clone();
    let posted = tokio::spawn(async move { http(&app, request).await });
    let message = b.next().await;
    assert_eq!((&message["from"], &message["text"]), (&json!({ "kind": "web" }), &json!(fits)));
    b.send(json!({ "type": "ack", "id": message["id"] })).await;
    assert_eq!(posted.await.unwrap().json()["status"], "delivered");
}

#[tokio::test]
async fn a_message_frame_of_exactly_64_kib_is_accepted() {
    let s = server_with(|c| c.relay.ack_wait = Duration::from_millis(1)).await;
    let (mut b, _) = Client::online(&s, &s.desktop, "sess-b").await;
    let web = |text: String| post("/api/v1/relay/messages", json!({ "to": "sess-b", "text": text }), None);
    // Message ids 1, 2, and 3 have the same length, so these frames differ only in their text.
    assert_eq!(http(&s.app, web("x".into())).await.status, StatusCode::OK);
    let overhead = b.next().await.to_string().len() - 1;
    let exact = escaped_text(10_000, 64 * 1024 - overhead - 60_000);
    assert_eq!(http(&s.app, web(exact.clone())).await.status, StatusCode::OK);
    let message = b.next().await;
    assert_eq!((message.to_string().len(), &message["text"]), (64 * 1024, &json!(exact)));
    let over = http(&s.app, web(exact + "x")).await;
    assert_eq!((over.status, over.json()), (StatusCode::BAD_REQUEST, json!({ "error": "too_large" })));
}

#[tokio::test]
async fn a_full_backlog_of_the_largest_frames_is_pushed_on_every_reconnect() {
    let s = server_with(|c| {
        c.relay.sends_per_minute = 1_000;
        c.relay.ack_wait = Duration::from_millis(1);
    })
    .await;
    record(&s.env.store, SESSION_ID, DEVICE);
    // The largest text each send allows: escaped control characters and padding up to a 64 KiB frame.
    let mut pad = 64 * 1024 - 60_000;
    let mut ids = Vec::new();
    while ids.len() < 100 {
        let text = escaped_text(10_000, pad);
        let r = http(&s.app, post("/api/v1/relay/messages", json!({ "to": SESSION_ID, "text": text }), None)).await;
        if r.status == StatusCode::BAD_REQUEST {
            assert_eq!(r.json(), json!({ "error": "too_large" }));
            pad -= 1;
            continue;
        }
        assert_eq!((r.status, &r.json()["status"]), (StatusCode::OK, &json!("queued")));
        ids.push(r.json()["id"].clone());
    }
    let web = http(&s.app, post("/api/v1/relay/messages", json!({ "to": SESSION_ID, "text": "x" }), None)).await;
    assert_eq!(web.json(), json!({ "error": "mailbox_full" }));
    for _ in 0..2 {
        let (mut t, _) = Client::online(&s, &s.laptop, SESSION_ID).await;
        let mut pushed = Vec::new();
        for _ in 0..100 {
            let message = t.next().await;
            assert_eq!((&message["type"], message.to_string().len()), (&json!("message"), 64 * 1024));
            pushed.push(message["id"].clone());
        }
        assert_eq!(pushed, ids);
        // Still open: it answers a send.
        assert_eq!(t.relay(send("c1", "nobody", "x")).await["reason"], "unknown_session");
        drop(t);
        sessions_until(&s, |items| items.is_empty()).await;
    }
    assert_eq!(s.state.relay.queued(), 100);
}

#[tokio::test]
async fn the_oldest_remembered_owners_are_forgotten_first() {
    let s = server_with(|c| c.relay.max_remembered = 2).await;
    for id in ["sess-1", "sess-2", "sess-3"] {
        let (t, _) = Client::online(&s, &s.laptop, id).await;
        drop(t);
        sessions_until(&s, |items| items.is_empty()).await;
    }
    assert_eq!(s.state.relay.remembered(), 2);
    // The oldest owner is forgotten, so another device may take its session; the others still may not.
    let (_one, _) = Client::online(&s, &s.desktop, "sess-1").await;
    for id in ["sess-2", "sess-3"] {
        let mut thief = Client::connect(&s, &s.desktop).await;
        thief.send(hello(id)).await;
        assert_eq!(thief.closed().await, 4403, "{id}");
    }
    // Coming back online forgets the owner; going offline again makes it the newest.
    let (t, _) = Client::online(&s, &s.laptop, "sess-2").await;
    assert_eq!(s.state.relay.remembered(), 1);
    drop(t);
    sessions_until(&s, |items| ids(items) == ["sess-1"]).await;
    let (_four, _) = Client::online(&s, &s.laptop, "sess-4").await;
    let (t, _) = Client::online(&s, &s.laptop, "sess-5").await;
    drop(t);
    sessions_until(&s, |items| !ids(items).contains(&"sess-5")).await;
    assert_eq!(s.state.relay.remembered(), 2);
    let (_three, _) = Client::online(&s, &s.desktop, "sess-3").await;
    let mut thief = Client::connect(&s, &s.desktop).await;
    thief.send(hello("sess-2")).await;
    assert_eq!(thief.closed().await, 4403);

    // Expired owners are forgotten by the next send or hello, without another session going offline.
    let ttl = Duration::from_millis(300);
    let s = server_with(|c| c.relay.ttl = ttl).await;
    let (t, _) = Client::online(&s, &s.laptop, "sess-t").await;
    drop(t);
    sessions_until(&s, |items| items.is_empty()).await;
    assert_eq!(s.state.relay.remembered(), 1);
    tokio::time::sleep(ttl).await;
    assert_eq!(s.state.relay.remembered(), 1);
    let r = http(&s.app, post("/api/v1/relay/messages", json!({ "to": "nobody", "text": "x" }), None)).await;
    assert_eq!(r.json(), json!({ "error": "unknown_session" }));
    assert_eq!(s.state.relay.remembered(), 0);
}

#[tokio::test]
async fn chatrooms_sync_agents_across_repos_and_only_notify_mentioned_members() {
    let s = server().await;
    // Three sessions across different repos: sess-a (backend), sess-b (web-app), sess-c (docs).
    let (mut a, _) = Client::online(&s, &s.laptop, "sess-a").await;
    let (mut b, _) = Client::online(&s, &s.desktop, "sess-b").await;
    let (mut c, _) = Client::online(&s, &s.laptop, "sess-c").await;

    // No implicit rooms exist initially.
    let list = http(&s.app, get("/api/relay/v1/rooms", Some(&s.laptop), None)).await;
    assert_eq!((list.status, list.json()), (StatusCode::OK, json!({ "items": [] })));

    // Explicitly create/join #auth-sync from the browser route with sess-a, sess-b, sess-c.
    let created = http(
        &s.app,
        post(
            "/api/v1/relay/rooms",
            json!({
                "name": "#auth-sync",
                "topic": "Coordinate token schema across repos",
                "members": ["sess-a", "sess-b", "sess-c"],
            }),
            None,
        ),
    )
    .await;
    assert_eq!(created.status, StatusCode::OK);
    assert_eq!(created.json()["room"]["name"], "auth-sync");
    assert_eq!(created.json()["room"]["topic"], "Coordinate token schema across repos");
    assert_eq!(created.json()["room"]["members"].as_array().unwrap().len(), 3);

    // 1. sess-a posts a status update without @mentions: recorded in room history, nobody gets a pushed message frame.
    let sent1 = a
        .relay(json!({
            "type": "send",
            "clientId": "r1",
            "room": "auth-sync",
            "text": "Starting backend schema migration.",
            "hops": 1,
        }))
        .await;
    assert_eq!(
        (&sent1["status"], &sent1["room"], &sent1["notified"]),
        (&json!("delivered"), &json!("auth-sync"), &json!([]))
    );
    assert_eq!(s.state.relay.queued(), 0);

    // 2. sess-a posts mentioning @name-sess-b: only sess-b receives a pushed message frame; sess-c is not interrupted.
    a.send(json!({
        "type": "send",
        "clientId": "r2",
        "room": "#auth-sync",
        "text": "Hey @name-sess-b I updated the payload fields, please check.",
        "hops": 1,
    }))
    .await;
    let sent2 = a.next().await;
    assert_eq!(sent2["type"], "sent");
    assert_eq!(sent2["room"], "auth-sync");
    assert_eq!(sent2["notified"].as_array().unwrap().len(), 1);
    assert_eq!(sent2["notified"][0]["sessionId"], "sess-b");

    let pushed_b = b.next().await;
    assert_eq!(
        (&pushed_b["type"], &pushed_b["room"], &pushed_b["mentions"], &pushed_b["from"]["sessionId"]),
        (&json!("message"), &json!("auth-sync"), &json!(["sess-b"]), &json!("sess-a"))
    );
    b.send(json!({ "type": "ack", "id": pushed_b["id"] })).await;

    // 3. Any agent (such as sess-c, which was not notified) can read the full room history on demand.
    let detail = http(&s.app, get("/api/relay/v1/rooms/auth-sync", Some(&s.laptop), None)).await;
    assert_eq!(detail.status, StatusCode::OK);
    let msgs = detail.json()["messages"].as_array().unwrap().clone();
    assert_eq!(msgs.len(), 2);
    assert_eq!((&msgs[0]["seq"], &msgs[0]["text"], &msgs[0]["mentions"]), (&json!(1), &json!("Starting backend schema migration."), &json!([])));
    assert_eq!((&msgs[1]["seq"], &msgs[1]["mentions"]), (&json!(2), &json!(["sess-b"])));

    // 4. Web UI posts to the room with explicit `mentions: ["sess-c"]`; only sess-c is notified.
    let web_post = http(
        &s.app,
        post(
            "/api/v1/relay/messages",
            json!({
                "room": "auth-sync",
                "text": "Please document the new fields.",
                "mentions": ["sess-c"],
                "urgent": true,
            }),
            None,
        ),
    )
    .await;
    assert_eq!(web_post.status, StatusCode::OK);
    assert_eq!(web_post.json()["room"], "auth-sync");
    assert_eq!(web_post.json()["notified"][0]["sessionId"], "sess-c");

    let pushed_c = c.next().await;
    assert_eq!(
        (&pushed_c["room"], &pushed_c["from"], &pushed_c["urgent"]),
        (&json!("auth-sync"), &json!({ "kind": "web" }), &json!(true))
    );
    c.send(json!({ "type": "ack", "id": pushed_c["id"] })).await;

    // 5. Leaving and deleting the room works cleanly.
    let leave_req = Request::builder()
        .method(Method::POST)
        .uri("/api/relay/v1/rooms")
        .header("content-type", "application/json")
        .header("authorization", format!("Bearer {}", s.laptop))
        .body(Body::from(json!({ "room": "auth-sync", "sessionId": "sess-c", "action": "leave" }).to_string()))
        .unwrap();
    let left = http(&s.app, leave_req).await;
    assert_eq!(left.status, StatusCode::OK);
    assert_eq!(left.json()["room"]["members"].as_array().unwrap().len(), 2);

    let deleted = http(&s.app, with_body(Method::DELETE, "/api/v1/relay/rooms/auth-sync", json!({}), None)).await;
    assert_eq!(deleted.status, StatusCode::NO_CONTENT);
    let list_after = http(&s.app, get("/api/v1/relay/rooms", None, None)).await;
    assert_eq!(list_after.json()["items"], json!([]));
}

/// `POST {base}/api/relay/v1/rooms` as the device of `token`.
async fn room_action(s: &Server, token: Option<&str>, body: Value) -> Reply {
    let mut request = Request::builder()
        .method(Method::POST)
        .uri(format!("{}/api/relay/v1/rooms", s.base))
        .header("content-type", "application/json");
    if let Some(token) = token {
        request = request.header("authorization", format!("Bearer {token}"));
    }
    http(&s.app, request.body(Body::from(body.to_string())).unwrap()).await
}

/// Reads the next `room` frame of each client and checks that it names `representative`, or nobody.
async fn heard(clients: &mut [&mut Client], representative: Option<&str>) {
    for client in clients.iter_mut() {
        let frame = client.next().await;
        assert_eq!((&frame["type"], &frame["room"]), (&json!("room"), &json!("team")), "{frame}");
        assert_eq!(frame.get("representative").and_then(Value::as_str), representative, "{frame}");
        assert!(frame["at"].as_str().is_some_and(|at| at.ends_with('Z')), "{frame}");
    }
}

fn member_ids(room: &Value) -> Vec<&str> {
    room["members"].as_array().unwrap().iter().map(|m| m["sessionId"].as_str().unwrap()).collect()
}

#[tokio::test]
async fn a_room_has_one_representative_and_its_online_members_hear_each_change() {
    let s = server().await;
    let (mut a, _) = Client::online(&s, &s.laptop, "sess-a").await;
    let (mut b, _) = Client::online(&s, &s.desktop, "sess-b").await;
    let (mut c, _) = Client::online(&s, &s.laptop, "sess-c").await;
    let (mut outsider, _) = Client::online(&s, &s.laptop, "sess-x").await;
    for (id, token) in [("sess-a", &s.laptop), ("sess-b", &s.desktop)] {
        let joined = room_action(&s, Some(token), json!({ "room": "team", "sessionId": id })).await;
        assert_eq!(joined.status, StatusCode::OK);
        assert!(joined.json()["room"].get("representative").is_none(), "nobody represents a new room");
    }

    // A member represents the room; its online members hear it, a session outside it does not.
    let body = json!({ "room": "#team", "sessionId": "sess-b", "action": "represent" });
    let represented = room_action(&s, Some(&s.desktop), body).await;
    assert_eq!(represented.status, StatusCode::OK);
    assert_eq!(represented.json()["room"]["representative"], "sess-b");
    assert!(represented.json()["messages"].is_array(), "the room detail, as for join");
    heard(&mut [&mut a, &mut b], Some("sess-b")).await;

    // A session that is not a member becomes one and replaces the representative.
    let body = json!({ "room": "team", "sessionId": "sess-c", "action": "represent" });
    let replaced = room_action(&s, Some(&s.laptop), body).await;
    assert_eq!(replaced.status, StatusCode::OK);
    assert_eq!(replaced.json()["room"]["representative"], "sess-c");
    assert_eq!(member_ids(&replaced.json()["room"]), ["sess-a", "sess-b", "sess-c"]);
    heard(&mut [&mut a, &mut b, &mut c], Some("sess-c")).await;

    // Every room summary carries it: the device and browser lists and details.
    for (path, token) in [("/api/relay/v1/rooms", Some(s.laptop.as_str())), ("/api/v1/relay/rooms", None)] {
        let list = http(&s.app, get(path, token, None)).await;
        assert_eq!(list.json()["items"][0]["representative"], "sess-c", "{path}");
    }
    for (path, token) in [("/api/relay/v1/rooms/team", Some(s.laptop.as_str())), ("/api/v1/relay/rooms/team", None)] {
        let detail = http(&s.app, get(path, token, None)).await;
        assert_eq!(detail.json()["room"]["representative"], "sess-c", "{path}");
    }

    // `unrepresent` by another member, and `represent` by the representative, change nothing and push nothing.
    let body = json!({ "room": "team", "sessionId": "sess-a", "action": "unrepresent" });
    let unchanged = room_action(&s, Some(&s.laptop), body).await;
    assert_eq!((unchanged.status, &unchanged.json()["room"]["representative"]), (StatusCode::OK, &json!("sess-c")));
    let body = json!({ "room": "team", "sessionId": "sess-c", "action": "represent" });
    let unchanged = room_action(&s, Some(&s.laptop), body).await;
    assert_eq!(unchanged.json()["room"]["representative"], "sess-c");

    // The representative stops representing and stays a member; the next frame each member gets says so.
    let body = json!({ "room": "team", "sessionId": "sess-c", "action": "unrepresent" });
    let cleared = room_action(&s, Some(&s.laptop), body).await;
    assert_eq!(cleared.status, StatusCode::OK);
    assert!(cleared.json()["room"].get("representative").is_none(), "{}", cleared.json());
    assert_eq!(member_ids(&cleared.json()["room"]), ["sess-a", "sess-b", "sess-c"]);
    heard(&mut [&mut a, &mut b, &mut c], None).await;

    // A representative that leaves stops representing, and hears it with the members that stay.
    room_action(&s, Some(&s.laptop), json!({ "room": "team", "sessionId": "sess-a", "action": "represent" })).await;
    heard(&mut [&mut a, &mut b, &mut c], Some("sess-a")).await;
    let body = json!({ "room": "team", "sessionId": "sess-a", "action": "leave" });
    let left = room_action(&s, Some(&s.laptop), body).await;
    assert!(left.json()["room"].get("representative").is_none(), "{}", left.json());
    assert_eq!(member_ids(&left.json()["room"]), ["sess-b", "sess-c"]);
    heard(&mut [&mut a, &mut b, &mut c], None).await;

    // So does one the browser removes.
    room_action(&s, Some(&s.desktop), json!({ "room": "team", "sessionId": "sess-b", "action": "represent" })).await;
    heard(&mut [&mut b, &mut c], Some("sess-b")).await;
    let body = json!({ "sessionId": "sess-b", "action": "remove" });
    let removed = http(&s.app, post("/api/v1/relay/rooms/team/members", body, None)).await;
    assert!(removed.json()["room"].get("representative").is_none(), "{}", removed.json());
    heard(&mut [&mut b, &mut c], None).await;

    // Deleting a represented room tells its members that nobody represents it.
    room_action(&s, Some(&s.laptop), json!({ "room": "team", "sessionId": "sess-c", "action": "represent" })).await;
    heard(&mut [&mut c], Some("sess-c")).await;
    let deleted = http(&s.app, with_body(Method::DELETE, "/api/v1/relay/rooms/team", json!({}), None)).await;
    assert_eq!(deleted.status, StatusCode::NO_CONTENT);
    heard(&mut [&mut c], None).await;

    // Sessions outside the room heard nothing: their next frame is a message sent now.
    for (client, to) in [(&mut a, "sess-a"), (&mut outsider, "sess-x")] {
        b.send(send(to, to, "after the room")).await;
        let frame = client.next().await;
        assert_eq!((&frame["type"], &frame["text"]), (&json!("message"), &json!("after the room")), "{frame}");
    }
    assert_eq!(s.state.relay.queued(), 2, "room frames never enter the mailbox");
}

#[tokio::test]
async fn representing_follows_the_rules_of_joining_and_leaving() {
    let s = server().await;
    record(&s.env.store, "sess-recorded", DEVICE);
    let represent = |id: &str, room: &str| json!({ "room": room, "sessionId": id, "action": "represent" });

    let unauthorized = room_action(&s, None, represent("sess-recorded", "team")).await;
    assert_eq!(unauthorized.status, StatusCode::UNAUTHORIZED);
    for (body, status, reason) in [
        (json!({ "room": "team", "sessionId": "sess-recorded", "action": "elect" }), 400, "invalid"),
        (represent("nobody", "team"), 400, "unknown_session"),
        (represent("sess-recorded", "bad room"), 400, "invalid"),
        (json!({ "room": "missing", "sessionId": "sess-recorded", "action": "unrepresent" }), 400, "invalid"),
    ] {
        let r = room_action(&s, Some(&s.laptop), body.clone()).await;
        assert_eq!((r.status.as_u16(), &r.json()["error"]), (status, &json!(reason)), "{body}");
    }
    let r = http(&s.app, get("/api/v1/relay/rooms", None, None)).await;
    assert_eq!(r.json()["items"], json!([]), "a refused represent creates no room");

    // A recorded session that is offline may represent, as it may join; that creates the room.
    let represented = room_action(&s, Some(&s.laptop), represent("sess-recorded", "team")).await;
    assert_eq!(represented.status, StatusCode::OK);
    let room = &represented.json()["room"];
    assert_eq!((&room["name"], &room["representative"]), (&json!("team"), &json!("sess-recorded")));
    assert_eq!((member_ids(room), &room["members"][0]["online"]), (vec!["sess-recorded"], &json!(false)));

    // An online member hears a change; nobody else is around to.
    let (mut a, _) = Client::online(&s, &s.laptop, "sess-a").await;
    room_action(&s, Some(&s.laptop), json!({ "room": "team", "sessionId": "sess-a" })).await;
    room_action(&s, Some(&s.laptop), json!({ "room": "team", "sessionId": "sess-recorded", "action": "leave" })).await;
    heard(&mut [&mut a], None).await;
}

/// Checks that each body, sent as the device of `token`, is refused with `status` and `reason`.
async fn refused_room_actions(s: &Server, token: &str, bodies: &[Value], status: u16, reason: &str) {
    for body in bodies {
        let r = room_action(s, Some(token), body.clone()).await;
        assert_eq!((r.status.as_u16(), r.json()), (status, json!({ "error": reason })), "{body}");
    }
}

#[tokio::test]
async fn a_device_acts_in_rooms_only_for_the_sessions_it_owns() {
    let s = server().await;
    let action = |id: &str, action: &str| json!({ "room": "team", "sessionId": id, "action": action });
    let all = |id: &str| ["join", "leave", "represent", "unrepresent"].map(|a| action(id, a));
    let room = || async { http(&s.app, get("/api/v1/relay/rooms/team", None, None)).await.json()["room"].clone() };
    // Members joining in the same millisecond sort by id, so compare them as sets.
    let set = |ids: &[&str]| ids.iter().map(|id| id.to_string()).collect::<std::collections::BTreeSet<String>>();
    let members = |room: &Value| set(&member_ids(room));
    let (mut l, _) = Client::online(&s, &s.laptop, "sess-l").await;
    let (mut d, _) = Client::online(&s, &s.desktop, "sess-d").await;

    // The laptop may not act for the desktop's online session; a refused join or represent creates no room.
    refused_room_actions(&s, &s.laptop, &all("sess-d"), 403, "not_owner").await;
    let r = http(&s.app, get("/api/v1/relay/rooms", None, None)).await;
    assert_eq!(r.json()["items"], json!([]), "a refused action creates no room");

    // Each action works from the owning device.
    for (token, id) in [(&s.desktop, "sess-d"), (&s.laptop, "sess-l")] {
        let joined = room_action(&s, Some(token), action(id, "join")).await;
        assert_eq!(joined.status, StatusCode::OK, "{id}");
    }
    let represented = room_action(&s, Some(&s.desktop), action("sess-d", "represent")).await;
    assert_eq!(represented.status, StatusCode::OK);
    assert_eq!(represented.json()["room"]["representative"], "sess-d");
    heard(&mut [&mut l, &mut d], Some("sess-d")).await;

    // From another device, every action is refused and changes nothing.
    refused_room_actions(&s, &s.laptop, &all("sess-d"), 403, "not_owner").await;
    refused_room_actions(&s, &s.desktop, &all("sess-l"), 403, "not_owner").await;
    let unchanged = room().await;
    assert_eq!((members(&unchanged), &unchanged["representative"]), (set(&["sess-d", "sess-l"]), &json!("sess-d")));

    let cleared = room_action(&s, Some(&s.desktop), action("sess-d", "unrepresent")).await;
    assert_eq!(cleared.status, StatusCode::OK);
    assert!(cleared.json()["room"].get("representative").is_none(), "{}", cleared.json());
    heard(&mut [&mut l, &mut d], None).await;
    let left = room_action(&s, Some(&s.desktop), action("sess-d", "leave")).await;
    assert_eq!((left.status, members(&left.json()["room"])), (StatusCode::OK, set(&["sess-l"])));

    // A recorded owner counts while the session is offline, and a remembered one after it went offline.
    record(&s.env.store, "sess-recorded", OTHER);
    refused_room_actions(&s, &s.laptop, &all("sess-recorded"), 403, "not_owner").await;
    let joined = room_action(&s, Some(&s.desktop), action("sess-recorded", "join")).await;
    assert_eq!((joined.status, members(&joined.json()["room"])), (StatusCode::OK, set(&["sess-l", "sess-recorded"])));
    let (gone, _) = Client::online(&s, &s.desktop, "sess-gone").await;
    room_action(&s, Some(&s.desktop), action("sess-gone", "join")).await;
    drop(gone);
    sessions_until(&s, |items| !ids(items).contains(&"sess-gone")).await;
    refused_room_actions(&s, &s.laptop, &all("sess-gone"), 403, "not_owner").await;
    assert_eq!(members(&room().await), set(&["sess-l", "sess-recorded", "sess-gone"]));
    let left = room_action(&s, Some(&s.desktop), action("sess-gone", "leave")).await;
    assert_eq!((left.status, members(&left.json()["room"])), (StatusCode::OK, set(&["sess-l", "sess-recorded"])));

    // An id that nobody owns is still unknown, for every action.
    refused_room_actions(&s, &s.laptop, &all("nobody"), 400, "unknown_session").await;

    // The browser, as the user, may act for any device's session.
    let path = "/api/v1/relay/rooms/team/members";
    let added = http(&s.app, post(path, json!({ "sessionId": "sess-d" }), None)).await;
    let (status, detail) = (added.status, added.json());
    assert_eq!((status, members(&detail["room"])), (StatusCode::OK, set(&["sess-l", "sess-recorded", "sess-d"])));
    let removed = http(&s.app, post(path, json!({ "sessionId": "sess-d", "action": "remove" }), None)).await;
    assert_eq!(removed.status, StatusCode::OK);

    // No refused action pushed a frame: each member's next frame is a message sent now.
    let (mut x, _) = Client::online(&s, &s.laptop, "sess-x").await;
    for (client, to) in [(&mut l, "sess-l"), (&mut d, "sess-d")] {
        x.send(send(to, to, "after the room")).await;
        let frame = client.next().await;
        assert_eq!((&frame["type"], &frame["text"]), (&json!("message"), &json!("after the room")), "{frame}");
    }
}

fn room_post(client_id: &str, room: &str, text: &str) -> Value {
    json!({ "type": "send", "clientId": client_id, "room": room, "text": text, "hops": 1 })
}

/// Creates room `name` from the browser with `members`.
async fn create_room(s: &Server, name: &str, members: &[&str]) {
    let r = http(&s.app, post("/api/v1/relay/rooms", json!({ "name": name, "members": members }), None)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.json());
}

async fn room_detail(s: &Server, name: &str) -> Value {
    let r = http(&s.app, get(&format!("/api/v1/relay/rooms/{name}"), None, None)).await;
    assert_eq!(r.status, StatusCode::OK);
    r.json()
}

#[tokio::test]
async fn a_post_to_a_room_that_does_not_exist_is_refused_and_creates_none() {
    let s = server().await;
    let (mut a, _) = Client::online(&s, &s.laptop, "sess-a").await;
    let (_b, _) = Client::online(&s, &s.desktop, "sess-b").await;
    let sent = a.relay(room_post("r1", "#nowhere", "hello @name-sess-b")).await;
    assert_eq!(sent, json!({ "type": "sent", "clientId": "r1", "status": "rejected", "reason": "unknown_room" }));
    let web = http(&s.app, post("/api/v1/relay/messages", json!({ "room": "nowhere", "text": "hi" }), None)).await;
    assert_eq!((web.status, web.json()), (StatusCode::NOT_FOUND, json!({ "error": "unknown_room" })));
    // A bad name is still `invalid`, checked first.
    let sent = a.relay(room_post("r2", "bad room", "hi")).await;
    assert_eq!(sent["reason"], "invalid");

    let rooms = http(&s.app, get("/api/v1/relay/rooms", None, None)).await;
    assert_eq!(rooms.json()["items"], json!([]), "posting creates no room");
    let events = events(&s, "").await;
    let refused: Vec<(&Value, &Value, &Value)> =
        events.iter().map(|e| (&e["status"], &e["reason"], &e["room"])).collect();
    let unknown = (&json!("rejected"), &json!("unknown_room"), &json!("nowhere"));
    assert_eq!(refused[1..], [unknown, unknown], "{events:?}");
    assert_eq!(s.state.relay.queued(), 0);
}

#[tokio::test]
async fn a_session_posts_only_to_rooms_it_is_a_member_of() {
    let s = server().await;
    let (mut a, _) = Client::online(&s, &s.laptop, "sess-a").await;
    let (mut b, _) = Client::online(&s, &s.desktop, "sess-b").await;
    let (mut x, _) = Client::online(&s, &s.laptop, "sess-x").await;
    create_room(&s, "team", &["sess-a", "sess-b"]).await;

    // An outsider's post is refused: the room stores nothing and gains no member, and nothing is pushed.
    let sent = x.relay(room_post("r1", "team", "@all and @sess-a, hello")).await;
    assert_eq!(sent, json!({ "type": "sent", "clientId": "r1", "status": "rejected", "reason": "not_member" }));
    let detail = room_detail(&s, "team").await;
    assert_eq!(member_ids(&detail["room"]), ["sess-a", "sess-b"]);
    assert_eq!((&detail["room"]["messageCount"], &detail["messages"]), (&json!(0), &json!([])));
    assert_eq!(s.state.relay.queued(), 0);
    let event = &events(&s, "?limit=1").await[0];
    let seen = (&event["status"], &event["reason"], &event["room"]);
    assert_eq!(seen, (&json!("rejected"), &json!("not_member"), &json!("team")), "{event}");

    // Each member's next frame is a post made after the refused one.
    b.relay(room_post("p1", "team", "@sess-a after")).await;
    let frame = a.next().await;
    assert_eq!((&frame["type"], &frame["text"]), (&json!("message"), &json!("@sess-a after")), "{frame}");
    a.send(json!({ "type": "ack", "id": frame["id"] })).await;
    a.relay(room_post("p2", "team", "@sess-b after")).await;
    let frame = b.next().await;
    assert_eq!((&frame["type"], &frame["text"]), (&json!("message"), &json!("@sess-b after")), "{frame}");
    b.send(json!({ "type": "ack", "id": frame["id"] })).await;

    // Once the user adds it, it may post; after it leaves, it may not.
    let added = http(&s.app, post("/api/v1/relay/rooms/team/members", json!({ "sessionId": "sess-x" }), None)).await;
    assert_eq!(added.status, StatusCode::OK);
    let sent = x.relay(room_post("r2", "team", "joined")).await;
    assert_eq!((&sent["status"], &sent["room"]), (&json!("delivered"), &json!("team")), "{sent}");
    let leave = json!({ "room": "team", "sessionId": "sess-x", "action": "leave" });
    assert_eq!(room_action(&s, Some(&s.laptop), leave).await.status, StatusCode::OK);
    let sent = x.relay(room_post("r3", "team", "gone")).await;
    assert_eq!(sent["reason"], "not_member");
    let detail = room_detail(&s, "team").await;
    let texts: Vec<&Value> = detail["messages"].as_array().unwrap().iter().map(|m| &m["text"]).collect();
    assert_eq!(texts, ["@sess-a after", "@sess-b after", "joined"]);
}

#[tokio::test]
async fn mentions_reach_only_members_and_the_others_come_back_unmatched() {
    let s = server().await;
    let (mut a, _) = Client::online(&s, &s.laptop, "sess-a").await;
    let (mut b, _) = Client::online(&s, &s.desktop, "sess-b").await;
    let (mut x, _) = Client::online(&s, &s.laptop, "sess-x").await;
    create_room(&s, "team", &["sess-a", "sess-b"]).await;

    // An online non-member named by id or by name is neither notified nor added.
    let sent = a
        .relay(json!({ "type": "send", "clientId": "m1", "room": "team", "mentions": ["sess-x"], "hops": 1,
            "text": "@name-sess-b and @name-sess-x, see @nobody" }))
        .await;
    assert_eq!(sent["status"], "delivered", "{sent}");
    let notified: Vec<&Value> = sent["notified"].as_array().unwrap().iter().map(|t| &t["sessionId"]).collect();
    assert_eq!(notified, ["sess-b"]);
    assert_eq!(sent["unmatched"], json!(["sess-x", "name-sess-x", "nobody"]));
    let pushed = b.next().await;
    assert_eq!((&pushed["type"], &pushed["mentions"]), (&json!("message"), &json!(["sess-b"])), "{pushed}");
    b.send(json!({ "type": "ack", "id": pushed["id"] })).await;
    let detail = room_detail(&s, "team").await;
    assert_eq!(member_ids(&detail["room"]), ["sess-a", "sess-b"]);
    assert_eq!(detail["messages"][0]["mentions"], json!(["sess-b"]));

    // `@all` reaches every member but the sender; neither it nor the sender's own name is unmatched.
    let sent = a.relay(room_post("m2", "team", "@all, from @name-sess-a")).await;
    let notified: Vec<&Value> = sent["notified"].as_array().unwrap().iter().map(|t| &t["sessionId"]).collect();
    assert_eq!(notified, ["sess-b"]);
    assert!(sent.get("unmatched").is_none(), "{sent}");
    let pushed = b.next().await;
    assert_eq!(pushed["text"], "@all, from @name-sess-a");
    b.send(json!({ "type": "ack", "id": pushed["id"] })).await;

    // The non-member heard nothing: its next frame is a message sent now.
    a.send(send("p1", "sess-x", "after the room")).await;
    let frame = x.next().await;
    assert_eq!((&frame["type"], &frame["text"]), (&json!("message"), &json!("after the room")), "{frame}");
}

#[tokio::test]
async fn the_web_posts_to_any_existing_room() {
    let s = server().await;
    let (mut a, _) = Client::online(&s, &s.laptop, "sess-a").await;
    let (_x, _) = Client::online(&s, &s.desktop, "sess-x").await;
    create_room(&s, "team", &["sess-a"]).await;
    create_room(&s, "empty", &[]).await;

    let body = json!({ "room": "#team", "text": "@name-sess-a please look, cc @sess-x" });
    let r = http(&s.app, post("/api/v1/relay/messages", body, None)).await;
    assert_eq!(r.status, StatusCode::OK);
    let posted = r.json();
    let seen = (&posted["status"], &posted["room"], &posted["notified"][0]["sessionId"], &posted["unmatched"]);
    assert_eq!(seen, (&json!("delivered"), &json!("team"), &json!("sess-a"), &json!(["sess-x"])), "{posted}");
    let pushed = a.next().await;
    assert_eq!((&pushed["room"], &pushed["from"]), (&json!("team"), &json!({ "kind": "web" })), "{pushed}");
    a.send(json!({ "type": "ack", "id": pushed["id"] })).await;
    let detail = room_detail(&s, "team").await;
    assert_eq!(member_ids(&detail["room"]), ["sess-a"], "the web joins nothing, and adds nobody");
    assert_eq!(detail["messages"][0]["from"], json!({ "kind": "web" }));

    // A room without members takes the post too.
    let r = http(&s.app, post("/api/v1/relay/messages", json!({ "room": "empty", "text": "note" }), None)).await;
    assert_eq!((r.status, &r.json()["notified"]), (StatusCode::OK, &json!([])));
    assert!(r.json().get("unmatched").is_none());
    assert_eq!(room_detail(&s, "empty").await["room"]["messageCount"], 1);
}

#[test]
fn schema_v18_migrates_from_v17_without_a_reindex() {
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");
    {
        let store = Store::open(&data).unwrap();
        common::device(&store, DEVICE);
        record(&store, SESSION_ID, DEVICE);
    }
    let conn = rusqlite::Connection::open(data.join("pika.db")).unwrap();
    conn.execute_batch(&format!("{UNDO_V18} PRAGMA user_version = 17;")).unwrap();
    drop(conn);

    let store = Store::open(&data).unwrap();
    assert_eq!(one(&store, "PRAGMA user_version")["user_version"], json!(18));
    assert_eq!(store.setting(pika::store::NEEDS_REINDEX).unwrap(), None);
    assert!(!pika::store::DERIVED_TABLES.iter().any(|t| t.starts_with("relay_")));
    for table in ["relay_rooms", "relay_room_members", "relay_room_messages", "relay_events", "relay_mailbox"] {
        assert_eq!(one(&store, &format!("SELECT COUNT(*) AS n FROM {table}"))["n"], json!(0), "{table}");
    }
    assert_eq!(one(&store, "SELECT COUNT(*) AS n FROM sessions")["n"], json!(1));
}

#[tokio::test]
async fn chatrooms_members_representatives_messages_and_deletions_survive_restarts() {
    let s = server_with(|c| {
        c.relay.sends_per_minute = 1_000;
        c.relay.sends_per_minute_per_device = 1_000;
    })
    .await;
    s.env
        .store
        .write(|tx| {
            tx.execute_batch(
                "UPDATE devices SET name = 'Old Laptop' WHERE id = 'laptop';
                 UPDATE devices SET name = 'Old Desk' WHERE id = 'desktop';",
            )
        })
        .unwrap();
    record(&s.env.store, "sess-rec", OTHER);

    let (mut a, _) = Client::online(&s, &s.laptop, "sess-a").await;
    let (mut b, _) = Client::online(&s, &s.desktop, "sess-b").await;
    let (_c, _) = Client::online(&s, &s.laptop, "sess-c").await;

    // Invalid/unknown members in `save_room` fail before any room or member is created or mutated.
    let bad_create = http(
        &s.app,
        post("/api/v1/relay/rooms", json!({ "name": "atomic-check", "members": ["sess-a", "nobody"] }), None),
    )
    .await;
    assert_eq!(bad_create.status, StatusCode::BAD_REQUEST);
    assert_eq!(http(&s.app, get("/api/v1/relay/rooms/atomic-check", None, None)).await.status, StatusCode::NOT_FOUND);

    let created = http(
        &s.app,
        post(
            "/api/v1/relay/rooms",
            json!({
                "name": "#auth-sync",
                "topic": "Coordinate token schema",
                "members": ["sess-a", "sess-b", "sess-rec"],
            }),
            None,
        ),
    )
    .await;
    assert_eq!(created.status, StatusCode::OK);

    let bad_update = http(
        &s.app,
        post(
            "/api/v1/relay/rooms",
            json!({ "name": "auth-sync", "topic": "Should not apply", "members": ["sess-c", "nobody"] }),
            None,
        ),
    )
    .await;
    assert_eq!(bad_update.status, StatusCode::BAD_REQUEST);
    assert_eq!(room_detail(&s, "auth-sync").await["room"]["topic"], "Coordinate token schema");
    assert!(!member_ids(&room_detail(&s, "auth-sync").await["room"]).contains(&"sess-c"));

    // Elect sess-b as representative.
    let rep = room_action(&s, Some(&s.desktop), json!({ "room": "auth-sync", "sessionId": "sess-b", "action": "represent" })).await;
    assert_eq!((rep.status, &rep.json()["room"]["representative"]), (StatusCode::OK, &json!("sess-b")));
    for client in [&mut a, &mut b] {
        assert_eq!(client.next().await["type"], "room");
    }

    // Create and delete a second room; deletion removes its room, members, and messages from SQLite.
    create_room(&s, "doomed", &["sess-a"]).await;
    a.relay(room_post("d1", "doomed", "temporary note")).await;
    let deleted = http(&s.app, with_body(Method::DELETE, "/api/v1/relay/rooms/doomed", json!({}), None)).await;
    assert_eq!(deleted.status, StatusCode::NO_CONTENT);

    // Post 205 messages to #auth-sync (exceeding MAX_ROOM_MESSAGES = 200) so pruning and monotonic seq are exercised.
    for i in 1..=204 {
        let sent = a.relay(room_post(&format!("m{i}"), "auth-sync", &format!("progress {i}"))).await;
        assert_eq!(sent["status"], "delivered");
    }
    // Message 205 mentions @name-sess-b so `notified` carries a Target with a device id.
    let sent205 = a
        .relay(json!({
            "type": "send",
            "clientId": "m205",
            "room": "auth-sync",
            "text": "final check @name-sess-b",
            "urgent": true,
            "hops": 2,
        }))
        .await;
    assert_eq!(sent205["status"], "delivered");
    let pushed = b.next().await;
    b.send(json!({ "type": "ack", "id": pushed["id"] })).await;

    drop(a);
    drop(b);
    drop(_c);

    // Restart Server on the same data directory (testing Drop-driven flush & join without explicit flush()).
    let s = s
        .restart(|c| {
            c.relay.sends_per_minute = 1_000;
            c.relay.sends_per_minute_per_device = 1_000;
        })
        .await;

    // Deleted room and its rows are gone from SQLite; #auth-sync pruned to 200 newest rows.
    for table in ["relay_rooms WHERE name = 'doomed'", "relay_room_members WHERE room = 'doomed'", "relay_room_messages WHERE room = 'doomed'"] {
        assert_eq!(one(&s.env.store, &format!("SELECT COUNT(*) AS n FROM {table}"))["n"], json!(0), "{table}");
    }
    assert_eq!(one(&s.env.store, "SELECT COUNT(*) AS n FROM relay_room_messages WHERE room = 'auth-sync'")["n"], json!(200));
    let raw_msg = one(&s.env.store, "SELECT from_json, notified_json FROM relay_room_messages WHERE room = 'auth-sync' AND seq = 205");
    assert!(!raw_msg["from_json"].as_str().unwrap().contains("deviceName"), "{raw_msg:?}");
    assert!(!raw_msg["notified_json"].as_str().unwrap().contains("deviceName"), "{raw_msg:?}");

    // Before reconnect, all hydrated members are offline, representative and topic hold, and device renames resolve dynamically.
    assert_eq!(
        http(&s.app, patch(&format!("/api/v1/devices/{DEVICE}"), json!({ "name": "New Laptop" }), None)).await.status,
        StatusCode::OK
    );
    assert_eq!(
        http(&s.app, patch(&format!("/api/v1/devices/{OTHER}"), json!({ "name": "New Desk" }), None)).await.status,
        StatusCode::OK
    );

    let list = http(&s.app, get("/api/v1/relay/rooms", None, None)).await.json();
    assert_eq!(list["items"].as_array().unwrap().len(), 1);
    let summary = &list["items"][0];
    assert_eq!(
        (&summary["name"], &summary["topic"], &summary["representative"], &summary["messageCount"]),
        (&json!("auth-sync"), &json!("Coordinate token schema"), &json!("sess-b"), &json!(205))
    );
    for m in summary["members"].as_array().unwrap() {
        assert_eq!((&m["online"], &m["state"]), (&json!(false), &json!("offline")), "{m}");
    }
    assert_eq!(summary["lastMessage"]["seq"], 205);
    assert_eq!(summary["lastMessage"]["from"]["deviceName"], "New Laptop");
    assert_eq!(summary["lastMessage"]["notified"][0]["deviceName"], "New Desk");

    let recent = http(&s.app, get("/api/v1/relay/rooms/auth-sync?after=203", None, None)).await.json();
    let seqs: Vec<u64> = recent["messages"].as_array().unwrap().iter().map(|m| m["seq"].as_u64().unwrap()).collect();
    assert_eq!(seqs, [204, 205]);
    assert_eq!(recent["messages"][1]["from"]["deviceName"], "New Laptop");
    assert_eq!(recent["messages"][1]["notified"][0]["deviceName"], "New Desk");

    let all_kept = http(&s.app, get("/api/v1/relay/rooms/auth-sync?limit=200", None, None)).await.json();
    assert_eq!(all_kept["messages"].as_array().unwrap().len(), 200);
    assert_eq!(all_kept["messages"][0]["seq"], 6);
    assert_eq!(all_kept["messages"][199]["seq"], 205);

    // Unrecorded offline member ownership (`sess-b` owned by `desktop`) survives restart via `RoomMember.device`.
    let wrong_dev = room_action(&s, Some(&s.laptop), json!({ "room": "auth-sync", "sessionId": "sess-b", "action": "unrepresent" })).await;
    assert_eq!((wrong_dev.status, wrong_dev.json()), (StatusCode::FORBIDDEN, json!({ "error": "not_owner" })));
    let cleared = room_action(&s, Some(&s.desktop), json!({ "room": "auth-sync", "sessionId": "sess-b", "action": "unrepresent" })).await;
    assert_eq!(cleared.status, StatusCode::OK);
    assert!(cleared.json()["room"].get("representative").is_none());

    // Reconnecting sess-a updates its online state and persists refreshed member metadata; new messages continue at seq 206.
    let mut a2 = Client::connect(&s, &s.laptop).await;
    a2.send(json!({
        "type": "hello",
        "session": {
            "id": "sess-a",
            "name": "name-sess-a",
            "title": "Refreshed after restart",
            "cwd": "/home/me/code/widgets",
            "project": "widgets",
            "host": "laptop.local",
            "model": "claude-opus-4-6",
            "state": "busy",
            "piVersion": "1.5.0",
            "relayVersion": "0.1.0",
        }
    }))
    .await;
    assert_eq!(a2.next().await["type"], "welcome");

    let detail_online = room_detail(&s, "auth-sync").await;
    let members = detail_online["room"]["members"].as_array().unwrap();
    let member_a = members.iter().find(|m| m["sessionId"] == "sess-a").unwrap();
    let member_b = members.iter().find(|m| m["sessionId"] == "sess-b").unwrap();
    assert_eq!((&member_a["online"], &member_a["state"], &member_a["title"], &member_a["deviceName"]), (&json!(true), &json!("busy"), &json!("Refreshed after restart"), &json!("New Laptop")));
    assert_eq!((&member_b["online"], &member_b["state"], &member_b["deviceName"]), (&json!(false), &json!("offline"), &json!("New Desk")));

    assert_eq!(a2.relay(room_post("m206", "auth-sync", "back online")).await["status"], "delivered");
    let after205 = http(&s.app, get("/api/v1/relay/rooms/auth-sync?after=205", None, None)).await.json();
    assert_eq!(after205["room"]["messageCount"], 206);
    assert_eq!(after205["messages"].as_array().unwrap().len(), 1);
    assert_eq!((&after205["messages"][0]["seq"], &after205["messages"][0]["text"]), (&json!(206), &json!("back online")));

    // Unrecorded offline `sess-b` can also leave from its owning device after restart, and that persists too.
    let left_b = room_action(&s, Some(&s.desktop), json!({ "room": "auth-sync", "sessionId": "sess-b", "action": "leave" })).await;
    assert_eq!(left_b.status, StatusCode::OK);
    drop(a2);
    let s = s.restart(|_| {}).await;
    let final_room = room_detail(&s, "auth-sync").await["room"].clone();
    assert_eq!(member_ids(&final_room), ["sess-a", "sess-rec"]);
    let persisted_a = final_room["members"].as_array().unwrap().iter().find(|m| m["sessionId"] == "sess-a").unwrap();
    assert_eq!((&persisted_a["title"], &persisted_a["model"]), (&json!("Refreshed after restart"), &json!("claude-opus-4-6")));
    assert!(final_room.get("representative").is_none());
}

#[tokio::test]
async fn relay_events_and_mailbox_survive_restarts_and_expire_cleanly() {
    let s = server_with(|c| {
        c.relay.ttl = Duration::from_secs(30);
        c.relay.ack_wait = Duration::from_millis(20);
    })
    .await;
    s.env
        .store
        .write(|tx| {
            tx.execute_batch(
                "UPDATE devices SET name = 'Laptop v1' WHERE id = 'laptop';
                 UPDATE devices SET name = 'Desk v1' WHERE id = 'desktop';",
            )
        })
        .unwrap();
    record(&s.env.store, "sess-offline-rec", OTHER);

    let (mut a, _) = Client::online(&s, &s.laptop, "sess-a").await;
    let (mut b, _) = Client::online(&s, &s.desktop, "sess-b").await;
    // `sess-wait` is unrecorded; it receives a message without acking before the server restarts.
    let (mut wait_initial, _) = Client::online(&s, &s.desktop, "sess-wait").await;

    // 1. Delivered 1:1 message.
    a.send(send("c1", "sess-b", "live delivery")).await;
    let live_msg = b.next().await;
    b.send(json!({ "type": "ack", "id": live_msg["id"] })).await;
    assert_eq!(a.next().await["status"], "delivered");

    // 2. Rejected 1:1 message.
    assert_eq!(a.relay(send("c2", "nobody", "bad target")).await["reason"], "unknown_session");

    // 3. Unacknowledged message to unrecorded `sess-wait` (answers `queued` once `ack_wait` elapses).
    let unacked_sent = a.relay(send("c3", "sess-wait", "waiting across restart")).await;
    let _unacked_push = wait_initial.next().await;
    assert_eq!(unacked_sent["status"], "queued");
    let unacked_id = unacked_sent["id"].as_str().unwrap().to_owned();

    // 4. Queued 1:1 message to offline recorded `sess-offline-rec`.
    let offline_sent = a.relay(send("c4", "sess-offline-rec", "for recorded offline target")).await;
    assert_eq!(offline_sent["status"], "queued");
    let offline_id = offline_sent["id"].as_str().unwrap().to_owned();

    drop(wait_initial);
    drop(a);
    drop(b);

    // Restart with the 30s TTL; rename devices before recipients reconnect.
    let s = s.restart(|c| c.relay.ttl = Duration::from_secs(30)).await;
    assert_eq!(s.state.relay.queued(), 2);
    assert_eq!(s.state.relay.pending_timers(), 2);

    assert_eq!(
        http(&s.app, patch(&format!("/api/v1/devices/{DEVICE}"), json!({ "name": "Laptop v2" }), None)).await.status,
        StatusCode::OK
    );
    assert_eq!(
        http(&s.app, patch(&format!("/api/v1/devices/{OTHER}"), json!({ "name": "Desk v2" }), None)).await.status,
        StatusCode::OK
    );

    let ev = events(&s, "").await;
    assert_eq!(ev.len(), 4);
    assert_eq!(
        (&ev[0]["id"], &ev[0]["status"], &ev[0]["from"]["deviceName"], &ev[0]["to"]["deviceName"]),
        (&json!(offline_id), &json!("queued"), &json!("Laptop v2"), &json!("Desk v2"))
    );
    assert_eq!(
        (&ev[1]["id"], &ev[1]["status"], &ev[1]["from"]["deviceName"], &ev[1]["to"]["deviceName"]),
        (&json!(unacked_id), &json!("queued"), &json!("Laptop v2"), &json!("Desk v2"))
    );
    assert_eq!((&ev[2]["status"], &ev[2]["reason"]), (&json!("rejected"), &json!("unknown_session")));
    assert_eq!((&ev[3]["status"], &ev[3]["text"]), (&json!("delivered"), &json!("live delivery")));
    assert!(ev[3]["deliveredAt"].is_string());

    // Offline ownership of unrecorded `sess-wait` was restored from `relay_mailbox`, so laptop cannot hijack it.
    let mut thief = Client::connect(&s, &s.laptop).await;
    thief.send(hello("sess-wait")).await;
    assert_eq!(thief.closed().await, 4403);

    // Desktop reconnects both `sess-wait` and `sess-offline-rec`, receives the queued messages with updated `deviceName`, and acknowledges them.
    let (mut wait_reconnected, _) = Client::online(&s, &s.desktop, "sess-wait").await;
    let pushed1 = wait_reconnected.next().await;
    assert_eq!(
        (&pushed1["id"], &pushed1["text"], &pushed1["from"]["deviceName"]),
        (&json!(unacked_id), &json!("waiting across restart"), &json!("Laptop v2"))
    );
    wait_reconnected.send(json!({ "type": "ack", "id": unacked_id })).await;

    let (mut rec_reconnected, _) = Client::online(&s, &s.desktop, "sess-offline-rec").await;
    let pushed2 = rec_reconnected.next().await;
    assert_eq!(
        (&pushed2["id"], &pushed2["text"], &pushed2["from"]["deviceName"]),
        (&json!(offline_id), &json!("for recorded offline target"), &json!("Laptop v2"))
    );
    rec_reconnected.send(json!({ "type": "ack", "id": offline_id })).await;

    timers_until(&s, 0).await;
    assert_eq!(s.state.relay.queued(), 0);
    s.state.relay.flush().await;
    assert_eq!(one(&s.env.store, "SELECT COUNT(*) AS n FROM relay_mailbox")["n"], json!(0));
    let ev_after = events(&s, "").await;
    assert_eq!((&ev_after[0]["id"], &ev_after[0]["status"]), (&json!(offline_id), &json!("delivered")));
    assert_eq!((&ev_after[1]["id"], &ev_after[1]["status"]), (&json!(unacked_id), &json!("delivered")));
    assert!(ev_after[0]["deliveredAt"].is_string() && ev_after[1]["deliveredAt"].is_string());

    // Now queue a message with a short TTL, stop the server until the TTL elapses, and verify startup transitions it to `expired`.
    drop(wait_reconnected);
    drop(rec_reconnected);
    let s = s.restart(|c| c.relay.ttl = Duration::from_millis(120)).await;
    record(&s.env.store, "sess-expiring", DEVICE);
    let r = http(&s.app, post("/api/v1/relay/messages", json!({ "to": "sess-expiring", "text": "expires while down" }), None)).await;
    assert_eq!((r.status, &r.json()["status"]), (StatusCode::OK, &json!("queued")));
    let exp_id = r.json()["id"].as_str().unwrap().to_owned();

    // Stop the server, wait past TTL while down, then reopen.
    let Server { env, state, app, laptop, desktop, serve_task, .. } = s;
    serve_task.abort();
    let _ = serve_task.await;
    drop(app);
    drop(state);
    tokio::time::sleep(Duration::from_millis(180)).await;
    let Env { dir, store } = env;
    drop(store);
    let store = Store::open(dir.path().join("data")).unwrap();
    let s = start_on(Env { dir, store }, laptop, desktop, |c| c.relay.ttl = Duration::from_millis(120)).await;

    assert_eq!(s.state.relay.queued(), 0);
    assert_eq!(one(&s.env.store, "SELECT COUNT(*) AS n FROM relay_mailbox")["n"], json!(0));
    assert_eq!(
        one(&s.env.store, &format!("SELECT status FROM relay_events WHERE id = '{exp_id}'"))["status"],
        json!("expired")
    );
    let latest = &events(&s, "?limit=1").await[0];
    assert_eq!((&latest["id"], &latest["status"]), (&json!(exp_id), &json!("expired")));
}

#[tokio::test]
async fn reindex_preserves_relay_tables() {
    let s = server().await;
    upload(&s.env.store, &format!("session:{SESSION_ID}"), "session", &fixture("session.jsonl"), 50);
    let (mut a, _) = Client::online(&s, &s.laptop, "sess-a").await;
    create_room(&s, "keep-me", &[SESSION_ID, "sess-a"]).await;
    room_action(&s, Some(&s.laptop), json!({ "room": "keep-me", "sessionId": "sess-a", "action": "represent" })).await;
    assert_eq!(a.next().await["type"], "room");
    assert_eq!(a.relay(room_post("r1", "keep-me", "persisted room message")).await["status"], "delivered");
    assert_eq!(a.relay(send("q1", SESSION_ID, "persisted mailbox message")).await["status"], "queued");
    s.state.relay.flush().await;

    let tables = [
        "SELECT * FROM relay_rooms ORDER BY name",
        "SELECT * FROM relay_room_members ORDER BY room, session_id",
        "SELECT * FROM relay_room_messages ORDER BY room, seq",
        "SELECT * FROM relay_events ORDER BY seq",
        "SELECT * FROM relay_mailbox ORDER BY seq",
    ];
    let before: Vec<_> = tables.iter().map(|sql| query(&s.env.store, sql)).collect();
    assert!(before.iter().all(|rows| !rows.is_empty()));

    let stats = pika::reindex::reindex(&s.env.store).unwrap();
    assert_eq!(stats.streams, 1);

    let after: Vec<_> = tables.iter().map(|sql| query(&s.env.store, sql)).collect();
    assert_eq!(after, before);
}
