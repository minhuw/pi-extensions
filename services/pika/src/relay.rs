//! pika relay: the online pi sessions, an in-memory mailbox, and the dashboard's event ring. The WebSocket and HTTP
//! routes are in `http::relay`. See `docs/RELAY.md`.
//!
//! All state sits behind one mutex that is never held across an `await`. Every frame to a connection goes through that
//! connection's `Outbox` while the lock is held, so `sent`, `status`, and `message` frames keep the order in which the
//! relay decided them. Each connection's writer task drains its outbox, so a peer that stops reading holds up neither
//! the relay nor its own connection's reader; a queue that grows past its maximum closes the connection with 1008.

use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use anyhow::Result;
use rusqlite::OptionalExtension;
use serde_json::{Map, Value, json};
use tokio::sync::{mpsc, oneshot};
use tokio::task::AbortHandle;

use crate::config::RelayConfig;
use crate::ratelimit::SlidingWindow;
use crate::store::Store;
use crate::util::{base64url_encode, cut_bytes, cut_chars, format_iso_ms, now_ms, random_bytes};

/// WebSocket close codes.
pub mod close {
    pub const GOING_AWAY: u16 = 1001;
    /// The connection's outgoing queue grew past its maximum: the peer reads too slowly.
    pub const SLOW_READER: u16 = 1008;
    pub const BAD_FRAME: u16 = 4400;
    pub const REVOKED: u16 = 4401;
    pub const OTHER_DEVICE: u16 = 4403;
    pub const NO_HELLO: u16 = 4408;
    pub const ONLINE_ELSEWHERE: u16 = 4409;
    pub const REPLACED: u16 = 4410;
    pub const TOO_MANY: u16 = 4429;
    /// Reserved for turning relay off at run time, which v1 cannot do.
    pub const RELAY_OFF: u16 = 4503;
}

/// A close code and its reason.
pub type Closing = (u16, &'static str);

const MAX_ID_CHARS: usize = 128;
const MAX_CLIENT_ID_CHARS: usize = 64;
const MAX_MESSAGE_ID_CHARS: usize = 64;

/// A pi session id: 1-128 characters of `[A-Za-z0-9._-]`.
pub fn valid_session_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_ID_CHARS
        && id.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

/// A message id as the relay makes them: 1-64 characters of the URL-safe alphabet `[A-Za-z0-9_-]`.
pub fn valid_message_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_MESSAGE_ID_CHARS
        && id.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
}

/// A connection's outgoing frames, and how many bytes of them its writer has not written yet.
#[derive(Clone)]
pub struct Outbox {
    tx: mpsc::UnboundedSender<String>,
    queued: Arc<AtomicUsize>,
    max: usize,
}

impl Outbox {
    /// Queues a frame, or returns false when it would take the queue past its maximum.
    pub fn push(&self, frame: String) -> bool {
        let len = frame.len();
        if self.queued.fetch_add(len, Ordering::Relaxed) + len > self.max {
            self.queued.fetch_sub(len, Ordering::Relaxed);
            return false;
        }
        let _ = self.tx.send(frame);
        true
    }
}

/// The writer's end of an `Outbox`.
pub struct Frames {
    rx: mpsc::UnboundedReceiver<String>,
    queued: Arc<AtomicUsize>,
}

impl Frames {
    pub async fn recv(&mut self) -> Option<String> {
        self.rx.recv().await
    }

    /// A frame of `len` bytes was written and no longer counts against the queue.
    pub fn written(&self, len: usize) {
        self.queued.fetch_sub(len, Ordering::Relaxed);
    }
}

/// A registered connection: its id, its outbox and the writer's end of it, and the relay's request to close it.
pub struct Connection {
    pub id: u64,
    pub outbox: Outbox,
    pub frames: Frames,
    pub closing: oneshot::Receiver<Closing>,
}

/// A frame the relay cannot accept; the connection closes with 4400.
#[derive(Debug, PartialEq, Eq)]
pub struct BadFrame;

fn put(object: &mut Map<String, Value>, key: &str, value: &Option<String>) {
    if let Some(value) = value {
        object.insert(key.into(), value.as_str().into());
    }
}

fn optional(value: Option<&Value>) -> Result<Option<&Value>, BadFrame> {
    Ok(value.filter(|v| !v.is_null()))
}

/// An optional string field cut to `max` characters; any other type than a string or null is an error.
fn optional_string(object: &Map<String, Value>, key: &str, max: usize) -> Result<Option<String>, BadFrame> {
    match optional(object.get(key))? {
        None => Ok(None),
        Some(Value::String(s)) => Ok(Some(cut_chars(s, max).to_owned())),
        Some(_) => Err(BadFrame),
    }
}

fn required_string(object: &Map<String, Value>, key: &str, max: usize) -> Result<String, BadFrame> {
    optional_string(object, key, max)?.ok_or(BadFrame)
}

fn parse_state(value: &Value) -> Result<bool, BadFrame> {
    match value.as_str() {
        Some("idle") => Ok(false),
        Some("busy") => Ok(true),
        _ => Err(BadFrame),
    }
}

fn state_str(busy: bool) -> &'static str {
    if busy { "busy" } else { "idle" }
}

/// The `session` of a `hello` frame.
#[derive(Clone, Debug)]
pub struct SessionInfo {
    pub id: String,
    pub name: Option<String>,
    pub title: Option<String>,
    pub cwd: String,
    pub project: String,
    pub host: String,
    pub model: Option<String>,
    pub busy: bool,
    pub pi_version: Option<String>,
    pub relay_version: String,
}

