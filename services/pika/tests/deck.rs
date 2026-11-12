//! Deck's owner routes (spec "Deck"): project keys for checkouts and the owner's name and collapsed state per key.

mod common;

use axum::Router;
use axum::body::Body;
use axum::http::{Method, Request, StatusCode, header};
use common::*;
use pika::config::{AuthMode, ServerConfig};
use pika::http::{AppState, router};
use serde_json::{Value, json};
use tower::ServiceExt;

const PASSWORD: &str = "correct horse battery";

struct App {
    env: Env,
    app: Router,
    /// The session cookie, in `password` mode.
    cookie: Option<String>,
    /// A device token and a node credential, which count for nothing here.
    device: String,
    credential: String,
    node: String,
}

/// A router with nodes on unless `configure` says otherwise, signed in when it uses `password` mode, a device
/// `laptop`, and a node `node01`.
async fn app_with(configure: impl FnOnce(&mut ServerConfig)) -> App {
    let env = env();
    let mut config = ServerConfig::new(env.dir.path().join("data"));
    config.auth = AuthMode::Password;
    config.password = Some(PASSWORD.into());
    config.nodes.enabled = true;
    configure(&mut config);
    let password = config.auth == AuthMode::Password;
    let device = common::device(&env.store, DEVICE);
    let created = pika::nodes::create_node(&env.store, "node01").unwrap();
    let app = router(AppState::new(env.store.clone(), config).unwrap());
    let mut app = App { env, app, cookie: None, device, credential: created.credential, node: created.id };
    if password {
        let r = app.call(Method::POST, "/api/v1/login", Auth::None, Some(json!({ "password": PASSWORD }))).await;
        assert_eq!(r.0, StatusCode::OK);
        app.cookie = Some(r.2.unwrap());
    }
    app
}

async fn app() -> App {
    app_with(|_| {}).await
}

#[derive(Clone, Copy)]
enum Auth<'a> {
    None,
    Cookie,
    Bearer(&'a str),
}

impl App {
    /// The status, JSON body (`Null` when not JSON), and the session cookie a response sets.
    async fn call(&self, method: Method, path: &str, auth: Auth<'_>, body: Option<Value>) -> (StatusCode, Value, Option<String>) {
        let mut request = Request::builder().method(method).uri(path);
        match auth {
            Auth::None => {}
            Auth::Cookie => request = request.header(header::COOKIE, self.cookie.as_deref().expect("signed in")),
            Auth::Bearer(token) => request = request.header(header::AUTHORIZATION, format!("Bearer {token}")),
        }
        let body = match body {
            Some(body) => {
                request = request.header(header::CONTENT_TYPE, "application/json");
                Body::from(body.to_string())
            }
            None => Body::empty(),
        };
        let response = self.app.clone().oneshot(request.body(body).unwrap()).await.unwrap();
        let status = response.status();
        let cookie = response
            .headers()
            .get(header::SET_COOKIE)
            .map(|v| v.to_str().unwrap().split(';').next().unwrap().to_owned());
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap();
        (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null), cookie)
    }

    /// An owner request with the session cookie, when there is one.
    async fn owner(&self, method: Method, path: &str, body: Option<Value>) -> (StatusCode, Value) {
        let auth = if self.cookie.is_some() { Auth::Cookie } else { Auth::None };
        let (status, body, _) = self.call(method, path, auth, body).await;
        (status, body)
    }

    async fn keys(&self, items: Value) -> (StatusCode, Value) {
        self.owner(Method::POST, "/api/v1/deck/project-keys", Some(json!({ "items": items }))).await
    }

    async fn patch(&self, key: &str, body: Value) -> (StatusCode, Value) {
        self.owner(Method::PATCH, &project_path(key), Some(body)).await
    }

    async fn projects(&self) -> Value {
        let (status, body) = self.owner(Method::GET, "/api/v1/deck/projects", None).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        body["projects"].clone()
    }
}

