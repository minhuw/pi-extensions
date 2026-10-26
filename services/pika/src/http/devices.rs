//! Devices and pairing: `{base}/api/v1/devices` and `pairings` (behind the login check) and the unauthenticated
//! `{base}/api/pair/v1/start` and `poll` that devices call.

use std::time::Instant;

use axum::Json;
use axum::extract::rejection::JsonRejection;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use serde_json::{Map, Value, json};

use super::auth::{Client, too_many_attempts};
use super::{AppState, blocking, error, internal_error};
use crate::auth::{self, valid_device_name};
use crate::pairing::{self, Approval, Poll};
use crate::util::{cut_chars, format_iso_ms, now_ms};

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
            item.insert("name".into(), d.name.into());
            item.insert("createdAt".into(), format_iso_ms(d.created_at).into());
            item.insert("createdVia".into(), d.created_via.into());
            put(&mut item, "lastSeenAt", &d.last_seen_at.map(format_iso_ms));
            put(&mut item, "lastHost", &d.last_host);
            Value::Object(item)
        })
        .collect();
    Json(json!({ "items": items })).into_response()
}

pub async fn revoke(State(state): State<AppState>, Path(name): Path<String>) -> Response {
    let store = state.store.clone();
    match blocking(move || auth::revoke_token(&store, &name)).await {
        Ok(true) => StatusCode::NO_CONTENT.into_response(),
        Ok(false) => error(StatusCode::NOT_FOUND, "not_found"),
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
}

pub async fn start(State(state): State<AppState>, client: Client, body: Result<Json<Start>, JsonRejection>) -> Response {
    let Ok(Json(body)) = body else { return error(StatusCode::BAD_REQUEST, "invalid_device") };
    if !valid_device_name(&body.device) || body.host.as_ref().is_some_and(|h| h.chars().count() > 255) {
        return error(StatusCode::BAD_REQUEST, "invalid_device");
    }
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
            device: &body.device,
            host: body.host.as_deref().filter(|h| !h.is_empty()),
            ip: ip.as_deref(),
            pika_version: body.pika_version.as_deref().filter(|v| !v.is_empty()).map(|v| cut_chars(v, 64)),
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
        Ok(Some(Poll::Approved { device, token })) => {
            tracing::info!("paired device {device:?}");
            Json(json!({ "status": "approved", "device": device, "token": token })).into_response()
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
            item.insert("device".into(), p.device.into());
            put(&mut item, "host", &p.host);
            put(&mut item, "ip", &p.ip);
            put(&mut item, "pikaVersion", &p.pika_version);
            item.insert("requestedAt".into(), format_iso_ms(p.requested_at).into());
            item.insert("expiresAt".into(), format_iso_ms(p.expires_at).into());
            item.insert("deviceExists".into(), p.device_exists.into());
            Value::Object(item)
        })
        .collect();
    Json(json!({ "items": items })).into_response()
}

#[derive(Deserialize)]
pub struct ApproveBody {
    name: Option<String>,
    replace: Option<bool>,
}

pub async fn approve(State(state): State<AppState>, Path(code): Path<String>, Json(body): Json<ApproveBody>) -> Response {
    let store = state.store.clone();
    let replace = body.replace == Some(true);
    match blocking(move || pairing::approve(&store, &code, body.name.as_deref(), replace, now_ms())).await {
        Ok(Approval::Approved(device)) => Json(json!({ "device": device })).into_response(),
        Ok(Approval::NotFound) => error(StatusCode::NOT_FOUND, "unknown_pairing"),
        Ok(Approval::InvalidName) => error(StatusCode::BAD_REQUEST, "invalid_device"),
        Ok(Approval::DeviceExists) => error(StatusCode::CONFLICT, "device_exists"),
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
