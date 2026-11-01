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
const UNPUBLISHED_FIELDS: [&str; 3] = ["requestId", "link", "herderRunId"];

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
