//! The full-text index over session entries: `search_docs` holds capped text and `search_fts` indexes it. The text
//! is scrubbed of credentials (`crate::redact`) before it is indexed, so no search, the owner's included, finds a
//! credential's value or shows it in a snippet.

use std::collections::{HashMap, HashSet};

use anyhow::Result;
use rusqlite::{Transaction, params};
use serde_json::Value;

use crate::blobs::BlobStore;
use crate::memory;
use crate::redact::{Scope, scrub_cut_text, scrub_text};
use crate::util::{cut_bytes, parse_json_lenient};

use super::session::content_text;
use super::{str_field, time_field};

/// Marks the start and end of a match in snippets; stripped from indexed text so they cannot occur in it.
pub const MARK_START: char = '\u{2}';
pub const MARK_END: char = '\u{3}';

pub const TEXT_BYTES: usize = 64 * 1024;
pub const TOOL_CALL_BYTES: usize = 4 * 1024;
pub const TOOL_RESULT_BYTES: usize = 16 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    User,
    Assistant,
    ToolCall,
    ToolResult,
    Title,
}

impl Kind {
    pub fn as_str(self) -> &'static str {
        match self {
            Kind::User => "user",
            Kind::Assistant => "assistant",
            Kind::ToolCall => "tool-call",
            Kind::ToolResult => "tool-result",
            Kind::Title => "title",
        }
    }

    fn parse(kind: &str) -> Option<Kind> {
        [Kind::User, Kind::Assistant, Kind::ToolCall, Kind::ToolResult, Kind::Title].into_iter().find(|k| k.as_str() == kind)
    }

    fn cap(self) -> usize {
        match self {
            Kind::ToolCall => TOOL_CALL_BYTES,
            Kind::ToolResult => TOOL_RESULT_BYTES,
            _ => TEXT_BYTES,
        }
    }
}

/// A document id's bits `SID_SHIFT..32` hold the low bits of its session's `sid` (`sid & SID_MASK`).
pub const SID_SHIFT: u32 = 12;
pub const SID_MASK: i64 = 0xF_FFFF;
const LOW_IDS: i64 = 1 << SID_SHIFT;

/// A document id: the Unix second of `at`, then the low 20 bits of `sid`, then 12 bits of `seq` and `part`.
fn doc_id(at: i64, sid: i64, seq: i64, part: i64) -> i64 {
    let secs = at.div_euclid(1000).clamp(0, i32::MAX as i64);
    secs << 32 | (sid & SID_MASK) << SID_SHIFT | ((seq * 8 + part) & 0xFFF)
}

/// Scrubs the whole source before capping it, so a credential straddling the cut is still recognised.
fn indexed_text(text: &str, kind: Kind) -> Option<String> {
    let scrubbed = scrub_text(text);
    capped_text(&scrubbed, kind)
}

fn capped_text(text: &str, kind: Kind) -> Option<String> {
    let text = cut_bytes(text, kind.cap());
    (!text.trim().is_empty()).then(|| text.replace([MARK_START, MARK_END], " "))
}

/// Indexes `text`, scrubbed, as part `part` of the entry at `seq`. Empty text is skipped. `text` comes whole, never
/// cut: a session's title document is its `session_info` name, not the title derive cuts from the first prompt.
pub fn index(tx: &Transaction, sid: i64, seq: i64, part: i64, at: i64, kind: Kind, text: &str) -> Result<()> {
    let Some(text) = indexed_text(text, kind) else { return Ok(()) };
    insert_text(tx, sid, seq, part, at, kind, &text)
}

/// Only capped search output survives preparation. Empty calls retain their original part numbers.
struct AssistantText {
    text: Option<String>,
    calls: Vec<Option<String>>,
}

