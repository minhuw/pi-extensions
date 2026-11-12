mod common;

use std::net::SocketAddr;
use std::time::Duration;

use axum::Router;
use axum::body::Body;
use axum::http::{Request, StatusCode};
use common::*;
use futures_util::{SinkExt, StreamExt};
use pika::config::{AuthMode, ServerConfig};
use pika::http::{AppState, router};
use serde_json::{Value, json};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::{self, Message};
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};
use tower::ServiceExt;

const PASSWORD: &str = "correct horse battery";
const WAIT: Duration = Duration::from_secs(5);
const PUBLIC_KEY: &str = "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

struct Server {
    env: Env,
    state: AppState,
    app: Router,
    addr: SocketAddr,
    /// The credential of node `node01`, and its id.
    credential: String,
    node: String,
    /// A device token, which must not reach node routes.
    device: String,
}

/// A served router with nodes on, `PIKA_AUTH=password` unless `configure` says otherwise, a node `node01`, and a
/// device `laptop`.
async fn server_with(configure: impl FnOnce(&mut ServerConfig)) -> Server {
    let env = env();
    let mut config = ServerConfig::new(env.dir.path().join("data"));
    config.auth = AuthMode::Password;
    config.password = Some(PASSWORD.into());
    config.nodes.enabled = true;
    configure(&mut config);
    let created = pika::nodes::create_node(&env.store, "node01").unwrap();
    let device = common::device(&env.store, DEVICE);
    let state = AppState::new(env.store.clone(), config).unwrap();
    let app = router(state.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let served = app.clone().into_make_service_with_connect_info::<SocketAddr>();
    tokio::spawn(async move { axum::serve(listener, served).await.unwrap() });
    Server { env, state, app, addr, credential: created.credential, node: created.id, device }
}

async fn server() -> Server {
    server_with(|_| {}).await
}

impl Server {
    fn origin(&self) -> String {
        format!("http://{}", self.addr)
    }

    async fn login(&self) -> String {
        let request = Request::post("/api/v1/login")
            .header("content-type", "application/json")
            .body(Body::from(json!({ "password": PASSWORD }).to_string()))
            .unwrap();
        let response = self.app.clone().oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let cookie = response.headers().get("set-cookie").unwrap().to_str().unwrap();
        cookie.split(';').next().unwrap().to_owned()
    }
}

struct Reply {
    status: StatusCode,
    headers: axum::http::HeaderMap,
    body: Vec<u8>,
}

impl Reply {
    fn json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap_or_else(|_| panic!("not JSON: {}", String::from_utf8_lossy(&self.body)))
    }
}

async fn http(app: &Router, request: Request<Body>) -> Reply {
    let response = app.clone().oneshot(request).await.unwrap();
    let (status, headers) = (response.status(), response.headers().clone());
    let body = axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap().to_vec();
    Reply { status, headers, body }
}

fn get(path: &str, token: Option<&str>) -> Request<Body> {
    let mut request = Request::get(path);
    if let Some(token) = token {
        request = request.header("authorization", format!("Bearer {token}"));
    }
    request.body(Body::empty()).unwrap()
}

type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;

async fn open_node(s: &Server, token: Option<&str>) -> Result<Ws, tungstenite::Error> {
    let mut request = format!("ws://{}/api/node/v1/connect", s.addr).into_client_request().unwrap();
    if let Some(token) = token {
        request.headers_mut().insert("authorization", format!("Bearer {token}").parse().unwrap());
    }
    tokio_tungstenite::connect_async(request).await.map(|(ws, _)| ws)
}

async fn open_client(s: &Server, cookie: Option<&str>, origin: Option<&str>) -> Result<Ws, tungstenite::Error> {
    let mut request = format!("ws://{}/api/v1/node/connect", s.addr).into_client_request().unwrap();
    if let Some(cookie) = cookie {
        request.headers_mut().insert("cookie", cookie.parse().unwrap());
    }
    if let Some(origin) = origin {
        request.headers_mut().insert("origin", origin.parse().unwrap());
    }
    request.headers_mut().insert("user-agent", "Firefox\u{1b} on mbp".replace('\u{1b}', "").parse().unwrap());
    tokio_tungstenite::connect_async(request).await.map(|(ws, _)| ws)
}

