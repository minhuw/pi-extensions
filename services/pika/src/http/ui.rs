use axum::extract::State;
use axum::http::{Method, StatusCode, Uri, header};
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

fn index(state: &AppState) -> Response {
    let html = match Assets::get("index.html") {
        Some(file) => String::from_utf8_lossy(&file.data).into_owned(),
        None => PLACEHOLDER.to_owned(),
    };
    (
        [(header::CONTENT_TYPE, "text/html; charset=utf-8"), (header::CACHE_CONTROL, "no-cache")],
        inject_base(&html, &state.config.base_path),
    )
        .into_response()
}

/// The embedded file for `path`. Relative asset URLs requested from a nested route (`sessions/x/assets/a.js`) resolve
/// to the file at the longest matching suffix (`assets/a.js`).
fn asset(path: &str) -> Option<(&str, rust_embed::EmbeddedFile)> {
    if path.is_empty() || path == "index.html" {
        return None;
    }
    if let Some(file) = Assets::get(path) {
        return Some((path, file));
    }
    if !path.rsplit('/').next().is_some_and(|name| name.contains('.')) {
        return None;
    }
    path.match_indices('/')
        .map(|(i, _)| &path[i + 1..])
        .filter(|suffix| *suffix != "index.html")
        .find_map(|suffix| Assets::get(suffix).map(|file| (suffix, file)))
}

pub async fn serve(State(state): State<AppState>, method: Method, uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    if path == "api" || path.starts_with("api/") {
        return error(StatusCode::NOT_FOUND, "not_found");
    }
    if method != Method::GET && method != Method::HEAD {
        return error(StatusCode::METHOD_NOT_ALLOWED, "method_not_allowed");
    }
    if let Some((path, file)) = asset(path) {
        let cache = if path.starts_with("assets/") { "public, max-age=31536000, immutable" } else { "no-cache" };
        return ([(header::CONTENT_TYPE, content_type(path)), (header::CACHE_CONTROL, cache)], file.data.into_owned())
            .into_response();
    }
    index(&state)
}

#[cfg(test)]
mod tests {
    use super::inject_base;

    #[test]
    fn injects_base_meta() {
        let html = "<!doctype html><html><head><meta name=\"pika-base\" content=\"/\"><title>x</title></head></html>";
        assert_eq!(
            inject_base(html, "/pika"),
            "<!doctype html><html><head><meta name=\"pika-base\" content=\"/pika\"><title>x</title></head></html>"
        );
    }
}
