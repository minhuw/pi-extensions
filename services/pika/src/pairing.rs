//! Device pairing, like OAuth's device flow: a device starts a pairing and polls with a secret id, the user approves
//! its code in the UI, and the device's next poll creates its token and returns it once. A pairing from a pi install
//! that pika recognizes, by its current token or its device key, can continue that install's device.

use anyhow::Result;
use rusqlite::{OptionalExtension, Transaction, params};

use crate::auth::{delete_tokens, device_name, insert_device, insert_token, new_device_id};
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
    /// The requested device name, already validated.
    pub device: &'a str,
    pub host: Option<&'a str>,
    pub ip: Option<&'a str>,
    pub pika_version: Option<&'a str>,
    /// The SHA-256 of the bearer token the request came with, if any.
    pub token_hash: Option<String>,
    /// The hash of the requesting install's device key, if it sent one.
    pub key_hash: Option<String>,
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
        // Recognize the device by its current token, else by its key. A token that resolves to nothing is ignored:
        // re-pairing usually happens because the token is gone.
        let by_token: Option<String> = match &request.token_hash {
            Some(hash) => tx.query_row("SELECT name FROM tokens WHERE hash = ?1", [hash], |r| r.get(0)).optional()?,
            None => None,
        };
        let matched = match (by_token, &request.key_hash) {
            (Some(id), _) => Some((id, "token")),
            (None, Some(key)) => tx
                .query_row("SELECT id FROM devices WHERE key_hash = ?1", [key], |r| r.get(0))
                .optional()?
                .map(|id| (id, "key")),
            (None, None) => None,
        };
        let (matched, matched_by) = matched.unzip();
        tx.execute(
            "INSERT INTO pairings (id_hash, code, device, host, ip, pika_version, requested_at, expires_at, key_hash,
                                   matched, matched_by)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![
                sha256_hex(pairing_id.as_bytes()),
                code,
                request.device,
                request.host,
                request.ip,
                request.pika_version,
                now,
                expires_at,
                request.key_hash,
                matched,
                matched_by
            ],
        )?;
        Ok(Some(Started { pairing_id, code: format_code(&code), expires_at }))
    })
}

pub enum Poll {
    Pending,
    /// `device` is the device id and `continued` whether it existed before. `revoked` holds the hashes of the tokens
    /// a continued device lost.
    Approved { device: String, name: String, token: String, continued: bool, revoked: Vec<String> },
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
        type Row = (String, i64, Option<String>, Option<String>, bool, Option<String>);
        let row: Option<Row> = tx
            .query_row(
                "SELECT status, expires_at, name, target, replace, key_hash FROM pairings WHERE id_hash = ?1",
                [&hash],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)),
            )
            .optional()?;
        let Some((status, expires_at, name, target, replace, key_hash)) = row else { return Ok(None) };
        let answer = match (status.as_str(), name) {
            _ if expires_at <= now => Poll::Expired,
            ("pending", _) => return Ok(Some(Poll::Pending)),
            // Approved before the upgrade to device ids: the name was the id, and only `replace` took over a token.
            ("approved", Some(name)) if target.is_none() && !replace && token_exists(tx, &name)? => {
                tracing::warn!("pairing for {name:?} refused: the device exists and approval did not replace it");
                Poll::Denied
            }
            ("approved", Some(name)) => {
                let device = target.unwrap_or_else(|| name.clone());
                let continued = tx
                    .execute("UPDATE devices SET name = ?2 WHERE id = ?1", params![device, name])?
                    > 0;
                if !continued {
                    insert_device(tx, &device, &name, now)?;
                }
                let revoked = delete_tokens(tx, &device)?;
                let token = insert_token(tx, &device, "pairing")?;
                // A machine's key points at the device it was last paired as.
                if let Some(key_hash) = key_hash {
                    let (cleared, set) = (
                        "UPDATE devices SET key_hash = NULL WHERE key_hash = ?1 AND id <> ?2",
                        "UPDATE devices SET key_hash = ?1 WHERE id = ?2",
                    );
                    tx.execute(cleared, params![key_hash, device])?;
                    tx.execute(set, params![key_hash, device])?;
                }
                Poll::Approved { device, name, token, continued, revoked }
            }
            _ => Poll::Denied,
        };
        tx.execute("DELETE FROM pairings WHERE id_hash = ?1", [&hash])?;
        Ok(Some(answer))
    })
}