/// The status and JSON body of a refused upgrade.
fn refusal(result: Result<Ws, tungstenite::Error>) -> (u16, Value) {
    match result {
        Err(tungstenite::Error::Http(response)) => {
            let body = serde_json::from_slice(response.body().as_deref().unwrap_or_default()).unwrap();
            (response.status().as_u16(), body)
        }
        Err(other) => panic!("expected a refused upgrade, got {other:?}"),
        Ok(_) => panic!("expected a refused upgrade, got a socket"),
    }
}

fn hello() -> Value {
    json!({ "type": "hello", "host": "node01.lan", "version": "0.1.0", "protocolVersions": [1], "publicKey": PUBLIC_KEY })
}

struct Peer {
    ws: Ws,
}

impl Peer {
    /// A node socket that said `hello`, and its `welcome`.
    async fn node(s: &Server, credential: &str) -> (Peer, Value) {
        let mut peer = Peer { ws: open_node(s, Some(credential)).await.unwrap() };
        peer.send(hello()).await;
        let welcome = peer.next().await;
        assert_eq!(welcome["type"], "welcome", "{welcome}");
        (peer, welcome)
    }

    /// A browser socket, past its `welcome`, and its first `nodes`.
    async fn client(s: &Server, cookie: &str) -> (Peer, Value) {
        let mut peer = Peer { ws: open_client(s, Some(cookie), Some(&s.origin())).await.unwrap() };
        let welcome = peer.next().await;
        assert_eq!(welcome["type"], "welcome", "{welcome}");
        let nodes = peer.next().await;
        assert_eq!(nodes["type"], "nodes", "{nodes}");
        (peer, nodes)
    }

    async fn send(&mut self, frame: Value) {
        self.ws.send(Message::text(frame.to_string())).await.unwrap();
    }

    async fn send_text(&mut self, text: &str) {
        self.ws.send(Message::text(text.to_owned())).await.unwrap();
    }

    /// The next text frame other than `ping`, as it came.
    async fn next_text(&mut self) -> String {
        loop {
            match tokio::time::timeout(WAIT, self.ws.next()).await.expect("no frame in time") {
                Some(Ok(Message::Text(text))) => {
                    let text = text.as_str().to_owned();
                    if serde_json::from_str::<Value>(&text).unwrap()["type"] != "ping" {
                        return text;
                    }
                }
                Some(Ok(Message::Close(frame))) => panic!("closed: {frame:?}"),
                Some(Ok(_)) => {}
                other => panic!("socket ended: {other:?}"),
            }
        }
    }

    async fn next(&mut self) -> Value {
        serde_json::from_str(&self.next_text().await).unwrap()
    }

    /// The next frame other than `ping` and `nodes`.
    async fn next_routed(&mut self) -> Value {
        loop {
            let frame = self.next().await;
            if frame["type"] != "nodes" {
                return frame;
            }
        }
    }

    /// Reads `nodes` frames until one passes `check`.
    async fn nodes_until(&mut self, check: impl Fn(&[Value]) -> bool) -> Vec<Value> {
        loop {
            let frame = self.next().await;
            assert_eq!(frame["type"], "nodes", "{frame}");
            let items = frame["items"].as_array().unwrap().clone();
            if check(&items) {
                return items;
            }
        }
    }

    /// Reads until the server closes and returns the close code.
    async fn closed(&mut self) -> u16 {
        loop {
            match tokio::time::timeout(WAIT, self.ws.next()).await.expect("not closed in time") {
                Some(Ok(Message::Close(Some(frame)))) => return frame.code.into(),
                Some(Ok(Message::Close(None))) => panic!("closed without a code"),
                Some(Ok(_)) => {}
                other => panic!("socket ended without a close frame: {other:?}"),
            }
        }
    }

