//! Agent memory (spec "Memory"): notes that pi agents save per user and per project through
//! `{base}/api/agent/v1/memory`, with compare-and-swap revisions, validation, the index and its budget, scope keys,
//! survival of `pika reindex`, scrubbing on write, authentication, and deletion with a project. Every credential here
//! is made up.

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
const REPO: &str = "https://github.com/me/widgets";

struct Reply {
    status: StatusCode,
    headers: header::HeaderMap,
    body: Vec<u8>,
}

impl Reply {
    fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }
    fn json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap_or_else(|_| panic!("not JSON: {}", self.text()))
    }
}

struct App {
    env: Env,
    app: Router,
    /// Device `a`'s token.
    a: String,
    /// Device `b`'s token.
    b: String,
}

impl App {
    fn new(auth: AuthMode) -> App {
        let env = env();
        let a = device(&env.store, "a");
        let b = device(&env.store, "b");
        let mut config = ServerConfig::new(env.dir.path().join("data"));
        config.auth = auth;
        config.password = Some(PASSWORD.into());
        let app = router(AppState::new(env.store.clone(), config).unwrap());
        App { env, app, a, b }
    }

    async fn send(&self, request: Request<Body>) -> Reply {
        let response = self.app.clone().oneshot(request).await.unwrap();
        let status = response.status();
        let headers = response.headers().clone();
        let body = axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap().to_vec();
        Reply { status, headers, body }
    }

    /// `method {path}` with `token` as the bearer, if any, and a JSON body, if any.
    async fn call(&self, method: Method, path: &str, token: Option<&str>, body: Option<Value>) -> Reply {
        let mut request = Request::builder().method(method).uri(path);
        if let Some(token) = token {
            request = request.header(header::AUTHORIZATION, format!("Bearer {token}"));
        }
        let body = match body {
            Some(body) => {
                request = request.header(header::CONTENT_TYPE, "application/json");
                Body::from(body.to_string())
            }
            None => Body::empty(),
        };
        self.send(request.body(body).unwrap()).await
    }

    /// `POST memory/notes` as `token`.
    async fn save(&self, token: &str, body: Value) -> Reply {
        self.call(Method::POST, "/api/agent/v1/memory/notes", Some(token), Some(body)).await
    }

    /// A save that must succeed; its note.
    async fn saved(&self, token: &str, body: Value) -> Value {
        let r = self.save(token, body).await;
        assert_eq!(r.status, StatusCode::OK, "{}", r.text());
        assert_eq!(r.headers[header::CACHE_CONTROL], "no-store");
        r.json()["note"].clone()
    }

    /// `POST memory/notes/:id/forget` as `token`.
    async fn forget(&self, token: &str, id: &str, body: Value) -> Reply {
        self.call(Method::POST, &format!("/api/agent/v1/memory/notes/{id}/forget"), Some(token), Some(body)).await
    }

    /// `GET memory?{query}` as `token`, which must succeed.
    async fn memory(&self, token: &str, query: &str) -> Value {
        let r = self.call(Method::GET, &format!("/api/agent/v1/memory?{query}"), Some(token), None).await;
        assert_eq!(r.status, StatusCode::OK, "{query}: {}", r.text());
        assert_eq!(r.headers[header::CACHE_CONTROL], "no-store");
        r.json()
    }

    /// The owner's `GET {base}/api/v1/{path}` without a login, for `AuthMode::None`.
    async fn owner(&self, path: &str) -> Reply {
        self.call(Method::GET, &format!("/api/v1/{path}"), None, None).await
    }

    fn count(&self, sql: &str) -> i64 {
        one(&self.env.store, sql).into_values().next().unwrap().as_i64().unwrap()
    }
}

/// Percent-encodes a query parameter value.
fn encode(s: &str) -> String {
    s.bytes()
        .map(|b| if b.is_ascii_alphanumeric() || b"-._~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") })
        .collect()
}

fn user_note(title: &str, hook: &str) -> Value {
    json!({ "expectedRevision": 0, "scope": "user", "category": "feedback", "title": title, "hook": hook, "body": "" })
}

fn repo_note(title: &str, category: &str) -> Value {
    json!({ "expectedRevision": 0, "scope": "project", "project": "widgets", "repository": REPO, "sessionId": "s-1",
            "category": category, "title": title, "hook": format!("when {title}"), "body": format!("All about {title}.") })
}

fn id(note: &Value) -> String {
    note["id"].as_str().unwrap().to_owned()
}

/// AC-1: a new note is revision 1 and readable; each save and forget adds exactly 1.
#[tokio::test]
async fn saves_start_at_revision_one_and_each_write_adds_one() {
    let app = App::new(AuthMode::None);
    let r = app.save(&app.a, repo_note("Build", "project")).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    let written = r.json();
    let note = written["note"].clone();
    let id = id(&note);
    assert!(!id.is_empty() && id.len() <= 16 && id.bytes().all(|b| b.is_ascii_alphanumeric()), "{id}");
    assert_eq!(note["revision"], 1);
    assert_eq!(note["scope"], json!({ "key": format!("repo:{REPO}"), "kind": "project", "label": "widgets" }));
    assert_eq!(
        (&note["category"], &note["title"], &note["hook"], &note["body"], &note["provenance"]),
        (&json!("project"), &json!("Build"), &json!("when Build"), &json!("All about Build."), &json!("agent"))
    );
    assert_eq!((&note["deviceId"], &note["sessionId"], &note["deletedAt"]), (&json!("a"), &json!("s-1"), &Value::Null));
    assert!(note["createdAt"].as_str().unwrap().ends_with('Z'));
    assert_eq!(note["createdAt"], note["updatedAt"]);
    let index = format!("# Project memory: widgets\n## project\n- Build — when Build [{id}]\n");
    assert_eq!(written["index"], json!(index));
    assert_eq!((written["indexBytes"].as_u64().unwrap(), written["indexLines"].as_u64().unwrap()), (index.len() as u64, 3));

    let query = format!("project=widgets&repository={}", encode(REPO));
    let read = app.memory(&app.a, &query).await;
    assert_eq!(read["notes"], json!([note]));
    assert_eq!(read["index"], json!(index));
    assert_eq!(read["scopes"], json!([{ "key": "user", "kind": "user", "label": "user" }, note["scope"]]));

    let mut update = repo_note("Build fast", "project");
    update["id"] = json!(id);
    update["expectedRevision"] = json!(1);
    let updated = app.saved(&app.b, update.clone()).await;
    assert_eq!((&updated["revision"], &updated["title"], &updated["deviceId"]), (&json!(2), &json!("Build fast"), &json!("b")));
    assert_eq!(updated["createdAt"], note["createdAt"]);
    update["expectedRevision"] = json!(2);
    assert_eq!(app.saved(&app.a, update).await["revision"], 3);

    let r = app.forget(&app.a, &id, json!({ "expectedRevision": 3, "project": "widgets", "repository": REPO, "reason": "stale" })).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    let forgotten = r.json();
    assert_eq!(forgotten["note"]["revision"], 4);
    assert!(forgotten["note"]["deletedAt"].is_string());
    assert_eq!((&forgotten["index"], &forgotten["indexBytes"], &forgotten["indexLines"]), (&json!(""), &json!(0), &json!(0)));
    let read = app.memory(&app.a, &query).await;
    assert_eq!((&read["notes"], &read["index"]), (&json!([]), &json!("")));
}

/// AC-2: a stale `expectedRevision` is a 409 with the current note and changes nothing; of concurrent saves at the same
/// revision exactly one succeeds.
#[tokio::test]
async fn stale_revisions_conflict_and_change_nothing() {
    let app = App::new(AuthMode::None);
    let note = app.saved(&app.a, user_note("Tabs", "indent with tabs")).await;
    let id = id(&note);
    let mut update = user_note("Spaces", "indent with spaces");
    update["id"] = json!(id);
    update["expectedRevision"] = json!(1);
    let current = app.saved(&app.a, update.clone()).await;
    assert_eq!(current["revision"], 2);
    let before = query(&app.env.store, "SELECT * FROM memory_notes");
    let history = app.count("SELECT COUNT(*) FROM memory_revisions");

    update["title"] = json!("Two spaces");
    for revision in [0, 1, 3] {
        update["expectedRevision"] = json!(revision);
        let r = app.save(&app.b, update.clone()).await;
        assert_eq!((r.status, r.json()), (StatusCode::CONFLICT, json!({ "error": "revision_conflict", "note": current })), "{revision}");
    }
    for revision in [1, 5] {
        let r = app.forget(&app.b, &id, json!({ "expectedRevision": revision })).await;
        assert_eq!((r.status, r.json()), (StatusCode::CONFLICT, json!({ "error": "revision_conflict", "note": current })));
    }
    assert_eq!(query(&app.env.store, "SELECT * FROM memory_notes"), before);
    assert_eq!(app.count("SELECT COUNT(*) FROM memory_revisions"), history);
    assert_eq!(app.memory(&app.a, "").await["notes"], json!([current]));

    // Eight agents save at revision 2 at once.
    update["expectedRevision"] = json!(2);
    let replies = concurrent_saves(&app, &update, 8).await;
    let ok = replies.iter().filter(|(status, _)| *status == StatusCode::OK).count();
    assert_eq!(ok, 1, "{replies:?}");
    for (status, body) in &replies {
        if *status != StatusCode::OK {
            assert_eq!((*status, &body["error"], &body["note"]["revision"]), (StatusCode::CONFLICT, &json!("revision_conflict"), &json!(3)));
        }
    }
    assert_eq!(app.count("SELECT revision FROM memory_notes"), 3);
    assert_eq!(app.count("SELECT COUNT(*) FROM memory_revisions"), 3);
}

/// Sends `n` copies of the save concurrently, each on its own task.
async fn concurrent_saves(app: &App, body: &Value, n: usize) -> Vec<(StatusCode, Value)> {
    let tasks: Vec<_> = (0..n)
        .map(|_| {
            let router = app.app.clone();
            let request = Request::post("/api/agent/v1/memory/notes")
                .header(header::AUTHORIZATION, format!("Bearer {}", app.a))
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(body.to_string()))
                .unwrap();
            tokio::spawn(async move {
                let response = router.oneshot(request).await.unwrap();
                let status = response.status();
                let body = axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap();
                (status, serde_json::from_slice(&body).unwrap())
            })
        })
        .collect();
    let mut replies = Vec::new();
    for task in tasks {
        replies.push(task.await.unwrap());
    }
    replies
}

