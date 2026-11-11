use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

use anyhow::{Context, Result, bail};
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};

use crate::blobs::BlobStore;

const MIGRATIONS: &[&str] = &[
    include_str!("schema.sql"),
    include_str!("schema_v2.sql"),
    include_str!("schema_v3.sql"),
    include_str!("schema_v4.sql"),
    include_str!("schema_v5.sql"),
    include_str!("schema_v6.sql"),
    include_str!("schema_v7.sql"),
    include_str!("schema_v8.sql"),
    include_str!("schema_v9.sql"),
    include_str!("schema_v10.sql"),
    include_str!("schema_v11.sql"),
    include_str!("schema_v12.sql"),
    include_str!("schema_v13.sql"),
    include_str!("schema_v14.sql"),
    include_str!("schema_v15.sql"),
    include_str!("schema_v16.sql"),
    include_str!("schema_v17.sql"),
    include_str!("schema_v18.sql"),
    include_str!("schema_v19.sql"),
];
/// The schema version that derives `sessions.project` and `sessions.repository` from the stream's `meta`.
const REPOSITORY_VERSION: usize = 8;
/// The newest schema version that requires rebuilding derived tables; opening an older database reindexes it.
const REINDEX_BELOW: usize = 11;
/// Set in the transaction of a migration that needs a reindex, and cleared by the reindex that follows, so an
/// interrupted or failed reindex runs again on the next open.
pub const NEEDS_REINDEX: &str = "needs_reindex";
/// Random bytes that every reindex replaces, so caches of derived data (the trace's `ETag`) change with it.
pub const DERIVED_GENERATION: &str = "derived_generation";
/// The redaction rules version (`crate::redact::RULES_VERSION`, in decimal) the search index's text was scrubbed
/// with. A database without it, or with an older one, has text that a pika before redaction or under older rules
/// indexed: public and agent search find nothing until `serve`'s background rewrite (`reindex::rescrub_search`) brings
/// it current. This rewrite uses settings and does not change the database schema.
pub const SEARCH_RULES: &str = "search_rules";
/// JSON containing the rewrite's target rules version and last scrubbed document id; only that target resumes.
pub const RESCRUB_AFTER: &str = "search_rescrub_after";
/// Marks the completed repair of cwd-based project names from uploads without Git metadata.
const WORKTREE_PROJECTS_REPAIRED: &str = "worktree_projects_repaired";
/// Marks the completed rewrite of derived model ids to bare model names (`crate::derive::normalize_models`).
const BARE_MODELS_REPAIRED: &str = "bare_models_repaired";
/// Marks the completed repair of turn `final_text` values truncated at 2,000 characters.
const FINAL_TEXT_REPAIRED: &str = "final_text_repaired";
/// Marks the completed repair of tool results whose tools called a memory tool (`crate::derive::repair_memory_calls`).
const MEMORY_CALLS_REPAIRED: &str = "memory_calls_repaired";
const MAX_IDLE_READERS: usize = 16;

/// Tables rebuilt by `pika reindex`, in the order they are cleared.
pub const DERIVED_TABLES: &[&str] = &[
    "sessions",
    "session_models",
    "session_links",
    "entries",
    "turns",
    "model_calls",
    "usage_events",
    "tool_calls",
    "herder_runs",
    "herder_events",
    "herder_steps",
    "search_docs",
];

/// Empties the full-text index; its content table `search_docs` is cleared with the other derived tables.
pub fn clear_search_index(tx: &Transaction) -> rusqlite::Result<()> {
    tx.execute("INSERT INTO search_fts (search_fts) VALUES ('delete-all')", [])?;
    Ok(())
}

/// Whether the search index's text was scrubbed under the current rules, or newer ones.
pub fn search_rules_current(conn: &Connection) -> rusqlite::Result<bool> {
    let value: Option<Vec<u8>> =
        conn.query_row("SELECT value FROM settings WHERE key = ?1", [SEARCH_RULES], |row| row.get(0)).optional()?;
    let version = value.and_then(|v| String::from_utf8(v).ok()).and_then(|v| v.parse::<u32>().ok());
    Ok(version.is_some_and(|v| v >= crate::redact::RULES_VERSION))
}

/// Records that every document in the search index is scrubbed under the current rules.
pub fn set_search_rules_current(tx: &Transaction) -> rusqlite::Result<()> {
    let version = crate::redact::RULES_VERSION.to_string().into_bytes();
    tx.execute("INSERT OR REPLACE INTO settings (key, value) VALUES (?1, ?2)", params![SEARCH_RULES, version])?;
    tx.execute("DELETE FROM settings WHERE key = ?1", [RESCRUB_AFTER])?;
    Ok(())
}

