//! Device pairing, like OAuth's device flow: a device starts a pairing and polls with a secret id, the user approves
//! its code in the UI, and the device's next poll creates its token and returns it once.

use anyhow::Result;
use rusqlite::{OptionalExtension, params};

use crate::auth::{device_exists, insert_token, valid_device_name};
use crate::store::Store;
use crate::util::{random_bytes, random_secret, sha256_hex};

pub const TTL_SECS: i64 = 600;
pub const POLL_INTERVAL_SECS: i64 = 2;
pub const MAX_PENDING: i64 = 10;
const CODE_ALPHABET: &[u8; 32] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
/// An expired pairing answers `expired` to a poll for this long, then any start deletes it.
const EXPIRED_KEEP_MS: i64 = 600_000;

pub struct Started {
    pub pairing_id: String,
    /// Formatted `XXXX-XXXX`.
    pub code: String,
    pub expires_at: i64,
}

pub struct Request<'a> {
    pub device: &'a str,
    pub host: Option<&'a str>,
    pub ip: Option<&'a str>,
    pub pika_version: Option<&'a str>,
}

/// `ABCDEFGH` as `ABCD-EFGH`.
pub fn format_code(code: &str) -> String {
    format!("{}-{}", &code[..4], &code[4..])
}

/// A code as stored: the 8 characters without the hyphen, upper case. `None` when it cannot be a code.
pub fn normalize_code(input: &str) -> Option<String> {
    let code: String = input.chars().filter(|c| *c != '-').map(|c| c.to_ascii_uppercase()).collect();
    (code.len() == 8 && code.bytes().all(|b| CODE_ALPHABET.contains(&b))).then_some(code)
}

fn random_code() -> String {
    random_bytes::<8>().iter().map(|b| CODE_ALPHABET[usize::from(b & 31)] as char).collect()
}

const PENDING_COUNT: &str = "SELECT count(*) FROM pairings WHERE status = 'pending' AND expires_at > ?1";

/// How many pairings are pending and unexpired, read without the writer.
pub fn pending_count(store: &Store, now: i64) -> Result<i64> {
    Ok(store.read(|conn| conn.query_row(PENDING_COUNT, [now], |r| r.get(0)))?)
}

/// Starts a pairing, or returns `None` when `MAX_PENDING` pairings are already pending.
pub fn start(store: &Store, request: &Request, now: i64) -> Result<Option<Started>> {
    let pairing_id = random_secret();
    let expires_at = now + TTL_SECS * 1000;
    store.write(|tx| {
        tx.execute("DELETE FROM pairings WHERE expires_at <= ?1", [now - EXPIRED_KEEP_MS])?;
        let pending: i64 = tx.query_row(PENDING_COUNT, [now], |r| r.get(0))?;
        if pending >= MAX_PENDING {
            return Ok(None);
        }
        let code = loop {
            let code = random_code();
            if tx.query_row("SELECT 1 FROM pairings WHERE code = ?1", [&code], |_| Ok(())).optional()?.is_none() {
                break code;
            }
        };
        tx.execute(
            "INSERT INTO pairings (id_hash, code, device, host, ip, pika_version, requested_at, expires_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                sha256_hex(pairing_id.as_bytes()),
                code,
                request.device,
                request.host,
                request.ip,
                request.pika_version,
                now,
                expires_at
            ],
        )?;
        Ok(Some(Started { pairing_id, code: format_code(&code), expires_at }))
    })
}

pub enum Poll {
    Pending,
    Approved { device: String, token: String },
    Denied,
    Expired,
}

