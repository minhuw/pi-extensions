//! Read-time projection of Spokesman's custom records; existing derived state stays untouched.
use std::collections::{HashMap, HashSet};

use rusqlite::Connection;
use serde::Serialize;

use super::{ReadResult, line_text, sessions::Turn};
use crate::{
    blobs::BlobStore,
    util::{bare_model, parse_json_lenient},
};

const MARKER: &str = "<!-- spokesman:rewritten -->\n";

pub fn strip_marker(text: &str) -> &str {
    text.strip_prefix(MARKER).unwrap_or(text)
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpokesmanResponse {
    pub seq: i64,
    pub target_seq: i64,
    pub original_text: String,
    pub rewritten_text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub original_model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub spokesman_model: Option<String>,
}

#[derive(Default)]
pub struct Rewrites {
    pub by_target: HashMap<i64, SpokesmanResponse>,
    target_turns: HashMap<i64, i64>,
}

impl Rewrites {
    pub fn load(conn: &Connection, blobs: &BlobStore, sid: i64) -> ReadResult<Self> {
        let mut stmt = conn.prepare_cached(
            "SELECT e.seq, l.data, l.blob FROM entries e
             JOIN lines l ON l.stream_id = e.sid AND l.offset = e.offset
             WHERE e.sid = ?1 AND e.type = 'custom' AND e.custom_type = 'spokesman-rewrite' ORDER BY e.seq",
        )?;
        let mut rows = stmt.query([sid])?;
        let mut candidates = Vec::new();
        while let Some(row) = rows.next()? {
            // An unreadable or malformed enhancement must not hide the persisted answer.
            let Ok(line) = line_text(blobs, row.get(1)?, row.get(2)?) else { continue };
            let Ok(raw) = parse_json_lenient(&line) else { continue };
            if raw["type"] != "custom" || raw["customType"] != "spokesman-rewrite" {
                continue;
            }
            let data = &raw["data"];
            let Some(target) = data["targetEntryId"].as_str().filter(|s| !s.is_empty()) else { continue };
            let Some(original) = data["originalText"].as_str().filter(|s| !s.trim().is_empty()) else { continue };
            let Some(rewritten) = data["rewrittenText"].as_str().filter(|s| !s.trim().is_empty()) else { continue };
            let model =
                |key: &str| data[key].as_str().filter(|s| !s.trim().is_empty()).map(|s| bare_model(s).to_owned());
            candidates.push((
                target.to_owned(),
                SpokesmanResponse {
                    seq: row.get(0)?,
                    target_seq: 0,
                    original_text: original.to_owned(),
                    rewritten_text: rewritten.to_owned(),
                    original_model: model("originalModel"),
                    spokesman_model: model("spokesmanModel"),
                },
            ));
        }
        let mut result = Self::default();
        if candidates.is_empty() {
            return Ok(result);
        }
        // Metadata only: ordinary sessions never need additional raw assistant reads. Duplicate ids are ambiguous.
        let mut targets = HashMap::new();
        let mut stmt = conn.prepare_cached(
            "SELECT e.entry_id, e.seq, m.turn FROM entries e JOIN model_calls m ON m.sid = e.sid AND m.seq = e.seq
             WHERE e.sid = ?1 AND e.type = 'message' AND e.role = 'assistant' AND e.entry_id IS NOT NULL ORDER BY e.seq",
        )?;
        let mut rows = stmt.query([sid])?;
        while let Some(row) = rows.next()? {
            let id: String = row.get(0)?;
            let target = (row.get::<_, i64>(1)?, row.get::<_, Option<i64>>(2)?);
            targets.entry(id).and_modify(|v| *v = None).or_insert(Some(target));
        }
        for (id, mut response) in candidates {
            let Some(Some((seq, turn))) = targets.get(&id) else { continue };
            response.target_seq = *seq;
            if let Some(turn) = turn {
                result.target_turns.insert(*seq, *turn);
            }
            result.by_target.insert(*seq, response);
        }
        Ok(result)
    }

    /// Turns whose display may have changed since the last poll, including targets in older turns.
    pub fn changed_turns(&self, since: i64) -> HashSet<i64> {
        self.by_target
            .values()
            .filter(|r| r.seq > since)
            .filter_map(|r| self.target_turns.get(&r.target_seq).copied())
            .collect()
    }

    pub fn enrich(&self, conn: &Connection, blobs: &BlobStore, sid: i64, turns: &mut [Turn]) -> ReadResult<()> {
        let affected: HashSet<i64> = self.target_turns.values().copied().collect();
        for turn in turns {
            turn.final_text = strip_marker(&turn.final_text).to_owned();
            if !affected.contains(&turn.index) {
                continue;
            }
            // Derive retains the last assistant with non-whitespace text, even if later calls contain only tools/thinking.
            let mut stmt = conn.prepare_cached(
                "SELECT m.seq, l.data, l.blob FROM model_calls m
                 JOIN entries e ON e.sid = m.sid AND e.seq = m.seq
                 LEFT JOIN lines l ON l.stream_id = e.sid AND l.offset = e.offset
                 WHERE m.sid = ?1 AND m.seq >= ?2 AND m.seq <= ?3 ORDER BY m.seq DESC",
            )?;
            let mut rows = stmt.query((sid, turn.start_seq, turn.end_seq))?;
            while let Some(row) = rows.next()? {
                let Ok(line) = line_text(blobs, row.get(1)?, row.get(2)?) else { break };
                let Ok(raw) = parse_json_lenient(&line) else { break };
                let text = match &raw["message"]["content"] {
                    serde_json::Value::String(text) => text.clone(),
                    serde_json::Value::Array(blocks) => blocks
                        .iter()
                        .filter(|b| b["type"] == "text")
                        .filter_map(|b| b["text"].as_str())
                        .collect::<Vec<_>>()
                        .join("\n"),
                    _ => String::new(),
                };
                if !text.trim().is_empty() {
                    turn.spokesman = self.by_target.get(&row.get::<_, i64>(0)?).cloned();
                    break;
                }
            }
        }
        Ok(())
    }
}
