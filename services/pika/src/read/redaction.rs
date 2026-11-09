//! Scrubbing of what the public session routes return (see `crate::redact`). Each response is scrubbed in one scope,
//! so a credential found anywhere in it is replaced wherever else it appears in it. Only session text is scrubbed:
//! titles, prompts, replies, tool summaries, entries' lines. Ids, seqs, offsets, counts, costs, times, models, cwds,
//! projects and pika's other own fields are left as they are, and the secret-name rule applies only inside session
//! content, so pika's own `tokens` and `firstToken` keep their values.
//!
//! Titles and turns' prompts and replies are read as derive stored them, cut, so a credential across the cut may be
//! left without its end; they are scrubbed as cut text (`Scope::cut_text`) when they are as long as derive keeps.

use std::collections::HashSet;

use serde_json::{Map, Value, json};

use super::Page;
use super::entries::Entry;
use super::herder::{RunDetail, RunSummary};
use super::sessions::{SessionDetail, SessionSummary, SessionTree, Turn, Updates};
use super::trace::{Record, Trace};
use crate::memory;
use crate::redact::{Scope, scrub_content, scrub_text};
use crate::util::parse_json_lenient;

/// How many characters derive keeps of the first prompt for a session's title and of a turn's prompt
/// (`TITLE_CHARS` and `USER_TEXT_CHARS` in `derive::session`).
const TITLE_CHARS: usize = 120;
const USER_TEXT_CHARS: usize = 65_536;

/// A summary's title, and its `link` (the whole `pi-extensions.session-link` entry, with a subagent's description and
/// its spawner's data) as session content. The public namespace drops the link before this.
fn summary<'a>(scope: &mut Scope<'a>, summary: &'a mut SessionSummary) {
    scope.cut_text(&mut summary.title, TITLE_CHARS);
    if let Some(link) = &mut summary.link {
        scope.content(link);
    }
}

fn turn<'a>(scope: &mut Scope<'a>, turn: &'a mut Turn) {
    scope.cut_text(&mut turn.user_text, USER_TEXT_CHARS);
    scope.text(&mut turn.final_text);
    if let Some(spokesman) = &mut turn.spokesman {
        scope.text(&mut spokesman.original_text);
        scope.text(&mut spokesman.rewritten_text);
    }
}

fn text<'a>(scope: &mut Scope<'a>, text: &'a mut Option<String>) {
    if let Some(text) = text {
        scope.text(text);
    }
}

pub fn sessions(page: &mut Page<SessionSummary>) {
    let mut scope = Scope::new();
    page.items.iter_mut().for_each(|s| summary(&mut scope, s));
    scope.finish();
}

pub fn detail(detail: &mut SessionDetail) {
    let mut scope = Scope::new();
    summary(&mut scope, &mut detail.summary);
    detail.children.iter_mut().for_each(|child| summary(&mut scope, &mut child.summary));
    scope.finish();
}

pub fn tree(tree: &mut SessionTree) {
    let mut scope = Scope::new();
    tree.nodes.iter_mut().for_each(|node| summary(&mut scope, &mut node.summary));
    scope.finish();
}

pub fn turns(page: &mut Page<Turn>) {
    let mut scope = Scope::new();
    page.items.iter_mut().for_each(|t| turn(&mut scope, t));
    scope.finish();
}

pub fn updates(updates: &mut Updates) {
    let mut scope = Scope::new();
    if let Some(session) = &mut updates.session {
        summary(&mut scope, session);
    }
    updates.turns.iter_mut().flatten().for_each(|t| turn(&mut scope, t));
    scope.finish();
}

/// Scrubs a trace's original text and structured arguments together, then formats and cuts its summaries. Each
/// string is scanned once; the formatted summaries are made only from the already scrubbed arguments.
pub fn trace(trace: &mut Trace) {
    let mut scope = Scope::new();
    for t in &mut trace.turns {
        scope.cut_text(&mut t.user_text, USER_TEXT_CHARS);
    }
    for record in &mut trace.records {
        match record {
            Record::Llm(record) => {
                text(&mut scope, &mut record.text);
                text(&mut scope, &mut record.error);
            }
            Record::Tool(record) => {
                if let Some(args) = &mut record.arguments {
                    scope.content(args);
                }
            }
            Record::Compaction(_) | Record::BranchSummary(_) => {}
        }
    }
    for child in &mut trace.children {
        text(&mut scope, &mut child.description);
        scope.cut_text(&mut child.title, TITLE_CHARS);
    }
    scope.finish();
    super::trace::finish_public(trace);
}

