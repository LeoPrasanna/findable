/** node --experimental-strip-types --no-warnings services/saveQuota.test.ts
 *
 * Invoked directly from .github/workflows/mobile-ci.yml, NOT as an npm script —
 * @expo/fingerprint hashes package.json's scripts block. See mobile/AGENTS.md.
 */
import assert from 'node:assert/strict';
import { saveQuota } from './saveQuota.ts';

// ── The real caps: 50 free, 500 trial/pro ────────────────────────────────────
// FREE
assert.equal(saveQuota(44, 50).level, 'ok');
assert.equal(saveQuota(45, 50).level, 'warn');        // 90%
assert.equal(saveQuota(47, 50).level, 'warn');
assert.equal(saveQuota(48, 50).level, 'critical');    // 95% of 50 is 47.5
assert.equal(saveQuota(50, 50).level, 'full');
assert.equal(saveQuota(71, 50).level, 'full');        // grandfathered over the cap

// PRO
assert.equal(saveQuota(449, 500).level, 'ok');
assert.equal(saveQuota(450, 500).level, 'warn');
assert.equal(saveQuota(475, 500).level, 'critical');
assert.equal(saveQuota(500, 500).level, 'full');

// ⚠️ The ratios are the reason both of the above work from one implementation.
// The thresholds were written for a 1000 cap that lasted about an hour; these
// assert they still land correctly at 1000 and at a small arbitrary limit, so a
// future change to SAVE_LIMIT cannot strand them.
assert.equal(saveQuota(900, 1000).level, 'warn');
assert.equal(saveQuota(950, 1000).level, 'critical');
assert.equal(saveQuota(180, 200).level, 'warn');
assert.equal(saveQuota(190, 200).level, 'critical');
assert.equal(saveQuota(100, 200).level, 'ok');

// Remaining is what the critical message promises.
assert.equal(saveQuota(48, 50).remaining, 2);
assert.match(saveQuota(48, 50).message, /2 more/);
assert.equal(saveQuota(50, 50).remaining, 0);

// This band is one line on the library screen; Pro is mentioned in the
// once-per-session alert and in the server's own 403, not here.
for (const [u, l] of [[45, 50], [48, 50], [50, 50], [475, 500]] as const) {
  assert.doesNotMatch(saveQuota(u, l).message, /pro|upgrade|subscri/i, `upsell leaked at ${u}/${l}`);
}

// Unknowns must stay quiet rather than render a scary zero-based ratio.
assert.equal(saveQuota(null, 50).level, 'ok');
assert.equal(saveQuota(500, null).level, 'ok');
assert.equal(saveQuota(undefined, undefined).level, 'ok');
assert.equal(saveQuota(5, 0).level, 'ok');
assert.equal(saveQuota(0, 50).message, '');

/**
 * A library ABOVE its cap, which is what the end of a trial produces.
 *
 * The trial allows 500 and free allows 50, so ten enthusiastic days can leave someone
 * 150 over the line on day eleven. Every message here used to say "delete a few",
 * which was wrong by 150 and looped: delete one, retry, identical message.
 */
assert.equal(saveQuota(200, 50).level, 'full', 'over the cap is still full');
assert.equal(saveQuota(200, 50).remaining, 0, 'never negative');
// +1 because room is needed for the NEXT save, not merely to reach the cap.
assert.equal(saveQuota(200, 50).toDelete, 151, 'counts the overage plus one');
assert.equal(saveQuota(50, 50).toDelete, 1, 'exactly full needs one gone');
assert.equal(saveQuota(49, 50).toDelete, 0, 'under the cap needs nothing');
assert.equal(saveQuota(0, 50).toDelete, 0);
assert.equal(saveQuota(null, 50).toDelete, 0, 'unknown is not an overage');

// "200/50" reads as a rendering bug, so the over-cap line is a sentence instead.
assert.doesNotMatch(saveQuota(200, 50).message, /200\/50/, 'no x/y when over');
assert.match(saveQuota(200, 50).message, /151/, 'says how many must go');
// Exactly-full keeps its original wording, which was never wrong.
assert.match(saveQuota(50, 50).message, /50\/50/);

// The no-upsell rule still holds in the new branch.
assert.doesNotMatch(saveQuota(200, 50).message, /pro|upgrade|subscri/i, 'upsell leaked when over');

/**
 * The trial overflow warning. The cap a trial user is measured against today is not
 * the one they will be measured against next week, and nothing used to say so.
 */
import { trialOverflow } from './saveQuota.ts';

const T = { tier: 'trial', freeLimit: 50, proLimit: 500 };
assert.equal(trialOverflow({ ...T, used: 70 })!.over, 20, 'counts how far past free');
assert.match(trialOverflow({ ...T, used: 70 })!.message, /70 saves/);
assert.match(trialOverflow({ ...T, used: 70 })!.message, /20 past/);
assert.match(trialOverflow({ ...T, used: 70 })!.body, /Pro holds 500/);

// Only during the trial, and only once actually past the free limit.
assert.equal(trialOverflow({ ...T, used: 50 }), null, 'at the free limit is not past it');
assert.equal(trialOverflow({ ...T, used: 10 }), null, 'well under');
assert.equal(trialOverflow({ ...T, tier: 'free', used: 70 }), null, 'free already lives it');
assert.equal(trialOverflow({ ...T, tier: 'pro', used: 70 }), null, 'pro is not warned');
// The usage cache starts null; an unknown tier must not warn.
assert.equal(trialOverflow({ ...T, tier: null, used: 70 }), null, 'unknown tier');
assert.equal(trialOverflow({ ...T, used: null }), null, 'unknown count');
assert.equal(trialOverflow({ tier: 'trial', used: 70, freeLimit: null }), null, 'unknown free cap');
assert.equal(trialOverflow({ tier: 'trial', used: 70, freeLimit: 0 }), null, 'nonsense free cap');

// Pro's number is the server's or it goes unsaid — never guessed.
assert.doesNotMatch(trialOverflow({ tier: 'trial', used: 70, freeLimit: 50 })!.body, /Pro holds/);

/**
 * ⚠️ IT MUST NOT THREATEN DELETION. Saves are never deleted — the cap gates new
 * saves only. The owner drafted copy saying older saves would be lost; that is not
 * what the app does, and shipping it would be a lie that costs a one-star review the
 * moment someone finds their reels still there.
 */
assert.doesNotMatch(
  trialOverflow({ ...T, used: 70 })!.body,
  /you will lose|you'll lose|older saves|be removed|will be deleted|are deleted/i,
  'the warning must not promise a deletion the app does not do',
);
assert.match(trialOverflow({ ...T, used: 70 })!.body, /Nothing is deleted/,
  'and it says so outright, because that is the question a warning like this raises');

console.log('saveQuota: ok');
