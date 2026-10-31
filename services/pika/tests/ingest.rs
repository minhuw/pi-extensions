mod common;

use common::*;
use pika::ingest::IngestError;
use pika::requests;
use pika::util::sha256_hex;
use serde_json::{Value, json};

const KEY: &str = "session:7f3c2a10-5b1e-4c3d-9a8e-1f2e3d4c5b6a";

fn export(env: &Env, id: &str) -> Vec<u8> {
    let mut out = Vec::new();
    assert!(pika::export::write_session(&env.store, id, &mut out).unwrap());
    out
}

fn parsed(payload: &serde_json::value::RawValue) -> Value {
    serde_json::from_str(payload.get()).unwrap()
}

fn line_count(env: &Env) -> i64 {
    one(&env.store, "SELECT COUNT(*) AS n FROM lines")["n"].as_i64().unwrap()
}

#[test]
fn append_duplicate_gap_and_conflict() {
    let env = env();
    let lines = fixture("session.jsonl");
    let at = |n: usize| byte_len(&lines[..n]);

    let r = ingest(&env.store, json!({ "streams": [stream(KEY, "session", 0, &lines[..3])] })).unwrap();
    assert_eq!(r.streams[KEY].length, at(3));

    // A resend of committed lines is a no-op; lines past the committed length are appended.
    let r = ingest(&env.store, json!({ "streams": [stream(KEY, "session", 0, &lines[..3])] })).unwrap();
    assert_eq!(r.streams[KEY].length, at(3));
    let r = ingest(&env.store, json!({ "streams": [stream(KEY, "session", at(1), &lines[1..5])] })).unwrap();
    assert_eq!(r.streams[KEY].length, at(5));
    assert_eq!(line_count(&env), 5);

    // A gap reports the committed length; resending from it succeeds.
    match ingest(&env.store, json!({ "streams": [stream(KEY, "session", at(7), &lines[7..])] })) {
        Err(IngestError::Gap { key, length }) => assert_eq!((key.as_str(), length), (KEY, at(5))),
        other => panic!("expected a gap, got {other:?}"),
    }
    let r = ingest(&env.store, json!({ "streams": [stream(KEY, "session", at(5), &lines[5..])] })).unwrap();
    assert_eq!(r.streams[KEY].length, at(lines.len()));

    // Different bytes below the committed length conflict, as does an offset inside a line.
    let mut changed = lines[2].clone();
    changed.push(' ');
    match ingest(&env.store, json!({ "streams": [stream(KEY, "session", at(2), &[changed])] })) {
        Err(IngestError::Conflict { key, length }) => assert_eq!((key.as_str(), length), (KEY, at(lines.len()))),
        other => panic!("expected a conflict, got {other:?}"),
    }
    let r = ingest(&env.store, json!({ "streams": [stream(KEY, "session", 1, &lines[..1])] }));
    assert!(matches!(r, Err(IngestError::Conflict { .. })), "{r:?}");

    assert_eq!(line_count(&env), lines.len() as i64);
    assert_eq!(export(&env, SESSION_ID), joined(&lines));
}

#[test]
fn a_rejected_batch_changes_nothing() {
    let env = env();
    let lines = fixture("session.jsonl");
    let goal = json!({ "key": "herder:r1:goal.md", "kind": "herder-goal", "runId": "r1", "content": "goal" });
    let r = ingest(
        &env.store,
        json!({
            "streams": [stream("session:other", "session", 0, &lines[..2]), stream(KEY, "session", 10, &lines[..1])],
            "documents": [goal],
        }),
    );
    assert!(matches!(r, Err(IngestError::Gap { length: 0, .. })), "{r:?}");
    for table in ["streams", "lines", "sessions", "entries", "documents"] {
        assert_eq!(one(&env.store, &format!("SELECT COUNT(*) AS n FROM {table}"))["n"], 0, "{table}");
    }
}

