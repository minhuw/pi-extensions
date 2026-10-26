use anyhow::Result;
use rusqlite::{OptionalExtension, Row, Transaction, params};
use serde_json::Value;

use super::search::{self, Kind};
use super::{Line, StreamInfo, Usage, int_field, str_field, string_field, time_field};
use crate::util::{basename, cut_chars, parse_json_lenient};

pub const LINK_CUSTOM_TYPE: &str = "pi-extensions.session-link";
const TITLE_CHARS: usize = 120;
const FINAL_TEXT_CHARS: usize = 2_000;
const USER_TEXT_CHARS: usize = 65_536;

struct SessionRow {
    sid: i64,
    id: String,
    cwd: Option<String>,
    name: Option<String>,
    first_prompt: Option<String>,
    version: Option<i64>,
    started_at: Option<i64>,
    last_at: i64,
    entry_count: i64,
    turn_count: i64,
    models: Vec<String>,
    usage: Usage,
    header_parent: Option<String>,
    parent_session_id: Option<String>,
    link: Option<Value>,
    herder_run_id: Option<String>,
}

struct TurnRow {
    idx: i64,
    start_seq: i64,
    end_seq: i64,
    user_text: String,
    at: Option<i64>,
    duration_ms: i64,
    model_calls: i64,
    tool_calls: i64,
    tool_errors: i64,
    usage: Usage,
    final_text: Option<String>,
}

pub fn create(tx: &Transaction, info: &StreamInfo) -> Result<()> {
    tx.prepare_cached(
        "INSERT INTO sessions (sid, id, device, child_count)
         VALUES (?1, ?2, ?3, (SELECT COUNT(*) FROM sessions WHERE parent_session_id = ?2))",
    )?
    .execute(params![info.id, info.name, info.device])?;
    Ok(())
}

fn load_session(tx: &Transaction, sid: i64) -> Result<SessionRow> {
    let row = tx
        .prepare_cached(
            "SELECT id, cwd, name, first_prompt, version, started_at, last_at, entry_count, turn_count, models,
                    input, output, cache_read, cache_write, cost, header_parent, parent_session_id, link, herder_run_id
             FROM sessions WHERE sid = ?1",
        )?
        .query_row([sid], |r| {
            Ok(SessionRow {
                sid,
                id: r.get(0)?,
                cwd: r.get(1)?,
                name: r.get(2)?,
                first_prompt: r.get(3)?,
                version: r.get(4)?,
                started_at: r.get(5)?,
                last_at: r.get(6)?,
                entry_count: r.get(7)?,
                turn_count: r.get(8)?,
                models: serde_json::from_str(&r.get::<_, String>(9)?).unwrap_or_default(),
                usage: Usage {
                    input: r.get(10)?,
                    output: r.get(11)?,
                    cache_read: r.get(12)?,
                    cache_write: r.get(13)?,
                    total_tokens: 0,
                    cost: r.get(14)?,
                },
                header_parent: r.get(15)?,
                parent_session_id: r.get(16)?,
                link: r.get::<_, Option<String>>(17)?.and_then(|s| serde_json::from_str(&s).ok()),
                herder_run_id: r.get(18)?,
            })
        })?;
    Ok(row)
}

fn save_session(tx: &Transaction, s: &SessionRow) -> Result<()> {
    let project = s
        .link
        .as_ref()
        .and_then(|l| l.get("herder"))
        .and_then(|h| str_field(h, "repo"))
        .or(s.cwd.as_deref())
        .map(|p| basename(p).to_owned());
    let title = s.name.clone().filter(|n| !n.trim().is_empty()).or_else(|| s.first_prompt.clone());
    tx.prepare_cached(
        "UPDATE sessions SET cwd = ?2, project = ?3, title = ?4, name = ?5, first_prompt = ?6, version = ?7,
             started_at = ?8, last_at = ?9, entry_count = ?10, turn_count = ?11, models = ?12, input = ?13,
             output = ?14, cache_read = ?15, cache_write = ?16, cost = ?17, header_parent = ?18,
             parent_session_id = ?19, link = ?20, herder_run_id = ?21
         WHERE sid = ?1",
    )?
    .execute(params![
        s.sid,
        s.cwd,
        project,
        title,
        s.name,
        s.first_prompt,
        s.version,
        s.started_at,
        s.last_at,
        s.entry_count,
        s.turn_count,
        serde_json::to_string(&s.models)?,
        s.usage.input,
        s.usage.output,
        s.usage.cache_read,
        s.usage.cache_write,
        s.usage.cost,
        s.header_parent,
        s.parent_session_id,
        s.link.as_ref().map(Value::to_string),
        s.herder_run_id,
    ])?;
    Ok(())
}

