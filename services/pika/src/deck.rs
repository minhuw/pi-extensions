//! Deck's projects (spec "Deck"): the project key of a node's checkout, computed by memory's scope rules with the node
//! in place of the device, and the owner's presentation of each key (a name, collapsed or not) in `deck_projects`. The
//! table is not derived: `pika reindex` leaves it alone.

use rusqlite::{Connection, Transaction, params};
use serde::Serialize;

use crate::memory::normalize_repository;
use crate::nodes::valid_id;
use crate::util::{format_iso_ms, valid_project};

/// The most items one `POST deck/project-keys` may hold.
pub const MAX_KEY_ITEMS: usize = 1024;

/// The project key of a checkout: `repo:<normalized URL>` for a nonempty `repository`, whatever `project` says, else
/// `local:<project>@node:<node>` for a valid project name. `None` when neither applies, the repository does not
/// normalize, or `node` is not a node id.
pub fn project_key(repository: Option<&str>, project: Option<&str>, node: &str) -> Option<String> {
    if !valid_id(node) {
        return None;
    }
    if let Some(repository) = repository.filter(|r| !r.is_empty()) {
        return normalize_repository(repository).map(|url| format!("repo:{url}"));
    }
    project.filter(|p| valid_project(p)).map(|p| format!("local:{p}@node:{node}"))
}

/// Whether `key` is one `project_key` could answer: `repo:` with an already normalized URL, or
/// `local:<valid project name>@node:<node id>`.
pub fn valid_key(key: &str) -> bool {
    if let Some(url) = key.strip_prefix("repo:") {
        return normalize_repository(url).as_deref() == Some(url);
    }
    // A node id holds neither `@` nor `:`, so the last `@node:` ends the project name.
    key.strip_prefix("local:")
        .and_then(|rest| rest.rsplit_once("@node:"))
        .is_some_and(|(project, node)| valid_project(project) && valid_id(node))
}

/// A stored row, as the routes answer it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeckProject {
    pub key: String,
    pub name: Option<String>,
    pub collapsed: bool,
    #[serde(serialize_with = "iso")]
    pub updated_at: i64,
}

fn iso<S: serde::Serializer>(ms: &i64, serializer: S) -> Result<S::Ok, S::Error> {
    serializer.serialize_str(&format_iso_ms(*ms))
}

fn row(r: &rusqlite::Row) -> rusqlite::Result<DeckProject> {
    Ok(DeckProject { key: r.get(0)?, name: r.get(1)?, collapsed: r.get(2)?, updated_at: r.get(3)? })
}

/// Every stored row, by key.
pub fn list(conn: &Connection) -> rusqlite::Result<Vec<DeckProject>> {
    conn.prepare_cached("SELECT key, name, collapsed, updated_at FROM deck_projects ORDER BY key")?
        .query_map([], row)?
        .collect()
}

/// What a `PATCH` sets: a field left `None` keeps its value; `name: Some(None)` clears the name.
#[derive(Debug, Default)]
pub struct Update {
    pub name: Option<Option<String>>,
    pub collapsed: Option<bool>,
}

/// Creates the key's row with the defaults when there is none, sets the fields given and `updated_at`, and returns
/// the row. The caller has checked the key and the name.
pub fn update(tx: &Transaction, key: &str, update: &Update, now: i64) -> rusqlite::Result<DeckProject> {
    tx.execute(
        "INSERT INTO deck_projects (key, name, collapsed, updated_at) VALUES (?1, NULL, 0, ?2)
         ON CONFLICT (key) DO UPDATE SET updated_at = excluded.updated_at",
        params![key, now],
    )?;
    if let Some(name) = &update.name {
        tx.execute("UPDATE deck_projects SET name = ?2 WHERE key = ?1", params![key, name])?;
    }
    if let Some(collapsed) = update.collapsed {
        tx.execute("UPDATE deck_projects SET collapsed = ?2 WHERE key = ?1", params![key, collapsed])?;
    }
    tx.query_row("SELECT key, name, collapsed, updated_at FROM deck_projects WHERE key = ?1", [key], row)
}

/// Deletes the key's row; false when there was none.
pub fn delete(tx: &Transaction, key: &str) -> rusqlite::Result<bool> {
    Ok(tx.execute("DELETE FROM deck_projects WHERE key = ?1", [key])? > 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_follow_memory_scope_rules() {
        let key = |repository, project, node| project_key(repository, project, node);
        assert_eq!(key(Some("https://GitHub.com/a/b.git/"), Some("x"), "n1").as_deref(), Some("repo:https://github.com/a/b"));
        assert_eq!(key(Some("https://github.com/a/b"), Some("bad/name"), "n1").as_deref(), Some("repo:https://github.com/a/b"));
        assert_eq!(key(Some(""), Some("widgets"), "n1").as_deref(), Some("local:widgets@node:n1"));
        assert_eq!(key(None, Some("widgets"), "n1").as_deref(), Some("local:widgets@node:n1"));
        assert_eq!(key(Some("git@github.com:a/b"), Some("widgets"), "n1"), None);
        assert_eq!(key(None, Some(".."), "n1"), None);
        assert_eq!(key(None, Some(""), "n1"), None);
        assert_eq!(key(None, None, "n1"), None);
        assert_eq!(key(None, Some("widgets"), "bad node"), None);
        assert_eq!(key(Some("https://github.com/a/b"), None, ""), None);
        assert_eq!(key(None, Some("widgets"), &"n".repeat(65)), None);
    }

    #[test]
    fn keys_are_checked() {
        for good in ["repo:https://github.com/a/b", "local:widgets@node:n1", "local:a@node:b@node:c_d-1", "local:x@y@node:n"] {
            assert!(valid_key(good), "{good}");
        }
        for bad in [
            "",
            "repo:",
            "repo:https://GitHub.com/a/b",
            "repo:https://github.com/a/b.git",
            "repo:https://github.com/a/b/",
            "repo: https://github.com/a/b",
            "repo:ftp://example.com/a",
            "local:widgets",
            "local:widgets@n1",
            "local:@node:n1",
            "local:..@node:n1",
            "local:a/b@node:n1",
            "local:widgets@node:",
            "local:widgets@node:bad node",
            "user",
            "widgets",
        ] {
            assert!(!valid_key(bad), "{bad}");
        }
    }
}
