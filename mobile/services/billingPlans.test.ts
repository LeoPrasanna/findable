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

console.log('billingPlans: ok');