/// Percent-encodes everything but unreserved characters, so a key is one path segment or a query value.
fn encode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

fn project_path(key: &str) -> String {
    format!("/api/v1/deck/projects/{}", encode(key))
}

fn is_iso(value: &Value) -> bool {
    value.as_str().is_some_and(|s| s.ends_with('Z') && s.len() == "2026-11-12T00:00:00.000Z".len())
}

#[tokio::test]
async fn nodes_off_answers_404_before_authentication() {
    let app = app_with(|c| c.nodes.enabled = false).await;
    let disabled = json!({ "error": "nodes_disabled" });
    let key = project_path("local:widgets@node:n1");
    let routes = [
        (Method::POST, "/api/v1/deck/project-keys".to_owned(), Some(json!({ "items": [{ "node": "n1" }] }))),
        (Method::GET, "/api/v1/deck/projects".to_owned(), None),
        (Method::PATCH, key.clone(), Some(json!({ "collapsed": true }))),
        (Method::DELETE, key, None),
    ];
    for (method, path, body) in routes {
        for auth in [Auth::None, Auth::Cookie, Auth::Bearer(&app.device)] {
            let (status, answer, _) = app.call(method.clone(), &path, auth, body.clone()).await;
            assert_eq!((status, &answer), (StatusCode::NOT_FOUND, &disabled), "{method} {path}");
        }
    }
    assert!(query(&app.env.store, "SELECT * FROM deck_projects").is_empty());
}

#[tokio::test]
async fn routes_need_the_owner_session_and_refuse_device_tokens_and_node_credentials() {
    let app = app().await;
    let unauthorized = json!({ "error": "unauthorized" });
    let key = project_path("local:widgets@node:n1");
    let routes = [
        (Method::POST, "/api/v1/deck/project-keys".to_owned(), Some(json!({ "items": [{ "node": "n1", "project": "w" }] }))),
        (Method::GET, "/api/v1/deck/projects".to_owned(), None),
        (Method::PATCH, key.clone(), Some(json!({ "collapsed": true }))),
        (Method::DELETE, key, None),
    ];
    for (method, path, body) in routes {
        let before = query(&app.env.store, "SELECT * FROM deck_projects");
        for auth in [Auth::None, Auth::Bearer(&app.device), Auth::Bearer(&app.credential)] {
            let (status, answer, _) = app.call(method.clone(), &path, auth, body.clone()).await;
            assert_eq!((status, &answer), (StatusCode::UNAUTHORIZED, &unauthorized), "{method} {path}");
        }
        assert_eq!(query(&app.env.store, "SELECT * FROM deck_projects"), before, "{method} {path}");
        let (status, answer, _) = app.call(method.clone(), &path, Auth::Cookie, body).await;
        assert_eq!(status, StatusCode::OK, "{method} {path}: {answer}");
    }
}

#[tokio::test]
async fn proxy_and_none_modes_authenticate_as_every_other_owner_route() {
    for mode in [AuthMode::Proxy, AuthMode::None] {
        let app = app_with(|c| c.auth = mode).await;
        let (status, body) = app.patch("local:widgets@node:n1", json!({ "collapsed": true })).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(app.projects().await.as_array().unwrap().len(), 1);
    }
}

#[tokio::test]
async fn writes_refuse_form_posts() {
    let app = app().await;
    for (method, path) in [
        (Method::POST, "/api/v1/deck/project-keys".to_owned()),
        (Method::PATCH, project_path("local:widgets@node:n1")),
    ] {
        let request = Request::builder()
            .method(method.clone())
            .uri(&path)
            .header(header::COOKIE, app.cookie.as_deref().unwrap())
            .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded")
            .body(Body::from("collapsed=true"))
            .unwrap();
        let response = app.app.clone().oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::UNSUPPORTED_MEDIA_TYPE, "{method} {path}");
    }
    assert!(query(&app.env.store, "SELECT * FROM deck_projects").is_empty());
}

