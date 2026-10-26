mod common;

use std::io::{BufRead, BufReader, Write};
use std::net::{IpAddr, SocketAddr};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;

use axum::Router;
use axum::body::Body;
use axum::extract::ConnectInfo;
use axum::http::{Method, Request, StatusCode, header};
use common::*;
use pika::config::{AuthMode, CookieSecure, ServerConfig};
use pika::http::{AppState, router};
use serde_json::{Value, json};
use tower::ServiceExt;

const PASSWORD: &str = "correct horse battery";
const INGEST: &str = "/api/ingest/v1/batch";

struct Reply {
    status: StatusCode,
    headers: header::HeaderMap,
    body: Vec<u8>,
}

impl Reply {
    fn json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap_or_else(|_| panic!("not JSON: {}", String::from_utf8_lossy(&self.body)))
    }
    fn set_cookie(&self) -> String {
        self.headers.get(header::SET_COOKIE).expect("Set-Cookie").to_str().unwrap().to_owned()
    }
    /// The `name=value` pair of the Set-Cookie header.
    fn cookie(&self) -> String {
        self.set_cookie().split(';').next().unwrap().to_owned()
    }
}

/// A request under construction.
struct Req {
    builder: axum::http::request::Builder,
    body: Body,
    peer: Option<IpAddr>,
}

impl Req {
    fn new(method: Method, path: &str) -> Req {
        Req { builder: Request::builder().method(method).uri(path), body: Body::empty(), peer: None }
    }
    fn get(path: &str) -> Req {
        Req::new(Method::GET, path)
    }
    fn delete(path: &str) -> Req {
        Req::new(Method::DELETE, path)
    }
    fn post(path: &str, body: Value) -> Req {
        let mut r = Req::new(Method::POST, path).header("content-type", "application/json");
        r.body = Body::from(body.to_string());
        r
    }
    fn form(path: &str, text: &str) -> Req {
        let mut r = Req::new(Method::POST, path).header("content-type", "application/x-www-form-urlencoded");
        r.body = Body::from(text.to_owned());
        r
    }
    fn header(mut self, name: &str, value: &str) -> Req {
        self.builder = self.builder.header(name, value);
        self
    }
    fn cookie(self, cookie: &str) -> Req {
        self.header("cookie", cookie)
    }
    fn peer(mut self, ip: &str) -> Req {
        self.peer = Some(ip.parse().unwrap());
        self
    }
    async fn send(self, app: &Router) -> Reply {
        let mut request = self.builder.body(self.body).unwrap();
        if let Some(ip) = self.peer {
            request.extensions_mut().insert(ConnectInfo(SocketAddr::new(ip, 40000)));
        }
        let response = app.clone().oneshot(request).await.unwrap();
        let status = response.status();
        let headers = response.headers().clone();
        let body = axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap().to_vec();
        Reply { status, headers, body }
    }
}

fn config(env: &Env) -> ServerConfig {
    let mut config = ServerConfig::new(env.dir.path().join("data"));
    config.password = Some(PASSWORD.into());
    config
}

fn app(env: &Env, config: ServerConfig) -> Router {
    router(AppState::new(env.store.clone(), config).unwrap())
}

async fn login(app: &Router, password: &str) -> Reply {
    Req::post("/api/v1/login", json!({ "password": password })).send(app).await
}

async fn logged_in(app: &Router) -> String {
    let r = login(app, PASSWORD).await;
    assert_eq!(r.status, StatusCode::OK);
    r.cookie()
}

fn batch(host: &str) -> Value {
    json!({ "client": { "host": host, "pikaVersion": "0.2.0" }, "streams": [] })
}

async fn ingest_with(app: &Router, token: &str, host: &str) -> StatusCode {
    Req::post(INGEST, batch(host)).header("authorization", &format!("Bearer {token}")).send(app).await.status
}

fn set_sql(env: &Env, sql: &str) {
    env.store.write(|tx| tx.execute_batch(sql)).unwrap();
}

/// Every byte of the database files, to check that a secret never reached them.
fn db_bytes(env: &Env) -> Vec<u8> {
    let data = env.dir.path().join("data");
    ["pika.db", "pika.db-wal"].iter().filter_map(|f| std::fs::read(data.join(f)).ok()).flatten().collect()
}

fn contains(haystack: &[u8], needle: &str) -> bool {
    haystack.windows(needle.len()).any(|w| w == needle.as_bytes())
}

/// The `pika` binary with no PIKA_* settings from the environment.
fn pika(data: &std::path::Path) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_pika"));
    for (key, _) in std::env::vars_os() {
        if key.to_string_lossy().starts_with("PIKA_") {
            command.env_remove(key);
        }
    }
    command.arg("--data-dir").arg(data);
    command
}

#[test]
fn password_mode_refuses_to_start_without_a_password() {
    let env = env();
    let mut config = ServerConfig::new(env.dir.path().join("data"));
    let Err(e) = AppState::new(env.store.clone(), config.clone()) else { panic!("started without a password") };
    assert!(e.downcast_ref::<pika::auth::NoPassword>().is_some(), "{e:#}");
    config.password = Some(String::new());
    assert!(AppState::new(env.store.clone(), config.clone()).is_err());
    for mode in [AuthMode::Proxy, AuthMode::None] {
        config.auth = mode;
        assert!(AppState::new(env.store.clone(), config.clone()).is_ok(), "{mode:?}");
    }

    let data = env.dir.path().join("cli");
    let out = pika(&data).args(["serve", "--bind", "127.0.0.1:0"]).output().unwrap();
    assert_eq!(out.status.code(), Some(2));
    assert_eq!(
        String::from_utf8_lossy(&out.stderr).trim(),
        "pika: no password configured. Run 'pika password set', set PIKA_PASSWORD_FILE or PIKA_PASSWORD, or set \
         PIKA_AUTH=proxy if your reverse proxy authenticates (PIKA_AUTH=none disables authentication)."
    );
    for mode in ["proxy", "none"] {
        let mut child = pika(&data)
            .args(["serve", "--bind", "127.0.0.1:0"])
            .env("PIKA_AUTH", mode)
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let lines: Vec<String> = BufReader::new(child.stdout.take().unwrap())
            .lines()
            .map_while(Result::ok)
            .take_while(|l| !l.contains("listening on"))
            .collect();
        let running = child.try_wait().unwrap().is_none();
        child.kill().unwrap();
        child.wait().unwrap();
        assert!(running, "{mode}: {lines:?}");
        assert!(lines.iter().any(|l| l.contains("WARN") && l.contains(&format!("PIKA_AUTH={mode}"))), "{lines:?}");
    }
}