#[test]
fn rejects_malformed_batches() {
    let env = env();
    let bad = [
        json!({ "streams": [{ "key": "herder:x", "kind": "session", "offset": 0, "lines": [] }] }),
        json!({ "streams": [{ "key": "session:x", "kind": "nope", "offset": 0, "lines": [] }] }),
        json!({ "streams": [{ "key": "session:x", "kind": "session", "offset": 0, "lines": ["a\nb"] }] }),
        json!({ "blobs": [{ "hash": sha256_hex(b"x"), "data": "y" }] }),
        json!({ "blobs": [{ "hash": "../../etc/passwd", "data": "y" }] }),
        json!({ "requests": [{ "id": "r", "sessionId": "s", "fidelity": "payload",
                               "skeleton": { "messages": [{ "$pika": "zz" }] }, "blocks": [] }] }),
    ];
    for batch in bad {
        let r = ingest(&env.store, batch.clone());
        assert!(matches!(r, Err(IngestError::BadRequest(_))), "{batch}: {r:?}");
    }
}

fn request(id: &str, session: &str, skeleton: &Value, blocks: &[(String, String)], ts: i64) -> Value {
    json!({
        "id": id, "sessionId": session, "seq": 1, "at": "2026-10-20T09:00:02.400Z", "fidelity": "payload",
        "provider": "anthropic", "api": "anthropic-messages", "model": "claude-sonnet-4-5",
        "assistant": { "timestamp": ts }, "skeleton": skeleton,
        "blocks": blocks.iter().map(|(h, _)| h.clone()).collect::<Vec<_>>(),
    })
}

fn blobs(blocks: &[(String, String)]) -> Value {
    blocks.iter().map(|(hash, data)| json!({ "hash": hash, "data": data })).collect()
}

fn nested_payload() -> Value {
    json!({
        "model": "claude-sonnet-4-5",
        "max_tokens": 8192,
        "stream": true,
        "system": [{ "type": "text", "text": "You are pika's test.", "cache_control": { "type": "ephemeral" } }],
        "messages": [
            { "role": "user", "content": [{ "type": "text", "text": "héllo 👋 世界" }, { "type": "image", "source": { "data": "aGk=" } }] },
            { "role": "assistant", "content": [{ "type": "tool_use", "id": "t1", "input": { "nested": [1, 2.5, -3e-7, null, true, { "deep": [[]] }] } }] },
            { "role": "user", "content": [{ "type": "tool_result", "tool_use_id": "t1", "content": "x".repeat(5000) }] },
            { "role": "user", "content": "duplicate" },
            { "role": "user", "content": "duplicate" },
        ],
        "tools": [],
        "instructions": "long ".repeat(600),
        "metadata": { "user_id": "abc", "tags": ["a", "b"] },
        "temperature": 0.7,
        "tool_choice": null,
    })
}

#[test]
fn request_split_and_reconstruct() {
    let payload = nested_payload();
    let (skeleton, blocks) = requests::split(&payload);
    assert_eq!(skeleton["model"], "claude-sonnet-4-5");
    assert_eq!(skeleton["metadata"], payload["metadata"]);
    assert_eq!(skeleton["instructions"]["$type"], "string");
    assert_eq!(skeleton["messages"][3], skeleton["messages"][4]);
    assert_eq!(blocks.len(), 1 + 4 + 1);
    let rebuilt = requests::reconstruct(&skeleton, &mut |hash| {
        Ok(blocks.iter().find(|(h, _)| h == hash).unwrap().1.clone())
    })
    .unwrap();
    assert_eq!(rebuilt, payload);

    // The same through the store.
    let env = env();
    let r = ingest(
        &env.store,
        json!({ "blobs": blobs(&blocks), "requests": [request("req-1", "s1", &skeleton, &blocks, 1)] }),
    )
    .unwrap();
    assert!(r.missing_blobs.is_empty());
    let stored = env.store.read(|conn| requests::load(conn, &env.store.blobs, "req-1")).unwrap().unwrap();
    assert!(stored.complete);
    assert_eq!(stored.fidelity, "payload");
    assert_eq!(parsed(&stored.payload), payload);
}

