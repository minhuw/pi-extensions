mod common;

use std::io::Write;

use axum::Router;
use axum::body::Body;
use axum::http::{Request, StatusCode, header};
use common::*;
use pika::config::ServerConfig;
use pika::http::{AppState, router};
use serde_json::{Value, json};
use tower::ServiceExt;

struct Server {
    env: Env,
    app: Router,
    token: String,
}

fn server(base: &str, password: Option<&str>, max_body: Option<usize>) -> Server {
    let env = env();
    let token = pika::auth::create_token(&env.store, DEVICE).unwrap();
    let mut config = ServerConfig::new(env.dir.path().join("data"));
    config.base_path = pika::config::normalize_base_path(base).unwrap();
    config.password = password.map(str::to_owned);
    if let Some(max) = max_body {
        config.max_body = max;
    }
    let app = router(AppState::new(env.store.clone(), config).unwrap());
    Server { env, app, token }
}

struct Reply {
    status: StatusCode,
    headers: header::HeaderMap,
    body: Vec<u8>,
}

impl Reply {
    fn json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap_or_else(|_| panic!("not JSON: {}", String::from_utf8_lossy(&self.body)))
    }
    fn text(&self) -> String {
        String::from_utf8(self.body.clone()).unwrap()
    }
}

async fn send(app: &Router, request: Request<Body>) -> Reply {
    let response = app.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let headers = response.headers().clone();
    let body = axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap().to_vec();
    Reply { status, headers, body }
}

async fn get(app: &Router, path: &str, cookie: Option<&str>) -> Reply {
    let mut request = Request::get(path);
    if let Some(cookie) = cookie {
        request = request.header(header::COOKIE, cookie);
    }
    send(app, request.body(Body::empty()).unwrap()).await
}

async fn post_json(app: &Router, path: &str, body: &Value, cookie: Option<&str>) -> Reply {
    let mut request = Request::post(path).header(header::CONTENT_TYPE, "application/json");
    if let Some(cookie) = cookie {
        request = request.header(header::COOKIE, cookie);
    }
    send(app, request.body(Body::from(body.to_string())).unwrap()).await
}

fn batch_request(path: &str, token: Option<&str>, body: Vec<u8>, gzip: bool) -> Request<Body> {
    let mut request = Request::post(path).header(header::CONTENT_TYPE, "application/json");
    if let Some(token) = token {
        request = request.header(header::AUTHORIZATION, format!("Bearer {token}"));
    }
    if gzip {
        request = request.header(header::CONTENT_ENCODING, "gzip");
    }
    request.body(Body::from(body)).unwrap()
}

fn gzip(data: &[u8]) -> Vec<u8> {
    let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    encoder.write_all(data).unwrap();
    encoder.finish().unwrap()
}

fn session_batch(offset: u64, lines: &[String]) -> Vec<u8> {
    json!({ "client": { "host": "laptop", "pikaVersion": "0.1.0" },
            "streams": [stream(&format!("session:{SESSION_ID}"), "session", offset, lines)] })
    .to_string()
    .into_bytes()
}