#[tokio::test]
async fn password_sources_take_precedence_in_order() {
    let env = env();
    pika::auth::set_password(&env.store, "the-stored-password").unwrap();
    let file = env.dir.path().join("password");
    std::fs::write(&file, "the-file-password\n").unwrap();

    // The stored hash alone.
    let mut c = config(&env);
    c.password = None;
    let a = app(&env, c.clone());
    assert_eq!(login(&a, "the-stored-password").await.status, StatusCode::OK);

    // The password beats the stored hash.
    c.password = Some("the-env-password".into());
    let a = app(&env, c.clone());
    assert_eq!(login(&a, "the-stored-password").await.status, StatusCode::UNAUTHORIZED);
    assert_eq!(login(&a, "the-env-password").await.status, StatusCode::OK);

    // The file beats both, without its trailing newline.
    c.password_file = Some(file.clone());
    let a = app(&env, c.clone());
    assert_eq!(login(&a, "the-env-password").await.status, StatusCode::UNAUTHORIZED);
    assert_eq!(login(&a, "the-file-password\n").await.status, StatusCode::UNAUTHORIZED);
    assert_eq!(login(&a, "the-file-password").await.status, StatusCode::OK);
    std::fs::write(&file, "keeps\n\n").unwrap();
    let a = app(&env, c.clone());
    assert_eq!(login(&a, "keeps\n").await.status, StatusCode::OK);

    std::fs::write(&file, "\n").unwrap();
    assert!(AppState::new(env.store.clone(), c.clone()).is_err());
    c.password_file = Some(env.dir.path().join("missing"));
    assert!(AppState::new(env.store.clone(), c.clone()).is_err());

    // A server on the stored hash picks up `password set` at once.
    let mut c = config(&env);
    c.password = None;
    let a = app(&env, c);
    pika::auth::set_password(&env.store, "a-newer-password").unwrap();
    assert_eq!(login(&a, "the-stored-password").await.status, StatusCode::UNAUTHORIZED);
    assert_eq!(login(&a, "a-newer-password").await.status, StatusCode::OK);
    assert!(pika::auth::set_password(&env.store, "too-short").is_err());
}

#[tokio::test]
async fn password_set_stores_argon2id_and_signs_everyone_out() {
    let env = env();
    let data = env.dir.path().join("data");
    let set = |input: &str| {
        let mut child = pika(&data).args(["password", "set"]).stdin(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
        child.stdin.take().unwrap().write_all(input.as_bytes()).unwrap();
        child.wait_with_output().unwrap()
    };
    let out = set("short\n");
    assert_eq!(out.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&out.stderr).contains("at least 12 characters"));
    assert_eq!(pika::auth::stored_password_hash(&env.store).unwrap(), None);

    assert!(set("first-password-1\n").status.success());
    let hash = pika::auth::stored_password_hash(&env.store).unwrap().unwrap();
    assert!(hash.starts_with("$argon2id$v=19$"), "{hash}");
    assert!(!contains(&db_bytes(&env), "first-password-1"));

    let mut c = config(&env);
    c.password = None;
    let a = app(&env, c.clone());
    let cookie = logged_in_with(&a, "first-password-1").await;
    assert_eq!(Req::get("/api/v1/sessions").cookie(&cookie).send(&a).await.status, StatusCode::OK);

    let out = set("second-password-2\n");
    assert!(out.status.success());
    assert!(String::from_utf8_lossy(&out.stderr).contains("signed out 1 browser sessions"));
    assert_eq!(Req::get("/api/v1/sessions").cookie(&cookie).send(&a).await.status, StatusCode::UNAUTHORIZED);
    assert_eq!(login(&a, "first-password-1").await.status, StatusCode::UNAUTHORIZED);
    let cookie = logged_in_with(&a, "second-password-2").await;

    // Restarting on the stored hash keeps the sessions made after `password set`.
    let a = app(&env, c.clone());
    assert_eq!(Req::get("/api/v1/sessions").cookie(&cookie).send(&a).await.status, StatusCode::OK);

    // Clearing the stored password signs everyone out at once, without a restart.
    let out = pika(&data).args(["password", "clear"]).output().unwrap();
    assert!(out.status.success());
    assert!(String::from_utf8_lossy(&out.stderr).contains("signed out 1 browser sessions"), "{out:?}");
    assert_eq!(pika::auth::stored_password_hash(&env.store).unwrap(), None);
    assert_eq!(Req::get("/api/v1/sessions").cookie(&cookie).send(&a).await.status, StatusCode::UNAUTHORIZED);
    assert!(query(&env.store, "SELECT * FROM auth_sessions").is_empty());
    let out = pika(&data).args(["password", "clear"]).output().unwrap();
    assert!(String::from_utf8_lossy(&out.stderr).contains("no stored password"), "{out:?}");
    let Err(e) = AppState::new(env.store.clone(), c) else { panic!("started without a password") };
    assert!(e.downcast_ref::<pika::auth::NoPassword>().is_some());
}

async fn logged_in_with(app: &Router, password: &str) -> String {
    let r = login(app, password).await;
    assert_eq!(r.status, StatusCode::OK);
    r.cookie()
}

