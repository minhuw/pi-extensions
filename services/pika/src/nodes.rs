//! pika nodes: node credentials, presence, and channels between the owner's browsers and `pika-node` daemons. The
//! WebSocket routes are in `http::nodes`. See `docs/NODE.md`.
//!
//! The server keeps no terminal state: it pairs one browser socket with one node socket in a channel and forwards the
//! channel's `body` verbatim, without parsing it. As in `relay`, all state sits behind one mutex that is never held
//! across an `await` or SQLite I/O, and every frame to a socket goes through that socket's `Outbox` while the lock is
//! held, so the frames of a channel keep their order; a queue that grows past its maximum closes the socket with 1008.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

use anyhow::{Result, bail};
use rusqlite::{OptionalExtension, params};
use serde::Deserialize;
use serde_json::value::RawValue;
use serde_json::{Map, Value, json};
use tokio::sync::{oneshot, watch};

use crate::config::NodesConfig;
use crate::relay::{Closing, Connection, Outbox};
use crate::store::Store;
use crate::util::{base64_decode, base64url_encode, now_ms, random_bytes, sha256_hex};

/// WebSocket close codes, shared with relay.
pub mod close {
    pub use crate::relay::close::{BAD_FRAME, GOING_AWAY, NO_HELLO, REPLACED, REVOKED, SLOW_READER, TOO_MANY};
    /// Reserved for turning nodes off at run time, which v1 cannot do.
    pub const NODES_OFF: u16 = 4503;
}

/// The channel close code the server sends a client when the channel's node socket closes.
pub const NODE_OFFLINE: &str = "node_offline";
/// The channel close code the server sends a node when the channel's client socket closes.
pub const CLIENT_GONE: &str = "client_gone";

const OPEN_WINDOW: Duration = Duration::from_secs(60);

// ---------------------------------------------------------------------------------------------------------------
// Credentials and the `nodes` table

pub const CREDENTIAL_PREFIX: &str = "pkn_";

/// A node credential as the server makes them: `pkn_` and 43 base64url characters (32 random bytes).
pub fn valid_credential(credential: &str) -> bool {
    credential
        .strip_prefix(CREDENTIAL_PREFIX)
        .is_some_and(|rest| rest.len() == 43 && rest.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_')))
}

/// A node name as stored: a valid device name (see `auth::device_name`) of at most 64 UTF-16 units, which clients
/// require.
pub fn node_name(input: &str) -> Option<&str> {
    crate::auth::device_name(input).filter(|name| name.encode_utf16().count() <= 64)
}

const NAME_RULE: &str = "node names use 1-64 characters, without control characters";

/// A node created by `create_node`, with its credential, shown once.
pub struct NewNode {
    pub id: String,
    pub name: String,
    pub credential: String,
}

/// Creates a node named `name` with a new UUID and credential; only the credential's SHA-256 is stored.
pub fn create_node(store: &Store, name: &str) -> Result<NewNode> {
    let Some(name) = node_name(name) else { bail!(NAME_RULE) };
    let id = crate::auth::new_device_id();
    let credential = format!("{CREDENTIAL_PREFIX}{}", base64url_encode(&random_bytes::<32>()));
    store.write(|tx| {
        tx.execute(
            "INSERT INTO nodes (id, name, token_hash, created_at) VALUES (?1, ?2, ?3, ?4)",
            params![id, name, sha256_hex(credential.as_bytes()), now_ms()],
        )
    })?;
    Ok(NewNode { id, name: name.to_owned(), credential })
}

/// A row of `nodes`, without the credential's hash.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NodeRow {
    pub id: String,
    pub name: String,
    pub created_at: i64,
    pub last_seen_at: Option<i64>,
    pub last_host: Option<String>,
    pub public_key: Option<String>,
}

