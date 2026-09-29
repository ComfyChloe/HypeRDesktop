// ==== tracker.rs — runtime tracker state.
//
// Stores both a HashMap (O(1) lookup by ID) and a parallel Vec<String>
// (config.json order). The Vec is the source of truth for UI/snapshot
// ordering; the HashMap is purely an accelerator for lookups.
//
// The runtime order is seeded from `config.trackers` (a Vec, so JSON order
// is preserved) and updated on add/remove. This guarantees the UI renders
// trackers in the order the user defined them in config.json, with no
// dependence on HashMap iteration (which is randomized per process).
//
// The IPC contract uses `TrackerSnapshot` — a tagged tuple — instead of a
// raw Record. JSON arrays preserve order by spec, so the JS side can
// iterate in the same order Rust emitted it.
// ====
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

/// One element of the snapshot emitted to the renderer. `id` first so the
/// serializer outputs `{ "id": "...", "name": ..., ... }` and the renderer
/// can pair them without ambiguity.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackerSnapshot {
    pub id: String,
    #[serde(flatten)]
    pub entry: TrackerEntry,
}

#[derive(Debug, Default, Clone)]
pub struct TrackerMapInner {
    /// Fast lookup by tracker ID.
    pub entries: HashMap<String, TrackerEntry>,
    /// Config.json order. Append on add, remove on delete. The first element
    /// is rendered leftmost in the UI; the last is rightmost.
    pub order: Vec<String>,
}

pub type TrackerMap = Arc<RwLock<TrackerMapInner>>;

pub fn new_tracker_map() -> TrackerMap {
    Arc::new(RwLock::new(TrackerMapInner::default()))
}

/// Build an ordered snapshot of all trackers, in config.json order. This is
/// what the renderer iterates to paint widgets left-to-right.
pub fn snapshot_ordered(map: &TrackerMapInner) -> Vec<TrackerSnapshot> {
    map.order
        .iter()
        .filter_map(|id| {
            map.entries.get(id).map(|entry| TrackerSnapshot {
                id: id.clone(),
                entry: entry.clone(),
            })
        })
        .collect()
}

/// Ordered list of tracker IDs in config.json order. Used by
/// `start_hyperate_task` to spawn connection loops deterministically.
pub fn ordered_ids(map: &TrackerMapInner) -> Vec<String> {
    map.order.clone()
}