#[test]
fn requests_blobs_and_documents_are_idempotent() {
    let env = env();
    let (skeleton, blocks) = requests::split(&nested_payload());
    let batch = json!({
        "blobs": blobs(&blocks),
        "requests": [request("req-1", "s1", &skeleton, &blocks, 1)],
        "documents": [{ "key": "herder:r1:goal.md", "kind": "herder-goal", "runId": "r1", "content": "v1", "sha256": sha256_hex(b"v1") }],
    });
    ingest(&env.store, batch.clone()).unwrap();
    let before = query(&env.store, "SELECT * FROM documents");
    let counts = |store| {
        ["requests", "blobs", "request_dict", "documents"]
            .map(|t| one(store, &format!("SELECT COUNT(*) AS n FROM {t}"))["n"].as_i64().unwrap())
    };
    let first = counts(&env.store);
    let files = std::fs::read_dir(env.dir.path().join("data/blobs")).unwrap().count();
    let r = ingest(&env.store, batch).unwrap();
    assert!(r.missing_blobs.is_empty());
    assert_eq!(counts(&env.store), first);
    assert_eq!(std::fs::read_dir(env.dir.path().join("data/blobs")).unwrap().count(), files);
    assert_eq!(query(&env.store, "SELECT * FROM documents"), before);

    // A document with a new sha256 replaces the old one.
    ingest(
        &env.store,
        json!({ "documents": [{ "key": "herder:r1:goal.md", "kind": "herder-goal", "content": "v2", "sha256": sha256_hex(b"v2") }] }),
    )
    .unwrap();
    let doc = one(&env.store, "SELECT content, run_id FROM documents");
    assert_eq!((doc["content"].as_str(), doc["run_id"].as_str()), (Some("v2"), Some("r1")));
}

#[test]
fn missing_blobs_complete_the_request_when_they_arrive() {
    let env = env();
    let payload = nested_payload();
    let (skeleton, blocks) = requests::split(&payload);
    let mut all: Vec<String> = blocks.iter().map(|(h, _)| h.clone()).collect();
    all.sort();

    let r = ingest(&env.store, json!({ "requests": [request("req-1", "s1", &skeleton, &blocks, 1)] })).unwrap();
    assert_eq!(r.missing_blobs, all);
    let load = || env.store.read(|conn| requests::load(conn, &env.store.blobs, "req-1")).unwrap().unwrap();
    let partial = load();
    assert!(!partial.complete);
    assert_eq!(parsed(&partial.payload)["messages"][0]["$pika"], blocks[1].0);

    let (first, rest) = blocks.split_at(2);
    let r = ingest(&env.store, json!({ "blobs": blobs(first) })).unwrap();
    assert!(r.missing_blobs.is_empty());
    assert!(!load().complete);
    // Resending the request reports what it still lacks.
    let r = ingest(&env.store, json!({ "requests": [request("req-1", "s1", &skeleton, &blocks, 1)] })).unwrap();
    let mut lacking: Vec<String> = rest.iter().map(|(h, _)| h.clone()).collect();
    lacking.sort();
    assert_eq!(r.missing_blobs, lacking);

    ingest(&env.store, json!({ "blobs": blobs(rest) })).unwrap();
    let done = load();
    assert!(done.complete);
    assert_eq!(parsed(&done.payload), payload);
}

/// Deterministic prose so that blocks compress like real text.
/// `request` with a `timing` field.
fn timed(id: &str, skeleton: &Value, blocks: &[(String, String)], timing: Value) -> Value {
    let mut r = request(id, "s1", skeleton, blocks, 1);
    r["timing"] = timing;
    r
}