fn turn_from_row(r: &Row) -> rusqlite::Result<TurnRow> {
    Ok(TurnRow {
        idx: r.get(0)?,
        start_seq: r.get(1)?,
        end_seq: r.get(2)?,
        user_text: r.get(3)?,
        at: r.get(4)?,
        duration_ms: r.get(5)?,
        model_calls: r.get(6)?,
        tool_calls: r.get(7)?,
        tool_errors: r.get(8)?,
        usage: Usage {
            cost: r.get(9)?,
            input: r.get(10)?,
            output: r.get(11)?,
            cache_read: r.get(12)?,
            cache_write: r.get(13)?,
            total_tokens: 0,
        },
        final_text: r.get(14)?,
    })
}

fn load_turn(tx: &Transaction, sid: i64, idx: i64) -> Result<Option<TurnRow>> {
    Ok(tx
        .prepare_cached(
            "SELECT idx, start_seq, end_seq, user_text, at, duration_ms, model_calls, tool_calls, tool_errors, cost,
                    input, output, cache_read, cache_write, final_text
             FROM turns WHERE sid = ?1 AND idx = ?2",
        )?
        .query_row(params![sid, idx], turn_from_row)
        .optional()?)
}

fn save_turn(tx: &Transaction, sid: i64, t: &TurnRow) -> Result<()> {
    tx.prepare_cached(
        "INSERT OR REPLACE INTO turns (sid, idx, start_seq, end_seq, user_text, at, duration_ms, model_calls, tool_calls,
             tool_errors, cost, input, output, cache_read, cache_write, final_text)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
    )?
    .execute(params![
        sid,
        t.idx,
        t.start_seq,
        t.end_seq,
        t.user_text,
        t.at,
        t.duration_ms,
        t.model_calls,
        t.tool_calls,
        t.tool_errors,
        t.usage.cost,
        t.usage.input,
        t.usage.output,
        t.usage.cache_read,
        t.usage.cache_write,
        t.final_text,
    ])?;
    Ok(())
}

/// The session id in a pi session file name (`<timestamp>_<sessionId>.jsonl`).
fn session_id_from_file(path: &str) -> Option<String> {
    let name = basename(path);
    let stem = name.strip_suffix(".jsonl").unwrap_or(name);
    let id = stem.split_once('_').map_or(stem, |(_, id)| id);
    (!id.is_empty()).then(|| id.to_owned())
}

/// Text of a `content` field: the string itself, or its text blocks joined by newlines.
fn content_text(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(blocks)) => blocks
            .iter()
            .filter(|b| str_field(b, "type") == Some("text"))
            .filter_map(|b| str_field(b, "text"))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

/// A tool call's searchable text: its name, then each argument as `key: value`, strings unquoted.
fn tool_call_text(block: &Value) -> String {
    let mut text = str_field(block, "name").unwrap_or("").to_owned();
    match block.get("arguments") {
        Some(Value::Object(args)) => {
            for (key, value) in args {
                text.push('\n');
                text.push_str(key);
                text.push_str(": ");
                match value {
                    Value::String(s) => text.push_str(s),
                    other => text.push_str(&other.to_string()),
                }
            }
        }
        Some(Value::Null) | None => {}
        Some(other) => {
            text.push('\n');
            text.push_str(&other.to_string());
        }
    }
    text
}

