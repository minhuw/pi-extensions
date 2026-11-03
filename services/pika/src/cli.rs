use std::io::{IsTerminal, Read};
use std::path::PathBuf;
use std::process::ExitCode;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use clap::{Parser, Subcommand};

use crate::auth::NoPassword;
use crate::config::{self, AuthMode, CookieSecure, RelayConfig, ServerConfig, VisitorAnalytics};
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
        /// Anonymous visitor analytics (on/auto detects direct and trusted proxy sources).
        #[arg(long, env = "PIKA_VISITOR_ANALYTICS", value_enum, default_value = "auto")]
        visitor_analytics: VisitorAnalytics,
        /// Maximum request body size, such as 32MiB.
        #[arg(long, env = "PIKA_MAX_BODY", default_value = "32MiB")]
        max_body: String,
        /// Relay messages between pi sessions: on or off.
        #[arg(long, env = "PIKA_RELAY", default_value = "on", value_parser = parse_switch_on)]
        relay: bool,
        /// Prices for Magpie calls that recorded no cost: a models.dev-format catalog URL or file, or off.
        #[arg(long, env = "PIKA_PRICES", default_value = crate::pricing::DEFAULT_SOURCE)]
        prices: String,
        /// For tests only: seconds an undelivered relay message is kept (default 300).
        #[arg(long, env = "PIKA_RELAY_TTL_SECS", hide = true, value_parser = clap::value_parser!(u64).range(1..))]
        relay_ttl_secs: Option<u64>,
        /// For tests only: seconds between relay heartbeats (default 20).
        #[arg(long, env = "PIKA_RELAY_HEARTBEAT_SECS", hide = true, value_parser = clap::value_parser!(u64).range(1..))]
        relay_heartbeat_secs: Option<u64>,
    },
    /// Manage devices and their tokens.
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
    /// Delete a session or a project for good, with everything recorded under it.
    Delete {
        #[command(subcommand)]
        what: DeleteAction,
    },
}

#[derive(Subcommand)]
enum DeleteAction {
    /// Delete a session and every recorded descendant (subagents, Herder steps, tickets).
    Session {
        id: String,
        /// Do not ask for confirmation.
        #[arg(long, short)]
        yes: bool,
    },
    /// Delete every session of a project, their descendants, and the project's Herder runs, and unpublish it.
    Project {
        name: String,
        /// Do not ask for confirmation.
        #[arg(long, short)]
        yes: bool,
    },
}

