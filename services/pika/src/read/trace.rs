//! `GET sessions/:id/trace`: one compact, session-wide list of records for the trajectory view, built from the derived
//! tables so the overview needs no raw entries. Only assistant lines (for their first text, thinking, and `durationMs`)
//! and compaction lines (for `tokensBefore`) are read.

use std::borrow::Cow;
use std::collections::HashMap;
use std::fmt::Write as _;
use std::sync::LazyLock;

use rusqlite::types::ValueRef;
use rusqlite::{Connection, Row};
use serde::de::{MapAccess, Visitor};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;
use serde_json::value::RawValue;
use sha2::{Digest, Sha256};

use super::sessions::Tokens;
use super::{ReadError, ReadResult};
use crate::blobs::BlobStore;
use crate::requests::{FIRST_TOKEN_KINDS, MAX_TIME_MS};
use crate::util::{cut_chars, parse_json_lenient};

/// `userText` is cut to this many characters.
pub const USER_TEXT_CHARS: usize = 200;
/// `text` and `summary` are cut to this many characters.
pub const SUMMARY_CHARS: usize = 160;
/// A line in the blob store (over 1 MiB) is read only when it decompresses to at most this many bytes; a longer one
/// gives its record no text, thinking, duration, or `tokensBefore`.
pub const BLOB_LINE_BYTES: u64 = 4 << 20;
/// A request's timing is left out more than this long before its model call's start ...
const TIMING_BEFORE_MS: i64 = 60_000;
/// ... or after its end.
const TIMING_AFTER_MS: i64 = 1_000;
/// A model call's `durationMs` over a week is left out.
const MAX_DURATION_MS: f64 = 7.0 * 24.0 * 3600.0 * 1000.0;

