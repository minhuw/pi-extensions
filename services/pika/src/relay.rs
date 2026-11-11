//! pika relay: the online pi sessions, mailbox, chatrooms, and the dashboard's event ring, backed by SQLite when
//! opened with a [`Store`]. The WebSocket and HTTP routes are in `http::relay`. See `docs/RELAY.md`.
//!
//! All state sits behind one mutex that is never held across an `await` or SQLite disk I/O. Every frame to a
//! connection goes through that connection's `Outbox` while the lock is held, so `sent`, `status`, and `message`
//! frames keep the order in which the relay decided them; persistence operations go through `Inner::persist` in the
//! same causal order to a dedicated writer thread. Each connection's writer task drains its outbox, so a peer that
//! stops reading holds up neither the relay nor its own connection's reader; a queue that grows past its maximum
//! closes the connection with 1008.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet, VecDeque};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use rusqlite::{OptionalExtension, Transaction, params};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use tokio::sync::{mpsc, oneshot, watch};
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

/// Device names by id. Frames and lists carry ids and look the names up when they are serialized, so a rename shows
/// in everything sent after it.
pub type Names = HashMap<String, String>;

/// The name of device `id`, or the id when it has none.
fn name_of<'a>(names: &'a Names, id: &'a str) -> &'a str {
    names.get(id).map_or(id, String::as_str)
}

const MAX_ID_CHARS: usize = 128;
const MAX_CLIENT_ID_CHARS: usize = 64;
const MAX_MESSAGE_ID_CHARS: usize = 64;
const MAX_ROOM_CHARS: usize = 64;
const MAX_ROOMS: usize = 200;
const MAX_ROOM_MESSAGES: usize = 200;
const MAX_MENTIONS: usize = 64;

/// A pi session id: 1-128 characters of `[A-Za-z0-9._-]`.
pub fn valid_session_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_ID_CHARS
        && id.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

/// Strips a single optional leading `#` and surrounding whitespace from a room name.
pub fn normalize_room_name(raw: &str) -> &str {
    let trimmed = raw.trim();
    trimmed.strip_prefix('#').unwrap_or(trimmed)
}

/// A room name: 1-64 characters of `[A-Za-z0-9._-]` (after stripping an optional leading `#`).
pub fn valid_room_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= MAX_ROOM_CHARS
        && name.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

/// Extracts `@mention` tokens from message text: `@` at the start or after whitespace/punctuation, followed by 1-128
/// characters of `[A-Za-z0-9._-]`.
pub fn extract_mentions(text: &str) -> Vec<String> {
    let bytes = text.as_bytes();
    let mut found = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'@' {
            let boundary = i == 0 || {
                let prev = bytes[i - 1];
                prev.is_ascii_whitespace() || matches!(prev, b'(' | b'[' | b'{' | b',' | b':' | b';' | b'"' | b'\'')
            };
            if boundary {
                let start = i + 1;
                let mut end = start;
                while end < bytes.len()
                    && (bytes[end].is_ascii_alphanumeric() || matches!(bytes[end], b'.' | b'_' | b'-'))
                {
                    end += 1;
                }
                let len = end - start;
                if (1..=MAX_ID_CHARS).contains(&len) {
                    let token = &text[start..end];
                    if !found.iter().any(|existing: &String| existing.eq_ignore_ascii_case(token)) {
                        found.push(token.to_owned());
                    }
                }
                i = end;
                continue;
            }
        }
        i += 1;
    }
    found
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
    /// `to` as given, cut to 128 characters, or empty when it was not a string or when `room` is set.
    pub to: String,
    /// Normalized room name when sending to a chatroom (`None` for a 1:1 session message).
    pub room: Option<String>,
    /// Explicit `@mention` tokens passed in `mentions` for a room message.
    pub mentions: Vec<String>,
    pub text: String,
    pub urgent: bool,
    pub reply_to: Option<String>,
    pub hops: u64,
    /// False for empty text, a bad `to` or `room`, bad hops, or a field of the wrong type: the `invalid` rejection.
    pub valid: bool,
}