/// Discover across one assistant entry before replacing or capping any document. Copy only searchable text,
/// names and arguments, not image blocks or call metadata. A later call can explain an earlier bare echo,
/// even when its secret field lies beyond the index cap or only one sibling is requested by a rewrite batch.
/// A memory tool call is never indexed, like an empty one, and its arguments take no part in discovery.
fn assistant_text(content: Option<&Value>) -> AssistantText {
    let mut text = content_text(content);
    let blocks = content.and_then(Value::as_array).map(Vec::as_slice).unwrap_or_default();
    let mut calls: Vec<_> = blocks.iter().filter(|b| str_field(b, "type") == Some("toolCall"))
        .map(|block| {
            let name = str_field(block, "name").unwrap_or("");
            (!memory::is_tool(name)).then(|| (name.to_owned(), block.get("arguments").cloned().unwrap_or(Value::Null)))
        })
        .collect();
    let mut scope = Scope::new();
    scope.text(&mut text);
    for (name, arguments) in calls.iter_mut().flatten() {
        scope.text(name);
        scope.content(arguments);
    }
    scope.finish();
    AssistantText {
        text: capped_text(&text, Kind::Assistant),
        calls: calls.into_iter().map(|call| {
            let (mut name, arguments) = call?;
            match arguments {
                Value::Object(args) => {
                    for (key, value) in args {
                        name.push('\n');
                        name.push_str(&key);
                        name.push_str(": ");
                        match value {
                            Value::String(s) => name.push_str(&s),
                            other => name.push_str(&other.to_string()),
                        }
                    }
                }
                Value::Null => {}
                other => {
                    name.push('\n');
                    name.push_str(&other.to_string());
                }
            }
            capped_text(&name, Kind::ToolCall)
        }).collect(),
    }
}

/// Preparation already scrubbed every string once; insert its capped documents without rescanning them.
pub(super) fn index_assistant(tx: &Transaction, sid: i64, seq: i64, at: i64, content: Option<&Value>) -> Result<()> {
    let prepared = assistant_text(content);
    if let Some(text) = prepared.text {
        insert_text(tx, sid, seq, 0, at, Kind::Assistant, &text)?;
    }
    for (part, text) in prepared.calls.into_iter().enumerate() {
        if let Some(text) = text {
            insert_text(tx, sid, seq, part as i64 + 1, at, Kind::ToolCall, &text)?;
        }
    }
    Ok(())
}

fn insert_text(tx: &Transaction, sid: i64, seq: i64, part: i64, at: i64, kind: Kind, text: &str) -> Result<()> {
    let mut id = doc_id(at, sid, seq, part);
    let mut insert =
        tx.prepare_cached("INSERT OR IGNORE INTO search_docs (id, sid, seq, kind, at, text) VALUES (?1, ?2, ?3, ?4, ?5, ?6)")?;
    // Ids collide only for sids 2^20 apart or many parts in one second. The next free id within the same second and
    // sid bits keeps the order and the sid bits, which searches filter on; once a second's 4,096 ids are taken, probing
    // moves to the next second with the same sid bits (wrapping to second 0 past the last one).
    let mut tries = 0;
    while insert.execute(params![id, sid, seq, kind.as_str(), at, text])? == 0 {
        tries += 1;
        id = if tries % LOW_IDS != 0 {
            id & !(LOW_IDS - 1) | id.wrapping_add(1) & (LOW_IDS - 1)
        } else {
            id.wrapping_add(1 << 32) & i64::MAX
        };
    }
    tx.prepare_cached("INSERT INTO search_fts (rowid, text) VALUES (?1, ?2)")?.execute(params![id, text])?;
    Ok(())
}

/// A row's position along the insertion probe, including low-bit and second wraparound. After each full second
/// of collisions, `index` advances the second while retaining the previous probe's low bits.
fn probe_distance(start: i64, id: i64) -> i64 {
    let seconds = ((id >> 32) - (start >> 32)) & i32::MAX as i64;
    seconds * LOW_IDS + (((id & (LOW_IDS - 1)) - (start & (LOW_IDS - 1)) + seconds) & (LOW_IDS - 1))
}

/// Only the 4,096 possible ids in one second/sid block are read. Unrelated sessions and seconds never
/// enlarge this lookup, even though schema 6 has no index on search_docs(sid, seq).
pub(crate) const PROBE_BLOCK_SQL: &str =
    "SELECT id, sid, seq, kind, at FROM search_docs WHERE id >= ?1 AND id <= ?2 ORDER BY id";

type ProbeRow = (i64, i64, i64, String, i64);
type SearchDoc = (i64, i64, i64, i64, String, String);

#[derive(Default)]
struct Sources {
    blocks: HashMap<i64, Vec<ProbeRow>>,
    #[cfg(test)]
    entries_read: usize,
    #[cfg(test)]
    calls_extracted: usize,
}

