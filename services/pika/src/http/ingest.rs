use std::io::Read;

use axum::Json;
use axum::body::Body;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde_json::json;

use super::{AppState, blocking, error, internal_error};
use crate::ingest::{self, Batch, IngestError};
use crate::util::{cut_chars, now_ms};

enum Rejection {
    TooLarge,
    Bad(String),
    Ingest(IngestError),
}

pub(super) fn bearer(headers: &HeaderMap) -> Option<&str> {
    let value = headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    let (scheme, token) = value.split_once(' ')?;
    scheme.eq_ignore_ascii_case("bearer").then(|| token.trim()).filter(|t| !t.is_empty())
}

fn decode(bytes: &[u8], gzip: bool, max: usize) -> Result<Batch, Rejection> {
    let owned;
    let json = if gzip {
        let mut out = Vec::new();
        flate2::read::MultiGzDecoder::new(bytes)
            .take(max as u64 + 1)
            .read_to_end(&mut out)
            .map_err(|e| Rejection::Bad(format!("invalid gzip body: {e}")))?;
        if out.len() > max {
            return Err(Rejection::TooLarge);
        }
        owned = out;
        &owned[..]
    } else {
        bytes
    };
    serde_json::from_slice(json).map_err(|e| Rejection::Bad(format!("invalid batch: {e}")))
}

pub async fn batch(State(state): State<AppState>, headers: HeaderMap, body: Body) -> Response {
    let Some(token) = bearer(&headers).map(str::to_owned) else {
        return error(StatusCode::UNAUTHORIZED, "unauthorized");
    };
    let store = state.store.clone();
    let (device, last_seen_at) = match blocking(move || crate::auth::device_for_token(&store, &token)).await {
        Ok(Some(found)) => found,
        Ok(None) => return error(StatusCode::UNAUTHORIZED, "unauthorized"),
        Err(e) => return internal_error(e),
    };
    let max = state.config.max_body;
    let declared = headers
        .get(header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok());
    if declared.is_some_and(|n| n > max as u64) {
        return error(StatusCode::PAYLOAD_TOO_LARGE, "too_large");
    }
    let Ok(bytes) = axum::body::to_bytes(body, max).await else {
        return error(StatusCode::PAYLOAD_TOO_LARGE, "too_large");
    };
    let gzip = headers
        .get(header::CONTENT_ENCODING)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.trim().eq_ignore_ascii_case("gzip"));
    let store = state.store.clone();
    let result = tokio::task::spawn_blocking(move || {
        let batch = decode(&bytes, gzip, max)?;
        let now = now_ms();
        if crate::auth::touch_due(last_seen_at, now) {
            let host = batch.client.as_ref().and_then(|c| c.get("host")).and_then(|h| h.as_str()).map(|h| cut_chars(h, 255));
            crate::auth::touch_device(&store, &device, host.filter(|h| !h.is_empty()), now)
                .map_err(|e| Rejection::Ingest(IngestError::Internal(e)))?;
        }
        ingest::apply(&store, &device, &batch).map_err(Rejection::Ingest)
    })
    .await;
    match result {
        Ok(Ok(response)) => Json(response).into_response(),
        Ok(Err(Rejection::TooLarge)) => error(StatusCode::PAYLOAD_TOO_LARGE, "too_large"),
        Ok(Err(Rejection::Bad(message) | Rejection::Ingest(IngestError::BadRequest(message)))) => {
            (StatusCode::BAD_REQUEST, Json(json!({ "error": "bad_request", "message": message }))).into_response()
        }
        Ok(Err(Rejection::Ingest(IngestError::Conflict { key, length }))) => {
            (StatusCode::CONFLICT, Json(json!({ "error": "conflict", "key": key, "length": length }))).into_response()
        }
        Ok(Err(Rejection::Ingest(IngestError::Gap { key, length }))) => {
            (StatusCode::CONFLICT, Json(json!({ "error": "gap", "key": key, "length": length }))).into_response()
        }
        Ok(Err(Rejection::Ingest(IngestError::Internal(e)))) => internal_error(format!("{e:#}")),
        Err(e) => internal_error(e),
    }
}
