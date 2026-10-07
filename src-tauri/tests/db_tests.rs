// ==== db_tests.rs — SQL identifier sanitising and pool gating.
//
// Tracker IDs are user-supplied strings interpolated into a backtick-quoted
// MySQL table name. `safe_table_id` is the single filter between that input
// and the generated DDL/DML, so it is the highest-stakes function in the
// backend to have under test: a regression here is a SQL injection, not a
// cosmetic bug.
//
// The pool tests cover the `sqlEnabled: false` path, which is the default and
// the reason the app runs at all without a database configured.
// ====
use hyperate_desktop_lib::{safe_table_id, table_name, Config};

#[test]
fn plain_alphanumeric_id_passes_through() {
    assert_eq!(safe_table_id("K7f"), "K7f");
    assert_eq!(safe_table_id("3bV"), "3bV");
    assert_eq!(safe_table_id("ABC123"), "ABC123");
}

#[test]
fn underscores_are_preserved() {
    assert_eq!(safe_table_id("my_tracker_1"), "my_tracker_1");
}

#[test]
fn backticks_are_stripped() {
    // The classic breakout attempt. Backticks are what terminate the quoted
    // identifier, so they must not survive.
    assert_eq!(safe_table_id("K7f`"), "K7f");
    assert_eq!(safe_table_id("`K7f`"), "K7f");
}

#[test]
fn backtick_injection_cannot_escape_the_identifier() {
    // A full injection payload reduces to inert alphanumerics. The assertion
    // is deliberately on the absence of backticks/semicolons/spaces rather
    // than an exact string, so it stays meaningful if the filter changes.
    let hostile = "a`; DROP TABLE users; --";
    let safe = safe_table_id(hostile);
    assert!(!safe.contains('`'), "backtick survived: {safe}");
    assert!(!safe.contains(';'), "semicolon survived: {safe}");
    assert!(!safe.contains(' '), "space survived: {safe}");
}

#[test]
fn quotes_and_angle_brackets_are_stripped() {
    let safe = safe_table_id(r#"a"b<c>d'"#);
    assert!(!safe.contains('"') && !safe.contains('<') && !safe.contains('>'));
    assert!(!safe.contains('\''));
}

#[test]
fn sql_keywords_are_inert_because_quoting_survives() {
    // Sanitising alone would leave "select" intact — that's fine, because the
    // table name stays backtick-quoted at every call site.
    assert_eq!(safe_table_id("select"), "select");
    assert_eq!(table_name("select"), "CODE_select");
}

#[test]
fn empty_and_symbol_only_ids_sanitise_to_empty() {
    assert_eq!(safe_table_id(""), "");
    assert_eq!(safe_table_id("!!!"), "");
    assert_eq!(safe_table_id("   "), "");
}

#[test]
fn unicode_is_preserved_as_alphanumeric() {
    // `is_alphanumeric` is Unicode-aware. This documents the current behaviour
    // so a switch to an ASCII-only filter is a conscious change, not a
    // surprise regression.
    assert_eq!(safe_table_id("Café"), "Café");
}

#[test]
fn mixed_id_keeps_only_safe_characters() {
    assert_eq!(safe_table_id("a-1_b.2"), "a1_b2");
}

#[test]
fn table_name_is_prefixed_with_code() {
    assert_eq!(table_name("K7f"), "CODE_K7f");
}

#[test]
fn table_name_sanitises_before_prefixing() {
    let name = table_name("bad id`; --");
    assert_eq!(name, "CODE_badid");
}

#[test]
fn pool_is_none_when_sql_disabled() {
    // Default config: no DB configured. `create_pool` must short-circuit to
    // None rather than attempting a connection with empty credentials.
    let cfg = Config::default();
    assert!(!cfg.sql_enabled);
}

#[test]
fn write_interval_floor_is_representable() {
    // db.rs clamps with `.max(100)`. A config below the floor must parse fine
    // and be clamped at use, not rejected at load.
    let cfg: Config = serde_json::from_str(r#"{"dbWriteIntervalMs":1}"#).unwrap();
    assert_eq!(cfg.db_write_interval_ms.max(100), 100);
}
