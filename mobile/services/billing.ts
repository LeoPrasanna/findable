/**
 * The RevenueCat SDK, wrapped so the rest of the app never imports it directly.
 *
 * Purchases happen through StoreKit / Play Billing — Apple and Google take their
 * cut on digital goods and a card form would be rejected at review anyway, so
 * there is no payment UI of ours in this flow at all. The OS presents the sheet;
 * we hand it a package and read the outcome.
 *
 * ⚠️ EVERY EXPORT HERE IS SAFE TO CALL WHEN BILLING DOES NOT EXIST. Web has no
 * IAP, a build can ship with no keys configured, and the SDK can fail to
 * initialise. All three are normal, and `available()` is false in all of them —
 * the paywall then renders read-only instead of crashing. A paywall that throws
 * is worse than one that cannot sell.
 *
 * ⚠️ THE SERVER GRANTS THE TIER, NOT THIS FILE. `customerInfo.entitlements` is a
 * client-side claim and the app enforces nothing from it — after a purchase the
 * app calls `POST /api/billing/sync`, which asks RevenueCat server-to-server and
 * stamps `app_metadata.tier`. See backend/app/routes/billing.py.
 */
import { Platform } from 'react-native';
import Purchases, { LOG_LEVEL } from 'react-native-purchases';
import { billingKey, packageFor, type PlanId, type StorePackage } from './billingPlans';

/**
 * Public SDK keys. ⚠️ THESE ARE PUBLIC BY DESIGN — RevenueCat's platform keys are
 * meant to ship inside the app binary, which is why they are `EXPO_PUBLIC_*`. The
 * key that must never appear here is the v1 REST **secret**, which lives only on
 * the server (`REVENUECAT_API_KEY`).
 */
const KEY = billingKey({
  dev: __DEV__,
  platform: Platform.OS,
  testKey: process.env.EXPO_PUBLIC_RC_TEST_KEY,
  ios: process.env.EXPO_PUBLIC_RC_IOS_KEY,
  android: process.env.EXPO_PUBLIC_RC_ANDROID_KEY,
});

let ready = false;

/** Whether a purchase can be attempted at all. */
export function available(): boolean {
  return ready;
}

/**
 * Start the SDK. Safe to call repeatedly; only the first call configures.
 *
 * `appUserID` is the Supabase user id and that is load-bearing: the webhook
 * identifies whose tier to change by `event.app_user_id`, so an anonymous id
 * RevenueCat generated for itself cannot be mapped back to an account. See the
 * preconditions in backend/app/routes/billing.py.
 */
export function configure(userId?: string | null): void {
  if (ready || !KEY) return;
  try {
    if (__DEV__) Purchases.setLogLevel(LOG_LEVEL.DEBUG);
    Purchases.configure({ apiKey: KEY, appUserID: userId ?? null });
    ready = true;
  } catch (e) {
    // A failure here means no billing, not a broken app.
    console.warn('[billing] configure failed', e);
    ready = false;
  }
}

/** Point the SDK at this Supabase user (call on sign-in). */
export async function identify(userId: string): Promise<void> {
  if (!KEY) return;
  configure(userId);
  if (!ready) return;
  try {
    await Purchases.logIn(userId);
  } catch (e) {
    console.warn('[billing] logIn failed', e);
  }
}

/** Detach from this user (call on sign-out) so the next account starts clean. */
export async function forget(): Promise<void> {
  if (!ready) return;
  try {
    await Purchases.logOut();
  } catch (e) {
    // logOut throws if the user is already anonymous. Not a problem.
    console.warn('[billing] logOut failed', e);
  }
}

/**
 * The packages in the current offering, or null when there is nothing to sell.
 *
 * null is the honest answer in a lot of normal situations — no network, no keys,
 * products not yet configured in the stores — and the paywall is built to show
 * authored prices and a "subscribe in the app" note in all of them.
 */
export async function packages(): Promise<StorePackage[] | null> {
  if (!ready) return null;
  try {
    const offerings = await Purchases.getOfferings();
    const current = offerings?.current;
    if (!current || !current.availablePackages?.length) return null;
    return current.availablePackages as unknown as StorePackage[];
  } catch (e) {
    console.warn('[billing] getOfferings failed', e);
    return null;
  }
}

export type PurchaseOutcome =
  | { status: 'purchased' }
  | { status: 'cancelled' }
  | { status: 'unavailable' }
  | { status: 'error'; message: string };

/**
 * Buy a plan. The OS owns the sheet from here.
 *
 * ⚠️ A CANCELLED PURCHASE IS NOT AN ERROR, and conflating the two is the single
 * most common bug in this flow: the user taps the system sheet away and the app
 * shows "Purchase failed", which reads as *we broke something* and kills the
 * second attempt. RevenueCat flags it as `userCancelled`; it gets its own status
 * and the caller shows nothing at all.
 */
export async function purchase(plan: PlanId): Promise<PurchaseOutcome> {
  if (!ready) return { status: 'unavailable' };
  const list = await packages();
  const pkg = list && packageFor(list, plan);
  if (!pkg) return { status: 'unavailable' };
  try {
    await Purchases.purchasePackage(pkg as any);
    return { status: 'purchased' };
  } catch (e: any) {
    if (e?.userCancelled) return { status: 'cancelled' };
    return { status: 'error', message: readableError(e) };
  }
}

/** Re-apply a purchase made on another device or before a reinstall. */
export async function restore(): Promise<PurchaseOutcome> {
  if (!ready) return { status: 'unavailable' };
  try {
    await Purchases.restorePurchases();
    return { status: 'purchased' };
  } catch (e: any) {
    if (e?.userCancelled) return { status: 'cancelled' };
    return { status: 'error', message: readableError(e) };
  }
}

/**
 * A sentence a person can act on.
 *
 * RevenueCat's errors carry a `message` plus an `underlyingErrorMessage` that is
 * usually StoreKit's internal text ("The operation couldn't be completed"). The
 * outer message is the human one; the underlying is for the log.
 */
function readableError(e: any): string {
  const msg = typeof e?.message === 'string' ? e.message.trim() : '';
  if (msg) return msg;
  return 'The store could not complete the purchase. Nothing was charged — try again in a moment.';
}
