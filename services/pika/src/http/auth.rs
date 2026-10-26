use std::convert::Infallible;
use std::net::{IpAddr, SocketAddr};
use std::time::{Duration, Instant};

use axum::extract::{ConnectInfo, FromRequestParts, Path, Request, State};
use axum::http::request::Parts;
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use serde::Deserialize;
use serde_json::{Map, Value, json};

use super::{AppState, blocking, error, internal_error};
use crate::auth::{self, SESSION_COOKIE, SESSION_MAX_AGE_SECS};
use crate::config::CookieSecure;
use crate::ratelimit::{client_key, retry_secs};
use crate::util::{cut_chars, format_iso_ms};

/// The id hash of the request's session, set by `require` in `password` mode.
#[derive(Clone)]
pub struct CurrentSession(pub String);

/// Where a request came from: the socket peer, or with `--trust-proxy` the proxy's `X-Forwarded-*` headers.
pub struct Client {
    pub ip: Option<IpAddr>,
    pub https: bool,
}

fn last_header_value<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    let value = headers.get_all(name).iter().filter_map(|v| v.to_str().ok()).next_back()?;
    value.rsplit(',').next().map(str::trim)
}

impl Client {
    pub fn new(headers: &HeaderMap, peer: Option<IpAddr>, trust_proxy: bool) -> Client {
        if !trust_proxy {
            return Client { ip: peer, https: false };
        }
        let forwarded = last_header_value(headers, "x-forwarded-for").and_then(|v| v.parse::<IpAddr>().ok());
        let https = last_header_value(headers, "x-forwarded-proto").is_some_and(|v| v.eq_ignore_ascii_case("https"));
        Client { ip: forwarded.or(peer), https }
    }

    /// The key the rate limits count under.
    pub fn key(&self) -> String {
        client_key(self.ip)
    }
}

impl FromRequestParts<AppState> for Client {
    type Rejection = Infallible;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Client, Infallible> {
        let peer = parts.extensions.get::<ConnectInfo<SocketAddr>>().map(|c| c.0.ip());
        Ok(Client::new(&parts.headers, peer, state.config.trust_proxy))
    }
}

/// 429 `{ error: "too_many_attempts", retryAfter }` with a `Retry-After` header.
pub fn too_many_attempts(wait: Duration) -> Response {
    let secs = retry_secs(wait);
    let mut response =
        (StatusCode::TOO_MANY_REQUESTS, Json(json!({ "error": "too_many_attempts", "retryAfter": secs }))).into_response();
    response.headers_mut().insert(header::RETRY_AFTER, HeaderValue::from(secs));
    response
}

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

/// The session cookie, or with `max_age` 0 the header that clears it.
fn set_cookie(state: &AppState, client: &Client, value: &str, max_age: i64) -> HeaderValue {
    let base = &state.config.base_path;
    let path = if base == "/" { "/".to_owned() } else { format!("{base}/") };
    let secure = match state.config.cookie_secure {
        CookieSecure::Always => true,
        CookieSecure::Never => false,
        CookieSecure::Auto => client.https,
    };
    let secure = if secure { "; Secure" } else { "" };
    HeaderValue::from_str(&format!("{SESSION_COOKIE}={value}; Path={path}; Max-Age={max_age}; HttpOnly; SameSite=Lax{secure}"))
        .expect("cookie header is ASCII")
}

fn with_cleared_cookie(mut response: Response, state: &AppState, client: &Client) -> Response {
    response.headers_mut().insert(header::SET_COOKIE, set_cookie(state, client, "", 0));
    response
}

/// The live session a request's cookie names.
async fn session(state: &AppState, headers: &HeaderMap) -> anyhow::Result<Option<String>> {
    let Some(value) = cookie(headers, SESSION_COOKIE) else { return Ok(None) };
    let store = state.store.clone();
    blocking(move || auth::session_for_cookie(&store, &value)).await
}

/// In `password` mode, requires a live session and records it as `CurrentSession`.
pub async fn require(State(state): State<AppState>, mut request: Request, next: Next) -> Response {
    if !state.auth.password_required() {
        return next.run(request).await;
    }
    match session(&state, request.headers()).await {
        Ok(Some(id_hash)) => {
            request.extensions_mut().insert(CurrentSession(id_hash));
            next.run(request).await
        }
        Ok(None) => error(StatusCode::UNAUTHORIZED, "unauthorized"),
        Err(e) => internal_error(e),
    }
}

#[derive(Deserialize)]
pub struct Login {
    #[serde(default)]
    password: String,
}