impl Sources {
    /// Follow the actual insertion probe, stopping at the first unassigned row belonging to this entry.
    /// A hole means source identity cannot be proved. The target bounds the walk, including second wraparound.
    fn call_row(&mut self, tx: &Transaction, start: i64, target: i64, sid: i64, seq: i64, at: i64,
        assigned: &HashSet<i64>) -> Option<i64> {
        for distance in 0..=probe_distance(start, target) {
            let seconds = distance / LOW_IDS;
            let second = ((start >> 32) + seconds) & i32::MAX as i64;
            let low = ((start & (LOW_IDS - 1)) + distance % LOW_IDS - seconds) & (LOW_IDS - 1);
            let id = second << 32 | (sid & SID_MASK) << SID_SHIFT | low;
            let base = id & !(LOW_IDS - 1);
            if let std::collections::hash_map::Entry::Vacant(entry) = self.blocks.entry(base) {
                let rows = tx.prepare_cached(PROBE_BLOCK_SQL).ok()?
                    .query_map(params![base, base | (LOW_IDS - 1)], |r| {
                        Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
                    }).ok()?.collect::<rusqlite::Result<Vec<ProbeRow>>>().ok()?;
                entry.insert(rows);
            }
            let rows = self.blocks.get(&base)?;
            let row = &rows[rows.binary_search_by_key(&id, |r| r.0).ok()?];
            if row.1 == sid && row.2 == seq && row.3 == "tool-call" && row.4 == at && !assigned.contains(&id) {
                return Some(id);
            }
        }
        None
    }

    /// Rebuild each entry once per batch, retaining only capped text for the requested documents. In particular,
    /// image payloads and uncapped arguments are dropped before reading the next source. Resolve call identities
    /// in one pass so a later call never causes preceding arguments to be cloned and scrubbed again.
    fn indexed(&mut self, tx: &Transaction, blobs: &BlobStore, docs: &[SearchDoc]) -> HashMap<i64, String> {
        let mut entries: HashMap<(i64, i64, i64), Vec<&SearchDoc>> = HashMap::new();
        for doc in docs {
            entries.entry((doc.1, doc.2, doc.3)).or_default().push(doc);
        }
        let mut texts = HashMap::new();
        for ((sid, seq, at), docs) in entries {
            self.entry(tx, blobs, sid, seq, at, &docs, &mut texts);
        }
        texts
    }

    fn entry(&mut self, tx: &Transaction, blobs: &BlobStore, sid: i64, seq: i64, at: i64,
        docs: &[&SearchDoc], texts: &mut HashMap<i64, String>) -> Option<()> {
        #[cfg(test)]
        { self.entries_read += 1; }
        let value = {
            let line = crate::read::entries::raw_by_sid(tx, blobs, sid, seq).ok()?;
            parse_json_lenient(&line).ok()?
        };
        // A mismatched source is no evidence for replacing a document (for example a repaired/imported index).
        if time_field(&value, "timestamp").is_some_and(|timestamp| timestamp != at) {
            return None;
        }
        let assistant = value.get("message")
            .filter(|message| str_field(&value, "type") == Some("message") && str_field(message, "role") == Some("assistant"))
            .map(|message| assistant_text(message.get("content")));
        #[cfg(test)]
        { self.calls_extracted += assistant.as_ref().map_or(0, |prepared| prepared.calls.len()); }
        let mut calls = HashSet::new();
        for doc in docs {
            let Some(kind) = Kind::parse(&doc.4) else { continue };
            if kind == Kind::Title {
                if str_field(&value, "type") == Some("session_info") {
                    if let Some(text) = str_field(&value, "name").and_then(|name| indexed_text(name, kind)) {
                        texts.insert(doc.0, text);
                    }
                }
                continue;
            }
            if str_field(&value, "type") != Some("message") { continue; }
            let Some(message) = value.get("message") else { continue };
            let role = match kind {
                Kind::User => "user",
                Kind::Assistant | Kind::ToolCall => "assistant",
                Kind::ToolResult => "toolResult",
                Kind::Title => unreachable!(),
            };
            if str_field(message, "role") != Some(role) { continue; }
            if kind == Kind::ToolCall {
                if (doc.0 >> SID_SHIFT) & SID_MASK == sid & SID_MASK {
                    calls.insert(doc.0);
                }
            } else if kind == Kind::Assistant {
                if let Some(text) = assistant.as_ref().and_then(|prepared| prepared.text.as_ref()) {
                    texts.insert(doc.0, text.clone());
                }
            } else if let Some(text) = indexed_text(&content_text(message.get("content")), kind) {
                texts.insert(doc.0, text);
            }
        }
        if calls.is_empty() { return Some(()); }
        let mut assigned = HashSet::new();
        for (part, text) in assistant?.calls.into_iter().enumerate() {
            let Some(text) = text else { continue };
            // Empty calls consume a part number but never create a row. Text, including a shared capped prefix,
            // is deliberately not used as identity. The farthest requested row bounds this insertion probe even
            // when ids wrap within a second or from the last second back to zero.
            let start = doc_id(at, sid, seq, part as i64 + 1);
            let target = *calls.iter().max_by_key(|id| probe_distance(start, **id))?;
            let row = self.call_row(tx, start, target, sid, seq, at, &assigned)?;
            assigned.insert(row);
            if calls.remove(&row) {
                texts.insert(row, text);
                if calls.is_empty() { break; }
            }
        }
        Some(())
    }
}

