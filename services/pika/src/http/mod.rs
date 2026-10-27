mod auth;
mod devices;
mod ingest;
mod read;
mod relay;
mod ui;

use std::net::SocketAddr;
use std::sync::{Arc, Mutex, MutexGuard};

use anyhow::Result;
use axum::extract::State;
use axum::http::StatusCode;
use axum::middleware;
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use serde_json::json;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

use crate::auth::Auth;
use crate::config::ServerConfig;
use crate::relay::Relay;
use crate::ratelimit::{
    LoginLimiter, MAX_PASSWORD_CHECKS, PAIR_START_WINDOW, PAIR_STARTS_PER_IP, PASSWORD_CHECK_QUEUE, SlidingWindow,
};
use crate::store::Store;

/// The in-memory rate limits.
pub struct Limits {
    login: Mutex<LoginLimiter>,
    pair_starts: Mutex<SlidingWindow>,
    /// One permit per password check allowed to run. The permit moves into the blocking task, so a check whose login
    /// was cancelled still holds it until argon2 finishes.
    password_checks: Arc<Semaphore>,
}

impl Default for Limits {
    fn default() -> Self {
        Limits {
            login: Mutex::new(LoginLimiter::default()),
            pair_starts: Mutex::new(SlidingWindow::new(PAIR_STARTS_PER_IP, PAIR_START_WINDOW)),
            password_checks: Arc::new(Semaphore::new(MAX_PASSWORD_CHECKS)),
        }
    }
}

impl Limits {
    fn login(&self) -> MutexGuard<'_, LoginLimiter> {
        self.login.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn pair_starts(&self) -> MutexGuard<'_, SlidingWindow> {
        self.pair_starts.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Waits up to `PASSWORD_CHECK_QUEUE` for a password check to free up.
    async fn password_check(&self) -> Option<OwnedSemaphorePermit> {
        let permit = self.password_checks.clone().acquire_owned();
        tokio::time::timeout(PASSWORD_CHECK_QUEUE, permit).await.ok()?.ok()
    }
}

#[derive(Clone)]
pub struct AppState {
    pub store: Arc<Store>,
    pub auth: Arc<Auth>,
    pub config: Arc<ServerConfig>,
    pub limits: Arc<Limits>,
    pub relay: Arc<Relay>,
}

impl AppState {
    /// Fails with `auth::NoPassword` in `password` mode without a password.
    pub fn new(store: Arc<Store>, config: ServerConfig) -> Result<AppState> {
        let auth = Auth::new(&store, &config)?;
        let relay = Arc::new(Relay::new(config.relay.clone()));
        Ok(AppState { store, auth: Arc::new(auth), config: Arc::new(config), limits: Arc::default(), relay })
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
    let features: &[&str] = if state.relay.enabled() { &["relay"] } else { &[] };
    let (version, base_path) = (env!("CARGO_PKG_VERSION"), &state.config.base_path);
    Json(json!({ "ok": true, "version": version, "basePath": base_path, "features": features })).into_response()
}

/// The whole application with every route under the configured base path.
pub fn router(state: AppState) -> Router {
    let require_login = middleware::from_fn_with_state(state.clone(), auth::require);
    let login = |routes: Router<AppState>| routes.route_layer(require_login.clone());
    // Browser sessions sit under `auth/` because `sessions` is the pi session list.
    let protected = read::routes()
        .route("/logout", post(auth::logout))
        .route("/auth/sessions", get(auth::sessions))
        .route("/auth/sessions/revoke-all", post(auth::revoke_all))
        .route("/auth/sessions/{id}", delete(auth::delete_session))
        .route("/devices", get(devices::list))
        .route("/devices/{name}", delete(devices::revoke))
        .route("/pairings", get(devices::pairings))
        .route("/pairings/{code}/approve", post(devices::approve))
        .route("/pairings/{code}/deny", post(devices::deny));
    let v1 = Router::new()
        .route("/login", post(auth::login))
        .route("/me", get(auth::me))
        .merge(login(protected))
        .merge(relay::browser_routes(&state, login));
    let inner = Router::new()
        .route("/api/health", get(health))
        .route("/api/ingest/v1/batch", post(ingest::batch))
        .route("/api/pair/v1/start", post(devices::start))
        .route("/api/pair/v1/poll", post(devices::poll))
        .merge(relay::device_routes(&state))
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
        "pika {} listening on http://{}{} (data {}, auth {}{})",
        env!("CARGO_PKG_VERSION"),
        listener.local_addr()?,
        config.base_path,
        config.data_dir.display(),
        state.auth.mode().as_str(),
        if config.trust_proxy { ", trusting X-Forwarded-For" } else { "" },
    );
    let relay = state.relay.clone();
    let app = router(state).into_make_service_with_connect_info::<SocketAddr>();
    let shutdown = {
        let relay = relay.clone();
        async move {
            shutdown_signal().await;
            relay.close_all(crate::relay::close::GOING_AWAY, "server stopping");
        }
    };
    axum::serve(listener, app).with_graceful_shutdown(shutdown).await?;
    // Upgraded relay connections outlive the HTTP server; let them finish their close handshakes.
    if !relay.drained(std::time::Duration::from_secs(3)).await {
        tracing::warn!("relay: stopping with connections still closing");
    }
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
