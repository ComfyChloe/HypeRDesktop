// ==== commands/tracker.rs — Tauri commands exposed to the renderer for
// managing the user's tracker list.
//
// `add_tracker` / `remove_tracker` maintain BOTH the HashMap (for O(1) HR
// updates from the WS loop) AND the parallel `order` Vec (so the UI renders
// in config.json order, not HashMap iteration order).
//
// All snapshot emits use `TrackerSnapshot[]` (a JSON array of
// `{ id, name, lastUpdate, ... }`) instead of a Record, so the renderer
// can iterate in the order Rust produced it.
// ====
use tauri::{AppHandle, Emitter, State};

use crate::config::{load_config, save_config, TrackerConfig};
use crate::hyperate::{join_channel, leave_channel, ConnectionMap};
use crate::log::log_info;
use crate::tracker::{snapshot_ordered, TrackerEntry, TrackerMap, TrackerSnapshot};

#[tauri::command]
pub fn get_trackers(trackers: State<'_, TrackerMap>) -> Vec<TrackerSnapshot> {
    snapshot_ordered(&trackers.read().unwrap())
}

#[tauri::command]
pub async fn add_tracker(
    id: String,
    name: String,
    trackers: State<'_, TrackerMap>,
    connections: State<'_, ConnectionMap>,
    app: AppHandle,
) -> Result<(), String> {
    let entry_msg = format!("add_tracker called: id={id:?} name={name:?}");
    eprintln!("{entry_msg}");
    log_info(&entry_msg);
    {
        let mut map = trackers.write().unwrap();
        let was_present = map.entries.contains_key(&id);
        map.entries
            .entry(id.clone())
            .or_insert_with(|| TrackerEntry::new(name.clone()));
        if !was_present && !map.order.contains(&id) {
            map.order.push(id.clone());
        }
        if was_present {
            log_info(&format!("[commands] tracker {id} already in runtime map — entry preserved"));
        }
        log_info(&format!(
            "[commands] post-insert order: [{}]",
            map.order.join(", ")
        ));
    }
    let mut config = load_config();
    if !config.trackers.iter().any(|t| t.id == id) {
        config.trackers.push(TrackerConfig { id: id.clone(), name });
        save_config(&config)?;
        log_info(&format!("[commands] saved {id} to config.json"));
    } else {
        log_info(&format!("[commands] {id} already in config.json — skipping save"));
    }
    // Pull the API key from the same source start_hyperate_task uses.
    let api_key = crate::config::api_key();
    join_channel(&connections, api_key, &trackers, &app, &id).await;
    let snapshot = snapshot_ordered(&trackers.read().unwrap());
    log_info(&format!(
        "[commands] emitting snapshot with {} tracker(s) in order: [{}]",
        snapshot.len(),
        snapshot.iter().map(|s| s.id.as_str()).collect::<Vec<_>>().join(", ")
    ));
    app.emit("heart-rate-update", &snapshot)
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn remove_tracker(
    id: String,
    trackers: State<'_, TrackerMap>,
    connections: State<'_, ConnectionMap>,
    app: AppHandle,
) -> Result<(), String> {
    log_info(&format!("[commands] remove_tracker called: id={id:?}"));
    leave_channel(&connections, &id).await;
    {
        let mut map = trackers.write().unwrap();
        map.entries.remove(&id);
        map.order.retain(|existing| existing != &id);
    }
    let mut config = load_config();
    config.trackers.retain(|t| t.id != id);
    save_config(&config)?;
    let snapshot = snapshot_ordered(&trackers.read().unwrap());
    app.emit("heart-rate-update", &snapshot)
        .map_err(|e| e.to_string())?;
    Ok(())
}