use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::net::TcpStream;
use tokio::sync::{Mutex, Notify};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async};

use crate::log::{log_error, log_info, log_warn};
use crate::tracker::TrackerMap;

type WsSink = futures_util::stream::SplitSink<WebSocketStream<MaybeTlsStream<TcpStream>>, Message>;

/// Per-tracker connection state. Each tracker gets its own WebSocket because
/// HypeRate's Phoenix Channels backend only delivers `hr_update` events to a
/// single subscribed topic per socket (confirmed via probe — joining multiple
/// `hr:X` topics on one socket silently drops all but one). Keeping each
/// tracker on its own connection side-steps the fan-out limitation.
pub struct ConnectionSlot {
    /// Outbound sink (None when the WS is disconnected; populated while
    /// the socket is open).
    sink: Mutex<Option<WsSink>>,
    /// Notified whenever a new tracker needs joining on this socket (used by
    /// the inner loop to refresh subscriptions after a reconnect).
    notify: Notify,
    /// Notified when leave_channel() wants this loop to exit. The inner loop
    /// polls this in its tokio::select! and breaks out cleanly.
    shutdown: Notify,
    /// Flag set by leave_channel() so the loop can detect shutdown even when
    /// it isn't currently parked on `shutdown.notified()` (e.g. mid-connect).
    cancelled: AtomicBool,
}

impl ConnectionSlot {
    fn new() -> Self {
        Self {
            sink: Mutex::new(None),
            notify: Notify::new(),
            shutdown: Notify::new(),
            cancelled: AtomicBool::new(false),
        }
    }
    fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
    }
    fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
        self.shutdown.notify_waiters();
    }
}

/// Tracker ID -> connection state. One slot per tracker ID. Looked up via
/// `Arc<RwLock<HashMap<...>>>` so the `add_tracker` / `remove_tracker`
/// commands can spawn and stop per-tracker loops without coordinating with
/// the global supervisor.
pub type ConnectionMap = Arc<std::sync::RwLock<HashMap<String, Arc<ConnectionSlot>>>>;

pub fn new_connection_map() -> ConnectionMap {
    Arc::new(std::sync::RwLock::new(HashMap::new()))
}

/// Send a `phx_join` on the given sink. Shared by `join_channel` and the
/// per-tracker loop's auto-rejoin path.
async fn send_phx_join(sink: &mut WsSink, id: &str) -> Result<(), String> {
    let msg = json!({
        "topic": format!("hr:{}", id),
        "event": "phx_join",
        "payload": {},
        "ref": 0
    });
    sink.send(Message::Text(msg.to_string().into()))
        .await
        .map_err(|e| e.to_string())
}

async fn send_phx_leave(sink: &mut WsSink, id: &str) -> Result<(), String> {
    let msg = json!({
        "topic": format!("hr:{}", id),
        "event": "phx_leave",
        "payload": {},
        "ref": 0
    });
    sink.send(Message::Text(msg.to_string().into()))
        .await
        .map_err(|e| e.to_string())
}

pub async fn join_channel(
    connections: &ConnectionMap,
    api_key: &'static str,
    trackers: &TrackerMap,
    app: &AppHandle,
    id: &str,
) {
    // Acquire or create the slot for this tracker.
    let slot = {
        let map = connections.read().unwrap();
        map.get(id).cloned()
    };
    let slot = match slot {
        Some(s) => s,
        None => {
            // No slot yet — start a new per-tracker loop. The loop reads
            // `trackers` to update the runtime map and `app` to emit the
            // snapshot. It exits when the slot's task is aborted.
            let new_slot = Arc::new(ConnectionSlot::new());
            // Acquire write lock briefly to register; clone out the slot then
            // drop the guard before spawning so we don't hold a non-Send guard
            // across the await.
            let registered = {
                let mut map = connections.write().unwrap();
                if let Some(existing) = map.get(id).cloned() {
                    Some(existing)
                } else {
                    map.insert(id.to_string(), new_slot.clone());
                    None
                }
            };
            if let Some(existing) = registered {
                return join_channel_existing(existing, id).await;
            }
            spawn_tracker_loop(api_key, trackers, app.clone(), new_slot.clone(), id.to_string());
            new_slot
        }
    };
    join_channel_existing(slot, id).await;
}

