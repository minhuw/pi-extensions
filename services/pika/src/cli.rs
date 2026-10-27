use std::io::{IsTerminal, Read};
use std::path::PathBuf;
use std::process::ExitCode;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use clap::{Parser, Subcommand};

use crate::auth::NoPassword;
use crate::config::{self, AuthMode, CookieSecure, RelayConfig, ServerConfig};
use crate::store::Store;

#[derive(Parser)]
#[command(name = "pika", version = env!("PIKA_BUILD"), about = "Stores and serves pi trajectories")]
struct Cli {
    /// Directory holding pika.db and the blob store.
    #[arg(long, env = "PIKA_DATA_DIR", default_value = config::DEFAULT_DATA_DIR, global = true)]
    data_dir: PathBuf,
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Serve ingest, the read API, and the web UI.
    Serve {
        #[arg(long, env = "PIKA_BIND", default_value = config::DEFAULT_BIND)]
        bind: String,
        /// Path prefix for every route, such as /pika.
        #[arg(long, env = "PIKA_BASE_PATH", default_value = "/")]
        base_path: String,
        /// Who authenticates viewers: pika's password login, the reverse proxy, or nobody.
        #[arg(long, env = "PIKA_AUTH", value_enum, default_value = "password")]
        auth: AuthMode,
        /// Read the login password from this file (one trailing newline is removed); wins over --password.
        #[arg(long, env = "PIKA_PASSWORD_FILE")]
        password_file: Option<PathBuf>,
        /// The login password; wins over the one stored by `pika password set`.
        #[arg(long, env = "PIKA_PASSWORD", hide_env_values = true)]
        password: Option<String>,
        /// When the session cookie is Secure: auto (HTTPS reported by a trusted proxy), always, or never.
        #[arg(long, env = "PIKA_COOKIE_SECURE", value_enum, default_value = "auto")]
        cookie_secure: CookieSecure,
        /// Trust X-Forwarded-For and X-Forwarded-Proto from the reverse proxy.
        #[arg(long, env = "PIKA_TRUST_PROXY", value_parser = parse_switch)]
        trust_proxy: bool,
        /// Maximum request body size, such as 32MiB.
        #[arg(long, env = "PIKA_MAX_BODY", default_value = "32MiB")]
        max_body: String,
        /// Relay messages between pi sessions: on or off.
        #[arg(long, env = "PIKA_RELAY", default_value = "on", value_parser = parse_switch_on)]
        relay: bool,
        /// For tests only: seconds an undelivered relay message is kept (default 300).
        #[arg(long, env = "PIKA_RELAY_TTL_SECS", hide = true, value_parser = clap::value_parser!(u64).range(1..))]
        relay_ttl_secs: Option<u64>,
        /// For tests only: seconds between relay heartbeats (default 20).
        #[arg(long, env = "PIKA_RELAY_HEARTBEAT_SECS", hide = true, value_parser = clap::value_parser!(u64).range(1..))]
        relay_heartbeat_secs: Option<u64>,
    },
    /// Manage device tokens.
    Token {
        #[command(subcommand)]
        action: TokenAction,
    },
    /// Manage the stored login password.
    Password {
        #[command(subcommand)]
        action: PasswordAction,
    },
    /// Rebuild every derived table from the stored lines.
    Reindex,
    /// Write a session's verbatim JSONL to stdout.
    Export { session_id: String },
}

#[derive(Subcommand)]
enum TokenAction {
    /// Create a token for a device and print it once.
    Create { name: String },
    /// List devices with their creation time, origin, and last upload.
    List,
    /// Revoke a device's token.
    Revoke { name: String },
}

#[derive(Subcommand)]
enum PasswordAction {
    /// Store a new password (at least 12 characters) and sign every browser out. Reads it twice from the terminal
    /// without echo, or once from stdin.
    Set,
    /// Remove the stored password and sign every browser out.
    Clear,
}

/// A switch from the environment: `1`, `true`, `yes`, or `on`, or `0`, `false`, `no`, or `off`, in any case; empty
/// means off. Anything else is an error, so a typo cannot turn a switch on.
fn parse_switch(value: &str) -> Result<bool, String> {
    match value.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => Ok(true),
        "" | "0" | "false" | "no" | "off" => Ok(false),
        _ => Err("expected 1, true, yes, or on, or 0, false, no, or off".into()),
    }
}

/// Like `parse_switch`, for a switch that is on by default: empty means on.
fn parse_switch_on(value: &str) -> Result<bool, String> {
    if value.trim().is_empty() { Ok(true) } else { parse_switch(value) }
}

pub fn main() -> ExitCode {
    let cli = Cli::parse();
    match run(cli) {
        Ok(code) => code,
        Err(e) if e.downcast_ref::<NoPassword>().is_some() => {
            eprintln!("pika: {e}");
            ExitCode::from(2)
        }
        Err(e) => {
            eprintln!("pika: {e:#}");
            ExitCode::FAILURE
        }
    }
}

