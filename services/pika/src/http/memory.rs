//! Agent memory routes (`crate::memory`): reading and writing notes under `{base}/api/agent/v1/` with a device token
//! that has read access, dream leases and commits (`crate::memory::dream`) beside them, and the owner's read-only view
//! under the authenticated `{base}/api/v1/`.

use std::collections::BTreeMap;

use axum::extract::rejection::JsonRejection;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

use super::ingest::bearer;
use super::{AppState, blocking, error, internal_error};
use crate::memory::dream::{self, DreamError};
use crate::memory::{self, LIMIT_BYTES, LIMIT_LINES, MemoryError};
use crate::util::{format_iso_ms, now_ms};

/// Behind `read::require_read_access` in the agent namespace.
pub(super) fn agent_routes() -> Router<AppState> {
    Router::new()
        .route("/memory", get(view))
        .route("/memory/notes", post(save))
        .route("/memory/notes/{id}/forget", post(forget))
        .route("/memory/dream/lease", post(dream_lease))
        .route("/memory/dream/{id}/renew", post(dream_renew))
        .route("/memory/dream/{id}/commit", post(dream_commit))
        .route("/memory/dream/{id}/release", post(dream_release))
}

/// Behind owner login under `/api/v1/`.
pub(super) fn owner_routes() -> Router<AppState> {
    Router::new()
        .route("/memory", get(scopes))
        .route("/memory/notes", get(scope_notes))
        .route("/memory/notes/{id}/revisions", get(revisions))
}

fn bad_request(message: impl std::fmt::Display) -> Response {
    (StatusCode::BAD_REQUEST, Json(json!({ "error": "bad_request", "message": message.to_string() }))).into_response()
}

fn memory_full(bytes: usize, lines: usize) -> Response {
    (
        StatusCode::UNPROCESSABLE_ENTITY,
        Json(json!({ "error": "memory_full", "indexBytes": bytes, "indexLines": lines,
                     "limitBytes": LIMIT_BYTES, "limitLines": LIMIT_LINES })),
    )
        .into_response()
}

fn conflict(body: Value) -> Response {
    (StatusCode::CONFLICT, Json(body)).into_response()
}

fn respond<T: Serialize>(result: anyhow::Result<Result<T, MemoryError>>) -> Response {
    match result {
        Ok(Ok(value)) => Json(value).into_response(),
        Ok(Err(MemoryError::BadRequest(message))) => bad_request(message),
        Ok(Err(MemoryError::NotFound)) => error(StatusCode::NOT_FOUND, "not_found"),
        Ok(Err(MemoryError::Conflict(note))) => conflict(json!({ "error": "revision_conflict", "note": note })),
        Ok(Err(MemoryError::Full { bytes, lines })) => memory_full(bytes, lines),
        Ok(Err(MemoryError::Internal(e))) => internal_error(format!("{e:#}")),
        Err(e) => internal_error(format!("{e:#}")),
    }
}

fn respond_dream<T: Serialize>(result: anyhow::Result<Result<T, DreamError>>) -> Response {
    match result {
        Ok(Ok(value)) => Json(value).into_response(),
        Ok(Err(DreamError::BadRequest(message))) => bad_request(message),
        Ok(Err(DreamError::Busy { expires_at })) => {
            conflict(json!({ "error": "dream_busy", "expiresAt": format_iso_ms(expires_at) }))
        }
        Ok(Err(DreamError::NotDue { reason, retry_at })) => {
            conflict(json!({ "error": "dream_not_due", "reason": reason, "retryAt": retry_at.map(format_iso_ms) }))
        }
        Ok(Err(DreamError::LeaseLost)) => conflict(json!({ "error": "lease_lost" })),
        Ok(Err(DreamError::Conflict { note, change })) => {
            conflict(json!({ "error": "revision_conflict", "note": note, "change": change }))
        }
        Ok(Err(DreamError::Full { bytes, lines })) => memory_full(bytes, lines),
        Ok(Err(DreamError::Internal(e))) => internal_error(format!("{e:#}")),
        Err(e) => internal_error(format!("{e:#}")),
    }
}

/// The id of the device whose token the request carries. The route layer already checked the token, but it may have
/// been revoked since.
async fn device(state: &AppState, headers: &HeaderMap) -> Result<String, Box<Response>> {
    let Some(token) = bearer(headers).map(str::to_owned) else {
        return Err(Box::new(error(StatusCode::UNAUTHORIZED, "unauthorized")));
    };
    let store = state.store.clone();
    match blocking(move || crate::auth::device_for_token(&store, &token)).await {
        Ok(Some((device, _))) => Ok(device),
        Ok(None) => Err(Box::new(error(StatusCode::UNAUTHORIZED, "unauthorized"))),
        Err(e) => Err(Box::new(internal_error(e))),
    }
}

/// A JSON body of shape `T`; anything else is a 400 `bad_request`.
fn parse<T: DeserializeOwned>(body: Result<Json<Value>, JsonRejection>) -> Result<T, Box<Response>> {
    let Json(value) = body.map_err(|e| Box::new(bad_request(e.body_text())))?;
    serde_json::from_value(value).map_err(|e| Box::new(bad_request(format!("invalid body: {e}"))))
}