/// Every node, by name case-insensitively, then by id.
pub fn list_nodes(store: &Store) -> Result<Vec<NodeRow>> {
    let mut nodes = store.read(|conn| {
        conn.prepare_cached("SELECT id, name, created_at, last_seen_at, last_host, public_key FROM nodes")?
            .query_map([], |r| {
                Ok(NodeRow {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    created_at: r.get(2)?,
                    last_seen_at: r.get(3)?,
                    last_host: r.get(4)?,
                    public_key: r.get(5)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()
    })?;
    nodes.sort_by(|a, b| crate::auth::by_name((&a.id, &a.name), (&b.id, &b.name)));
    Ok(nodes)
}

/// The node id that `given` names for the CLI's `action`: a node id, else the name of exactly one node.
pub fn resolve_node(store: &Store, given: &str, action: &str) -> Result<String> {
    let (by_id, mut by_name) = store.read(|conn| {
        let by_id: Option<String> =
            conn.query_row("SELECT id FROM nodes WHERE id = ?1", [given], |r| r.get(0)).optional()?;
        let by_name = conn
            .prepare("SELECT id FROM nodes WHERE name = ?1")?
            .query_map([given], |r| r.get(0))?
            .collect::<rusqlite::Result<Vec<String>>>()?;
        Ok::<_, rusqlite::Error>((by_id, by_name))
    })?;
    if let Some(id) = by_id {
        return Ok(id);
    }
    match by_name.len() {
        0 => bail!("no node {given:?}"),
        1 => Ok(by_name.remove(0)),
        _ => {
            by_name.sort();
            bail!("several nodes are named {given:?}: {}; {action} by id", by_name.join(", "))
        }
    }
}

/// Deletes node `id` with its credential. A running server closes the node's socket with 4401 within
/// `NodesConfig::revalidate`.
pub fn revoke_node(store: &Store, id: &str) -> Result<bool> {
    Ok(store.write(|tx| tx.execute("DELETE FROM nodes WHERE id = ?1", [id]))? > 0)
}

/// Renames node `id` and returns the stored name; `Ok(None)` when there is no such node.
pub fn rename_node(store: &Store, id: &str, name: &str) -> Result<Option<String>> {
    let Some(name) = node_name(name) else { bail!(NAME_RULE) };
    Ok(store.write(|tx| {
        tx.query_row("UPDATE nodes SET name = ?2 WHERE id = ?1 RETURNING name", params![id, name], |r| r.get(0))
            .optional()
    })?)
}

/// The id and name of the node a credential belongs to; `None` for a malformed, unknown, or revoked credential, such as
/// a device token.
pub fn node_for_credential(store: &Store, credential: &str) -> Result<Option<(String, String)>> {
    if !valid_credential(credential) {
        return Ok(None);
    }
    let hash = sha256_hex(credential.as_bytes());
    Ok(store.read(|conn| {
        conn.prepare_cached("SELECT id, name FROM nodes WHERE token_hash = ?1")?
            .query_row([hash], |r| Ok((r.get(0)?, r.get(1)?)))
            .optional()
    })?)
}

/// Records a node's `hello`: its host, when it gave one, and its public key.
pub fn record_hello(store: &Store, id: &str, host: Option<&str>, public_key: &str, now: i64) -> Result<()> {
    store.write(|tx| {
        tx.execute(
            "UPDATE nodes SET last_seen_at = ?2, last_host = COALESCE(?3, last_host), public_key = ?4 WHERE id = ?1",
            params![id, now, host, public_key],
        )
    })?;
    Ok(())
}

/// Records that node `id` was seen at `now`; unless `always`, at most once per `auth::TOUCH_INTERVAL_MS`.
pub fn touch_node(store: &Store, id: &str, now: i64, always: bool) -> Result<bool> {
    let interval = if always { i64::MIN / 2 } else { crate::auth::TOUCH_INTERVAL_MS };
    Ok(store.write(|tx| {
        tx.execute(
            "UPDATE nodes SET last_seen_at = ?2 WHERE id = ?1 AND (last_seen_at IS NULL OR last_seen_at <= ?2 - ?3)",
            params![id, now, interval],
        )
    })? > 0)
}

/// The fingerprint of a public key given as base64url SPKI: the lowercase hex SHA-256 of the DER.
pub fn fingerprint(public_key: &str) -> Option<String> {
    base64_decode(public_key).map(|der| sha256_hex(&der))
}

/// A fingerprint as people compare it: its first 32 hex characters in 8 groups of 4.
pub fn display_fingerprint(fingerprint: &str) -> String {
    let head = &fingerprint[..fingerprint.len().min(32)];
    head.as_bytes().chunks(4).map(|c| std::str::from_utf8(c).unwrap_or_default()).collect::<Vec<_>>().join(" ")
}

// ---------------------------------------------------------------------------------------------------------------
// Routing frames

/// A frame the server cannot accept; the socket closes with 4400.
#[derive(Debug, PartialEq, Eq)]
pub struct BadFrame;

/// A node's `hello`, checked.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Hello {
    pub host: Option<String>,
    pub version: String,
    pub public_key: String,
}

/// A routing frame from a node or a client.
#[derive(Debug)]
pub enum Frame<'a> {
    Hello(Hello),
    Open { reference: String, node: String },
    /// `frame`: the body is forwarded as it came.
    Body { channel: String, body: &'a RawValue },
    Close { channel: String, code: String, reason: Option<String> },
    Pong,
}

#[derive(Deserialize)]
struct Raw<'a> {
    #[serde(rename = "type")]
    kind: String,
    channel: Option<Value>,
    #[serde(borrow)]
    body: Option<&'a RawValue>,
    code: Option<Value>,
    reason: Option<Value>,
    #[serde(rename = "ref")]
    reference: Option<Value>,
    node: Option<Value>,
    host: Option<Value>,
    version: Option<Value>,
    #[serde(rename = "protocolVersions")]
    protocol_versions: Option<Value>,
    #[serde(rename = "publicKey")]
    public_key: Option<Value>,
}

fn is_control(c: char) -> bool {
    matches!(c, '\u{0}'..='\u{1f}' | '\u{7f}'..='\u{9f}')
}

/// Nonblank single-line text of at most `max` UTF-16 units, as `label` in `protocol.ts`.
fn label(value: Option<&Value>, max: usize) -> Result<String, BadFrame> {
    match value {
        Some(Value::String(s)) if !s.trim().is_empty() && s.encode_utf16().count() <= max && !s.chars().any(is_control) => {
            Ok(s.clone())
        }
        _ => Err(BadFrame),
    }
}

fn optional_label(value: Option<&Value>, max: usize) -> Result<Option<String>, BadFrame> {
    value.map(|v| label(Some(v), max)).transpose()
}

/// A node, channel, or other id: 1-64 characters of `[A-Za-z0-9_-]`.
pub fn valid_id(id: &str) -> bool {
    (1..=64).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
}

/// A request id: 1-64 characters of `[A-Za-z0-9._:-]`.
pub fn valid_request_id(id: &str) -> bool {
    (1..=64).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b':' | b'-'))
}

