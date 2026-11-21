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
/// Per-version SQL that undoes schema version `v` back to `v - 1`, in ascending version order.
/// Dropping v7's `search_fts` needs `pika::tokenizer::register`, which `rewind` calls before that step.
pub const UNDO_STEPS: &[(usize, &str)] = &[
    (
        2,
        "DROP TABLE search_fts; DROP TABLE search_docs;
         DROP INDEX sessions_device_project; DROP INDEX sessions_root_device;
         DROP INDEX sessions_root_project; DROP INDEX sessions_root_device_project;",
    ),
    (3, ""),
    (
        4,
        "DROP TABLE auth_sessions; DROP TABLE pairings;
         ALTER TABLE tokens DROP COLUMN created_via;
         ALTER TABLE tokens DROP COLUMN last_seen_at;
         ALTER TABLE tokens DROP COLUMN last_host;",
    ),
    (
        5,
        "DROP TABLE devices;
         ALTER TABLE pairings DROP COLUMN key_hash;
         ALTER TABLE pairings DROP COLUMN matched;
         ALTER TABLE pairings DROP COLUMN matched_by;
         ALTER TABLE pairings DROP COLUMN target;",
    ),
    (6, "ALTER TABLE requests DROP COLUMN timing;"),
    (
        7,
        "DROP TABLE search_fts;
         CREATE VIRTUAL TABLE search_fts USING fts5(text, content = 'search_docs', content_rowid = 'id',
             tokenize = \"unicode61 remove_diacritics 2 categories 'L* N* Co So'\");
         INSERT INTO search_fts (search_fts) VALUES ('rebuild');",
    ),
    (8, "ALTER TABLE sessions DROP COLUMN repository;"),
    (9, "DROP TABLE visitor_views; DROP TABLE visitor_day_key;"),
    (
        10,
        "DROP TABLE deleted_streams; DROP TABLE hidden_sessions; DROP TABLE session_hidden;
         DROP INDEX IF EXISTS search_docs_sid; DROP INDEX lines_blob; DROP INDEX request_dict_blob;",
    ),
    (11, "DROP TABLE usage_events; DROP INDEX entries_activity;"),
    (12, "DROP INDEX usage_events_pricing; ALTER TABLE usage_events DROP COLUMN pricing;"),
    (13, "ALTER TABLE devices DROP COLUMN read_access;"),
    (14, "DROP TABLE memory_revisions; DROP TABLE memory_notes; DROP TABLE memory_scopes;"),
    (
        15,
        "DROP TABLE memory_checkpoints; DROP TABLE memory_dream_batches; DROP TABLE memory_dream_leases;
         DROP INDEX memory_revisions_batch; ALTER TABLE memory_revisions DROP COLUMN batch_id;
         ALTER TABLE memory_revisions DROP COLUMN sources; ALTER TABLE memory_revisions DROP COLUMN provenance;
         ALTER TABLE memory_notes DROP COLUMN sources;",
    ),
    (
        16,
        "DROP INDEX memory_dream_batches_commit; DROP INDEX memory_dream_batches_lease;
         ALTER TABLE memory_dream_batches DROP COLUMN commit_id;",
    ),
    (17, "ALTER TABLE memory_notes DROP COLUMN last_used_at;"),
    (
        18,
        "DROP TABLE relay_mailbox; DROP TABLE relay_events; DROP TABLE relay_room_messages;
         DROP TABLE relay_room_members; DROP TABLE relay_rooms;",
    ),
    (19, "DROP INDEX entries_custom_type; DROP INDEX tool_calls_started;"),
    (20, "DROP TABLE relay_boards;"),
    (21, "DROP TABLE nodes;"),
    (22, "DROP TABLE deck_projects;"),
    (23, "DROP INDEX IF EXISTS entries_spokesman;"),
    (
        24,
        "CREATE INDEX IF NOT EXISTS sessions_root ON sessions(last_at DESC, id DESC) WHERE parent_session_id IS NULL;
         CREATE INDEX IF NOT EXISTS sessions_root_device ON sessions(device, last_at DESC, id DESC) WHERE parent_session_id IS NULL;
         CREATE INDEX IF NOT EXISTS sessions_root_project ON sessions(project, last_at DESC, id DESC) WHERE parent_session_id IS NULL;
         CREATE INDEX IF NOT EXISTS sessions_root_device_project ON sessions(device, project, last_at DESC, id DESC) WHERE parent_session_id IS NULL;",
    ),
    (25, "DROP INDEX IF EXISTS session_links_dream; DROP INDEX IF EXISTS sessions_repo_last;"),
];

/// Rewinds `conn` from its current `PRAGMA user_version` down to `target_version`, running each intermediate undo step
/// in descending version order and updating `PRAGMA user_version`.
pub fn rewind(conn: &rusqlite::Connection, target_version: usize) {
    let current = conn.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0)).unwrap() as usize;
    assert!(
        target_version >= 1 && target_version <= current,
        "cannot rewind schema from version {current} to {target_version}"
    );
    for version in ((target_version + 1)..=current).rev() {
        let (_, sql) = UNDO_STEPS
            .iter()
            .find(|(v, _)| *v == version)
            .unwrap_or_else(|| panic!("missing UNDO_STEPS entry for schema version {version}"));
        if version == 7 {
            // Dropping v7's FTS5 table requires its custom tokenizer to be registered on this connection.
            pika::tokenizer::register(conn).unwrap();
        }
        if !sql.is_empty() {
            conn.execute_batch(sql).unwrap_or_else(|e| panic!("rewinding schema version {version} failed: {e}"));
        }
    }
    conn.pragma_update(None, "user_version", target_version as i64).unwrap();
}

pub struct Env {
    pub dir: TempDir,
    pub store: Arc<Store>,
}

pub fn env() -> Env {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("data")).unwrap();
    Env { dir, store }
}

/// Creates device `id`, named `name`, with a token, and returns the token. Devices from before 0.4 have ids like
/// these after the upgrade; `pika token create` gives new devices a UUID.
pub fn device_named(store: &Store, id: &str, name: &str) -> String {
    let token = format!("pika_{}", hex::encode(pika::util::random_bytes::<32>()));
    let hash = pika::util::sha256_hex(token.as_bytes());
    store
        .write(|tx| {
            tx.execute("INSERT INTO devices (id, name, created_at) VALUES (?1, ?2, 1)", [id, name])?;
            tx.execute("INSERT INTO tokens (name, hash, created_at) VALUES (?1, ?2, ?3)", rusqlite::params![id, hash, pika::util::now_ms()])
        })
        .unwrap();
    token
}

/// `device_named` with the id as the name.
pub fn device(store: &Store, id: &str) -> String {
    device_named(store, id, id)
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