fn token_exists(tx: &Transaction, id: &str) -> rusqlite::Result<bool> {
    Ok(tx.query_row("SELECT 1 FROM tokens WHERE name = ?1", [id], |_| Ok(())).optional()?.is_some())
}

/// The device a pairing request was recognized as when it started.
pub struct Match {
    pub id: String,
    pub name: String,
    /// `token` or `key`.
    pub by: String,
    /// Whether the device has a token.
    pub active: bool,
}

pub struct Pending {
    pub code: String,
    /// The requested name.
    pub name: String,
    pub host: Option<String>,
    pub ip: Option<String>,
    pub pika_version: Option<String>,
    pub requested_at: i64,
    pub expires_at: i64,
    pub matched: Option<Match>,
}

/// Pending, unexpired pairings, newest first.
pub fn pending(store: &Store, now: i64) -> Result<Vec<Pending>> {
    Ok(store.read(|conn| {
        conn.prepare(
            "SELECT p.code, p.device, p.host, p.ip, p.pika_version, p.requested_at, p.expires_at, p.matched,
                    COALESCE(d.name, p.matched), p.matched_by, EXISTS (SELECT 1 FROM tokens t WHERE t.name = p.matched)
             FROM pairings p LEFT JOIN devices d ON d.id = p.matched
             WHERE p.status = 'pending' AND p.expires_at > ?1 ORDER BY p.requested_at DESC, p.code",
        )?
        .query_map([now], |r| {
            let matched = match (r.get::<_, Option<String>>(7)?, r.get::<_, Option<String>>(8)?, r.get(9)?) {
                (Some(id), Some(name), Some(by)) => Some(Match { id, name, by, active: r.get(10)? }),
                _ => None,
            };
            Ok(Pending {
                code: format_code(&r.get::<_, String>(0)?),
                name: r.get(1)?,
                host: r.get(2)?,
                ip: r.get(3)?,
                pika_version: r.get(4)?,
                requested_at: r.get(5)?,
                expires_at: r.get(6)?,
                matched,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()
    })?)
}

/// Which device an approved pairing's token belongs to.
#[derive(Clone, Debug)]
pub enum Continues {
    /// The device the request was recognized as, or a new device when it was not.
    Match,
    New,
    /// An existing device id, with or without a token.
    Device(String),
}

pub enum Approval {
    /// Approved for device `device` (the id), named `name`; `continued` when that device exists.
    Approved { device: String, name: String, continued: bool },
    NotFound,
    UnknownDevice,
    InvalidName,
}

/// Approves a pending pairing for the device `continues` chooses, named `name` (default: the continued device's
/// name, or the requested name for a new device). Only the choice is stored; the device's poll creates the token.
pub fn approve(store: &Store, code: &str, name: Option<&str>, continues: Continues, now: i64) -> Result<Approval> {
    let Some(code) = normalize_code(code) else { return Ok(Approval::NotFound) };
    store.write(|tx| {
        let row: Option<(String, Option<String>)> = tx
            .query_row(
                "SELECT device, matched FROM pairings WHERE code = ?1 AND status = 'pending' AND expires_at > ?2",
                params![code, now],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        let Some((requested, matched)) = row else { return Ok(Approval::NotFound) };
        let (chosen, explicit) = match continues {
            Continues::Match => (matched, false),
            Continues::New => (None, false),
            Continues::Device(id) => (Some(id), true),
        };
        let existing = match chosen {
            Some(id) => match crate::auth::name_of(tx, &id)? {
                Some(current) => Some((id, current)),
                None if explicit => return Ok(Approval::UnknownDevice),
                // A matched device always has a row; without one, the request gets a new device.
                None => None,
            },
            None => None,
        };
        let default = existing.as_ref().map_or(requested.as_str(), |(_, current)| current.as_str());
        let Some(name) = device_name(name.unwrap_or(default)).map(str::to_owned) else {
            return Ok(Approval::InvalidName);
        };
        let continued = existing.is_some();
        let device = existing.map_or_else(new_device_id, |(id, _)| id);
        tx.execute(
            "UPDATE pairings SET status = 'approved', name = ?2, target = ?3 WHERE code = ?1",
            params![code, name, device],
        )?;
        Ok(Approval::Approved { device, name, continued })
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