fn id(value: Option<&Value>, valid: fn(&str) -> bool) -> Result<String, BadFrame> {
    match value {
        Some(Value::String(s)) if valid(s) => Ok(s.clone()),
        _ => Err(BadFrame),
    }
}

/// Text cut to at most `max` UTF-16 units without control characters; `None` when nothing is left.
pub fn clean(text: &str, max: usize) -> Option<String> {
    let mut out = String::new();
    let mut units = 0;
    for c in text.chars().filter(|c| !is_control(*c)) {
        units += c.len_utf16();
        if units > max {
            break;
        }
        out.push(c);
    }
    let out = out.trim();
    (!out.is_empty()).then(|| out.to_owned())
}

fn hello(raw: &Raw) -> Result<Hello, BadFrame> {
    let host = match &raw.host {
        Some(Value::String(host)) => clean(host, 255),
        _ => return Err(BadFrame),
    };
    let version = label(raw.version.as_ref(), 64)?;
    match &raw.protocol_versions {
        Some(Value::Array(versions))
            if (1..=16).contains(&versions.len()) && versions.iter().all(|v| v.as_u64().is_some_and(|v| v >= 1)) => {}
        _ => return Err(BadFrame),
    }
    let public_key = match &raw.public_key {
        Some(Value::String(key))
            if key.len() % 4 != 1
                && key.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
                && (64..=200).contains(&(key.len() * 3 / 4)) =>
        {
            key.clone()
        }
        _ => return Err(BadFrame),
    };
    Ok(Hello { host, version, public_key })
}

