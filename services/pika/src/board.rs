//! Swarm boards: one kanban board per coordinator session, the latest full snapshot its device uploaded. See "Boards"
//! in `docs/RELAY.md`.

use anyhow::Result;
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use crate::store::Store;
use crate::util::{format_iso_ms, now_ms};

/// Most cards a board may hold.
pub const MAX_CARDS: usize = 200;
/// Largest request body a board upload may have, in bytes.
pub const MAX_BYTES: usize = 64 * 1024;
/// Longest id, in characters, of a card or of who created or updated it.
const MAX_ID_CHARS: usize = 128;
/// The latest time accepted: the end of year 9999, in Unix milliseconds.
const MAX_TIME: i64 = 253_402_300_799_999;

pub const STATUSES: &[&str] = &["todo", "doing", "blocked", "done", "failed", "dropped"];

/// One card, as the coordinator's extension wrote it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Card {
    pub id: String,
    pub title: String,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    pub created_by: String,
    pub updated_by: String,
    pub created_at: i64,
    pub updated_at: i64,
}

impl Card {
    fn to_json(&self) -> Value {
        let mut object = Map::new();
        object.insert("id".into(), self.id.as_str().into());
        object.insert("title".into(), self.title.as_str().into());
        object.insert("status".into(), self.status.as_str().into());
        for (key, value) in [("agentId", &self.agent_id), ("agent", &self.agent), ("note", &self.note)] {
            if let Some(value) = value {
                object.insert(key.into(), value.as_str().into());
            }
        }
        object.insert("createdBy".into(), self.created_by.as_str().into());
        object.insert("updatedBy".into(), self.updated_by.as_str().into());
        object.insert("createdAt".into(), format_iso_ms(self.created_at).into());
        object.insert("updatedAt".into(), format_iso_ms(self.updated_at).into());
        Value::Object(object)
    }
}

/// A validated upload.
#[derive(Clone, Debug)]
pub struct Snapshot {
    pub updated_at: i64,
    pub cards: Vec<Card>,
}

/// Why an upload was refused: `too_large` (413) or `invalid` (400), with a message naming the field.
#[derive(Debug, PartialEq, Eq)]
pub enum Refusal {
    TooLarge(String),
    Invalid(String),
}

fn invalid(message: impl Into<String>) -> Refusal {
    Refusal::Invalid(message.into())
}

/// A Unix-millisecond time: an integer from 0 to the end of year 9999.
fn time(value: Option<&Value>, field: &str) -> Result<i64, Refusal> {
    let ms = match value {
        Some(Value::Number(n)) => n.as_i64().or_else(|| n.as_f64().filter(|f| f.fract() == 0.0).map(|f| f as i64)),
        _ => None,
    };
    ms.filter(|ms| (0..=MAX_TIME).contains(ms)).ok_or_else(|| invalid(format!("{field} must be Unix milliseconds")))
}

fn string<'a>(object: &'a Map<String, Value>, key: &str, at: &str) -> Result<&'a str, Refusal> {
    object.get(key).and_then(Value::as_str).ok_or_else(|| invalid(format!("{at}.{key} must be a string")))
}

fn id<'a>(object: &'a Map<String, Value>, key: &str, at: &str) -> Result<&'a str, Refusal> {
    let value = string(object, key, at)?;
    if value.is_empty() || value.chars().count() > MAX_ID_CHARS {
        return Err(invalid(format!("{at}.{key} must be 1-{MAX_ID_CHARS} characters")));
    }
    Ok(value)
}

fn optional(object: &Map<String, Value>, key: &str, at: &str) -> Result<Option<String>, Refusal> {
    match object.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => Ok(Some(s.clone())),
        Some(_) => Err(invalid(format!("{at}.{key} must be a string"))),
    }
}

