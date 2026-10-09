/** node --experimental-strip-types --no-warnings services/billingPlans.test.ts
 *
 * Invoked directly from .github/workflows/mobile-ci.yml, NOT as an npm script —
 * @expo/fingerprint hashes package.json's scripts block. See mobile/AGENTS.md.
 */
import assert from 'node:assert/strict';
import { billingKey, packageFor, storeTerms, type StorePackage } from './billingPlans.ts';

// ── Which key a build may use ────────────────────────────────────────────────
const KEYS = { testKey: 'test_abc', ios: 'appl_ios', android: 'goog_and' };

assert.equal(billingKey({ dev: false, platform: 'ios', ...KEYS }), 'appl_ios');
assert.equal(billingKey({ dev: false, platform: 'android', ...KEYS }), 'goog_and');

/**
 * ⚠️ THE ONE THAT MATTERS. A Test Store key in a release build does not degrade —
 * the SDK crashes on purpose, and it decides by how the app was COMPILED. A
 * release build must therefore never be handed the test key, whatever is set in
 * the environment.
 */
assert.equal(billingKey({ dev: false, platform: 'ios', ...KEYS }), 'appl_ios',
  'release ios must not take the test key');
assert.equal(billingKey({ dev: false, platform: 'android', ...KEYS }), 'goog_and',
  'release android must not take the test key');
// And in dev it IS the test key, which is the whole point of having one.
assert.equal(billingKey({ dev: true, platform: 'ios', ...KEYS }), 'test_abc');
assert.equal(billingKey({ dev: true, platform: 'android', ...KEYS }), 'test_abc');
// A dev build with no test key configured falls back to the real platform key.
assert.equal(billingKey({ dev: true, platform: 'ios', ios: 'appl_ios' }), 'appl_ios');

// No billing is a supported state, not an error — the paywall still has to render.
assert.equal(billingKey({ dev: false, platform: 'web', ...KEYS }), null, 'no IAP on web');
assert.equal(billingKey({ dev: true, platform: 'web', ...KEYS }), null, 'not even in dev');
assert.equal(billingKey({ dev: false, platform: 'ios' }), null, 'nothing configured');
assert.equal(billingKey({ dev: false, platform: 'ios', ios: '' }), null, 'empty is unset');
assert.equal(billingKey({ dev: false, platform: 'android', ios: 'appl_ios' }), null,
  "ios key must never be used on android");

// ── Matching a plan to a package ─────────────────────────────────────────────
const weekly: StorePackage = {
  identifier: '$rc_weekly', packageType: 'WEEKLY', product: { priceString: '₹25' },
};
const monthly: StorePackage = {
  identifier: '$rc_monthly', packageType: 'MONTHLY', product: { priceString: '₹120' },
};

assert.equal(packageFor([weekly, monthly], 'weekly'), weekly);
assert.equal(packageFor([weekly, monthly], 'monthly'), monthly);
assert.equal(packageFor([weekly], 'monthly'), null, 'a missing plan is null, not a throw');
assert.equal(packageFor([], 'weekly'), null, 'empty offering');

// Matched on packageType, so renaming a package in the dashboard cannot empty
// the paywall — this is the regression that rename would otherwise cause.
const renamed: StorePackage = { ...monthly, identifier: 'findable_pro_month' };
assert.equal(packageFor([renamed], 'monthly'), renamed, 'identifier is not the key');
assert.equal(packageFor([{ ...monthly, packageType: 'ANNUAL' }], 'monthly'), null,
  'an annual package is not the monthly plan');

// ── The sentence someone reads before agreeing to pay ────────────────────────
assert.equal(
  storeTerms(monthly, 'monthly'),
  'Auto-renews monthly at ₹120 until cancelled.',
);
assert.equal(
  storeTerms(weekly, 'weekly'),
  'Auto-renews weekly at ₹25 until cancelled.',
);

// An introductory offer must disclose intro price, duration AND revert price.
const intro: StorePackage = {
  identifier: '$rc_monthly', packageType: 'MONTHLY',
  product: {
    priceString: '₹120',
    introPrice: { priceString: '₹99', periodUnit: 'MONTH', periodNumberOfUnits: 1, cycles: 6 },
  },
};
assert.equal(
  storeTerms(intro, 'monthly'),
  'Auto-renews monthly at ₹99 for the first 6 months, then ₹120 until cancelled.',
);
// A single-cycle offer reads naturally, not "1 months".
const oneWeek: StorePackage = {
  identifier: '$rc_weekly', packageType: 'WEEKLY',
  product: {
    priceString: '₹25',
    introPrice: { priceString: '₹5', periodUnit: 'WEEK', periodNumberOfUnits: 1, cycles: 1 },
  },
};
assert.equal(
  storeTerms(oneWeek, 'weekly'),
  'Auto-renews weekly at ₹5 for the first 1 week, then ₹25 until cancelled.',
);
// periodNumberOfUnits multiplies: 2-month cycles × 3 = 6 months.
const sixViaCycles: StorePackage = {
  ...intro,
  product: { ...intro.product, introPrice: { priceString: '₹99', periodUnit: 'MONTH', periodNumberOfUnits: 2, cycles: 3 } },
};
assert.match(storeTerms(sixViaCycles, 'monthly')!, /first 6 months/);