/// Parses a routing frame from a node (`from_node`) or a client. Fields the frame type does not use are ignored; an
/// unknown type, or one the sender may not send, is a bad frame.
pub fn parse(text: &str, from_node: bool) -> Result<Frame<'_>, BadFrame> {
    // serde reads a struct from an array too; a frame must be an object.
    if !text.trim_start().starts_with('{') {
        return Err(BadFrame);
    }
    let raw: Raw = serde_json::from_str(text).map_err(|_| BadFrame)?;
    Ok(match (raw.kind.as_str(), from_node) {
        ("hello", true) => Frame::Hello(hello(&raw)?),
        ("open", false) => {
            Frame::Open { reference: id(raw.reference.as_ref(), valid_request_id)?, node: id(raw.node.as_ref(), valid_id)? }
        }
        ("frame", _) => {
            let channel = id(raw.channel.as_ref(), valid_id)?;
            let body = raw.body.filter(|body| body.get().starts_with('{')).ok_or(BadFrame)?;
            Frame::Body { channel, body }
        }
        ("close", _) => Frame::Close {
            channel: id(raw.channel.as_ref(), valid_id)?,
            code: label(raw.code.as_ref(), 64)?,
            reason: optional_label(raw.reason.as_ref(), 200)?,
        },
        ("pong", _) => Frame::Pong,
        _ => return Err(BadFrame),
    })
}

fn close_json(channel: &str, code: &str, reason: Option<&str>) -> String {
    let mut frame = json!({ "type": "close", "channel": channel, "code": code });
    if let Some(reason) = reason {
        frame["reason"] = reason.into();
    }
    frame.to_string()
}

// ---------------------------------------------------------------------------------------------------------------
// Presence and channels

enum Role {
    /// A node socket, online once its `hello` succeeded.
    Node { id: String, credential_hash: String, online: bool },
    /// A browser socket: the owner session's id hash in `password` mode, the `client` object of `open`, and the
    /// times of its recent opens.
    Client { session: Option<String>, client: Value, opens: VecDeque<Instant> },
}

struct Socket {
    role: Role,
    outbox: Outbox,
    /// Asks the socket's task to close. Taken when the server closes it; the socket is forgotten when its task ends.
    closing: Option<oneshot::Sender<Closing>>,
    channels: HashSet<String>,
}

impl Socket {
    fn closed(&self) -> bool {
        self.closing.is_none()
    }
}

/// An online node, held by one socket.
struct Online {
    socket: u64,
    name: String,
    host: Option<String>,
    version: String,
    public_key: String,
    connected_at: i64,
}

struct Channel {
    node_socket: u64,
    client_socket: u64,
}

#[derive(Default)]
struct Inner {
    sockets: HashMap<u64, Socket>,
    online: HashMap<String, Online>,
    channels: HashMap<String, Channel>,
    /// Browser sockets per owner session, in `password` mode.
    per_session: HashMap<String, usize>,
    /// The `nodes` table as last read.
    known: Vec<NodeRow>,
    /// The last `nodes` frame sent, so an unchanged list is not sent again.
    nodes_frame: String,
}

impl Inner {
    /// Queues a frame for `socket`; one whose queue would grow past its maximum is closed with 1008.
    fn push(&mut self, socket: u64, frame: String) {
        let Some(s) = self.sockets.get(&socket).filter(|s| !s.closed()) else { return };
        if !s.outbox.push(frame) {
            self.close(socket, close::SLOW_READER, "outgoing buffer full");
        }
    }

    /// Asks `socket` to close, and closes its channels and takes its node offline at once.
    fn close(&mut self, socket: u64, code: u16, reason: &'static str) {
        let Some(s) = self.sockets.get_mut(&socket) else { return };
        if let Some(closing) = s.closing.take() {
            let _ = closing.send((code, reason));
        }
        self.detach(socket);
    }

    /// Closes the channels of `socket`, telling each other side, and takes its node offline if it still holds it.
    fn detach(&mut self, socket: u64) {
        let Some(s) = self.sockets.get_mut(&socket) else { return };
        let channels: Vec<String> = s.channels.drain().collect();
        let (code, offline) = match &mut s.role {
            Role::Node { id, online, .. } => (NODE_OFFLINE, std::mem::take(online).then(|| id.clone())),
            Role::Client { .. } => (CLIENT_GONE, None),
        };
        for channel in channels {
            let Some(c) = self.channels.remove(&channel) else { continue };
            let other = if c.node_socket == socket { c.client_socket } else { c.node_socket };
            if let Some(o) = self.sockets.get_mut(&other) {
                o.channels.remove(&channel);
            }
            self.push(other, close_json(&channel, code, None));
        }
        if let Some(id) = offline
            && self.online.get(&id).is_some_and(|o| o.socket == socket)
        {
            self.online.remove(&id);
            self.broadcast();
        }
    }

