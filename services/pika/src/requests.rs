//! Model request blocks. Clients split a payload into a skeleton plus content-addressed blocks (spec "Request
//! blocks"). The server numbers each session's distinct block hashes in `request_dict` and stores the skeleton with
//! those numbers: a ref becomes `{"$pika": n}` and an array made only of refs becomes `{"$pika_runs": [[start, len],
//! ...]}`. A context that grows by a few messages per request then costs a few bytes of skeleton per request.

use std::collections::BTreeMap;

use anyhow::{Context, Result, anyhow, bail};
use rusqlite::{Connection, OptionalExtension, Transaction, params};
use serde_json::{Map, Value, json};

use crate::blobs::BlobStore;
use crate::util::{is_hash, sha256_hex};

const STRING_THRESHOLD: usize = 2048;

/// A spec-format ref: `{"$pika": h}` or `{"$pika": h, "$type": "string"}`.
fn as_ref(v: &Value) -> Option<(&Value, bool)> {
    let obj = v.as_object()?;
    let target = obj.get("$pika")?;
    match obj.len() {
        1 => Some((target, false)),
        2 if obj.get("$type").and_then(Value::as_str) == Some("string") => Some((target, true)),
        _ => None,
    }
}

/// Splits a payload by the spec's rules. Returns the skeleton and the blocks as `(hash, text)` in order of first
/// appearance, without duplicates.
pub fn split(payload: &Value) -> (Value, Vec<(String, String)>) {
    let mut blocks: Vec<(String, String)> = Vec::new();
    let mut emit = |text: String| -> String {
        let hash = sha256_hex(text.as_bytes());
        if !blocks.iter().any(|(h, _)| *h == hash) {
            blocks.push((hash.clone(), text));
        }
        hash
    };
    let Value::Object(obj) = payload else { return (payload.clone(), Vec::new()) };
    let mut skeleton = Map::new();
    for (key, value) in obj {
        let replaced = match value {
            Value::Array(items) => {
                Value::Array(items.iter().map(|item| json!({ "$pika": emit(item.to_string()) })).collect())
            }
            Value::String(s) if s.encode_utf16().count() > STRING_THRESHOLD => {
                json!({ "$pika": emit(s.clone()), "$type": "string" })
            }
            other => other.clone(),
        };
        skeleton.insert(key.clone(), replaced);
    }
    (Value::Object(skeleton), blocks)
}

/// Replaces every spec-format ref in `skeleton` with its block.
pub fn reconstruct(skeleton: &Value, block: &mut impl FnMut(&str) -> Result<String>) -> Result<Value> {
    if let Some((target, is_string)) = as_ref(skeleton) {
        let hash = target.as_str().ok_or_else(|| anyhow!("ref is not a hash"))?;
        let text = block(hash)?;
        return Ok(if is_string { Value::String(text) } else { serde_json::from_str(&text)? });
    }
    Ok(match skeleton {
        Value::Array(items) => Value::Array(items.iter().map(|i| reconstruct(i, block)).collect::<Result<_>>()?),
        Value::Object(obj) => Value::Object(
            obj.iter()
                .map(|(k, v)| Ok((k.clone(), reconstruct(v, block)?)))
                .collect::<Result<_>>()?,
        ),
        other => other.clone(),
    })
}

/// Rewrites spec-format refs to dictionary numbers. `number` maps a hash to its number in the session dictionary.
pub fn compact(skeleton: &Value, number: &mut impl FnMut(&str) -> Result<i64>) -> Result<Value> {
    let mut hash_of = |target: &Value| -> Result<i64> {
        match target.as_str() {
            Some(hash) if is_hash(hash) => number(hash),
            _ => bail!("invalid block ref {target}"),
        }
    };
    compact_with(skeleton, &mut hash_of)
}

fn compact_with(v: &Value, number: &mut impl FnMut(&Value) -> Result<i64>) -> Result<Value> {
    if let Some((target, is_string)) = as_ref(v) {
        let n = number(target)?;
        return Ok(if is_string { json!({ "$pika": n, "$type": "string" }) } else { json!({ "$pika": n }) });
    }
    Ok(match v {
        Value::Array(items) if !items.is_empty() && items.iter().all(|i| matches!(as_ref(i), Some((_, false)))) => {
            let mut runs: Vec<[i64; 2]> = Vec::new();
            for item in items {
                let n = number(as_ref(item).expect("checked above").0)?;
                match runs.last_mut() {
                    Some([start, len]) if *start + *len == n => *len += 1,
                    _ => runs.push([n, 1]),
                }
            }
            json!({ "$pika_runs": runs })
        }
        Value::Array(items) => Value::Array(items.iter().map(|i| compact_with(i, number)).collect::<Result<_>>()?),
        Value::Object(obj) => Value::Object(
            obj.iter()
                .map(|(k, v)| Ok((k.clone(), compact_with(v, number)?)))
                .collect::<Result<_>>()?,
        ),
        other => other.clone(),
    })
}