/// Answers a device's poll, or `None` for an unknown pairing id. Every answer but `Pending` deletes the pairing; an
/// approval creates the device token here, so no plaintext token is ever stored. Unknown and pending pairings are
/// answered from a read connection, so polls do not queue for the writer.
pub fn poll(store: &Store, pairing_id: &str, now: i64) -> Result<Option<Poll>> {
    let hash = sha256_hex(pairing_id.as_bytes());
    let row: Option<(String, i64)> = store.read(|conn| {
        conn.prepare_cached("SELECT status, expires_at FROM pairings WHERE id_hash = ?1")?
            .query_row([&hash], |r| Ok((r.get(0)?, r.get(1)?)))
            .optional()
    })?;
    match row {
        None => return Ok(None),
        Some((status, expires_at)) if status == "pending" && expires_at > now => return Ok(Some(Poll::Pending)),
        Some(_) => {}
    }
    store.write(|tx| {
        let row: Option<(String, i64, Option<String>, bool)> = tx
            .query_row("SELECT status, expires_at, name, replace FROM pairings WHERE id_hash = ?1", [&hash], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
            })
            .optional()?;
        let Some((status, expires_at, name, replace)) = row else { return Ok(None) };
        let answer = match (status.as_str(), name) {
            _ if expires_at <= now => Poll::Expired,
            ("pending", _) => return Ok(Some(Poll::Pending)),
            ("approved", Some(name)) => {
                if replace {
                    tx.execute("DELETE FROM tokens WHERE name = ?1", [&name])?;
                }
                if device_exists(tx, &name)? {
                    // A token of that name was created after the approval.
                    tracing::warn!("pairing for {name:?} refused: the device exists and approval did not replace it");
                    Poll::Denied
                } else {
                    let token = insert_token(tx, &name, "pairing")?;
                    Poll::Approved { device: name, token }
                }
            }
            _ => Poll::Denied,
        };
        tx.execute("DELETE FROM pairings WHERE id_hash = ?1", [&hash])?;
        Ok(Some(answer))
    })
}

pub struct Pending {
    pub code: String,
    pub device: String,
    pub host: Option<String>,
    pub ip: Option<String>,
    pub pika_version: Option<String>,
    pub requested_at: i64,
    pub expires_at: i64,
    pub device_exists: bool,
}

/// Pending, unexpired pairings, newest first.
pub fn pending(store: &Store, now: i64) -> Result<Vec<Pending>> {
    Ok(store.read(|conn| {
        conn.prepare(
            "SELECT code, device, host, ip, pika_version, requested_at, expires_at,
                    EXISTS (SELECT 1 FROM tokens WHERE tokens.name = pairings.device)
             FROM pairings WHERE status = 'pending' AND expires_at > ?1 ORDER BY requested_at DESC, code",
        )?
        .query_map([now], |r| {
            Ok(Pending {
                code: format_code(&r.get::<_, String>(0)?),
                device: r.get(1)?,
                host: r.get(2)?,
                ip: r.get(3)?,
                pika_version: r.get(4)?,
                requested_at: r.get(5)?,
                expires_at: r.get(6)?,
                device_exists: r.get(7)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()
    })?)
}

pub enum Approval {
    /// Approved under this device name.
    Approved(String),
    NotFound,
    InvalidName,
    DeviceExists,
}

/// Approves a pending pairing under `name` (default: the requested device name).
pub fn approve(store: &Store, code: &str, name: Option<&str>, replace: bool, now: i64) -> Result<Approval> {
    let Some(code) = normalize_code(code) else { return Ok(Approval::NotFound) };
    store.write(|tx| {
        let device: Option<String> = tx
            .query_row(
                "SELECT device FROM pairings WHERE code = ?1 AND status = 'pending' AND expires_at > ?2",
                params![code, now],
                |r| r.get(0),
            )
            .optional()?;
        let Some(device) = device else { return Ok(Approval::NotFound) };
        let name = name.unwrap_or(&device);
        if !valid_device_name(name) {
            return Ok(Approval::InvalidName);
        }
        if !replace && device_exists(tx, name)? {
            return Ok(Approval::DeviceExists);
        }
        tx.execute(
            "UPDATE pairings SET status = 'approved', name = ?2, replace = ?3 WHERE code = ?1",
            params![code, name, replace],
        )?;
        Ok(Approval::Approved(name.to_owned()))
    })
}

/// Denies a pending pairing; returns whether there was one.
pub fn deny(store: &Store, code: &str, now: i64) -> Result<bool> {
    let Some(code) = normalize_code(code) else { return Ok(false) };
    Ok(store.write(|tx| {
        tx.execute(
            "UPDATE pairings SET status = 'denied' WHERE code = ?1 AND status = 'pending' AND expires_at > ?2",
            params![code, now],
        )
    })? > 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codes() {
        for _ in 0..100 {
            let code = random_code();
            assert_eq!(normalize_code(&code).as_deref(), Some(code.as_str()));
            assert_eq!(normalize_code(&format_code(&code).to_lowercase()).as_deref(), Some(code.as_str()));
        }
        assert_eq!(format_code("ABCDEFGH"), "ABCD-EFGH");
        assert_eq!(normalize_code("abcd-efgh").as_deref(), Some("ABCDEFGH"));
        assert_eq!(normalize_code("ABCDEFG"), None);
        // 0, 1, I, and O are not in the alphabet.
        assert_eq!(normalize_code("ABCD-EFG0"), None);
        assert_eq!(normalize_code("ABCD-EFGI"), None);
    }
}