    /// The `nodes` frame: every known node, and any online node the last read of the table missed.
    fn nodes_json(&self) -> String {
        let mut items: Vec<(String, String, Value)> = Vec::new();
        let info = |id: &str, name: &str, row: Option<&NodeRow>| {
            let mut item = Map::new();
            item.insert("id".into(), id.into());
            item.insert("name".into(), name.into());
            let online = self.online.get(id);
            let host = online.and_then(|o| o.host.clone()).or_else(|| row.and_then(|r| r.last_host.clone()));
            if let Some(host) = host.as_deref().and_then(|h| clean(h, 255)) {
                item.insert("host".into(), host.into());
            }
            item.insert("online".into(), online.is_some().into());
            if let Some(online) = online {
                item.insert("version".into(), online.version.as_str().into());
            }
            let public_key = online.map(|o| o.public_key.clone()).or_else(|| row.and_then(|r| r.public_key.clone()));
            if let Some(public_key) = public_key {
                item.insert("publicKey".into(), public_key.into());
            }
            if let Some(online) = online {
                item.insert("connectedAt".into(), online.connected_at.into());
            }
            if let Some(seen) = row.and_then(|r| r.last_seen_at) {
                item.insert("lastSeenAt".into(), seen.into());
            }
            Value::Object(item)
        };
        for row in &self.known {
            // An online node shows the name it came online with until the table is read again.
            items.push((row.id.clone(), row.name.clone(), info(&row.id, &row.name, Some(row))));
        }
        for (id, online) in &self.online {
            if !self.known.iter().any(|r| &r.id == id) {
                items.push((id.clone(), online.name.clone(), info(id, &online.name, None)));
            }
        }
        items.sort_by(|a, b| crate::auth::by_name((&a.0, &a.1), (&b.0, &b.1)));
        let items: Vec<Value> = items.into_iter().map(|(_, _, item)| item).collect();
        json!({ "type": "nodes", "items": items }).to_string()
    }

    /// Sends every client the `nodes` frame when it changed.
    fn broadcast(&mut self) {
        let frame = self.nodes_json();
        if frame == self.nodes_frame {
            return;
        }
        self.nodes_frame = frame.clone();
        let clients: Vec<u64> = self
            .sockets
            .iter()
            .filter(|(_, s)| matches!(s.role, Role::Client { .. }) && !s.closed())
            .map(|(id, _)| *id)
            .collect();
        for client in clients {
            self.push(client, frame.clone());
        }
    }
}

/// A running socket task; see [`Nodes::task`].
pub struct Task<'a>(&'a Nodes);

impl Drop for Task<'_> {
    fn drop(&mut self) {
        self.0.tasks.send_modify(|n| *n -= 1);
    }
}

/// The nodes' state; one per server.
pub struct Nodes {
    config: NodesConfig,
    inner: Mutex<Inner>,
    next_socket: AtomicU64,
    /// Socket tasks still running, including ones finishing their close handshake.
    tasks: watch::Sender<usize>,
}

impl Nodes {
    pub fn new(config: NodesConfig) -> Nodes {
        Nodes { config, inner: Mutex::default(), next_socket: AtomicU64::new(1), tasks: watch::channel(0).0 }
    }

    pub fn config(&self) -> &NodesConfig {
        &self.config
    }

    pub fn enabled(&self) -> bool {
        self.config.enabled
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Counts a socket task until the guard drops, so stopping the server can wait for its close handshake.
    pub fn task(&self) -> Task<'_> {
        self.tasks.send_modify(|n| *n += 1);
        Task(self)
    }

    /// Waits until every socket task has ended, at most `within`; whether they all did.
    pub async fn drained(&self, within: Duration) -> bool {
        let mut tasks = self.tasks.subscribe();
        tokio::time::timeout(within, tasks.wait_for(|n| *n == 0)).await.is_ok()
    }

    fn limits(&self, max_channels: usize) -> Value {
        json!({
            "heartbeatSeconds": self.config.heartbeat.as_secs().max(1),
            "maxFrameBytes": self.config.max_frame_bytes,
            "maxChannels": max_channels,
        })
    }

