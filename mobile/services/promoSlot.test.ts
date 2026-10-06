import assert from 'node:assert/strict';
import { promoSlots, promoCards, readDismissed, PROMO_SNOOZE_MS } from './promoSlot.ts';

/**
 * Self-check for the promo slot's rules. No framework — plain node, the same way
 * every other check in mobile/ runs (see .github/workflows/mobile-ci.yml).
 *
 * ⚠️ The case worth having a test for at all is the PAYING USER. Everything else here
 * is arithmetic; showing a Pro subscriber an advert for Pro is the one failure that
 * costs money rather than taste.
 */

const NOW = 1_760_000_000_000;
// ⚠️ PRO'S NUMBERS ARE ARGUMENTS NOW, NOT CONSTANTS. The module used to hardcode
// 500/20 with a comment admitting nothing enforced they matched render.yaml.
const PRO = { proSaveLimit: 500, proAiLimit: 20 };
const FREE = { saveLimit: 50, aiPerDay: 3, canAsk: false, ...PRO };

// ── who sees them ────────────────────────────────────────────────────────────
assert.deepEqual(promoSlots(30, 'free', null, NOW, 3), [8, 18, 28], 'free user, 30 saves');
assert.deepEqual(promoSlots(30, 'pro', null, NOW, 3), [], 'a paying user is never sold Pro');
assert.deepEqual(promoSlots(30, 'trial', null, NOW, 3), [], 'trial already has the paid numbers');
// The usage cache starts null, and an unknown tier must not default to "free".
assert.deepEqual(promoSlots(30, null, null, NOW, 3), [], 'unknown tier shows nothing');
assert.deepEqual(promoSlots(30, undefined, null, NOW, 3), [], 'missing tier shows nothing');
// Nothing to show means no empty slots.
assert.deepEqual(promoSlots(30, 'free', null, NOW, 0), [], 'no creatives, no slots');

// ── a small library is not a feed ────────────────────────────────────────────
assert.deepEqual(promoSlots(0, 'free', null, NOW, 3), [], 'empty library');
assert.deepEqual(promoSlots(9, 'free', null, NOW, 3), [], 'just under the threshold');
assert.deepEqual(promoSlots(10, 'free', null, NOW, 3), [8], 'at the threshold, one slot');

// ── never the final tile ─────────────────────────────────────────────────────
for (const total of [10, 11, 18, 19, 20, 29, 30, 31, 100]) {
  const slots = promoSlots(total, 'free', null, NOW, 3);
  for (const s of slots) {
    assert.ok(s < total - 1, `slot ${s} must not be last of ${total}`);
  }
}

// ── density and the cap ──────────────────────────────────────────────────────
assert.deepEqual(promoSlots(20, 'free', null, NOW, 3), [8, 18], 'one every ten');
// ⚠️ The cap is a house-ad artefact — three creatives cannot fill fifty slots.
assert.equal(promoSlots(500, 'free', null, NOW, 3).length, 6, 'capped');
assert.deepEqual(promoSlots(500, 'free', null, NOW, 3), [8, 18, 28, 38, 48, 58], 'capped from the top');

// ── dismissal hides ALL of them, not one ─────────────────────────────────────
assert.deepEqual(promoSlots(30, 'free', NOW - 1000, NOW, 3), [], 'just dismissed');
assert.deepEqual(promoSlots(30, 'free', NOW - PROMO_SNOOZE_MS + 1, NOW, 3), [], 'inside the snooze');
assert.deepEqual(promoSlots(30, 'free', NOW - PROMO_SNOOZE_MS, NOW, 3), [8, 18, 28], 'snooze expired');

// ── the creatives are built from the user's OWN live limits ──────────────────
const cards = promoCards(FREE);
assert.equal(cards.length, 3, 'a post-trial free user has three true pitches');
assert.deepEqual(cards.map(c => c.key), ['saves', 'ai', 'ask'], 'stable keys and order');
assert.ok(cards[0].headline.includes('500') && cards[0].headline.includes('50'), 'names both numbers');
assert.ok(cards[0].sub.includes('450'), 'the difference is computed, not written down');
assert.ok(cards[1].headline.includes('20') && cards[1].headline.includes('3'), 'AI pitch is live');

// A premise that is not true for this user is omitted, never softened.
assert.deepEqual(
  promoCards({ saveLimit: 50, aiPerDay: 3, canAsk: true, ...PRO }).map(c => c.key),
  ['saves', 'ai'],
  'a user who still has Ask is not told Ask is Pro-only',
);
assert.deepEqual(
  promoCards({ saveLimit: 500, aiPerDay: 20, canAsk: true, ...PRO }).map(c => c.key),
  [],
  'nothing to offer someone already at the Pro numbers',
);
// A missing /usage payload must not produce "undefined saves instead of null".
assert.deepEqual(promoCards({}).map(c => c.key), [], 'no live limits, no claims');
assert.deepEqual(
  promoCards({ saveLimit: null, aiPerDay: null, ...PRO }).map(c => c.key),
  [],
  'unlimited saves (null) is not something to upsell',
);
// ⚠️ AND WITHOUT PRO'S NUMBERS, NO CLAIM IS MADE AT ALL. Falling back to a
// hardcoded 500 is exactly the false advertisement this signature removed.
assert.deepEqual(
  promoCards({ saveLimit: 50, aiPerDay: 3, canAsk: false }).map(c => c.key),
  ['ask'],
  'no Pro numbers means no numeric comparison, only the one card that needs none',
);
// The card quotes the SERVER's number, whatever it is.
assert.ok(
  promoCards({ saveLimit: 50, proSaveLimit: 300 })[0].headline.includes('300'),
  'quotes what the server granted, not 500',
);

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