fn content_size(content: Option<&Value>) -> i64 {
    match content {
        Some(Value::String(s)) => s.len() as i64,
        Some(Value::Array(blocks)) => blocks
            .iter()
            .map(|b| match str_field(b, "type") {
                Some("text") => str_field(b, "text").map_or(0, str::len),
                Some("image") => str_field(b, "data").map_or(0, str::len),
                _ => 0,
            } as i64)
            .sum(),
        _ => 0,
    }
}

struct Deriver<'a> {
    tx: &'a Transaction<'a>,
    s: SessionRow,
    turn: Option<TurnRow>,
}

impl Deriver<'_> {
    fn add_usage(&mut self, usage: &Usage) {
        self.s.usage.add(usage);
        if let Some(turn) = &mut self.turn {
            turn.usage.add(usage);
        }
    }

    fn set_parent(&mut self) -> Result<()> {
        let link = self.s.link.as_ref();
        let parent = link
            .and_then(|l| string_field(l, "parentSessionId"))
            .or_else(|| link.and_then(|l| str_field(l, "parentSessionFile")).and_then(session_id_from_file))
            .or_else(|| self.s.header_parent.as_deref().and_then(session_id_from_file));
        if parent == self.s.parent_session_id {
            return Ok(());
        }
        let mut adjust = self.tx.prepare_cached("UPDATE sessions SET child_count = child_count + ?2 WHERE id = ?1")?;
        if let Some(old) = &self.s.parent_session_id {
            adjust.execute(params![old, -1])?;
        }
        if let Some(new) = &parent {
            adjust.execute(params![new, 1])?;
        }
        self.s.parent_session_id = parent;
        Ok(())
    }

    fn header(&mut self, seq: i64, v: &Value) -> Result<()> {
        self.s.cwd = string_field(v, "cwd").or(self.s.cwd.take());
        self.s.version = int_field(v, "version").or(self.s.version);
        if let Some(parent) = string_field(v, "parentSession") {
            self.s.header_parent = Some(parent.clone());
            if self.s.link.is_none() {
                self.tx
                    .prepare_cached(
                        "INSERT OR REPLACE INTO session_links (sid, source, seq, parent_session_id, parent_session_file)
                         VALUES (?1, 'header', ?2, ?3, ?4)",
                    )?
                    .execute(params![self.s.sid, seq, session_id_from_file(&parent), parent])?;
            }
        }
        self.set_parent()
    }

    fn link(&mut self, seq: i64, data: &Value) -> Result<()> {
        if self.s.link.is_some() || !data.is_object() {
            return Ok(());
        }
        let herder = data.get("herder").filter(|h| h.is_object());
        let h = |key| herder.and_then(|h| string_field(h, key));
        let hi = |key| herder.and_then(|h| int_field(h, key));
        let parent_file = string_field(data, "parentSessionFile");
        let parent_id = string_field(data, "parentSessionId").or_else(|| parent_file.as_deref().and_then(session_id_from_file));
        self.tx
            .prepare_cached(
                "INSERT OR REPLACE INTO session_links (sid, source, seq, kind, parent_session_id, parent_session_file,
                     parent_tool_call_id, agent_id, parent_agent_id, workflow_id, agent_type, description,
                     herder_run_id, herder_step_key, herder_step_id, herder_role, herder_attempt, herder_launch, data)
                 VALUES (?1, 'entry', ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)",
            )?
            .execute(params![
                self.s.sid,
                seq,
                string_field(data, "kind"),
                parent_id,
                parent_file,
                string_field(data, "parentToolCallId"),
                string_field(data, "agentId"),
                string_field(data, "parentAgentId"),
                string_field(data, "workflowId"),
                string_field(data, "agentType"),
                string_field(data, "description"),
                h("runId"),
                h("stepKey"),
                h("stepId"),
                h("role"),
                hi("attempt"),
                hi("launch"),
                data.to_string(),
            ])?;
        self.s.herder_run_id = h("runId");
        self.s.link = Some(data.clone());
        self.set_parent()
    }

    fn user(&mut self, seq: i64, ts: Option<i64>, message: &Value) -> Result<()> {
        let text = content_text(message.get("content"));
        if self.s.first_prompt.is_none() {
            let trimmed = text.trim();
            if !trimmed.is_empty() {
                self.s.first_prompt = Some(cut_chars(trimmed, TITLE_CHARS).to_owned());
            }
        }
        self.start_turn(seq, ts, &text)
    }

    /// Starts the turn whose prompt is the entry at `seq`.
    fn start_turn(&mut self, seq: i64, ts: Option<i64>, text: &str) -> Result<()> {
        if let Some(previous) = self.turn.take() {
            save_turn(self.tx, self.s.sid, &previous)?;
        }
        self.turn = Some(TurnRow {
            idx: self.s.turn_count,
            start_seq: seq,
            end_seq: seq,
            user_text: cut_chars(text, USER_TEXT_CHARS).to_owned(),
            at: ts,
            duration_ms: 0,
            model_calls: 0,
            tool_calls: 0,
            tool_errors: 0,
            usage: Usage::default(),
            final_text: None,
        });
        self.s.turn_count += 1;
        Ok(())
    }

    /// Whether a run is in progress at this point of the current turn: its user prompt awaits the first reply, or its
    /// last assistant message continues with tool calls. Reads only rows already written, so incremental ingest and
    /// reindex agree.
    fn run_in_progress(&self) -> Result<bool> {
        let Some(turn) = &self.turn else { return Ok(false) };
        let last: Option<(i64, Option<String>)> = self
            .tx
            .prepare_cached("SELECT seq, stop_reason FROM model_calls WHERE sid = ?1 AND seq >= ?2 ORDER BY seq DESC LIMIT 1")?
            .query_row(params![self.s.sid, turn.start_seq], |r| Ok((r.get(0)?, r.get(1)?)))
            .optional()?;
        Ok(match last {
            None => {
                let role: Option<String> = self
                    .tx
                    .prepare_cached("SELECT role FROM entries WHERE sid = ?1 AND seq = ?2")?
                    .query_row(params![self.s.sid, turn.start_seq], |r| r.get(0))
                    .optional()?
                    .flatten();
                role.as_deref() == Some("user")
            }
            Some((_, Some(stop))) if stop == "toolUse" => true,
            // pi ends the run without running the tools of an aborted or failed reply.
            Some((_, Some(stop))) if stop == "aborted" || stop == "error" => false,
            Some((seq, _)) => self
                .tx
                .prepare_cached("SELECT EXISTS (SELECT 1 FROM tool_calls WHERE sid = ?1 AND call_seq = ?2 AND result_seq IS NULL)")?
                .query_row(params![self.s.sid, seq], |r| r.get(0))?,
        })
    }

    fn assistant(&mut self, seq: i64, entry: &Value, ts: Option<i64>, message: &Value) -> Result<Vec<String>> {
        let usage = Usage::parse(message.get("usage")).unwrap_or_default();
        self.add_usage(&usage);
        let turn_idx = self.turn.as_ref().map(|t| t.idx);
        let model = string_field(message, "model");
        if let Some(model) = &model
            && !self.s.models.contains(model)
        {
            self.s.models.push(model.clone());
            self.tx
                .prepare_cached("INSERT OR IGNORE INTO session_models (model, sid) VALUES (?1, ?2)")?
                .execute(params![model, self.s.sid])?;
        }
        let message_ts = int_field(message, "timestamp");
        let request_id: Option<String> = match message_ts {
            Some(mts) => self
                .tx
                .prepare_cached(
                    "SELECT id FROM requests WHERE session_id = ?1 AND assistant_ts = ?2 ORDER BY at_ms DESC, id DESC LIMIT 1",
                )?
                .query_row(params![self.s.id, mts], |r| r.get(0))
                .optional()?,
            None => None,
        };
        self.tx
            .prepare_cached(
                "INSERT OR REPLACE INTO model_calls (sid, seq, entry_id, turn, ts, at, provider, model, api, stop_reason,
                     input, output, cache_read, cache_write, total_tokens, cost, response_id, error_message, request_id)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19)",
            )?
            .execute(params![
                self.s.sid,
                seq,
                str_field(entry, "id"),
                turn_idx,
                message_ts,
                ts,
                str_field(message, "provider"),
                model,
                str_field(message, "api"),
                str_field(message, "stopReason"),
                usage.input,
                usage.output,
                usage.cache_read,
                usage.cache_write,
                usage.total_tokens,
                usage.cost,
                str_field(message, "responseId"),
                str_field(message, "errorMessage"),
                request_id,
            ])?;

        let mut call_ids = Vec::new();
        let blocks = message.get("content").and_then(Value::as_array).map(Vec::as_slice).unwrap_or_default();
        for block in blocks.iter().filter(|b| str_field(b, "type") == Some("toolCall")) {
            let Some(call_id) = string_field(block, "id") else { continue };
            self.tx
                .prepare_cached(
                    "INSERT INTO tool_calls (sid, call_id, name, arguments, turn, call_seq, started_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                     ON CONFLICT (sid, call_id) DO UPDATE SET name = excluded.name, arguments = excluded.arguments,
                         turn = excluded.turn, call_seq = excluded.call_seq, started_at = excluded.started_at,
                         duration_ms = tool_calls.ended_at - excluded.started_at",
                )?
                .execute(params![
                    self.s.sid,
                    call_id,
                    str_field(block, "name"),
                    block.get("arguments").map(Value::to_string),
                    turn_idx,
                    seq,
                    ts,
                ])?;
            call_ids.push(call_id);
        }
        if let Some(turn) = &mut self.turn {
            turn.model_calls += 1;
            turn.tool_calls += call_ids.len() as i64;
            let text = content_text(message.get("content"));
            if !text.trim().is_empty() {
                turn.final_text = Some(cut_chars(&text, FINAL_TEXT_CHARS).to_owned());
            }
        }
        Ok(call_ids)
    }

    fn tool_result(&mut self, seq: i64, ts: Option<i64>, message: &Value) -> Result<Vec<String>> {
        let Some(call_id) = string_field(message, "toolCallId") else { return Ok(Vec::new()) };
        let is_error = message.get("isError").and_then(Value::as_bool).unwrap_or(false);
        let size = content_size(message.get("content"));
        let turn_idx = self.turn.as_ref().map(|t| t.idx);
        let updated = self
            .tx
            .prepare_cached(
                "UPDATE tool_calls SET result_seq = ?3, is_error = ?4, ended_at = ?5, output_size = ?6,
                     duration_ms = ?5 - started_at
                 WHERE sid = ?1 AND call_id = ?2",
            )?
            .execute(params![self.s.sid, call_id, seq, is_error, ts, size])?;
        if updated == 0 {
            self.tx
                .prepare_cached(
                    "INSERT INTO tool_calls (sid, call_id, name, turn, result_seq, is_error, ended_at, output_size)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                )?
                .execute(params![self.s.sid, call_id, str_field(message, "toolName"), turn_idx, seq, is_error, ts, size])?;
        }
        if is_error && let Some(turn) = &mut self.turn {
            turn.tool_errors += 1;
        }
        Ok(vec![call_id])
    }

    fn index_search(&self, seq: i64, ty: &str, v: &Value, at: i64) -> Result<()> {
        let sid = self.s.sid;
        match ty {
            "session_info" => {
                if let Some(name) = str_field(v, "name") {
                    search::index(self.tx, sid, seq, 0, at, Kind::Title, name)?;
                }
            }
            "message" => {
                let Some(message) = v.get("message") else { return Ok(()) };
                let content = message.get("content");
                match str_field(message, "role") {
                    Some("user") => search::index(self.tx, sid, seq, 0, at, Kind::User, &content_text(content))?,
                    Some("assistant") => {
                        search::index(self.tx, sid, seq, 0, at, Kind::Assistant, &content_text(content))?;
                        let blocks = content.and_then(Value::as_array).map(Vec::as_slice).unwrap_or_default();
                        for (part, block) in blocks.iter().filter(|b| str_field(b, "type") == Some("toolCall")).enumerate() {
                            search::index(self.tx, sid, seq, part as i64 + 1, at, Kind::ToolCall, &tool_call_text(block))?;
                        }
                    }
                    Some("toolResult") => {
                        search::index(self.tx, sid, seq, 0, at, Kind::ToolResult, &content_text(content))?
                    }
                    _ => {}
                }
            }
            _ => {}
        }
        Ok(())
    }

    fn line(&mut self, line: &Line) -> Result<()> {
        let parsed: Option<Value> = parse_json_lenient(line.text).ok().filter(Value::is_object);
        let empty = Value::Null;
        let v = parsed.as_ref().unwrap_or(&empty);
        let ty = if parsed.is_some() { str_field(v, "type").unwrap_or("") } else { "invalid" };
        let ts = time_field(v, "timestamp");
        self.s.entry_count = line.seq + 1;
        if let Some(ts) = ts {
            self.s.last_at = self.s.last_at.max(ts);
            self.s.started_at.get_or_insert(ts);
        }
        let mut role = None;
        let mut custom_type = None;
        let mut call_ids = Vec::new();
        match ty {
            "session" => self.header(line.seq, v)?,
            "message" => {
                let message = v.get("message").unwrap_or(&empty);
                role = str_field(message, "role");
                match role {
                    Some("user") => self.user(line.seq, ts, message)?,
                    Some("assistant") => call_ids = self.assistant(line.seq, v, ts, message)?,
                    Some("toolResult") => call_ids = self.tool_result(line.seq, ts, message)?,
                    _ => {}
                }
            }
            "usage" | "compaction" | "branch_summary" => {
                if let Some(usage) = Usage::parse(v.get("usage")) {
                    self.add_usage(&usage);
                }
            }
            "session_info" => self.s.name = string_field(v, "name"),
            "custom" | "custom_message" => {
                custom_type = str_field(v, "customType");
                if ty == "custom" && custom_type == Some(LINK_CUSTOM_TYPE) {
                    self.link(line.seq, v.get("data").unwrap_or(&empty))?;
                }
                // A displayed extension message that starts a run, such as the prompt of `/herder <goal>`, is the
                // prompt of its turn. One delivered during a run, such as a steered subagent notice, stays inside it.
                if ty == "custom_message"
                    && v.get("display").and_then(Value::as_bool) == Some(true)
                    && !self.run_in_progress()?
                {
                    self.start_turn(line.seq, ts, &content_text(v.get("content")))?;
                }
            }
            _ => {}
        }
        self.index_search(line.seq, ty, v, ts.unwrap_or(self.s.last_at))?;
        let turn_idx = match &mut self.turn {
            Some(turn) => {
                turn.end_seq = line.seq;
                if let (Some(ts), Some(at)) = (ts, turn.at) {
                    turn.duration_ms = turn.duration_ms.max(ts - at);
                }
                Some(turn.idx)
            }
            None => None,
        };
        self.tx
            .prepare_cached(
                "INSERT OR REPLACE INTO entries (sid, seq, offset, entry_id, parent_id, type, role, custom_type, ts,
                     tool_call_ids, turn)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            )?
            .execute(params![
                self.s.sid,
                line.seq,
                line.offset,
                str_field(v, "id"),
                str_field(v, "parentId"),
                ty,
                role,
                custom_type,
                ts,
                (!call_ids.is_empty()).then(|| serde_json::to_string(&call_ids)).transpose()?,
                turn_idx,
            ])?;
        Ok(())
    }
}

pub fn apply(tx: &Transaction, info: &StreamInfo, lines: &[Line]) -> Result<()> {
    let s = load_session(tx, info.id)?;
    let turn = if s.turn_count > 0 { load_turn(tx, info.id, s.turn_count - 1)? } else { None };
    let mut deriver = Deriver { tx, s, turn };
    for line in lines {
        deriver.line(line)?;
    }
    if let Some(turn) = &deriver.turn {
        save_turn(tx, info.id, turn)?;
    }
    save_session(tx, &deriver.s)
}

#[cfg(test)]
mod tests {
    use super::session_id_from_file;

    #[test]
    fn session_ids_from_file_names() {
        assert_eq!(
            session_id_from_file("/x/--a--/2024-12-03T14-00-00-000Z_0b7c-11.jsonl").as_deref(),
            Some("0b7c-11")
        );
        assert_eq!(session_id_from_file("plain.jsonl").as_deref(), Some("plain"));
    }
}
