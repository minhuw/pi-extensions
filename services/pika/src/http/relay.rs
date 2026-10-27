//! Relay routes: the device WebSocket `{base}/api/relay/v1/connect` and session list (bearer token), and the browser's
//! `relay/sessions`, `relay/messages`, and `relay/events` under `{base}/api/v1/`. See `docs/RELAY.md`.

use std::collections::BTreeMap;

use axum::extract::rejection::JsonRejection;
use axum::extract::ws::rejection::WebSocketUpgradeRejection;
use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, Request, State};
use axum::http::{HeaderMap, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use futures_util::stream::SplitSink;
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::sync::oneshot;
use tokio::time::{Duration, Instant};

use super::ingest::bearer;
use super::{AppState, blocking, error, internal_error};
use crate::relay::{
    self, Closing, Connection, Draft, Frames, Origin, Outcome, Reason, Reply, SessionInfo, StateUpdate, close,
};
use crate::util::{format_iso_ms, now_ms, sha256_hex};

/// 404 `{ error: "relay_disabled" }` on every relay route when relay is off.
pub async fn require_enabled(State(state): State<AppState>, request: Request, next: Next) -> Response {
    if !state.relay.enabled() {
        return error(StatusCode::NOT_FOUND, "relay_disabled");
    }
    next.run(request).await
}

/// The device of the request's bearer token, and the token; `None` for a missing, unknown, or revoked token.
async fn device(state: &AppState, headers: &HeaderMap) -> anyhow::Result<Option<(String, String)>> {
    let Some(token) = bearer(headers).map(str::to_owned) else { return Ok(None) };
    let (store, lookup) = (state.store.clone(), token.clone());
    let found = blocking(move || crate::auth::device_for_token(&store, &lookup)).await?;
    Ok(found.map(|(device, _)| (device, token)))
}

/// Reloads the relay's device names from the store, so that a rename from `pika token rename`, in another process,
/// shows too. Names are only for display: a failure, or a snapshot that an in-process rename overtook, keeps the old
/// ones.
async fn refresh_names(state: &AppState) {
    let (store, generation) = (state.store.clone(), state.relay.names_generation());
    match blocking(move || Ok(store.read(crate::auth::device_names)?)).await {
        Ok(names) => state.relay.set_names(names, generation),
        Err(e) => tracing::warn!("relay: reading device names: {e:#}"),
    }
}

/// `{ items: OnlineSession[] }`.
async fn session_list(state: &AppState) -> Response {
    refresh_names(state).await;
    let items = state.relay.online();
    let ids: Vec<String> = items.iter().map(|s| s.info.id.clone()).collect();
    let store = state.store.clone();
    let recorded = match blocking(move || relay::recorded_ids(&store, &ids)).await {
        Ok(recorded) => recorded,
        Err(e) => return internal_error(e),
    };
    let items: Vec<Value> = items.iter().map(|s| s.to_json(recorded.contains(&s.info.id))).collect();
    Json(json!({ "items": items })).into_response()
}

/// `GET {base}/api/relay/v1/sessions` for devices.
pub async fn device_sessions(State(state): State<AppState>, headers: HeaderMap) -> Response {
    match device(&state, &headers).await {
        Ok(Some(_)) => session_list(&state).await,
        Ok(None) => error(StatusCode::UNAUTHORIZED, "unauthorized"),
        Err(e) => internal_error(e),
    }
}

/// `GET relay/sessions` for the browser.
pub async fn sessions(State(state): State<AppState>) -> Response {
    session_list(&state).await
}

/// `GET relay/events?limit=`: default 100, at most the ring's 500.
pub async fn events(State(state): State<AppState>, Query(query): Query<BTreeMap<String, String>>) -> Response {
    let limit = match query.get("limit").map(|l| l.parse::<i64>()) {
        None => 100,
        Some(Ok(limit)) => limit.clamp(1, state.relay.config().event_ring as i64) as usize,
        Some(Err(_)) => {
            return (StatusCode::BAD_REQUEST, Json(json!({ "error": "bad_request", "message": "invalid limit" })))
                .into_response();
        }
    };
    refresh_names(&state).await;
    Json(json!({ "items": state.relay.events(limit) })).into_response()
}

/// What pika records about a valid target id.
async fn recorded(state: &AppState, draft: &Draft) -> anyhow::Result<Option<relay::Recorded>> {
    if !draft.valid {
        return Ok(None);
    }
    let (store, to) = (state.store.clone(), draft.to.clone());
    blocking(move || relay::recorded(&store, &to)).await
}

/// `POST relay/messages` with `{ to, text, urgent? }`, sent as `{ kind: "web" }` with hops 0.
pub async fn post_message(State(state): State<AppState>, body: Result<Json<Value>, JsonRejection>) -> Response {
    let body = match body {
        Ok(Json(body)) => body,
        Err(rejection @ JsonRejection::MissingJsonContentType(_)) => return rejection.into_response(),
        Err(_) => Value::Null,
    };
    let draft = Draft::parse(&body, true);
    refresh_names(&state).await;
    let recorded = match recorded(&state, &draft).await {
        Ok(recorded) => recorded,
        Err(e) => return internal_error(e),
    };
    let (tx, rx) = oneshot::channel();
    state.relay.send(Origin::Web, draft, recorded, Reply::Web(tx));
    match rx.await {
        Ok(Outcome::Accepted { id, delivered, target }) => Json(json!({
            "id": id, "status": if delivered { "delivered" } else { "queued" }, "to": state.relay.target_json(&target),
        }))
        .into_response(),
        Ok(Outcome::Rejected(reason)) => {
            let status = match reason {
                Reason::RateLimited | Reason::MailboxFull => StatusCode::TOO_MANY_REQUESTS,
                _ => StatusCode::BAD_REQUEST,
            };
            error(status, reason.as_str())
        }
        Err(e) => internal_error(e),
    }
}

/// `GET {base}/api/relay/v1/connect`: the token is checked before the upgrade.
pub async fn connect(
    State(state): State<AppState>,
    headers: HeaderMap,
    upgrade: Result<WebSocketUpgrade, WebSocketUpgradeRejection>,
) -> Response {
    let (device, token) = match device(&state, &headers).await {
        Ok(Some(found)) => found,
        Ok(None) => return error(StatusCode::UNAUTHORIZED, "unauthorized"),
        Err(e) => return internal_error(e),
    };
    let upgrade = match upgrade {
        Ok(upgrade) => upgrade,
        Err(rejection) => return rejection.into_response(),
    };
    let max = state.relay.config().max_frame_bytes;
    upgrade.max_message_size(max).max_frame_size(max).on_upgrade(move |socket| run(state, socket, device, token))
}

/// Takes the connection out of the relay when its task ends, however it ends.
struct Registered<'a>(&'a relay::Relay, u64);

