fn main() {
    // If HYPERATE_API_KEY is already set in the environment, use it.
    // Otherwise read secrets.json from the workspace root and extract the key
    // with a simple string search (no serde dependency in build scripts).
    if std::env::var("HYPERATE_API_KEY").unwrap_or_default().is_empty() {
        let secrets_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../secrets.json");
        println!("cargo:rerun-if-changed={}", secrets_path.display());
        if let Ok(raw) = std::fs::read_to_string(&secrets_path) {
            // Extract "apiKey": "<value>" without a JSON parser
            if let Some(key) = extract_api_key(&raw) {
                println!("cargo:rustc-env=HYPERATE_API_KEY={}", key);
            }
        }
    }
    println!("cargo:rerun-if-env-changed=HYPERATE_API_KEY");
    tauri_build::build()
}

fn extract_api_key(json: &str) -> Option<&str> {
    let needle = "\"apiKey\"";
    let start = json.find(needle)? + needle.len();
    let after = json[start..].trim_start();
    let after = after.strip_prefix(':')?.trim_start();
    let after = after.strip_prefix('"')?;
    let end = after.find('"')?;
    Some(&after[..end])
}