impl SessionInfo {
    /// Parses the `session` object of a `hello` frame; `Err` makes it a bad frame.
    pub fn parse(value: Option<&Value>) -> Result<SessionInfo, BadFrame> {
        let Some(Value::Object(s)) = value else { return Err(BadFrame) };
        let id = match s.get("id") {
            Some(Value::String(id)) if valid_session_id(id) => id.clone(),
            _ => return Err(BadFrame),
        };
        Ok(SessionInfo {
            id,
            name: optional_string(s, "name", 200)?,
            title: optional_string(s, "title", 200)?,
            cwd: required_string(s, "cwd", 1024)?,
            project: required_string(s, "project", 255)?,
            host: required_string(s, "host", 255)?,
            model: optional_string(s, "model", 200)?,
            busy: parse_state(s.get("state").ok_or(BadFrame)?)?,
            pi_version: optional_string(s, "piVersion", 64)?,
            relay_version: required_string(s, "relayVersion", 64)?,
        })
    }
}

/// A `state` frame; absent fields stay as they are.
#[derive(Debug, Default)]
pub struct StateUpdate {
    pub busy: Option<bool>,
    pub name: Option<String>,
    pub title: Option<String>,
    pub model: Option<String>,
}

impl StateUpdate {
    pub fn parse(frame: &Map<String, Value>) -> Result<StateUpdate, BadFrame> {
        Ok(StateUpdate {
            busy: optional(frame.get("state"))?.map(parse_state).transpose()?,
            name: optional_string(frame, "name", 200)?,
            title: optional_string(frame, "title", 200)?,
            model: optional_string(frame, "model", 200)?,
        })
    }
}

/// The `clientId` of a `send` frame; a missing or overlong one makes it a bad frame, since `sent` could not name it.
pub fn client_id(frame: &Map<String, Value>) -> Option<String> {
    match frame.get("clientId") {
        Some(Value::String(id)) if id.chars().count() <= MAX_CLIENT_ID_CHARS => Some(id.clone()),
        _ => None,
    }
}

/// A message someone wants to send, before the relay checks it.
#[derive(Clone, Debug)]
pub struct Draft {
    /// `to` as given, cut to 128 characters, or empty when it was not a string.
    pub to: String,
    pub text: String,
    pub urgent: bool,
    pub reply_to: Option<String>,
    pub hops: u64,
    /// False for empty text, a bad `to`, bad hops, or a field of the wrong type: the `invalid` rejection.
    pub valid: bool,
}

impl Draft {
    /// A `send` frame (`hops` an integer >= 1) or, with `web`, a browser's body (hops 0).
    pub fn parse(body: &Value, web: bool) -> Draft {
        let empty = Map::new();
        let object = body.as_object().unwrap_or(&empty);
        let mut valid = body.is_object();
        let to = match object.get("to") {
            Some(Value::String(to)) => {
                valid &= valid_session_id(to);
                cut_chars(to, MAX_ID_CHARS).to_owned()
            }
            _ => {
                valid = false;
                String::new()
            }
        };
        let text = match object.get("text") {
            Some(Value::String(text)) if !text.is_empty() => text.clone(),
            _ => {
                valid = false;
                String::new()
            }
        };
        let urgent = match object.get("urgent") {
            None | Some(Value::Null) => false,
            Some(Value::Bool(urgent)) => *urgent,
            Some(_) => {
                valid = false;
                false
            }
        };
        let reply_to = match object.get("replyTo") {
            None | Some(Value::Null) => None,
            Some(Value::String(id)) if valid_message_id(id) => Some(id.clone()),
            Some(_) => {
                valid = false;
                None
            }
        };
        let hops = if web {
            0
        } else {
            match object.get("hops").and_then(Value::as_u64) {
                Some(hops) if hops >= 1 => hops,
                _ => {
                    valid = false;
                    0
                }
            }
        };
        Draft { to, text, urgent, reply_to, hops, valid }
    }
}

/// What pika's `sessions` table records about a session.
#[derive(Clone, Debug)]
pub struct Recorded {
    pub device: String,
    pub name: Option<String>,
    pub title: Option<String>,
    pub project: Option<String>,
}

/// The recorded session `id`, if pika has its transcript.
pub fn recorded(store: &Store, id: &str) -> Result<Option<Recorded>> {
    Ok(store.read(|conn| {
        conn.prepare_cached("SELECT device, name, title, project FROM sessions WHERE id = ?1")?
            .query_row([id], |r| {
                Ok(Recorded { device: r.get(0)?, name: r.get(1)?, title: r.get(2)?, project: r.get(3)? })
            })
            .optional()
    })?)
}

/// Which of `ids` pika has recorded.
pub fn recorded_ids(store: &Store, ids: &[String]) -> Result<HashSet<String>> {
    Ok(store.read(|conn| {
        let mut statement = conn.prepare_cached("SELECT 1 FROM sessions WHERE id = ?1")?;
        let mut found = HashSet::new();
        for id in ids {
            if statement.exists([id])? {
                found.insert(id.clone());
            }
        }
        Ok::<_, rusqlite::Error>(found)
    })?)
}

#[derive(Clone, Debug)]
pub enum Sender {
    Web,
    Session { session_id: String, device: String, name: Option<String>, title: Option<String>, project: String },
}

impl Sender {
    pub fn to_json(&self) -> Value {
        match self {
            Sender::Web => json!({ "kind": "web" }),
            Sender::Session { session_id, device, name, title, project } => {
                let mut object = Map::new();
                object.insert("kind".into(), "session".into());
                object.insert("sessionId".into(), session_id.as_str().into());
                object.insert("device".into(), device.as_str().into());
                put(&mut object, "name", name);
                put(&mut object, "title", title);
                object.insert("project".into(), project.as_str().into());
                Value::Object(object)
            }
        }
    }

    fn session_id(&self) -> Option<&str> {
        match self {
            Sender::Web => None,
            Sender::Session { session_id, .. } => Some(session_id),
        }
    }