pub fn runs(page: &mut Page<RunSummary>) {
    let mut scope = Scope::new();
    page.items.iter_mut().for_each(|run| scope.text(&mut run.title));
    scope.finish();
}

/// A run's title, goal, plan, and steps' names as text. Journal events are Herder's own records, so their strings
/// are scrubbed whatever their field is called (a step's `key` stays), except the agent-written `data` of a step and
/// a launch's `args`, which are session content.
pub fn run(detail: &mut RunDetail) {
    let mut scope = Scope::new();
    scope.text(&mut detail.run.title);
    text(&mut scope, &mut detail.goal);
    text(&mut scope, &mut detail.plan);
    for event in &mut detail.events {
        match &mut event.data {
            Value::Object(fields) => {
                for (key, value) in fields.iter_mut() {
                    if key == "data" || key == "args" { scope.content(value) } else { scope.strings(value) }
                }
            }
            data => scope.strings(data),
        }
    }
    for step in &mut detail.steps {
        scope.text(&mut step.key);
        scope.text(&mut step.id);
        scope.text(&mut step.role);
        text(&mut scope, &mut step.task);
        text(&mut scope, &mut step.label);
        text(&mut scope, &mut step.phase);
    }
    scope.finish();
}

/// What stands for omitted memory: a memory tool call's arguments (also a nested one's), a memory tool result's
/// `details`, a `pika-memory` entry's `data`, and a system message's `memory` section.
fn omitted() -> Value {
    json!({ "omitted": "memory" })
}

/// The one text block of a memory tool result's `content`.
pub const OMITTED_RESULT: &str = "[memory tool result omitted]";

/// The system-prompt section the pika extension pins the memory index in (`extensions/pika/memory/index.ts`).
const MEMORY_SECTION: &str = "memory";

/// What stands for the memory section's text where a system message's `content` repeats it.
pub const OMITTED_SECTION: &str = "[memory omitted]";

/// A copy of `call` with only `keep` of its fields, and the omitted marker as its `arguments`: rebuilt rather than
/// edited, so no other field of the call can carry its arguments.
fn omitted_call(call: &Value, keep: &[&str]) -> Value {
    let mut omitted_call = Map::new();
    for &key in keep {
        if let Some(value) = call.get(key) {
            omitted_call.insert(key.into(), value.clone());
        }
    }
    omitted_call.insert("arguments".into(), omitted());
    Value::Object(omitted_call)
}

/// Omits the memory section of a system message, which Pi records as a `message` entry with role `system` and, in
/// full, as a compaction's `systemMessage`: `sections.memory` (unless `null`, which removes the section) becomes the
/// omitted marker, and where `content`, a string or text blocks, repeats the section's text, that text becomes
/// `OMITTED_SECTION`. Pi records `content: ""` beside sections; the other sections stay.
fn omit_section(message: &mut Map<String, Value>) {
    let Some(sections) = message.get_mut("sections").and_then(Value::as_object_mut) else { return };
    let Some(section) = sections.get_mut(MEMORY_SECTION).filter(|section| !section.is_null()) else { return };
    let Value::String(text) = std::mem::replace(section, omitted()) else { return };
    if text.is_empty() {
        return;
    }
    let mut strings = Vec::new();
    match message.get_mut("content") {
        Some(Value::String(content)) => strings.push(content),
        Some(Value::Array(blocks)) => {
            strings.extend(blocks.iter_mut().filter_map(|block| match block.get_mut("text") {
                Some(Value::String(text)) => Some(text),
                _ => None,
            }))
        }
        _ => {}
    }
    for content in strings.into_iter().filter(|content| content.contains(&text)) {
        *content = content.replace(&text, OMITTED_SECTION);
    }
}

