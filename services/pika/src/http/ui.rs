use axum::extract::State;
use axum::http::{HeaderValue, Method, StatusCode, Uri, header};
use axum::response::{IntoResponse, Response};
use rust_embed::RustEmbed;

use super::{AppState, error};

/// The web UI build. Debug builds read it from disk; when it is missing, a placeholder page is served.
#[derive(RustEmbed)]
#[folder = "web/dist"]
#[allow_missing = true]
struct Assets;

const PLACEHOLDER: &str = "<!doctype html>
<html lang=\"en\">
<head><meta charset=\"utf-8\"><title>pika</title></head>
<body style=\"font-family: system-ui, sans-serif; max-width: 40rem; margin: 4rem auto; color: #37352f\">
<h1 style=\"font-weight: 600\">pika</h1>
<p>The server is running, but this build does not include the web UI. Build <code>services/pika/web</code> and rebuild the binary.</p>
</body>
</html>
";

fn content_type(path: &str) -> &'static str {
    match path.rsplit_once('.').map(|(_, ext)| ext.to_ascii_lowercase()).as_deref() {
        Some("html") => "text/html; charset=utf-8",
        Some("js" | "mjs") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("json" | "map") => "application/json",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("ico") => "image/x-icon",
        Some("woff") => "font/woff",
        Some("woff2") => "font/woff2",
        Some("ttf") => "font/ttf",
        Some("txt") => "text/plain; charset=utf-8",
        Some("wasm") => "application/wasm",
        _ => "application/octet-stream",
    }
}

fn escape_attr(s: &str) -> String {
    s.replace('&', "&amp;").replace('"', "&quot;").replace('<', "&lt;").replace('>', "&gt;")
}

/// Replaces any existing `pika-base` meta tag and inserts one right after `<head>`.
pub fn inject_base(html: &str, base: &str) -> String {
    let mut html = html.to_owned();
    while let Some(start) = html.find("<meta name=\"pika-base\"") {
        let Some(len) = html[start..].find('>') else { break };
        html.replace_range(start..start + len + 1, "");
    }
    let meta = format!("<meta name=\"pika-base\" content=\"{}\">", escape_attr(base));
    let at = html
        .to_ascii_lowercase()
        .find("<head")
        .and_then(|start| html[start..].find('>').map(|end| start + end + 1))
        .unwrap_or(0);
    html.insert_str(at, &meta);
    html
}

/// Whether `url` resolves against the page's URL: not absolute, not rooted, and not a fragment.
fn is_relative(url: &str) -> bool {
    let scheme = url.split_once(':').is_some_and(|(scheme, _)| {
        !scheme.is_empty() && scheme.chars().all(|c| c.is_ascii_alphanumeric() || "+-.".contains(c))
    });
    !(url.is_empty() || url.starts_with('/') || url.starts_with('#') || scheme)
}

/// Makes the build's relative `src` and `href` URLs (`./assets/a.js`) absolute under `prefix` (the base path, empty
/// for `/`). Without a base element (forbidden by the nodes CSP), relative URLs resolve against each route, so every
/// route prefix would fetch and cache its own copy of each file. Chunks, workers, and fonts load relative to the
/// module or stylesheet that names them, so they follow.
pub fn absolute_urls(html: &str, prefix: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut rest = html;
    loop {
        let next = ["src=\"", "href=\""]
            .into_iter()
            .filter_map(|attr| {
                rest.match_indices(attr)
                    .find(|(at, _)| rest[..*at].ends_with(|c: char| c.is_ascii_whitespace()))
                    .map(|(at, attr)| at + attr.len())
            })
            .min();
        let Some(start) = next else { break };
        out.push_str(&rest[..start]);
        rest = &rest[start..];
        let end = rest.find('"').unwrap_or(rest.len());
        let url = &rest[..end];
        if is_relative(url) {
            out.push_str(&escape_attr(prefix));
            out.push('/');
            out.push_str(url.strip_prefix("./").unwrap_or(url));
        } else {
            out.push_str(url);
        }
        rest = &rest[end..];
    }
    out.push_str(rest);
    out
}

/// The page every UI route serves: the build's `index.html` with absolute asset URLs and the `pika-base` meta.
pub fn page(html: &str, base: &str) -> String {
    let prefix = if base == "/" { "" } else { base };
    inject_base(&absolute_urls(html, prefix), base)
}

fn index(state: &AppState) -> Response {
    let html = match Assets::get("index.html") {
        Some(file) => String::from_utf8_lossy(&file.data).into_owned(),
        None => PLACEHOLDER.to_owned(),
    };
    (
        [(header::CONTENT_TYPE, "text/html; charset=utf-8"), (header::CACHE_CONTROL, "no-cache")],
        page(&html, &state.config.base_path),
    )
        .into_response()
}

/// The embedded file at exactly `path`; the page links every file by its absolute URL (see [`absolute_urls`]).
fn asset(path: &str) -> Option<rust_embed::EmbeddedFile> {
    if path.is_empty() || path == "index.html" {
        return None;
    }
    Assets::get(path)
}

/// The Content-Security-Policy of every UI response while nodes are on (see "Server hardening" in `docs/NODE.md`).
pub const CONTENT_SECURITY_POLICY: &str = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; \
    img-src 'self' data: blob:; connect-src 'self'; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; \
    form-action 'self'";

