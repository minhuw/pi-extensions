// Release builds embed web/dist; rebuild when it changes, or when it appears inside web/.
fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    if let Some(dir) = ["web/dist", "web"].into_iter().find(|dir| std::path::Path::new(dir).exists()) {
        println!("cargo:rerun-if-changed={dir}");
    }
    // The commit the binary is built from, which the image build passes as `PIKA_REVISION`: its first 7 hex digits,
    // or empty when it is unset or not a commit id. `PIKA_BUILD` is the version, followed by that commit if known.
    println!("cargo:rerun-if-env-changed=PIKA_REVISION");
    let revision = std::env::var("PIKA_REVISION").unwrap_or_default();
    let revision = revision.trim();
    let short = if revision.len() >= 7 && revision.bytes().all(|b| b.is_ascii_hexdigit()) {
        revision[..7].to_ascii_lowercase()
    } else {
        String::new()
    };
    let version = std::env::var("CARGO_PKG_VERSION").unwrap_or_default();
    let build = if short.is_empty() { version } else { format!("{version} ({short})") };
    println!("cargo:rustc-env=PIKA_REVISION_SHORT={short}");
    println!("cargo:rustc-env=PIKA_BUILD={build}");
}
