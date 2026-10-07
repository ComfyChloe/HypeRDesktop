// ==== protocol_tests.rs — HypeRate Phoenix Channels wire format.
//
// The tracker IDs are short random strings (e.g. "K7f", "3bV") that the user
// reads off a web page and types in. Everything here guards the join/leave
// handshake and the inbound `hr_update` routing, because a malformed frame
// means a widget that silently sits at "--" forever with no visible error.
//
// `parse_hr_update` returning None for a wrong-topic frame is a security-
// relevant behaviour, not just tidiness: it is what stops one tracker's socket
// from writing another tracker's heart rate into the wrong widget.
// ====
use hyperate_desktop_lib::{
    hr_topic, parse_hr_update, parse_phx_reply_status, phx_heartbeat_message, phx_join_message,
    phx_leave_message,
};
use serde_json::Value;

fn parse(s: &str) -> Value {
    serde_json::from_str(s).unwrap()
}

// ---- outbound message shapes ----

#[test]
fn topic_is_namespaced_with_hr_prefix() {
    assert_eq!(hr_topic("K7f"), "hr:K7f");
}

#[test]
fn join_message_has_expected_shape() {
    let v = parse(&phx_join_message("K7f"));
    assert_eq!(v["topic"], "hr:K7f");
    assert_eq!(v["event"], "phx_join");
    assert_eq!(v["ref"], 0);
    assert!(v["payload"].is_object(), "payload must be an object, not null");
}

#[test]
fn leave_message_has_expected_shape() {
    let v = parse(&phx_leave_message("3bV"));
    assert_eq!(v["topic"], "hr:3bV");
    assert_eq!(v["event"], "phx_leave");
    assert_eq!(v["ref"], 0);
}

#[test]
fn heartbeat_uses_reserved_phoenix_topic() {
    // Must NOT be hr:-prefixed — it is a transport-level keepalive, not a
    // subscription to a tracker topic.
    let v = parse(&phx_heartbeat_message());
    assert_eq!(v["topic"], "phoenix");
    assert_eq!(v["event"], "heartbeat");
    assert_eq!(v["ref"], 0);
}

#[test]
fn join_and_leave_differ_only_by_event() {
    let j = parse(&phx_join_message("K7f"));
    let l = parse(&phx_leave_message("K7f"));
    assert_eq!(j["topic"], l["topic"]);
    assert_ne!(j["event"], l["event"]);
}

// ---- inbound hr_update routing ----

#[test]
fn parses_valid_hr_update() {
    let v = parse(r#"{"topic":"hr:K7f","event":"hr_update","payload":{"hr":72}}"#);
    assert_eq!(parse_hr_update(&v, "K7f"), Some(72));
}

#[test]
fn ignores_update_for_a_different_tracker() {
    // The cross-contamination guard. Without this, a socket for "3bV" could
    // paint "K7f"'s heart rate onto its own widget.
    let v = parse(r#"{"topic":"hr:K7f","event":"hr_update","payload":{"hr":150}}"#);
    assert_eq!(parse_hr_update(&v, "3bV"), None);
}

#[test]
fn ignores_topic_without_hr_prefix() {
    let v = parse(r#"{"topic":"phoenix","event":"hr_update","payload":{"hr":80}}"#);
    assert_eq!(parse_hr_update(&v, "K7f"), None);
}

#[test]
fn ignores_non_hr_update_events() {
    let v = parse(r#"{"topic":"hr:K7f","event":"phx_reply","payload":{"hr":80}}"#);
    assert_eq!(parse_hr_update(&v, "K7f"), None);
}

#[test]
fn ignores_missing_event_field() {
    let v = parse(r#"{"topic":"hr:K7f","payload":{"hr":80}}"#);
    assert_eq!(parse_hr_update(&v, "K7f"), None);
}

#[test]
fn ignores_missing_topic_field() {
    let v = parse(r#"{"event":"hr_update","payload":{"hr":80}}"#);
    assert_eq!(parse_hr_update(&v, "K7f"), None);
}

#[test]
fn ignores_payload_without_numeric_hr() {
    let v = parse(r#"{"topic":"hr:K7f","event":"hr_update","payload":{}}"#);
    assert_eq!(parse_hr_update(&v, "K7f"), None);
}

#[test]
fn ignores_non_numeric_hr() {
    // `as_u64` is deliberately strict: a string "72" is not coerced, so a
    // schema change upstream shows up as ignored frames rather than a silent 0.
    let v = parse(r#"{"topic":"hr:K7f","event":"hr_update","payload":{"hr":"72"}}"#);
    assert_eq!(parse_hr_update(&v, "K7f"), None);
}

#[test]
fn accepts_zero_hr() {
    // 0 is a legitimate value (no reading yet); it must not be confused with
    // "field absent" — both yield 0 in the struct but arrive differently.
    let v = parse(r#"{"topic":"hr:K7f","event":"hr_update","payload":{"hr":0}}"#);
    assert_eq!(parse_hr_update(&v, "K7f"), Some(0));
}

#[test]
fn tracker_id_with_prefix_is_compared_whole() {
    // "K7f" must not match a tracker literally named "hr:K7f-extra".
    let v = parse(r#"{"topic":"hr:K7f-extra","event":"hr_update","payload":{"hr":70}}"#);
    assert_eq!(parse_hr_update(&v, "K7f"), None);
}

// ---- phx_reply status ----

#[test]
fn reads_ok_reply_status() {
    let v = parse(r#"{"topic":"hr:K7f","event":"phx_reply","payload":{"status":"ok"}}"#);
    assert_eq!(parse_phx_reply_status(&v), Some("ok"));
}

#[test]
fn reads_error_reply_status() {
    let v = parse(r#"{"topic":"hr:K7f","event":"phx_reply","payload":{"status":"error"}}"#);
    assert_eq!(parse_phx_reply_status(&v), Some("error"));
}

#[test]
fn reply_without_status_reports_question_mark() {
    // Callers log this verbatim, so it must never be None-on-a-reply (which
    // would make an error reply look like a non-reply frame).
    let v = parse(r#"{"topic":"hr:K7f","event":"phx_reply","payload":{}}"#);
    assert_eq!(parse_phx_reply_status(&v), Some("?"));
}

#[test]
fn non_reply_frames_have_no_status() {
    let v = parse(r#"{"topic":"hr:K7f","event":"hr_update","payload":{"hr":70}}"#);
    assert_eq!(parse_phx_reply_status(&v), None);
}
