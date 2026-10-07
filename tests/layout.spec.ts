// ==== layout.spec.ts — overlay strip sizing rules.
//
// `stripWidth` is mirrored in `lib.rs` at startup (`tracker_count * 100`).
// If the two drift apart the window is sized correctly on launch and then
// jumps by a different amount the first time a tracker is added — a visible
// glitch that's easy to miss. These tests pin the JS side of that contract.
import { describe, it, expect } from 'vitest'
import { shouldResize, stripWidth, CELL_WIDTH, STRIP_HEIGHT } from '../src/lib/layout'

describe('stripWidth', () => {
  it('is one cell wide with no trackers', () => {
    // Not zero: the empty window still hosts the close button and the
    // add-tracker panel.
    expect(stripWidth(0)).toBe(CELL_WIDTH)
  })

  it('is one cell wide for a single tracker', () => {
    expect(stripWidth(1)).toBe(100)
  })

  it('scales linearly with the tracker count', () => {
    expect(stripWidth(2)).toBe(200)
    expect(stripWidth(5)).toBe(500)
  })

  it('holds for a large tracker list', () => {
    expect(stripWidth(20)).toBe(2000)
  })

  it('floors a negative count to one cell', () => {
    // Defensive: a malformed snapshot must not produce a negative width,
    // which the window manager would reject.
    expect(stripWidth(-3)).toBe(CELL_WIDTH)
  })

  it('matches the Rust startup formula', () => {
    // lib.rs: `(tracker_count * 100).max(100)`.
    for (const n of [0, 1, 3, 7]) {
      expect(stripWidth(n)).toBe(Math.max(n * 100, 100))
    }
  })
})

describe('shouldResize', () => {
  it('resizes when the tracker count changes', () => {
    expect(shouldResize(1, 2)).toBe(true)
  })

  it('does not resize on a same-count update', () => {
    // Heart-rate snapshots arrive several times a second; resizing on each
    // would hammer the window manager for no reason.
    expect(shouldResize(3, 3)).toBe(false)
  })

  it('resizes back down when a tracker is removed', () => {
    expect(shouldResize(2, 1)).toBe(true)
  })

  it('resizes on the first update from an unknown count', () => {
    expect(shouldResize(-1, 0)).toBe(true)
  })

  it('does not resize when repeatedly told the same count', () => {
    let last = -1
    const counts = [2, 2, 2, 2, 2]
    let resizes = 0
    for (const c of counts) {
      if (shouldResize(last, c)) resizes++
      last = c
    }
    expect(resizes).toBe(1)
  })
})

describe('strip constants', () => {
  it('keeps the fixed height used by both runtimes', () => {
    expect(STRIP_HEIGHT).toBe(100)
    expect(CELL_WIDTH).toBe(100)
  })
})