/// Validates the upload `body` for session `session_id`: `{ version: 1, sessionId, updatedAt, cards }`. Unknown fields
/// are dropped.
pub fn parse(body: &Value, session_id: &str) -> Result<Snapshot, Refusal> {
    let Some(object) = body.as_object() else { return Err(invalid("the body must be a board object")) };
    if object.get("version") != Some(&json!(1)) {
        return Err(invalid("version must be 1"));
    }
    if object.get("sessionId").and_then(Value::as_str) != Some(session_id) {
        return Err(invalid("sessionId must be the session of the path"));
    }
    let updated_at = time(object.get("updatedAt"), "updatedAt")?;
    let Some(items) = object.get("cards").and_then(Value::as_array) else {
        return Err(invalid("cards must be an array"));
    };
    if items.len() > MAX_CARDS {
        return Err(Refusal::TooLarge(format!("a board holds at most {MAX_CARDS} cards")));
    }
    let mut cards = Vec::with_capacity(items.len());
    let mut seen = std::collections::HashSet::new();
    for (index, item) in items.iter().enumerate() {
        let at = format!("cards[{index}]");
        let Some(card) = item.as_object() else { return Err(invalid(format!("{at} must be an object"))) };
        let status = string(card, "status", &at)?;
        if !STATUSES.contains(&status) {
            return Err(invalid(format!("{at}.status must be one of {}", STATUSES.join(", "))));
        }
        let card_id = id(card, "id", &at)?;
        if !seen.insert(card_id) {
            return Err(invalid(format!("{at}.id repeats an earlier card's")));
        }
        cards.push(Card {
            id: card_id.to_owned(),
            title: string(card, "title", &at)?.to_owned(),
            status: status.to_owned(),
            agent_id: optional(card, "agentId", &at)?,
            agent: optional(card, "agent", &at)?,
            note: optional(card, "note", &at)?,
            created_by: id(card, "createdBy", &at)?.to_owned(),
            updated_by: id(card, "updatedBy", &at)?.to_owned(),
            created_at: time(card.get("createdAt"), &format!("{at}.createdAt"))?,
            updated_at: time(card.get("updatedAt"), &format!("{at}.updatedAt"))?,
        });
    }
    Ok(Snapshot { updated_at, cards })
}

/// What `save` did: stored the snapshot, or kept a newer one already stored.
#[derive(Debug, PartialEq, Eq)]
pub enum Saved {
    Stored,
    Stale { updated_at: i64 },
}

/// Replaces the board of `session_id`, owned by `device`, unless the stored one has a newer `updatedAt`.
pub fn save(store: &Store, session_id: &str, device: &str, snapshot: &Snapshot) -> Result<Saved> {
    let cards = serde_json::to_string(&snapshot.cards)?;
    store.write(|tx| {
        let stored: Option<i64> = tx
            .prepare_cached("SELECT updated_at FROM relay_boards WHERE session_id = ?1")?
            .query_row([session_id], |r| r.get(0))
            .optional()?;
        if let Some(updated_at) = stored.filter(|stored| *stored > snapshot.updated_at) {
            return Ok(Saved::Stale { updated_at });
        }
        tx.prepare_cached(
            "INSERT OR REPLACE INTO relay_boards (session_id, device, updated_at, received_at, cards_json)
             VALUES (?1, ?2, ?3, ?4, ?5)",
        )?
        .execute(params![session_id, device, snapshot.updated_at, now_ms(), cards])?;
        Ok(Saved::Stored)
    })
}

/// A stored board.
#[derive(Clone, Debug)]
pub struct Board {
    pub session_id: String,
    pub device: String,
    pub updated_at: i64,
    pub received_at: i64,
    pub cards: Vec<Card>,
}

impl Board {
    /// `{ sessionId, device, updatedAt, receivedAt, cards }`; the caller adds `deviceName` and the session's labels.
    pub fn to_json(&self) -> Map<String, Value> {
        let mut object = Map::new();
        object.insert("sessionId".into(), self.session_id.as_str().into());
        object.insert("device".into(), self.device.as_str().into());
        object.insert("updatedAt".into(), format_iso_ms(self.updated_at).into());
        object.insert("receivedAt".into(), format_iso_ms(self.received_at).into());
        object.insert("cards".into(), Value::Array(self.cards.iter().map(Card::to_json).collect()));
        object
    }
}

/// The stored boards of `ids`, in the order of `ids`, skipping sessions without one.
pub fn load(store: &Store, ids: &[String]) -> Result<Vec<Board>> {
    let rows = store.read(|conn| {
        let mut statement = conn.prepare_cached(
            "SELECT device, updated_at, received_at, cards_json FROM relay_boards WHERE session_id = ?1",
        )?;
        let mut rows = Vec::new();
        for id in ids {
            let row = statement
                .query_row([id], |r| Ok((id.clone(), r.get(0)?, r.get(1)?, r.get(2)?, r.get::<_, String>(3)?)))
                .optional()?;
            rows.extend(row);
        }
        Ok::<_, rusqlite::Error>(rows)
    })?;
    rows.into_iter()
        .map(|(session_id, device, updated_at, received_at, cards)| {
            Ok(Board { session_id, device, updated_at, received_at, cards: serde_json::from_str(&cards)? })
        })
        .collect()
}
