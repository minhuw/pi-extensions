//! SQLite persistence, startup hydration, and session-record lookups for the relay.
//!
//! All SQLite I/O for the relay lives in this module so that `relay::mod` cannot perform database work while holding
//! its state mutex.

use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use rusqlite::{OptionalExtension, Transaction, params};
use tokio::sync::oneshot;

use crate::store::Store;
use crate::util::now_ms;

use super::{Event, MAX_ROOM_MESSAGES, Message, Names, Reason, Room, RoomMember, RoomMessage, Sender, Status, Target};

const PERSIST_CHANNEL_CAPACITY: usize = 4096;

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

/// The recorded sessions among `ids`, fetched in a single SQLite read.
pub fn recorded_batch(store: &Store, ids: &[String]) -> Result<HashMap<String, Recorded>> {
    if ids.is_empty() {
        return Ok(HashMap::new());
    }
    let ids_json = serde_json::to_string(ids)?;
    Ok(store.read(|conn| {
        let mut stmt = conn.prepare_cached(
            "SELECT id, device, name, title, project
             FROM sessions
             WHERE id IN (SELECT value FROM json_each(?1))",
        )?;
        let rows = stmt.query_map([&ids_json], |r| {
            Ok((
                r.get::<_, String>(0)?,
                Recorded { device: r.get(1)?, name: r.get(2)?, title: r.get(3)?, project: r.get(4)? },
            ))
        })?;
        let mut found = HashMap::new();
        for row in rows {
            let (id, rec) = row?;
            found.insert(id, rec);
        }
        Ok::<_, rusqlite::Error>(found)
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

#[derive(Clone)]
pub(super) struct RoomRow {
    name: String,
    topic: Option<String>,
    created_at: i64,
    updated_at: i64,
    representative: Option<String>,
    next_seq: u64,
}

impl RoomRow {
    pub(super) fn from_room(room: &Room) -> RoomRow {
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

pub(super) struct MailboxRow {
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
    pub(super) fn from_message(m: &Message) -> MailboxRow {
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

pub(super) enum PersistOp {
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

pub(super) enum PersistCmd {
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

pub(super) fn spawn_worker(
    store: Arc<Store>,
) -> Result<(std::sync::mpsc::SyncSender<PersistCmd>, std::thread::JoinHandle<()>)> {
    let (persist_tx, persist_rx) = std::sync::mpsc::sync_channel(PERSIST_CHANNEL_CAPACITY);
    let worker = std::thread::Builder::new()
        .name("pika-relay-persist".into())
        .spawn(move || persist_loop(store, persist_rx))
        .context("spawning relay persistence worker")?;
    Ok((persist_tx, worker))
}

/// Relay state hydrated from SQLite on startup.
pub(super) struct Hydrated {
    pub(super) names: Names,
    pub(super) rooms: BTreeMap<String, Room>,
    pub(super) events: VecDeque<Event>,
    pub(super) live_messages: Vec<(Message, Duration)>,
}

/// Reads persisted relay rooms, events, and unexpired mailbox entries from `store`, expiring stale mailbox entries
/// and orphan queued events in SQLite before returning.
pub(super) fn hydrate(store: &Store, ttl: Duration, event_ring: usize) -> Result<Hydrated> {
    let now = now_ms();
    let ttl_ms = i64::try_from(ttl.as_millis()).unwrap_or(i64::MAX);
    let (names, rooms, events, live_messages, expired_mailbox_ids, has_orphan_queued) =
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

    Ok(Hydrated { names, rooms, events, live_messages })
}