#[test]
fn request_timing_is_stored_and_invalid_keys_are_dropped() {
    let env = env();
    let (skeleton, blocks) = requests::split(&nested_payload());
    let full = json!({ "sentAt": 1792486802510_i64, "responseAt": 1792486802900_i64, "firstTokenAt": 1792486803400_i64,
                       "firstToken": "thinking", "ttfb": 3 });
    let mixed = json!({ "sentAt": "1792486802510", "responseAt": 1792486802900.5, "firstTokenAt": 1792486803400_i64,
                        "firstToken": "audio" });
    let batch = json!({
        "blobs": blobs(&blocks),
        "requests": [
            timed("req-full", &skeleton, &blocks, full),
            timed("req-mixed", &skeleton, &blocks, mixed),
            timed("req-invalid", &skeleton, &blocks, json!({ "sentAt": -1, "responseAt": 253_402_300_800_000_i64, "firstToken": null })),
            timed("req-array", &skeleton, &blocks, json!([1792486802510_i64])),
            timed("req-null", &skeleton, &blocks, Value::Null),
            request("req-none", "s1", &skeleton, &blocks, 1),
        ],
    });
    // Invalid timing never rejects its request.
    assert!(ingest(&env.store, batch).unwrap().missing_blobs.is_empty());
    let timing = |store| -> Vec<(String, Value)> {
        query(store, "SELECT id, timing FROM requests ORDER BY id")
            .into_iter()
            .map(|r| (r["id"].as_str().unwrap().to_owned(), r["timing"].as_str().map_or(Value::Null, |t| serde_json::from_str(t).unwrap())))
            .collect()
    };
    let stored = vec![
        ("req-array".into(), Value::Null),
        ("req-full".into(), json!({ "sentAt": 1792486802510_i64, "responseAt": 1792486802900_i64, "firstTokenAt": 1792486803400_i64, "firstToken": "thinking" })),
        ("req-invalid".into(), Value::Null),
        ("req-mixed".into(), json!({ "firstTokenAt": 1792486803400_i64 })),
        ("req-none".into(), Value::Null),
        ("req-null".into(), Value::Null),
    ];
    assert_eq!(timing(&env.store), stored);

    // A resend is a no-op, timing included, as for every other request field.
    let resend = json!({ "requests": [timed("req-none", &skeleton, &blocks, json!({ "sentAt": 5 })),
                                      timed("req-full", &skeleton, &blocks, json!({ "sentAt": 6 }))] });
    ingest(&env.store, resend).unwrap();
    assert_eq!(timing(&env.store), stored);
}

