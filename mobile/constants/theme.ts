import { Platform, Appearance } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * Findable design system — "Contact Sheet".
 *
 * ── Reference lock (Refero, 2026-08-01) ──────────────────────────────────────
 * Primary:  Julia Krantz (juliakrantz.com) — "darkroom contact sheet": a grid of
 *           photographic tiles on absolute #000, identity spelled in barely-there
 *           light letterforms. Its governing rule is the one that reshapes this
 *           whole file: "Color is entirely absent from the UI layer; all
 *           chromatic interest is delegated to the photography."
 * Borrow:   mono (mono.frm.fm) — the GHOST OUTLINE control: transparent fill,
 *           1px border, 0 radius, wide horizontal padding, no filled CTA colour.
 *           entire studios — small tracked uppercase utility labels as the
 *           navigation/metadata voice instead of icons.
 * Reject:   any hue in the chrome · rounded corners · shadows/elevation ·
 *           gradients on controls · filled colour CTAs · a hue per category ·
 *           weight above 500 · decorative entry animation.
 *
 * ── Why this replaced a colour-first system ──────────────────────────────────
 * The outgoing direction rotated four saturated brand colours across card
 * surfaces. Findable's cards are THUMBNAILS — every one arrives with its own
 * palette, and brand colour on the surface around them fought all of it. Here
 * the chrome is achromatic on purpose so the user's saved content is the only
 * colour on screen. That is the whole thesis; do not add an accent "just for
 * the primary button".
 *
 * ── Roles (do not repurpose) ─────────────────────────────────────────────────
 *   ink        The single foreground. All text, all icons, all borders.
 *   ash        Secondary hierarchy. Labels, counts, metadata. Never body copy.
 *   ghostLine  Structural seams ONLY — tile borders, dividers, rules.
 *   veil       Decorative overlay text on photography (the archival index).
 *              Meaningful overlay text uses `ink` over `scrim`, never veil.
 *   canvas     Absolute. #000 in dark, #FFF in light. Never a "near" value.
 *
 * NOTE: token names are a stable API — screens import these by name. Every name
 * the old system exported still resolves, so the look changes app-wide without
 * ~30 call sites being edited. Add tokens freely; rename only with a sweep.
 */

/* ── Schemes ───────────────────────────────────────────────────────────────── */

export type ColorScheme = 'light' | 'dark';
/** What the user picked. 'system' follows the OS and keeps following it. */
export type SchemePreference = ColorScheme | 'system';

interface Palette {
  background: string; surface: string; card: string; cardElevated: string;
  border: string; borderLight: string;
  accent: string; accentDark: string; accentLight: string;
  textPrimary: string; textSecondary: string; textTertiary: string;
  onAccent: string;
  tagBg: string; tagText: string;
  danger: string; success: string; warning: string;
  scrimMid: string; scrimBottom: string;
  ghostLine: string; veil: string;
  /** Top → bottom stops for the tab bar pill. A slightly lifted top edge is
   *  what gives the pill its shape against a dark page; a flat fill reads as a
   *  hole punched in the canvas. */
  tabBarTop: string;
  tabBarBottom: string;
}

/**
 * Two inversions of one system, not two systems.
 *
 * Dark is Julia Krantz verbatim: absolute #000, a single #F8F8F8 foreground.
 * Light is the same grammar inverted, grounded in `entire studios` and `mono`
 * (both monochrome gallery systems in the same research batch) rather than
 * invented — #FFF canvas, black ink, the same hairline seams at 14%.
 *
 * ⚠️ The ash values are NOT the reference's #707070. That measures 4.24:1 on
 * black and fails AA at the 10px label sizes this system leans on. Both were
 * walked until they pass: #787878 = 4.76:1 on void, #6E6E6E = 5.10:1 on canvas.
 * Preserving an accessibility bug is not preserving a signature trait.
 */