/// Random per server process, so a new build, whose trace may differ for the same rows, never matches an old tag.
static INSTANCE: LazyLock<[u8; 8]> = LazyLock::new(crate::util::random_bytes);

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Trace {
    pub session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_at: Option<i64>,
    pub turns: Vec<TraceTurn>,
    pub records: Vec<Record>,
    pub children: Vec<TraceChild>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceTurn {
    pub index: i64,
    pub start_seq: i64,
    pub end_seq: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub at: Option<i64>,
    pub duration_ms: i64,
    pub user_text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub custom_type: Option<String>,
    pub model_calls: i64,
    pub tool_calls: i64,
    pub tool_errors: i64,
    pub cost: f64,
    pub tokens: Tokens,
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum Record {
    Llm(LlmRecord),
    Tool(ToolRecord),
    Compaction(SummaryRecord),
    BranchSummary(SummaryRecord),
}

impl Record {
    fn seq(&self) -> i64 {
        match self {
            Record::Llm(r) => r.seq,
            Record::Tool(r) => r.seq,
            Record::Compaction(r) | Record::BranchSummary(r) => r.seq,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmRecord {
    pub seq: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sent_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub response_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub first_token_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub first_token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stop_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub input: i64,
    pub output: i64,
    pub cache_read: i64,
    pub cache_write: i64,
    pub cost: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thinking: Option<bool>,
    pub tool_calls: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolRecord {
    pub seq: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result_seq: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn: Option<i64>,
    pub call_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<i64>,
    pub is_error: bool,
    pub summary: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_size: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub child_session_id: Option<String>,
}

/// A `compaction` or `branch_summary` entry.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SummaryRecord {
    pub seq: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tokens_before: Option<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceChild {
    pub session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_tool_call_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_at: Option<i64>,
    pub entry_count: i64,
    pub tokens: Tokens,
    pub cost: f64,
    pub title: String,
}

pub(crate) const SESSION_SQL: &str = "SELECT sid, started_at, last_at, entry_count FROM sessions WHERE id = ?1";

pub(crate) const TURNS_SQL: &str = "SELECT t.idx, t.start_seq, t.end_seq, substr(t.user_text, 1, 200), t.at, t.duration_ms,
         t.model_calls, t.tool_calls, t.tool_errors, t.cost, t.input, t.output, t.cache_read, t.cache_write, e.custom_type
     FROM turns t LEFT JOIN entries e ON e.sid = t.sid AND e.seq = t.start_seq AND e.type = 'custom_message'
     WHERE t.sid = ?1 ORDER BY t.idx";

pub(crate) const MODEL_CALLS_SQL: &str = "SELECT m.seq, m.turn, m.ts, m.at, m.model, m.provider, m.stop_reason, m.error_message,
         m.input, m.output, m.cache_read, m.cache_write, m.cost, m.request_id, l.data, l.blob, e.tool_call_ids, r.timing
     FROM model_calls m
     LEFT JOIN entries e ON e.sid = m.sid AND e.seq = m.seq
     LEFT JOIN lines l ON l.stream_id = e.sid AND l.offset = e.offset
     LEFT JOIN requests r ON r.id = m.request_id
     WHERE m.sid = ?1 ORDER BY m.seq";

pub(crate) const TOOL_CALLS_SQL: &str = "SELECT call_id, name, arguments, turn, call_seq, result_seq, is_error, started_at, ended_at,
         duration_ms, output_size
     FROM tool_calls WHERE sid = ?1";

/// Compactions and branch summaries: a walk of the session's entries by primary key, which reads only the small
/// derived rows, then one line lookup per match.
pub(crate) const SUMMARIES_SQL: &str = "SELECT e.seq, e.type, e.turn, e.ts, l.data, l.blob
     FROM entries e LEFT JOIN lines l ON l.stream_id = e.sid AND l.offset = e.offset
     WHERE e.sid = ?1 AND e.type IN ('compaction', 'branch_summary') ORDER BY e.seq";

pub(crate) const CHILDREN_SQL: &str = "SELECT s.id, s.started_at, s.last_at, s.entry_count, s.input, s.output, s.cache_read,
         s.cache_write, s.cost, s.title, s.herder_run_id, l.parent_tool_call_id, l.agent_type, l.description, l.kind
     FROM sessions s LEFT JOIN session_links l USING (sid)
     WHERE s.parent_session_id = ?1 ORDER BY s.started_at IS NULL, s.started_at, s.id";

/// What the trace is built from, changing whenever the trace can: the session's rows grow with its entries (`entry_count`
/// and `last_at`), except for `requestId` and the request's timing, which a request arriving after its model call
/// sets (requests are only inserted, with their timing; a resend is a no-op); the children's rows grow with their
/// entries, and a new child adds one; and a reindex, which can change derived rows without changing any count, records
/// a new `derived_generation`.
pub(crate) const FINGERPRINT_SQL: &str = "SELECT s.sid, s.entry_count, s.last_at,
         (SELECT COUNT(*) FROM requests r WHERE r.session_id = s.id),
         c.n, c.entries, c.last_at,
         (SELECT value FROM settings WHERE key = 'derived_generation')
     FROM sessions s,
         (SELECT COUNT(*) AS n, COALESCE(SUM(entry_count), 0) AS entries, MAX(last_at) AS last_at
          FROM sessions WHERE parent_session_id = ?1) c
     WHERE s.id = ?1";

/// A session's start and end, as `SessionSummary` reports them: none without entries or times.
fn times(started_at: Option<i64>, last_at: i64, entry_count: i64) -> (Option<i64>, Option<i64>) {
    let has_time = entry_count > 0 && (started_at.is_some() || last_at != 0);
    let last = has_time.then_some(last_at);
    (if has_time { started_at.or(last) } else { None }, last)
}

/// Replaces control characters with spaces, trims, and cuts to `SUMMARY_CHARS` characters, mapping only the characters
/// it keeps.
fn one_line(s: &str) -> String {
    let blank = |c: char| c.is_whitespace() || c.is_control();
    let s = s.trim_start_matches(blank);
    let cut = cut_chars(s, SUMMARY_CHARS);
    // As if the whole string were trimmed before cutting: the end is trimmed only when nothing but blanks follows.
    let cut = if s[cut.len()..].chars().all(blank) { cut.trim_end_matches(blank) } else { cut };
    cut.chars().map(|c| if c.is_control() { ' ' } else { c }).collect()
}

fn first_line(s: &str) -> &str {
    let s = s.trim_start();
    s.split(['\n', '\r']).next().unwrap_or(s)
}

/// A string borrowed from the JSON text unless it has escapes.
#[derive(Deserialize)]
struct Text<'a>(#[serde(borrow)] Cow<'a, str>);

/// A tool call's arguments: each top-level key with its raw value, in order, so a summary decodes only the strings it
/// uses.
struct Args<'a>(Vec<(Cow<'a, str>, &'a RawValue)>);

impl<'de: 'a, 'a> Deserialize<'de> for Args<'a> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct ArgsVisitor<'a>(std::marker::PhantomData<&'a ()>);
        impl<'de: 'a, 'a> Visitor<'de> for ArgsVisitor<'a> {
            type Value = Args<'a>;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("an object")
            }
            fn visit_map<M: MapAccess<'de>>(self, mut map: M) -> Result<Args<'a>, M::Error> {
                let mut fields = Vec::new();
                while let Some((Text(key), value)) = map.next_entry::<Text<'de>, &'de RawValue>()? {
                    fields.push((key, value));
                }
                Ok(Args(fields))
            }
        }
        deserializer.deserialize_map(ArgsVisitor(std::marker::PhantomData))
    }
}

/// What a summary reads from a tool call's arguments.
trait ArgSource {
    /// The value of `key`, if it is a string.
    fn string(&self, key: &str) -> Option<Cow<'_, str>>;
    /// The value of `key`, if it is a number, or else a non-blank string, trimmed.
    fn number(&self, key: &str) -> Option<String>;
    /// The string values, in order.
    fn strings(&self) -> impl Iterator<Item = Cow<'_, str>>;
}

/// Lenient parses of arguments that the borrowed parse rejects, and tests.
impl ArgSource for Value {
    fn string(&self, key: &str) -> Option<Cow<'_, str>> {
        self.get(key).and_then(Value::as_str).map(Cow::Borrowed)
    }

    fn number(&self, key: &str) -> Option<String> {
        match self.get(key)? {
            Value::Number(n) => Some(n.to_string()),
            Value::String(s) if !s.trim().is_empty() => Some(s.trim().to_owned()),
            _ => None,
        }
    }

    fn strings(&self) -> impl Iterator<Item = Cow<'_, str>> {
        self.as_object().into_iter().flat_map(|o| o.values()).filter_map(Value::as_str).map(Cow::Borrowed)
    }
}

