//! Schema v26 migration, memory tiers (`pinned` | `archival`), per-scope archival cap (`MAX_ARCHIVAL_NOTES_PER_SCOPE`),
//! index-only view (`GET /api/agent/v1/memory?view=index`), per-scope write accounting (`scopeIndexBytes` /
//! `scopeIndexLines` and 422 `budget: "per_scope"`), lexical FTS5 (`pika_cjk`) + substring `GET memory/search`,
//! and owner `ScopeSummary` budget fields. Every credential here is made up.

mod common;

use axum::Router;
use axum::body::Body;
use axum::http::{Method, Request, StatusCode, header};
use common::*;
use pika::config::{AuthMode, ServerConfig};
use pika::http::{AppState, router};
use pika::memory::{LIMIT_BYTES, LIMIT_LINES, MAX_ARCHIVAL_NOTES_PER_SCOPE, SEARCH_DEFAULT_LIMIT};
use pika::store::Store;
use serde_json::{Value, json};

const REPO: &str = "https://github.com/me/widgets";
const KEY: &str = "repo:https://github.com/me/widgets";

struct App {
    env: Env,
    app: Router,
    token: String,
}

impl App {
    fn new() -> App {
        let env = env();
        let token = device(&env.store, DEVICE);
        let mut config = ServerConfig::new(env.dir.path().join("data"));
        config.auth = AuthMode::None;
        let state = AppState::new(env.store.clone(), config).unwrap();
        App { env, app: router(state), token }
    }

    async fn call(&self, method: Method, path: &str, token: Option<&str>, body: Option<Value>) -> Reply {
        let mut req = Request::builder().method(method).uri(path);
        if let Some(tok) = token {
            req = req.header(header::AUTHORIZATION, format!("Bearer {tok}"));
        }
        let body = match body {
            Some(v) => {
                req = req.header(header::CONTENT_TYPE, "application/json");
                Body::from(v.to_string())
            }
            None => Body::empty(),
        };
        send(&self.app, req.body(body).unwrap()).await
    }

    async fn save(&self, body: Value) -> Reply {
        self.call(Method::POST, "/api/agent/v1/memory/notes", Some(&self.token), Some(body)).await
    }

    async fn saved(&self, body: Value) -> Value {
        let r = self.save(body).await;
        assert_eq!(r.status, StatusCode::OK, "{}", r.text());
        r.json()["note"].clone()
    }

    async fn forget(&self, id: &str, body: Value) -> Reply {
        self.call(Method::POST, &format!("/api/agent/v1/memory/notes/{id}/forget"), Some(&self.token), Some(body)).await
    }

    async fn memory_reply(&self, query: &str) -> Reply {
        let path = if query.is_empty() { "/api/agent/v1/memory".into() } else { format!("/api/agent/v1/memory?{query}") };
        self.call(Method::GET, &path, Some(&self.token), None).await
    }

    async fn memory(&self, query: &str) -> Value {
        let r = self.memory_reply(query).await;
        assert_eq!(r.status, StatusCode::OK, "{query}: {}", r.text());
        r.json()
    }

    async fn search(&self, query: &str) -> Reply {
        self.call(Method::GET, &format!("/api/agent/v1/memory/search?{query}"), Some(&self.token), None).await
    }

    async fn owner(&self, method: Method, path: &str, body: Option<Value>) -> Reply {
        self.call(method, &format!("/api/v1/{path}"), None, body).await
    }

    fn count(&self, sql: &str) -> i64 {
        one(&self.env.store, sql).into_values().next().unwrap().as_i64().unwrap()
    }
}

fn ingest_turn_session(store: &Store, id: &str, user_text: &str, final_text: &str) {
    let lines = vec![
        json!({
            "type": "session",
            "version": 3,
            "id": id,
            "timestamp": "2026-10-20T09:00:00.000Z",
            "cwd": "/w/widgets"
        })
        .to_string(),
        json!({
            "type": "message",
            "id": "u1",
            "parentId": null,
            "timestamp": "2026-10-20T09:00:02.000Z",
            "message": { "role": "user", "content": user_text, "timestamp": 1_792_486_802_000_i64 }
        })
        .to_string(),
        json!({
            "type": "message",
            "id": "a1",
            "parentId": "u1",
            "timestamp": "2026-10-20T09:00:05.000Z",
            "message": {
                "role": "assistant",
                "content": [{ "type": "text", "text": final_text }],
                "timestamp": 1_792_486_805_000_i64,
                "provider": "openai",
                "model": "gpt-5",
                "stopReason": "stop",
                "usage": { "input": 10, "output": 5, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 15, "cost": { "total": 0.0 } }
            }
        })
        .to_string(),
    ];
    let batch = json!({
        "streams": [{
            "key": format!("session:{id}"),
            "kind": "session",
            "offset": 0,
            "lines": lines,
            "meta": { "sessionId": id, "cwd": "/w/widgets", "project": "widgets", "repository": REPO }
        }]
    });
    ingest(store, batch).unwrap();
}