    fn device(&self) -> Option<&str> {
        match self {
            Sender::Web => None,
            Sender::Session { device, .. } => Some(device),
        }
    }

    fn rate_key(&self) -> String {
        match self {
            Sender::Web => "web".into(),
            Sender::Session { session_id, .. } => format!("session:{session_id}"),
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct Target {
    pub session_id: String,
    pub device: Option<String>,
    pub name: Option<String>,
    pub title: Option<String>,
    pub project: Option<String>,
}

impl Target {
    pub fn to_json(&self) -> Value {
        let mut object = Map::new();
        object.insert("sessionId".into(), self.session_id.as_str().into());
        put(&mut object, "device", &self.device);
        put(&mut object, "name", &self.name);
        put(&mut object, "title", &self.title);
        put(&mut object, "project", &self.project);
        Value::Object(object)
    }
}

/// Why a send was rejected, in the order the relay checks.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Reason {
    Invalid,
    SelfTarget,
    TooLarge,
    RateLimited,
    HopLimit,
    UnknownSession,
    MailboxFull,
}

impl Reason {
    pub fn as_str(self) -> &'static str {
        match self {
            Reason::Invalid => "invalid",
            Reason::SelfTarget => "self",
            Reason::TooLarge => "too_large",
            Reason::RateLimited => "rate_limited",
            Reason::HopLimit => "hop_limit",
            Reason::UnknownSession => "unknown_session",
            Reason::MailboxFull => "mailbox_full",
        }
    }
}

#[derive(Debug)]
pub enum Outcome {
    /// `delivered` when the target acknowledged within the ack wait, otherwise `queued`.
    Accepted { id: String, delivered: bool, target: Target },
    Rejected(Reason),
}

/// Who sends: a connection that has passed `hello`, or the web UI.
#[derive(Clone, Copy, Debug)]
pub enum Origin {
    Conn(u64),
    Web,
}

/// Where the answer to a send goes.
#[derive(Debug)]
pub enum Reply {
    /// A `sent` frame with `client_id` to connection `conn`, if it is still open.
    Socket { conn: u64, client_id: String },
    Web(oneshot::Sender<Outcome>),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Status {
    Queued,
    Delivered,
    Expired,
    Rejected,
}

impl Status {
    fn as_str(self) -> &'static str {
        match self {
            Status::Queued => "queued",
            Status::Delivered => "delivered",
            Status::Expired => "expired",
            Status::Rejected => "rejected",
        }
    }
}

/// A dashboard entry, one per message, updated in place.
struct Event {
    id: String,
    at: i64,
    from: Sender,
    to: Target,
    status: Status,
    reason: Option<Reason>,
    delivered_at: Option<i64>,
    urgent: bool,
    reply_to: Option<String>,
    hops: u64,
    text: String,
}

impl Event {
    fn to_json(&self) -> Value {
        let mut object = Map::new();
        object.insert("id".into(), self.id.as_str().into());
        object.insert("at".into(), format_iso_ms(self.at).into());
        object.insert("from".into(), self.from.to_json());
        object.insert("to".into(), self.to.to_json());
        object.insert("status".into(), self.status.as_str().into());
        put(&mut object, "reason", &self.reason.map(|r| r.as_str().to_owned()));
        put(&mut object, "deliveredAt", &self.delivered_at.map(format_iso_ms));
        object.insert("urgent".into(), self.urgent.into());
        put(&mut object, "replyTo", &self.reply_to);
        object.insert("hops".into(), self.hops.into());
        object.insert("text".into(), self.text.as_str().into());
        Value::Object(object)
    }
}

/// A message in the mailbox: accepted and not yet acknowledged or expired.
struct Message {
    id: String,
    from: Sender,
    to: Target,
    text: String,
    urgent: bool,
    reply_to: Option<String>,
    hops: u64,
    sent_at: i64,
    /// The device that owns the target session; the message is pushed only to its connections.
    owner: String,
    /// The answer to the send, while it waits for the target's `ack`. Once taken, delivery becomes a `status` frame.
    reply: Option<Reply>,
    /// The timer that expires the message, and the one that ends the ack wait while it runs; aborted on removal.
    expiry: Option<AbortHandle>,
    ack_wait: Option<AbortHandle>,
}

impl Message {
    fn frame(&self) -> String {
        message_frame(&self.id, &self.from, &self.text, self.urgent, &self.reply_to, self.hops, self.sent_at)
    }
}

/// The `message` frame that pushes a message to its target.
fn message_frame(
    id: &str,
    from: &Sender,
    text: &str,
    urgent: bool,
    reply_to: &Option<String>,
    hops: u64,
    sent_at: i64,
) -> String {
    let mut object = Map::new();
    object.insert("type".into(), "message".into());
    object.insert("id".into(), id.into());
    object.insert("from".into(), from.to_json());
    object.insert("text".into(), text.into());
    object.insert("urgent".into(), urgent.into());
    put(&mut object, "replyTo", reply_to);
    object.insert("hops".into(), hops.into());
    object.insert("sentAt".into(), format_iso_ms(sent_at).into());
    Value::Object(object).to_string()
}

struct Conn {
    device: String,
    /// The SHA-256 of the token the connection was made with, so that revoking it closes the connection.
    token_hash: String,
    outbox: Outbox,
    /// Asks the connection's task to close. Taken when the relay closes it; the connection is forgotten when its task
    /// ends.
    closing: Option<oneshot::Sender<Closing>>,
    /// The session this connection holds online, once `hello` succeeded and until it is closed.
    session: Option<String>,
}

impl Conn {
    fn closed(&self) -> bool {
        self.closing.is_none()
    }
}

/// The device that last held a session online, remembered as its owner until `until` and while messages are queued
/// for the session. `seq` is its key in `Inner::forgetting`.
struct Remembered {
    device: String,
    until: Instant,
    seq: u64,
}

/// Counts a pending timer until it fires or is aborted.
struct Pending(Arc<AtomicUsize>);

impl Pending {
    fn new(count: &Arc<AtomicUsize>) -> Pending {
        count.fetch_add(1, Ordering::Relaxed);
        Pending(count.clone())
    }
}

impl Drop for Pending {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::Relaxed);
    }
}

