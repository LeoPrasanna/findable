/**
 * WHERE promoted tiles go in the library grid, WHAT they say, and whether they go at
 * all.
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
 * So the measurement IS the feature: the dismiss rate is the tolerance signal.
 */

/**
 * How many tiles must exist before a promo is allowed to appear.
 *
 * ⚠️ A PROMO IN A NEARLY-EMPTY LIBRARY IS THE WHOLE FEAR MADE REAL. Someone with four
 * saves who finds a fifth tile selling them something has been advertised at, not
 * shown their library.
 */
const MIN_TILES = 10;

/** The first slot sits below the opening screenful, so the library's own content is
 *  what opens. */
const FIRST = 8;

/**
 * Then one every this many tiles.
 *
 * ⚠️ ONE PER GRID WAS TOO FEW AND THE OWNER WAS RIGHT (2026-10-06: "just one is not
 * enough"). A single tile in a 30-save library is not a density a real network would
 * ever buy, so it could not tell us what real density feels like — which is the only
 * thing this slot is for. 1-in-10 is deliberately sparser than a social feed (Instagram
 * runs nearer 1-in-4) because this is a library of your own things, not a discovery
 * feed, and the sparse end is where the honest test is. ⚠️ No authoritative figure for
 * Pinterest's own in-feed density is public — do not let anyone cite one.
 */
const EVERY = 10;

/**
 * Hard cap per rendered grid.
 *
 * ⚠️ THIS IS A HOUSE-AD ARTEFACT, NOT AN AD-POLICY RULE. There are only three
 * creatives below, so an uncapped 1-in-10 over a 500-save library would repeat the
 * same three cards fifty times, which reads as a rendering bug rather than as
 * inventory. **Delete this cap the day real creatives arrive** — a network supplies a
 * different one every time and the cap would then be throwing away revenue.
 */
const MAX_PROMOS = 6;

/** The tile's shape. One of ReelCard's own RATIOS, so it cannot disturb the grid's
 *  rhythm by introducing a fifth proportion nothing else uses. */
export const PROMO_ASPECT = 4 / 5;

/** How long a dismissal lasts. Long enough to be a real "no" rather than a
 *  per-session shrug; short enough that the slot is not permanently dead on a device
 *  while we are still measuring it. */
export const PROMO_SNOOZE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * What Pro actually gives you. ⚠️ THESE TWO MIRROR `render.yaml`
 * (`PRO_SAVE_LIMIT`, `AI_PRO_DAILY_LIMIT`) AND NOTHING ENFORCES THAT. A promo that
 * promises 500 saves when the server grants 300 is not a stale string, it is a false
 * advertisement inside the product. The FREE numbers are never hardcoded here — they
 * come from the live `/usage` payload, because that is the one the user can check.
 */
const PRO_SAVES = 500;
const PRO_AI_PER_DAY = 20;

export interface PromoCard {
  /** Stable React key, and the label if this is ever logged. */
  key: string;
  headline: string;
  sub: string;
}

/**
 * The creatives, built from the user's OWN live limits so the comparison is true for
 * them specifically.
 *
 * ⚠️ VARIETY IS WHAT MAKES REPETITION SURVIVABLE. The owner asked for more slots, and
 * more slots showing one identical card would have measured "does the same tile five
 * times annoy people" — a question with an obvious answer — instead of "is promoted
 * inventory tolerable here". A network rotates creatives; so does this.
 *
 * Cards whose premise is not true for this user are omitted rather than softened: a
 * free user who still has Ask is not told Ask is Pro-only.
 */
export function promoCards(opts: {
  saveLimit?: number | null;
  aiPerDay?: number | null;
  canAsk?: boolean;
}): PromoCard[] {
  const cards: PromoCard[] = [];

  if (opts.saveLimit != null && opts.saveLimit < PRO_SAVES) {
    cards.push({
      key: 'saves',
      headline: `${PRO_SAVES} saves\ninstead of ${opts.saveLimit}`,
      sub: `Findable Pro — ${PRO_SAVES - opts.saveLimit} more things you never have to delete.`,
    });
  }
  if (opts.aiPerDay != null && opts.aiPerDay < PRO_AI_PER_DAY) {
    cards.push({
      key: 'ai',
      headline: `${PRO_AI_PER_DAY} AI actions\na day, not ${opts.aiPerDay}`,
      sub: 'Summaries, recipes, tasks and workouts — without running out by lunchtime.',
    });
  }
  if (opts.canAsk === false) {
    cards.push({
      key: 'ask',
      headline: 'Ask your whole\nlibrary a question',
      sub: 'Ask is part of Findable Pro. Your saves become something you can search by meaning.',
    });
  }

  // ⚠️ NEVER RETURN AN EMPTY LIST SILENTLY — the caller would then render promo slots
  // with nothing in them. A user whose limits already match Pro's is not someone to
  // advertise to at all, and `promoSlots` is what decides that; this is the backstop.
  return cards;
}

/**
 * Which indices in the newest-first order carry a promo.
 *
 * Returned as indices rather than a count so the grid can place each one by its own
 * shortest-column rule — that inline flow is what makes this Pinterest-shaped rather
 * than a banner.
 *
 * ⚠️ `tier` MUST BE THE STRING 'free', never `tier !== 'pro'`. The usage cache starts
 * null, so an unknown tier would otherwise be treated as free and show a paying user
 * an advert for the thing they already bought — a churn mechanic, not an upsell. Same
 * rule ProfilePanel.tsx states for its own tier read.
 */
export function promoSlots(
  total: number,
  tier: string | null | undefined,
  dismissedAt: number | null,
  now: number,
  cardCount = 1,
): number[] {
  if (tier !== 'free') return [];
  if (total < MIN_TILES) return [];
  if (cardCount < 1) return [];
  if (dismissedAt != null && now - dismissedAt < PROMO_SNOOZE_MS) return [];

  const out: number[] = [];
  // `total - 1` keeps a promo off the final position: a promoted tile as the last
  // thing in the grid reads as a footer advert, which is the format this is trying
  // not to be.
  for (let i = FIRST; i < total - 1 && out.length < MAX_PROMOS; i += EVERY) {
    out.push(i);
  }
  return out;
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
