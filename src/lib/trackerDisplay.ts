// ==== trackerDisplay.ts — pure presentation logic for a tracker widget.
//
// Every rule here was previously inline computed properties in
// HeartWidget.vue. Extracting them keeps the timing thresholds in one
// testable place and, more importantly, lets the thresholds be exercised
// directly instead of only through rendered markup.
//
// The single source of truth for "is this widget connected?" is
// `isDisconnected`. `--` is shown for disconnected widgets, so getting it
// wrong means either a live heart rate hidden behind dashes or a stale
// number presented as if it were current.

/** Rust's channel watchdog forces a reconnect on its second stale check
 *  (60s). The renderer matches this so a single WebSocket blip doesn't flip
 *  every widget to "--" for one cycle. */
export const STALE_THRESHOLD_MS = 60_000

/** Beyond this, the exact age is noise — shown as a vague phrase instead. */
export const VAGUE_AFTER_MS = 5 * 60_000

/** Placeholder shown when there is no trustworthy reading. */
export const NO_READING = '--'

export interface TrackerEntry {
  name: string
  lastUpdate: number
  lastHeartrate: number
  lastChanged: number
}

/**
 * Milliseconds since the last update, or 0 when the tracker has never
 * reported. `Math.abs` is deliberate: a `lastUpdate` in the future (clock
 * skew between the WS event and the render, or a system clock change) would
 * otherwise yield a negative age that reads as "not stale" forever.
 */
export function staleMs(entry: TrackerEntry, now: number): number {
  if (entry.lastUpdate === 0) return 0
  return Math.abs(now - entry.lastUpdate)
}

/** True once the last reading is older than the stale threshold. */
export function isStale(entry: TrackerEntry, now: number): boolean {
  return staleMs(entry, now) > STALE_THRESHOLD_MS
}

/**
 * No live data. Either the tracker has never reported, or the last report is
 * older than the stale threshold.
 */
export function isDisconnected(entry: TrackerEntry, now: number): boolean {
  return entry.lastUpdate === 0 || isStale(entry, now)
}

/**
 * Human-readable age, shown under the reading. Precise to the second up to
 * `VAGUE_AFTER_MS`, then a vague phrase so the widget doesn't jitter between
 * "299s ago" and "a while ago".
 */
export function staleText(entry: TrackerEntry, now: number): string {
  const age = staleMs(entry, now)
  return age < VAGUE_AFTER_MS ? `${Math.floor(age / 1000)}s ago` : 'a while ago'
}

/** The heart rate to render, or `--` when disconnected. */
export function heartDisplay(entry: TrackerEntry, now: number): string | number {
  return isDisconnected(entry, now) ? NO_READING : entry.lastHeartrate
}