    /// Opens a channel to `node` and returns its id, or the `refused` frame.
    async fn open(&mut self, reference: &str, node: &str) -> Result<String, Value> {
        self.send(json!({ "type": "open", "ref": reference, "node": node })).await;
        let answer = self.next_routed().await;
        match answer["type"].as_str() {
            Some("opened") => {
                assert_eq!((&answer["ref"], &answer["node"]), (&json!(reference), &json!(node)), "{answer}");
                Ok(answer["channel"].as_str().unwrap().to_owned())
            }
            _ => Err(answer),
        }
    }
}

/// Polls until `check` holds.
async fn until(what: &str, check: impl Fn() -> bool) {
    let deadline = tokio::time::Instant::now() + WAIT;
    while !check() {
        assert!(tokio::time::Instant::now() < deadline, "{what} never happened");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

#[tokio::test]
async fn nodes_off_answers_404_on_every_node_route() {
    let s = server_with(|c| c.nodes.enabled = false).await;
    let disabled = (404, json!({ "error": "nodes_disabled" }));
    // Before authentication: a valid credential, a device token, and none all get the same answer.
    assert_eq!(refusal(open_node(&s, Some(&s.credential)).await), disabled);
    assert_eq!(refusal(open_node(&s, Some(&s.device)).await), disabled);
    assert_eq!(refusal(open_node(&s, None).await), disabled);
    assert_eq!(refusal(open_client(&s, None, Some(&s.origin())).await), disabled);
    let cookie = s.login().await;
    assert_eq!(refusal(open_client(&s, Some(&cookie), Some(&s.origin())).await), disabled);

    let health = http(&s.app, get("/api/health", None)).await;
    assert_eq!(health.json()["features"], json!(["relay", "agent"]));
    let page = http(&s.app, get("/", None)).await;
    assert_eq!(page.status, StatusCode::OK);
    assert!(page.headers.get("content-security-policy").is_none());
}

#[tokio::test]
async fn a_node_connects_with_its_credential_and_shows_online() {
    let s = server().await;
    let health = http(&s.app, get("/api/health", None)).await;
    assert_eq!(health.json()["features"], json!(["relay", "agent", "nodes"]));
    // Pages at every depth, and the 404 of a missing build file, carry the policy.
    for path in ["/sessions/x", "/deck/x/t1", "/assets/missing-0000.js"] {
        let page = http(&s.app, get(path, None)).await;
        assert_eq!(
            page.headers.get("content-security-policy").unwrap(),
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; \
             connect-src 'self'; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
            "{path}"
        );
    }

    let cookie = s.login().await;
    let (mut browser, nodes) = Peer::client(&s, &cookie).await;
    assert_eq!(nodes["items"], json!([{ "id": s.node, "name": "node01", "online": false }]));

    let (mut node, welcome) = Peer::node(&s, &s.credential).await;
    assert_eq!(
        welcome,
        json!({ "type": "welcome", "node": s.node, "nodeName": "node01", "serverVersion": env!("CARGO_PKG_VERSION"),
            "limits": { "heartbeatSeconds": 20, "maxFrameBytes": 2 << 20, "maxChannels": 64 } })
    );
    // Online at once, then with the time the hello was recorded.
    let items = browser.nodes_until(|items| items[0]["online"] == true && items[0].get("lastSeenAt").is_some()).await;
    let item = items[0].as_object().unwrap();
    assert_eq!(
        (&item["id"], &item["name"], &item["host"], &item["version"], &item["publicKey"]),
        (&json!(s.node), &json!("node01"), &json!("node01.lan"), &json!("0.1.0"), &json!(PUBLIC_KEY))
    );
    assert!(item["connectedAt"].as_i64().unwrap() > 0 && item["lastSeenAt"].as_i64().unwrap() > 0, "{item:?}");
    // The hello is recorded for display.
    let rows = pika::nodes::list_nodes(&s.env.store).unwrap();
    assert_eq!((rows[0].last_host.as_deref(), rows[0].public_key.as_deref()), (Some("node01.lan"), Some(PUBLIC_KEY)));

    // A second browser gets the list on connect, with the right welcome.
    let mut second = Peer { ws: open_client(&s, Some(&cookie), Some(&s.origin())).await.unwrap() };
    assert_eq!(
        second.next().await,
        json!({ "type": "welcome", "serverVersion": env!("CARGO_PKG_VERSION"),
            "limits": { "heartbeatSeconds": 20, "maxFrameBytes": 2 << 20, "maxChannels": 16 } })
    );
    assert_eq!(second.next().await["items"][0]["online"], true);

    // A rename from another process shows within the revalidation interval.
    pika::nodes::rename_node(&s.env.store, &s.node, "build box").unwrap();
    browser.nodes_until(|items| items[0]["name"] == "build box").await;

    drop(node.ws.close(None).await);
    let items = browser.nodes_until(|items| items[0]["online"] == false).await;
    assert!(items[0].get("version").is_none() && items[0].get("connectedAt").is_none(), "{items:?}");
    assert_eq!(items[0]["host"], "node01.lan");
}

#[tokio::test]
async fn device_tokens_and_node_credentials_do_not_cross() {
    let s = server().await;
    let unauthorized = (401, json!({ "error": "unauthorized" }));
    assert_eq!(refusal(open_node(&s, None).await), unauthorized);
    assert_eq!(refusal(open_node(&s, Some(&s.device)).await), unauthorized);
    assert_eq!(refusal(open_node(&s, Some("pkn_unknown")).await), unauthorized);
    let other = pika::nodes::create_node(&s.env.store, "node02").unwrap();
    pika::nodes::revoke_node(&s.env.store, &other.id).unwrap();
    assert_eq!(refusal(open_node(&s, Some(&other.credential)).await), unauthorized);

    // A node credential is not a device token anywhere else.
    let batch = Request::post("/api/ingest/v1/batch")
        .header("authorization", format!("Bearer {}", s.credential))
        .header("content-type", "application/json")
        .body(Body::from(json!({ "streams": [] }).to_string()))
        .unwrap();
    let bind = Request::post("/api/pair/v1/bind")
        .header("authorization", format!("Bearer {}", s.credential))
        .header("content-type", "application/json")
        .body(Body::from(json!({ "key": "0".repeat(64) }).to_string()))
        .unwrap();
    for request in [
        batch,
        bind,
        get("/api/relay/v1/sessions", Some(&s.credential)),
        get("/api/relay/v1/rooms", Some(&s.credential)),
        get("/api/agent/v1/sessions", Some(&s.credential)),
    ] {
        let path = request.uri().path().to_owned();
        let r = http(&s.app, request).await;
        assert_eq!(r.status, StatusCode::UNAUTHORIZED, "{path}: {}", String::from_utf8_lossy(&r.body));
    }
    let mut relay = format!("ws://{}/api/relay/v1/connect", s.addr).into_client_request().unwrap();
    relay.headers_mut().insert("authorization", format!("Bearer {}", s.credential).parse().unwrap());
    let refused = match tokio_tungstenite::connect_async(relay).await {
        Err(tungstenite::Error::Http(response)) => response.status().as_u16(),
        other => panic!("{other:?}"),
    };
    assert_eq!(refused, 401);
    // The device token still works where it belongs, and so does the credential.
    let r = http(&s.app, get("/api/relay/v1/sessions", Some(&s.device))).await;
    assert_eq!(r.status, StatusCode::OK);
    Peer::node(&s, &s.credential).await;
}

#[tokio::test]
async fn the_browser_socket_needs_a_session_and_the_same_origin() {
    let s = server_with(|c| c.nodes.public_origin = Some("https://pika.example.com".into())).await;
    assert_eq!(refusal(open_client(&s, None, Some(&s.origin())).await), (401, json!({ "error": "unauthorized" })));
    let cookie = s.login().await;
    let forbidden = (403, json!({ "error": "forbidden_origin" }));
    for origin in [None, Some("http://evil.example"), Some("null"), Some("https://127.0.0.1"), Some("http://localhost:1")] {
        assert_eq!(refusal(open_client(&s, Some(&cookie), origin).await), forbidden, "{origin:?}");
    }
    // The device token is no session.
    let mut request = format!("ws://{}/api/v1/node/connect", s.addr).into_client_request().unwrap();
    request.headers_mut().insert("authorization", format!("Bearer {}", s.device).parse().unwrap());
    request.headers_mut().insert("origin", s.origin().parse().unwrap());
    assert_eq!(refusal(tokio_tungstenite::connect_async(request).await.map(|(ws, _)| ws)).0, 401);
    // The configured public URL's origin counts too.
    open_client(&s, Some(&cookie), Some("https://pika.example.com")).await.unwrap();
    Peer::client(&s, &cookie).await;
    // Signing out closes the socket with 4401.
    let (mut browser, _) = Peer::client(&s, &cookie).await;
    pika::auth::revoke_all_sessions(&s.env.store).unwrap();
    assert_eq!(browser.closed().await, 4401);

    // Without authentication the browser socket stays off unless allowed explicitly.
    let open = server_with(|c| c.auth = AuthMode::None).await;
    assert_eq!(refusal(open_client(&open, None, Some(&open.origin())).await), (404, json!({ "error": "nodes_disabled" })));
    let insecure = server_with(|c| {
        c.auth = AuthMode::None;
        c.nodes.insecure = true;
    })
    .await;
    assert_eq!(refusal(open_client(&insecure, None, Some("http://evil.example")).await).0, 403);
    let mut browser = Peer { ws: open_client(&insecure, None, Some(&insecure.origin())).await.unwrap() };
    assert_eq!(browser.next().await["type"], "welcome");
    // Nodes connect in every mode, with their credential.
    Peer::node(&insecure, &insecure.credential).await;
}

#[tokio::test]
async fn channels_forward_bodies_verbatim_both_ways() {
    let s = server().await;
    let offline = pika::nodes::create_node(&s.env.store, "node02").unwrap();
    let cookie = s.login().await;
    let (mut node, _) = Peer::node(&s, &s.credential).await;
    let (mut browser, _) = Peer::client(&s, &cookie).await;

    assert_eq!(browser.open("r1", "no-such-node").await, Err(json!({ "type": "refused", "ref": "r1", "code": "unknown_node" })));
    assert_eq!(browser.open("r2", &offline.id).await, Err(json!({ "type": "refused", "ref": "r2", "code": "node_offline" })));

    let channel = browser.open("r:3", &s.node).await.unwrap();
    assert_eq!(channel.len(), 22, "128 random bits");
    let open = node.next().await;
    let session = open["client"]["session"].as_str().unwrap();
    assert!(session.len() == 12 && session.bytes().all(|b| b.is_ascii_hexdigit()), "{open}");
    assert_eq!(
        open,
        json!({ "type": "open", "channel": channel, "client": { "session": session, "userAgent": "Firefox on mbp",
            "ip": "127.0.0.1" } })
    );

    // Bodies pass byte for byte, whitespace, escapes, and key order included; unknown fields of the frame do not.
    let body = r#"{ "t":"hs1","v":1, "clientKey":"AA", "eph" : "\u00e9x", "nested":{"z":[1,2.50,null]} }"#;
    browser.send_text(&format!(r#"{{"type":"frame","channel":"{channel}","body":{body},"extra":true}}"#)).await;
    assert_eq!(node.next_text().await, format!(r#"{{"type":"frame","channel":"{channel}","body":{body}}}"#));
    let back = r#"{"t":"rec","n":0,"ct":"q83vEjRWeJA"}"#;
    node.send_text(&format!(r#"{{"type":"frame","channel":"{channel}","body":{back}}}"#)).await;
    assert_eq!(browser.next_text().await, format!(r#"{{"type":"frame","channel":"{channel}","body":{back}}}"#));
    // Order holds within a channel.
    for n in 0..50 {
        node.send(json!({ "type": "frame", "channel": channel, "body": { "t": "rec", "n": n, "ct": "x" } })).await;
    }
    for n in 0..50 {
        assert_eq!(browser.next_routed().await["body"]["n"], n);
    }

    // A frame for a channel the sender is not a side of goes nowhere.
    let (mut other, _) = Peer::client(&s, &cookie).await;
    other.send(json!({ "type": "frame", "channel": channel, "body": { "t": "rec" } })).await;
    other.send(json!({ "type": "close", "channel": channel, "code": "closed" })).await;

    // A close goes to the other side with its code and reason, and ends the channel.
    browser.send(json!({ "type": "close", "channel": channel, "code": "closed", "reason": "tab closed" })).await;
    assert_eq!(node.next().await, json!({ "type": "close", "channel": channel, "code": "closed", "reason": "tab closed" }));
    until("the channel to close", || s.state.nodes.channels() == 0).await;
    node.send(json!({ "type": "frame", "channel": channel, "body": { "t": "late" } })).await;
    // A browser that closes its socket closes its channels with `client_gone`.
    let second = browser.open("r4", &s.node).await.unwrap();
    assert_eq!(node.next().await["channel"], second);
    drop(browser.ws.close(None).await);
    assert_eq!(node.next().await, json!({ "type": "close", "channel": second, "code": "client_gone" }));
}

#[tokio::test]
async fn a_node_that_goes_away_closes_its_channels() {
    let s = server().await;
    let cookie = s.login().await;
    let (mut browser, _) = Peer::client(&s, &cookie).await;
    let (mut node, _) = Peer::node(&s, &s.credential).await;
    browser.nodes_until(|items| items[0]["online"] == true).await;
    let channels = [browser.open("a", &s.node).await.unwrap(), browser.open("b", &s.node).await.unwrap()];
    for channel in &channels {
        assert_eq!(&node.next().await["channel"], channel);
    }
    drop(node.ws.close(None).await);
    let mut closed = Vec::new();
    while closed.len() < 2 {
        let frame = browser.next().await;
        if frame["type"] == "close" {
            assert_eq!(frame["code"], "node_offline", "{frame}");
            closed.push(frame["channel"].as_str().unwrap().to_owned());
        }
    }
    closed.sort();
    let mut expected = channels.to_vec();
    expected.sort();
    assert_eq!(closed, expected);
    until("the channels to close", || s.state.nodes.channels() == 0).await;

    // A newer socket for the node replaces the older one with 4410, which closes the older one's channels.
    let (mut first, _) = Peer::node(&s, &s.credential).await;
    let channel = browser.open("c", &s.node).await.unwrap();
    assert_eq!(first.next().await["channel"], channel);
    let (mut second, _) = Peer::node(&s, &s.credential).await;
    assert_eq!(first.closed().await, 4410);
    assert_eq!(browser.next_routed().await, json!({ "type": "close", "channel": channel, "code": "node_offline" }));
    let channel = browser.open("d", &s.node).await.unwrap();
    assert_eq!(second.next().await["channel"], channel);
    assert_eq!(s.state.nodes.online(), 1);
}

#[tokio::test]
async fn revoking_a_node_closes_its_socket_with_4401() {
    let s = server_with(|c| c.nodes.revalidate = Duration::from_millis(50)).await;
    let cookie = s.login().await;
    let (mut browser, _) = Peer::client(&s, &cookie).await;
    let (mut node, _) = Peer::node(&s, &s.credential).await;
    let channel = browser.open("a", &s.node).await.unwrap();
    assert_eq!(node.next().await["channel"], channel);
    // As `pika node revoke` does, from another process.
    assert!(pika::nodes::revoke_node(&s.env.store, &s.node).unwrap());
    assert_eq!(node.closed().await, 4401);
    assert_eq!(browser.next_routed().await, json!({ "type": "close", "channel": channel, "code": "node_offline" }));
    browser.nodes_until(|items| items.is_empty()).await;
    assert_eq!(refusal(open_node(&s, Some(&s.credential)).await).0, 401);
    // A socket waiting for its hello is closed too.
    let other = pika::nodes::create_node(&s.env.store, "node02").unwrap();
    let mut pending = Peer { ws: open_node(&s, Some(&other.credential)).await.unwrap() };
    pika::nodes::revoke_node(&s.env.store, &other.id).unwrap();
    assert_eq!(pending.closed().await, 4401);
}

#[tokio::test]
async fn limits_are_enforced() {
    let s = server_with(|c| {
        c.nodes.max_channels_per_client = 2;
        c.nodes.max_channels_per_node = 3;
        c.nodes.opens_per_minute = 4;
        c.nodes.max_online = 1;
        c.nodes.max_sockets_per_session = 3;
        c.nodes.max_frame_bytes = 4096;
        c.nodes.hello_timeout = Duration::from_millis(200);
    })
    .await;
    let cookie = s.login().await;
    let (mut node, _) = Peer::node(&s, &s.credential).await;
    let too_many = |r: &str| Err(json!({ "type": "refused", "ref": r, "code": "too_many_channels" }));

    // Per browser socket; an open refused for the socket's own limit does not count against its rate.
    let (mut a, _) = Peer::client(&s, &cookie).await;
    a.open("1", &s.node).await.unwrap();
    a.open("2", &s.node).await.unwrap();
    assert_eq!(a.open("3", &s.node).await, too_many("3"));
    // Per node.
    let (mut b, _) = Peer::client(&s, &cookie).await;
    b.open("4", &s.node).await.unwrap();
    assert_eq!(b.open("5", &s.node).await, too_many("5"));
    for _ in 0..3 {
        assert_eq!(node.next().await["type"], "open");
    }
    // Per minute: every other open counts, refused or not.
    let (mut c, _) = Peer::client(&s, &cookie).await;
    for r in ["6", "7", "8", "9"] {
        assert_eq!(c.open(r, "nowhere").await, Err(json!({ "type": "refused", "ref": r, "code": "unknown_node" })));
    }
    assert_eq!(c.open("10", "nowhere").await, too_many("10"));
    // Per owner session: a 4th socket closes with 4429.
    let mut fourth = Peer { ws: open_client(&s, Some(&cookie), Some(&s.origin())).await.unwrap() };
    assert_eq!(fourth.closed().await, 4429);
    // Another session has its own sockets.
    let other_session = s.login().await;
    Peer::client(&s, &other_session).await;

    // Online nodes per server.
    let other = pika::nodes::create_node(&s.env.store, "node02").unwrap();
    let mut second = Peer { ws: open_node(&s, Some(&other.credential)).await.unwrap() };
    second.send(hello()).await;
    assert_eq!(second.closed().await, 4429);

    // Frames: too large, binary, unknown type, invalid JSON, and a body that is not an object close with 4400.
    let big = format!(r#"{{"type":"frame","channel":"x","body":{{"pad":"{}"}}}}"#, "x".repeat(5000));
    for bad in [Message::text(big), Message::binary(vec![1, 2, 3]), Message::text(r#"{"type":"nodes"}"#),
        Message::text("{"), Message::text(r#"{"type":"frame","channel":"x","body":[]}"#)]
    {
        let (mut browser, _) = Peer::client(&s, &s.login().await).await;
        browser.ws.send(bad).await.unwrap();
        assert_eq!(browser.closed().await, 4400);
    }
    // A node that sends anything before its hello, or a second hello.
    let mut early = Peer { ws: open_node(&s, Some(&other.credential)).await.unwrap() };
    early.send(json!({ "type": "pong" })).await;
    assert_eq!(early.closed().await, 4400);
    node.send(hello()).await;
    assert_eq!(node.closed().await, 4400);
    // No hello in time.
    let mut silent = Peer { ws: open_node(&s, Some(&other.credential)).await.unwrap() };
    assert_eq!(silent.closed().await, 4408);
}

#[tokio::test]
async fn silent_sockets_are_closed_and_heartbeats_flow() {
    let s = server_with(|c| {
        c.nodes.heartbeat = Duration::from_millis(50);
        c.nodes.dead_after = Duration::from_millis(400);
    })
    .await;
    let mut node = Peer { ws: open_node(&s, Some(&s.credential)).await.unwrap() };
    node.send(hello()).await;
    assert_eq!(node.next().await["type"], "welcome");
    // Pings arrive; answering keeps the socket alive past `dead_after`.
    let started = tokio::time::Instant::now();
    while started.elapsed() < Duration::from_millis(800) {
        match tokio::time::timeout(WAIT, node.ws.next()).await.unwrap() {
            Some(Ok(Message::Text(text))) => {
                let frame: Value = serde_json::from_str(text.as_str()).unwrap();
                assert_eq!(frame["type"], "ping");
                assert!(frame["at"].as_i64().unwrap() > 0);
                node.send(json!({ "type": "pong" })).await;
            }
            other => panic!("{other:?}"),
        }
    }
    // Silence closes it with 1001.
    assert_eq!(node.closed().await, 1001);
}

#[tokio::test]
async fn the_cli_manages_node_credentials() {
    let env = env();
    let data = env.dir.path().join("data");
    drop(env.store);
    let pika = |args: &[&str]| {
        let output = std::process::Command::new(env!("CARGO_BIN_EXE_pika")).arg("--data-dir").arg(&data).args(args).output().unwrap();
        (output.status.success(), String::from_utf8(output.stdout).unwrap(), String::from_utf8(output.stderr).unwrap())
    };
    let (ok, credential, _) = pika(&["node", "create", "node01"]);
    assert!(ok);
    let credential = credential.trim();
    assert!(pika::nodes::valid_credential(credential), "{credential}");
    let (ok, list, _) = pika(&["node", "list"]);
    assert!(ok);
    let fields: Vec<&str> = list.trim().split('\t').collect();
    assert_eq!((fields[1], fields[3], fields[4], fields[5]), ("node01", "never", "-", "-"), "{list}");
    let id = fields[0].to_owned();
    assert!(pika(&["node", "rename", "node01", "build box"]).0);
    assert!(pika(&["node", "list"]).1.contains("\tbuild box\t"));
    assert!(!pika(&["node", "rename", &id, ""]).0);
    let (ok, _, stderr) = pika(&["node", "revoke", "build box"]);
    assert!(ok, "{stderr}");
    assert_eq!(pika(&["node", "list"]).1, "");
    let (ok, _, stderr) = pika(&["node", "revoke", &id]);
    assert!(!ok && stderr.contains("no node"), "{stderr}");
}

#[tokio::test]
async fn a_browser_that_stops_reading_is_closed_with_1008() {
    let s = server_with(|c| c.nodes.max_outgoing_bytes = 256 << 10).await;
    let cookie = s.login().await;
    let (mut node, _) = Peer::node(&s, &s.credential).await;
    let (mut browser, _) = Peer::client(&s, &cookie).await;
    let channel = browser.open("a", &s.node).await.unwrap();
    assert_eq!(node.next().await["channel"], channel);
    // The browser reads nothing while the node sends far more than its queue and the socket buffers hold.
    let pad = "x".repeat(64 << 10);
    for n in 0..256 {
        node.send(json!({ "type": "frame", "channel": channel, "body": { "n": n, "pad": pad } })).await;
    }
    assert_eq!(node.next().await, json!({ "type": "close", "channel": channel, "code": "client_gone" }));
    assert_eq!(browser.closed().await, 1008);
    // The node is unaffected.
    assert_eq!(s.state.nodes.online(), 1);
}
