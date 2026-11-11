//! Node routes: the node WebSocket `{base}/api/node/v1/connect` (node credential) and the browser's
//! `{base}/api/v1/node/connect` (owner session and same-origin `Origin`). See `docs/NODE.md`.

use axum::extract::ws::rejection::WebSocketUpgradeRejection;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Request, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Extension, Router};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Map, Value, json};
use tokio::sync::oneshot;
use tokio::time::Instant;

use super::auth::{Client, CurrentSession};
use super::ingest::bearer;
use super::relay::{CLOSE_HANDSHAKE, close_frame, write};
use super::{AppState, blocking, error, internal_error};
use crate::config::{AuthMode, origin_of};
use crate::nodes::{self, Frame, close};
use crate::relay::{Closing, Connection};
use crate::util::{now_ms, sha256_hex};

/// 404 `{ error: "nodes_disabled" }` on every node route when nodes are off, before authentication.
pub async fn require_enabled(State(state): State<AppState>, request: Request, next: Next) -> Response {
    if !state.nodes.enabled() {
        return error(StatusCode::NOT_FOUND, "nodes_disabled");
    }
    next.run(request).await
}

/// The node id of the request's bearer credential, and the credential; `None` for a missing, unknown, or revoked
/// credential, and for any device token.
async fn node(state: &AppState, headers: &HeaderMap) -> anyhow::Result<Option<(String, String)>> {
    let Some(credential) = bearer(headers).map(str::to_owned) else { return Ok(None) };
    let (store, lookup) = (state.store.clone(), credential.clone());
    let found = blocking(move || nodes::node_for_credential(&store, &lookup)).await?;
    Ok(found.map(|(id, _)| (id, credential)))
}

/// Re-reads the `nodes` table and sends every browser the list when it changed. The list is only for display: a
/// failure keeps the old one.
async fn refresh(state: &AppState) {
    let store = state.store.clone();
    match blocking(move || nodes::list_nodes(&store)).await {
        Ok(rows) => state.nodes.publish(rows),
        Err(e) => tracing::warn!("nodes: reading the node list: {e:#}"),
    }
}

/// `GET {base}/api/node/v1/connect`: the credential is checked before the upgrade.
pub async fn node_connect(
    State(state): State<AppState>,
    headers: HeaderMap,
    upgrade: Result<WebSocketUpgrade, WebSocketUpgradeRejection>,
) -> Response {
    let (id, credential) = match node(&state, &headers).await {
        Ok(Some(found)) => found,
        Ok(None) => return error(StatusCode::UNAUTHORIZED, "unauthorized"),
        Err(e) => return internal_error(e),
    };
    let upgrade = match upgrade {
        Ok(upgrade) => upgrade,
        Err(rejection) => return rejection.into_response(),
    };
    let max = state.nodes.config().max_frame_bytes;
    upgrade.max_message_size(max).max_frame_size(max).on_upgrade(move |socket| run(state, socket, Peer::Node { id, credential }))
}

/// Whether the request's `Origin` is the server's own, as the request reached it, or the configured public URL's.
fn same_origin(state: &AppState, headers: &HeaderMap, client: &Client) -> bool {
    let Some(origin) = headers.get(header::ORIGIN).and_then(|v| v.to_str().ok()).and_then(origin_of) else {
        return false;
    };
    if state.config.nodes.public_origin.as_deref() == Some(origin.as_str()) {
        return true;
    }
    let scheme = if client.https { "https" } else { "http" };
    headers
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .and_then(|host| origin_of(&format!("{scheme}://{host}")))
        .is_some_and(|own| own == origin)
}

/// `GET {base}/api/v1/node/connect` for the browser. `require` has checked the owner session in `password` mode; the
/// proxy authenticates in `proxy` mode; `none` mode answers 404 unless `PIKA_NODES_INSECURE` allows it.
pub async fn client_connect(
    State(state): State<AppState>,
    client: Client,
    headers: HeaderMap,
    current: Option<Extension<CurrentSession>>,
    upgrade: Result<WebSocketUpgrade, WebSocketUpgradeRejection>,
) -> Response {
    let mode = state.auth.mode();
    if mode == AuthMode::None && !state.config.nodes.insecure {
        return error(StatusCode::NOT_FOUND, "nodes_disabled");
    }
    if !same_origin(&state, &headers, &client) {
        return error(StatusCode::FORBIDDEN, "forbidden_origin");
    }
    let session = current.map(|Extension(CurrentSession(id_hash))| id_hash);
    if mode == AuthMode::Password && session.is_none() {
        return error(StatusCode::UNAUTHORIZED, "unauthorized");
    }
    let upgrade = match upgrade {
        Ok(upgrade) => upgrade,
        Err(rejection) => return rejection.into_response(),
    };
    let mut info = Map::new();
    let label = session.as_deref().map_or(mode.as_str(), |id_hash| &id_hash[..12]);
    info.insert("session".into(), label.into());
    if let Some(agent) = headers.get(header::USER_AGENT).and_then(|v| v.to_str().ok()).and_then(|v| nodes::clean(v, 512)) {
        info.insert("userAgent".into(), agent.into());
    }
    if let Some(ip) = client.ip {
        info.insert("ip".into(), ip.to_canonical().to_string().into());
    }
    let max = state.nodes.config().max_frame_bytes;
    upgrade
        .max_message_size(max)
        .max_frame_size(max)
        .on_upgrade(move |socket| run(state, socket, Peer::Client { session, info: Value::Object(info) }))
}

