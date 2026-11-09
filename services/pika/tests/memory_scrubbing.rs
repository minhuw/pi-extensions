//! Agent memory that reaches sessions outside a `pika-memory` entry and the memory tools' own calls (spec "Scrubbing"
//! under "Memory"): the memory section of the system prompt, which Pi records as a system message and again in each
//! compaction's `systemMessage`, and memory tools called by another tool, as a codemode script calls them, which Pi
//! records on that tool's result as `nestedCalls`. The public and agent namespaces omit it, search never indexes it,
//! the owner sees everything, and an upgraded database is repaired once.

mod common;

use axum::Router;
use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use common::*;
use pika::config::{AuthMode, ServerConfig};
use pika::http::{AppState, router};
use serde_json::{Value, json};
use tower::ServiceExt;

const ID: &str = "6b0c3a20-6d1e-4f3a-8b9c-2e3f4a5b6c7d";
/// Text that appears only in memory: the pinned index, the system prompt's memory section, a nested `memory_save`'s
/// title and body, and what the script read back.
const INDEX_MARK: &str = "quokkaindex";
const SECTION_MARK: &str = "quokkasection";
const TITLE_MARK: &str = "quokkanestedtitle";
const BODY_MARK: &str = "quokkanestedbody";
const READBACK_MARK: &str = "quokkareadback";
const MARKS: [&str; 5] = [INDEX_MARK, SECTION_MARK, TITLE_MARK, BODY_MARK, READBACK_MARK];
/// In a codemode script that mentions `memory_read` but calls only `read`: not memory.
const PLAIN_MARK: &str = "quokkaplain";

/// The `memory` section as the pika extension pins it.
fn section() -> String {
    format!("Saved notes from earlier sessions.\n\n# User memory\n## feedback\n- Tabs — {SECTION_MARK} [0123456789ab]\n")
}

fn memory_script() -> String {
    format!("const note = await tools.memory_save({{ title: '{TITLE_MARK}', hook: 'h', body: '{BODY_MARK}', expectedRevision: 0 }});\nreturn note")
}

fn message(id: &str, parent: &str, at: &str, message: Value) -> String {
    json!({ "type": "message", "id": id, "parentId": parent, "timestamp": at, "message": message }).to_string()
}

