//! What visitors get from a published session holding credentials: every public session route returns them as
//! `[REDACTED:<KIND>]` (a secret-named field's value as `[REDACTED]`) and leaves pika's own fields as they are, while
//! the owner's routes return the session as it was ingested. Search, the owner's included, indexes text scrubbed, and
//! a database indexed before redaction is rewritten in the background while public search finds nothing. Every
//! credential here is made up.

mod common;

use axum::Router;
use axum::body::Body;
use axum::http::{Request, StatusCode, header};
use common::*;
use pika::config::{AuthMode, ServerConfig};
use pika::http::{AppState, router};
use pika::store::{self, Store};
use pika::util::encode_path_segment;
use serde_json::{Value, json};
use tower::ServiceExt;

const SESSION: &str = "5ec2e7a0-0000-4000-8000-000000000001";
const CHILD: &str = "5ec2e7a0-0000-4000-8000-0000000000c1";

const GITHUB_TOKEN: &str = "ghp_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE00";
const AWS_KEY: &str = "AKIAFAKEFAKEFAKE0000";
const OPENAI_KEY: &str = "sk-proj-FAKEFAKEFAKEFAKE0000";
const ENV_SECRET: &str = "Fake0000Example1111";
const URL_PASSWORD: &str = "Fake0000Pass2222";
const FIELD_KEY: &str = "Fake0000Field3333";
const GITLAB_TOKEN: &str = "glpat-FAKEFAKEFAKEFAKE0000";
const ALL: [&str; 7] = [GITHUB_TOKEN, AWS_KEY, OPENAI_KEY, ENV_SECRET, URL_PASSWORD, FIELD_KEY, GITLAB_TOKEN];

/// The assistant message whose model call has a captured request, with its timing.
const TIMED_TS: i64 = 1792486803000;

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
    token: String,
}

impl App {
    fn new() -> App {
        let env = env();
        let token = device(&env.store, DEVICE);
        let mut config = ServerConfig::new(env.dir.path().join("data"));
        config.auth = AuthMode::None;
        let app = router(AppState::new(env.store.clone(), config).unwrap());
        App { env, app, token }
    }

    async fn send(&self, request: Request<Body>) -> Reply {
        let response = self.app.clone().oneshot(request).await.unwrap();
        let status = response.status();
        let headers = response.headers().clone();
        let body = axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap().to_vec();
        Reply { status, headers, body }
    }

    async fn get(&self, path: &str) -> Reply {
        let reply = self.send(Request::get(path).body(Body::empty()).unwrap()).await;
        assert_eq!(reply.status, StatusCode::OK, "{path}: {}", reply.text());
        reply
    }

    async fn owner(&self, path: &str) -> Reply {
        self.get(&format!("/api/v1/{path}")).await
    }

    async fn public(&self, path: &str) -> Reply {
        let reply = self.get(&format!("/api/public/v1/{path}")).await;
        assert_eq!(reply.headers[header::CACHE_CONTROL], "no-store", "{path}");
        reply
    }

    async fn ingest(&self, batch: Value) {
        let request = Request::post("/api/ingest/v1/batch")
            .header(header::CONTENT_TYPE, "application/json")
            .header(header::AUTHORIZATION, format!("Bearer {}", self.token))
            .body(Body::from(batch.to_string()))
            .unwrap();
        let reply = self.send(request).await;
        assert_eq!(reply.status, StatusCode::OK, "{}", reply.text());
    }

    async fn upload(&self, id: &str, lines: &[String]) {
        self.ingest(json!({ "streams": [stream(&format!("session:{id}"), "session", 0, lines)] })).await;
    }

    async fn publish(&self, project: &str) {
        let request = Request::patch("/api/v1/settings/publishing")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(json!({ "project": project, "published": true }).to_string()))
            .unwrap();
        let reply = self.send(request).await;
        assert_eq!(reply.status, StatusCode::OK, "{}", reply.text());
    }
}

fn message(id: &str, parent: Option<&str>, at: &str, message: Value) -> Value {
    json!({ "type": "message", "id": id, "parentId": parent, "timestamp": at, "message": message })
}

fn assistant(content: Value, stop: &str, ts: i64) -> Value {
    json!({ "role": "assistant", "content": content, "api": "openai-responses", "provider": "openai", "model": "gpt-5",
            "usage": { "input": 100, "output": 20, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 120, "cost": { "total": 0.002 } },
            "stopReason": stop, "timestamp": ts })
}

fn tool_result(call: &str, name: &str, text: &str, ts: i64) -> Value {
    json!({ "role": "toolResult", "toolCallId": call, "toolName": name, "isError": false, "timestamp": ts,
            "content": [{ "type": "text", "text": text }] })
}

/// One turn: a prompt and a reply holding credentials, a `.env` read, a deploy with an exported key and a configure
/// call with a secret-named argument, and a later output that echoes the `.env` secret bare.
fn session() -> Vec<String> {
    let env = format!("DB_PASSWORD={ENV_SECRET}\nDATABASE_URL=postgres://app:{URL_PASSWORD}@db.internal:5432/orders\n");
    [
        json!({ "type": "session", "version": 3, "id": SESSION, "timestamp": "2026-10-20T09:00:00.000Z", "cwd": "/home/me/code/widgets" }),
        message("e1", None, "2026-10-20T09:00:01.000Z",
            json!({ "role": "user", "content": format!("Deploy the widgets; my GitHub token is {GITHUB_TOKEN}"), "timestamp": 1792486801000_i64 })),
        message("e2", Some("e1"), "2026-10-20T09:00:03.000Z", assistant(json!([
            { "type": "text", "text": format!("Reading the config; the bucket takes {AWS_KEY} as its key id.") },
            { "type": "toolCall", "id": "call_env", "name": "read", "arguments": { "path": ".env" } },
        ]), "toolUse", TIMED_TS)),
        message("e3", Some("e2"), "2026-10-20T09:00:04.000Z", tool_result("call_env", "read", &env, 1792486804000)),
        message("e4", Some("e3"), "2026-10-20T09:00:06.000Z", assistant(json!([
            { "type": "toolCall", "id": "call_deploy", "name": "bash",
              "arguments": { "command": format!("export OPENAI_API_KEY={OPENAI_KEY} && npm run deploy") } },
            { "type": "toolCall", "id": "call_cfg", "name": "configure", "arguments": { "api_key": FIELD_KEY, "region": "eu-central-1" } },
        ]), "toolUse", 1792486806000)),
        message("e5", Some("e4"), "2026-10-20T09:00:08.000Z",
            tool_result("call_deploy", "bash", &format!("deployed; database login {ENV_SECRET} accepted"), 1792486808000)),
        message("e6", Some("e5"), "2026-10-20T09:00:09.000Z", tool_result("call_cfg", "configure", "configured", 1792486809000)),
        message("e7", Some("e6"), "2026-10-20T09:00:11.000Z", assistant(json!([
            { "type": "text", "text": format!("Deployed. Revoke {GITHUB_TOKEN} when you are done.") },
        ]), "stop", 1792486811000)),
    ]
    .iter()
    .map(Value::to_string)
    .collect()
}

/// A subagent the session started, whose description and prompt hold a GitLab token.
fn child() -> Vec<String> {
    let task = format!("Check that {GITLAB_TOKEN} can read the repo");
    [
        json!({ "type": "session", "version": 3, "id": CHILD, "timestamp": "2026-10-20T09:00:06.500Z", "cwd": "/home/me/code/widgets" }),
        json!({ "type": "custom", "id": "c1", "parentId": null, "timestamp": "2026-10-20T09:00:06.600Z", "customType": "pi-extensions.session-link",
                "data": { "kind": "subagent", "parentSessionId": SESSION, "parentToolCallId": "call_deploy", "agentId": "agent-2",
                          "agentType": "recon", "description": task } }),
        message("c2", Some("c1"), "2026-10-20T09:00:06.700Z", json!({ "role": "user", "content": task, "timestamp": 1792486806700_i64 })),
        message("c3", Some("c2"), "2026-10-20T09:00:07.000Z",
            assistant(json!([{ "type": "text", "text": "Read access works." }]), "stop", 1792486807000)),
    ]
    .iter()
    .map(Value::to_string)
    .collect()
}

/// A captured request for the timed model call, so its trace record has `firstToken`.
fn request() -> Value {
    let payload = json!({ "model": "gpt-5", "input": [{ "role": "user", "content": "Deploy the widgets" }], "stream": true });
    let (skeleton, blocks) = pika::requests::split(&payload);
    json!({
        "blobs": blocks.iter().map(|(hash, data)| json!({ "hash": hash, "data": data })).collect::<Vec<_>>(),
        "requests": [{ "id": "req-1", "sessionId": SESSION, "seq": 2, "at": "2026-10-20T09:00:01.500Z", "fidelity": "payload",
                       "provider": "openai", "api": "openai-responses", "model": "gpt-5",
                       "assistant": { "timestamp": TIMED_TS, "responseId": "resp_01" },
                       "timing": { "sentAt": 1792486801500_i64, "firstTokenAt": 1792486802000_i64, "firstToken": "text" },
                       "skeleton": skeleton, "blocks": blocks.iter().map(|(h, _)| h.clone()).collect::<Vec<_>>() }],
    })
}

async fn world() -> App {
    let app = App::new();
    app.ingest(request()).await;
    app.upload(SESSION, &session()).await;
    app.upload(CHILD, &child()).await;
    app.publish("widgets").await;
    app
}

/// Fields the public routes leave out of a published session, whatever its content.
/// `hidden` and `hiddenBy` mark sessions for the owner only.
const UNPUBLISHED_FIELDS: [&str; 5] = ["requestId", "link", "herderRunId", "hidden", "hiddenBy"];

/// Asserts that `public` is `owner` with only credentials replaced: the same keys (bar those publication leaves
/// out), the same numbers, booleans and ids, and strings that differ only where `public` has a marker.
fn assert_only_scrubbed(owner: &Value, public: &Value, at: &str) {
    match (owner, public) {
        (Value::Object(o), Value::Object(p)) => {
            for key in p.keys() {
                assert!(o.contains_key(key), "{at}.{key}: only in public");
            }
            for (key, value) in o {
                match p.get(key) {
                    Some(public) => assert_only_scrubbed(value, public, &format!("{at}.{key}")),
                    None => assert!(UNPUBLISHED_FIELDS.contains(&key.as_str()), "{at}.{key}: missing in public"),
                }
            }
        }
        (Value::Array(o), Value::Array(p)) => {
            assert_eq!(o.len(), p.len(), "{at}: length");
            for (i, (o, p)) in o.iter().zip(p).enumerate() {
                assert_only_scrubbed(o, p, &format!("{at}[{i}]"));
            }
        }
        (Value::String(o), Value::String(p)) if o != p => {
            assert!(p.contains("[REDACTED"), "{at}: {o:?} became {p:?}");
        }
        _ => assert_eq!(owner, public, "{at}"),
    }
}

/// Asserts that no credential is in `body` and every one of `markers` is.
fn assert_scrubbed(path: &str, body: &str, markers: &[&str]) {
    for credential in ALL {
        assert!(!body.contains(credential), "{path} shows {credential}: {body}");
    }
    for marker in markers {
        assert!(body.contains(marker), "{path} lacks {marker}: {body}");
    }
}

fn assert_shown(path: &str, body: &str, credentials: &[&str]) {
    for credential in credentials {
        assert!(body.contains(credential), "the owner's {path} lacks {credential}: {body}");
    }
}

#[tokio::test]
async fn public_session_routes_scrub_credentials_and_keep_pikas_fields() {
    let app = world().await;
    let api_key = "[REDACTED:API_KEY]";
    let routes: [(String, &[&str], &[&str]); 7] = [
        ("sessions".into(), &[GITHUB_TOKEN, GITLAB_TOKEN], &[api_key]),
        (format!("sessions/{SESSION}"), &[GITHUB_TOKEN, GITLAB_TOKEN], &[api_key]),
        (format!("sessions/{CHILD}/tree"), &[GITHUB_TOKEN, GITLAB_TOKEN], &[api_key]),
        (format!("sessions/{SESSION}/turns"), &[GITHUB_TOKEN], &[api_key]),
        (format!("sessions/{SESSION}/updates"), &[GITHUB_TOKEN], &[api_key]),
        (
            format!("sessions/{SESSION}/entries"),
            &[GITHUB_TOKEN, AWS_KEY, OPENAI_KEY, ENV_SECRET, URL_PASSWORD, FIELD_KEY],
            &[api_key, "[REDACTED:SECRET]", "[REDACTED:PASSWORD]", "\"[REDACTED]\""],
        ),
        (format!("sessions/{SESSION}/trace"), &[GITHUB_TOKEN, AWS_KEY, OPENAI_KEY, FIELD_KEY, GITLAB_TOKEN], &[api_key]),
    ];
    for (path, credentials, markers) in &routes {
        let owner = app.owner(path).await;
        assert_shown(path, &owner.text(), credentials);
        let public = app.public(path).await;
        assert_scrubbed(path, &public.text(), markers);
        let (owner, public) = (owner.json(), public.json());
        if path.ends_with("/trace") {
            // AC-1 replaces a displayed secret value; it must not disappear in favor of a harmless argument.
            let configure = |trace: &Value| trace["records"].as_array().unwrap().iter().position(|r| r["name"] == "configure").unwrap();
            let i = configure(&owner);
            assert_eq!((&owner["records"][i]["summary"], &public["records"][i]["summary"]), (&json!(FIELD_KEY), &json!("[REDACTED]")));
        }
        assert_only_scrubbed(&owner, &public, path);
    }

    // pika's own fields named like secrets keep their values.
    let trace = app.public(&format!("sessions/{SESSION}/trace")).await.json();
    let timed = trace["records"].as_array().unwrap().iter().find(|r| r["kind"] == "llm" && r["seq"] == 2).unwrap();
    assert_eq!((&timed["firstToken"], &timed["firstTokenAt"]), (&json!("text"), &json!(1792486802000_i64)));
    assert_eq!(timed["text"], "Reading the config; the bucket takes [REDACTED:API_KEY] as its key id.");
    assert_eq!(trace["children"][0]["description"], "Check that [REDACTED:API_KEY] can read the repo");
    let detail = app.public(&format!("sessions/{SESSION}")).await.json();
    assert_eq!(detail["tokens"], json!({ "input": 300, "output": 60, "cacheRead": 0, "cacheWrite": 0 }));
    assert_eq!(detail["title"], "Deploy the widgets; my GitHub token is [REDACTED:API_KEY]");
    assert_eq!((&detail["id"], &detail["children"][0]["id"]), (&json!(SESSION), &json!(CHILD)));

    // A value found in one entry is replaced where it reappears bare in another of the same response.
    let entries = app.public(&format!("sessions/{SESSION}/entries")).await.json();
    let text = |seq: usize| entries["items"][seq]["raw"]["message"]["content"][0]["text"].clone();
    assert_eq!(text(3), json!("DB_PASSWORD=[REDACTED:SECRET]\nDATABASE_URL=postgres://app:[REDACTED:PASSWORD]@db.internal:5432/orders\n"));
    assert_eq!(text(5), json!("deployed; database login [REDACTED:SECRET] accepted"));
    let calls = &entries["items"][4]["raw"]["message"]["content"];
    assert_eq!(calls[0]["arguments"]["command"], "export OPENAI_API_KEY=[REDACTED:API_KEY] && npm run deploy");
    assert_eq!(calls[1]["arguments"], json!({ "api_key": "[REDACTED]", "region": "eu-central-1" }));
}