const PALETTES: Record<ColorScheme, Palette> = {
  // ── "Nocturnal Dimension" ────────────────────────────────────────────────
  // Sources: Suno (surfaces, ink, pink), Vapi (accent orange). See
  // docs/DESIGN_PROPOSAL.md. Ratios below are measured against `background`
  // #101012 — NOT the old #000000, which is why several values moved.
  dark: {
    background: '#101012',     // Suno Pitch Black. Warm-lean, not absolute void.
    surface: '#101012',
    card: '#17171A',           // Suno Void Black — the floor behind a photograph
    cardElevated: '#1E1E22',   // derived: card +1 step
    border: 'rgba(247,244,239,0.10)',
    borderLight: 'rgba(247,244,239,0.20)',
    accent: '#E96B34',         // Vapi Orange. 6.0:1 — the one CTA hue.
    accentDark: '#C95524',     // derived: accent darkened for pressed states
    accentLight: '#FD429C',    // Suno Vivid Pink — gradient stop ONLY, never a fill
    textPrimary: '#F7F4EF',    // Suno Ghost White — 17.4:1
    textSecondary: '#A3A3A3',  // Suno Muted Steel —  7.6:1
    textTertiary: '#7E7E7E',   //  4.7:1 — was #787878, which measures 4.33 on
                               //  #101012 and would have shipped below AA
    onAccent: '#101012',       // dark text on the orange fill — 6.0:1
    tagBg: 'transparent',      // tags are tracked type, not chips
    tagText: '#7E7E7E',
    danger: '#E05561',         // DERIVED, not a source token: neither Suno nor
                               // Vapi ships a red. Suno Vivid Pink #FD429C
                               // rotated 337°→355° and desaturated 98%→69%.
                               // 5.5:1. Colour carries meaning here.
    success: '#F7F4EF',        // still monochrome — reads by wording
    warning: '#F7F4EF',        // still monochrome — reads by wording
    scrimMid: 'rgba(0,0,0,0)',
    scrimBottom: 'rgba(0,0,0,0.82)',
    ghostLine: 'rgba(247,244,239,0.10)',
    veil: 'rgba(247,244,239,0.45)',
    tabBarTop: 'rgba(30,30,34,0.94)',
    tabBarBottom: 'rgba(16,16,18,0.94)',
  },
  light: {
    background: '#FFFFFF',     // Arctic White (entire studios)
    surface: '#FFFFFF',
    card: '#F2F2F2',
    cardElevated: '#E9E9E9',
    border: 'rgba(0,0,0,0.14)',
    borderLight: 'rgba(0,0,0,0.26)',
    accent: '#000000',
    accentDark: '#000000',
    accentLight: '#2B2B2B',
    textPrimary: '#000000',    // 21:1
    textSecondary: '#4A4A4A',  //  9.0:1
    textTertiary: '#6E6E6E',   //  5.1:1
    onAccent: '#FFFFFF',
    tagBg: 'transparent',
    tagText: '#6E6E6E',
    // Light stays monochrome — Nocturnal Dimension is a dark-scheme identity.
    // `danger` is the one exception: the meaning rule has to hold in both
    // schemes, and #E05561 measures 3.5:1 on white, so light uses a darkened
    // crimson (6.1:1) instead of the dark-scheme value.
    danger: '#B3323E',
    success: '#000000',
    warning: '#000000',
    scrimMid: 'rgba(0,0,0,0)',
    // ⚠️ The scrim does NOT invert. It sits over a photograph, and photographs
    // are the same in both schemes — a white scrim would make overlay text
    // unreadable on a light image. Overlay text is white-on-dark in both.
    scrimBottom: 'rgba(0,0,0,0.82)',
    ghostLine: 'rgba(0,0,0,0.14)',
    veil: 'rgba(248,248,248,0.45)',
    tabBarTop: 'rgba(255,255,255,0.98)',
    tabBarBottom: 'rgba(232,232,232,0.98)',
  },
};

/**
 * Text that sits ON a photograph. Fixed across schemes for the reason above.
 * Use with `gradients.scrim` behind it whenever the text carries meaning.
 */
export const onImage = {
  primary: '#F8F8F8',
  muted: 'rgba(248,248,248,0.45)',
} as const;

/**
 * Live token object. Mutated in place by `setScheme` — never reassigned, so
 * `import { colors }` stays valid and every themed() sheet re-reads it.
 */
export const colors = {
  ...PALETTES.dark,

  /** The inverted primary: fill with `action`, label with `onAction`. This is
   *  the ONLY inversion in the system, which is what makes it read as emphasis
   *  without a hue. Ghost outline (see `control.ghost`) is the default; this is
   *  reserved for the single most important action on a screen. */
  action: PALETTES.dark.textPrimary,
  onAction: PALETTES.dark.background,

  // The retired ember/neon/glass compatibility aliases (`hologram`, `neonPink`,
  // `neonCyan`, `neonViolet`, `glassBg`, `glassBorder`, `glassBorderLight`) were
  // removed 2026-08-09 — grep confirmed zero readers outside this file, so they
  // were only being kept alive by their own re-theme lines in applyScheme.
};