/// Omits agent memory from an entry's parsed line, for the public and agent namespaces: a `pika-memory` custom
/// entry's `data`; the `memory` section of system messages, also a compaction's (`omit_section`); the arguments of
/// memory tool calls and the content and details of their results; and the same of a tool result whose tool called
/// a memory tool (`crate::derive::nested_memory`), as a codemode script does, with the arguments of those nested
/// calls, and of its call, which is one of `memory_calls`: the ids of the calls the line makes that are memory through
/// their results (`crate::derive::memory_calls`). Ids, names, and the rest of the line stay, so the entry tree still
/// links and an assistant message keeps its other blocks.
pub fn omit_memory(line: &mut Value, memory_calls: &HashSet<String>) {
    let Some(entry) = line.as_object_mut() else { return };
    let custom = entry.get("customType").and_then(Value::as_str) == Some(memory::CUSTOM_TYPE);
    match entry.get("type").and_then(Value::as_str) {
        Some("custom") if custom => {
            entry.insert("data".into(), omitted());
        }
        Some("compaction") => {
            if let Some(system) = entry.get_mut("systemMessage").and_then(Value::as_object_mut) {
                omit_section(system);
            }
        }
        Some("message") => {
            let Some(message) = entry.get_mut("message") else { return };
            let nested = crate::derive::nested_memory(message);
            let Some(message) = message.as_object_mut() else { return };
            let own = message.get("toolName").and_then(Value::as_str).is_some_and(memory::is_tool);
            match message.get("role").and_then(Value::as_str) {
                Some("system") => omit_section(message),
                Some("assistant") => {
                    for block in message.get_mut("content").and_then(Value::as_array_mut).into_iter().flatten() {
                        let memory = block["name"].as_str().is_some_and(memory::is_tool)
                            || block["id"].as_str().is_some_and(|id| memory_calls.contains(id));
                        if block["type"] == "toolCall" && memory {
                            *block = omitted_call(block, &["type", "id", "name"]);
                        }
                    }
                }
                Some("toolResult") if own || nested => {
                    message.insert("content".into(), json!([{ "type": "text", "text": OMITTED_RESULT }]));
                    if message.contains_key("details") {
                        message.insert("details".into(), omitted());
                    }
                    let calls = message.get_mut("nestedCalls").and_then(|nested| nested.get_mut("calls"));
                    for call in calls.and_then(Value::as_array_mut).into_iter().flatten() {
                        if call["name"].as_str().is_some_and(memory::is_tool) {
                            *call = omitted_call(call, &["id", "name", "status", "durationMs"]);
                        }
                    }
                }
                _ => {}
            }
        }
        _ => {}
    }
}

/// Each entry's line is session content.
pub fn entries(entries: &mut [Entry]) {
    let mut scope = Scope::new();
    entries.iter_mut().for_each(|entry| scope.content(&mut entry.raw));
    scope.finish();
}

