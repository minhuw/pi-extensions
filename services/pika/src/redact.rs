//! Credential scrubbing for what pika serves to anonymous visitors: published trajectories under `/api/public/v1/`
//! and the text public search indexes. Stored lines, entries and blobs, and everything the owner reads, stay as
//! written; only what leaves through a public page is scrubbed.
//!
//! A credential becomes `[REDACTED:<KIND>]` (PRIVATE_KEY, API_KEY, TOKEN, PASSWORD or SECRET), and the whole string
//! value of a session-content field named for a secret (`password`, `api_key`, `authorization`, `key`…) becomes
//! `[REDACTED]`. Nothing is kept to put a value back: no hash of it, no mapping. Personal data (emails, phone
//! numbers, ID and card numbers) is left alone.
//!
//! A credential found once in a response is replaced wherever else it occurs among that response's texts, before
//! the place it was found as well as after: an agent reads a key from `.env` and later echoes it in prose that no
//! rule recognises. [`Scope`] runs the rules over every string first, then replaces.
//!
//! The rules, their markers, bounds and guards, and the false positives they leave alone are ported from magpie's
//! `internal/redact` (redact.go, fieldvalue.go, ids.go, known.go, json.go and scrub.go) at
//! https://github.com/yetone/magpie, commit c30d3b7b63e818d3b7d9c3eb6fcdada4c7d8c5e0. Only its secret kinds are
//! ported. Its rules have no text rule for `Authorization: Bearer|Basic`, so that rule is pika's, after magpie's
//! header scrubbing, and so are the rule for a private key whose END line is missing and the rules for what a cut
//! leaves of a credential at a stored text's end ([`scrub_cut_text`]). magpie is under this license:
//!
//! MIT License
//!
//! Copyright (c) 2026 yetone
//!
//! Permission is hereby granted, free of charge, to any person obtaining a copy
//! of this software and associated documentation files (the "Software"), to deal
//! in the Software without restriction, including without limitation the rights
//! to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
//! copies of the Software, and to permit persons to whom the Software is
//! furnished to do so, subject to the following conditions:
//!
//! The above copyright notice and this permission notice shall be included in all
//! copies or substantial portions of the Software.
//!
//! THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
//! IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
//! FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
//! AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
//! LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
//! OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
//! SOFTWARE.

use std::borrow::Cow;
use std::collections::{BTreeMap, BTreeSet};
use std::sync::LazyLock;

use regex::Regex;
use serde_json::{Map, Value};

/// Bumped whenever the rules change what they find, so text scrubbed and stored under older rules (the search
/// index) is known to need scrubbing again.
pub const RULES_VERSION: u32 = 12;

/// What the whole string value of a field named for a secret becomes.
pub const REDACTED: &str = "[REDACTED]";

/// The shortest value replaced wherever else it occurs in a response. Shorter ones (a three-letter password in a URL)
/// would turn up all over ordinary text; 8 is what the assignment rule asks of a value.
pub const MIN_KNOWN: usize = 8;

/// Scrubs one text on its own: borrowed back unchanged, with nothing allocated, when nothing is found.
pub fn scrub_text(s: &str) -> Cow<'_, str> {
    let mut known = Known::default();
    let spans = find(s, &mut known);
    match apply(s, &spans, &known) {
        Some(out) => Cow::Owned(out),
        None => Cow::Borrowed(s),
    }
}

/// Scrubs text that pika stored cut at its end: a title cut from the first prompt, a turn's reply, a search document
/// at its cap. The cut may have left only the start of a credential, which no rule recognises without its end, so that
/// start becomes the marker of its kind too (see [`cut_tail`]). Everything else is scrubbed as [`scrub_text`] does;
/// ordinary text at the end is kept.
pub fn scrub_cut_text(s: &str) -> Cow<'_, str> {
    let mut known = Known::default();
    let spans = discover(s, &mut known, 0, true, false);
    match apply(s, &spans, &known) {
        Some(out) => Cow::Owned(out),
        None => Cow::Borrowed(s),
    }
}

/// Scrubs one piece of session content (an entry's raw line, a tool call's arguments) in a scope of its own.
pub fn scrub_content(value: &mut Value) {
    let mut scope = Scope::new();
    scope.content(value);
    scope.finish();
}

/// Says a field called `name` holds a secret: a token, a key, a password, a credential, a cookie, an authorization;
/// not a count of tokens (`max_tokens`, `token_count`).
pub fn secret_name(name: &str) -> bool {
    static NAME: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(&format!("(?i){}|authori[sz]ation|cookie|^key$", names_pattern())).unwrap());
    // A scrubbed property name may contain a marker and a collision suffix. Its marker's kind is not a
    // secret-field name, but an actual name outside the marker (api_key [REDACTED]) still is. Keep a
    // separator so fragments on either side cannot join into a new secret name on a subsequent scrub.
    let mut name = Cow::Borrowed(name);
    if name.contains("[REDACTED") {
        for marker in REDACTION_MARKERS {
            if name.contains(marker) { name = Cow::Owned(name.replace(marker, " ")); }
        }
    }
    let n = ascii_lower(&name);
    name_marker(&n) && NAME.is_match(&n) && !n.ends_with("tokens") && !n.ends_with("token_count")
}

/// One response's scrubbing. Each string given to it is read by the rules once, when it is given; [`Scope::finish`]
/// then replaces what they found, and every value of [`MIN_KNOWN`] characters or more found anywhere in the scope, in
/// every string. Strings are changed only by `finish`, apart from secret-named fields, which become [`REDACTED`]
/// at once.
#[derive(Default)]
pub struct Scope<'a> {
    targets: Vec<Target<'a>>,
    /// The rules' finds, one list per string scrubbed as text, in the order the strings were read.
    spans: Vec<Discovery>,
    known: Known,
}

