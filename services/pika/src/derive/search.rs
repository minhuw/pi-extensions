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

/// A document id: the Unix second of `at`, then the low 20 bits of `sid`, then 12 bits of `seq` and `part`.
fn doc_id(at: i64, sid: i64, seq: i64, part: i64) -> i64 {
    let secs = at.div_euclid(1000).clamp(0, i32::MAX as i64);
    secs << 32 | (sid & 0xF_FFFF) << 12 | ((seq * 8 + part) & 0xFFF)
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
    // Ids collide only for sids 2^20 apart or many parts in one second; the next free id keeps the order.
    while insert.execute(params![id, sid, seq, kind.as_str(), at, text])? == 0 {
        id += 1;
    }
    tx.prepare_cached("INSERT INTO search_fts (rowid, text) VALUES (?1, ?2)")?.execute(params![id, text])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::doc_id;

    #[test]
    fn ids_order_by_second_then_session_then_seq() {
        assert!(doc_id(2_000, 1, 0, 0) > doc_id(1_999, 9, 500, 3));
        assert!(doc_id(1_000, 2, 0, 0) > doc_id(1_500, 1, 9, 0));
        assert!(doc_id(1_000, 1, 3, 0) > doc_id(1_000, 1, 2, 7));
        assert_eq!(doc_id(-5, 1, 0, 0), 1 << 12);
    }
}
