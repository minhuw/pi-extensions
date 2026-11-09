mod common;
use axum::{
    Router,
    body::Body,
    extract::ConnectInfo,
    http::{Request, StatusCode, header},
};
use common::*;
use pika::{
    config::{AuthMode, ServerConfig, VisitorAnalytics},
    http::{AppState, router},
};
use serde_json::{Value, json};
use tower::ServiceExt;

fn app(env: &Env, mode: VisitorAnalytics, auth: AuthMode) -> Router {
    app_with_proxy(env, mode, auth, true)
}

fn app_with_proxy(env: &Env, mode: VisitorAnalytics, auth: AuthMode, trust_proxy: bool) -> Router {
    let mut cfg = ServerConfig::new(env.dir.path());
    cfg.auth = auth;
    cfg.password = Some("a sufficiently long password".into());
    cfg.trust_proxy = trust_proxy;
    cfg.visitor_analytics = mode;
    router(AppState::new(env.store.clone(), cfg).unwrap())
}

async fn send(
    app: &Router,
    body: Value,
    peer: Option<&str>,
    headers: &[(&str, &str)],
) -> StatusCode {
    let mut req = Request::post("/api/public/v1/visitor-view")
        .header(header::CONTENT_TYPE, "application/json");
    for (key, value) in headers {
        req = req.header(*key, *value);
    }
    let mut req = req.body(Body::from(body.to_string())).unwrap();
    if let Some(peer) = peer {
        req.extensions_mut()
            .insert(ConnectInfo(peer.parse::<std::net::SocketAddr>().unwrap()));
    }
    let response = app.clone().oneshot(req).await.unwrap();
    assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    response.status()
}

