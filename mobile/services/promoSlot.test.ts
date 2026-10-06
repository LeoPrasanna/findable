import assert from 'node:assert/strict';
import { promoAt, readDismissed, PROMO_SNOOZE_MS } from './promoSlot.ts';

/**
 * Self-check for the promo slot's rules. No framework — plain node, the same way
 * every other check in mobile/ runs (see .github/workflows/mobile-ci.yml).
 *
 * ⚠️ The case worth having a test for at all is the PAYING USER. Everything else here
 * is arithmetic; showing a Pro subscriber an advert for Pro is the one failure that
 * costs money rather than taste.
 */

const NOW = 1_760_000_000_000;

// ── who sees it ──────────────────────────────────────────────────────────────
assert.equal(promoAt(50, 'free', null, NOW), 8, 'a free user with a full library sees it');
assert.equal(promoAt(50, 'pro', null, NOW), null, 'a paying user is never sold Pro');
assert.equal(promoAt(50, 'trial', null, NOW), null, 'trial already has the paid numbers');
// The usage cache starts null, and an unknown tier must not default to "free".
assert.equal(promoAt(50, null, null, NOW), null, 'unknown tier shows nothing');
assert.equal(promoAt(50, undefined, null, NOW), null, 'missing tier shows nothing');

// ── a small library is not a feed ────────────────────────────────────────────
assert.equal(promoAt(0, 'free', null, NOW), null, 'empty library');
assert.equal(promoAt(9, 'free', null, NOW), null, 'just under the threshold');
assert.equal(promoAt(10, 'free', null, NOW), 8, 'at the threshold');
// It must never be the last tile in the grid.
assert.ok((promoAt(10, 'free', null, NOW) as number) < 10 - 1, 'never the final tile');

// ── dismissal ────────────────────────────────────────────────────────────────
assert.equal(promoAt(50, 'free', NOW - 1000, NOW), null, 'just dismissed');
assert.equal(promoAt(50, 'free', NOW - PROMO_SNOOZE_MS + 1, NOW), null, 'inside the snooze');
assert.equal(promoAt(50, 'free', NOW - PROMO_SNOOZE_MS, NOW), 8, 'snooze expired');
assert.equal(promoAt(50, 'free', NOW - PROMO_SNOOZE_MS * 10, NOW), 8, 'long expired');

// ── stored value, which is user-writable in practice ─────────────────────────
assert.equal(readDismissed(null, NOW), null, 'nothing stored');
assert.equal(readDismissed('', NOW), null, 'empty string');
assert.equal(readDismissed('not a number', NOW), null, 'junk');
assert.equal(readDismissed('0', NOW), null, 'zero is not a timestamp');
assert.equal(readDismissed('-5', NOW), null, 'negative');
assert.equal(readDismissed(String(NOW - 500), NOW), NOW - 500, 'a real timestamp');
// A clock that moved backwards would otherwise strand the slot in the future forever.
assert.equal(readDismissed(String(NOW + 999_999), NOW), NOW, 'future is clamped to now');

console.log('promoSlot: ok');