/// AC-2 and the contract's 404s: unknown and forgotten ids, notes of another scope, and changing a note's scope.
#[tokio::test]
async fn updates_find_only_live_notes_of_the_requests_scope() {
    let app = App::new(AuthMode::None);
    let user = app.saved(&app.a, user_note("Tabs", "indent with tabs")).await;
    let local = app
        .saved(&app.a, json!({ "expectedRevision": 0, "scope": "project", "project": "scratch", "category": "project",
                                "title": "Scratch", "hook": "a local project", "body": "" }))
        .await;
    let not_found = (StatusCode::NOT_FOUND, json!({ "error": "not_found" }));
    let mut update = user_note("Spaces", "indent with spaces");
    update["expectedRevision"] = json!(1);
    update["id"] = json!("000000000000");
    let r = app.save(&app.a, update.clone()).await;
    assert_eq!((r.status, r.json()), not_found.clone());
    // A user note cannot move to a project scope, nor a project note to the user scope.
    update["id"] = json!(id(&user));
    update["scope"] = json!("project");
    update["project"] = json!("scratch");
    let r = app.save(&app.a, update.clone()).await;
    assert_eq!((r.status, r.json()), not_found.clone());
    let mut moved = update.clone();
    moved["id"] = json!(id(&local));
    moved["scope"] = json!("user");
    let r = app.save(&app.a, moved).await;
    assert_eq!((r.status, r.json()), not_found.clone());
    // Device b's `scratch` is another scope.
    let mut other = update.clone();
    other["id"] = json!(id(&local));
    let r = app.save(&app.b, other.clone()).await;
    assert_eq!((r.status, r.json()), not_found.clone());
    let r = app.forget(&app.b, &id(&local), json!({ "expectedRevision": 1, "project": "scratch" })).await;
    assert_eq!((r.status, r.json()), not_found.clone());
    // Forgetting a project note needs its project; a user note can be forgotten from any project.
    let r = app.forget(&app.a, &id(&local), json!({ "expectedRevision": 1 })).await;
    assert_eq!((r.status, r.json()), not_found.clone());
    let r = app.forget(&app.a, &id(&user), json!({ "expectedRevision": 1, "project": "scratch" })).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    // A forgotten note cannot be updated or forgotten again.
    update["scope"] = json!("user");
    update["expectedRevision"] = json!(2);
    let r = app.save(&app.a, update).await;
    assert_eq!((r.status, r.json()), not_found.clone());
    let r = app.forget(&app.a, &id(&user), json!({ "expectedRevision": 2 })).await;
    assert_eq!((r.status, r.json()), not_found.clone());
    let r = app.forget(&app.a, "nope", json!({ "expectedRevision": 0 })).await;
    assert_eq!((r.status, r.json()), not_found);
    assert_eq!(app.count("SELECT COUNT(*) FROM memory_revisions"), 3);
}

/// AC-3: invalid saves are 400 `bad_request` and store nothing.
#[tokio::test]
async fn invalid_saves_are_bad_requests() {
    let app = App::new(AuthMode::None);
    let valid = user_note("Tabs", "indent with tabs");
    let cases: Vec<(&str, Value)> = vec![
        ("category", json!({ "category": "misc" })),
        ("category case", json!({ "category": "Feedback" })),
        ("empty title", json!({ "title": "" })),
        ("blank title", json!({ "title": "   " })),
        ("long title", json!({ "title": "t".repeat(121) })),
        ("empty hook", json!({ "hook": "" })),
        ("multi-line hook", json!({ "hook": "one\ntwo" })),
        ("carriage return hook", json!({ "hook": "one\rtwo" })),
        ("long hook", json!({ "hook": "h".repeat(151) })),
        ("long body", json!({ "body": "b".repeat(8193) })),
        ("long reason", json!({ "reason": "r".repeat(501) })),
        ("negative revision", json!({ "expectedRevision": -1 })),
        ("fractional revision", json!({ "expectedRevision": 0.5 })),
        ("string revision", json!({ "expectedRevision": "0" })),
        ("create at revision 1", json!({ "expectedRevision": 1 })),
        ("scope", json!({ "scope": "global" })),
        ("project scope without a project", json!({ "scope": "project" })),
        ("invalid project", json!({ "scope": "project", "project": "a/b" })),
        ("dot project", json!({ "scope": "project", "project": ".." })),
        ("repository with user info", json!({ "scope": "project", "repository": "https://me:pw@github.com/me/widgets" })),
        ("ssh repository", json!({ "scope": "project", "repository": "git@github.com:me/widgets.git" })),
        ("missing title", json!({ "title": null })),
    ];
    for (name, change) in cases {
        let mut body = valid.clone();
        for (key, value) in change.as_object().unwrap() {
            body[key] = value.clone();
        }
        if body["title"].is_null() {
            body.as_object_mut().unwrap().remove("title");
        }
        let r = app.save(&app.a, body).await;
        assert_eq!((r.status, &r.json()["error"]), (StatusCode::BAD_REQUEST, &json!("bad_request")), "{name}: {}", r.text());
    }
    for raw in ["not json", "[]"] {
        let request = Request::post("/api/agent/v1/memory/notes")
            .header(header::AUTHORIZATION, format!("Bearer {}", app.a))
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(raw))
            .unwrap();
        let r = app.send(request).await;
        assert_eq!((r.status, &r.json()["error"]), (StatusCode::BAD_REQUEST, &json!("bad_request")), "{raw}");
    }
    let r = app.forget(&app.a, "x", json!({ "expectedRevision": -1 })).await;
    assert_eq!((r.status, &r.json()["error"]), (StatusCode::BAD_REQUEST, &json!("bad_request")));
    let r = app.call(Method::GET, "/api/agent/v1/memory?project=a%2Fb", Some(&app.a), None).await;
    assert_eq!((r.status, &r.json()["error"]), (StatusCode::BAD_REQUEST, &json!("bad_request")));
    assert_eq!(app.count("SELECT COUNT(*) FROM memory_notes"), 0);
    assert_eq!(app.count("SELECT COUNT(*) FROM memory_scopes"), 0);

    // At the limits: 120 and 150 characters (not bytes), 8 KiB of body, and an empty body.
    let mut body = valid.clone();
    body["title"] = json!("é".repeat(120));
    body["hook"] = json!(format!("  {}  ", "ü".repeat(150)));
    body["body"] = json!("b".repeat(8192));
    body["reason"] = json!("r".repeat(500));
    let note = app.saved(&app.a, body).await;
    assert_eq!(note["hook"], json!("ü".repeat(150)));
    app.saved(&app.a, user_note("Empty", "an empty body")).await;
}

/// AC-3: a save whose index of the user and request's project scopes would pass 200 lines or 8 KiB is 422
/// `memory_full` and stores nothing; forgetting is always allowed.
#[tokio::test]
async fn saves_past_the_line_budget_are_memory_full() {
    let app = App::new(AuthMode::None);
    // `# User memory`, `## feedback`, and 197 notes: 199 lines.
    for n in 0..197 {
        app.saved(&app.a, user_note(&format!("n{n}"), "h")).await;
    }
    let lines = app.memory(&app.a, "").await["indexLines"].clone();
    assert_eq!(lines, 199);
    // A project note would add its scope's two headers too.
    let r = app.save(&app.a, json!({ "expectedRevision": 0, "scope": "project", "project": "scratch", "category": "project",
                                     "title": "Scratch", "hook": "h" })).await;
    let scratch = json!({ "key": "local:scratch@a", "kind": "project", "label": "scratch" });
    assert_eq!(
        (r.status, r.json()),
        (StatusCode::UNPROCESSABLE_ENTITY, json!({ "error": "memory_full", "indexBytes": r.json()["indexBytes"],
                                                    "indexLines": 202, "limitBytes": 8192, "limitLines": 200, "project": scratch }))
    );
    assert!(r.json()["indexBytes"].as_u64().unwrap() < 8192);
    let last = app.saved(&app.a, user_note("n197", "h")).await;
    let r = app.save(&app.a, user_note("n198", "h")).await;
    assert_eq!((r.status, &r.json()["error"], &r.json()["indexLines"]), (StatusCode::UNPROCESSABLE_ENTITY, &json!("memory_full"), &json!(201)));
    // The user scope's index alone is past the budget: the answer names no project.
    assert_eq!(r.json()["project"], Value::Null);
    let r = app.forget(&app.a, &id(&last), json!({ "expectedRevision": 1 })).await;
    assert_eq!((r.status, &r.json()["indexLines"]), (StatusCode::OK, &json!(199)));
    assert_eq!(app.count("SELECT COUNT(*) FROM memory_notes WHERE deleted_at IS NULL"), 197);
    assert_eq!(app.count("SELECT COUNT(*) FROM memory_scopes"), 1);
    assert_eq!(app.count("SELECT COUNT(*) FROM memory_revisions"), 199);
}

