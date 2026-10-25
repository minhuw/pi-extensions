use anyhow::{Result, bail};
use rusqlite::{OptionalExtension, params};
use sha2::{Digest, Sha256};

use crate::store::Store;
use crate::util::{constant_time_eq, hmac_sha256, now_ms, random_bytes, sha256_hex};

pub const COOKIE_NAME: &str = "pika_auth";
pub const COOKIE_MAX_AGE_SECS: i64 = 30 * 24 * 3600;
const COOKIE_KEY_SETTING: &str = "cookie_key";

fn valid_device_name(name: &str) -> bool {
    !name.is_empty() && name.len() <= 64 && name.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c))
}

/// Creates a device token and returns it; only its SHA-256 is stored.
pub fn create_token(store: &Store, name: &str) -> Result<String> {
    if !valid_device_name(name) {
        bail!("device names use 1-64 characters from [A-Za-z0-9._-]");
    }
    let token = format!("pika_{}", hex::encode(random_bytes::<32>()));
    let hash = sha256_hex(token.as_bytes());
    store.write(|tx| {
        if tx.query_row("SELECT 1 FROM tokens WHERE name = ?1", [name], |_| Ok(())).optional()?.is_some() {
            bail!("a token for {name:?} exists; revoke it first");
        }
        tx.execute("INSERT INTO tokens (name, hash, created_at) VALUES (?1, ?2, ?3)", params![name, hash, now_ms()])?;
        Ok(())
    })?;
    Ok(token)
}

/// Device names and creation times, by name.
pub fn list_tokens(store: &Store) -> Result<Vec<(String, i64)>> {
    Ok(store.read(|conn| {
        conn.prepare("SELECT name, created_at FROM tokens ORDER BY name")?
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()
    })?)
}

pub fn revoke_token(store: &Store, name: &str) -> Result<bool> {
    Ok(store.write(|tx| tx.execute("DELETE FROM tokens WHERE name = ?1", [name]))? > 0)
}

pub fn device_for_token(store: &Store, token: &str) -> Result<Option<String>> {
    let hash = sha256_hex(token.as_bytes());
    Ok(store.read(|conn| {
        conn.prepare_cached("SELECT name FROM tokens WHERE hash = ?1")?
            .query_row([hash], |r| r.get(0))
            .optional()
    })?)
}

/// Password login with HMAC-signed cookies. The signing key lives in the database; the password's hash is part of
/// each signature, so changing the password logs every browser out.
pub struct Auth {
    password_hash: Option<[u8; 32]>,
    key: Vec<u8>,
}

impl Auth {
    pub fn new(store: &Store, password: Option<&str>) -> Result<Auth> {
        let key = store.setting_or_init(COOKIE_KEY_SETTING, || random_bytes::<32>().to_vec())?;
        let password_hash = password.filter(|p| !p.is_empty()).map(|p| Sha256::digest(p.as_bytes()).into());
        Ok(Auth { password_hash, key })
    }

    pub fn password_required(&self) -> bool {
        self.password_hash.is_some()
    }

    pub fn check_password(&self, given: &str) -> bool {
        let given: [u8; 32] = Sha256::digest(given.as_bytes()).into();
        self.password_hash.is_some_and(|expected| constant_time_eq(&given, &expected))
    }

    fn signature(&self, expires: i64) -> [u8; 32] {
        let password = self.password_hash.map(hex::encode).unwrap_or_default();
        hmac_sha256(&self.key, format!("pika-session:{expires}:{password}").as_bytes())
    }

    /// A cookie value valid for `COOKIE_MAX_AGE_SECS`.
    pub fn issue(&self) -> String {
        let expires = now_ms() + COOKIE_MAX_AGE_SECS * 1000;
        format!("{expires}.{}", hex::encode(self.signature(expires)))
    }

    pub fn verify(&self, value: &str) -> bool {
        let Some((expires, signature)) = value.split_once('.') else { return false };
        let (Ok(expires), Ok(signature)) = (expires.parse::<i64>(), hex::decode(signature)) else { return false };
        expires > now_ms() && constant_time_eq(&signature, &self.signature(expires))
    }
}