/// Upgrading from schema v25 adds `tier` defaulting to `'pinned'` on existing notes and revisions, backfills live
/// notes (and not forgotten ones) into `memory_notes_fts`, and runs no reindex.
#[tokio::test]
async fn schema_v26_migrates_existing_notes_and_backfills_fts_without_reindex() {
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");
    let derived_gen = {
        let store = Store::open(&data).unwrap();
        let gen_before = store.setting(pika::store::DERIVED_GENERATION).unwrap();
        drop(store);
        let conn = rusqlite::Connection::open(data.join("pika.db")).unwrap();
        rewind(&conn, 25);
        conn.execute_batch(
            "INSERT INTO memory_scopes (key, kind, label, created_at, updated_at)
             VALUES ('user', 'user', 'user', 100, 100);
             INSERT INTO memory_notes (id, scope_key, category, title, hook, body, provenance, revision,
                 created_at, updated_at, deleted_at, device_id, session_id, sources, last_used_at)
             VALUES
                 ('live00000001', 'user', 'feedback', 'SQLite WAL', 'always enable WAL mode', 'Use WAL for concurrency',
                  'agent', 1, 100, 100, NULL, 'laptop', NULL, '[]', NULL),
                 ('gone00000002', 'user', 'feedback', 'Forgotten Note', 'should not backfill', 'obsolete secret',
                  'agent', 2, 100, 110, 110, 'laptop', NULL, '[]', NULL);
             INSERT INTO memory_revisions (note_id, revision, action, category, title, hook, body, at,
                 device_id, session_id, reason, provenance, sources, batch_id)
             VALUES
                 ('live00000001', 1, 'save', 'feedback', 'SQLite WAL', 'always enable WAL mode', 'Use WAL for concurrency',
                  100, 'laptop', NULL, NULL, 'agent', '[]', NULL);",
        )
        .unwrap();
        gen_before
    };

    let store = Store::open(&data).unwrap();
    assert_eq!(one(&store, "PRAGMA user_version")["user_version"], json!(SCHEMA_VERSION));
    assert_eq!(store.setting(pika::store::NEEDS_REINDEX).unwrap(), None);
    assert_eq!(store.setting(pika::store::DERIVED_GENERATION).unwrap(), derived_gen);

    // Existing rows default to `tier = 'pinned'`.
    assert_eq!(one(&store, "SELECT tier FROM memory_notes WHERE id = 'live00000001'")["tier"], json!("pinned"));
    assert_eq!(one(&store, "SELECT tier FROM memory_revisions WHERE note_id = 'live00000001'")["tier"], json!("pinned"));

    // Only live notes are backfilled into `memory_notes_fts`.
    assert_eq!(one(&store, "SELECT COUNT(*) AS n FROM memory_notes_fts")["n"], json!(1));
    assert_eq!(
        one(&store, "SELECT note_id FROM memory_notes_fts WHERE memory_notes_fts MATCH '\"concurrency\"'")["note_id"],
        json!("live00000001")
    );
    assert_eq!(
        one(&store, "SELECT COUNT(*) AS n FROM memory_notes_fts WHERE memory_notes_fts MATCH '\"obsolete\"'")["n"],
        json!(0)
    );
}

