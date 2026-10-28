use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;
use serde_json::{Map, Value};

use super::{Params, ReadError, ReadResult, iso, line_text, session_sid};
use crate::blobs::BlobStore;
use crate::util::{base64_decode, encode_path_segment, parse_json_lenient};

pub const ENTRY_LIMIT: i64 = 200;
pub const MAX_ENTRY_LIMIT: i64 = 1000;
/// Longer strings in `raw` are cut to this many characters.
pub const MAX_STRING_CHARS: usize = 65_536;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub seq: i64,
    pub offset: i64,
    pub id: Option<String>,
    pub parent_id: Option<String>,
    #[serde(rename = "type")]
    pub ty: String,
    pub timestamp: Option<String>,
    pub raw: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub truncated: bool,
}

#[derive(Debug, Serialize)]
pub struct Entries {
    pub items: Vec<Entry>,
}

/// Calls `f` with each image block (`{"type": "image", "data": "<base64>", ...}`) in document order, numbered from 0.
fn for_each_image(v: &mut Value, next: &mut usize, f: &mut impl FnMut(usize, &mut Map<String, Value>)) {
    match v {
        Value::Object(obj) => {
            if obj.get("type").and_then(Value::as_str) == Some("image") && obj.get("data").is_some_and(Value::is_string) {
                f(*next, obj);
                *next += 1;
                return;
            }
            obj.values_mut().for_each(|value| for_each_image(value, next, f));
        }
        Value::Array(items) => items.iter_mut().for_each(|item| for_each_image(item, next, f)),
        _ => {}
    }
}

/// Cuts every string longer than `MAX_STRING_CHARS` characters; returns whether any was cut.
fn truncate_strings(v: &mut Value) -> bool {
    match v {
        Value::String(s) if s.len() > MAX_STRING_CHARS => match s.char_indices().nth(MAX_STRING_CHARS) {
            Some((end, _)) => {
                s.truncate(end);
                true
            }
            None => false,
        },
        Value::Array(items) => items.iter_mut().fold(false, |cut, item| truncate_strings(item) | cut),
        Value::Object(obj) => obj.values_mut().fold(false, |cut, value| truncate_strings(value) | cut),
        _ => false,
    }
}

/// The parsed line, or the line as a JSON string when it is not JSON.
fn parse(text: String) -> Value {
    parse_json_lenient(&text).unwrap_or(Value::String(text))
}

pub(crate) const LIST_SQL: &str = "SELECT e.seq, e.offset, e.entry_id, e.parent_id, e.type, e.ts, l.data, l.blob, m.request_id
     FROM entries e
     JOIN lines l ON l.stream_id = e.sid AND l.offset = e.offset
     LEFT JOIN model_calls m ON m.sid = e.sid AND m.seq = e.seq
     WHERE e.sid = ?1 AND e.seq >= ?2 AND e.seq <= ?3
     ORDER BY e.seq LIMIT ?4";

/// Entries `from..=to` by seq. `prefix` is the base path prefix for image URLs (empty for `/`).
pub fn list(conn: &Connection, blobs: &BlobStore, prefix: &str, id: &str, p: &Params) -> ReadResult<Entries> {
    list_scoped(conn, blobs, prefix, id, p, false)
}