fn raw_string(raw: &RawValue) -> Option<Cow<'_, str>> {
    let raw = raw.get();
    if !raw.starts_with('"') {
        return None;
    }
    match serde_json::from_str::<Text>(raw) {
        Ok(Text(s)) => Some(s),
        // A lone surrogate escape, which only the lenient parse accepts.
        Err(_) => match parse_json_lenient(raw) {
            Ok(Value::String(s)) => Some(Cow::Owned(s)),
            _ => None,
        },
    }
}

impl ArgSource for Args<'_> {
    fn string(&self, key: &str) -> Option<Cow<'_, str>> {
        // The last of duplicate keys wins, as in a parsed object.
        self.0.iter().rfind(|(k, _)| k == key).and_then(|(_, v)| raw_string(v))
    }

    fn number(&self, key: &str) -> Option<String> {
        let (_, raw) = self.0.iter().rfind(|(k, _)| k == key)?;
        match raw_string(raw) {
            Some(s) => Some(s.trim().to_owned()).filter(|s| !s.is_empty()),
            None => serde_json::from_str::<serde_json::Number>(raw.get()).ok().map(|n| n.to_string()),
        }
    }

    fn strings(&self) -> impl Iterator<Item = Cow<'_, str>> {
        self.0.iter().filter_map(|(_, v)| raw_string(v))
    }
}

fn arg_str<'a>(args: &'a impl ArgSource, keys: &[&str]) -> Option<Cow<'a, str>> {
    keys.iter().find_map(|k| args.string(k)).filter(|s| !s.trim().is_empty())
}

/// The first string argument of at most `SUMMARY_CHARS` characters, or else the first line of the first string
/// argument.
fn first_string(args: &impl ArgSource) -> Option<String> {
    let mut first = None;
    for s in args.strings().filter(|s| !s.trim().is_empty()) {
        if s.chars().nth(SUMMARY_CHARS).is_none() {
            return Some(one_line(&s));
        }
        first.get_or_insert(s);
    }
    first.map(|s| one_line(first_line(&s)))
}

/// A tool call's one-line summary from its name and arguments (see the spec's `trace` route).
fn tool_summary(name: &str, args: &impl ArgSource) -> String {
    let path = || arg_str(args, &["path", "file_path"]);
    let text = match name.to_ascii_lowercase().as_str() {
        "bash" | "shell" | "powershell" => arg_str(args, &["command", "cmd"]).map(|c| one_line(first_line(&c))),
        "read" => path().map(|p| {
            let range = match (args.number("offset"), args.number("limit")) {
                (Some(offset), Some(limit)) => format!(":{offset}-{limit}"),
                (Some(offset), None) => format!(":{offset}"),
                (None, Some(limit)) => format!(":-{limit}"),
                (None, None) => String::new(),
            };
            one_line(&format!("{p}{range}"))
        }),
        "write" | "edit" => path().map(|p| one_line(&p)),
        "grep" | "find" | "ls" | "glob" => match (arg_str(args, &["pattern"]), path()) {
            (Some(pattern), Some(path)) => Some(one_line(&format!("{pattern} in {path}"))),
            (pattern, path) => pattern.or(path).map(|s| one_line(&s)),
        },
        "web_search" => arg_str(args, &["query"]).map(|s| one_line(&s)),
        "web_fetch" => arg_str(args, &["url"]).map(|s| one_line(&s)),
        "agent" => match (arg_str(args, &["subagent_type"]), arg_str(args, &["description"])) {
            (Some(ty), Some(description)) => Some(one_line(&format!("{ty}: {description}"))),
            (ty, description) => ty.or(description).map(|s| one_line(&s)),
        },
        _ => None,
    };
    text.or_else(|| first_string(args)).unwrap_or_default()
}