type Ramp4 = readonly [string, string, string, string];

/**
 * The haze stops. DARK ONLY carries hue — a chromatic wash over a white UI
 * breaks both the look and the contrast gates, so the light scheme stays flat
 * monochrome (the one exception is the semantic `danger` token). Called from
 * both the initial `gradients` literal and `applyScheme`, so the stops exist in
 * exactly one place.
 *
 * ⚠️ Light collapses to TRANSPARENT, not to four copies of the canvas.
 * Opaque canvas stops made this an opaque white sheet, and the haze is rendered
 * ABOVE content on some screens (LoginScreen paints it over the drifting reel
 * wall) — so a "flat white" fallback silently erased the whole animation in
 * light mode. Dark gets away with opaque end-stops only because its middle
 * stops are rgba() and the ramp interpolates to partial transparency.
 *
 * Screens that need a canvas underneath set their own `backgroundColor`
 * (e.g. `styles.center` on the workout rest screen), so a transparent ramp
 * changes nothing there — it just stops the layer from covering anything.
 */
function hazeFor(p: Palette, s: ColorScheme): Ramp4 {
  return s === 'dark'
    ? [p.background, 'rgba(253,66,156,0.10)', 'rgba(233,107,52,0.14)', p.background]
    : ['transparent', 'transparent', 'transparent', 'transparent'];
}

/**
 * ⚠️ Gradients are FLAT on purpose — except `scrim` and `haze`.
 *
 * Julia Krantz: "Never introduce gradients, overlays, or tinted backgrounds."
 * A gradient on every primary action is also the single most recognisable
 * "an agent made this" signature. Both stops of `primary` and `success` are the
 * same colour, so their call sites keep the component and render a solid fill.
 *
 * `scrim` and `haze` keep real stops. `scrim` is an image treatment that makes
 * overlay text legible over an unknown photograph; `haze` is the screen-root
 * atmosphere. Neither is decoration on a control — and no control may use them.
 *
 * ⚠️ Primary actions stay the CREAM INVERSION, not the orange accent (owner,
 * 2026-08-09, "Option B"). Fifteen orange buttons is how one accent becomes
 * wallpaper. `colors.accent` is reserved for active tabs, filter chips, and the
 * centre FAB.
 *
 * Removed 2026-08-09 — `vibrant`, `sunset`, `cool` (three names for the exact
 * same flat ink, left over from the retired per-feature rainbow: sunset=
 * itinerary, cool=recipe, vibrant=workout — meaning that colour no longer
 * carries); `surface`, `hologram`, `neon`, `darkSurface` (zero call sites).
 */
export const gradients = {
  primary: [PALETTES.dark.textPrimary, PALETTES.dark.textPrimary] as const,
  success: [PALETTES.dark.textPrimary, PALETTES.dark.textPrimary] as const,
  scrim: ['transparent', PALETTES.dark.scrimMid, PALETTES.dark.scrimBottom] as const,

  /**
   * The ONE real ramp besides `scrim`. Full-bleed atmospheric haze for the
   * home canvas — Suno's amber/magenta glow, no blur anywhere, so web and
   * Android cost the same single GPU draw as iOS. Render it once at the root
   * of the screen with `pointerEvents="none"`, never per-card.
   * Stops pair with `hazeLocations`.
   */
  haze: hazeFor(PALETTES.dark, 'dark'),
};

/** Stop positions for `gradients.haze`. */
export const hazeLocations = [0, 0.45, 0.78, 1] as const;

/**
 * Platform identity is a WORDMARK, not a colour.
 *
 * `label` is the load-bearing field now — rendered as tracked uppercase type
 * (see `kit.Label`). The `color` key is retained because ~6 call sites read it,
 * but every value is the ink tone: six brand hues in the chrome would be the
 * loudest thing on a screen full of thumbnails and would fight every one of
 * them. Julia Krantz's rule holds — no colour in the UI layer.
 */
// Read from the palette rather than repeating hex. These were hardcoded
// '#F8F8F8'/'#0B0B0B' and silently drifted when the canvas moved to Nocturnal
// Dimension — the placeholder sat a step darker than every card around it.
const INK = PALETTES.dark.textPrimary;
const CARD = PALETTES.dark.card;