#[tokio::test]
async fn saves_past_the_byte_budget_are_memory_full() {
    let app = App::new(AuthMode::None);
    let title = |n: usize| format!("{n:03}{}", "t".repeat(117));
    let mut saved = Vec::new();
    let full = loop {
        let r = app.save(&app.a, user_note(&title(saved.len()), &"h".repeat(150))).await;
        if r.status != StatusCode::OK {
            break r;
        }
        assert!(r.json()["indexBytes"].as_u64().unwrap() <= 8192);
        saved.push(r.json()["note"].clone());
    };
    let body = full.json();
    assert_eq!((full.status, &body["error"], &body["limitBytes"], &body["limitLines"]),
               (StatusCode::UNPROCESSABLE_ENTITY, &json!("memory_full"), &json!(8192), &json!(200)));
    let read = app.memory(&app.a, "").await;
    assert_eq!(body["indexBytes"].as_u64().unwrap(), read["indexBytes"].as_u64().unwrap() + 293, "one line of 293 bytes");
    assert_eq!(body["indexLines"].as_u64().unwrap(), read["indexLines"].as_u64().unwrap() + 1);
    assert_eq!(read["notes"].as_array().unwrap().len(), saved.len());
    // Growing a note past the budget is refused too; shrinking it is not.
    let mut short = user_note("x", "y");
    short["id"] = saved[0]["id"].clone();
    short["expectedRevision"] = json!(1);
    let small = app.saved(&app.a, short.clone()).await;
    let r = app.save(&app.a, user_note(&title(98), &"h".repeat(150))).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    short["title"] = json!(title(99));
    short["hook"] = json!("h".repeat(150));
    short["expectedRevision"] = json!(2);
    let r = app.save(&app.a, short).await;
    assert_eq!((r.status, &r.json()["error"]), (StatusCode::UNPROCESSABLE_ENTITY, &json!("memory_full")));
    assert_eq!(one(&app.env.store, &format!("SELECT title FROM memory_notes WHERE id = '{}'", id(&small)))["title"], json!("x"));
}

/// AC-4: the index is rendered from the live notes alone, grouped and ordered the same way whoever reads it.
#[tokio::test]
async fn the_index_is_deterministic() {
    let app = App::new(AuthMode::None);
    let reference = app.saved(&app.a, repo_note("Docs", "reference")).await;
    let build = app.saved(&app.a, repo_note("Build", "project")).await;
    let feedback = app.saved(&app.b, user_note("Terse", "keep replies short")).await;
    let role = app
        .saved(&app.a, json!({ "expectedRevision": 0, "scope": "user", "category": "user", "title": "Role",
                                "hook": "a systems researcher", "body": "" }))
        .await;
    let gone = app.saved(&app.a, repo_note("Old", "project")).await;
    let r = app.forget(&app.a, &id(&gone), json!({ "expectedRevision": 1, "repository": REPO })).await;
    assert_eq!(r.status, StatusCode::OK);
    let expected = format!(
        "# User memory\n## user\n- Role — a systems researcher [{}]\n## feedback\n- Terse — keep replies short [{}]\n\
         # Project memory: widgets\n## project\n- Build — when Build [{}]\n## reference\n- Docs — when Docs [{}]\n",
        id(&role),
        id(&feedback),
        id(&build),
        id(&reference)
    );
    let first = app.memory(&app.a, &format!("repository={}", encode(REPO))).await;
    assert_eq!(first["index"], json!(expected));
    assert_eq!((first["indexBytes"].as_u64().unwrap(), first["indexLines"].as_u64().unwrap()), (expected.len() as u64, 10));
    let ids: Vec<String> = first["notes"].as_array().unwrap().iter().map(id).collect();
    assert_eq!(ids, [id(&role), id(&feedback), id(&build), id(&reference)]);
    // Another device, another spelling of the URL, and the response of a write all render the same bytes.
    let second = app.memory(&app.b, &format!("project=widgets&repository={}", encode("HTTPS://GitHub.com/me/widgets.git/"))).await;
    assert_eq!(second, first);
    let mut touch = repo_note("Build", "project");
    touch["id"] = json!(id(&build));
    touch["expectedRevision"] = json!(1);
    let r = app.save(&app.b, touch).await;
    assert_eq!(r.json()["index"], json!(expected));
    // Without a project only the user scope is read.
    let user = app.memory(&app.a, "").await;
    assert_eq!(user["scopes"], json!([{ "key": "user", "kind": "user", "label": "user" }]));
    assert!(expected.starts_with(user["index"].as_str().unwrap()) && user["indexLines"] == 5);
}

/// AC-5: project memory is keyed by the normalized repository, shared across devices, or else by project name and
/// device; the user scope is shared by every device.
#[tokio::test]
async fn project_scopes_follow_the_repository_or_the_device() {
    let app = App::new(AuthMode::None);
    let shared = app
        .saved(&app.a, json!({ "expectedRevision": 0, "scope": "project", "project": "widgets",
                                "repository": "https://GitHub.COM/me/widgets.git", "category": "project",
                                "title": "Shared", "hook": "same repository", "body": "" }))
        .await;
    assert_eq!(shared["scope"]["key"], json!(format!("repo:{REPO}")));
    // Device b, under another local name, reads and updates it.
    let read = app.memory(&app.b, &format!("project=widgets-fork&repository={}", encode(&format!("{REPO}/")))).await;
    assert_eq!(read["notes"], json!([shared]));
    assert_eq!(read["scopes"][1], shared["scope"], "a stored scope keeps its label");

    let local = app
        .saved(&app.a, json!({ "expectedRevision": 0, "scope": "project", "project": "scratch", "category": "project",
                                "title": "Local", "hook": "only on a", "body": "" }))
        .await;
    assert_eq!(local["scope"], json!({ "key": "local:scratch@a", "kind": "project", "label": "scratch" }));
    let on_b = app.memory(&app.b, "project=scratch").await;
    assert_eq!(on_b["notes"], json!([]));
    assert_eq!(on_b["scopes"][1], json!({ "key": "local:scratch@b", "kind": "project", "label": "scratch" }));
    assert_eq!(app.memory(&app.a, "project=scratch").await["notes"], json!([local]));
    // An empty repository names nothing, so the project name decides.
    assert_eq!(app.memory(&app.a, "project=scratch&repository=").await["notes"], json!([local]));

    let user = app.saved(&app.b, user_note("Tabs", "indent with tabs")).await;
    assert_eq!(user["scope"], json!({ "key": "user", "kind": "user", "label": "user" }));
    assert_eq!(app.memory(&app.a, "").await["notes"], json!([user]));
    assert_eq!(app.memory(&app.a, "project=scratch").await["notes"], json!([user, local]));
    // A repository without a project name is labeled by its last path segment.
    let unnamed = app
        .saved(&app.b, json!({ "expectedRevision": 0, "scope": "project", "repository": "https://example.com/team/gadgets",
                                "category": "reference", "title": "Gadgets", "hook": "h", "body": "" }))
        .await;
    assert_eq!(unnamed["scope"], json!({ "key": "repo:https://example.com/team/gadgets", "kind": "project", "label": "gadgets" }));
}

/// AC-6: `pika reindex` keeps every note and revision; every save and forget is a revision row, and forgetting keeps
/// the note's row and history.
#[tokio::test]
async fn reindex_keeps_memory_and_its_history() {
    let app = App::new(AuthMode::None);
    upload(&app.env.store, &format!("session:{SESSION_ID}"), "session", &fixture("session.jsonl"), 3);
    let kept = app.saved(&app.a, repo_note("Build", "project")).await;
    let mut update = repo_note("Build fast", "project");
    update["id"] = json!(id(&kept));
    update["expectedRevision"] = json!(1);
    update["reason"] = json!("faster");
    app.saved(&app.a, update).await;
    let gone = app.saved(&app.b, user_note("Tabs", "indent with tabs")).await;
    let r = app.forget(&app.b, &id(&gone), json!({ "expectedRevision": 1, "sessionId": "s-2", "reason": "wrong" })).await;
    assert_eq!(r.status, StatusCode::OK);

    let tables = ["memory_scopes", "memory_notes", "memory_revisions"];
    let dump = |app: &App| tables.map(|t| query(&app.env.store, &format!("SELECT * FROM {t} ORDER BY 1, 2")));
    let before = dump(&app);
    let read_before = app.memory(&app.a, &format!("repository={}", encode(REPO))).await;
    pika::reindex::reindex(&app.env.store).unwrap();
    assert_eq!(dump(&app), before);
    assert_eq!(app.memory(&app.a, &format!("repository={}", encode(REPO))).await, read_before);
    assert_eq!(app.count("SELECT COUNT(*) FROM sessions"), 1, "the reindex ran");

    let r = app.owner(&format!("memory/notes/{}/revisions", id(&kept))).await;
    assert_eq!(r.status, StatusCode::OK);
    let revisions = r.json()["revisions"].clone();
    assert_eq!(revisions.as_array().unwrap().len(), 2);
    assert_eq!(
        (&revisions[0]["revision"], &revisions[0]["action"], &revisions[0]["title"], &revisions[0]["reason"]),
        (&json!(1), &json!("save"), &json!("Build"), &Value::Null)
    );
    assert_eq!(
        (&revisions[1]["revision"], &revisions[1]["action"], &revisions[1]["title"], &revisions[1]["reason"]),
        (&json!(2), &json!("save"), &json!("Build fast"), &json!("faster"))
    );
    let revisions = app.owner(&format!("memory/notes/{}/revisions", id(&gone))).await.json()["revisions"].clone();
    assert_eq!(
        revisions[1],
        json!({ "revision": 2, "action": "forget", "category": "feedback", "title": "Tabs", "hook": "indent with tabs",
                "body": "", "at": revisions[1]["at"], "deviceId": "b", "sessionId": "s-2", "reason": "wrong",
                "provenance": "agent", "sources": [], "batchId": null })
    );
    assert!(revisions[1]["at"].is_string());
    assert_eq!(one(&app.env.store, &format!("SELECT revision, deleted_at IS NOT NULL AS gone FROM memory_notes WHERE id = '{}'", id(&gone))),
               one(&app.env.store, "SELECT 2 AS revision, 1 AS gone"));
}

