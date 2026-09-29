// ==== log.rs — tiny append-only file logger for HypeRDesktop.
//
// Tauri Windows GUI apps don't have a visible stdout/stderr by default, so
// `eprintln!` only shows up in the terminal that launched `tauri dev`.
// For visibility on the user's side, mirror log lines to a file at:
//   <exe dir>/logs/hyperate.log
// (debug builds also try ../logs/hyperate.log relative to CARGO_MANIFEST_DIR
// so the dev binary writes next to source).
//
// The functions are no-ops if the log file can't be opened (e.g. read-only
// filesystem, sandbox restriction) so the app never fails because of logging.
// ====

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

static LOG_FILE: OnceLock<Mutex<Option<File>>> = OnceLock::new();

fn log_file() -> &'static Mutex<Option<File>> {
    LOG_FILE.get_or_init(|| {
        let candidates = [
            PathBuf::from("logs/hyperate.log"),
            PathBuf::from("../logs/hyperate.log"),
            std::env::temp_dir().join("hyperate-desktop.log"),
        ];
        for path in &candidates {
            if let Some(parent) = path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            match OpenOptions::new().create(true).append(true).open(path) {
                Ok(f) => {
                    eprintln!("[log] writing to {}", path.display());
                    return Mutex::new(Some(f));
                }
                Err(e) => {
                    eprintln!("[log] could not open {}: {e}", path.display());
                }
            }
        }
        Mutex::new(None)
    })
}

fn write_line(level: &str, msg: &str) {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0);
    let line = format!("[{now:.3}] [{level}] {msg}\n");
    // Poisoning is non-fatal — if a previous holder panicked, recover and
    // proceed rather than swallow log lines.
    let mut guard = match log_file().lock() {
        Ok(g) => g,
        Err(poisoned) => poisoned.into_inner(),
    };
    if let Some(file) = guard.as_mut() {
        let _ = file.write_all(line.as_bytes());
        let _ = file.flush();
    }
}

pub fn log_info(msg: &str) { write_line("INFO", msg); }
pub fn log_warn(msg: &str) { write_line("WARN", msg); }
pub fn log_error(msg: &str) { write_line("ERROR", msg); }
#[allow(dead_code)]
pub fn log_debug(msg: &str) { write_line("DEBUG", msg); }