/// Send `phx_join` on an existing slot's sink. If the sink is currently
/// disconnected, the loop's reconnect path will join automatically — we
/// also poke the slot's Notify so it picks up the request faster.
async fn join_channel_existing(slot: Arc<ConnectionSlot>, id: &str) {
    let mut guard = slot.sink.lock().await;
    match guard.as_mut() {
        Some(sink) => match send_phx_join(sink, id).await {
            Ok(()) => {
                log_info(&format!("[hyperate] phx_join sent for {id}"));
                eprintln!("[hyperate] phx_join sent for {id}");
            }
            Err(e) => {
                log_error(&format!("[hyperate] phx_join send failed for {id}: {e}"));
                eprintln!("[hyperate] phx_join send failed for {id}: {e}");
            }
        },
        None => {
            log_warn(&format!(
                "[hyperate] join_channel({id}) called but sink is None — loop will rejoin on reconnect"
            ));
            drop(guard);
            slot.notify.notify_one();
        }
    }
}

pub async fn leave_channel(connections: &ConnectionMap, id: &str) {
    let slot = {
        let map = connections.read().unwrap();
        map.get(id).cloned()
    };
    let Some(slot) = slot else {
        log_warn(&format!("[hyperate] leave_channel({id}) called but no slot exists"));
        return;
    };
    // Best-effort phx_leave over the open socket.
    {
        let mut guard = slot.sink.lock().await;
        if let Some(sink) = guard.as_mut() {
            if let Err(e) = send_phx_leave(sink, id).await {
                log_warn(&format!("[hyperate] phx_leave send failed for {id}: {e}"));
            } else {
                log_info(&format!("[hyperate] phx_leave sent for {id}"));
            }
        }
    }
    // Signal the inner loop to exit. Order matters: set the cancelled flag
    // BEFORE notifying waiters, so a loop that's mid-iteration (not parked
    // on .notified()) still sees the flag on its next loop check.
    slot.cancel();
    // Remove from the map. The spawned task holds its own Arc<ConnectionSlot>,
    // so the slot isn't dropped yet — the task will exit on its next
    // shutdown check and the runtime will drop the remaining Arc.
    {
        let mut map = connections.write().unwrap();
        if let Some(current) = map.get(id) {
            if Arc::ptr_eq(current, &slot) {
                map.remove(id);
            }
        }
    }
    log_info(&format!("[hyperate] tracker {id} connection close requested"));
}

pub fn start_hyperate_task(
    api_key: &'static str,
    trackers: TrackerMap,
    app: AppHandle,
    connections: ConnectionMap,
) {
    // Spawn one loop per tracker already in config. The trackers map is
    // populated by lib.rs *before* this is called.
    //
    // IMPORTANT: HashMap iteration order is randomized, so we sort the IDs
    // before spawning. This makes the connection order deterministic across
    // runs (e.g. "3bV" always connects before "K7f"), so the UI opens in a
    // predictable sequence and the log file is easy to diff between runs.
    let initial_ids: Vec<String> = crate::tracker::ordered_ids(&trackers.read().unwrap());
    // Pre-create all slots in one write pass so each subsequent spawn() doesn't
    // contend on the connections RwLock. We also hold the slots until after
    // every spawn() has been queued so the runtime sees them in config.json
    // order, guaranteeing a deterministic connection sequence that matches the
    // UI's left-to-right render order.
    log_info(&format!(
        "[hyperate] spawning connection loops in config order: [{}]",
        initial_ids.join(", ")
    ));
    let mut slots: Vec<(String, Arc<ConnectionSlot>)> = Vec::with_capacity(initial_ids.len());
    {
        let mut map = connections.write().unwrap();
        for id in &initial_ids {
            let slot = Arc::new(ConnectionSlot::new());
            map.insert(id.clone(), slot.clone());
            slots.push((id.clone(), slot));
        }
    }
    for (id, slot) in slots {
        spawn_tracker_loop(api_key, &trackers, app.clone(), slot, id);
    }
    log_info(&format!(
        "[hyperate] started per-tracker loops for {} tracker(s): {}",
        initial_ids.len(),
        initial_ids.join(", ")
    ));
}

fn spawn_tracker_loop(
    api_key: &'static str,
    trackers: &TrackerMap,
    app: AppHandle,
    slot: Arc<ConnectionSlot>,
    id: String,
) {
    // Single spawn per tracker. Cancellation is handled via ConnectionSlot's
    // shutdown Notify + cancelled AtomicBool (set by leave_channel), so we
    // don't need to register a JoinHandle back into the slot.
    let trackers = trackers.clone();
    tauri::async_runtime::spawn(async move {
        tracker_loop(api_key, trackers, app, slot, id).await;
    });
}