impl Drop for Registered<'_> {
    fn drop(&mut self) {
        self.0.disconnect(self.1);
    }
}

fn close_frame(code: u16, reason: &str) -> Message {
    Message::Close(Some(CloseFrame { code, reason: reason.into() }))
}

/// One connection. The reader loop handles frames, pings, re-validates the token every heartbeat, and closes on a bad
/// frame, a missing `hello`, silence, a full outgoing queue, or the relay's request. A separate writer task writes the
/// frames, so a peer that stops reading holds up none of that.
async fn run(state: AppState, socket: WebSocket, device: String, token: String) {
    let relay = state.relay.clone();
    let _task = relay.task();
    let config = relay.config().clone();
    let (mut sink, mut stream) = socket.split();
    let Some(connection) = relay.connect(&device, sha256_hex(token.as_bytes())) else {
        let refusal = sink.send(close_frame(close::TOO_MANY, "too many connections"));
        let _ = tokio::time::timeout(config.write_timeout, refusal).await;
        return;
    };
    let Connection { id: conn, outbox, frames, closing: mut asked } = connection;
    let registered = Registered(&relay, conn);
    let (close_writer, closing) = oneshot::channel();
    let mut writer = tokio::spawn(write(sink, frames, closing, config.write_timeout));
    let opened = Instant::now();
    let mut last_frame = opened;
    let mut online = false;
    let mut heartbeat = tokio::time::interval_at(opened + config.heartbeat, config.heartbeat);
    heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    // `None` ends the connection without a close frame: the peer closed it, or the writer could not write.
    let closing: Option<Closing> = loop {
        let deadline = if online { last_frame + config.dead_after } else { opened + config.hello_timeout };
        let closing = tokio::select! {
            frame = stream.next() => match frame {
                None | Some(Ok(Message::Close(_))) => break None,
                Some(Err(_)) => Some(BAD),
                Some(Ok(message)) => {
                    last_frame = Instant::now();
                    let was_online = online;
                    match handle(&state, conn, (&device, &token), &mut online, message).await {
                        // The heartbeat starts when the session comes online.
                        Ok(()) if !was_online => {
                            heartbeat.reset();
                            None
                        }
                        Ok(()) => {
                            relay.touch(conn);
                            None
                        }
                        Err(closing) => Some(closing),
                    }
                }
            },
            asked = &mut asked => Some(asked.unwrap_or((close::GOING_AWAY, "closed"))),
            // A write failed or did not finish in time.
            _ = &mut writer => break None,
            _ = heartbeat.tick(), if online => {
                let ping = json!({ "type": "ping", "at": format_iso_ms(now_ms()) }).to_string();
                if revoked(&state, &token, &device).await {
                    Some((close::REVOKED, "token revoked"))
                } else if !outbox.push(ping) {
                    Some((close::SLOW_READER, "outgoing buffer full"))
                } else {
                    None
                }
            },
            _ = tokio::time::sleep_until(deadline) => Some(if online {
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
    if let Some((code, reason)) = closing {
        tracing::debug!("relay: closing a connection of {device}: {code} {reason}");
        let _ = close_writer.send((code, reason));
        let _ = writer.await;
        // Read the peer's answer to the close frame: a socket closed with it unread is reset, and the peer loses the
        // close frame, as Linux showed when the server stopped.
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

/// How long a closing connection waits for the peer to answer its close frame.
const CLOSE_HANDSHAKE: Duration = Duration::from_secs(2);

/// Writes a connection's frames, each within `timeout`, until the reader asks it to close; then it skips the frames
/// still queued and sends the close frame, also within `timeout`. A write that fails or does not finish in time ends
/// it early, which the reader takes as a dead connection.
async fn write(
    mut sink: SplitSink<WebSocket, Message>,
    mut frames: Frames,
    mut closing: oneshot::Receiver<Closing>,
    timeout: Duration,
) {
    let closing = loop {
        let frame = tokio::select! {
            biased;
            closing = &mut closing => break closing,
            frame = frames.recv() => match frame {
                Some(frame) => frame,
                None => return,
            },
        };
        let len = frame.len();
        let written = tokio::select! {
            biased;
            closing = &mut closing => break closing,
            written = tokio::time::timeout(timeout, sink.send(Message::Text(frame.into()))) => written,
        };
        frames.written(len);
        if !matches!(written, Ok(Ok(()))) {
            return;
        }
    };
    if let Ok((code, reason)) = closing {
        let _ = tokio::time::timeout(timeout, sink.send(close_frame(code, reason))).await;
    }
}

/// Whether the connection's token no longer names its device, as after `pika token revoke` in another process.
async fn revoked(state: &AppState, token: &str, device: &str) -> bool {
    let (store, token) = (state.store.clone(), token.to_owned());
    match blocking(move || crate::auth::device_for_token(&store, &token)).await {
        Ok(found) => found.is_none_or(|(name, _)| name != device),
        Err(e) => {
            tracing::warn!("relay: checking a token: {e:#}");
            false
        }
    }
}

const BAD: Closing = (close::BAD_FRAME, "bad frame");

/// Handles one frame from the connection made by `device` with `token`; `Err` closes the connection.
async fn handle(
    state: &AppState,
    conn: u64,
    (device, token): (&str, &str),
    online: &mut bool,
    message: Message,
) -> Result<(), Closing> {
    let text = match message {
        Message::Text(text) => text,
        Message::Binary(_) => return Err(BAD),
        // Control frames count as liveness only.
        _ => return Ok(()),
    };
    if text.len() > state.relay.config().max_frame_bytes {
        return Err(BAD);
    }
    let Ok(Value::Object(frame)) = serde_json::from_str::<Value>(text.as_str()) else { return Err(BAD) };
    let Some(kind) = frame.get("type").and_then(Value::as_str) else { return Err(BAD) };
    let relay = &state.relay;
    match (kind, *online) {
        ("hello", false) => {
            let info = SessionInfo::parse(frame.get("session")).map_err(|_| BAD)?;
            // The token may have been revoked between the upgrade and the connection's registration.
            if revoked(state, token, device).await {
                return Err((close::REVOKED, "token revoked"));
            }
            refresh_names(state).await;
            let (store, id) = (state.store.clone(), info.id.clone());
            let recorded = match blocking(move || relay::recorded(&store, &id)).await {
                Ok(recorded) => recorded,
                Err(e) => {
                    tracing::error!("relay: looking up a session: {e:#}");
                    return Err((close::GOING_AWAY, "internal error"));
                }
            };
            relay
                .hello(conn, info, recorded.as_ref().map(|r| r.device.as_str()))
                .map_err(|code| (code, reason(code)))?;
            *online = true;
        }
        (_, false) | ("hello", true) => return Err(BAD),
        ("state", true) => relay.state(conn, StateUpdate::parse(&frame).map_err(|_| BAD)?),
        ("send", true) => {
            let client_id = relay::client_id(&frame).ok_or(BAD)?;
            let draft = Draft::parse(&Value::Object(frame), false);
            refresh_names(state).await;
            let recorded = match recorded(state, &draft).await {
                Ok(recorded) => recorded,
                Err(e) => {
                    tracing::error!("relay: looking up a session: {e:#}");
                    return Err((close::GOING_AWAY, "internal error"));
                }
            };
            relay.send(Origin::Conn(conn), draft, recorded, Reply::Socket { conn, client_id });
        }
        ("ack", true) => match frame.get("id") {
            Some(Value::String(id)) => relay.ack(conn, id),
            _ => return Err(BAD),
        },
        ("pong", true) => {}
        _ => return Err(BAD),
    }
    Ok(())
}

fn reason(code: u16) -> &'static str {
    match code {
        close::OTHER_DEVICE => "session belongs to another device",
        close::ONLINE_ELSEWHERE => "session already online from another device",
        close::TOO_MANY => "too many online sessions",
        _ => "closed",
    }
}

/// The device routes under `{base}/api/relay/v1/`.
pub fn device_routes(state: &AppState) -> Router<AppState> {
    Router::new()
        .route("/api/relay/v1/connect", get(connect))
        .route("/api/relay/v1/sessions", get(device_sessions))
        .route_layer(middleware::from_fn_with_state(state.clone(), require_enabled))
}

/// The browser routes under `{base}/api/v1/`, behind `login` and, before it, the relay switch.
pub fn browser_routes(state: &AppState, login: impl Fn(Router<AppState>) -> Router<AppState>) -> Router<AppState> {
    let routes = Router::new()
        .route("/relay/sessions", get(sessions))
        .route("/relay/messages", post(post_message))
        .route("/relay/events", get(events));
    login(routes).route_layer(middleware::from_fn_with_state(state.clone(), require_enabled))
}
