import assert from 'node:assert/strict';
import {
  addNote, markRead, markAllRead, removeNote, unreadCount, parseNotes, ago,
  MAX_NOTES, type Note,
} from './notifyLog.ts';

/**
 * Run with:  npm run test:notifications
 *
 * No framework on purpose. This pins the list arithmetic and the tolerant
 * parse — the parse specifically, because Android Phase B writes this same
 * AsyncStorage key from Kotlin, so the reader has to survive a payload it did
 * not produce.
 */

const note = (id: string, read = false, at = 1_000): Note =>
  ({ id, title: `t-${id}`, body: `b-${id}`, at, read });

const ids = (list: Note[]) => list.map(n => n.id);

/* ── cap and ordering ─────────────────────────────────────────────────────── */

assert.deepEqual(
  ids(addNote([note('a'), note('b')], note('c'))),
  ['c', 'a', 'b'],
  'newest goes first — the drawer is read top-down',
);

const full = Array.from({ length: MAX_NOTES }, (_, i) => note(`n${i}`));
const overflowed = addNote(full, note('new'));
assert.equal(overflowed.length, MAX_NOTES, 'the cap holds');
assert.equal(overflowed[0].id, 'new', 'the new one survives');
assert.equal(
  overflowed.includes(full[MAX_NOTES - 1]), false,
  'the OLDEST is the one dropped, not the newest',
);

// Two saves of the same link are two real events; collapsing them would be a
// lie about what happened.
assert.equal(addNote([note('a')], note('a')).length, 2, 'no deduping');

/* ── read state ───────────────────────────────────────────────────────────── */

const mixed = [note('a'), note('b', true), note('c')];
assert.equal(unreadCount(mixed), 2);
assert.equal(unreadCount(markAllRead(mixed)), 0, 'mark all read clears the count');
assert.equal(unreadCount(markRead(mixed, 'a')), 1, 'mark one read clears exactly one');
assert.equal(
  unreadCount(markRead(mixed, 'nope')), 2,
  'an unknown id is a no-op, not a crash',
);
// Already-read rows keep their identity, so React does not re-render the whole list.
const allRead = [note('a', true)];
assert.equal(markAllRead(allRead)[0], allRead[0], 'no needless new objects');

/* ── delete ───────────────────────────────────────────────────────────────── */

assert.deepEqual(ids(removeNote(mixed, 'b')), ['a', 'c']);
assert.deepEqual(ids(removeNote(mixed, 'zzz')), ['a', 'b', 'c'], 'unknown id is a no-op');

/* ── tolerant parse (Kotlin writes this key too) ──────────────────────────── */

assert.deepEqual(parseNotes(null), [], 'nothing stored');
assert.deepEqual(parseNotes('not json'), [], 'garbage degrades to empty, never throws');
assert.deepEqual(parseNotes('{"a":1}'), [], 'a non-array degrades to empty');

const salvaged = parseNotes(JSON.stringify([
  { id: 'ok', title: 'T', body: 'B', at: 5, read: true },
  { id: 'no-at', title: 'T', body: 'B' },          // unusable — no timestamp
  { title: 'no id', at: 6 },                        // unusable — no id
  null,
  { id: 'sparse', at: '7' },                        // numeric string, no title/body
]));
assert.deepEqual(
  ids(salvaged), ['ok', 'sparse'],
  'one bad row must not discard the good rows beside it',
);
assert.deepEqual(
  salvaged[1], { id: 'sparse', title: '', body: '', at: 7, read: false },
  'missing fields fill in rather than reject the row',
);
assert.equal(
  parseNotes(JSON.stringify(Array.from({ length: 40 }, (_, i) => note(`x${i}`)))).length,
  MAX_NOTES,
  'a foreign writer that ignored the cap is trimmed on read',
);

/* ── reelId: the row is a door, when there is somewhere to go ─────────────── */

// Present and a string — the drawer row opens that save.
assert.equal(
  parseNotes(JSON.stringify([{ id: 'a', at: 1, reelId: 'r-1' }]))[0].reelId,
  'r-1',
);
// ⚠️ The three normal ways it is ABSENT, all of which must render a plain row
// rather than a link to nothing: a receipt written before the field existed, a
// FAILED save (no reel to point at), and a payload from Kotlin that did not
// bother. The key must be MISSING, not `undefined` — `deepEqual` is strict
// about own properties, which is what pins it.
assert.deepEqual(
  parseNotes(JSON.stringify([{ id: 'a', at: 1 }]))[0],
  { id: 'a', title: '', body: '', at: 1, read: false },
  'no reelId means no key at all',
);
assert.deepEqual(
  parseNotes(JSON.stringify([{ id: 'a', at: 1, reelId: 42 }]))[0],
  { id: 'a', title: '', body: '', at: 1, read: false },
  'a non-string reelId is dropped, not carried through',
);
assert.deepEqual(
  parseNotes(JSON.stringify([{ id: 'a', at: 1, reelId: '' }]))[0],
  { id: 'a', title: '', body: '', at: 1, read: false },
  'an empty reelId is the same as none',
);

/* ── relative time ────────────────────────────────────────────────────────── */

const T = 1_000_000_000_000;
assert.equal(ago(T, T), 'Just now');
assert.equal(ago(T - 59_000, T), 'Just now', 'under a minute stays "Just now"');
assert.equal(ago(T - 60_000, T), '1m ago');
assert.equal(ago(T - 3_600_000, T), '1h ago');
assert.equal(ago(T - 86_400_000, T), 'Yesterday');
assert.equal(ago(T - 3 * 86_400_000, T), '3d ago');
// Clock skew (device time moved backwards) must not print "-2m ago".
assert.equal(ago(T + 120_000, T), 'Just now', 'a future timestamp clamps');

console.log('notifyLog: all assertions passed');