/// Pinned vs archival tiers: defaults, update preservation, index & budget exclusion, demotion freeing budget,
/// promotion enforcing budget, validation, owner `ScopeSummary` fields, and dream save + revert restoring `tier`.
#[tokio::test]
async fn tiers_control_index_budget_owner_summary_and_dream_revert() {
    let app = App::new();

    // Invalid tier is rejected with 400.
    let bad = app
        .save(json!({
            "expectedRevision": 0, "scope": "user", "category": "feedback", "tier": "ephemeral",
            "title": "Bad", "hook": "bad tier", "body": ""
        }))
        .await;
    assert_eq!(bad.status, StatusCode::BAD_REQUEST);

    // Default create is `pinned`.
    let pinned = app
        .saved(json!({
            "expectedRevision": 0, "scope": "user", "category": "feedback",
            "title": "Pinned Rule", "hook": "always in index", "body": "body"
        }))
        .await;
    assert_eq!(pinned["tier"], json!("pinned"));

    // Explicit `archival` create is stored live, excluded from index, and kept on updates when `tier` is omitted.
    let archival = app
        .saved(json!({
            "expectedRevision": 0, "scope": "user", "category": "reference", "tier": "archival",
            "title": "Deep Reference", "hook": "searchable only", "body": "long details"
        }))
        .await;
    assert_eq!(archival["tier"], json!("archival"));
    let archival_id = archival["id"].as_str().unwrap().to_owned();

    let view = app.memory("").await;
    assert_eq!(view["notes"].as_array().unwrap().len(), 2);
    assert_eq!(view["tiers"], json!(true));
    assert_eq!(view["archivalCount"], json!(1));
    assert_eq!(view["archivalCounts"], json!({ "user": 1, "project": 0 }));
    let idx = view["index"].as_str().unwrap();
    assert!(idx.contains("Pinned Rule"), "{idx}");
    assert!(!idx.contains("Deep Reference"), "archival note must not appear in index: {idx}");

    // Update omitting `tier` preserves `archival`.
    let updated_archival = app
        .saved(json!({
            "id": archival_id, "expectedRevision": 1, "scope": "user", "category": "reference",
            "title": "Deep Reference v2", "hook": "still archival", "body": "updated details"
        }))
        .await;
    assert_eq!(updated_archival["tier"], json!("archival"));

    // Fill the project scope's pinned budget close to LIMIT_BYTES (8192) so one more pinned note overflows.
    let mut last_pinned_id = String::new();
    let mut last_pinned_rev = 0;
    let big_title = "T".repeat(100);
    let big_hook = "H".repeat(130);
    for i in 0..40 {
        let r = app
            .save(json!({
                "expectedRevision": 0, "scope": "project", "project": "widgets", "repository": REPO,
                "category": "project", "title": format!("{i:02}-{big_title}"), "hook": big_hook, "body": ""
            }))
            .await;
        if r.status == StatusCode::UNPROCESSABLE_ENTITY {
            let body = r.json();
            assert_eq!(body["error"], json!("memory_full"));
            assert_eq!(body["budget"], json!("per_scope"));
            break;
        }
        assert_eq!(r.status, StatusCode::OK, "{}", r.text());
        last_pinned_id = r.json()["note"]["id"].as_str().unwrap().to_owned();
        last_pinned_rev = r.json()["note"]["revision"].as_i64().unwrap();
    }
    assert!(!last_pinned_id.is_empty());

    // While project pinned budget is full, saving a new `archival` note in that project succeeds.
    let extra_archival = app
        .saved(json!({
            "expectedRevision": 0, "scope": "project", "project": "widgets", "repository": REPO,
            "category": "project", "tier": "archival",
            "title": format!("arch-{big_title}"), "hook": big_hook, "body": "archival body"
        }))
        .await;
    assert_eq!(extra_archival["tier"], json!("archival"));
    let extra_archival_id = extra_archival["id"].as_str().unwrap().to_owned();

    // Promoting that archival note to pinned fails with 422 `memory_full` and `"budget": "per_scope"`.
    let promote_fail = app
        .save(json!({
            "id": extra_archival_id, "expectedRevision": 1, "scope": "project", "project": "widgets", "repository": REPO,
            "category": "project", "tier": "pinned",
            "title": format!("arch-{big_title}"), "hook": big_hook, "body": "archival body"
        }))
        .await;
    assert_eq!(promote_fail.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(promote_fail.json()["error"], json!("memory_full"));
    assert_eq!(promote_fail.json()["budget"], json!("per_scope"));

    // Demoting a pinned note to archival immediately frees budget so promotion succeeds.
    let demoted = app
        .saved(json!({
            "id": last_pinned_id, "expectedRevision": last_pinned_rev, "scope": "project", "project": "widgets", "repository": REPO,
            "category": "project", "tier": "archival",
            "title": format!("demoted-{big_title}"), "hook": big_hook, "body": ""
        }))
        .await;
    assert_eq!(demoted["tier"], json!("archival"));

    let promoted = app
        .saved(json!({
            "id": extra_archival_id, "expectedRevision": 1, "scope": "project", "project": "widgets", "repository": REPO,
            "category": "project", "tier": "pinned",
            "title": format!("arch-{big_title}"), "hook": big_hook, "body": "promoted"
        }))
        .await;
    assert_eq!(promoted["tier"], json!("pinned"));

    // Owner `GET /api/v1/memory` reports pinnedCount, archivalCount, indexBytes, indexLines, limitBytes, limitLines.
    let scopes_reply = app.owner(Method::GET, "memory", None).await;
    assert_eq!(scopes_reply.status, StatusCode::OK);
    let scopes = scopes_reply.json()["scopes"].as_array().unwrap().clone();
    let user_scope = scopes.iter().find(|s| s["key"] == "user").unwrap();
    assert_eq!(user_scope["noteCount"], json!(2));
    assert_eq!(user_scope["pinnedCount"], json!(1));
    assert_eq!(user_scope["archivalCount"], json!(1));
    assert_eq!(user_scope["limitBytes"], json!(LIMIT_BYTES));
    assert_eq!(user_scope["limitLines"], json!(LIMIT_LINES));
    assert!(user_scope["indexBytes"].as_u64().unwrap() > 0);
    assert_eq!(user_scope["indexLines"], json!(3)); // `# User memory`, `## feedback`, `- Pinned Rule ...`

    let proj_scope = scopes.iter().find(|s| s["key"] == KEY).unwrap();
    assert_eq!(proj_scope["archivalCount"], json!(1));
    assert_eq!(proj_scope["noteCount"].as_i64().unwrap(), proj_scope["pinnedCount"].as_i64().unwrap() + 1);
    assert!(proj_scope["indexBytes"].as_u64().unwrap() <= LIMIT_BYTES as u64);
    assert!(proj_scope["indexLines"].as_u64().unwrap() <= LIMIT_LINES as u64);
    assert_eq!(proj_scope["limitBytes"], json!(LIMIT_BYTES));
    assert_eq!(proj_scope["limitLines"], json!(LIMIT_LINES));

    // Dream save can demote/promote tier, and owner batch revert restores the previous tier.
    ingest_turn_session(&app.env.store, "dream-src-1", "refactor build", "done");
    let lease_r = app
        .call(
            Method::POST,
            "/api/agent/v1/memory/dream/lease",
            Some(&app.token),
            Some(json!({ "project": "widgets", "repository": REPO, "mode": "manual" })),
        )
        .await;
    assert_eq!(lease_r.status, StatusCode::OK, "{}", lease_r.text());
    let lease_id = lease_r.json()["lease"]["id"].as_str().unwrap().to_owned();

    let commit_r = app
        .call(
            Method::POST,
            &format!("/api/agent/v1/memory/dream/{lease_id}/commit"),
            Some(&app.token),
            Some(json!({
                "sessions": ["dream-src-1"],
                "changes": [{
                    "op": "save",
                    "id": extra_archival_id,
                    "expectedRevision": 2,
                    "scope": "project",
                    "category": "project",
                    "tier": "archival",
                    "title": "Dream demoted",
                    "hook": "moved to archival by dream",
                    "body": "body",
                    "sources": [{ "sessionId": "dream-src-1", "seq": 1 }]
                }]
            })),
        )
        .await;
    assert_eq!(commit_r.status, StatusCode::OK, "{}", commit_r.text());
    let batch_id = commit_r.json()["batch"]["id"].as_str().unwrap().to_owned();
    assert_eq!(
        one(&app.env.store, &format!("SELECT tier FROM memory_notes WHERE id = '{extra_archival_id}'"))["tier"],
        json!("archival")
    );

    let revert_r = app
        .owner(Method::POST, &format!("memory/batches/{batch_id}/revert"), Some(json!({})))
        .await;
    assert_eq!(revert_r.status, StatusCode::OK, "{}", revert_r.text());
    assert_eq!(
        one(&app.env.store, &format!("SELECT tier FROM memory_notes WHERE id = '{extra_archival_id}'"))["tier"],
        json!("pinned")
    );
}

/// `MAX_ARCHIVAL_NOTES_PER_SCOPE` (500) is enforced independently per scope in `save` and atomically in `dream::commit`,
/// allowing an atomic forget+archive swap at the cap and shrink-only edits if already over cap.
#[tokio::test]
async fn archival_cap_enforced_per_scope_and_atomically_in_dreams() {
    let app = App::new();

    // Seed 500 live archival notes in project scope directly for speed.
    app.env
        .store
        .write(|tx| {
            tx.execute(
                "INSERT INTO memory_scopes (key, kind, label, created_at, updated_at) VALUES (?1, 'project', 'widgets', 100, 100)",
                [KEY],
            )?;
            for i in 0..MAX_ARCHIVAL_NOTES_PER_SCOPE {
                let id = format!("arch{i:08x}");
                tx.execute(
                    "INSERT INTO memory_notes (id, scope_key, category, tier, title, hook, body, provenance, revision,
                         created_at, updated_at, deleted_at, device_id, session_id, sources, last_used_at)
                     VALUES (?1, ?2, 'project', 'archival', ?3, ?4, '', 'agent', 1, 100, 100, NULL, ?5, NULL, '[]', NULL)",
                    rusqlite::params![id, KEY, format!("Arch {i}"), format!("hook {i}"), DEVICE],
                )?;
                tx.execute(
                    "INSERT INTO memory_revisions (note_id, revision, action, category, tier, title, hook, body, at,
                         device_id, session_id, reason, provenance, sources, batch_id)
                     VALUES (?1, 1, 'save', 'project', 'archival', ?2, ?3, '', 100, ?4, NULL, NULL, 'agent', '[]', NULL)",
                    rusqlite::params![id, format!("Arch {i}"), format!("hook {i}"), DEVICE],
                )?;
                tx.execute(
                    "INSERT INTO memory_notes_fts (note_id, title, hook, body) VALUES (?1, ?2, ?3, '')",
                    rusqlite::params![id, format!("Arch {i}"), format!("hook {i}")],
                )?;
            }
            Ok::<_, rusqlite::Error>(())
        })
        .unwrap();

    // 501st archival note in project scope fails with 400.
    let expected_msg = format!(
        "archival limit reached ({MAX_ARCHIVAL_NOTES_PER_SCOPE} notes per scope); forget obsolete archival notes first"
    );
    let over = app
        .save(json!({
            "expectedRevision": 0, "scope": "project", "project": "widgets", "repository": REPO,
            "category": "project", "tier": "archival",
            "title": "Over Cap", "hook": "should fail", "body": ""
        }))
        .await;
    assert_eq!(over.status, StatusCode::BAD_REQUEST, "{}", over.text());
    assert_eq!(over.json()["message"], json!(expected_msg));
    assert_eq!(
        app.count(&format!("SELECT COUNT(*) FROM memory_notes WHERE scope_key = '{KEY}' AND deleted_at IS NULL AND tier = 'archival'")),
        MAX_ARCHIVAL_NOTES_PER_SCOPE as i64
    );

    // Updating an existing archival note in-place when at cap still succeeds (count stays 500).
    let updated = app
        .save(json!({
            "id": "arch00000000", "expectedRevision": 1, "scope": "project", "project": "widgets", "repository": REPO,
            "category": "project", "tier": "archival",
            "title": "Arch 0 updated", "hook": "still at cap", "body": "updated"
        }))
        .await;
    assert_eq!(updated.status, StatusCode::OK, "{}", updated.text());

    // Saving an archival note in the independent `user` scope succeeds even when project is at 500.
    let user_arch = app
        .saved(json!({
            "expectedRevision": 0, "scope": "user", "project": "widgets", "repository": REPO,
            "category": "user", "tier": "archival",
            "title": "User Archival", "hook": "independent cap", "body": ""
        }))
        .await;
    assert_eq!(user_arch["tier"], json!("archival"));

    // Dream commit: adding 1 archival note at cap fails atomically and writes nothing.
    ingest_turn_session(&app.env.store, "cap-sess-1", "cap test", "done");
    let lease_r = app
        .call(
            Method::POST,
            "/api/agent/v1/memory/dream/lease",
            Some(&app.token),
            Some(json!({ "project": "widgets", "repository": REPO, "mode": "manual" })),
        )
        .await;
    assert_eq!(lease_r.status, StatusCode::OK, "{}", lease_r.text());
    let lease_id = lease_r.json()["lease"]["id"].as_str().unwrap().to_owned();

    let dream_fail = app
        .call(
            Method::POST,
            &format!("/api/agent/v1/memory/dream/{lease_id}/commit"),
            Some(&app.token),
            Some(json!({
                "sessions": ["cap-sess-1"],
                "changes": [{
                    "op": "save",
                    "expectedRevision": 0,
                    "scope": "project",
                    "category": "project",
                    "tier": "archival",
                    "title": "Dream Over Cap",
                    "hook": "fails",
                    "body": "",
                    "sources": [{ "sessionId": "cap-sess-1", "seq": 1 }]
                }]
            })),
        )
        .await;
    assert_eq!(dream_fail.status, StatusCode::BAD_REQUEST, "{}", dream_fail.text());
    assert_eq!(dream_fail.json()["message"], json!(expected_msg));
    assert_eq!(app.count("SELECT COUNT(*) FROM memory_dream_batches"), 0);

    // Dream commit: atomic swap (forget 1 archival + save 1 new archival) succeeds at cap!
    let dream_swap = app
        .call(
            Method::POST,
            &format!("/api/agent/v1/memory/dream/{lease_id}/commit"),
            Some(&app.token),
            Some(json!({
                "sessions": ["cap-sess-1"],
                "changes": [
                    {
                        "op": "forget",
                        "id": "arch00000001",
                        "expectedRevision": 1,
                        "sources": [{ "sessionId": "cap-sess-1", "seq": 1 }]
                    },
                    {
                        "op": "save",
                        "expectedRevision": 0,
                        "scope": "project",
                        "category": "project",
                        "tier": "archival",
                        "title": "Dream Swapped In",
                        "hook": "fits atomically",
                        "body": "replacement",
                        "sources": [{ "sessionId": "cap-sess-1", "seq": 1 }]
                    }
                ]
            })),
        )
        .await;
    assert_eq!(dream_swap.status, StatusCode::OK, "{}", dream_swap.text());
    assert_eq!(
        app.count(&format!("SELECT COUNT(*) FROM memory_notes WHERE scope_key = '{KEY}' AND deleted_at IS NULL AND tier = 'archival'")),
        MAX_ARCHIVAL_NOTES_PER_SCOPE as i64
    );
}

