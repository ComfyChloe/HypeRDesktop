// ==== HeartWidget.spec.ts — component-level rendering of a tracker cell.
//
// The pure rules are covered in `trackerDisplay.spec.ts`. This file checks
// that the component actually wires those rules to the markup and to the
// remove interaction — the layer where a correct helper can still be
// presented wrongly (e.g. bound to the wrong class, or the caption never
// un-hiding).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import HeartWidget from '../src/components/HeartWidget.vue'
import type { TrackerEntry } from '../src/lib/trackerDisplay'

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

function mountWidget(tracker: TrackerEntry, shiftHeld = false) {
  return mount(HeartWidget, {
    props: { id: 'K7f', tracker, opacityClass: 'opacity-8', shiftHeld },
  })
}

// The component keeps a 1s interval to re-evaluate staleness against the
// wall clock. Pinning Date.now keeps the rendered output deterministic, and
// the fake timers keep that interval from outliving the test.
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('rendering a live reading', () => {
  it('shows the heart rate', () => {
    const w = mountWidget(entry())
    expect(w.get('.heart_rate').text()).toBe('72')
  })

  it('shows the tracker name', () => {
    const w = mountWidget(entry({ name: 'Kiri' }))
    expect(w.get('.identicator').text()).toBe('Kiri')
  })

  it('is not marked disconnected', () => {
    const w = mountWidget(entry())
    expect(w.get('.heart-rate').classes()).not.toContain('disconnected')
  })

  it('hides the stale caption while fresh', () => {
    const w = mountWidget(entry())
    expect(w.get('.last_update').classes()).toContain('hidden')
  })

  it('applies the opacity class to the background', () => {
    const w = mountWidget(entry())
    expect(w.get('.background').classes()).toContain('opacity-8')
  })
})

describe('rendering a never-updated tracker', () => {
  it('shows dashes instead of a reading', () => {
    const w = mountWidget(entry({ lastUpdate: 0, lastHeartrate: 72 }))
    expect(w.get('.heart_rate').text()).toBe('--')
  })

  it('is marked disconnected', () => {
    const w = mountWidget(entry({ lastUpdate: 0 }))
    expect(w.get('.heart-rate').classes()).toContain('disconnected')
  })

  it('still shows the name so the user knows which tracker is down', () => {
    const w = mountWidget(entry({ lastUpdate: 0, name: 'Kiri' }))
    expect(w.get('.identicator').text()).toBe('Kiri')
  })
})

describe('staleness over time', () => {
  // The widget derives staleness from `Date.now()`, so these mount against a
  // pinned clock with an already-aged tracker. That exercises the same rules
  // as trackerDisplay.spec.ts without depending on the ticking interval,
  // which is covered separately below.
  it('shows dashes for a reading older than the threshold', () => {
    const w = mountWidget(entry({ lastUpdate: NOW - 61_000 }))
    expect(w.get('.heart_rate').text()).toBe('--')
    expect(w.get('.heart-rate').classes()).toContain('disconnected')
  })

  it('reveals the stale caption once past the threshold', () => {
    const w = mountWidget(entry({ lastUpdate: NOW - 61_000 }))
    expect(w.get('.last_update').classes()).not.toContain('hidden')
    expect(w.get('.last_update').text()).toBe('61s ago')
  })

  it('keeps the caption hidden just inside the threshold', () => {
    const w = mountWidget(entry({ lastUpdate: NOW - 59_000 }))
    expect(w.get('.last_update').classes()).toContain('hidden')
    expect(w.get('.heart_rate').text()).toBe('72')
  })

  it('switches to the vague caption past five minutes', () => {
    const w = mountWidget(entry({ lastUpdate: NOW - 6 * 60_000 }))
    expect(w.get('.last_update').text()).toBe('a while ago')
  })

  it('recovers when a fresh reading arrives', async () => {
    const w = mountWidget(entry({ lastUpdate: NOW - 61_000 }))
    expect(w.get('.heart_rate').text()).toBe('--')

    await w.setProps({ tracker: entry({ lastHeartrate: 80, lastUpdate: NOW }) })
    expect(w.get('.heart_rate').text()).toBe('80')
    expect(w.get('.heart-rate').classes()).not.toContain('disconnected')
    expect(w.get('.last_update').classes()).toContain('hidden')
  })
})

describe('the ticking clock', () => {
  // Rust emits a snapshot on data change only, so without a local timer a
  // widget whose socket has gone quiet would keep claiming to be live
  // forever. Advancing the fake clock is what proves the timer re-evaluates
  // staleness on its own.
  it('goes stale as the clock advances without new data', async () => {
    const w = mountWidget(entry())
    expect(w.get('.heart_rate').text()).toBe('72')

    vi.advanceTimersByTime(61_000)
    await nextTick()

    expect(w.get('.heart_rate').text()).toBe('--')
    expect(w.get('.last_update').classes()).not.toContain('hidden')
  })

  it('keeps a never-updated tracker showing dashes', async () => {
    const w = mountWidget(entry({ lastUpdate: 0 }))
    vi.advanceTimersByTime(5_000)
    await nextTick()
    expect(w.get('.heart_rate').text()).toBe('--')
  })
})

describe('remove button', () => {
  it('is hidden unless shift is held', () => {
    const w = mountWidget(entry(), false)
    expect(w.get('.remove-btn').classes()).not.toContain('visible')
  })

  it('is revealed while shift is held', () => {
    const w = mountWidget(entry(), true)
    expect(w.get('.remove-btn').classes()).toContain('visible')
  })

  it('emits remove with the tracker id when clicked', async () => {
    const w = mountWidget(entry(), true)
    await w.get('.remove-btn').trigger('click')
    expect(w.emitted('remove')).toEqual([['K7f']])
  })

  it('does not emit when shift is not held', async () => {
    // The button is hidden but still in the DOM; a click must not slip
    // through to an accidental deletion.
    const w = mountWidget(entry(), false)
    await w.get('.remove-btn').trigger('click')
    expect(w.emitted('remove')).toBeUndefined()
  })
})

describe('lifecycle', () => {
  it('clears its interval on unmount', () => {
    // Without this the widget keeps a timer alive after teardown, which in
    // the real app accumulates one per tracker as they are added/removed.
    const w = mountWidget(entry())
    w.unmount()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps exactly one interval while mounted', () => {
    const w = mountWidget(entry())
    expect(vi.getTimerCount()).toBe(1)
    w.unmount()
  })
})