enum Target<'a> {
    Text(&'a mut String),
    Json(&'a mut Value, bool),
}

impl<'a> Scope<'a> {
    pub fn new() -> Self {
        Self::default()
    }

    /// A text of the response: a title, a snippet, a command, a log line.
    pub fn text(&mut self, s: &'a mut String) {
        let spans = find(s, &mut self.known);
        self.spans.push(spans);
        self.targets.push(Target::Text(s));
    }

    /// A text that derive stored cut to `max` characters, a title or a turn's reply: as [`Scope::text`], and when it is
    /// that long, also the start of a credential the cut may have left at its end, as [`scrub_cut_text`] finds it.
    /// That start is not learned: a piece of a value is no value to look for elsewhere.
    pub fn cut_text(&mut self, s: &'a mut String, max: usize) {
        let cut = s.chars().nth(max.saturating_sub(1)).is_some();
        let spans = discover(s, &mut self.known, 0, cut, false);
        self.spans.push(spans);
        self.targets.push(Target::Text(s));
    }

    /// Session content: every property name and string value scrubbed as text, the whole string value of a field
    /// named for a secret ([`secret_name`]) replaced by [`REDACTED`], image data left alone.
    pub fn content(&mut self, value: &'a mut Value) {
        self.read(value, true);
        self.targets.push(Target::Json(value, true));
    }

    /// JSON that is not session content: every string scrubbed as text, whatever its field is called, an image's
    /// base64 `data` and image data URLs left alone.
    pub fn strings(&mut self, value: &'a mut Value) {
        self.read(value, false);
        self.targets.push(Target::Json(value, false));
    }

    fn read(&mut self, value: &mut Value, content: bool) {
        visit(value, content, false, &mut |key, s, treat| match treat {
            Treat::Text => {
                let spans = find(s, &mut self.known);
                self.spans.push(spans);
            }
            Treat::Secret => {
                // Discover credentials before applying reference heuristics: a vendor token can also look
                // like a snake-case identifier. Keep only references with no recognized credential in them.
                let found = find(s, &mut self.known);
                if field_reference(s) && !found.redacts() {
                    return;
                }
                self.known.learn_field(key, s);
                if s != REDACTED {
                    *s = REDACTED.to_owned();
                }
            }
            Treat::Keep => {}
        });
    }

    /// Replaces what was found, in every string given.
    pub fn finish(self) {
        let Scope { targets, spans, known } = self;
        let mut spans = spans.into_iter();
        for target in targets {
            match target {
                Target::Text(s) => {
                    let found = spans.next().unwrap_or_default();
                    if let Some(out) = apply(s, &found, &known) {
                        *s = out;
                    }
                }
                Target::Json(value, content) => visit(value, content, true, &mut |_, s, treat| {
                    if treat == Treat::Text {
                        let found = spans.next().unwrap_or_default();
                        if let Some(out) = apply(s, &found, &known) {
                            *s = out;
                        }
                    }
                }),
            }
        }
    }
}

// ---- JSON -----------------------------------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq)]
enum Treat {
    Text,
    Secret,
    Keep,
}

/// Calls `f` with content names and values in their original order. Names are rebuilt only after their values
/// have been classified and their saved discoveries consumed, so sorting renamed keys cannot reorder discovery.
fn visit(value: &mut Value, content: bool, replace_names: bool, f: &mut impl FnMut(&str, &mut String, Treat)) {
    visit_in(value, "", false, content, replace_names, f)
}

fn visit_in(value: &mut Value, key: &str, image: bool, content: bool, replace_names: bool, f: &mut impl FnMut(&str, &mut String, Treat)) {
    match value {
        Value::String(s) => {
            let treat = if data_url(s) || image && key == "data" || is_marker(s)
                || content && contextual_identifier(key, s)
            {
                Treat::Keep
            } else if content && secret_field(key, s) {
                Treat::Secret
            } else {
                Treat::Text
            };
            f(key, s, treat)
        }
        Value::Array(items) => items.iter_mut().for_each(|item| visit_in(item, key, image, content, replace_names, f)),
        Value::Object(map) => {
            let image = image_object(map);
            if content && replace_names {
                let entries = std::mem::take(map).into_iter().map(|(key, mut item)| {
                    let mut name = key.clone();
                    f("", &mut name, Treat::Text);
                    visit_in(&mut item, &key, image, content, replace_names, f);
                    (name != key, name, item)
                }).collect();
                *map = renamed_map(entries);
            } else {
                for (k, item) in map.iter_mut() {
                    if content { f("", &mut k.clone(), Treat::Text); }
                    visit_in(item, k, image, content, replace_names, f);
                }
            }
        }
        _ => {}
    }
}

/// Keep unchanged names (including literal markers and suffixes) and every associated value. Reserve all
/// requested names before suffixing collisions; per-name counters keep large sets of collisions cheap.
fn renamed_map(entries: Vec<(bool, String, Value)>) -> Map<String, Value> {
    let reserved: BTreeSet<String> = entries.iter().map(|(_, name, _)| name.clone()).collect();
    let (changed, unchanged): (Vec<_>, Vec<_>) = entries.into_iter().partition(|(changed, _, _)| *changed);
    let mut map: Map<String, Value> = unchanged.into_iter().map(|(_, name, value)| (name, value)).collect();
    let mut suffixes = BTreeMap::new();
    for (_, name, value) in changed {
        let mut candidate = name.clone();
        if map.contains_key(&candidate) {
            let suffix = suffixes.entry(name.clone()).or_insert(1);
            loop {
                *suffix += 1;
                candidate = format!("{name}#{suffix}");
                if !reserved.contains(&candidate) && !map.contains_key(&candidate) { break; }
            }
        }
        map.insert(candidate, value);
    }
    map
}

/// An image block: pi's `{"type":"image","data":…,"mimeType":"image/png"}`, a provider's base64 `source`.
fn image_object(map: &Map<String, Value>) -> bool {
    map.get("type").and_then(Value::as_str) == Some("image")
        || ["mimeType", "mime_type", "media_type"]
            .iter()
            .any(|k| map.get(*k).and_then(Value::as_str).is_some_and(|t| t.starts_with("image/")))
}

/// Only image data URLs are opaque. A text/plain data URL can carry readable credentials.
fn data_url(s: &str) -> bool {
    image_url_end(s) == Some(s.len())
}

/// A data URL ends at text delimiters. Protect just that span, never the subsequent command or log line.
fn image_url_end(s: &str) -> Option<usize> {
    if !s.starts_with("data:image/") { return None; }
    let end = s.find(|c: char| c.is_whitespace() || "\"'<>`\\".contains(c)).unwrap_or(s.len());
    s[..end].contains(',').then_some(end)
}

/// A bare key is often a map key. Use the assignment rule's strict predicate in JSON too. `visit_in` keeps
/// replacement values explicitly, so fields replaced during discovery cannot consume another string's spans.
fn secret_field(key: &str, s: &str) -> bool {
    secret_name(key) && (!key.eq_ignore_ascii_case("key") || bare_key(s))
}

/// The field supplies secrecy, but examples and code references are still examples and code. A plain numeric
/// token is not a line reference here, and whitespace in a real passphrase is allowed.
fn field_reference(s: &str) -> bool {
    let v = auth_payload(s.trim());
    if v.starts_with("[REDACTED") || id_shaped(v.as_bytes()) { return false; }
    field_placeholder(v)
        || ["process.env", "env.", "os."].iter().any(|prefix| v.starts_with(prefix)) && IDENT_PATH.is_match(v)
        || path_value(v) || field_path(v) || version_value(v)
        || line_ref(v) && !v.bytes().all(|c| c.is_ascii_digit())
        || v.split_once('(').is_some_and(|(name, _)| v.ends_with(')') && IDENT_PATH.is_match(name))
        || names_a_secret(v) && reads_as_name(v) || SNAKE_NAME.is_match(v)
}

/// In a whole field, a single `x` can be a real short credential; only explicit variable syntax or a run of
/// masking characters is a placeholder. Arbitrary phrases starting with punctuation still need redaction.
fn field_placeholder(v: &str) -> bool {
    if v.len() >= 4 && v.bytes().all(|c| b"*xX.".contains(&c)) {
        return true;
    }
    let name = v.strip_prefix("${").and_then(|s| s.strip_suffix('}'))
        .or_else(|| v.strip_prefix('$'))
        .or_else(|| v.strip_prefix('%').and_then(|s| s.strip_suffix('%')))
        .or_else(|| v.strip_prefix('<').and_then(|s| s.strip_suffix('>')));
    name.is_some_and(|s| IDENT_PATH.is_match(s))
}

/// A cut may remove the closing delimiter of an explicit placeholder. Validate its remaining name with the
/// same whole-field predicate, rather than treating arbitrary punctuation at the start of a phrase as masking.
fn field_placeholder_prefix(v: &str) -> bool {
    let v = auth_payload(v.trim());
    for (open, close) in [("${", "}"), ("<", ">"), ("%", "%")] {
        if v.starts_with(open) && !v[open.len()..].contains(close) && field_placeholder(&format!("{v}{close}")) {
            return true;
        }
    }
    false
}

/// A file name or relative path in a field is a reference too. Requiring a known extension avoids mistaking
/// opaque tokens with a slash for paths. The optional suffix names a source line, not a URL port.
fn field_path(v: &str) -> bool {
    let path = match v.split_once(':') {
        Some((path, line)) if line_ref(line) => path,
        Some(_) => return false,
        None => v,
    };
    if path.chars().any(char::is_whitespace) { return false; }
    let Some((_, ext)) = path.rsplit_once('.') else { return false };
    let ext = ascii_lower(ext);
    SOURCE_EXT.contains(&ext.as_ref()) || ["pem", "key", "env", "txt"].contains(&ext.as_ref())
}

fn auth_payload(v: &str) -> &str {
    let header = v.trim_start();
    for prefix in ["bearer ", "basic "] {
        if header.len() >= prefix.len() && header.as_bytes()[..prefix.len()].eq_ignore_ascii_case(prefix.as_bytes()) {
            return header[prefix.len()..].trim_start();
        }
    }
    v
}

fn bare_key(s: &str) -> bool {
    s.len() >= 16 && secret_value(s) && s.bytes().all(|c| c.is_ascii_alphanumeric() || b"_-./+=~!@#%^&*".contains(&c))
        && field_at(s, 0, s.len()) && !id_shaped(s.as_bytes())
}

// ---- finding --------------------------------------------------------------------------------------------------

#[derive(Clone, Copy, Debug)]
struct Span {
    start: usize,
    end: usize,
    kind: &'static str,
}

/// One kind of credential. The match is group 1 when the pattern has one, else all of it.
struct Rule {
    kind: &'static str,
    re: Regex,
    /// One of these is in any text the pattern can match, as written.
    markers: Vec<String>,
    /// Markers too, looked for in the text in lower case, for a pattern that takes its words in any case.
    fold: Vec<String>,
    /// Bytes that may not touch the value on either side: a key inside a longer word is no key.
    bound: &'static [u8],
    ok: Option<fn(&str) -> bool>,
    /// Checks the value at `s[a..b]` by what is around it.
    at: Option<fn(&str, usize, usize) -> bool>,
}

const ALNUM: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const TOKEN_CH: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";
/// A field's or a value's quote, if it has one: `"` or `'`, or `\"` in JSON written inside a string.
const QUOTE: &str = r#"(?:\\?["'])?"#;
/// The characters of a secret's value.
const SECRET_CH: &str = r"[A-Za-z0-9_\-./+=~!@#%^&*]";
/// The characters a value said in a sentence may end with: not a full stop.
const SECRET_END: &str = r"[A-Za-z0-9_\-/+=~!@#%^&*]";

/// What a field holding a secret has in its name, DB_PASSWORD, apiKey, x-api-key, client_secret: a pattern for each,
/// and text any match of it has in it, so a rule's markers and its names come from one list.
const SECRET_NAMES: &[(&str, &str)] = &[
    ("password", "pass"),
    ("passwd", "pass"),
    ("secret", "secret"),
    ("token", "token"),
    ("api[_-]?key", "key"),
    ("access[_-]?key", "key"),
    ("private[_-]?key", "key"),
    ("credential", "credential"),
];

fn names_pattern() -> String {
    SECRET_NAMES.iter().map(|(re, _)| *re).collect::<Vec<_>>().join("|")
}

fn name_marker(lower: &str) -> bool {
    SECRET_NAMES.iter().any(|(_, marker)| lower.contains(marker)) || lower.contains("authori") || lower.contains("cookie")
}

fn names_fold() -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for (_, m) in SECRET_NAMES {
        if !out.iter().any(|o| o == m) {
            out.push(m.to_string());
        }
    }
    out
}

/// What a password is called in Chinese, Japanese and Korean.
const CJK_PASSWORD_NAMES: &[&str] =
    &["密码", "密碼", "口令", "PIN码", "PIN碼", "PIN 码", "安全码", "安全碼", "パスワード", "暗証番号", "비밀번호", "암호", "비번"];

/// What a key, a secret or a token is called in Chinese, Simplified and Traditional, Japanese and Korean.
const CJK_KEY_NAMES: &[&str] = &[
    "密钥", "密鑰", "秘钥", "秘鑰", "私钥", "私鑰", "金钥", "金鑰", "令牌", "权杖", "權杖", "授权码", "授權碼", "秘密鍵",
    "トークン", "シークレット", "APIキー", "アクセスキー", "토큰", "비밀키", "API 키", "API키",
];

/// What stands between a name and its value in a Chinese message: 为, 為, 是, a full-width colon.
const CJK_COPULAS: &[&str] = &["为", "為", "是", "："];

fn strings(list: &[&str]) -> Vec<String> {
    list.iter().map(|s| s.to_string()).collect()
}

fn lower_all(list: &[&str]) -> Vec<String> {
    list.iter().map(|s| s.to_ascii_lowercase()).collect()
}

/// A value after one of `names`: after ：, :, =, 为, 為, 是, は or 는, quoted or not, or after nothing but a space.
fn cjk_named(names: &[&str]) -> Regex {
    Regex::new(&format!(
        r#"(?i)(?:{})[ \t]*(?:[:：=][ \t]*|[为為是][ \t]*[:：]?[ \t]*|は[ \t]*|는[ \t]*)?(?:\\?["'“「])?({SECRET_CH}{{3,63}}{SECRET_END})"#,
        names.join("|")
    ))
    .unwrap()
}

