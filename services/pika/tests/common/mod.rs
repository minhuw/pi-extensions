#![allow(dead_code)]

use std::collections::BTreeMap;
use std::sync::Arc;

use pika::ingest::{self, Batch, BatchResponse, IngestError};
use pika::store::{DERIVED_TABLES, Store};
use rusqlite::types::ValueRef;
use serde_json::{Value, json};
use tempfile::TempDir;

pub const DEVICE: &str = "laptop";
pub const SESSION_ID: &str = "7f3c2a10-5b1e-4c3d-9a8e-1f2e3d4c5b6a";
pub const RUN_ID: &str = "20261021-100000-abcd";
/// SQL that removes what schema version 4 added, for tests that rewind `user_version`.
pub const UNDO_V4: &str = "DROP TABLE auth_sessions; DROP TABLE pairings; ALTER TABLE tokens DROP COLUMN created_via;
    ALTER TABLE tokens DROP COLUMN last_seen_at; ALTER TABLE tokens DROP COLUMN last_host;";

pub struct Env {
    pub dir: TempDir,
    pub store: Arc<Store>,
}

pub fn env() -> Env {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("data")).unwrap();
    Env { dir, store }
}

pub fn fixture(name: &str) -> Vec<String> {
    let path = format!("{}/tests/fixtures/{name}", env!("CARGO_MANIFEST_DIR"));
    std::fs::read_to_string(path).unwrap().lines().map(str::to_owned).collect()
}

pub fn byte_len(lines: &[String]) -> u64 {
    lines.iter().map(|l| l.len() as u64 + 1).sum()
}

pub fn joined(lines: &[String]) -> Vec<u8> {
    lines.iter().flat_map(|l| l.bytes().chain(std::iter::once(b'\n'))).collect()
}

pub fn stream(key: &str, kind: &str, offset: u64, lines: &[String]) -> Value {
    json!({ "key": key, "kind": kind, "offset": offset, "lines": lines })
}

pub fn ingest(store: &Store, batch: Value) -> Result<BatchResponse, IngestError> {
    let batch: Batch = serde_json::from_value(batch).unwrap();
    ingest::apply(store, DEVICE, &batch)
}

/// Uploads `lines` of a stream in batches of `chunk` lines.
pub fn upload(store: &Store, key: &str, kind: &str, lines: &[String], chunk: usize) {
    let mut offset = 0;
    for part in lines.chunks(chunk) {
        let response = ingest(store, json!({ "streams": [stream(key, kind, offset, part)] })).unwrap();
        offset += byte_len(part);
        assert_eq!(response.streams[key].length, offset);
    }
}

fn to_json(v: ValueRef) -> Value {
    match v {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(i) => json!(i),
        ValueRef::Real(f) => json!(f),
        ValueRef::Text(t) => json!(String::from_utf8_lossy(t)),
        ValueRef::Blob(b) => json!(hex::encode(b)),
    }
}

pub fn query(store: &Store, sql: &str) -> Vec<BTreeMap<String, Value>> {
    store
        .read(|conn| {
            let mut stmt = conn.prepare(sql)?;
            let names: Vec<String> = stmt.column_names().map(str::to_owned).collect();
            let rows = stmt.query_map([], |row| {
                Ok(names.iter().enumerate().map(|(i, n)| (n.clone(), to_json(row.get_ref(i).unwrap()))).collect())
            })?;
            rows.collect::<rusqlite::Result<Vec<_>>>()
        })
        .unwrap()
}

pub fn one(store: &Store, sql: &str) -> BTreeMap<String, Value> {
    let mut rows = query(store, sql);
    assert_eq!(rows.len(), 1, "{sql}");
    rows.remove(0)
}

/// Every derived table's rows, sorted.
pub fn dump_derived(store: &Store) -> BTreeMap<String, Vec<String>> {
    DERIVED_TABLES
        .iter()
        .map(|table| {
            let mut rows: Vec<String> =
                query(store, &format!("SELECT * FROM {table}")).iter().map(|r| serde_json::to_string(r).unwrap()).collect();
            rows.sort();
            (table.to_string(), rows)
        })
        .collect()
}
