use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::Duration;

use anyhow::{Context, Result, anyhow};
use rusqlite::{OptionalExtension, Transaction, params};

use crate::derive::{self, Line, StreamInfo, StreamKind};
use crate::store::{self, DERIVED_TABLES, Store};

const CHUNK_LINES: i64 = 2_000;
/// Search documents scrubbed in one write transaction of the background rewrite: short enough that ingest waits
/// for it no longer than for a large batch of its own.
const RESCRUB_DOCS: i64 = 256;
/// The pause between the rewrite's transactions, in which ingest takes the writer.
const RESCRUB_PAUSE: Duration = Duration::from_millis(5);

#[derive(Debug, Default, PartialEq, Eq)]
pub struct ReindexStats {
    pub streams: u64,
    pub lines: u64,
}

/// Rebuilds every derived table from the verbatim lines in one transaction, streaming each stream in chunks.
pub fn reindex(store: &Store) -> Result<ReindexStats> {
    store.write(|tx| {
        for table in DERIVED_TABLES {
            tx.execute(&format!("DELETE FROM {table}"), [])?;
        }
        store::clear_search_index(tx)?;
        // Every document is indexed again below, scrubbed.
        store::set_search_rules_current(tx)?;
        tx.execute("DELETE FROM settings WHERE key = ?1", [store::NEEDS_REINDEX])?;
        tx.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES (?1, ?2)",
            params![store::DERIVED_GENERATION, crate::util::random_bytes::<8>()],
        )?;
        let streams: Vec<(i64, String, String, String)> = tx
            .prepare("SELECT id, key, kind, device FROM streams ORDER BY id")?
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?
            .collect::<rusqlite::Result<_>>()?;
        let mut stats = ReindexStats::default();
        for (id, key, kind, device) in streams {
            let kind = StreamKind::parse(&kind).ok_or_else(|| anyhow!("stream {key} has unknown kind {kind}"))?;
            let name = key.strip_prefix(kind.key_prefix()).unwrap_or(&key).to_owned();
            let info = StreamInfo { id, kind, name, device };
            derive::create_stream(tx, &info)?;
            stats.streams += 1;
            let mut seq = 0i64;
            let mut after = -1i64;
            loop {
                let chunk: Vec<(i64, Option<String>, Option<String>)> = tx
                    .prepare_cached(
                        "SELECT offset, data, blob FROM lines WHERE stream_id = ?1 AND offset > ?2 ORDER BY offset LIMIT ?3",
                    )?
                    .query_map(params![id, after, CHUNK_LINES], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
                    .collect::<rusqlite::Result<_>>()?;
                let Some(last) = chunk.last() else { break };
                after = last.0;
                let mut texts = Vec::with_capacity(chunk.len());
                for (offset, data, blob) in chunk {
                    let text = match (data, blob) {
                        (Some(data), _) => data,
                        (None, Some(hash)) => store.blobs.get_string(&hash)?,
                        (None, None) => String::new(),
                    };
                    texts.push((offset, text));
                }
                let lines: Vec<Line> = texts
                    .iter()
                    .map(|(offset, text)| {
                        seq += 1;
                        Line { seq: seq - 1, offset: *offset, text }
                    })
                    .collect();
                stats.lines += lines.len() as u64;
                derive::apply_lines(tx, &info, &lines)?;
            }
        }
        Ok(stats)
    })
}

/// A cursor is valid only for the rules it was written under. Legacy, damaged, or older-rule progress restarts
/// at the beginning so an interrupted upgrade cannot skip documents scrubbed under an earlier target.
#[derive(serde::Serialize, serde::Deserialize)]
struct RescrubPosition {
    target: u32,
    after: i64,
}

fn rescrub_position(tx: &Transaction) -> Result<i64> {
    let value: Option<rusqlite::types::Value> = tx
        .query_row("SELECT value FROM settings WHERE key = ?1", [store::RESCRUB_AFTER], |r| r.get(0))
        .optional()?;
    let value = match value {
        Some(rusqlite::types::Value::Blob(value)) => String::from_utf8(value).ok(),
        _ => None,
    };
    Ok(value.and_then(|v| serde_json::from_str::<RescrubPosition>(&v).ok())
        .filter(|position| position.target == crate::redact::RULES_VERSION)
        .map_or(i64::MIN, |position| position.after))
}

fn set_rescrub_position(tx: &Transaction, after: i64) -> Result<()> {
    tx.execute(
        "INSERT OR REPLACE INTO settings (key, value) VALUES (?1, ?2)",
        params![store::RESCRUB_AFTER, serde_json::to_vec(&RescrubPosition { target: crate::redact::RULES_VERSION, after })?],
    )?;
    Ok(())
}

/// Scrubs the search index's text under the current rules, `RESCRUB_DOCS` documents per write transaction, in id
/// order from where an earlier run stopped, then records the rules as current. Documents indexed meanwhile are
/// scrubbed already, including any with ids behind the cursor.
/// Returns how many documents were read; none when the index is current.
pub fn rescrub_search(store: &Store) -> Result<u64> {
    let mut read = 0;
    loop {
        // The number of documents read, and whether there may be more.
        let (count, more) = store.write(|tx| {
            // A `pika reindex` in between has indexed everything scrubbed.
            if store::search_rules_current(tx)? {
                return Ok::<_, anyhow::Error>((0, false));
            }
            let after = rescrub_position(tx)?;
            match derive::search::rescrub(tx, &store.blobs, after, RESCRUB_DOCS)? {
                Some((last, count)) if count as i64 == RESCRUB_DOCS => {
                    set_rescrub_position(tx, last)?;
                    Ok((count, true))
                }
                found => {
                    store::set_search_rules_current(tx)?;
                    Ok((found.map_or(0, |(_, count)| count), false))
                }
            }
        })?;
        read += count as u64;
        if !more {
            return Ok(read);
        }
        std::thread::sleep(RESCRUB_PAUSE);
    }
}

/// Starts [`rescrub_search`] on a thread of its own when the search index's text is not current, so `serve`
/// answers at once, health included; public search finds nothing until it is done. A restart resumes it.
pub fn rescrub_in_background(store: &Arc<Store>) -> Result<Option<JoinHandle<()>>> {
    if store.read(|conn| store::search_rules_current(conn))? {
        return Ok(None);
    }
    let store = store.clone();
    let thread = std::thread::Builder::new().name("pika-rescrub".into()).spawn(move || {
        tracing::info!("search: scrubbing the indexed text in the background; public search is off until it is done");
        match rescrub_search(&store) {
            Ok(read) => tracing::info!("search: scrubbed the indexed text ({read} documents); public search is on"),
            Err(e) => tracing::error!("search: scrubbing the indexed text failed; the next start resumes it: {e:#}"),
        }
    });
    Ok(Some(thread.context("starting the search rewrite")?))
}