/// A session in project `widgets`: a pinned index, the system message with its memory section, a prompt, an
/// assistant message with a codemode call that saves a note (seq 4, part 1), a `read` call, and a codemode call that
/// only mentions a memory tool, their results (seqs 5 to 7), and a compaction that repeats the system message.
fn session() -> Vec<String> {
    vec![
        json!({ "type": "session", "version": 3, "id": ID, "timestamp": "2026-10-20T09:00:00.000Z", "cwd": "/home/me/code/widgets" })
            .to_string(),
        json!({ "type": "custom", "id": "m0", "parentId": null, "timestamp": "2026-10-20T09:00:00.500Z", "customType": "pika-memory",
                "data": { "index": format!("# User memory\n- Tabs — {INDEX_MARK} [0123456789ab]\n") } })
        .to_string(),
        message("s1", "m0", "2026-10-20T09:00:00.700Z", json!({ "role": "system", "content": "", "timestamp": 1792486800700_i64,
            "sections": { "preamble": "You are pi.", "memory": section() } })),
        message("m1", "s1", "2026-10-20T09:00:01.000Z", json!({ "role": "user", "content": "Fix the wombat parser", "timestamp": 1792486801000_i64 })),
        message("m2", "m1", "2026-10-20T09:00:02.000Z", json!({ "role": "assistant", "api": "openai-responses", "provider": "openai",
            "model": "gpt-5", "stopReason": "toolUse", "timestamp": 1792486802000_i64,
            "usage": { "input": 100, "output": 20, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 120, "cost": { "total": 0.002 } },
            "content": [
                { "type": "text", "text": "Saving a note, then reading the wombat parser." },
                { "type": "toolCall", "id": "call_cm", "name": "codemode", "arguments": { "code": memory_script() } },
                { "type": "toolCall", "id": "call_read", "name": "read", "arguments": { "path": "src/wombat.rs" } },
                { "type": "toolCall", "id": "call_plain", "name": "codemode",
                  "arguments": { "code": format!("// {PLAIN_MARK}: memory_read is not needed here\nreturn await tools.read({{ path: 'src/plain.rs' }})") } },
            ] })),
        message("m3", "m2", "2026-10-20T09:00:03.000Z", json!({ "role": "toolResult", "toolCallId": "call_cm", "toolName": "codemode",
            "isError": false, "timestamp": 1792486803000_i64, "content": [{ "type": "text", "text": format!("Saved: {READBACK_MARK}") }],
            "details": { "output": READBACK_MARK },
            "nestedCalls": { "calls": [
                { "id": "call_cm/1", "name": "memory_save", "status": "error", "durationMs": 12, "error": format!("conflict on {TITLE_MARK}"),
                  "arguments": { "title": TITLE_MARK, "hook": "h", "body": BODY_MARK, "expectedRevision": 0 } },
                { "id": "call_cm/2", "name": "read", "status": "ok", "durationMs": 3, "arguments": { "path": "src/nested.rs" } },
            ], "complete": true } })),
        message("m4", "m3", "2026-10-20T09:00:04.000Z", json!({ "role": "toolResult", "toolCallId": "call_read", "toolName": "read",
            "isError": false, "timestamp": 1792486804000_i64, "content": [{ "type": "text", "text": "fn wombat() {}" }] })),
        message("m5", "m4", "2026-10-20T09:00:05.000Z", json!({ "role": "toolResult", "toolCallId": "call_plain", "toolName": "codemode",
            "isError": false, "timestamp": 1792486805000_i64, "content": [{ "type": "text", "text": "plain wombat output" }],
            "nestedCalls": { "calls": [{ "id": "call_plain/1", "name": "read", "status": "ok", "arguments": { "path": "src/plain.rs" } }],
                             "complete": true } })),
        json!({ "type": "compaction", "id": "c1", "parentId": "m5", "timestamp": "2026-10-20T09:00:06.000Z", "summary": "Wombat work so far.",
                "firstKeptEntryId": "m5", "tokensBefore": 1000,
                "systemMessage": { "role": "system", "content": "", "timestamp": 1792486806000_i64,
                                   "sections": { "preamble": "You are pi.", "memory": section() } } })
        .to_string(),
    ]
}

struct App {
    env: Env,
    app: Router,
    /// A device's token for the agent namespace.
    token: String,
}

impl App {
    fn new() -> App {
        let env = env();
        let token = device(&env.store, "a");
        let mut config = ServerConfig::new(env.dir.path().join("data"));
        config.auth = AuthMode::None;
        let app = router(AppState::new(env.store.clone(), config).unwrap());
        App { env, app, token }
    }

    /// `env` with its store reopened, as an upgraded server opens it.
    fn reopen(env: Env, token: String) -> App {
        let data = env.dir.path().join("data");
        drop(env.store);
        let store = pika::store::Store::open(&data).unwrap();
        let env = Env { dir: env.dir, store };
        let mut config = ServerConfig::new(data);
        config.auth = AuthMode::None;
        let app = router(AppState::new(env.store.clone(), config).unwrap());
        App { env, app, token }
    }

    async fn publish(&self) {
        let request = Request::builder()
            .method(Method::PATCH)
            .uri("/api/v1/settings/publishing")
            .header("content-type", "application/json")
            .body(Body::from(json!({ "project": "widgets", "published": true }).to_string()))
            .unwrap();
        let response = self.app.clone().oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
    }