impl Draft {
    /// A `send` frame (`hops` an integer >= 1) or, with `web`, a browser's body (hops 0).
    pub fn parse(body: &Value, web: bool) -> Draft {
        let empty = Map::new();
        let object = body.as_object().unwrap_or(&empty);
        let mut valid = body.is_object();
        let room = match object.get("room") {
            None | Some(Value::Null) => None,
            Some(Value::String(raw)) => {
                let norm = normalize_room_name(raw);
                valid &= valid_room_name(norm);
                Some(cut_chars(norm, MAX_ROOM_CHARS).to_owned())
            }
            Some(_) => {
                valid = false;
                Some(String::new())
            }
        };
        let to = if room.is_some() {
            if object.get("to").is_some_and(|v| !v.is_null()) {
                valid = false;
            }
            String::new()
        } else {
            match object.get("to") {
                Some(Value::String(to)) => {
                    valid &= valid_session_id(to);
                    cut_chars(to, MAX_ID_CHARS).to_owned()
                }
                _ => {
                    valid = false;
                    String::new()
                }
            }
        };
        let mentions = match object.get("mentions") {
            None | Some(Value::Null) => Vec::new(),
            Some(Value::Array(items)) if items.len() <= MAX_MENTIONS => {
                let mut parsed = Vec::with_capacity(items.len());
                for item in items {
                    match item.as_str() {
                        Some(raw) => {
                            let token = raw.trim().strip_prefix('@').unwrap_or_else(|| raw.trim());
                            if token.is_empty() || token.len() > MAX_ID_CHARS {
                                valid = false;
                            } else {
                                parsed.push(token.to_owned());
                            }
                        }
                        None => valid = false,
                    }
                }
                parsed
            }
            Some(_) => {
                valid = false;
                Vec::new()
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
        Draft { to, room, mentions, text, urgent, reply_to, hops, valid }
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

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Sender {
    Web,
    #[serde(rename_all = "camelCase")]
    Session {
        session_id: String,
        device: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        name: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        title: Option<String>,
        project: String,
    },
}

impl Sender {
    pub fn to_json(&self, names: &Names) -> Value {
        match self {
            Sender::Web => json!({ "kind": "web" }),
            Sender::Session { session_id, device, name, title, project } => {
                let mut object = Map::new();
                object.insert("kind".into(), "session".into());
                object.insert("sessionId".into(), session_id.as_str().into());
                object.insert("device".into(), device.as_str().into());
                object.insert("deviceName".into(), name_of(names, device).into());
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

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    pub session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
}

impl Target {
    pub fn to_json(&self, names: &Names) -> Value {
        let mut object = Map::new();
        object.insert("sessionId".into(), self.session_id.as_str().into());
        put(&mut object, "device", &self.device);
        put(&mut object, "deviceName", &self.device.as_deref().map(|d| name_of(names, d).to_owned()));
        put(&mut object, "name", &self.name);
        put(&mut object, "title", &self.title);
        put(&mut object, "project", &self.project);
        Value::Object(object)
    }
}

/// Why a send was rejected, in the order the relay checks, or a room action.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Reason {
    Invalid,
    SelfTarget,
    TooLarge,
    RateLimited,
    HopLimit,
    UnknownSession,
    /// A room post to a room that does not exist.
    UnknownRoom,
    /// A room post from a session that is not a member of the room.
    NotMember,
    MailboxFull,
    /// A device acted for a session that another device owns; room actions only.
    NotOwner,
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
            Reason::UnknownRoom => "unknown_room",
            Reason::NotMember => "not_member",
            Reason::MailboxFull => "mailbox_full",
            Reason::NotOwner => "not_owner",
        }
    }

    fn from_str(s: &str) -> Option<Reason> {
        match s {
            "invalid" => Some(Reason::Invalid),
            "self" => Some(Reason::SelfTarget),
            "too_large" => Some(Reason::TooLarge),
            "rate_limited" => Some(Reason::RateLimited),
            "hop_limit" => Some(Reason::HopLimit),
            "unknown_session" => Some(Reason::UnknownSession),
            "unknown_room" => Some(Reason::UnknownRoom),
            "not_member" => Some(Reason::NotMember),
            "mailbox_full" => Some(Reason::MailboxFull),
            "not_owner" => Some(Reason::NotOwner),
            _ => None,
        }
    }
}

#[derive(Debug)]
pub enum Outcome {
    /// `delivered` when the target acknowledged within the ack wait, otherwise `queued`.
    Accepted { id: String, delivered: bool, target: Target },
    /// A message posted to a chatroom (`room`); `notified` lists the `@`-mentioned members who received a live push,
    /// `unmatched` the mention tokens that named no member.
    RoomAccepted { id: String, room: String, target: Target, notified: Vec<Target>, unmatched: Vec<String> },
    Rejected(Reason),
}

/// A member of a chatroom, enriched with live online state when serialized.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RoomMember {
    pub session_id: String,
    pub device: Option<String>,
    pub name: Option<String>,
    pub title: Option<String>,
    pub project: Option<String>,
    pub model: Option<String>,
    pub joined_at: i64,
}

impl RoomMember {
    fn from_online(online: &Online, joined_at: i64) -> RoomMember {
        RoomMember {
            session_id: online.info.id.clone(),
            device: Some(online.device.clone()),
            name: online.info.name.clone(),
            title: online.info.title.clone(),
            project: Some(online.info.project.clone()),
            model: online.info.model.clone(),
            joined_at,
        }
    }

    fn from_recorded(session_id: &str, recorded: Option<&Recorded>, joined_at: i64) -> RoomMember {
        RoomMember {
            session_id: session_id.to_owned(),
            device: recorded.map(|r| r.device.clone()),
            name: recorded.and_then(|r| r.name.clone()),
            title: recorded.and_then(|r| r.title.clone()),
            project: recorded.and_then(|r| r.project.clone()),
            model: None,
            joined_at,
        }
    }

    fn refresh(&mut self, online: &Online) -> bool {
        let before = self.clone();
        self.device = Some(online.device.clone());
        if online.info.name.is_some() {
            self.name = online.info.name.clone();
        }
        if online.info.title.is_some() {
            self.title = online.info.title.clone();
        }
        self.project = Some(online.info.project.clone());
        if online.info.model.is_some() {
            self.model = online.info.model.clone();
        }
        *self != before
    }

    fn target(&self, online: Option<&Online>) -> Target {
        if let Some(online) = online {
            return online.target();
        }
        Target {
            session_id: self.session_id.clone(),
            device: self.device.clone(),
            name: self.name.clone(),
            title: self.title.clone(),
            project: self.project.clone(),
        }
    }

    fn matches_mention(&self, token: &str, online: Option<&Online>) -> bool {
        let lower = token.to_ascii_lowercase();
        if self.session_id.eq_ignore_ascii_case(token)
            || (lower.len() >= 8 && self.session_id.to_ascii_lowercase().starts_with(&lower))
        {
            return true;
        }
        let slug = |s: &str| {
            s.trim()
                .chars()
                .map(|c| if c.is_whitespace() { '-' } else { c.to_ascii_lowercase() })
                .collect::<String>()
        };
        let check_field = |val: Option<&String>| -> bool {
            let Some(v) = val else { return false };
            v.eq_ignore_ascii_case(token) || slug(v) == lower || v.replace(' ', "_") == token
        };
        let name = online.and_then(|o| o.info.name.as_ref()).or(self.name.as_ref());
        let title = online.and_then(|o| o.info.title.as_ref()).or(self.title.as_ref());
        let project = online.map(|o| &o.info.project).or(self.project.as_ref());
        check_field(name) || check_field(title) || check_field(project)
    }

    fn to_json(&self, online: Option<&Online>, names: &Names) -> Value {
        let mut object = Map::new();
        let device = online.map(|o| o.device.as_str()).or(self.device.as_deref());
        let name = online.and_then(|o| o.info.name.as_ref()).or(self.name.as_ref()).cloned();
        let title = online.and_then(|o| o.info.title.as_ref()).or(self.title.as_ref()).cloned();
        let project = online.map(|o| o.info.project.clone()).or_else(|| self.project.clone());
        let model = online.and_then(|o| o.info.model.as_ref()).or(self.model.as_ref()).cloned();
        object.insert("sessionId".into(), self.session_id.as_str().into());
        if let Some(d) = device {
            object.insert("device".into(), d.into());
            object.insert("deviceName".into(), name_of(names, d).into());
        }
        put(&mut object, "name", &name);
        put(&mut object, "title", &title);
        put(&mut object, "project", &project);
        put(&mut object, "model", &model);
        object.insert("state".into(), online.map_or("offline", |o| state_str(o.info.busy)).into());
        object.insert("online".into(), online.is_some().into());
        object.insert("joinedAt".into(), format_iso_ms(self.joined_at).into());
        Value::Object(object)
    }
}

/// One message in a chatroom's transcript.
#[derive(Clone, Debug)]
pub struct RoomMessage {
    pub id: String,
    pub seq: u64,
    pub room: String,
    pub from: Sender,
    pub text: String,
    pub mentions: Vec<String>,
    pub notified: Vec<Target>,
    pub urgent: bool,
    pub reply_to: Option<String>,
    pub hops: u64,
    pub at: i64,
}

impl RoomMessage {
    fn to_json(&self, names: &Names) -> Value {
        let mut object = Map::new();
        object.insert("id".into(), self.id.as_str().into());
        object.insert("seq".into(), self.seq.into());
        object.insert("room".into(), self.room.as_str().into());
        object.insert("from".into(), self.from.to_json(names));
        object.insert("text".into(), self.text.as_str().into());
        object.insert("mentions".into(), json!(self.mentions));
        let notified: Vec<Value> = self.notified.iter().map(|t| t.to_json(names)).collect();
        object.insert("notified".into(), Value::Array(notified));
        object.insert("urgent".into(), self.urgent.into());
        put(&mut object, "replyTo", &self.reply_to);
        object.insert("hops".into(), self.hops.into());
        object.insert("at".into(), format_iso_ms(self.at).into());
        Value::Object(object)
    }
}

/// What a device does to a session's place in a room (`action` of `POST {base}/api/relay/v1/rooms`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RoomAction {
    Join,
    Leave,
    /// Joins if needed and becomes the room's representative, replacing any other.
    Represent,
    /// Stops representing the room; no change unless the session is its representative.
    Unrepresent,
}

/// An explicit multi-agent chatroom.
struct Room {
    name: String,
    topic: Option<String>,
    created_at: i64,
    updated_at: i64,
    members: BTreeMap<String, RoomMember>,
    /// The member that represents the user in the room, at most one.
    representative: Option<String>,
    messages: VecDeque<RoomMessage>,
    next_seq: u64,
}

impl Room {
    fn new(name: String, topic: Option<String>, now: i64) -> Room {
        Room {
            name,
            topic,
            created_at: now,
            updated_at: now,
            members: BTreeMap::new(),
            representative: None,
            messages: VecDeque::new(),
            next_seq: 1,
        }
    }

    fn summary_json(&self, online: &HashMap<String, Online>, names: &Names) -> Value {
        let mut members: Vec<&RoomMember> = self.members.values().collect();
        members.sort_by(|a, b| a.joined_at.cmp(&b.joined_at).then_with(|| a.session_id.cmp(&b.session_id)));
        let members_json: Vec<Value> = members
            .into_iter()
            .map(|m| m.to_json(online.get(&m.session_id), names))
            .collect();
        let mut object = Map::new();
        object.insert("name".into(), self.name.as_str().into());
        put(&mut object, "topic", &self.topic);
        object.insert("createdAt".into(), format_iso_ms(self.created_at).into());
        object.insert("updatedAt".into(), format_iso_ms(self.updated_at).into());
        object.insert("messageCount".into(), (self.next_seq - 1).into());
        object.insert("members".into(), Value::Array(members_json));
        put(&mut object, "representative", &self.representative);
        if let Some(last) = self.messages.back() {
            object.insert("lastMessage".into(), last.to_json(names));
        }
        Value::Object(object)
    }

    fn detail_json(&self, online: &HashMap<String, Online>, names: &Names, limit: usize, after: u64) -> Value {
        let filtered: Vec<&RoomMessage> = self.messages.iter().filter(|m| m.seq > after).collect();
        let start = filtered.len().saturating_sub(limit);
        let messages: Vec<Value> = filtered[start..].iter().map(|m| m.to_json(names)).collect();
        json!({
            "room": self.summary_json(online, names),
            "messages": messages,
        })
    }
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

    fn from_str(s: &str) -> Option<Status> {
        match s {
            "queued" => Some(Status::Queued),
            "delivered" => Some(Status::Delivered),
            "expired" => Some(Status::Expired),
            "rejected" => Some(Status::Rejected),
            _ => None,
        }
    }
}

/// A dashboard entry, one per message, updated in place.
#[derive(Clone)]
struct Event {
    id: String,
    at: i64,
    from: Sender,
    to: Target,
    room: Option<String>,
    mentions: Vec<String>,
    status: Status,
    reason: Option<Reason>,
    delivered_at: Option<i64>,
    urgent: bool,
    reply_to: Option<String>,
    hops: u64,
    text: String,
}

impl Event {
    fn to_json(&self, names: &Names) -> Value {
        let mut object = Map::new();
        object.insert("id".into(), self.id.as_str().into());
        object.insert("at".into(), format_iso_ms(self.at).into());
        object.insert("from".into(), self.from.to_json(names));
        object.insert("to".into(), self.to.to_json(names));
        put(&mut object, "room", &self.room);
        if !self.mentions.is_empty() {
            object.insert("mentions".into(), json!(self.mentions));
        }
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
    room: Option<String>,
    mentions: Vec<String>,
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
    fn frame(&self, names: &Names) -> String {
        let draft = (self.text.as_str(), self.urgent, &self.reply_to, self.hops);
        message_frame_with_room(&self.id, &self.from, draft, self.room.as_deref(), &self.mentions, self.sent_at, names)
    }
}

/// The `message` frame that pushes a message to its target; `draft` is its text, urgent flag, `replyTo`, and hops.
fn message_frame(
    id: &str,
    from: &Sender,
    (text, urgent, reply_to, hops): (&str, bool, &Option<String>, u64),
    sent_at: i64,
    names: &Names,
) -> String {
    message_frame_with_room(id, from, (text, urgent, reply_to, hops), None, &[], sent_at, names)
}

fn message_frame_with_room(
    id: &str,
    from: &Sender,
    (text, urgent, reply_to, hops): (&str, bool, &Option<String>, u64),
    room: Option<&str>,
    mentions: &[String],
    sent_at: i64,
    names: &Names,
) -> String {
    let mut object = Map::new();
    object.insert("type".into(), "message".into());
    object.insert("id".into(), id.into());
    if let Some(room) = room {
        object.insert("room".into(), room.into());
    }
    if !mentions.is_empty() {
        object.insert("mentions".into(), json!(mentions));
    }
    object.insert("from".into(), from.to_json(names));
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

#[derive(Clone)]
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
    pub device_name: String,
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
        object.insert("deviceName".into(), self.device_name.as_str().into());
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

#[derive(Clone)]
struct RoomRow {
    name: String,
    topic: Option<String>,
    created_at: i64,
    updated_at: i64,
    representative: Option<String>,
    next_seq: u64,
}

impl RoomRow {
    fn from_room(room: &Room) -> RoomRow {
        RoomRow {
            name: room.name.clone(),
            topic: room.topic.clone(),
            created_at: room.created_at,
            updated_at: room.updated_at,
            representative: room.representative.clone(),
            next_seq: room.next_seq,
        }
    }
}

struct MailboxRow {
    id: String,
    session_id: String,
    owner: String,
    from: Sender,
    to: Target,
    room: Option<String>,
    mentions: Vec<String>,
    text: String,
    urgent: bool,
    reply_to: Option<String>,
    hops: u64,
    sent_at: i64,
}

impl MailboxRow {
    fn from_message(m: &Message) -> MailboxRow {
        MailboxRow {
            id: m.id.clone(),
            session_id: m.to.session_id.clone(),
            owner: m.owner.clone(),
            from: m.from.clone(),
            to: m.to.clone(),
            room: m.room.clone(),
            mentions: m.mentions.clone(),
            text: m.text.clone(),
            urgent: m.urgent,
            reply_to: m.reply_to.clone(),
            hops: m.hops,
            sent_at: m.sent_at,
        }
    }
}

enum PersistOp {
    UpsertRoom(RoomRow),
    UpsertRoomMember { room: String, member: RoomMember },
    DeleteRoomMember { room: String, session_id: String },
    DeleteRoom { name: String },
    InsertRoomMessage { message: RoomMessage, max_messages: usize },
    InsertEvent { event: Event, ring: usize },
    MarkEventDelivered { id: String, delivered_at: i64 },
    MarkEventExpired { id: String },
    InsertMailbox(MailboxRow),
    DeleteMailbox { id: String },
}

enum PersistCmd {
    Op(PersistOp),
    Flush(oneshot::Sender<()>),
}

fn apply_persist_ops(tx: &Transaction, ops: &[PersistOp]) -> Result<()> {
    for op in ops {
        match op {
            PersistOp::UpsertRoom(r) => {
                tx.prepare_cached(
                    "INSERT INTO relay_rooms (name, topic, created_at, updated_at, representative, next_seq)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                     ON CONFLICT(name) DO UPDATE SET
                         topic = excluded.topic,
                         created_at = excluded.created_at,
                         updated_at = excluded.updated_at,
                         representative = excluded.representative,
                         next_seq = excluded.next_seq",
                )?
                .execute(params![r.name, r.topic, r.created_at, r.updated_at, r.representative, r.next_seq as i64])?;
            }
            PersistOp::UpsertRoomMember { room, member: m } => {
                tx.prepare_cached(
                    "INSERT INTO relay_room_members (room, session_id, device, name, title, project, model, joined_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                     ON CONFLICT(room, session_id) DO UPDATE SET
                         device = excluded.device,
                         name = excluded.name,
                         title = excluded.title,
                         project = excluded.project,
                         model = excluded.model,
                         joined_at = excluded.joined_at",
                )?
                .execute(params![room, m.session_id, m.device, m.name, m.title, m.project, m.model, m.joined_at])?;
            }
            PersistOp::DeleteRoomMember { room, session_id } => {
                tx.prepare_cached("DELETE FROM relay_room_members WHERE room = ?1 AND session_id = ?2")?
                    .execute(params![room, session_id])?;
            }
            PersistOp::DeleteRoom { name } => {
                tx.prepare_cached("DELETE FROM relay_room_messages WHERE room = ?1")?.execute([name])?;
                tx.prepare_cached("DELETE FROM relay_room_members WHERE room = ?1")?.execute([name])?;
                tx.prepare_cached("DELETE FROM relay_rooms WHERE name = ?1")?.execute([name])?;
            }
            PersistOp::InsertRoomMessage { message: m, max_messages } => {
                let from_json = serde_json::to_string(&m.from)?;
                let mentions_json = serde_json::to_string(&m.mentions)?;
                let notified_json = serde_json::to_string(&m.notified)?;
                tx.prepare_cached(
                    "INSERT OR REPLACE INTO relay_room_messages
                         (room, seq, id, from_json, text, mentions_json, notified_json, urgent, reply_to, hops, at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
                )?
                .execute(params![
                    m.room,
                    m.seq as i64,
                    m.id,
                    from_json,
                    m.text,
                    mentions_json,
                    notified_json,
                    i64::from(m.urgent),
                    m.reply_to,
                    m.hops as i64,
                    m.at,
                ])?;
                tx.prepare_cached(
                    "DELETE FROM relay_room_messages
                     WHERE room = ?1
                       AND seq <= COALESCE(
                           (SELECT seq FROM relay_room_messages WHERE room = ?1 ORDER BY seq DESC LIMIT 1 OFFSET ?2),
                           -1
                       )",
                )?
                .execute(params![m.room, *max_messages as i64])?;
            }
            PersistOp::InsertEvent { event: e, ring } => {
                if *ring == 0 {
                    tx.prepare_cached("DELETE FROM relay_events")?.execute([])?;
                } else {
                    let from_json = serde_json::to_string(&e.from)?;
                    let to_json = serde_json::to_string(&e.to)?;
                    let mentions_json = serde_json::to_string(&e.mentions)?;
                    tx.prepare_cached(
                        "INSERT OR REPLACE INTO relay_events
                             (id, at, from_json, to_json, room, mentions_json, status, reason, delivered_at, urgent, reply_to, hops, text)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
                    )?
                    .execute(params![
                        e.id,
                        e.at,
                        from_json,
                        to_json,
                        e.room,
                        mentions_json,
                        e.status.as_str(),
                        e.reason.map(Reason::as_str),
                        e.delivered_at,
                        i64::from(e.urgent),
                        e.reply_to,
                        e.hops as i64,
                        e.text,
                    ])?;
                    tx.prepare_cached(
                        "DELETE FROM relay_events
                         WHERE seq <= COALESCE(
                             (SELECT seq FROM relay_events ORDER BY seq DESC LIMIT 1 OFFSET ?1),
                             -1
                         )",
                    )?
                    .execute(params![*ring as i64])?;
                }
            }
            PersistOp::MarkEventDelivered { id, delivered_at } => {
                tx.prepare_cached(
                    "UPDATE relay_events SET status = 'delivered', delivered_at = ?2 WHERE id = ?1 AND status = 'queued'",
                )?
                .execute(params![id, delivered_at])?;
            }
            PersistOp::MarkEventExpired { id } => {
                tx.prepare_cached("UPDATE relay_events SET status = 'expired' WHERE id = ?1 AND status = 'queued'")?
                    .execute([id])?;
            }
            PersistOp::InsertMailbox(m) => {
                let from_json = serde_json::to_string(&m.from)?;
                let to_json = serde_json::to_string(&m.to)?;
                let mentions_json = serde_json::to_string(&m.mentions)?;
                tx.prepare_cached(
                    "INSERT OR REPLACE INTO relay_mailbox
                         (id, session_id, owner, from_json, to_json, room, mentions_json, text, urgent, reply_to, hops, sent_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
                )?
                .execute(params![
                    m.id,
                    m.session_id,
                    m.owner,
                    from_json,
                    to_json,
                    m.room,
                    mentions_json,
                    m.text,
                    i64::from(m.urgent),
                    m.reply_to,
                    m.hops as i64,
                    m.sent_at,
                ])?;
            }
            PersistOp::DeleteMailbox { id } => {
                tx.prepare_cached("DELETE FROM relay_mailbox WHERE id = ?1")?.execute([id])?;
            }
        }
    }
    Ok(())
}

fn persist_loop(store: Arc<Store>, rx: std::sync::mpsc::Receiver<PersistCmd>) {
    while let Ok(first) = rx.recv() {
        let mut ops = Vec::new();
        let mut flushes = Vec::new();
        match first {
            PersistCmd::Op(op) => ops.push(op),
            PersistCmd::Flush(tx) => flushes.push(tx),
        }
        for cmd in rx.try_iter() {
            match cmd {
                PersistCmd::Op(op) => ops.push(op),
                PersistCmd::Flush(tx) => flushes.push(tx),
            }
        }
        if !ops.is_empty()
            && let Err(e) = store.write(|tx| apply_persist_ops(tx, &ops))
        {
            tracing::error!("relay: persisting state: {e:#}");
        }
        for tx in flushes {
            let _ = tx.send(());
        }
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
    /// Explicit chatrooms keyed by normalized room name.
    rooms: BTreeMap<String, Room>,
    rates: SlidingWindow,
    device_rates: SlidingWindow,
    events: VecDeque<Event>,
    names: Names,
    /// Counts in-process renames, so that a snapshot of the store read before one does not undo it.
    names_generation: u64,
    /// Ordered persistence queue to the background SQLite writer thread (`None` in memory-only mode).
    persist: Option<std::sync::mpsc::Sender<PersistCmd>>,
}

impl Inner {
    fn persist(&self, op: PersistOp) {
        if let Some(tx) = &self.persist {
            let _ = tx.send(PersistCmd::Op(op));
        }
    }

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

    /// Remembers `device` as the offline owner of `session`.
    fn remember(&mut self, device: String, session: String) {
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

    /// Takes `session` offline if `conn` holds it, and remembers `device` as its owner.
    fn offline(&mut self, session: String, conn: u64, device: String) {
        if self.online.get(&session).is_none_or(|o| o.conn != conn) {
            return;
        }
        self.online.remove(&session);
        self.remember(device, session);
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

    /// The owner of `session` ("Ownership" in `docs/RELAY.md`): `recorded_device`, the device pika's sessions table
    /// records for it, else the device holding it online, else the remembered one. `None` means nobody owns it.
    fn owner<'a>(&'a self, session: &str, recorded_device: Option<&'a str>) -> Option<&'a str> {
        recorded_device
            .or_else(|| self.online.get(session).map(|o| o.device.as_str()))
            .or_else(|| self.remembered_owner(session))
    }

    /// The current connection of an online session.
    fn conn_of(&self, session: &str) -> Option<u64> {
        self.online.get(session).map(|o| o.conn)
    }

    fn event(&mut self, id: &str) -> Option<&mut Event> {
        self.events.iter_mut().rev().find(|e| e.id == id)
    }

    fn record(&mut self, event: Event, ring: usize) {
        self.persist(PersistOp::InsertEvent { event: event.clone(), ring });
        if ring == 0 {
            return;
        }
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
                        "status": if delivered { "delivered" } else { "queued" }, "to": target.to_json(&self.names),
                    }),
                    Outcome::RoomAccepted { id, room, target, notified, unmatched } => {
                        let notified_json: Vec<Value> = notified.iter().map(|t| t.to_json(&self.names)).collect();
                        let mut frame = json!({
                            "type": "sent", "clientId": client_id, "id": id,
                            "status": "delivered", "room": room, "notified": notified_json,
                            "to": target.to_json(&self.names),
                        });
                        if !unmatched.is_empty() {
                            frame["unmatched"] = json!(unmatched);
                        }
                        frame
                    }
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
        self.persist(PersistOp::DeleteMailbox { id: id.to_owned() });
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
            "type": "status", "id": message.id, "status": status.as_str(), "to": message.to.to_json(&self.names),
            "at": format_iso_ms(at),
        });
        self.push(conn, frame.to_string());
    }

    /// Tells the online sessions among `sessions` (the room's members, and its previous representative if that left)
    /// that `representative` now represents `room`, or nobody.
    fn announce_representative(&mut self, room: &str, representative: Option<&str>, sessions: BTreeSet<String>) {
        let mut frame = Map::new();
        frame.insert("type".into(), "room".into());
        frame.insert("room".into(), room.into());
        if let Some(representative) = representative {
            frame.insert("representative".into(), representative.into());
        }
        frame.insert("at".into(), format_iso_ms(now_ms()).into());
        let frame = Value::Object(frame).to_string();
        let conns: Vec<u64> = sessions.iter().filter_map(|s| self.conn_of(s)).collect();
        for conn in conns {
            self.push(conn, frame.clone());
        }
    }
}

/// The relay's state; one per server.
/// A running connection task; see [`Relay::task`].
pub struct Task<'a>(&'a Relay);

impl Drop for Task<'_> {
    fn drop(&mut self) {
        self.0.tasks.send_modify(|n| *n -= 1);
    }
}

pub struct Relay {
    config: RelayConfig,
    inner: Mutex<Inner>,
    persist_worker: Option<std::thread::JoinHandle<()>>,
    next_conn: AtomicU64,
    next_message: AtomicU64,
    /// Expiry and ack-wait timers that have neither fired nor been aborted.
    timers: Arc<AtomicUsize>,
    /// Connection tasks still running, including ones finishing their close handshake.
    tasks: watch::Sender<usize>,
}

impl Drop for Relay {
    fn drop(&mut self) {
        {
            let mut inner = self.lock();
            for message in inner.messages.values_mut() {
                for timer in [message.expiry.take(), message.ack_wait.take()].into_iter().flatten() {
                    timer.abort();
                }
            }
            inner.persist = None;
        }
        if let Some(worker) = self.persist_worker.take() {
            let _ = worker.join();
        }
    }
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
                rooms: BTreeMap::new(),
                rates: SlidingWindow::new(config.sends_per_minute, minute),
                device_rates: SlidingWindow::new(config.sends_per_minute_per_device, minute),
                events: VecDeque::new(),
                names: Names::new(),
                names_generation: 0,
                persist: None,
            }),
            persist_worker: None,
            config,
            next_conn: AtomicU64::new(1),
            next_message: AtomicU64::new(1),
            timers: Arc::default(),
            tasks: watch::channel(0).0,
        }
    }

    /// Hydrates persistent relay state from `store` and spawns the background SQLite writer thread.
    pub fn open(config: RelayConfig, store: Arc<Store>) -> Result<Arc<Relay>> {
        if !config.enabled {
            return Ok(Arc::new(Relay::new(config)));
        }
        let now = now_ms();
        let ttl_ms = i64::try_from(config.ttl.as_millis()).unwrap_or(i64::MAX);
        let event_ring = config.event_ring;
        let (names, rooms, mut events, live_messages, expired_mailbox_ids, has_orphan_queued) =
            store.read(|conn| -> Result<_> {
                let names = crate::auth::device_names(conn)?;

                let mut rooms = BTreeMap::new();
                {
                    let mut stmt = conn.prepare(
                        "SELECT name, topic, created_at, updated_at, representative, next_seq FROM relay_rooms",
                    )?;
                    let rows = stmt.query_map([], |r| {
                        Ok((
                            r.get::<_, String>(0)?,
                            r.get::<_, Option<String>>(1)?,
                            r.get::<_, i64>(2)?,
                            r.get::<_, i64>(3)?,
                            r.get::<_, Option<String>>(4)?,
                            r.get::<_, i64>(5)?.max(1) as u64,
                        ))
                    })?;
                    for row in rows {
                        let (name, topic, created_at, updated_at, representative, next_seq) = row?;
                        rooms.insert(
                            name.clone(),
                            Room {
                                name,
                                topic,
                                created_at,
                                updated_at,
                                members: BTreeMap::new(),
                                representative,
                                messages: VecDeque::new(),
                                next_seq,
                            },
                        );
                    }
                }

                {
                    let mut stmt = conn.prepare(
                        "SELECT room, session_id, device, name, title, project, model, joined_at FROM relay_room_members",
                    )?;
                    let rows = stmt.query_map([], |r| {
                        Ok((
                            r.get::<_, String>(0)?,
                            RoomMember {
                                session_id: r.get(1)?,
                                device: r.get(2)?,
                                name: r.get(3)?,
                                title: r.get(4)?,
                                project: r.get(5)?,
                                model: r.get(6)?,
                                joined_at: r.get(7)?,
                            },
                        ))
                    })?;
                    for row in rows {
                        let (room_name, member) = row?;
                        if let Some(room) = rooms.get_mut(&room_name) {
                            room.members.insert(member.session_id.clone(), member);
                        }
                    }
                }

                {
                    let mut stmt = conn.prepare(
                        "SELECT room, seq, id, from_json, text, mentions_json, notified_json, urgent, reply_to, hops, at
                         FROM relay_room_messages
                         ORDER BY room ASC, seq ASC",
                    )?;
                    let rows = stmt.query_map([], |r| {
                        Ok((
                            r.get::<_, String>(0)?,
                            r.get::<_, i64>(1)?.max(1) as u64,
                            r.get::<_, String>(2)?,
                            r.get::<_, String>(3)?,
                            r.get::<_, String>(4)?,
                            r.get::<_, String>(5)?,
                            r.get::<_, String>(6)?,
                            r.get::<_, i64>(7)? != 0,
                            r.get::<_, Option<String>>(8)?,
                            r.get::<_, i64>(9)?.max(0) as u64,
                            r.get::<_, i64>(10)?,
                        ))
                    })?;
                    for row in rows {
                        let (
                            room_name,
                            seq,
                            id,
                            from_json,
                            text,
                            mentions_json,
                            notified_json,
                            urgent,
                            reply_to,
                            hops,
                            at,
                        ) = row?;
                        let Some(room) = rooms.get_mut(&room_name) else { continue };
                        let from: Sender = serde_json::from_str(&from_json)
                            .with_context(|| format!("parsing relay_room_messages.from_json for {id}"))?;
                        let mentions: Vec<String> = serde_json::from_str(&mentions_json)
                            .with_context(|| format!("parsing relay_room_messages.mentions_json for {id}"))?;
                        let notified: Vec<Target> = serde_json::from_str(&notified_json)
                            .with_context(|| format!("parsing relay_room_messages.notified_json for {id}"))?;
                        room.messages.push_back(RoomMessage {
                            id,
                            seq,
                            room: room_name,
                            from,
                            text,
                            mentions,
                            notified,
                            urgent,
                            reply_to,
                            hops,
                            at,
                        });
                    }
                    for room in rooms.values_mut() {
                        while room.messages.len() > MAX_ROOM_MESSAGES {
                            room.messages.pop_front();
                        }
                        let min_next = room.messages.back().map_or(1, |m| m.seq.saturating_add(1));
                        room.next_seq = room.next_seq.max(min_next).max(1);
                    }
                }

                let mut events = VecDeque::new();
                if event_ring > 0 {
                    let mut stmt = conn.prepare(
                        "SELECT id, at, from_json, to_json, room, mentions_json, status, reason, delivered_at, urgent, reply_to, hops, text
                         FROM (
                             SELECT seq, id, at, from_json, to_json, room, mentions_json, status, reason, delivered_at, urgent, reply_to, hops, text
                             FROM relay_events
                             ORDER BY seq DESC
                             LIMIT ?1
                         )
                         ORDER BY seq ASC",
                    )?;
                    let rows = stmt.query_map([event_ring as i64], |r| {
                        Ok((
                            r.get::<_, String>(0)?,
                            r.get::<_, i64>(1)?,
                            r.get::<_, String>(2)?,
                            r.get::<_, String>(3)?,
                            r.get::<_, Option<String>>(4)?,
                            r.get::<_, String>(5)?,
                            r.get::<_, String>(6)?,
                            r.get::<_, Option<String>>(7)?,
                            r.get::<_, Option<i64>>(8)?,
                            r.get::<_, i64>(9)? != 0,
                            r.get::<_, Option<String>>(10)?,
                            r.get::<_, i64>(11)?.max(0) as u64,
                            r.get::<_, String>(12)?,
                        ))
                    })?;
                    for row in rows {
                        let (
                            id,
                            at,
                            from_json,
                            to_json,
                            room,
                            mentions_json,
                            status_str,
                            reason_str,
                            delivered_at,
                            urgent,
                            reply_to,
                            hops,
                            text,
                        ) = row?;
                        let from: Sender = serde_json::from_str(&from_json)
                            .with_context(|| format!("parsing relay_events.from_json for {id}"))?;
                        let to: Target = serde_json::from_str(&to_json)
                            .with_context(|| format!("parsing relay_events.to_json for {id}"))?;
                        let mentions: Vec<String> = serde_json::from_str(&mentions_json)
                            .with_context(|| format!("parsing relay_events.mentions_json for {id}"))?;
                        let status = Status::from_str(&status_str).unwrap_or(Status::Expired);
                        let reason = reason_str.as_deref().and_then(Reason::from_str);
                        events.push_back(Event {
                            id,
                            at,
                            from,
                            to,
                            room,
                            mentions,
                            status,
                            reason,
                            delivered_at,
                            urgent,
                            reply_to,
                            hops,
                            text,
                        });
                    }
                }

                let mut expired_mailbox_ids = Vec::new();
                let mut live_messages = Vec::new();
                {
                    let mut stmt = conn.prepare(
                        "SELECT id, session_id, owner, from_json, to_json, room, mentions_json, text, urgent, reply_to, hops, sent_at
                         FROM relay_mailbox
                         ORDER BY seq ASC",
                    )?;
                    let rows = stmt.query_map([], |r| {
                        Ok((
                            r.get::<_, String>(0)?,
                            r.get::<_, String>(1)?,
                            r.get::<_, String>(2)?,
                            r.get::<_, String>(3)?,
                            r.get::<_, String>(4)?,
                            r.get::<_, Option<String>>(5)?,
                            r.get::<_, String>(6)?,
                            r.get::<_, String>(7)?,
                            r.get::<_, i64>(8)? != 0,
                            r.get::<_, Option<String>>(9)?,
                            r.get::<_, i64>(10)?.max(0) as u64,
                            r.get::<_, i64>(11)?,
                        ))
                    })?;
                    for row in rows {
                        let (
                            id,
                            session_id,
                            owner,
                            from_json,
                            to_json,
                            room,
                            mentions_json,
                            text,
                            urgent,
                            reply_to,
                            hops,
                            sent_at,
                        ) = row?;
                        let deadline_ms = sent_at.saturating_add(ttl_ms);
                        if deadline_ms <= now {
                            expired_mailbox_ids.push(id);
                            continue;
                        }
                        let from: Sender = serde_json::from_str(&from_json)
                            .with_context(|| format!("parsing relay_mailbox.from_json for {id}"))?;
                        let mut to: Target = serde_json::from_str(&to_json)
                            .with_context(|| format!("parsing relay_mailbox.to_json for {id}"))?;
                        if to.session_id.is_empty() {
                            to.session_id = session_id;
                        }
                        let mentions: Vec<String> = serde_json::from_str(&mentions_json)
                            .with_context(|| format!("parsing relay_mailbox.mentions_json for {id}"))?;
                        let remaining = Duration::from_millis((deadline_ms - now) as u64);
                        live_messages.push((
                            Message {
                                id,
                                from,
                                to,
                                room,
                                mentions,
                                text,
                                urgent,
                                reply_to,
                                hops,
                                sent_at,
                                owner,
                                reply: None,
                                expiry: None,
                                ack_wait: None,
                            },
                            remaining,
                        ));
                    }
                }

                let has_orphan_queued: bool = conn.query_row(
                    "SELECT EXISTS(
                         SELECT 1 FROM relay_events
                         WHERE status = 'queued'
                           AND NOT EXISTS (SELECT 1 FROM relay_mailbox WHERE relay_mailbox.id = relay_events.id)
                     )",
                    [],
                    |r| r.get(0),
                )?;

                Ok((names, rooms, events, live_messages, expired_mailbox_ids, has_orphan_queued))
            })?;

        if !expired_mailbox_ids.is_empty() || has_orphan_queued {
            store.write(|tx| {
                for id in &expired_mailbox_ids {
                    tx.prepare_cached("DELETE FROM relay_mailbox WHERE id = ?1")?.execute([id])?;
                }
                tx.execute(
                    "UPDATE relay_events SET status = 'expired'
                     WHERE status = 'queued'
                       AND NOT EXISTS (SELECT 1 FROM relay_mailbox WHERE relay_mailbox.id = relay_events.id)",
                    [],
                )?;
                Ok::<_, rusqlite::Error>(())
            })?;
        }

        let (persist_tx, persist_rx) = std::sync::mpsc::channel();
        let writer_store = store.clone();
        let worker = std::thread::Builder::new()
            .name("pika-relay-persist".into())
            .spawn(move || persist_loop(writer_store, persist_rx))
            .context("spawning relay persistence worker")?;

        let minute = Duration::from_secs(60);
        let mut inner = Inner {
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
            rooms,
            rates: SlidingWindow::new(config.sends_per_minute, minute),
            device_rates: SlidingWindow::new(config.sends_per_minute_per_device, minute),
            events: VecDeque::new(),
            names,
            names_generation: 0,
            persist: Some(persist_tx),
        };

        let mut live_expiries = Vec::with_capacity(live_messages.len());
        for (message, remaining) in live_messages {
            let id = message.id.clone();
            let session_id = message.to.session_id.clone();
            let owner = message.owner.clone();
            inner.queues.entry(session_id.clone()).or_default().push_back(id.clone());
            inner.messages.insert(id.clone(), message);
            inner.remember(owner, session_id);
            live_expiries.push((id, remaining));
        }

        for event in &mut events {
            if event.status == Status::Queued && !inner.messages.contains_key(&event.id) {
                event.status = Status::Expired;
            }
        }
        inner.events = events;

        let relay = Arc::new(Relay {
            inner: Mutex::new(inner),
            persist_worker: Some(worker),
            config,
            next_conn: AtomicU64::new(1),
            next_message: AtomicU64::new(1),
            timers: Arc::default(),
            tasks: watch::channel(0).0,
        });

        if !live_expiries.is_empty() && tokio::runtime::Handle::try_current().is_ok() {
            let mut inner = relay.lock();
            for (id, remaining) in live_expiries {
                if let Some(message) = inner.messages.get_mut(&id) {
                    let expiring = id.clone();
                    message.expiry = Some(relay.timer(remaining, move |r| r.expire(&expiring)));
                }
            }
        }

        Ok(relay)
    }

    /// Waits until every persistence operation queued so far has been committed to SQLite.
    pub async fn flush(&self) {
        let rx = {
            let inner = self.lock();
            let Some(persist) = &inner.persist else { return };
            let (tx, rx) = oneshot::channel();
            if persist.send(PersistCmd::Flush(tx)).is_err() {
                return;
            }
            rx
        };
        let _ = rx.await;
    }

    /// Counts a connection task until the guard drops, so stopping the server can wait for its close handshake.
    pub fn task(&self) -> Task<'_> {
        self.tasks.send_modify(|n| *n += 1);
        Task(self)
    }

    /// Waits until every connection task has ended, at most `within`; whether they all did.
    pub async fn drained(&self, within: Duration) -> bool {
        let mut tasks = self.tasks.subscribe();
        tokio::time::timeout(within, tasks.wait_for(|n| *n == 0)).await.is_ok()
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
        let relay = Arc::downgrade(self);
        tokio::spawn(async move {
            let _pending = pending;
            tokio::time::sleep(after).await;
            if let Some(relay) = relay.upgrade() {
                f(&relay);
            }
        })
        .abort_handle()
    }

    /// The current names generation; read it before reading the names from the store, then pass it to `set_names`.
    pub fn names_generation(&self) -> u64 {
        self.lock().names_generation
    }

    /// Replaces the device names with the store's current ones, read when the names generation was `generation`. A
    /// snapshot read before a later `rename` is dropped: it may predate that rename.
    pub fn set_names(&self, names: Names, generation: u64) {
        let mut inner = self.lock();
        if inner.names_generation == generation {
            inner.names = names;
        }
    }

    /// Names device `id` `name` from now on.
    pub fn rename(&self, id: &str, name: &str) {
        let mut inner = self.lock();
        inner.names.insert(id.to_owned(), name.to_owned());
        inner.names_generation += 1;
    }

    /// The current display name of device `id`, its id when it has none.
    pub fn device_name(&self, id: &str) -> String {
        name_of(&self.lock().names, id).to_owned()
    }

    /// The owner of `session` ("Ownership" in `docs/RELAY.md`), given the device pika's sessions table records for it.
    pub fn owner(&self, session: &str, recorded_device: Option<&str>) -> Option<String> {
        self.lock().owner(session, recorded_device).map(str::to_owned)
    }

    /// A target as JSON, with its device's current name.
    pub fn target_json(&self, target: &Target) -> Value {
        target.to_json(&self.lock().names)
    }

    /// Multiple targets as JSON, with their devices' current names.
    pub fn targets_json(&self, targets: &[Target]) -> Vec<Value> {
        let names = &self.lock().names;
        targets.iter().map(|t| t.to_json(names)).collect()
    }

    /// Session id held online by connection `conn`.
    pub fn session_of(&self, conn: u64) -> Option<String> {
        let inner = self.lock();
        inner.conns.get(&conn).and_then(|c| c.session.clone())
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
        // Only the owner takes the session online. Another device holding it online closes 4409, unless pika records a
        // third device for it; any other owner closes 4403.
        match inner.online.get(&info.id) {
            Some(other) if other.device != device && recorded_device.is_none_or(|d| d == device) => {
                return Err(close::ONLINE_ELSEWHERE);
            }
            _ if inner.owner(&info.id, recorded_device).is_some_and(|d| d != device) => {
                return Err(close::OTHER_DEVICE);
            }
            Some(other) => {
                let old = other.conn;
                inner.close(old, close::REPLACED, "replaced by a newer connection");
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
        let mut refreshed_members = Vec::new();
        if let Some(online) = inner.online.get(&id).cloned() {
            for (room_name, room) in &mut inner.rooms {
                if let Some(member) = room.members.get_mut(&id)
                    && member.refresh(&online)
                {
                    refreshed_members.push((room_name.clone(), member.clone()));
                }
            }
        }
        for (room_name, member) in refreshed_members {
            inner.persist(PersistOp::UpsertRoomMember { room: room_name, member });
        }
        if let Some(c) = inner.conns.get_mut(&conn) {
            c.session = Some(id.clone());
        }
        let welcome = json!({
            "type": "welcome",
            "device": device,
            "deviceName": name_of(&inner.names, &device),
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
            .map(|m| m.frame(&inner.names))
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
        if draft.room.is_some() {
            self.send_room(from, draft, reply);
            return;
        }
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
            let parts = (draft.text.as_str(), draft.urgent, &draft.reply_to, draft.hops);
            draft.text.len() > config.max_text_bytes
                || message_frame(&id, &sender, parts, now, &inner.names).len() > config.max_frame_bytes
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
            room: None,
            mentions: Vec::new(),
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
            room: None,
            mentions: Vec::new(),
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
                let frame = message.frame(&inner.names);
                inner.push(conn, frame);
                message.reply = Some(reply);
                let waiting = id.clone();
                message.ack_wait = Some(self.timer(config.ack_wait, move |relay| relay.ack_wait_ended(&waiting)));
            }
            None => inner.answer(reply, Outcome::Accepted { id: id.clone(), delivered: false, target }),
        }
        let expiring = id.clone();
        message.expiry = Some(self.timer(config.ttl, move |relay| relay.expire(&expiring)));
        inner.persist(PersistOp::InsertMailbox(MailboxRow::from_message(&message)));
        inner.queues.entry(draft.to).or_default().push_back(id.clone());
        inner.messages.insert(id, message);
    }

    /// Posts a message to an existing chatroom and pushes live `[relay]` notifications only to `@`-mentioned members.
    /// A session must be a member of the room, the web UI may post to any room; posting never creates a room or adds a
    /// member, and mentions resolve only among the members.
    pub fn send_room(self: &Arc<Self>, from: Origin, draft: Draft, reply: Reply) {
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
        let room_name = draft.room.clone().unwrap_or_default();
        let room_target = Target {
            session_id: if room_name.is_empty() { String::new() } else { format!("#{room_name}") },
            device: None,
            name: (!room_name.is_empty()).then(|| format!("#{room_name}")),
            title: None,
            project: None,
        };
        let config = &self.config;
        let id = self.new_id();
        let too_large = || {
            let parts = (draft.text.as_str(), draft.urgent, &draft.reply_to, draft.hops);
            draft.text.len() > config.max_text_bytes
                || message_frame_with_room(&id, &sender, parts, Some(&room_name), &draft.mentions, now, &inner.names)
                    .len()
                    > config.max_frame_bytes
        };
        let rejection = if !draft.valid || !valid_room_name(&room_name) {
            Some(Reason::Invalid)
        } else if too_large() {
            Some(Reason::TooLarge)
        } else if inner.rate_limited(&sender, Instant::now()) {
            Some(Reason::RateLimited)
        } else if draft.hops > config.max_hops {
            Some(Reason::HopLimit)
        } else if !inner.rooms.contains_key(&room_name) {
            Some(Reason::UnknownRoom)
        } else if sender.session_id().is_some_and(|s| !inner.rooms[&room_name].members.contains_key(s)) {
            Some(Reason::NotMember)
        } else {
            None
        };
        if let Some(reason) = rejection {
            let event = Event {
                id,
                at: now,
                from: sender,
                to: room_target,
                room: (!room_name.is_empty()).then_some(room_name),
                mentions: Vec::new(),
                status: Status::Rejected,
                reason: Some(reason),
                delivered_at: None,
                urgent: draft.urgent,
                reply_to: draft.reply_to,
                hops: draft.hops,
                text: cut_bytes(&draft.text, config.max_text_bytes).to_owned(),
            };
            inner.record(event, config.event_ring);
            inner.answer(reply, Outcome::Rejected(reason));
            return;
        }

        // Gather mention tokens from `draft.mentions` and `@token` in `draft.text`.
        let mut tokens: Vec<String> = Vec::new();
        for token in draft.mentions.iter().cloned().chain(extract_mentions(&draft.text)) {
            if !tokens.iter().any(|t| t.eq_ignore_ascii_case(&token)) {
                tokens.push(token);
            }
        }
        let everyone = |t: &str| t.eq_ignore_ascii_case("all") || t.eq_ignore_ascii_case("everyone") || t == "*";
        let mention_all = tokens.iter().any(|t| everyone(t));

        // Resolve mentions among the room's members; the sender may be named but is never notified.
        let sender_sid = sender.session_id().map(str::to_owned);
        let mut notified_targets: Vec<(Target, String)> = Vec::new();
        let mut resolved_ids: Vec<String> = Vec::new();
        let mut named = vec![false; tokens.len()];
        let mut refreshed_members: Vec<RoomMember> = Vec::new();
        {
            let online_snapshot: HashMap<String, Online> = inner.online.clone();
            let remembered_owners: HashMap<String, String> = inner
                .remembered
                .iter()
                .filter_map(|(sid, _)| inner.remembered_owner(sid).map(|d| (sid.clone(), d.to_owned())))
                .collect();
            if let Some(room) = inner.rooms.get_mut(&room_name) {
                for member in room.members.values_mut() {
                    if let Some(online) = online_snapshot.get(&member.session_id)
                        && member.refresh(online)
                    {
                        refreshed_members.push(member.clone());
                    }
                    let online = online_snapshot.get(&member.session_id);
                    let mut matched = mention_all;
                    for (token, named) in tokens.iter().zip(named.iter_mut()) {
                        if !everyone(token) && member.matches_mention(token, online) {
                            *named = true;
                            matched = true;
                        }
                    }
                    if sender_sid.as_deref() == Some(member.session_id.as_str()) {
                        continue;
                    }
                    if matched {
                        let owner = online
                            .map(|o| o.device.clone())
                            .or_else(|| remembered_owners.get(&member.session_id).cloned())
                            .or_else(|| member.device.clone());
                        resolved_ids.push(member.session_id.clone());
                        let target = member.target(online);
                        if let Some(owner) = owner {
                            notified_targets.push((target, owner));
                        } else {
                            notified_targets.push((target, String::new()));
                        }
                    }
                }
            }
        }
        for member in refreshed_members {
            inner.persist(PersistOp::UpsertRoomMember { room: room_name.clone(), member });
        }

        let unmatched: Vec<String> = (tokens.into_iter().zip(named))
            .filter(|(token, named)| !named && !everyone(token))
            .map(|(token, _)| token)
            .collect();
        let notified: Vec<Target> = notified_targets.iter().map(|(t, _)| t.clone()).collect();
        let mut room_persistence = None;
        if let Some(room) = inner.rooms.get_mut(&room_name) {
            let seq = room.next_seq;
            room.next_seq += 1;
            room.updated_at = now;
            if room.messages.len() >= MAX_ROOM_MESSAGES {
                room.messages.pop_front();
            }
            let room_msg = RoomMessage {
                id: id.clone(),
                seq,
                room: room_name.clone(),
                from: sender.clone(),
                text: cut_bytes(&draft.text, config.max_text_bytes).to_owned(),
                mentions: resolved_ids.clone(),
                notified: notified.clone(),
                urgent: draft.urgent,
                reply_to: draft.reply_to.clone(),
                hops: draft.hops,
                at: now,
            };
            room.messages.push_back(room_msg.clone());
            room_persistence = Some((RoomRow::from_room(room), room_msg));
        }
        if let Some((room_row, room_msg)) = room_persistence {
            inner.persist(PersistOp::UpsertRoom(room_row));
            inner.persist(PersistOp::InsertRoomMessage { message: room_msg, max_messages: MAX_ROOM_MESSAGES });
        }

        let event = Event {
            id: id.clone(),
            at: now,
            from: sender.clone(),
            to: room_target.clone(),
            room: Some(room_name.clone()),
            mentions: resolved_ids.clone(),
            status: Status::Delivered,
            reason: None,
            delivered_at: Some(now),
            urgent: draft.urgent,
            reply_to: draft.reply_to.clone(),
            hops: draft.hops,
            text: cut_bytes(&draft.text, config.max_text_bytes).to_owned(),
        };
        inner.record(event, config.event_ring);

        // Push/queue `[relay]` notifications for each mentioned member that has a known owner device.
        for (idx, (target, owner)) in notified_targets.into_iter().enumerate() {
            if owner.is_empty() {
                continue;
            }
            if inner.queues.get(&target.session_id).is_some_and(|q| q.len() >= config.max_queued_per_target)
                || inner.messages.len() >= config.max_queued
            {
                continue;
            }
            let notif_id = if idx == 0 { id.clone() } else { self.new_id() };
            let mut message = Message {
                id: notif_id.clone(),
                from: sender.clone(),
                to: target.clone(),
                room: Some(room_name.clone()),
                mentions: resolved_ids.clone(),
                text: draft.text.clone(),
                urgent: draft.urgent,
                reply_to: draft.reply_to.clone(),
                hops: draft.hops,
                sent_at: now,
                owner,
                reply: None,
                expiry: None,
                ack_wait: None,
            };
            if let Some(conn) = inner.online.get(&target.session_id).filter(|o| o.device == message.owner).map(|o| o.conn) {
                let frame = message.frame(&inner.names);
                inner.push(conn, frame);
            }
            let expiring = notif_id.clone();
            message.expiry = Some(self.timer(config.ttl, move |relay| relay.expire(&expiring)));
            inner.persist(PersistOp::InsertMailbox(MailboxRow::from_message(&message)));
            inner.queues.entry(target.session_id).or_default().push_back(notif_id.clone());
            inner.messages.insert(notif_id, message);
        }

        inner.answer(reply, Outcome::RoomAccepted { id, room: room_name, target: room_target, notified, unmatched });
    }

    /// Lists all active chatrooms, most recently active first.
    pub fn rooms(&self) -> Vec<Value> {
        let inner = self.lock();
        let mut list: Vec<&Room> = inner.rooms.values().collect();
        list.sort_by(|a, b| b.updated_at.cmp(&a.updated_at).then_with(|| a.name.cmp(&b.name)));
        list.into_iter().map(|r| r.summary_json(&inner.online, &inner.names)).collect()
    }

    /// Reads one chatroom's summary and message history (`seq > after`, up to `limit` newest messages).
    pub fn room(&self, raw_name: &str, limit: usize, after: u64) -> Option<Value> {
        let name = normalize_room_name(raw_name);
        let inner = self.lock();
        let room = inner.rooms.get(name)?;
        Some(room.detail_json(&inner.online, &inner.names, limit.clamp(1, MAX_ROOM_MESSAGES), after))
    }

    /// Creates or updates a chatroom and adds `members` (each with its optional `Recorded` fallback).
    /// `topic` is `None` when omitted (preserving an existing room's topic), `Some(None)` or blank `Some(Some(_))`
    /// to clear it, or `Some(Some(_))` to set it.
    pub fn save_room(
        &self,
        raw_name: &str,
        topic: Option<Option<String>>,
        members: &[(String, Option<Recorded>)],
    ) -> Result<Value, Reason> {
        let name = normalize_room_name(raw_name);
        if !valid_room_name(name) {
            return Err(Reason::Invalid);
        }
        let mut inner = self.lock();
        if !inner.rooms.contains_key(name) && inner.rooms.len() >= MAX_ROOMS {
            return Err(Reason::MailboxFull);
        }
        let now = now_ms();
        let topic_update =
            topic.map(|t| t.map(|s| cut_chars(s.trim(), 200).to_owned()).filter(|s| !s.is_empty()));
        let online_snapshot: HashMap<String, Online> =
            inner.online.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
        for (sid, rec) in members {
            if !valid_session_id(sid) {
                return Err(Reason::Invalid);
            }
            let already_member = inner.rooms.get(name).is_some_and(|r| r.members.contains_key(sid));
            if !online_snapshot.contains_key(sid) && rec.is_none() && !already_member {
                return Err(Reason::UnknownSession);
            }
        }
        let mut upserted_members = Vec::new();
        let room_row = {
            let initial_topic = topic_update.clone().flatten();
            let room = inner
                .rooms
                .entry(name.to_owned())
                .or_insert_with(|| Room::new(name.to_owned(), initial_topic, now));
            if let Some(new_topic) = topic_update {
                room.topic = new_topic;
            }
            room.updated_at = now;
            for (sid, rec) in members {
                if let Some(online) = online_snapshot.get(sid) {
                    let member = room
                        .members
                        .entry(sid.clone())
                        .and_modify(|m| {
                            m.refresh(online);
                        })
                        .or_insert_with(|| RoomMember::from_online(online, now))
                        .clone();
                    upserted_members.push(member);
                } else if rec.is_some() {
                    let member = room
                        .members
                        .entry(sid.clone())
                        .or_insert_with(|| RoomMember::from_recorded(sid, rec.as_ref(), now))
                        .clone();
                    upserted_members.push(member);
                }
            }
            RoomRow::from_room(room)
        };
        inner.persist(PersistOp::UpsertRoom(room_row));
        for member in upserted_members {
            inner.persist(PersistOp::UpsertRoomMember { room: name.to_owned(), member });
        }
        Ok(inner.rooms[name].detail_json(&online_snapshot, &inner.names, MAX_ROOM_MESSAGES, 0))
    }

    /// Joins, leaves, represents, or stops representing a chatroom for `session_id`. Joining and representing create
    /// the room if it does not exist yet. When the representative changes, every online member, and the previous
    /// representative if it left, gets a `room` frame. `device` is the device acting for the session, which must own
    /// it (see `Inner::owner`): another owner is `NotOwner`, none at all `UnknownSession`, and neither changes
    /// anything. `None` is the user, who may act for any session.
    pub fn set_room_member(
        &self,
        raw_name: &str,
        session_id: &str,
        recorded: Option<Recorded>,
        device: Option<&str>,
        action: RoomAction,
        topic: Option<String>,
    ) -> Result<Value, Reason> {
        let name = normalize_room_name(raw_name);
        if !valid_room_name(name) || !valid_session_id(session_id) {
            return Err(Reason::Invalid);
        }
        let mut inner = self.lock();
        let member_device = inner
            .rooms
            .get(name)
            .and_then(|r| r.members.get(session_id))
            .and_then(|m| m.device.clone());
        if let Some(device) = device {
            let known_device = recorded.as_ref().map(|r| r.device.as_str()).or(member_device.as_deref());
            match inner.owner(session_id, known_device) {
                None => return Err(Reason::UnknownSession),
                Some(owner) if owner != device => return Err(Reason::NotOwner),
                Some(_) => {}
            }
        }
        let now = now_ms();
        let online_snapshot: HashMap<String, Online> = inner.online.clone();
        let previous = inner.rooms.get(name).and_then(|r| r.representative.clone());
        if matches!(action, RoomAction::Join | RoomAction::Represent) {
            if !inner.rooms.contains_key(name) && inner.rooms.len() >= MAX_ROOMS {
                return Err(Reason::MailboxFull);
            }
            let online = online_snapshot.get(session_id);
            let already_member = inner.rooms.get(name).is_some_and(|r| r.members.contains_key(session_id));
            if online.is_none() && recorded.is_none() && !already_member {
                return Err(Reason::UnknownSession);
            }
            let clean_topic = topic.map(|t| cut_chars(t.trim(), 200).to_owned()).filter(|t| !t.is_empty());
            let (room_row, member) = {
                let room = inner
                    .rooms
                    .entry(name.to_owned())
                    .or_insert_with(|| Room::new(name.to_owned(), clean_topic.clone(), now));
                if clean_topic.is_some() {
                    room.topic = clean_topic;
                }
                room.updated_at = now;
                let member = if let Some(online) = online {
                    room.members
                        .entry(session_id.to_owned())
                        .and_modify(|m| {
                            m.refresh(online);
                        })
                        .or_insert_with(|| RoomMember::from_online(online, now))
                        .clone()
                } else {
                    room.members
                        .entry(session_id.to_owned())
                        .or_insert_with(|| RoomMember::from_recorded(session_id, recorded.as_ref(), now))
                        .clone()
                };
                if action == RoomAction::Represent {
                    room.representative = Some(session_id.to_owned());
                }
                (RoomRow::from_room(room), member)
            };
            inner.persist(PersistOp::UpsertRoom(room_row));
            inner.persist(PersistOp::UpsertRoomMember { room: name.to_owned(), member });
        } else {
            let (room_row, represents) = {
                let Some(room) = inner.rooms.get_mut(name) else {
                    return Err(Reason::Invalid);
                };
                let represents = room.representative.as_deref() == Some(session_id);
                if represents {
                    room.representative = None;
                }
                if action == RoomAction::Leave {
                    room.members.remove(session_id);
                }
                if action == RoomAction::Leave || represents {
                    room.updated_at = now;
                }
                (RoomRow::from_room(room), represents)
            };
            if action == RoomAction::Leave || represents {
                inner.persist(PersistOp::UpsertRoom(room_row));
            }
            if action == RoomAction::Leave {
                inner.persist(PersistOp::DeleteRoomMember {
                    room: name.to_owned(),
                    session_id: session_id.to_owned(),
                });
            }
        }
        let room = &inner.rooms[name];
        let current = room.representative.clone();
        if current != previous {
            let mut sessions: BTreeSet<String> = room.members.keys().cloned().collect();
            sessions.extend(previous);
            inner.announce_representative(name, current.as_deref(), sessions);
        }
        Ok(inner.rooms[name].detail_json(&online_snapshot, &inner.names, MAX_ROOM_MESSAGES, 0))
    }

    /// Deletes a chatroom; returns whether it existed. A room that had a representative tells its online members
    /// that nobody represents it now.
    pub fn delete_room(&self, raw_name: &str) -> bool {
        let name = normalize_room_name(raw_name);
        let mut inner = self.lock();
        let Some(room) = inner.rooms.remove(name) else { return false };
        inner.persist(PersistOp::DeleteRoom { name: name.to_owned() });
        if let Some(representative) = room.representative {
            let mut sessions: BTreeSet<String> = room.members.into_keys().collect();
            sessions.insert(representative);
            inner.announce_representative(name, None, sessions);
        }
        true
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
        if message.room.is_some() {
            return;
        }
        let now = now_ms();
        let mut transitioned = false;
        if let Some(event) = inner.event(id)
            && event.status == Status::Queued
        {
            event.status = Status::Delivered;
            event.delivered_at = Some(now);
            transitioned = true;
        }
        if transitioned {
            inner.persist(PersistOp::MarkEventDelivered { id: id.to_owned(), delivered_at: now });
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
        if message.room.is_some() {
            return;
        }
        if let Some(reply) = message.reply.take() {
            inner.answer(reply, Outcome::Accepted { id: id.to_owned(), delivered: false, target: message.to.clone() });
        }
        let mut transitioned = false;
        if let Some(event) = inner.event(id)
            && event.status == Status::Queued
        {
            event.status = Status::Expired;
            transitioned = true;
        }
        if transitioned {
            inner.persist(PersistOp::MarkEventExpired { id: id.to_owned() });
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

    /// The online sessions, by device name case-insensitively, then device id, then newest connection first.
    pub fn online(&self) -> Vec<OnlineSession> {
        let inner = self.lock();
        let mut items: Vec<OnlineSession> = inner
            .online
            .values()
            .map(|o| OnlineSession {
                device: o.device.clone(),
                device_name: name_of(&inner.names, &o.device).to_owned(),
                info: o.info.clone(),
                connected_at: o.connected_at,
                state_since: o.state_since,
                last_seen_at: o.last_seen_at,
            })
            .collect();
        items.sort_by(|a, b| {
            crate::auth::by_name((&a.device, &a.device_name), (&b.device, &b.device_name))
                .then(b.connected_at.cmp(&a.connected_at))
                .then_with(|| a.info.id.cmp(&b.info.id))
        });
        items
    }

    /// The newest `limit` events, newest first.
    pub fn events(&self, limit: usize) -> Vec<Value> {
        let inner = self.lock();
        inner.events.iter().rev().take(limit).map(|e| e.to_json(&inner.names)).collect()
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
        assert_eq!((c.max_text_bytes, c.max_frame_bytes, c.max_hops), (32 * 1024, 64 * 1024, 128));
        assert_eq!((c.sends_per_minute, c.sends_per_minute_per_device, c.max_outgoing_bytes), (60, 300, 8 << 20));
        assert_eq!((c.max_queued_per_target, c.max_queued), (100, 10_000));
        assert_eq!((c.max_online, c.max_connections_per_device, c.event_ring), (1_000, 64, 500));
        assert_eq!(c.max_remembered, 10_000);
    }

    #[test]
    fn a_names_snapshot_older_than_a_rename_does_not_undo_it() {
        let relay = Relay::new(RelayConfig::default());
        let generation = relay.names_generation();
        // The store is read here, then a rename lands before the snapshot is applied.
        let stale = Names::from([("laptop".to_owned(), "old".to_owned())]);
        relay.rename("laptop", "new");
        relay.set_names(stale, generation);
        assert_eq!(relay.lock().names["laptop"], "new");
        let fresh = Names::from([("laptop".to_owned(), "newer".to_owned())]);
        relay.set_names(fresh, relay.names_generation());
        assert_eq!(relay.lock().names["laptop"], "newer");
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

    #[test]
    fn persisted_sender_and_target_store_raw_device_ids_and_resolve_names_dynamically() {
        let sender = Sender::Session {
            session_id: "s1".into(),
            device: "dev-1".into(),
            name: Some("worker".into()),
            title: None,
            project: "pika".into(),
        };
        let target = Target {
            session_id: "s2".into(),
            device: Some("dev-2".into()),
            name: Some("review".into()),
            title: Some("Review PR".into()),
            project: Some("pika".into()),
        };
        let sender_db: Value = serde_json::from_str(&serde_json::to_string(&sender).unwrap()).unwrap();
        let target_db: Value = serde_json::from_str(&serde_json::to_string(&target).unwrap()).unwrap();
        assert!(sender_db.get("deviceName").is_none(), "{sender_db}");
        assert!(target_db.get("deviceName").is_none(), "{target_db}");
        assert_eq!(serde_json::from_value::<Sender>(sender_db).unwrap(), sender);
        assert_eq!(serde_json::from_value::<Target>(target_db).unwrap(), target);
        assert_eq!(serde_json::from_str::<Sender>(r#"{"kind":"web"}"#).unwrap(), Sender::Web);

        let names = Names::from([("dev-1".into(), "MacBook".into()), ("dev-2".into(), "Workstation".into())]);
        assert_eq!(sender.to_json(&names)["deviceName"], "MacBook");
        assert_eq!(target.to_json(&names)["deviceName"], "Workstation");
    }
}
