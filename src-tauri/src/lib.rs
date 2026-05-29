mod commands;
mod config;
mod db;
mod hyperate;
mod tracker;

use commands::app::{close_window, resize_window};
use commands::tracker::{add_tracker, remove_tracker};
use hyperate::new_ws_sender;
use tauri::Manager;
use tracker::new_tracker_map;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let config = config::load_config();
    let api_key = config::api_key();

    let tracker_map = new_tracker_map();
    {
        let mut map = tracker_map.write().unwrap();
        for t in &config.trackers {
            map.insert(t.id.clone(), tracker::TrackerEntry::new(t.name.clone()));
        }
    }

    let ws_sender = new_ws_sender();

    tauri::Builder::default()
        .manage(tracker_map.clone())
        .manage(ws_sender.clone())
        .invoke_handler(tauri::generate_handler![
            add_tracker,
            remove_tracker,
            resize_window,
            close_window,
        ])
        .setup(move |app| {
            let app_handle = app.handle().clone();

            // Set initial window size based on loaded tracker count
            let tracker_count = tracker_map.read().unwrap().len();
            if tracker_count > 0 {
                if let Some(window) = app.get_webview_window("main") {
                    let width = (tracker_count * 100).max(100) as u32;
                    let _ = window.set_size(tauri::LogicalSize::new(width, 100u32));
                }
            }

            // Start WS connection task
            hyperate::start_hyperate_task(
                api_key,
                tracker_map.clone(),
                ws_sender.clone(),
                app_handle.clone(),
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