/// Every pattern is compiled once per process, here.
static RULES: LazyLock<Vec<Rule>> = LazyLock::new(|| {
    let re = |pattern: &str| Regex::new(pattern).unwrap();
    let rule = |kind, re: Regex| Rule {
        kind,
        re,
        markers: Vec::new(),
        fold: Vec::new(),
        bound: b"",
        ok: None,
        at: None,
    };
    vec![
        Rule {
            markers: strings(&["PRIVATE KEY"]),
            ..rule("PRIVATE_KEY", re(r"-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----[\s\S]+?-----END (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----"))
        },
        Rule {
            markers: strings(&["sk-"]),
            bound: TOKEN_CH,
            ok: Some(not_a_slug),
            ..rule("API_KEY", re(r"sk-(?:ant-|proj-|or-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}"))
        },
        // a gateway's or a relay's own: oc_sk_…, or_sk_…
        Rule {
            markers: strings(&["_sk_"]),
            bound: TOKEN_CH,
            ok: Some(secret_value),
            ..rule("API_KEY", re(r"[a-z]{2,4}_sk_[A-Za-z0-9_-]{20,}"))
        },
        Rule {
            markers: strings(&["gh", "github_pat_", "glpat-"]),
            bound: TOKEN_CH,
            ..rule("API_KEY", re(r"(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|glpat-[A-Za-z0-9_-]{20,})"))
        },
        Rule { markers: strings(&["AIza"]), bound: TOKEN_CH, ..rule("API_KEY", re(r"AIza[0-9A-Za-z_-]{35}")) },
        Rule { markers: strings(&["xox"]), bound: TOKEN_CH, ..rule("API_KEY", re(r"xox[abposr]-[0-9A-Za-z-]{10,}")) },
        Rule { markers: strings(&["_live_"]), bound: TOKEN_CH, ..rule("API_KEY", re(r"(?:sk|rk)_live_[0-9A-Za-z]{20,}")) },
        Rule { markers: strings(&["AKIA", "ASIA"]), bound: ALNUM, ..rule("API_KEY", re(r"(?:AKIA|ASIA)[0-9A-Z]{16}")) },
        Rule {
            markers: strings(&["hf_", "gsk_", "xai-", "npm_", "pypi-", "dop_v1_", "SG."]),
            bound: TOKEN_CH,
            ..rule("API_KEY", re(r"(?:hf_[A-Za-z0-9]{30,}|gsk_[A-Za-z0-9]{40,}|xai-[A-Za-z0-9]{40,}|npm_[A-Za-z0-9]{36}|pypi-[A-Za-z0-9_-]{50,}|dop_v1_[a-f0-9]{64}|SG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43})"))
        },
        Rule {
            markers: strings(&["eyJ"]),
            bound: TOKEN_CH,
            ..rule("TOKEN", re(r"eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}"))
        },
        // the password of user:password@host, or of :password@host as a Redis URL has it with no user
        Rule {
            markers: strings(&["://"]),
            ok: Some(not_a_variable),
            at: Some(hidden_in_url),
            ..rule("PASSWORD", re(r#"[A-Za-z][A-Za-z0-9+.-]*://[^\t\n\x0C\r :@/?#"'<>]*:([^\t\n\x0C\r @/?#"'<>]{3,})@"#))
        },
        // the credential of an Authorization header, as a log, a curl -H or a JSON body writes it (pika's own). Docs
        // write a name in its place (Bearer ACCESS_TOKEN, Basic username:password), which the guards turn away.
        Rule {
            fold: strings(&["authori"]),
            ok: Some(bearer_value),
            ..rule("TOKEN", re(&format!(r"(?i)authori[sz]ation{QUOTE}[ \t]*[:=][ \t]*{QUOTE}bearer[ \t]+([A-Za-z0-9_\-.~+/]{{8,}}=*)")))
        },
        Rule {
            fold: strings(&["authori"]),
            ok: Some(basic_value),
            ..rule("TOKEN", re(&format!(r"(?i)authori[sz]ation{QUOTE}[ \t]*[:=][ \t]*{QUOTE}basic[ \t]+([A-Za-z0-9_\-.~+/]{{8,}}=*)")))
        },
        // password = …, API_KEY: "…", as .env files and configs have them
        Rule {
            fold: names_fold(),
            ok: Some(secret_value),
            at: Some(field_at),
            ..rule("SECRET", re(&format!(r"(?i)[A-Za-z0-9_.-]*(?:{})[A-Za-z0-9_.-]*{QUOTE}[ \t]*[:=][ \t]*{QUOTE}({SECRET_CH}{{8,}})", names_pattern())))
        },
        // a field called key and nothing more, as a providers file has one: "key": "oc_sk_…". Only a long value of
        // letters and digits both, since code calls anything a key: a map's "key": "value", sort_key, keyboard.
        Rule {
            fold: strings(&["key"]),
            ok: Some(secret_value),
            at: Some(field_at),
            ..rule("SECRET", re(&format!(r"(?i)(?:^|[^A-Za-z0-9_.-]){QUOTE}key{QUOTE}[ \t]*[:=][ \t]*{QUOTE}({SECRET_CH}{{16,}})")))
        },
        // a password after its name in Chinese, Japanese or Korean, as people write one into a message. Nothing in
        // code is called 密码, so any value of four or more is taken; a sentence's closing stop is no part of it.
        Rule {
            fold: lower_all(CJK_PASSWORD_NAMES),
            ok: Some(not_a_variable),
            ..rule("PASSWORD", cjk_named(CJK_PASSWORD_NAMES))
        },
        // a key, a secret or a token after its name the same way: 密钥为 …, 令牌是 …
        Rule { fold: lower_all(CJK_KEY_NAMES), at: Some(key_at), ..rule("SECRET", cjk_named(CJK_KEY_NAMES)) },
        // an English name for one before 为, 為, 是 or ：, as a Chinese message has it: apikey 为 …, token 是 …
        Rule {
            fold: strings(CJK_COPULAS),
            at: Some(key_at),
            ..rule(
                "SECRET",
                re(&format!(
                    r#"(?i)(?:{}|pwd|api[ ]key|access[ ]key|secret[ ]key|key|(?-u:\b)pin(?:[ ]?code)?){QUOTE}[ \t]*(?:[为為是][ \t]*[:：]?|：)[ \t]*(?:\\?["'“「])?({SECRET_CH}{{3,}}{SECRET_END})"#,
                    names_pattern()
                )))
        },
    ]
});

/// Saved discovery, including decoded JSON strings and their source offsets for cross-text echoes.
#[derive(Default)]
struct Discovery {
    spans: Vec<Span>,
    encoded: Vec<Encoded>,
}

impl Discovery {
    fn redacts(&self) -> bool {
        self.spans.iter().any(|f| f.kind != KEEP_SPAN)
    }
}

struct Encoded {
    text: String,
    offsets: Vec<usize>,
}

/// A retained span protects an image or an explicit reference from both rules and learned values.
const KEEP_SPAN: &str = "KEEP";

/// Finds JSON source with one forward scan and bounded candidate parsing, including inside non-JSON syntax.
/// Serialized strings can contain another JSON document; the depth bound keeps even hostile nesting linear.
fn find(s: &str, known: &mut Known) -> Discovery {
    discover(s, known, 0, false, false)
}

fn discover(s: &str, known: &mut Known, depth: usize, cut: bool, fragment: bool) -> Discovery {
    let mut out = Discovery::default();
    if data_url(s) {
        out.spans.push(Span { start: 0, end: s.len(), kind: KEEP_SPAN });
        return out;
    }
    let mut leaves = Vec::new();
    let mut quoted = Vec::new();
    if depth < 32 && s.contains('"') {
        let mut consumed = 0;
        for (at, end, height) in json_candidates(s) {
            if at < consumed || height > 32 { continue; }
            if let Ok(value) = serde_json::from_str::<Value>(&s[at..end]) {
                let mut pos = at;
                // Standalone quoted arguments still need their surrounding assignment/header context.
                // Retain their decoded offsets too, so escaped echoes can be replaced at finish.
                let target = if value.as_str().is_some_and(|v| !v.contains(['{', '['])) {
                    &mut quoted
                } else {
                    &mut leaves
                };
                json_leaves(s, &mut pos, "", false, Some(&value), target);
                consumed = end;
            } else if cut && end == s.len() {
                // A stored cut can leave valid field facts before an unfinished container or string.
                // Keep them in this discovery pass, never reparsing every prefix or scanning its leaves twice.
                let mut prefix = Vec::new();
                let mut pos = at;
                if json_prefix_leaves(s, &mut pos, "", 0, 0, &mut prefix).is_ok() && pos == end
                    && (s.as_bytes()[at] != b'"' || prefix[0].text.contains(['{', '[']))
                {
                    leaves.extend(prefix);
                    consumed = end;
                }
            }
        }
    }
    let mut last = 0;
    for leaf in leaves {
        discover_plain(s, last, leaf.start, known, &mut out, false);
        last = leaf.end;
        let raw = &s[leaf.start..leaf.end];
        let mut offsets = json_offsets(raw, &leaf.text, leaf.start);
        let content_end = leaf.end - usize::from(leaf.complete);
        if !leaf.complete { *offsets.last_mut().unwrap() = content_end; }
        let secret = secret_field(&leaf.key, &leaf.text);
        if leaf.image || data_url(&leaf.text) || is_marker(&leaf.text) || contextual_identifier(&leaf.key, &leaf.text) {
            out.spans.push(Span { start: leaf.start + 1, end: content_end, kind: KEEP_SPAN });
            continue;
        }
        let child = discover(&leaf.text, known, depth + 1, !leaf.complete || cut && leaf.text.contains(['{', '[']), !leaf.complete);
        let reference = field_reference(&leaf.text) || !leaf.complete && field_placeholder_prefix(&leaf.text);
        if secret_name(&leaf.key) && reference && !child.redacts() {
            out.spans.push(Span { start: leaf.start + 1, end: content_end, kind: KEEP_SPAN });
            continue;
        }
        if secret {
            if leaf.complete { known.learn_field(&leaf.key, &leaf.text); }
            if leaf.text != REDACTED {
                out.spans.push(Span { start: leaf.start + 1, end: content_end, kind: if leaf.complete { "" } else { "SECRET" } });
            }
        } else {
            out.spans.extend(child.spans.into_iter().map(|f| Span {
                start: offsets[f.start], end: offsets[f.end], kind: f.kind,
            }));
            out.encoded.extend(child.encoded.into_iter().map(|e| Encoded {
                text: e.text, offsets: e.offsets.into_iter().map(|i| offsets[i]).collect(),
            }));
            out.encoded.push(Encoded { text: leaf.text, offsets });
        }
    }
    discover_plain(s, last, s.len(), known, &mut out, fragment);
    for leaf in quoted {
        let offsets = json_offsets(&s[leaf.start..leaf.end], &leaf.text, leaf.start);
        // Unescaped strings were already scanned with their original context above.
        if s[leaf.start..leaf.end].contains('\\') {
            let child = discover(&leaf.text, known, depth + 1, false, false);
            out.spans.extend(child.spans.into_iter().map(|f| Span {
                start: offsets[f.start], end: offsets[f.end], kind: f.kind,
            }));
            out.encoded.extend(child.encoded.into_iter().map(|e| Encoded {
                text: e.text, offsets: e.offsets.into_iter().map(|i| offsets[i]).collect(),
            }));
        }
        out.encoded.push(Encoded { text: leaf.text, offsets });
    }
    out.spans = first_and_longest(out.spans);
    // A leaf reaching EOF already handled its decoded tail (including image/reference protection).
    if cut && last != s.len() { with_cut_tail(s, out) } else { out }
}

fn discover_plain(s: &str, start: usize, end: usize, known: &mut Known, out: &mut Discovery, cut: bool) {
    let mut last = start;
    for (at, _) in s[start..end].match_indices("data:image/") {
        let at = start + at;
        if at < last { continue; }
        if let Some(len) = image_url_end(&s[at..end]) {
            discover_rules(s, last, at, known, out, false);
            last = at + len;
            out.spans.push(Span { start: at, end: last, kind: KEEP_SPAN });
        }
    }
    discover_rules(s, last, end, known, out, cut);
}

fn discover_rules(s: &str, start: usize, end: usize, known: &mut Known, out: &mut Discovery, cut: bool) {
    let text = &s[start..end];
    let spans = find_rules(text);
    // A match ending at a stored cut is not evidence of the credential's complete value.
    for f in &spans {
        if !cut || f.end != text.len() { known.learn(&text[f.start..f.end], f.kind); }
    }
    out.spans.extend(spans.into_iter().map(|f| Span { start: start + f.start, end: start + f.end, kind: f.kind }));
    for (i, _) in text.match_indices("[REDACTED") {
        if let Some(marker) = REDACTION_MARKERS.iter().find(|m| text[i..].starts_with(**m)) {
            out.spans.push(Span { start: start + i, end: start + i + marker.len(), kind: KEEP_SPAN });
        }
    }
}

struct JsonLeaf {
    start: usize,
    end: usize,
    key: String,
    text: String,
    image: bool,
    complete: bool,
    /// The containing object's source offset, used while discovering an unfinished image block.
    object: usize,
}

/// Locate containers and quoted tokens in one pass, retaining children even in invalid outer syntax.
/// Candidates deeper than 32 levels are skipped, so failed parses inspect each byte at most 32 times;
/// a shell function or bracketed log cannot hide valid JSON inside it or cause quadratic reparsing.
fn json_candidates(s: &str) -> Vec<(usize, usize, usize)> {
    let mut candidates: Vec<(usize, usize, usize)> = Vec::new();
    let mut stack: Vec<usize> = Vec::new();
    let mut at = 0;
    while at < s.len() {
        match s.as_bytes()[at] {
            b'"' => {
                let end = json_end(s, at);
                candidates.push((at, end, 1));
                at = end;
                continue;
            }
            b'{' | b'[' => {
                stack.push(candidates.len());
                candidates.push((at, s.len(), 1));
            }
            b'}' | b']' => {
                if let Some(index) = stack.pop() {
                    candidates[index].1 = at + 1;
                    if let Some(&parent) = stack.last() {
                        candidates[parent].2 = candidates[parent].2.max(candidates[index].2 + 1);
                    }
                }
            }
            _ => {}
        }
        at += 1;
    }
    while let Some(index) = stack.pop() {
        if let Some(&parent) = stack.last() {
            candidates[parent].2 = candidates[parent].2.max(candidates[index].2 + 1);
        }
    }
    candidates
}

/// The end of a quoted token, or of a balanced object/array, even if its contents are not valid JSON.
fn json_end(s: &str, start: usize) -> usize {
    let b = s.as_bytes();
    if b[start] == b'"' {
        let mut i = start + 1;
        while i < b.len() {
            match b[i] {
                b'\\' => i = (i + 2).min(b.len()),
                b'"' => return i + 1,
                _ => i += 1,
            }
        }
        return b.len();
    }
    let mut nesting = 1;
    let mut i = start + 1;
    while i < b.len() {
        match b[i] {
            b'"' => { i = json_end(s, i); continue; }
            b'{' | b'[' => nesting += 1,
            b'}' | b']' => {
                nesting -= 1;
                if nesting == 0 { return i + 1; }
            }
            _ => {}
        }
        i += 1;
    }
    b.len()
}

fn json_blanks(s: &str, at: &mut usize) {
    while s.as_bytes().get(*at).is_some_and(u8::is_ascii_whitespace) {
        *at += 1;
    }
}

/// Walk validated source in source order (including duplicate keys), retaining the original string spans.
fn json_leaves(s: &str, at: &mut usize, key: &str, image: bool, value: Option<&Value>, out: &mut Vec<JsonLeaf>) {
    json_blanks(s, at);
    match s.as_bytes()[*at] {
        b'"' => {
            let start = *at;
            *at = json_end(s, start);
            let text = serde_json::from_str(&s[start..*at]).unwrap();
            out.push(JsonLeaf { start, end: *at, key: key.to_owned(), text, image: image && key == "data", complete: true, object: 0 });
        }
        b'{' => {
            let image = value.and_then(Value::as_object).is_some_and(image_object);
            *at += 1;
            loop {
                json_blanks(s, at);
                if s.as_bytes()[*at] == b'}' { *at += 1; break; }
                let end = json_end(s, *at);
                let name: String = serde_json::from_str(&s[*at..end]).unwrap();
                out.push(JsonLeaf { start: *at, end, key: String::new(), text: name.clone(), image: false, complete: true, object: 0 });
                *at = end;
                json_blanks(s, at);
                *at += 1; // colon
                json_leaves(s, at, &name, image, value.and_then(|v| v.get(&name)), out);
                json_blanks(s, at);
                if s.as_bytes()[*at] == b',' { *at += 1; }
            }
        }
        b'[' => {
            *at += 1;
            let mut index = 0;
            loop {
                json_blanks(s, at);
                if s.as_bytes()[*at] == b']' { *at += 1; break; }
                json_leaves(s, at, key, image, value.and_then(|v| v.get(index)), out);
                index += 1;
                json_blanks(s, at);
                if s.as_bytes()[*at] == b',' { *at += 1; }
            }
        }
        _ => {
            while s.as_bytes().get(*at).is_some_and(|c| !b",]} \t\r\n".contains(c)) { *at += 1; }
        }
    }
}

/// Retains the quoted fields of a valid JSON prefix. Only EOF may interrupt the grammar; arbitrary broken
/// syntax falls back to the scanner's child candidates. The same depth bound as candidate parsing limits work.
fn json_prefix_leaves(s: &str, at: &mut usize, key: &str, object: usize, depth: usize, out: &mut Vec<JsonLeaf>) -> Result<(), ()> {
    if depth >= 32 { return Err(()); }
    json_blanks(s, at);
    let Some(&first) = s.as_bytes().get(*at) else { return Ok(()); };
    match first {
        b'"' => {
            let start = *at;
            *at = json_end(s, start);
            let raw = &s[start..*at];
            let (text, complete) = match serde_json::from_str::<String>(raw) {
                Ok(text) => (text, true),
                Err(error) if error.is_eof() && *at == s.len() => (json_string_prefix(raw)?, false),
                Err(_) => return Err(()),
            };
            out.push(JsonLeaf { start, end: *at, key: key.to_owned(), text, image: false, complete, object });
        }
        b'{' | b'[' => {
            let start = *at;
            let first_leaf = out.len();
            let is_object = first == b'{';
            let close = if is_object { b'}' } else { b']' };
            let mut metadata = Map::new();
            *at += 1;
            json_blanks(s, at);
            if s.as_bytes().get(*at) == Some(&close) { *at += 1; return Ok(()); }
            loop {
                json_blanks(s, at);
                if *at == s.len() { break; }
                let mut name = key.to_owned();
                if is_object {
                    if s.as_bytes()[*at] != b'"' { return Err(()); }
                    let index = out.len();
                    json_prefix_leaves(s, at, "", start, depth + 1, out)?;
                    let leaf = &out[index];
                    if !leaf.complete { break; }
                    name = leaf.text.clone();
                    json_blanks(s, at);
                    if *at == s.len() { break; }
                    if s.as_bytes()[*at] != b':' { return Err(()); }
                    *at += 1;
                }
                let index = out.len();
                json_blanks(s, at);
                let direct_string = s.as_bytes().get(*at) == Some(&b'"');
                json_prefix_leaves(s, at, &name, if is_object { start } else { object }, depth + 1, out)?;
                if is_object && ["type", "mimeType", "mime_type", "media_type"].contains(&name.as_str()) {
                    // Only a complete direct string establishes an image, just as image_object does.
                    if let Some(leaf) = out.get(index).filter(|l| direct_string && l.object == start && l.key == name && l.complete) {
                        metadata.insert(name.clone(), Value::String(leaf.text.clone()));
                    } else {
                        metadata.remove(&name);
                    }
                }
                json_blanks(s, at);
                if *at == s.len() { break; }
                match s.as_bytes()[*at] {
                    c if c == close => { *at += 1; break; }
                    b',' => *at += 1,
                    _ => return Err(()),
                }
            }
            if is_object && image_object(&metadata) {
                for leaf in &mut out[first_leaf..] {
                    if leaf.object == start && leaf.key == "data" { leaf.image = true; }
                }
            }
        }
        _ => {
            let start = *at;
            while s.as_bytes().get(*at).is_some_and(|c| !b",]} \t\r\n".contains(c)) { *at += 1; }
            let raw = &s[start..*at];
            if let Err(error) = serde_json::from_str::<Value>(raw) {
                let prefix = ["true", "false", "null"].iter().any(|v| v.starts_with(raw)) || error.is_eof();
                if *at != s.len() || !prefix { return Err(()); }
            }
        }
    }
    Ok(())
}

/// Decode an unfinished string once, dropping only an unfinished escape at EOF. Retained offsets still cover
/// that escape when its secret value is replaced; the fragment is never learned as a complete credential.
fn json_string_prefix(raw: &str) -> Result<String, ()> {
    let mut at = 1;
    while at < raw.len() {
        if raw.as_bytes()[at] != b'\\' { at += 1; continue; }
        let mut width = 2;
        if raw.as_bytes().get(at + 1) == Some(&b'u') {
            width = 6;
            if let Some(hex) = raw.get(at + 2..at + 6) {
                if u16::from_str_radix(hex, 16).is_ok_and(|n| (0xD800..=0xDBFF).contains(&n)) { width = 12; }
            }
        }
        if at + width > raw.len() { break; }
        at += width;
    }
    serde_json::from_str(&format!("{}\"", &raw[..at])).map_err(|_| ())
}

/// Maps decoded UTF-8 boundaries back to the exact JSON spelling, including surrogate pairs and escaped quotes.
fn json_offsets(raw: &str, decoded: &str, base: usize) -> Vec<usize> {
    let mut offsets = vec![base + 1; decoded.len() + 1];
    let mut source = 1;
    for (at, c) in decoded.char_indices() {
        let width = if raw.as_bytes()[source] == b'\\' {
            if raw.as_bytes()[source + 1] == b'u' { if c.len_utf8() == 4 { 12 } else { 6 } } else { 2 }
        } else { c.len_utf8() };
        offsets[at..at + c.len_utf8()].fill(base + source);
        source += width;
        offsets[at + c.len_utf8()] = base + source;
    }
    offsets
}

/// What the rules find in plain text, where they overlap the first to start and of those the longest.
fn find_rules(s: &str) -> Vec<Span> {
    let mut found = Vec::new();
    if s.len() < 3 {
        return found;
    }
    let mut lower: Option<Cow<'_, str>> = None;
    for rule in RULES.iter() {
        if !rule.markers.is_empty() && !rule.markers.iter().any(|m| s.contains(m.as_str())) {
            continue;
        }
        if !rule.fold.is_empty() {
            let lower = lower.get_or_insert_with(|| ascii_lower(s));
            if !rule.fold.iter().any(|m| lower.contains(m.as_str())) {
                continue;
            }
        }
        if rule.re.captures_len() > 1 {
            for caps in rule.re.captures_iter(s) {
                let m = caps.get(1).or_else(|| caps.get(0)).unwrap();
                rule.take(s, m.start(), m.end(), &mut found);
            }
        } else {
            for m in rule.re.find_iter(s) {
                rule.take(s, m.start(), m.end(), &mut found);
            }
        }
    }
    if s.contains("PRIVATE KEY") {
        open_keys(s, &mut found);
    }
    if found.is_empty() {
        return found;
    }
    no_ids(s, &mut found);
    first_and_longest(found)
}

const REDACTION_MARKERS: &[&str] = &[
    "[REDACTED]", "[REDACTED:PRIVATE_KEY]", "[REDACTED:API_KEY]", "[REDACTED:TOKEN]",
    "[REDACTED:PASSWORD]", "[REDACTED:SECRET]",
];

fn is_marker(s: &str) -> bool {
    REDACTION_MARKERS.contains(&s)
}

impl Rule {
    fn take(&self, s: &str, a: usize, b: usize, found: &mut Vec<Span>) {
        let bytes = s.as_bytes();
        if b <= a
            || a > 0 && self.bound.contains(&bytes[a - 1])
            || b < bytes.len() && self.bound.contains(&bytes[b])
            || self.ok.is_some_and(|ok| !ok(&s[a..b]))
            || self.at.is_some_and(|at| !at(s, a, b))
        {
            return;
        }
        found.push(Span { start: a, end: b, kind: self.kind });
    }
}

/// The header of a PEM private key, as the PRIVATE_KEY rule has it.
static KEY_HEADER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----").unwrap());

/// Finds the private keys whose END line is missing, cut off or never pasted: the header and the base64 lines after
/// it, through the last of them, so what follows the key is kept. A header with no key lines after it only names
/// one. A key with its END line is the PRIVATE_KEY rule's, whose longer find wins.
fn open_keys(s: &str, found: &mut Vec<Span>) {
    for header in KEY_HEADER.find_iter(s) {
        if let Some(end) = key_lines_end(s.as_bytes(), header.end()) {
            found.push(Span { start: header.start(), end, kind: "PRIVATE_KEY" });
        }
    }
}

/// Where the base64 lines that start on the line after `at` end, if any do. Every line of a key but its last is as
/// long as its first, 64 or 70 characters, so a line of another length ends the key; a short last line is taken only
/// when it reads like base64, not a word (`Done`) on a line of its own after the key. Spaces and tabs a terminal or an
/// editor left at a line's end, the header's included, are skipped before its break, including JSON-escaped tabs.
fn key_lines_end(b: &[u8], mut at: usize) -> Option<usize> {
    let tail = |line: &[u8]| line.len() >= 16 || line.iter().any(|&c| c.is_ascii_digit() || b"+/=".contains(&c));
    let blanks_end = |mut i: usize| {
        while i < b.len() {
            if b" \t".contains(&b[i]) {
                i += 1;
            } else if b[i..].starts_with(b"\\t") {
                i += 2;
            } else {
                break;
            }
        }
        i
    };
    let mut full = 0;
    let mut end = None;
    while let Some(start) = line_break(b, blanks_end(at)) {
        let start = blanks_end(start);
        let mut j = start;
        while j < b.len() && (b[j].is_ascii_alphanumeric() || b"+/=".contains(&b[j])) {
            j += 1;
        }
        let k = blanks_end(j);
        // a line ends at a break, at the text's end (where a cut leaves it), or at the quote closing a string
        let line = &b[start..j];
        if line.is_empty() || k < b.len() && line_break(b, k).is_none() && !b"\"'`".contains(&b[k]) {
            break;
        }
        if full == 0 {
            if line.len() < 16 && !(k == b.len() && tail(line)) {
                break;
            }
            full = line.len();
        } else if line.len() > full || line.len() < full && !tail(line) {
            break;
        }
        end = Some(j);
        at = j;
        if line.len() < full {
            break;
        }
    }
    end
}

/// The position after the line break at `s[i]`, a real one or one escaped in a JSON string; `None` if there is none.
fn line_break(s: &[u8], i: usize) -> Option<usize> {
    [&b"\r\n"[..], b"\n", b"\\r\\n", b"\\n"].iter().find(|brk| s[i..].starts_with(brk)).map(|brk| i + brk.len())
}

// ---- text cut at its end -------------------------------------------------------------------------------------

/// `spans`, what the rules found in `s`, with the start of a credential that a cut at `s`'s end may have left.
fn with_cut_tail(s: &str, mut found: Discovery) -> Discovery {
    if let Some(tail) = cut_tail(s) {
        if !found.spans.iter().any(|f| f.kind == KEEP_SPAN && f.start < tail.end && tail.start < f.end) {
            found.spans.push(tail);
            found.spans = first_and_longest(found.spans);
        }
    }
    found
}

/// How far before the last run of non-blanks a name and its separator are looked for: `DB_PASSWORD = `,
/// `Authorization: Bearer `.
const CUT_CONTEXT: usize = 64;

/// A token's marker, as the rules have them, and its first characters through the text's end.
static CUT_TOKEN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?:sk-|[a-z]{2,4}_sk_|gh[pousr]_|github_pat_|glpat-|AIza|xox[abposr]-|[sr]k_live_|AKIA|ASIA|hf_|gsk_|xai-|npm_|pypi-|dop_v1_|SG\.|eyJ)([A-Za-z0-9_.\-]+)$").unwrap()
});