/// An entry's verbatim line without its memory (`omit_memory`, with the ids of the calls it makes that are memory
/// through their results), scrubbed as session content and written back as one line of JSON. Malformed text becomes a
/// JSON string (AC-1); repaired JSON must be serialized even if it contains no credentials.
pub fn raw(line: String, memory_calls: &HashSet<String>) -> String {
    let strict = serde_json::from_str::<serde_json::Value>(&line);
    let unchanged_bytes = strict.is_ok() && !line.contains(['\n', '\r']);
    let Ok(parsed) = strict.or_else(|_| parse_json_lenient(&line)) else {
        return serde_json::to_string(scrub_text(&line).as_ref()).expect("a JSON string serializes");
    };
    let mut value = parsed.clone();
    omit_memory(&mut value, memory_calls);
    scrub_content(&mut value);
    if unchanged_bytes && value == parsed { line } else { serde_json::to_string(&value).expect("a JSON value serializes") }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    /// A line none of whose calls is memory through its results.
    fn raw(line: String) -> String {
        super::raw(line, &HashSet::new())
    }

    #[test]
    fn raw_lines_stay_one_line_of_json() {
        let line = json!({ "message": { "content": "DB_PASSWORD=Fake0000Example1111\nnext", "arguments": { "api_key": "x" } } })
            .to_string();
        let out = raw(line);
        assert!(!out.contains('\n') && !out.contains("Fake0000Example1111"), "{out}");
        let out: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(out["message"]["arguments"]["api_key"], crate::redact::REDACTED);
        let plain = r#"{"a": 1,  "b": "plain"}"#.to_owned();
        assert_eq!(raw(plain.clone()), plain);
        // AC-1 requires valid JSON even for an accepted non-JSON entry: the fallback is a string value.
        assert_eq!(raw("not json DB_PASSWORD=Fake0000Example1111".into()), r#""not json DB_PASSWORD=[REDACTED:SECRET]""#);
        for text in ["ordinary malformed text", "bad \"quote\"\t\r\n\u{0001}\\path"] {
            let out = raw(text.into());
            assert!(!out.contains(['\n', '\r']));
            assert_eq!(serde_json::from_str::<Value>(&out).unwrap(), json!(text));
        }
        for text in [r#"{"text":"ordinary\ud800"}"#, r#"{"text":"ordinary\udc00"}"#] {
            assert!(serde_json::from_str::<Value>(text).is_err());
            assert_eq!(serde_json::from_str::<Value>(&raw(text.into())).unwrap(), json!({ "text": "ordinary�" }));
        }
        assert_eq!(raw("{\n\"plain\": 1\n}".into()), r#"{"plain":1}"#);
    }

    /// A system message's `content`, which Pi records empty, loses the memory section's text where it repeats it; a
    /// section removed with `null` stays, as does a system message without a memory section.
    #[test]
    fn system_messages_lose_their_memory_section() {
        let section = "Notes.\n- Tabs — fake note [0123456789ab]";
        let mut line = json!({ "type": "message", "message": { "role": "system",
            "content": format!("Base prompt.\n\n{section}"), "sections": { "preamble": "You are pi.", "memory": section } } });
        omit_memory(&mut line, &HashSet::new());
        assert_eq!(line["message"]["content"], "Base prompt.\n\n[memory omitted]");
        assert_eq!(line["message"]["sections"], json!({ "preamble": "You are pi.", "memory": { "omitted": "memory" } }));
        let mut line = json!({ "type": "compaction", "systemMessage": { "role": "system",
            "content": [{ "type": "text", "text": section }, { "type": "text", "text": "Other." }], "sections": { "memory": section } } });
        omit_memory(&mut line, &HashSet::new());
        assert_eq!(line["systemMessage"]["content"], json!([{ "type": "text", "text": OMITTED_SECTION }, { "type": "text", "text": "Other." }]));
        for unchanged in [
            json!({ "type": "message", "message": { "role": "system", "content": "", "sections": { "memory": null } } }),
            json!({ "type": "message", "message": { "role": "system", "content": "", "sections": { "tools": "Tools." } } }),
            json!({ "type": "compaction", "summary": "No system message." }),
        ] {
            let mut line = unchanged.clone();
            omit_memory(&mut line, &HashSet::new());
            assert_eq!(line, unchanged);
        }
    }

    /// A call is memory by its name, or by its id when its result shows it called a memory tool; a result is memory by
    /// its tool's name or its nested calls, and its other nested calls keep their arguments.
    #[test]
    fn calls_are_memory_by_name_or_through_their_results() {
        let assistant = json!({ "type": "message", "message": { "role": "assistant", "content": [
            { "type": "toolCall", "id": "a", "name": "codemode", "arguments": { "code": "x" }, "partialJson": "x" },
            { "type": "toolCall", "id": "b", "name": "codemode", "arguments": { "code": "y" } },
        ] } });
        let mut line = assistant.clone();
        omit_memory(&mut line, &HashSet::from(["a".to_owned()]));
        assert_eq!(line["message"]["content"][0], json!({ "type": "toolCall", "id": "a", "name": "codemode", "arguments": { "omitted": "memory" } }));
        assert_eq!(line["message"]["content"][1], assistant["message"]["content"][1]);
        // A result whose nested calls name no memory tool is not memory, whatever its text says.
        let plain = json!({ "type": "message", "message": { "role": "toolResult", "toolCallId": "b", "toolName": "codemode",
            "content": [{ "type": "text", "text": "memory_read" }], "nestedCalls": { "calls": [{ "name": "read", "arguments": {} }] } } });
        let mut line = plain.clone();
        omit_memory(&mut line, &HashSet::new());
        assert_eq!(line, plain);
        let mut line = json!({ "type": "message", "message": { "role": "toolResult", "toolCallId": "a", "toolName": "codemode",
            "content": [{ "type": "text", "text": "note" }],
            "nestedCalls": { "calls": [{ "name": "dream_save", "argumentsBytes": 9000, "status": "ok" }], "complete": false } } });
        omit_memory(&mut line, &HashSet::new());
        assert_eq!(line["message"]["content"], json!([{ "type": "text", "text": OMITTED_RESULT }]));
        assert_eq!(line["message"].get("details"), None);
        assert_eq!(
            line["message"]["nestedCalls"],
            json!({ "calls": [{ "name": "dream_save", "status": "ok", "arguments": { "omitted": "memory" } }], "complete": false })
        );
    }
}