/// `GET /api/agent/v1/memory?view=index` returns `notes: []`, rendered pinned `index`, `tiers: true`, `archivalCount`,
/// and `archivalCounts: { user, project }`; invalid `view` returns 400.
#[tokio::test]
async fn memory_view_index_mode_and_capability_fields() {
    let app = App::new();

    app.saved(json!({
        "expectedRevision": 0, "scope": "user", "category": "user", "tier": "pinned",
        "title": "User Pinned", "hook": "in index", "body": "body"
    }))
    .await;
    app.saved(json!({
        "expectedRevision": 0, "scope": "user", "category": "reference", "tier": "archival",
        "title": "User Archival 1", "hook": "archived", "body": "big user archival body"
    }))
    .await;
    app.saved(json!({
        "expectedRevision": 0, "scope": "project", "project": "widgets", "repository": REPO,
        "category": "project", "tier": "pinned",
        "title": "Proj Pinned", "hook": "in project index", "body": "body"
    }))
    .await;
    for i in 0..2 {
        app.saved(json!({
            "expectedRevision": 0, "scope": "project", "project": "widgets", "repository": REPO,
            "category": "reference", "tier": "archival",
            "title": format!("Proj Archival {i}"), "hook": "archived", "body": "big project archival body"
        }))
        .await;
    }

    let q = format!("project=widgets&repository={}", encode(REPO));
    let full = app.memory(&q).await;
    assert_eq!(full["notes"].as_array().unwrap().len(), 5);
    assert_eq!(full["tiers"], json!(true));
    assert_eq!(full["archivalCount"], json!(3));
    assert_eq!(full["archivalCounts"], json!({ "user": 1, "project": 2 }));

    let explicit_full = app.memory(&format!("{q}&view=full")).await;
    assert_eq!(explicit_full["notes"].as_array().unwrap().len(), 5);
    assert_eq!(explicit_full["index"], full["index"]);

    let index_only = app.memory(&format!("{q}&view=index")).await;
    assert_eq!(index_only["notes"], json!([]));
    assert_eq!(index_only["index"], full["index"]);
    assert_eq!(index_only["indexBytes"], full["indexBytes"]);
    assert_eq!(index_only["indexLines"], full["indexLines"]);
    assert_eq!(index_only["tiers"], json!(true));
    assert_eq!(index_only["archivalCount"], json!(3));
    assert_eq!(index_only["archivalCounts"], json!({ "user": 1, "project": 2 }));
    assert_eq!(index_only["scopes"], full["scopes"]);

    // Invalid `view` returns 400.
    let bad = app.memory_reply(&format!("{q}&view=compact")).await;
    assert_eq!(bad.status, StatusCode::BAD_REQUEST, "{}", bad.text());
    assert_eq!(bad.json()["message"], json!("view must be full or index"));
}