/// An Authorization header's scheme and the start of its credential.
static CUT_AUTHORIZATION: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(r"(?i)authori[sz]ation{QUOTE}[ \t]*[:=][ \t]*{QUOTE}(?:bearer|basic)[ \t]+([A-Za-z0-9_\-.~+/]+=*)$")).unwrap()
});

/// A URL's user and the start of its password, before the `@` the cut took.
static CUT_URL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"[A-Za-z][A-Za-z0-9+.-]*://[^\t\n\x0C\r :@/?#"'<>]*:([^\t\n\x0C\r :@/?#"'<>]+)$"#).unwrap()
});

/// A secret's name, then the start of its value.
static CUT_FIELD: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r"(?i)([A-Za-z0-9_.-]*(?:{})[A-Za-z0-9_.-]*){QUOTE}[ \t]*[:=][ \t]*{QUOTE}({SECRET_CH}+)$",
        names_pattern()
    ))
    .unwrap()
});

/// The start of a credential at `s`'s end that a cut may have left and no rule recognises without its end: a private
/// key with nothing after its header but base64 lines, however little of them is left; a token's marker and what
/// follows it, when that reads as random (a digit or a capital in it, a digit after AKIA or ASIA); the start of a value after an Authorization
/// header's scheme, a URL's user or a secret's name. Each runs to the end with no blank in it but a separator's, so
/// text that ends in a blank, and ordinary words, are never taken.
fn cut_tail(s: &str) -> Option<Span> {
    if let Some(key) = open_key_at_end(s) {
        return Some(key);
    }
    let run = s.char_indices().rev().find(|(_, c)| c.is_whitespace()).map_or(0, |(i, c)| i + c.len_utf8());
    if run == s.len() {
        return None;
    }
    let mut from = run.saturating_sub(CUT_CONTEXT);
    while !s.is_char_boundary(from) {
        from -= 1;
    }
    let window = &s[from..];
    let bytes = s.as_bytes();
    let span = |m: regex::Match<'_>, kind| Span { start: from + m.start(), end: s.len(), kind };
    let lower = ascii_lower(window);
    let token_marker = RULES.iter().filter(|r| matches!(r.kind, "API_KEY" | "TOKEN"))
        .any(|r| r.markers.iter().any(|m| window.contains(m.as_str())));
    if let Some(caps) = token_marker.then(|| CUT_TOKEN.captures(window)).flatten() {
        let all = caps.get(0).unwrap();
        let a = from + all.start();
        // AKIA and ASIA start words in capitals too (ASIAN); an AWS key id's start has a digit in it
        let v = caps[1].as_bytes();
        let aws = all.as_str().starts_with("AKIA") || all.as_str().starts_with("ASIA");
        let random = v.iter().any(u8::is_ascii_digit) || !aws && v.iter().any(u8::is_ascii_uppercase);
        if random && (a == 0 || !TOKEN_CH.contains(&bytes[a - 1])) {
            return Some(span(all, if all.as_str().starts_with("eyJ") { "TOKEN" } else { "API_KEY" }));
        }
    }
    if let Some(caps) = lower.contains("authori").then(|| CUT_AUTHORIZATION.captures(window)).flatten() {
        let v = caps.get(1).unwrap();
        if not_a_variable(v.as_str()) && !SNAKE_NAME.is_match(v.as_str()) && !WORDS.is_match(v.as_str()) {
            return Some(span(v, "TOKEN"));
        }
    }
    if let Some(caps) = window.contains("://").then(|| CUT_URL.captures(window)).flatten() {
        // all digits is a port: https://example.org:8443
        let v = caps.get(1).unwrap();
        if not_a_variable(v.as_str()) && !v.as_str().bytes().all(|c| c.is_ascii_digit()) {
            return Some(span(v, "PASSWORD"));
        }
    }
    if let Some(caps) = name_marker(&lower).then(|| CUT_FIELD.captures(window)).flatten() {
        let v = caps.get(2).unwrap();
        if secret_name(&caps[1]) && not_a_variable(v.as_str()) && field_at(s, from + v.start(), s.len()) {
            return Some(span(v, "SECRET"));
        }
    }
    None
}