    /// `GET /api/{namespace}/{path}` (`v1`, `public/v1`, or `agent/v1` with the device's token), which must succeed.
    async fn read_in(&self, namespace: &str, path: &str) -> String {
        let mut request = Request::builder().method(Method::GET).uri(format!("/api/{namespace}/{path}"));
        if namespace == "agent/v1" {
            request = request.header("authorization", format!("Bearer {}", self.token));
        }
        let response = self.app.clone().oneshot(request.body(Body::empty()).unwrap()).await.unwrap();
        let status = response.status();
        let body = axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let text = String::from_utf8_lossy(&body).into_owned();
        assert_eq!(status, StatusCode::OK, "{namespace} {path}: {text}");
        text
    }

    async fn json_in(&self, namespace: &str, path: &str) -> Value {
        serde_json::from_str(&self.read_in(namespace, path).await).unwrap()
    }

    /// Each search hit for `q` in a namespace, in both groupings.
    async fn hits_in(&self, namespace: &str, q: &str) -> Vec<Value> {
        let mut hits = Vec::new();
        for group in ["entry", "session"] {
            let found = self.json_in(namespace, &format!("search?q={q}&group={group}")).await;
            hits.extend(found["items"].as_array().unwrap().iter().cloned());
        }
        hits
    }
}

fn tool<'a>(trace: &'a Value, call_id: &str) -> &'a Value {
    trace["records"].as_array().unwrap().iter().find(|r| r["kind"] == "tool" && r["callId"] == call_id).unwrap()
}