/// Scrubs up to `limit` documents after `after`, returning the last id and number read. Capped text is rebuilt from
/// its source with the same scrub-whole-then-cut step as indexing. Thus documents indexed during the rewrite stay
/// byte-identical even when their entry dates put their ids ahead of the cursor. Unavailable sources fall back to
/// scrubbing the cut text; ordinary text is kept, and a non-empty document is never replaced with empty text.
pub fn rescrub(tx: &Transaction, blobs: &BlobStore, after: i64, limit: i64) -> Result<Option<(i64, usize)>> {
    let docs: Vec<SearchDoc> = tx
        .prepare_cached("SELECT id, sid, seq, at, kind, text FROM search_docs WHERE id > ?1 ORDER BY id LIMIT ?2")?
        .query_map(params![after, limit], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)))?
        .collect::<rusqlite::Result<_>>()?;
    let mut texts = Sources::default().indexed(tx, blobs, &docs);
    for (id, _, _, _, kind, text) in &docs {
        let kind = Kind::parse(kind);
        let scrubbed = texts.remove(id)
            .unwrap_or_else(|| {
                // `cut_bytes` leaves cut text at most three bytes short of the cap.
                if text.len() + 3 >= kind.map_or(TEXT_BYTES, Kind::cap) {
                    scrub_cut_text(text).into_owned()
                } else {
                    scrub_text(text).into_owned()
                }
            });
        if scrubbed == text.as_str() {
            continue;
        }
        // External content: the index forgets a row only when given the text it indexed.
        tx.prepare_cached("INSERT INTO search_fts (search_fts, rowid, text) VALUES ('delete', ?1, ?2)")?
            .execute(params![id, text])?;
        tx.prepare_cached("UPDATE search_docs SET text = ?2 WHERE id = ?1")?.execute(params![id, scrubbed])?;
        tx.prepare_cached("INSERT INTO search_fts (rowid, text) VALUES (?1, ?2)")?.execute(params![id, scrubbed])?;
    }
    Ok(docs.last().map(|(id, ..)| (*id, docs.len())))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Install a verbatim blob-backed entry, as ingestion does for large lines. Keep only its derived index rows
    /// in memory in the caller, so the rewrite exercises source reconstruction rather than a fixture's Value cache.
    fn source(tx: &Transaction, blobs: &BlobStore, sid: i64, seq: i64, value: serde_json::Value) {
        let line = value.to_string();
        let hash = crate::util::sha256_hex(line.as_bytes());
        blobs.put(&hash, line.as_bytes()).unwrap();
        tx.execute("INSERT INTO entries (sid, seq, offset, type) VALUES (?1, ?2, ?2, 'message')", params![sid, seq]).unwrap();
        tx.execute("INSERT INTO lines (stream_id, offset, blob) VALUES (?1, ?2, ?3)", params![sid, seq, hash]).unwrap();
    }

    fn documents(tx: &Transaction) -> Vec<SearchDoc> {
        tx.prepare("SELECT id, sid, seq, at, kind, text FROM search_docs ORDER BY id").unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?))).unwrap()
            .collect::<rusqlite::Result<_>>().unwrap()
    }

    #[test]
    fn rewrite_extracts_each_call_once_per_entry_in_a_batch() {
        for count in [16, 64, 256] {
            let dir = tempfile::tempdir().unwrap();
            let store = crate::store::Store::open(dir.path()).unwrap();
            store.write(|tx| {
                let mut blocks: Vec<_> = (0..count).map(|i| json!({
                    "type": "toolCall", "name": format!("fake-call-{i} FAKElettersOnly"),
                    "arguments": { "echo": "FAKElettersOnly", "ordinary": "neighbor ".repeat(12_800) },
                })).collect();
                blocks.last_mut().unwrap()["arguments"]["client_secret"] = json!("FAKElettersOnly");
                blocks.insert(0, json!({ "type": "text", "text": "assistant neighbor FAKElettersOnly" }));
                blocks.push(json!({ "type": "image", "data": "FAKE".repeat(64 * 1024), "mimeType": "image/png" }));
                let content = Value::Array(blocks);
                index_assistant(tx, 7, 1, 5_000, Some(&content))?;
                source(tx, &store.blobs, 7, 1, json!({ "type": "message", "timestamp": 5_000,
                    "message": { "role": "assistant", "content": content } }));
                let docs = documents(tx);
                let mut sources = Sources::default();
                let texts = sources.indexed(tx, &store.blobs, &docs);
                assert_eq!(sources.entries_read, 1, "read and parse each source only once");
                assert_eq!(sources.calls_extracted, count, "discovery work must grow linearly with call count");
                assert_eq!(texts.len(), count + 1);
                for doc in &docs {
                    assert_eq!(texts[&doc.0], doc.5);
                    assert!(!doc.5.contains("FAKElettersOnly"));
                }
                // AC-3/4: requesting only the assistant or first call still discovers the last call's field.
                for requested in [&docs[..1], &docs[1..2]] {
                    let mut sources = Sources::default();
                    let texts = sources.indexed(tx, &store.blobs, requested);
                    assert_eq!(sources.entries_read, 1);
                    assert_eq!(sources.calls_extracted, count);
                    assert_eq!(texts.len(), 1);
                    assert_eq!(texts[&requested[0].0], requested[0].5);
                }
                Ok::<_, anyhow::Error>(())
            }).unwrap();
        }
    }

    #[test]
    fn rewrite_retains_only_searchable_text_from_image_heavy_sources() {
        let dir = tempfile::tempdir().unwrap();
        let store = crate::store::Store::open(dir.path()).unwrap();
        store.write(|tx| {
            for seq in 0..256 {
                let text = format!("fake screenshot {seq} neighbor");
                let content = json!([
                    { "type": "text", "text": text },
                    { "type": "image", "mimeType": "image/png", "data": "FAKE".repeat(64 * 1024) },
                ]);
                let role = if seq % 2 == 0 {
                    index_assistant(tx, 7, seq, 5_000, Some(&content))?;
                    "assistant"
                } else {
                    index(tx, 7, seq, 0, 5_000, Kind::ToolResult, &text)?;
                    "toolResult"
                };
                source(tx, &store.blobs, 7, seq, json!({ "type": "message", "timestamp": 5_000,
                    "message": { "role": role, "content": content } }));
            }
            let docs = documents(tx);
            let mut sources = Sources::default();
            let texts = sources.indexed(tx, &store.blobs, &docs);
            assert_eq!(sources.entries_read, 256);
            assert_eq!(sources.calls_extracted, 0);
            assert!(sources.blocks.is_empty());
            // The batch retains only these capped strings, not 64 MiB of parsed image payloads. Sources holds
            // identity blocks only; each parsed entry goes out of scope before the next source is read.
            assert_eq!(texts.len(), 256);
            assert!(texts.values().map(String::len).sum::<usize>() < 16 * 1024);
            for doc in &docs { assert_eq!(texts[&doc.0], doc.5); }
            assert_eq!(rescrub(tx, &store.blobs, i64::MIN, 256)?.unwrap().1, 256);
            assert_eq!(documents(tx), docs);
            Ok::<_, anyhow::Error>(())
        }).unwrap();
    }

    #[test]
    fn assistant_discovery_is_local_to_searchable_content_in_one_entry() {
        let first = json!([
            { "type": "text", "text": "neighbor FAKEinsideOnly" },
            { "type": "toolCall", "name": "configure", "arguments": { "client_secret": "FAKEinsideOnly" } },
        ]);
        assert_eq!(assistant_text(Some(&first)).text.as_deref(), Some("neighbor [REDACTED:SECRET]"));
        let second = json!([
            { "type": "text", "text": "neighbor FAKEinsideOnly FAKEoutsideOnly" },
            { "type": "image", "mimeType": "image/png", "data": "DB_PASSWORD=FAKEoutsideOnly" },
            { "type": "toolCall", "id": "DB_PASSWORD=FAKEoutsideOnly", "name": "configure", "arguments": {} },
        ]);
        assert_eq!(assistant_text(Some(&second)).text.as_deref(), Some("neighbor FAKEinsideOnly FAKEoutsideOnly"));
    }

    #[test]
    fn ids_order_by_second_then_session_then_seq() {
        assert!(doc_id(2_000, 1, 0, 0) > doc_id(1_999, 9, 500, 3));
        assert!(doc_id(1_000, 2, 0, 0) > doc_id(1_500, 1, 9, 0));
        assert!(doc_id(1_000, 1, 3, 0) > doc_id(1_000, 1, 2, 7));
        assert_eq!(doc_id(-5, 1, 0, 0), 1 << 12);
    }

    /// A colliding id at the top of the low bits wraps within them instead of carrying into the sid bits.
    #[test]
    fn colliding_ids_keep_their_sid_bits() {
        let dir = tempfile::tempdir().unwrap();
        let store = crate::store::Store::open(dir.path()).unwrap();
        let sid = 7;
        store
            .write(|tx| {
                for _ in 0..3 {
                    index(tx, sid, 511, 7, 5_000, Kind::Assistant, "same second")?;
                }
                Ok::<_, anyhow::Error>(())
            })
            .unwrap();
        let ids: Vec<i64> = store
            .read(|conn| conn.prepare("SELECT id FROM search_docs ORDER BY id")?.query_map([], |r| r.get(0))?.collect())
            .unwrap();
        assert_eq!(ids, [doc_id(5_000, sid, 512, 0), doc_id(5_000, sid, 512, 1), doc_id(5_000, sid, 511, 7)]);
        assert!(ids.iter().all(|id| (id >> SID_SHIFT) & SID_MASK == sid), "{ids:?}");
    }

    /// Once one second's 4,096 ids are taken, further documents go to the next second, still with their sid bits.
    #[test]
    fn a_full_second_moves_on_without_changing_the_sid_bits() {
        let dir = tempfile::tempdir().unwrap();
        let store = crate::store::Store::open(dir.path()).unwrap();
        let sid = 7;
        store
            .write(|tx| {
                for seq in 0..4_200 {
                    index(tx, sid, seq, 0, 5_000, Kind::User, "same second")?;
                }
                Ok::<_, anyhow::Error>(())
            })
            .unwrap();
        let ids: Vec<i64> = store
            .read(|conn| conn.prepare("SELECT id FROM search_docs ORDER BY id")?.query_map([], |r| r.get(0))?.collect())
            .unwrap();
        assert_eq!(ids.len(), 4_200);
        assert!(ids.iter().all(|id| (id >> SID_SHIFT) & SID_MASK == sid), "sid bits");
        assert_eq!(ids.iter().filter(|id| *id >> 32 == 5).count(), 4_096);
        assert_eq!(ids.iter().filter(|id| *id >> 32 == 6).count(), 104);
    }

    /// Probing past the last second, which every later time is clamped to, wraps to second 0 instead of overflowing.
    #[test]
    fn the_last_second_wraps_to_the_first() {
        let dir = tempfile::tempdir().unwrap();
        let store = crate::store::Store::open(dir.path()).unwrap();
        store
            .write(|tx| {
                for seq in 0..4_097 {
                    index(tx, SID_MASK, seq, 0, i64::MAX, Kind::User, "last second")?;
                }
                Ok::<_, anyhow::Error>(())
            })
            .unwrap();
        let ids: Vec<i64> = store
            .read(|conn| conn.prepare("SELECT id FROM search_docs ORDER BY id")?.query_map([], |r| r.get(0))?.collect())
            .unwrap();
        assert_eq!((ids[0] >> 32, (ids[0] >> SID_SHIFT) & SID_MASK), (0, SID_MASK));
        assert_eq!(ids[1..].iter().filter(|id| *id >> 32 == i32::MAX as i64).count(), 4_096);
        assert_eq!(ids.last(), Some(&i64::MAX));
    }
}
