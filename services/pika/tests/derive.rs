mod common;

use common::*;
use pika::util::parse_iso_ms;
use serde_json::{Value, json};

const STEP_SESSION: &str = "step-s2";
const CHILD_SESSION: &str = "c4ild000-0000-0000-0000-000000000001";
const LATE_CHILD_SESSION: &str = "c4ild000-0000-0000-0000-000000000002";

fn ms(iso: &str) -> Value {
    json!(parse_iso_ms(iso).unwrap())
}

fn step_session() -> Vec<String> {
    [
        json!({ "type": "session", "version": 3, "id": STEP_SESSION, "timestamp": "2026-10-21T10:05:30.000Z", "cwd": "/home/me/.git/herder/worktrees/r1/impl" }),
        json!({ "type": "custom", "id": "s0000001", "parentId": null, "timestamp": "2026-10-21T10:05:30.100Z",
                "customType": "pi-extensions.session-link",
                "data": { "kind": "herder-step", "parentSessionId": "orch-1",
                          "herder": { "runId": RUN_ID, "stepKey": "impl-T1", "stepId": "impl-T1", "task": "T1",
                                      "role": "worker", "attempt": 2, "launch": 1, "repo": "widgets" } } }),
        json!({ "type": "message", "id": "s0000002", "parentId": "s0000001", "timestamp": "2026-10-21T10:05:31.000Z",
                "message": { "role": "user", "content": "Implement T1", "timestamp": 1 } }),
    ]
    .iter()
    .map(Value::to_string)
    .collect()
}

fn child_session(id: &str) -> Vec<String> {
    let parent_file = format!("/home/me/.pi/agent/sessions/--x--/2026-10-20T09-00-00-000Z_{SESSION_ID}.jsonl");
    [json!({ "type": "session", "version": 3, "id": id, "timestamp": "2026-10-20T10:00:00.000Z",
             "cwd": "/home/me/code/widgets", "parentSession": parent_file })]
    .iter()
    .map(Value::to_string)
    .collect()
}

fn request_for(seq_ts: i64, id: &str, at: &str) -> Value {
    json!({ "requests": [{ "id": id, "sessionId": SESSION_ID, "seq": 1, "at": at, "fidelity": "context",
                           "assistant": { "timestamp": seq_ts }, "skeleton": { "messages": [] }, "blocks": [] }] })
}

/// Uploads every fixture with `chunk` lines per batch; requests and children arrive before and after their targets.
fn load_all(env: &Env, chunk: usize) {
    ingest(&env.store, request_for(1792486802500, "req-a", "2026-10-20T09:00:02.400Z")).unwrap();
    upload(&env.store, &format!("session:{CHILD_SESSION}"), "session", &child_session(CHILD_SESSION), chunk);
    upload(&env.store, &format!("session:{SESSION_ID}"), "session", &fixture("session.jsonl"), chunk);
    upload(&env.store, &format!("session:{LATE_CHILD_SESSION}"), "session", &child_session(LATE_CHILD_SESSION), chunk);
    upload(&env.store, &format!("herder:{RUN_ID}"), "herder-journal", &fixture("herder-journal.jsonl"), chunk);
    upload(&env.store, &format!("session:{STEP_SESSION}"), "session", &step_session(), chunk);
    ingest(&env.store, request_for(1792486925000, "req-b", "2026-10-20T09:02:04.000Z")).unwrap();
    // A later capture for the same call wins.
    ingest(&env.store, request_for(1792486802500, "req-c", "2026-10-20T09:00:02.450Z")).unwrap();
}