#[test]
fn upgrading_from_version_5_adds_request_timing_without_a_reindex() {
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");
    let (skeleton, blocks) = requests::split(&nested_payload());
    let derived = {
        let store = pika::store::Store::open(&data).unwrap();
        upload(&store, KEY, "session", &fixture("session.jsonl"), 50);
        ingest(&store, json!({ "blobs": blobs(&blocks), "requests": [request("req-old", "s1", &skeleton, &blocks, 1)] })).unwrap();
        dump_derived(&store)
    };
    let conn = rusqlite::Connection::open(data.join("pika.db")).unwrap();
    conn.execute_batch(&format!("{UNDO_V6} PRAGMA user_version = 5;")).unwrap();
    drop(conn);

    let store = pika::store::Store::open(&data).unwrap();
    let version: i64 = store.read(|c| c.pragma_query_value(None, "user_version", |r| r.get(0))).unwrap();
    assert_eq!(version, 6);
    assert_eq!(store.setting("needs_reindex").unwrap(), None);
    assert_eq!(dump_derived(&store), derived);
    assert_eq!(one(&store, "SELECT timing FROM requests")["timing"], Value::Null);
    ingest(&store, json!({ "requests": [timed("req-new", &skeleton, &blocks, json!({ "sentAt": 7 }))] })).unwrap();
    assert_eq!(one(&store, "SELECT timing FROM requests WHERE id = 'req-new'")["timing"], r#"{"sentAt":7}"#);
}

fn prose(seed: u64, words: usize) -> String {
    const WORDS: &[&str] = &[
        "the", "session", "agent", "tool", "returned", "file", "error", "function", "test", "build", "value", "branch",
        "request", "model", "cache", "parser", "struct", "async", "index", "query", "token", "commit", "review", "fix",
    ];
    let mut state = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
    (0..words)
        .map(|_| {
            state = state.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            WORDS[(state >> 33) as usize % WORDS.len()]
        })
        .collect::<Vec<_>>()
        .join(" ")
}

#[test]
fn growing_contexts_store_under_twice_their_distinct_bytes() {
    let env = env();
    let tools: Vec<Value> = (0..6)
        .map(|i| json!({ "name": format!("tool{i}"), "description": prose(100 + i, 40), "input_schema": { "type": "object" } }))
        .collect();
    let messages: Vec<Value> = (0..50)
        .map(|i| {
            let role = if i % 2 == 0 { "user" } else { "assistant" };
            json!({ "role": role, "content": [{ "type": "text", "text": prose(i, 60 + (i as usize * 37) % 300) }] })
        })
        .collect();
    let system = prose(999, 900);
    let mut acknowledged = std::collections::HashSet::new();
    let mut distinct: std::collections::BTreeMap<String, usize> = Default::default();
    let mut last = Value::Null;
    for i in 0..50 {
        let payload = json!({
            "model": "claude-sonnet-4-5", "max_tokens": 4096, "system": system,
            "messages": messages[..=i], "tools": tools, "stream": true,
        });
        let (skeleton, blocks) = requests::split(&payload);
        let new: Vec<(String, String)> = blocks.iter().filter(|(h, _)| !acknowledged.contains(h)).cloned().collect();
        for (hash, data) in &blocks {
            distinct.insert(hash.clone(), data.len());
        }
        let r = ingest(
            &env.store,
            json!({ "blobs": blobs(&new), "requests": [request(&format!("req-{i}"), "s1", &skeleton, &blocks, i as i64)] }),
        )
        .unwrap();
        assert!(r.missing_blobs.is_empty());
        acknowledged.extend(blocks.into_iter().map(|(h, _)| h));
        last = payload;
    }
    let distinct_bytes: usize = distinct.values().sum();
    let files: i64 = one(&env.store, "SELECT SUM(stored) AS n FROM blobs")["n"].as_i64().unwrap();
    let skeletons: i64 = one(&env.store, "SELECT SUM(LENGTH(skeleton)) AS n FROM requests")["n"].as_i64().unwrap();
    let dict: i64 = one(&env.store, "SELECT SUM(LENGTH(hash)) AS n FROM request_dict")["n"].as_i64().unwrap();
    let on_disk: u64 = walk(&env.dir.path().join("data/blobs"));
    assert_eq!(on_disk as i64, files);
    let stored = files + skeletons + dict;
    eprintln!("stored {stored} bytes (blobs {files}, skeletons {skeletons}, dict {dict}) for {distinct_bytes} distinct");
    assert!((stored as usize) < 2 * distinct_bytes, "stored {stored} >= 2 x {distinct_bytes}");

    let stored = env.store.read(|conn| requests::load(conn, &env.store.blobs, "req-49")).unwrap().unwrap();
    assert_eq!(parsed(&stored.payload), last);
}

fn walk(dir: &std::path::Path) -> u64 {
    std::fs::read_dir(dir)
        .unwrap()
        .map(|e| {
            let e = e.unwrap();
            if e.file_type().unwrap().is_dir() { walk(&e.path()) } else { e.metadata().unwrap().len() }
        })
        .sum()
}

#[test]
fn export_is_byte_identical_with_unicode_and_large_lines() {
    let env = env();
    let id = "big-1";
    let big_text: String = "ünïcødé 🦀 漢字 e\u{301} ".chars().cycle().take(700_000).collect();
    let lines = vec![
        json!({ "type": "session", "version": 3, "id": id, "timestamp": "2026-10-20T09:00:00.000Z", "cwd": "/tmp/ü" }).to_string(),
        r#"{"type":"message","id":"b1","parentId":null,"timestamp":"2026-10-20T09:00:01.000Z","message":{"role":"user","content":"\u00e9 é \ud83e\udd80 🦀 \"q\"","timestamp":1}}"#.to_owned(),
        json!({ "type": "message", "id": "b2", "parentId": "b1", "timestamp": "2026-10-20T09:00:02.000Z",
                "message": { "role": "toolResult", "toolCallId": "c", "toolName": "read",
                             "content": [{ "type": "text", "text": big_text }], "isError": false, "timestamp": 2 } })
        .to_string(),
        "  {\"type\":\"custom\" , \"spacing\":  \"kept\"}\t".to_owned(),
    ];
    assert!(lines[2].len() > 1 << 20);
    let key = format!("session:{id}");
    upload(&env.store, &key, "session", &lines, 2);
    let big = one(&env.store, "SELECT data IS NULL AS blob FROM lines WHERE offset > 0 ORDER BY LENGTH(blob) DESC LIMIT 1");
    assert_eq!(big["blob"], 1);
    // The large line deduplicates against its blob.
    let r = ingest(&env.store, json!({ "streams": [stream(&key, "session", byte_len(&lines[..2]), &lines[2..3])] })).unwrap();
    assert_eq!(r.streams[&key].length, byte_len(&lines));
    assert_eq!(export(&env, id), joined(&lines));
}
