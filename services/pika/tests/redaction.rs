//! What `pika::redact` takes out of public responses, and what it leaves as written. Every credential here is made
//! up and says so (FAKE, EXAMPLE, or a repeated run) while keeping the shape its rule asks for. Many cases are
//! ported from magpie's tests (https://github.com/yetone/magpie, MIT), with their values replaced.

use std::borrow::Cow;

use pika::redact::{REDACTED, RULES_VERSION, Scope, scrub_content, scrub_cut_text, scrub_text, secret_name};
use serde_json::{Value, json};

/// Sixteen characters, for keys whose rule wants an exact length.
macro_rules! f16 {
    () => {
        "FAKEFAKEFAKEFAKE"
    };
}

const OPENAI_KEY: &str = concat!("sk-proj-", f16!(), "0000");
const ANTHROPIC_KEY: &str = "sk-ant-api03-FAKEEXAMPLE0000000000";
const PLAIN_SK_KEY: &str = "sk-FAKEEXAMPLE0123456789abcdef";
const RELAY_KEY: &str = "oc_sk_EXAMPLE0000FAKE0000KEY";
const GITHUB_TOKEN: &str = concat!("ghp_", f16!(), f16!(), "00");
const GITHUB_PAT: &str = concat!("github_pat_11FAKE0000_", f16!(), f16!());
const GITLAB_TOKEN: &str = "glpat-FAKEEXAMPLE0000000000";
const GOOGLE_KEY: &str = concat!("AIzaSy", f16!(), f16!(), "0");
const SLACK_TOKEN: &str = "xoxb-0000000000-FAKEFAKEFAKE";
const STRIPE_KEY: &str = concat!("sk_live_", f16!(), "0000");
const STRIPE_RESTRICTED: &str = concat!("rk_live_", f16!(), "1111");
const AWS_KEY_ID: &str = "AKIAFAKEEXAMPLE00000";
const AWS_SESSION_KEY_ID: &str = "ASIAFAKEEXAMPLE11111";
const HF_TOKEN: &str = concat!("hf_", f16!(), f16!());
const GROQ_KEY: &str = concat!("gsk_", f16!(), f16!(), "FAKEFAKE");
const XAI_KEY: &str = concat!("xai-", f16!(), f16!(), "FAKEFAKE");
const NPM_TOKEN: &str = concat!("npm_", f16!(), f16!(), "FAKE");
const PYPI_TOKEN: &str = concat!("pypi-", f16!(), f16!(), f16!(), "FAKE");
const DO_TOKEN: &str = "dop_v1_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
/// pika's own device token: pika_ and 64 lowercase hex.
const PIKA_TOKEN: &str = "pika_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const SENDGRID_KEY: &str = concat!("SG.", f16!(), "FAKE00", ".", f16!(), f16!(), "FAKEFAKE000");
const JWT: &str = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJGQUtFIn0.FAKEsignatureEXAMPLE";
const PEM_BODY: &str = "MIIEFAKEFAKEFAKEFAKEEXAMPLEKEYBODY0000";