    fn register(&self, inner: &mut Inner, role: Role) -> Connection {
        let id = self.next_socket.fetch_add(1, Ordering::Relaxed);
        let (outbox, frames) = Outbox::new(self.config.max_outgoing_bytes);
        let (closing, closing_rx) = oneshot::channel();
        let socket = Socket { role, outbox: outbox.clone(), closing: Some(closing), channels: HashSet::new() };
        inner.sockets.insert(id, socket);
        Connection { id, outbox, frames, closing: closing_rx }
    }

    /// Registers a node socket made with the credential whose SHA-256 is `credential_hash`; it stays offline until
    /// `hello`.
    pub fn connect_node(&self, id: &str, credential_hash: String) -> Connection {
        let mut inner = self.lock();
        self.register(&mut inner, Role::Node { id: id.to_owned(), credential_hash, online: false })
    }

    /// Registers a browser socket and queues its `welcome` and `nodes`, or `None` when the owner session has too many.
    /// `client` is the `client` object the node gets in `open`.
    pub fn connect_client(&self, session: Option<String>, client: Value) -> Option<Connection> {
        let mut inner = self.lock();
        if let Some(session) = &session {
            let count = inner.per_session.entry(session.clone()).or_default();
            if *count >= self.config.max_sockets_per_session {
                return None;
            }
            *count += 1;
        }
        let connection = self.register(&mut inner, Role::Client { session, client, opens: VecDeque::new() });
        let welcome = json!({ "type": "welcome", "serverVersion": env!("CARGO_PKG_VERSION"),
            "limits": self.limits(self.config.max_channels_per_client) });
        inner.push(connection.id, welcome.to_string());
        let nodes = inner.nodes_json();
        inner.nodes_frame = nodes.clone();
        inner.push(connection.id, nodes);
        Some(connection)
    }

    /// Forgets a socket whose task ended: closes its channels and takes its node offline if it still holds it.
    pub fn disconnect(&self, socket: u64) {
        let mut inner = self.lock();
        inner.detach(socket);
        let Some(s) = inner.sockets.remove(&socket) else { return };
        if let Role::Client { session: Some(session), .. } = s.role
            && let Some(count) = inner.per_session.get_mut(&session)
        {
            *count -= 1;
            if *count == 0 {
                inner.per_session.remove(&session);
            }
        }
    }

    /// Takes the node of `socket` online, named `name`, and sends `welcome`. An older socket of the same node closes
    /// with 4410. `Err` is the socket's close code. A socket that is closing stays offline.
    pub fn hello(&self, socket: u64, hello: Hello, name: String) -> Result<(), Closing> {
        let mut inner = self.lock();
        let id = match inner.sockets.get(&socket) {
            Some(s) if s.closed() => return Ok(()),
            Some(Socket { role: Role::Node { id, .. }, .. }) => id.clone(),
            Some(_) => return Err((close::BAD_FRAME, "bad frame")),
            None => return Err((close::GOING_AWAY, "closed")),
        };
        match inner.online.get(&id).map(|o| o.socket) {
            Some(old) => inner.close(old, close::REPLACED, "replaced by a newer socket"),
            None if inner.online.len() >= self.config.max_online => return Err((close::TOO_MANY, "too many online nodes")),
            None => {}
        }
        if let Some(Socket { role: Role::Node { online, .. }, .. }) = inner.sockets.get_mut(&socket) {
            *online = true;
        }
        let welcome = json!({ "type": "welcome", "node": id, "nodeName": name, "serverVersion": env!("CARGO_PKG_VERSION"),
            "limits": self.limits(self.config.max_channels_per_node) });
        let Hello { host, version, public_key } = hello;
        inner.online.insert(id, Online { socket, name, host, version, public_key, connected_at: now_ms() });
        inner.push(socket, welcome.to_string());
        inner.broadcast();
        Ok(())
    }

    /// Whether node `id` is online.
    pub fn is_online(&self, id: &str) -> bool {
        self.lock().online.contains_key(id)
    }

