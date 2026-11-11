//! The owner's extension usage aggregate: how often each tool was called, and each slash command (an extension's,
//! a prompt template's, or a skill's) was used, over the last `days` days. Commands are the `pi-extensions.command`
//! custom entries that extensions append when one runs. Every recorded session counts, hidden ones included, as in
//! the owner's statistics.
use std::collections::{BTreeMap, BTreeSet};

use rusqlite::{Connection, params};
use serde::Serialize;
use serde_json::Value;

use super::{Params, ReadResult, bad, line_text};
use crate::blobs::BlobStore;
use crate::util::{now_ms, parse_json_lenient};

const DAY_MS: i64 = 86_400_000;
pub const DEFAULT_DAYS: i64 = 90;
pub const MAX_DAYS: i64 = 3650;
/// The `customType` of the entry an extension appends when one of its commands runs.
pub const COMMAND_CUSTOM_TYPE: &str = "pi-extensions.command";

pub(crate) const TOOLS_SQL: &str = "SELECT name, COUNT(*), COUNT(DISTINCT sid), SUM(is_error = 1), MAX(started_at)
     FROM tool_calls WHERE started_at >= ?1 AND name IS NOT NULL GROUP BY name";

pub(crate) const COMMANDS_SQL: &str = "SELECT e.sid, e.ts, l.data, l.blob
     FROM entries e JOIN lines l ON l.stream_id = e.sid AND l.offset = e.offset
     WHERE e.custom_type = ?1 AND e.ts >= ?2 AND e.type = 'custom'";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolUsage {
    pub name: String,
    pub calls: i64,
    pub sessions: i64,
    pub errors: i64,
    pub last_at: Option<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandUsage {
    pub command: String,
    pub kind: String,
    pub extension: Option<String>,
    pub uses: i64,
    pub sessions: i64,
    pub last_at: Option<i64>,
}

#[derive(Debug, Serialize)]
pub struct ExtensionUsage {
    pub days: i64,
    /// Unix milliseconds: tool calls and commands at or after it count.
    pub since: i64,
    pub tools: Vec<ToolUsage>,
    pub commands: Vec<CommandUsage>,
}

pub fn extension_usage(conn: &Connection, blobs: &BlobStore, p: &Params) -> ReadResult<ExtensionUsage> {
    at_time(conn, blobs, p, now_ms())
}

/// `{ command, kind, extension? }` of a command entry's `data`, or `None` when it is malformed.
fn command(line: &str) -> Option<(String, String, Option<String>)> {
    let v = parse_json_lenient(line).ok()?;
    let data = v.get("data")?.as_object()?;
    let command = data.get("command")?.as_str().filter(|c| !c.is_empty())?;
    let kind = data.get("kind")?.as_str().filter(|k| ["extension", "template", "skill"].contains(k))?;
    let extension = match data.get("extension") {
        None | Some(Value::Null) => None,
        Some(Value::String(e)) => Some(e.clone()),
        Some(_) => return None,
    };
    Some((command.to_owned(), kind.to_owned(), extension))
}

fn at_time(conn: &Connection, blobs: &BlobStore, p: &Params, now: i64) -> ReadResult<ExtensionUsage> {
    let days = match p.0.get("days").map(String::as_str) {
        None => DEFAULT_DAYS,
        Some(raw) => raw
            .parse::<i64>()
            .ok()
            .filter(|d| raw.bytes().all(|b| b.is_ascii_digit()) && (1..=MAX_DAYS).contains(d))
            .ok_or_else(|| bad(format!("days must be an integer from 1 to {MAX_DAYS}")))?,
    };
    let since = now - days * DAY_MS;
    // One snapshot for both lists.
    let tx = conn.unchecked_transaction()?;

    let mut tools = tx
        .prepare_cached(TOOLS_SQL)?
        .query_map([since], |r| {
            Ok(ToolUsage { name: r.get(0)?, calls: r.get(1)?, sessions: r.get(2)?, errors: r.get(3)?, last_at: r.get(4)? })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    tools.sort_by(|a, b| b.calls.cmp(&a.calls).then_with(|| a.name.cmp(&b.name)));

    let rows = tx
        .prepare_cached(COMMANDS_SQL)?
        .query_map(params![COMMAND_CUSTOM_TYPE, since], |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?, r.get::<_, Option<String>>(2)?, r.get::<_, Option<String>>(3)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    // (uses, sessions, last time) per (command, kind, extension).
    let mut groups: BTreeMap<(String, String, Option<String>), (i64, BTreeSet<i64>, i64)> = BTreeMap::new();
    for (sid, ts, data, blob) in rows {
        let Some(key) = command(&line_text(blobs, data, blob)?) else { continue };
        let group = groups.entry(key).or_default();
        group.0 += 1;
        group.1.insert(sid);
        group.2 = group.2.max(ts);
    }
    tx.finish()?;
    let mut commands: Vec<_> = groups
        .into_iter()
        .map(|((command, kind, extension), (uses, sessions, last_at))| CommandUsage {
            command,
            kind,
            extension,
            uses,
            sessions: sessions.len() as i64,
            last_at: Some(last_at),
        })
        .collect();
    // The map's order breaks ties: by command, kind, then extension, without one first.
    commands.sort_by(|a, b| b.uses.cmp(&a.uses));
    Ok(ExtensionUsage { days, since, tools, commands })
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn command_payloads_must_be_well_formed() {
        let line = |data: Value| json!({ "type": "custom", "customType": COMMAND_CUSTOM_TYPE, "data": data }).to_string();
        assert_eq!(
            command(&line(json!({ "command": "recap", "kind": "template" }))),
            Some(("recap".into(), "template".into(), None))
        );
        assert_eq!(
            command(&line(json!({ "command": "ps", "kind": "extension", "extension": "processes" }))),
            Some(("ps".into(), "extension".into(), Some("processes".into())))
        );
        assert_eq!(command(&line(json!({ "command": "x", "kind": "skill", "extension": null }))).unwrap().2, None);
        for bad in [
            json!(null),
            json!("recap"),
            json!({ "kind": "template" }),
            json!({ "command": "", "kind": "template" }),
            json!({ "command": 1, "kind": "template" }),
            json!({ "command": "x", "kind": "macro" }),
            json!({ "command": "x" }),
            json!({ "command": "x", "kind": "extension", "extension": 3 }),
        ] {
            assert_eq!(command(&line(bad.clone())), None, "{bad}");
        }
        assert_eq!(command("not json"), None);
    }
}
