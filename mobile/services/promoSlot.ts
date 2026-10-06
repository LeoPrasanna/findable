/**
 * WHERE a promoted tile goes in the library grid, and whether it goes at all.
 *
 * Pure, no imports — so it can be checked by `node --experimental-strip-types`
 * (promoSlot.test.ts) and so the rules live somewhere other than inside a 700-line
 * screen.
 *
 * ⚠️ THIS IS A HOUSE AD, AND ON PURPOSE. It renders OUR Pro upsell, not a network's
 * creative. AdMob cannot serve this app at all until it is publicly downloadable in a
 * store (`docs/ADS_RESEARCH.md`), so the slot exists to answer the one question no
 * eCPM table can: does a non-organic tile in someone's OWN library read as useful, or
 * as a breach? Pinterest's feed is discovery, where a Promoted Pin is more of what you
 * came for. This grid is the things the user chose to keep, which is a different
 * promise — closer to an ad in a photo album.
 *
 * So the measurement IS the feature: the dismiss rate is the tolerance signal. If
 * people bin it immediately, that is the answer, bought for the price of an OTA
 * instead of an SDK, a CMP, a privacy rewrite and a build.
 */

/**
 * How many tiles must exist before a promo is allowed to appear.
 *
 * ⚠️ A PROMO IN A NEARLY-EMPTY LIBRARY IS THE WHOLE FEAR MADE REAL. Someone with four
 * saves who finds a fifth tile selling them something has been advertised at, not
 * shown their library. The promo has to be outnumbered by the user's own things by a
 * wide margin or it is not "in-feed", it IS the feed.
 */
const MIN_TILES = 10;

/**
 * Where in the newest-first order it lands.
 *
 * Below the first screenful (so the library's own content is what opens) and well
 * clear of the end (so it is never the last thing, which reads as a footer ad). The
 * mosaic places it in whichever column is shortest, exactly as it does a real tile —
 * that inline flow is the part that makes it Pinterest-shaped rather than a banner.
 */
const PROMO_INDEX = 8;

/** The tile's shape. One of ReelCard's own RATIOS, so it cannot disturb the grid's
 *  rhythm by introducing a fifth proportion nothing else uses. */
export const PROMO_ASPECT = 4 / 5;

/** How long a dismissal lasts. Long enough to be a real "no" rather than a
 *  per-session shrug; short enough that the slot is not permanently dead on a device
 *  while we are still measuring it. */
export const PROMO_SNOOZE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The index to inject at, or null for "no promo in this grid".
 *
 * ⚠️ `tier` MUST BE THE STRING 'free', never `tier !== 'pro'`. The usage cache starts
 * null, so an unknown tier would otherwise be treated as free and show a paying user
 * an advert for the thing they already bought — which is a churn mechanic, not an
 * upsell. Same rule ProfilePanel.tsx states for its own tier read.
 */
export function promoAt(
  total: number,
  tier: string | null | undefined,
  dismissedAt: number | null,
  now: number,
): number | null {
  if (tier !== 'free') return null;
  if (total < MIN_TILES) return null;
  if (dismissedAt != null && now - dismissedAt < PROMO_SNOOZE_MS) return null;
  return PROMO_INDEX;
}

/** A stored dismissal timestamp, validated. Junk in storage must read as "never
 *  dismissed" rather than as a dismissal in 1970 or one in the future. */
export function readDismissed(raw: string | null, now: number): number | null {
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  // A clock that has moved backwards (timezone edit, NTP correction) would otherwise
  // leave a dismissal stuck in the future and the slot dead forever.
  return n > now ? now : n;
}
