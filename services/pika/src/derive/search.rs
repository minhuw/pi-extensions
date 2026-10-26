//! The full-text index over session entries: `search_docs` holds capped text and `search_fts` indexes it.

use anyhow::Result;
use rusqlite::{Transaction, params};

use crate::util::cut_bytes;

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

/// Indexes `text` as part `part` of the entry at `seq`. Empty text is skipped.
pub fn index(tx: &Transaction, sid: i64, seq: i64, part: i64, at: i64, kind: Kind, text: &str) -> Result<()> {
    let text = cut_bytes(text, kind.cap());
    if text.trim().is_empty() {
        return Ok(());
    }
    let text = text.replace([MARK_START, MARK_END], " ");
    let mut id = doc_id(at, sid, seq, part);
    let mut insert =
        tx.prepare_cached("INSERT OR IGNORE INTO search_docs (id, sid, seq, kind, at, text) VALUES (?1, ?2, ?3, ?4, ?5, ?6)")?;
    // Ids collide only for sids 2^20 apart or many parts in one second. The next free id within the same second and
    // sid bits keeps the order and the sid bits, which searches filter on; only a full second of 4,096 ids moves on.
    let mut tries = 0;
    while insert.execute(params![id, sid, seq, kind.as_str(), at, text])? == 0 {
        tries += 1;
        id = if tries < LOW_IDS { id & !(LOW_IDS - 1) | (id + 1) & (LOW_IDS - 1) } else { id + 1 };
    }
    tx.prepare_cached("INSERT INTO search_fts (rowid, text) VALUES (?1, ?2)")?.execute(params![id, text])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
