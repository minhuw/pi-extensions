use std::io::Write;

use anyhow::Result;
use rusqlite::{Connection, OptionalExtension, params};

use crate::store::Store;

const CHUNK_LINES: i64 = 1_000;

pub fn session_stream(conn: &Connection, session_id: &str) -> rusqlite::Result<Option<i64>> {
    conn.prepare_cached("SELECT id FROM streams WHERE key = ?1 AND kind = 'session'")?
        .query_row([format!("session:{session_id}")], |r| r.get(0))
        .optional()
}

/// Reads up to `CHUNK_LINES` lines at or after `from`, each followed by `\n`. Returns the bytes and the next offset,
/// or `None` when the stream has no more lines.
pub fn read_chunk(store: &Store, stream_id: i64, from: i64) -> Result<(Vec<u8>, Option<i64>)> {
    let rows: Vec<(i64, Option<String>, Option<String>)> = store.read(|conn| {
        conn.prepare_cached("SELECT offset, data, blob FROM lines WHERE stream_id = ?1 AND offset >= ?2 ORDER BY offset LIMIT ?3")?
            .query_map(params![stream_id, from, CHUNK_LINES], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()
    })?;
    let mut out = Vec::new();
    let mut next = None;
    for (offset, data, blob) in rows {
        let start = out.len();
        match (data, blob) {
            (Some(data), _) => out.extend_from_slice(data.as_bytes()),
            (None, Some(hash)) => out.extend_from_slice(&store.blobs.get(&hash)?),
            (None, None) => {}
        }
        out.push(b'\n');
        next = Some(offset + (out.len() - start) as i64);
    }
    Ok((out, next))
}

/// Writes the session's verbatim JSONL. Returns false when the session is unknown.
pub fn write_session(store: &Store, session_id: &str, out: &mut impl Write) -> Result<bool> {
    let Some(stream_id) = store.read(|conn| session_stream(conn, session_id))? else { return Ok(false) };
    let mut from = 0;
    loop {
        let (bytes, next) = read_chunk(store, stream_id, from)?;
        out.write_all(&bytes)?;
        match next {
            Some(next) => from = next,
            None => break,
        }
    }
    out.flush()?;
    Ok(true)
}