/// The SQLite database and blob store. Writes go through one connection; reads use a pool of query-only connections.
pub struct Store {
    data_dir: PathBuf,
    db_path: PathBuf,
    writer: Mutex<Connection>,
    readers: Mutex<Vec<Connection>>,
    /// Prices for model calls that recorded no cost (`crate::pricing`): the kept ones until `serve` installs its own.
    prices: RwLock<Arc<crate::pricing::PriceTable>>,
    pub blobs: BlobStore,
}

/// Sets up a connection: its pragmas and the full-text index's tokenizer, which every use of the index needs.
fn configure(conn: &Connection) -> rusqlite::Result<()> {
    crate::tokenizer::register(conn)?;
    conn.busy_timeout(Duration::from_secs(10))?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    conn.pragma_update(None, "temp_store", "MEMORY")?;
    conn.pragma_update(None, "cache_size", -32_000)?;
    Ok(())
}

/// Applies pending migrations.
fn migrate(conn: &mut Connection, blobs: &BlobStore) -> Result<()> {
    let version = conn.pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))? as usize;
    if version > MIGRATIONS.len() {
        bail!("database schema version {version} is newer than this pika ({})", MIGRATIONS.len());
    }
    for (index, sql) in MIGRATIONS.iter().enumerate().skip(version) {
        if version > 0 {
            tracing::info!("applying schema migration {}", index + 1);
        }
        let tx = conn.transaction()?;
        tx.execute_batch(sql).with_context(|| format!("applying migration {}", index + 1))?;
        if version > 0 && version < REINDEX_BELOW && index + 1 >= REINDEX_BELOW {
            tx.execute("INSERT OR REPLACE INTO settings (key, value) VALUES (?1, x'01')", [NEEDS_REINDEX])?;
        }
        // A new database's index starts empty, so scrubbed under the current rules.
        if version == 0 && index + 1 == MIGRATIONS.len() {
            set_search_rules_current(&tx)?;
        }
        tx.pragma_update(None, "user_version", (index + 1) as i64)?;
        tx.commit()?;
    }
    // A database written before `meta` named the repository may still hold such `meta`, from clients newer than the
    // server; re-deriving those sessions is enough, as every other row derives as before.
    if version > 0 && version < REPOSITORY_VERSION {
        let tx = conn.transaction()?;
        crate::derive::refresh_repositories(&tx).context("deriving session repositories")?;
        tx.commit()?;
    }
    // This changes derivation only, not the schema. Repair existing rows once, atomically with the marker;
    // an interrupted repair retries at the next open, and later opens need no session scan or blob replay.
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let repaired = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM settings WHERE key = ?1)",
        [WORKTREE_PROJECTS_REPAIRED],
        |r| r.get::<_, bool>(0),
    )?;
    if !repaired {
        crate::derive::refresh_worktree_projects(&tx).context("repairing managed worktree projects")?;
        tx.execute("INSERT INTO settings (key, value) VALUES (?1, x'01')", [WORKTREE_PROJECTS_REPAIRED])?;
    }
    tx.commit()?;
    // Bare model names are also a derivation change: rewrite the stored ids once, in Rust, atomically with the marker.
    // A rewrite that changed rows replaces `derived_generation`, as a reindex does, so no cached trace survives it.
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let repaired =
        tx.query_row("SELECT EXISTS(SELECT 1 FROM settings WHERE key = ?1)", [BARE_MODELS_REPAIRED], |r| r.get::<_, bool>(0))?;
    if !repaired {
        if crate::derive::normalize_models(&tx).context("rewriting model ids to bare names")? {
            tx.execute(
                "INSERT OR REPLACE INTO settings (key, value) VALUES (?1, ?2)",
                params![DERIVED_GENERATION, crate::util::random_bytes::<8>()],
            )?;
        }
        tx.execute("INSERT INTO settings (key, value) VALUES (?1, x'01')", [BARE_MODELS_REPAIRED])?;
    }
    tx.commit()?;
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let repaired =
        tx.query_row("SELECT EXISTS(SELECT 1 FROM settings WHERE key = ?1)", [FINAL_TEXT_REPAIRED], |r| r.get::<_, bool>(0))?;
    if !repaired {
        crate::derive::refresh_final_texts(&tx, blobs).context("repairing turn final texts")?;
        tx.execute("INSERT INTO settings (key, value) VALUES (?1, x'01')", [FINAL_TEXT_REPAIRED])?;
    }
    tx.commit()?;
    // Marking memory reached through nested tool calls is a derivation change too: an older pika indexed such calls and
    // results for search and left their entries unmarked, so public and agent reads showed them. Repair them once.
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let repaired =
        tx.query_row("SELECT EXISTS(SELECT 1 FROM settings WHERE key = ?1)", [MEMORY_CALLS_REPAIRED], |r| r.get::<_, bool>(0))?;
    if !repaired {
        crate::derive::repair_memory_calls(&tx, blobs).context("repairing memory reached through nested tool calls")?;
        tx.execute("INSERT INTO settings (key, value) VALUES (?1, x'01')", [MEMORY_CALLS_REPAIRED])?;
    }
    tx.commit()?;
    Ok(())
}

