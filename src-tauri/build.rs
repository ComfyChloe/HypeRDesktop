fn main() {
    println!("cargo:rerun-if-env-changed=HYPERATE_API_KEY");
    tauri_build::build()
}
