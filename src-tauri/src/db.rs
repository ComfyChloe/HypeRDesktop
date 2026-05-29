use std::collections::HashSet;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use sqlx::MySqlPool;

use crate::config::Config;
use crate::tracker::TrackerMap;

pub async fn create_pool(config: &Config) -> Option<MySqlPool> {
    if !config.sql_enabled {
        eprintln!("DB: SQL logging disabled");
        return None;
    }
    let url = format!(
        "mysql://{}:{}@{}:{}/{}",
        config.db_user, config.db_password, config.db_host, config.db_port, config.db_name
    );
    match MySqlPool::connect(&url).await {
        Ok(pool) => {
            eprintln!("DB: connected to {}/{}", config.db_host, config.db_name);
            Some(pool)
        }
        Err(e) => {
            eprintln!("DB: connect failed: {e}");
            None
        }
    }
}

async fn create_table(pool: &MySqlPool, id: &str) -> bool {
    let safe_id: String = id.chars().filter(|c| c.is_alphanumeric() || *c == '_').collect();
    let sql = format!(
        "CREATE TABLE IF NOT EXISTS `CODE_{safe_id}` (\
            id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,\
            recorded_at DATETIME NOT NULL,\
            heart_rate TINYINT UNSIGNED NOT NULL,\
            INDEX idx_recorded_at (recorded_at)\
        )"
    );
    match sqlx::query(&sql).execute(pool).await {
        Ok(_) => {
            eprintln!("DB: CODE_{safe_id} table ready");
            true
        }
        Err(e) => {
            eprintln!("DB: failed to create CODE_{safe_id}: {e}");
            false
        }
    }
}

pub async fn init_tables(pool: &MySqlPool, trackers: &TrackerMap) {
    let ids: Vec<String> = trackers.read().unwrap().keys().cloned().collect();
    for id in ids {
        create_table(pool, &id).await;
    }
}

pub fn start_db_timer(pool: Option<MySqlPool>, trackers: TrackerMap, config: Config) {
    let Some(pool) = pool else { return };
    let interval_ms = config.db_write_interval_ms.max(100);
    let stale_ms = config.stale_threshold_ms;

    tauri::async_runtime::spawn(async move {
        let mut ready_tables: HashSet<String> = HashSet::new();
        loop {
            tokio::time::sleep(Duration::from_millis(interval_ms)).await;

            let now_ms = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64;

            let snapshot: Vec<(String, u8)> = {
                trackers.read().unwrap()
                    .iter()
                    .filter_map(|(id, entry)| {
                        if entry.last_heartrate == 0 { return None; }
                        if now_ms.saturating_sub(entry.last_changed) > stale_ms { return None; }
                        Some((id.clone(), entry.last_heartrate))
                    })
                    .collect()
            };

            for (id, hr) in snapshot {
                let safe_id: String = id.chars().filter(|c| c.is_alphanumeric() || *c == '_').collect();
                if !ready_tables.contains(&safe_id) {
                    if create_table(&pool, &id).await {
                        ready_tables.insert(safe_id.clone());
                    } else {
                        continue;
                    }
                }
                let sql = format!("INSERT INTO `CODE_{safe_id}` (recorded_at, heart_rate) VALUES (NOW(), ?)");
                if let Err(e) = sqlx::query(&sql).bind(hr as i16).execute(&pool).await {
                    eprintln!("DB: write error for CODE_{safe_id}: {e}");
                }
            }
        }
    });
}