/// What the public and agent namespaces show of the session, and that the owner's show everything.
async fn assert_omitted(app: &App) {
    let entries = format!("sessions/{ID}/entries");
    let trace = format!("sessions/{ID}/trace");
    let owner = app.read_in("v1", &entries).await;
    assert!(MARKS.iter().all(|mark| owner.contains(mark)), "{owner}");
    let owner_trace = app.json_in("v1", &trace).await;
    assert!(tool(&owner_trace, "call_cm")["summary"].as_str().unwrap().contains(TITLE_MARK), "{owner_trace}");
    for seq in 0..9 {
        let line = app.read_in("v1", &format!("{entries}/{seq}/raw")).await;
        assert_eq!(line, session()[seq], "the owner's raw line {seq}");
    }

    for namespace in ["public/v1", "agent/v1"] {
        let text = app.read_in(namespace, &entries).await;
        assert!(MARKS.iter().all(|mark| !text.contains(mark)), "{namespace}: {text}");
        let items: Value = serde_json::from_str(&text).unwrap();
        let raw = |seq: usize| items["items"][seq]["raw"].clone();
        assert_eq!(raw(1)["data"], json!({ "omitted": "memory" }), "{namespace}");
        // The system message keeps its other sections.
        assert_eq!(
            raw(2)["message"],
            json!({ "role": "system", "content": "", "timestamp": 1792486800700_i64,
                    "sections": { "preamble": "You are pi.", "memory": { "omitted": "memory" } } }),
            "{namespace}"
        );
        // The codemode call that saved a note is a memory call; the one that only names a memory tool is not.
        let content = raw(4)["message"]["content"].clone();
        assert_eq!(content[0]["text"], "Saving a note, then reading the wombat parser.", "{namespace}");
        assert_eq!(
            content[1],
            json!({ "type": "toolCall", "id": "call_cm", "name": "codemode", "arguments": { "omitted": "memory" } }),
            "{namespace}"
        );
        assert_eq!(content[2], json!({ "type": "toolCall", "id": "call_read", "name": "read", "arguments": { "path": "src/wombat.rs" } }));
        assert!(content[3]["arguments"]["code"].as_str().unwrap().contains(PLAIN_MARK), "{namespace}: {content}");
        // Its result is a memory result, whose nested memory call keeps no arguments and no error.
        let result = raw(5)["message"].clone();
        assert_eq!((&result["toolCallId"], &result["toolName"]), (&json!("call_cm"), &json!("codemode")), "{namespace}");
        assert_eq!(result["content"], json!([{ "type": "text", "text": "[memory tool result omitted]" }]), "{namespace}");
        assert_eq!(result["details"], json!({ "omitted": "memory" }), "{namespace}");
        assert_eq!(
            result["nestedCalls"],
            json!({ "calls": [
                { "id": "call_cm/1", "name": "memory_save", "status": "error", "durationMs": 12, "arguments": { "omitted": "memory" } },
                { "id": "call_cm/2", "name": "read", "status": "ok", "durationMs": 3, "arguments": { "path": "src/nested.rs" } },
            ], "complete": true }),
            "{namespace}"
        );
        assert_eq!(raw(7)["message"]["content"][0]["text"], "plain wombat output", "{namespace}");
        assert_eq!(raw(8)["summary"], "Wombat work so far.", "{namespace}");
        assert_eq!(
            raw(8)["systemMessage"]["sections"],
            json!({ "preamble": "You are pi.", "memory": { "omitted": "memory" } }),
            "{namespace}"
        );

        let text = app.read_in(namespace, &trace).await;
        assert!(MARKS.iter().all(|mark| !text.contains(mark)), "{namespace}: {text}");
        let scrubbed: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(scrubbed["records"].as_array().unwrap().len(), owner_trace["records"].as_array().unwrap().len());
        let memory = tool(&scrubbed, "call_cm");
        assert_eq!((&memory["name"], &memory["summary"], &memory["resultSeq"]), (&json!("codemode"), &json!(""), &json!(5)), "{namespace}");
        assert_eq!(tool(&scrubbed, "call_read")["summary"], "src/wombat.rs", "{namespace}");
        assert!(tool(&scrubbed, "call_plain")["summary"].as_str().unwrap().contains(PLAIN_MARK), "{namespace}: {text}");
    }
    // The public namespace's raw lines omit it too, each one with the context of its session.
    for seq in 0..9 {
        let line = app.read_in("public/v1", &format!("{entries}/{seq}/raw")).await;
        assert!(MARKS.iter().all(|mark| !line.contains(mark)), "{seq}: {line}");
        let line: Value = serde_json::from_str(&line).unwrap();
        if seq == 4 {
            assert_eq!(line["message"]["content"][1]["arguments"], json!({ "omitted": "memory" }));
        }
    }

    for namespace in ["v1", "public/v1", "agent/v1"] {
        for mark in MARKS {
            assert_eq!(app.hits_in(namespace, mark).await, Vec::<Value>::new(), "{namespace} {mark}");
        }
        let kinds = |hits: Vec<Value>| hits.iter().filter_map(|h| h["kind"].as_str().map(str::to_owned)).collect::<Vec<_>>();
        let wombat = kinds(app.hits_in(namespace, "wombat").await);
        for kind in ["user", "assistant", "tool-call", "tool-result"] {
            assert!(wombat.iter().any(|k| k == kind), "{namespace} {kind}: {wombat:?}");
        }
        assert!(kinds(app.hits_in(namespace, PLAIN_MARK).await).iter().any(|k| k == "tool-call"), "{namespace}");
    }
}

/// The text documents of the session, by seq and kind.
fn documents(store: &pika::store::Store) -> Vec<(i64, String)> {
    query(store, &format!("SELECT d.seq, d.kind FROM search_docs d JOIN sessions s USING (sid) WHERE s.id = '{ID}' ORDER BY d.seq, d.id"))
        .into_iter()
        .map(|r| (r["seq"].as_i64().unwrap(), r["kind"].as_str().unwrap().to_owned()))
        .collect()
}

fn expected_documents() -> Vec<(i64, String)> {
    // The prompt; the assistant's text, `read` call, and plain codemode call; and those two calls' results.
    [(3, "user"), (4, "assistant"), (4, "tool-call"), (4, "tool-call"), (6, "tool-result"), (7, "tool-result")]
        .into_iter()
        .map(|(seq, kind)| (seq, kind.to_owned()))
        .collect()
}

