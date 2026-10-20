import assert from 'node:assert/strict';
import { addNote, markRead, markAllRead, removeNote, unreadCount, parseNotes, ago, orderReceipts, MAX_NOTES, type Note, reelRoute } from './notifyLog.ts';

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

// ── orderReceipts: the iOS Share Extension's queue ──────────────────────────
// ⚠️ OLDEST FIRST. The drawer renders newest-first and addNote prepends, so
// arrival order would put a batch of shares in upside down.
assert.deepEqual(
  orderReceipts([
    { title: 'Saving from Threads', body: 'c', at: 300 },
    { title: 'Saving from Instagram', body: 'a', at: 100 },
    { title: 'Saving from YouTube', body: 'b', at: 200 },
  ]).map(r => r.at),
  [100, 200, 300],
);

// Written by another PROCESS, so it is validated rather than trusted: a receipt
// from a future version of the Swift must not take the drawer down with it.
assert.deepEqual(orderReceipts([{ body: 'no title', at: 1 }]), []);
assert.deepEqual(orderReceipts([null, undefined, 4, 'x']), []);
assert.deepEqual(orderReceipts(null), []);
assert.deepEqual(orderReceipts('[]'), []);

// A missing body or timestamp is survivable; `at: 0` is what tells
// drainShareReceipts to fall back to "now".
const partial = orderReceipts([{ title: 'Saving from the web' }]);
assert.equal(partial.length, 1);
assert.equal(partial[0].body, '');
assert.equal(partial[0].at, 0);

// ── reelRoute: which receipts are openable ──────────────────────────────────
// A uuid4 id is the ONLY thing that opens a reel. Everything else must leave
// the row inert rather than navigate to a dead screen.
const UUID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
assert.equal(reelRoute(UUID), `/reel/${UUID}`);
assert.equal(reelRoute(UUID.toUpperCase()), `/reel/${UUID.toUpperCase()}`);

// Absent, because failures and both native share paths write no id.
assert.equal(reelRoute(undefined), null);
assert.equal(reelRoute(null), null);

// ⚠️ The shapes that would otherwise navigate somewhere dead. The empty
// string and the literal 'undefined' are what a JSON round-trip through the
// Android share Activity or the iOS App Group can actually produce.
assert.equal(reelRoute(''), null);
assert.equal(reelRoute('undefined'), null);
assert.equal(reelRoute('null'), null);

// Not a uuid4: wrong version nibble, wrong variant, truncated, padded.
assert.equal(reelRoute('3f2504e0-4f89-11d3-9a0c-0305e82c3301'), null);
assert.equal(reelRoute('3f2504e0-4f89-41d3-1a0c-0305e82c3301'), null);
assert.equal(reelRoute('3f2504e0-4f89-41d3-9a0c-0305e82c33'), null);
assert.equal(reelRoute(`${UUID}0`), null);
assert.equal(reelRoute(` ${UUID}`), null);

// Non-strings reach this from storage another process wrote.
assert.equal(reelRoute(42 as any), null);
assert.equal(reelRoute({} as any), null);

// addNote keeps reelId, and leaves rows that never had one alone.
const withId = addNote([], { id: 'a', title: 't', body: 'b', at: 1, read: false, reelId: UUID });
assert.equal(withId[0].reelId, UUID);
const withoutId = addNote([], { id: 'a', title: 't', body: 'b', at: 1, read: false });
assert.equal(withoutId[0].reelId, undefined);

// Marking read must not drop the id - the row stays openable afterwards.
assert.equal(markRead(withId, 'a')[0].reelId, UUID);
assert.equal(markAllRead(withId)[0].reelId, UUID);

console.log('notifyLog: all assertions passed');
