//! Devices and pairing: `{base}/api/v1/devices` and `pairings` (behind the login check) and the unauthenticated
//! `{base}/api/pair/v1/start`, `poll`, and `bind` that devices call.

use std::time::Instant;

use axum::Json;
use axum::extract::rejection::JsonRejection;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use serde::{Deserialize, Deserializer};
use serde_json::{Map, Value, json};

use super::auth::{Client, too_many_attempts};
use super::ingest::bearer;
use super::{AppState, blocking, error, internal_error};
use crate::auth::{self, Bind, device_name, key_hash, valid_device_id};
use crate::pairing::{self, Approval, Continues, Poll};
use crate::util::{cut_chars, format_iso_ms, now_ms, sha256_hex};

fn put(item: &mut Map<String, Value>, key: &str, value: &Option<String>) {
    if let Some(value) = value {
        item.insert(key.into(), value.as_str().into());
    }
}

pub async fn list(State(state): State<AppState>) -> Response {
    let store = state.store.clone();
    let devices = match blocking(move || auth::list_devices(&store)).await {
        Ok(devices) => devices,
        Err(e) => return internal_error(e),
    };
    let items: Vec<Value> = devices
        .into_iter()
        .map(|d| {
            let mut item = Map::new();
            item.insert("id".into(), d.id.into());
            item.insert("name".into(), d.name.into());
            item.insert("createdAt".into(), format_iso_ms(d.created_at).into());
            item.insert("createdVia".into(), d.created_via.into());
            put(&mut item, "lastSeenAt", &d.last_seen_at.map(format_iso_ms));
            put(&mut item, "lastHost", &d.last_host);
            item.insert("hasKey".into(), d.has_key.into());
            Value::Object(item)
        })
        .collect();
    Json(json!({ "items": items })).into_response()
}

pub async fn revoke(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    if !valid_device_id(&id) {
        return error(StatusCode::NOT_FOUND, "not_found");
    }
    let store = state.store.clone();
    match blocking(move || auth::revoke_token_hashes(&store, &id)).await {
        Ok(revoked) if revoked.is_empty() => error(StatusCode::NOT_FOUND, "not_found"),
        Ok(revoked) => {
            state.relay.close_tokens(&revoked, crate::relay::close::REVOKED, "token revoked");
            StatusCode::NO_CONTENT.into_response()
        }
        Err(e) => internal_error(e),
    }
}

