// ==== trackerDisplay.spec.ts — widget staleness and disconnection rules.
//
// These thresholds decide whether a user sees a live heart rate or "--".
// Getting them wrong fails quietly: a stale number looks exactly like a live
// one until someone notices a friend hasn't updated in an hour. Hence the
// boundary tests on both sides of each threshold, not just the happy path.
import { describe, it, expect } from 'vitest'
import {
  heartDisplay,
  isDisconnected,
  isStale,
  staleMs,
  staleText,
  NO_READING,
  STALE_THRESHOLD_MS,
  VAGUE_AFTER_MS,
  type TrackerEntry,
} from '../src/lib/trackerDisplay'

const NOW = 1_700_000_000_000

function entry(overrides: Partial<TrackerEntry> = {}): TrackerEntry {
  return {
    name: 'Chloe',
    lastUpdate: NOW,
    lastHeartrate: 72,
    lastChanged: NOW,
    ...overrides,
  }
}

/** A tracker that last reported `ageMs` ago. */
function aged(ageMs: number, hr = 72): TrackerEntry {
  return entry({ lastUpdate: NOW - ageMs, lastHeartrate: hr })
}

// ---- staleMs ----

describe('staleMs', () => {
  it('returns 0 for a tracker that has never reported', () => {
    expect(staleMs(entry({ lastUpdate: 0 }), NOW)).toBe(0)
  })

  it('measures the age of a recent update', () => {
    expect(staleMs(aged(5_000), NOW)).toBe(5_000)
  })

  it('treats a future timestamp as recently updated', () => {
    // Clock skew must not produce a negative age, which would read as
    // "not stale" and pin the widget in a permanently-live state.
    const future = entry({ lastUpdate: NOW + 10_000 })
    expect(staleMs(future, NOW)).toBe(10_000)
  })
})

// ---- isStale ----

describe('isStale', () => {
  it('is false for a fresh reading', () => {
    expect(isStale(aged(0), NOW)).toBe(false)
  })

  it('is false one millisecond below the threshold', () => {
    expect(isStale(aged(STALE_THRESHOLD_MS), NOW)).toBe(false)
  })

  it('is true exactly at the threshold', () => {
    // The comparison is strictly `>`, so equality is still fresh.
    expect(isStale(aged(STALE_THRESHOLD_MS + 1), NOW)).toBe(true)
  })

  it('is false for a never-updated tracker', () => {
    // Age 0 is "no data yet", which is disconnected but not stale. The two
    // states are distinguished so the "--" and the stale caption stay separate.
    expect(isStale(entry({ lastUpdate: 0 }), NOW)).toBe(false)
  })
})

// ---- isDisconnected ----

describe('isDisconnected', () => {
  it('is true when the tracker has never reported', () => {
    expect(isDisconnected(entry({ lastUpdate: 0 }), NOW)).toBe(true)
  })

  it('is false for a fresh reading', () => {
    expect(isDisconnected(aged(1_000), NOW)).toBe(false)
  })

  it('is true once the reading goes stale', () => {
    expect(isDisconnected(aged(STALE_THRESHOLD_MS + 1), NOW)).toBe(true)
  })

  it('holds for an implausibly old reading', () => {
    expect(isDisconnected(aged(24 * 60 * 60_000), NOW)).toBe(true)
  })
})

// ---- heartDisplay ----

describe('heartDisplay', () => {
  it('shows the reading when connected', () => {
    expect(heartDisplay(aged(1_000, 64), NOW)).toBe(64)
  })

  it('hides the reading when never updated', () => {
    expect(heartDisplay(entry({ lastUpdate: 0, lastHeartrate: 64 }), NOW)).toBe(NO_READING)
  })

  it('hides the reading once stale', () => {
    expect(heartDisplay(aged(STALE_THRESHOLD_MS + 1, 64), NOW)).toBe(NO_READING)
  })

  it('shows a legitimate zero reading rather than dashes', () => {
    // A real 0 bpm must not be confused with "no data" — otherwise a resting
    // tracker looks broken.
    expect(heartDisplay(aged(1_000, 0), NOW)).toBe(0)
  })

  it('renders a high reading unchanged', () => {
    expect(heartDisplay(aged(1_000, 212), NOW)).toBe(212)
  })
})

// ---- staleText ----

describe('staleText', () => {
  it('renders seconds for a fresh reading', () => {
    expect(staleText(aged(0), NOW)).toBe('0s ago')
  })

  it('rounds down partial seconds', () => {
    expect(staleText(aged(9_999), NOW)).toBe('9s ago')
  })

  it('renders a multi-digit age', () => {
    expect(staleText(aged(125_000), NOW)).toBe('125s ago')
  })

  it('switches to the vague phrase past the cut-off', () => {
    expect(staleText(aged(VAGUE_AFTER_MS), NOW)).toBe('a while ago')
  })

  it('stays precise just below the cut-off', () => {
    expect(staleText(aged(VAGUE_AFTER_MS - 1_000), NOW)).toBe('299s ago')
  })

  it('renders zero for a never-updated tracker', () => {
    // Only shown when stale, so this branch is not user-visible — but it must
    // not produce NaN or a negative string.
    expect(staleText(entry({ lastUpdate: 0 }), NOW)).toBe('0s ago')
  })
})

// ---- threshold coherence ----

describe('thresholds', () => {
  it('places the stale threshold below the vague-text cut-off', () => {
    // If these ever invert, a widget would go vague before going stale and
    // the two captions would overlap confusingly.
    expect(STALE_THRESHOLD_MS).toBeLessThan(VAGUE_AFTER_MS)
  })

  it('matches the Rust watchdog cycle', () => {
    // Documented in trackerDisplay.ts: the renderer's 60s matches the Rust
    // second-stale-check reconnect so one blip doesn't blank every widget.
    expect(STALE_THRESHOLD_MS).toBe(60_000)
    expect(VAGUE_AFTER_MS).toBe(300_000)
  })
})
