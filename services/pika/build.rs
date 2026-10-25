// Release builds embed web/dist; rebuild when it changes, or when it appears inside web/.
fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    if let Some(dir) = ["web/dist", "web"].into_iter().find(|dir| std::path::Path::new(dir).exists()) {
        println!("cargo:rerun-if-changed={dir}");
    }
}