/// S1, S2: the memory section of system messages and compactions, and memory tools called by a codemode script, are
/// omitted from public and agent entries, raw lines, and traces, and never indexed, however the session's lines are
/// batched and after a reindex; the owner sees everything.
#[tokio::test]
async fn memory_in_system_messages_and_nested_calls_is_omitted_and_never_indexed() {
    let mut derived = None;
    for chunk in [1, 2, 9] {
        let app = App::new();
        upload(&app.env.store, &format!("session:{ID}"), "session", &session(), chunk);
        app.publish().await;
        assert_omitted(&app).await;
        assert_eq!(documents(&app.env.store), expected_documents(), "batches of {chunk}");
        let dump = dump_derived(&app.env.store);
        pika::reindex::reindex(&app.env.store).unwrap();
        assert_eq!(dump_derived(&app.env.store), dump, "reindexed, batches of {chunk}");
        assert_omitted(&app).await;
        if let Some(derived) = &derived {
            assert_eq!(&dump, derived, "batches of {chunk}");
        }
        derived = Some(dump);
    }
}

/// A database derived by a pika that indexed nested memory calls and their results, and left their entries unmarked, is
/// repaired once when it is opened: it then holds what deriving it now gives, and reads and search omit the memory.
#[tokio::test]
async fn opening_a_database_repairs_nested_memory_calls_once() {
    let app = App::new();
    upload(&app.env.store, &format!("session:{ID}"), "session", &session(), 9);
    app.publish().await;
    let expected = dump_derived(&app.env.store);
    // What an older pika derived: the codemode call's document (part 1 of seq 4) and its result's, and no mark.
    app.env.store.write(|tx| {
        let sid: i64 = tx.query_row("SELECT sid FROM sessions WHERE id = ?1", [ID], |r| r.get(0))?;
        let at = |seq: i64| -> rusqlite::Result<i64> {
            tx.query_row("SELECT ts FROM entries WHERE sid = ?1 AND seq = ?2", [sid, seq], |r| r.get(0))
        };
        use pika::derive::search::{Kind, index};
        index(tx, sid, 4, 1, at(4)?, Kind::ToolCall, &format!("codemode\ncode: {}", memory_script()))?;
        index(tx, sid, 5, 0, at(5)?, Kind::ToolResult, &format!("Saved: {READBACK_MARK}"))?;
        tx.execute("UPDATE entries SET custom_type = NULL WHERE custom_type = 'pika-memory-calls'", [])?;
        tx.execute("DELETE FROM settings WHERE key = 'memory_calls_repaired'", [])?;
        Ok::<_, anyhow::Error>(())
    }).unwrap();
    assert!(!app.hits_in("public/v1", READBACK_MARK).await.is_empty(), "the leak this repairs");
    assert!(!app.hits_in("agent/v1", TITLE_MARK).await.is_empty(), "the leak this repairs");
    let text = app.read_in("public/v1", &format!("sessions/{ID}/entries")).await;
    assert!(text.contains(TITLE_MARK), "the leak this repairs: {text}");

    let App { env, app: router, token } = app;
    drop(router);
    let app = App::reopen(env, token);
    assert_eq!(dump_derived(&app.env.store), expected);
    assert_eq!(app.env.store.setting("memory_calls_repaired").unwrap(), Some(vec![1]));
    assert_eq!(app.env.store.setting("needs_reindex").unwrap(), None);
    assert_omitted(&app).await;

    // Once: a later open repairs nothing, even a mark removed since.
    app.env.store.write(|tx| tx.execute("UPDATE entries SET custom_type = NULL WHERE custom_type = 'pika-memory-calls'", [])).unwrap();
    let App { env, app: router, token } = app;
    drop(router);
    let app = App::reopen(env, token);
    assert_eq!(one(&app.env.store, "SELECT COUNT(*) AS n FROM entries WHERE custom_type = 'pika-memory-calls'")["n"], json!(0));
}