fn runs_of(v: &Value) -> Option<Vec<(i64, i64)>> {
    let obj = v.as_object().filter(|o| o.len() == 1)?;
    let runs = obj.get("$pika_runs")?.as_array()?;
    runs.iter()
        .map(|r| Some((r.get(0)?.as_i64()?, r.get(1)?.as_i64()?)))
        .collect()
}

fn number_ref(v: &Value) -> Option<(i64, bool)> {
    let (target, is_string) = as_ref(v)?;
    Some((target.as_i64()?, is_string))
}

fn visit_numbers(v: &Value, f: &mut impl FnMut(i64, i64)) {
    if let Some(runs) = runs_of(v) {
        runs.into_iter().for_each(|(start, len)| f(start, len));
    } else if let Some((n, _)) = number_ref(v) {
        f(n, 1);
    } else if let Some(items) = v.as_array() {
        items.iter().for_each(|i| visit_numbers(i, f));
    } else if let Some(obj) = v.as_object() {
        obj.values().for_each(|i| visit_numbers(i, f));
    }
}

/// Rebuilds the payload from a compact skeleton. `block(n, is_string)` yields the value for number `n`.
pub fn expand(v: &Value, block: &mut impl FnMut(i64, bool) -> Result<Value>) -> Result<Value> {
    if let Some(runs) = runs_of(v) {
        let mut items = Vec::new();
        for (start, len) in runs {
            for n in start..start + len {
                items.push(block(n, false)?);
            }
        }
        return Ok(Value::Array(items));
    }
    if let Some((n, is_string)) = number_ref(v) {
        return block(n, is_string);
    }
    Ok(match v {
        Value::Array(items) => Value::Array(items.iter().map(|i| expand(i, block)).collect::<Result<_>>()?),
        Value::Object(obj) => Value::Object(
            obj.iter()
                .map(|(k, v)| Ok((k.clone(), expand(v, block)?)))
                .collect::<Result<_>>()?,
        ),
        other => other.clone(),
    })
}

pub struct NewRequest<'a> {
    pub id: &'a str,
    pub session_id: &'a str,
    pub device: &'a str,
    pub seq: Option<i64>,
    pub at: Option<&'a str>,
    pub fidelity: &'a str,
    pub provider: Option<&'a str>,
    pub api: Option<&'a str>,
    pub model: Option<&'a str>,
    pub assistant_ts: Option<i64>,
    pub response_id: Option<&'a str>,
    pub skeleton: &'a Value,
}

/// Stores a request unless its id exists and returns the hashes it still lacks.
pub fn store(tx: &Transaction, r: &NewRequest, now: i64) -> Result<Vec<String>> {
    let exists = tx
        .prepare_cached("SELECT 1 FROM requests WHERE id = ?1")?
        .query_row([r.id], |_| Ok(()))
        .optional()?
        .is_some();
    if exists {
        let mut stmt = tx.prepare_cached("SELECT hash FROM request_missing WHERE request_id = ?1 ORDER BY hash")?;
        return Ok(stmt.query_map([r.id], |row| row.get(0))?.collect::<rusqlite::Result<_>>()?);
    }
    tx.prepare_cached("INSERT OR IGNORE INTO request_sessions (session_id) VALUES (?1)")?.execute([r.session_id])?;
    let rs: i64 = tx
        .prepare_cached("SELECT id FROM request_sessions WHERE session_id = ?1")?
        .query_row([r.session_id], |row| row.get(0))?;
    let mut next: i64 = tx
        .prepare_cached("SELECT COALESCE(MAX(idx) + 1, 0) FROM request_dict WHERE rs = ?1")?
        .query_row([rs], |row| row.get(0))?;
    let mut referenced: BTreeMap<String, ()> = BTreeMap::new();
    let compacted = {
        let mut lookup = tx.prepare_cached("SELECT idx FROM request_dict WHERE rs = ?1 AND hash = ?2")?;
        let mut insert = tx.prepare_cached("INSERT INTO request_dict (rs, idx, hash) VALUES (?1, ?2, ?3)")?;
        compact(r.skeleton, &mut |hash: &str| {
            referenced.insert(hash.to_owned(), ());
            let bytes = hex::decode(hash)?;
            if let Some(n) = lookup.query_row(params![rs, bytes], |row| row.get(0)).optional()? {
                return Ok(n);
            }
            insert.execute(params![rs, next, bytes])?;
            next += 1;
            Ok(next - 1)
        })?
    };
    let mut missing = Vec::new();
    {
        let mut have = tx.prepare_cached("SELECT 1 FROM blobs WHERE hash = ?1")?;
        let mut record = tx.prepare_cached("INSERT OR IGNORE INTO request_missing (hash, request_id) VALUES (?1, ?2)")?;
        for hash in referenced.keys() {
            if have.query_row([hash], |_| Ok(())).optional()?.is_none() {
                record.execute(params![hash, r.id])?;
                missing.push(hash.clone());
            }
        }
    }
    let at_ms = r.at.and_then(crate::util::parse_iso_ms);
    tx.prepare_cached(
        "INSERT INTO requests (id, session_id, rs, device, seq, at, at_ms, fidelity, provider, api, model, assistant_ts,
             response_id, skeleton, block_count, complete, received_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)",
    )?
    .execute(params![
        r.id,
        r.session_id,
        rs,
        r.device,
        r.seq,
        r.at,
        at_ms,
        r.fidelity,
        r.provider,
        r.api,
        r.model,
        r.assistant_ts,
        r.response_id,
        compacted.to_string(),
        referenced.len() as i64,
        missing.is_empty(),
        now,
    ])?;
    if let Some(ts) = r.assistant_ts {
        crate::derive::link_requests(tx, r.session_id, ts)?;
    }
    Ok(missing)
}