#[tokio::test]
async fn raw_lines_are_scrubbed_to_one_line_of_json() {
    let app = world().await;
    let lines = session();
    // Entry 5 echoes the `.env` secret with nothing around it that a rule recognises; only a response that also
    // holds where it was found (the entry list) replaces it.
    for seq in [0, 1, 2, 3, 4, 6, 7] {
        let path = format!("sessions/{SESSION}/entries/{seq}/raw");
        let owner = app.owner(&path).await;
        assert_eq!(owner.text(), lines[seq], "the owner's {path}");
        let public = app.public(&path).await;
        let body = public.text();
        assert_scrubbed(&path, &body, &[]);
        assert!(!body.contains('\n'), "{path}: {body}");
        assert_eq!(public.headers[header::CONTENT_TYPE], "application/json; charset=utf-8");
        let (owner, public) = (owner.json(), public.json());
        assert_only_scrubbed(&owner, &public, &path);
        if [0, 6].contains(&seq) {
            assert_eq!(body, lines[seq], "{path}: a line with nothing to scrub is served as stored");
        }
    }
    let raw = app.public(&format!("sessions/{SESSION}/entries/4/raw")).await.json();
    assert_eq!(raw["message"]["content"][1]["arguments"]["api_key"], "[REDACTED]");
    assert_eq!(raw["message"]["content"][0]["arguments"]["command"], "export OPENAI_API_KEY=[REDACTED:API_KEY] && npm run deploy");
    let raw = app.public(&format!("sessions/{SESSION}/entries/3/raw")).await.text();
    assert!(raw.contains("[REDACTED:SECRET]") && raw.contains("[REDACTED:PASSWORD]"), "{raw}");
}

