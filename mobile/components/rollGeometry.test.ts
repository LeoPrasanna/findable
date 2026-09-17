import assert from 'node:assert/strict';
import { rollTravel, MAX_TRAVEL } from './rollGeometry.ts';

/**
 * Run with:  npm run test:roll
 *
 * No framework, same as todoMerge.test.ts. This pins the one rule that the
 * "Slate lines are cut off" bug kept violating: a rolling line may never
 * travel further than the slack around it, because the viewport clips.
 *
 * Both previous attempts at this bug edited the QUOTES. That only ever worked
 * by accident — it made some of them fit on one line, where there happened to
 * be enough slack. These cases are written in the real numbers the app uses so
 * a future viewport or lineHeight change fails here instead of on a phone.
 */

/* ── the bug, in the exact numbers that produced it ──────────────────────── */

// The Slate quote roller as it shipped: 42px viewport, two 18px lines.
// 36px of text in a 42px window is 3px of slack, and it was translating 22px.
assert.equal(
  rollTravel(42, 18, 2),
  3,
  'the old Slate geometry has only 3px of slack — 22px of travel sliced the text',
);

// The same roller after widening the viewport to 60. This is the fix.
assert.equal(
  rollTravel(60, 18, 2),
  12,
  'a 60px viewport gives two 18px lines a real 12px roll',
);

// The Slate quote roller TODAY (owner, 2026-09-17: "the box is taking a lot of
// space"). It dropped to one line and had to shed the 60px viewport with it —
// `compact` is a FIXED 60, so numberOfLines={1} alone would have cost the line
// and saved nothing. 34 is the smallest height that still leaves a real roll.
assert.equal(
  rollTravel(34, 18, 1),
  8,
  'the shrunk Slate quote still rolls 8px — below this it degrades to a crossfade',
);

/* ── the shapes that were always fine, and must stay fine ────────────────── */

// One line in the compact roller: 21px of slack, so a near-full roll and
// nowhere near the ceiling. (Written as 22 first — the slack is (60-18)/2 = 21,
// which is exactly the sort of off-by-one this file exists to catch.)
assert.equal(
  rollTravel(60, 18, 1),
  21,
  'a single compact line has slack to spare and rolls almost the full distance',
);

// The library capability roll: 42px viewport, ONE 18px line. Never clipped,
// and it must keep its 42px footprint (it replaced the search field).
assert.equal(
  rollTravel(42, 18, 1),
  12,
  'the library roll is one line in 42px and rolls without clipping',
);

/* ── degenerate cases must not produce a clipping roll ───────────────────── */

// Text exactly fills the viewport: nothing may move.
assert.equal(rollTravel(36, 18, 2), 0, 'no slack means no travel — a crossfade, not a slice');

// Text OVERFLOWS the viewport. Travel must clamp to 0, never go negative
// (a negative would invert the roll's direction, which is worse than static).
assert.equal(rollTravel(30, 18, 2), 0, 'overflowing text still yields zero travel, never negative');

// Enormous viewport: capped, so the roll never becomes a slide.
assert.equal(rollTravel(400, 18, 1), MAX_TRAVEL, 'travel is capped at the design ceiling');

console.log('rollGeometry: all assertions passed');