#[tokio::test]
async fn ingest_requires_a_known_token() {
    let s = server("/", None, None);
    let path = "/api/ingest/v1/batch";
    let lines = fixture("session.jsonl");
    for token in [None, Some("pika_wrong")] {
        let r = send(&s.app, batch_request(path, token, session_batch(0, &lines), false)).await;
        assert_eq!(r.status, StatusCode::UNAUTHORIZED);
        assert_eq!(r.json()["error"], "unauthorized");
    }
    let r = send(&s.app, batch_request(path, Some(&s.token), session_batch(0, &lines[..4]), false)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    assert_eq!(r.json(), json!({ "streams": { format!("session:{SESSION_ID}"): { "length": byte_len(&lines[..4]) } }, "missingBlobs": [] }));

    // Gzip bodies, and the gap and conflict answers.
    let r = send(&s.app, batch_request(path, Some(&s.token), gzip(&session_batch(byte_len(&lines[..4]), &lines[4..])), true)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    let r = send(&s.app, batch_request(path, Some(&s.token), session_batch(byte_len(&lines) + 5, &lines[..1]), false)).await;
    assert_eq!(r.status, StatusCode::CONFLICT);
    assert_eq!(r.json(), json!({ "error": "gap", "key": format!("session:{SESSION_ID}"), "length": byte_len(&lines) }));
    let r = send(&s.app, batch_request(path, Some(&s.token), session_batch(0, &lines[1..2]), false)).await;
    assert_eq!(r.status, StatusCode::CONFLICT);
    assert_eq!(r.json()["error"], "conflict");
    let r = send(&s.app, batch_request(path, Some(&s.token), b"{not json".to_vec(), false)).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);

    let r = get(&s.app, &format!("/api/v1/sessions/{SESSION_ID}/export"), None).await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(r.body, joined(&lines));
    assert_eq!(get(&s.app, "/api/v1/sessions/nope/export", None).await.status, StatusCode::NOT_FOUND);

    assert!(pika::auth::revoke_token(&s.env.store, DEVICE).unwrap());
    let r = send(&s.app, batch_request(path, Some(&s.token), session_batch(0, &lines[..1]), false)).await;
    assert_eq!(r.status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn bodies_over_the_limit_are_rejected() {
    let s = server("/", None, Some(4096));
    let path = "/api/ingest/v1/batch";
    let big = vec![format!("{{\"type\":\"session\",\"pad\":\"{}\"}}", "x".repeat(5000))];
    let r = send(&s.app, batch_request(path, Some(&s.token), session_batch(0, &big), false)).await;
    assert_eq!(r.status, StatusCode::PAYLOAD_TOO_LARGE);
    // Small compressed, large decompressed.
    let r = send(&s.app, batch_request(path, Some(&s.token), gzip(&session_batch(0, &big)), true)).await;
    assert_eq!(r.status, StatusCode::PAYLOAD_TOO_LARGE);
    let r = send(&s.app, batch_request(path, Some(&s.token), session_batch(0, &fixture("session.jsonl")[..1]), false)).await;
    assert_eq!(r.status, StatusCode::OK);
}

#[tokio::test]
async fn the_default_limit_admits_multi_megabyte_batches() {
    let s = server("/", None, None);
    let mut lines = fixture("session.jsonl")[..1].to_vec();
    lines.push(json!({ "type": "custom", "customType": "x", "data": "y".repeat(3 << 20) }).to_string());
    let r = send(&s.app, batch_request("/api/ingest/v1/batch", Some(&s.token), session_batch(0, &lines), false)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    let r = get(&s.app, &format!("/api/v1/sessions/{SESSION_ID}/export"), None).await;
    assert_eq!(r.body, joined(&lines));
}

#[tokio::test]
async fn password_login_guards_the_read_api() {
    let s = server("/pika", Some("hunter2"), None);
    let lines = fixture("session.jsonl");
    let r = send(&s.app, batch_request("/pika/api/ingest/v1/batch", Some(&s.token), session_batch(0, &lines), false)).await;
    assert_eq!(r.status, StatusCode::OK);
    let export = format!("/pika/api/v1/sessions/{SESSION_ID}/export");

    assert_eq!(get(&s.app, "/pika/api/health", None).await.status, StatusCode::OK);
    assert_eq!(get(&s.app, "/pika/api/v1/me", None).await.json(), json!({ "authenticated": false, "passwordRequired": true }));
    let r = get(&s.app, &export, None).await;
    assert_eq!((r.status, r.json()), (StatusCode::UNAUTHORIZED, json!({ "error": "unauthorized" })));
    assert_eq!(post_json(&s.app, "/pika/api/v1/logout", &json!({}), None).await.status, StatusCode::UNAUTHORIZED);
    assert_eq!(get(&s.app, &export, Some("pika_auth=1.abc")).await.status, StatusCode::UNAUTHORIZED);

    let r = post_json(&s.app, "/pika/api/v1/login", &json!({ "password": "hunter3" }), None).await;
    assert_eq!(r.status, StatusCode::UNAUTHORIZED);
    assert!(r.headers.get(header::SET_COOKIE).is_none());

    let r = post_json(&s.app, "/pika/api/v1/login", &json!({ "password": "hunter2" }), None).await;
    assert_eq!(r.status, StatusCode::OK);
    let set_cookie = r.headers.get(header::SET_COOKIE).unwrap().to_str().unwrap().to_owned();
    assert!(set_cookie.contains("HttpOnly") && set_cookie.contains("Path=/pika;"), "{set_cookie}");
    let cookie = set_cookie.split(';').next().unwrap().to_owned();

    assert_eq!(get(&s.app, "/pika/api/v1/me", Some(&cookie)).await.json()["authenticated"], true);
    let r = get(&s.app, &export, Some(&format!("theme=dark; {cookie}"))).await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(r.body, joined(&lines));
    let mut tampered = cookie.clone();
    tampered.pop();
    tampered.push(if cookie.ends_with('0') { '1' } else { '0' });
    assert_eq!(get(&s.app, &export, Some(&tampered)).await.status, StatusCode::UNAUTHORIZED);

    let r = post_json(&s.app, "/pika/api/v1/logout", &json!({}), Some(&cookie)).await;
    assert_eq!(r.status, StatusCode::OK);
    assert!(r.headers.get(header::SET_COOKIE).unwrap().to_str().unwrap().contains("Max-Age=0"));

    // The ingest API keeps using device tokens, not the cookie.
    let r = send(&s.app, batch_request("/pika/api/ingest/v1/batch", None, session_batch(0, &lines), false)).await;
    assert_eq!(r.status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn without_a_password_everything_is_open() {
    let s = server("/", None, None);
    assert_eq!(get(&s.app, "/api/v1/me", None).await.json(), json!({ "authenticated": true, "passwordRequired": false }));
    let r = post_json(&s.app, "/api/v1/login", &json!({}), None).await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(post_json(&s.app, "/api/v1/logout", &json!({}), None).await.status, StatusCode::OK);
    let r = get(&s.app, "/", None).await;
    assert_eq!(r.status, StatusCode::OK);
    assert!(r.text().contains(r#"<meta name="pika-base" content="/">"#), "{}", r.text());
}

#[tokio::test]
async fn routes_live_under_the_base_path() {
    let s = server("/pika/", None, None);
    let health = get(&s.app, "/pika/api/health", None).await;
    assert_eq!((health.status, &health.json()["basePath"]), (StatusCode::OK, &json!("/pika")));
    for outside in ["/api/health", "/", "/pikachu", "/other/api/health"] {
        assert_eq!(get(&s.app, outside, None).await.status, StatusCode::NOT_FOUND, "{outside}");
    }
    for page in ["/pika", "/pika/", "/pika/sessions/abc", "/pika/herder/runs/r1"] {
        let r = get(&s.app, page, None).await;
        assert_eq!(r.status, StatusCode::OK, "{page}");
        assert!(r.headers[header::CONTENT_TYPE].to_str().unwrap().starts_with("text/html"));
        assert!(r.text().contains(r#"<meta name="pika-base" content="/pika">"#), "{page}");
    }
    let r = get(&s.app, "/pika/api/v1/unknown", None).await;
    assert_eq!((r.status, r.json()), (StatusCode::NOT_FOUND, json!({ "error": "not_found" })));
    let lines = fixture("session.jsonl");
    let r = send(&s.app, batch_request("/pika/api/ingest/v1/batch", Some(&s.token), session_batch(0, &lines), false)).await;
    assert_eq!(r.status, StatusCode::OK);
    let r = get(&s.app, &format!("/pika/api/v1/sessions/{SESSION_ID}/export"), None).await;
    assert_eq!(r.body, joined(&lines));
}
