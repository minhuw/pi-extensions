use std::fmt;
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};

use anyhow::{Context, Result, anyhow, bail};
use argon2::Argon2;
use argon2::password_hash::phc::PasswordHash;
use argon2::password_hash::{PasswordHasher, PasswordVerifier};
use rusqlite::{OptionalExtension, Transaction, params};

use crate::config::{AuthMode, ServerConfig};
use crate::store::Store;
use crate::util::{constant_time_eq, hmac_sha256, now_ms, random_bytes, random_secret, sha256_hex};

pub const SESSION_COOKIE: &str = "pika_session";
pub const SESSION_MAX_AGE_SECS: i64 = 30 * 24 * 3600;
/// Sessions and devices record when they were last seen at most this often.
pub const TOUCH_INTERVAL_MS: i64 = 60_000;
pub const MIN_PASSWORD_CHARS: usize = 12;
/// A random key that never leaves the database. It keys the fingerprint of the stored hash; pika 0.1 signed cookies
/// with it.
const DB_KEY_SETTING: &str = "cookie_key";
const PASSWORD_HASH_SETTING: &str = "password_hash";
const FINGERPRINT_SETTING: &str = "password_fingerprint";

pub fn valid_device_name(name: &str) -> bool {
    !name.is_empty() && name.len() <= 64 && name.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c))
}

/// Creates a device token and returns it; only its SHA-256 is stored.
pub fn create_token(store: &Store, name: &str) -> Result<String> {
    if !valid_device_name(name) {
        bail!("device names use 1-64 characters from [A-Za-z0-9._-]");
    }
    store.write(|tx| {
        if device_exists(tx, name)? {
            bail!("a token for {name:?} exists; revoke it first");
        }
        Ok(insert_token(tx, name, "cli")?)
    })
}

pub(crate) fn device_exists(tx: &Transaction, name: &str) -> rusqlite::Result<bool> {
    Ok(tx.query_row("SELECT 1 FROM tokens WHERE name = ?1", [name], |_| Ok(())).optional()?.is_some())
}

/// Inserts a token for `name`, created via `cli` or `pairing`, and returns it; only its SHA-256 is stored.
pub(crate) fn insert_token(tx: &Transaction, name: &str, via: &str) -> rusqlite::Result<String> {
    let token = format!("pika_{}", hex::encode(random_bytes::<32>()));
    tx.execute(
        "INSERT INTO tokens (name, hash, created_at, created_via) VALUES (?1, ?2, ?3, ?4)",
        params![name, sha256_hex(token.as_bytes()), now_ms(), via],
    )?;
    Ok(token)
}

pub struct Device {
    pub name: String,
    pub created_at: i64,
    pub created_via: String,
    pub last_seen_at: Option<i64>,
    pub last_host: Option<String>,
}