    /// Opens a channel from client `socket` to `node` and answers `opened`, or answers `refused`.
    pub fn open(&self, socket: u64, reference: &str, node: &str) {
        let mut inner = self.lock();
        let now = Instant::now();
        let (max_client, max_node, per_minute) =
            (self.config.max_channels_per_client, self.config.max_channels_per_node, self.config.opens_per_minute);
        // Opens refused for the socket's own limits do not count against the rate.
        let client = {
            let Some(s) = inner.sockets.get_mut(&socket).filter(|s| !s.closed()) else { return };
            let open_channels = s.channels.len();
            let Role::Client { client, opens, .. } = &mut s.role else { return };
            while opens.front().is_some_and(|at| now.duration_since(*at) >= OPEN_WINDOW) {
                opens.pop_front();
            }
            if open_channels >= max_client || opens.len() >= per_minute {
                None
            } else {
                opens.push_back(now);
                Some(client.clone())
            }
        };
        let refused = |code: &str| json!({ "type": "refused", "ref": reference, "code": code }).to_string();
        let Some(client) = client else {
            inner.push(socket, refused("too_many_channels"));
            return;
        };
        let node_socket = match inner.online.get(node) {
            Some(online) => online.socket,
            None => {
                let known = inner.known.iter().any(|r| r.id == node);
                inner.push(socket, refused(if known { NODE_OFFLINE } else { "unknown_node" }));
                return;
            }
        };
        if inner.sockets.get(&node_socket).is_none_or(|s| s.channels.len() >= max_node) {
            inner.push(socket, refused("too_many_channels"));
            return;
        }
        let channel = base64url_encode(&random_bytes::<16>());
        inner.channels.insert(channel.clone(), Channel { node_socket, client_socket: socket });
        for side in [node_socket, socket] {
            if let Some(s) = inner.sockets.get_mut(&side) {
                s.channels.insert(channel.clone());
            }
        }
        inner.push(node_socket, json!({ "type": "open", "channel": channel, "client": client }).to_string());
        inner.push(socket, json!({ "type": "opened", "ref": reference, "channel": channel, "node": node }).to_string());
    }

    /// The other side of `channel` from `socket`, when `socket` is one of its sides.
    fn peer(inner: &Inner, socket: u64, channel: &str) -> Option<u64> {
        let c = inner.channels.get(channel)?;
        if c.node_socket == socket {
            Some(c.client_socket)
        } else if c.client_socket == socket {
            Some(c.node_socket)
        } else {
            None
        }
    }

    /// Forwards a `frame` from `socket` to the other side of `channel`, with its body as it came. A channel that
    /// `socket` is not a side of, as one closed a moment ago, drops it.
    pub fn forward(&self, socket: u64, channel: &str, body: &RawValue) {
        let mut inner = self.lock();
        let Some(other) = Self::peer(&inner, socket, channel) else { return };
        // `channel` is a valid id, which needs no escaping.
        let frame = format!("{{\"type\":\"frame\",\"channel\":\"{channel}\",\"body\":{}}}", body.get());
        inner.push(other, frame);
    }

    /// Ends `channel` at the request of `socket`, one of its sides, and tells the other side.
    pub fn close_channel(&self, socket: u64, channel: &str, code: &str, reason: Option<&str>) {
        let mut inner = self.lock();
        let Some(other) = Self::peer(&inner, socket, channel) else { return };
        inner.channels.remove(channel);
        for side in [socket, other] {
            if let Some(s) = inner.sockets.get_mut(&side) {
                s.channels.remove(channel);
            }
        }
        inner.push(other, close_json(channel, code, reason));
    }

    /// Replaces the known nodes with the table's current rows and sends every client the list when it changed.
    pub fn publish(&self, rows: Vec<NodeRow>) {
        let mut inner = self.lock();
        inner.known = rows;
        inner.broadcast();
    }

    /// Closes every socket of node `id`, as when its credential is revoked.
    pub fn close_node(&self, id: &str, code: u16, reason: &'static str) {
        let mut inner = self.lock();
        let sockets: Vec<u64> = inner
            .sockets
            .iter()
            .filter(|(_, s)| matches!(&s.role, Role::Node { id: node, .. } if node == id))
            .map(|(socket, _)| *socket)
            .collect();
        for socket in sockets {
            inner.close(socket, code, reason);
        }
    }

    /// Closes `socket` with `code`.
    pub fn close(&self, socket: u64, code: u16, reason: &'static str) {
        self.lock().close(socket, code, reason);
    }

    /// Closes every socket, as when the server stops.
    pub fn close_all(&self, code: u16, reason: &'static str) {
        let mut inner = self.lock();
        let sockets: Vec<u64> = inner.sockets.keys().copied().collect();
        for socket in sockets {
            inner.close(socket, code, reason);
        }
    }