/// AC-7: credentials in a title, hook, body, or reason are stored and returned scrubbed.
#[tokio::test]
async fn credentials_are_scrubbed_before_they_are_stored() {
    let app = App::new(AuthMode::None);
    let token = format!("pika_{}", "0123456789abcdef".repeat(4));
    let password = "FAKEmemoryPass0042";
    let mut body = user_note(&format!("Device token {token}"), &format!("deploy with {token}"));
    body["body"] = json!(format!("Set DB_PASSWORD={password} before deploying.\nToken: {token}\n"));
    body["reason"] = json!(format!("learned DB_PASSWORD={password}"));
    let note = app.saved(&app.a, body).await;
    for field in ["title", "hook", "body"] {
        let text = note[field].as_str().unwrap();
        assert!(text.contains("[REDACTED"), "{field}: {text}");
        assert!(!text.contains(&token) && !text.contains(password), "{field}: {text}");
    }
    let stored = [
        query(&app.env.store, "SELECT * FROM memory_notes"),
        query(&app.env.store, "SELECT * FROM memory_revisions"),
    ];
    let stored = serde_json::to_string(&stored).unwrap();
    assert!(!stored.contains(&token) && !stored.contains(password), "{stored}");
    assert!(one(&app.env.store, "SELECT reason FROM memory_revisions")["reason"].as_str().unwrap().contains("[REDACTED"));
    let read = app.memory(&app.a, "").await.to_string();
    assert!(!read.contains(&token) && !read.contains(password));
    let owner = app.owner(&format!("memory/notes/{}/revisions", id(&note))).await.text();
    assert!(!owner.contains(&token) && !owner.contains(password));
}

/// AC-8: agent memory routes need a device token with read access; the owner's need a login.
#[tokio::test]
async fn memory_routes_need_a_reading_device_or_the_owner() {
    let app = App::new(AuthMode::Password);
    let note = app.saved(&app.a, user_note("Tabs", "indent with tabs")).await;
    let forget = format!("/api/agent/v1/memory/notes/{}/forget", id(&note));
    let agent: [(Method, &str, Option<Value>); 4] = [
        (Method::GET, "/api/agent/v1/memory?project=widgets", None),
        (Method::POST, "/api/agent/v1/memory/notes", Some(user_note("Spaces", "indent with spaces"))),
        (Method::POST, forget.as_str(), Some(json!({ "expectedRevision": 1 }))),
        (Method::POST, "/api/agent/v1/memory/used", Some(json!({ "ids": [id(&note)] }))),
    ];
    pika::auth::update_device(&app.env.store, "b", None, Some(false)).unwrap();
    for (method, path, body) in &agent {
        for token in [None, Some("pika_unknown"), Some("")] {
            let r = app.call(method.clone(), path, token, body.clone()).await;
            assert_eq!((r.status, r.json()), (StatusCode::UNAUTHORIZED, json!({ "error": "unauthorized" })), "{method} {path} {token:?}");
            assert_eq!(r.headers[header::CACHE_CONTROL], "no-store");
        }
        let r = app.call(method.clone(), path, Some(&app.b), body.clone()).await;
        assert_eq!((r.status, r.json()), (StatusCode::FORBIDDEN, json!({ "error": "read_access_denied" })), "{method} {path}");
    }
    assert_eq!(app.count("SELECT COUNT(*) FROM memory_revisions"), 1);
    assert_eq!(app.count("SELECT COUNT(*) FROM memory_notes WHERE last_used_at IS NOT NULL"), 0);
    // A revoked token is refused at once.
    pika::auth::revoke_token(&app.env.store, "a").unwrap();
    let r = app.call(Method::GET, "/api/agent/v1/memory", Some(&app.a), None).await;
    assert_eq!(r.status, StatusCode::UNAUTHORIZED);
    // Unknown paths in the namespace stay 404.
    let r = app.call(Method::GET, "/api/agent/v1/memory/scopes", None, None).await;
    assert_eq!((r.status, r.json()), (StatusCode::NOT_FOUND, json!({ "error": "not_found" })));

    let revisions = format!("memory/notes/{}/revisions", id(&note));
    let owner = ["memory", "memory/notes?scope=user", revisions.as_str()];
    for path in owner {
        let r = app.owner(path).await;
        assert_eq!(r.status, StatusCode::UNAUTHORIZED, "{path}");
        // A device token is no owner login.
        let r = app.call(Method::GET, &format!("/api/v1/{path}"), Some(&app.b), None).await;
        assert_eq!(r.status, StatusCode::UNAUTHORIZED, "{path}");
    }
    let login = app.call(Method::POST, "/api/v1/login", None, Some(json!({ "password": PASSWORD }))).await;
    assert_eq!(login.status, StatusCode::OK, "{}", login.text());
    let cookie = login.headers[header::SET_COOKIE].to_str().unwrap().split(';').next().unwrap().to_owned();
    for path in owner {
        let request = Request::get(format!("/api/v1/{path}")).header(header::COOKIE, &cookie).body(Body::empty()).unwrap();
        let r = app.send(request).await;
        assert_eq!(r.status, StatusCode::OK, "{path}: {}", r.text());
    }
}

/// The owner's read-only view: scopes with live note counts, a scope's notes, and a note's revisions.
#[tokio::test]
async fn the_owner_lists_scopes_notes_and_revisions() {
    let app = App::new(AuthMode::None);
    let docs = app.saved(&app.a, repo_note("Docs", "reference")).await;
    let build = app.saved(&app.a, repo_note("Build", "project")).await;
    let local = app
        .saved(&app.b, json!({ "expectedRevision": 0, "scope": "project", "project": "alpha", "category": "project",
                                "title": "Alpha", "hook": "h", "body": "" }))
        .await;
    let r = app.forget(&app.b, &id(&local), json!({ "expectedRevision": 1, "project": "alpha" })).await;
    assert_eq!(r.status, StatusCode::OK);
    let user = app.saved(&app.b, user_note("Tabs", "indent with tabs")).await;

    let scopes = app.owner("memory").await.json()["scopes"].clone();
    let summary: Vec<_> = scopes.as_array().unwrap().iter().map(|s| (s["key"].clone(), s["label"].clone(), s["noteCount"].clone())).collect();
    assert_eq!(
        summary,
        [
            (json!("user"), json!("user"), json!(1)),
            (json!("local:alpha@b"), json!("alpha"), json!(0)),
            (json!(format!("repo:{REPO}")), json!("widgets"), json!(2)),
        ]
    );
    assert_eq!(scopes[0]["kind"], "user");
    assert_eq!(scopes[0]["updatedAt"], user["updatedAt"]);
    assert_eq!(scopes[2]["updatedAt"], build["updatedAt"]);

    let r = app.owner(&format!("memory/notes?scope={}", encode(&format!("repo:{REPO}")))).await;
    assert_eq!(r.json(), json!({ "notes": [build, docs] }));
    assert_eq!(app.owner("memory/notes?scope=local%3Aalpha%40b").await.json(), json!({ "notes": [] }));
    let r = app.owner("memory/notes?scope=local%3Aalpha%40a").await;
    assert_eq!((r.status, r.json()), (StatusCode::NOT_FOUND, json!({ "error": "not_found" })));
    let r = app.owner("memory/notes").await;
    assert_eq!((r.status, &r.json()["error"]), (StatusCode::BAD_REQUEST, &json!("bad_request")));
    let r = app.owner("memory/notes/nope/revisions").await;
    assert_eq!((r.status, r.json()), (StatusCode::NOT_FOUND, json!({ "error": "not_found" })));
    let revisions = app.owner(&format!("memory/notes/{}/revisions", id(&local))).await.json()["revisions"].clone();
    let actions: Vec<_> = revisions.as_array().unwrap().iter().map(|r| r["action"].clone()).collect();
    assert_eq!(actions, [json!("save"), json!("forget")]);
}

/// AC-11: deleting a project deletes the memory of every project scope labeled with its name, and nothing else.
#[tokio::test]
async fn deleting_a_project_deletes_its_memory() {
    let app = App::new(AuthMode::None);
    let repo = app.saved(&app.a, repo_note("Build", "project")).await;
    let local = |project: &str| {
        json!({ "expectedRevision": 0, "scope": "project", "project": project, "category": "project",
                "title": format!("{project} note"), "hook": "h", "body": "" })
    };
    let on_a = app.saved(&app.a, local("widgets")).await;
    let on_b = app.saved(&app.b, local("widgets")).await;
    let r = app.forget(&app.b, &id(&on_b), json!({ "expectedRevision": 1, "project": "widgets" })).await;
    assert_eq!(r.status, StatusCode::OK);
    let other = app.saved(&app.a, local("gadgets")).await;
    let user = app.saved(&app.a, user_note("Tabs", "indent with tabs")).await;
    // A user-scope note saved from the project stays with the user scope.
    let mut from_widgets = user_note("Terse", "keep replies short");
    from_widgets["project"] = json!("widgets");
    from_widgets["category"] = json!("user");
    let from_widgets = app.saved(&app.a, from_widgets).await;

    // Memory alone makes the project deletable.
    let r = app.owner("projects/widgets/deletion").await;
    assert_eq!((r.status, r.json()), (StatusCode::OK, json!({ "deletedSessions": 0, "deletedHerderRuns": 0 })));
    let r = app.call(Method::DELETE, "/api/v1/projects/widgets", None, None).await;
    assert_eq!((r.status, r.json()), (StatusCode::OK, json!({ "deletedSessions": 0, "deletedHerderRuns": 0 })));

    let keys: Vec<Value> = query(&app.env.store, "SELECT key FROM memory_scopes ORDER BY key").into_iter().map(|r| r["key"].clone()).collect();
    assert_eq!(keys, [json!("local:gadgets@a"), json!("user")]);
    for gone in [&repo, &on_a, &on_b] {
        let id = id(gone);
        assert_eq!(app.count(&format!("SELECT COUNT(*) FROM memory_notes WHERE id = '{id}'")), 0);
        assert_eq!(app.count(&format!("SELECT COUNT(*) FROM memory_revisions WHERE note_id = '{id}'")), 0);
    }
    for kept in [&other, &user, &from_widgets] {
        assert_eq!(app.count(&format!("SELECT COUNT(*) FROM memory_revisions WHERE note_id = '{}'", id(kept))), 1);
    }
    assert_eq!(app.memory(&app.a, &format!("project=widgets&repository={}", encode(REPO))).await["notes"], json!([from_widgets, user]));
    let r = app.call(Method::DELETE, "/api/v1/projects/widgets", None, None).await;
    assert_eq!((r.status, r.json()), (StatusCode::NOT_FOUND, json!({ "error": "not_found" })));
    // The project's memory starts empty if it comes back.
    let again = app.saved(&app.a, repo_note("Build", "project")).await;
    assert_eq!(again["revision"], 1);
}