export const platformMeta: Record<string, { color: string; gradient: readonly [string, string]; icon: string; label: string }> = {
  youtube:   { color: INK, gradient: [CARD, CARD], icon: 'logo-youtube',   label: 'YouTube' },
  instagram: { color: INK, gradient: [CARD, CARD], icon: 'logo-instagram', label: 'Instagram' },
  tiktok:    { color: INK, gradient: [CARD, CARD], icon: 'logo-tiktok',    label: 'TikTok' },
  linkedin:  { color: INK, gradient: [CARD, CARD], icon: 'logo-linkedin',  label: 'LinkedIn' },
  facebook:  { color: INK, gradient: [CARD, CARD], icon: 'logo-facebook',  label: 'Facebook' },
  // `logo-threads` is real in the installed Ionicons (@expo/vector-icons 15) —
  // verified against the glyph map, not assumed. ⚠️ An Ionicons name that
  // doesn't exist renders as an EMPTY BOX beside the label rather than
  // throwing, so a brand glyph added here must be checked against
  // `@expo/vector-icons/build/vendor/react-native-vector-icons/glyphmaps/Ionicons.json`
  // before it ships — the failure is silent and only visible on a real card.
  threads:   { color: INK, gradient: [CARD, CARD], icon: 'logo-threads',   label: 'Threads' },
  twitter:   { color: INK, gradient: [CARD, CARD], icon: 'logo-twitter',   label: 'X' },
  unknown:   { color: INK, gradient: [CARD, CARD], icon: 'globe-outline',  label: 'Web' },
};

/**
 * Categories carry ICON + LABEL only.
 *
 * The old map handed all 16 categories a bespoke hue (fitness pink, cooking
 * orange, tech teal, beauty magenta…). That is a taxonomy wearing a palette.
 * A category is now a small tracked uppercase word — Julia Krantz's Category
 * Label component doing exactly the job it was built for. `color` survives as
 * a key for the ~6 sites that read it, resolving to the muted ink tone.
 */
export const categoryMeta: Record<string, { icon: string; color: string }> = Object.fromEntries(
  ['all', 'fitness', 'cooking', 'tech', 'motivation', 'education', 'entertainment',
   'fashion', 'beauty', 'travel', 'business', 'news', 'health', 'finance',
   'hobby', 'shopping', 'general', 'other'].map(k => [k, { icon: k, color: PALETTES.dark.textTertiary }]),
);

export const categoryFor = (c?: string | null) =>
  categoryMeta[(c || 'other').toLowerCase()] ?? categoryMeta.other;

/* ── Scheme switching ────────────────────────────────────────────────────────
 * This machinery is inherited from the accent-switching system it replaces —
 * same problem, wider blast radius. `setScheme()` mutates the token objects,
 * regenerates every style sheet made through `themed()` (module-level
 * StyleSheet.create freezes values, so those sheets are wrapped in factories
 * that re-run), then notifies subscribers — the root layout bumps a remount key
 * and the tree repaints in one frame.
 *
 * Boot: web reads localStorage synchronously so the first paint is already
 * correct; native applies right after the root layout's AsyncStorage read.    */

export const SCHEME_STORAGE_KEY = '@savehere:scheme:v1';

function applyScheme(s: ColorScheme) {
  const p = PALETTES[s];
  Object.assign(colors, p);
  colors.action = p.textPrimary;
  colors.onAction = p.background;
  for (const k of Object.keys(categoryMeta)) categoryMeta[k].color = p.textTertiary;
  for (const k of Object.keys(platformMeta)) {
    platformMeta[k].color = p.textPrimary;
    (platformMeta[k] as { gradient: readonly [string, string] }).gradient = [p.card, p.card];
  }
  // Aliases that shadow palette values have to be re-pointed by hand.
  // No cast. The compiler checks these key names, so deleting a gradient can
  // never again leave a silent dangling reference here (the old loop still
  // named `vibrant`/`sunset`/`cool`/`hologram`/`neon`/`surface`/`darkSurface`
  // long after they were removed, and resurrected them on every scheme switch).
  gradients.primary = [p.textPrimary, p.textPrimary];
  gradients.success = [p.textPrimary, p.textPrimary];
  gradients.scrim = ['transparent', p.scrimMid, p.scrimBottom];
  gradients.haze = hazeFor(p, s);
  glass.card.backgroundColor = p.card;
  glass.card.borderColor = p.ghostLine;
  glass.cardElevated.backgroundColor = p.cardElevated;
  glass.cardElevated.borderColor = p.ghostLine;
  glass.neonBorder.borderColor = p.borderLight;
  control.ghost.borderColor = p.textPrimary;
  control.filled.backgroundColor = p.textPrimary;
  control.rule.backgroundColor = p.ghostLine;
}