struct Online {
    conn: u64,
    device: String,
    info: SessionInfo,
    connected_at: i64,
    state_since: i64,
    last_seen_at: i64,
}

impl Online {
    fn sender(&self) -> Sender {
        Sender::Session {
            session_id: self.info.id.clone(),
            device: self.device.clone(),
            name: self.info.name.clone(),
            title: self.info.title.clone(),
            project: self.info.project.clone(),
        }
    }

    fn target(&self) -> Target {
        Target {
            session_id: self.info.id.clone(),
            device: Some(self.device.clone()),
            name: self.info.name.clone(),
            title: self.info.title.clone(),
            project: Some(self.info.project.clone()),
        }
    }
}

/// An online session as the session lists show it; `recorded` is looked up by the caller.
pub struct OnlineSession {
    pub device: String,
    pub info: SessionInfo,
    pub connected_at: i64,
    pub state_since: i64,
    pub last_seen_at: i64,
}

impl OnlineSession {
    pub fn to_json(&self, recorded: bool) -> Value {
        let mut object = Map::new();
        object.insert("id".into(), self.info.id.as_str().into());
        object.insert("device".into(), self.device.as_str().into());
        object.insert("host".into(), self.info.host.as_str().into());
        put(&mut object, "name", &self.info.name);
        put(&mut object, "title", &self.info.title);
        object.insert("cwd".into(), self.info.cwd.as_str().into());
        object.insert("project".into(), self.info.project.as_str().into());
        put(&mut object, "model", &self.info.model);
        object.insert("state".into(), state_str(self.info.busy).into());
        put(&mut object, "piVersion", &self.info.pi_version);
        object.insert("connectedAt".into(), format_iso_ms(self.connected_at).into());
        object.insert("stateSince".into(), format_iso_ms(self.state_since).into());
        object.insert("lastSeenAt".into(), format_iso_ms(self.last_seen_at).into());
        object.insert("recorded".into(), recorded.into());
        Value::Object(object)
    }
}

struct Inner {
    /// The message TTL, which is also how long an offline session's owner is remembered.
    ttl: Duration,
    conns: HashMap<u64, Conn>,
    per_device: HashMap<String, usize>,
    online: HashMap<String, Online>,
    /// Owners of sessions that went offline, at most `max_remembered`, and their sessions in the order they went
    /// offline, which is also the order of their `until`. Those keyed below `expired_from` are past their time and
    /// kept only while messages are queued for them.
    remembered: HashMap<String, Remembered>,
    forgetting: BTreeMap<u64, String>,
    max_remembered: usize,
    next_remembered: u64,
    expired_from: u64,
    messages: HashMap<String, Message>,
    /// Each target's message ids in acceptance order.
    queues: HashMap<String, VecDeque<String>>,
    rates: SlidingWindow,
    device_rates: SlidingWindow,
    events: VecDeque<Event>,
}

impl Inner {
    /// Queues a frame for connection `conn`; one whose queue would grow past its maximum is closed with 1008.
    fn push(&mut self, conn: u64, frame: String) {
        let Some(c) = self.conns.get(&conn).filter(|c| !c.closed()) else { return };
        if !c.outbox.push(frame) {
            self.close(conn, close::SLOW_READER, "outgoing buffer full");
        }
    }

    /// Asks connection `conn` to close and takes its session offline at once.
    fn close(&mut self, conn: u64, code: u16, reason: &'static str) {
        let Some(c) = self.conns.get_mut(&conn) else { return };
        if let Some(closing) = c.closing.take() {
            let _ = closing.send((code, reason));
        }
        if let Some(session) = c.session.take() {
            let device = c.device.clone();
            self.offline(session, conn, device);
        }
    }

    /// Takes `session` offline if `conn` holds it, and remembers `device` as its owner.
    fn offline(&mut self, session: String, conn: u64, device: String) {
        if self.online.get(&session).is_none_or(|o| o.conn != conn) {
            return;
        }
        self.online.remove(&session);
        let now = Instant::now();
        self.forget_expired(now);
        self.forget(&session);
        let seq = self.next_remembered;
        self.next_remembered += 1;
        self.forgetting.insert(seq, session.clone());
        self.remembered.insert(session, Remembered { device, until: now + self.ttl, seq });
        while self.remembered.len() > self.max_remembered
            && let Some((_, oldest)) = self.forgetting.pop_first()
        {
            self.remembered.remove(&oldest);
        }
    }

    /// Stops remembering the owner of `session`.
    fn forget(&mut self, session: &str) {
        if let Some(r) = self.remembered.remove(session) {
            self.forgetting.remove(&r.seq);
        }
    }

    /// Forgets the owners whose time has passed, unless messages are still queued for their sessions; `take` forgets
    /// those when their queues empty.
    fn forget_expired(&mut self, now: Instant) {
        while let Some((&seq, session)) = self.forgetting.range(self.expired_from..).next() {
            if self.remembered.get(session).is_some_and(|r| r.until > now) {
                break;
            }
            self.expired_from = seq + 1;
            if !self.queues.contains_key(session) {
                let session = session.clone();
                self.forget(&session);
            }
        }
    }

    /// The device that last held the offline `session` online, while it is remembered.
    fn remembered_owner(&self, session: &str) -> Option<&str> {
        let r = self.remembered.get(session)?;
        (Instant::now() < r.until || self.queues.contains_key(session)).then_some(r.device.as_str())
    }

