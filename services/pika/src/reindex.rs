use anyhow::{Result, anyhow};
use rusqlite::params;

use crate::derive::{self, Line, StreamInfo, StreamKind};
use crate::store::{DERIVED_TABLES, Store};

const CHUNK_LINES: i64 = 2_000;

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