#[test]
fn derives_sessions_turns_calls_links_and_herder_runs() {
    let env = env();
    load_all(&env, 5);
    let store = &env.store;

    let s = one(store, &format!("SELECT * FROM sessions WHERE id = '{SESSION_ID}'"));
    assert_eq!(s["device"], DEVICE);
    assert_eq!(s["cwd"], "/home/me/code/widgets");
    assert_eq!(s["project"], "widgets");
    assert_eq!(s["title"], "Fix flaky widget test");
    assert_eq!(s["first_prompt"], "Why does `test_widget_spin` fail intermittently?\nIt passes locally — sometimes. 🌀");
    assert_eq!(s["started_at"], ms("2026-10-20T09:00:00.000Z"));
    assert_eq!(s["last_at"], ms("2026-10-20T09:02:11.000Z"));
    assert_eq!(s["entry_count"], 16);
    assert_eq!(s["turn_count"], 2);
    assert_eq!(s["models"], r#"["claude-sonnet-4-5","gpt-5"]"#);
    assert_eq!((&s["input"], &s["output"], &s["cache_read"], &s["cache_write"]), (&json!(8300), &json!(730), &json!(9900), &json!(100)));
    assert!((s["cost"].as_f64().unwrap() - 0.0458).abs() < 1e-9, "{}", s["cost"]);
    assert_eq!(s["parent_session_id"], "parent-0001");
    assert_eq!(s["child_count"], 2);
    assert_eq!(s["herder_run_id"], Value::Null);
    let link: Value = serde_json::from_str(s["link"].as_str().unwrap()).unwrap();
    assert_eq!(link["parentToolCallId"], "toolu_parent");

    let models = query(store, "SELECT model FROM session_models ORDER BY model");
    assert_eq!(models.len(), 2);

    let turns = query(store, "SELECT t.* FROM turns t JOIN sessions s USING (sid) WHERE s.id LIKE '7f3c%' ORDER BY idx");
    assert_eq!(turns.len(), 2);
    let t0 = &turns[0];
    assert_eq!((&t0["idx"], &t0["start_seq"], &t0["end_seq"]), (&json!(0), &json!(5), &json!(12)));
    assert_eq!(t0["user_text"], s["first_prompt"]);
    assert_eq!(t0["at"], ms("2026-10-20T09:00:02.000Z"));
    assert_eq!(t0["duration_ms"], 58_000);
    assert_eq!((&t0["model_calls"], &t0["tool_calls"], &t0["tool_errors"]), (&json!(3), &json!(2), &json!(1)));
    assert_eq!((&t0["input"], &t0["output"], &t0["cache_read"], &t0["cache_write"]), (&json!(7400), &json!(650), &json!(9900), &json!(100)));
    assert!((t0["cost"].as_f64().unwrap() - 0.0428).abs() < 1e-9);
    assert_eq!(t0["final_text"], "The test depends on wall-clock timing; I pinned the clock.");
    let t1 = &turns[1];
    assert_eq!((&t1["start_seq"], &t1["end_seq"], &t1["duration_ms"]), (&json!(13), &json!(15), &json!(11_000)));
    assert_eq!(t1["user_text"], "Now add a regression test");
    assert_eq!((&t1["model_calls"], &t1["tool_calls"], &t1["input"]), (&json!(1), &json!(0), &json!(900)));
    assert_eq!(t1["final_text"], "Added `test_spin_clock`.");

    let entries = query(store, "SELECT e.* FROM entries e JOIN sessions s USING (sid) WHERE s.id LIKE '7f3c%' ORDER BY seq");
    assert_eq!(entries.len(), 16);
    assert_eq!((&entries[0]["type"], &entries[0]["offset"], &entries[0]["turn"]), (&json!("session"), &json!(0), &Value::Null));
    let lines = fixture("session.jsonl");
    assert_eq!(entries[6]["offset"], json!(byte_len(&lines[..6])));
    assert_eq!((&entries[6]["entry_id"], &entries[6]["parent_id"]), (&json!("a0000006"), &json!("a0000005")));
    assert_eq!((&entries[6]["role"], &entries[6]["tool_call_ids"], &entries[6]["turn"]), (&json!("assistant"), &json!(r#"["call_1"]"#), &json!(0)));
    assert_eq!(entries[1]["custom_type"], "pi-extensions.session-link");
    assert_eq!(entries[15]["type"], "future_thing");
    assert_eq!(entries[15]["turn"], 1);

    let calls = query(store, "SELECT m.* FROM model_calls m JOIN sessions s USING (sid) WHERE s.id LIKE '7f3c%' ORDER BY seq");
    assert_eq!(calls.iter().map(|c| c["seq"].as_i64().unwrap()).collect::<Vec<_>>(), [6, 8, 10, 14]);
    let c = &calls[0];
    assert_eq!((&c["provider"], &c["model"], &c["api"]), (&json!("anthropic"), &json!("claude-sonnet-4-5"), &json!("anthropic-messages")));
    assert_eq!((&c["stop_reason"], &c["ts"], &c["at"]), (&json!("toolUse"), &json!(1792486802500i64), &ms("2026-10-20T09:00:05.000Z")));
    assert_eq!((&c["input"], &c["output"], &c["cache_read"], &c["cache_write"], &c["total_tokens"]), (&json!(1200), &json!(150), &json!(800), &json!(100), &json!(2250)));
    assert_eq!((&c["response_id"], &c["request_id"], &c["turn"]), (&json!("msg_01"), &json!("req-c"), &json!(0)));
    assert_eq!(calls[3]["request_id"], "req-b");
    assert_eq!(calls[3]["model"], "gpt-5");
    assert_eq!(calls[1]["request_id"], Value::Null);

    let tools = query(store, "SELECT t.* FROM tool_calls t JOIN sessions s USING (sid) WHERE s.id LIKE '7f3c%' ORDER BY call_seq");
    assert_eq!(tools.len(), 2);
    let ok = &tools[0];
    assert_eq!((&ok["call_id"], &ok["name"], &ok["arguments"]), (&json!("call_1"), &json!("bash"), &json!(r#"{"command":"pytest -k spin"}"#)));
    assert_eq!((&ok["call_seq"], &ok["result_seq"], &ok["is_error"]), (&json!(6), &json!(7), &json!(0)));
    assert_eq!((&ok["started_at"], &ok["ended_at"], &ok["duration_ms"], &ok["output_size"]), (&ms("2026-10-20T09:00:05.000Z"), &ms("2026-10-20T09:00:07.000Z"), &json!(2000), &json!(8)));
    let failed = &tools[1];
    assert_eq!((&failed["name"], &failed["is_error"], &failed["duration_ms"], &failed["output_size"]), (&json!("read"), &json!(1), &json!(500), &json!(6)));

    let link = one(store, &format!("SELECT l.* FROM session_links l JOIN sessions s USING (sid) WHERE s.id = '{SESSION_ID}'"));
    assert_eq!((&link["source"], &link["kind"], &link["seq"]), (&json!("entry"), &json!("subagent"), &json!(1)));
    assert_eq!((&link["parent_session_id"], &link["parent_tool_call_id"]), (&json!("parent-0001"), &json!("toolu_parent")));
    assert_eq!((&link["agent_id"], &link["parent_agent_id"], &link["workflow_id"]), (&json!("agent-2"), &json!("agent-1"), &json!("wf-9")));
    assert_eq!((&link["agent_type"], &link["description"]), (&json!("worker"), &json!("Fix the flaky test")));

    // The header's parentSession is the fallback link.
    let child = one(store, &format!("SELECT * FROM sessions WHERE id = '{CHILD_SESSION}'"));
    assert_eq!(child["parent_session_id"], SESSION_ID);
    assert_eq!(child["title"], Value::Null);
    let child_link = one(store, &format!("SELECT l.* FROM session_links l JOIN sessions s USING (sid) WHERE s.id = '{CHILD_SESSION}'"));
    assert_eq!((&child_link["source"], &child_link["parent_session_id"]), (&json!("header"), &json!(SESSION_ID)));

    // Herder step sessions take their project from the link and point at their run.
    let step = one(store, &format!("SELECT * FROM sessions WHERE id = '{STEP_SESSION}'"));
    assert_eq!((&step["project"], &step["herder_run_id"], &step["parent_session_id"]), (&json!("widgets"), &json!(RUN_ID), &json!("orch-1")));
    assert_eq!(step["title"], "Implement T1");
    let step_link = one(store, &format!("SELECT l.* FROM session_links l JOIN sessions s USING (sid) WHERE s.id = '{STEP_SESSION}'"));
    assert_eq!((&step_link["kind"], &step_link["herder_step_key"], &step_link["herder_role"]), (&json!("herder-step"), &json!("impl-T1"), &json!("worker")));
    assert_eq!((&step_link["herder_attempt"], &step_link["herder_launch"]), (&json!(2), &json!(1)));

    let run = one(store, "SELECT * FROM herder_runs");
    assert_eq!((&run["run_id"], &run["device"], &run["repo"]), (&json!(RUN_ID), &json!(DEVICE), &json!("widgets")));
    assert_eq!((&run["repo_path"], &run["title"], &run["session_id"]), (&json!("/home/me/code/widgets"), &json!("Add pagination"), &json!("orch-1")));
    assert_eq!((&run["status"], &run["verdict"], &run["step_count"], &run["event_count"]), (&json!("delivered"), &json!("met"), &json!(2), &json!(15)));
    assert_eq!((&run["goal_sha256"], &run["plan_sha256"]), (&json!("9a1f"), &json!("7c2e")));
    assert_eq!((&run["started_at"], &run["last_at"]), (&ms("2026-10-21T10:00:00.000Z"), &ms("2026-10-21T10:14:00.000Z")));

    let steps = query(store, "SELECT * FROM herder_steps ORDER BY first_seq");
    assert_eq!(steps.len(), 2);
    let s = &steps[0];
    assert_eq!((&s["key"], &s["id"], &s["task"], &s["role"]), (&json!("impl-T1"), &json!("impl-T1"), &json!("T1"), &json!("worker")));
    assert_eq!((&s["label"], &s["phase"], &s["status"], &s["attempts"]), (&json!("Implement T1"), &json!("build"), &json!("ok"), &json!(2)));
    assert_eq!((&s["session_id"], &s["commit_sha"], &s["error"]), (&json!("step-s2"), &json!("c0ffee"), &Value::Null));
    assert_eq!((&s["started_at"], &s["ended_at"]), (&ms("2026-10-21T10:03:01.000Z"), &ms("2026-10-21T10:09:00.000Z")));
    let r = &steps[1];
    assert_eq!((&r["key"], &r["role"], &r["status"], &r["attempts"], &r["error"]), (&json!("review-T1"), &json!("reviewer"), &json!("stopped"), &json!(1), &json!("stopped by user")));

    let events = query(store, "SELECT seq, t FROM herder_events ORDER BY seq");
    assert_eq!(events.len(), 15);
    assert_eq!(events[12]["t"], "custom.future");
}

#[test]
fn reindex_rebuilds_identical_tables() {
    let env = env();
    load_all(&env, 1);
    let incremental = dump_derived(&env.store);
    assert!(incremental.values().all(|rows| !rows.is_empty()));
    let stats = pika::reindex::reindex(&env.store).unwrap();
    assert_eq!(stats.streams, 5);
    assert_eq!(dump_derived(&env.store), incremental);

    // Batch boundaries do not matter either.
    let other = common::env();
    load_all(&other, 1000);
    assert_eq!(dump_derived(&other.store), incremental);
}

/// `JSON.stringify` writes an unpaired UTF-16 surrogate as an escape, for example when pi's grep tool cuts a line
/// between the halves of an emoji. Such lines still derive, with U+FFFD in place of the surrogate.
#[test]
fn lines_with_lone_surrogate_escapes_derive() {
    let env = env();
    let lone = |v: Value| v.to_string().replace("LONE", "\\ud83d");
    let session = vec![
        json!({ "type": "session", "version": 3, "id": "lone-1", "timestamp": "2026-10-20T09:00:00.000Z", "cwd": "/w/x" }).to_string(),
        json!({ "type": "message", "id": "u1", "parentId": null, "timestamp": "2026-10-20T09:00:01.000Z",
                "message": { "role": "user", "content": "grep it", "timestamp": 1 } })
        .to_string(),
        json!({ "type": "message", "id": "a1", "parentId": "u1", "timestamp": "2026-10-20T09:00:02.000Z",
                "message": { "role": "assistant", "content": [{ "type": "toolCall", "id": "call_g", "name": "grep", "arguments": {} }],
                             "stopReason": "toolUse", "timestamp": 2 } })
        .to_string(),
        lone(json!({ "type": "message", "id": "r1", "parentId": "a1", "timestamp": "2026-10-20T09:00:03.500Z",
                     "message": { "role": "toolResult", "toolCallId": "call_g", "toolName": "grep", "isError": true,
                                  "content": [{ "type": "text", "text": "a.txt:1: smile LONE... [truncated]" }], "timestamp": 3 } })),
    ];
    assert!(session[3].contains(r"smile \ud83d..."));
    upload(&env.store, "session:lone-1", "session", &session, 10);
    let result = one(&env.store, "SELECT e.* FROM entries e JOIN sessions s USING (sid) WHERE s.id = 'lone-1' AND e.seq = 3");
    assert_eq!((&result["type"], &result["role"]), (&json!("message"), &json!("toolResult")));
    assert_eq!((&result["entry_id"], &result["parent_id"], &result["tool_call_ids"]), (&json!("r1"), &json!("a1"), &json!(r#"["call_g"]"#)));
    let call = one(&env.store, "SELECT t.* FROM tool_calls t JOIN sessions s USING (sid) WHERE s.id = 'lone-1'");
    assert_eq!((&call["result_seq"], &call["is_error"], &call["duration_ms"]), (&json!(3), &json!(1), &json!(1500)));
    assert_eq!(call["output_size"], json!("a.txt:1: smile \u{fffd}... [truncated]".len()));
    let turn = one(&env.store, "SELECT t.* FROM turns t JOIN sessions s USING (sid) WHERE s.id = 'lone-1'");
    assert_eq!((&turn["tool_calls"], &turn["tool_errors"]), (&json!(1), &json!(1)));

    let journal = vec![
        json!({ "v": 1, "t": "run.started", "at": "2026-10-21T10:00:00.000Z", "runId": "r-lone", "title": "Lone", "repo": "/w/x" }).to_string(),
        lone(json!({ "v": 1, "t": "step.started", "at": "2026-10-21T10:01:00.000Z", "key": "impl-T1", "id": "impl-T1", "attempt": 1,
                     "role": "worker", "task": "T1", "launch": 1, "label": "Cut LONE" })),
    ];
    upload(&env.store, "herder:r-lone", "herder-journal", &journal, 10);
    let event = one(&env.store, "SELECT t FROM herder_events WHERE seq = 1");
    assert_eq!(event["t"], "step.started");
    let step = one(&env.store, "SELECT * FROM herder_steps");
    assert_eq!((&step["key"], &step["status"], &step["label"]), (&json!("impl-T1"), &json!("running"), &json!("Cut \u{fffd}")));
    assert_eq!(one(&env.store, "SELECT step_count FROM herder_runs")["step_count"], 1);
}

/// A displayed extension message, such as `/herder <goal>`'s prompt, starts a turn; a hidden one does not.
#[test]
fn displayed_custom_messages_start_turns() {
    let env = env();
    let entry = |id: &str, seq: i64, fields: Value| {
        let mut v = json!({ "id": id, "parentId": null, "timestamp": format!("2026-10-20T09:00:{seq:02}.000Z") });
        v.as_object_mut().unwrap().extend(fields.as_object().unwrap().clone());
        v.to_string()
    };
    let assistant = |text: &str| json!({ "type": "message", "message": { "role": "assistant", "content": [{ "type": "text", "text": text }], "stopReason": "stop", "timestamp": 1 } });
    let session = vec![
        json!({ "type": "session", "version": 3, "id": "custom-1", "timestamp": "2026-10-20T09:00:00.000Z", "cwd": "/w/x" }).to_string(),
        entry("u1", 1, json!({ "type": "message", "message": { "role": "user", "content": "first", "timestamp": 1 } })),
        entry("a1", 2, assistant("one")),
        entry("c1", 3, json!({ "type": "custom_message", "customType": "herder:prompt", "content": "/herder: run started", "display": true })),
        entry("a2", 4, assistant("two")),
        entry("c2", 5, json!({ "type": "custom_message", "customType": "note", "content": "hidden context", "display": false })),
        entry("a3", 6, assistant("three")),
    ];
    upload(&env.store, "session:custom-1", "session", &session, 3);
    let turns = query(&env.store, "SELECT t.* FROM turns t JOIN sessions s USING (sid) WHERE s.id = 'custom-1' ORDER BY idx");
    let got: Vec<_> = turns.iter().map(|t| (t["start_seq"].clone(), t["end_seq"].clone(), t["user_text"].clone(), t["final_text"].clone())).collect();
    assert_eq!(got, vec![
        (json!(1), json!(2), json!("first"), json!("one")),
        (json!(3), json!(6), json!("/herder: run started"), json!("three")),
    ]);
    let session = one(&env.store, "SELECT first_prompt, turn_count FROM sessions WHERE id = 'custom-1'");
    assert_eq!((&session["first_prompt"], &session["turn_count"]), (&json!("first"), &json!(2)));
}