    /// The current connection of an online session.
    fn conn_of(&self, session: &str) -> Option<u64> {
        self.online.get(session).map(|o| o.conn)
    }

    fn event(&mut self, id: &str) -> Option<&mut Event> {
        self.events.iter_mut().rev().find(|e| e.id == id)
    }

    fn record(&mut self, event: Event, ring: usize) {
        if self.events.len() >= ring {
            self.events.pop_front();
        }
        self.events.push_back(event);
    }

    /// Counts a send against its session's and its device's limits; true when either is reached.
    fn rate_limited(&mut self, sender: &Sender, now: Instant) -> bool {
        let key = sender.rate_key();
        if self.rates.try_record(&key, now).is_err() {
            return true;
        }
        let Some(device) = sender.device() else { return false };
        if self.device_rates.try_record(device, now).is_err() {
            self.rates.forget(&key, now);
            return true;
        }
        false
    }

    fn answer(&mut self, reply: Reply, outcome: Outcome) {
        match reply {
            Reply::Web(tx) => {
                let _ = tx.send(outcome);
            }
            Reply::Socket { conn, client_id } => {
                let frame = match outcome {
                    Outcome::Accepted { id, delivered, target } => json!({
                        "type": "sent", "clientId": client_id, "id": id,
                        "status": if delivered { "delivered" } else { "queued" }, "to": target.to_json(),
                    }),
                    Outcome::Rejected(reason) => json!({
                        "type": "sent", "clientId": client_id, "status": "rejected", "reason": reason.as_str(),
                    }),
                };
                self.push(conn, frame.to_string());
            }
        }
    }

    /// Removes a message from the mailbox and cancels its timers.
    fn take(&mut self, id: &str) -> Option<Message> {
        let mut message = self.messages.remove(id)?;
        for timer in [message.expiry.take(), message.ack_wait.take()].into_iter().flatten() {
            timer.abort();
        }
        let session = &message.to.session_id;
        if let Some(queue) = self.queues.get_mut(session) {
            queue.retain(|m| m != id);
            if queue.is_empty() {
                self.queues.remove(session);
                if self.remembered.get(session).is_some_and(|r| r.until <= Instant::now()) {
                    self.forget(session);
                }
            }
        }
        Some(message)
    }

    /// A `status` frame to the sender's current connection, if it is online.
    fn status(&mut self, message: &Message, status: Status, at: i64) {
        let Some(conn) = message.from.session_id().and_then(|s| self.conn_of(s)) else { return };
        let frame = json!({
            "type": "status", "id": message.id, "status": status.as_str(), "to": message.to.to_json(),
            "at": format_iso_ms(at),
        });
        self.push(conn, frame.to_string());
    }
}

/// The relay's state; one per server.
pub struct Relay {
    config: RelayConfig,
    inner: Mutex<Inner>,
    next_conn: AtomicU64,
    next_message: AtomicU64,
    /// Expiry and ack-wait timers that have neither fired nor been aborted.
    timers: Arc<AtomicUsize>,
}

impl Relay {
    pub fn new(config: RelayConfig) -> Relay {
        let minute = Duration::from_secs(60);
        Relay {
            inner: Mutex::new(Inner {
                ttl: config.ttl,
                conns: HashMap::new(),
                per_device: HashMap::new(),
                online: HashMap::new(),
                remembered: HashMap::new(),
                forgetting: BTreeMap::new(),
                max_remembered: config.max_remembered,
                next_remembered: 0,
                expired_from: 0,
                messages: HashMap::new(),
                queues: HashMap::new(),
                rates: SlidingWindow::new(config.sends_per_minute, minute),
                device_rates: SlidingWindow::new(config.sends_per_minute_per_device, minute),
                events: VecDeque::new(),
            }),
            config,
            next_conn: AtomicU64::new(1),
            next_message: AtomicU64::new(1),
            timers: Arc::default(),
        }
    }

    pub fn config(&self) -> &RelayConfig {
        &self.config
    }

