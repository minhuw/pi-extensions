//! pika: ingest, storage, read API, and web UI for pi trajectories. See `docs/SPEC.md`.

pub mod auth;
pub mod blobs;
pub mod cli;
pub mod config;
pub mod delete;
pub mod derive;
pub mod export;
pub mod hidden;
pub mod http;
pub mod ingest;
pub mod memory;
pub mod pairing;
pub mod pricing;
pub mod ratelimit;
pub mod read;
pub mod redact;
pub mod reindex;
pub mod relay;
pub mod requests;
pub mod store;
pub mod tokenizer;
pub mod util;

/// The commit this binary was built from, as 7 hex digits, or empty when the build did not say (see `build.rs`).
pub const REVISION: &str = env!("PIKA_REVISION_SHORT");
