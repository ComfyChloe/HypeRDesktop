# Tests

110 tests covering the Rust backend and the Vue frontend. Both suites run
without a live HypeRate account, WebSocket, or MySQL server.

```bash
npm test          # frontend (Vitest) — 57 tests
npm run test:rust # backend (cargo test) — 53 tests
npm run test:all  # both
npm run test:watch
```

Type-checked separately, since the base `tsconfig.json` only covers `src/`:

```bash
npm run typecheck:tests
```

## Layout

| File | Covers |
|---|---|
| `trackerDisplay.spec.ts` | Widget staleness, disconnection, `--` rendering, captions |
| `layout.spec.ts` | Overlay strip sizing and resize gating |
| `HeartWidget.spec.ts` | The `HeartWidget.vue` SFC — markup, classes, remove button, timer cleanup |
| `../src-tauri/tests/tracker_tests.rs` | Tracker ordering invariants and snapshot shape |
| `../src-tauri/tests/config_tests.rs` | `config.json` parsing, defaults, camelCase round-trip |
| `../src-tauri/tests/protocol_tests.rs` | Phoenix Channels frames and inbound routing |
| `../src-tauri/tests/db_tests.rs` | SQL identifier sanitising, pool gating |

## What is deliberately not covered

- **Live WebSocket behaviour.** `tracker_loop` needs an `AppHandle` and a real
  socket. The pure parts — message construction and frame parsing — are
  extracted and tested; the loop around them is not.
- **MySQL integration.** `sqlEnabled` is `false` by default, so `create_pool`
  short-circuits. Exercising the write path needs a live server.
- **Tauri IPC.** Commands are thin wrappers over the functions above and
  require an `AppHandle` to construct.

## Notes for contributors

Thresholds in `src/lib/trackerDisplay.ts` are mirrored by the Rust watchdog
(`STALE_SECS` in `hyperate.rs`). If you change one, change both — the tests
assert the current values, so a mismatch fails loudly rather than silently
showing a stale reading as live.

`safe_table_id` in `db.rs` is the only filter between user-supplied tracker
IDs and an interpolated MySQL table name. It has adversarial tests; keep them
passing if you touch it.