#[tokio::test]
async fn project_keys_follow_memory_scope_rules_with_the_node() {
    let app = app().await;
    let (status, body) = app
        .keys(json!([
            { "repository": "https://GitHub.com/acme/widgets.git/", "project": "widgets", "node": "n1" },
            { "repository": "https://github.com/acme/widgets", "project": "bad/name", "node": "n2" },
            { "repository": "", "project": "widgets", "node": "n1" },
            { "project": "widgets", "node": "node_2-B" },
            { "repository": null, "project": "my@node:proj", "node": "n1" },
            { "repository": "git@github.com:acme/widgets.git", "project": "widgets", "node": "n1" },
            { "repository": "https://user@github.com/acme/widgets", "node": "n1" },
            { "repository": "ftp://example.com/widgets", "node": "n1" },
            { "project": "..", "node": "n1" },
            { "project": "a/b", "node": "n1" },
            { "project": "", "node": "n1" },
            { "node": "n1" },
            { "project": "widgets", "node": "bad node" },
            { "project": "widgets", "node": "n".repeat(65) },
            { "project": "widgets", "node": "" },
            { "project": "widgets" },
            { "repository": "https://github.com/acme/widgets", "node": 7 },
            { "project": 5, "node": "n1" },
            {},
        ]))
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        body,
        json!({ "keys": [
            "repo:https://github.com/acme/widgets",
            "repo:https://github.com/acme/widgets",
            "local:widgets@node:n1",
            "local:widgets@node:node_2-B",
            "local:my@node:proj@node:n1",
            null, null, null, null, null, null, null, null, null, null, null, null, null, null,
        ] })
    );
    // Answering stores nothing.
    assert!(query(&app.env.store, "SELECT * FROM deck_projects").is_empty());
    let (status, _) = app.keys(json!([{ "project": "widgets", "node": "n".repeat(64) }])).await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn project_keys_answer_400_for_a_body_of_another_shape() {
    let app = app().await;
    let invalid = json!({ "error": "invalid" });
    let item = json!({ "project": "widgets", "node": "n1" });
    let too_many: Vec<Value> = (0..1025).map(|_| item.clone()).collect();
    for body in [
        json!({}),
        json!({ "items": [] }),
        json!({ "items": too_many }),
        json!({ "items": [item, "widgets"] }),
        json!({ "items": [null] }),
        json!({ "items": { "0": item } }),
        json!({ "items": "widgets" }),
        json!([item]),
        json!(null),
    ] {
        let (status, answer) = app.owner(Method::POST, "/api/v1/deck/project-keys", Some(body.clone())).await;
        assert_eq!((status, &answer), (StatusCode::BAD_REQUEST, &invalid), "{body}");
    }
    let request = Request::post("/api/v1/deck/project-keys")
        .header(header::COOKIE, app.cookie.as_deref().unwrap())
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from("{\"items\":"))
        .unwrap();
    assert_eq!(app.app.clone().oneshot(request).await.unwrap().status(), StatusCode::BAD_REQUEST);
    let most: Vec<Value> = (0..1024).map(|_| item.clone()).collect();
    let (status, answer) = app.keys(json!(most)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(answer["keys"].as_array().unwrap().len(), 1024);
    assert!(answer["keys"].as_array().unwrap().iter().all(|k| k == "local:widgets@node:n1"));
}