/// AC-1 requires the application/json raw response to remain one JSON value even when ingestion accepted text
/// or repaired a lone surrogate. The owner's response and stored source remain byte-exact.
#[tokio::test]
async fn malformed_public_raw_entries_are_valid_json_values() {
    let app = App::new();
    let cases = [
        ("not json DB_PASSWORD=FAKEmalformed0001".to_owned(), json!("not json DB_PASSWORD=[REDACTED:SECRET]")),
        ("ordinary malformed text".to_owned(), json!("ordinary malformed text")),
        ("bad \"quote\"\t\r\u{0001}\\path".to_owned(), json!("bad \"quote\"\t\r\u{0001}\\path")),
        (r#"{"ordinary":"FAKE repaired \ud800"}"#.to_owned(), json!({ "ordinary": "FAKE repaired �" })),
        (r#"{"ordinary":"FAKE repaired \udc00","password":"FAKElettersOnly"}"#.to_owned(),
         json!({ "ordinary": "FAKE repaired �", "password": "[REDACTED]" })),
        (r#"{"text":"ordinary\nline\twith\"quotes\""}"#.to_owned(), json!({ "text": "ordinary\nline\twith\"quotes\"" })),
        (r#"{"text":"DB_PASSWORD=FAKEcontrol0002\nnext\t\"quoted\""}"#.to_owned(),
         json!({ "text": "DB_PASSWORD=[REDACTED:SECRET]\nnext\t\"quoted\"" })),
    ];
    let mut lines = vec![session()[0].clone()];
    lines.extend(cases.iter().map(|(line, _)| line.clone()));
    app.upload(SESSION, &lines).await;
    app.publish("widgets").await;
    for (i, (line, expected)) in cases.iter().enumerate() {
        let path = format!("sessions/{SESSION}/entries/{}/raw", i + 1);
        let owner = app.owner(&path).await;
        assert_eq!(owner.body, line.as_bytes(), "{path}");
        let public = app.public(&path).await;
        assert_eq!(public.headers[header::CONTENT_TYPE], "application/json; charset=utf-8");
        assert!(!public.text().contains(['\n', '\r']), "{path}: {}", public.text());
        assert_eq!(public.json(), *expected, "{path}");
        assert_eq!(app.owner(&path).await.body, line.as_bytes(), "public reads leave storage exact");
    }
}

/// A title can contain a complete credential while a later description leaves its JSON container unfinished.
/// Every route must use those prefix fields without fetching the full prompt just to scrub a summary.
#[tokio::test]
async fn stored_json_prefixes_protect_titles_replies_children_and_search() {
    let app = App::new();
    let source = |secret: &str| format!("Deploy with {{\"client_secret\":{},\"description\":{}}}",
        serde_json::to_string(secret).unwrap(), serde_json::to_string(&"ordinary widgets description ".repeat(150)).unwrap());
    let secrets = ["FAKElettersOnly", "FAKEreplyLettersOnly", "FAKEchildLettersOnly"];
    let prompt = source(secrets[0]);
    let reply = source(secrets[1]);
    let task = source(secrets[2]);
    let title = first_chars(&prompt, 120);
    let child_title = first_chars(&task, 120);
    let final_text = first_chars(&reply, 2000);
    assert_eq!(title.chars().count(), 120);
    assert_eq!(child_title.chars().count(), 120);
    assert_eq!(final_text.chars().count(), 2000);
    for (text, secret) in [(&title, secrets[0]), (&child_title, secrets[2]), (&final_text, secrets[1])] {
        assert!(text.contains(&format!("\"{secret}\",")));
        assert!(serde_json::from_str::<Value>(text.strip_prefix("Deploy with ").unwrap()).is_err());
    }
    let mut lines = session();
    let mut user: Value = serde_json::from_str(&lines[1]).unwrap();
    user["message"]["content"] = json!(prompt);
    lines[1] = user.to_string();
    let mut answer: Value = serde_json::from_str(&lines[7]).unwrap();
    answer["message"]["content"] = json!([{ "type": "text", "text": reply }]);
    lines[7] = answer.to_string();
    let mut child_lines = child();
    let mut user: Value = serde_json::from_str(&child_lines[2]).unwrap();
    user["message"]["content"] = json!(task);
    child_lines[2] = user.to_string();
    app.ingest(request()).await;
    app.upload(SESSION, &lines).await;
    app.upload(CHILD, &child_lines).await;
    app.publish("widgets").await;

    let owner = app.owner(&format!("sessions/{SESSION}")).await.json();
    assert_eq!(owner["title"], title);
    assert_eq!(owner["children"][0]["title"], child_title);
    assert_eq!(app.owner(&format!("sessions/{SESSION}/turns")).await.json()["items"][0]["finalText"], final_text);
    for path in [
        "sessions".to_owned(), format!("sessions/{SESSION}"), format!("sessions/{CHILD}"),
        format!("sessions/{CHILD}/tree"), format!("sessions/{SESSION}/turns"), format!("sessions/{CHILD}/turns"),
        format!("sessions/{SESSION}/updates"), format!("sessions/{SESSION}/trace"), format!("sessions/{SESSION}/entries"),
    ] {
        let owner = app.owner(&path).await;
        assert!(owner.text().contains(secrets[0]) || owner.text().contains(secrets[2]), "{path}");
        let public = app.public(&path).await;
        for secret in secrets { assert!(!public.text().contains(secret), "{path}: {secret}"); }
        assert!(public.text().contains("[REDACTED]"), "{path}");
        assert_only_scrubbed(&owner.json(), &public.json(), &path);
    }
    let detail = app.public(&format!("sessions/{SESSION}")).await.json();
    assert_eq!(detail["title"], title.replace(secrets[0], "[REDACTED]"));
    assert_eq!(detail["children"][0]["title"], child_title.replace(secrets[2], "[REDACTED]"));
    let turns = app.public(&format!("sessions/{SESSION}/turns")).await.json();
    assert_eq!(turns["items"][0]["finalText"], final_text.replace(secrets[1], "[REDACTED]"));
    let trace = app.public(&format!("sessions/{SESSION}/trace")).await.json();
    assert_eq!(trace["children"][0]["title"], child_title.replace(secrets[2], "[REDACTED]"));
    for public in [false, true] {
        let hits = items(&search(&app, public, "ordinary").await);
        assert!(!hits.is_empty());
        for hit in hits {
            let expected = if hit["sessionId"] == CHILD { &child_title } else { &title };
            let secret = if hit["sessionId"] == CHILD { secrets[2] } else { secrets[0] };
            assert_eq!(hit["sessionTitle"], expected.replace(secret, "[REDACTED]"));
            for secret in secrets { assert!(!hit.to_string().contains(secret)); }
        }
    }
    assert_unsearchable(&app, &secrets).await;
    for (id, lines) in [(SESSION, &lines), (CHILD, &child_lines)] {
        for (seq, line) in lines.iter().enumerate() {
            assert_eq!(app.owner(&format!("sessions/{id}/entries/{seq}/raw")).await.text(), *line);
        }
    }
    assert_current_at_version_8(&app.env.store);
}

/// The trace cuts `userText` to 200 characters and `text` and `summary` to 160; a credential across the cut is
/// scrubbed whole before it, so no part of it shows, though the owner's trace shows the part before the cut.
#[tokio::test]
async fn trace_texts_are_scrubbed_before_they_are_cut() {
    const LONG: &str = "5ec2e7a0-0000-4000-8000-000000000002";
    const PROMPT_TOKEN: &str = "gho_Fake0000Fake1111Fake2222Fake3333";
    const COMMAND_TOKEN: &str = "ghs_Fake4444Fake5555Fake6666Fake7777";
    const PEM: &str = "-----BEGIN EC PRIVATE KEY-----\nMHcCAQEEIFakeFakeFakeFakeFakeFakeFakeFakeFakeFakeFakeFakeoAoGCCqGSM49\n\
                       AwEHoUQDQgAEFakeFakeFakeFakeFakeFakeFakeFakeFakeFakeFakeFakeFakeFake\n-----END EC PRIVATE KEY-----";
    let cut = |s: String, n: usize| s.chars().take(n).collect::<String>();
    // The prompt's token starts at character 189, the PEM at 124 of the reply, the command's token at 141.
    let prompt = format!("{}{PROMPT_TOKEN} please", "Please deploy the widgets. ".repeat(7));
    let reply = format!("{}{PEM}\ndone", "Here is the key you asked for. ".repeat(4));
    let command = format!("{}echo {COMMAND_TOKEN} | gh auth login --with-token", "echo deploying the widgets now && ".repeat(4));
    let lines: Vec<String> = [
        json!({ "type": "session", "version": 3, "id": LONG, "timestamp": "2026-10-21T09:00:00.000Z", "cwd": "/home/me/code/widgets" }),
        message("l1", None, "2026-10-21T09:00:01.000Z", json!({ "role": "user", "content": prompt, "timestamp": 1792573201000_i64 })),
        message("l2", Some("l1"), "2026-10-21T09:00:03.000Z", assistant(json!([
            { "type": "text", "text": reply },
            { "type": "toolCall", "id": "call_login", "name": "bash", "arguments": { "command": command } },
        ]), "toolUse", 1792573203000)),
    ]
    .iter()
    .map(Value::to_string)
    .collect();
    let app = App::new();
    app.upload(LONG, &lines).await;
    app.publish("widgets").await;
    let path = format!("sessions/{LONG}/trace");

    let owner = app.owner(&path).await.json();
    assert_eq!(owner["turns"][0]["userText"], cut(prompt.clone(), 200));
    assert_eq!(owner["records"][0]["text"], cut(reply.replace('\n', " "), 160));
    assert_eq!(owner["records"][1]["summary"], cut(command.clone(), 160));

    let public = app.public(&path).await;
    let body = public.text();
    for part in [&PROMPT_TOKEN[..11], &COMMAND_TOKEN[..12], "BEGIN EC PRIVATE KEY", "MHcCAQEE"] {
        assert!(!body.contains(part), "{path} shows {part}: {body}");
    }
    let public = public.json();
    assert_eq!(public["turns"][0]["userText"], cut(prompt.replace(PROMPT_TOKEN, "[REDACTED:API_KEY]"), 200));
    assert_eq!(public["records"][0]["text"], cut(reply.replace(PEM, "[REDACTED:PRIVATE_KEY]").replace('\n', " "), 160));
    assert_eq!(public["records"][1]["summary"], cut(command.replace(COMMAND_TOKEN, "[REDACTED:API_KEY]"), 160));
    assert_eq!(public["records"][1]["summary"].as_str().unwrap().chars().count(), 160);
}

/// AC-1 requires PEM recognition before assistant newline collapse or a command's first-line selection. Both
/// actual line breaks and literal JSON-style escapes occur in agent text; all key bodies here are fake.
#[tokio::test]
async fn trace_scrubs_unterminated_pem_before_formatting() {
    for newline in ["\n", "\r\n", r"\n", r"\r\n"] {
        let app = App::new();
        let pem = format!("-----BEGIN PRIVATE KEY-----{newline}FAKE0000MadeUpPrivateKeyBody11112222{newline}FAKE0000Tail==");
        let reply = format!("Captured key:\n{pem}");
        let command = format!("{pem}\necho done");
        let lines: Vec<String> = [
            json!({ "type": "session", "version": 3, "id": SESSION, "timestamp": "2026-10-20T09:00:00.000Z", "cwd": "/home/me/code/widgets" }),
            message("pem-user", None, "2026-10-20T09:00:01.000Z",
                json!({ "role": "user", "content": "Inspect the fake key fixture", "timestamp": 1792486801000_i64 })),
            message("pem-assistant", Some("pem-user"), "2026-10-20T09:00:03.000Z", assistant(json!([
                { "type": "text", "text": reply },
                { "type": "toolCall", "id": "pem-command", "name": "bash", "arguments": { "command": command } },
            ]), "toolUse", TIMED_TS)),
        ].iter().map(Value::to_string).collect();
        app.ingest(request()).await;
        app.upload(SESSION, &lines).await;
        app.publish("widgets").await;

        let path = format!("sessions/{SESSION}/trace");
        let owner = app.owner(&path).await.json();
        let public = app.public(&path).await.json();
        assert_eq!(owner["records"][0]["text"], reply.replace(['\r', '\n'], " "));
        assert_eq!(owner["records"][1]["summary"], command.split(['\r', '\n']).next().unwrap());
        assert_eq!(public["records"][0]["text"], "Captured key: [REDACTED:PRIVATE_KEY]");
        assert_eq!(public["records"][1]["summary"], "[REDACTED:PRIVATE_KEY]");
        assert_only_scrubbed(&owner, &public, &path);
        assert_eq!(public["records"][0]["firstToken"], "text");
        assert_eq!(owner["records"][0]["requestId"], "req-1");
        assert!(public["records"][0].get("requestId").is_none());
        assert!(!public.to_string().contains("FAKE0000"));
        assert!(public["records"][1].get("arguments").is_none());

        let path = format!("sessions/{SESSION}/entries/2/raw");
        assert_eq!(app.owner(&path).await.text(), lines[2]);
        let raw = app.public(&path).await;
        assert!(!raw.text().contains(['\r', '\n']));
        let raw = raw.json();
        assert_eq!(raw["message"]["content"][0]["text"], "Captured key:\n[REDACTED:PRIVATE_KEY]");
        assert_eq!(raw["message"]["content"][1]["arguments"]["command"], "[REDACTED:PRIVATE_KEY]\necho done");
    }
}

/// All original tool arguments participate, including ones the selected summary will not show. AC-6 propagation
/// covers letters-only credentials, phrases and eight-digit tokens (12345678 is a deliberately fake test token).
#[tokio::test]
async fn trace_arguments_and_cross_record_echoes_share_one_scope() {
    let app = App::new();
    let letters = "FAKElettersOnly";
    let phrase = "FAKE pass phrase for tests";
    let digits = "12345678";
    let echo = format!("echo {letters}; {phrase}; {digits}");
    let lines: Vec<String> = [
        json!({ "type": "session", "version": 3, "id": SESSION, "timestamp": "2026-10-20T09:00:00.000Z", "cwd": "/home/me/code/widgets" }),
        message("echo-user", None, "2026-10-20T09:00:01.000Z",
            json!({ "role": "user", "content": echo, "timestamp": 1792486801000_i64 })),
        message("echo-before", Some("echo-user"), "2026-10-20T09:00:02.000Z", assistant(json!([
            { "type": "text", "text": echo },
            { "type": "toolCall", "id": "echo-before", "name": "bash", "arguments": { "command": echo } },
        ]), "toolUse", 1792486802000)),
        message("echo-definitions", Some("echo-before"), "2026-10-20T09:00:03.000Z", assistant(json!([
            { "type": "toolCall", "id": "letters", "name": "configure", "arguments": { "api_key": letters, "region": "eu" } },
            { "type": "toolCall", "id": "phrase", "name": "login", "arguments": { "password": phrase } },
            { "type": "toolCall", "id": "digits", "name": "read", "arguments": { "path": "src/a.rs", "offset": 3, "limit": 8, "session_token": digits } },
        ]), "toolUse", TIMED_TS)),
        message("echo-after", Some("echo-definitions"), "2026-10-20T09:00:04.000Z", assistant(json!([
            { "type": "text", "text": echo },
            { "type": "toolCall", "id": "echo-after", "name": "bash", "arguments": { "command": echo } },
        ]), "toolUse", 1792486804000)),
    ].iter().map(Value::to_string).collect();
    app.ingest(request()).await;
    app.upload(SESSION, &lines).await;
    app.publish("widgets").await;
    let path = format!("sessions/{SESSION}/trace");
    let owner = app.owner(&path).await.json();
    let public = app.public(&path).await.json();
    assert_only_scrubbed(&owner, &public, &path);
    assert_eq!(owner["turns"][0]["userText"], echo);
    let summary = |trace: &Value, id| trace["records"].as_array().unwrap().iter()
        .find(|r| r["callId"] == id).unwrap()["summary"].clone();
    for (id, expected) in [("letters", letters), ("phrase", phrase), ("digits", "src/a.rs:3-8"), ("echo-before", &echo), ("echo-after", &echo)] {
        assert_eq!(summary(&owner, id), expected);
    }
    // AC-1 requires a placeholder in the generic summary, not omission or selection of the harmless region.
    assert_eq!(summary(&public, "letters"), "[REDACTED]");
    assert_eq!(summary(&public, "phrase"), "[REDACTED]");
    assert_eq!(summary(&public, "digits"), "src/a.rs:3-8");
    for id in ["echo-before", "echo-after"] {
        let scrubbed = summary(&public, id);
        assert_eq!(scrubbed.as_str().unwrap().matches("[REDACTED").count(), 3);
    }
    for trace in [&owner, &public] {
        assert!(trace["records"].as_array().unwrap().iter().all(|r| r.get("arguments").is_none()));
    }
    for credential in [letters, phrase, digits] {
        assert!(!public.to_string().contains(credential));
    }
    for (seq, line) in lines.iter().enumerate() {
        assert_eq!(app.owner(&format!("sessions/{SESSION}/entries/{seq}/raw")).await.text(), *line);
    }
}

#[tokio::test]
async fn public_entries_keep_original_truncated_flags_when_credentials_shrink() {
    use pika::read::entries::MAX_STRING_CHARS;
    let app = App::new();
    let credential = "FAKEoversizedCredential0".repeat(MAX_STRING_CHARS / 10);
    let ordinary = "é".repeat(MAX_STRING_CHARS + 1);
    let lines: Vec<String> = [
        json!({ "type": "session", "version": 3, "id": SESSION, "timestamp": "2026-10-20T09:00:00.000Z", "cwd": "/home/me/code/widgets" }),
        message("large-user", None, "2026-10-20T09:00:01.000Z",
            json!({ "role": "user", "content": "Inspect oversized fake credentials", "timestamp": 1792486801000_i64 })),
        message("large-call", Some("large-user"), "2026-10-20T09:00:03.000Z", assistant(json!([
            { "type": "toolCall", "id": "large-login", "name": "login", "arguments": { "password": credential } },
            { "type": "image", "mimeType": "image/png", "data": "aGk=".repeat(MAX_STRING_CHARS) },
        ]), "toolUse", TIMED_TS)),
        message("large-text", Some("large-call"), "2026-10-20T09:00:04.000Z", assistant(json!([
            { "type": "text", "text": ordinary },
        ]), "stop", 1792486804000)),
    ].iter().map(Value::to_string).collect();
    app.ingest(request()).await;
    app.upload(SESSION, &lines).await;
    app.publish("widgets").await;
    let path = format!("sessions/{SESSION}/entries");
    let owner = app.owner(&path).await.json();
    let mut public = app.public(&path).await.json();
    assert_eq!(owner["items"][2]["truncated"], true);
    assert_eq!(public["items"][2]["truncated"], true);
    assert_eq!(public["items"][2]["raw"]["message"]["content"][0]["arguments"]["password"], "[REDACTED]");
    assert_eq!(owner["items"][2]["raw"]["message"]["content"][0]["arguments"]["password"], credential.chars().take(MAX_STRING_CHARS).collect::<String>());
    assert_eq!(public["items"][3]["raw"]["message"]["content"][0]["text"].as_str().unwrap().chars().count(), MAX_STRING_CHARS);
    assert_eq!(public["items"][3]["truncated"], true);
    let image = &public["items"][2]["raw"]["message"]["content"][1];
    assert_eq!(image["data"], "");
    assert_eq!(image["src"], format!("/api/public/v1/sessions/{SESSION}/entries/2/image/0"));
    assert!(public["items"][2].get("requestId").is_none());
    assert_eq!(owner["items"][2]["requestId"], "req-1");
    // Image URLs deliberately use the public namespace; every other API field stays the same.
    public["items"][2]["raw"]["message"]["content"][1]["src"] = owner["items"][2]["raw"]["message"]["content"][1]["src"].clone();
    assert_only_scrubbed(&owner, &public, &path);
    let raw_path = format!("sessions/{SESSION}/entries/2/raw");
    assert_eq!(app.owner(&raw_path).await.text(), lines[2]);
    let raw = app.public(&raw_path).await;
    assert!(!raw.text().contains('\n'));
    assert_eq!(raw.json()["message"]["content"][0]["arguments"]["password"], "[REDACTED]");
}

#[tokio::test]
async fn unpublished_and_missing_sessions_are_still_not_found() {
    let app = App::new();
    app.upload(SESSION, &session()).await;
    for id in [SESSION, "missing"] {
        for suffix in ["", "/tree", "/turns", "/entries", "/entries/1/raw", "/trace", "/updates"] {
            let reply = app.send(Request::get(format!("/api/public/v1/sessions/{id}{suffix}")).body(Body::empty()).unwrap()).await;
            assert_eq!((reply.status, reply.json()), (StatusCode::NOT_FOUND, json!({ "error": "not_found" })), "{id}{suffix}");
        }
    }
}

const HOOK_SESSION: &str = "5ec2e7a0-0000-4000-8000-000000000003";
const LATE_SESSION: &str = "5ec2e7a0-0000-4000-8000-000000000004";
/// A password whose words, quokka, Fake0000 and lantern, occur nowhere else.
const HOOK_PASSWORD: &str = "quokka-Fake0000-lantern";

/// A published session whose one prompt holds a webhook URL with `HOOK_PASSWORD`.
fn hook_session() -> Vec<String> {
    [
        json!({ "type": "session", "version": 3, "id": HOOK_SESSION, "timestamp": "2026-10-22T09:00:00.000Z", "cwd": "/home/me/code/widgets" }),
        message("h1", None, "2026-10-22T09:00:01.000Z", json!({ "role": "user",
            "content": format!("Notify the hooks at https://deploy:{HOOK_PASSWORD}@ci.internal/hooks"), "timestamp": 1792659601000_i64 })),
    ]
    .iter()
    .map(Value::to_string)
    .collect()
}

/// A published session started while the index is rewritten, whose prompt holds the AWS key id.
fn late_session() -> Vec<String> {
    [
        json!({ "type": "session", "version": 3, "id": LATE_SESSION, "timestamp": "2026-10-23T09:00:00.000Z", "cwd": "/home/me/code/widgets" }),
        message("l1", None, "2026-10-23T09:00:01.000Z",
            json!({ "role": "user", "content": format!("Rotate {AWS_KEY} tonight"), "timestamp": 1792746001000_i64 })),
    ]
    .iter()
    .map(Value::to_string)
    .collect()
}

async fn search(app: &App, public: bool, q: &str) -> Reply {
    let path = format!("search?q={}", encode_path_segment(q));
    if public { app.public(&path).await } else { app.owner(&path).await }
}

fn items(reply: &Reply) -> Vec<Value> {
    reply.json()["items"].as_array().unwrap().clone()
}

/// The words the index splits a credential into, of three letters or more: its runs of letters and digits.
fn words(credential: &str) -> Vec<&str> {
    credential.split(|c: char| !c.is_alphanumeric()).filter(|w| w.len() >= 3).collect()
}

/// Asserts that neither the owner nor a visitor finds any of `credentials` or any of their words.
async fn assert_unsearchable(app: &App, credentials: &[&str]) {
    for public in [false, true] {
        for credential in credentials {
            for q in std::iter::once(*credential).chain(words(credential)) {
                assert_eq!(items(&search(app, public, q).await), Vec::<Value>::new(), "public {public}: {q}");
            }
        }
    }
}

/// Writes `docs` (kind, text) into the search index of `session` as a pika before redaction indexed them,
/// unscrubbed, one second apart from second 100, and removes the rules version. Returns their ids, in order.
fn forge_unscrubbed(store: &Store, session: &str, docs: &[(&str, String)]) -> Vec<i64> {
    forge_unscrubbed_at(store, session, docs, 100)
}

fn forge_unscrubbed_at(store: &Store, session: &str, docs: &[(&str, String)], first_second: i64) -> Vec<i64> {
    use pika::derive::search::{SID_MASK, SID_SHIFT};
    store
        .write(|tx| {
            let sid: i64 = tx.query_row("SELECT sid FROM sessions WHERE id = ?1", [session], |r| r.get(0))?;
            let mut ids = Vec::new();
            for (i, (kind, text)) in docs.iter().enumerate() {
                let second = first_second + i as i64;
                let id = second << 32 | (sid & SID_MASK) << SID_SHIFT;
                tx.execute(
                    "INSERT INTO search_docs (id, sid, seq, kind, at, text) VALUES (?1, ?2, 1, ?3, ?4, ?5)",
                    rusqlite::params![id, sid, kind, second * 1000, text],
                )?;
                tx.execute("INSERT INTO search_fts (rowid, text) VALUES (?1, ?2)", rusqlite::params![id, text])?;
                ids.push(id);
            }
            tx.execute("DELETE FROM settings WHERE key = ?1", [store::SEARCH_RULES])?;
            Ok::<_, rusqlite::Error>(ids)
        })
        .unwrap()
}

fn rewrite_cursor(target: u32, after: i64) -> Vec<u8> {
    serde_json::to_vec(&json!({ "target": target, "after": after })).unwrap()
}

fn current(store: &Store) -> bool {
    store.read(|conn| store::search_rules_current(conn)).unwrap()
}

/// The texts of the search index's documents with any of `credentials` in them.
fn indexed_with(store: &Store, credentials: &[&str]) -> Vec<String> {
    query(store, "SELECT text FROM search_docs")
        .into_iter()
        .map(|row| row["text"].as_str().unwrap().to_owned())
        .filter(|text| credentials.iter().any(|c| text.contains(c)))
        .collect()
}

/// Asserts the index is recorded as scrubbed under the current rules, with no rewrite left to resume, and the schema
/// is version 11, the latest; redaction adds no migration.
fn assert_current_at_version_8(store: &Store) {
    let settings = query(store, "SELECT key, CAST(value AS TEXT) AS value FROM settings WHERE key LIKE 'search%'");
    assert_eq!(settings, query(store, &format!("SELECT '{}' AS key, '{}' AS value", store::SEARCH_RULES, pika::redact::RULES_VERSION)));
    assert_eq!(one(store, "PRAGMA user_version")["user_version"], json!(12));
}

#[tokio::test]
async fn search_finds_no_credential_and_shows_markers_next_to_one() {
    let app = world().await;
    app.upload(HOOK_SESSION, &hook_session()).await;
    assert!(current(&app.env.store), "a new database's index starts current");
    // Each document is scrubbed on its own: the `.env` secret, echoed bare in entry 5 with nothing a rule recognises,
    // is indexed there, as values found elsewhere in a session are not remembered.
    let credentials: Vec<&str> = ALL.iter().copied().filter(|c| *c != ENV_SECRET).chain([HOOK_PASSWORD]).collect();
    assert_unsearchable(&app, &credentials).await;
    assert!(indexed_with(&app.env.store, &credentials).is_empty());
    let echoed = indexed_with(&app.env.store, &[ENV_SECRET]);
    assert_eq!(echoed, [format!("deployed; database login {ENV_SECRET} accepted")]);
    for public in [false, true] {
        let hits = items(&search(&app, public, ENV_SECRET).await);
        assert_eq!(hits.iter().map(|h| h["seq"].clone()).collect::<Vec<_>>(), [json!(5)], "public {public}");
    }

    // Words next to a credential: the prompt (also the session's title), the `.env` read, the reply, the webhook.
    for public in [false, true] {
        for (q, marker) in [
            ("GitHub", "[REDACTED:API_KEY]"),
            ("DATABASE_URL", "[REDACTED:PASSWORD]"),
            ("DB_PASSWORD", "[REDACTED:SECRET]"),
            ("Revoke", "[REDACTED:API_KEY]"),
            ("notify hooks", "[REDACTED:PASSWORD]"),
        ] {
            let reply = search(&app, public, q).await;
            let hits = items(&reply);
            assert!(hits.iter().any(|h| h["snippet"].as_str().unwrap().contains(marker)), "public {public}: {q}: {hits:?}");
            assert_scrubbed(q, &reply.text(), &[]);
            assert!(!reply.text().contains(HOOK_PASSWORD), "public {public}: {q}");
        }
        let titles = items(&search(&app, public, "GitHub").await);
        assert!(titles.iter().all(|h| h["sessionTitle"] == "Deploy the widgets; my GitHub token is [REDACTED:API_KEY]"), "{titles:?}");
    }
}

/// A database whose index a pika before redaction wrote: public search finds nothing while every other route,
/// health included, answers and the owner's search works; documents ingested meanwhile are indexed scrubbed; the
/// background rewrite scrubs every document, a cut credential's start included, in batches, and records the version.
#[tokio::test]
async fn an_index_written_before_redaction_is_rewritten_in_the_background() {
    let app = world().await;
    let store = app.env.store.clone();
    // A tool call cut at its 4 KiB cap in the middle of a token: what is left of it no rule recognises.
    let cut_token = &GITHUB_TOKEN[..16];
    // An `edit` call cut inside a multi-line private key: its END line, which the PRIVATE_KEY rule needs, is gone.
    let key_lines: Vec<String> = (0..80).map(|i| format!("MIIJ{i:04}{}", "Qk8xZ".repeat(12))).collect();
    let mut cut_key = format!("edit deploy/key.pem oldText -----BEGIN RSA PRIVATE KEY-----\n{}", key_lines.join("\n"));
    cut_key.truncate(pika::derive::search::TOOL_CALL_BYTES);
    let indexed_lines: Vec<&str> = key_lines.iter().map(String::as_str).filter(|l| cut_key.contains(&format!("{l}\n"))).collect();
    let mut docs = vec![
        ("user", format!("Deploy with {GITHUB_TOKEN} today")),
        ("tool-call", format!("{}{cut_token}", "deploy log line ".repeat(255))),
        ("tool-call", cut_key),
    ];
    docs.extend((0..600).map(|i| ("tool-result", format!("note {i}: export OPENAI_API_KEY={OPENAI_KEY}"))));
    forge_unscrubbed(&store, SESSION, &docs);
    assert_eq!(docs[1].1.len(), pika::derive::search::TOOL_CALL_BYTES);
    assert_eq!(docs[2].1.len(), pika::derive::search::TOOL_CALL_BYTES);
    assert!(indexed_lines.len() > 50, "{}", indexed_lines.len());
    assert!(!current(&store));

    let empty = json!({ "items": [], "nextCursor": null });
    for q in ["Deploy", "note", GITHUB_TOKEN] {
        assert_eq!(search(&app, true, q).await.json(), empty, "{q}");
    }
    assert_eq!(app.get("/api/health").await.json()["ok"], true);
    assert_scrubbed("sessions", &app.public("sessions").await.text(), &["[REDACTED:API_KEY]"]);
    assert_eq!(items(&search(&app, false, GITHUB_TOKEN).await).len(), 1, "the owner's search keeps working");
    assert_eq!(items(&search(&app, false, words(cut_token).last().unwrap()).await).len(), 1);
    assert_eq!(items(&search(&app, false, indexed_lines[0]).await).len(), 1);

    let rewrite = pika::reindex::rescrub_in_background(&store).unwrap().expect("a rewrite is needed");
    app.upload(LATE_SESSION, &late_session()).await;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
    while !current(&store) {
        assert!(std::time::Instant::now() < deadline, "the rewrite did not finish");
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    rewrite.join().unwrap();

    assert!(indexed_with(&store, &[GITHUB_TOKEN, OPENAI_KEY, AWS_KEY, cut_token]).is_empty());
    assert_unsearchable(&app, &[GITHUB_TOKEN, OPENAI_KEY, AWS_KEY, cut_token]).await;
    assert!(indexed_with(&store, &indexed_lines).is_empty());
    assert_unsearchable(&app, &indexed_lines).await;
    assert_unsearchable(&app, &["BEGIN"]).await;
    // The marker's own words are indexed, as for a key scrubbed whole; nothing of the key is.
    for public in [false, true] {
        let private = items(&search(&app, public, "PRIVATE").await);
        assert!(!private.is_empty());
        assert!(private.iter().all(|h| h["snippet"] == "edit deploy/key.pem oldText [REDACTED:<mark>PRIVATE</mark>_KEY]"), "{private:?}");
    }
    let edit = search(&app, true, "oldText").await;
    assert!(items(&edit).iter().any(|h| h["snippet"].as_str().unwrap().ends_with("[REDACTED:PRIVATE_KEY]")), "{}", edit.text());
    let deploy = search(&app, true, "Deploy").await;
    assert_scrubbed("Deploy", &deploy.text(), &["[REDACTED:API_KEY]"]);
    assert!(items(&deploy).iter().any(|h| h["snippet"] == "<mark>Deploy</mark> with [REDACTED:API_KEY] today"), "{}", deploy.text());
    assert_eq!(items(&search(&app, true, "note").await).len(), 50);
    let rotate = search(&app, true, "Rotate").await;
    assert_eq!(items(&rotate)[0]["snippet"], "<mark>Rotate</mark> [REDACTED:API_KEY] tonight");
    assert_current_at_version_8(&store);
    assert!(pika::reindex::rescrub_in_background(&store).unwrap().is_none(), "a current index needs no rewrite");
}

/// A rewrite stopped after a batch resumes after the last document it recorded; `pika reindex` writes scrubbed text
/// and records the version.
#[test]
fn the_rewrite_resumes_where_it_stopped_and_reindex_sets_the_version() {
    let env = env();
    upload(&env.store, &format!("session:{SESSION}"), "session", &session(), 100);
    let docs: Vec<(&str, String)> = (0..600).map(|i| ("user", format!("note {i}: export OPENAI_API_KEY={OPENAI_KEY}"))).collect();
    let ids = forge_unscrubbed(&env.store, SESSION, &docs);
    let derived = query(&env.store, "SELECT COUNT(*) AS n FROM search_docs")[0]["n"].as_i64().unwrap() as u64;
    env.store
        .write(|tx| {
            tx.execute(
                "INSERT INTO settings (key, value) VALUES (?1, ?2)",
                // AC-4 permits resuming only progress made under the current target rules.
                rusqlite::params![store::RESCRUB_AFTER, rewrite_cursor(pika::redact::RULES_VERSION, ids[299])],
            )
        })
        .unwrap();
    assert_eq!(pika::reindex::rescrub_search(&env.store).unwrap(), derived - 300);
    let text = |id: i64| one(&env.store, &format!("SELECT text FROM search_docs WHERE id = {id}"))["text"].as_str().unwrap().to_owned();
    assert!(text(ids[299]).contains(OPENAI_KEY), "documents before the resume point are as they were");
    assert_eq!(text(ids[300]), "note 300: export OPENAI_API_KEY=[REDACTED:API_KEY]");
    assert_eq!(indexed_with(&env.store, &[OPENAI_KEY]).len(), 300);
    assert_current_at_version_8(&env.store);

    env.store.write(|tx| tx.execute("DELETE FROM settings WHERE key = ?1", [store::SEARCH_RULES])).unwrap();
    pika::reindex::reindex(&env.store).unwrap();
    assert!(indexed_with(&env.store, &[GITHUB_TOKEN, AWS_KEY, OPENAI_KEY, URL_PASSWORD, FIELD_KEY]).is_empty());
    assert_eq!(query(&env.store, "SELECT COUNT(*) AS n FROM search_docs")[0]["n"].as_i64().unwrap() as u64, derived - 600);
    assert_current_at_version_8(&env.store);
}

const KEYS_SESSION: &str = "5ec2e7a0-0000-4000-8000-000000000005";
const KEYS_CHILD: &str = "5ec2e7a0-0000-4000-8000-0000000000c5";
/// A made-up key that the child's 120-character title cuts after `CUT_KEY_LEFT`.
const CUT_KEY: &str = "sk-proj-FAKE0000FAKE0000FAKE0000";
const CUT_KEY_LEFT: &str = "sk-proj-FAKE00";

/// A made-up key's base64 lines, `width` characters each; each starts with `tag` and its number, so no two are alike.
fn fake_key_lines(tag: &str, width: usize, n: usize) -> Vec<String> {
    (0..n)
        .map(|i| {
            let mut line = format!("{tag}{i:02}{}", "FAKEkeyEXAMPLE".repeat(6));
            line.truncate(width);
            line
        })
        .collect()
}

fn first_chars(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

/// A published session whose first prompt holds an Ed25519 key that its 120-character title cuts the END line (and
/// most of the base64) from, whose reply ends in an RSA key that the 2,000-character `finalText` cuts the same way,
/// and a child whose title is cut inside `CUT_KEY`. Returns the session's lines, the child's, and every key line.
fn cut_sessions() -> (Vec<String>, Vec<String>, Vec<String>) {
    let ed25519 = fake_key_lines("EDfake", 70, 5);
    let rsa = fake_key_lines("RSAfake", 64, 10);
    let prompt = format!(
        "Use this deploy key:\n-----BEGIN OPENSSH PRIVATE KEY-----\n{}\n-----END OPENSSH PRIVATE KEY-----",
        ed25519.join("\n")
    );
    let reply = format!(
        "{}\n-----BEGIN RSA PRIVATE KEY-----\n{}\n-----END RSA PRIVATE KEY-----",
        "Here is the server key you asked for. ".repeat(50),
        rsa.join("\n")
    );
    let lead = "Check the staging deploy and report back whether the widgets build passes there. ".repeat(2);
    let task = format!("{} {CUT_KEY} please", &lead[..105]);
    let session = [
        json!({ "type": "session", "version": 3, "id": KEYS_SESSION, "timestamp": "2026-10-24T09:00:00.000Z", "cwd": "/home/me/code/widgets" }),
        message("k1", None, "2026-10-24T09:00:01.000Z", json!({ "role": "user", "content": prompt, "timestamp": 1792832401000_i64 })),
        message("k2", Some("k1"), "2026-10-24T09:00:03.000Z",
            assistant(json!([{ "type": "text", "text": reply }]), "stop", 1792832403000)),
    ];
    let child = [
        json!({ "type": "session", "version": 3, "id": KEYS_CHILD, "timestamp": "2026-10-24T09:00:04.000Z", "cwd": "/home/me/code/widgets" }),
        json!({ "type": "custom", "id": "kc1", "parentId": null, "timestamp": "2026-10-24T09:00:04.100Z", "customType": "pi-extensions.session-link",
                "data": { "kind": "subagent", "parentSessionId": KEYS_SESSION, "agentId": "agent-5", "agentType": "recon",
                          "description": "Check staging" } }),
        message("kc2", Some("kc1"), "2026-10-24T09:00:04.200Z", json!({ "role": "user", "content": task, "timestamp": 1792832404200_i64 })),
    ];
    let lines = |entries: &[Value]| entries.iter().map(Value::to_string).collect::<Vec<_>>();
    (lines(&session), lines(&child), ed25519.into_iter().chain(rsa).collect())
}

/// Titles and replies derive stored cut keep no part of a credential the cut left without its end, on any public
/// route or in any search snippet; the owner's routes return them as stored.
#[tokio::test]
async fn texts_stored_cut_show_no_part_of_a_cut_credential() {
    let (session, child, key_lines) = cut_sessions();
    let app = App::new();
    app.upload(KEYS_SESSION, &session).await;
    app.upload(KEYS_CHILD, &child).await;
    app.publish("widgets").await;
    let content = |line: &str, at: &str| serde_json::from_str::<Value>(line).unwrap()["message"]["content"].pointer(at).cloned().unwrap();
    let prompt = content(&session[1], "").as_str().unwrap().to_owned();
    let reply = content(&session[2], "/0/text").as_str().unwrap().to_owned();
    let task = content(&child[2], "").as_str().unwrap().to_owned();
    let title = first_chars(&prompt, 120);
    let child_title = first_chars(&task, 120);
    let final_text = first_chars(&reply, 2000);
    // What the cuts left of each key: no END line, part of a line of base64 or of the key.
    assert!(!title.contains("-----END") && title.ends_with(&key_lines[0][..63]), "{title:?}");
    assert!(!final_text.contains("-----END") && final_text.contains(&key_lines[5]), "{final_text:?}");
    assert!(child_title.ends_with(CUT_KEY_LEFT) && !child_title.contains(CUT_KEY), "{child_title:?}");

    // The owner's routes return what derive stored.
    let detail = app.owner(&format!("sessions/{KEYS_SESSION}")).await.json();
    assert_eq!(detail["title"], title);
    assert_eq!(detail["children"][0]["title"], child_title);
    let turns = app.owner(&format!("sessions/{KEYS_SESSION}/turns")).await.json();
    assert_eq!(turns["items"][0]["finalText"], final_text);
    assert_eq!(app.owner(&format!("sessions/{KEYS_CHILD}")).await.json()["title"], child_title);

    let mut parts: Vec<String> = key_lines.iter().map(|line| line[..16].to_owned()).collect();
    parts.extend([key_lines[0][..63].to_owned(), CUT_KEY_LEFT.to_owned(), "BEGIN OPENSSH".into(), "BEGIN RSA".into()]);
    let assert_clean = |path: &str, body: &str| {
        for part in &parts {
            assert!(!body.contains(part.as_str()), "{path} shows {part}: {body}");
        }
    };
    for path in [
        "sessions".to_owned(),
        format!("sessions/{KEYS_SESSION}"),
        format!("sessions/{KEYS_CHILD}"),
        format!("sessions/{KEYS_CHILD}/tree"),
        format!("sessions/{KEYS_SESSION}/turns"),
        format!("sessions/{KEYS_CHILD}/turns"),
        format!("sessions/{KEYS_SESSION}/updates"),
        format!("sessions/{KEYS_SESSION}/trace"),
        format!("sessions/{KEYS_SESSION}/entries"),
    ] {
        assert_clean(&path, &app.public(&path).await.text());
    }
    let detail = app.public(&format!("sessions/{KEYS_SESSION}")).await.json();
    assert_eq!(detail["title"], "Use this deploy key:\n[REDACTED:PRIVATE_KEY]");
    let cut_child = format!("{}[REDACTED:API_KEY]", &child_title[..child_title.len() - CUT_KEY_LEFT.len()]);
    assert_eq!(detail["children"][0]["title"], cut_child);
    let trace = app.public(&format!("sessions/{KEYS_SESSION}/trace")).await.json();
    assert_eq!(trace["children"][0]["title"], cut_child);
    let turns = app.public(&format!("sessions/{KEYS_SESSION}/turns")).await.json();
    assert_eq!(turns["items"][0]["finalText"], format!("{}\n[REDACTED:PRIVATE_KEY]", "Here is the server key you asked for. ".repeat(50)));

    for public in [false, true] {
        for q in ["deploy", "server key", "staging", "widgets"] {
            let hits = items(&search(&app, public, q).await);
            assert!(!hits.is_empty(), "public {public}: {q}");
            for hit in &hits {
                assert_clean(&format!("search {q} (public {public})"), hit["snippet"].as_str().unwrap());
                assert_clean(&format!("search title {q} (public {public})"), hit["sessionTitle"].as_str().unwrap());
            }
        }
    }
}

/// Backlog uploads have ids below the newest old document. Pause after one real batch to exercise that ordering
/// deterministically, including the saved cursor used after a restart.
#[tokio::test]
async fn the_rewrite_leaves_new_documents_with_older_dates_byte_identical() {
    use pika::derive::search::{self, TOOL_RESULT_BYTES};
    let app = App::new();
    let store = &app.env.store;
    app.upload(SESSION, &session()).await;
    app.publish("widgets").await;
    let docs: Vec<_> = (0..300).map(|i| ("tool-result", format!("note {i}: export OPENAI_API_KEY={OPENAI_KEY}"))).collect();
    forge_unscrubbed(store, SESSION, &docs);
    let newest = forge_unscrubbed_at(store, SESSION, &[("user", format!("newest {GITHUB_TOKEN}"))], 1792918800)[0]; // October 25
    let (after, count) = store.write(|tx| {
        let result = search::rescrub(tx, &store.blobs, i64::MIN, 256)?.unwrap();
        tx.execute("INSERT INTO settings (key, value) VALUES (?1, ?2)",
            rusqlite::params![store::RESCRUB_AFTER, rewrite_cursor(pika::redact::RULES_VERSION, result.0)])?;
        Ok::<_, anyhow::Error>(result)
    }).unwrap();
    assert_eq!(count, 256);
    assert!(after < newest && !current(store));

    let tail = " DB_PASSWORD=FAKEpa";
    let pad = "rotate the widgets cache ".repeat(TOOL_RESULT_BYTES / 10);
    let text = format!("{}{tail} and then the rest", &pad[..TOOL_RESULT_BYTES - tail.len()]);
    let backlog = [
        json!({ "type": "session", "version": 3, "id": LATE_SESSION, "timestamp": "2026-10-01T09:00:00.000Z", "cwd": "/home/me/code/widgets" }),
        message("b1", None, "2026-10-01T09:00:01.000Z", tool_result("backlog", "read", &text, 1790845201000)),
        message("b2", Some("b1"), "2026-10-01T09:00:02.000Z", assistant(json!([
            { "type": "toolCall", "id": "fake-mixed", "name": "bash", "arguments": {
                "command": "API_KEY=FAKE1234_token_EXAMPLE\nredis://:token_EXAMPLE@fake.example\ncurl --data '{\"client_secret\":\"FAKE mixed phrase\"}'",
                "client_secret": "FAKE mixed phrase", "echo": "FAKE mixed phrase" } },
        ]), "toolUse", 1790845202000)),
    ].iter().map(Value::to_string).collect::<Vec<_>>();
    app.upload(LATE_SESSION, &backlog).await;
    let sql = format!("SELECT d.id, d.text FROM search_docs d JOIN sessions s ON s.sid = d.sid WHERE s.id = '{LATE_SESSION}'");
    let before = query(store, &sql);
    assert_eq!(before.len(), 2);
    assert!(before[1]["text"].as_str().unwrap().contains("API_KEY=FAKE1234_[REDACTED:PASSWORD]"));
    assert!(!before[1]["text"].as_str().unwrap().contains("FAKE mixed phrase"));
    let id = before[0]["id"].as_i64().unwrap();
    assert!(after < id && id < newest);
    assert_eq!(before[0]["text"], &text[..TOOL_RESULT_BYTES]);
    assert_eq!(items(&search(&app, false, "FAKEpa").await).len(), 1);
    assert!(items(&search(&app, true, "widgets").await).is_empty());
    assert_eq!(app.get("/api/health").await.json()["ok"], true);

    pika::reindex::rescrub_search(store).unwrap();
    assert_eq!(query(store, &sql), before);
    for public in [false, true] {
        assert_eq!(items(&search(&app, public, "FAKEpa").await).len(), 1);
    }
    assert_unsearchable(&app, &[GITHUB_TOKEN, OPENAI_KEY]).await;
    assert_current_at_version_8(store);
}

/// Capped old documents are rebuilt from every supported source kind, including multiple tool calls in one
/// entry and a blob-backed line. Ordinary text before the credential survives, and a second rewrite changes nothing.
#[tokio::test]
async fn capped_documents_are_rebuilt_from_their_whole_source_lines() {
    use pika::derive::search::{TEXT_BYTES, TOOL_CALL_BYTES, TOOL_RESULT_BYTES};
    let app = App::new();
    let store = &app.env.store;
    let crossing = |cap: usize, lead: &str| {
        let mut prefix = format!("{lead}{}", "ordinary widgets ".repeat(cap / 8));
        prefix.truncate(cap - 32);
        format!("{prefix} {GITHUB_TOKEN} done")
    };
    let user = crossing(TEXT_BYTES, "user ");
    let reply = crossing(TEXT_BYTES, "assistant ");
    let result = crossing(TOOL_RESULT_BYTES, "result ");
    let title = crossing(TEXT_BYTES, "title ");
    let first_call = crossing(TOOL_CALL_BYTES, "bash\ncommand: first ");
    let second_call = crossing(TOOL_CALL_BYTES, "bash\ncommand: second ");
    let lines = [
        json!({ "type": "session", "version": 3, "id": SESSION, "timestamp": "2026-10-25T09:00:00.000Z", "cwd": "/home/me/code/widgets" }),
        message("s1", None, "2026-10-25T09:00:01.000Z", json!({ "role": "user", "content": user })),
        message("s2", Some("s1"), "2026-10-25T09:00:02.000Z", assistant(json!([
            { "type": "text", "text": reply },
            { "type": "toolCall", "id": "first", "name": "bash", "arguments": { "command": first_call.strip_prefix("bash\ncommand: ").unwrap() } },
            { "type": "text", "text": "" },
            { "type": "toolCall", "id": "second", "name": "bash", "arguments": { "command": second_call.strip_prefix("bash\ncommand: ").unwrap() } },
        ]), "toolUse", 1792918802000)),
        message("s3", Some("s2"), "2026-10-25T09:00:03.000Z", tool_result("first", "bash", &result, 1792918803000)),
        json!({ "type": "session_info", "name": title, "timestamp": "2026-10-25T09:00:04.000Z" }),
    ].iter().map(Value::to_string).collect::<Vec<_>>();
    app.upload(SESSION, &lines).await;
    app.publish("widgets").await;
    let indexed = query(store, "SELECT id, kind, seq, text FROM search_docs ORDER BY id");
    assert_eq!(indexed.len(), 6);
    let sources = [(&user, TEXT_BYTES), (&reply, TEXT_BYTES), (&first_call, TOOL_CALL_BYTES),
        (&second_call, TOOL_CALL_BYTES), (&result, TOOL_RESULT_BYTES), (&title, TEXT_BYTES)];
    let hash = pika::util::sha256_hex(lines[3].as_bytes());
    store.blobs.put(&hash, lines[3].as_bytes()).unwrap();
    store.write(|tx| {
        tx.execute("UPDATE lines SET data = NULL, blob = ?1 WHERE offset = (SELECT offset FROM entries WHERE seq = 3)", [&hash])?;
        for (doc, (source, cap)) in indexed.iter().zip(&sources) {
            let id = doc["id"].as_i64().unwrap();
            let old = pika::util::cut_bytes(source, *cap);
            assert_eq!(old.len(), *cap);
            assert!(!old.contains(GITHUB_TOKEN), "the credential straddles the cap");
            assert!(old.contains(&GITHUB_TOKEN[..16]));
            tx.execute("INSERT INTO search_fts (search_fts, rowid, text) VALUES ('delete', ?1, ?2)", rusqlite::params![id, doc["text"].as_str().unwrap()])?;
            tx.execute("UPDATE search_docs SET text = ?2 WHERE id = ?1", rusqlite::params![id, old])?;
            tx.execute("INSERT INTO search_fts (rowid, text) VALUES (?1, ?2)", rusqlite::params![id, old])?;
        }
        tx.execute("DELETE FROM settings WHERE key = ?1", [store::SEARCH_RULES])?;
        Ok::<_, rusqlite::Error>(())
    }).unwrap();
    pika::reindex::rescrub_search(store).unwrap();
    assert_eq!(query(store, "SELECT id, kind, seq, text FROM search_docs ORDER BY id"), indexed);
    for (doc, (source, cap)) in indexed.iter().zip(&sources) {
        let text = doc["text"].as_str().unwrap();
        assert!(text.starts_with(&source[..cap - 32]));
        assert!(text.contains("[REDACTED:API_KEY]"));
    }
    assert_unsearchable(&app, &[GITHUB_TOKEN, &GITHUB_TOKEN[..16]]).await;
    store.write(|tx| tx.execute("DELETE FROM settings WHERE key = ?1", [store::SEARCH_RULES])).unwrap();
    pika::reindex::rescrub_search(store).unwrap();
    assert_eq!(query(store, "SELECT id, kind, seq, text FROM search_docs ORDER BY id"), indexed);
    assert_current_at_version_8(store);
}

/// AC-3/6 require shared discoveries within one entry, including a secret named beyond the cap. Identical old
/// prefixes cannot identify a call; harmless suffixes exposed by scrubbing still prove its actual source.
/// Collisions can put the second row before the first numerically or move it into the next second entirely.
#[tokio::test]
async fn capped_tool_calls_with_shared_prefixes_keep_their_own_sources() {
    use pika::derive::search::{self, Kind, TOOL_CALL_BYTES};
    const FAKE_SECRET: &str = "FakeSharedPrefixSecret7654";
    for collisions in ["none", "low-wrap", "next-second", "last-second"] {
        let at = if collisions == "last-second" { i32::MAX as i64 * 1000 } else { 1792918801000 };
        let timestamp = if collisions == "last-second" { "2038-01-19T03:14:07.000Z" } else { "2026-10-25T09:00:01.000Z" };
        let app = App::new();
        let store = &app.env.store;
        let header = json!({ "type": "session", "version": 3, "id": SESSION,
            "timestamp": "2026-10-25T09:00:00.000Z", "cwd": "/home/me/code/widgets" }).to_string();
        app.upload(SESSION, &[header.clone()]).await;
        let sid = one(store, "SELECT sid FROM sessions")["sid"].as_i64().unwrap();
        store.write(|tx| {
            let start = match collisions { "low-wrap" => 10, "next-second" | "last-second" => 0, _ => 4095 };
            for part in start..4095 {
                search::index(tx, sid, 0, part, at, Kind::User, "ordinary collision filler")?;
            }
            Ok::<_, anyhow::Error>(())
        }).unwrap();
        let mut prefix = format!("bash\ncommand: {FAKE_SECRET} {}", "ordinary widgets ".repeat(TOOL_CALL_BYTES));
        prefix.truncate(TOOL_CALL_BYTES);
        let first = format!("{prefix} alpha");
        let second = format!("{prefix} omega\nDB_PASSWORD={FAKE_SECRET}\n");
        let entry = message("shared", None, timestamp, assistant(json!([
            { "type": "toolCall", "id": "empty", "name": "" },
            { "type": "text", "text": "" },
            { "type": "toolCall", "id": "first", "name": "bash", "arguments": { "command": first.strip_prefix("bash\ncommand: ").unwrap() } },
            { "type": "text", "text": "" },
            { "type": "toolCall", "id": "second", "name": "bash", "arguments": { "command": second.strip_prefix("bash\ncommand: ").unwrap() } },
        ]), "toolUse", at)).to_string();
        app.upload(SESSION, &[header, entry]).await;
        app.publish("widgets").await;
        let sql = "SELECT id, text FROM search_docs WHERE kind = 'tool-call' ORDER BY id";
        let indexed = query(store, sql);
        assert_eq!(indexed.len(), 2);
        let first_row = indexed.iter().find(|row| row["text"].as_str().unwrap().contains(" alpha")).unwrap();
        let second_row = indexed.iter().find(|row| row["text"].as_str().unwrap().contains(" omega")).unwrap();
        for row in &indexed {
            assert!(row["text"].as_str().unwrap().contains("[REDACTED:SECRET]"));
        }
        assert_unsearchable(&app, &[FAKE_SECRET]).await;
        let first_id = first_row["id"].as_i64().unwrap();
        let second_id = second_row["id"].as_i64().unwrap();
        match collisions {
            "low-wrap" => assert!(second_id < first_id),
            "next-second" => assert_eq!((second_id >> 32) - (first_id >> 32), 1),
            "last-second" => assert_eq!((first_id >> 32, second_id >> 32), (i32::MAX as i64, 0)),
            _ => assert_eq!(second_id, first_id + 1),
        }
        store.write(|tx| {
            for doc in &indexed {
                let id = doc["id"].as_i64().unwrap();
                tx.execute("INSERT INTO search_fts (search_fts, rowid, text) VALUES ('delete', ?1, ?2)",
                    rusqlite::params![id, doc["text"].as_str().unwrap()])?;
                tx.execute("UPDATE search_docs SET text = ?2 WHERE id = ?1", rusqlite::params![id, prefix])?;
                tx.execute("INSERT INTO search_fts (rowid, text) VALUES (?1, ?2)", rusqlite::params![id, prefix])?;
            }
            tx.execute("DELETE FROM settings WHERE key = ?1", [store::SEARCH_RULES])?;
            Ok::<_, rusqlite::Error>(())
        }).unwrap();
        assert_eq!(items(&search(&app, false, FAKE_SECRET).await).len(), 2);
        // A single-row batch also proves source identity does not depend on which sibling is already scrubbed.
        store.write(|tx| search::rescrub(tx, &store.blobs, indexed[0]["id"].as_i64().unwrap() - 1, 1)).unwrap();
        pika::reindex::rescrub_search(store).unwrap();
        assert_eq!(query(store, sql), indexed, "{collisions}");
        assert_unsearchable(&app, &[FAKE_SECRET]).await;
        store.write(|tx| tx.execute("DELETE FROM settings WHERE key = ?1", [store::SEARCH_RULES])).unwrap();
        pika::reindex::rescrub_search(store).unwrap();
        assert_eq!(query(store, sql), indexed, "current documents stay byte-identical: {collisions}");
        assert_current_at_version_8(store);
    }
}

/// AC-3/4 share discoveries across assistant text, tool names and argument names/values within one entry.
/// Every single-row rewrite must read the whole source, including discoveries beyond either document's cap.
#[tokio::test]
async fn assistant_entry_discoveries_cross_documents_before_capping_and_during_rewrite() {
    use pika::derive::search::{self, TEXT_BYTES, TOOL_CALL_BYTES};
    const FAKE_SECRET: &str = "FAKEentryorchid-FAKEentrypetal-7654";
    for discovery in ["field", "assignment", "assistant"] {
        for reversed in [false, true] {
            let app = App::new();
            let store = &app.env.store;
            let mut text = format!("textneighbor {FAKE_SECRET}");
            let mut arguments = json!({ "region": format!("discoveryneighbor {FAKE_SECRET}") });
            match discovery {
                "field" => {
                    arguments["padding"] = json!("ordinary ".repeat(TOOL_CALL_BYTES));
                    arguments["client_secret"] = json!(FAKE_SECRET);
                }
                "assignment" => {
                    arguments["command"] = json!(format!("{}\nDB_PASSWORD={FAKE_SECRET}", "ordinary ".repeat(TOOL_CALL_BYTES)));
                }
                _ => text.push_str(&format!(" {}\nDB_PASSWORD={FAKE_SECRET}", "ordinary ".repeat(TEXT_BYTES))),
            }
            let mut blocks = vec![
                json!({ "type": "text", "text": text }),
                json!({ "type": "toolCall", "id": "fake-echo", "name": FAKE_SECRET,
                    "arguments": { FAKE_SECRET: "echoneighbor", "echo": FAKE_SECRET } }),
                json!({ "type": "toolCall", "id": "fake-discovery", "name": "configure", "arguments": arguments }),
            ];
            if reversed { blocks.reverse(); }
            let lines = [
                json!({ "type": "session", "version": 3, "id": SESSION,
                    "timestamp": "2026-10-25T09:00:00.000Z", "cwd": "/home/me/code/widgets" }).to_string(),
                message("fake-shared-entry", None, "2026-10-25T09:00:01.000Z",
                    assistant(Value::Array(blocks), "toolUse", 1792918801000)).to_string(),
            ];
            app.upload(SESSION, &lines).await;
            app.publish("widgets").await;
            let sql = "SELECT id, kind, seq, text FROM search_docs ORDER BY id";
            let expected = query(store, sql);
            assert_eq!(expected.len(), 3);
            assert_eq!(expected[0]["kind"], "assistant");
            assert!(expected.iter().all(|doc| doc["text"].as_str().unwrap().contains("[REDACTED:SECRET]")));
            let credentials = [FAKE_SECRET, "FAKEentryorchid", "FAKEentrypetal"];
            assert_unsearchable(&app, &credentials).await;
            assert_eq!(app.owner(&format!("sessions/{SESSION}/entries/1/raw")).await.json(), serde_json::from_str::<Value>(&lines[1]).unwrap());

            for blob in [false, true] {
                if blob {
                    let hash = pika::util::sha256_hex(lines[1].as_bytes());
                    store.blobs.put(&hash, lines[1].as_bytes()).unwrap();
                    store.write(|tx| tx.execute("UPDATE lines SET data = NULL, blob = ?1 WHERE offset = (SELECT offset FROM entries WHERE seq = 1)", [&hash])).unwrap();
                }
                for public in [false, true] {
                    for neighbor in ["textneighbor", "echoneighbor", "discoveryneighbor"] {
                        let hits = items(&search(&app, public, neighbor).await);
                        assert_eq!(hits.len(), 1, "{discovery}, reversed {reversed}, blob {blob}: {neighbor}");
                        let snippet = hits[0]["snippet"].as_str().unwrap();
                        assert!(snippet.contains("[REDACTED:SECRET]"), "{snippet}");
                        assert!(snippet.contains(&format!("<mark>{neighbor}</mark>")), "{snippet}");
                    }
                }
                let old = format!("oldneighbor {FAKE_SECRET}");
                store.write(|tx| {
                    for doc in &expected {
                        let id = doc["id"].as_i64().unwrap();
                        tx.execute("INSERT INTO search_fts (search_fts, rowid, text) VALUES ('delete', ?1, ?2)", rusqlite::params![id, doc["text"].as_str().unwrap()])?;
                        tx.execute("UPDATE search_docs SET text = ?2 WHERE id = ?1", rusqlite::params![id, old])?;
                        tx.execute("INSERT INTO search_fts (rowid, text) VALUES (?1, ?2)", rusqlite::params![id, old])?;
                    }
                    tx.execute("DELETE FROM settings WHERE key = ?1", [store::SEARCH_RULES])?;
                    Ok::<_, rusqlite::Error>(())
                }).unwrap();
                assert_eq!(items(&search(&app, false, "FAKEentryorchid").await).len(), 3);
                assert!(items(&search(&app, true, "oldneighbor").await).is_empty());
                for (i, doc) in expected.iter().enumerate() {
                    let id = doc["id"].as_i64().unwrap();
                    assert_eq!(store.write(|tx| search::rescrub(tx, &store.blobs, id - 1, 1)).unwrap(), Some((id, 1)));
                    let partial = query(store, sql);
                    assert_eq!(partial[..=i], expected[..=i], "{discovery}, reversed {reversed}, blob {blob}");
                    assert!(partial[i + 1..].iter().all(|row| row["text"] == old));
                    assert_eq!(items(&search(&app, false, "FAKEentryorchid").await).len(), 2 - i);
                }
                pika::reindex::rescrub_search(store).unwrap();
                assert_eq!(query(store, sql), expected);
                assert_unsearchable(&app, &credentials).await;
                assert_current_at_version_8(store);
            }
        }
    }
}

/// Search must retain field semantics before flattening tool arguments, including echoes in ordinary arguments.
/// Rewriting both short and formerly capped documents uses the same raw/blob source extraction as ingest.
#[tokio::test]
async fn structured_arguments_are_unsearchable_and_rebuilt_at_every_size() {
    use pika::derive::search::TOOL_CALL_BYTES;
    let app = App::new();
    let store = &app.env.store;
    let cases = [
        ("api_key", "FAKElettersOnly", "lettersneighbor"),
        ("client_secret", "FAKEphraseorchid FAKEphrasepetal", "phraseneighbor"),
        ("session_token", "87654321", "numericneighbor"),
    ];
    let mut blocks: Vec<Value> = cases.iter().enumerate().map(|(i, (field, secret, neighbor))| {
        json!({ "type": "toolCall", "id": format!("fake-{i}"), "name": "configure",
            "arguments": { *field: secret, "a_echo": secret, "region": neighbor } })
    }).collect();
    blocks.push(json!({ "type": "toolCall", "id": "fake-body", "name": "bash", "arguments": {
        "command": "curl --data '{\"client_secret\":\"FAKEbodyOnly\"}' https://fake.example/bodyneighbor" } }));
    // The old field's huge value was already replaced by an earlier rule, leaving a short document. Its ordinary
    // echo still needs reconstruction from the whole source, even though the stored text is now below the cap.
    let long_secret = format!("FAKElongsecret{}", "q".repeat(TOOL_CALL_BYTES * 2));
    blocks.push(json!({ "type": "toolCall", "id": "fake-shrunk", "name": "configure", "arguments": {
        "api_key": long_secret, "z_echo": long_secret, "region": "shrunkneighbor" } }));
    let header = json!({ "type": "session", "version": 3, "id": SESSION,
        "timestamp": "2026-10-25T09:00:00.000Z", "cwd": "/home/me/code/widgets" }).to_string();
    let lines = [header, message("fake-args", None, "2026-10-25T09:00:01.000Z",
        assistant(Value::Array(blocks), "toolUse", 1792918801000)).to_string()];
    app.upload(SESSION, &lines).await;
    app.publish("widgets").await;
    let sql = "SELECT id, text FROM search_docs WHERE kind = 'tool-call' ORDER BY id";
    let expected = query(store, sql);
    assert_eq!(expected.len(), 5);
    let credentials = ["FAKElettersOnly", "FAKEphraseorchid FAKEphrasepetal", "FAKEphraseorchid", "87654321", "FAKEbodyOnly", "FAKElongsecret"];
    assert_unsearchable(&app, &credentials).await;
    for public in [false, true] {
        for neighbor in ["lettersneighbor", "phraseneighbor", "numericneighbor", "bodyneighbor", "shrunkneighbor"] {
            let hits = items(&search(&app, public, neighbor).await);
            assert_eq!(hits.len(), 1, "{neighbor}: {hits:?}");
            assert!(hits[0]["snippet"].as_str().unwrap().contains("[REDACTED"));
            assert!(hits[0]["snippet"].as_str().unwrap().contains(&format!("<mark>{neighbor}</mark>")));
        }
    }
    assert_eq!(app.owner(&format!("sessions/{SESSION}/entries/1/raw")).await.json(), serde_json::from_str::<Value>(&lines[1]).unwrap());

    for blob in [false, true] {
        if blob {
            let hash = pika::util::sha256_hex(lines[1].as_bytes());
            store.blobs.put(&hash, lines[1].as_bytes()).unwrap();
            store.write(|tx| tx.execute("UPDATE lines SET data = NULL, blob = ?1 WHERE offset = (SELECT offset FROM entries WHERE seq = 1)", [&hash])).unwrap();
        }
        store.write(|tx| {
            let old = [
                "configure\napi_key: FAKElettersOnly\na_echo: FAKElettersOnly\nregion: lettersneighbor".to_string(),
                "configure\nclient_secret: FAKEphraseorchid FAKEphrasepetal\na_echo: FAKEphraseorchid FAKEphrasepetal\nregion: phraseneighbor".to_string(),
                "configure\nsession_token: 87654321\na_echo: 87654321\nregion: numericneighbor".to_string(),
                "bash\ncommand: curl --data '{\"client_secret\":\"FAKEbodyOnly\"}' https://fake.example/bodyneighbor".to_string(),
                "configure\napi_key: [REDACTED]\nregion: shrunkneighbor\nz_echo: FAKElongsecret".to_string(),
            ];
            for (doc, text) in expected.iter().zip(old) {
                let id = doc["id"].as_i64().unwrap();
                tx.execute("INSERT INTO search_fts (search_fts, rowid, text) VALUES ('delete', ?1, ?2)", rusqlite::params![id, doc["text"].as_str().unwrap()])?;
                tx.execute("UPDATE search_docs SET text = ?2 WHERE id = ?1", rusqlite::params![id, text])?;
                tx.execute("INSERT INTO search_fts (rowid, text) VALUES (?1, ?2)", rusqlite::params![id, text])?;
            }
            tx.execute("DELETE FROM settings WHERE key = ?1", [store::SEARCH_RULES])?;
            Ok::<_, rusqlite::Error>(())
        }).unwrap();
        assert!(!items(&search(&app, false, "FAKEphraseorchid").await).is_empty());
        assert!(items(&search(&app, true, "phraseneighbor").await).is_empty());
        pika::reindex::rescrub_search(store).unwrap();
        assert_eq!(query(store, sql), expected, "blob source: {blob}");
        assert_unsearchable(&app, &credentials).await;
        assert_current_at_version_8(store);
    }
}

/// AC-3 covers every indexed argument string, including map names. Names share discoveries with values, while
/// the original secret-field names still classify their values. Scrubbed name collisions must keep both neighbors.
#[tokio::test]
async fn argument_property_credentials_never_enter_either_search_index() {
    let app = App::new();
    let store = &app.env.store;
    let url_secret = "FAKEmappass4826";
    let github = format!("ghp_FAKE{}", "7".repeat(32));
    let other_github = format!("ghp_FAKE{}", "8".repeat(32));
    let phrase = "FAKEmapword FAKEpetal";
    let arguments = json!({
        format!("https://deployer:{url_secret}@example.invalid/"): "deployneighbor",
        "targets": [{
            &github: "vendorneighbor",
            &other_github: "otherneighbor",
            phrase: "echoneighbor",
            "client_secret": phrase,
            "echo": url_secret,
        }],
    });
    let lines = [
        json!({ "type": "session", "version": 3, "id": SESSION,
            "timestamp": "2026-10-25T09:00:00.000Z", "cwd": "/home/me/code/widgets" }).to_string(),
        message("fake-map", None, "2026-10-25T09:00:01.000Z", assistant(json!([
            { "type": "toolCall", "id": "fake-map-call", "name": "configure", "arguments": arguments }
        ]), "toolUse", 1792918801000)).to_string(),
    ];
    app.upload(SESSION, &lines).await;
    app.publish("widgets").await;
    let sql = "SELECT id, text FROM search_docs WHERE kind = 'tool-call' ORDER BY id";
    let expected = query(store, sql);
    assert_eq!(expected.len(), 1);
    let credentials = [url_secret, github.as_str(), other_github.as_str(), phrase, "FAKEmapword"];
    assert_unsearchable(&app, &credentials).await;
    let text = expected[0]["text"].as_str().unwrap();
    for credential in credentials { assert!(!text.contains(credential), "{text}"); }
    assert!(text.contains("\"client_secret\":\"[REDACTED]\""), "{text}");
    assert_eq!(app.owner(&format!("sessions/{SESSION}/entries/1/raw")).await.json(), serde_json::from_str::<Value>(&lines[1]).unwrap());

    for blob in [false, true] {
        if blob {
            let hash = pika::util::sha256_hex(lines[1].as_bytes());
            store.blobs.put(&hash, lines[1].as_bytes()).unwrap();
            store.write(|tx| tx.execute("UPDATE lines SET data = NULL, blob = ?1 WHERE offset = (SELECT offset FROM entries WHERE seq = 1)", [&hash])).unwrap();
        }
        let id = expected[0]["id"].as_i64().unwrap();
        let old = format!("configure\n{arguments}");
        store.write(|tx| {
            tx.execute("INSERT INTO search_fts (search_fts, rowid, text) VALUES ('delete', ?1, ?2)", rusqlite::params![id, text])?;
            tx.execute("UPDATE search_docs SET text = ?2 WHERE id = ?1", rusqlite::params![id, old])?;
            tx.execute("INSERT INTO search_fts (rowid, text) VALUES (?1, ?2)", rusqlite::params![id, old])?;
            tx.execute("DELETE FROM settings WHERE key = ?1", [store::SEARCH_RULES])?;
            Ok::<_, rusqlite::Error>(())
        }).unwrap();
        assert_eq!(items(&search(&app, false, url_secret).await).len(), 1);
        pika::reindex::rescrub_search(store).unwrap();
        assert_eq!(query(store, sql), expected, "blob source: {blob}");
        assert_unsearchable(&app, &credentials).await;
        for public in [false, true] {
            for neighbor in ["deployneighbor", "vendorneighbor", "otherneighbor", "echoneighbor"] {
                assert_eq!(items(&search(&app, public, neighbor).await).len(), 1, "{neighbor}");
            }
        }
    }
}

/// AC-1/6/7 apply to session-content property names and contextual identifiers on both entry routes.
#[tokio::test]
async fn public_entry_names_and_identifiers_keep_values_images_and_owner_bytes() {
    let app = App::new();
    let first = format!("ghp_FAKE{}", "7".repeat(32));
    let second = format!("ghp_FAKE{}", "8".repeat(32));
    let digest = "0123456789abcdef".repeat(4);
    let uuid = "00000000-0000-4000-8000-000000000000";
    let hex_credential = "abcdef0123456789".repeat(4);
    let padded_digest = format!("{digest}\n");
    let padded_uuid = format!(" {uuid} ");
    let arguments = json!({
        "before": [{ "FAKElettersOnly": "before neighbor" }],
        "client_secret": "FAKElettersOnly",
        "after": { "FAKElettersOnly": "after neighbor" },
        "names": {
            &first: "first neighbor", &second: "second neighbor",
            "[REDACTED:API_KEY]": "literal marker", "[REDACTED:API_KEY]#2": "literal suffix",
            "https://fake:FAKEurlPhrase@example.invalid/": "url neighbor",
        },
        "echo": "FAKEurlPhrase",
        "body": r#"{"\u0046AKElettersOnly":"embedded neighbor","echo":"FAKEurlPhrase"}"#,
        "identifiers": { "secret_hash": digest, "session_token_id": uuid, "echoes": [digest, uuid] },
        // AC-7 keeps command-output whitespace exact and does not learn identifier echoes.
        "padded_identifiers": { "secret_hash": padded_digest, "session_token_id": padded_uuid, "echoes": [padded_digest, padded_uuid] },
        "identifier_body": json!({ "secret_hash": padded_digest, "session_token_id": padded_uuid, "echoes": [padded_digest, padded_uuid] }).to_string(),
        "marker_name": { "client_secret": "[FAKEopaquevalue]", "api[FAKEopaquevalue]key": "cached", "api[REDACTED:SECRET]key": "literal cached" },
        "credentials": { "api_key": hex_credential, "echo": hex_credential },
        "padded_credentials": { "api_key": format!(" {hex_credential}\n"), "echo": format!(" {hex_credential}\n") },
    });
    let entry = message("fake-properties", None, "2026-10-25T09:00:01.000Z", assistant(json!([
        { "type": "toolCall", "id": "fake-properties-call", "name": "configure", "arguments": arguments },
        { "type": "image", "mimeType": "image/png", "data": first },
    ]), "toolUse", 1792918801000));
    let raw = entry.to_string().replace(r#""FAKElettersOnly":"before neighbor""#, r#""\u0046AKElettersOnly":"before neighbor""#);
    let lines = [
        json!({ "type": "session", "version": 3, "id": SESSION,
            "timestamp": "2026-10-25T09:00:00.000Z", "cwd": "/home/me/code/widgets" }).to_string(),
        raw,
    ];
    app.upload(SESSION, &lines).await;
    app.publish("widgets").await;
    let expected = json!({
        "before": [{ "[REDACTED:SECRET]": "before neighbor" }],
        "client_secret": "[REDACTED]",
        "after": { "[REDACTED:SECRET]": "after neighbor" },
        "names": {
            "[REDACTED:API_KEY]#3": "first neighbor", "[REDACTED:API_KEY]#4": "second neighbor",
            "[REDACTED:API_KEY]": "literal marker", "[REDACTED:API_KEY]#2": "literal suffix",
            "https://fake:[REDACTED:PASSWORD]@example.invalid/": "url neighbor",
        },
        "echo": "[REDACTED:PASSWORD]",
        "body": r#"{"[REDACTED:SECRET]":"embedded neighbor","echo":"[REDACTED:PASSWORD]"}"#,
        "identifiers": arguments["identifiers"],
        "padded_identifiers": arguments["padded_identifiers"],
        "identifier_body": arguments["identifier_body"],
        "marker_name": { "client_secret": "[REDACTED]", "api[REDACTED:SECRET]key#2": "cached", "api[REDACTED:SECRET]key": "literal cached" },
        "credentials": { "api_key": "[REDACTED]", "echo": "[REDACTED:SECRET]" },
        "padded_credentials": { "api_key": "[REDACTED]", "echo": "[REDACTED:SECRET]" },
    });
    let entries_path = format!("sessions/{SESSION}/entries");
    let raw_path = format!("sessions/{SESSION}/entries/1/raw");
    let public_entries = app.public(&entries_path).await.json();
    let public_raw = app.public(&raw_path).await.text();
    assert_eq!(public_raw.lines().count(), 1);
    let public: Value = serde_json::from_str(&public_raw).unwrap();
    assert_eq!(public["message"]["content"][0]["arguments"], expected);
    assert_eq!(public_entries["items"][1]["raw"]["message"]["content"][0]["arguments"], expected);
    assert_eq!(public["message"]["content"][1], entry["message"]["content"][1]);
    assert_eq!(public["message"]["usage"], entry["message"]["usage"]);
    for field in ["id", "type", "parentId", "timestamp"] { assert_eq!(public[field], entry[field]); }
    assert_eq!(app.owner(&raw_path).await.text(), lines[1]);
    let owner_entries = app.owner(&entries_path).await.json();
    assert_eq!(owner_entries["items"][1]["raw"]["message"]["content"][0]["arguments"], arguments);
    for field in ["seq", "offset", "type", "id", "timestamp"] {
        assert_eq!(public_entries["items"][1][field], owner_entries["items"][1][field]);
    }
}

/// Cut vendor prefixes are scrubbed in both search namespaces. A title's findings also protect other hits'
/// snippets, even if highlighting splits the learned phrase. HTML in unchanged snippets remains escaped.
#[tokio::test]
async fn search_titles_and_snippets_share_a_cut_aware_scope() {
    let app = App::new();
    let lead = "widgets ".repeat(14);
    let key = format!("ghp_FAKE{}", "0".repeat(32));
    let lines = [
        json!({ "type": "session", "version": 3, "id": SESSION,
            "timestamp": "2026-10-25T09:00:00.000Z", "cwd": "/home/me/code/widgets" }).to_string(),
        message("fake-title", None, "2026-10-25T09:00:01.000Z", json!({ "role": "user", "content": format!("{lead}{key}") })).to_string(),
        message("fake-echo", None, "2026-10-25T09:00:02.000Z", json!({ "role": "user", "content": "<b>widgets</b> FAKE phraseorchid words" })).to_string(),
    ];
    app.upload(SESSION, &lines).await;
    app.publish("widgets").await;
    for public in [false, true] {
        let hits = items(&search(&app, public, "widgets").await);
        assert_eq!(hits.len(), 2);
        assert!(hits.iter().all(|h| h["sessionTitle"] == format!("{lead}[REDACTED:API_KEY]")));
        assert!(hits.iter().any(|h| h["snippet"].as_str().unwrap().contains("&lt;b&gt;<mark>widgets</mark>&lt;/b&gt;")));
    }
    app.env.store.write(|tx| tx.execute("UPDATE sessions SET title = ?1", [r#"widgets {"client_secret":"FAKE phraseorchid words"}"#])).unwrap();
    for public in [false, true] {
        let reply = search(&app, public, "phraseorchid").await;
        let hits = items(&reply);
        assert_eq!(hits.len(), 1);
        assert!(!reply.text().contains("phraseorchid"));
        assert!(hits[0]["snippet"].as_str().unwrap().contains("&lt;b&gt;widgets&lt;/b&gt; [REDACTED:SECRET]"));
    }
}

/// Grouped/prefix search was added independently of redaction. Both output shapes must keep the same publication
/// gate and scrub root titles, hit titles and snippets together, including relevance lookups and HTML highlights.
#[tokio::test]
async fn grouped_prefix_search_preserves_redaction_and_rewrite_gating() {
    let app = App::new();
    let lead = "widgets ".repeat(14);
    let key = format!("ghp_FAKE{}", "0".repeat(32));
    let lines = [
        json!({ "type": "session", "version": 3, "id": SESSION,
            "timestamp": "2026-10-25T09:00:00.000Z", "cwd": "/home/me/code/widgets" }).to_string(),
        message("merge-title", None, "2026-10-25T09:00:01.000Z",
            json!({ "role": "user", "content": format!("{lead}{key}") })).to_string(),
        message("merge-echo", None, "2026-10-25T09:00:02.000Z",
            json!({ "role": "user", "content": "<b>widgets</b> FAKE phraseorchid words" })).to_string(),
    ];
    app.upload(SESSION, &lines).await;
    app.publish("widgets").await;
    for group in ["entry", "session"] {
        for sort in ["newest", "relevance"] {
            let suffix = format!("&group={group}&sort={sort}&prefix=true");
            for public in [false, true] {
                let namespace = if public { "public/v1" } else { "v1" };
                let reply = app.get(&format!("/api/{namespace}/search?q=wid{suffix}")).await;
                let entries = items(&reply);
                assert!(!entries.is_empty(), "{group} {sort}");
                assert!(!reply.text().contains("ghp_FAKE"));
                assert!(reply.text().contains("[REDACTED:API_KEY]"));
                for entry in &entries {
                    assert_eq!(entry["sessionTitle"], format!("{lead}[REDACTED:API_KEY]"));
                }
                let hits: Vec<&Value> = if group == "session" {
                    entries.iter().flat_map(|e| e["hits"].as_array().unwrap()).collect()
                } else { entries.iter().collect() };
                assert!(hits.iter().all(|h| h["sessionTitle"] == format!("{lead}[REDACTED:API_KEY]")));
                assert!(hits.iter().any(|h| h["snippet"].as_str().unwrap().contains("&lt;b&gt;<mark>widgets</mark>&lt;/b&gt;")));
                let absent = app.get(&format!("/api/{namespace}/search?q={}{suffix}", encode_path_segment(&key))).await;
                assert!(items(&absent).is_empty(), "credential was indexed: {group} {sort}");
            }
            app.env.store.write(|tx| tx.execute("DELETE FROM settings WHERE key = ?1", [store::SEARCH_RULES])).unwrap();
            assert!(items(&app.public(&format!("search?q=wid{suffix}")).await).is_empty());
            assert!(!items(&app.owner(&format!("search?q=wid{suffix}")).await).is_empty());
            app.env.store.write(store::set_search_rules_current).unwrap();
        }
    }
    // The root group's title can teach the response a value absent from the indexed snippet's context.
    app.env.store.write(|tx| tx.execute("UPDATE sessions SET title = ?1",
        [r#"widgets {"client_secret":"FAKE phraseorchid words"}"#])).unwrap();
    for public in [false, true] {
        for sort in ["newest", "relevance"] {
            let namespace = if public { "public/v1" } else { "v1" };
            let reply = app.get(&format!("/api/{namespace}/search?q=phraseorc&prefix=true&group=session&sort={sort}")).await;
            assert!(!items(&reply).is_empty());
            assert!(!reply.text().contains("phraseorchid"));
            assert!(reply.text().contains("[REDACTED:SECRET]"));
            assert!(reply.text().contains("&lt;b&gt;widgets&lt;/b&gt;"));
        }
    }
    assert_current_at_version_8(&app.env.store);
}

/// Missing entries, unreadable blobs and invalid JSON all keep the capped ordinary text through the fallback.
#[test]
fn capped_documents_with_unreadable_sources_stay_nonempty() {
    use pika::derive::search::TOOL_RESULT_BYTES;
    for damage in ["missing", "blob", "json"] {
        let env = env();
        upload(&env.store, &format!("session:{SESSION}"), "session", &session(), 100);
        let tail = " DATABASE_URL=postgres://app:FAKEpass0";
        let mut text = "ordinary widgets ".repeat(TOOL_RESULT_BYTES / 8);
        text.truncate(TOOL_RESULT_BYTES - tail.len());
        text.push_str(tail);
        let id = forge_unscrubbed(&env.store, SESSION, &[("tool-result", text.clone())])[0];
        env.store.write(|tx| {
            match damage {
                "missing" => tx.execute("DELETE FROM lines WHERE offset = (SELECT offset FROM entries WHERE seq = 1)", [])?,
                "blob" => tx.execute("UPDATE lines SET data = NULL, blob = ?1 WHERE offset = (SELECT offset FROM entries WHERE seq = 1)", ["0".repeat(64)])?,
                _ => tx.execute("UPDATE lines SET data = 'not JSON' WHERE offset = (SELECT offset FROM entries WHERE seq = 1)", [])?,
            };
            Ok::<_, rusqlite::Error>(())
        }).unwrap();
        pika::reindex::rescrub_search(&env.store).unwrap();
        assert_eq!(one(&env.store, &format!("SELECT text FROM search_docs WHERE id = {id}"))["text"], text.replace("FAKEpass0", "[REDACTED:PASSWORD]"), "{damage}");
        assert_current_at_version_8(&env.store);
    }
}

#[test]
fn unknown_rewrite_positions_restart_from_the_beginning() {
    use rusqlite::types::Value as SqlValue;
    let values = [b"9223372036854775807 9223372036854775807".as_slice(), b"unknown", b"\xff", b"9223372036854775808"]
        .into_iter()
        .map(|value| SqlValue::Blob(value.to_vec()))
        .chain([
            SqlValue::Text(i64::MAX.to_string()), SqlValue::Integer(i64::MAX),
            // AC-4: legacy bare ids and progress toward another rules version cannot skip any prefix.
            SqlValue::Blob(i64::MAX.to_string().into_bytes()),
            SqlValue::Blob(rewrite_cursor(pika::redact::RULES_VERSION - 1, i64::MAX)),
            SqlValue::Blob(rewrite_cursor(pika::redact::RULES_VERSION + 1, i64::MAX)),
            SqlValue::Blob(br#"{"target":7,"after":"broken"}"#.to_vec()),
        ]);
    for value in values {
        let env = env();
        upload(&env.store, &format!("session:{SESSION}"), "session", &session(), 100);
        forge_unscrubbed(&env.store, SESSION, &[("user", format!("Deploy {GITHUB_TOKEN}"))]);
        env.store.write(|tx| tx.execute("INSERT INTO settings (key, value) VALUES (?1, ?2)", rusqlite::params![store::RESCRUB_AFTER, value])).unwrap();
        pika::reindex::rescrub_search(&env.store).unwrap();
        assert!(indexed_with(&env.store, &[GITHUB_TOKEN]).is_empty());
        assert_current_at_version_8(&env.store);
    }
}

/// The rewrite scrubs text a pika before redaction indexed at its cap as cut text: ordinary text, with no blank in it
/// or only near its start, comes out whole; the start of a credential at its end becomes the marker of its kind; and a
/// document this pika indexes while the rewrite runs is left exactly as it was indexed.
#[tokio::test]
async fn the_rewrite_keeps_ordinary_text_at_the_cap_and_leaves_new_documents_alone() {
    use pika::derive::search::{TEXT_BYTES, TOOL_RESULT_BYTES};
    let app = App::new();
    let store = app.env.store.clone();
    app.upload(SESSION, &session()).await;
    app.publish("widgets").await;

    let minified: String = (0..1_000).map(|i| format!(r#"{{"id":{i},"name":"widget{i:04}","size":{}}},"#, i * 7)).collect();
    let capped = |s: String| {
        let mut s = s;
        s.truncate(TOOL_RESULT_BYTES);
        s
    };
    let no_blank = capped(format!("[{minified}"));
    let early_blank = capped(format!("Output:\n[{minified}"));
    let tail = "DATABASE_URL=postgres://app:FAKEpass0";
    let mut partial = "deploy log line ".repeat(1_100);
    partial.truncate(TOOL_RESULT_BYTES - tail.len() - 1);
    partial.push(' ');
    partial.push_str(tail);
    let mut docs = vec![("tool-result", no_blank.clone()), ("tool-result", early_blank.clone()), ("tool-result", partial.clone())];
    docs.extend((0..600).map(|i| ("tool-result", format!("note {i}: export OPENAI_API_KEY={OPENAI_KEY}"))));
    let ids = forge_unscrubbed(&store, SESSION, &docs);
    assert!(docs[..3].iter().all(|(_, text)| text.len() == TOOL_RESULT_BYTES));

    // A prompt this pika indexes at its 64 KiB cap, cut after what reads like the start of a password: too short for
    // the SECRET rule, so it was not a credential in the whole text, and the rewrite must not scrub it as cut text.
    let pad = "rotate the widgets cache ".repeat(TEXT_BYTES / 25);
    let pad = &pad[..TEXT_BYTES - " DB_PASSWORD=FAKEpa".len()];
    let late_prompt = format!("{pad} DB_PASSWORD=FAKEpa and then the rest");
    let late_indexed = &late_prompt[..TEXT_BYTES];
    let late = [
        json!({ "type": "session", "version": 3, "id": LATE_SESSION, "timestamp": "2026-10-23T09:00:00.000Z", "cwd": "/home/me/code/widgets" }),
        message("l1", None, "2026-10-23T09:00:01.000Z", json!({ "role": "user", "content": late_prompt, "timestamp": 1792746001000_i64 })),
    ]
    .iter()
    .map(Value::to_string)
    .collect::<Vec<_>>();

    let rewrite = pika::reindex::rescrub_in_background(&store).unwrap().expect("a rewrite is needed");
    app.upload(LATE_SESSION, &late).await;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
    while !current(&store) {
        assert!(std::time::Instant::now() < deadline, "the rewrite did not finish");
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    rewrite.join().unwrap();

    let text = |id: i64| one(&store, &format!("SELECT text FROM search_docs WHERE id = {id}"))["text"].as_str().unwrap().to_owned();
    assert_eq!(text(ids[0]), no_blank);
    assert_eq!(text(ids[1]), early_blank);
    assert_eq!(text(ids[2]), partial.replace("FAKEpass0", "[REDACTED:PASSWORD]"));
    assert_eq!(text(ids[3]), "note 0: export OPENAI_API_KEY=[REDACTED:API_KEY]");
    let late_docs: Vec<String> = query(&store, "SELECT text FROM search_docs WHERE kind = 'user'")
        .into_iter()
        .map(|row| row["text"].as_str().unwrap().to_owned())
        .filter(|text| text.starts_with("rotate the widgets cache"))
        .collect();
    assert_eq!(late_docs, [late_indexed]);
    assert_unsearchable(&app, &["FAKEpass0"]).await;
    for public in [false, true] {
        for (q, n) in [("widget0100", 2), ("Output", 1), ("log", 1)] {
            assert_eq!(items(&search(&app, public, q).await).len(), n, "public {public}: {q}");
        }
    }
    assert_current_at_version_8(&store);
}