async fn tracker_loop(
    api_key: &'static str,
    trackers: TrackerMap,
    app: AppHandle,
    slot: Arc<ConnectionSlot>,
    id: String,
) {
    const STALE_SECS: u64 = 3 * 60;
    let url = format!("wss://app.hyperate.io/socket/websocket?token={}", api_key);

    loop {
        // Check for shutdown before (and during) each connect attempt so we
        // don't reconnect after the user removed this tracker.
        if slot.is_cancelled() {
            log_info(&format!("[hyperate:{id}] cancelled before connect — exiting loop"));
            return;
        }

        let msg = format!("[hyperate:{id}] connecting...");
        eprintln!("{msg}");
        log_info(&msg);
        let ws_stream = match connect_async(&url).await {
            Ok((stream, _)) => stream,
            Err(e) => {
                let m = format!("[hyperate:{id}] connect failed: {e}");
                eprintln!("{m}");
                log_error(&m);
                // Sleep with cancellation awareness — exit early if shutdown
                // is requested instead of waiting the full 10s.
                tokio::select! {
                    _ = slot.shutdown.notified() => {
                        log_info(&format!("[hyperate:{id}] cancelled during reconnect backoff — exiting loop"));
                        return;
                    }
                    _ = tokio::time::sleep(Duration::from_secs(10)) => {}
                }
                continue;
            }
        };

        let (mut sink, mut stream) = ws_stream.split();
        // Join our single tracker immediately so the server knows we're
        // listening for this topic.
        if let Err(e) = send_phx_join(&mut sink, &id).await {
            log_warn(&format!("[hyperate:{id}] initial phx_join failed: {e}"));
        } else {
            log_info(&format!("[hyperate:{id}] phx_join sent"));
        }
        {
            let mut guard = slot.sink.lock().await;
            *guard = Some(sink);
        }
        // Wake any join_channel() callers that arrived during the connect
        // window so they can re-issue phx_join on the fresh sink.
        slot.notify.notify_waiters();

        // Emit the current snapshot so the renderer keeps showing the last
        // known values while we re-establish. Order matters — we want the UI
        // to render in config.json order, not HashMap iteration order, so we
        // build a Vec<TrackerSnapshot> via tracker::snapshot_ordered.
        {
            let snapshot = crate::tracker::snapshot_ordered(&trackers.read().unwrap());
            let _ = app.emit("heart-rate-update", &snapshot);
        }

        let mut last_heartbeat = Instant::now();
        let mut last_hr: Option<Instant> = None;
        let mut watchdog_count: u32 = 0;
        let mut watchdog_first_done = false;
        let mut last_watchdog = Instant::now();
        let mut force_disconnect = false;

        loop {
            let tick = tokio::time::sleep(Duration::from_secs(1));
            tokio::select! {
                msg = stream.next() => {
                    match msg {
                        None => {
                            let m = format!("[hyperate:{id}] stream ended");
                            eprintln!("{m}");
                            log_info(&m);
                            break;
                        }
                        Some(Err(e)) => {
                            let m = format!("[hyperate:{id}] WS error: {e}");
                            eprintln!("{m}");
                            log_error(&m);
                            break;
                        }
                        Some(Ok(Message::Text(text))) => {
                            if let Ok(data) = serde_json::from_str::<Value>(&text) {
                                match data["event"].as_str() {
                                    Some("hr_update") => {
                                        let topic = data["topic"].as_str().unwrap_or_default();
                                        if let Some(tid) = topic.strip_prefix("hr:") {
                                            if tid != id {
                                                // Defensive: HypeRate shouldn't send hr_update
                                                // for a different topic on this socket, but if
                                                // it ever does, ignore it.
                                                continue;
                                            }
                                            if let Some(hr) = data["payload"]["hr"].as_u64() {
                                                let now_ms = SystemTime::now()
                                                    .duration_since(UNIX_EPOCH)
                                                    .unwrap_or_default()
                                                    .as_millis() as u64;
                                                let mut updated = false;
                                                {
                                                    let mut map = trackers.write().unwrap();
                                                    if let Some(entry) = map.entries.get_mut(&id) {
                                                        if hr as u8 != entry.last_heartrate {
                                                            entry.last_heartrate = hr as u8;
                                                            entry.last_changed = now_ms;
                                                            updated = true;
                                                        }
                                                        entry.last_update = now_ms;
                                                    } else {
                                                        log_warn(&format!(
                                                            "[hyperate:{id}] hr_update but tracker missing from runtime map"
                                                        ));
                                                    }
                                                }
                                                if updated {
                                                    log_info(&format!("[hyperate:{id}] hr_update hr={hr}"));
                                                }
                                                last_hr = Some(Instant::now());
                                                watchdog_count = 0;
                                                let snapshot = crate::tracker::snapshot_ordered(&trackers.read().unwrap());
                                                let _ = app.emit("heart-rate-update", &snapshot);
                                            }
                                        }
                                    }
                                    Some("phx_reply") => {
                                        let status = data["payload"]["status"].as_str().unwrap_or("?");
                                        if status != "ok" {
                                            log_warn(&format!(
                                                "[hyperate:{id}] phx_reply status={status} payload={}",
                                                data["payload"]
                                            ));
                                        }
                                    }
                                    _ => {}
                                }
                            }
                        }
                        _ => {}
                    }
                }
                _ = slot.notify.notified() => {
                    // Re-issued join request — phx_join again so the server has
                    // an explicit subscription even if the auto-join above was
                    // missed (e.g. transport-level race).
                    let mut guard = slot.sink.lock().await;
                    if let Some(s) = guard.as_mut() {
                        if let Err(e) = send_phx_join(s, &id).await {
                            log_warn(&format!("[hyperate:{id}] notify-triggered phx_join failed: {e}"));
                        }
                    }
                }
                _ = slot.shutdown.notified() => {
                    // Leave requested — break out of the inner loop and let
                    // the outer reconnect cycle see is_cancelled() and exit.
                    log_info(&format!("[hyperate:{id}] shutdown signalled — closing connection"));
                    force_disconnect = true;
                }
                _ = tick => {
                    // Phoenix heartbeat every 30s.
                    if last_heartbeat.elapsed() >= Duration::from_secs(30) {
                        let mut guard = slot.sink.lock().await;
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

                    // Channel watchdog: re-join or force reconnect on stale data.
                    let watchdog_wait = if watchdog_first_done {
                        Duration::from_secs(60)
                    } else {
                        Duration::from_secs(30)
                    };
                    if last_watchdog.elapsed() >= watchdog_wait {
                        watchdog_first_done = true;
                        last_watchdog = Instant::now();
                        let stale = last_hr
                            .map(|t| t.elapsed() > Duration::from_secs(STALE_SECS))
                            .unwrap_or(true);
                        if stale {
                            watchdog_count = watchdog_count.saturating_add(1);
                            let since = last_hr
                                .map(|t| format!("{}s ago", t.elapsed().as_secs()))
                                .unwrap_or_else(|| "never".into());
                            if watchdog_count >= 2 {
                                let m = format!(
                                    "[hyperate:{id}] watchdog: {watchdog_count} stale checks — forcing reconnect (last hr: {since})"
                                );
                                eprintln!("{m}");
                                log_warn(&m);
                                force_disconnect = true;
                            } else {
                                let m = format!(
                                    "[hyperate:{id}] watchdog: no hr for {since} — re-joining (attempt {watchdog_count})"
                                );
                                eprintln!("{m}");
                                log_warn(&m);
                                let mut guard = slot.sink.lock().await;
                                if let Some(sink) = guard.as_mut() {
                                    let _ = send_phx_join(sink, &id).await;
                                }
                            }
                        } else {
                            watchdog_count = 0;
                        }
                    }

                    if force_disconnect {
                        break;
                    }
                }
            }
        }

        // Disconnect cleanup: clear sink so join_channel() callers see None
        // and a fresh phx_join will be issued once the new socket is up.
        {
            let mut guard = slot.sink.lock().await;
            *guard = None;
        }
        // If we were disconnected because of a shutdown signal, exit the
        // outer loop instead of reconnecting. The cancelled flag was set by
        // leave_channel() before it notified shutdown.
        if slot.is_cancelled() {
            log_info(&format!("[hyperate:{id}] cancelled after disconnect — exiting loop"));
            return;
        }
        let m = format!("[hyperate:{id}] disconnected — reconnecting in 10s");
        eprintln!("{m}");
        log_info(&m);
        tokio::time::sleep(Duration::from_secs(10)).await;
    }
}