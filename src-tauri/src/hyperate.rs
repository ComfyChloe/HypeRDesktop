use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::net::TcpStream;
use tokio::sync::Mutex;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async};

use crate::tracker::TrackerMap;

type WsSink = futures_util::stream::SplitSink<WebSocketStream<MaybeTlsStream<TcpStream>>, Message>;
pub type WsSenderHandle = Arc<Mutex<Option<WsSink>>>;

pub fn new_ws_sender() -> WsSenderHandle {
    Arc::new(Mutex::new(None))
}

pub async fn join_channel(sender: &WsSenderHandle, id: &str) {
    let mut guard = sender.lock().await;
    if let Some(sink) = guard.as_mut() {
        let msg = json!({
            "topic": format!("hr:{}", id),
            "event": "phx_join",
            "payload": {},
            "ref": 0
        });
        let _ = sink.send(Message::Text(msg.to_string().into())).await;
    }
}

pub async fn leave_channel(sender: &WsSenderHandle, id: &str) {
    let mut guard = sender.lock().await;
    if let Some(sink) = guard.as_mut() {
        let msg = json!({
            "topic": format!("hr:{}", id),
            "event": "phx_leave",
            "payload": {},
            "ref": 0
        });
        let _ = sink.send(Message::Text(msg.to_string().into())).await;
    }
}

pub fn start_hyperate_task(api_key: &'static str, trackers: TrackerMap, sender: WsSenderHandle, app: AppHandle) {
    tauri::async_runtime::spawn(hyperate_loop(api_key, trackers, sender, app));
}

async fn hyperate_loop(api_key: &'static str, trackers: TrackerMap, sender: WsSenderHandle, app: AppHandle) {
    const STALE_SECS: u64 = 3 * 60;
    let url = format!("wss://app.hyperate.io/socket/websocket?token={}", api_key);

    loop {
        eprintln!("HypeRate: connecting...");
        let ws_stream = match connect_async(&url).await {
            Ok((stream, _)) => stream,
            Err(e) => {
                eprintln!("HypeRate: connect failed: {e}");
                tokio::time::sleep(Duration::from_secs(10)).await;
                continue;
            }
        };

        let (sink, mut stream) = ws_stream.split();
        {
            let mut guard = sender.lock().await;
            *guard = Some(sink);
        }

        // Join all current channels
        {
            let ids: Vec<String> = trackers.read().unwrap().keys().cloned().collect();
            eprintln!("HypeRate: connected, joining {} channel(s)", ids.len());
            for id in &ids {
                join_channel(&sender, id).await;
            }
        }

        let mut last_heartbeat = Instant::now();
        let mut last_hr: Option<Instant> = None;
        let mut watchdog_count = 0u32;
        let mut watchdog_first_done = false;
        let mut last_watchdog = Instant::now();
        let mut force_disconnect = false;

        loop {
            // Re-create a 1-second sleep each iteration for the timer arm
            let tick = tokio::time::sleep(Duration::from_secs(1));

            tokio::select! {
                msg = stream.next() => {
                    match msg {
                        None => { eprintln!("HypeRate: stream ended"); break; }
                        Some(Err(e)) => { eprintln!("HypeRate: WS error: {e}"); break; }
                        Some(Ok(Message::Text(text))) => {
                            if let Ok(data) = serde_json::from_str::<Value>(&text) {
                                if data["event"].as_str() == Some("hr_update") {
                                    let topic = data["topic"].as_str().unwrap_or_default();
                                    if let Some(id) = topic.strip_prefix("hr:") {
                                        if let Some(hr) = data["payload"]["hr"].as_u64() {
                                            let now_ms = SystemTime::now()
                                                .duration_since(UNIX_EPOCH)
                                                .unwrap_or_default()
                                                .as_millis() as u64;
                                            {
                                                let mut map = trackers.write().unwrap();
                                                if let Some(entry) = map.get_mut(id) {
                                                    if hr as u8 != entry.last_heartrate {
                                                        entry.last_heartrate = hr as u8;
                                                        entry.last_changed = now_ms;
                                                    }
                                                    entry.last_update = now_ms;
                                                }
                                            }
                                            last_hr = Some(Instant::now());
                                            watchdog_count = 0;
                                            let snapshot = trackers.read().unwrap().clone();
                                            let _ = app.emit("heart-rate-update", &snapshot);
                                        }
                                    }
                                }
                            }
                        }
                        _ => {}
                    }
                }
                _ = tick => {
                    // Phoenix heartbeat every 30s
                    if last_heartbeat.elapsed() >= Duration::from_secs(30) {
                        let mut guard = sender.lock().await;
                        if let Some(sink) = guard.as_mut() {
                            let msg = json!({
                                "topic": "phoenix",
                                "event": "heartbeat",
                                "payload": {},
                                "ref": 0
                            });
                            if sink.send(Message::Text(msg.to_string().into())).await.is_err() {
                                force_disconnect = true;
                            }
                        }
                        drop(guard);
                        last_heartbeat = Instant::now();
                    }

                    // Channel watchdog
                    let watchdog_wait = if watchdog_first_done {
                        Duration::from_secs(60)
                    } else {
                        Duration::from_secs(30)
                    };
                    if last_watchdog.elapsed() >= watchdog_wait {
                        watchdog_first_done = true;
                        last_watchdog = Instant::now();
                        let tracker_count = trackers.read().unwrap().len();
                        if tracker_count > 0 {
                            let stale = last_hr
                                .map(|t| t.elapsed() > Duration::from_secs(STALE_SECS))
                                .unwrap_or(true);
                            if stale {
                                watchdog_count += 1;
                                let since = last_hr
                                    .map(|t| format!("{}s ago", t.elapsed().as_secs()))
                                    .unwrap_or_else(|| "never".into());
                                if watchdog_count >= 2 {
                                    eprintln!("Watchdog: {} re-joins with no data — forcing reconnect", watchdog_count);
                                    force_disconnect = true;
                                } else {
                                    eprintln!("Watchdog: last update {} — re-joining {} channel(s) (attempt {})", since, tracker_count, watchdog_count);
                                    let ids: Vec<String> = trackers.read().unwrap().keys().cloned().collect();
                                    for id in &ids {
                                        join_channel(&sender, id).await;
                                    }
                                }
                            } else {
                                watchdog_count = 0;
                            }
                        }
                    }

                    if force_disconnect {
                        break;
                    }
                }
            }
        }

        {
            let mut guard = sender.lock().await;
            *guard = None;
        }
        eprintln!("HypeRate: disconnected — reconnecting in 10s");
        tokio::time::sleep(Duration::from_secs(10)).await;
    }
}