impl Store {
    pub fn open(data_dir: impl AsRef<Path>) -> Result<Arc<Store>> {
        let data_dir = data_dir.as_ref().to_path_buf();
        std::fs::create_dir_all(&data_dir).with_context(|| format!("creating {}", data_dir.display()))?;
        let blobs = BlobStore::new(data_dir.join("blobs"));
        let db_path = data_dir.join("pika.db");
        let mut writer = Connection::open(&db_path).with_context(|| format!("opening {}", db_path.display()))?;
        configure(&writer)?;
        migrate(&mut writer, &blobs)?;
        let needs_reindex = writer
            .query_row("SELECT 1 FROM settings WHERE key = ?1", [NEEDS_REINDEX], |_| Ok(()))
            .optional()?
            .is_some();
        let prices = crate::pricing::kept(&data_dir);
        let store = Arc::new(Store {
            blobs,
            data_dir,
            db_path,
            writer: Mutex::new(writer),
            readers: Mutex::new(Vec::new()),
            prices: RwLock::new(Arc::new(prices)),
        });
        if needs_reindex {
            let stats = crate::reindex::reindex(&store).context("reindexing after the schema upgrade")?;
            tracing::info!("reindexed {} streams after a schema upgrade", stats.streams);
        }
        Ok(store)
    }

    pub fn data_dir(&self) -> &Path {
        &self.data_dir
    }

    /// The prices that ingest and reindex give model calls without a recorded cost.
    pub fn prices(&self) -> Arc<crate::pricing::PriceTable> {
        self.prices.read().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// Replaces the prices and reprices every call without a recorded cost, in one transaction with the swap so ingest
    /// never prices with the old table after it. A change replaces `derived_generation`, so no cached trace survives
    /// it. Returns the number of calls whose cost changed.
    pub fn set_prices(&self, table: crate::pricing::PriceTable) -> Result<usize> {
        let table = Arc::new(table);
        let previous = self.prices();
        self.write(|tx| {
            let changed = crate::pricing::reprice(tx, &table, None)?;
            if changed > 0 {
                tx.execute(
                    "INSERT OR REPLACE INTO settings (key, value) VALUES (?1, ?2)",
                    params![DERIVED_GENERATION, crate::util::random_bytes::<8>()],
                )?;
            }
            *self.prices.write().unwrap_or_else(|e| e.into_inner()) = table.clone();
            Ok::<_, anyhow::Error>(changed)
        })
        // A failed commit leaves the costs priced by the previous table.
        .inspect_err(|_| *self.prices.write().unwrap_or_else(|e| e.into_inner()) = previous)
    }

    /// Runs `f` in one IMMEDIATE transaction on the writer connection; commits when it returns `Ok`.
    pub fn write<T, E>(&self, f: impl FnOnce(&Transaction) -> Result<T, E>) -> Result<T, E>
    where
        E: From<rusqlite::Error>,
    {
        let mut conn = self.writer.lock().unwrap_or_else(|e| e.into_inner());
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let value = f(&tx)?;
        tx.commit()?;
        Ok(value)
    }

    /// Runs `f` on a pooled query-only connection.
    pub fn read<T, E>(&self, f: impl FnOnce(&Connection) -> Result<T, E>) -> Result<T, E>
    where
        E: From<rusqlite::Error>,
    {
        let pooled = self.readers.lock().unwrap_or_else(|e| e.into_inner()).pop();
        let conn = match pooled {
            Some(conn) => conn,
            None => {
                let conn = Connection::open(&self.db_path)?;
                configure(&conn)?;
                conn.pragma_update(None, "query_only", true)?;
                conn
            }
        };
        let result = f(&conn);
        let mut readers = self.readers.lock().unwrap_or_else(|e| e.into_inner());
        if readers.len() < MAX_IDLE_READERS {
            readers.push(conn);
        }
        result
    }

    pub fn setting(&self, key: &str) -> Result<Option<Vec<u8>>> {
        Ok(self.read(|conn| {
            conn.query_row("SELECT value FROM settings WHERE key = ?1", [key], |row| row.get(0)).optional()
        })?)
    }

    /// Returns the setting, storing `init()` first when it is absent.
    pub fn setting_or_init(&self, key: &str, init: impl FnOnce() -> Vec<u8>) -> Result<Vec<u8>> {
        Ok(self.write(|tx| {
            if let Some(value) = tx.query_row("SELECT value FROM settings WHERE key = ?1", [key], |row| row.get(0)).optional()? {
                return Ok::<_, rusqlite::Error>(value);
            }
            let value = init();
            tx.execute("INSERT INTO settings (key, value) VALUES (?1, ?2)", params![key, value])?;
            Ok(value)
        })?)
    }
}