/**
 * ⚠️ HALF A DISCLOSURE IS WORSE THAN NONE. An intro price whose duration we cannot
 * read must not produce a sentence — the caller falls back to the authored one
 * rather than implying the intro price lasts forever.
 */
for (const bad of [undefined, null, '', 'FORTNIGHT', 'month ']) {
  const broken: StorePackage = {
    ...intro,
    product: { ...intro.product, introPrice: { priceString: '₹99', periodUnit: bad as any, cycles: 6 } },
  };
  assert.equal(storeTerms(broken, 'monthly'), null, `unreadable period ${JSON.stringify(bad)}`);
}
// No price at all from the store means we say nothing about price.
assert.equal(storeTerms({ ...monthly, product: { priceString: '' } }, 'monthly'), null);

/**
 * ── IDENTITY ORDERING ────────────────────────────────────────────────────────
 * ⚠️ WHAT THIS PREVENTS IS TWO ACCOUNTS SHARING ONE SUBSCRIPTION. RevenueCat
 * aliases app user ids when a `logIn` lands before the preceding `logOut` has
 * finished, so on a shared device account A's purchase can end up attached to
 * account B. The sign-out and sign-in call sites are fire-and-forget by design —
 * the auth gate must not block on a billing SDK — so the ORDER has to be a
 * property of the queue rather than of which network call returns first.
 */
import { serialQueue } from './billingPlans.ts';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

{
  const log: string[] = [];
  const run = serialQueue();
  // Deliberately backwards: the FIRST task is the SLOW one. Unqueued, 'in' would
  // finish first and that is exactly the aliasing bug.
  const a = run(async () => { await sleep(40); log.push('out'); });
  const b = run(async () => { await sleep(1); log.push('in'); });
  await Promise.all([a, b]);
  assert.deepEqual(log, ['out', 'in'], 'logOut must complete before logIn starts');
}

{
  // A failed task must not wedge the queue behind it: a logOut that rejects
  // (LogOutWithAnonymousUserError) still has to let the next logIn through.
  const log: string[] = [];
  const run = serialQueue();
  const bad = run(async () => { await sleep(10); log.push('out'); throw new Error('anonymous'); });
  const good = run(async () => { log.push('in'); });
  await assert.rejects(() => bad, /anonymous/, 'the failure still reaches its own caller');
  await good;
  assert.deepEqual(log, ['out', 'in'], 'a rejection must not stall the queue');
}

{
  // Order holds across more than two, and each caller gets its own result.
  const log: number[] = [];
  const run = serialQueue();
  const all = [30, 20, 10, 0].map((ms, i) =>
    run(async () => { await sleep(ms); log.push(i); return i; }));
  assert.deepEqual(await Promise.all(all), [0, 1, 2, 3], 'results are per-caller');
  assert.deepEqual(log, [0, 1, 2, 3], 'strict submission order regardless of duration');
}

{
  // Tasks queued later, after the queue has drained, still run.
  const run = serialQueue();
  assert.equal(await run(async () => 'first'), 'first');
  assert.equal(await run(async () => 'second'), 'second');
}

/**
 * ── WHAT TO SAY AFTER A SYNC ───────────────────────────────────────────
 * ⚠️ THE ROW THAT MATTERS IS (false, false). That is "tapped Restore, owns
 * nothing", and the app used to answer "You're on Pro — everything is unlocked."
 * `/sync` returns 200 with `{tier: null, active: false}` for that case, and the
 * old code showed the success dialog on any 2xx without reading the body.
 */
import { syncVerdict } from './billingPlans.ts';

assert.equal(syncVerdict(false, false), 'none',
  'restore with no entitlement must NOT claim Pro');
assert.equal(syncVerdict(false, null), 'failed',
  'a failed sync after a restore must not mention a payment — none was made');

// Paid paths: the money is already gone, so "not yet" is never "it failed".
assert.equal(syncVerdict(true, false), 'pending', 'paid, server not caught up');
assert.equal(syncVerdict(true, null), 'pending', 'paid, sync threw — still reassure');

// Server says yes — the only verdict allowed to claim Pro, by either route.
assert.equal(syncVerdict(true, true), 'pro');
assert.equal(syncVerdict(false, true), 'pro', 'a genuine restore does claim Pro');

// Only the server grants. `paid` never promotes a negative answer to 'pro'.
for (const paid of [true, false]) {
  assert.notEqual(syncVerdict(paid, false), 'pro', `paid=${paid} must not self-grant`);
  assert.notEqual(syncVerdict(paid, null), 'pro', `paid=${paid} must not grant on failure`);
}

console.log('billingPlans: ok');