/// `Written` (`POST memory/notes` & `POST memory/notes/:id/forget`) reports `scopeIndexBytes` and `scopeIndexLines`
/// for the written note's own scope alone even when user + project combined exceeds 8192 bytes, and 422 reports
/// `"budget": "per_scope"`.
#[tokio::test]
async fn written_reports_per_scope_sizes_when_combined_exceeds_8192() {
    let app = App::new();

    let title_pad = "T".repeat(100);
    let hook_pad = "H".repeat(130);

    // Put ~5 KiB in user scope and ~5 KiB in project scope (combined ~10 KiB > 8192 B).
    for i in 0..20 {
        let r = app
            .save(json!({
                "expectedRevision": 0, "scope": "user",
                "category": "feedback", "title": format!("u{i:02}-{title_pad}"), "hook": hook_pad, "body": ""
            }))
            .await;
        assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    }
    let mut last_proj_id = String::new();
    let mut last_written = Value::Null;
    for i in 0..20 {
        let r = app
            .save(json!({
                "expectedRevision": 0, "scope": "project", "project": "widgets", "repository": REPO,
                "category": "project", "title": format!("p{i:02}-{title_pad}"), "hook": hook_pad, "body": ""
            }))
            .await;
        assert_eq!(r.status, StatusCode::OK, "{}", r.text());
        last_written = r.json();
        last_proj_id = last_written["note"]["id"].as_str().unwrap().to_owned();
    }

    let combined_bytes = last_written["indexBytes"].as_u64().unwrap();
    let scope_bytes = last_written["scopeIndexBytes"].as_u64().unwrap();
    let scope_lines = last_written["scopeIndexLines"].as_u64().unwrap();
    assert!(combined_bytes > LIMIT_BYTES as u64, "combined should exceed 8192 B, got {combined_bytes}");
    assert!(scope_bytes < combined_bytes && scope_bytes <= LIMIT_BYTES as u64, "scope={scope_bytes}, combined={combined_bytes}");
    assert_eq!(scope_lines, 22); // `# Project memory: widgets`, `## project`, 20 notes

    // Verify `scopeIndexBytes` matches owner `GET /api/v1/memory` for the project scope exactly.
    let scopes = app.owner(Method::GET, "memory", None).await.json()["scopes"].as_array().unwrap().clone();
    let proj_summary = scopes.iter().find(|s| s["key"] == KEY).unwrap();
    assert_eq!(scope_bytes, proj_summary["indexBytes"].as_u64().unwrap());
    assert_eq!(scope_lines, proj_summary["indexLines"].as_u64().unwrap());

    // Forgetting that project note reports the decremented project-only size on `Written`.
    let forgot = app
        .forget(
            &last_proj_id,
            json!({ "expectedRevision": 1, "project": "widgets", "repository": REPO }),
        )
        .await;
    assert_eq!(forgot.status, StatusCode::OK, "{}", forgot.text());
    let forgot_body = forgot.json();
    assert!(forgot_body["indexBytes"].as_u64().unwrap() > LIMIT_BYTES as u64);
    assert!(forgot_body["scopeIndexBytes"].as_u64().unwrap() < scope_bytes);
    assert_eq!(forgot_body["scopeIndexLines"], json!(21));

    // Push user scope over 8192 bytes and confirm 422 includes `"budget": "per_scope"`.
    let full_reply = loop {
        let idx = app.count("SELECT COUNT(*) FROM memory_notes WHERE scope_key = 'user'");
        let r = app
            .save(json!({
                "expectedRevision": 0, "scope": "user", "project": "widgets", "repository": REPO,
                "category": "feedback", "title": format!("u{idx:03}-{title_pad}"), "hook": hook_pad, "body": ""
            }))
            .await;
        if r.status != StatusCode::OK {
            break r;
        }
    };
    assert_eq!(full_reply.status, StatusCode::UNPROCESSABLE_ENTITY);
    let full_json = full_reply.json();
    assert_eq!(full_json["error"], json!("memory_full"));
    assert_eq!(full_json["budget"], json!("per_scope"));
    assert_eq!(full_json["project"], Value::Null);
}