// Two-phase notify: sheets must be regenerated BEFORE React subscribers
// re-render, or the remounted tree would still read the old sheets.
const _sheetRegens = new Set<() => void>();
const _schemeSubs = new Set<() => void>();

/** Subscribe to scheme changes (the root layout remounts the tree).
 *  Returns an unsubscribe function. */
export function onSchemeChange(fn: () => void): () => void {
  _schemeSubs.add(fn);
  return () => { _schemeSubs.delete(fn); };
}

/**
 * Wrap any module-level object whose values bake in theme tokens — a
 * StyleSheet.create(...) call, a colour map, a steps array. The factory re-runs
 * on every scheme change and the returned proxy always forwards to the latest
 * result, so `styles.foo` at render time is never stale.
 *
 *   const styles = themed(() => StyleSheet.create({ ... }));
 *
 * ⚠️ Load-bearing. Any sheet that bakes in a colour and skips this goes stale
 * the moment the user switches Light/Dark. With an achromatic system the
 * failure is total rather than cosmetic — a stale sheet renders white on white.
 */
export function themed<T extends object>(factory: () => T): T {
  let current = factory();
  _sheetRegens.add(() => { current = factory(); });
  return new Proxy({} as T, {
    get: (_, prop) => (current as Record<PropertyKey, unknown>)[prop as never],
    has: (_, prop) => prop in current,
    ownKeys: () => Reflect.ownKeys(current),
    getOwnPropertyDescriptor: (_, prop) => Object.getOwnPropertyDescriptor(current, prop),
  });
}

let _preference: SchemePreference = 'system';
let _active: ColorScheme = 'dark';

function resolve(p: SchemePreference): ColorScheme {
  if (p !== 'system') return p;
  return Appearance.getColorScheme() === 'light' ? 'light' : 'dark';
}

function repaint(next: ColorScheme) {
  if (next === _active) return;
  _active = next;
  applyScheme(next);
  _sheetRegens.forEach(fn => fn());
  _schemeSubs.forEach(fn => fn());
}

/** Set the user's preference. 'system' keeps tracking the OS from here on.
 *  Always notifies subscribers, even when the resolved scheme is unchanged, so
 *  a Dark → System tap that resolves back to dark still repaints the settings
 *  UI's selected state. */
export function setScheme(p: SchemePreference, opts?: { persist?: boolean }) {
  const changed = p !== _preference;
  _preference = p;
  /**
   * ⚠️ TELL THE NATIVE SIDE TOO, OR ONLY HALF THE APP CHANGES THEME.
   *
   * Owner report, first TestFlight build (2026-09-09): in dark mode the iOS
   * navigation bar drew a WHITE capsule behind the back button and a white
   * circle behind the hamburger. Nothing was wrong with either component —
   * they were painting correctly on top of native chrome that was still in
   * LIGHT appearance, because the phone's own setting was light and only our
   * JS tokens had been told about the change. Every native surface has the
   * same problem: the keyboard, alerts, the text-selection UI, scroll bars.
   *
   * ⚠️ ORDER MATTERS — this runs BEFORE resolve(). `Appearance.getColorScheme()`
   * returns the OVERRIDE once one is set, so resolve('system') would otherwise
   * read back whatever we last forced and 'system' would stick on that value
   * forever. `'unspecified'` clears the override and makes RN re-read the real
   * system scheme (Appearance.js:102) — that is exactly what 'system' means,
   * and it is the API's word for it, NOT `null`, which does not typecheck.
   */
  if (Platform.OS !== 'web') {
    Appearance.setColorScheme(p === 'system' ? 'unspecified' : p);
  }
  const next = resolve(p);
  if (next === _active) {
    if (changed) _schemeSubs.forEach(fn => fn());
  } else {
    repaint(next);
  }
  if (opts?.persist !== false) {
    if (Platform.OS === 'web') {
      try { window.localStorage.setItem(SCHEME_STORAGE_KEY, p); } catch {}
    }
    AsyncStorage.setItem(SCHEME_STORAGE_KEY, p).catch(() => {});
  }
}