/// The summary of a tool call from its stored arguments, which are JSON; anything but an object summarizes as empty.
fn arguments_summary(name: &str, arguments: &str) -> String {
    match serde_json::from_str::<Args>(arguments) {
        Ok(args) => tool_summary(name, &args),
        // A lone surrogate escape, which only the lenient parse accepts.
        Err(_) if arguments.trim_start().starts_with('{') => {
            parse_json_lenient(arguments).map(|v| tool_summary(name, &v)).unwrap_or_default()
        }
        Err(_) => String::new(),
    }
}

#[derive(Deserialize)]
struct AssistantLine<'a> {
    #[serde(borrow)]
    message: Option<AssistantMessage<'a>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AssistantMessage<'a> {
    #[serde(borrow, default)]
    content: Option<Vec<Block<'a>>>,
    duration_ms: Option<f64>,
}

#[derive(Deserialize)]
struct Block<'a> {
    #[serde(rename = "type", borrow)]
    ty: Option<Cow<'a, str>>,
    #[serde(borrow)]
    text: Option<Cow<'a, str>>,
}

/// What the trace shows of an assistant line: its first non-empty text, whether it has a thinking block, and its
/// `durationMs`.
#[derive(Debug, Default, PartialEq)]
struct AssistantFacts {
    text: Option<String>,
    thinking: bool,
    duration_ms: Option<f64>,
}

fn assistant_facts(line: &str) -> AssistantFacts {
    let from_blocks = |types: &mut dyn Iterator<Item = (Option<&str>, Option<&str>)>, duration_ms| {
        let mut facts = AssistantFacts { duration_ms, ..AssistantFacts::default() };
        for (ty, text) in types {
            match ty {
                Some("thinking") => facts.thinking = true,
                Some("text") if facts.text.is_none() => {
                    facts.text = text.filter(|t| !t.trim().is_empty()).map(one_line);
                }
                _ => {}
            }
        }
        facts
    };
    // Typed parsing skips the tool arguments and thinking text without building values for them.
    if let Ok(parsed) = serde_json::from_str::<AssistantLine>(line) {
        let Some(message) = parsed.message else { return AssistantFacts::default() };
        let blocks = message.content.unwrap_or_default();
        return from_blocks(&mut blocks.iter().map(|b| (b.ty.as_deref(), b.text.as_deref())), message.duration_ms);
    }
    let Ok(v) = parse_json_lenient(line) else { return AssistantFacts::default() };
    let message = &v["message"];
    let blocks = message["content"].as_array().map(Vec::as_slice).unwrap_or_default();
    from_blocks(&mut blocks.iter().map(|b| (b["type"].as_str(), b["text"].as_str())), message["durationMs"].as_f64())
}

/// A model call's start and end: pi's `timestamp` is when the request started, and `durationMs` runs from it to the end
/// of the response; the entry is appended after the response, so its time is the end when `durationMs` is absent.
/// Implausible times and durations are left out.
fn llm_times(ts: Option<i64>, at: Option<i64>, duration_ms: Option<f64>) -> (Option<i64>, Option<i64>) {
    let plausible = |t: &i64| (0..=MAX_TIME_MS).contains(t);
    let (start, at) = (ts.filter(plausible), at.filter(plausible));
    let end = match (start, duration_ms) {
        (Some(start), Some(ms)) if (0.0..=MAX_DURATION_MS).contains(&ms) => start.checked_add(ms.round() as i64).or(at),
        _ => at,
    };
    (start, end)
}

/// A request's stored `timing` (see `requests::timing`).
#[derive(Debug, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Timing {
    sent_at: Option<i64>,
    response_at: Option<i64>,
    first_token_at: Option<i64>,
    first_token: Option<String>,
}

/// The timing of a model call's request, without times implausible for the call: those more than `TIMING_BEFORE_MS`
/// before its start or `TIMING_AFTER_MS` after its end, when known. `firstToken` goes with `firstTokenAt`.
fn llm_timing(timing: Option<&str>, start: Option<i64>, end: Option<i64>) -> Timing {
    let Some(t) = timing.and_then(|t| serde_json::from_str::<Timing>(t).ok()) else { return Timing::default() };
    let plausible = |t: &i64| {
        (0..=MAX_TIME_MS).contains(t)
            && start.is_none_or(|start| *t >= start.saturating_sub(TIMING_BEFORE_MS))
            && end.is_none_or(|end| *t <= end.saturating_add(TIMING_AFTER_MS))
    };
    let first_token_at = t.first_token_at.filter(plausible);
    Timing {
        sent_at: t.sent_at.filter(plausible),
        response_at: t.response_at.filter(plausible),
        first_token_at,
        first_token: t.first_token.filter(|k| first_token_at.is_some() && FIRST_TOKEN_KINDS.contains(&k.as_str())),
    }
}