    /// The credential hash a node socket was made with.
    pub fn credential_of(&self, socket: u64) -> Option<String> {
        match &self.lock().sockets.get(&socket)?.role {
            Role::Node { credential_hash, .. } => Some(credential_hash.clone()),
            Role::Client { .. } => None,
        }
    }

    /// How many sockets are registered, node and client, online or not.
    pub fn sockets(&self) -> usize {
        self.lock().sockets.len()
    }

    /// How many nodes are online.
    pub fn online(&self) -> usize {
        self.lock().online.len()
    }

    /// How many channels are open.
    pub fn channels(&self) -> usize {
        self.lock().channels.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_match_the_contract() {
        let c = NodesConfig::default();
        assert!(!c.enabled && !c.insecure);
        assert_eq!((c.heartbeat.as_secs(), c.dead_after.as_secs(), c.hello_timeout.as_secs()), (20, 45, 10));
        assert_eq!((c.max_frame_bytes, c.max_outgoing_bytes), (2 << 20, 16 << 20));
        assert_eq!((c.max_channels_per_node, c.max_channels_per_client, c.opens_per_minute), (64, 16, 30));
        assert_eq!((c.max_online, c.max_sockets_per_session), (32, 4));
    }

    #[test]
    fn credentials_have_the_contract_format() {
        let credential = format!("{CREDENTIAL_PREFIX}{}", base64url_encode(&random_bytes::<32>()));
        assert_eq!(credential.len(), 47);
        assert!(valid_credential(&credential));
        for bad in ["", "pkn_", "pika_0123", &format!("pkn_{}", "a".repeat(44)), &format!("pkn_{}=", "a".repeat(42))] {
            assert!(!valid_credential(bad), "{bad}");
        }
    }

    #[test]
    fn node_names_fit_clients_utf16_limit() {
        assert_eq!(node_name(" node01 "), Some("node01"));
        assert!(node_name(&"é".repeat(64)).is_some());
        assert!(node_name(&"💻".repeat(33)).is_none(), "66 UTF-16 units");
        assert!(node_name("a\u{85}b").is_none());
    }

    #[test]
    fn frames_are_checked_and_bodies_kept_verbatim() {
        let text = r#"{"type":"frame","channel":"c-1","body":{ "t":"rec", "n":0,"ct":"x\u00e9" },"extra":1}"#;
        match parse(text, true).unwrap() {
            Frame::Body { channel, body } => {
                assert_eq!(channel, "c-1");
                assert_eq!(body.get(), r#"{ "t":"rec", "n":0,"ct":"x\u00e9" }"#);
            }
            other => panic!("{other:?}"),
        }
        let hello = json!({ "type": "hello", "host": "node01\u{1b}[31m", "version": "0.1.0", "protocolVersions": [1],
            "publicKey": "A".repeat(124) });
        match parse(&hello.to_string(), true).unwrap() {
            Frame::Hello(h) => assert_eq!(h.host.as_deref(), Some("node01[31m")),
            other => panic!("{other:?}"),
        }
        assert!(parse(&hello.to_string(), false).is_err(), "clients do not say hello");
        assert!(parse(r#"{"type":"open","ref":"r1","node":"n"}"#, false).is_ok());
        for bad in [
            r#"["frame","c",{}]"#,
            r#"{"type":"frame","channel":"c","body":[1]}"#,
            r#"{"type":"frame","channel":"c","body":"x"}"#,
            r#"{"type":"frame","channel":"c d","body":{}}"#,
            r#"{"type":"frame","channel":"c"}"#,
            r#"{"type":"close","channel":"c","code":""}"#,
            r#"{"type":"open","ref":"r1","node":"n"}"#,
            r#"{"type":"nodes"}"#,
            r#"{"type":1}"#,
            "not json",
        ] {
            assert!(parse(bad, true).is_err(), "{bad}");
        }
        let bad_key = json!({ "type": "hello", "host": "h", "version": "1", "protocolVersions": [1], "publicKey": "A+B" });
        assert!(parse(&bad_key.to_string(), true).is_err());
    }

    #[test]
    fn fingerprints_display_in_groups() {
        let fp = sha256_hex(b"x");
        assert_eq!(display_fingerprint(&fp).len(), 39);
        assert_eq!(display_fingerprint(&fp).split(' ').count(), 8);
    }
}