/// Schema version 14 adds the memory tables to an existing database without a reindex.
#[test]
fn an_older_database_gains_the_memory_tables() {
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");
    {
        let store = pika::store::Store::open(&data).unwrap();
        device(&store, DEVICE);
    }
    let conn = rusqlite::Connection::open(data.join("pika.db")).unwrap();
    conn.execute_batch(&format!("{UNDO_V14} PRAGMA user_version = 13;")).unwrap();
    drop(conn);
    let store = pika::store::Store::open(&data).unwrap();
    assert_eq!(one(&store, "PRAGMA user_version")["user_version"], json!(21));
    assert_eq!(store.setting("needs_reindex").unwrap(), None);
    assert_eq!(one(&store, "SELECT COUNT(*) AS n FROM memory_scopes, memory_notes, memory_revisions")["n"], json!(0));
    assert!(!pika::store::DERIVED_TABLES.iter().any(|t| t.starts_with("memory_")));
}

/// Sends each `(path, body)` POST as device `a` concurrently, each on its own task.
async fn concurrent_posts(app: &App, posts: Vec<(String, Value)>) -> Vec<(StatusCode, Value)> {
    let tasks: Vec<_> = posts
        .into_iter()
        .map(|(path, body)| {
            let router = app.app.clone();
            let request = Request::post(path)
                .header(header::AUTHORIZATION, format!("Bearer {}", app.a))
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(body.to_string()))
                .unwrap();
            tokio::spawn(async move {
                let response = router.oneshot(request).await.unwrap();
                let status = response.status();
                let body = axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap();
                (status, serde_json::from_slice(&body).unwrap())
            })
        })
        .collect();
    let mut replies = Vec::new();
    for task in tasks {
        replies.push(task.await.unwrap());
    }
    replies
}

/// AC-8: the agent memory routes need a device token even when the owner routes need no login.
#[tokio::test]
async fn agent_memory_routes_need_a_token_without_owner_auth() {
    let app = App::new(AuthMode::None);
    let note = app.saved(&app.a, user_note("Tabs", "indent with tabs")).await;
    let forget = format!("/api/agent/v1/memory/notes/{}/forget", id(&note));
    let agent: [(Method, &str, Option<Value>); 4] = [
        (Method::GET, "/api/agent/v1/memory", None),
        (Method::POST, "/api/agent/v1/memory/notes", Some(user_note("Spaces", "indent with spaces"))),
        (Method::POST, forget.as_str(), Some(json!({ "expectedRevision": 1 }))),
        (Method::POST, "/api/agent/v1/memory/used", Some(json!({ "ids": [id(&note)] }))),
    ];
    pika::auth::update_device(&app.env.store, "b", None, Some(false)).unwrap();
    for (method, path, body) in &agent {
        for token in [None, Some("pika_unknown")] {
            let r = app.call(method.clone(), path, token, body.clone()).await;
            assert_eq!((r.status, r.json()), (StatusCode::UNAUTHORIZED, json!({ "error": "unauthorized" })), "{method} {path} {token:?}");
        }
        let r = app.call(method.clone(), path, Some(&app.b), body.clone()).await;
        assert_eq!((r.status, r.json()), (StatusCode::FORBIDDEN, json!({ "error": "read_access_denied" })), "{method} {path}");
    }
    assert_eq!(app.count("SELECT COUNT(*) FROM memory_revisions"), 1);
    assert_eq!(app.count("SELECT revision FROM memory_notes"), 1);
    assert_eq!(app.count("SELECT COUNT(*) FROM memory_notes WHERE last_used_at IS NOT NULL"), 0);
}

/// AC-3: more 400 cases: missing and out-of-range fields, sizes in bytes or characters as the contract counts them,
/// and invalid project names and repositories on every route.
#[tokio::test]
async fn more_invalid_requests_are_bad_requests() {
    let app = App::new(AuthMode::None);
    let valid = user_note("Tabs", "indent with tabs");
    let cases: Vec<(&str, Value)> = vec![
        ("missing expectedRevision", json!({ "expectedRevision": null })),
        ("missing category", json!({ "category": null })),
        ("missing hook", json!({ "hook": null })),
        ("missing scope", json!({ "scope": null })),
        ("huge revision", json!({ "expectedRevision": u64::MAX })),
        ("blank hook", json!({ "hook": "   " })),
        ("multi-byte body over 8 KiB", json!({ "body": "é".repeat(4097) })),
        ("project scope with empty names", json!({ "scope": "project", "project": "", "repository": "" })),
        ("long project", json!({ "scope": "project", "project": "p".repeat(1025) })),
        ("control character project", json!({ "scope": "project", "project": "a\u{7}b" })),
        ("backslash project", json!({ "scope": "project", "project": "a\\b" })),
        ("dot project", json!({ "scope": "project", "project": "." })),
        ("ftp repository", json!({ "scope": "project", "repository": "ftp://example.com/me/widgets" })),
        ("user info without password", json!({ "scope": "project", "repository": "https://me@github.com/me/widgets" })),
        ("hostless repository", json!({ "scope": "project", "repository": "https:///me/widgets" })),
    ];
    for (name, change) in cases {
        let mut body = valid.clone();
        for (key, value) in change.as_object().unwrap() {
            if value.is_null() {
                body.as_object_mut().unwrap().remove(key);
            } else {
                body[key] = value.clone();
            }
        }
        let r = app.save(&app.a, body).await;
        assert_eq!((r.status, &r.json()["error"]), (StatusCode::BAD_REQUEST, &json!("bad_request")), "{name}: {}", r.text());
    }
    for query in ["repository=git%40github.com%3Ame%2Fwidgets.git", "repository=https%3A%2F%2Fme%3Apw%40github.com%2Fme%2Fw", "project=.."] {
        let r = app.call(Method::GET, &format!("/api/agent/v1/memory?{query}"), Some(&app.a), None).await;
        assert_eq!((r.status, &r.json()["error"]), (StatusCode::BAD_REQUEST, &json!("bad_request")), "{query}: {}", r.text());
    }
    let note = app.saved(&app.a, valid.clone()).await;
    for (name, body) in [
        ("forget with an invalid project", json!({ "expectedRevision": 1, "project": "a/b" })),
        ("forget with an ssh repository", json!({ "expectedRevision": 1, "repository": "git@github.com:me/w.git" })),
        ("forget with a long reason", json!({ "expectedRevision": 1, "reason": "r".repeat(501) })),
        ("forget without expectedRevision", json!({})),
    ] {
        let r = app.forget(&app.a, &id(&note), body).await;
        assert_eq!((r.status, &r.json()["error"]), (StatusCode::BAD_REQUEST, &json!("bad_request")), "{name}: {}", r.text());
    }
    assert_eq!(app.count("SELECT COUNT(*) FROM memory_revisions"), 1);
    assert_eq!(app.count("SELECT COUNT(*) FROM memory_scopes"), 1);

    // At the limits: a 1024-byte project name, a reason of 500 multi-byte characters, a body of exactly 8 KiB in
    // multi-byte characters.
    let mut body = valid.clone();
    body["scope"] = json!("project");
    body["project"] = json!("p".repeat(1024));
    body["reason"] = json!("é".repeat(500));
    body["body"] = json!("é".repeat(4096));
    let note = app.saved(&app.a, body).await;
    assert_eq!(note["scope"]["label"], json!("p".repeat(1024)));
}

/// AC-7 with AC-3: lengths are checked on the scrubbed text, so a credential that pushes a field past its limit is
/// accepted once scrubbed.
#[tokio::test]
async fn limits_apply_to_the_scrubbed_text() {
    let app = App::new(AuthMode::None);
    let token = format!("pika_{}", "0123456789abcdef".repeat(4));
    let mut body = user_note(&format!("{} {token}", "t".repeat(100)), &format!("{} {token}", "h".repeat(130)));
    body["body"] = json!(format!("{} {token}", "b".repeat(8130)));
    assert!(body["title"].as_str().unwrap().chars().count() > 120);
    assert!(body["hook"].as_str().unwrap().chars().count() > 150);
    assert!(body["body"].as_str().unwrap().len() > 8192);
    let note = app.saved(&app.a, body).await;
    for field in ["title", "hook", "body"] {
        let text = note[field].as_str().unwrap();
        assert!(text.contains("[REDACTED") && !text.contains(&token), "{field}: {text}");
    }
    assert!(note["title"].as_str().unwrap().chars().count() <= 120);
    assert!(note["hook"].as_str().unwrap().chars().count() <= 150);
    assert!(note["body"].as_str().unwrap().len() <= 8192);
}

