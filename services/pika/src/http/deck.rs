//! Deck's owner routes under `{base}/api/v1/deck/` (`crate::deck`): project keys for checkouts, and the owner's name and
//! collapsed state per key. Behind the nodes switch, then owner login; a device token or node credential counts for
//! nothing.

use axum::extract::rejection::{JsonRejection, PathRejection};
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::middleware;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch, post};
use axum::{Json, Router};
use serde_json::{Value, json};

use super::nodes::require_enabled;
use super::{AppState, blocking, error, internal_error};
use crate::deck::{self, MAX_KEY_ITEMS, Update};
use crate::util::{now_ms, valid_project};

fn invalid() -> Response {
    error(StatusCode::BAD_REQUEST, "invalid")
}

/// The JSON body; a form post keeps the extractor's 415, and anything else that is not JSON is 400 `invalid`.
fn body(body: Result<Json<Value>, JsonRejection>) -> Result<Value, Response> {
    match body {
        Ok(Json(body)) => Ok(body),
        Err(rejection @ JsonRejection::MissingJsonContentType(_)) => Err(rejection.into_response()),
        Err(_) => Err(invalid()),
    }
}

/// An optional string field: absent and `null` are none; another type is `Err`.
fn optional_str<'a>(item: &'a serde_json::Map<String, Value>, field: &str) -> Result<Option<&'a str>, ()> {
    match item.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => Ok(Some(s)),
        Some(_) => Err(()),
    }
}

/// The path's key, percent-decoded, when it is one `project-keys` could answer.
fn checked(key: Result<Path<String>, PathRejection>) -> Option<String> {
    key.ok().map(|Path(key)| key).filter(|key| deck::valid_key(key))
}

/// `POST deck/project-keys` → one key, or null, per item, in order. Stores nothing.
async fn project_keys(raw: Result<Json<Value>, JsonRejection>) -> Response {
    let body = match body(raw) {
        Ok(body) => body,
        Err(response) => return response,
    };
    let Some(items) = body.get("items").and_then(Value::as_array) else { return invalid() };
    if items.is_empty() || items.len() > MAX_KEY_ITEMS {
        return invalid();
    }
    let mut keys = Vec::with_capacity(items.len());
    for item in items {
        let Some(item) = item.as_object() else { return invalid() };
        // A field of the wrong type names nothing the key could come from, so its entry is null.
        let key = match (optional_str(item, "repository"), optional_str(item, "project"), optional_str(item, "node")) {
            (Ok(repository), Ok(project), Ok(Some(node))) => deck::project_key(repository, project, node),
            _ => None,
        };
        keys.push(key);
    }
    Json(json!({ "keys": keys })).into_response()
}

/// `GET deck/projects` → every stored row, by key.
async fn projects(State(state): State<AppState>) -> Response {
    let store = state.store.clone();
    match blocking(move || Ok(store.read(deck::list)?)).await {
        Ok(projects) => Json(json!({ "projects": projects })).into_response(),
        Err(e) => internal_error(e),
    }
}

/// `PATCH deck/projects/:key` with `{ name?, collapsed? }` → the row, created with the defaults first if need be.
async fn update(
    State(state): State<AppState>,
    key: Result<Path<String>, PathRejection>,
    raw: Result<Json<Value>, JsonRejection>,
) -> Response {
    let body = match body(raw) {
        Ok(body) => body,
        Err(response) => return response,
    };
    let Some(key) = checked(key) else { return invalid() };
    let Some(body) = body.as_object() else { return invalid() };
    let name = match body.get("name") {
        None => None,
        Some(Value::Null) => Some(None),
        Some(Value::String(name)) if valid_project(name) => Some(Some(name.clone())),
        Some(_) => return invalid(),
    };
    let collapsed = match body.get("collapsed") {
        None => None,
        Some(Value::Bool(collapsed)) => Some(*collapsed),
        Some(_) => return invalid(),
    };
    let store = state.store.clone();
    let update = Update { name, collapsed };
    match blocking(move || Ok(store.write(|tx| deck::update(tx, &key, &update, now_ms()))?)).await {
        Ok(row) => Json(row).into_response(),
        Err(e) => internal_error(e),
    }
}

/// `DELETE deck/projects/:key` → `{ deleted }`, false for a key without a row.
async fn remove(State(state): State<AppState>, key: Result<Path<String>, PathRejection>) -> Response {
    let Some(key) = checked(key) else { return invalid() };
    let store = state.store.clone();
    match blocking(move || Ok(store.write(|tx| deck::delete(tx, &key))?)).await {
        Ok(deleted) => Json(json!({ "deleted": deleted })).into_response(),
        Err(e) => internal_error(e),
    }
}

/// The routes under `{base}/api/v1/`, behind `login` and, before it, the nodes switch.
pub fn routes(state: &AppState, login: impl Fn(Router<AppState>) -> Router<AppState>) -> Router<AppState> {
    let routes = Router::new()
        .route("/deck/project-keys", post(project_keys))
        .route("/deck/projects", get(projects))
        .route("/deck/projects/{key}", patch(update).delete(remove));
    login(routes).route_layer(middleware::from_fn_with_state(state.clone(), require_enabled))
}