pub async fn serve(State(state): State<AppState>, method: Method, uri: Uri) -> Response {
    let mut response = respond(&state, method, uri);
    if state.nodes.enabled() {
        response.headers_mut().insert(header::CONTENT_SECURITY_POLICY, HeaderValue::from_static(CONTENT_SECURITY_POLICY));
    }
    response
}

fn respond(state: &AppState, method: Method, uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    if path == "api" || path.starts_with("api/") {
        return error(StatusCode::NOT_FOUND, "not_found");
    }
    if method != Method::GET && method != Method::HEAD {
        return error(StatusCode::METHOD_NOT_ALLOWED, "method_not_allowed");
    }
    if let Some(file) = asset(path) {
        let cache = if path.starts_with("assets/") { "public, max-age=31536000, immutable" } else { "no-cache" };
        return ([(header::CONTENT_TYPE, content_type(path)), (header::CACHE_CONTROL, cache)], file.data.into_owned())
            .into_response();
    }
    // A missing build file is an error, not a route: answering with the page would hide a stale or broken reference.
    if path.starts_with("assets/") {
        return error(StatusCode::NOT_FOUND, "not_found");
    }
    index(state)
}

#[cfg(test)]
mod tests {
    use super::{absolute_urls, inject_base, page};

    #[test]
    fn injects_base_meta() {
        let html = "<!doctype html><html><head><meta name=\"pika-base\" content=\"/\"><title>x</title></head></html>";
        assert_eq!(
            inject_base(html, "/pika"),
            "<!doctype html><html><head><meta name=\"pika-base\" content=\"/pika\"><title>x</title></head></html>"
        );
    }

    #[test]
    fn makes_relative_urls_absolute_under_the_base_path() {
        let cases = [
            (r#"<script  src="./boot.js">"#, r#"<script  src="/pika/boot.js">"#),
            (r#"<script type="module" src="./assets/i.js">"#, r#"<script type="module" src="/pika/assets/i.js">"#),
            (r#"<link rel="modulepreload" href="./assets/r.js">"#, r#"<link rel="modulepreload" href="/pika/assets/r.js">"#),
            ("<link rel=\"stylesheet\"\n\thref=\"assets/i.css\">", "<link rel=\"stylesheet\"\n\thref=\"/pika/assets/i.css\">"),
            (r#"<link rel="icon" href="data:image/svg+xml,%3Csvg%3E">"#, r#"<link rel="icon" href="data:image/svg+xml,%3Csvg%3E">"#),
            (r##"<a href="https://x.dev/a"><a href="/abs"><a href="#top">"##, r##"<a href="https://x.dev/a"><a href="/abs"><a href="#top">"##),
            (r#"<img data-src="./kept.png"><p>src="./text"</p>"#, r#"<img data-src="./kept.png"><p>src="./text"</p>"#),
        ];
        for (html, absolute) in cases {
            assert_eq!(absolute_urls(html, "/pika"), absolute);
        }
        let all: String = cases.iter().map(|(html, _)| *html).collect();
        assert_eq!(absolute_urls(&all, "/pika"), cases.iter().map(|(_, absolute)| *absolute).collect::<String>());
        assert_eq!(absolute_urls(r#"<script src="./assets/i.js">"#, ""), r#"<script src="/assets/i.js">"#);
        assert_eq!(page(r#"<head><script src="./a.js">"#, "/"), r#"<head><meta name="pika-base" content="/"><script src="/a.js">"#);
    }

    /// A Vite build's `index.html` (`npm run build` in `web/`), so the rewrite is checked on real output even when the
    /// binary embeds no build.
    const BUILT: &str = include_str!("../../tests/fixtures/index.html");

    #[test]
    fn a_built_page_links_every_file_under_the_base_path() {
        let urls = regex::Regex::new(r#"\s(?:src|href)="([^"]*)""#).unwrap();
        let scripts = regex::Regex::new(r"<script\b([^>]*)>([^<]*)</script>").unwrap();
        for (base, prefix) in [("/", "/"), ("/pika", "/pika/")] {
            let html = page(BUILT, base);
            let found: Vec<&str> = urls.captures_iter(&html).map(|c| c.get(1).unwrap().as_str()).collect();
            assert!(found.len() >= 4, "{found:?}");
            for url in &found {
                assert!(url.starts_with("data:") || (url.starts_with(prefix) && !url[prefix.len()..].starts_with('.')), "{url}");
            }
            assert!(found.contains(&format!("{prefix}boot.js").as_str()), "{found:?}");
            assert!(found.iter().any(|url| url.starts_with(&format!("{prefix}assets/index-"))), "{found:?}");
            // The nodes CSP (`script-src 'self'`, `base-uri 'none'`) holds: no inline script and no base element.
            let scripts: Vec<_> = scripts.captures_iter(&html).collect();
            assert_eq!(scripts.len(), html.matches("<script").count(), "{html}");
            assert!(scripts.iter().all(|s| s[1].contains(" src=\"") && s[2].trim().is_empty()), "{html}");
            assert!(!html.to_ascii_lowercase().contains("<base"), "{html}");
        }
    }
}