/** What the user chose (may be 'system'). For the settings UI. */
export const getSchemePreference = (): SchemePreference => _preference;
/** What is actually painted right now. For StatusBar style, SVG fills, etc. */
export const getColorScheme = (): ColorScheme => _active;
export const isDark = () => _active === 'dark';

// Follow the OS whenever the preference is 'system'. Registered once for the
// life of the process — there is no unsubscribe path because this listener is
// as long-lived as the token module itself.
Appearance.addChangeListener(() => {
  if (_preference === 'system') repaint(resolve('system'));
});

// Boot read — web only (sync localStorage), so the first paint is correct. On
// native app/_layout.tsx reads AsyncStorage after mount and calls setScheme.
if (Platform.OS === 'web') {
  try {
    const stored = window.localStorage.getItem(SCHEME_STORAGE_KEY);
    if (stored === 'light' || stored === 'dark' || stored === 'system') _preference = stored;
  } catch {}
}
_active = resolve(_preference);

/** The categories a reel can be assigned to (auto or user-picked). Excludes the
 *  'all' filter pseudo-category. Keep in sync with backend ALLOWED_CATEGORIES. */
export const CATEGORY_OPTIONS = [
  'fitness', 'cooking', 'tech', 'motivation', 'education', 'entertainment',
  'fashion', 'beauty', 'travel', 'business', 'news', 'health', 'finance',
  'hobby', 'shopping', 'other',
] as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
  xxl: 48,
};

/**
 * The mosaic gutter — used as BOTH the gap between tiles and the grid's own
 * edge padding, so the rhythm is even all the way to the screen edge.
 *
 * ⚠️ ONE CONSTANT, THREE CONSUMERS: `app/index.tsx` (the masonry),
 * `components/SkeletonCard.tsx` (the loading placeholder) and
 * `app/rediscover.tsx`. They MUST agree — the skeleton renders on every
 * category switch, and when its spacing didn't match the real grid the whole
 * page visibly re-flowed the moment tiles landed. That was the "doesn't match
 * in every category" symptom: not the tiles, the placeholder underneath them.
 *
 * ⚠️ 8 → 12 (owner, 2026-08-12) as part of the library's Pinterest pass.
 * Measured off four Pinterest screens: gutter and page margin are ~10–12pt and
 * — the part most people get wrong — they are EQUAL. Pinterest does not use a
 * wider page margin than its gutter, which is exactly the architecture this
 * constant already had; only the value was too tight. At 12 a 390pt phone
 * gives 177pt tiles, within a couple of points of Pinterest's own 181pt.
 */
export const GRID_GAP = 12;

/** The width a tile WANTS to be, in points. Measured off Pinterest: ~181pt on a
 *  390pt phone at 2 columns. The column count is solved for this, not the other
 *  way round — see `columnsForWidth`. */
export const TARGET_TILE = 180;

/**
 * How many columns a grid of `width` points gets. **The one copy.**
 *
 * ⚠️ THIS LIVES HERE BECAUSE THE LAST FIX WENT TO ONE CALL SITE AND MISSED THE
 * OTHER. Round 1 diagnosed `width < 600 ? 2 : width < 1024 ? 3 : 4` as the
 * reason the grid looked right on a phone and wrong on a tablet, and replaced
 * it — in `app/index.tsx` only. `app/rediscover.tsx` still had the original
 * line, so the Rediscover grid kept the exact bug that was reported as fixed.
 * Two screens cannot hold "the same" formula; one of them is always the stale
 * one. Import this instead.
 *
 * Tile width stays roughly constant and the COLUMN COUNT grows to fill the
 * screen — that is the whole Pinterest trick. Fixed breakpoints do the
 * opposite: they hold the count steady and let tiles stretch, so a 10" tablet
 * at 3 columns rendered ~330pt tiles, nearly double a phone's, and a wall of
 * vast thumbnails with 12px gutters reads as broken rather than denser.
 *
 * Clamped at 2 so a small phone never collapses to a single column (that is a
 * list, not a mosaic) and at 6 so a desktop browser does not shred the grid
 * into a filmstrip.
 */
