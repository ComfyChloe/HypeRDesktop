use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackerConfig {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    #[serde(default)]
    pub sql_enabled: bool,
    #[serde(default)]
    pub db_host: String,
    #[serde(default = "default_db_port")]
    pub db_port: String,
    #[serde(default)]
    pub db_user: String,
    #[serde(default)]
    pub db_password: String,
    #[serde(default = "default_db_name")]
    pub db_name: String,
    #[serde(default = "default_write_interval")]
    pub db_write_interval_ms: u64,
    #[serde(default = "default_stale_threshold")]
    pub stale_threshold_ms: u64,
    #[serde(default)]
    pub trackers: Vec<TrackerConfig>,
}

fn default_db_port() -> String { "3306".into() }
fn default_db_name() -> String { "heartmonitor".into() }
fn default_write_interval() -> u64 { 2000 }
fn default_stale_threshold() -> u64 { 8000 }

impl Default for Config {
    fn default() -> Self {
        Self {
            sql_enabled: false,
            db_host: String::new(),
            db_port: default_db_port(),
            db_user: String::new(),
            db_password: String::new(),
            db_name: default_db_name(),
            db_write_interval_ms: default_write_interval(),
            stale_threshold_ms: default_stale_threshold(),
            trackers: Vec::new(),
        }
    }
}

fn config_path() -> PathBuf {
    #[cfg(debug_assertions)]
    {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../config.json")
    }
    #[cfg(not(debug_assertions))]
    {
        std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|d| d.join("config.json")))
            .unwrap_or_else(|| PathBuf::from("config.json"))
    }
}

pub fn load_config() -> Config {
    let path = config_path();
    if !path.exists() {
        let default = Config::default();
        let _ = save_config(&default);
        return default;
    }
    match std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
    {
        Some(cfg) => cfg,
        None => {
            eprintln!("Failed to parse config.json — using defaults");
            Config::default()
        }
    }
}

pub fn save_config(config: &Config) -> Result<(), String> {
    let path = config_path();
    let json = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| e.to_string())
}

pub fn api_key() -> &'static str {
    option_env!("HYPERATE_API_KEY").unwrap_or("")
}
