use axum::Json;
use axum::extract::{Request, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use serde_json::json;

use super::{AppState, error};
use crate::auth::{COOKIE_MAX_AGE_SECS, COOKIE_NAME};

fn cookie(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';'))
        .filter_map(|pair| pair.trim().split_once('='))
        .find(|(k, _)| *k == name)
        .map(|(_, v)| v.to_owned())
}

fn authenticated(state: &AppState, headers: &HeaderMap) -> bool {
    !state.auth.password_required() || cookie(headers, COOKIE_NAME).is_some_and(|v| state.auth.verify(&v))
}

fn set_cookie(state: &AppState, value: &str, max_age: i64) -> HeaderValue {
    let path = &state.config.base_path;
    HeaderValue::from_str(&format!("{COOKIE_NAME}={value}; Path={path}; Max-Age={max_age}; HttpOnly; SameSite=Lax"))
        .expect("cookie header is ASCII")
}

/// Requires the login cookie when a password is configured.
pub async fn require(State(state): State<AppState>, request: Request, next: Next) -> Response {
    if authenticated(&state, request.headers()) {
        next.run(request).await
    } else {
        error(StatusCode::UNAUTHORIZED, "unauthorized")
    }
}

#[derive(Deserialize)]
pub struct Login {
    #[serde(default)]
    password: String,
}

pub async fn login(State(state): State<AppState>, Json(body): Json<Login>) -> Response {
    if !state.auth.password_required() {
        return Json(json!({ "authenticated": true })).into_response();
    }
    if !state.auth.check_password(&body.password) {
        return error(StatusCode::UNAUTHORIZED, "invalid_password");
    }
    let mut response = Json(json!({ "authenticated": true })).into_response();
    response.headers_mut().insert(header::SET_COOKIE, set_cookie(&state, &state.auth.issue(), COOKIE_MAX_AGE_SECS));
    response
}

pub async fn logout(State(state): State<AppState>) -> Response {
    let mut response = Json(json!({ "authenticated": !state.auth.password_required() })).into_response();
    response.headers_mut().insert(header::SET_COOKIE, set_cookie(&state, "", 0));
    response
}

pub async fn me(State(state): State<AppState>, headers: HeaderMap) -> Response {
    Json(json!({
        "authenticated": authenticated(&state, &headers),
        "passwordRequired": state.auth.password_required(),
    }))
    .into_response()
}