fn tokens_before(line: &str) -> Option<i64> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Summary {
        tokens_before: Option<Value>,
    }
    let value = match serde_json::from_str::<Summary>(line) {
        Ok(s) => s.tokens_before,
        Err(_) => parse_json_lenient(line).ok().and_then(|v| v.get("tokensBefore").cloned()),
    }?;
    value.as_i64().or_else(|| value.as_f64().map(|f| f.round() as i64))
}

fn turn_row(r: &Row) -> rusqlite::Result<TraceTurn> {
    Ok(TraceTurn {
        index: r.get(0)?,
        start_seq: r.get(1)?,
        end_seq: r.get(2)?,
        user_text: cut_chars(&r.get::<_, String>(3)?, USER_TEXT_CHARS).to_owned(),
        at: r.get(4)?,
        duration_ms: r.get(5)?,
        model_calls: r.get(6)?,
        tool_calls: r.get(7)?,
        tool_errors: r.get(8)?,
        cost: r.get(9)?,
        tokens: Tokens { input: r.get(10)?, output: r.get(11)?, cache_read: r.get(12)?, cache_write: r.get(13)? },
        custom_type: r.get(14)?,
    })
}

fn child_row(r: &Row) -> rusqlite::Result<TraceChild> {
    let (started_at, last_at) = times(r.get(1)?, r.get(2)?, r.get(3)?);
    let herder_run: Option<String> = r.get(10)?;
    let kind: Option<String> = r.get(14)?;
    Ok(TraceChild {
        session_id: r.get(0)?,
        parent_tool_call_id: r.get(11)?,
        agent_type: r.get(12)?,
        description: r.get(13)?,
        kind: if kind.as_deref() == Some("herder-step") || herder_run.is_some() { "herder-step" } else { "subagent" },
        started_at,
        last_at,
        entry_count: r.get(3)?,
        tokens: Tokens { input: r.get(4)?, output: r.get(5)?, cache_read: r.get(6)?, cache_write: r.get(7)? },
        cost: r.get(8)?,
        title: r.get::<_, Option<String>>(9)?.unwrap_or_default(),
    })
}

/// A text column without copying it.
fn text_ref<'a>(r: &'a Row, i: usize) -> rusqlite::Result<Option<&'a str>> {
    Ok(r.get_ref(i)?.as_str_or_null()?)
}

/// A line's text from its row: borrowed when it is stored inline; read from the blob store when it is not, unless it is
/// longer than `BLOB_LINE_BYTES`. A blob that cannot be read is counted in `failed` and gives no text.
fn line_text<'a>(r: &'a Row, data: usize, blobs: &BlobStore, failed: &mut BlobFailures) -> rusqlite::Result<Option<Cow<'a, str>>> {
    if let ValueRef::Text(text) = r.get_ref(data)? {
        return Ok(std::str::from_utf8(text).ok().map(Cow::Borrowed));
    }
    let Some(hash) = text_ref(r, data + 1)? else { return Ok(None) };
    Ok(match blobs.get_bounded(hash, BLOB_LINE_BYTES) {
        Ok(bytes) => bytes.and_then(|b| String::from_utf8(b).ok()).map(Cow::Owned),
        Err(e) => {
            failed.count += 1;
            failed.first.get_or_insert_with(|| format!("{e:#}"));
            None
        }
    })
}

/// Blob-stored lines that could not be read, logged once per trace.
#[derive(Default)]
struct BlobFailures {
    count: usize,
    first: Option<String>,
}

/// The trace's fingerprint (see `FINGERPRINT_SQL`), as 32 hex digits.
pub fn fingerprint(conn: &Connection, id: &str) -> ReadResult<String> {
    let row = conn
        .prepare_cached(FINGERPRINT_SQL)?
        .query_row([id], |r| {
            let mut key = hex::encode(*INSTANCE);
            for i in 0..7 {
                write!(key, ".{:?}", r.get::<_, Option<i64>>(i)?).expect("writing to a string");
            }
            if let Some(generation) = r.get::<_, Option<Vec<u8>>>(7)? {
                write!(key, ".{}", hex::encode(generation)).expect("writing to a string");
            }
            Ok(key)
        })
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => ReadError::NotFound,
            e => e.into(),
        })?;
    Ok(hex::encode(&Sha256::digest(row.as_bytes())[..16]))
}

/// The trace's fingerprint and, unless `unchanged` says the client has that version, the trace, from one snapshot.
pub fn trace_if_changed(
    conn: &Connection,
    blobs: &BlobStore,
    id: &str,
    unchanged: impl FnOnce(&str) -> bool,
) -> ReadResult<(String, Option<Trace>)> {
    // Reuse the caller's snapshot when publication was checked in it.
    let _tx = conn.is_autocommit().then(|| conn.unchecked_transaction()).transpose()?;
    let tx = conn;
    let fingerprint = fingerprint(tx, id)?;
    if unchanged(&fingerprint) {
        return Ok((fingerprint, None));
    }
    let trace = build(tx, blobs, id)?;
    Ok((fingerprint, Some(trace)))
}