/// AC-3: forgetting never fails the budget, even when the index of the request's scopes is already past it, as the
/// owner's revert, which does not check the budget, can leave it. There a save that grows the index is refused, and one
/// that leaves it as it is or shrinks it is not.
#[tokio::test]
async fn forgetting_ignores_the_budget() {
    let app = App::new(AuthMode::None);
    let project = |n: usize| {
        json!({ "expectedRevision": 0, "scope": "project", "project": "scratch", "category": "project",
                "title": format!("p{n}"), "hook": "h" })
    };
    // 100 project notes (102 lines) and 96 user notes (98 lines) fill the budget.
    let mut projects = Vec::new();
    for n in 0..100 {
        projects.push(app.saved(&app.a, project(n)).await);
    }
    let mut users = Vec::new();
    for n in 0..96 {
        users.push(app.saved(&app.a, user_note(&format!("u{n}"), "h")).await);
    }
    // Ids are short, URL-safe, and unique.
    let mut ids: Vec<String> = projects.iter().chain(&users).map(id).collect();
    assert!(ids.iter().all(|id| !id.is_empty() && id.len() <= 32 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')));
    ids.sort();
    ids.dedup();
    assert_eq!(ids.len(), 196);
    // A copy of every user note puts the index 96 lines past the budget.
    app.env
        .store
        .write(|tx| {
            tx.execute_batch(
                "INSERT INTO memory_notes (id, scope_key, category, title, hook, body, provenance, revision, created_at,
                     updated_at, deleted_at, device_id, session_id, sources)
                 SELECT 'c' || id, scope_key, category, 'copy of ' || title, hook, body, provenance, revision, created_at,
                     updated_at, deleted_at, device_id, session_id, sources FROM memory_notes WHERE scope_key = 'user'",
            )
        })
        .unwrap();
    let read = app.memory(&app.a, "project=scratch").await;
    assert_eq!(read["indexLines"], 296);

    let r = app.forget(&app.a, &id(&users[0]), json!({ "expectedRevision": 1, "project": "scratch" })).await;
    assert_eq!((r.status, &r.json()["indexLines"]), (StatusCode::OK, &json!(295)), "{}", r.text());
    let r = app.forget(&app.a, &id(&projects[0]), json!({ "expectedRevision": 1, "project": "scratch" })).await;
    assert_eq!((r.status, &r.json()["indexLines"]), (StatusCode::OK, &json!(294)), "{}", r.text());
    // A save that grows the index is still over the budget, with or without the project named.
    let mut update = user_note("u1", "hh");
    update["id"] = users[1]["id"].clone();
    update["expectedRevision"] = json!(1);
    for project in [json!("scratch"), Value::Null] {
        update["project"] = project;
        let r = app.save(&app.a, update.clone()).await;
        assert_eq!((r.status, &r.json()["error"]), (StatusCode::UNPROCESSABLE_ENTITY, &json!("memory_full")), "{}", r.text());
        assert_eq!(r.json()["project"]["label"], "scratch");
    }
    let r = app.save(&app.a, user_note("u96", "h")).await;
    assert_eq!((r.status, &r.json()["indexLines"]), (StatusCode::UNPROCESSABLE_ENTITY, &json!(295)));
    let mut project_update = project(1);
    project_update["id"] = projects[1]["id"].clone();
    project_update["expectedRevision"] = json!(1);
    project_update["hook"] = json!("hh");
    let r = app.save(&app.a, project_update.clone()).await;
    assert_eq!((r.status, &r.json()["error"]), (StatusCode::UNPROCESSABLE_ENTITY, &json!("memory_full")));
    // An edit of the same size, or a shorter one, is not.
    update["project"] = json!("scratch");
    update["hook"] = json!("k");
    let r = app.save(&app.a, update.clone()).await;
    assert_eq!((r.status, &r.json()["indexLines"]), (StatusCode::OK, &json!(294)), "{}", r.text());
    let bytes = r.json()["indexBytes"].as_u64().unwrap();
    update["title"] = json!("u");
    update["expectedRevision"] = json!(2);
    let r = app.save(&app.a, update).await;
    assert_eq!((r.status, &r.json()["indexBytes"]), (StatusCode::OK, &json!(bytes - 1)), "{}", r.text());
    project_update["title"] = json!("p");
    project_update["hook"] = json!("h");
    let r = app.save(&app.a, project_update).await;
    assert_eq!((r.status, &r.json()["indexBytes"]), (StatusCode::OK, &json!(bytes - 2)), "{}", r.text());
}

/// C2: a user note is in every project's index, so a user-scope save, from whichever project or none, must fit the
/// index of the user scope with each project scope; the 422 names the project whose index it would overfill, which
/// keeps within the budget and can still save.
#[tokio::test]
async fn user_saves_fit_every_projects_index() {
    let app = App::new(AuthMode::None);
    let long = |n: usize| format!("{n:03}{}", "t".repeat(117));
    // Long notes in the widgets repository until one more does not fit.
    let mut saved = Vec::new();
    loop {
        let mut note = repo_note(&long(saved.len()), "project");
        note["hook"] = json!("h".repeat(150));
        let r = app.save(&app.a, note).await;
        if r.status != StatusCode::OK {
            assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY, "{}", r.text());
            break;
        }
        saved.push(r.json()["note"].clone());
    }
    let query = format!("repository={}", encode(REPO));
    let widgets = app.memory(&app.a, &query).await;
    let (bytes, lines) = (widgets["indexBytes"].as_u64().unwrap(), widgets["indexLines"].as_u64().unwrap());
    assert!(8192 - bytes < 293, "{bytes}");

    // A long user note, 26 bytes of headers and a line of 293, does not fit beside them, whether device b saves it
    // from its gadgets project or device a from no project.
    let scope = json!({ "key": format!("repo:{REPO}"), "kind": "project", "label": "widgets" });
    let full = json!({ "error": "memory_full", "indexBytes": bytes + 319, "indexLines": lines + 3, "limitBytes": 8192,
                       "limitLines": 200, "project": scope });
    let mut user = user_note(&long(900), &"h".repeat(150));
    user["project"] = json!("gadgets");
    let r = app.save(&app.b, user.clone()).await;
    assert_eq!((r.status, r.json()), (StatusCode::UNPROCESSABLE_ENTITY, full.clone()));
    user.as_object_mut().unwrap().remove("project");
    let r = app.save(&app.a, user).await;
    assert_eq!((r.status, r.json()), (StatusCode::UNPROCESSABLE_ENTITY, full));
    assert_eq!(app.count("SELECT COUNT(*) FROM memory_notes WHERE scope_key = 'user'"), 0);
    assert_eq!(app.memory(&app.a, &query).await["indexBytes"], json!(bytes));

    // Device b's gadgets project has its own budget, and widgets still saves.
    app.saved(&app.b, json!({ "expectedRevision": 0, "scope": "project", "project": "gadgets", "category": "project",
                               "title": long(901), "hook": "h".repeat(150) }))
        .await;
    let mut edit = repo_note("Short", "project");
    edit["id"] = saved[0]["id"].clone();
    edit["expectedRevision"] = json!(1);
    app.saved(&app.a, edit).await;
    let r = app.save(&app.a, user_note("Tabs", "indent with tabs")).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
}

/// AC-3 with the CAS rule: concurrent creates that fit only one at a time leave exactly one more note.
#[tokio::test]
async fn concurrent_creates_respect_the_budget() {
    let app = App::new(AuthMode::None);
    for n in 0..197 {
        app.saved(&app.a, user_note(&format!("n{n}"), "h")).await;
    }
    let posts = (0..8).map(|n| ("/api/agent/v1/memory/notes".to_owned(), user_note(&format!("c{n}"), "h"))).collect();
    let replies = concurrent_posts(&app, posts).await;
    let ok = replies.iter().filter(|(status, _)| *status == StatusCode::OK).count();
    assert_eq!(ok, 1, "{replies:?}");
    for (status, body) in &replies {
        if *status != StatusCode::OK {
            assert_eq!((*status, &body["error"], &body["indexLines"]), (StatusCode::UNPROCESSABLE_ENTITY, &json!("memory_full"), &json!(201)));
        }
    }
    assert_eq!(app.count("SELECT COUNT(*) FROM memory_notes"), 198);
    assert_eq!(app.count("SELECT COUNT(*) FROM memory_revisions"), 198);
}

/// AC-2: concurrent saves and forgets at the same revision: exactly one wins, the rest conflict.
#[tokio::test]
async fn concurrent_saves_and_forgets_at_one_revision() {
    let app = App::new(AuthMode::None);
    let note = app.saved(&app.a, user_note("Tabs", "indent with tabs")).await;
    let id = id(&note);
    let mut update = user_note("Spaces", "indent with spaces");
    update["id"] = json!(id);
    update["expectedRevision"] = json!(1);
    let forget = format!("/api/agent/v1/memory/notes/{id}/forget");
    let posts = (0..8)
        .map(|n| {
            if n % 2 == 0 {
                ("/api/agent/v1/memory/notes".to_owned(), update.clone())
            } else {
                (forget.clone(), json!({ "expectedRevision": 1 }))
            }
        })
        .collect();
    let replies = concurrent_posts(&app, posts).await;
    let ok = replies.iter().filter(|(status, _)| *status == StatusCode::OK).count();
    assert_eq!(ok, 1, "{replies:?}");
    for (status, body) in &replies {
        // A loser either sees the newer revision or, after a forget, no live note.
        assert!(
            *status == StatusCode::OK
                || (*status == StatusCode::CONFLICT && body["note"]["revision"] == 2)
                || (*status == StatusCode::NOT_FOUND && body == &json!({ "error": "not_found" })),
            "{status} {body}"
        );
    }
    assert_eq!(app.count("SELECT revision FROM memory_notes"), 2);
    assert_eq!(app.count("SELECT COUNT(*) FROM memory_revisions"), 2);
}

/// AC-5: the server lowercases only the scheme and host of a repository, and strips a trailing `/` and `.git`.
#[tokio::test]
async fn repository_keys_keep_the_path_case() {
    let app = App::new(AuthMode::None);
    let save = |repository: &str| {
        json!({ "expectedRevision": 0, "scope": "project", "project": "gadgets", "repository": repository,
                "category": "project", "title": "G", "hook": "h" })
    };
    let note = app.saved(&app.a, save("HTTP://Example.COM:8080/Team/Gadgets.git")).await;
    assert_eq!(note["scope"]["key"], json!("repo:http://example.com:8080/Team/Gadgets"));
    let other = app.saved(&app.b, save("http://example.com:8080/team/gadgets/")).await;
    assert_eq!(other["scope"]["key"], json!("repo:http://example.com:8080/team/gadgets"));
    let read = app.memory(&app.b, &format!("repository={}", encode("http://EXAMPLE.com:8080/Team/Gadgets/"))).await;
    assert_eq!(read["notes"], json!([note]));
}