/// The last private key's header in `s`, when only lines of base64 follow it to the end (lines broken as written or
/// as a JSON string escapes them, a cut escape at the very end included) and some base64 does: the whole key the cut
/// took the END line of, even a first line too short for [`open_keys`] to take.
fn open_key_at_end(s: &str) -> Option<Span> {
    if !s.contains("PRIVATE KEY") {
        return None;
    }
    let header = KEY_HEADER.find_iter(s).last()?;
    let rest = s[header.end()..].replace("\\r", "\n").replace("\\n", "\n");
    let rest = rest.strip_suffix('\\').unwrap_or(&rest);
    let mut body = false;
    for line in rest.split(['\n', '\r']).map(|line| line.trim_matches([' ', '\t'])) {
        if !line.bytes().all(|c| c.is_ascii_alphanumeric() || b"+/=".contains(&c)) {
            return None;
        }
        body |= !line.is_empty();
    }
    body.then(|| Span { start: header.start(), end: s.len(), kind: "PRIVATE_KEY" })
}

/// `s` with its ASCII letters in lower case, as long as `s`; borrowed when it has none in upper case.
fn ascii_lower(s: &str) -> Cow<'_, str> {
    if s.bytes().any(|c| c.is_ascii_uppercase()) { Cow::Owned(s.to_ascii_lowercase()) } else { Cow::Borrowed(s) }
}

