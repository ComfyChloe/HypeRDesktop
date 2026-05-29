use tauri::{AppHandle, Emitter, State};

use crate::config::{load_config, save_config, TrackerConfig};
use crate::hyperate::{join_channel, leave_channel, WsSenderHandle};
use crate::tracker::{TrackerEntry, TrackerMap};

#[tauri::command]
pub async fn add_tracker(
    id: String,
    name: String,
    trackers: State<'_, TrackerMap>,
    ws: State<'_, WsSenderHandle>,
    app: AppHandle,
) -> Result<(), String> {
    {
        let mut map = trackers.write().unwrap();
        map.entry(id.clone()).or_insert_with(|| TrackerEntry::new(name.clone()));
    }
    let mut config = load_config();
    if !config.trackers.iter().any(|t| t.id == id) {
        config.trackers.push(TrackerConfig { id: id.clone(), name });
        save_config(&config)?;
    }
    join_channel(&ws, &id).await;
    let snapshot = trackers.read().unwrap().clone();
    app.emit("heart-rate-update", &snapshot).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn remove_tracker(
    id: String,
    trackers: State<'_, TrackerMap>,
    ws: State<'_, WsSenderHandle>,
    app: AppHandle,
) -> Result<(), String> {
    leave_channel(&ws, &id).await;
    {
        let mut map = trackers.write().unwrap();
        map.remove(&id);
    }
    let mut config = load_config();
    config.trackers.retain(|t| t.id != id);
    save_config(&config)?;
    let snapshot = trackers.read().unwrap().clone();
    app.emit("heart-rate-update", &snapshot).map_err(|e| e.to_string())?;
    Ok(())
}