/// AC-11: a project delete matches the name exactly (no pattern characters) and takes the project's sessions and
/// memory in one request without changing the response shape.
#[tokio::test]
async fn deleting_a_project_matches_its_name_exactly_and_takes_sessions_too() {
    let app = App::new(AuthMode::None);
    upload(&app.env.store, &format!("session:{SESSION_ID}"), "session", &fixture("session.jsonl"), 3);
    let project = one(&app.env.store, "SELECT project FROM sessions")["project"].as_str().unwrap().to_owned();
    let local = |project: &str| {
        json!({ "expectedRevision": 0, "scope": "project", "project": project, "category": "project",
                "title": format!("{project} note"), "hook": "h" })
    };
    let mine = app.saved(&app.a, local(&project)).await;
    let pattern = app.saved(&app.a, local("a_c")).await;
    let lookalike = app.saved(&app.a, local("abc")).await;
    let percent = app.saved(&app.a, local("a%")).await;
    let r = app.call(Method::DELETE, &format!("/api/v1/projects/{project}"), None, None).await;
    assert_eq!((r.status, r.json()), (StatusCode::OK, json!({ "deletedSessions": 1, "deletedHerderRuns": 0 })));
    assert_eq!(app.count("SELECT COUNT(*) FROM sessions"), 0);
    assert_eq!(app.count(&format!("SELECT COUNT(*) FROM memory_notes WHERE id = '{}'", id(&mine))), 0);

    let r = app.call(Method::DELETE, "/api/v1/projects/a_c", None, None).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    let r = app.call(Method::DELETE, "/api/v1/projects/a%25", None, None).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    for gone in [&pattern, &percent] {
        assert_eq!(app.count(&format!("SELECT COUNT(*) FROM memory_notes WHERE id = '{}'", id(gone))), 0);
    }
    assert_eq!(app.count(&format!("SELECT COUNT(*) FROM memory_revisions WHERE note_id = '{}'", id(&lookalike))), 1);
    assert_eq!(app.memory(&app.a, "project=abc").await["notes"], json!([lookalike]));
}

const MEMORY_SESSION: &str = "5b0c3a20-6d1e-4f3a-8b9c-2e3f4a5b6c7d";
/// Text that appears only in memory: the pinned index, a `memory_save` call's arguments, and its result.
const INDEX_MARK: &str = "quokkaindex";
const SAVE_MARK: &str = "quokkasave";
const RESULT_MARK: &str = "quokkaresult";

/// A session in project `widgets` with a pinned `pika-memory` index, an assistant message that mixes text, a
/// `memory_save` call, and a `read` call, and both calls' results.
fn memory_session() -> Vec<String> {
    let message = |id: &str, parent: &str, at: &str, message: Value| {
        json!({ "type": "message", "id": id, "parentId": parent, "timestamp": at, "message": message }).to_string()
    };
    vec![
        json!({ "type": "session", "version": 3, "id": MEMORY_SESSION, "timestamp": "2026-10-20T09:00:00.000Z",
                "cwd": "/home/me/code/widgets" }).to_string(),
        json!({ "type": "custom", "id": "m0", "parentId": null, "timestamp": "2026-10-20T09:00:00.500Z", "customType": "pika-memory",
                "data": { "index": format!("# User memory\n## feedback\n- Tabs — {INDEX_MARK} [0123456789ab]\n"), "indexBytes": 48 } })
        .to_string(),
        message("m1", "m0", "2026-10-20T09:00:01.000Z", json!({ "role": "user", "content": "Fix the wombat parser", "timestamp": 1792486801000_i64 })),
        message("m2", "m1", "2026-10-20T09:00:02.000Z", json!({ "role": "assistant", "api": "openai-responses", "provider": "openai",
            "model": "gpt-5", "stopReason": "toolUse", "timestamp": 1792486802000_i64,
            "usage": { "input": 100, "output": 20, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 120, "cost": { "total": 0.002 } },
            "content": [
                { "type": "text", "text": "Reading the wombat parser first." },
                { "type": "toolCall", "id": "call_mem", "name": "memory_save", "thoughtSignature": SAVE_MARK,
                  "arguments": { "title": format!("Remember {SAVE_MARK}"), "expectedRevision": 0 } },
                { "type": "toolCall", "id": "call_read", "name": "read", "arguments": { "path": "src/wombat.rs" } },
            ] })),
        message("m3", "m2", "2026-10-20T09:00:03.000Z", json!({ "role": "toolResult", "toolCallId": "call_mem", "toolName": "memory_save",
            "isError": false, "timestamp": 1792486803000_i64, "content": [{ "type": "text", "text": format!("Saved {RESULT_MARK}") }],
            "details": { "note": { "title": RESULT_MARK } } })),
        message("m4", "m3", "2026-10-20T09:00:04.000Z", json!({ "role": "toolResult", "toolCallId": "call_read", "toolName": "read",
            "isError": false, "timestamp": 1792486804000_i64, "content": [{ "type": "text", "text": "fn wombat() {}" }] })),
    ]
}

impl App {
    /// `GET {base}{path}` in a namespace (`v1`, `public/v1`, or `agent/v1` as device `a`), which must succeed.
    async fn read_in(&self, namespace: &str, path: &str) -> String {
        let token = (namespace == "agent/v1").then_some(self.a.as_str());
        let r = self.call(Method::GET, &format!("/api/{namespace}/{path}"), token, None).await;
        assert_eq!(r.status, StatusCode::OK, "{namespace} {path}: {}", r.text());
        if path.ends_with("/raw") { r.text() } else { r.json().to_string() }
    }

    /// The `(sessionId, seq)` of each search hit for `q` in a namespace, in both groupings.
    async fn hits_in(&self, namespace: &str, q: &str) -> Vec<Value> {
        let mut hits = Vec::new();
        for group in ["entry", "session"] {
            let found: Value = serde_json::from_str(&self.read_in(namespace, &format!("search?q={q}&group={group}")).await).unwrap();
            hits.extend(found["items"].as_array().unwrap().iter().cloned());
        }
        hits
    }
}

/// AC-9, AC-10: memory is the owner's alone. The public and agent namespaces' entries, raw lines, and traces omit a
/// `pika-memory` entry's data and memory tool calls' arguments and results, keeping the rest of each entry, and no
/// namespace's search finds text that appears only in memory, before or after a reindex.
#[tokio::test]
async fn memory_is_omitted_from_public_and_agent_reads_and_from_search() {
    let app = App::new(AuthMode::None);
    upload(&app.env.store, &format!("session:{MEMORY_SESSION}"), "session", &memory_session(), 2);
    let r = app.call(Method::PATCH, "/api/v1/settings/publishing", None, Some(json!({ "project": "widgets", "published": true }))).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    let marks = [INDEX_MARK, SAVE_MARK, RESULT_MARK];
    let entries = format!("sessions/{MEMORY_SESSION}/entries");
    let trace = format!("sessions/{MEMORY_SESSION}/trace");

    let owner = app.read_in("v1", &entries).await;
    assert!(marks.iter().all(|mark| owner.contains(mark)), "{owner}");
    let owner_trace: Value = serde_json::from_str(&app.read_in("v1", &trace).await).unwrap();
    let tool = |trace: &Value, name: &str| {
        trace["records"].as_array().unwrap().iter().find(|r| r["kind"] == "tool" && r["name"] == name).cloned().unwrap()
    };
    assert_eq!(tool(&owner_trace, "memory_save")["summary"], json!(format!("Remember {SAVE_MARK}")));

    for namespace in ["public/v1", "agent/v1"] {
        let text = app.read_in(namespace, &entries).await;
        assert!(marks.iter().all(|mark| !text.contains(mark)), "{namespace}: {text}");
        let items: Value = serde_json::from_str(&text).unwrap();
        let raw = |seq: usize| items["items"][seq]["raw"].clone();
        assert_eq!(raw(1)["customType"], "pika-memory", "{namespace}");
        assert_eq!(raw(1)["data"], json!({ "omitted": "memory" }), "{namespace}");
        assert_eq!(
            raw(3)["message"]["content"],
            json!([
                { "type": "text", "text": "Reading the wombat parser first." },
                { "type": "toolCall", "id": "call_mem", "name": "memory_save", "arguments": { "omitted": "memory" } },
                { "type": "toolCall", "id": "call_read", "name": "read", "arguments": { "path": "src/wombat.rs" } },
            ]),
            "{namespace}"
        );
        let result = raw(4)["message"].clone();
        assert_eq!((&result["toolCallId"], &result["toolName"]), (&json!("call_mem"), &json!("memory_save")), "{namespace}");
        assert_eq!(result["content"], json!([{ "type": "text", "text": "[memory tool result omitted]" }]), "{namespace}");
        assert_eq!(result["details"], json!({ "omitted": "memory" }), "{namespace}");
        assert_eq!(raw(5)["message"]["content"][0]["text"], "fn wombat() {}", "{namespace}");

        let text = app.read_in(namespace, &trace).await;
        assert!(marks.iter().all(|mark| !text.contains(mark)), "{namespace}: {text}");
        let scrubbed: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(scrubbed["records"].as_array().unwrap().len(), owner_trace["records"].as_array().unwrap().len());
        let llm = scrubbed["records"].as_array().unwrap().iter().find(|r| r["kind"] == "llm").unwrap();
        assert_eq!((&llm["text"], &llm["toolCalls"]), (&json!("Reading the wombat parser first."), &json!(2)), "{namespace}");
        let memory = tool(&scrubbed, "memory_save");
        assert_eq!((&memory["callId"], &memory["summary"], &memory["resultSeq"]), (&json!("call_mem"), &json!(""), &json!(4)), "{namespace}");
        assert_eq!(tool(&scrubbed, "read")["summary"], json!("src/wombat.rs"), "{namespace}");
    }
    // The public namespace's raw lines omit it too.
    for seq in 0..6 {
        let line = app.read_in("public/v1", &format!("{entries}/{seq}/raw")).await;
        assert!(marks.iter().all(|mark| !line.contains(mark)), "{seq}: {line}");
        serde_json::from_str::<Value>(&line).unwrap();
    }

    for reindexed in [false, true] {
        if reindexed {
            pika::reindex::reindex(&app.env.store).unwrap();
        }
        for namespace in ["v1", "public/v1", "agent/v1"] {
            for mark in marks {
                assert_eq!(app.hits_in(namespace, mark).await, Vec::<Value>::new(), "{namespace} {mark} reindexed: {reindexed}");
            }
            let hits = app.hits_in(namespace, "wombat").await;
            let kinds: Vec<&str> = hits.iter().filter_map(|h| h["kind"].as_str()).collect();
            for kind in ["user", "assistant", "tool-call", "tool-result"] {
                assert!(kinds.contains(&kind), "{namespace} {kind} reindexed: {reindexed}: {hits:?}");
            }
        }
    }
    let docs = app.count(&format!(
        "SELECT COUNT(*) FROM search_docs d JOIN sessions s ON s.sid = d.sid WHERE s.id = '{MEMORY_SESSION}'"
    ));
    // The prompt, the reply's text, the `read` call, and its result.
    assert_eq!(docs, 4);
}

