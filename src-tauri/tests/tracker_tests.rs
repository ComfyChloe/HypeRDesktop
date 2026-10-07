// ==== tracker_tests.rs — ordering and snapshot invariants.
//
// The whole UI is driven by `snapshot_ordered`: the renderer's left-to-right
// widget order IS the config.json order. If this file ever regresses, widgets
// silently reshuffle between restarts — a bug that is very hard to spot by
// eye. These tests pin the invariant.
//
// The module also stores a HashMap for O(1) lookup. HashMap iteration order is
// randomized per process in Rust, so any test that accidentally relies on it
// would be flaky. `snapshot_ordered` must therefore never iterate the map.
// ====
use hyperate_desktop_lib::{
    new_tracker_map, ordered_ids, snapshot_ordered, TrackerEntry, TrackerMapInner,
};

/// Owned ID list from a snapshot. Collecting into `String` (rather than
/// borrowing `&str` out of the returned Vec) keeps the temporary
/// `Vec<TrackerSnapshot>` from being dropped while still borrowed.
fn snapshot_ids(map: &TrackerMapInner) -> Vec<String> {
    snapshot_ordered(map).into_iter().map(|s| s.id).collect()
}

/// Owned ID list from the `order` vec.
fn order_ids(map: &TrackerMapInner) -> Vec<String> {
    ordered_ids(map)
}

/// Build an inner map from an ordered list of (id, name) pairs, mirroring what
/// `lib.rs::run` does when seeding from config.json.
fn seeded(pairs: &[(&str, &str)]) -> TrackerMapInner {
    let map = new_tracker_map();
    let mut guard = map.write().unwrap();
    for (id, name) in pairs {
        guard
            .entries
            .insert((*id).to_string(), TrackerEntry::new((*name).to_string()));
        guard.order.push((*id).to_string());
    }
    TrackerMapInner {
        entries: guard.entries.clone(),
        order: guard.order.clone(),
    }
}

#[test]
fn empty_map_snapshot_is_empty() {
    let map = TrackerMapInner::default();
    assert!(snapshot_ordered(&map).is_empty());
    assert!(ordered_ids(&map).is_empty());
}

#[test]
fn snapshot_preserves_insertion_order() {
    // Deliberately NOT alphabetical: if this passes for "3bV, K7f" the order
    // really is config order and not a sort or a coincidental hash layout.
    let map = seeded(&[("K7f", "Chloe"), ("3bV", "Kiri")]);
    assert_eq!(snapshot_ids(&map), vec!["K7f", "3bV"], "must follow config order, not sorted order");
}

#[test]
fn ordered_ids_matches_snapshot_order() {
    let map = seeded(&[("abc", "A"), ("def", "D"), ("ghi", "G")]);
    assert_eq!(order_ids(&map), snapshot_ids(&map), "the two orderings must not diverge");
}

#[test]
fn snapshot_carries_name_and_timestamps() {
    let map = seeded(&[("K7f", "Chloe")]);
    let snap = snapshot_ordered(&map);
    let first = &snap[0];
    assert_eq!(first.id, "K7f");
    assert_eq!(first.entry.name, "Chloe");
    // A fresh entry has never received data — this zero state is what drives
    // the renderer's "--" / disconnected visuals on first paint.
    assert_eq!(first.entry.last_heartrate, 0);
    assert_eq!(first.entry.last_update, 0);
    assert_eq!(first.entry.last_changed, 0);
}

#[test]
fn snapshot_skips_order_ids_missing_from_entries() {
    // `order` and `entries` are updated independently by add/remove commands.
    // A stale order entry must not panic or emit a phantom widget.
    let mut map = seeded(&[("K7f", "Chloe"), ("3bV", "Kiri")]);
    map.entries.remove("3bV");
    assert_eq!(snapshot_ids(&map), vec!["K7f"], "orphaned order entry must be filtered out");
}

#[test]
fn snapshot_skips_entries_absent_from_order() {
    // The inverse desync: an entry with no order slot must not be rendered,
    // because there is no position to render it at. The legitimately-ordered
    // tracker alongside it must still render.
    let map = seeded(&[("K7f", "Chloe")]);
    let mut map2 = TrackerMapInner {
        entries: map.entries.clone(),
        order: map.order.clone(),
    };
    map2.entries
        .insert("ghost".into(), TrackerEntry::new("Ghost".into()));
    assert_eq!(
        snapshot_ids(&map2),
        vec!["K7f"],
        "entry with no order slot must not be rendered"
    );
}

#[test]
fn order_is_preserved_across_many_trackers() {
    let pairs: Vec<(String, String)> = (0..12)
        .map(|i| (format!("id{i:02}"), format!("Name {i}")))
        .collect();
    let refs: Vec<(&str, &str)> = pairs.iter().map(|(a, b)| (a.as_str(), b.as_str())).collect();
    let map = seeded(&refs);
    let expected: Vec<String> = pairs.iter().map(|(a, _)| a.clone()).collect();
    assert_eq!(snapshot_ids(&map), expected, "order must survive past the first handful of trackers");
}

#[test]
fn removing_from_middle_preserves_relative_order_of_rest() {
    // Mirrors `remove_tracker`: entries.remove + order.retain.
    let mut map = seeded(&[("a", "A"), ("b", "B"), ("c", "C")]);
    map.entries.remove("b");
    map.order.retain(|x| x != "b");
    assert_eq!(snapshot_ids(&map), vec!["a", "c"]);
}

#[test]
fn re_adding_preserved_entry_keeps_original_position() {
    // Mirrors `add_tracker`: an existing entry is NOT re-appended to `order`.
    // A user re-saving an existing tracker must not send its widget to the end.
    let mut map = seeded(&[("a", "A"), ("b", "B")]);
    let was_present = map.entries.contains_key("b");
    map.entries
        .entry("b".to_string())
        .or_insert_with(|| TrackerEntry::new("B".into()));
    if !was_present {
        map.order.push("b".into());
    }
    assert_eq!(snapshot_ids(&map), vec!["a", "b"]);
}

#[test]
fn tracker_entry_new_starts_zeroed() {
    let e = TrackerEntry::new("Test".into());
    assert_eq!(e.name, "Test");
    assert_eq!(e.last_heartrate, 0);
    assert_eq!(e.last_update, 0);
    assert_eq!(e.last_changed, 0);
}

#[test]
fn snapshot_entry_is_a_clone_not_a_reference() {
    // The renderer receives an owned snapshot; mutating the source map
    // afterwards must not retroactively change an already-taken snapshot.
    let map = seeded(&[("K7f", "Chloe")]);
    let snap = snapshot_ordered(&map);
    let shared = new_tracker_map();
    {
        let mut guard = shared.write().unwrap();
        guard.entries = map.entries.clone();
        guard.order = map.order.clone();
    }
    shared.write().unwrap().entries.get_mut("K7f").unwrap().last_heartrate = 99;
    assert_eq!(snap[0].entry.last_heartrate, 0);
}
