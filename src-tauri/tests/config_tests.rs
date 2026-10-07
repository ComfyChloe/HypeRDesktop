// ==== config_tests.rs — config.json deserialization contract.
//
// config.json is hand-editable by users, so the parser has to be forgiving:
// every field except `trackers` is optional, and unknown keys must not blow
// up the whole load. `run()` degrades to `Config::default()` on a parse
// failure, which would silently disconnect every tracker — so the tolerant
// path is the one that matters and is what these tests pin down.
//
// Field names are camelCase on disk (`sqlEnabled`, `dbWriteIntervalMs`) while
// the Rust struct is snake_case. A mismatch here is invisible until runtime,
// hence the explicit round-trip assertions.
// ====
use hyperate_desktop_lib::{Config, TrackerConfig};

#[test]
fn default_config_is_disabled_and_empty() {
    let c = Config::default();
    assert!(!c.sql_enabled, "SQL logging must be opt-in, not on by default");
    assert_eq!(c.db_port, "3306");
    assert_eq!(c.db_name, "heartmonitor");
    assert_eq!(c.db_write_interval_ms, 2000);
    assert_eq!(c.stale_threshold_ms, 8000);
    assert!(c.trackers.is_empty());
}

#[test]
fn empty_object_falls_back_to_defaults() {
    let c: Config = serde_json::from_str("{}").unwrap();
    assert_eq!(c.db_port, Config::default().db_port);
    assert_eq!(c.stale_threshold_ms, Config::default().stale_threshold_ms);
    assert!(c.trackers.is_empty());
}

#[test]
fn trackers_only_config_is_valid() {
    // The common real-world case: a user config with nothing but trackers.
    let json = r#"{"trackers":[{"id":"K7f","name":"Chloe"},{"id":"3bV","name":"Kiri"}]}"#;
    let c: Config = serde_json::from_str(json).unwrap();
    assert_eq!(c.trackers.len(), 2);
    // Order within the array must survive — the UI renders in this order.
    assert_eq!(c.trackers[0].id, "K7f");
    assert_eq!(c.trackers[1].id, "3bV");
    assert!(!c.sql_enabled);
}

#[test]
fn camel_case_keys_map_to_snake_case_fields() {
    let json = r#"{
        "sqlEnabled": true,
        "dbHost": "127.0.0.1",
        "dbPort": "3307",
        "dbUser": "root",
        "dbPassword": "hunter2",
        "dbName": "hr",
        "dbWriteIntervalMs": 5000,
        "staleThresholdMs": 12000
    }"#;
    let c: Config = serde_json::from_str(json).unwrap();
    assert!(c.sql_enabled);
    assert_eq!(c.db_host, "127.0.0.1");
    assert_eq!(c.db_port, "3307");
    assert_eq!(c.db_user, "root");
    assert_eq!(c.db_password, "hunter2");
    assert_eq!(c.db_name, "hr");
    assert_eq!(c.db_write_interval_ms, 5000);
    assert_eq!(c.stale_threshold_ms, 12000);
}

#[test]
fn serializes_back_to_camel_case() {
    // `save_config` writes this form, and `load_config` must read its own
    // output back — otherwise every add/remove_tracker call corrupts config.
    let c = Config {
        sql_enabled: true,
        db_host: "localhost".into(),
        db_write_interval_ms: 3000,
        ..Default::default()
    };
    let json = serde_json::to_string(&c).unwrap();
    assert!(json.contains("\"sqlEnabled\":true"), "got: {json}");
    assert!(json.contains("\"dbHost\":\"localhost\""), "got: {json}");
    assert!(json.contains("\"dbWriteIntervalMs\":3000"), "got: {json}");

    let reparsed: Config = serde_json::from_str(&json).unwrap();
    assert_eq!(reparsed.sql_enabled, c.sql_enabled);
    assert_eq!(reparsed.db_host, c.db_host);
    assert_eq!(reparsed.db_write_interval_ms, c.db_write_interval_ms);
}

#[test]
fn unknown_keys_are_ignored_not_fatal() {
    // Forward compatibility: a newer client writing extra keys must not brick
    // an older build's config load.
    let json = r#"{"sqlEnabled":false,"someFutureKey":42,"trackers":[]}"#;
    let c: Config = serde_json::from_str(json).unwrap();
    assert!(!c.sql_enabled);
}

#[test]
fn zero_interval_is_preserved_not_defaulted() {
    // `db_write_interval_ms` has no floor in serde; db.rs clamps at runtime.
    // The parser must not silently substitute 2000 here.
    let c: Config = serde_json::from_str(r#"{"dbWriteIntervalMs":0}"#).unwrap();
    assert_eq!(c.db_write_interval_ms, 0);
}

#[test]
fn malformed_json_is_an_error_not_a_panic() {
    // `load_config` relies on this returning Err so it can degrade to defaults.
    assert!(serde_json::from_str::<Config>("{ not json").is_err());
}

#[test]
fn tracker_config_round_trips() {
    let t = TrackerConfig { id: "K7f".into(), name: "Chloe".into() };
    let json = serde_json::to_string(&t).unwrap();
    assert_eq!(json, r#"{"id":"K7f","name":"Chloe"}"#);
    let back: TrackerConfig = serde_json::from_str(&json).unwrap();
    assert_eq!(back.id, "K7f");
    assert_eq!(back.name, "Chloe");
}

#[test]
fn tracker_config_requires_id_and_name() {
    // Both fields are non-Option with no default, so a partial tracker object
    // must be rejected outright rather than defaulted into a broken entry.
    assert!(serde_json::from_str::<TrackerConfig>(r#"{"id":"K7f"}"#).is_err());
    assert!(serde_json::from_str::<TrackerConfig>(r#"{"name":"Chloe"}"#).is_err());
}