impl App {
    /// `POST memory/used` as `token`.
    async fn used(&self, token: &str, body: Value) -> Reply {
        self.call(Method::POST, "/api/agent/v1/memory/used", Some(token), Some(body)).await
    }

    /// A `POST memory/used` that must succeed; its count.
    async fn marked(&self, token: &str, body: Value) -> Value {
        let r = self.used(token, body).await;
        assert_eq!(r.status, StatusCode::OK, "{}", r.text());
        assert_eq!(r.headers[header::CACHE_CONTROL], "no-store");
        r.json()
    }
}

/// `POST memory/used` sets `lastUsedAt` and nothing else: no revision, no history, the same `updatedAt` and index. A
/// fresh note has none, and later writes keep it.
#[tokio::test]
async fn marking_notes_used_records_only_the_time() {
    let app = App::new(AuthMode::None);
    let note = app.saved(&app.a, repo_note("Build", "project")).await;
    let other = app.saved(&app.a, user_note("Tabs", "indent with tabs")).await;
    assert_eq!((&note["lastUsedAt"], &other["lastUsedAt"]), (&Value::Null, &Value::Null));
    let query = format!("project=widgets&repository={}", encode(REPO));
    let before = app.memory(&app.a, &query).await;
    assert_eq!(before["notes"], json!([other, note]));
    let history = query_history(&app);

    assert_eq!(app.marked(&app.a, json!({ "ids": [] })).await, json!({ "used": 0 }));
    let marked = app.marked(&app.b, json!({ "ids": [id(&note), id(&note)], "project": "widgets", "repository": REPO,
                                             "sessionId": "s-2" }))
        .await;
    assert_eq!(marked, json!({ "used": 1 }));
    let after = app.memory(&app.a, &query).await;
    let used = after["notes"][1].clone();
    assert_eq!(used["id"], note["id"]);
    let at = used["lastUsedAt"].as_str().expect("lastUsedAt is set");
    assert!(at.ends_with('Z') && at >= note["updatedAt"].as_str().unwrap(), "{at}");
    let mut expected = note.clone();
    expected["lastUsedAt"] = json!(at);
    assert_eq!(used, expected);
    assert_eq!(after["notes"][0], other);
    assert_eq!((&after["index"], &after["indexBytes"], &after["indexLines"]), (&before["index"], &before["indexBytes"], &before["indexLines"]));
    assert_eq!(query_history(&app), history);
    let row = one(&app.env.store, &format!("SELECT revision, updated_at, last_used_at FROM memory_notes WHERE id = '{}'", id(&note)));
    assert_eq!(row["revision"], json!(1));
    assert!(row["last_used_at"].as_i64().unwrap() >= row["updated_at"].as_i64().unwrap());
    // The owner sees it too.
    let r = app.owner(&format!("memory/notes?scope={}", encode(&format!("repo:{REPO}")))).await;
    assert_eq!(r.json(), json!({ "notes": [used] }));

    // A later save or forget keeps it, and a conflict shows it.
    let mut update = repo_note("Build fast", "project");
    update["id"] = json!(id(&note));
    update["expectedRevision"] = json!(1);
    let updated = app.saved(&app.a, update.clone()).await;
    assert_eq!((&updated["revision"], &updated["lastUsedAt"]), (&json!(2), &json!(at)));
    let r = app.save(&app.a, update).await;
    assert_eq!((r.status, &r.json()["note"]["lastUsedAt"]), (StatusCode::CONFLICT, &json!(at)));
    let r = app.forget(&app.a, &id(&note), json!({ "expectedRevision": 2, "project": "widgets", "repository": REPO })).await;
    assert_eq!((r.status, &r.json()["note"]["lastUsedAt"]), (StatusCode::OK, &json!(at)), "{}", r.text());
    // A note marked before counts again.
    assert_eq!(app.marked(&app.a, json!({ "ids": [id(&other)] })).await, json!({ "used": 1 }));
    assert_eq!(app.marked(&app.a, json!({ "ids": [id(&other)] })).await, json!({ "used": 1 }));
    let read = app.memory(&app.a, "").await;
    assert!(read["notes"][0]["lastUsedAt"].is_string());
    assert_eq!(read["notes"][0]["revision"], json!(1));
}

/// Every revision row, for checking that marking notes used leaves history alone.
fn query_history(app: &App) -> Vec<std::collections::BTreeMap<String, Value>> {
    query(&app.env.store, "SELECT * FROM memory_revisions ORDER BY note_id, revision")
}

/// Only live notes of the user scope and the request's project scope are marked and counted; other ids are ignored.
#[tokio::test]
async fn marking_ignores_other_scopes_and_forgotten_notes() {
    let app = App::new(AuthMode::None);
    let repo = app.saved(&app.a, repo_note("Build", "project")).await;
    let user = app.saved(&app.a, user_note("Tabs", "indent with tabs")).await;
    let local = |project: &str| {
        json!({ "expectedRevision": 0, "scope": "project", "project": project, "category": "project",
                "title": format!("{project} note"), "hook": "h", "body": "" })
    };
    // The same project name on another device is another scope.
    let on_b = app.saved(&app.b, local("alpha")).await;
    let on_a = app.saved(&app.a, local("alpha")).await;
    let gone = app.saved(&app.a, user_note("Spaces", "indent with spaces")).await;
    let r = app.forget(&app.a, &id(&gone), json!({ "expectedRevision": 1 })).await;
    assert_eq!(r.status, StatusCode::OK);
    let ids = json!([id(&repo), id(&user), id(&on_b), id(&on_a), id(&gone), "nope", ""]);

    let marked = app.marked(&app.a, json!({ "ids": ids, "project": "alpha" })).await;
    assert_eq!(marked, json!({ "used": 2 }));
    let used = |note: &Value| app.count(&format!("SELECT last_used_at IS NOT NULL FROM memory_notes WHERE id = '{}'", id(note)));
    assert_eq!([used(&repo), used(&user), used(&on_b), used(&on_a), used(&gone)], [0, 1, 0, 1, 0]);
    // Without a project, only the user scope.
    assert_eq!(app.marked(&app.b, json!({ "ids": ids })).await, json!({ "used": 1 }));
    assert_eq!(app.marked(&app.b, json!({ "ids": ids, "project": "", "repository": "" })).await, json!({ "used": 1 }));
    assert_eq!(app.marked(&app.b, json!({ "ids": ids, "repository": REPO })).await, json!({ "used": 2 }));
    assert_eq!([used(&repo), used(&user), used(&on_b), used(&on_a), used(&gone)], [1, 1, 0, 1, 0]);
    // The forgotten note's GET-visible state is unchanged.
    let read = app.owner(&format!("memory/notes/{}/revisions", id(&gone))).await.json();
    assert_eq!(read["revisions"].as_array().unwrap().len(), 2);
    assert_eq!(app.count("SELECT COUNT(*) FROM memory_revisions"), 6);
}

/// More than 50 ids, a non-string id, no `ids`, and an invalid project or session id are 400s that mark nothing.
#[tokio::test]
async fn invalid_used_requests_are_bad_requests() {
    let app = App::new(AuthMode::None);
    let note = app.saved(&app.a, user_note("Tabs", "indent with tabs")).await;
    let many: Vec<String> = std::iter::repeat_n(id(&note), 51).collect();
    let bodies = [
        json!({ "ids": many }),
        json!({ "ids": [id(&note), 7] }),
        json!({ "ids": [null] }),
        json!({ "ids": id(&note) }),
        json!({}),
        json!([id(&note)]),
        json!({ "ids": [id(&note)], "project": "a/b" }),
        json!({ "ids": [id(&note)], "repository": "git@github.com:me/widgets.git" }),
        json!({ "ids": [id(&note)], "sessionId": "x".repeat(257) }),
    ];
    for body in bodies {
        let r = app.used(&app.a, body.clone()).await;
        assert_eq!((r.status, &r.json()["error"]), (StatusCode::BAD_REQUEST, &json!("bad_request")), "{body}: {}", r.text());
    }
    let r = app
        .send(Request::post("/api/agent/v1/memory/used").header(header::AUTHORIZATION, format!("Bearer {}", app.a)).body(Body::from("{")).unwrap())
        .await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    assert_eq!(app.count("SELECT COUNT(*) FROM memory_notes WHERE last_used_at IS NOT NULL"), 0);
    // Exactly 50 is fine.
    let fifty: Vec<String> = std::iter::repeat_n(id(&note), 50).collect();
    assert_eq!(app.marked(&app.a, json!({ "ids": fifty })).await, json!({ "used": 1 }));
}

/// Schema version 17 adds `last_used_at` to an existing database's notes without a reindex; existing notes have none.
#[test]
fn an_older_database_gains_last_used_times() {
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");
    {
        let store = pika::store::Store::open(&data).unwrap();
        device(&store, DEVICE);
        let request = serde_json::from_value(json!({ "expectedRevision": 0, "scope": "user", "category": "user",
                                                     "title": "Role", "hook": "a developer" }))
        .unwrap();
        store.write(|tx| pika::memory::save(tx, DEVICE, request)).unwrap();
    }
    let conn = rusqlite::Connection::open(data.join("pika.db")).unwrap();
    conn.execute_batch(&format!("{UNDO_V17} PRAGMA user_version = 16;")).unwrap();
    drop(conn);
    let store = pika::store::Store::open(&data).unwrap();
    assert_eq!(one(&store, "PRAGMA user_version")["user_version"], json!(21));
    assert_eq!(store.setting("needs_reindex").unwrap(), None);
    assert_eq!(one(&store, "SELECT last_used_at FROM memory_notes")["last_used_at"], Value::Null);
    let view = store.read(|conn| pika::memory::view(conn, DEVICE, None, None)).unwrap();
    assert_eq!(serde_json::to_value(&view.notes[0]).unwrap()["lastUsedAt"], Value::Null);
}