/// The side a socket speaks for.
enum Peer {
    /// A node, by id, with its credential.
    Node { id: String, credential: String },
    /// A browser: the owner session's id hash in `password` mode, and the `client` object nodes get in `open`.
    Client { session: Option<String>, info: Value },
}

/// Takes the socket out of the nodes' state when its task ends, however it ends.
struct Registered<'a>(&'a nodes::Nodes, u64);

impl Drop for Registered<'_> {
    fn drop(&mut self) {
        self.0.disconnect(self.1);
    }
}

const BAD: Closing = (close::BAD_FRAME, "bad frame");

/// One socket. The reader loop handles frames, pings, re-checks the credential or session every `revalidate`, and
/// closes on a bad frame, a missing `hello`, silence, a full outgoing queue, or the server's request. A separate writer
/// task writes the frames, so a peer that stops reading holds up neither the other sockets nor this one's reader.
async fn run(state: AppState, socket: WebSocket, peer: Peer) {
    let hub = state.nodes.clone();
    let _task = hub.task();
    let config = hub.config().clone();
    let (mut sink, mut stream) = socket.split();
    let connection = match &peer {
        Peer::Node { id, credential } => Some(hub.connect_node(id, sha256_hex(credential.as_bytes()))),
        Peer::Client { session, info } => {
            refresh(&state).await;
            hub.connect_client(session.clone(), info.clone())
        }
    };
    let Some(Connection { id: socket, outbox, frames, closing: mut asked }) = connection else {
        let refusal = sink.send(close_frame(close::TOO_MANY, "too many sockets"));
        let _ = tokio::time::timeout(config.write_timeout, refusal).await;
        return;
    };
    let registered = Registered(&hub, socket);
    let (close_writer, closing) = oneshot::channel();
    let mut writer = tokio::spawn(write(sink, frames, closing, config.write_timeout));
    let opened = Instant::now();
    let mut last_frame = opened;
    // A browser is ready at once; a node after its `hello`.
    let mut ready = matches!(peer, Peer::Client { .. });
    let mut heartbeat = tokio::time::interval_at(opened + config.heartbeat, config.heartbeat);
    heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut revalidate = tokio::time::interval_at(opened + config.revalidate, config.revalidate);
    revalidate.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    // `None` ends the socket without a close frame: the peer closed it, or the writer could not write.
    let closing: Option<Closing> = loop {
        let deadline = if ready { last_frame + config.dead_after } else { opened + config.hello_timeout };
        let closing = tokio::select! {
            frame = stream.next() => match frame {
                None | Some(Ok(Message::Close(_))) => break None,
                Some(Err(_)) => Some(BAD),
                Some(Ok(message)) => {
                    last_frame = Instant::now();
                    let was_ready = ready;
                    match handle(&state, socket, &peer, &mut ready, message).await {
                        // The heartbeat starts when the node comes online.
                        Ok(()) if !was_ready && ready => {
                            heartbeat.reset();
                            None
                        }
                        Ok(()) => None,
                        Err(closing) => Some(closing),
                    }
                }
            },
            asked = &mut asked => Some(asked.unwrap_or((close::GOING_AWAY, "closed"))),
            // A write failed or did not finish in time.
            _ = &mut writer => break None,
            _ = heartbeat.tick(), if ready => {
                if let Peer::Node { id, .. } = &peer {
                    let (store, id) = (state.store.clone(), id.clone());
                    if let Err(e) = blocking(move || nodes::touch_node(&store, &id, now_ms(), false)).await {
                        tracing::warn!("nodes: recording that a node was seen: {e:#}");
                    }
                }
                let ping = json!({ "type": "ping", "at": now_ms() }).to_string();
                (!outbox.push(ping)).then_some((close::SLOW_READER, "outgoing buffer full"))
            },
            _ = revalidate.tick() => {
                if revoked(&state, &peer).await {
                    Some((close::REVOKED, if matches!(peer, Peer::Node { .. }) { "credential revoked" } else { "session revoked" }))
                } else {
                    if matches!(peer, Peer::Client { .. }) {
                        refresh(&state).await;
                    }
                    None
                }
            },
            _ = tokio::time::sleep_until(deadline) => Some(if ready {
                (close::GOING_AWAY, "no frame in time")
            } else {
                (close::NO_HELLO, "no hello in time")
            }),
        };
        if let Some(closing) = closing {
            break Some(closing);
        }
    };
    drop(registered);
    if let Peer::Node { id, .. } = &peer
        && ready
    {
        let (store, id) = (state.store.clone(), id.clone());
        if let Err(e) = blocking(move || nodes::touch_node(&store, &id, now_ms(), true)).await {
            tracing::warn!("nodes: recording that a node was seen: {e:#}");
        }
        refresh(&state).await;
    }
    if let Some((code, reason)) = closing {
        tracing::debug!("nodes: closing a socket: {code} {reason}");
        let _ = close_writer.send((code, reason));
        let _ = writer.await;
        // Read the peer's answer to the close frame, so that the peer gets the close frame (see `http::relay`).
        let answered = async {
            while let Some(Ok(message)) = stream.next().await {
                if matches!(message, Message::Close(_)) {
                    break;
                }
            }
        };
        let _ = tokio::time::timeout(CLOSE_HANDSHAKE, answered).await;
    }
}