/// `GET /api/agent/v1/memory/search`: English & CJK FTS5 AND/OR lexical search, substring fallback, default limit 20,
/// `limit=100` returning >50 results without truncation, scope/category/tier filters, exclusion of forgotten notes,
/// and `pika reindex` + project deletion behavior for `memory_notes_fts`.
#[tokio::test]
async fn memory_search_lexical_cjk_or_substring_limits_filters_and_reindex() {
    let app = App::new();

    // Validation checks.
    assert_eq!(app.search("").await.status, StatusCode::BAD_REQUEST);
    assert_eq!(app.search("q=%20%20").await.status, StatusCode::BAD_REQUEST);
    assert_eq!(app.search("q=test&tier=bogus").await.status, StatusCode::BAD_REQUEST);
    assert_eq!(app.search("q=test&scope=global").await.status, StatusCode::BAD_REQUEST);
    assert_eq!(app.search("q=test&category=bogus").await.status, StatusCode::BAD_REQUEST);
    assert_eq!(app.search("q=test&limit=0").await.status, StatusCode::BAD_REQUEST);
    assert_eq!(app.search("q=test&limit=101").await.status, StatusCode::BAD_REQUEST);

    // Create notes across user & project scopes, pinned & archival, English & CJK.
    let n_auth_pkce = app
        .saved(json!({
            "expectedRevision": 0, "scope": "project", "project": "widgets", "repository": REPO,
            "category": "project", "tier": "pinned",
            "title": "Authentication OAuth Flow",
            "hook": "authentication via oauth login",
            "body": "Uses OAuth PKCE for authentication and session refresh."
        }))
        .await;
    let n_archival = app
        .saved(json!({
            "expectedRevision": 0, "scope": "project", "project": "widgets", "repository": REPO,
            "category": "reference", "tier": "archival",
            "title": "SSO Sign-In",
            "hook": "oauth gateway tokens",
            "body": "OAuth login tokens expire after 15 minutes."
        }))
        .await;
    let n_user = app
        .saved(json!({
            "expectedRevision": 0, "scope": "user",
            "category": "feedback", "tier": "pinned",
            "title": "Deployment Checklist",
            "hook": "verify authentication banner",
            "body": "Check the docs for authentication flag qx_marker before release."
        }))
        .await;
    let n_cjk = app
        .saved(json!({
            "expectedRevision": 0, "scope": "project", "project": "widgets", "repository": REPO,
            "category": "project", "tier": "archival",
            "title": "数据库缓存策略",
            "hook": "本地缓存失效机制",
            "body": "使用本地 SQLite 缓存避免重复查询"
        }))
        .await;
    let n_forgotten = app
        .saved(json!({
            "expectedRevision": 0, "scope": "user",
            "category": "user", "tier": "pinned",
            "title": "Authentication Legacy",
            "hook": "deleted authentication note",
            "body": "Should never show up in search."
        }))
        .await;
    let forget_r = app.forget(n_forgotten["id"].as_str().unwrap(), json!({ "expectedRevision": 1 })).await;
    assert_eq!(forget_r.status, StatusCode::OK);

    let scope_q = format!("project=widgets&repository={}", encode(REPO));

    // Single-term English FTS5 lexical search excludes forgotten notes.
    let lex_r = app.search(&format!("q=authentication&{scope_q}")).await;
    assert_eq!(lex_r.status, StatusCode::OK, "{}", lex_r.text());
    let lex = lex_r.json();
    assert_eq!(lex["mode"], json!("lexical"));
    assert_eq!(lex["total"], json!(4));
    let lex_ids: Vec<&str> = lex["notes"].as_array().unwrap().iter().map(|n| n["id"].as_str().unwrap()).collect();
    assert!(lex_ids.contains(&n_auth_pkce["id"].as_str().unwrap()));
    assert!(lex_ids.contains(&n_user["id"].as_str().unwrap()));
    assert!(!lex_ids.contains(&n_archival["id"].as_str().unwrap()));
    assert!(!lex_ids.contains(&n_forgotten["id"].as_str().unwrap()));

    // Multi-term AND match returns only notes containing both terms.
    let and_r = app.search(&format!("q=oauth+pkce&{scope_q}")).await;
    assert_eq!(and_r.status, StatusCode::OK);
    let and_body = and_r.json();
    assert_eq!(and_body["mode"], json!("lexical"));
    assert_eq!(and_body["notes"].as_array().unwrap().len(), 1);
    assert_eq!(and_body["notes"][0]["id"], n_auth_pkce["id"]);

    // Multi-term OR fallback when AND yields 0 matches.
    let or_r = app.search(&format!("q=pkce+qx_marker&{scope_q}")).await;
    assert_eq!(or_r.status, StatusCode::OK);
    let or_body = or_r.json();
    assert_eq!(or_body["mode"], json!("lexical"));
    let or_ids: Vec<&str> = or_body["notes"].as_array().unwrap().iter().map(|n| n["id"].as_str().unwrap()).collect();
    assert!(or_ids.contains(&n_auth_pkce["id"].as_str().unwrap()));
    assert!(or_ids.contains(&n_user["id"].as_str().unwrap()));

    // CJK FTS5 search via `pika_cjk`.
    let cjk_r = app.search(&format!("q={}&{scope_q}", encode("缓存策略"))).await;
    assert_eq!(cjk_r.status, StatusCode::OK, "{}", cjk_r.text());
    let cjk = cjk_r.json();
    assert_eq!(cjk["mode"], json!("lexical"));
    assert_eq!(cjk["notes"].as_array().unwrap().len(), 1);
    assert_eq!(cjk["notes"][0]["id"], n_cjk["id"]);

    // Substring fallback when FTS5 yields 0 matches (partial substring inside a token).
    let sub_r = app.search(&format!("q=x_m&{scope_q}")).await;
    assert_eq!(sub_r.status, StatusCode::OK, "{}", sub_r.text());
    let sub = sub_r.json();
    assert_eq!(sub["mode"], json!("substring"));
    assert_eq!(sub["notes"].as_array().unwrap().len(), 1);
    assert_eq!(sub["notes"][0]["id"], n_user["id"]);

    // Scope, category, and tier filters.
    let by_tier = app.search(&format!("q=oauth&tier=archival&{scope_q}")).await.json();
    assert_eq!(by_tier["notes"].as_array().unwrap().len(), 1);
    assert_eq!(by_tier["notes"][0]["id"], n_archival["id"]);

    let by_scope = app.search(&format!("q=authentication&scope=user&{scope_q}")).await.json();
    assert_eq!(by_scope["notes"].as_array().unwrap().len(), 1);
    assert_eq!(by_scope["notes"][0]["id"], n_user["id"]);

    let by_cat = app.search(&format!("q=oauth&category=project&{scope_q}")).await.json();
    assert_eq!(by_cat["notes"].as_array().unwrap().len(), 1);
    assert_eq!(by_cat["notes"][0]["id"], n_auth_pkce["id"]);

    // Seed 75 archival notes matching `bulk_needle` to verify default limit 20 and `limit=100` (>50 results).
    for i in 0..75 {
        app.saved(json!({
            "expectedRevision": 0, "scope": "project", "project": "widgets", "repository": REPO,
            "category": "reference", "tier": "archival",
            "title": format!("Bulk {i:02}"), "hook": "bulk_needle entry", "body": format!("bulk_needle payload {i}")
        }))
        .await;
    }

    let default_lim = app.search(&format!("q=bulk_needle&{scope_q}")).await.json();
    assert_eq!(default_lim["mode"], json!("lexical"));
    assert_eq!(default_lim["notes"].as_array().unwrap().len(), SEARCH_DEFAULT_LIMIT);

    let max_lim = app.search(&format!("q=bulk_needle&limit=100&{scope_q}")).await.json();
    assert_eq!(max_lim["mode"], json!("lexical"));
    assert_eq!(max_lim["notes"].as_array().unwrap().len(), 75, "limit=100 must not truncate at 50");

    // `pika reindex` leaves `memory_notes_fts` intact.
    let fts_before = app.count("SELECT COUNT(*) FROM memory_notes_fts");
    assert_eq!(fts_before, 79);
    pika::reindex::reindex(&app.env.store).unwrap();
    assert_eq!(app.count("SELECT COUNT(*) FROM memory_notes_fts"), fts_before);

    // Search still works right after `pika reindex`.
    let after_reindex = app.search(&format!("q=bulk_needle&limit=100&{scope_q}")).await.json();
    assert_eq!(after_reindex["notes"].as_array().unwrap().len(), 75);

    // Deleting the project removes project notes from `memory_notes_fts` while preserving user notes.
    let del = app.owner(Method::DELETE, "projects/widgets", None).await;
    assert_eq!(del.status, StatusCode::OK, "{}", del.text());
    assert_eq!(app.count("SELECT COUNT(*) FROM memory_notes_fts"), 1);
    let user_after_del = app.search("q=authentication").await.json();
    assert_eq!(user_after_del["notes"].as_array().unwrap().len(), 1);
    assert_eq!(user_after_del["notes"][0]["id"], n_user["id"]);
}
