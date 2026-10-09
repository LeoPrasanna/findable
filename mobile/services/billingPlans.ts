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
 * Run tasks strictly one after another, in the order they were handed over.
 *
 * ⚠️ THIS EXISTS TO STOP TWO ACCOUNTS SHARING ONE SUBSCRIPTION. RevenueCat's rule
 * for switching users is `logOut()`, **wait for it**, then `logIn(newId)` — swapping
 * directly with a second `logIn` ALIASES the two app user ids together, which on a
 * shared device would attach one account's purchase to the other's.
 *
 * Supabase delivers SIGNED_OUT and SIGNED_IN as two separate events, and the auth
 * gate must not block on a billing SDK, so both call sites are deliberately
 * fire-and-forget. Without a queue their promises interleave and the order RevenueCat
 * sees is whichever network call returns first. The queue makes the ORDERING a
 * property of this module instead of a property of how fast two requests happen to
 * resolve.
 *
 * A rejected task must not stall the queue behind it, so failures are absorbed here
 * and still delivered to the caller's own promise.
 */
export function serialQueue() {
  let tail: Promise<unknown> = Promise.resolve();
  return function run<T>(task: () => Promise<T>): Promise<T> {
    // `.then(task, task)` runs the next task whether the previous one kept or broke
    // its promise — a failed logOut must never wedge every later logIn.
    const next = tail.then(task, task);
    tail = next.catch(() => {});
    return next;
  };
}

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

/**
 * What to tell someone after `/api/billing/sync`, given whether money moved.
 *
 * ⚠️ THIS EXISTS BECAUSE THE APP ONCE SAID "YOU'RE ON PRO" TO PEOPLE WHO WERE NOT.
 * `apply()` called `/sync`, threw the response away, and showed the success
 * dialog on any 2xx. `/sync` answers `{tier: null, active: false}` when
 * RevenueCat has never heard of you — a perfectly successful request meaning
 * "nothing found" — so tapping Restore with nothing to restore congratulated you
 * on a subscription you did not have. Nothing was granted server-side; it was a
 * lying dialog, which is its own kind of harm on a payment screen.
 *
 * ⚠️ `paid` IS THE WHOLE REASON THIS TAKES TWO ARGUMENTS. The same sync result
 * means different things on the two paths, and the reassuring sentences are only
 * true on one of them:
 *
 *   - After a PURCHASE, Apple or Google already took the money before this app
 *     heard anything. `active: false` means "not applied yet", never "it failed",
 *     and the webhook will finish the job within the hour. Saying the wrong one
 *     of those to someone holding a receipt is how a refund request starts.
 *   - After a RESTORE, no money moved at all. Every sentence about a payment is
 *     false there — including on the error path, where the old code's "Payment
 *     received" would have been pure invention.
 *
 * `active: null` means the sync itself failed (threw), not that it answered no.
 */
export type SyncVerdict =
  /** Entitlement confirmed by the server. The only path that may claim Pro. */
  | 'pro'
  /** Paid, but the server has not caught up. Reassure; do not claim Pro. */
  | 'pending'
  /** Restore found nothing. Say so plainly — no money was involved. */
  | 'none'
  /** The sync call failed on a path where nothing was paid. */
  | 'failed';

export function syncVerdict(paid: boolean, active: boolean | null): SyncVerdict {
  if (active === null) return paid ? 'pending' : 'failed';
  if (active) return 'pro';
  return paid ? 'pending' : 'none';
}
