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
}

/// A served router with tokens for `laptop` and `desktop`, `PIKA_AUTH=none` unless `configure` says otherwise.
async fn server_with(configure: impl FnOnce(&mut ServerConfig)) -> Server {
    let env = env();
    let laptop = pika::auth::create_token(&env.store, DEVICE).unwrap();
    let desktop = pika::auth::create_token(&env.store, OTHER).unwrap();
    let mut config = ServerConfig::new(env.dir.path().join("data"));
    config.auth = AuthMode::None;
    configure(&mut config);
    let base = config.prefix().to_owned();
    let state = AppState::new(env.store.clone(), config).unwrap();
    let app = router(state.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let served = app.clone().into_make_service_with_connect_info::<SocketAddr>();
    tokio::spawn(async move { axum::serve(listener, served).await.unwrap() });
    Server { env, state, app, addr, base, laptop, desktop }
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
    let mut request = Request::builder().method(Method::POST).uri(path).header("content-type", "application/json");
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
        json!({ "type": "welcome", "device": "laptop", "serverVersion": "0.3.0",
            "limits": { "ttlSeconds": 300, "heartbeatSeconds": 20, "maxTextBytes": 32768, "maxHops": 8 } })
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
        json!({ "id": "sess-a", "device": "laptop", "host": "laptop.local", "name": "name-sess-a",
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
            "from": { "kind": "session", "sessionId": "sess-a", "device": "laptop", "name": "name-sess-a",
                "project": "widgets" } })
    );
    b.send(json!({ "type": "ack", "id": id })).await;
    let sent = a.next().await;
    assert_eq!(
        sent,
        json!({ "type": "sent", "clientId": "c1", "id": id, "status": "delivered",
            "to": { "sessionId": "sess-b", "device": "desktop", "name": "name-sess-b", "project": "widgets" } })
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
        assert_eq!(sent["to"], json!({ "sessionId": SESSION_ID, "device": "laptop", "project": "widgets" }));
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
        (frame("sess-a", &big, json!(9)), "self"),
        (frame("nobody", &big, json!(9)), "too_large"),
        (frame("nobody", "x", json!(9)), "hop_limit"),
        (frame("nobody", "x", json!(1)), "unknown_session"),
        (frame(SESSION_ID, &exact, json!(8)), "queued"),
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
    over["hops"] = json!(9);
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
    assert_eq!(health.json()["features"], json!(["relay"]));

    let s = server_with(|c| {
        c.relay.enabled = false;
        c.auth = AuthMode::Password;
        c.password = Some(PASSWORD.into());
    })
    .await;
    let health = http(&s.app, get("/api/health", None, None)).await;
    assert_eq!((health.json()["features"].clone(), health.json()["version"].clone()), (json!([]), json!("0.3.0")));
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
    assert_eq!(ids(&items), ["sess-b", SESSION_ID, "sess-a"], "by device, then newest first");
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
            "to": { "sessionId": "sess-b", "device": "desktop", "name": "name-sess-b", "project": "widgets" } })
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
        json!({ "sessionId": "offline-recorded", "device": "desktop", "project": "widgets" })
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
            "to": { "sessionId": "sess-b", "device": "desktop", "name": "name-sess-b", "project": "widgets" } })
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
    let token = pika::auth::create_token(&env.store, DEVICE).unwrap();
    let cases = [
        ("off", json!([])),
        ("OFF", json!([])),
        ("on", json!(["relay"])),
        ("1", json!(["relay"])),
        ("", json!(["relay"])),
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
    assert_eq!(health_of(&addr)["features"], json!(["relay"]));
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
    let online = tokio::time::Instant::now();
    let mut t = slow_online(&s, "sess-t").await;
    let ids = flood(&s, "sess-t", |s| stalled(s, "sess-t")).await;
    assert!(online.elapsed() < dead_after, "the flood took {:?}", online.elapsed());
    // The silence timeout runs while a write waits, and takes the connection out at once.
    sessions_until(&s, |items| items.is_empty()).await;
    assert!(online.elapsed() >= dead_after, "{:?}", online.elapsed());
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
async fn pairing_with_replace_closes_the_old_tokens_connections_at_once() {
    let s = server().await;
    let (mut old, _) = Client::online(&s, &s.laptop, "sess-a").await;
    let (_other, _) = Client::online(&s, &s.desktop, "sess-b").await;
    let started = http(&s.app, post("/api/pair/v1/start", json!({ "device": DEVICE }), None)).await.json();
    let code = started["code"].as_str().unwrap();
    let r = http(&s.app, post(&format!("/api/v1/pairings/{code}/approve"), json!({ "replace": true }), None)).await;
    assert_eq!(r.status, StatusCode::OK);
    // The old token works until the device collects the new one.
    assert_eq!(old.relay(send("c1", "nobody", "x")).await["reason"], "unknown_session");
    let polled = http(&s.app, post("/api/pair/v1/poll", json!({ "pairingId": started["pairingId"] }), None)).await;
    let token = polled.json()["token"].as_str().unwrap().to_owned();
    let collected = tokio::time::Instant::now();
    assert_eq!(old.closed().await, 4401);
    assert!(collected.elapsed() < Duration::from_secs(1), "{:?}", collected.elapsed());
    assert_eq!(ids(&sessions(&s).await), ["sess-b"]);
    Client::online(&s, &token, "sess-a").await;
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
    let controls = escaped_text((64 * 1024 - send("c1", "sess-b", "").to_string().len()) / 6, 0);
    assert!(send("c1", "sess-b", &controls).to_string().len() <= 64 * 1024);
    assert_eq!(a.relay(send("c1", "sess-b", &controls)).await["reason"], "too_large");
    // In the same place in the order: after `self`, before the hops and the target.
    assert_eq!(a.relay(send("c2", "sess-a", &controls)).await["reason"], "self");
    let mut far = send("c3", "nobody", &controls);
    far["hops"] = json!(9);
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
