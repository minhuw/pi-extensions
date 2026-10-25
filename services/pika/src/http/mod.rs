mod auth;
mod ingest;
mod read;
mod ui;

use std::sync::Arc;

use anyhow::Result;
use axum::extract::State;
use axum::http::StatusCode;
use axum::middleware;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::json;

use crate::auth::Auth;
use crate::config::ServerConfig;
use crate::store::Store;

#[derive(Clone)]
pub struct AppState {
    pub store: Arc<Store>,
    pub auth: Arc<Auth>,
    pub config: Arc<ServerConfig>,
}

impl AppState {
    pub fn new(store: Arc<Store>, config: ServerConfig) -> Result<AppState> {
        let auth = Auth::new(&store, config.password.as_deref())?;
        Ok(AppState { store, auth: Arc::new(auth), config: Arc::new(config) })
    }
}

/// A JSON error body `{ "error": code, ... }`.
pub fn error(status: StatusCode, code: &str) -> Response {
    (status, Json(json!({ "error": code }))).into_response()
}

pub fn internal_error(e: impl std::fmt::Display) -> Response {
    tracing::error!("{e}");
    error(StatusCode::INTERNAL_SERVER_ERROR, "internal")
}

/// Runs blocking store work off the async runtime.
pub async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T> + Send + 'static) -> Result<T> {
    tokio::task::spawn_blocking(f).await?
}

async fn health(State(state): State<AppState>) -> Response {
    Json(json!({ "ok": true, "version": env!("CARGO_PKG_VERSION"), "basePath": state.config.base_path })).into_response()
}

/// The whole application with every route under the configured base path.
pub fn router(state: AppState) -> Router {
    let protected = read::routes()
        .route("/logout", post(auth::logout))
        .route_layer(middleware::from_fn_with_state(state.clone(), auth::require));
    let v1 = Router::new().route("/login", post(auth::login)).route("/me", get(auth::me)).merge(protected);
    let inner = Router::new()
        .route("/api/health", get(health))
        .route("/api/ingest/v1/batch", post(ingest::batch))
        .nest("/api/v1", v1)
        .fallback(ui::serve)
        .with_state(state.clone());
    if state.config.base_path == "/" {
        inner
    } else {
        Router::new()
            .nest_service(&state.config.base_path, inner)
            .fallback(|| async { error(StatusCode::NOT_FOUND, "not_found") })
    }
}

pub async fn serve(config: ServerConfig) -> Result<()> {
    let store = Store::open(&config.data_dir)?;
    let state = AppState::new(store, config.clone())?;
    let listener = tokio::net::TcpListener::bind(&config.bind).await?;
    tracing::info!(
        "pika {} listening on http://{}{} (data {}, password {})",
        env!("CARGO_PKG_VERSION"),
        listener.local_addr()?,
        config.base_path,
        config.data_dir.display(),
        if state.auth.password_required() { "on" } else { "off" },
    );
    axum::serve(listener, router(state)).with_graceful_shutdown(shutdown_signal()).await?;
    Ok(())
}

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut signal) => {
                signal.recv().await;
            }
            Err(_) => std::future::pending().await,
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        _ = ctrl_c => {}
        _ = terminate => {}
    }
}