pub fn list_scoped(conn: &Connection, blobs: &BlobStore, prefix: &str, id: &str, p: &Params, public: bool) -> ReadResult<Entries> {
    let sid = session_sid(conn, id)?;
    let limit = p.limit(ENTRY_LIMIT, MAX_ENTRY_LIMIT)?;
    let from = p.int("from")?.unwrap_or(0);
    let to = p.int("to")?.unwrap_or(i64::MAX);
    let rows = conn
        .prepare_cached(LIST_SQL)?
        .query_map(params![sid, from, to, limit], |r| {
            Ok((
                Entry {
                    seq: r.get(0)?,
                    offset: r.get(1)?,
                    id: r.get(2)?,
                    parent_id: r.get(3)?,
                    ty: r.get(4)?,
                    timestamp: iso(r.get(5)?),
                    raw: Value::Null,
                    request_id: r.get(8)?,
                    truncated: false,
                },
                r.get::<_, Option<String>>(6)?,
                r.get::<_, Option<String>>(7)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let namespace = if public { "public/v1" } else { "v1" };
    let images = format!("{prefix}/api/{namespace}/sessions/{}/entries", encode_path_segment(id));
    let mut items = Vec::with_capacity(rows.len());
    for (mut entry, data, blob) in rows {
        let mut raw = parse(line_text(blobs, data, blob)?);
        let seq = entry.seq;
        for_each_image(&mut raw, &mut 0, &mut |index, image| {
            image.insert("data".into(), Value::String(String::new()));
            image.insert("src".into(), Value::String(format!("{images}/{seq}/image/{index}")));
        });
        entry.truncated = truncate_strings(&mut raw);
        entry.raw = raw;
        if public {
            entry.request_id = None;
        }
        items.push(entry);
    }
    Ok(Entries { items })
}

/// The verbatim line of entry `seq`.
pub fn raw(conn: &Connection, blobs: &BlobStore, id: &str, seq: i64) -> ReadResult<String> {
    let sid = session_sid(conn, id)?;
    let (data, blob) = conn
        .prepare_cached(
            "SELECT l.data, l.blob FROM entries e JOIN lines l ON l.stream_id = e.sid AND l.offset = e.offset
             WHERE e.sid = ?1 AND e.seq = ?2",
        )?
        .query_row(params![sid, seq], |r| Ok((r.get(0)?, r.get(1)?)))
        .optional()?
        .ok_or(ReadError::NotFound)?;
    line_text(blobs, data, blob)
}

fn image_type(mime: Option<&str>) -> &str {
    match mime {
        Some(m)
            if m.len() <= 64
                && m.strip_prefix("image/").is_some_and(|sub| {
                    !sub.is_empty() && sub.bytes().all(|b| b.is_ascii_alphanumeric() || b"+-.".contains(&b))
                }) =>
        {
            m
        }
        _ => "application/octet-stream",
    }
}

/// The decoded bytes and content type of image `index` of entry `seq`.
pub fn image(conn: &Connection, blobs: &BlobStore, id: &str, seq: i64, index: usize) -> ReadResult<(String, Vec<u8>)> {
    let mut raw = parse(raw(conn, blobs, id, seq)?);
    let mut found = None;
    for_each_image(&mut raw, &mut 0, &mut |i, image| {
        if i == index {
            found = Some((
                image_type(image.get("mimeType").and_then(Value::as_str)).to_owned(),
                image.get("data").and_then(Value::as_str).and_then(base64_decode),
            ));
        }
    });
    match found {
        Some((content_type, Some(bytes))) => Ok((content_type, bytes)),
        Some((_, None)) => Err(ReadError::Internal(anyhow::anyhow!("image {index} of {id}/{seq} is not base64"))),
        None => Err(ReadError::NotFound),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn images_and_long_strings() {
        let mut v = json!({ "content": [{ "type": "image", "data": "aGk=", "mimeType": "image/png" }, { "type": "text", "text": "x".repeat(MAX_STRING_CHARS + 3) }],
                            "nested": { "type": "image", "data": "aGk=" } });
        let mut seen = Vec::new();
        for_each_image(&mut v, &mut 0, &mut |i, image| seen.push((i, image["data"].clone())));
        assert_eq!(seen, [(0, json!("aGk=")), (1, json!("aGk="))]);
        assert!(truncate_strings(&mut v));
        assert_eq!(v["content"][1]["text"].as_str().unwrap().len(), MAX_STRING_CHARS);
        assert!(!truncate_strings(&mut v));
        let mut wide = json!("é".repeat(MAX_STRING_CHARS));
        assert!(!truncate_strings(&mut wide));
        assert_eq!(image_type(Some("image/svg+xml")), "image/svg+xml");
        assert_eq!(image_type(Some("text/html")), "application/octet-stream");
        assert_eq!(image_type(Some("image/png\r\nx: y")), "application/octet-stream");
    }
}