#[tokio::test]
async fn sessions_live_on_the_server() {
    let env = env();
    let mut c = config(&env);
    c.base_path = "/pika".into();
    let a = app(&env, c);
    let r = Req::post("/pika/api/v1/login", json!({ "password": PASSWORD })).send(&a).await;
    assert_eq!(r.status, StatusCode::OK);
    let set_cookie = r.set_cookie();
    for part in ["Path=/pika/", "Max-Age=2592000", "HttpOnly", "SameSite=Lax"] {
        assert!(set_cookie.split("; ").any(|p| p == part), "{part}: {set_cookie}");
    }
    assert!(!set_cookie.contains("Secure"), "{set_cookie}");
    let cookie = r.cookie();
    let value = cookie.strip_prefix("pika_session=").unwrap();
    assert_eq!(value.len(), 43);
    assert!(value.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'), "{value}");
    // Only the id's SHA-256 is stored.
    let row = one(&env.store, "SELECT * FROM auth_sessions");
    assert_eq!(row["id_hash"], json!(pika::util::sha256_hex(value.as_bytes())));
    assert!(!contains(&db_bytes(&env), value));

    let me = Req::get("/pika/api/v1/me").cookie(&cookie).send(&a).await.json();
    assert_eq!(me, json!({ "authenticated": true, "passwordRequired": true, "authMode": "password" }));
    assert_eq!(Req::get("/pika/api/v1/facets").cookie(&cookie).send(&a).await.status, StatusCode::OK);

    // A cookie that 0.1 would have accepted with its database key is refused.
    let key = env.store.setting_or_init("cookie_key", || pika::util::random_bytes::<32>().to_vec()).unwrap();
    let expires = pika::util::now_ms() + 3_600_000;
    let password = pika::util::sha256_hex(PASSWORD.as_bytes());
    let signature = pika::util::hmac_sha256(&key, format!("pika-session:{expires}:{password}").as_bytes());
    let old = format!("pika_auth={expires}.{}", hex::encode(signature));
    assert_eq!(Req::get("/pika/api/v1/facets").cookie(&old).send(&a).await.status, StatusCode::UNAUTHORIZED);
    assert_eq!(Req::get("/pika/api/v1/me").cookie(&old).send(&a).await.json()["authenticated"], false);

    // Form posts are refused: state changes need a JSON body.
    let form = Req::form("/pika/api/v1/logout", "").cookie(&cookie).send(&a).await;
    assert_eq!(form.status, StatusCode::UNSUPPORTED_MEDIA_TYPE);
    let form = Req::form("/pika/api/v1/login", &format!("password={PASSWORD}")).send(&a).await;
    assert_eq!(form.status, StatusCode::UNSUPPORTED_MEDIA_TYPE);
    assert_eq!(Req::get("/pika/api/v1/facets").cookie(&cookie).send(&a).await.status, StatusCode::OK);

    let r = Req::post("/pika/api/v1/logout", json!({})).cookie(&cookie).send(&a).await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(r.set_cookie(), "pika_session=; Path=/pika/; Max-Age=0; HttpOnly; SameSite=Lax");
    assert_eq!(Req::get("/pika/api/v1/facets").cookie(&cookie).send(&a).await.status, StatusCode::UNAUTHORIZED);
    assert!(query(&env.store, "SELECT * FROM auth_sessions").is_empty());
}

#[tokio::test]
async fn sessions_can_be_listed_and_revoked() {
    let env = env();
    let a = app(&env, config(&env));
    let login_from = |ip: &'static str, agent: &'static str| {
        let a = a.clone();
        async move {
            let r = Req::post("/api/v1/login", json!({ "password": PASSWORD })).peer(ip).header("user-agent", agent).send(&a).await;
            assert_eq!(r.status, StatusCode::OK);
            r.cookie()
        }
    };
    let first = login_from("10.0.0.1", "Firefox").await;
    set_sql(&env, "UPDATE auth_sessions SET created_at = created_at - 1000");
    let second = login_from("10.0.0.2", "Chrome").await;

    let r = Req::get("/api/v1/auth/sessions").cookie(&second).send(&a).await;
    assert_eq!(r.status, StatusCode::OK);
    let items = r.json()["items"].as_array().unwrap().clone();
    assert_eq!(items.len(), 2);
    assert_eq!((&items[0]["userAgent"], &items[0]["ip"], &items[0]["current"]), (&json!("Chrome"), &json!("10.0.0.2"), &json!(true)));
    assert_eq!((&items[1]["userAgent"], &items[1]["ip"], &items[1]["current"]), (&json!("Firefox"), &json!("10.0.0.1"), &json!(false)));
    for item in &items {
        let id = item["id"].as_str().unwrap();
        assert!(id.len() == 12 && id.bytes().all(|b| b.is_ascii_hexdigit()), "{id}");
        for key in ["createdAt", "lastSeenAt", "expiresAt"] {
            assert!(item[key].as_str().unwrap().ends_with('Z'), "{key}");
        }
    }

    // Deleting another session signs it out; deleting the current one clears the cookie too.
    let first_id = items[1]["id"].as_str().unwrap().to_owned();
    let r = Req::delete(&format!("/api/v1/auth/sessions/{first_id}")).cookie(&second).send(&a).await;
    assert_eq!(r.status, StatusCode::NO_CONTENT);
    assert!(r.headers.get(header::SET_COOKIE).is_none());
    assert_eq!(Req::get("/api/v1/facets").cookie(&first).send(&a).await.status, StatusCode::UNAUTHORIZED);
    let r = Req::delete(&format!("/api/v1/auth/sessions/{first_id}")).cookie(&second).send(&a).await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);
    let second_id = items[0]["id"].as_str().unwrap().to_owned();
    let r = Req::delete(&format!("/api/v1/auth/sessions/{second_id}")).cookie(&second).send(&a).await;
    assert_eq!(r.status, StatusCode::NO_CONTENT);
    assert!(r.set_cookie().contains("Max-Age=0"));
    assert_eq!(Req::get("/api/v1/facets").cookie(&second).send(&a).await.status, StatusCode::UNAUTHORIZED);

    // Sign out everywhere, this browser included.
    let one_more = logged_in(&a).await;
    let another = logged_in(&a).await;
    let r = Req::post("/api/v1/auth/sessions/revoke-all", json!({})).cookie(&one_more).send(&a).await;
    assert_eq!((r.status, r.json()), (StatusCode::OK, json!({})));
    assert!(r.set_cookie().contains("Max-Age=0"));
    for cookie in [&one_more, &another] {
        assert_eq!(Req::get("/api/v1/facets").cookie(cookie).send(&a).await.status, StatusCode::UNAUTHORIZED);
    }
    assert_eq!(Req::post("/api/v1/auth/sessions/revoke-all", json!({})).send(&a).await.status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn sessions_expire_and_record_visits_once_a_minute() {
    let env = env();
    let a = app(&env, config(&env));
    let cookie = logged_in(&a).await;
    let last_seen = || one(&env.store, "SELECT last_seen_at FROM auth_sessions")["last_seen_at"].as_i64().unwrap();

    let recent = pika::util::now_ms() - 30_000;
    set_sql(&env, &format!("UPDATE auth_sessions SET last_seen_at = {recent}"));
    assert_eq!(Req::get("/api/v1/facets").cookie(&cookie).send(&a).await.status, StatusCode::OK);
    assert_eq!(last_seen(), recent);
    let stale = pika::util::now_ms() - 61_000;
    set_sql(&env, &format!("UPDATE auth_sessions SET last_seen_at = {stale}"));
    assert_eq!(Req::get("/api/v1/facets").cookie(&cookie).send(&a).await.status, StatusCode::OK);
    assert!(last_seen() > stale + 60_000);

    set_sql(&env, &format!("UPDATE auth_sessions SET expires_at = {}", pika::util::now_ms() - 1));
    assert_eq!(Req::get("/api/v1/facets").cookie(&cookie).send(&a).await.status, StatusCode::UNAUTHORIZED);
    assert!(query(&env.store, "SELECT * FROM auth_sessions").is_empty());
    assert_eq!(Req::get("/api/v1/me").cookie(&cookie).send(&a).await.json()["authenticated"], false);

    // Logging in deletes expired sessions.
    let cookie = logged_in(&a).await;
    set_sql(&env, "UPDATE auth_sessions SET expires_at = 1");
    logged_in(&a).await;
    assert_eq!(query(&env.store, "SELECT * FROM auth_sessions").len(), 1);
    assert_eq!(Req::get("/api/v1/facets").cookie(&cookie).send(&a).await.status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn a_password_change_between_starts_signs_everyone_out() {
    let env = env();
    let a = app(&env, config(&env));
    let cookie = logged_in(&a).await;
    // Same password: the session survives a restart.
    let a = app(&env, config(&env));
    assert_eq!(Req::get("/api/v1/facets").cookie(&cookie).send(&a).await.status, StatusCode::OK);
    let mut c = config(&env);
    c.password = Some("a different password".into());
    let a = app(&env, c.clone());
    assert_eq!(Req::get("/api/v1/facets").cookie(&cookie).send(&a).await.status, StatusCode::UNAUTHORIZED);
    assert!(!contains(&db_bytes(&env), "a different password"));
    assert!(!contains(&db_bytes(&env), PASSWORD));
}

fn fingerprint(env: &Env) -> String {
    String::from_utf8_lossy(&env.store.setting("password_fingerprint").unwrap().unwrap()).into_owned()
}

#[tokio::test]
async fn a_configured_password_is_fingerprinted_with_argon2id_only() {
    let env = env();
    let a = app(&env, config(&env));
    let cookie = logged_in(&a).await;
    let first = fingerprint(&env);
    assert!(first.starts_with("$argon2id$v=19$"), "{first}");
    assert!(pika::auth::verify_password(&first, PASSWORD));
    // No fast hash of the password reaches the database: neither its SHA-256 nor an HMAC with the database key.
    let bytes = db_bytes(&env);
    assert!(!contains(&bytes, &pika::util::sha256_hex(PASSWORD.as_bytes())));
    if let Some(key) = env.store.setting("cookie_key").unwrap() {
        for source in ["configured", "PIKA_PASSWORD"] {
            let hmac = pika::util::hmac_sha256(&key, format!("pika-password:{source}:{PASSWORD}").as_bytes());
            assert!(!bytes.windows(32).any(|w| w == hmac), "{source}");
        }
    }

    // A restart with the same password keeps the fingerprint and the sessions.
    let a = app(&env, config(&env));
    assert_eq!(fingerprint(&env), first);
    assert_eq!(Req::get("/api/v1/facets").cookie(&cookie).send(&a).await.status, StatusCode::OK);
    // A new password replaces it and signs everyone out.
    let mut c = config(&env);
    c.password = Some("a different password".into());
    let a = app(&env, c);
    let second = fingerprint(&env);
    assert!(second.starts_with("$argon2id$") && second != first, "{second}");
    assert!(pika::auth::verify_password(&second, "a different password"));
    assert_eq!(Req::get("/api/v1/facets").cookie(&cookie).send(&a).await.status, StatusCode::UNAUTHORIZED);
    assert_eq!(login(&a, "a different password").await.status, StatusCode::OK);
}

#[tokio::test]
async fn the_secure_attribute_follows_cookie_secure() {
    let env = env();
    let cases = [
        (CookieSecure::Auto, false, Some("https"), false),
        (CookieSecure::Auto, true, Some("https"), true),
        (CookieSecure::Auto, true, Some("HTTPS"), true),
        (CookieSecure::Auto, true, Some("http"), false),
        (CookieSecure::Auto, true, None, false),
        (CookieSecure::Always, false, None, true),
        (CookieSecure::Never, true, Some("https"), false),
    ];
    for (secure, trust, proto, expected) in cases {
        let mut c = config(&env);
        c.cookie_secure = secure;
        c.trust_proxy = trust;
        let a = app(&env, c);
        let mut r = Req::post("/api/v1/login", json!({ "password": PASSWORD }));
        if let Some(proto) = proto {
            r = r.header("x-forwarded-proto", proto);
        }
        let set_cookie = r.send(&a).await.set_cookie();
        assert_eq!(set_cookie.ends_with("; Secure"), expected, "{secure:?} {trust} {proto:?}: {set_cookie}");
        let cookie = set_cookie.split(';').next().unwrap().to_owned();
        let mut r = Req::post("/api/v1/logout", json!({})).cookie(&cookie);
        if let Some(proto) = proto {
            r = r.header("x-forwarded-proto", proto);
        }
        assert_eq!(r.send(&a).await.set_cookie().ends_with("; Secure"), expected);
    }
}

#[tokio::test]
async fn the_client_ip_comes_from_the_proxy_only_when_trusted() {
    let env = env();
    let a = app(&env, config(&env));
    // Untrusted: a different X-Forwarded-For on every attempt still counts against the socket peer.
    for i in 0..5 {
        let r = Req::post("/api/v1/login", json!({ "password": "wrong" }))
            .peer("192.0.2.7")
            .header("x-forwarded-for", &format!("203.0.113.{i}"))
            .send(&a)
            .await;
        assert_eq!(r.status, StatusCode::UNAUTHORIZED, "{i}");
    }
    let r = Req::post("/api/v1/login", json!({ "password": PASSWORD }))
        .peer("192.0.2.7")
        .header("x-forwarded-for", "203.0.113.99")
        .send(&a)
        .await;
    assert_eq!(r.status, StatusCode::TOO_MANY_REQUESTS);
    let r = Req::post("/api/v1/login", json!({ "password": PASSWORD }))
        .peer("192.0.2.8")
        .header("x-forwarded-for", "203.0.113.99")
        .send(&a)
        .await;
    assert_eq!(r.status, StatusCode::OK);
    let sessions = query(&env.store, "SELECT ip FROM auth_sessions");
    assert_eq!(sessions[0]["ip"], json!("192.0.2.8"));

    // Trusted: the rightmost X-Forwarded-For address is the client.
    let trusted = common::env();
    let mut c = config(&trusted);
    c.trust_proxy = true;
    let a = app(&trusted, c);
    for _ in 0..5 {
        let r = Req::post("/api/v1/login", json!({ "password": "wrong" }))
            .peer("127.0.0.1")
            .header("x-forwarded-for", "198.51.100.1, 203.0.113.5")
            .send(&a)
            .await;
        assert_eq!(r.status, StatusCode::UNAUTHORIZED);
    }
    let blocked = Req::post("/api/v1/login", json!({ "password": PASSWORD }))
        .peer("127.0.0.1")
        .header("x-forwarded-for", "203.0.113.5")
        .send(&a)
        .await;
    assert_eq!(blocked.status, StatusCode::TOO_MANY_REQUESTS);
    let r = Req::post("/api/v1/login", json!({ "password": PASSWORD }))
        .peer("127.0.0.1")
        .header("x-forwarded-for", "203.0.113.5, 203.0.113.6")
        .send(&a)
        .await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(one(&trusted.store, "SELECT ip FROM auth_sessions")["ip"], json!("203.0.113.6"));
}

#[tokio::test]
async fn failed_logins_are_rate_limited() {
    let env = env();
    let mut c = config(&env);
    c.trust_proxy = true;
    let a = app(&env, c);
    let attempt = |ip: String, password: &'static str| {
        let a = a.clone();
        async move { Req::post("/api/v1/login", json!({ "password": password })).header("x-forwarded-for", &ip).send(&a).await }
    };
    for _ in 0..5 {
        let r = attempt("10.1.0.1".into(), "wrong").await;
        assert_eq!((r.status, r.json()), (StatusCode::UNAUTHORIZED, json!({ "error": "invalid_password" })));
    }
    // Blocked without checking the password, even the right one.
    let r = attempt("10.1.0.1".into(), PASSWORD).await;
    assert_eq!(r.status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(r.json()["error"], "too_many_attempts");
    let retry = r.json()["retryAfter"].as_u64().unwrap();
    assert!((899..=900).contains(&retry), "{retry}");
    assert_eq!(r.headers[header::RETRY_AFTER].to_str().unwrap(), retry.to_string());
    assert!(r.headers.get(header::SET_COOKIE).is_none());

    // A success clears that IP's failures.
    for _ in 0..4 {
        assert_eq!(attempt("10.1.0.2".into(), "wrong").await.status, StatusCode::UNAUTHORIZED);
    }
    assert_eq!(attempt("10.1.0.2".into(), PASSWORD).await.status, StatusCode::OK);
    for _ in 0..5 {
        assert_eq!(attempt("10.1.0.2".into(), "wrong").await.status, StatusCode::UNAUTHORIZED);
    }
    assert_eq!(attempt("10.1.0.2".into(), "wrong").await.status, StatusCode::TOO_MANY_REQUESTS);

    // 100 failures an hour across all clients block everyone; 14 so far.
    for i in 0..86 {
        assert_eq!(attempt(format!("10.2.{}.{}", i / 4, i % 4), "wrong").await.status, StatusCode::UNAUTHORIZED, "{i}");
    }
    let r = attempt("10.3.0.1".into(), PASSWORD).await;
    assert_eq!(r.status, StatusCode::TOO_MANY_REQUESTS);
    assert!(r.json()["retryAfter"].as_u64().unwrap() > 3500);
}

/// Sends a wrong password from `ip` and drops the request once its password check has started, as a client that
/// disconnects does.
async fn abandon_login(a: &Router, state: &AppState, ip: &str) {
    let started = state.auth.password_checks().started;
    let request = Req::post("/api/v1/login", json!({ "password": "wrong" })).header("x-forwarded-for", ip).send(a);
    tokio::pin!(request);
    while state.auth.password_checks().started == started {
        tokio::select! {
            biased;
            r = &mut request => panic!("the login finished with {}", r.status),
            _ = tokio::time::sleep(Duration::from_millis(1)) => {}
        }
    }
}

#[tokio::test]
async fn abandoned_logins_count_and_password_checks_stay_bounded() {
    let env = env();
    let mut c = config(&env);
    c.trust_proxy = true;
    let state = AppState::new(env.store.clone(), c).unwrap();
    let a = router(state.clone());
    // Clients that disconnect mid-check leave argon2 running; the next checks wait for those to finish.
    for i in 0..8 {
        abandon_login(&a, &state, &format!("10.6.0.{i}")).await;
    }
    // Five abandoned attempts are that address's five failures.
    for _ in 0..5 {
        abandon_login(&a, &state, "10.5.0.1").await;
    }
    let r = Req::post("/api/v1/login", json!({ "password": PASSWORD })).header("x-forwarded-for", "10.5.0.1").send(&a).await;
    assert_eq!(r.status, StatusCode::TOO_MANY_REQUESTS);
    while state.auth.password_checks().running > 0 {
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    let checks = state.auth.password_checks();
    assert_eq!(checks.started, 13);
    assert!(checks.peak <= pika::ratelimit::MAX_PASSWORD_CHECKS, "{checks:?}");
    // Others still log in, and parallel logins share the checks.
    let logins: Vec<_> = (0..6)
        .map(|i| {
            let a = a.clone();
            tokio::spawn(async move {
                let r = Req::post("/api/v1/login", json!({ "password": PASSWORD }))
                    .header("x-forwarded-for", &format!("10.7.0.{i}"))
                    .send(&a)
                    .await;
                r.status
            })
        })
        .collect();
    for login in logins {
        assert_eq!(login.await.unwrap(), StatusCode::OK);
    }
    assert!(state.auth.password_checks().peak <= pika::ratelimit::MAX_PASSWORD_CHECKS);
}

#[tokio::test]
async fn ipv6_clients_share_the_limits_of_their_64() {
    let env = env();
    let a = app(&env, config(&env));
    for i in 1..=5 {
        let r = Req::post("/api/v1/login", json!({ "password": "wrong" })).peer(&format!("2001:db8:1:2::{i}")).send(&a).await;
        assert_eq!(r.status, StatusCode::UNAUTHORIZED, "{i}");
    }
    let r = Req::post("/api/v1/login", json!({ "password": PASSWORD })).peer("2001:db8:1:2:ffff:ffff:ffff:ffff").send(&a).await;
    assert_eq!(r.status, StatusCode::TOO_MANY_REQUESTS);
    let r = Req::post("/api/v1/login", json!({ "password": PASSWORD })).peer("2001:db8:1:3::1").send(&a).await;
    assert_eq!(r.status, StatusCode::OK);
    // The session list still shows the full address.
    assert_eq!(one(&env.store, "SELECT ip FROM auth_sessions")["ip"], json!("2001:db8:1:3::1"));

    // Pairing starts count the same way, and an IPv4-mapped address counts as the IPv4 address.
    for i in 1..=5 {
        assert_eq!(start(&a, &format!("2001:db8:9:9::{i}"), json!({ "device": "box" })).await.status, StatusCode::OK);
    }
    assert_eq!(start(&a, "2001:db8:9:9::99", json!({ "device": "box" })).await.status, StatusCode::TOO_MANY_REQUESTS);
    set_sql(&env, "DELETE FROM pairings");
    for _ in 0..5 {
        assert_eq!(start(&a, "::ffff:192.0.2.9", json!({ "device": "box" })).await.status, StatusCode::OK);
    }
    assert_eq!(start(&a, "192.0.2.9", json!({ "device": "box" })).await.status, StatusCode::TOO_MANY_REQUESTS);
}

#[tokio::test]
async fn me_reports_the_mode() {
    let env = env();
    let a = app(&env, config(&env));
    let me = Req::get("/api/v1/me").send(&a).await.json();
    assert_eq!(me, json!({ "authenticated": false, "passwordRequired": true, "authMode": "password" }));
    for (mode, name) in [(AuthMode::Proxy, "proxy"), (AuthMode::None, "none")] {
        let mut c = config(&env);
        c.auth = mode;
        let a = app(&env, c);
        let me = Req::get("/api/v1/me").send(&a).await.json();
        assert_eq!(me, json!({ "authenticated": true, "passwordRequired": false, "authMode": name }));
        // The read API and the management routes are open; the proxy guards them.
        for path in ["/api/v1/sessions", "/api/v1/facets", "/api/v1/devices", "/api/v1/pairings", "/api/v1/auth/sessions"] {
            assert_eq!(Req::get(path).send(&a).await.status, StatusCode::OK, "{name} {path}");
        }
        assert_eq!(login(&a, "anything").await.json(), json!({ "authenticated": true }));
    }
}

#[tokio::test]
async fn management_routes_need_a_login_in_password_mode() {
    let env = env();
    let a = app(&env, config(&env));
    let requests = [
        Req::get("/api/v1/sessions"),
        Req::get("/api/v1/auth/sessions"),
        Req::delete("/api/v1/auth/sessions/0123456789ab"),
        Req::post("/api/v1/auth/sessions/revoke-all", json!({})),
        Req::post("/api/v1/logout", json!({})),
        Req::get("/api/v1/devices"),
        Req::delete(&format!("/api/v1/devices/{DEVICE}")),
        Req::get("/api/v1/pairings"),
        Req::post("/api/v1/pairings/ABCD-EFGH/approve", json!({})),
        Req::post("/api/v1/pairings/ABCD-EFGH/deny", json!({})),
    ];
    for r in requests {
        let r = r.cookie("pika_session=forged").send(&a).await;
        assert_eq!((r.status, r.json()), (StatusCode::UNAUTHORIZED, json!({ "error": "unauthorized" })));
    }
    // Health, ingest, and pairing stay open.
    assert_eq!(Req::get("/api/health").send(&a).await.status, StatusCode::OK);
    assert_eq!(Req::post(INGEST, batch("x")).send(&a).await.status, StatusCode::UNAUTHORIZED);
    assert_eq!(Req::post("/api/pair/v1/start", json!({ "device": "box" })).send(&a).await.status, StatusCode::OK);
}

#[tokio::test]
async fn devices_can_be_listed_and_revoked() {
    let env = env();
    let token = pika::auth::create_token(&env.store, DEVICE).unwrap();
    pika::auth::create_token(&env.store, "desktop").unwrap();
    let a = app(&env, config(&env));
    let cookie = logged_in(&a).await;

    let r = Req::get("/api/v1/devices").cookie(&cookie).send(&a).await;
    let items = r.json()["items"].as_array().unwrap().clone();
    assert_eq!(items.iter().map(|d| d["name"].clone()).collect::<Vec<_>>(), [json!("desktop"), json!(DEVICE)]);
    assert_eq!(items[1]["createdVia"], "cli");
    assert!(items[1].get("lastSeenAt").is_none() && items[1].get("lastHost").is_none());

    // Ingest records the device's last upload at most once a minute.
    assert_eq!(ingest_with(&a, &token, "laptop.lan").await, StatusCode::OK);
    let r = Req::get("/api/v1/devices").cookie(&cookie).send(&a).await;
    let laptop = r.json()["items"][1].clone();
    assert_eq!(laptop["lastHost"], "laptop.lan");
    assert!(laptop["lastSeenAt"].as_str().unwrap().ends_with('Z'));
    let recent = pika::util::now_ms() - 30_000;
    set_sql(&env, &format!("UPDATE tokens SET last_seen_at = {recent} WHERE name = '{DEVICE}'"));
    assert_eq!(ingest_with(&a, &token, "elsewhere").await, StatusCode::OK);
    let row = one(&env.store, &format!("SELECT last_seen_at, last_host FROM tokens WHERE name = '{DEVICE}'"));
    assert_eq!((row["last_seen_at"].as_i64().unwrap(), &row["last_host"]), (recent, &json!("laptop.lan")));
    let stale = pika::util::now_ms() - 61_000;
    set_sql(&env, &format!("UPDATE tokens SET last_seen_at = {stale} WHERE name = '{DEVICE}'"));
    assert_eq!(ingest_with(&a, &token, "elsewhere").await, StatusCode::OK);
    let row = one(&env.store, &format!("SELECT last_seen_at, last_host FROM tokens WHERE name = '{DEVICE}'"));
    assert!(row["last_seen_at"].as_i64().unwrap() > stale + 60_000);
    assert_eq!(row["last_host"], "elsewhere");

    // `pika token list` shows it too.
    let out = pika(&env.dir.path().join("data")).args(["token", "list"]).output().unwrap();
    let listing = String::from_utf8(out.stdout).unwrap();
    let line = listing.lines().find(|l| l.starts_with("laptop\t")).unwrap();
    let fields: Vec<&str> = line.split('\t').collect();
    assert_eq!((fields.len(), fields[2], fields[4]), (5, "cli", "elsewhere"), "{line}");
    assert!(fields[3].ends_with('Z'), "{line}");
    assert!(listing.lines().any(|l| l.starts_with("desktop\t") && l.ends_with("\tcli\tnever\t-")), "{listing}");

    // Revoking refuses the token at once.
    let r = Req::delete(&format!("/api/v1/devices/{DEVICE}")).cookie(&cookie).send(&a).await;
    assert_eq!(r.status, StatusCode::NO_CONTENT);
    assert_eq!(ingest_with(&a, &token, "laptop.lan").await, StatusCode::UNAUTHORIZED);
    let r = Req::delete(&format!("/api/v1/devices/{DEVICE}")).cookie(&cookie).send(&a).await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);
}

async fn start(a: &Router, ip: &str, body: Value) -> Reply {
    Req::post("/api/pair/v1/start", body).peer(ip).send(a).await
}

async fn poll(a: &Router, pairing_id: &str) -> Reply {
    Req::post("/api/pair/v1/poll", json!({ "pairingId": pairing_id })).send(a).await
}

fn is_code(code: &str) -> bool {
    let alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    code.len() == 9
        && code.char_indices().all(|(i, c)| if i == 4 { c == '-' } else { alphabet.contains(c) })
}

#[tokio::test]
async fn pairing_start_validates_and_limits() {
    let env = env();
    let a = app(&env, config(&env));
    let invalid = [
        json!({}),
        json!({ "device": "" }),
        json!({ "device": "a".repeat(65) }),
        json!({ "device": "has space" }),
        json!({ "device": "ümlaut" }),
        json!({ "device": 7 }),
        json!({ "device": "box", "host": "h".repeat(256) }),
    ];
    for body in invalid {
        let r = start(&a, "10.0.0.1", body.clone()).await;
        assert_eq!((r.status, r.json()), (StatusCode::BAD_REQUEST, json!({ "error": "invalid_device" })), "{body}");
    }
    let r = Req::form("/api/pair/v1/start", "device=box").send(&a).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);

    let r = start(&a, "10.0.0.1", json!({ "device": "a".repeat(64), "host": "h".repeat(255), "pikaVersion": "0.2.0" })).await;
    assert_eq!(r.status, StatusCode::OK);
    let body = r.json();
    let keys: Vec<&str> = body.as_object().unwrap().keys().map(String::as_str).collect();
    assert_eq!(keys, ["pairingId", "code", "expiresAt", "expiresIn", "interval"]);
    assert_eq!(body["pairingId"].as_str().unwrap().len(), 43);
    assert!(is_code(body["code"].as_str().unwrap()), "{body}");
    assert_eq!((&body["expiresIn"], &body["interval"]), (&json!(600), &json!(2)));
    assert!(body["expiresAt"].as_str().unwrap().ends_with('Z'));

    // Five starts per client IP in ten minutes.
    for _ in 0..4 {
        assert_eq!(start(&a, "10.0.0.1", json!({ "device": "box" })).await.status, StatusCode::OK);
    }
    let r = start(&a, "10.0.0.1", json!({ "device": "box" })).await;
    assert_eq!(r.status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(r.json()["error"], "too_many_attempts");
    let retry = r.json()["retryAfter"].as_u64().unwrap();
    assert!((599..=600).contains(&retry), "{retry}");
    assert_eq!(r.headers[header::RETRY_AFTER].to_str().unwrap(), retry.to_string());

    // Ten pending pairings at a time.
    for _ in 0..5 {
        assert_eq!(start(&a, "10.0.0.2", json!({ "device": "box" })).await.status, StatusCode::OK);
    }
    // Starts refused for too many pairings do not count against the client.
    for _ in 0..6 {
        let r = start(&a, "10.0.0.3", json!({ "device": "box" })).await;
        assert_eq!((r.status, r.json()), (StatusCode::TOO_MANY_REQUESTS, json!({ "error": "too_many_pairings" })));
    }
    let codes: Vec<String> = query(&env.store, "SELECT code FROM pairings").iter().map(|r| r["code"].to_string()).collect();
    assert_eq!(codes.len(), 10);
    assert_eq!(codes.iter().collect::<std::collections::BTreeSet<_>>().len(), 10);
    // Expired pairings no longer count.
    set_sql(&env, &format!("UPDATE pairings SET expires_at = {}", pika::util::now_ms() - 1));
    assert_eq!(start(&a, "10.0.0.3", json!({ "device": "box" })).await.status, StatusCode::OK);
    // Long-expired ones are deleted.
    set_sql(&env, "UPDATE pairings SET expires_at = 1");
    assert_eq!(start(&a, "10.0.0.4", json!({ "device": "box" })).await.status, StatusCode::OK);
    assert_eq!(query(&env.store, "SELECT * FROM pairings").len(), 1);
}

#[tokio::test]
async fn an_approved_pairing_hands_out_its_token_once() {
    let env = env();
    let mut c = config(&env);
    c.base_path = "/pika".into();
    let a = router(AppState::new(env.store.clone(), c).unwrap());
    let r = Req::post("/pika/api/pair/v1/start", json!({ "device": "work-laptop", "host": "wl.lan", "pikaVersion": "0.2.0" }))
        .peer("10.9.0.1")
        .send(&a)
        .await;
    assert_eq!(r.status, StatusCode::OK);
    let pairing_id = r.json()["pairingId"].as_str().unwrap().to_owned();
    let code = r.json()["code"].as_str().unwrap().to_owned();
    assert!(!contains(&db_bytes(&env), &pairing_id));

    assert_eq!(Req::get("/pika/api/v1/pairings").send(&a).await.status, StatusCode::UNAUTHORIZED);
    let r = Req::post("/pika/api/v1/login", json!({ "password": PASSWORD })).send(&a).await;
    let cookie = r.cookie();
    let r = Req::get("/pika/api/v1/pairings").cookie(&cookie).send(&a).await;
    let items = r.json()["items"].as_array().unwrap().clone();
    assert_eq!(items.len(), 1);
    let item = &items[0];
    assert_eq!(
        (&item["code"], &item["device"], &item["host"], &item["ip"], &item["pikaVersion"], &item["deviceExists"]),
        (&json!(code), &json!("work-laptop"), &json!("wl.lan"), &json!("10.9.0.1"), &json!("0.2.0"), &json!(false))
    );
    assert!(item["requestedAt"].as_str().unwrap() < item["expiresAt"].as_str().unwrap());

    let pending = Req::post("/pika/api/pair/v1/poll", json!({ "pairingId": pairing_id })).send(&a).await;
    assert_eq!((pending.status, pending.json()), (StatusCode::OK, json!({ "status": "pending" })));

    // Codes match without the hyphen and in any case.
    let loose = code.replace('-', "").to_lowercase();
    let r = Req::post(&format!("/pika/api/v1/pairings/{loose}/approve"), json!({})).cookie(&cookie).send(&a).await;
    assert_eq!((r.status, r.json()), (StatusCode::OK, json!({ "device": "work-laptop" })));
    let r = Req::get("/pika/api/v1/pairings").cookie(&cookie).send(&a).await;
    assert_eq!(r.json()["items"], json!([]));
    let r = Req::post(&format!("/pika/api/v1/pairings/{code}/approve"), json!({})).cookie(&cookie).send(&a).await;
    assert_eq!((r.status, r.json()), (StatusCode::NOT_FOUND, json!({ "error": "unknown_pairing" })));
    // No token exists until the device polls.
    assert!(query(&env.store, "SELECT * FROM tokens WHERE name = 'work-laptop'").is_empty());

    let r = Req::post("/pika/api/pair/v1/poll", json!({ "pairingId": pairing_id })).send(&a).await;
    assert_eq!(r.status, StatusCode::OK);
    let body = r.json();
    assert_eq!((&body["status"], &body["device"]), (&json!("approved"), &json!("work-laptop")));
    let token = body["token"].as_str().unwrap().to_owned();
    assert!(token.starts_with("pika_"));
    let r = Req::post("/pika/api/pair/v1/poll", json!({ "pairingId": pairing_id })).send(&a).await;
    assert_eq!((r.status, r.json()), (StatusCode::NOT_FOUND, json!({ "error": "unknown_pairing" })));

    let r = Req::post("/pika/api/ingest/v1/batch", batch("wl.lan")).header("authorization", &format!("Bearer {token}")).send(&a).await;
    assert_eq!(r.status, StatusCode::OK);
    let row = one(&env.store, "SELECT created_via, hash, last_host FROM tokens WHERE name = 'work-laptop'");
    assert_eq!((&row["created_via"], &row["last_host"]), (&json!("pairing"), &json!("wl.lan")));
    assert_eq!(row["hash"], json!(pika::util::sha256_hex(token.as_bytes())));
    // Neither secret was ever written to the database.
    let bytes = db_bytes(&env);
    assert!(!contains(&bytes, &token) && !contains(&bytes, &token["pika_".len()..]));
    assert!(!contains(&bytes, &pairing_id));
}

#[tokio::test]
async fn pairings_can_be_denied_or_expire() {
    let env = env();
    let a = app(&env, config(&env));
    let cookie = logged_in(&a).await;
    let r = start(&a, "10.0.0.1", json!({ "device": "box" })).await;
    let (id, code) = (r.json()["pairingId"].as_str().unwrap().to_owned(), r.json()["code"].as_str().unwrap().to_owned());
    let r = Req::post(&format!("/api/v1/pairings/{code}/deny"), json!({})).cookie(&cookie).send(&a).await;
    assert_eq!(r.status, StatusCode::NO_CONTENT);
    let r = Req::post(&format!("/api/v1/pairings/{code}/deny"), json!({})).cookie(&cookie).send(&a).await;
    assert_eq!((r.status, r.json()), (StatusCode::NOT_FOUND, json!({ "error": "unknown_pairing" })));
    assert_eq!(poll(&a, &id).await.json(), json!({ "status": "denied" }));
    assert_eq!(poll(&a, &id).await.status, StatusCode::NOT_FOUND);

    let r = start(&a, "10.0.0.1", json!({ "device": "box" })).await;
    let (id, code) = (r.json()["pairingId"].as_str().unwrap().to_owned(), r.json()["code"].as_str().unwrap().to_owned());
    set_sql(&env, &format!("UPDATE pairings SET expires_at = {}", pika::util::now_ms() - 1));
    assert_eq!(Req::get("/api/v1/pairings").cookie(&cookie).send(&a).await.json()["items"], json!([]));
    let r = Req::post(&format!("/api/v1/pairings/{code}/approve"), json!({})).cookie(&cookie).send(&a).await;
    assert_eq!((r.status, r.json()), (StatusCode::NOT_FOUND, json!({ "error": "unknown_pairing" })));
    let r = Req::post(&format!("/api/v1/pairings/{code}/deny"), json!({})).cookie(&cookie).send(&a).await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);
    assert_eq!(poll(&a, &id).await.json(), json!({ "status": "expired" }));
    assert_eq!(poll(&a, &id).await.status, StatusCode::NOT_FOUND);

    // Unknown ids and codes.
    let r = poll(&a, "not-a-pairing").await;
    assert_eq!((r.status, r.json()), (StatusCode::NOT_FOUND, json!({ "error": "unknown_pairing" })));
    assert_eq!(Req::post("/api/pair/v1/poll", json!({})).send(&a).await.status, StatusCode::NOT_FOUND);
    for code in ["ZZZZ-ZZZZ", "nonsense"] {
        let r = Req::post(&format!("/api/v1/pairings/{code}/approve"), json!({})).cookie(&cookie).send(&a).await;
        assert_eq!(r.status, StatusCode::NOT_FOUND, "{code}");
    }
}

#[tokio::test]
async fn approving_an_existing_device_name_needs_replace() {
    let env = env();
    let old = pika::auth::create_token(&env.store, DEVICE).unwrap();
    let a = app(&env, config(&env));
    let cookie = logged_in(&a).await;
    let r = start(&a, "10.0.0.1", json!({ "device": DEVICE })).await;
    let (id, code) = (r.json()["pairingId"].as_str().unwrap().to_owned(), r.json()["code"].as_str().unwrap().to_owned());
    let items = Req::get("/api/v1/pairings").cookie(&cookie).send(&a).await.json()["items"].clone();
    assert_eq!(items[0]["deviceExists"], true);

    let approve = |body: Value| {
        let (a, cookie, code) = (a.clone(), cookie.clone(), code.clone());
        async move { Req::post(&format!("/api/v1/pairings/{code}/approve"), body).cookie(&cookie).send(&a).await }
    };
    let r = approve(json!({})).await;
    assert_eq!((r.status, r.json()), (StatusCode::CONFLICT, json!({ "error": "device_exists" })));
    let r = approve(json!({ "replace": false })).await;
    assert_eq!(r.status, StatusCode::CONFLICT);
    let r = approve(json!({ "name": "bad name" })).await;
    assert_eq!((r.status, r.json()), (StatusCode::BAD_REQUEST, json!({ "error": "invalid_device" })));
    let r = approve(json!({ "replace": true })).await;
    assert_eq!((r.status, r.json()), (StatusCode::OK, json!({ "device": DEVICE })));
    // The old token works until the device collects the new one.
    assert_eq!(ingest_with(&a, &old, "x").await, StatusCode::OK);
    let token = poll(&a, &id).await.json()["token"].as_str().unwrap().to_owned();
    assert_eq!(ingest_with(&a, &old, "x").await, StatusCode::UNAUTHORIZED);
    assert_eq!(ingest_with(&a, &token, "x").await, StatusCode::OK);
    assert_eq!(one(&env.store, &format!("SELECT created_via FROM tokens WHERE name = '{DEVICE}'"))["created_via"], "pairing");

    // Another name avoids the conflict.
    let r = start(&a, "10.0.0.1", json!({ "device": DEVICE })).await;
    let (id, code) = (r.json()["pairingId"].as_str().unwrap().to_owned(), r.json()["code"].as_str().unwrap().to_owned());
    let r = Req::post(&format!("/api/v1/pairings/{code}/approve"), json!({ "name": "laptop-2" })).cookie(&cookie).send(&a).await;
    assert_eq!(r.json(), json!({ "device": "laptop-2" }));
    // A token of that name created after the approval wins; the device is told it was denied.
    pika::auth::create_token(&env.store, "laptop-2").unwrap();
    assert_eq!(poll(&a, &id).await.json(), json!({ "status": "denied" }));
}

#[test]
fn upgrading_from_version_3_keeps_tokens_and_does_not_reindex() {
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");
    {
        let store = pika::store::Store::open(&data).unwrap();
        pika::auth::create_token(&store, DEVICE).unwrap();
    }
    let conn = rusqlite::Connection::open(data.join("pika.db")).unwrap();
    conn.execute_batch(&format!("{UNDO_V4} PRAGMA user_version = 3;")).unwrap();
    drop(conn);
    let store = pika::store::Store::open(&data).unwrap();
    assert_eq!(store.setting("needs_reindex").unwrap(), None);
    let row = one(&store, "SELECT name, created_via, last_seen_at FROM tokens");
    assert_eq!((&row["name"], &row["created_via"], &row["last_seen_at"]), (&json!(DEVICE), &json!("cli"), &Value::Null));
    let version: i64 = store.read(|c| c.pragma_query_value(None, "user_version", |r| r.get(0))).unwrap();
    assert_eq!(version, 4);
}

#[test]
fn polls_for_unknown_or_pending_pairings_do_not_wait_for_the_writer() {
    let env = env();
    let now = pika::util::now_ms();
    let request = pika::pairing::Request { device: "box", host: None, ip: None, pika_version: None };
    let pairing_id = pika::pairing::start(&env.store, &request, now).unwrap().unwrap().pairing_id;
    let (held, wait_held) = mpsc::channel();
    let (release, wait_release) = mpsc::channel::<()>();
    let store = env.store.clone();
    let holder = std::thread::spawn(move || {
        store
            .write(|_| {
                held.send(()).unwrap();
                wait_release.recv().unwrap();
                Ok::<_, rusqlite::Error>(())
            })
            .unwrap()
    });
    wait_held.recv().unwrap();
    let (done, answers) = mpsc::channel();
    let store = env.store.clone();
    std::thread::spawn(move || {
        let unknown = pika::pairing::poll(&store, "not-a-pairing", now).unwrap().is_none();
        let pending = matches!(pika::pairing::poll(&store, &pairing_id, now).unwrap(), Some(pika::pairing::Poll::Pending));
        done.send((unknown, pending)).unwrap();
    });
    let answered = answers.recv_timeout(Duration::from_secs(2));
    release.send(()).unwrap();
    holder.join().unwrap();
    assert_eq!(answered, Ok((true, true)));
}

/// Starts `pika serve` with `PIKA_AUTH=none` and `env`; returns its listening line, or its exit status and error output
/// when it does not start.
fn serve_with(data: &std::path::Path, env: &[(&str, &str)]) -> Result<String, String> {
    let mut command = pika(data);
    command.args(["serve", "--bind", "127.0.0.1:0"]).env("PIKA_AUTH", "none").envs(env.iter().copied());
    let mut child = command.stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
    let listening =
        BufReader::new(child.stdout.take().unwrap()).lines().map_while(Result::ok).find(|l| l.contains("listening on"));
    if let Some(line) = listening {
        child.kill().unwrap();
        child.wait().unwrap();
        return Ok(line);
    }
    let out = child.wait_with_output().unwrap();
    Err(format!("{:?}: {}", out.status.code(), String::from_utf8_lossy(&out.stderr)))
}

#[test]
fn trust_proxy_accepts_only_switch_values() {
    let env = env();
    let data = env.dir.path().join("cli");
    for value in ["1", "true", "YES", "on"] {
        let line = serve_with(&data, &[("PIKA_TRUST_PROXY", value)]).unwrap();
        assert!(line.contains("trusting X-Forwarded-For"), "{value}: {line}");
    }
    for value in ["", "0", "false", "No", "off"] {
        let line = serve_with(&data, &[("PIKA_TRUST_PROXY", value)]).unwrap();
        assert!(!line.contains("trusting"), "{value:?}: {line}");
    }
    for value in ["maybe", "2", "enabled"] {
        let e = serve_with(&data, &[("PIKA_TRUST_PROXY", value)]).unwrap_err();
        assert!(e.starts_with("Some(2): ") && e.contains(&format!("invalid value '{value}' for '--trust-proxy'")), "{e}");
    }
}