/// Whether the socket's node credential or owner session is gone, as after `pika node revoke` or a sign-out.
async fn revoked(state: &AppState, peer: &Peer) -> bool {
    let store = state.store.clone();
    let checked = match peer {
        Peer::Node { id, credential } => {
            let (credential, id) = (credential.clone(), id.clone());
            blocking(move || Ok(nodes::node_for_credential(&store, &credential)?.is_none_or(|(node, _)| node != id))).await
        }
        Peer::Client { session: Some(id_hash), .. } => {
            let id_hash = id_hash.clone();
            blocking(move || Ok(!crate::auth::session_alive(&store, &id_hash)?)).await
        }
        Peer::Client { session: None, .. } => Ok(false),
    };
    checked.unwrap_or_else(|e| {
        tracing::warn!("nodes: checking a credential: {e:#}");
        false
    })
}

/// Handles one frame from `socket`; `Err` closes it.
async fn handle(state: &AppState, socket: u64, peer: &Peer, ready: &mut bool, message: Message) -> Result<(), Closing> {
    let text = match message {
        Message::Text(text) => text,
        Message::Binary(_) => return Err(BAD),
        // Control frames count as liveness only.
        _ => return Ok(()),
    };
    if text.len() > state.nodes.config().max_frame_bytes {
        return Err(BAD);
    }
    let hub = &state.nodes;
    let frame = nodes::parse(text.as_str(), matches!(peer, Peer::Node { .. })).map_err(|_| BAD)?;
    match (frame, peer, *ready) {
        (Frame::Hello(hello), Peer::Node { id, credential }, false) => {
            // The credential may have been revoked between the upgrade and `hello`.
            let (store, lookup) = (state.store.clone(), credential.clone());
            let name = match blocking(move || nodes::node_for_credential(&store, &lookup)).await {
                Ok(Some((node, name))) if node == *id => name,
                Ok(_) => return Err((close::REVOKED, "credential revoked")),
                Err(e) => {
                    tracing::error!("nodes: checking a credential: {e:#}");
                    return Err((close::GOING_AWAY, "internal error"));
                }
            };
            let (host, public_key) = (hello.host.clone(), hello.public_key.clone());
            hub.hello(socket, hello, name)?;
            *ready = true;
            let (store, id) = (state.store.clone(), id.clone());
            if let Err(e) = blocking(move || nodes::record_hello(&store, &id, host.as_deref(), &public_key, now_ms())).await
            {
                tracing::warn!("nodes: recording a hello: {e:#}");
            }
            refresh(state).await;
        }
        (_, Peer::Node { .. }, false) | (Frame::Hello(_), _, _) => return Err(BAD),
        (Frame::Open { reference, node }, Peer::Client { .. }, _) => {
            // A node created since the list was last read is offline, not unknown.
            if !hub.is_online(&node) {
                refresh(state).await;
            }
            hub.open(socket, &reference, &node);
        }
        (Frame::Open { .. }, Peer::Node { .. }, _) => return Err(BAD),
        (Frame::Body { channel, body }, _, _) => hub.forward(socket, &channel, body),
        (Frame::Close { channel, code, reason }, _, _) => hub.close_channel(socket, &channel, &code, reason.as_deref()),
        (Frame::Pong, _, _) => {}
    }
    Ok(())
}

/// The node route `{base}/api/node/v1/connect`, behind the nodes switch.
pub fn node_routes(state: &AppState) -> Router<AppState> {
    Router::new()
        .route("/api/node/v1/connect", get(node_connect))
        .route_layer(middleware::from_fn_with_state(state.clone(), require_enabled))
}

/// The browser route under `{base}/api/v1/`, behind `login` and, before it, the nodes switch.
pub fn browser_routes(state: &AppState, login: impl Fn(Router<AppState>) -> Router<AppState>) -> Router<AppState> {
    login(Router::new().route("/node/connect", get(client_connect)))
        .route_layer(middleware::from_fn_with_state(state.clone(), require_enabled))
}