async fn report(app: &Router) -> Value {
    let response = app
        .clone()
        .oneshot(
            Request::get("/api/v1/visitor-origins")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    serde_json::from_slice(
        &axum::body::to_bytes(response.into_body(), 100_000)
            .await
            .unwrap(),
    )
    .unwrap()
}

#[tokio::test]
async fn analytics_are_enabled_by_default_and_can_be_disabled() {
    let env = env();
    let mut cfg = ServerConfig::new(env.dir.path());
    cfg.auth = AuthMode::None;
    assert_eq!(VisitorAnalytics::default(), VisitorAnalytics::Auto);
    assert_eq!(cfg.visitor_analytics, VisitorAnalytics::Auto);
    let enabled = router(AppState::new(env.store.clone(), cfg.clone()).unwrap());
    assert_eq!(send(&enabled, json!({"page":"gallery"}), Some("192.0.2.1:1234"), &[]).await, StatusCode::NO_CONTENT);
    let data = report(&enabled).await;
    assert_eq!(data["mode"], "auto");
    assert_eq!(data["views"], 1);
    assert_eq!(data["dailyVisitors"], 1);

    cfg.visitor_analytics = VisitorAnalytics::Off;
    let disabled = router(AppState::new(env.store.clone(), cfg).unwrap());
    assert_eq!(send(&disabled, json!({"page":"gallery"}), Some("192.0.2.2:1234"), &[]).await, StatusCode::NO_CONTENT);
    let data = report(&disabled).await;
    assert_eq!(data["mode"], "off");
    assert_eq!(data["views"], 1);
}

#[test]
fn cli_advertises_automatic_analytics_by_default() {
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_pika"))
        .args(["serve", "--help"])
        .env_remove("PIKA_VISITOR_ANALYTICS")
        .output()
        .unwrap();
    assert!(output.status.success());
    let help = String::from_utf8(output.stdout).unwrap();
    let option = help.split("--visitor-analytics").nth(1).expect("visitor analytics option");
    assert!(option.split("--max-body").next().unwrap().contains("[default: auto]"), "{option}");
}

#[tokio::test]
async fn views_are_published_deduplicated_and_bounded() {
    let env = env();
    env.store.write(|tx| {
        tx.execute_batch("INSERT INTO sessions (sid,id,device,project) VALUES (1,'s1','d','one'),(2,'s2','d','two'),(3,'private','d','hidden'); INSERT INTO settings VALUES ('published_projects', CAST('[\"one\",\"two\"]' AS BLOB));")
    }).unwrap();
    let app = app(&env, VisitorAnalytics::Cloudflare, AuthMode::None);
    let h = [
        ("cf-connecting-ip", "2001:db8::1"),
        ("cf-ipcountry", "US"),
        ("user-agent", "test"),
    ];
    for body in [
        json!({"page":"gallery"}),
        json!({"page":"gallery","project":"one"}),
        json!({"page":"session","sessionId":"s2"}),
        json!({"page":"session","sessionId":"s2"}),
        json!({"page":"session","sessionId":"private"}),
        json!({"page":"gallery","project":"hidden"}),
        json!({"page":"session","sessionId":"missing"}),
    ] {
        assert_eq!(send(&app, body, None, &h).await, StatusCode::NO_CONTENT);
    }
    assert_eq!(
        send(
            &app,
            json!({"page":"session","sessionId":"s1","project":"two"}),
            None,
            &h
        )
        .await,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        send(&app, json!({"page":"session","sessionId":""}), None, &h).await,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        send(
            &app,
            json!({"page":"gallery"}),
            None,
            &[("cf-ipcountry", "XX")]
        )
        .await,
        StatusCode::NO_CONTENT
    );
    let data = report(&app).await;
    assert_eq!(data["views"], 5);
    assert_eq!(data["dailyVisitors"], 1);
    assert_eq!(data["daily"].as_array().unwrap().len(), 30);
    assert_eq!(
        data["projects"][0],
        json!({"project":"two","views":2,"dailyVisitors":1})
    );
    assert_eq!(
        data["countries"][0],
        json!({"country":"US","views":4,"dailyVisitors":1})
    );
    assert_eq!(
        data["countries"][1],
        json!({"country":null,"views":1,"dailyVisitors":0})
    );
    let rows = query(&env.store, "SELECT visitor FROM visitor_views");
    assert!(
        rows.iter()
            .all(|r| !r["visitor"].as_str().unwrap().contains("2001"))
    );
}

#[tokio::test]
async fn boundaries_trust_and_retention() {
    let env = env();
    let mut cfg = ServerConfig::new(env.dir.path());
    cfg.auth = AuthMode::None;
    for mode in [VisitorAnalytics::Proxy, VisitorAnalytics::Cloudflare] {
        cfg.visitor_analytics = mode;
        assert!(AppState::new(env.store.clone(), cfg.clone()).is_err());
    }
    let off = app(&env, VisitorAnalytics::Off, AuthMode::Password);
    assert_eq!(
        send(&off, json!({"page":"gallery"}), Some("127.0.0.1:1234"), &[]).await,
        StatusCode::NO_CONTENT
    );
    let response = off
        .clone()
        .oneshot(
            Request::get("/api/v1/visitor-origins")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    let response = off
        .oneshot(
            Request::get("/api/public/v1/visitor-origins")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    assert_eq!(
        one(&env.store, "SELECT COUNT(*) AS n FROM visitor_views")["n"],
        0
    );
    let direct = app(&env, VisitorAnalytics::Direct, AuthMode::None);
    for forwarded in ["1.1.1.1", "2.2.2.2"] {
        send(
            &direct,
            json!({"page":"gallery"}),
            Some("[::1]:1234"),
            &[("x-forwarded-for", forwarded)],
        )
        .await;
    }
    assert_eq!(report(&direct).await["dailyVisitors"], 1);
    let proxy = app(&env, VisitorAnalytics::Proxy, AuthMode::None);
    send(
        &proxy,
        json!({"page":"gallery"}),
        Some("127.0.0.1:1"),
        &[("x-forwarded-for", "1.1.1.1, 2001:db8::2")],
    )
    .await;
    send(
        &proxy,
        json!({"page":"gallery"}),
        Some("127.0.0.1:1"),
        &[("x-forwarded-for", "2001:0db8:0:0::2")],
    )
    .await;
    assert_eq!(report(&proxy).await["dailyVisitors"], 2);
    let cf = app(&env, VisitorAnalytics::Cloudflare, AuthMode::None);
    send(
        &cf,
        json!({"page":"gallery"}),
        Some("127.0.0.1:1"),
        &[
            ("cf-connecting-ip", "1.1.1.1"),
            ("cf-connecting-ip", "2.2.2.2"),
            ("cf-ipcountry", "US"),
            ("cf-ipcountry", "GB"),
        ],
    )
    .await;
    send(
        &cf,
        json!({"page":"gallery"}),
        None,
        &[
            ("cf-connecting-ip", "1.1.1.1, 2.2.2.2"),
            ("cf-ipcountry", "T1"),
        ],
    )
    .await;
    assert_eq!(report(&cf).await["dailyVisitors"], 2);
    env.store.write(|tx| tx.execute_batch("INSERT INTO visitor_views VALUES(date('now','-30 days'),'','',x'01',1); INSERT INTO visitor_day_key(day, key) VALUES(date('now','-1 day'),x'01');")).unwrap();
    // Startup performs retention even if no analytics events arrive.
    let _ = app(&env, VisitorAnalytics::Off, AuthMode::None);
    assert_eq!(
        one(
            &env.store,
            "SELECT COUNT(*) AS n FROM visitor_views WHERE day < date('now','-29 days')"
        )["n"],
        0
    );
    assert_eq!(
        one(
            &env.store,
            "SELECT COUNT(*) AS n FROM visitor_day_key WHERE day <> date('now')"
        )["n"],
        0
    );
}

#[test]
fn auto_mode_accepts_convenient_on_aliases() {
    use clap::ValueEnum;
    for name in ["auto", "on", "1", "true", "yes"] {
        assert_eq!(VisitorAnalytics::from_str(name, true).unwrap(), VisitorAnalytics::Auto);
    }
    for name in ["off", "0", "false", "no"] {
        assert_eq!(VisitorAnalytics::from_str(name, true).unwrap(), VisitorAnalytics::Off);
    }
    assert!(VisitorAnalytics::from_str("maybe", true).is_err());
    assert_eq!(serde_json::to_value(VisitorAnalytics::Auto).unwrap(), "auto");
}

#[tokio::test]
async fn automatic_source_respects_the_proxy_trust_boundary() {
    let env = env();
    let direct = app_with_proxy(&env, VisitorAnalytics::Auto, AuthMode::None, false);
    for fake in ["198.51.100.1", "198.51.100.2"] {
        assert_eq!(send(&direct, json!({"page":"gallery"}), Some("192.0.2.10:1234"), &[
            ("x-forwarded-for", fake), ("cf-connecting-ip", fake), ("cf-ipcountry", "US")
        ]).await, StatusCode::NO_CONTENT);
    }
    let data = report(&direct).await;
    assert_eq!(data["mode"], "auto");
    assert_eq!(data["views"], 2);
    assert_eq!(data["dailyVisitors"], 1);
    assert_eq!(data["countries"], json!([{ "country": null, "views": 2, "dailyVisitors": 1 }]));
}

#[tokio::test]
async fn automatic_source_detects_cloudflare_and_trusted_proxies() {
    let env = env();
    let app = app(&env, VisitorAnalytics::Auto, AuthMode::None);
    let requests: Vec<Vec<(&str, &str)>> = vec![
        // Ordinary proxy: the rightmost forwarded address is the visitor.
        vec![("x-forwarded-for", "203.0.113.99, 198.51.100.1")],
        // Cloudflare's address agrees with the proxy's address, including canonical IPv4-mapped IPv6.
        vec![("x-forwarded-for", "203.0.113.2"), ("cf-connecting-ip", "::ffff:203.0.113.2"), ("cf-ipcountry", "US")],
        vec![("x-forwarded-for", "::ffff:203.0.113.2"), ("cf-connecting-ip", "203.0.113.2"), ("cf-ipcountry", "US")],
        // Mismatched, absent, or duplicated Cloudflare headers never override the trusted IP or country.
        vec![("x-forwarded-for", "203.0.113.2"), ("cf-connecting-ip", "203.0.113.9"), ("cf-ipcountry", "GB")],
        vec![("cf-connecting-ip", "203.0.113.9"), ("cf-ipcountry", "GB")],
        vec![("x-forwarded-for", "203.0.113.2"), ("cf-connecting-ip", "203.0.113.2"), ("cf-connecting-ip", "203.0.113.2"), ("cf-ipcountry", "GB")],
        vec![("x-forwarded-for", "not-an-ip"), ("cf-connecting-ip", "203.0.113.9"), ("cf-ipcountry", "US")],
        vec![("x-forwarded-for", "203.0.113.2"), ("cf-connecting-ip", "203.0.113.2"), ("cf-ipcountry", "US"), ("cf-ipcountry", "GB")],
        vec![("x-forwarded-for", "2001:db8::1"), ("cf-connecting-ip", "2001:0db8::1"), ("cf-ipcountry", "GB")],
    ];
    for headers in requests {
        assert_eq!(send(&app, json!({"page":"gallery"}), Some("127.0.0.1:1234"), &headers).await, StatusCode::NO_CONTENT);
    }
    let data = report(&app).await;
    assert_eq!(data["views"], 9);
    assert_eq!(data["dailyVisitors"], 4);
    assert_eq!(data["countries"], json!([
        {"country":null,"views":6,"dailyVisitors":3},
        {"country":"US","views":2,"dailyVisitors":1},
        {"country":"GB","views":1,"dailyVisitors":1}
    ]));
}

#[tokio::test]
async fn tailnet_views_are_ignored() {
    let env = env();
    let direct = app(&env, VisitorAnalytics::Direct, AuthMode::None);
    // More than the per-client limit: ignored views are neither recorded nor rate limited.
    for _ in 0..61 {
        assert_eq!(send(&direct, json!({"page":"gallery"}), Some("100.101.102.103:1"), &[]).await, StatusCode::NO_CONTENT);
    }
    for peer in ["100.64.0.0:1", "100.127.255.255:1", "[fd7a:115c:a1e0::1]:1", "[::ffff:100.100.1.1]:1"] {
        assert_eq!(send(&direct, json!({"page":"gallery"}), Some(peer), &[]).await, StatusCode::NO_CONTENT);
    }
    // A trusted proxy's tailnet visitor, with or without Cloudflare headers, and a direct one without a forwarded address.
    let auto = app(&env, VisitorAnalytics::Auto, AuthMode::None);
    for (peer, headers) in [
        ("127.0.0.1:1", vec![("x-forwarded-for", "203.0.113.1, 100.101.102.103")]),
        ("127.0.0.1:1", vec![("x-forwarded-for", "fd7a:115c:a1e0:ab12::1"), ("cf-connecting-ip", "fd7a:115c:a1e0:ab12::1"), ("cf-ipcountry", "US")]),
        ("100.101.102.103:1", vec![]),
    ] {
        assert_eq!(send(&auto, json!({"page":"gallery"}), Some(peer), &headers).await, StatusCode::NO_CONTENT);
    }
    assert_eq!(one(&env.store, "SELECT COUNT(*) AS n FROM visitor_views")["n"], 0);

    // Neighbouring ranges, loopback, and LAN addresses still count.
    for peer in ["100.63.255.255:1", "100.128.0.0:1", "[fd7a:115c:a1e1::1]:1", "127.0.0.1:1", "192.168.1.2:1"] {
        assert_eq!(send(&direct, json!({"page":"gallery"}), Some(peer), &[]).await, StatusCode::NO_CONTENT);
    }
    let data = report(&direct).await;
    assert_eq!(data["views"], 5);
    assert_eq!(data["dailyVisitors"], 5);
}

#[tokio::test]
async fn forged_cloudflare_ips_cannot_bypass_automatic_rate_limits() {
    let env = env();
    let app = app(&env, VisitorAnalytics::Auto, AuthMode::None);
    for i in 0..61 {
        let fake = format!("203.0.113.{}", i + 1);
        let status = send(&app, json!({"page":"gallery"}), Some("127.0.0.1:1234"), &[
            ("x-forwarded-for", "198.51.100.1"), ("cf-connecting-ip", &fake), ("cf-ipcountry", "US")
        ]).await;
        assert_eq!(status, if i < 60 { StatusCode::NO_CONTENT } else { StatusCode::TOO_MANY_REQUESTS });
    }
    let data = report(&app).await;
    assert_eq!(data["views"], 60);
    assert_eq!(data["dailyVisitors"], 1);
    assert_eq!(data["countries"][0]["country"], Value::Null);
}

#[tokio::test]
async fn rejects_large_non_json_and_rate_limits_only_views() {
    let env = env();
    let app = app(&env, VisitorAnalytics::Direct, AuthMode::None);
    for request in [
        Request::post("/api/public/v1/visitor-view")
            .body(Body::from("{}".to_owned()))
            .unwrap(),
        Request::post("/api/public/v1/visitor-view")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(" ".repeat(4097)))
            .unwrap(),
    ] {
        let response = app.clone().oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    }
    for _ in 0..60 {
        assert_eq!(
            send(&app, json!({"page":"gallery"}), Some("127.0.0.1:10"), &[]).await,
            StatusCode::NO_CONTENT
        );
    }
    for _ in 0..6000 {
        assert_eq!(
            send(&app, json!({"page":"gallery"}), Some("127.0.0.1:10"), &[]).await,
            StatusCode::TOO_MANY_REQUESTS
        );
    }
    // One exhausted client cannot consume the global allowance for another client.
    assert_eq!(
        send(&app, json!({"page":"gallery"}), Some("127.0.0.2:10"), &[]).await,
        StatusCode::NO_CONTENT
    );
    assert_eq!(report(&app).await["views"], 61);
}

#[tokio::test]
async fn visitor_storage_is_bounded_and_does_not_depend_on_user_agent() {
    let env = env();
    let app = app(&env, VisitorAnalytics::Direct, AuthMode::None);
    for agent in ["browser one", "browser two", "browser three"] {
        assert_eq!(
            send(
                &app,
                json!({"page":"gallery"}),
                Some("192.0.2.1:1"),
                &[("user-agent", agent)]
            )
            .await,
            StatusCode::NO_CONTENT
        );
    }
    assert_eq!(
        one(&env.store, "SELECT COUNT(*) AS n FROM visitor_views")["n"],
        1
    );
    assert_eq!(report(&app).await["dailyVisitors"], 1);

    // Simulate the daily bound without filling the database. Existing visitors still deduplicate;
    // new visitors add views to the unidentifiable bucket instead of creating more digest rows.
    env.store
        .write(|tx| tx.execute("UPDATE visitor_day_key SET row_count=19999", []))
        .unwrap();
    assert_eq!(
        send(&app, json!({"page":"gallery"}), Some("192.0.2.2:1"), &[]).await,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        send(&app, json!({"page":"gallery"}), Some("192.0.2.1:1"), &[]).await,
        StatusCode::NO_CONTENT
    );
    let data = report(&app).await;
    assert_eq!(data["views"], 5);
    assert_eq!(data["dailyVisitors"], 1);
    assert_eq!(
        one(&env.store, "SELECT COUNT(*) AS n FROM visitor_views")["n"],
        2
    );
}

#[tokio::test]
async fn unidentified_buckets_obey_the_daily_row_limit() {
    let env = env();
    env.store.write(|tx| tx.execute_batch(
        "INSERT INTO sessions (sid,id,device,project) VALUES (1,'s1','d','one'); INSERT INTO settings VALUES ('published_projects', CAST('[\"one\"]' AS BLOB));"
    )).unwrap();
    let app = app(&env, VisitorAnalytics::Cloudflare, AuthMode::None);
    for country in ["US", "GB"] {
        assert_eq!(send(&app, json!({"page":"gallery"}), None, &[("cf-ipcountry", country)]).await, StatusCode::NO_CONTENT);
    }
    assert_eq!(one(&env.store, "SELECT row_count FROM visitor_day_key")["row_count"], 2);
    // Reserve the final row for overflow and send two previously unseen unidentified groups.
    env.store.write(|tx| tx.execute("UPDATE visitor_day_key SET row_count=19999", [])).unwrap();
    for country in ["GB", "US"] {
        assert_eq!(send(&app, json!({"page":"gallery","project":"one"}), None, &[("cf-ipcountry", country)]).await, StatusCode::NO_CONTENT);
    }
    assert_eq!(one(&env.store, "SELECT row_count FROM visitor_day_key")["row_count"], 20000);
    assert_eq!(one(&env.store, "SELECT COUNT(*) AS n FROM visitor_views")["n"], 3);
    let data = report(&app).await;
    assert_eq!(data["views"], 4);
    assert_eq!(data["dailyVisitors"], 0);
    assert_eq!(data["countries"][0], json!({"country":null,"views":2,"dailyVisitors":0}));
    assert_eq!(data["projects"], json!([]));
}

#[test]
fn upgrade_from_eight_preserves_existing_settings() {
    let env = env();
    env.store.write(|tx| tx.execute_batch(&format!("{} INSERT INTO settings VALUES('visitor_test',x'1234'); DROP TABLE visitor_views; DROP TABLE visitor_day_key; PRAGMA user_version=8;", common::UNDO_V10))).unwrap();
    let reopened = pika::store::Store::open(env.dir.path().join("data")).unwrap();
    assert_eq!(
        reopened.setting("visitor_test").unwrap(),
        Some(vec![0x12, 0x34])
    );
    assert_eq!(one(&reopened, "PRAGMA user_version")["user_version"], 16);
    assert_eq!(
        one(&reopened, "SELECT COUNT(*) AS n FROM visitor_views")["n"],
        0
    );
}
