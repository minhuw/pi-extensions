//! Read API routes under `{base}/api/v1/`. Every route here sits behind the login check.

use std::collections::BTreeMap;

use axum::body::{Body, Bytes};
use axum::extract::{Path, Query, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde::Serialize;
use serde_json::json;

use super::{AppState, blocking, error, internal_error};
use crate::export;
use crate::read::{self, Params, ReadError, ReadResult};
use crate::store::Store;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/facets", get(facets))
        .route("/sessions", get(sessions))
        .route("/sessions/{id}", get(session))
        .route("/sessions/{id}/turns", get(turns))
        .route("/sessions/{id}/entries", get(entries))
        .route("/sessions/{id}/entries/{seq}/raw", get(raw_entry))
        .route("/sessions/{id}/entries/{seq}/image/{index}", get(image))
        .route("/sessions/{id}/updates", get(updates))
        .route("/sessions/{id}/export", get(export_session))
        .route("/requests/{id}", get(request))
        .route("/herder/runs", get(herder_runs))
        .route("/herder/runs/{id}", get(herder_run))
        .route("/search", get(search))
}

type QueryParams = Query<BTreeMap<String, String>>;

fn read_error(e: ReadError) -> Response {
    match e {
        ReadError::BadRequest(message) => {
            (StatusCode::BAD_REQUEST, Json(json!({ "error": "bad_request", "message": message }))).into_response()
        }
        ReadError::NotFound => error(StatusCode::NOT_FOUND, "not_found"),
        ReadError::Internal(e) => internal_error(format!("{e:#}")),
    }
}

/// Runs `f` on a pooled read connection off the async runtime.
async fn query<T: Send + 'static>(
    state: &AppState,
    f: impl FnOnce(&Store, &rusqlite::Connection) -> ReadResult<T> + Send + 'static,
) -> ReadResult<T> {
    let store = state.store.clone();
    tokio::task::spawn_blocking(move || store.read(|conn| f(&store, conn)))
        .await
        .map_err(|e| ReadError::Internal(e.into()))?
}

async fn json<T: Serialize + Send + 'static>(
    state: &AppState,
    f: impl FnOnce(&Store, &rusqlite::Connection) -> ReadResult<T> + Send + 'static,
) -> Response {
    match query(state, f).await {
        Ok(value) => Json(value).into_response(),
        Err(e) => read_error(e),
    }
}

fn seq_param(raw: &str) -> ReadResult<i64> {
    raw.parse().map_err(|_| read::bad("seq must be an integer"))
}

async fn facets(State(state): State<AppState>) -> Response {
    json(&state, |_, conn| read::sessions::facets(conn)).await
}

async fn sessions(State(state): State<AppState>, Query(params): QueryParams) -> Response {
    json(&state, move |_, conn| read::sessions::list(conn, &Params(params))).await
}

async fn session(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    json(&state, move |_, conn| read::sessions::detail(conn, &id)).await
}

async fn turns(State(state): State<AppState>, Path(id): Path<String>, Query(params): QueryParams) -> Response {
    json(&state, move |_, conn| read::sessions::turns(conn, &id, &Params(params))).await
}

async fn updates(State(state): State<AppState>, Path(id): Path<String>, Query(params): QueryParams) -> Response {
    json(&state, move |_, conn| read::sessions::updates(conn, &id, &Params(params))).await
}

async fn entries(State(state): State<AppState>, Path(id): Path<String>, Query(params): QueryParams) -> Response {
    let prefix = state.config.prefix().to_owned();
    json(&state, move |store, conn| read::entries::list(conn, &store.blobs, &prefix, &id, &Params(params))).await
}

async fn raw_entry(State(state): State<AppState>, Path((id, seq)): Path<(String, String)>) -> Response {
    let seq = match seq_param(&seq) {
        Ok(seq) => seq,
        Err(e) => return read_error(e),
    };
    match query(&state, move |store, conn| read::entries::raw(conn, &store.blobs, &id, seq)).await {
        Ok(line) => (
            [(header::CONTENT_TYPE, "application/json; charset=utf-8"), (header::X_CONTENT_TYPE_OPTIONS, "nosniff")],
            line,
        )
            .into_response(),
        Err(e) => read_error(e),
    }
}

async fn image(State(state): State<AppState>, Path((id, seq, index)): Path<(String, String, String)>) -> Response {
    let seq = match seq_param(&seq) {
        Ok(seq) => seq,
        Err(e) => return read_error(e),
    };
    let Ok(index) = index.parse::<usize>() else { return read_error(read::bad("index must be an integer")) };
    match query(&state, move |store, conn| read::entries::image(conn, &store.blobs, &id, seq, index)).await {
        // Stored lines never change, so neither do their images.
        Ok((content_type, bytes)) => (
            [
                (header::CONTENT_TYPE, content_type),
                (header::CACHE_CONTROL, "private, max-age=31536000, immutable".to_owned()),
                (header::X_CONTENT_TYPE_OPTIONS, "nosniff".to_owned()),
                (header::CONTENT_SECURITY_POLICY, "default-src 'none'; style-src 'unsafe-inline'; sandbox".to_owned()),
            ],
            bytes,
        )
            .into_response(),
        Err(e) => read_error(e),
    }
}

async fn request(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    json(&state, move |store, conn| crate::requests::load(conn, &store.blobs, &id)?.ok_or(ReadError::NotFound)).await
}

async fn herder_runs(State(state): State<AppState>, Query(params): QueryParams) -> Response {
    json(&state, move |_, conn| read::herder::list(conn, &Params(params))).await
}

async fn herder_run(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    json(&state, move |store, conn| read::herder::detail(conn, &store.blobs, &id)).await
}

async fn search(State(state): State<AppState>, Query(params): QueryParams) -> Response {
    json(&state, move |_, conn| read::search::search(conn, &Params(params))).await
}

async fn export_session(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    let store = state.store.clone();
    let lookup = id.clone();
    let stream_id = match blocking(move || Ok(store.read(|conn| export::session_stream(conn, &lookup))?)).await {
        Ok(Some(stream_id)) => stream_id,
        Ok(None) => return error(StatusCode::NOT_FOUND, "not_found"),
        Err(e) => return internal_error(e),
    };
    let (tx, rx) = tokio::sync::mpsc::channel::<Result<Bytes, std::io::Error>>(4);
    let store = state.store.clone();
    tokio::task::spawn_blocking(move || {
        let mut from = 0;
        loop {
            match export::read_chunk(&store, stream_id, from) {
                Ok((bytes, next)) => {
                    if tx.blocking_send(Ok(Bytes::from(bytes))).is_err() {
                        break;
                    }
                    match next {
                        Some(next) => from = next,
                        None => break,
                    }
                }
                Err(e) => {
                    tracing::error!("exporting session {stream_id}: {e:#}");
                    let _ = tx.blocking_send(Err(std::io::Error::other(e.to_string())));
                    break;
                }
            }
        }
    });
    let body = futures_util::stream::unfold(rx, |mut rx| async move { rx.recv().await.map(|item| (item, rx)) });
    let filename: String = id.chars().filter(|c| c.is_ascii_alphanumeric() || "-_.".contains(*c)).collect();
    (
        [
            (header::CONTENT_TYPE, "application/x-ndjson; charset=utf-8".to_owned()),
            (header::CONTENT_DISPOSITION, format!("attachment; filename=\"{filename}.jsonl\"")),
        ],
        Body::from_stream(body),
    )
        .into_response()
}