/// `PATCH devices/:id` with `{ name }` renames a device, with or without a token.
pub async fn rename(
    State(state): State<AppState>,
    Path(id): Path<String>,
    body: Result<Json<Value>, JsonRejection>,
) -> Response {
    let body = match body {
        Ok(Json(body)) => body,
        Err(rejection @ JsonRejection::MissingJsonContentType(_)) => return rejection.into_response(),
        Err(_) => Value::Null,
    };
    let Some(name) = body.get("name").and_then(Value::as_str).and_then(device_name).map(str::to_owned) else {
        return error(StatusCode::BAD_REQUEST, "invalid_name");
    };
    if !valid_device_id(&id) {
        return error(StatusCode::NOT_FOUND, "unknown_device");
    }
    let (store, renamed) = (state.store.clone(), id.clone());
    match blocking(move || auth::rename_device(&store, &renamed, &name)).await {
        Ok(Some(name)) => {
            state.relay.rename(&id, &name);
            Json(json!({ "id": id, "name": name })).into_response()
        }
        Ok(None) => error(StatusCode::NOT_FOUND, "unknown_device"),
        Err(e) => internal_error(e),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Start {
    #[serde(default)]
    device: String,
    host: Option<String>,
    pika_version: Option<String>,
    key: Option<String>,
}

pub async fn start(
    State(state): State<AppState>,
    client: Client,
    headers: HeaderMap,
    body: Result<Json<Start>, JsonRejection>,
) -> Response {
    let Ok(Json(body)) = body else { return error(StatusCode::BAD_REQUEST, "invalid_device") };
    let name = match device_name(&body.device) {
        Some(name) if body.host.as_ref().is_none_or(|h| h.chars().count() <= 255) => name.to_owned(),
        _ => return error(StatusCode::BAD_REQUEST, "invalid_device"),
    };
    let key_hash = match body.key.as_deref().map(key_hash) {
        Some(None) => return error(StatusCode::BAD_REQUEST, "invalid_key"),
        Some(Some(hash)) => Some(hash),
        None => None,
    };
    let token_hash = bearer(&headers).map(|token| sha256_hex(token.as_bytes()));
    let (key, now) = (client.key(), Instant::now());
    if let Some(wait) = state.limits.pair_starts().retry_after(&key, now) {
        return too_many_attempts(wait);
    }
    // A start refused for too many pending pairings does not count against the client.
    let store = state.store.clone();
    match blocking(move || pairing::pending_count(&store, now_ms())).await {
        Ok(pending) if pending >= pairing::MAX_PENDING => return error(StatusCode::TOO_MANY_REQUESTS, "too_many_pairings"),
        Ok(_) => {}
        Err(e) => return internal_error(e),
    }
    if let Err(wait) = state.limits.pair_starts().try_record(&key, now) {
        return too_many_attempts(wait);
    }
    let ip = client.ip.map(|ip| ip.to_canonical().to_string());
    let store = state.store.clone();
    let started = blocking(move || {
        let request = pairing::Request {
            device: &name,
            host: body.host.as_deref().filter(|h| !h.is_empty()),
            ip: ip.as_deref(),
            pika_version: body.pika_version.as_deref().filter(|v| !v.is_empty()).map(|v| cut_chars(v, 64)),
            token_hash,
            key_hash,
        };
        pairing::start(&store, &request, now_ms())
    })
    .await;
    match started {
        Ok(Some(started)) => Json(json!({
            "pairingId": started.pairing_id,
            "code": started.code,
            "expiresAt": format_iso_ms(started.expires_at),
            "expiresIn": pairing::TTL_SECS,
            "interval": pairing::POLL_INTERVAL_SECS,
        }))
        .into_response(),
        Ok(None) => {
            state.limits.pair_starts().forget(&key, now);
            error(StatusCode::TOO_MANY_REQUESTS, "too_many_pairings")
        }
        Err(e) => internal_error(e),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PollBody {
    #[serde(default)]
    pairing_id: String,
}

pub async fn poll(State(state): State<AppState>, body: Result<Json<PollBody>, JsonRejection>) -> Response {
    let Ok(Json(body)) = body else { return error(StatusCode::BAD_REQUEST, "bad_request") };
    let store = state.store.clone();
    match blocking(move || pairing::poll(&store, &body.pairing_id, now_ms())).await {
        Ok(None) => error(StatusCode::NOT_FOUND, "unknown_pairing"),
        Ok(Some(Poll::Pending)) => Json(json!({ "status": "pending" })).into_response(),
        Ok(Some(Poll::Approved { device, name, token, continued, revoked })) => {
            tracing::info!("paired device {device} ({name:?}){}", if continued { ", continuing it" } else { "" });
            // Continuing a device revoked its old token.
            state.relay.close_tokens(&revoked, crate::relay::close::REVOKED, "token revoked");
            state.relay.rename(&device, &name);
            Json(json!({ "status": "approved", "device": device, "name": name, "token": token, "continued": continued }))
                .into_response()
        }
        Ok(Some(Poll::Denied)) => Json(json!({ "status": "denied" })).into_response(),
        Ok(Some(Poll::Expired)) => Json(json!({ "status": "expired" })).into_response(),
        Err(e) => internal_error(e),
    }
}

pub async fn pairings(State(state): State<AppState>) -> Response {
    let store = state.store.clone();
    let pending = match blocking(move || pairing::pending(&store, now_ms())).await {
        Ok(pending) => pending,
        Err(e) => return internal_error(e),
    };
    let items: Vec<Value> = pending
        .into_iter()
        .map(|p| {
            let mut item = Map::new();
            item.insert("code".into(), p.code.into());
            item.insert("name".into(), p.name.into());
            put(&mut item, "host", &p.host);
            put(&mut item, "ip", &p.ip);
            put(&mut item, "pikaVersion", &p.pika_version);
            item.insert("requestedAt".into(), format_iso_ms(p.requested_at).into());
            item.insert("expiresAt".into(), format_iso_ms(p.expires_at).into());
            if let Some(m) = p.matched {
                item.insert("match".into(), json!({ "id": m.id, "name": m.name, "by": m.by, "active": m.active }));
            }
            Value::Object(item)
        })
        .collect();
    Json(json!({ "items": items })).into_response()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApproveBody {
    name: Option<String>,
    /// Omitted: `None`; `null`: `Some(None)`.
    #[serde(default, deserialize_with = "present")]
    continues: Option<Option<String>>,
}

/// Tells a field that is `null` from one that is missing, which `#[serde(default)]` leaves `None`.
fn present<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<Option<String>>, D::Error> {
    Option::<String>::deserialize(deserializer).map(Some)
}

pub async fn approve(State(state): State<AppState>, Path(code): Path<String>, Json(body): Json<ApproveBody>) -> Response {
    let store = state.store.clone();
    let continues = match body.continues {
        None => Continues::Match,
        Some(None) => Continues::New,
        Some(Some(id)) => Continues::Device(id),
    };
    match blocking(move || pairing::approve(&store, &code, body.name.as_deref(), continues, now_ms())).await {
        Ok(Approval::Approved { device, name, continued }) => {
            Json(json!({ "device": device, "name": name, "continued": continued })).into_response()
        }
        Ok(Approval::NotFound) => error(StatusCode::NOT_FOUND, "unknown_pairing"),
        Ok(Approval::UnknownDevice) => error(StatusCode::NOT_FOUND, "unknown_device"),
        Ok(Approval::InvalidName) => error(StatusCode::BAD_REQUEST, "invalid_name"),
        Err(e) => internal_error(e),
    }
}

pub async fn deny(State(state): State<AppState>, Path(code): Path<String>, Json(_): Json<Value>) -> Response {
    let store = state.store.clone();
    match blocking(move || pairing::deny(&store, &code, now_ms())).await {
        Ok(true) => StatusCode::NO_CONTENT.into_response(),
        Ok(false) => error(StatusCode::NOT_FOUND, "unknown_pairing"),
        Err(e) => internal_error(e),
    }
}

#[derive(Deserialize)]
pub struct BindBody {
    key: Option<String>,
}

/// `POST {base}/api/pair/v1/bind` with a device token and `{ key }`: makes a device paired without a key, or logged in
/// with a pasted token, recognizable by its key.
pub async fn bind(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Result<Json<BindBody>, JsonRejection>,
) -> Response {
    let Some(token) = bearer(&headers).map(str::to_owned) else {
        return error(StatusCode::UNAUTHORIZED, "unauthorized");
    };
    let (store, lookup) = (state.store.clone(), token.clone());
    match blocking(move || auth::device_for_token(&store, &lookup)).await {
        Ok(Some(_)) => {}
        Ok(None) => return error(StatusCode::UNAUTHORIZED, "unauthorized"),
        Err(e) => return internal_error(e),
    }
    let Some(hash) = body.ok().and_then(|Json(body)| body.key).as_deref().and_then(key_hash) else {
        return error(StatusCode::BAD_REQUEST, "invalid_key");
    };
    let store = state.store.clone();
    match blocking(move || auth::bind_key(&store, &token, &hash)).await {
        Ok(Bind::Bound) => StatusCode::NO_CONTENT.into_response(),
        Ok(Bind::Unauthorized) => error(StatusCode::UNAUTHORIZED, "unauthorized"),
        Ok(Bind::Conflict) => error(StatusCode::CONFLICT, "key_conflict"),
        Err(e) => internal_error(e),
    }
}