/**
 * What a tile wants to be on a TABLET — and the correction to two rounds of
 * fixing the tablet grid in the wrong direction (2026-08-15).
 *
 * ⚠️ Rounds 1 and 3 both held the tile at ~180pt and added COLUMNS as the canvas
 * grew: 1180pt → 6 columns of 182pt stamps. Pinterest does the opposite, and it
 * is measurable — researched on Refero against three Pinterest captures: the iOS
 * home masonry renders a **181pt** tile on a 390pt canvas, while Pinterest
 * desktop renders a **~221–248px** tile at ~1280–1440px. The tile GROWS with the
 * canvas. Holding it constant is precisely what turns a tablet into a filmstrip
 * of phone-sized thumbnails, which is the "not Pinterest at all" complaint.
 *
 * ⚠️ 232 is the MIDPOINT OF A MEASURED RANGE, not a measured value — the render
 * scale of the desktop capture is inferred, so anywhere in 221–248 is defensible.
 * Do not treat it as precise.
 */
const TARGET_TILE_WIDE = 232;

export function columnsForWidth(width: number): number {
  // ⚠️ Gated at 700 so PHONE output is bit-identical to before: 390 → 2,
  // 600 → 3. Only tablet-and-wider canvases move.
  // New output: 768→3, 834→3, 1024→4, 1180→5, 1366→6 (tiles ~214–262pt).
  const target = width < 700 ? TARGET_TILE : TARGET_TILE_WIDE;
  return Math.max(2, Math.min(6, Math.round((width - GRID_GAP) / (target + GRID_GAP))));
}

/**
 * ⚠️ REVERSED (owner, 2026-08-03). These were ALL ZERO — the primary style
 * reference's one absolute rule was "never round corners; 0px is
 * non-negotiable". The owner asked for soft curves, referencing the app this
 * direction was briefed against, whose controls are pills and whose fields are
 * ~10px rounded rectangles.
 *
 * So the rule is now: CONTROLS AND SURFACES CURVE, PHOTOGRAPHS DO NOT.
 *   - buttons, chips, the tab bar          → `full` (pill)
 *   - fields, cards, banners, modals       → `sm`–`lg`
 *   - grid tiles, the hero image           → still 0, hardcoded at the call
 *     site. A rounded photo in a tight mosaic reads as a sticker, and the
 *     reference grid is square-cornered; keep it that way.
 *
 * Because ~30 call sites already ask for `radius.full`, flipping this constant
 * turned them all back into pills in one move rather than 30 edits.
 */
export const radius = {
  sm: 8,
  md: 12,
  lg: 16,
  /** Dimension's card radius (24). Was 20 before Nocturnal Dimension. */
  xl: 24,
  /** Pill. Buttons, chips, the tab bar. */
  full: 999,
  /** A true circle. Category bubbles, tab-bar slots, auth buttons, avatars.
   *  Identical to `full`; the separate name says "this is meant to be round",
   *  not "this is a pill that happens to be square". */
  circle: 999,
};

/**
 * Motion, from Julia Krantz: two tiers only. 0.2s ease for colour/opacity state
 * changes, 0.4s ease for image brightness. The custom deceleration curve is
 * reserved for transforms.
 *
 * Its explicit rule: "No entry animations, no scroll-triggered effects. The
 * motion philosophy is minimal: only hover feedback, nothing decorative."
 *
 * This is a hard reversal of the outgoing system, which sprang, bobbed and
 * overshot. Press feedback here is OPACITY, never scale — a contact sheet whose
 * tiles bounce is a contradiction.
 */
export const motion = {
  instant: 120,
  micro: 200,     // colour/opacity state change — the base
  base: 200,
  state: 400,     // image brightness
  /** Controlled arrival. Transforms only. */
  spring: [0.22, 0.61, 0.36, 1] as const,
  easing: [0.22, 0.61, 0.36, 1] as const,
  /** Press feedback: dim, don't scale. */
  pressOpacity: 0.55,
  /** A tile under the finger darkens, exactly as the reference's hover does. */
  pressBrightness: 0.82,
};

/**
 * ONE FAMILY: Inter.
 *
 * ⚠️ Owner direction (2026-08-01): match the brief's reference app, which sets
 * everything — wordmark, headings, body, buttons — in a single neutral
 * Helvetica-class grotesque at regular-to-semibold weights.
 *
 * Inter is that face. It is the standard open substitute for Helvetica
 * Now/Neue Haas Grotesk: same neutral skeleton, no signature quirks, and it
 * ships every weight this needs through `@expo-google-fonts/inter`.
 *
 * This REPLACED Space Grotesk + DM Sans at weight 300. That pairing came from
 * the primary style reference (Julia Krantz), whose signature is a
 * nearly-invisible light letterform — a portfolio move that reads as elegant on
 * a desktop contact sheet and as under-inked on a phone. Inter at 400/500/600
 * is the deliberate trade: less rarefied, considerably more legible at the
 * 10–13px label sizes this system leans on, and it is what the owner asked for.
 *
 * `serif` / `serifBlack` are kept as KEYS resolving to Inter so the ~8 call
 * sites asking for a serif stop rendering Fraunces without being edited.
 */