#[tokio::test]
async fn repository_keys_equal_memory_scope_keys() {
    let app = app().await;
    let urls = [
        "https://github.com/acme/widgets",
        "https://GitHub.com/acme/widgets.git",
        "https://github.com/acme/widgets/",
        "HTTPS://GITHUB.COM/Acme/Widgets.git/",
        "http://git.example.com:8080/team/repo",
        "https://gitlab.com/group/sub/project.git",
        " https://github.com/acme/padded ",
        "https://github.com/acme/fork-of-widgets",
    ];
    let items: Vec<Value> = urls.iter().map(|url| json!({ "repository": url, "project": "widgets", "node": app.node })).collect();
    let (status, body) = app.keys(json!(items)).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    for (url, key) in urls.iter().zip(body["keys"].as_array().unwrap()) {
        let path = format!("/api/agent/v1/memory?project=widgets&repository={}", encode(url));
        let (status, memory, _) = app.call(Method::GET, &path, Auth::Bearer(&app.device), None).await;
        assert_eq!(status, StatusCode::OK, "{url}: {memory}");
        let scope = &memory["scopes"][1];
        assert_eq!(scope["kind"], "project");
        assert!(key.is_string(), "{url}");
        assert_eq!(&scope["key"], key, "{url}");
    }
    // A repository without a remote is keyed by the node in Deck and by the device in memory.
    let (_, body) = app.keys(json!([{ "project": "widgets", "node": app.node }])).await;
    let (_, memory, _) = app.call(Method::GET, "/api/agent/v1/memory?project=widgets", Auth::Bearer(&app.device), None).await;
    assert_eq!(body["keys"][0], json!(format!("local:widgets@node:{}", app.node)));
    assert_eq!(memory["scopes"][1]["key"], json!(format!("local:widgets@{DEVICE}")));
}

#[tokio::test]
async fn projects_are_created_patched_listed_and_deleted() {
    let app = app().await;
    assert_eq!(app.projects().await, json!([]));
    let repo = "repo:https://github.com/acme/widgets";
    let local = "local:scratch@node:n1";

    // A PATCH creates the row with the defaults, then sets what it names.
    let (status, row) = app.patch(repo, json!({ "collapsed": true })).await;
    assert_eq!(status, StatusCode::OK, "{row}");
    assert_eq!((&row["key"], &row["name"], &row["collapsed"]), (&json!(repo), &Value::Null, &json!(true)));
    assert!(is_iso(&row["updatedAt"]), "{row}");
    assert_eq!(row.as_object().unwrap().len(), 4);

    let (_, row) = app.patch(repo, json!({ "name": "Widgets" })).await;
    assert_eq!((&row["name"], &row["collapsed"]), (&json!("Widgets"), &json!(true)));
    let (_, row) = app.patch(local, json!({})).await;
    assert_eq!((&row["name"], &row["collapsed"]), (&Value::Null, &json!(false)));
    let (_, row) = app.patch(local, json!({ "name": "My scratch", "collapsed": false, "other": 1 })).await;
    assert_eq!((&row["name"], &row["collapsed"]), (&json!("My scratch"), &json!(false)));

    let listed = app.projects().await;
    let keys: Vec<&str> = listed.as_array().unwrap().iter().map(|p| p["key"].as_str().unwrap()).collect();
    assert_eq!(keys, [local, repo]);
    assert_eq!(listed[1]["name"], "Widgets");
    assert!(listed.as_array().unwrap().iter().all(|p| is_iso(&p["updatedAt"])));
    let stored = one(&app.env.store, &format!("SELECT name, collapsed, updated_at FROM deck_projects WHERE key = '{repo}'"));
    assert_eq!((&stored["name"], &stored["collapsed"]), (&json!("Widgets"), &json!(1)));
    assert!(stored["updated_at"].as_i64().unwrap() > 1_700_000_000_000);

    // `null` clears the name; collapsed stays.
    let (_, row) = app.patch(repo, json!({ "name": null })).await;
    assert_eq!((&row["name"], &row["collapsed"]), (&Value::Null, &json!(true)));

    let (status, body) = app.owner(Method::DELETE, &project_path(repo), None).await;
    assert_eq!((status, body), (StatusCode::OK, json!({ "deleted": true })));
    let (status, body) = app.owner(Method::DELETE, &project_path(repo), None).await;
    assert_eq!((status, body), (StatusCode::OK, json!({ "deleted": false })));
    let keys: Vec<Value> = app.projects().await.as_array().unwrap().iter().map(|p| p["key"].clone()).collect();
    assert_eq!(keys, [json!(local)]);

    // A deleted row is back to the defaults: patching it again starts from them.
    let (_, row) = app.patch(repo, json!({ "name": "Again" })).await;
    assert_eq!((&row["name"], &row["collapsed"]), (&json!("Again"), &json!(false)));
}

