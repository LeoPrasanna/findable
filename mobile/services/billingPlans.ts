/**
 * The decisions a purchase flow has to get right, as pure functions.
 *
 * No imports — so `node --experimental-strip-types` can check it
 * (billingPlans.test.ts), and so the two things most likely to be WRONG IN A WAY
 * THAT COSTS MONEY are not buried inside a screen:
 *
 *   1. which RevenueCat API key a build is allowed to use, and
 *   2. what price sentence the user is shown before they agree to pay.
 *
 * `services/billing.ts` does the SDK talking; this file decides.
 */

/** The two plans the paywall offers. Mirrors `Plan['id']` in constants/pricing.ts. */
export type PlanId = 'weekly' | 'monthly';

/**
 * Enough of RevenueCat's `PurchasesPackage` to choose and describe one. Declared
 * structurally rather than imported so this module stays dependency-free — and so
 * an SDK upgrade that reshapes these fields fails the test rather than the store.
 */
export interface StorePackage {
  identifier: string;
  packageType: string;
  product: {
    priceString: string;
    introPrice?: {
      priceString: string;
      periodUnit?: string;        // 'DAY' | 'WEEK' | 'MONTH' | 'YEAR'
      periodNumberOfUnits?: number;
      cycles?: number;
    } | null;
  };
}

/**
 * Which API key this build may configure the SDK with, or null for "no billing".
 *
 * ⚠️ THE TEST KEY IS GATED ON `__DEV__` AND NOTHING ELSE, AND THAT IS A SAFETY
 * PROPERTY, NOT A PREFERENCE. RevenueCat's SDK does not degrade when it finds a
 * Test Store key in a release build — it logs, alerts and then **crashes on
 * purpose**, and it decides by how the app was COMPILED, not how it was
 * distributed. TestFlight and every Play testing track are release builds. So if
 * the test key were selected by the presence of an env var, one mis-set value in
 * an EAS environment would ship a binary that dies on launch. `__DEV__` is
 * compile-time, so that mistake is unrepresentable.
 *
 * The consequence, stated plainly: the Test Store is reachable only from a
 * development build, never from the preview APK or TestFlight. RevenueCat offers
 * `forceAllowTestStoreInReleaseBuilds` to undo this; it is deliberately not used
 * here, because the preview APK is an artifact we hand to other people.
 *
 * ⚠️ RETURNING null IS A SUPPORTED STATE, not an error. Web has no IAP, and a
 * build with no keys configured must still render the paywall — read-only, saying
 * where to subscribe instead. A paywall that crashes is worse than one that
 * cannot sell.
 */
export function billingKey(opts: {
  dev: boolean;
  platform: string;
  testKey?: string | null;
  ios?: string | null;
  android?: string | null;
}): string | null {
  if (opts.platform !== 'ios' && opts.platform !== 'android') return null;
  if (opts.dev && opts.testKey) return opts.testKey;
  const key = opts.platform === 'ios' ? opts.ios : opts.android;
  return key || null;
}

/**
 * The package for a plan, matched on `packageType` rather than identifier.
 *
 * ⚠️ NOT BY IDENTIFIER. RevenueCat's defaults are `$rc_weekly` / `$rc_monthly`,
 * but an offering can name its packages anything, and a dashboard rename would
 * silently empty the paywall. `packageType` is the SDK's own normalised value and
 * survives renaming.
 */
export function packageFor(packages: StorePackage[], plan: PlanId): StorePackage | null {
  const want = plan === 'weekly' ? 'WEEKLY' : 'MONTHLY';
  return packages.find(p => p.packageType === want) ?? null;
}

/** "6 months", "1 week" — the length of an intro offer, pluralised. */
function periodText(unit: string | undefined, n: number | undefined, cycles: number | undefined): string | null {
  const word = String(unit || '').toLowerCase();
  if (!['day', 'week', 'month', 'year'].includes(word)) return null;
  const total = Math.max(1, (n || 1)) * Math.max(1, (cycles || 1));
  return `${total} ${word}${total === 1 ? '' : 's'}`;
}

/**
 * The renewal sentence, built from what the STORE says this costs.
 *
 * ⚠️ THE STORE'S PRICE IS THE ONLY TRUE ONE, and this is why the paywall cannot
 * keep showing the numbers in constants/pricing.ts once offerings load. Those are
 * hardcoded and chosen by DEVICE LOCALE; Apple and Google charge by the account's
 * STOREFRONT. Someone with an Indian phone and a US App Store account is shown ₹99
 * and billed $7 — a refund request, and a review rejection for good measure.
 *
 * ⚠️ AND APPLE REQUIRES THE WHOLE TRUTH TOGETHER. Under an introductory offer the
 * intro price, its duration AND the standard price must all be disclosed on the
 * purchase screen. Returns null when the store has not said enough to write a
 * complete sentence — the caller then falls back to the authored one rather than
 * inventing a term.
 */
export function storeTerms(pkg: StorePackage, plan: PlanId): string | null {
  const cadence = plan === 'weekly' ? 'weekly' : 'monthly';
  const standard = pkg.product?.priceString;
  if (!standard) return null;

  const intro = pkg.product.introPrice;
  if (intro?.priceString) {
    const span = periodText(intro.periodUnit, intro.periodNumberOfUnits, intro.cycles);
    // An intro price with no readable duration is half a disclosure, which is
    // worse than none — fall back and let the authored sentence stand.
    if (!span) return null;
    return `Auto-renews ${cadence} at ${intro.priceString} for the first ${span}, then ${standard} until cancelled.`;
  }
  return `Auto-renews ${cadence} at ${standard} until cancelled.`;
}
