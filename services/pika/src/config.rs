use std::path::PathBuf;

use anyhow::{Result, bail};

pub const DEFAULT_BIND: &str = "127.0.0.1:7171";
pub const DEFAULT_DATA_DIR: &str = "./pika-data";
pub const DEFAULT_MAX_BODY: usize = 32 << 20;

#[derive(Clone, Debug)]
pub struct ServerConfig {
    pub bind: String,
    /// `/` or a path without a trailing slash, such as `/pika`.
    pub base_path: String,
    pub data_dir: PathBuf,
    pub password: Option<String>,
    pub max_body: usize,
}

impl ServerConfig {
    pub fn new(data_dir: impl Into<PathBuf>) -> Self {
        ServerConfig {
            bind: DEFAULT_BIND.into(),
            base_path: "/".into(),
            data_dir: data_dir.into(),
            password: None,
            max_body: DEFAULT_MAX_BODY,
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
