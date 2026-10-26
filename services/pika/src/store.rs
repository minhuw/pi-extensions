use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{Context, Result, bail};
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};

use crate::blobs::BlobStore;

const MIGRATIONS: &[&str] = &[include_str!("schema.sql"), include_str!("schema_v2.sql")];
/// The first schema version whose derived tables an older database lacks; opening such a database reindexes it.
const REINDEX_BELOW: usize = 2;
/// Set in the transaction of a migration that needs a reindex, and cleared by the reindex that follows, so an
/// interrupted or failed reindex runs again on the next open.
pub const NEEDS_REINDEX: &str = "needs_reindex";
const MAX_IDLE_READERS: usize = 16;

/// Tables rebuilt by `pika reindex`, in the order they are cleared.
pub const DERIVED_TABLES: &[&str] = &[
    "sessions",
    "session_models",
    "session_links",
    "entries",
    "turns",
    "model_calls",
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

/// The SQLite database and blob store. Writes go through one connection; reads use a pool of query-only connections.
pub struct Store {
    data_dir: PathBuf,
    db_path: PathBuf,
    writer: Mutex<Connection>,
    readers: Mutex<Vec<Connection>>,
    pub blobs: BlobStore,
}

fn configure(conn: &Connection) -> rusqlite::Result<()> {
    conn.busy_timeout(Duration::from_secs(10))?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    conn.pragma_update(None, "temp_store", "MEMORY")?;
    conn.pragma_update(None, "cache_size", -32_000)?;
    Ok(())
}

/// Applies pending migrations.
fn migrate(conn: &mut Connection) -> Result<()> {
    let version = conn.pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))? as usize;
    if version > MIGRATIONS.len() {
        bail!("database schema version {version} is newer than this pika ({})", MIGRATIONS.len());
    }
    for (index, sql) in MIGRATIONS.iter().enumerate().skip(version) {
        let tx = conn.transaction()?;
        tx.execute_batch(sql).with_context(|| format!("applying migration {}", index + 1))?;
        if version > 0 && index + 1 >= REINDEX_BELOW {
            tx.execute("INSERT OR REPLACE INTO settings (key, value) VALUES (?1, x'01')", [NEEDS_REINDEX])?;
        }
        tx.pragma_update(None, "user_version", (index + 1) as i64)?;
        tx.commit()?;
    }
    Ok(())
}

impl Store {
    pub fn open(data_dir: impl AsRef<Path>) -> Result<Arc<Store>> {
        let data_dir = data_dir.as_ref().to_path_buf();
        std::fs::create_dir_all(&data_dir).with_context(|| format!("creating {}", data_dir.display()))?;
        let db_path = data_dir.join("pika.db");
        let mut writer = Connection::open(&db_path).with_context(|| format!("opening {}", db_path.display()))?;
        configure(&writer)?;
        migrate(&mut writer)?;
        let needs_reindex = writer
            .query_row("SELECT 1 FROM settings WHERE key = ?1", [NEEDS_REINDEX], |_| Ok(()))
            .optional()?
            .is_some();
        let store = Arc::new(Store {
            blobs: BlobStore::new(data_dir.join("blobs")),
            data_dir,
            db_path,
            writer: Mutex::new(writer),
            readers: Mutex::new(Vec::new()),
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
