//! The owner's state-changing session routes under the authenticated `/api/v1/`: deleting sessions and projects
//! (`crate::delete`) and hiding sessions from the public view (`crate::hidden`). None exists under `/api/public/`.

use axum::extract::rejection::JsonRejection;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::Value;

use super::{AppState, blocking, error, internal_error};
use crate::delete::{self, Deleted};
use crate::util::{now_ms, valid_project};

fn deleted(result: anyhow::Result<Option<Deleted>>) -> Response {
    match result {
        Ok(Some(deleted)) => Json(deleted).into_response(),
        Ok(None) => error(StatusCode::NOT_FOUND, "not_found"),
        Err(e) => internal_error(format!("{e:#}")),
    }
}

/// `DELETE sessions/:id` deletes the session and its recorded descendants.
pub async fn delete_session(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    let store = state.store.clone();
    deleted(blocking(move || delete::delete_session(&store, &id)).await)
}

/// `GET sessions/:id/deletion` counts what `DELETE sessions/:id` would delete.
pub async fn session_deletion(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    let store = state.store.clone();
    deleted(blocking(move || Ok(store.read(|conn| delete::plan_session(conn, &id))?.map(|plan| plan.counts()))).await)
}

/// `DELETE projects/:name` deletes the project's sessions, their descendants, and its Herder runs, and unpublishes it.
pub async fn delete_project(State(state): State<AppState>, Path(name): Path<String>) -> Response {
    if !valid_project(&name) {
        return error(StatusCode::BAD_REQUEST, "invalid_project");
    }
    let store = state.store.clone();
    deleted(blocking(move || delete::delete_project(&store, &name)).await)
}

/// `GET projects/:name/deletion` counts what `DELETE projects/:name` would delete.
pub async fn project_deletion(State(state): State<AppState>, Path(name): Path<String>) -> Response {
    if !valid_project(&name) {
        return error(StatusCode::BAD_REQUEST, "invalid_project");
    }
    let store = state.store.clone();
    deleted(
        blocking(move || {
            store.read(|conn| -> anyhow::Result<Option<Deleted>> {
                let plan = delete::plan_project(conn, &name)?;
                let selected = crate::read::publishing::is_selected(conn, &name).map_err(|e| anyhow::anyhow!("{e}"))?;
                Ok((selected || !plan.sessions.is_empty() || !plan.herder_runs.is_empty()).then(|| plan.counts()))
            })
        })
        .await,
    )
}

/// `PATCH sessions/:id` with `{ hidden: boolean }` hides the session (and so its recorded descendants) from the
/// public view, or shows it again, and returns its `SessionSummary`.
pub async fn update_session(
    State(state): State<AppState>,
    Path(id): Path<String>,
    body: Result<Json<Value>, JsonRejection>,
) -> Response {
    let body = match body {
        Ok(Json(body)) => body,
        Err(rejection @ JsonRejection::MissingJsonContentType(_)) => return rejection.into_response(),
        Err(_) => Value::Null,
    };
    let Some(hidden) = body.get("hidden").and_then(Value::as_bool) else {
        return error(StatusCode::BAD_REQUEST, "invalid_body");
    };
    let store = state.store.clone();
    let result = blocking(move || {
        let found = store.write(|tx| crate::hidden::set(tx, &id, hidden, now_ms()))?;
        if !found {
            return Ok(None);
        }
        // A concurrent deletion may have removed it since.
        store.read(|conn| -> anyhow::Result<_> {
            let tx = conn.unchecked_transaction()?;
            let mut summary = match crate::read::sessions::detail(&tx, &id) {
                Ok(detail) => detail.summary,
                Err(crate::read::ReadError::NotFound) => return Ok(None),
                Err(e) => anyhow::bail!("{e}"),
            };
            crate::hidden::Marks::load(&tx)?.mark(&tx, &mut summary)?;
            Ok(Some(summary))
        })
    })
    .await;
    match result {
        Ok(Some(summary)) => Json(summary).into_response(),
        Ok(None) => error(StatusCode::NOT_FOUND, "not_found"),
        Err(e) => internal_error(format!("{e:#}")),
    }
}
