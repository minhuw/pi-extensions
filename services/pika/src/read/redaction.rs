//! Scrubbing of what the public session routes return (see `crate::redact`). Each response is scrubbed in one scope,
//! so a credential found anywhere in it is replaced wherever else it appears in it. Only session text is scrubbed:
//! titles, prompts, replies, tool summaries, entries' lines. Ids, seqs, offsets, counts, costs, times, models, cwds,
//! projects and pika's other own fields are left as they are, and the secret-name rule applies only inside session
//! content, so pika's own `tokens` and `firstToken` keep their values.
//!
//! Titles and turns' prompts and replies are read as derive stored them, cut, so a credential across the cut may be
//! left without its end; they are scrubbed as cut text (`Scope::cut_text`) when they are as long as derive keeps.

use serde_json::Value;

use super::Page;
use super::entries::Entry;
use super::herder::{RunDetail, RunSummary};
use super::sessions::{SessionDetail, SessionSummary, SessionTree, Turn, Updates};
use super::trace::{Record, Trace};
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

/// Each entry's line is session content.
pub fn entries(entries: &mut [Entry]) {
    let mut scope = Scope::new();
    entries.iter_mut().for_each(|entry| scope.content(&mut entry.raw));
    scope.finish();
}

/// An entry's verbatim line, scrubbed as session content and written back as one line of JSON. Malformed text
/// becomes a JSON string (AC-1); repaired JSON must be serialized even if it contains no credentials.
pub fn raw(line: String) -> String {
    let strict = serde_json::from_str::<serde_json::Value>(&line);
    let unchanged_bytes = strict.is_ok() && !line.contains(['\n', '\r']);
    let Ok(parsed) = strict.or_else(|_| parse_json_lenient(&line)) else {
        return serde_json::to_string(scrub_text(&line).as_ref()).expect("a JSON string serializes");
    };
    let mut value = parsed.clone();
    scrub_content(&mut value);
    if unchanged_bytes && value == parsed { line } else { serde_json::to_string(&value).expect("a JSON value serializes") }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

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
}