pub fn trace(conn: &Connection, blobs: &BlobStore, id: &str) -> ReadResult<Trace> {
    // One snapshot for every table.
    // Reuse the caller's snapshot when publication was checked in it.
    let _tx = conn.is_autocommit().then(|| conn.unchecked_transaction()).transpose()?;
    let tx = conn;
    build(tx, blobs, id)
}

fn build(tx: &Connection, blobs: &BlobStore, id: &str) -> ReadResult<Trace> {
    let (sid, started_at, last_at, entry_count): (i64, Option<i64>, i64, i64) = tx
        .prepare_cached(SESSION_SQL)?
        .query_row([id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => ReadError::NotFound,
            e => e.into(),
        })?;
    let (started_at, last_at) = times(started_at, last_at, entry_count);

    let turns = tx.prepare_cached(TURNS_SQL)?.query_map([sid], turn_row)?.collect::<rusqlite::Result<Vec<_>>>()?;
    let children = tx.prepare_cached(CHILDREN_SQL)?.query_map([id], child_row)?.collect::<rusqlite::Result<Vec<_>>>()?;
    // A workflow call can start several children; the tool record names the first.
    let mut child_of: HashMap<&str, &str> = HashMap::new();
    for child in &children {
        if let Some(call_id) = &child.parent_tool_call_id {
            child_of.entry(call_id.as_str()).or_insert(child.session_id.as_str());
        }
    }

    let mut records = Vec::new();
    let mut calls_per_seq: HashMap<i64, i64> = HashMap::new();
    let mut stmt = tx.prepare_cached(TOOL_CALLS_SQL)?;
    let mut rows = stmt.query([sid])?;
    while let Some(r) = rows.next()? {
        let call_id: String = r.get(0)?;
        let name: Option<String> = r.get(1)?;
        let call_seq: Option<i64> = r.get(4)?;
        let result_seq: Option<i64> = r.get(5)?;
        // A result without its call is placed at the result.
        let Some(seq) = call_seq.or(result_seq) else { continue };
        if let Some(call_seq) = call_seq {
            *calls_per_seq.entry(call_seq).or_default() += 1;
        }
        let summary = match text_ref(r, 2)? {
            Some(arguments) => arguments_summary(name.as_deref().unwrap_or(""), arguments),
            None => String::new(),
        };
        let started: Option<i64> = r.get(7)?;
        records.push(Record::Tool(ToolRecord {
            seq,
            result_seq,
            turn: r.get(3)?,
            summary,
            child_session_id: child_of.get(call_id.as_str()).map(|s| s.to_string()),
            call_id,
            name,
            start: started,
            end: r.get(8)?,
            duration_ms: if started.is_some() { r.get(9)? } else { None },
            is_error: r.get::<_, Option<bool>>(6)?.unwrap_or(false),
            output_size: r.get(10)?,
        }));
    }
    drop(rows);

    let mut failed = BlobFailures::default();
    // Each call's position in its assistant message.
    let mut position: HashMap<String, usize> = HashMap::new();
    let mut stmt = tx.prepare_cached(MODEL_CALLS_SQL)?;
    let mut rows = stmt.query([sid])?;
    while let Some(r) = rows.next()? {
        let seq: i64 = r.get(0)?;
        if let Some(ids) = r.get::<_, Option<String>>(16)? {
            let ids: Vec<String> = serde_json::from_str(&ids).unwrap_or_default();
            position.extend(ids.into_iter().enumerate().map(|(i, id)| (id, i + 1)));
        }
        let facts = line_text(r, 14, blobs, &mut failed)?.map(|line| assistant_facts(&line)).unwrap_or_default();
        let (start, end) = llm_times(r.get(2)?, r.get(3)?, facts.duration_ms);
        let timing = llm_timing(text_ref(r, 17)?, start, end);
        records.push(Record::Llm(LlmRecord {
            seq,
            turn: r.get(1)?,
            start,
            end,
            sent_at: timing.sent_at,
            response_at: timing.response_at,
            first_token_at: timing.first_token_at,
            first_token: timing.first_token,
            model: r.get(4)?,
            provider: r.get(5)?,
            stop_reason: r.get(6)?,
            error: r.get(7)?,
            input: r.get(8)?,
            output: r.get(9)?,
            cache_read: r.get(10)?,
            cache_write: r.get(11)?,
            cost: r.get(12)?,
            request_id: r.get(13)?,
            text: facts.text,
            thinking: facts.thinking.then_some(true),
            tool_calls: calls_per_seq.get(&seq).copied().unwrap_or(0),
        }));
    }
    drop(rows);

    let mut stmt = tx.prepare_cached(SUMMARIES_SQL)?;
    let mut rows = stmt.query([sid])?;
    while let Some(r) = rows.next()? {
        let ty: String = r.get(1)?;
        let mut record = SummaryRecord { seq: r.get(0)?, turn: r.get(2)?, at: r.get(3)?, tokens_before: None };
        if ty == "compaction" {
            record.tokens_before = line_text(r, 4, blobs, &mut failed)?.and_then(|line| tokens_before(&line));
            records.push(Record::Compaction(record));
        } else {
            records.push(Record::BranchSummary(record));
        }
    }
    drop(rows);
    drop(stmt);
    if let Some(first) = failed.first {
        tracing::warn!("trace of session {id}: {} stored lines could not be read; the first: {first}", failed.count);
    }

    // A tool call shares its assistant message's seq and follows it, in the message's order.
    records.sort_by_cached_key(|r| {
        let rank = match r {
            Record::Tool(t) => position.get(&t.call_id).copied().unwrap_or(usize::MAX),
            _ => 0,
        };
        (r.seq(), rank)
    });
    Ok(Trace { session_id: id.to_owned(), started_at, last_at, turns, records, children })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn summaries_by_tool_family() {
        let s = |name: &str, args: Value| tool_summary(name, &args);
        assert_eq!(s("bash", json!({ "command": "\n  cargo test\n--locked", "timeout": 60 })), "cargo test");
        assert_eq!(s("read", json!({ "path": "src/a.rs", "offset": 10, "limit": 40 })), "src/a.rs:10-40");
        assert_eq!(s("read", json!({ "path": "src/a.rs", "offset": 10 })), "src/a.rs:10");
        assert_eq!(s("read", json!({ "path": "src/a.rs" })), "src/a.rs");
        assert_eq!(s("edit", json!({ "path": "b.rs", "oldText": "x", "newText": "y" })), "b.rs");
        assert_eq!(s("grep", json!({ "pattern": "fn main", "path": "src" })), "fn main in src");
        assert_eq!(s("ls", json!({ "path": "src" })), "src");
        assert_eq!(s("web_search", json!({ "query": "rust gzip" })), "rust gzip");
        assert_eq!(s("web_fetch", json!({ "url": "https://example.com/a" })), "https://example.com/a");
        assert_eq!(s("Agent", json!({ "subagent_type": "recon", "description": "Map it", "prompt": "..." })), "recon: Map it");
        assert_eq!(s("mcp__rea__decompile", json!({ "n": 3, "target": "libfoo.so" })), "libfoo.so");
        assert_eq!(s("codemode", json!({ "code": format!("const a = 1;\n{}", "x".repeat(300)) })), "const a = 1;");
        assert_eq!(s("other", json!({ "a": 1 })), "");
        assert_eq!(s("bash", json!({ "command": format!("echo\t{}", "é".repeat(400)) })).chars().count(), SUMMARY_CHARS);
        assert_eq!(s("bash", json!({ "command": "a\u{7}b" })), "a b");
    }

    #[test]
    fn assistant_lines() {
        let line = json!({ "type": "message", "message": { "role": "assistant", "durationMs": 1500,
            "content": [{ "type": "thinking", "thinking": "hm" }, { "type": "text", "text": "  " },
                        { "type": "text", "text": "Done.\nNext" }, { "type": "toolCall", "arguments": { "x": [1] } }] } });
        assert_eq!(
            assistant_facts(&line.to_string()),
            AssistantFacts { text: Some("Done. Next".into()), thinking: true, duration_ms: Some(1500.0) }
        );
        // A lone surrogate escape falls back to lenient parsing.
        let lenient = r#"{"message":{"content":[{"type":"text","text":"a\ud83d"}]}}"#;
        assert_eq!(assistant_facts(lenient).text.as_deref(), Some("a\u{fffd}"));
        assert_eq!(assistant_facts("not json"), AssistantFacts::default());
    }

    #[test]
    fn stored_arguments_summarize_as_parsed_ones() {
        let cases = [
            ("bash", json!({ "command": "\n  cargo test\n--locked", "timeout": 60 })),
            ("Bash", json!({ "cmd": "echo \"hi\"\tthere" })),
            ("READ", json!({ "file_path": "src/a.rs", "offset": 1e2, "limit": " 40 " })),
            ("read", json!({ "path": "src/a.rs", "limit": -3 })),
            ("Grep", json!({ "pattern": "\u{1}fn", "path": "src" })),
            ("edit", json!({ "path": "  ", "oldText": "x" })),
            ("codemode", json!({ "code": format!("const a = 1;\n{}", "x".repeat(300)) })),
            ("mcp__rea__decompile", json!({ "n": 3, "nested": { "s": "no" }, "target": "libfoo.so" })),
            ("other", json!({ "a": format!("{}  \u{7}", "é".repeat(158)), "b": "short" })),
            ("other", json!({ "a": format!("{} \u{7}z", "é".repeat(159)) })),
        ];
        for (name, args) in cases {
            assert_eq!(arguments_summary(name, &args.to_string()), tool_summary(name, &args), "{name} {args}");
        }
        // Tool names match case-insensitively for every family.
        assert_eq!(arguments_summary("Bash", r#"{"command":"ls -la\nwc"}"#), "ls -la");
        assert_eq!(arguments_summary("READ", r#"{"path":"a.rs","offset":3}"#), "a.rs:3");
        assert_eq!(arguments_summary("WebFetch", r#"{"url":"u"}"#), "u");
        // Anything but an object summarizes as empty.
        for arguments in ["{not json", r#""rm -rf /""#, r#"["a", "b"]"#, "null", "3", ""] {
            assert_eq!(arguments_summary("bash", arguments), "", "{arguments}");
            assert_eq!(arguments_summary("mcp__x__y", arguments), "", "{arguments}");
        }
        // A lone surrogate escape falls back to lenient parsing.
        assert_eq!(arguments_summary("bash", r#"{"command":"a\ud83d"}"#), "a\u{fffd}");
    }

    #[test]
    fn one_line_replaces_control_characters_before_trimming() {
        assert_eq!(one_line("\u{1}\u{7f} abc\u{1b}"), "abc");
        assert_eq!(one_line("a\u{0}b"), "a b");
        // A blank at the cut stays unless only blanks follow it.
        let s = format!("{} b", "a".repeat(SUMMARY_CHARS - 1));
        assert_eq!(one_line(&s), format!("{} ", "a".repeat(SUMMARY_CHARS - 1)));
        let s = format!("{} \u{1}\t ", "a".repeat(SUMMARY_CHARS - 1));
        assert_eq!(one_line(&s), "a".repeat(SUMMARY_CHARS - 1));
    }

    #[test]
    fn implausible_request_times_are_left_out() {
        let all = r#"{"sentAt":1010,"responseAt":1400,"firstTokenAt":2000,"firstToken":"text"}"#;
        let full = Timing { sent_at: Some(1010), response_at: Some(1400), first_token_at: Some(2000), first_token: Some("text".into()) };
        assert_eq!(llm_timing(Some(all), Some(1_000), Some(3_000)), full);
        assert_eq!(llm_timing(Some(all), None, None), full);
        // Up to a minute before the start and a second after the end are kept.
        let (start, end) = (Some(100_000), Some(103_000));
        let edges = r#"{"sentAt":40000,"responseAt":39999,"firstTokenAt":104000,"firstToken":"toolCall"}"#;
        assert_eq!(
            llm_timing(Some(edges), start, end),
            Timing { sent_at: Some(40_000), first_token_at: Some(104_000), first_token: Some("toolCall".into()), ..Timing::default() }
        );
        let late = r#"{"sentAt":100005,"firstTokenAt":104001,"firstToken":"thinking"}"#;
        assert_eq!(llm_timing(Some(late), start, end), Timing { sent_at: Some(100_005), ..Timing::default() });
        // Without an end, only the start bounds them.
        assert_eq!(llm_timing(Some(late), start, None).first_token.as_deref(), Some("thinking"));
        // Only a known kind, and only with its time.
        assert_eq!(llm_timing(Some(r#"{"firstToken":"text"}"#), None, None), Timing::default());
        assert_eq!(llm_timing(Some(r#"{"firstTokenAt":5,"firstToken":"image"}"#), None, None).first_token, None);
        assert_eq!(llm_timing(None, Some(1), Some(2)), Timing::default());
        assert_eq!(llm_timing(Some("not json"), None, None), Timing::default());
    }

    #[test]
    fn implausible_llm_times_are_left_out() {
        let (start, at) = (Some(1_000), Some(5_000));
        assert_eq!(llm_times(start, at, Some(1500.4)), (start, Some(2_500)));
        assert_eq!(llm_times(start, at, None), (start, at));
        for duration in [-1.0, f64::NAN, f64::INFINITY, 1e300, MAX_DURATION_MS + 1.0] {
            assert_eq!(llm_times(start, at, Some(duration)), (start, at), "{duration}");
        }
        assert_eq!(llm_times(Some(i64::MAX), at, Some(10.0)), (None, at));
        assert_eq!(llm_times(Some(-1), Some(i64::MIN), Some(10.0)), (None, None));
        assert_eq!(llm_times(Some(MAX_TIME_MS), None, Some(MAX_DURATION_MS)), (Some(MAX_TIME_MS), Some(MAX_TIME_MS + MAX_DURATION_MS as i64)));
    }
}