/// The first to start, and of those the longest, wins where spans overlap; of two the same, the one found first,
/// so a key in API_KEY=… is an API_KEY, not a SECRET.
fn first_and_longest(mut found: Vec<Span>) -> Vec<Span> {
    found.sort_by(|x, y| x.start.cmp(&y.start).then(y.end.cmp(&x.end)));
    let mut next = 0;
    found.retain(|f| {
        if f.start < next {
            return false;
        }
        next = f.end;
        true
    });
    found
}

// ---- values found in a scope ----------------------------------------------------------------------------------

/// The values of [`MIN_KNOWN`] characters or more found in a scope, each with the kind it was first found as.
#[derive(Default)]
struct Known(Vec<(String, &'static str)>);

impl Known {
    fn learn(&mut self, v: &str, kind: &'static str) {
        if v.chars().count() >= MIN_KNOWN && !v.contains("[REDACTED") && !self.0.iter().any(|(k, _)| k == v) {
            self.0.push((v.to_owned(), kind));
        }
    }

    /// A real field value supplies secrecy, including phrases and eight-digit tokens. Schemes name how a
    /// credential is sent; learn their payload so an echo without the scheme is also removed.
    fn learn_field(&mut self, key: &str, v: &str) {
        // Callers have already distinguished real fields from references using their saved discovery.
        if key.eq_ignore_ascii_case("key") && !bare_key(v) {
            return;
        }
        self.learn(auth_payload(v), "SECRET");
    }
}

/// `s` with the rules' finds and every known value in it replaced; `None` when nothing is.
fn apply(s: &str, rules: &Discovery, known: &Known) -> Option<String> {
    let mut found = rules.spans.clone();
    let protected = |a, b| {
        let at = rules.spans.partition_point(|f| f.end <= a);
        rules.spans[at..].iter().take_while(|f| f.start < b).any(|f| f.kind == KEEP_SPAN)
    };
    let mut echoes = |text: &str, offsets: Option<&[usize]>| {
        for (v, kind) in &known.0 {
            for (i, _) in text.match_indices(v.as_str()) {
                let end = i + v.len();
                let (a, b) = offsets.map_or((i, end), |map| (map[i], map[end]));
                if stands_alone(text.as_bytes(), i, end) && !protected(a, b) {
                    found.push(Span { start: a, end: b, kind });
                }
            }
        }
    };
    echoes(s, None);
    for encoded in &rules.encoded {
        echoes(&encoded.text, Some(&encoded.offsets));
    }
    if !found.iter().any(|f| f.kind != KEEP_SPAN) {
        return None;
    }
    let mut out = String::with_capacity(s.len());
    let mut last = 0;
    for f in first_and_longest(found) {
        out.push_str(&s[last..f.start]);
        if f.kind == KEEP_SPAN {
            out.push_str(&s[f.start..f.end]);
        } else if f.kind.is_empty() {
            out.push_str(REDACTED);
        } else {
            out.push_str("[REDACTED:");
            out.push_str(f.kind);
            out.push(']');
        }
        last = f.end;
    }
    out.push_str(&s[last..]);
    Some(out)
}

/// Says `s[a..b]`, a known value, is the value itself and not a piece of a longer word: no letter or digit against
/// either end that is a letter or digit.
fn stands_alone(s: &[u8], a: usize, b: usize) -> bool {
    let alnum = |c: u8| c.is_ascii_alphanumeric();
    !(a > 0 && alnum(s[a - 1]) && alnum(s[a])) && !(b < s.len() && alnum(s[b]) && alnum(s[b - 1]))
}

// ---- guards ---------------------------------------------------------------------------------------------------

fn has_letter(v: &str) -> bool {
    v.bytes().any(|c| c.is_ascii_alphabetic())
}

fn has_digit(v: &str) -> bool {
    v.bytes().any(|c| c.is_ascii_digit())
}

fn word_byte(c: u8) -> bool {
    c == b'_' || c.is_ascii_alphanumeric()
}

/// Turns away what stands in for a value: ${PASS}, <password>, ****, xxxx.
fn not_a_variable(v: &str) -> bool {
    if v.bytes().next().is_none_or(|c| b"$%{<[*".contains(&c)) {
        return false;
    }
    !v.trim_matches(['*', 'x', 'X', '.']).is_empty()
}

/// A key's or a token's value, not a word or a number: letters and digits both, or 16 characters or more that
/// aren't all digits.
fn key_value(v: &str) -> bool {
    not_a_variable(v) && has_letter(v) && (has_digit(v) || v.len() >= 16)
}

/// A name as docs write one in a token's place: YOUR_API_KEY, MY_TOKEN_2, access_token_here.
static SNAKE_NAME: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(?:[A-Z]+(?:_[A-Z]+[0-9]*)+|[a-z]+(?:_[a-z]+[0-9]*)+)$").unwrap());

/// Letters that are a word or words, not random: credentials, Credentials, ACCESSTOKEN, your-token-here.
static WORDS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(?:[a-z]+(?:[_-][a-z]+)*|[A-Z][a-z]+|[A-Z]+(?:[_-][A-Z]+)*)$").unwrap());

/// A Bearer credential, not what docs write in its place: letters and digits both, 16 characters or more that are
/// not a word, or 16 digits or more alone, as an opaque numeric session token is; never a name (ACCESS_TOKEN,
/// YOUR_API_KEY, apiToken) or a placeholder (<token>, ${TOKEN}).
fn bearer_value(v: &str) -> bool {
    if v.len() >= 16 && v.bytes().all(|c| c.is_ascii_digit()) {
        return true;
    }
    if !not_a_variable(v) || !has_letter(v) || names_a_secret(v) && reads_as_name(v) || SNAKE_NAME.is_match(v) {
        return false;
    }
    has_digit(v) || v.len() >= 16 && !WORDS.is_match(v)
}

/// Says each of `v`'s words is letters with at most digits after them, as a name's are (refreshToken2, MY_TOKEN_2):
/// a token that starts with its kind (secret_ then random base62) has letters after digits somewhere and is no name.
fn reads_as_name(v: &str) -> bool {
    ident_words(v).iter().all(|w| w.trim_end_matches(|c: char| c.is_ascii_digit()).bytes().all(|c| c.is_ascii_alphabetic()))
}

/// A Basic credential: base64 that decodes to text with a colon in it, user:password as a header carries it; not
/// `username:password` written out, or a word.
fn basic_value(v: &str) -> bool {
    use base64ct::{Base64, Base64Unpadded, Encoding};
    let decoded = Base64::decode_vec(v).or_else(|_| Base64Unpadded::decode_vec(v));
    decoded
        .ok()
        .and_then(|d| String::from_utf8(d).ok())
        .is_some_and(|t| t.contains(':') && !t.chars().any(char::is_control))
}

/// What stands between a name and a key's value.
const KEY_SEPARATORS: &[&str] = &["为", "為", "是", "：", ":", "=", "は", "는"];

/// What a number counts when one follows it: bits, bytes, a time, a count.
const QUANTITY_UNITS: &[&str] = &[
    "位", "比特", "字节", "字節", "个", "個", "次", "秒", "毫秒", "分钟", "分鐘", "小时", "小時", "天", "年", "bit", "byte", "ms", "sec",
    "min", "ビット", "バイト", "비트", "바이트",
];

/// [`key_value`] for `s[a..b]`, or six digits or more right after a separator that count nothing: 密钥为 739146 is a
/// key, 密钥为 2048 位 a size.
fn key_at(s: &str, a: usize, b: usize) -> bool {
    let v = &s[a..b];
    if path_value(v) || version_value(v) {
        return false;
    }
    if key_value(v) {
        return true;
    }
    if v.len() < 6 || !v.bytes().all(|c| c.is_ascii_digit()) {
        return false;
    }
    let before = s[..a].trim_end_matches([' ', '\t', '"', '\'', '“', '「', '\\']);
    let after = s[b..].trim_start_matches([' ', '\t']);
    KEY_SEPARATORS.iter().any(|c| before.ends_with(c)) && !QUANTITY_UNITS.iter().any(|u| after.starts_with(u))
}

/// A value that looks like a secret, not code: letters and digits both, and not a call, a reference or a
/// placeholder of its own.
fn secret_value(v: &str) -> bool {
    not_a_variable(v) && !v.starts_with("process.env") && !v.starts_with("os.") && has_digit(v) && has_letter(v)
}

/// A name in code, or a field read through one: Uint8Array, details.2, opts.token2.
static IDENT_PATH: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*$").unwrap());

/// Turns away a value at `s[a..b]` that is code naming a secret, not the secret: a call (`privateKey:
/// toBase64Url(…)`), or, unquoted after a colon, a type or a read that code goes on from (`secretKey: Uint8Array;`).
/// A secret written in code is a string, so in quotes; one after = or at a line's end (.env files, logs, YAML) is
/// kept.
fn not_code(s: &str, a: usize, b: usize) -> bool {
    if !IDENT_PATH.is_match(&s[a..b]) {
        return true;
    }
    let rest = s[b..].trim_start_matches([' ', '\t']);
    if rest.starts_with('(') {
        return false;
    }
    let quoted = a > 0 && matches!(s.as_bytes()[a - 1], b'"' | b'\'');
    if quoted || !s[..a].trim_end_matches([' ', '\t']).ends_with(':') {
        return true;
    }
    rest.bytes().next().is_none_or(|c| !b";,)}]|?&<>".contains(&c))
}

/// Says the password at `s[a..b]`, in a URL's user:password@, is hidden by replacing it: it is not also written as
/// the URL's user name or as a part of its host or path, as postgres://postgres:postgres@localhost and a test
/// database named for its project write it. Anyone who reads the rest of the URL reads that password.
fn hidden_in_url(s: &str, a: usize, b: usize) -> bool {
    let bytes = s.as_bytes();
    let pw = &s[a..b];
    let Some(i) = s[..a].rfind("//") else { return true };
    if bytes[a - 1] != b':' {
        return true;
    }
    if &s[i + 2..a - 1] == pw {
        return false; // the user name
    }
    // the host and the path, to the URL's end
    let mut end = b + 1;
    while end < bytes.len() && !b" \t\r\n\"'<>`\\)]}".contains(&bytes[end]) {
        end += 1;
    }
    !s[b + 1..end].split(|c: char| "/:.?#&=;,@".contains(c)).any(|part| part == pw)
}

/// False for words in lower case joined by hyphens, as a page's address names an article about SK hynix
/// (sk-hynix-third-quarter-profit). A key's characters are random: it has a capital, or a run of 16 or more with no
/// hyphen, or hex digits alone, as a UUID's groups are.
fn not_a_slug(v: &str) -> bool {
    if v.bytes().any(|c| c.is_ascii_uppercase()) {
        return true;
    }
    let tail = v.strip_prefix("sk-").unwrap_or(v);
    if tail.bytes().all(|c| c == b'-' || c == b'_' || c.is_ascii_digit() || (b'a'..=b'f').contains(&c)) {
        return true;
    }
    v.split(['-', '_']).any(|w| w.len() >= 16)
}

// What follows a secret's name and a colon or = is not always the secret: a place in a file
// (internal/auth/token.go:L643-669), a path to where one is kept (PRIVATE_KEY_PATH=~/.ssh/id_ed25519), code naming
// one (access_token = get_access_token_v2), a package's version ("js-tokens": "^4.0.0-beta.1"). A secret written
// down still is one: password=Passw0rd123, token: t0k3nValue2.

/// Where a value the assignment rules found can be a secret: not code, and not a place in a file, a path, a name in
/// code, a plugin's skill or a version.
fn field_at(s: &str, a: usize, b: usize) -> bool {
    if !not_code(s, a, b) {
        return false;
    }
    let v = &s[a..b];
    if v.starts_with('=') || s[b..].starts_with("[REDACTED") {
        return false; // Go's :=, or an ordinary prefix next to a previously replaced suffix
    }
    !file_field(s.as_bytes(), a)
        && !line_ref(v)
        && !path_value(v)
        && !names_a_secret(v)
        && !skill_name(s, a, b)
        && !version_value(v)
}

/// A release's version as a manifest or a lock file pins it: a range's operator, numbers joined by dots, then a
/// pre-release's or a build's parts (-beta.1, -rc1, .post2, b1, +build.5).
static VERSION_RANGE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(concat!(
        r"^(?:[~\^]|[<>=!~]=?|==)?[vV]?[0-9]+(?:\.[0-9]+)+",
        r"(?:[-+._]?(?:(?i:alpha|beta|rc|pre|preview|post|dev|canary|next|nightly|snapshot|release|final|ga|stable|build|incubating)[0-9]*|[abcmABCM][0-9]+|[0-9]+))*$",
    ))
    .unwrap()
});