/// Marks requests complete once `hash` arrived.
pub fn blob_arrived(tx: &Transaction, hash: &str) -> Result<()> {
    let waiting: Vec<String> = tx
        .prepare_cached("DELETE FROM request_missing WHERE hash = ?1 RETURNING request_id")?
        .query_map([hash], |row| row.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    for id in waiting {
        tx.prepare_cached(
            "UPDATE requests SET complete = 1 WHERE id = ?1 AND NOT EXISTS (SELECT 1 FROM request_missing WHERE request_id = ?1)",
        )?
        .execute([&id])?;
    }
    Ok(())
}

#[derive(Debug, serde::Serialize)]
pub struct StoredRequest {
    pub id: String,
    #[serde(rename = "sessionId")]
    pub session_id: String,
    pub fidelity: String,
    pub provider: Option<String>,
    pub api: Option<String>,
    pub model: Option<String>,
    pub at: Option<String>,
    pub complete: bool,
    /// The reconstructed payload. Blocks that have not arrived stay as `{"$pika": hash}` refs.
    pub payload: Value,
}

pub fn load(conn: &Connection, blobs: &BlobStore, id: &str) -> Result<Option<StoredRequest>> {
    let row = conn
        .prepare_cached(
            "SELECT session_id, rs, fidelity, provider, api, model, at, complete, skeleton FROM requests WHERE id = ?1",
        )?
        .query_row([id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, Option<String>>(3)?,
                r.get::<_, Option<String>>(4)?,
                r.get::<_, Option<String>>(5)?,
                r.get::<_, Option<String>>(6)?,
                r.get::<_, bool>(7)?,
                r.get::<_, String>(8)?,
            ))
        })
        .optional()?;
    let Some((session_id, rs, fidelity, provider, api, model, at, complete, skeleton)) = row else { return Ok(None) };
    let skeleton: Value = serde_json::from_str(&skeleton).context("stored skeleton")?;
    let mut hashes: BTreeMap<i64, String> = BTreeMap::new();
    let mut ranges = Vec::new();
    visit_numbers(&skeleton, &mut |start, len| ranges.push((start, len)));
    {
        let mut stmt = conn.prepare_cached("SELECT idx, hash FROM request_dict WHERE rs = ?1 AND idx >= ?2 AND idx < ?3")?;
        for (start, len) in ranges {
            if (start..start + len).all(|n| hashes.contains_key(&n)) {
                continue;
            }
            for row in stmt.query_map(params![rs, start, start + len], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, Vec<u8>>(1)?)))? {
                let (n, hash) = row?;
                hashes.insert(n, hex::encode(hash));
            }
        }
    }
    let mut texts: BTreeMap<i64, Option<String>> = BTreeMap::new();
    let payload = expand(&skeleton, &mut |n, is_string| {
        let hash = hashes.get(&n).ok_or_else(|| anyhow!("request {id} refers to unknown block {n}"))?;
        Ok(match texts.entry(n).or_insert_with(|| blobs.get_string(hash).ok()) {
            None if is_string => json!({ "$pika": hash, "$type": "string" }),
            None => json!({ "$pika": hash }),
            Some(text) if is_string => Value::String(text.clone()),
            Some(text) => serde_json::from_str(text).with_context(|| format!("block {hash}"))?,
        })
    })?;
    Ok(Some(StoredRequest { id: id.to_owned(), session_id, fidelity, provider, api, model, at, complete, payload }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compact_runs_and_expand() {
        let payload = json!({ "messages": [1, 2, 3, {"x": "y"}], "tools": [], "system": "s".repeat(3000), "n": 1 });
        let (skeleton, blocks) = split(&payload);
        let order: Vec<String> = blocks.iter().map(|(h, _)| h.clone()).collect();
        let compacted = compact(&skeleton, &mut |h| Ok(order.iter().position(|x| x == h).unwrap() as i64)).unwrap();
        assert_eq!(compacted["messages"], json!({ "$pika_runs": [[0, 4]] }));
        assert_eq!(compacted["tools"], json!([]));
        assert_eq!(compacted["system"], json!({ "$pika": 4, "$type": "string" }));
        let expanded = expand(&compacted, &mut |n, is_string| {
            let text = &blocks[n as usize].1;
            Ok(if is_string { Value::String(text.clone()) } else { serde_json::from_str(text)? })
        })
        .unwrap();
        assert_eq!(expanded, payload);
    }
}