export const typeface = {
  display: 'Inter_600SemiBold',
  displaySemi: 'Inter_600SemiBold',
  displayMedium: 'Inter_500Medium',
  /** The wordmark. Same face as everything else — that is the point. */
  wordmark: 'Inter_600SemiBold',
  body: 'Inter_400Regular',
  bodyBold: 'Inter_500Medium',
  /** Small tracked uppercase labels — the metadata voice. */
  label: 'Inter_500Medium',
  serif: 'Inter_600SemiBold',
  serifBlack: 'Inter_600SemiBold',
};

/** Type scale. The reference's: caption 10 / heading 29 / display 44, with body
 *  sizes 12–14. Body is lifted to 15 — 13px light-weight body is a reading
 *  problem on a phone that a portfolio site never has to solve. */
export const font = {
  xs: 10,      // tracked uppercase labels ONLY — never sentence copy
  sm: 12,
  md: 15,      // body
  lg: 18,
  xl: 24,
  xxl: 29,
  display: 44,
};

/**
 * Letter-spacing is structural here, not a flourish. The reference carries its
 * entire hierarchy on tracking + weight because it has no colour to spend:
 * tight negative at display, wide positive at label sizes.
 *
 * React Native's `letterSpacing` is in POINTS, not em — these are pre-multiplied
 * against the size they belong to.
 */
/**
 * ⚠️ Loosened from -0.04em to -0.025em at display sizes when the face changed
 * from a 300-weight to a 600-weight. Tight negative tracking exists to stop
 * light letterforms drifting apart; applied to semibold Inter it jams the
 * counters shut. The heavier the weight, the less tightening it wants.
 */
export const tracking = {
  display: -1.1,    // -0.025em at 44
  title: -0.72,     // -0.025em at 29
  heading: -0.36,
  body: 0,
  /** +0.06em at 10px. Uppercase labels. */
  label: 0.6,
  /** +0.14em at 10px. The widest — category tags on tiles. */
  labelWide: 1.4,
};

/**
 * ⚠️ NO SHADOWS. Julia Krantz: "Never add box-shadows or elevation — depth
 * comes from contrast with the black canvas only."
 *
 * These are empty objects rather than deleted keys so the ~12 call sites that
 * spread `...shadow.glow` stop casting light without one of them being edited.
 */
export const shadow = {
  sm: {},
  md: {},
  glow: {},
} as const;

/**
 * The control vocabulary. Ghost is the DEFAULT — mono's rule, "all buttons
 * should be ghosted or outlined, never solid background fills". `filled` is the
 * single inversion, reserved for one primary action per screen.
 *
 * Deliberately NOT `as const`: applyScheme re-points these in place.
 */
export const control = {
  /** Transparent, 1px ink border, PILL, wide horizontal padding. */
  ghost: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: colors.textPrimary,
    borderRadius: 999,
    paddingVertical: 14,
    paddingHorizontal: 20,
  },
  /** The one inversion. Ink fill, canvas text. One per screen, at most. */
  filled: {
    backgroundColor: colors.textPrimary,
    borderWidth: 1,
    borderColor: colors.textPrimary,
    borderRadius: 999,
    paddingVertical: 14,
    paddingHorizontal: 20,
  },
  /** The ghost line, as a 1px divider. The only structural separator. */
  rule: {
    height: 1,
    backgroundColor: colors.ghostLine,
  },
};

/** Legacy "glass" presets — now flat, square, hairline-bordered surfaces.
 *  Deliberately NOT `as const`: applyScheme re-points these in place. */
export const glass = {
  card: {
    backgroundColor: colors.card,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.ghostLine,
  },
  cardElevated: {
    backgroundColor: colors.cardElevated,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.ghostLine,
  },
  neonBorder: {
    borderWidth: 1,
    borderColor: colors.borderLight,
  },
};

/** Legacy glow presets — neutralised to empty style objects. */
export const glow = { violet: {}, cyan: {}, pink: {} };

// Paint the resolved scheme now that every token object above exists.
applyScheme(_active);
