mod commands;
mod config;
mod db;
mod hyperate;
mod log;
mod tracker;

// Re-exported so the integration tests in `src-tauri/tests/` can reach the
// pure logic without a Tauri app instance or a live WebSocket. Everything
// here is side-effect free; the `run()` entry point below is unchanged.
pub use config::{Config, TrackerConfig};
pub use db::{safe_table_id, table_name};
pub use hyperate::{
    hr_topic, parse_hr_update, parse_phx_reply_status, phx_heartbeat_message, phx_join_message,
    phx_leave_message,
};
pub use tracker::{
    new_tracker_map, ordered_ids, snapshot_ordered, TrackerEntry, TrackerMapInner, TrackerSnapshot,
};

use commands::app::{close_window, resize_window};
use commands::tracker::{add_tracker, get_trackers, remove_tracker};
use hyperate::new_connection_map;
use tauri::{Emitter, Manager};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let config = config::load_config();
    let api_key = config::api_key();
    log::log_info(&format!(
        "HypeRDesktop starting — config has {} tracker(s), api_key present: {}",
        config.trackers.len(),
        !api_key.is_empty()
    ));

    let tracker_map = new_tracker_map();
    {
        let mut map = tracker_map.write().unwrap();
        for t in &config.trackers {
            map.entries
                .insert(t.id.clone(), tracker::TrackerEntry::new(t.name.clone()));
            map.order.push(t.id.clone());
        }
        log::log_info(&format!(
            "seeded runtime map with {} tracker(s) in config order: [{}]",
            map.order.len(),
            map.order.join(", ")
        ));
    }

    let connections = new_connection_map();

    tauri::Builder::default()
        .manage(tracker_map.clone())
        .manage(connections.clone())
        .invoke_handler(tauri::generate_handler![
            add_tracker,
            remove_tracker,
            get_trackers,
            resize_window,
            close_window,
        ])
        .setup(move |app| {
            let app_handle = app.handle().clone();

            // Set initial window size based on loaded tracker count
            let tracker_count = tracker_map.read().unwrap().entries.len();
            if tracker_count > 0 {
                if let Some(window) = app.get_webview_window("main") {
                    let width = (tracker_count * 100).max(100) as u32;
                    let _ = window.set_size(tauri::LogicalSize::new(width, 100u32));
                }
            }

            // Emit the initial snapshot so the renderer paints known trackers
            // (with disconnected visuals) on first paint instead of an empty UI.
            let initial_snapshot = tracker::snapshot_ordered(&tracker_map.read().unwrap());
            log::log_info(&format!(
                "emitting initial snapshot with {} tracker(s)",
                initial_snapshot.len()
            ));
            let _ = app.emit("heart-rate-update", &initial_snapshot);

            // Start one WS connection per tracker (HypeRate's Phoenix Channels
            // backend only delivers hr_update to a single subscribed topic per
            // socket, so multi-tracker support requires one connection each).
            hyperate::start_hyperate_task(
                api_key,
                tracker_map.clone(),
                app_handle.clone(),
                connections.clone(),
            );

            // Start DB timer (async: create pool first, then start timer)
            let db_config = config.clone();
            let db_trackers = tracker_map.clone();
            tauri::async_runtime::spawn(async move {
                let pool = db::create_pool(&db_config).await;
                if let Some(ref p) = pool {
                    db::init_tables(p, &db_trackers).await;
                }
                db::start_db_timer(pool, db_trackers, db_config);
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running HypeRate Desktop");
}