fn version_value(v: &str) -> bool {
    VERSION_RANGE.is_match(v)
}

/// Words in lower case joined by hyphens: a plugin's, a skill's or a command's name.
static SKILL_SLUG: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[a-z0-9]+(?:-[a-z0-9]+)+$").unwrap());

/// Says `s[a..b]` is the second half of plugin:skill (design-tokens:generate-v2): words in lower case joined by
/// hyphens on both sides of a colon with no space around it.
fn skill_name(s: &str, a: usize, b: usize) -> bool {
    let bytes = s.as_bytes();
    if a < 2 || bytes[a - 1] != b':' || !SKILL_SLUG.is_match(&s[a..b]) || not_a_slug(&s[a..b]) {
        return false;
    }
    let mut i = a - 1;
    while i > 0 && (bytes[i - 1].is_ascii_lowercase() || bytes[i - 1].is_ascii_digit() || bytes[i - 1] == b'-') {
        i -= 1;
    }
    i < a - 1
        && (i == 0 || !(bytes[i - 1].is_ascii_alphanumeric() || b"_.".contains(&bytes[i - 1])))
        && SKILL_SLUG.is_match(&s[i..a - 1])
}

/// A line or a range of lines, as an editor or a review names them: L643, L643-669, L12-L40, 643:12.
static LINE_REF: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^L?[0-9]+(?:[-–:]L?[0-9]+)*[.,;:]?$").unwrap());

fn line_ref(v: &str) -> bool {
    LINE_REF.is_match(v)
}

/// The extensions of files an agent reads and names with a line after them. Not .env, .txt, .key or .pem, whose
/// content is what a secret is kept in.
const SOURCE_EXT: &[&str] = &[
    "go", "ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs", "py", "pyi", "rb", "rs", "java", "kt", "kts", "swift", "c",
    "h", "cc", "cpp", "cxx", "hpp", "hh", "m", "mm", "cs", "fs", "php", "scala", "dart", "lua", "zig", "nim", "ex", "exs",
    "erl", "hs", "ml", "clj", "r", "jl", "sh", "bash", "zsh", "fish", "ps1", "vue", "svelte", "astro", "md", "mdx", "rst",
    "sql", "proto", "graphql", "gradle", "html", "css", "scss", "less", "json", "jsonc", "yaml", "yml", "toml", "xml",
    "tf", "ipynb",
];

/// Says the name before the value at `s[a]` is a file's, or a path's last part, not a field's: token.go:L643-669,
/// skills/secret-scanner:…
fn file_field(s: &[u8], a: usize) -> bool {
    let space = |c: u8| b" \t\"'\\".contains(&c);
    let mut i = a;
    while i > 0 && space(s[i - 1]) {
        i -= 1;
    }
    if i == 0 || s[i - 1] != b':' && s[i - 1] != b'=' {
        return false;
    }
    i -= 1;
    while i > 0 && space(s[i - 1]) {
        i -= 1;
    }
    let end = i;
    while i > 0 && (s[i - 1].is_ascii_alphanumeric() || b"_.-".contains(&s[i - 1])) {
        i -= 1;
    }
    let name = &s[i..end];
    if name.is_empty() {
        return false;
    }
    if i > 0 && (s[i - 1] == b'/' || s[i - 1] == b'\\') {
        return true; // a path's last part
    }
    match name.iter().rposition(|&c| c == b'.') {
        Some(dot) if dot > 0 => {
            let ext = name[dot + 1..].to_ascii_lowercase();
            SOURCE_EXT.iter().any(|e| e.as_bytes() == ext.as_slice())
        }
        _ => false,
    }
}

/// The folders an absolute path starts at.
const PATH_ROOTS: &[&str] = &[
    "Users", "home", "tmp", "private", "var", "etc", "run", "opt", "usr", "mnt", "Volumes", "root", "srv", "data",
    "workspace", "workspaces", "app", "Applications", "Library", "System", "proc", "dev", "sys", "nix",
];

/// Says `v` is a file's or a folder's path: from home (~/), from here (./, ../), or from a root folder (/Users/…,
/// /tmp/…), with no + or = in it as base64 has.
fn path_value(v: &str) -> bool {
    if v.contains(['+', '=']) {
        return false;
    }
    if ["~/", "./", "../"].iter().any(|p| v.starts_with(p) && v.len() > p.len()) {
        return true;
    }
    let Some(rest) = v.strip_prefix('/') else { return false };
    match rest.split_once('/') {
        Some((first, rest)) if !rest.is_empty() => PATH_ROOTS.contains(&first),
        _ => false,
    }
}

/// The words of a name in code that say it holds a secret.
const SECRET_WORDS: &[&str] = &[
    "token", "tokens", "secret", "secrets", "password", "passwords", "passwd", "pwd", "key", "keys", "apikey", "credential",
    "credentials",
];

/// A name in code, read through others or not: camelCase, snake_case, SCREAMING_CASE, env.SECRET_V2.
static IDENT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$").unwrap());

