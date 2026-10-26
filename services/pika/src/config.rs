use std::path::PathBuf;
use std::time::Duration;

use anyhow::{Result, bail};

pub const DEFAULT_BIND: &str = "127.0.0.1:7171";
pub const DEFAULT_DATA_DIR: &str = "./pika-data";
pub const DEFAULT_MAX_BODY: usize = 32 << 20;

/// Who authenticates viewers of the UI and the read API.
#[derive(Clone, Copy, Debug, PartialEq, Eq, clap::ValueEnum)]
pub enum AuthMode {
    /// pika's own password login; the server refuses to start without a password.
    Password,
    /// The reverse proxy authenticates every path except ingest, pairing, and health.
    Proxy,
    /// No authentication.
    None,
}

impl AuthMode {
    pub fn as_str(self) -> &'static str {
        match self {
            AuthMode::Password => "password",
            AuthMode::Proxy => "proxy",
            AuthMode::None => "none",
        }
    }
}

/// When the session cookie gets the `Secure` attribute.
#[derive(Clone, Copy, Debug, PartialEq, Eq, clap::ValueEnum)]
pub enum CookieSecure {
    /// When a trusted proxy reports that the request arrived over HTTPS.
    Auto,
    Always,
    Never,
}

#[derive(Clone, Debug)]
pub struct ServerConfig {
    pub bind: String,
    /// `/` or a path without a trailing slash, such as `/pika`.
    pub base_path: String,
    pub data_dir: PathBuf,
    pub auth: AuthMode,
    /// Read at startup; wins over `password` and the stored hash.
    pub password_file: Option<PathBuf>,
    /// Wins over the stored hash. Empty means unset.
    pub password: Option<String>,
    pub cookie_secure: CookieSecure,
    /// Take the client address from `X-Forwarded-For` and HTTPS from `X-Forwarded-Proto`.
    pub trust_proxy: bool,
    pub max_body: usize,
    pub relay: RelayConfig,
}

/// Relay settings. Only `enabled`, `ttl`, and `heartbeat` come from the environment, and the last two only for tests
/// and the end-to-end script; every other field keeps its default outside tests. See `docs/RELAY.md`.
#[derive(Clone, Debug)]
pub struct RelayConfig {
    pub enabled: bool,
    /// Undelivered messages are dropped this long after their acceptance.
    pub ttl: Duration,
    /// How often the server sends `ping` and re-validates each connection's token.
    pub heartbeat: Duration,
    /// A connection without any frame for this long is closed.
    pub dead_after: Duration,
    /// `hello` must arrive this soon after the upgrade.
    pub hello_timeout: Duration,
    /// How long `send` waits for the target's `ack` before answering `queued`.
    pub ack_wait: Duration,
    /// A socket write that takes longer closes the connection as dead.
    pub write_timeout: Duration,
    /// Bytes of frames a connection may have queued and not yet written; more closes it with 1008.
    pub max_outgoing_bytes: usize,
    pub max_text_bytes: usize,
    pub max_frame_bytes: usize,
    pub max_hops: u64,
    /// Sends per sending session in a sliding minute.
    pub sends_per_minute: usize,
    /// Sends per sending device, across its sessions, in a sliding minute.
    pub sends_per_minute_per_device: usize,
    pub max_queued_per_target: usize,
    pub max_queued: usize,
    pub max_online: usize,
    pub max_connections_per_device: usize,
    /// Owners of offline sessions remembered at once; more forgets the oldest.
    pub max_remembered: usize,
    pub event_ring: usize,
}

impl Default for RelayConfig {
    fn default() -> Self {
        RelayConfig {
            enabled: true,
            ttl: Duration::from_secs(300),
            heartbeat: Duration::from_secs(20),
            dead_after: Duration::from_secs(45),
            hello_timeout: Duration::from_secs(10),
            ack_wait: Duration::from_secs(2),
            write_timeout: Duration::from_secs(45),
            max_outgoing_bytes: 8 << 20,
            max_text_bytes: 32 << 10,
            max_frame_bytes: 64 << 10,
            max_hops: 8,
            sends_per_minute: 60,
            sends_per_minute_per_device: 300,
            max_queued_per_target: 100,
            max_queued: 10_000,
            max_online: 1_000,
            max_connections_per_device: 64,
            max_remembered: 10_000,
            event_ring: 500,
        }
    }
}

impl ServerConfig {
    pub fn new(data_dir: impl Into<PathBuf>) -> Self {
        ServerConfig {
            bind: DEFAULT_BIND.into(),
            base_path: "/".into(),
            data_dir: data_dir.into(),
            auth: AuthMode::Password,
            password_file: None,
            password: None,
            cookie_secure: CookieSecure::Auto,
            trust_proxy: false,
            max_body: DEFAULT_MAX_BODY,
            relay: RelayConfig::default(),
        }
    }

    /// The base path as a prefix to join paths onto: empty for `/`.
    pub fn prefix(&self) -> &str {
        if self.base_path == "/" { "" } else { &self.base_path }
    }
}

/// Normalizes `pika/`, `/pika/`, and `/pika` to `/pika`, and an empty path to `/`.
pub fn normalize_base_path(raw: &str) -> Result<String> {
    let trimmed = raw.trim().trim_matches('/');
    if trimmed.is_empty() {
        return Ok("/".into());
    }
    if trimmed.split('/').any(|seg| seg.is_empty() || seg == "." || seg == "..")
        || !trimmed.chars().all(|c| c.is_ascii_alphanumeric() || "-_.~/".contains(c))
    {
        bail!("invalid base path {raw:?}");
    }
    Ok(format!("/{trimmed}"))
}

/// Parses a byte size such as `33554432`, `512KiB`, `32MiB`, `1GiB`, or `32M`.
pub fn parse_size(raw: &str) -> Result<usize> {
    let s = raw.trim();
    let split = s.find(|c: char| !c.is_ascii_digit()).unwrap_or(s.len());
    let (digits, unit) = s.split_at(split);
    let Ok(n) = digits.parse::<usize>() else { bail!("invalid size {raw:?}") };
    let shift = match unit.trim().to_ascii_lowercase().as_str() {
        "" | "b" => 0,
        "k" | "kb" | "kib" => 10,
        "m" | "mb" | "mib" => 20,
        "g" | "gb" | "gib" => 30,
        _ => bail!("invalid size unit in {raw:?}"),
    };
    n.checked_mul(1 << shift).filter(|n| *n > 0).ok_or_else(|| anyhow::anyhow!("invalid size {raw:?}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base_paths() {
        assert_eq!(normalize_base_path("/").unwrap(), "/");
        assert_eq!(normalize_base_path("").unwrap(), "/");
        assert_eq!(normalize_base_path("pika/").unwrap(), "/pika");
        assert_eq!(normalize_base_path("/a/b").unwrap(), "/a/b");
        assert!(normalize_base_path("/a/../b").is_err());
        assert!(normalize_base_path("/a\"b").is_err());
    }

    #[test]
    fn sizes() {
        assert_eq!(parse_size("1024").unwrap(), 1024);
        assert_eq!(parse_size("32MiB").unwrap(), 32 << 20);
        assert_eq!(parse_size("8k").unwrap(), 8192);
        assert!(parse_size("lots").is_err());
    }
}