pub async fn login(State(state): State<AppState>, client: Client, headers: HeaderMap, Json(body): Json<Login>) -> Response {
    if !state.auth.password_required() {
        return Json(json!({ "authenticated": true })).into_response();
    }
    let key = client.key();
    // A client over its limit is refused before it waits for a password check.
    if let Some(wait) = state.limits.login().retry_after(&key, Instant::now()) {
        return too_many_attempts(wait);
    }
    let Some(permit) = state.limits.password_check().await else {
        return too_many_attempts(Duration::from_secs(1));
    };
    // The attempt counts as failed before the check, so cancelling the request cannot skip the count.
    let at = Instant::now();
    if let Err(wait) = state.limits.login().attempt(&key, at) {
        return too_many_attempts(wait);
    }
    let (store, auth) = (state.store.clone(), state.auth.clone());
    let checked = blocking(move || {
        let _permit = permit;
        auth.check_password(&store, &body.password)
    })
    .await;
    match checked {
        Ok(true) => state.limits.login().succeeded(&key, at),
        Ok(false) => return error(StatusCode::UNAUTHORIZED, "invalid_password"),
        Err(e) => return internal_error(e),
    }
    let user_agent = headers.get(header::USER_AGENT).and_then(|v| v.to_str().ok()).map(|v| cut_chars(v, 255).to_owned());
    let ip = client.ip.map(|ip| ip.to_canonical().to_string());
    let store = state.store.clone();
    let value = match blocking(move || auth::create_session(&store, user_agent.as_deref(), ip.as_deref())).await {
        Ok(value) => value,
        Err(e) => return internal_error(e),
    };
    let mut response = Json(json!({ "authenticated": true })).into_response();
    response.headers_mut().insert(header::SET_COOKIE, set_cookie(&state, &client, &value, SESSION_MAX_AGE_SECS));
    response
}

pub async fn logout(
    State(state): State<AppState>,
    client: Client,
    current: Option<Extension<CurrentSession>>,
    Json(_): Json<Value>,
) -> Response {
    if let Some(Extension(CurrentSession(id_hash))) = current {
        let store = state.store.clone();
        if let Err(e) = blocking(move || auth::delete_session(&store, &id_hash)).await {
            return internal_error(e);
        }
    }
    let response = Json(json!({ "authenticated": !state.auth.password_required() })).into_response();
    with_cleared_cookie(response, &state, &client)
}

pub async fn me(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let authenticated = if state.auth.password_required() {
        match session(&state, &headers).await {
            Ok(session) => session.is_some(),
            Err(e) => return internal_error(e),
        }
    } else {
        true
    };
    Json(json!({
        "authenticated": authenticated,
        "passwordRequired": state.auth.password_required(),
        "authMode": state.auth.mode().as_str(),
    }))
    .into_response()
}

pub async fn sessions(State(state): State<AppState>, current: Option<Extension<CurrentSession>>) -> Response {
    let store = state.store.clone();
    let sessions = match blocking(move || auth::list_sessions(&store)).await {
        Ok(sessions) => sessions,
        Err(e) => return internal_error(e),
    };
    let current = current.map(|Extension(CurrentSession(id_hash))| id_hash);
    let items: Vec<Value> = sessions
        .iter()
        .map(|s| {
            let mut item = Map::new();
            item.insert("id".into(), s.id().into());
            item.insert("createdAt".into(), format_iso_ms(s.created_at).into());
            item.insert("lastSeenAt".into(), format_iso_ms(s.last_seen_at).into());
            item.insert("expiresAt".into(), format_iso_ms(s.expires_at).into());
            if let Some(user_agent) = &s.user_agent {
                item.insert("userAgent".into(), user_agent.as_str().into());
            }
            if let Some(ip) = &s.ip {
                item.insert("ip".into(), ip.as_str().into());
            }
            item.insert("current".into(), (current.as_deref() == Some(s.id_hash.as_str())).into());
            Value::Object(item)
        })
        .collect();
    Json(json!({ "items": items })).into_response()
}

pub async fn delete_session(
    State(state): State<AppState>,
    client: Client,
    current: Option<Extension<CurrentSession>>,
    Path(id): Path<String>,
) -> Response {
    let store = state.store.clone();
    let deleted = match blocking(move || auth::delete_session_by_id(&store, &id)).await {
        Ok(deleted) => deleted,
        Err(e) => return internal_error(e),
    };
    if deleted.is_empty() {
        return error(StatusCode::NOT_FOUND, "not_found");
    }
    let response = StatusCode::NO_CONTENT.into_response();
    match current {
        Some(Extension(CurrentSession(id_hash))) if deleted.contains(&id_hash) => {
            with_cleared_cookie(response, &state, &client)
        }
        _ => response,
    }
}

pub async fn revoke_all(State(state): State<AppState>, client: Client, Json(_): Json<Value>) -> Response {
    let store = state.store.clone();
    match blocking(move || auth::revoke_all_sessions(&store)).await {
        Ok(_) => with_cleared_cookie(Json(json!({})).into_response(), &state, &client),
        Err(e) => internal_error(e),
    }
}
