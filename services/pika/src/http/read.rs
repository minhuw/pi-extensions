//! Read API routes under `{base}/api/v1/`. Every route here sits behind the login check.

use axum::Router;
use axum::body::{Body, Bytes};
use axum::extract::{Path, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::get;

use super::{AppState, blocking, error, internal_error};
use crate::export;

pub fn routes() -> Router<AppState> {
    Router::new().route("/sessions/{id}/export", get(export_session))
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