/// `GET memory?project=&repository=` → the user scope and the project scope the parameters name, their live notes,
/// and their index.
async fn view(State(state): State<AppState>, headers: HeaderMap, Query(params): Query<BTreeMap<String, String>>) -> Response {
    let device = match device(&state, &headers).await {
        Ok(device) => device,
        Err(response) => return *response,
    };
    let store = state.store.clone();
    respond(
        blocking(move || {
            let (project, repository) = (params.get("project").map(String::as_str), params.get("repository").map(String::as_str));
            Ok(store.read(|conn| memory::view(conn, &device, project, repository)))
        })
        .await,
    )
}

/// `POST memory/notes` creates or updates a note.
async fn save(State(state): State<AppState>, headers: HeaderMap, body: Result<Json<Value>, JsonRejection>) -> Response {
    let device = match device(&state, &headers).await {
        Ok(device) => device,
        Err(response) => return *response,
    };
    let request: memory::Save = match parse(body) {
        Ok(request) => request,
        Err(response) => return *response,
    };
    let store = state.store.clone();
    respond(blocking(move || Ok(store.write(|tx| memory::save(tx, &device, request)))).await)
}

/// `POST memory/notes/:id/forget` forgets a note.
async fn forget(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    body: Result<Json<Value>, JsonRejection>,
) -> Response {
    let device = match device(&state, &headers).await {
        Ok(device) => device,
        Err(response) => return *response,
    };
    let request: memory::Forget = match parse(body) {
        Ok(request) => request,
        Err(response) => return *response,
    };
    let store = state.store.clone();
    respond(blocking(move || Ok(store.write(|tx| memory::forget(tx, &device, &id, request)))).await)
}

/// `POST memory/dream/lease` grants a dream lease on the project scope the body names.
async fn dream_lease(State(state): State<AppState>, headers: HeaderMap, body: Result<Json<Value>, JsonRejection>) -> Response {
    let device = match device(&state, &headers).await {
        Ok(device) => device,
        Err(response) => return *response,
    };
    let request: dream::LeaseRequest = match parse(body) {
        Ok(request) => request,
        Err(response) => return *response,
    };
    let store = state.store.clone();
    respond_dream(blocking(move || Ok(store.write(|tx| dream::lease(tx, &device, request, now_ms())))).await)
}

/// `POST memory/dream/:id/renew` extends a live lease; its body is ignored.
async fn dream_renew(State(state): State<AppState>, headers: HeaderMap, Path(id): Path<String>) -> Response {
    let device = match device(&state, &headers).await {
        Ok(device) => device,
        Err(response) => return *response,
    };
    let store = state.store.clone();
    respond_dream(
        blocking(move || Ok(store.write(|tx| dream::renew(tx, &device, &id, now_ms())).map(|lease| json!({ "lease": lease }))))
            .await,
    )
}

/// `POST memory/dream/:id/commit` applies a dream's changes and advances its sessions' checkpoints.
async fn dream_commit(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    body: Result<Json<Value>, JsonRejection>,
) -> Response {
    let device = match device(&state, &headers).await {
        Ok(device) => device,
        Err(response) => return *response,
    };
    let request: dream::Commit = match parse(body) {
        Ok(request) => request,
        Err(response) => return *response,
    };
    let store = state.store.clone();
    respond_dream(blocking(move || Ok(store.write(|tx| dream::commit(tx, &device, &id, request, now_ms())))).await)
}

/// `POST memory/dream/:id/release` ends a lease with an outcome.
async fn dream_release(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    body: Result<Json<Value>, JsonRejection>,
) -> Response {
    let device = match device(&state, &headers).await {
        Ok(device) => device,
        Err(response) => return *response,
    };
    let request: dream::Release = match parse(body) {
        Ok(request) => request,
        Err(response) => return *response,
    };
    let store = state.store.clone();
    respond_dream(
        blocking(move || {
            Ok(store.write(|tx| dream::release(tx, &device, &id, request, now_ms())).map(|lease| json!({ "lease": lease })))
        })
        .await,
    )
}

/// `GET memory` → every stored scope with its live note count.
async fn scopes(State(state): State<AppState>) -> Response {
    let store = state.store.clone();
    respond(blocking(move || Ok(Ok(json!({ "scopes": store.read(memory::scopes)? })))).await)
}

/// `GET memory/notes?scope=<key>` → the scope's live notes in index order.
async fn scope_notes(State(state): State<AppState>, Query(params): Query<BTreeMap<String, String>>) -> Response {
    let Some(key) = params.get("scope").cloned() else {
        return bad_request("scope is required");
    };
    let store = state.store.clone();
    respond(
        blocking(move || {
            Ok(store.read(|conn| memory::scope_notes(conn, &key))?.map(|notes| json!({ "notes": notes })).ok_or(MemoryError::NotFound))
        })
        .await,
    )
}

/// `GET memory/notes/:id/revisions` → the note's revisions, oldest first.
async fn revisions(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    let store = state.store.clone();
    respond(
        blocking(move || {
            Ok(store
                .read(|conn| memory::revisions(conn, &id))?
                .map(|revisions| json!({ "revisions": revisions }))
                .ok_or(MemoryError::NotFound))
        })
        .await,
    )
}
