// ==== layout.ts — window sizing rules for the overlay strip.
//
// The app is a transparent always-on-top strip: one fixed-width cell per
// tracker. Both `App.vue` (on snapshot updates) and `lib.rs` (at startup)
// size the window, so the rule lives here as a single pure function and is
// mirrored on the Rust side with a test on either end guarding the match.

/** Width of one tracker cell in logical pixels. Matches the CSS. */
export const CELL_WIDTH = 100

/** Height of the strip. Fixed — the overlay never scrolls. */
export const STRIP_HEIGHT = 100

/**
 * Strip width for a tracker count. Floored at one cell so an empty tracker
 * list still yields a usable window (it hosts the add-tracker panel and the
 * close button) rather than collapsing to zero.
 */
export function stripWidth(count: number): number {
  return Math.max(count * CELL_WIDTH, CELL_WIDTH)
}

/**
 * Whether a resize call is warranted. The WS emits a snapshot on every
 * heart-rate update — several per second — so resizing unconditionally would
 * hammer the window manager for no reason. Size only changes with count.
 */
export function shouldResize(lastCount: number, nextCount: number): boolean {
  return nextCount !== lastCount
}