#[derive(Subcommand)]
enum TokenAction {
    /// Create a new device named NAME (1-64 characters; quote it in the shell) and print its token once.
    Create { name: String },
    /// List devices with tokens: id, name, creation time, origin, last upload, and last host.
    List,
    /// Revoke a device's token. DEVICE is a device id, or a name that only one device has.
    Revoke { device: String },
    /// Rename a device. DEVICE is a device id, or a name that only one device has.
    Rename { device: String, name: String },
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
            visitor_analytics,
            max_body,
            relay,
            prices,
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
                visitor_analytics,
                max_body: config::parse_size(&max_body)?,
                relay: relay_config,
                prices: config::price_source(&prices),
            };
            let level = if std::env::var_os("PIKA_DEBUG").is_some() { tracing::Level::DEBUG } else { tracing::Level::INFO };
            tracing_subscriber::fmt().with_max_level(level).with_target(false).init();
            tokio::runtime::Builder::new_multi_thread().enable_all().build()?.block_on(crate::http::serve(config))?;
        }
        Command::Token { action } => {
            let store = Store::open(&cli.data_dir)?;
            match action {
                TokenAction::Create { name } => {
                    let device = crate::auth::create_device(&store, &name)?;
                    println!("{}", device.token);
                    eprintln!("created device {} ({})", device.id, device.name);
                }
                TokenAction::List => {
                    for d in crate::auth::list_devices(&store)? {
                        let seen = d.last_seen_at.map_or_else(|| "never".into(), crate::util::format_iso_ms);
                        let created = crate::util::format_iso_ms(d.created_at);
                        let host = d.last_host.as_deref().unwrap_or("-");
                        println!("{}\t{}\t{created}\t{}\t{seen}\t{host}", d.id, d.name, d.created_via);
                    }
                }
                TokenAction::Revoke { device } => {
                    let id = crate::auth::resolve_device(&store, &device, true)?;
                    let name = store.read(|conn| crate::auth::name_of(conn, &id))?.unwrap_or_else(|| id.clone());
                    if !crate::auth::revoke_token(&store, &id)? {
                        bail!("no device {device:?}");
                    }
                    eprintln!("revoked {name} ({id})");
                }
                TokenAction::Rename { device, name } => {
                    if crate::auth::device_name(&name).is_none() {
                        bail!("device names use 1-64 characters, without control characters");
                    }
                    let id = crate::auth::resolve_device(&store, &device, false)?;
                    match crate::auth::rename_device(&store, &id, &name)? {
                        Some(name) => eprintln!("renamed {id} to {name}"),
                        None => bail!("no device {device:?}"),
                    }
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
        Command::Delete { what } => {
            let store = Store::open(&cli.data_dir)?;
            return delete(&store, what);
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

/// `pika delete`: says what will be deleted, asks unless `--yes`, deletes, and prints the counts. Safe while `pika
/// serve` runs on the same data dir: the deletion is one SQLite write transaction, which waits for the server's.
fn delete(store: &Store, what: DeleteAction) -> Result<ExitCode> {
    use crate::delete::{delete_project, delete_session, plan_project, plan_session};
    type Run<'a> = Box<dyn FnOnce() -> Result<Option<crate::delete::Deleted>> + 'a>;
    let (yes, description, run): (bool, String, Run) = match what {
        DeleteAction::Session { id, yes } => {
            let Some(plan) = store.read(|conn| plan_session(conn, &id))? else {
                eprintln!("pika: no session {id:?}");
                return Ok(ExitCode::FAILURE);
            };
            let n = plan.sessions.len();
            let what = if n == 1 { format!("session {id}") } else { format!("session {id} and its {} descendants", n - 1) };
            (yes, what, Box::new(move || delete_session(store, &id)))
        }
        DeleteAction::Project { name, yes } => {
            if !crate::util::valid_project(&name) {
                bail!("{name:?} is not a project name");
            }
            let (plan, selected) = store.read(|conn| -> Result<_> {
                let plan = plan_project(conn, &name)?;
                Ok((plan, crate::read::publishing::is_selected(conn, &name).map_err(|e| anyhow::anyhow!("{e}"))?))
            })?;
            if plan.sessions.is_empty() && plan.herder_runs.is_empty() && !selected {
                eprintln!("pika: no project {name:?}");
                return Ok(ExitCode::FAILURE);
            }
            let what = format!(
                "project {name:?}: {}, {}{}",
                plural(plan.sessions.len(), "session"),
                plural(plan.herder_runs.len(), "Herder run"),
                if selected { ", and its publication" } else { "" },
            );
            (yes, what, Box::new(move || delete_project(store, &name)))
        }
    };
    eprintln!("This permanently deletes {description}. It cannot be undone.");
    let stdin = std::io::stdin();
    if !confirmed(yes, stdin.is_terminal(), &mut stdin.lock(), &mut std::io::stderr())? {
        return Ok(ExitCode::FAILURE);
    }
    match run()? {
        Some(d) => {
            eprintln!(
                "deleted {} and {}",
                plural(d.deleted_sessions as usize, "session"),
                plural(d.deleted_herder_runs as usize, "Herder run")
            );
            Ok(ExitCode::SUCCESS)
        }
        None => {
            eprintln!("pika: nothing to delete any more");
            Ok(ExitCode::FAILURE)
        }
    }
}

fn plural(n: usize, noun: &str) -> String {
    if n == 1 { format!("1 {noun}") } else { format!("{n} {noun}s") }
}

/// Whether to go ahead with a deletion: at once with `--yes`; on a terminal when the answer is `y` or `yes`; never
/// when stdin is not a terminal without `--yes`, so a script cannot delete by piping an answer in by mistake.
fn confirmed(yes: bool, terminal: bool, input: &mut impl std::io::BufRead, out: &mut impl std::io::Write) -> Result<bool> {
    if yes {
        return Ok(true);
    }
    if !terminal {
        writeln!(out, "pika: refusing to delete without --yes when stdin is not a terminal")?;
        return Ok(false);
    }
    write!(out, "Delete? [y/N] ")?;
    out.flush()?;
    let mut answer = String::new();
    input.read_line(&mut answer).context("reading the answer")?;
    let go = matches!(answer.trim().to_ascii_lowercase().as_str(), "y" | "yes");
    if !go {
        writeln!(out, "nothing deleted")?;
    }
    Ok(go)
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

#[cfg(test)]
mod tests {
    use super::*;

    fn ask(yes: bool, terminal: bool, input: &str) -> (bool, String) {
        let mut out = Vec::new();
        let go = confirmed(yes, terminal, &mut input.as_bytes(), &mut out).unwrap();
        (go, String::from_utf8(out).unwrap())
    }

    #[test]
    fn deletion_asks_on_a_terminal_and_refuses_without_one() {
        assert_eq!(ask(true, false, ""), (true, String::new()));
        assert_eq!(ask(true, true, "n\n"), (true, String::new()));
        for answer in ["y\n", "YES\n", " yes \n"] {
            assert_eq!(ask(false, true, answer), (true, "Delete? [y/N] ".into()), "{answer:?}");
        }
        for answer in ["\n", "n\n", "no\n", "yeah\n", ""] {
            assert_eq!(ask(false, true, answer), (false, "Delete? [y/N] nothing deleted\n".into()), "{answer:?}");
        }
        // A piped "y" does not count.
        let (go, out) = ask(false, false, "y\n");
        assert!(!go && out.contains("--yes"), "{out}");
    }

    #[test]
    fn delete_subcommands_parse() {
        let cli = Cli::try_parse_from(["pika", "delete", "session", "abc", "--yes"]).unwrap();
        assert!(matches!(cli.command, Command::Delete { what: DeleteAction::Session { ref id, yes: true } } if id == "abc"));
        let cli = Cli::try_parse_from(["pika", "delete", "project", "my widgets"]).unwrap();
        assert!(matches!(cli.command, Command::Delete { what: DeleteAction::Project { ref name, yes: false } } if name == "my widgets"));
    }
}