fn run(cli: Cli) -> Result<ExitCode> {
    match cli.command {
        Command::Serve {
            bind,
            base_path,
            auth,
            password_file,
            password,
            cookie_secure,
            trust_proxy,
            max_body,
            relay,
            relay_ttl_secs,
            relay_heartbeat_secs,
        } => {
            let mut relay_config = RelayConfig { enabled: relay, ..RelayConfig::default() };
            if let Some(secs) = relay_ttl_secs {
                relay_config.ttl = Duration::from_secs(secs);
            }
            if let Some(secs) = relay_heartbeat_secs {
                relay_config.heartbeat = Duration::from_secs(secs);
            }
            let config = ServerConfig {
                bind,
                base_path: config::normalize_base_path(&base_path)?,
                data_dir: cli.data_dir,
                auth,
                password_file,
                password: password.filter(|p| !p.is_empty()),
                cookie_secure,
                trust_proxy,
                max_body: config::parse_size(&max_body)?,
                relay: relay_config,
            };
            let level = if std::env::var_os("PIKA_DEBUG").is_some() { tracing::Level::DEBUG } else { tracing::Level::INFO };
            tracing_subscriber::fmt().with_max_level(level).with_target(false).init();
            tokio::runtime::Builder::new_multi_thread().enable_all().build()?.block_on(crate::http::serve(config))?;
        }
        Command::Token { action } => {
            let store = Store::open(&cli.data_dir)?;
            match action {
                TokenAction::Create { name } => println!("{}", crate::auth::create_token(&store, &name)?),
                TokenAction::List => {
                    for d in crate::auth::list_devices(&store)? {
                        let seen = d.last_seen_at.map_or_else(|| "never".into(), crate::util::format_iso_ms);
                        let created = crate::util::format_iso_ms(d.created_at);
                        println!("{}\t{created}\t{}\t{seen}\t{}", d.name, d.created_via, d.last_host.as_deref().unwrap_or("-"));
                    }
                }
                TokenAction::Revoke { name } => {
                    if !crate::auth::revoke_token(&store, &name)? {
                        eprintln!("pika: no token for {name:?}");
                        return Ok(ExitCode::FAILURE);
                    }
                    eprintln!("revoked {name}");
                }
            }
        }
        Command::Password { action } => {
            let store = Store::open(&cli.data_dir)?;
            match action {
                PasswordAction::Set => {
                    let password = read_new_password()?;
                    let revoked = crate::auth::set_password(&store, &password)?;
                    eprintln!("password set; signed out {revoked} browser sessions");
                    for var in ["PIKA_PASSWORD_FILE", "PIKA_PASSWORD"] {
                        if std::env::var_os(var).is_some_and(|v| !v.is_empty()) {
                            eprintln!("note: {var} is set and wins over the stored password");
                        }
                    }
                }
                PasswordAction::Clear => match crate::auth::clear_password(&store)? {
                    Some(revoked) => eprintln!("stored password removed; signed out {revoked} browser sessions"),
                    None => eprintln!("no stored password"),
                },
            }
        }
        Command::Reindex => {
            let store = Store::open(&cli.data_dir)?;
            let stats = crate::reindex::reindex(&store)?;
            eprintln!("reindexed {} streams, {} lines", stats.streams, stats.lines);
        }
        Command::Export { session_id } => {
            let store = Store::open(&cli.data_dir)?;
            let stdout = std::io::stdout();
            let mut out = std::io::BufWriter::new(stdout.lock());
            if !crate::export::write_session(&store, &session_id, &mut out)? {
                eprintln!("pika: no session {session_id:?}");
                return Ok(ExitCode::FAILURE);
            }
        }
    }
    Ok(ExitCode::SUCCESS)
}

/// Reads a new password twice without echo from the terminal, or once from stdin with one trailing newline removed.
fn read_new_password() -> Result<String> {
    if !std::io::stdin().is_terminal() {
        let mut text = String::new();
        std::io::stdin().read_to_string(&mut text).context("reading the password from stdin")?;
        let password = match text.strip_suffix('\n') {
            Some(rest) => rest.strip_suffix('\r').unwrap_or(rest),
            None => &text,
        };
        return Ok(password.to_owned());
    }
    let first = rpassword::prompt_password("New password: ").context("reading the password")?;
    if first.chars().count() < crate::auth::MIN_PASSWORD_CHARS {
        bail!("the password needs at least {} characters", crate::auth::MIN_PASSWORD_CHARS);
    }
    let second = rpassword::prompt_password("Repeat it: ").context("reading the password")?;
    if first != second {
        bail!("the passwords differ");
    }
    Ok(first)
}
