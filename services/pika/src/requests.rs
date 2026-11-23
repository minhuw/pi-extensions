//! Model request blocks. Clients split a payload into a skeleton plus content-addressed blocks (spec "Request
//! blocks"). The server numbers each session's distinct block hashes in `request_dict` and stores the skeleton with
//! those numbers: a ref becomes `{"$pika": n}` and an array made only of refs becomes `{"$pika_runs": [[start, len],
//! ...]}`. A context that grows by a few messages per request then costs a few bytes of skeleton per request.

use std::collections::BTreeMap;

use anyhow::{Context, Result, anyhow, bail};
use rusqlite::{Connection, OptionalExtension, Transaction, params};
use serde_json::value::RawValue;
use serde_json::{Map, Value, json};

use crate::blobs::BlobStore;
use crate::util::{is_hash, sha256_hex};

const STRING_THRESHOLD: usize = 2048;
/// Times after the year 9999 are not times.
pub const MAX_TIME_MS: i64 = 253_402_300_799_999;
/// The kinds of a request's first streamed delta.
pub const FIRST_TOKEN_KINDS: &[&str] = &["text", "thinking", "toolCall"];
/// Maximum size in bytes of an expanded request payload.
pub const MAX_EXPANDED_BYTES: usize = 128 * 1024 * 1024;

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
    if is_runs_object(v) {
        bail!("skeleton must not contain $pika_runs");
    }
    Ok(match v {
        Value::Array(items) if !items.is_empty() && items.iter().all(|i| matches!(as_ref(i), Some((_, false)))) => {
            let mut runs: Vec<[i64; 2]> = Vec::new();
            for item in items {
                let n = number(as_ref(item).expect("checked above").0)?;
                match runs.last_mut() {
                    Some([start, len]) if start.checked_add(*len) == Some(n) && *len < i64::MAX => *len += 1,
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

fn is_runs_object(v: &Value) -> bool {
    v.as_object().is_some_and(|o| o.len() == 1 && o.contains_key("$pika_runs"))
}

/// Parses a `{"$pika_runs": [[start, len], ...]}` directive into validated `(start, end)` ranges.
fn runs_of(v: &Value) -> Result<Option<Vec<(i64, i64)>>> {
    let Some(obj) = v.as_object().filter(|o| o.len() == 1) else { return Ok(None) };
    let Some(runs) = obj.get("$pika_runs") else { return Ok(None) };
    let runs = runs.as_array().ok_or_else(|| anyhow!("invalid $pika_runs: expected array"))?;
    let mut out = Vec::with_capacity(runs.len());
    for r in runs {
        let pair = r.as_array().filter(|a| a.len() == 2).ok_or_else(|| anyhow!("invalid $pika_runs entry"))?;
        let start = pair[0].as_i64().ok_or_else(|| anyhow!("invalid $pika_runs start"))?;
        let len = pair[1].as_i64().ok_or_else(|| anyhow!("invalid $pika_runs len"))?;
        if start < 0 {
            bail!("invalid $pika_runs negative start {start}");
        }
        if len < 0 {
            bail!("invalid $pika_runs negative len {len}");
        }
        let end = start.checked_add(len).ok_or_else(|| anyhow!("invalid $pika_runs overflow: {start} + {len}"))?;
        out.push((start, end));
    }
    Ok(Some(out))
}

fn number_ref(v: &Value) -> Option<(i64, bool)> {
    let (target, is_string) = as_ref(v)?;
    Some((target.as_i64()?, is_string))
}

fn visit_numbers(v: &Value, f: &mut impl FnMut(i64, i64)) -> Result<()> {
    if let Some(runs) = runs_of(v)? {
        for (start, end) in runs {
            f(start, end);
        }
    } else if let Some((n, _)) = number_ref(v) {
        if n < 0 {
            bail!("invalid block ref negative index {n}");
        }
        let end = n.checked_add(1).ok_or_else(|| anyhow!("invalid block ref overflow: {n}"))?;
        f(n, end);
    } else if let Some(items) = v.as_array() {
        for item in items {
            visit_numbers(item, f)?;
        }
    } else if let Some(obj) = v.as_object() {
        for item in obj.values() {
            visit_numbers(item, f)?;
        }
    }
    Ok(())
}

/// Rebuilds the payload from a compact skeleton as JSON text, failing if the expanded JSON exceeds `max_bytes` bytes.
/// `block(n, is_string, out)` appends the JSON of number `n` to `out`, so block text is spliced in without a round
/// trip through `Value`.
pub fn expand_limited(
    v: &Value,
    max_bytes: usize,
    block: &mut impl FnMut(i64, bool, &mut String) -> Result<()>,
) -> Result<String> {
    let mut out = String::new();
    write_expanded(v, &mut out, max_bytes, block)?;
    Ok(out)
}

fn check_limit(len: usize, max_bytes: usize) -> Result<()> {
    if len > max_bytes {
        bail!("expanded payload exceeds {max_bytes} byte limit");
    }
    Ok(())
}

fn push_char_limited(out: &mut String, ch: char, max_bytes: usize) -> Result<()> {
    let next = out.len().checked_add(ch.len_utf8()).ok_or_else(|| anyhow!("expanded payload size overflow"))?;
    check_limit(next, max_bytes)?;
    out.push(ch);
    Ok(())
}

fn push_str_limited(out: &mut String, s: &str, max_bytes: usize) -> Result<()> {
    let next = out.len().checked_add(s.len()).ok_or_else(|| anyhow!("expanded payload size overflow"))?;
    check_limit(next, max_bytes)?;
    out.push_str(s);
    Ok(())
}

fn write_expanded(
    v: &Value,
    out: &mut String,
    max_bytes: usize,
    block: &mut impl FnMut(i64, bool, &mut String) -> Result<()>,
) -> Result<()> {
    if let Some(runs) = runs_of(v)? {
        push_char_limited(out, '[', max_bytes)?;
        let mut first = true;
        for (start, end) in runs {
            for n in start..end {
                if !first {
                    push_char_limited(out, ',', max_bytes)?;
                }
                first = false;
                block(n, false, out)?;
                check_limit(out.len(), max_bytes)?;
            }
        }
        push_char_limited(out, ']', max_bytes)?;
        return Ok(());
    }
    if let Some((n, is_string)) = number_ref(v) {
        if n < 0 {
            bail!("invalid block ref negative index {n}");
        }
        if n.checked_add(1).is_none() {
            bail!("invalid block ref overflow: {n}");
        }
        block(n, is_string, out)?;
        check_limit(out.len(), max_bytes)?;
        return Ok(());
    }
    match v {
        Value::Array(items) => {
            push_char_limited(out, '[', max_bytes)?;
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    push_char_limited(out, ',', max_bytes)?;
                }
                write_expanded(item, out, max_bytes, block)?;
            }
            push_char_limited(out, ']', max_bytes)?;
        }
        Value::Object(obj) => {
            push_char_limited(out, '{', max_bytes)?;
            for (i, (key, item)) in obj.iter().enumerate() {
                if i > 0 {
                    push_char_limited(out, ',', max_bytes)?;
                }
                push_str_limited(out, &serde_json::to_string(key)?, max_bytes)?;
                push_char_limited(out, ':', max_bytes)?;
                write_expanded(item, out, max_bytes, block)?;
            }
            push_char_limited(out, '}', max_bytes)?;
        }
        other => push_str_limited(out, &other.to_string(), max_bytes)?,
    }
    Ok(())
}

/// A request's `timing` as stored: its times that are integers from 0 to `MAX_TIME_MS` and a known `firstToken`, as
/// a JSON object, or none when no key is valid. Invalid and unknown keys are dropped, never rejected.
pub fn timing(v: &Value) -> Option<String> {
    let obj = v.as_object()?;
    let mut out = Map::new();
    for key in ["sentAt", "responseAt", "firstTokenAt"] {
        if let Some(t) = obj.get(key).and_then(Value::as_i64).filter(|t| (0..=MAX_TIME_MS).contains(t)) {
            out.insert(key.to_owned(), t.into());
        }
    }
    if let Some(kind) = obj.get("firstToken").and_then(Value::as_str).filter(|k| FIRST_TOKEN_KINDS.contains(k)) {
        out.insert("firstToken".to_owned(), kind.into());
    }
    (!out.is_empty()).then(|| Value::Object(out).to_string())
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
    /// See `timing`.
    pub timing: Option<&'a str>,
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
             response_id, skeleton, block_count, complete, received_at, timing)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)",
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
        r.timing,
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
    pub api: Option<String>,
    /// The model's bare name (`crate::util::bare_model`); the stored request and its payload keep the id as sent.
    pub model: Option<String>,
    pub at: Option<String>,
    pub complete: bool,
    /// The reconstructed payload, with block text verbatim: a block may hold escapes of unpaired UTF-16 surrogates,
    /// which `Value` cannot. Blocks that have not arrived stay as `{"$pika": hash}` refs.
    pub payload: Box<RawValue>,
}

pub fn load(conn: &Connection, blobs: &BlobStore, id: &str) -> Result<Option<StoredRequest>> {
    load_limited(conn, blobs, id, MAX_EXPANDED_BYTES)
}

pub fn load_limited(conn: &Connection, blobs: &BlobStore, id: &str, max_bytes: usize) -> Result<Option<StoredRequest>> {
    let row = conn
        .prepare_cached(
            "SELECT session_id, rs, fidelity, api, model, at, complete, skeleton FROM requests WHERE id = ?1",
        )?
        .query_row([id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, Option<String>>(3)?,
                r.get::<_, Option<String>>(4)?,
                r.get::<_, Option<String>>(5)?,
                r.get::<_, bool>(6)?,
                r.get::<_, String>(7)?,
            ))
        })
        .optional()?;
    let Some((session_id, rs, fidelity, api, model, at, complete, skeleton)) = row else { return Ok(None) };
    let model = model.map(|m| crate::util::bare_model(&m).to_owned());
    let skeleton: Value = serde_json::from_str(&skeleton).context("stored skeleton")?;
    let mut hashes: BTreeMap<i64, String> = BTreeMap::new();
    let mut ranges = Vec::new();
    visit_numbers(&skeleton, &mut |start, end| ranges.push((start, end)))?;
    {
        let mut stmt = conn.prepare_cached("SELECT idx, hash FROM request_dict WHERE rs = ?1 AND idx >= ?2 AND idx < ?3")?;
        for (start, end) in ranges {
            let count = u64::try_from(end - start).unwrap_or(u64::MAX);
            if count <= hashes.len() as u64 && (start..end).all(|n| hashes.contains_key(&n)) {
                continue;
            }
            for row in stmt.query_map(params![rs, start, end], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, Vec<u8>>(1)?)))? {
                let (n, hash) = row?;
                hashes.insert(n, hex::encode(hash));
            }
        }
    }
    let mut texts: BTreeMap<i64, Option<String>> = BTreeMap::new();
    let payload = expand_limited(&skeleton, max_bytes, &mut |n, is_string, out| {
        let hash = hashes.get(&n).ok_or_else(|| anyhow!("request {id} refers to unknown block {n}"))?;
        match texts.entry(n).or_insert_with(|| blobs.get_string(hash).ok()) {
            None if is_string => push_str_limited(out, &json!({ "$pika": hash, "$type": "string" }).to_string(), max_bytes)?,
            None => push_str_limited(out, &json!({ "$pika": hash }).to_string(), max_bytes)?,
            Some(text) if is_string => push_str_limited(out, &serde_json::to_string(text)?, max_bytes)?,
            Some(text) => {
                // One JSON value; unlike `Value`, `RawValue` accepts escapes of unpaired surrogates.
                let value: &RawValue = serde_json::from_str(text).with_context(|| format!("block {hash}"))?;
                push_str_limited(out, value.get(), max_bytes)?;
            }
        }
        Ok(())
    })?;
    let payload = RawValue::from_string(payload).context("reconstructed payload")?;
    Ok(Some(StoredRequest { id: id.to_owned(), session_id, fidelity, api, model, at, complete, payload }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn invalid_timing_keys_are_dropped() {
        let t = |v: Value| timing(&v);
        assert_eq!(
            t(json!({ "sentAt": 5, "responseAt": 6, "firstTokenAt": 7, "firstToken": "thinking", "extra": 1 })),
            Some(r#"{"sentAt":5,"responseAt":6,"firstTokenAt":7,"firstToken":"thinking"}"#.into())
        );
        assert_eq!(t(json!({ "sentAt": 1.5, "responseAt": "6", "firstTokenAt": -1, "firstToken": "image" })), None);
        assert_eq!(
            t(json!({ "sentAt": MAX_TIME_MS + 1, "responseAt": u64::MAX, "firstTokenAt": MAX_TIME_MS, "firstToken": 1 })),
            Some(format!(r#"{{"firstTokenAt":{MAX_TIME_MS}}}"#))
        );
        for v in [json!(null), json!([1]), json!("x"), json!({})] {
            assert_eq!(t(v.clone()), None, "{v}");
        }
    }

    #[test]
    fn compact_runs_and_expand() {
        let payload = json!({ "messages": [1, 2, 3, {"x": "y"}], "tools": [], "system": "s".repeat(3000), "n": 1 });
        let (skeleton, blocks) = split(&payload);
        let order: Vec<String> = blocks.iter().map(|(h, _)| h.clone()).collect();
        let compacted = compact(&skeleton, &mut |h| Ok(order.iter().position(|x| x == h).unwrap() as i64)).unwrap();
        assert_eq!(compacted["messages"], json!({ "$pika_runs": [[0, 4]] }));
        assert_eq!(compacted["tools"], json!([]));
        assert_eq!(compacted["system"], json!({ "$pika": 4, "$type": "string" }));
        let expanded = expand_limited(&compacted, MAX_EXPANDED_BYTES, &mut |n, is_string, out| {
            let text = &blocks[n as usize].1;
            out.push_str(&if is_string { serde_json::to_string(text)? } else { text.clone() });
            Ok(())
        })
        .unwrap();
        assert_eq!(serde_json::from_str::<Value>(&expanded).unwrap(), payload);
    }

    #[test]
    fn compact_rejects_injected_pika_runs() {
        let hash = sha256_hex(b"1");
        let cases = [
            json!({ "$pika_runs": [[0, 1]] }),
            json!({ "messages": { "$pika_runs": [[0, 1]] } }),
            json!({ "messages": [{ "$pika_runs": [[0, 1]] }] }),
            json!({ "messages": [{ "$pika": hash }, { "$pika_runs": [[0, 1]] }] }),
            json!({ "messages": { "$pika_runs": "not-an-array" } }),
        ];
        for skeleton in cases {
            let err = compact(&skeleton, &mut |_| Ok(0)).unwrap_err();
            assert!(err.to_string().contains("$pika_runs"), "{skeleton}: {err:#}");
        }
    }

    #[test]
    fn expand_and_visit_reject_overflowing_and_negative_runs() {
        let malformed = [
            json!({ "messages": { "$pika_runs": [[i64::MAX, 1]] } }),
            json!({ "messages": { "$pika_runs": [[i64::MAX - 2, 5]] } }),
            json!({ "messages": { "$pika_runs": [[0, -1]] } }),
            json!({ "messages": { "$pika_runs": [[-1, 1]] } }),
            json!({ "messages": { "$pika_runs": [[0]] } }),
            json!({ "messages": { "$pika_runs": "bad" } }),
            json!({ "system": { "$pika": i64::MAX } }),
            json!({ "system": { "$pika": -1 } }),
        ];
        for skeleton in malformed {
            assert!(visit_numbers(&skeleton, &mut |_, _| {}).is_err(), "visit_numbers accepted {skeleton}");
            let res = expand_limited(&skeleton, MAX_EXPANDED_BYTES, &mut |_, _, out| {
                out.push('1');
                Ok(())
            });
            assert!(res.is_err(), "expand_limited accepted {skeleton}");
        }
    }

    #[test]
    fn expand_enforces_output_byte_cap() {
        let block = format!("\"{}\"", "x".repeat(100));
        // Repeated run references to the same block.
        let repeated_runs = json!({ "messages": { "$pika_runs": vec![[0, 1]; 20] } });
        let err = expand_limited(&repeated_runs, 512, &mut |_, _, out| {
            out.push_str(&block);
            Ok(())
        })
        .unwrap_err();
        assert!(err.to_string().contains("byte limit"), "{err:#}");

        // Repeated single refs to the same block.
        let repeated_refs = json!({ "messages": vec![json!({ "$pika": 0 }); 20] });
        let err = expand_limited(&repeated_refs, 512, &mut |_, _, out| {
            out.push_str(&block);
            Ok(())
        })
        .unwrap_err();
        assert!(err.to_string().contains("byte limit"), "{err:#}");

        // Huge single run length cannot spin even when blocks are tiny.
        let huge_run = json!({ "messages": { "$pika_runs": [[0, 1_000_000]] } });
        let err = expand_limited(&huge_run, 64, &mut |_, _, out| {
            out.push('1');
            Ok(())
        })
        .unwrap_err();
        assert!(err.to_string().contains("byte limit"), "{err:#}");

        // Fits cleanly when under the cap.
        let small = json!({ "messages": { "$pika_runs": [[0, 2]] } });
        let ok = expand_limited(&small, 512, &mut |_, _, out| {
            out.push_str(&block);
            Ok(())
        })
        .unwrap();
        assert!(ok.len() <= 512);
    }
}
