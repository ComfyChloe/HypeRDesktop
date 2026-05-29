use serde::Serialize;
use std::collections::HashMap;
use std::sync::{Arc, RwLock};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackerEntry {
    pub name: String,
    pub last_update: u64,
    pub last_heartrate: u8,
    pub last_changed: u64,
}

impl TrackerEntry {
    pub fn new(name: String) -> Self {
        Self {
            name,
            last_update: 0,
            last_heartrate: 0,
            last_changed: 0,
        }
    }
}

pub type TrackerMap = Arc<RwLock<HashMap<String, TrackerEntry>>>;

pub fn new_tracker_map() -> TrackerMap {
    Arc::new(RwLock::new(HashMap::new()))
}