/// Devices with tokens, by name.
pub fn list_devices(store: &Store) -> Result<Vec<Device>> {
    Ok(store.read(|conn| {
        conn.prepare("SELECT name, created_at, created_via, last_seen_at, last_host FROM tokens ORDER BY name")?
            .query_map([], |r| {
                Ok(Device {
                    name: r.get(0)?,
                    created_at: r.get(1)?,
                    created_via: r.get(2)?,
                    last_seen_at: r.get(3)?,
                    last_host: r.get(4)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()
    })?)
}

pub fn revoke_token(store: &Store, name: &str) -> Result<bool> {
    Ok(!revoke_token_hashes(store, name)?.is_empty())
}

/// Revokes `name`'s token and returns the hashes it deleted, so that connections made with them can be closed.
pub fn revoke_token_hashes(store: &Store, name: &str) -> Result<Vec<String>> {
    Ok(store.write(|tx| delete_tokens(tx, name))?)
}

pub(crate) fn delete_tokens(tx: &Transaction, name: &str) -> rusqlite::Result<Vec<String>> {
    tx.prepare_cached("DELETE FROM tokens WHERE name = ?1 RETURNING hash")?.query_map([name], |r| r.get(0))?.collect()
}

/// The device of a token and when it was last seen.
pub fn device_for_token(store: &Store, token: &str) -> Result<Option<(String, Option<i64>)>> {
    let hash = sha256_hex(token.as_bytes());
    Ok(store.read(|conn| {
        conn.prepare_cached("SELECT name, last_seen_at FROM tokens WHERE hash = ?1")?
            .query_row([hash], |r| Ok((r.get(0)?, r.get(1)?)))
            .optional()
    })?)
}

/// Whether a device last seen at `last_seen_at` is due for `touch_device`.
pub fn touch_due(last_seen_at: Option<i64>, now: i64) -> bool {
    last_seen_at.is_none_or(|seen| seen <= now - TOUCH_INTERVAL_MS)
}

/// Records that a device uploaded from `host`, at most once per `TOUCH_INTERVAL_MS`.
pub fn touch_device(store: &Store, name: &str, host: Option<&str>, now: i64) -> Result<bool> {
    Ok(store.write(|tx| {
        tx.execute(
            "UPDATE tokens SET last_seen_at = ?2, last_host = COALESCE(?3, last_host)
             WHERE name = ?1 AND (last_seen_at IS NULL OR last_seen_at <= ?2 - ?4)",
            params![name, now, host, TOUCH_INTERVAL_MS],
        )
    })? > 0)
}

/// An argon2id PHC string with the `argon2` crate's default parameters and a random salt.
pub fn hash_password(password: &str) -> Result<String> {
    Argon2::default()
        .hash_password(password.as_bytes())
        .map(|hash| hash.to_string())
        .map_err(|e| anyhow!("hashing the password: {e}"))
}

/// Checks `given` against a PHC string; argon2 compares in constant time.
pub fn verify_password(phc: &str, given: &str) -> bool {
    PasswordHash::new(phc).is_ok_and(|hash| Argon2::default().verify_password(given.as_bytes(), &hash).is_ok())
}

pub fn stored_password_hash(store: &Store) -> Result<Option<String>> {
    store
        .setting(PASSWORD_HASH_SETTING)?
        .map(|value| String::from_utf8(value).context("the stored password hash is not UTF-8"))
        .transpose()
}

fn db_key(store: &Store) -> Result<Vec<u8>> {
    store.setting_or_init(DB_KEY_SETTING, || random_bytes::<32>().to_vec())
}

/// Identifies the stored hash: an HMAC of its PHC string keyed with the database key.
fn stored_fingerprint(key: &[u8], phc: &str) -> Vec<u8> {
    hmac_sha256(key, format!("pika-password:stored:{phc}").as_bytes()).to_vec()
}

fn upsert_setting(tx: &Transaction, key: &str, value: &[u8]) -> rusqlite::Result<()> {
    tx.execute("INSERT OR REPLACE INTO settings (key, value) VALUES (?1, ?2)", params![key, value])?;
    Ok(())
}

/// Stores a new password hash for `pika password set` and signs every browser out. Returns how many sessions ended.
pub fn set_password(store: &Store, password: &str) -> Result<usize> {
    if password.chars().count() < MIN_PASSWORD_CHARS {
        bail!("the password needs at least {MIN_PASSWORD_CHARS} characters");
    }
    let phc = hash_password(password)?;
    let fingerprint = stored_fingerprint(&db_key(store)?, &phc);
    store.write(|tx| {
        upsert_setting(tx, PASSWORD_HASH_SETTING, phc.as_bytes())?;
        upsert_setting(tx, FINGERPRINT_SETTING, &fingerprint)?;
        Ok(tx.execute("DELETE FROM auth_sessions", [])?)
    })
}

/// Removes the stored password hash and, when there was one, signs every browser out. Returns how many sessions ended,
/// or `None` when there was no stored hash.
pub fn clear_password(store: &Store) -> Result<Option<usize>> {
    Ok(store.write(|tx| {
        if tx.execute("DELETE FROM settings WHERE key = ?1", [PASSWORD_HASH_SETTING])? == 0 {
            return Ok::<_, rusqlite::Error>(None);
        }
        Ok(Some(tx.execute("DELETE FROM auth_sessions", [])?))
    })?)
}

/// `password` mode found no password; `pika serve` exits with status 2.
#[derive(Debug)]
pub struct NoPassword;

impl fmt::Display for NoPassword {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(
            "no password configured. Run 'pika password set', set PIKA_PASSWORD_FILE or PIKA_PASSWORD, or set \
             PIKA_AUTH=proxy if your reverse proxy authenticates (PIKA_AUTH=none disables authentication).",
        )
    }
}

impl std::error::Error for NoPassword {}

/// A password file's contents with one trailing newline removed.
pub fn read_password_file(path: &Path) -> Result<String> {
    let text = std::fs::read_to_string(path).with_context(|| format!("reading the password file {}", path.display()))?;
    let password = match text.strip_suffix('\n') {
        Some(rest) => rest.strip_suffix('\r').unwrap_or(rest),
        None => &text,
    };
    if password.is_empty() {
        bail!("the password file {} is empty", path.display());
    }
    Ok(password.to_owned())
}

enum Password {
    /// From `--password-file` or `--password`, hashed at startup.
    Hashed(String),
    /// The hash `pika password set` stored, read at each login so a new one applies at once.
    Stored,
}

/// How many password checks have started, run now, and ran at once at most.
#[derive(Clone, Copy, Debug, Default)]
pub struct PasswordChecks {
    pub started: usize,
    pub running: usize,
    pub peak: usize,
}

#[derive(Default)]
struct CheckCounters {
    started: AtomicUsize,
    running: AtomicUsize,
    peak: AtomicUsize,
}

/// Counts a running password check until dropped.
struct Running<'a>(&'a CheckCounters);

impl<'a> Running<'a> {
    fn enter(counters: &'a CheckCounters) -> Running<'a> {
        counters.started.fetch_add(1, Ordering::SeqCst);
        let running = counters.running.fetch_add(1, Ordering::SeqCst) + 1;
        counters.peak.fetch_max(running, Ordering::SeqCst);
        Running(counters)
    }
}

impl Drop for Running<'_> {
    fn drop(&mut self) {
        self.0.running.fetch_sub(1, Ordering::SeqCst);
    }
}

/// Viewer authentication: the mode and, in `password` mode, the password.
pub struct Auth {
    mode: AuthMode,
    password: Option<Password>,
    checks: CheckCounters,
}

impl Auth {
    /// Resolves the password (file, then flag or environment, then stored hash) and signs every browser out when it
    /// differs from the one the server last started with. Fails with `NoPassword` when `password` mode has none.
    pub fn new(store: &Store, config: &ServerConfig) -> Result<Auth> {
        match config.auth {
            AuthMode::Password => {}
            AuthMode::Proxy => {
                tracing::warn!(
                    "PIKA_AUTH=proxy: pika does not authenticate viewers; the reverse proxy must authenticate every \
                     path except api/ingest/, api/pair/, api/relay/, and api/health"
                );
                return Ok(Auth { mode: config.auth, password: None, checks: CheckCounters::default() });
            }
            AuthMode::None => {
                tracing::warn!("PIKA_AUTH=none: authentication is off; anyone who can reach pika can read everything");
                return Ok(Auth { mode: config.auth, password: None, checks: CheckCounters::default() });
            }
        }
        let stored = stored_password_hash(store)?;
        let configured = match (&config.password_file, config.password.as_deref().filter(|p| !p.is_empty())) {
            (Some(path), _) => Some(("PIKA_PASSWORD_FILE", read_password_file(path)?)),
            (None, Some(password)) => Some(("PIKA_PASSWORD", password.to_owned())),
            (None, None) => None,
        };
        let (password, fingerprint) = match (configured, stored) {
            (Some((source, password)), stored) => {
                if stored.is_some() {
                    tracing::info!("using the password from {source}; the stored password hash is ignored");
                }
                // The fingerprint of a configured password is its argon2id hash, kept while the password matches it,
                // so a copy of the database allows no fast guessing.
                let previous = store.setting(FINGERPRINT_SETTING)?.and_then(|v| String::from_utf8(v).ok());
                let phc = match previous {
                    Some(phc) if verify_password(&phc, &password) => phc,
                    _ => hash_password(&password)?,
                };
                let fingerprint = phc.clone().into_bytes();
                (Password::Hashed(phc), fingerprint)
            }
            (None, Some(phc)) => (Password::Stored, stored_fingerprint(&db_key(store)?, &phc)),
            (None, None) => return Err(NoPassword.into()),
        };
        let revoked = store.write(|tx| {
            let previous: Option<Vec<u8>> = tx
                .query_row("SELECT value FROM settings WHERE key = ?1", [FINGERPRINT_SETTING], |r| r.get(0))
                .optional()?;
            if previous.is_some_and(|p| constant_time_eq(&p, &fingerprint)) {
                return Ok::<_, rusqlite::Error>(0);
            }
            upsert_setting(tx, FINGERPRINT_SETTING, &fingerprint)?;
            tx.execute("DELETE FROM auth_sessions", [])
        })?;
        if revoked > 0 {
            tracing::info!("the password changed; signed out {revoked} browser sessions");
        }
        Ok(Auth { mode: config.auth, password: Some(password), checks: CheckCounters::default() })
    }

    pub fn mode(&self) -> AuthMode {
        self.mode
    }

    pub fn password_required(&self) -> bool {
        self.mode == AuthMode::Password
    }

    pub fn password_checks(&self) -> PasswordChecks {
        PasswordChecks {
            started: self.checks.started.load(Ordering::SeqCst),
            running: self.checks.running.load(Ordering::SeqCst),
            peak: self.checks.peak.load(Ordering::SeqCst),
        }
    }

    /// Verifies a login password. argon2id is slow on purpose, so call this off the async runtime.
    pub fn check_password(&self, store: &Store, given: &str) -> Result<bool> {
        let _running = Running::enter(&self.checks);
        Ok(match &self.password {
            None => false,
            Some(Password::Hashed(phc)) => verify_password(phc, given),
            Some(Password::Stored) => stored_password_hash(store)?.is_some_and(|phc| verify_password(&phc, given)),
        })
    }
}

/// A row of `auth_sessions`, a browser's login.
pub struct BrowserSession {
    pub id_hash: String,
    pub created_at: i64,
    pub last_seen_at: i64,
    pub expires_at: i64,
    pub user_agent: Option<String>,
    pub ip: Option<String>,
}

impl BrowserSession {
    /// The public id: the first 12 hex characters of the id hash.
    pub fn id(&self) -> &str {
        &self.id_hash[..12]
    }
}

/// Starts a session valid for `SESSION_MAX_AGE_SECS` and returns the cookie value; only its SHA-256 is stored.
/// Deletes expired sessions on the way.
pub fn create_session(store: &Store, user_agent: Option<&str>, ip: Option<&str>) -> Result<String> {
    let id = random_secret();
    let now = now_ms();
    store.write(|tx| {
        tx.execute("DELETE FROM auth_sessions WHERE expires_at <= ?1", [now])?;
        tx.execute(
            "INSERT INTO auth_sessions (id_hash, created_at, last_seen_at, expires_at, user_agent, ip)
             VALUES (?1, ?2, ?2, ?3, ?4, ?5)",
            params![sha256_hex(id.as_bytes()), now, now + SESSION_MAX_AGE_SECS * 1000, user_agent, ip],
        )?;
        Ok::<_, rusqlite::Error>(())
    })?;
    Ok(id)
}

/// The id hash of the live session a cookie value names. Records the visit at most once per `TOUCH_INTERVAL_MS` and
/// deletes the session when it has expired.
pub fn session_for_cookie(store: &Store, value: &str) -> Result<Option<String>> {
    let hash = sha256_hex(value.as_bytes());
    let row: Option<(i64, i64)> = store.read(|conn| {
        conn.prepare_cached("SELECT expires_at, last_seen_at FROM auth_sessions WHERE id_hash = ?1")?
            .query_row([&hash], |r| Ok((r.get(0)?, r.get(1)?)))
            .optional()
    })?;
    let Some((expires_at, last_seen_at)) = row else { return Ok(None) };
    let now = now_ms();
    if expires_at <= now {
        store.write(|tx| tx.execute("DELETE FROM auth_sessions WHERE id_hash = ?1", [&hash]))?;
        return Ok(None);
    }
    if last_seen_at <= now - TOUCH_INTERVAL_MS {
        store.write(|tx| tx.execute("UPDATE auth_sessions SET last_seen_at = ?2 WHERE id_hash = ?1", params![hash, now]))?;
    }
    Ok(Some(hash))
}

/// Live sessions, newest first.
pub fn list_sessions(store: &Store) -> Result<Vec<BrowserSession>> {
    let now = now_ms();
    Ok(store.read(|conn| {
        conn.prepare(
            "SELECT id_hash, created_at, last_seen_at, expires_at, user_agent, ip FROM auth_sessions
             WHERE expires_at > ?1 ORDER BY created_at DESC, id_hash",
        )?
        .query_map([now], |r| {
            Ok(BrowserSession {
                id_hash: r.get(0)?,
                created_at: r.get(1)?,
                last_seen_at: r.get(2)?,
                expires_at: r.get(3)?,
                user_agent: r.get(4)?,
                ip: r.get(5)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()
    })?)
}

pub fn delete_session(store: &Store, id_hash: &str) -> Result<bool> {
    Ok(store.write(|tx| tx.execute("DELETE FROM auth_sessions WHERE id_hash = ?1", [id_hash]))? > 0)
}

/// Deletes the sessions whose public id is `id`; returns their id hashes.
pub fn delete_session_by_id(store: &Store, id: &str) -> Result<Vec<String>> {
    if id.len() != 12 || !id.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) {
        return Ok(Vec::new());
    }
    Ok(store.write(|tx| {
        let hashes = tx
            .prepare("SELECT id_hash FROM auth_sessions WHERE substr(id_hash, 1, 12) = ?1")?
            .query_map([id], |r| r.get(0))?
            .collect::<rusqlite::Result<Vec<String>>>()?;
        tx.execute("DELETE FROM auth_sessions WHERE substr(id_hash, 1, 12) = ?1", [id])?;
        Ok::<_, rusqlite::Error>(hashes)
    })?)
}

/// Signs every browser out; returns how many sessions ended.
pub fn revoke_all_sessions(store: &Store) -> Result<usize> {
    Ok(store.write(|tx| tx.execute("DELETE FROM auth_sessions", []))?)
}