/// Says `v` is a name in code for a secret, not one: two words or more, one of them token, secret, password or key,
/// written as code writes a name (refreshToken2, generate_token_v2, env.SECRET_V2). Passw0rd123 is one word, and
/// SuperSecret2024 is a password, not how code names a value.
fn names_a_secret(v: &str) -> bool {
    if !IDENT.is_match(v) {
        return false;
    }
    if !v.as_bytes()[0].is_ascii_lowercase() && !v.contains(['_', '.']) {
        return false;
    }
    let mut words = 0;
    let mut named = false;
    for w in ident_words(v) {
        if !has_letter(w) {
            continue;
        }
        words += 1;
        let w = w.find(|c: char| c.is_ascii_digit()).map_or(w, |i| &w[..i]); // countTokens4o: Tokens
        if SECRET_WORDS.contains(&w.to_ascii_lowercase().as_str()) {
            named = true;
        }
    }
    words >= 2 && named
}

/// `v`'s words: split at _ and ., and where a capital starts a word in camelCase.
fn ident_words(v: &str) -> Vec<&str> {
    let mut out = Vec::new();
    for part in v.split(['_', '.']).filter(|p| !p.is_empty()) {
        let b = part.as_bytes();
        let mut start = 0;
        for i in 1..b.len() {
            if b[i].is_ascii_uppercase() && b[i - 1].is_ascii_lowercase() {
                out.push(&part[start..i]);
                start = i;
            }
        }
        out.push(&part[start..]);
    }
    out
}

// ---- ids ------------------------------------------------------------------------------------------------------

// An id a backend made (a UUID, 32 hex digits or more, a commit's or a digest's hex) is no credential by its shape:
// a piece of one is never a value of its own, and a whole one is a credential only in a field named for one
// (password=, api_key:, "refresh_token":), never one named for an id (secret_id), a cursor (next_page_token), a
// digest (secret_hash) or a bare "key".

/// Drops from `found` what is in an id of `s`, but for credentials named for one.
fn no_ids(s: &str, found: &mut Vec<Span>) {
    let bytes = s.as_bytes();
    found.retain(|f| {
        let Some((l, r)) = id_around(bytes, f.start, f.end) else { return true };
        if f.start > l || f.end < r {
            return false; // a piece of an id
        }
        match f.kind {
            "SECRET" => {
                // a short digest after a key's name in a sentence (密钥为 5d41402abc4b2a76) is that key
                let words = field_words(bytes, l);
                credential_id(&words, &bytes[l..r]) || words == ["key"] && key_phrase(bytes, l)
            }
            _ => true,
        }
    });
}

/// The id that `s[a..b]` is in, or is: the run of hex digits and hyphens around it, when that run is a UUID, 32 hex
/// digits or more, or a short digest; or `s[a..b]` when it is an element token.
fn id_around(s: &[u8], a: usize, b: usize) -> Option<(usize, usize)> {
    if element_token(s, a, b) {
        return Some((a, b));
    }
    let (mut l, mut r) = (a, b);
    while l > 0 && hex_or_hyphen(s[l - 1]) {
        l -= 1;
    }
    while r < s.len() && hex_or_hyphen(s[r]) {
        r += 1;
    }
    while l < r && s[l] == b'-' {
        l += 1;
    }
    while r > l && s[r - 1] == b'-' {
        r -= 1;
    }
    if a < l || b > r || !s[l..r].iter().all(|&c| hex_or_hyphen(c)) || !id_shaped(&s[l..r]) {
        return None;
    }
    // a short digest is a word of its own, not the hex end of a longer one (a key's sk_…deadbeef…)
    if digest_shaped(&s[l..r]) && (l > 0 && word_byte(s[l - 1]) || r < s.len() && word_byte(s[r])) {
        return None;
    }
    Some((l, r))
}

/// An element token a computer-use driver made, s and 8 lowercase hex digits then a colon and an index
/// (s0000002a:14), or without the index the value of an element_token field.
fn element_token(s: &[u8], a: usize, b: usize) -> bool {
    if b - a < 9 || s[a] != b's' || a > 0 && word_byte(s[a - 1]) {
        return false;
    }
    if !s[a + 1..a + 9].iter().all(|&c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)) {
        return false;
    }
    let mut end = a + 9;
    if end < s.len() && s[end] == b':' {
        let mut i = end + 1;
        while i < s.len() && s[i].is_ascii_digit() {
            i += 1;
        }
        if i == end + 1 {
            return false; // a colon and no index
        }
        end = i;
    }
    if b != a + 9 && b != end || end < s.len() && word_byte(s[end]) {
        return false;
    }
    end > a + 9 || field_words(s, a) == ["element", "token"]
}

fn hex_or_hyphen(c: u8) -> bool {
    c == b'-' || c.is_ascii_hexdigit()
}

static UUID: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(?i)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$").unwrap()
});

/// Says `v`, hex digits and hyphens, is a UUID, 32 hex digits or more without a hyphen, or a shorter digest.
fn id_shaped(v: &[u8]) -> bool {
    let uuid = std::str::from_utf8(v).is_ok_and(|v| UUID.is_match(v));
    uuid || v.len() >= 32 && v.iter().all(|c| c.is_ascii_hexdigit()) || digest_shaped(v)
}

/// Says `v` is a hash's hex digits short of 32: 16 to 31 of them in one case, letters and digits both, as a short
/// commit, a 64-bit hash or a truncated sha256 is written.
fn digest_shaped(v: &[u8]) -> bool {
    if v.len() < 16 || v.len() >= 32 {
        return false;
    }
    let (mut lower, mut upper, mut digits) = (0, 0, 0);
    for &c in v {
        match c {
            b'0'..=b'9' => digits += 1,
            b'a'..=b'f' => lower += 1,
            b'A'..=b'F' => upper += 1,
            _ => return false,
        }
    }
    // a hash's digits are random: of 16, about 6 are letters and 10 digits
    let least = 3.max(v.len() / 8);
    (lower == 0 || upper == 0) && lower + upper >= least && digits >= least
}

/// Whether a whole identifier-shaped value is a credential in this field. Plain text and JSON share the
/// contextual exclusions; the shape alone never exempts a real api_key or token.
fn credential_id(words: &[String], value: &[u8]) -> bool {
    digest_shaped(value) && words.is_empty() || credential_words(words)
}

fn contextual_identifier(key: &str, value: &str) -> bool {
    // Command output and formatted configuration can pad references; classify their shape without changing
    // the original bytes or learning them as credentials.
    let value = value.trim();
    secret_name(key) && id_shaped(value.as_bytes()) && !credential_id(&name_words(key.as_bytes()), value.as_bytes())
}

/// A credential's name, excluding identifiers, cursors, digests, lookups and a bare key.
fn credential_words(words: &[String]) -> bool {
    if words.len() < 2 && words.first().is_none_or(|w| w == "key") || words == ["element", "token"] {
        return false;
    }
    if matches!(words.last().map(String::as_str), Some("id" | "ids" | "uuid" | "guid")) {
        return false;
    }
    !words.iter().any(|w| {
        matches!(
            w.as_str(),
            "page" | "next" | "cursor" | "continuation" | "csrf" | "xsrf" | "trace" | "request" | "idempotency" | "sync"
                | "nonce" | "hash" | "digest" | "checksum" | "sha" | "fingerprint" | "etag"
                // a key for finding data, not for getting in: cache_key, object_key
                | "cache" | "commit" | "object" | "blob" | "file" | "content" | "revision" | "rev" | "partition"
                | "shard" | "bucket" | "dedup" | "dedupe" | "lookup" | "row" | "sort"
        )
    })
}

/// Says the bare key whose value starts at `s[at]` is the second word of a credential's name: api key, access key,
/// secret key, private key.
fn key_phrase(s: &[u8], at: usize) -> bool {
    let before = s[at.saturating_sub(24)..at].to_ascii_lowercase();
    let Some(i) = before.windows(3).rposition(|w| w == b"key") else { return false };
    let mut end = i;
    while end > 0 && before[end - 1] == b' ' {
        end -= 1;
    }
    let before = &before[..end];
    ["api", "access", "secret", "private", "signing", "license", "licence"].iter().any(|w| {
        before.ends_with(w.as_bytes()) && (before.len() == w.len() || !word_byte(before[before.len() - w.len() - 1]))
    })
}

/// The words of the name of the field whose value starts at `s[at]`, none where no field's name is before it.
fn field_words(s: &[u8], at: usize) -> Vec<String> {
    let space = |c: u8| b" \t\"'\\".contains(&c);
    let mut i = at;
    while i > 0 && space(s[i - 1]) {
        i -= 1;
    }
    if i == 0 || s[i - 1] != b':' && s[i - 1] != b'=' {
        return Vec::new();
    }
    i -= 1;
    while i > 0 && space(s[i - 1]) {
        i -= 1;
    }
    let mut j = i;
    while j > 0 && (s[j - 1].is_ascii_alphanumeric() || b"_.-".contains(&s[j - 1])) {
        j -= 1;
    }
    name_words(&s[j..i])
}

/// A field's name's words in lower case: next_page_token, nextPageToken and X-Next-Page-Token are next, page, token.
fn name_words(name: &[u8]) -> Vec<String> {
    let mut out = Vec::new();
    let mut w = String::new();
    for (i, &c) in name.iter().enumerate() {
        match c {
            b'_' | b'-' | b'.' => {
                if !w.is_empty() {
                    out.push(std::mem::take(&mut w));
                }
            }
            b'A'..=b'Z' => {
                if i > 0 && name[i - 1].is_ascii_lowercase() && !w.is_empty() {
                    out.push(std::mem::take(&mut w));
                }
                w.push(c.to_ascii_lowercase() as char);
            }
            _ => w.push(c as char),
        }
    }
    if !w.is_empty() {
        out.push(w);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every rule is skipped by a plain substring check unless one of its markers is in the text.
    #[test]
    fn every_rule_has_a_marker() {
        for rule in RULES.iter() {
            assert!(!rule.markers.is_empty() || !rule.fold.is_empty(), "{} has no marker", rule.re);
            assert!(rule.fold.iter().all(|m| *m == m.to_ascii_lowercase()), "{} folds an upper-case marker", rule.re);
        }
    }

    #[test]
    fn nothing_found_borrows() {
        assert!(matches!(scrub_text("cargo test --locked"), Cow::Borrowed(_)));
    }
}