/// Each case: the text, the credential in it, and what it must become.
fn redact_cases() -> Vec<(String, &'static str, &'static str)> {
    let s = |t: String, v: &'static str, k: &'static str| (t, v, k);
    vec![
        // ---- private keys
        s(format!("$ cat ~/.ssh/id_rsa\n-----BEGIN RSA PRIVATE KEY-----\n{PEM_BODY}\nFAKEFAKEFAKE==\n-----END RSA PRIVATE KEY-----\n"), PEM_BODY, "PRIVATE_KEY"),
        s(format!(r#"{{"path":"deploy.pem","content":"-----BEGIN PRIVATE KEY-----\n{PEM_BODY}\n-----END PRIVATE KEY-----\n"}}"#), PEM_BODY, "PRIVATE_KEY"),
        // ---- vendor keys
        s(format!("export OPENAI_API_KEY={OPENAI_KEY}"), OPENAI_KEY, "API_KEY"),
        s(format!("ANTHROPIC_API_KEY: {ANTHROPIC_KEY}\nMODEL: claude-opus"), ANTHROPIC_KEY, "API_KEY"),
        s(format!("I tested it with {PLAIN_SK_KEY} and the request went through."), PLAIN_SK_KEY, "API_KEY"),
        s(format!(r#"client = OpenAI(api_key="{OPENAI_KEY}")"#), OPENAI_KEY, "API_KEY"),
        s(format!(r#"curl -H "X-Relay-Key: {RELAY_KEY}" https://relay.example.org/v1/models"#), RELAY_KEY, "API_KEY"),
        s(format!("gh auth login --with-token <<< {GITHUB_TOKEN}"), GITHUB_TOKEN, "API_KEY"),
        s(format!("GITHUB_TOKEN={GITHUB_PAT}\nGITHUB_OWNER=acme"), GITHUB_PAT, "API_KEY"),
        s(format!(r#"export GITLAB_TOKEN="{GITLAB_TOKEN}""#), GITLAB_TOKEN, "API_KEY"),
        s(format!("const maps = '{GOOGLE_KEY}';\nconst zoom = 12;"), GOOGLE_KEY, "API_KEY"),
        s(format!("SLACK_BOT_TOKEN={SLACK_TOKEN}"), SLACK_TOKEN, "API_KEY"),
        s(format!(r#"stripe.api_key = "{STRIPE_KEY}""#), STRIPE_KEY, "API_KEY"),
        s(format!("Use the restricted key {STRIPE_RESTRICTED} for the webhook worker."), STRIPE_RESTRICTED, "API_KEY"),
        s(format!("[default]\naws_access_key_id = {AWS_KEY_ID}\nregion = eu-central-1"), AWS_KEY_ID, "API_KEY"),
        s(format!("2026-10-21T09:14:03Z INFO assumed role, credentials {AWS_SESSION_KEY_ID} valid for 3600s"), AWS_SESSION_KEY_ID, "API_KEY"),
        s(format!("huggingface-cli login --token {HF_TOKEN}"), HF_TOKEN, "API_KEY"),
        s(format!("GROQ_API_KEY={GROQ_KEY}"), GROQ_KEY, "API_KEY"),
        s(format!("The xAI key is {XAI_KEY} (rotate it next week)."), XAI_KEY, "API_KEY"),
        s(format!("$ cat ~/.npmrc\n//registry.npmjs.org/:_authToken={NPM_TOKEN}"), NPM_TOKEN, "API_KEY"),
        s(format!("[pypi]\nusername = __token__\npassword = {PYPI_TOKEN}"), PYPI_TOKEN, "API_KEY"),
        s(format!("doctl auth init --access-token {DO_TOKEN}"), DO_TOKEN, "API_KEY"),
        s(format!("node seed.mjs http://127.0.0.1:7171 {PIKA_TOKEN}"), PIKA_TOKEN, "API_KEY"),
        s(format!("Paired: the device token is {PIKA_TOKEN}."), PIKA_TOKEN, "API_KEY"),
        // AC-6 replaces a secret-named JSON field's whole value, even when a vendor rule also matches it.
        s(format!(r#"{{"mail":{{"provider":"sendgrid","apiKey":"{SENDGRID_KEY}"}}}}"#), SENDGRID_KEY, ""),
        // ---- tokens
        s(format!("2026-10-21 DEBUG session restored token={JWT}"), JWT, "TOKEN"),
        s(format!(r#"{{"id_token":"{JWT}","expires_in":3600}}"#), JWT, ""),
        s(format!("curl -H 'Authorization: Bearer {JWT}' https://api.example.org/v1/me"), JWT, "TOKEN"),
        s("GET /v1/projects HTTP/1.1\nHost: api.example.org\nAuthorization: Bearer FAKEtokenEXAMPLE0000\nAccept: */*".into(), "FAKEtokenEXAMPLE0000", "TOKEN"),
        // A Basic credential is taken only when it is base64 of user:password, so this case's value, once
        // FAKEbase64EXAMPLE00== (not base64), is now FAKEuser:EXAMPLEpass00 encoded.
        s("curl -s -H \"authorization: Basic RkFLRXVzZXI6RVhBTVBMRXBhc3MwMA==\" https://ci.example.org/api".into(), "RkFLRXVzZXI6RVhBTVBMRXBhc3MwMA==", "TOKEN"),
        s(r#"{"headers":{"Authorization": "Bearer FAKEheaderTOKEN1234"},"method":"POST"}"#.into(), "FAKEheaderTOKEN1234", ""),
        // ---- passwords in URLs
        s("DATABASE_URL=postgres://app:FAKEpass1234@db.internal:5432/orders".into(), "FAKEpass1234", "PASSWORD"),
        s("REDIS_URL=redis://:FAKEredis5678@cache.internal:6379/0".into(), "FAKEredis5678", "PASSWORD"),
        s("mysql --url mysql://root:FAKEroot0000@10.0.0.5/shop -e 'select 1'".into(), "FAKEroot0000", "PASSWORD"),
        s("Connected to mongodb+srv://admin:FAKEmongo2026@cluster0.example.mongodb.net/app".into(), "FAKEmongo2026", "PASSWORD"),
        // ---- assignments to secret-named names
        s("API_KEY=FAKE0000EXAMPLE1111\nDEBUG=true".into(), "FAKE0000EXAMPLE1111", "SECRET"),
        s("DB_HOST=localhost\nDB_PASSWORD=FAKE-Tr0ub4dor&3\n".into(), "FAKE-Tr0ub4dor&3", "SECRET"),
        s("database:\n  user: app\n  password: \"FAKEhunter2Example\"\n".into(), "FAKEhunter2Example", "SECRET"),
        s(r#"{"client_id": "web", "client_secret": "FAKE0secret0EXAMPLE"}"#.into(), "FAKE0secret0EXAMPLE", ""),
        s(r#"{"command":"echo '{\"password\": \"FAKEpass9876\"}' > cfg.json"}"#.into(), "FAKEpass9876", ""),
        s("aws_secret_access_key = FAKEwJalrXUtnFEMI7EXAMPLEKEY".into(), "FAKEwJalrXUtnFEMI7EXAMPLEKEY", "SECRET"),
        s("SECRET_KEY='django-insecure-FAKE0example0key'".into(), "django-insecure-FAKE0example0key", "SECRET"),
        s("auth:\n  token: FAKEt0k3nValue2\n".into(), "FAKEt0k3nValue2", "SECRET"),
        s("2026-10-21T09:14:03Z DEBUG sending request with x-api-key: FAKE0000apikey0000".into(), "FAKE0000apikey0000", "SECRET"),
        s(r#"{"providers":[{"name":"relay","key":"FAKE0000EXAMPLE0000KEY"}]}"#.into(), "FAKE0000EXAMPLE0000KEY", ""),
        // ---- passwords and keys named in Chinese
        s("服务器密码是 FAKEpw1234，用完记得改掉".into(), "FAKEpw1234", "PASSWORD"),
        s("新的密钥为 FAKEkey0000EXAMPLE".into(), "FAKEkey0000EXAMPLE", "SECRET"),
        s("测试环境的 token 是 FAKE0token0EXAMPLE".into(), "FAKE0token0EXAMPLE", "SECRET"),
    ]
}

/// Texts that must come back byte for byte: the false positives magpie documents.
const KEEP: &[&str] = &[
    // file paths and file:line locations
    "Look at internal/auth/token.go:L643-669.",
    "see src/secret_store.ts:L643-669 and internal/redact/password_test.go:L12-30",
    "PRIVATE_KEY_PATH=~/.ssh/id_ed25519",
    "GOOGLE_APPLICATION_CREDENTIALS=/Users/alice/.config/gcloud/legacy_credentials/x7k2p9q1/adc.json",
    "--token-file=/tmp/tok-a8f3k2x9/token",
    "skills/secret-scanner:x7k2p9q1",
    "internal/redact/model.go:212:9: undefined: epochNumber (pid 48213, exit status 2)",
    // identifiers and calls
    "access_token = get_access_token_v2()",
    "  secret: env.SECRET_V2",
    "const apiKey = process.env.API_KEY;",
    "password = getPassword()",
    "self.token = generate_token_v2",
    r#"TOKEN_V2 = "TOKEN_V2""#,
    "tokenCount = countTokens4o",
    "- design-tokens:generate-v2: Generate tokens",
    // versions
    r#"{"dependencies": {"js-tokens": "^4.0.0-beta.1", "jsonwebtoken": "9.2.0-beta1"}}"#,
    // placeholders
    "export OPENAI_API_KEY=${OPENAI_API_KEY}",
    r#"curl -H "Authorization: Bearer $TOKEN" https://api.example.org/v1/me"#,
    "password: <password>\nDATABASE_URL=postgres://app:<password>@db/app",
    "DB_PASSWORD=********",
    "API_KEY=xxxxxxxxxxxx",
    "set API_KEY=%API_KEY%",
    "postgres://app:${DB_PASS}@db/app",
    // token counts
    "max_tokens: 4096\nmax_tokens=32000000",
    r#"{"usage": {"input_tokens": 1520, "output_tokens": 830, "total_tokens": 2350}}"#,
    "token_count=14998722",
    "<system-reminder><total_tokens>14902266 tokens left</total_tokens></system-reminder>",
    // git hashes, digests, UUIDs
    "commit 919585d1700e515ac38da49e31bc60a527fc15c2\nAuthor: dev <dev@users.noreply.github.com>",
    "sha256: 80efc1803eda7c095a79741d2008c07e2e0a57b01bac8825fbeb448fd097998c",
    "secret_hash: 80efc1803eda7c095a79741d2008c07e2e0a57b01bac8825fbeb448fd097998c",
    "session_token_id: 3f2b6c1e-8a4d-4f7e-9b1a-2c3d4e5f6a7b",
    "next_page_token: 019a2b3c4d5e7f608a9b0c1d2e3f4a5b",
    "Read ~/.claude/projects/-Users-dev-app/3f2b6c1e-8a4d-4f7e-9b1a-2c3d4e5f6a7b.jsonl for the transcript.",
    // short or word values of a "key" field
    r#"{"key": "value", "sort_key": "created_at"}"#,
    // slugs after sk-
    "https://www.cnbc.com/2026/10/28/sk-hynix-third-quarter-profit.html",
    // email addresses
    "Author: Jane Smith <jane.smith@gmail.com>",
    // URL passwords anyone reading the URL already reads
    "postgres://postgres:postgres@localhost:5432/app",
    r#""url": "postgresql://geo:geo@db/geo""#,
    // prose and code that only names secrets
    "rg -n 'password|passwd|secret_key|api_token' --glob '*.go'",
    "the tokenizer splits words",
    "[providers]\ngroqAPIKey = \"gsk_x…\"\nclaudeAPIModel = \"claude-3-5-sonnet-20241022\"",
    r#"{"type":"tool_result","tool_use_id":"toolu_01XkP9qLm2VbT7wZ4nR8sYc3","content":"ok"}"#,
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA+k5zM7Md7tM9ehxd51xF/isvM9",
    // pika's own names, and pika_ before what is not 64 lowercase hex
    "use pika_config::load; let pika_server = pika_config.server;",
    "pika_0123456789abcdef is too short for a device token",
    "pika_0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF",
    "pika_0123456789abcdefg123456789abcdef0123456789abcdef0123456789abcdef",
];

#[test]
fn credentials_are_redacted() {
    let cases = redact_cases();
    assert!(cases.len() >= 40, "{} redact cases", cases.len());
    for (text, value, kind) in &cases {
        let out = scrub_text(text);
        assert!(!out.contains(value), "{value} kept in {out:?}");
        let marker = if kind.is_empty() { REDACTED.to_owned() } else { format!("[REDACTED:{kind}]") };
        assert!(out.contains(&marker), "{marker} missing from {out:?}");
    }
}

#[test]
fn scrubbing_is_idempotent() {
    for (text, _, _) in redact_cases() {
        let once = scrub_text(&text);
        assert_eq!(scrub_text(&once), once, "second scrub changed {text:?}");
    }
    for marker in ["[REDACTED]", "[REDACTED:PRIVATE_KEY]", "[REDACTED:API_KEY]", "[REDACTED:TOKEN]", "[REDACTED:PASSWORD]", "[REDACTED:SECRET]"] {
        for text in [
            format!("API_KEY={marker}"),
            format!("password: {marker}"),
            format!(r#"{{"client_secret": "{marker}"}}"#),
            format!("Authorization: Bearer {marker}"),
        ] {
            assert_eq!(scrub_text(&text), text);
        }
    }
}

#[test]
fn false_positives_come_back_as_written() {
    assert!(KEEP.len() >= 30, "{} keep cases", KEEP.len());
    for text in KEEP {
        let out = scrub_text(text);
        assert_eq!(out, *text);
        assert!(matches!(out, Cow::Borrowed(_)), "{text:?} was copied");
    }
}

#[test]
fn surrounding_text_is_kept() {
    assert_eq!(
        scrub_text("DATABASE_URL=postgres://app:FAKEpass1234@db.internal:5432/orders"),
        "DATABASE_URL=postgres://app:[REDACTED:PASSWORD]@db.internal:5432/orders"
    );
    assert_eq!(scrub_text(&format!("export OPENAI_API_KEY={OPENAI_KEY}")), "export OPENAI_API_KEY=[REDACTED:API_KEY]");
    assert_eq!(
        scrub_text("curl -H 'Authorization: Bearer FAKEtokenEXAMPLE0000' https://api.example.org"),
        "curl -H 'Authorization: Bearer [REDACTED:TOKEN]' https://api.example.org"
    );
}

#[test]
fn secret_names() {
    for name in ["password", "DB_PASSWORD", "passwd", "client_secret", "access_token", "api_key", "x-api-key", "apiKey",
        "access_key", "private_key", "credentials", "Authorization", "authorisation", "Set-Cookie", "key", "KEY"]
    {
        assert!(secret_name(name), "{name}");
    }
    for name in ["max_tokens", "maxTokens", "input_tokens", "token_count", "keyboard", "sort_key", "model", "data", "monkey",
        "[REDACTED:API_KEY]", "[REDACTED:SECRET]#2", "https://fake:[REDACTED:PASSWORD]@example.invalid/"] {
        assert!(!secret_name(name), "{name}");
    }
    assert!(secret_name("api_key [REDACTED]"));
}

#[test]
fn content_fields_named_for_secrets() {
    let image = "iVBORw0KGgo/AKIAFAKEEXAMPLE00000/AAAA";
    let data_url = format!("data:image/png;base64,{image}");
    let mut entry = json!({
        "type": "message",
        "message": {
            "role": "assistant",
            "content": [
                { "type": "text", "text": "Retried with FAKEtokenEXAMPLE0000 and it worked." },
                { "type": "toolCall", "id": "call_1", "name": "bash",
                  "arguments": { "command": "export API_KEY=FAKE0000EXAMPLE1111 && ./deploy.sh" } },
                { "type": "image", "data": image, "mimeType": "image/png" },
                { "type": "input_image", "image_url": data_url },
            ],
            "usage": { "max_tokens": 4096, "maxTokens": "8192", "input_tokens": 1200, "token_count": 12 },
        },
        "headers": { "Authorization": "Bearer FAKEtokenEXAMPLE0000", "cookie": "sid=FAKEsession0000" },
        "config": { "password": "FAKEpass1234", "key": "value", "api_key": ["FAKEkey0001", "FAKEkey0002"], "passwd": 1234 },
        "custom": { "data": { "note": format!("aws {AWS_KEY_ID}") } },
    });
    scrub_content(&mut entry);

    let content = &entry["message"]["content"];
    assert_eq!(content[0]["text"], "Retried with [REDACTED:SECRET] and it worked.");
    assert_eq!(content[1]["arguments"]["command"], "export API_KEY=[REDACTED:SECRET] && ./deploy.sh");
    assert_eq!(content[2]["data"], image, "an image's data is left alone");
    assert_eq!(content[3]["image_url"], data_url.as_str(), "a data: URL is left alone");
    assert_eq!(entry["message"]["usage"], json!({ "max_tokens": 4096, "maxTokens": "8192", "input_tokens": 1200, "token_count": 12 }));
    assert_eq!(entry["headers"], json!({ "Authorization": REDACTED, "cookie": REDACTED }));
    // AC-7 keeps short/word bare keys in structured content as well as in text.
    assert_eq!(entry["config"], json!({ "password": REDACTED, "key": "value", "api_key": [REDACTED, REDACTED], "passwd": 1234 }));
    assert_eq!(entry["custom"]["data"]["note"], "aws [REDACTED:API_KEY]", "data outside an image is text");
    assert_eq!(entry["type"], "message");
}

#[test]
fn found_values_are_replaced_across_a_scope() {
    let mut before = "echo FAKEpass1234 | psql -U app orders".to_string();
    let mut found = "DB_PASSWORD=FAKEpass1234".to_string();
    let mut after = "Retrying with FAKEpass1234.".to_string();
    let mut field_echo = "login used FAKEfield0000pass".to_string();
    let mut content = json!({ "arguments": { "password": "FAKEfield0000pass", "user": "app" } });
    let mut short = "redis://:FAKE1@cache:6379".to_string();
    let mut short_echo = "FAKE1 is too short to follow".to_string();
    let mut untouched = "nothing to see here".to_string();

    let mut scope = Scope::new();
    scope.text(&mut before);
    scope.text(&mut found);
    scope.text(&mut after);
    scope.text(&mut field_echo);
    scope.content(&mut content);
    scope.text(&mut short);
    scope.text(&mut short_echo);
    scope.text(&mut untouched);
    scope.finish();

    assert_eq!(before, "echo [REDACTED:SECRET] | psql -U app orders");
    assert_eq!(found, "DB_PASSWORD=[REDACTED:SECRET]");
    assert_eq!(after, "Retrying with [REDACTED:SECRET].");
    assert_eq!(field_echo, "login used [REDACTED:SECRET]", "a secret field's value found before it");
    assert_eq!(content, json!({ "arguments": { "password": REDACTED, "user": "app" } }));
    assert_eq!(short, "redis://:[REDACTED:PASSWORD]@cache:6379");
    assert_eq!(short_echo, "FAKE1 is too short to follow");
    assert_eq!(untouched, "nothing to see here");
}

#[test]
fn a_known_value_inside_a_longer_word_stays() {
    let mut found = "API_KEY=FAKE0000EXAMPLE1111".to_string();
    let mut longer = "xFAKE0000EXAMPLE1111y is another word".to_string();
    let mut scope = Scope::new();
    scope.text(&mut found);
    scope.text(&mut longer);
    scope.finish();
    assert_eq!(found, "API_KEY=[REDACTED:SECRET]");
    assert_eq!(longer, "xFAKE0000EXAMPLE1111y is another word");
}

#[test]
fn other_json_is_scrubbed_as_text_only() {
    let mut value: Value = json!({ "title": "DB_PASSWORD=FAKEpass1234", "password": "plainword" });
    let mut scope = Scope::new();
    scope.strings(&mut value);
    scope.finish();
    assert_eq!(value, json!({ "title": "DB_PASSWORD=[REDACTED:SECRET]", "password": "plainword" }));
}

/// A secret field's value is a credential wherever else the response has it, letters alone or not; a bare `key`
/// field's word is not.
#[test]
fn secret_field_values_of_letters_alone_are_learned() {
    let mut before = "logged in with EXAMPLEpassphrase".to_string();
    let mut content = json!({ "arguments": { "password": "EXAMPLEpassphrase" } });
    let mut after = "logged in with EXAMPLEpassphrase".to_string();
    let mut scope = Scope::new();
    scope.text(&mut before);
    scope.content(&mut content);
    scope.text(&mut after);
    scope.finish();
    assert_eq!(before, "logged in with [REDACTED:SECRET]");
    assert_eq!(content, json!({ "arguments": { "password": REDACTED } }));
    assert_eq!(after, "logged in with [REDACTED:SECRET]");

    for field in ["password", "client_secret", "token", "api_key"] {
        let mut content = json!({ field: "FAKEonlyLETTERSvalue" });
        let mut echo = "echo FAKEonlyLETTERSvalue".to_string();
        let mut scope = Scope::new();
        scope.content(&mut content);
        scope.text(&mut echo);
        scope.finish();
        assert_eq!(content, json!({ field: REDACTED }), "{field}");
        assert_eq!(echo, "echo [REDACTED:SECRET]", "{field}");
    }

    let mut content = json!({ "key": "settings" });
    let mut text = "open the settings page".to_string();
    let mut scope = Scope::new();
    scope.content(&mut content);
    scope.text(&mut text);
    scope.finish();
    // AC-7's word-key exception preserves the field itself, not just its echoes.
    assert_eq!(content, json!({ "key": "settings" }));
    assert_eq!(text, "open the settings page");
}

/// What docs write after Bearer or Basic in a credential's place.
const AUTH_PLACEHOLDERS: &[&str] = &[
    "Authorization: Bearer ACCESS_TOKEN",
    "Authorization: Bearer YOUR_API_KEY",
    "Authorization: Bearer <token>",
    "Authorization: Bearer ${TOKEN}",
    "Authorization: Basic username:password",
    "Authorization: Bearer credentials",
];

#[test]
fn authorization_placeholders_are_kept() {
    for header in AUTH_PLACEHOLDERS {
        for text in [header.to_string(), format!("curl -H '{header}' https://api.example.org/v1/me")] {
            assert_eq!(scrub_text(&text), text);

            let mut doc = text.clone();
            let mut export = "export ACCESS_TOKEN=$(gh auth token)".to_string();
            let mut user = r#"{"username": "alice", "credentials": "none"}"#.to_string();
            let mut scope = Scope::new();
            scope.text(&mut doc);
            scope.text(&mut export);
            scope.text(&mut user);
            scope.finish();
            assert_eq!(doc, text);
            assert_eq!(export, "export ACCESS_TOKEN=$(gh auth token)");
            // AC-6 applies whole-field semantics to JSON source even when its value is a short word.
            assert_eq!(user, r#"{"username": "alice", "credentials": "[REDACTED]"}"#);
        }
    }
}

#[test]
fn authorization_credentials_are_redacted() {
    let basic = "dXNlcjpFWEFNUExFcGFzcw=="; // user:EXAMPLEpass
    // a token named for its kind, as Notion's integration tokens are: secret_ then random base62
    let named = "secret_FAKEnotionEXAMPLE0123456789abcdefABCDEFGHIJ";
    // an opaque numeric session token, 19 digits alone
    let numeric = "1234567890123456789";
    for value in [JWT, OPENAI_KEY, "EXAMPLE0a1b2c3d4e5f6g7h8", named, "key_FAKE3ZZexample0123456789", basic, numeric] {
        let scheme = if value == basic { "Basic" } else { "Bearer" };
        for text in [
            format!("GET /v1/me HTTP/1.1\nAuthorization: {scheme} {value}\nAccept: */*"),
            format!(r#"curl -H "Authorization: {scheme} {value}" https://api.example.org/v1/me"#),
        ] {
            let out = scrub_text(&text);
            assert!(!out.contains(value), "{value} kept in {out:?}");
            assert!(out.contains(&format!("Authorization: {scheme} [REDACTED:")), "{out:?}");
        }
    }
}

/// The value after Bearer or Basic in a field named for a secret is learned as any secret field's value is, letters
/// alone too, and replaced in the scope's other texts before the field and after it; a name in ALL_CAPS is not.
#[test]
fn authorization_field_values_are_learned() {
    for (header, value) in [("Bearer FAKElettersonly", "FAKElettersonly"), ("Basic FAKEuserpass00", "FAKEuserpass00")] {
        let mut before = format!("sent {value} to the API");
        let mut content = json!({ "headers": { "authorization": header } });
        let mut after = format!("the server rejected {value}.");
        let mut scope = Scope::new();
        scope.text(&mut before);
        scope.content(&mut content);
        scope.text(&mut after);
        scope.finish();
        assert_eq!(before, "sent [REDACTED:SECRET] to the API", "{header}");
        assert_eq!(content, json!({ "headers": { "authorization": REDACTED } }));
        assert_eq!(after, "the server rejected [REDACTED:SECRET].", "{header}");
    }

    for name in ["ACCESS_TOKEN", "YOUR_API_KEY", "MY_TOKEN_HERE"] {
        let export = format!("export {name}=$(gh auth token)");
        let mut text = export.clone();
        let mut content = json!({ "authorization": format!("Bearer {name}") });
        let mut scope = Scope::new();
        scope.content(&mut content);
        scope.text(&mut text);
        scope.finish();
        // AC-7 keeps explicit placeholder references, including in structured fields.
        assert_eq!(content, json!({ "authorization": format!("Bearer {name}") }));
        assert_eq!(text, export);
    }
}

#[test]
fn numeric_secret_field_values_are_learned() {
    // Invented numeric tokens: the review's example and repeated digits at the length boundary.
    // AC-6's threshold is eight characters, including numeric field values; no sixteen-digit exception.
    for numeric in ["8236419075512348876", "1111111111111111", "111111111111111", "11111111", "12345678"] {
        for (field, prefix) in [("authorization", "Bearer "), ("session_token", "")] {
            let mut before = format!("retrying with {numeric}");
            let mut content = json!({ field: format!("{prefix}{numeric}") });
            let mut after = before.clone();
            let mut scope = Scope::new();
            scope.text(&mut before);
            scope.content(&mut content);
            scope.text(&mut after);
            scope.finish();
            assert_eq!(before, "retrying with [REDACTED:SECRET]", "{field}: {prefix}{numeric}");
            assert_eq!(content, json!({ field: REDACTED }));
            assert_eq!(after, "retrying with [REDACTED:SECRET]", "{field}: {prefix}{numeric}");
        }
    }

    // AC-7's strict bare-key predicate rejects numbers even after a scheme.
    for (field, numeric) in [
        ("key", "1111111111111111"),
        ("KEY", "8236419075512348876"),
    ] {
        for prefix in ["", "Bearer "] {
            let mut content = json!({ field: format!("{prefix}{numeric}") });
            let original = format!("retrying with {numeric}");
            let mut echo = original.clone();
            let mut scope = Scope::new();
            scope.content(&mut content);
            scope.text(&mut echo);
            scope.finish();
            assert_eq!(content, json!({ field: format!("{prefix}{numeric}") }));
            assert_eq!(echo, original, "{field}: {prefix}{numeric}");
        }
    }
}

/// These names contain no secret word, so only the scheme's snake-case guard keeps their echoes.
#[test]
fn authorization_field_placeholder_names_are_not_learned() {
    for (name, text) in [
        ("YOUR_GITHUB_PAT", "export YOUR_GITHUB_PAT=$(gh auth token)"),
        ("MY_AUTH_HEADER", "send MY_AUTH_HEADER with the request"),
    ] {
        let mut before = text.to_string();
        let mut content = json!({ "authorization": format!("Bearer {name}") });
        let mut after = text.to_string();
        let mut scope = Scope::new();
        scope.text(&mut before);
        scope.content(&mut content);
        scope.text(&mut after);
        scope.finish();
        // AC-7 preserves reference names rather than treating them as real credentials.
        assert_eq!(content, json!({ "authorization": format!("Bearer {name}") }));
        assert_eq!(before, text);
        assert_eq!(after, text);
    }
}

/// Lines of a made-up key's base64 body, `width` characters each, the last `last` long.
fn key_body(width: usize, lines: usize, last: usize) -> Vec<String> {
    let run = "FAKEKEYEXAMPLE0123456789".repeat(4);
    let mut out: Vec<String> = (0..lines).map(|_| run[..width].to_string()).collect();
    out.push(format!("{}==", &run[..last - 2]));
    out
}

#[test]
fn private_keys_without_an_end_line_are_redacted() {
    let ed25519 = format!("-----BEGIN OPENSSH PRIVATE KEY-----\n{}", key_body(70, 4, 20).join("\n"));
    let rsa = format!("-----BEGIN RSA PRIVATE KEY-----\n{}", key_body(64, 6, 44).join("\n"));
    for key in [&ed25519, &rsa] {
        assert_eq!(scrub_text(key), "[REDACTED:PRIVATE_KEY]");
        assert_eq!(scrub_text(&format!("{key}\n")), "[REDACTED:PRIVATE_KEY]\n");
        assert_eq!(
            scrub_text(&format!("$ cat ~/.ssh/id_test\n{key}\nThe END line was never pasted; rotate this key.")),
            "$ cat ~/.ssh/id_test\n[REDACTED:PRIVATE_KEY]\nThe END line was never pasted; rotate this key."
        );
        // cut in the middle of its second line
        let second = key.match_indices('\n').nth(1).unwrap().0;
        let cut = &key[..second + 1 + 30];
        assert_eq!(scrub_text(&format!("I read this:\n{cut}")), "I read this:\n[REDACTED:PRIVATE_KEY]");
        // as a JSON line writes it
        let raw = format!(r#"{{"content":"{}\n","path":"id_test"}}"#, key.replace('\n', "\\n"));
        assert_eq!(scrub_text(&raw), r#"{"content":"[REDACTED:PRIVATE_KEY]\n","path":"id_test"}"#);

        let mut text = format!("{key}\nDone.");
        let mut scope = Scope::new();
        scope.text(&mut text);
        scope.finish();
        assert_eq!(text, "[REDACTED:PRIVATE_KEY]\nDone.");
    }
    for mention in [
        "A key file starts with -----BEGIN OPENSSH PRIVATE KEY----- and ends with its END line.",
        "-----BEGIN RSA PRIVATE KEY-----\nPaste the rest of the key here.",
        "-----BEGIN PRIVATE KEY-----\n\nThen the base64 lines.",
    ] {
        assert_eq!(scrub_text(mention), mention);
    }
}

/// A key copied from a terminal or an editor has spaces or tabs at its lines' ends, the header's too, and may be
/// indented; without its END line it is still redacted from its header through its last base64 line, with LF or CRLF
/// breaks, real or escaped in a JSON string, and the prose after it is kept. With its END line it is as well.
#[test]
fn private_keys_with_trailing_blanks_are_redacted() {
    let prose = "The END line was never pasted; rotate this key.";
    for (kind, body) in [("OPENSSH", key_body(70, 4, 20)), ("RSA", key_body(64, 6, 44))] {
        let header = format!("-----BEGIN {kind} PRIVATE KEY-----");
        let lines: Vec<&str> = std::iter::once(header.as_str()).chain(body.iter().map(String::as_str)).collect();
        let variants: Vec<Vec<String>> = vec![
            // the header alone, every line, a tab, indented lines
            lines.iter().enumerate().map(|(i, l)| if i == 0 { format!("{l}  ") } else { l.to_string() }).collect(),
            lines.iter().map(|l| format!("{l}   ")).collect(),
            lines.iter().map(|l| format!("{l}\t")).collect(),
            lines.iter().enumerate().map(|(i, l)| if i == 0 { format!("{l} \t") } else { format!("    {l} ") }).collect(),
        ];
        let none_left = |out: &str| {
            assert!(!out.contains("BEGIN"), "{out:?}");
            for line in &body {
                assert!(!out.contains(line.as_str()), "{line} kept in {out:?}");
            }
        };
        for variant in &variants {
            for brk in ["\n", "\r\n"] {
                let key = variant.join(brk);
                let text = format!("$ cat ~/.ssh/id_test{brk}{key}{brk}{prose}");
                let out = scrub_text(&text);
                none_left(&out);
                assert!(out.starts_with(&format!("$ cat ~/.ssh/id_test{brk}[REDACTED:PRIVATE_KEY]")), "{out:?}");
                assert!(out.ends_with(&format!("{brk}{prose}")), "{out:?}");

                let ended = format!("{key}{brk}-----END {kind} PRIVATE KEY----- {brk}{prose}");
                let out = scrub_text(&ended);
                none_left(&out);
                assert_eq!(out, format!("[REDACTED:PRIVATE_KEY] {brk}{prose}"));
            }
            for brk in [r"\n", r"\r\n"] {
                let raw = format!(r#"{{"content":"{}{brk}{prose}","path":"id_test"}}"#, variant.join(brk));
                let out = scrub_text(&raw);
                none_left(&out);
                assert!(out.starts_with(r#"{"content":"[REDACTED:PRIVATE_KEY]"#), "{out:?}");
                assert!(out.ends_with(&format!(r#"{brk}{prose}","path":"id_test"}}"#)), "{out:?}");
            }
        }
    }
}

/// JSON encoders escape tabs as well as line breaks, including the blanks around a PEM's base64 lines.
#[test]
fn private_keys_with_json_escaped_tabs_are_redacted() {
    let prose = "The rest of this text must survive.";
    for (kind, body) in [("OPENSSH", key_body(70, 4, 20)), ("RSA", key_body(64, 6, 44))] {
        for (header_blanks, indent, trailing) in [
            ("\t", "", ""),
            ("", "", "\t"),
            ("", "\t", ""),
            (" \t\t ", " \t\t ", " \t\t "),
        ] {
            for brk in ["\n", "\r\n"] {
                let lines: Vec<String> = body.iter().map(|line| format!("{indent}{line}{trailing}")).collect();
                let key = format!("-----BEGIN {kind} PRIVATE KEY-----{header_blanks}{brk}{}", lines.join(brk));
                for ended in [false, true] {
                    let key = if ended {
                        format!("{key}{brk}-----END {kind} PRIVATE KEY-----")
                    } else {
                        key.clone()
                    };
                    let raw = serde_json::to_string(&json!({
                        "private_key": format!("{key}{brk}{prose}"), "path": "id_test",
                    })).unwrap();
                    assert!(raw.contains(r"\t"), "{raw:?}");
                    let out = scrub_text(&raw);
                    for line in &body {
                        assert!(!out.contains(line.as_str()), "{line} kept in {out:?}");
                    }
                    // AC-6 replaces the entire secret field, including text following the PEM.
                    let expected = serde_json::to_string(&json!({
                        "private_key": REDACTED, "path": "id_test",
                    })).unwrap();
                    assert_eq!(out, expected, "{kind}, ended={ended}");
                }
            }
        }
    }
}

/// Text stored cut has the start of a credential the cut left at its end replaced by the marker of its kind; what is
/// before it, and any text that ends otherwise, stays as written.
#[test]
fn cut_text_redacts_a_credentials_start_at_its_end() {
    for (cut, out) in [
        ("I tested it with sk-proj-FAKE00", "I tested it with [REDACTED:API_KEY]"),
        ("export OPENAI_API_KEY=sk-proj-FAKE", "export OPENAI_API_KEY=[REDACTED:API_KEY]"),
        ("my token is ghp_FAKE0000", "my token is [REDACTED:API_KEY]"),
        (r#"{"key":"oc_sk_FAKE0000"#, r#"{"key":"[REDACTED:API_KEY]"#),
        ("my PAT is github_pat_11FAKE", "my PAT is [REDACTED:API_KEY]"),
        ("glpat-FAKE0", "[REDACTED:API_KEY]"),
        ("const maps = 'AIzaSyFAKE", "const maps = '[REDACTED:API_KEY]"),
        ("the bot uses xoxb-0000FAKE", "the bot uses [REDACTED:API_KEY]"),
        ("stripe sk_live_FAKE0", "stripe [REDACTED:API_KEY]"),
        ("the key id is AKIAFAKE00", "the key id is [REDACTED:API_KEY]"),
        ("credentials ASIAFAKE00", "credentials [REDACTED:API_KEY]"),
        ("--token hf_FAKE0", "--token [REDACTED:API_KEY]"),
        ("GROQ gsk_FAKE0", "GROQ [REDACTED:API_KEY]"),
        ("xai-FAKE0", "[REDACTED:API_KEY]"),
        ("publish with npm_FAKE0", "publish with [REDACTED:API_KEY]"),
        ("upload with pypi-FAKE0", "upload with [REDACTED:API_KEY]"),
        ("node seed.mjs http://127.0.0.1:7171 pika_0123abc", "node seed.mjs http://127.0.0.1:7171 [REDACTED:API_KEY]"),
        // a secret's name before a value of 8 or more: the SECRET rule's find wins, as for whole text
        ("_authToken=npm_FAKE0000", "_authToken=[REDACTED:SECRET]"),
        ("export OPENAI_API_KEY=sk-proj-FAKE00", "export OPENAI_API_KEY=[REDACTED:SECRET]"),
        ("--access-token dop_v1_0000fake", "--access-token [REDACTED:API_KEY]"),
        ("apiKey SG.FAKE0000", "apiKey [REDACTED:API_KEY]"),
        ("session restored eyJhbGciOiJGQUtF", "session restored [REDACTED:TOKEN]"),
        ("DB_PASSWORD=FAKEpa", "DB_PASSWORD=[REDACTED:SECRET]"),
        (r#"{"user":"app","password":"FAKEp"#, r#"{"user":"app","password":"[REDACTED:SECRET]"#),
        ("api_key: FAKE", "api_key: [REDACTED:SECRET]"),
        ("DATABASE_URL=postgres://app:FAKEpa", "DATABASE_URL=postgres://app:[REDACTED:PASSWORD]"),
        ("redis://:FAKEre", "redis://:[REDACTED:PASSWORD]"),
        ("curl -H 'Authorization: Bearer FAKEtok", "curl -H 'Authorization: Bearer [REDACTED:TOKEN]"),
        (r#""authorization":"Basic RkFLRX"#, r#""authorization":"Basic [REDACTED:TOKEN]"#),
        ("DB_PASSWORD=FAKEpass1234 and then", "DB_PASSWORD=[REDACTED:SECRET] and then"),
    ] {
        assert_eq!(scrub_cut_text(cut), out, "{cut:?}");
    }

    let key = format!("-----BEGIN RSA PRIVATE KEY-----\n{}", key_body(64, 3, 20).join("\n"));
    assert_eq!(scrub_cut_text(&format!("cat id_test\n{}", &key[..key.len() - 10])), "cat id_test\n[REDACTED:PRIVATE_KEY]");
    // a first line too short for a key with an END line to be recognised by, as a JSON string writes it too
    let ed25519 = format!("-----BEGIN OPENSSH PRIVATE KEY-----\n{}\nFAKEkey", key_body(70, 1, 20)[0]);
    assert_eq!(scrub_cut_text(&format!("Key:\n{ed25519}")), "Key:\n[REDACTED:PRIVATE_KEY]");
    assert_eq!(scrub_cut_text(&format!(r#"{{"text":"Key:\n{}"#, ed25519.replace('\n', "\\n"))), r#"{"text":"Key:\n[REDACTED:PRIVATE_KEY]"#);
    assert_eq!(scrub_cut_text("Key:\n-----BEGIN OPENSSH PRIVATE KEY-----\\nFAKEkey\\"), "Key:\n[REDACTED:PRIVATE_KEY]");

    // what scrub_text finds is replaced as before
    let found = format!("export OPENAI_API_KEY={OPENAI_KEY} and the next step");
    assert_eq!(scrub_cut_text(&found), scrub_text(&found));
}

/// Text stored cut that ends in ordinary text, with or without a blank in it, comes back as written and unallocated.
#[test]
fn cut_text_keeps_ordinary_text() {
    let minified: String = (0..400).map(|i| format!(r#"{{"id":{i},"name":"widget-{i:04}","tags":["a","b"]}},"#)).collect();
    let output = format!("Output:\n[{minified}");
    for text in [
        "the build finished and the next step is",
        minified.as_str(),
        output.as_str(),
        "an article at https://news.example.org/sk-hynix-third-quar",
        "the task-forc",
        "a trip to ASIAN",
        "from huggingface_hub import hf_hub_downl",
        "load it with pika_config",
        "a pika_v2",
        "the request set max_tokens: 4096 and input_tokens: 12",
        "Remaining tokens: lo",
        "listening on https://example.org:8443",
        "Authorization: Bearer YOUR_API_K",
        "Authorization: Bearer <tok",
        "password=${DB_PASS",
        "PRIVATE_KEY_PATH=~/.ssh/id_ed25519",
        "-----BEGIN RSA PRIVATE KEY-----",
        "A key file starts with -----BEGIN OPENSSH PRIVATE KEY----- and then",
        "-----BEGIN RSA PRIVATE KEY-----\nPaste the rest of the key here",
        "ends in a blank: sk-proj-FAKE00 ",
        "",
    ] {
        let out = scrub_cut_text(text);
        assert_eq!(out, text);
        assert!(matches!(out, Cow::Borrowed(_)), "{text:?} was copied");
    }
}

/// In a scope, a text as long as derive keeps has the start of a credential at its end replaced; a shorter one is
/// only scrubbed, since nothing was cut from it; and the cut start is not looked for in the scope's other texts.
#[test]
fn scopes_scrub_texts_at_their_stored_length_as_cut() {
    let title = format!("{}sk-proj-FAKE0000", "Deploy the widgets with this key please ".repeat(3)[..104].to_owned());
    assert_eq!(title.chars().count(), 120);
    let mut cut = title.clone();
    let mut short = "Use sk-proj-FAKE0000".to_owned();
    let mut echo = "later: sk-proj-FAKE0000 again".to_owned();
    let mut scope = Scope::new();
    scope.cut_text(&mut cut, 120);
    scope.cut_text(&mut short, 120);
    scope.text(&mut echo);
    scope.finish();
    assert_eq!(cut, format!("{}[REDACTED:API_KEY]", &title[..104]));
    assert_eq!(short, "Use sk-proj-FAKE0000");
    assert_eq!(echo, "later: sk-proj-FAKE0000 again");
}

/// Real encoders escape quotes, slashes, controls, and nested JSON independently of how an agent displays them.
#[test]
fn json_source_uses_whole_fields_and_decoded_values() {
    for value in [
        "FAKElettersOnly",
        "FAKE phrase with spaces",
        "FAKE 密语 has nine characters 🔑",
        "FAKE \"quoted\" phrase\\with\tcontrols\nand lines",
        "12345678", // deliberately invented eight-digit token
    ] {
        let body = json!({ "requests": [{ "api_key": [value, { "client_secret": value }] }], "region": "eu" });
        let expected = json!({ "requests": [{ "api_key": [REDACTED, { "client_secret": REDACTED }] }], "region": "eu" });
        let raw = serde_json::to_string(&body).unwrap();
        let redacted = serde_json::to_string(&expected).unwrap();
        for (text, want) in [
            (format!("curl --data '{raw}' https://example.test"), format!("curl --data '{redacted}' https://example.test")),
            (format!("request body: {raw}\nresponse ok"), format!("request body: {redacted}\nresponse ok")),
            (serde_json::to_string(&raw).unwrap(), serde_json::to_string(&redacted).unwrap()),
            (serde_json::to_string(&json!({ "arguments": raw })).unwrap(),
             serde_json::to_string(&json!({ "arguments": redacted })).unwrap()),
        ] {
            assert_eq!(scrub_text(&text), want, "{text:?}");
            assert_eq!(scrub_cut_text(&text), want, "{text:?}");
            assert_eq!(scrub_text(&want), want, "second scrub: {text:?}");

            let mut before = format!("before {value}");
            let mut source = text.clone();
            let mut after = format!("after {value}");
            let mut encoded_echo = serde_json::to_string(&json!({ "echo": value })).unwrap();
            let mut scope = Scope::new();
            scope.text(&mut before);
            scope.text(&mut encoded_echo);
            scope.cut_text(&mut source, text.chars().count());
            scope.text(&mut after);
            scope.finish();
            assert_eq!(before, "before [REDACTED:SECRET]");
            assert_eq!(after, "after [REDACTED:SECRET]");
            assert_eq!(source, want);
            assert_eq!(serde_json::from_str::<Value>(&encoded_echo).unwrap(), json!({ "echo": "[REDACTED:SECRET]" }));
        }

        let mut structured = body;
        scrub_content(&mut structured);
        assert_eq!(structured, expected);
    }
}

#[test]
fn unicode_escapes_and_duplicate_json_fields_keep_their_source_spelling() {
    let text = r#"log { "api\u005fkey" : "FAKE\u0020phrase\u0020\ud83d\udd11", "key":"settings", "api_key":"FAKEsecondValue" } done"#;
    assert_eq!(scrub_text(text), r#"log { "api\u005fkey" : "[REDACTED]", "key":"settings", "api_key":"[REDACTED]" } done"#);
    let mut before = "echo FAKE phrase 🔑 and FAKEsecondValue".to_string();
    let mut source = text.to_string();
    let mut after = before.clone();
    let mut scope = Scope::new();
    scope.text(&mut before);
    scope.text(&mut source);
    scope.text(&mut after);
    scope.finish();
    assert_eq!(before, "echo [REDACTED:SECRET] and [REDACTED:SECRET]");
    assert_eq!(after, before);
}

#[test]
fn structured_phrases_propagate_before_and_after_the_field() {
    for value in ["FAKE arbitrary phrase", "FAKE 假的 unicode 口令 🔑", "FAKE\tquoted \"phrase\"\n", "12345678"] {
        for name in ["password", "client_secret", "session_token", "authorization"] {
            let mut before = format!("before {value}");
            let mut body = json!({ name: value });
            let mut after = format!("after {value}");
            let mut scope = Scope::new();
            scope.text(&mut before);
            scope.content(&mut body);
            scope.text(&mut after);
            scope.finish();
            assert_eq!(body, json!({ name: REDACTED }));
            assert_eq!(before, "before [REDACTED:SECRET]");
            assert_eq!(after, "after [REDACTED:SECRET]");
        }
    }
}

#[test]
fn reference_fields_and_bare_keys_stay_unlearned_in_all_representations() {
    for value in [
        "ACCESS_TOKEN", "YOUR_GITHUB_PAT", "${TOKEN}", "$TOKEN", "<password>", "****", "xxxx",
        "env.SECRET_V2", "process.env.API_KEY", "get_access_token_v2", "get_access_token_v2()", "~/.ssh/id_ed25519",
        "/tmp/FAKE-key-v2.pem", "internal/auth/token.go:L12-30", "^4.0.0-beta.1", "L12-30",
    ] {
        let mut content = json!({ "password": value });
        let original = content.clone();
        let text = serde_json::to_string(&content).unwrap();
        let mut echo = format!("example: {value}");
        let mut scope = Scope::new();
        scope.content(&mut content);
        scope.text(&mut echo);
        scope.finish();
        assert_eq!(content, original, "{value}");
        assert_eq!(echo, format!("example: {value}"));
        assert!(matches!(scrub_text(&text), Cow::Borrowed(_)), "{value}");
    }
    for value in ["value", "settings", "FAKE1234", "FAKEonlyLettersLongEnough", "1234567890123456",
        "80efc1803eda7c095a79741d2008c07e2e0a57b01bac8825fbeb448fd097998c"] {
        let mut content = json!({ "key": value });
        let original = content.clone();
        let raw = serde_json::to_string(&content).unwrap();
        let assignment = format!("key: {value}");
        let mut echo = format!("echo {value}");
        let mut scope = Scope::new();
        scope.content(&mut content);
        scope.text(&mut echo);
        scope.finish();
        assert_eq!(content, original, "{value}");
        assert_eq!(echo, format!("echo {value}"));
        assert!(matches!(scrub_text(&raw), Cow::Borrowed(_)), "{raw}");
        assert_eq!(scrub_text(&assignment), assignment);
    }
    // A real bare key mutates before finish; it must not consume the next ordinary string's saved spans.
    let mut content = json!({ "a": { "key": "FAKE0123456789example" }, "b": format!("use {OPENAI_KEY}"), "z": "ok" });
    scrub_content(&mut content);
    assert_eq!(content, json!({ "a": { "key": REDACTED }, "b": "use [REDACTED:API_KEY]", "z": "ok" }));
}

#[test]
fn only_image_data_is_exempt() {
    let image = format!("data:image/png;base64,{OPENAI_KEY}");
    let text = format!("data:text/plain,API_KEY={OPENAI_KEY}");
    let application = format!("data:application/json,{{\"api_key\":\"FAKElettersOnly\"}}");
    let original = json!({
        "image": image, "text": text, "application": application,
        "image_block": { "type": "image", "data": OPENAI_KEY, "mimeType": "image/png" },
        "provider_source": { "type": "base64", "data": OPENAI_KEY, "media_type": "image/png" },
        "password": text, "token": image,
    });
    let expected = json!({
        // The whole text URL is also a secret field's value, so AC-6 propagates that finding to this echo.
        "image": image, "text": "[REDACTED:SECRET]",
        "application": "data:application/json,{\"api_key\":\"[REDACTED]\"}",
        "image_block": original["image_block"], "provider_source": original["provider_source"],
        "password": REDACTED, "token": image,
    });
    let mut body = original.clone();
    scrub_content(&mut body);
    assert_eq!(body, expected);
    let raw = serde_json::to_string(&original).unwrap();
    assert_eq!(serde_json::from_str::<Value>(&scrub_text(&raw)).unwrap(), expected);
    assert_eq!(scrub_text(&text), "data:text/plain,API_KEY=[REDACTED:API_KEY]");
    assert!(matches!(scrub_text(&image), Cow::Borrowed(_)));
    assert_eq!(scrub_cut_text(&image), image);
}

#[test]
fn mixed_contexts_are_idempotent_without_learning_marker_contents() {
    // names_a_secret rejects the complete identifier. URL discovery then removes its suffix; field_at must
    // continue to keep the ordinary prefix adjacent to the marker on a subsequent request.
    let text = "API_KEY=FAKE1234_token_EXAMPLE\nredis://:token_EXAMPLE@fake.example";
    let expected = "API_KEY=FAKE1234_[REDACTED:PASSWORD]\nredis://:[REDACTED:PASSWORD]@fake.example";
    assert_eq!(scrub_text(text), expected);
    assert_eq!(scrub_text(expected), expected);
    assert_eq!(scrub_cut_text(expected), expected);

    for value in ["FAKE mixed phrase", "FAKEquoted\"value", "12345678"] {
        let body = serde_json::to_string(&json!({ "client_secret": value, "echo": value })).unwrap();
        let text = format!("{text}\ncurl --data '{body}'\n{value}");
        let once = scrub_text(&text);
        assert_eq!(scrub_text(&once), once);
        assert_eq!(scrub_cut_text(&once), once);
        assert!(!once.contains(value));
    }
    let mut content = json!({ "password": "[REDACTED:API_KEY]", "secret": "PASSWORD" });
    let mut echo = "[REDACTED:PASSWORD] and PASSWORD".to_string();
    let mut scope = Scope::new();
    scope.content(&mut content);
    scope.text(&mut echo);
    scope.finish();
    assert_eq!(echo, "[REDACTED:PASSWORD] and [REDACTED:SECRET]");
    assert_eq!(content["password"], "[REDACTED:API_KEY]");
}

#[test]
fn whole_fields_distinguish_short_values_and_phrases_from_placeholders() {
    // AC-6 applies to whole string values even below the echo threshold. AC-7 exempts explicit placeholders,
    // not every string starting with punctuation or a single x used as a deliberately fake credential.
    for value in ["x", "", "*FAKE phrase", "[FAKE phrase]", "{FAKE phrase}", "env. FAKE phrase"] {
        let mut body = json!({ "api_key": value });
        let source = serde_json::to_string(&body).unwrap();
        scrub_content(&mut body);
        assert_eq!(body, json!({ "api_key": REDACTED }), "{value:?}");
        assert_eq!(serde_json::from_str::<Value>(&scrub_text(&source)).unwrap(), body);
    }
}

#[test]
fn large_json_source_is_scanned_without_changing_ordinary_content() {
    let records = (0..2000).map(|i| json!({ "key": "settings", "name": format!("widget-{i}"), "max_tokens": 4096 })).collect::<Vec<_>>();
    let raw = serde_json::to_string(&records).unwrap();
    assert!(matches!(scrub_text(&raw), Cow::Borrowed(_)));
    assert!(matches!(scrub_cut_text(&raw), Cow::Borrowed(_)));
    let invalid = format!("{} \"ordinary prose\"", "{".repeat(10000));
    assert!(matches!(scrub_text(&invalid), Cow::Borrowed(_)));
    let incomplete_markers = "[REDACTED".repeat(10000);
    assert!(matches!(scrub_text(&incomplete_markers), Cow::Borrowed(_)));
}

#[test]
fn recognized_credentials_are_not_field_references() {
    let gateway = format!("oc_sk_{}0", "fake".repeat(8));
    let opaque = "secret_FAKEnotionEXAMPLE0123456789abcdefABCDEFGHIJ";
    for (field, value, payload) in [
        ("api_key", gateway.clone(), gateway.as_str()),
        ("authorization", format!("Bearer {opaque}"), opaque),
        ("authorization", "Basic RkFLRXVzZXI6RVhBTVBMRXBhc3MwMA==".to_owned(), "RkFLRXVzZXI6RVhBTVBMRXBhc3MwMA=="),
    ] {
        for embedded in [false, true] {
            let original = json!({ field: value });
            let mut content = original.clone();
            let mut source = format!("curl --data '{}'", serde_json::to_string(&original).unwrap());
            let mut before = format!("echo {payload}");
            let mut after = before.clone();
            let mut scope = Scope::new();
            scope.text(&mut before);
            if embedded { scope.text(&mut source); } else { scope.content(&mut content); }
            scope.text(&mut after);
            scope.finish();
            assert!(!before.contains(payload), "{before}");
            assert_eq!(before, after);
            if embedded {
                let expected = format!("curl --data '{}'", serde_json::to_string(&json!({ field: REDACTED })).unwrap());
                assert_eq!(source, expected);
                assert_eq!(scrub_text(&source), source);
            } else {
                assert_eq!(content, json!({ field: REDACTED }));
                scrub_content(&mut content);
                assert_eq!(content, json!({ field: REDACTED }));
            }
        }
    }
}

#[test]
fn embedded_json_survives_non_json_enclosing_syntax() {
    let body = r#"{"api_key":"FAKElettersOnly"}"#;
    let redacted = r#"{"api_key":"[REDACTED]"}"#;
    for (prefix, suffix) in [
        ("send() { curl --data '", "' https://example.test; }"),
        ("{ curl --data '", "'; }"),
        ("[INFO request ", " accepted]"),
        ("[INFO { request ", " accepted }]"),
        ("{{{{{{{{{{{{{{{{{{{{{{{{{{{{{{{{{{{{{{{{", ""),
    ] {
        let text = format!("{prefix}{body}{suffix}");
        let expected = format!("{prefix}{redacted}{suffix}");
        assert_eq!(scrub_text(&text), expected);
        assert_eq!(scrub_cut_text(&text), expected);
        assert_eq!(scrub_text(&expected), expected);
        let mut source = text;
        let mut before = "echo FAKElettersOnly".to_owned();
        let mut after = before.clone();
        let mut scope = Scope::new();
        scope.text(&mut before);
        scope.text(&mut source);
        scope.text(&mut after);
        scope.finish();
        assert_eq!(source, expected);
        assert_eq!(before, "echo [REDACTED:SECRET]");
        assert_eq!(after, before);
    }
    // Even many invalid enclosing candidates leave the inner body discoverable with bounded work.
    let text = format!("{}{}{}", "[invalid ".repeat(10000), body, "]".repeat(10000));
    assert_eq!(scrub_text(&text), text.replace(body, redacted));
}

#[test]
fn image_urls_do_not_exempt_following_text() {
    let image = format!("data:image/png;base64,{OPENAI_KEY}");
    for prefix in ["", "image: "] {
        for separator in ["\n", "\t", " "] {
            let text = format!("{prefix}{image}{separator}API_KEY=FAKEreviewTOKEN0000");
            let expected = format!("{prefix}{image}{separator}API_KEY=[REDACTED:SECRET]");
            assert_eq!(scrub_text(&text), expected);
            assert_eq!(scrub_cut_text(&text), expected);
            assert_eq!(scrub_text(&expected), expected);
            let mut source = text.clone();
            let mut before = "echo FAKEreviewTOKEN0000".to_owned();
            let mut after = before.clone();
            let mut scope = Scope::new();
            scope.text(&mut before);
            scope.cut_text(&mut source, text.chars().count());
            scope.text(&mut after);
            scope.finish();
            assert_eq!(source, expected);
            let serialized = serde_json::to_string(&text).unwrap();
            let serialized_expected = serde_json::to_string(&expected).unwrap();
            assert_eq!(scrub_text(&serialized), serialized_expected);
            assert_eq!(scrub_cut_text(&serialized), serialized_expected);
            assert_eq!(before, "echo [REDACTED:SECRET]");
            assert_eq!(after, before);
            let mut content = json!({ "text": text, "api_key": text });
            let raw = serde_json::to_string(&content).unwrap();
            scrub_content(&mut content);
            // A mixed image/text value under a secret field is not an opaque image URL.
            assert_eq!(content["api_key"], REDACTED);
            assert_eq!(serde_json::from_str::<Value>(&scrub_text(&raw)).unwrap(), content);
        }
    }
}

#[test]
fn standalone_serialized_echoes_keep_decoded_offsets() {
    for value in ["FAKE\"phrase", "FAKE\\path\\opaque", "FAKE\tphrase\nwith controls", "FAKE 假的 🔑 \"phrase\""] {
        for embedded in [false, true] {
            let mut before = serde_json::to_string(value).unwrap();
            let mut after = before.clone();
            let mut content = json!({ "api_key": value });
            let mut source = format!("request {}", serde_json::to_string(&content).unwrap());
            let mut scope = Scope::new();
            scope.text(&mut before);
            if embedded { scope.text(&mut source); } else { scope.content(&mut content); }
            scope.text(&mut after);
            scope.finish();
            assert_eq!(serde_json::from_str::<String>(&before).unwrap(), "[REDACTED:SECRET]", "{value:?}");
            assert_eq!(after, before);
            assert_eq!(scrub_text(&before), before);
        }
    }
    // Quoted shell values and headers retain the context needed by the ordinary text rules.
    assert_eq!(scrub_text(r#"API_KEY="FAKEreviewTOKEN0000""#), r#"API_KEY="[REDACTED:SECRET]""#);
    assert_eq!(scrub_text(r#"Authorization: "Bearer FAKEreviewTOKEN0000""#), r#"Authorization: "Bearer [REDACTED:TOKEN]""#);
}

#[test]
fn content_names_share_discoveries_without_changing_response_schema_names() {
    for field in ["a_client_secret", "z_client_secret"] {
        let phrase = "FAKElettersOnly";
        let url = "https://fake:FAKEurlPhrase@example.invalid/";
        let mut content = json!({
            field: phrase,
            "middle": [{ phrase: "cached", url: "urlneighbor", OPENAI_KEY: "vendorneighbor" }],
            "echo": "FAKEurlPhrase",
            "vendor_echo": OPENAI_KEY,
            "image": { "type": "image", "mimeType": "image/png", "data": OPENAI_KEY },
        });
        let mut schema = json!({ phrase: "FAKEurlPhrase", "firstToken": 42, "tokens": 120 });
        let mut scope = Scope::new();
        scope.strings(&mut schema);
        scope.content(&mut content);
        scope.finish();
        assert_eq!(schema, json!({ phrase: "[REDACTED:PASSWORD]", "firstToken": 42, "tokens": 120 }));
        assert_eq!(content[field], REDACTED);
        assert_eq!(content["middle"][0], json!({
            "[REDACTED:SECRET]": "cached",
            "https://fake:[REDACTED:PASSWORD]@example.invalid/": "urlneighbor",
            "[REDACTED:API_KEY]": "vendorneighbor",
        }));
        assert_eq!(content["echo"], "[REDACTED:PASSWORD]");
        assert_eq!(content["vendor_echo"], "[REDACTED:API_KEY]");
        assert_eq!(content["image"]["data"], OPENAI_KEY);
        let once = content.clone();
        scrub_content(&mut content);
        assert_eq!(content, once);
    }
}

#[test]
fn renamed_content_names_keep_values_spans_and_literal_suffixes() {
    let second = format!("ghp_FAKE{}", "8".repeat(32));
    let original = json!({
        "[REDACTED:API_KEY]": "literal",
        "[REDACTED:API_KEY]#2": "literal suffix",
        "[REDACTED:API_KEY]#4": "another suffix",
        OPENAI_KEY: { "text": "redis://:FAKEfirstPass@example.invalid/", "order": 1 },
        &second: { "text": "Authorization: Bearer FAKEsecondToken000", "order": 2 },
        "z_plain": "ordinary trailing value",
    });
    let mut content = original.clone();
    scrub_content(&mut content);
    assert_eq!(content, json!({
        "[REDACTED:API_KEY]": "literal",
        "[REDACTED:API_KEY]#2": "literal suffix",
        "[REDACTED:API_KEY]#4": "another suffix",
        "[REDACTED:API_KEY]#3": { "text": "redis://:[REDACTED:PASSWORD]@example.invalid/", "order": 1 },
        "[REDACTED:API_KEY]#5": { "text": "Authorization: Bearer [REDACTED:TOKEN]", "order": 2 },
        "z_plain": "ordinary trailing value",
    }));
    for _ in 0..3 {
        let once = content.clone();
        scrub_content(&mut content);
        assert_eq!(content, once);
    }
    let mut again = original;
    scrub_content(&mut again);
    assert_eq!(again, content, "suffixes are deterministic");
}

#[test]
fn embedded_property_names_use_decoded_offsets_in_both_directions() {
    let phrase = "FAKE\"phrase\\value";
    for source in [
        r#"{"api_key":"FAKE\"phrase\\value","nested":[{"\u0046AKE\"phrase\\value":"cached"}]}"#.to_owned(),
        r#"{"nested":[{"\u0046AKE\"phrase\\value":"cached"}],"api_key":"FAKE\"phrase\\value"}"#.to_owned(),
        format!(r#"{{"nested":[{{"{}":"vendorneighbor"}}],"echo":"{}"}}"#, OPENAI_KEY.replace("sk-", "sk\\u002d"), OPENAI_KEY),
        r#"{"https:\/\/fake:FAKEurlPhrase@example.invalid/":"urlneighbor","echo":"FAKEurlPhrase"}"#.to_owned(),
    ] {
        let mut structured: Value = serde_json::from_str(&source).unwrap();
        scrub_content(&mut structured);
        let scrubbed = scrub_text(&source);
        assert_eq!(serde_json::from_str::<Value>(&scrubbed).unwrap(), structured);
        assert!(!scrubbed.contains(phrase));
        assert!(!scrubbed.contains("FAKEurlPhrase"));
        assert!(!scrubbed.contains(OPENAI_KEY));
        assert_eq!(scrub_text(&scrubbed), scrubbed);
        let shell = format!("curl --data '{}'", serde_json::to_string(&source).unwrap());
        let expected = format!("curl --data '{}'", serde_json::to_string(scrubbed.as_ref()).unwrap());
        assert_eq!(scrub_text(&shell), expected);
    }
}

#[test]
fn markers_between_name_fragments_preserve_ordinary_values_on_repeated_scrubs() {
    // AC-1/7: replacing a name must not invent secret-field semantics for its ordinary value.
    let original = json!({
        "client_secret": "[FAKEopaquevalue]",
        "api[FAKEopaquevalue]key": "cached",
        "api[REDACTED:SECRET]key": "literal cached",
    });
    let expected = json!({
        "client_secret": REDACTED,
        "api[REDACTED:SECRET]key#2": "cached",
        "api[REDACTED:SECRET]key": "literal cached",
    });
    let mut structured = original;
    scrub_content(&mut structured);
    assert_eq!(structured, expected);
    for _ in 0..3 {
        scrub_content(&mut structured);
        assert_eq!(structured, expected);
    }
    // Embedded JSON retains source property order and spelling, including escaped name fragments.
    for source in [
        r#"{"client_secret":"[FAKEopaquevalue]","api[FAKEopaquevalue]key":"cached"}"#,
        r#"{"api\u005bFAKEopaquevalue]key":"cached","client_secret":"[FAKEopaquevalue]"}"#,
        r#"{"api[REDACTED:SECRET]key":"cached","client_secret":"[REDACTED]"}"#,
    ] {
        let mut text = scrub_text(source).into_owned();
        let expected = json!({ "client_secret": REDACTED, "api[REDACTED:SECRET]key": "cached" });
        assert_eq!(serde_json::from_str::<Value>(&text).unwrap(), expected);
        for _ in 0..3 {
            let next = scrub_text(&text).into_owned();
            assert_eq!(next, text);
            text = next;
        }
    }
}

#[test]
fn contextual_json_identifiers_are_kept_and_never_learned() {
    // AC-7 exempts identifier/digest contexts, while AC-6 still scrubs the same shapes in credential fields.
    let digest = "0123456789abcdef".repeat(4);
    let uuid = "00000000-0000-4000-8000-000000000000";
    let padded_digest = format!("{digest}\n");
    let padded_uuid = format!(" {uuid} ");
    for (field, value) in [
        ("secret_hash", digest.as_str()), ("secretDigest", digest.as_str()),
        ("session_token_id", uuid), ("next_page_token", uuid),
        ("secret_hash", padded_digest.as_str()), ("secretDigest", padded_digest.as_str()),
        ("session_token_id", padded_uuid.as_str()), ("next_page_token", padded_uuid.as_str()),
    ] {
        let original = json!({ field: value, "echo": value, "names": { value: "cached" } });
        let mut structured = original.clone();
        let mut before = format!("echo {value}");
        let mut after = before.clone();
        let mut source = serde_json::to_string(&original).unwrap();
        let mut scope = Scope::new();
        scope.text(&mut before);
        scope.content(&mut structured);
        scope.text(&mut source);
        scope.text(&mut after);
        scope.finish();
        assert_eq!(structured, original);
        assert_eq!(source, serde_json::to_string(&original).unwrap());
        assert_eq!(before, format!("echo {value}"));
        assert_eq!(after, before);
    }
    for field in ["api_key", "passwd", "token"] {
        for value in [digest.as_str(), uuid, padded_digest.as_str(), padded_uuid.as_str()] {
            let original = json!({ field: value, "echo": value });
            let mut structured = original.clone();
            scrub_content(&mut structured);
            assert_eq!(structured, json!({ field: REDACTED, "echo": "[REDACTED:SECRET]" }));
            assert_eq!(serde_json::from_str::<Value>(&scrub_text(&original.to_string())).unwrap(), structured);
        }
    }
}

#[test]
fn whitespace_before_authorization_schemes_does_not_hide_payload_echoes() {
    for whitespace in [" ", "\t", " \t "] {
        for scheme in ["Bearer", "Basic", "bEaReR"] {
            for embedded in [false, true] {
                let mut content = json!({ "authorization": format!("{whitespace}{scheme} FAKElettersOnly") });
                let mut source = serde_json::to_string(&content).unwrap();
                let mut before = "echo FAKElettersOnly".to_owned();
                let mut after = before.clone();
                let mut scope = Scope::new();
                scope.text(&mut before);
                if embedded { scope.text(&mut source); } else { scope.content(&mut content); }
                scope.text(&mut after);
                scope.finish();
                assert_eq!(before, "echo [REDACTED:SECRET]", "{whitespace:?}{scheme}");
                assert_eq!(after, before);
                if embedded {
                    assert_eq!(serde_json::from_str::<Value>(&source).unwrap(), json!({ "authorization": REDACTED }));
                } else {
                    assert_eq!(content, json!({ "authorization": REDACTED }));
                }
            }
        }
    }
    // Trimming is specific to a header's scheme; ordinary secret phrases keep their exact whitespace.
    let value = "  FAKE arbitrary phrase  ";
    let mut content = json!({ "api_key": value });
    let mut echo = format!("before:{value}:after");
    let mut scope = Scope::new();
    scope.content(&mut content);
    scope.text(&mut echo);
    scope.finish();
    assert_eq!(echo, "before:[REDACTED:SECRET]:after");
}

/// A complete field in a cut container retains its field meaning, including across encoded JSON layers.
#[test]
fn cut_json_prefixes_learn_complete_fields_and_keep_source_syntax() {
    for value in ["FAKElettersOnly", "FAKE phrase with spaces", "FAKE \"quoted\" 密语 🔑\\value\tand\nlines"] {
        let field = serde_json::to_string(value).unwrap();
        for (source, expected) in [
            (format!(r#"Deploy with {{"client_secret":{field},"description":"ordinary remaining"#),
             r#"Deploy with {"client_secret":"[REDACTED]","description":"ordinary remaining"#.to_owned()),
            (format!(r#"request [{{"api_key":[{field},{field}],"description":"ordinary"#),
             r#"request [{"api_key":["[REDACTED]","[REDACTED]"],"description":"ordinary"#.to_owned()),
            (format!(r#"[{{"password":{field}}},{{"nested":[true,null,12,"#),
             r#"[{"password":"[REDACTED]"},{"nested":[true,null,12,"#.to_owned()),
        ] {
            // An encoder's complete string holding cut JSON, and a stored cut inside the encoded string.
            let encoded = serde_json::to_string(&source).unwrap();
            let encoded_expected = serde_json::to_string(&expected).unwrap();
            for (source, expected) in [
                (source, expected),
                (encoded.clone(), encoded_expected.clone()),
                (encoded[..encoded.len() - 1].to_owned(), encoded_expected[..encoded_expected.len() - 1].to_owned()),
            ] {
                let mut before = format!("before {value}");
                let mut after = format!("after {value}");
                let mut text = source.clone();
                let mut scope = Scope::new();
                scope.text(&mut before);
                scope.cut_text(&mut text, source.chars().count());
                scope.text(&mut after);
                scope.finish();
                assert_eq!(text, expected, "{source}");
                assert_eq!(before, "before [REDACTED:SECRET]");
                assert_eq!(after, "after [REDACTED:SECRET]");
                assert_eq!(scrub_cut_text(&text), text, "repeat {source}");
            }
        }
    }
    let source = r#"Deploy {"api\u005fkey":"FAKE\u0020phrase\ud83d\udd11","description":"ordinary"#;
    let mut before = "echo FAKE phrase🔑".to_owned();
    let mut text = source.to_owned();
    let mut scope = Scope::new();
    scope.text(&mut before);
    scope.cut_text(&mut text, source.chars().count());
    scope.finish();
    assert_eq!(text, r#"Deploy {"api\u005fkey":"[REDACTED]","description":"ordinary"#);
    assert_eq!(before, "echo [REDACTED:SECRET]");
}

#[test]
fn cut_json_secret_fragments_are_scrubbed_but_never_learned() {
    for value in ["FAKElettersOnly", "FAKE123456789", "FAKE \"quoted\" 密语 🔑\\tail\tand\nlines"] {
        let encoded = serde_json::to_string(value).unwrap();
        let source = format!(r#"{{"client_secret":{}"#, &encoded[..encoded.len() - 1]);
        for text in [source.clone(), serde_json::to_string(&source).unwrap()] {
            let mut before = format!("before {value}");
            let mut after = format!("after {value}");
            let mut cut = text.clone();
            let mut scope = Scope::new();
            scope.text(&mut before);
            scope.cut_text(&mut cut, text.chars().count());
            scope.text(&mut after);
            scope.finish();
            let expected = r#"{"client_secret":"[REDACTED:SECRET]"#;
            assert_eq!(cut, if text == source { expected.to_owned() } else { serde_json::to_string(expected).unwrap() });
            assert_eq!(before, format!("before {value}"));
            assert_eq!(after, format!("after {value}"));
            assert_eq!(scrub_cut_text(&cut), cut);
        }
    }
    // Cuts inside encoder-produced escape sequences must consume the entire fragment, never a stray slash.
    let encoded = serde_json::to_string("FAKElettersOnly\"\\\n\t🔑").unwrap();
    for (i, _) in encoded.match_indices('\\') {
        let source = format!(r#"{{"password":{}"#, &encoded[..i + 1]);
        assert_eq!(scrub_cut_text(&source), r#"{"password":"[REDACTED:SECRET]"#, "{source}");
    }
    for tail in [r#"\u"#, r#"\u00"#, r#"\ud83d"#, r#"\ud83d\udd"#] {
        let source = format!(r#"{{"password":"FAKElettersOnly{tail}"#);
        assert_eq!(scrub_cut_text(&source), r#"{"password":"[REDACTED:SECRET]"#, "{source}");
    }
    let mut source = r#"{"client_secret":"FAKEcompleteLetters","password":["FAKE","FAKEpartial123456"#.to_owned();
    let original = source.clone();
    let echo = "FAKEcompleteLetters FAKE FAKEpartial123456";
    let mut before = echo.to_owned();
    let mut after = echo.to_owned();
    let mut scope = Scope::new();
    scope.text(&mut before);
    scope.cut_text(&mut source, original.chars().count());
    scope.text(&mut after);
    scope.finish();
    assert_eq!(source, r#"{"client_secret":"[REDACTED]","password":["[REDACTED]","[REDACTED:SECRET]"#);
    assert_eq!(before, "[REDACTED:SECRET] FAKE FAKEpartial123456");
    assert_eq!(after, before);
    assert_eq!(scrub_cut_text(&source), source);
}

#[test]
fn cut_json_prefixes_keep_references_images_counts_and_ordinary_text() {
    let image = format!("FAKEimage{OPENAI_KEY}");
    let cases = [
        r#"{"password":"process.env.API_KEY","description":"ordinary"#.to_owned(),
        r#"[{"password":"get_access_token_v2()","token":"${TOKEN}","description":"ordinary"#.to_owned(),
        r#"{"key":"settings","max_tokens":"12345678","token_count":4096,"description":"ordinary"#.to_owned(),
        r#"{"secret_hash":"80efc1803eda7c095a79741d2008c07e2e0a57b01bac8825fbeb448fd097998c","description":"ordinary"#.to_owned(),
        r#"{"password":"internal/auth/token.go:L12-30","description":"ordinary"#.to_owned(),
        r#"{"password":"****","description":"ordinary"#.to_owned(),
        format!(r#"{{"type":"image","data":"{image}"#),
        format!(r#"{{"data":"{image}","mimeType":"image/png","description":"ordinary"#),
        format!(r#"{{"password":"data:image/png;base64,{image}","description":"ordinary"#),
        r#"[true,false,null,12,{"ordinary":"hello"#.to_owned(),
        r#"{"password":"process.env.API_KEY"#.to_owned(),
        r#"{"token":"${TOKEN"#.to_owned(),
        r#"{"token":"<password"#.to_owned(),
        r#"{"token":"%API_KEY"#.to_owned(),
        r#"{"key":"settings"#.to_owned(),
    ];
    for source in cases {
        assert_eq!(scrub_cut_text(&source), source, "{source}");
        let encoded = serde_json::to_string(&source).unwrap();
        assert_eq!(scrub_cut_text(&encoded), encoded, "{source}");
        let mut field = source.clone();
        let mut before = "settings ${TOKEN} process.env.API_KEY internal/auth/token.go:L12-30".to_owned();
        let mut after = before.clone();
        let expected_echo = before.clone();
        let mut scope = Scope::new();
        scope.text(&mut before);
        scope.cut_text(&mut field, source.chars().count());
        scope.text(&mut after);
        scope.finish();
        assert_eq!(before, expected_echo);
        assert_eq!(after, expected_echo);
        assert_eq!(field, source);
    }
    // Image semantics belong to each object; a nested ordinary data field, or an array-valued type, is text.
    for source in [
        format!(r#"{{"type":"image","nested":{{"data":"{OPENAI_KEY}"}},"description":"ordinary"#),
        format!(r#"{{"type":["image"],"data":"{OPENAI_KEY}","description":"ordinary"#),
    ] {
        assert_eq!(scrub_cut_text(&source), source.replace(OPENAI_KEY, "[REDACTED:API_KEY]"));
    }
}

#[test]
fn large_cut_json_prefix_uses_bounded_discovery() {
    let source = format!("[{}{{\"client_secret\":\"FAKElettersOnly\",\"description\":\"ordinary", r#"{"name":"ordinary","max_tokens":4096},"#.repeat(4000));
    assert_eq!(scrub_cut_text(&source), source.replace("FAKElettersOnly", REDACTED));
}

const _: () = assert!(RULES_VERSION >= 13);
