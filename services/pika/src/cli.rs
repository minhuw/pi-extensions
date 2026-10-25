use std::path::PathBuf;
use std::process::ExitCode;

use anyhow::Result;
use clap::{Parser, Subcommand};

use crate::config::{self, ServerConfig};
use crate::store::Store;

#[derive(Parser)]
#[command(name = "pika", version, about = "Stores and serves pi trajectories")]
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
        /// Require this password for the read API and UI.
        #[arg(long, env = "PIKA_PASSWORD", hide_env_values = true)]
        password: Option<String>,
        /// Maximum request body size, such as 32MiB.
        #[arg(long, env = "PIKA_MAX_BODY", default_value = "32MiB")]
        max_body: String,
    },
    /// Manage device tokens.
    Token {
        #[command(subcommand)]
        action: TokenAction,
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
    /// List devices with tokens.
    List,
    /// Revoke a device's token.
    Revoke { name: String },
}

pub fn main() -> ExitCode {
    let cli = Cli::parse();
    match run(cli) {
        Ok(code) => code,
        Err(e) => {
            eprintln!("pika: {e:#}");
            ExitCode::FAILURE
        }
    }
}

fn run(cli: Cli) -> Result<ExitCode> {
    match cli.command {
        Command::Serve { bind, base_path, password, max_body } => {
            let config = ServerConfig {
                bind,
                base_path: config::normalize_base_path(&base_path)?,
                data_dir: cli.data_dir,
                password: password.filter(|p| !p.is_empty()),
                max_body: config::parse_size(&max_body)?,
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
                    for (name, created) in crate::auth::list_tokens(&store)? {
                        println!("{name}\t{}", crate::util::format_iso_ms(created));
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