#[tokio::test]
async fn keys_names_and_fields_are_checked() {
    let app = app().await;
    let invalid = (StatusCode::BAD_REQUEST, json!({ "error": "invalid" }));
    for key in [
        "repo:https://GitHub.com/acme/widgets",
        "repo:https://github.com/acme/widgets.git",
        "repo:https://github.com/acme/widgets/",
        "repo:git@github.com:acme/widgets",
        "repo:https://user@github.com/acme/widgets",
        "local:widgets",
        "local:widgets@laptop",
        "local:a/b@node:n1",
        "local:..@node:n1",
        "local:widgets@node:bad node",
        "local:widgets@node:",
        "user",
        "widgets",
    ] {
        assert_eq!(app.patch(key, json!({ "collapsed": true })).await, invalid, "{key}");
        assert_eq!(app.owner(Method::DELETE, &project_path(key), None).await, invalid, "{key}");
    }
    let key = "local:widgets@node:n1";
    for body in [
        json!({ "name": "" }),
        json!({ "name": " " }),
        json!({ "name": "a/b" }),
        json!({ "name": ".." }),
        json!({ "name": "line\nbreak" }),
        json!({ "name": 5 }),
        json!({ "name": "x".repeat(1025) }),
        json!({ "collapsed": "yes" }),
        json!({ "collapsed": 1 }),
        json!({ "collapsed": null }),
        json!([]),
        json!("widgets"),
        json!(null),
    ] {
        assert_eq!(app.patch(key, body.clone()).await, invalid, "{body}");
    }
    assert!(query(&app.env.store, "SELECT * FROM deck_projects").is_empty());
    let (status, row) = app.patch(key, json!({ "name": "x".repeat(1024) })).await;
    assert_eq!(status, StatusCode::OK, "{row}");
}

#[test]
fn reindex_and_upgrades_leave_deck_projects_alone() {
    let env = env();
    assert!(!pika::store::DERIVED_TABLES.contains(&"deck_projects"));
    upload(&env.store, &format!("session:{SESSION_ID}"), "session", &fixture("session.jsonl"), 4096);
    env.store
        .write(|tx| {
            let update = pika::deck::Update { name: Some(Some("Widgets".into())), collapsed: Some(true) };
            pika::deck::update(tx, "repo:https://github.com/acme/widgets", &update, 1_000)
        })
        .unwrap();
    pika::reindex::reindex(&env.store).unwrap();
    let rows = env.store.read(pika::deck::list).unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!((rows[0].name.as_deref(), rows[0].collapsed, rows[0].updated_at), (Some("Widgets"), true, 1_000));
}

#[test]
fn schema_version_22_adds_deck_projects_without_a_reindex() {
    let env = env();
    let store = env.store.clone();
    upload(&store, &format!("session:{SESSION_ID}"), "session", &fixture("session.jsonl"), 4096);
    let before = dump_derived(&store);
    let created = pika::nodes::create_node(&store, "node01").unwrap();
    store.write(|tx| tx.execute_batch(&format!("{UNDO_V22} PRAGMA user_version = 21;"))).unwrap();
    drop(store);
    let store = pika::store::Store::open(env.dir.path().join("data")).unwrap();
    assert_eq!(one(&store, "PRAGMA user_version")["user_version"], json!(22));
    assert!(query(&store, "SELECT * FROM deck_projects").is_empty());
    assert!(query(&store, "SELECT 1 FROM settings WHERE key = 'needs_reindex'").is_empty());
    assert_eq!(dump_derived(&store), before);
    assert_eq!(query(&store, "SELECT id FROM nodes"), vec![[("id".to_owned(), json!(created.id))].into()]);
}