    pub fn enabled(&self) -> bool {
        self.config.enabled
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// A URL-safe id, random and numbered so that it is unique for the server's lifetime.
    fn new_id(&self) -> String {
        let n = self.next_message.fetch_add(1, Ordering::Relaxed);
        format!("{}{n:x}", base64url_encode(&random_bytes::<9>()))
    }

    /// Calls `f` after `after` unless the returned handle aborts it first.
    fn timer(self: &Arc<Self>, after: Duration, f: impl FnOnce(&Relay) + Send + 'static) -> AbortHandle {
        let pending = Pending::new(&self.timers);
        let relay = self.clone();
        tokio::spawn(async move {
            let _pending = pending;
            tokio::time::sleep(after).await;
            f(&relay);
        })
        .abort_handle()
    }

    /// Registers a new connection of `device`, made with the token whose SHA-256 is `token_hash`, or `None` when the
    /// device has too many.
    pub fn connect(&self, device: &str, token_hash: String) -> Option<Connection> {
        let mut inner = self.lock();
        let count = inner.per_device.entry(device.to_owned()).or_default();
        if *count >= self.config.max_connections_per_device {
            return None;
        }
        *count += 1;
        let id = self.next_conn.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = mpsc::unbounded_channel();
        let queued = Arc::new(AtomicUsize::new(0));
        let outbox = Outbox { tx, queued: queued.clone(), max: self.config.max_outgoing_bytes };
        let (closing, closing_rx) = oneshot::channel();
        let conn =
            Conn { device: device.to_owned(), token_hash, outbox: outbox.clone(), closing: Some(closing), session: None };
        inner.conns.insert(id, conn);
        Some(Connection { id, outbox, frames: Frames { rx, queued }, closing: closing_rx })
    }

    /// Forgets a connection that ended, and takes its session offline if it still held it.
    pub fn disconnect(&self, conn: u64) {
        let mut inner = self.lock();
        let Some(c) = inner.conns.remove(&conn) else { return };
        if let Some(count) = inner.per_device.get_mut(&c.device) {
            *count -= 1;
            if *count == 0 {
                inner.per_device.remove(&c.device);
            }
        }
        if let Some(session) = c.session {
            inner.offline(session, conn, c.device);
        }
    }

    /// Takes `info.id` online on `conn`, given the device pika recorded for it, then sends `welcome` and the queued
    /// messages bound to this device. `Err` is the close code. A connection that is closing stays offline and gets its
    /// own close code.
    pub fn hello(&self, conn: u64, info: SessionInfo, recorded_device: Option<&str>) -> Result<(), u16> {
        let mut inner = self.lock();
        inner.forget_expired(Instant::now());
        let device = match inner.conns.get(&conn) {
            Some(c) if c.closed() => return Ok(()),
            Some(c) => c.device.clone(),
            None => return Err(close::GOING_AWAY),
        };
        // The owner is the recorded device, else the one holding the session online, else the remembered one.
        if recorded_device.is_some_and(|d| d != device) {
            return Err(close::OTHER_DEVICE);
        }
        match inner.online.get(&info.id) {
            Some(other) if other.device != device => return Err(close::ONLINE_ELSEWHERE),
            Some(other) => {
                let old = other.conn;
                inner.close(old, close::REPLACED, "replaced by a newer connection");
            }
            None if recorded_device.is_none() && inner.remembered_owner(&info.id).is_some_and(|d| d != device) => {
                return Err(close::OTHER_DEVICE);
            }
            None if inner.online.len() >= self.config.max_online => return Err(close::TOO_MANY),
            None => {}
        }
        let now = now_ms();
        let id = info.id.clone();
        inner.forget(&id);
        inner.online.insert(
            id.clone(),
            Online { conn, device: device.clone(), info, connected_at: now, state_since: now, last_seen_at: now },
        );
        if let Some(c) = inner.conns.get_mut(&conn) {
            c.session = Some(id.clone());
        }
        let welcome = json!({
            "type": "welcome",
            "device": device,
            "serverVersion": env!("CARGO_PKG_VERSION"),
            "limits": {
                "ttlSeconds": self.config.ttl.as_secs(),
                "heartbeatSeconds": self.config.heartbeat.as_secs(),
                "maxTextBytes": self.config.max_text_bytes,
                "maxHops": self.config.max_hops,
            },
        });
        inner.push(conn, welcome.to_string());
        let queued: Vec<String> = inner
            .queues
            .get(&id)
            .into_iter()
            .flatten()
            .filter_map(|m| inner.messages.get(m))
            .filter(|m| m.owner == device)
            .map(Message::frame)
            .collect();
        for frame in queued {
            inner.push(conn, frame);
        }
        Ok(())
    }

    /// Records a frame from `conn` for `lastSeenAt`.
    pub fn touch(&self, conn: u64) {
        let mut inner = self.lock();
        let Some(session) = inner.conns.get(&conn).and_then(|c| c.session.clone()) else { return };
        if let Some(online) = inner.online.get_mut(&session) {
            online.last_seen_at = now_ms();
        }
    }

    pub fn state(&self, conn: u64, update: StateUpdate) {
        let mut inner = self.lock();
        let Some(session) = inner.conns.get(&conn).and_then(|c| c.session.clone()) else { return };
        let Some(online) = inner.online.get_mut(&session) else { return };
        if let Some(busy) = update.busy
            && busy != online.info.busy
        {
            online.info.busy = busy;
            online.state_since = now_ms();
        }
        for (field, value) in [
            (&mut online.info.name, update.name),
            (&mut online.info.title, update.title),
            (&mut online.info.model, update.model),
        ] {
            if value.is_some() {
                *field = value;
            }
        }
    }

    /// Checks and accepts a message; the answer goes to `reply`, at once or when the target acknowledges or the ack
    /// wait ends. `recorded` is what pika records about `draft.to`. A connection that is closing is ignored.
    pub fn send(self: &Arc<Self>, from: Origin, draft: Draft, recorded: Option<Recorded>, reply: Reply) {
        let mut inner = self.lock();
        inner.forget_expired(Instant::now());
        let sender = match from {
            Origin::Web => Sender::Web,
            Origin::Conn(conn) => {
                let online = inner.conns.get(&conn).and_then(|c| c.session.as_ref()).and_then(|s| inner.online.get(s));
                let Some(online) = online else { return };
                online.sender()
            }
        };
        let now = now_ms();
        let target = match inner.online.get(&draft.to) {
            Some(online) => online.target(),
            None => Target {
                session_id: draft.to.clone(),
                device: recorded.as_ref().map(|r| r.device.clone()),
                name: recorded.as_ref().and_then(|r| r.name.clone()),
                title: recorded.as_ref().and_then(|r| r.title.clone()),
                project: recorded.as_ref().and_then(|r| r.project.clone()),
            },
        };
        // The target's owner: the recorded device, else the one holding it online. Neither means an unknown session.
        let owner = (recorded.as_ref().map(|r| r.device.clone()))
            .or_else(|| inner.online.get(&draft.to).map(|o| o.device.clone()));
        let config = &self.config;
        let id = self.new_id();
        // Text within its limit can still make a `message` frame over the frame limit: JSON escapes each control
        // character as six bytes.
        let too_large = || {
            draft.text.len() > config.max_text_bytes
                || message_frame(&id, &sender, &draft.text, draft.urgent, &draft.reply_to, draft.hops, now).len()
                    > config.max_frame_bytes
        };
        let rejection = if !draft.valid {
            Some(Reason::Invalid)
        } else if sender.session_id() == Some(draft.to.as_str()) {
            Some(Reason::SelfTarget)
        } else if too_large() {
            Some(Reason::TooLarge)
        } else if inner.rate_limited(&sender, Instant::now()) {
            Some(Reason::RateLimited)
        } else if draft.hops > config.max_hops {
            Some(Reason::HopLimit)
        } else if owner.is_none() {
            Some(Reason::UnknownSession)
        } else if inner.queues.get(&draft.to).is_some_and(|q| q.len() >= config.max_queued_per_target)
            || inner.messages.len() >= config.max_queued
        {
            Some(Reason::MailboxFull)
        } else {
            None
        };
        let event = Event {
            id: id.clone(),
            at: now,
            from: sender.clone(),
            to: target.clone(),
            status: if rejection.is_some() { Status::Rejected } else { Status::Queued },
            reason: rejection,
            delivered_at: None,
            urgent: draft.urgent,
            reply_to: draft.reply_to.clone(),
            hops: draft.hops,
            text: cut_bytes(&draft.text, config.max_text_bytes).to_owned(),
        };
        inner.record(event, config.event_ring);
        let (None, Some(owner)) = (rejection, owner) else {
            inner.answer(reply, Outcome::Rejected(rejection.unwrap_or(Reason::UnknownSession)));
            return;
        };
        let mut message = Message {
            id: id.clone(),
            from: sender,
            to: target.clone(),
            text: draft.text,
            urgent: draft.urgent,
            reply_to: draft.reply_to,
            hops: draft.hops,
            sent_at: now,
            owner,
            reply: None,
            expiry: None,
            ack_wait: None,
        };
        match inner.online.get(&draft.to).filter(|o| o.device == message.owner).map(|o| o.conn) {
            Some(conn) => {
                inner.push(conn, message.frame());
                message.reply = Some(reply);
                let waiting = id.clone();
                message.ack_wait = Some(self.timer(config.ack_wait, move |relay| relay.ack_wait_ended(&waiting)));
            }
            None => inner.answer(reply, Outcome::Accepted { id: id.clone(), delivered: false, target }),
        }
        let expiring = id.clone();
        message.expiry = Some(self.timer(config.ttl, move |relay| relay.expire(&expiring)));
        inner.queues.entry(draft.to).or_default().push_back(id.clone());
        inner.messages.insert(id, message);
    }

    /// Answers `queued` to a send whose target has not acknowledged yet.
    fn ack_wait_ended(&self, id: &str) {
        let mut inner = self.lock();
        let Some(message) = inner.messages.get_mut(id) else { return };
        message.ack_wait = None;
        let Some(reply) = message.reply.take() else { return };
        let outcome = Outcome::Accepted { id: id.to_owned(), delivered: false, target: message.to.clone() };
        inner.answer(reply, outcome);
    }

    /// The target on `conn` delivered message `id`. Unknown, already acknowledged, or other sessions' ids are ignored.
    pub fn ack(&self, conn: u64, id: &str) {
        let mut inner = self.lock();
        let Some(session) = inner.conns.get(&conn).and_then(|c| c.session.clone()) else { return };
        if inner.messages.get(id).is_none_or(|m| m.to.session_id != session) {
            return;
        }
        let Some(mut message) = inner.take(id) else { return };
        let now = now_ms();
        if let Some(event) = inner.event(id) {
            event.status = Status::Delivered;
            event.delivered_at = Some(now);
        }
        let sender_conn = message.from.session_id().and_then(|s| inner.conn_of(s));
        match message.reply.take() {
            // The sender reconnected during the ack wait: `sent` cannot reach it, so its current connection gets
            // `status`.
            Some(Reply::Socket { conn, .. }) if sender_conn != Some(conn) => {
                inner.status(&message, Status::Delivered, now);
            }
            Some(reply) => {
                let outcome = Outcome::Accepted { id: id.to_owned(), delivered: true, target: message.to.clone() };
                inner.answer(reply, outcome);
            }
            None => inner.status(&message, Status::Delivered, now),
        }
    }

    /// Drops message `id` when its TTL has passed without an `ack`.
    fn expire(&self, id: &str) {
        let mut inner = self.lock();
        let Some(mut message) = inner.take(id) else { return };
        if let Some(reply) = message.reply.take() {
            inner.answer(reply, Outcome::Accepted { id: id.to_owned(), delivered: false, target: message.to.clone() });
        }
        if let Some(event) = inner.event(id) {
            event.status = Status::Expired;
        }
        inner.status(&message, Status::Expired, now_ms());
    }

    /// Closes every connection made with a token whose SHA-256 is in `token_hashes`, as when they are revoked.
    pub fn close_tokens(&self, token_hashes: &[String], code: u16, reason: &'static str) {
        let mut inner = self.lock();
        let conns: Vec<u64> =
            inner.conns.iter().filter(|(_, c)| token_hashes.contains(&c.token_hash)).map(|(id, _)| *id).collect();
        for conn in conns {
            inner.close(conn, code, reason);
        }
    }

    /// Closes every connection, as when the server stops.
    pub fn close_all(&self, code: u16, reason: &'static str) {
        let mut inner = self.lock();
        let conns: Vec<u64> = inner.conns.keys().copied().collect();
        for conn in conns {
            inner.close(conn, code, reason);
        }
    }

    /// The online sessions, by device, then newest connection first.
    pub fn online(&self) -> Vec<OnlineSession> {
        let inner = self.lock();
        let mut items: Vec<OnlineSession> = inner
            .online
            .values()
            .map(|o| OnlineSession {
                device: o.device.clone(),
                info: o.info.clone(),
                connected_at: o.connected_at,
                state_since: o.state_since,
                last_seen_at: o.last_seen_at,
            })
            .collect();
        items.sort_by(|a, b| {
            a.device.cmp(&b.device).then(b.connected_at.cmp(&a.connected_at)).then_with(|| a.info.id.cmp(&b.info.id))
        });
        items
    }

    /// The newest `limit` events, newest first.
    pub fn events(&self, limit: usize) -> Vec<Value> {
        self.lock().events.iter().rev().take(limit).map(Event::to_json).collect()
    }

    /// How many messages wait in the mailbox.
    pub fn queued(&self) -> usize {
        self.lock().messages.len()
    }

    /// How many bytes of frames wait to be written to the connection holding `session` online.
    pub fn outgoing_bytes(&self, session: &str) -> Option<usize> {
        let inner = self.lock();
        let conn = inner.conn_of(session)?;
        inner.conns.get(&conn).map(|c| c.outbox.queued.load(Ordering::Relaxed))
    }

    /// How many offline sessions' owners are remembered.
    pub fn remembered(&self) -> usize {
        self.lock().remembered.len()
    }

    /// How many connections are registered, online or waiting for `hello`.
    pub fn connections(&self) -> usize {
        self.lock().conns.len()
    }

    /// How many expiry and ack-wait timers are pending: never more than the queued messages plus the sends in their
    /// ack wait.
    pub fn pending_timers(&self) -> usize {
        self.timers.load(Ordering::Relaxed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_match_the_contract() {
        let c = RelayConfig::default();
        assert!(c.enabled);
        assert_eq!((c.ttl.as_secs(), c.heartbeat.as_secs(), c.dead_after.as_secs()), (300, 20, 45));
        assert_eq!((c.hello_timeout.as_secs(), c.ack_wait.as_secs(), c.write_timeout.as_secs()), (10, 2, 45));
        assert_eq!((c.max_text_bytes, c.max_frame_bytes, c.max_hops), (32 * 1024, 64 * 1024, 8));
        assert_eq!((c.sends_per_minute, c.sends_per_minute_per_device, c.max_outgoing_bytes), (60, 300, 8 << 20));
        assert_eq!((c.max_queued_per_target, c.max_queued), (100, 10_000));
        assert_eq!((c.max_online, c.max_connections_per_device, c.event_ring), (1_000, 64, 500));
        assert_eq!(c.max_remembered, 10_000);
    }

    #[test]
    fn session_ids() {
        assert!(valid_session_id("7f3c2a10-5b1e-4c3d-9a8e-1f2e3d4c5b6a"));
        assert!(valid_session_id("a.b_c-D"));
        assert!(valid_session_id(&"x".repeat(128)));
        assert!(!valid_session_id(""));
        assert!(!valid_session_id(&"x".repeat(129)));
        assert!(!valid_session_id("a/b"));
        assert!(!valid_session_id("é"));
    }

    #[test]
    fn drafts() {
        let ok = Draft::parse(&json!({ "to": "b", "text": "hi", "hops": 1, "urgent": true, "replyTo": "m1" }), false);
        assert!(ok.valid && ok.urgent && ok.hops == 1 && ok.reply_to.as_deref() == Some("m1"));
        let longest = "A-_z9".repeat(13)[..64].to_owned();
        let ok = Draft::parse(&json!({ "to": "b", "text": "hi", "hops": 1, "replyTo": longest }), false);
        assert!(ok.valid && ok.reply_to.as_deref() == Some(longest.as_str()));
        for bad in [
            json!({ "to": "b", "text": "", "hops": 1 }),
            json!({ "to": "b/c", "text": "hi", "hops": 1 }),
            json!({ "to": 5, "text": "hi", "hops": 1 }),
            json!({ "to": "b", "text": "hi", "hops": 0 }),
            json!({ "to": "b", "text": "hi", "hops": 1.5 }),
            json!({ "to": "b", "text": "hi" }),
            json!({ "to": "b", "text": "hi", "hops": 1, "urgent": "yes" }),
            json!({ "to": "b", "text": "hi", "hops": 1, "replyTo": 3 }),
            json!({ "to": "b", "text": "hi", "hops": 1, "replyTo": "" }),
            json!({ "to": "b", "text": "hi", "hops": 1, "replyTo": "x".repeat(65) }),
            json!({ "to": "b", "text": "hi", "hops": 1, "replyTo": "a.b" }),
            json!({ "to": "b", "text": "hi", "hops": 1, "replyTo": "line\nbreak" }),
            json!("hi"),
        ] {
            assert!(!Draft::parse(&bad, false).valid, "{bad}");
        }
        let web = Draft::parse(&json!({ "to": "b", "text": "hi", "hops": 5 }), true);
        assert!(web.valid && web.hops == 0);
        assert!(Draft::parse(&json!({ "to": "b", "text": "hi", "hops": 9 }), false).valid);
    }

    #[test]
    fn hello_fields_are_checked_and_cut() {
        let long = "n".repeat(300);
        let info = SessionInfo::parse(Some(&json!({
            "id": "s1", "name": long, "cwd": "/w", "project": "w", "host": "h", "state": "busy", "relayVersion": "1",
        })))
        .unwrap();
        assert_eq!((info.name.unwrap().len(), info.busy, info.title), (200, true, None));
        for bad in [
            json!({ "id": "s 1", "cwd": "/w", "project": "w", "host": "h", "state": "idle", "relayVersion": "1" }),
            json!({ "id": "s1", "project": "w", "host": "h", "state": "idle", "relayVersion": "1" }),
            json!({ "id": "s1", "cwd": "/w", "project": "w", "host": "h", "state": "asleep", "relayVersion": "1" }),
            json!({ "id": "s1", "cwd": "/w", "project": "w", "host": "h", "state": "idle" }),
            json!({ "id": "s1", "cwd": "/w", "project": "w", "host": "h", "state": "idle", "relayVersion": "1",
                "model": 4 }),
        ] {
            assert!(SessionInfo::parse(Some(&bad)).is_err(), "{bad}");
        }
    }
}
