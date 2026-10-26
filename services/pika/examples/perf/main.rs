//! pika's performance harness (`scripts/perf.sh` drives it):
//!
//! - `perf load --data-dir D --plan P --stats S` generates the dataset and loads it through the ingest code.
//! - `perf check --data-dir D --shape S` checks the loaded dataset's shape from the database's counts.
//! - `perf bench --addr A --plan P --data-dir D` measures the read API of a running `pika serve`.
//!
//! `--scale` makes a smaller dataset of the same shape for trying the harness; the check then expects that size.

mod bench;
mod check;
mod dataset;
mod load;
mod rng;
mod text;

use std::path::PathBuf;
use std::process::ExitCode;

use anyhow::Result;
use clap::{Parser, Subcommand};

#[derive(Parser)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    Load {
        #[arg(long)]
        data_dir: PathBuf,
        #[arg(long)]
        plan: PathBuf,
        #[arg(long)]
        stats: PathBuf,
        #[arg(long)]
        scale: Option<f64>,
    },
    Check {
        #[arg(long)]
        data_dir: PathBuf,
        #[arg(long)]
        shape: PathBuf,
        #[arg(long)]
        scale: Option<f64>,
    },
    Bench {
        /// host:port of the server.
        #[arg(long)]
        addr: String,
        #[arg(long, default_value = "/")]
        base_path: String,
        #[arg(long)]
        plan: PathBuf,
        #[arg(long)]
        data_dir: PathBuf,
        /// The server's process id, for its peak RSS.
        #[arg(long)]
        pid: Option<u32>,
        #[arg(long)]
        load_stats: Option<PathBuf>,
        #[arg(long)]
        shape: Option<PathBuf>,
        /// Run only these sections (list, session, search); for investigating, never passes.
        #[arg(long, value_delimiter = ',', value_parser = clap::builder::PossibleValuesParser::new(bench::SECTIONS))]
        only: Vec<String>,
        /// Measured requests per class; fewer than the default never passes.
        #[arg(long, default_value_t = bench::SAMPLES)]
        samples: usize,
    },
}

fn config(scale: Option<f64>) -> dataset::Config {
    scale.map_or_else(dataset::Config::full, dataset::Config::scaled)
}

fn run(cli: Cli) -> Result<bool> {
    match cli.command {
        Command::Load { data_dir, plan, stats, scale } => load::run(&data_dir, &plan, &stats, config(scale)).map(|_| true),
        Command::Check { data_dir, shape, scale } => {
            let value = check::run(&data_dir, &config(scale), scale.is_none())?;
            std::fs::write(&shape, value.to_string())?;
            eprintln!("perf: dataset shape ok: {value}");
            Ok(true)
        }
        Command::Bench { addr, base_path, plan, data_dir, pid, load_stats, shape, only, samples } => bench::run(bench::Options {
            addr,
            base_path,
            plan: &plan,
            data_dir: &data_dir,
            pid,
            load_stats: load_stats.as_deref(),
            shape: shape.as_deref(),
            only,
            samples,
        }),
    }
}

fn main() -> ExitCode {
    match run(Cli::parse()) {
        Ok(true) => ExitCode::SUCCESS,
        Ok(false) => {
            eprintln!("perf: a limit was exceeded");
            ExitCode::FAILURE
        }
        Err(e) => {
            eprintln!("perf: {e:#}");
            ExitCode::FAILURE
        }
    }
}
