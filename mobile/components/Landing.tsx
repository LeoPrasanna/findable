import { useState, useCallback, useEffect } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { api } from '../services/api';
import { Pressable } from './Pressable';
import { Icon } from './Icon';
import { Label, Wordmark } from './kit';
import { colors, spacing, font, tracking, typeface, radius, themed, gradients, hazeLocations } from '../constants/theme';
import { useAuth } from '../contexts/AuthContext';
import { emitUi, onUi } from '../services/uiBus';
import { ASK_MIN_REELS } from '../constants/limits';
import { TAB_BAR_CLEARANCE } from './TabBar';
import { getSaveCount, hydrateSaveCount, rememberSaveCount } from '../services/saveCount';
import { RollingTagline } from './RollingTagline';

/**
 * The home screen — "editorial hero" (variant D7, owner-selected 2026-08-03).
 *
 * ── What this replaced, and why ──────────────────────────────────────────────
 * The old landing stacked a greeting, a rolling tip, an Ask row, a to-do block
 * with two columns, a category chip strip, a recent carousel and a four-line
 * disclaimer. Every one of those was defensible alone; together they were a
 * menu of eight destinations on a screen the user opens to do ONE thing.
 *
 * This is a statement and a single input. Everything the old screen linked to is
 * a tab away — Library, Slate and Ask are all in the tab bar now, so repeating
 * them here was pure duplication. The category chips duplicated the Library's
 * own filter; the disclaimer moved to where it is actually read.
 *
 * ── The ladder ───────────────────────────────────────────────────────────────
 *
 *     0 saves        paste a link      "Save it. Then ask it."
 *     1..MIN-1       paste a link      "…and two to go."   + unlock ticks
 *     MIN+           NO COMPOSER       "You saved it. Now use it." + live counters
 *
 * ⚠️ The composer used to become an "ASK YOUR LIBRARY" button at MIN+ saves.
 * The owner removed it (2026-08-10): Ask is a tab, and the home screen has one
 * action. The three-state ladder survives because it describes the LIBRARY, not
 * the button — `ASK_MIN_REELS` is still a real server-enforced gate
 * (app/ask.tsx enforces it independently), so the unlock ticks still tell the
 * truth about when the Ask tab starts working. Threshold is imported, never
 * hardcoded.
 *
 * ⚠️ THE COMPOSER NOW DISAPPEARS AT `ready` (owner, 2026-09-17). This reverses
 * "the input never moves", which this file argued for at length — so the reason
 * it is safe is worth stating rather than discovering later:
 *
 *   SAVING IS NOT ORPHANED. The tab bar carries a `+ Save` tab on every screen
 *   it renders on, and `/` is NOT in its HIDE_ON list (components/TabBar.tsx),
 *   so the route to /save is permanently one tap away and always in the same
 *   place. The dock composer at MIN+ saves was a SECOND button to the same
 *   screen, sitting directly above the first.
 *
 *   It stays for `empty` and `learning`. A user with four saves has not met the
 *   tab bar yet — for them the dock IS the instruction, and deleting it would
 *   leave a first-run screen with a sentence and no way to act on it.
 *
 * Net: at `ready` this screen is a dashboard, and its numbers are the controls
 * (see the metrics block below).
 *
 * ⚠️ NO SERIF. The approved mockup rendered the hero in a serif face; the app is
 * one family (Inter) and the owner asked for strict consistency in the same
 * breath. "Editorial" here is the composition — one large left-aligned
 * statement, a quiet supporting line, a pinned action — not a second typeface.
 */

/** Both taps hand off to a screen that already owns the job — this screen holds
 *  no paste or ask logic of its own, so there is one implementation of each. */
/** Things worth doing with a library that already exists. Phrased as
 *  invitations, not features — this sits under a receipt, and a list of nouns
 *  next to three numbers reads as a spec sheet. */
const HOME_TIPS = [
  'Ask your library a question — answered from your own saves',
  'Turn a tutorial into a checklist you can tick off',
  'Build a guided workout, with rest timers',
  'Pull the recipe out of a cooking video',
  'Share straight from Instagram — it saves without opening this app',
  'Rediscover something you forgot you kept',
];

type Stage = 'empty' | 'learning' | 'ready';

export function Landing({ onEnter }: { onEnter: () => void }) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { displayName } = useAuth();
  // ⚠️ SEEDED FROM THE LAST KNOWN COUNT, not null. Starting at null fell through
  // to the zero-save stage, so a user with 63 saves was shown "Save it. Then ask
  // it." for as long as the request took — measured at 21s against staging.
  // See services/saveCount.ts.
  const [total, setTotal] = useState<number | null>(getSaveCount);
  const [fetchError, setFetchError] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => { hydrateSaveCount().then(n => setTotal(t => t ?? n)); }, []);

  /**
   * Slate counters for the `ready` dashboard below.
   *
   * ⚠️ FETCHED ONLY WHEN IT WILL BE SHOWN — i.e. past ASK_MIN_REELS saves. The
   * screen this replaced pulled twelve reels AND the whole to-do list on every
   * open, for blocks most users never scrolled to; the rewrite's whole premise
   * was one count and one control. This is the one extra request, and a brand
   * new user with four saves still makes none of it.
   *
   * `null` means "haven't got it", never zero — an empty slate and an unasked
   * question look identical as a 0, and only one of them is true.
   */
  const [slate, setSlate] = useState<{ open: number; doneToday: number | null } | null>(null);

  // Only the COUNT is needed, so ask for one row rather than a page of twenty.
  // The old screen pulled twelve reels plus the whole to-do list to render
  // blocks this design no longer has.
  useFocusEffect(useCallback(() => {
    setFetchError(false);
    api.listReels({ limit: 1 })
      .then(d => { setTotal(d.total); rememberSaveCount(d.total); })
      .catch(() => setFetchError(true));
  }, [attempt]));

  // Deliberately NOT gated on `stage`: that would make the request depend on a
  // value derived from a request still in flight, and the dashboard would
  // arrive a beat after the hero. `total` is seeded from the cache, so a
  // returning user already reads as `ready` on the first frame.
  const wantsSlate = (total ?? 0) >= ASK_MIN_REELS;
  useFocusEffect(useCallback(() => {
    if (!wantsSlate) return;
    const today = new Date().toLocaleDateString('en-CA');   // YYYY-MM-DD, local
    api.listTodos(false, today)
      .then(d => setSlate({ open: d.stats.open, doneToday: d.stats.completed_today }))
      .catch(() => {});   // a missing counter just doesn't render; never a blocker
  }, [wantsSlate, attempt]));

  // A share saved while the app was backgrounded changes this count without any
  // router focus event — the native share Activity never enters JS. `attempt`
  // is the screen's existing refetch seam, so this reuses it rather than adding
  // a second fetch path. See the AppState listener in app/_layout.tsx.
  useEffect(() => onUi('appResumed', () => setAttempt(a => a + 1)), []);

  // An error only takes over the screen when there is nothing remembered to
  // show. With a known count the screen stays useful and the failure is a
  // quiet line — the count being a few minutes stale is not worth a full stop.
  const blocked = fetchError && total === null;

  const stage: Stage =
    total === null ? 'empty'
    : total === 0 ? 'empty'
    : total < ASK_MIN_REELS ? 'learning'
    : 'ready';

  const remaining = ASK_MIN_REELS - (total ?? 0);

  const copy = {
    empty: {
      head: 'Save it.\nThen ask it.',
      sub: 'Paste anything you’ve been meaning to come back to. The summary writes itself.',
    },
    learning: {
      head: `${total} in.\n${remaining} to go.`,
      sub: `Questions unlock at ${ASK_MIN_REELS} saves — they need a little to draw on.`,
    },
    ready: {
      // ⚠️ Was "You saved it. / Now ask it." — copy for a button that no longer
      // sits under it (owner removed the Ask CTA, 2026-08-10). A hero that says
      // "ask it" above a Paste-a-link control is a promise the screen can't
      // keep. Ask still exists; it is a tab, and the sub-line points there.
      head: 'You saved it.\nNow use it.',
      // ⚠️ SHORTER SINCE THE DASHBOARD LANDED (2026-09-11). This used to list
      // what the library holds and where to ask it — both of which the counters
      // and the rolling line underneath now say better, and saying them twice
      // is how a minimal screen stops being one.
      sub: 'Here’s where you are.',
    },
  }[stage];

  return (
    <View style={styles.screen}>
      {/* Nocturnal Dimension haze (owner, 2026-08-10). This screen is exactly
          what the wash was designed for — two text blocks and one control on an
          otherwise empty canvas, the same conditions under which it reads on the
          login wall. It is invisible on the library grid because full-bleed
          thumbnails cover it, and that stays accepted: there the pictures ARE
          the colour. Rendered ONCE at the root and non-interactive so it cannot
          eat the composer's tap. `hazeFor()` collapses to a flat canvas fill in
          light, so this paints nothing there — same deal as app/index.tsx. */}
      <LinearGradient
        colors={gradients.haze}
        locations={hazeLocations}
        style={[StyleSheet.absoluteFill, { pointerEvents: 'none' }]}
      />
      <View style={[styles.header, { paddingTop: insets.top + spacing.sm }]}>
        <Wordmark size={22} />
        <Pressable
          style={styles.menuBtn}
          onPress={() => emitUi('openProfile')}
          accessibilityRole="button"
          accessibilityLabel="Menu"
        >
          <Icon name="menu" size={17} color={colors.textPrimary} />
        </Pressable>
      </View>

      {/* ⚠️ The bottom inset is the BODY's job now, not the dock's. The dock
          used to be the only thing standing between centred content and the
          floating tab bar; with it gone at `ready`, content centred over the
          full height sits under the bar. Padding the body keeps the centring
          honest in both cases — at `empty`/`learning` the dock adds its own
          padding below this, which is what has always happened. */}
      <View
        style={[
          styles.body,
          stage === 'ready' && { paddingBottom: insets.bottom + TAB_BAR_CLEARANCE },
        ]}
      >
        <Text style={styles.hero}>
          {blocked ? 'Can’t reach\nthe server.' : copy.head}
        </Text>
        <Text style={styles.sub}>
          {blocked
            ? 'Your saves are safe — this screen just couldn’t load. The backend may be waking up.'
            : copy.sub}
        </Text>

        {/* A real button, because this screen does not scroll — the copy it
            replaces told the user to "pull down" on a view with nothing to
            pull. */}
        {blocked && (
          <Pressable
            style={styles.retry}
            onPress={() => setAttempt(a => a + 1)}
            accessibilityRole="button"
            accessibilityLabel="Try again"
          >
            <Label tone="ink" wide>Try again</Label>
          </Pressable>
        )}

        {/* Known count, failed refresh: say so, don't hijack the screen. */}
        {fetchError && total !== null && (
          <Label style={styles.stale}>Showing your last known count</Label>
        )}

        {/*
          ── The `ready` dashboard (owner, 2026-09-11) ──────────────────────
          Three counters and a rolling line, under the hero.

          ⚠️ MINIMAL MEANS NO NEW VOCABULARY. No cards, no icons, no colour,
          no progress rings — numbers in the display face with a Label under
          each, which is the grammar this screen already speaks.

          ⚠️ THEY ARE TAPPABLE NOW (owner, 2026-09-17). This file used to say
          "these are a receipt, not destinations, so nothing here is tappable"
          and warn that taps would rebuild the eight-link menu the redesign
          deleted. That worry was about ADDING links; this adds none. Each
          number already names exactly one place, and a user who reads "23 on
          slate" and presses it is not browsing a menu — they are following the
          only thing that number can mean:

              Saved      → the Library (same route, `onEnter`)
              On slate   → /todos
              Done today → /todos

          Nothing NEW appears on screen for this — no chevrons, no underlines,
          no hit-state borders. The affordance is the press dim that every
          Pressable in the app already has, which is why this does not put the
          menu back.

          ⚠️ `Saved` does NOT push a route. Home and Library are the SAME route
          (`/`), told apart by a session flag — see app/index.tsx. `onEnter` is
          the one correct way in, and it is why this component has taken an
          `onEnter` prop all along (unused since the Ask CTA was removed).

          "Done today" hides when the server didn't answer it — `null` is
          "didn't ask", and rendering that as a 0 would say "you've done
          nothing today" to someone who has.
        */}
        {stage === 'ready' && (
          <>
            <View style={styles.metrics}>
              <Pressable
                style={styles.metric}
                onPress={onEnter}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel={`${total} saved. Open your library.`}
              >
                <Text style={styles.metricN}>{total}</Text>
                <Label>Saved</Label>
              </Pressable>
              {slate ? (
                <Pressable
                  style={styles.metric}
                  onPress={() => router.push('/todos')}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel={`${slate.open} on your slate. Open your slate.`}
                >
                  <Text style={styles.metricN}>{slate.open}</Text>
                  <Label>On slate</Label>
                </Pressable>
              ) : null}
              {slate && slate.doneToday !== null ? (
                <Pressable
                  style={styles.metric}
                  onPress={() => router.push('/todos')}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel={`${slate.doneToday} done today. Open your slate.`}
                >
                  <Text style={styles.metricN}>{slate.doneToday}</Text>
                  <Label>Done today</Label>
                </Pressable>
              ) : null}
            </View>
            {/* What the library can still do for a save they already have —
                the one place on this screen that suggests rather than reports. */}
            <RollingTagline
              compact
              shuffle
              alignLeft
              lines={HOME_TIPS}
              numberOfLines={1}
              style={styles.tips}
            />
          </>
        )}

        {/* The unlock ladder, only while it means something. Discrete ticks
            rather than a bar: "3 of 5" reads instantly, a part-filled bar
            reads as "some". Same grammar the Ask screen's own gate uses. */}
        {stage === 'learning' && (
          <View style={styles.ticks}>
            {Array.from({ length: ASK_MIN_REELS }).map((_, i) => (
              <View key={i} style={[styles.tick, i < (total ?? 0) && styles.tickOn]} />
            ))}
          </View>
        )}
      </View>

      {/* ── The input. One job while it is shown: paste a link. ──
          A Pressable shaped like the composer rather than a live field: the
          paste flow lives on /save, which already handles clipboard
          permissions, validation, quota and errors. Duplicating it here would
          be a second implementation to keep in sync — and the first to drift.

          ⚠️ This used to swap to an "ASK YOUR LIBRARY" button at `ready`
          (owner removed it, 2026-08-10). Ask is a tab; do not re-add a second
          destination here.

          ⚠️ NOT RENDERED AT `ready` (owner, 2026-09-17) — the tab bar's `+ Save`
          tab is the save route once the user has a library, and this was the
          same destination stacked above it. See the header docblock for why
          that is safe and why it stays for `empty` and `learning`. */}
      {stage !== 'ready' && (
        <View style={[styles.dock, { paddingBottom: insets.bottom + TAB_BAR_CLEARANCE }]}>
          <Pressable
            style={styles.composer}
            onPress={() => router.push('/save')}
            accessibilityRole="button"
            accessibilityLabel="Paste a link to save"
          >
            <Text style={styles.composerText}>Paste a link</Text>
            <Icon name="copy" size={15} color={colors.textPrimary} />
          </Pressable>
        </View>
      )}
    </View>
  );
}

const styles = themed(() => StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.sm,
  },
  menuBtn: {
    width: 36, height: 36,
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: colors.ghostLine,
    alignItems: 'center',
    justifyContent: 'center',
  },

  // Vertically centred rather than top-aligned: with only two blocks on the
  // screen, hanging them off the top leaves a dead lower half.
  body: { flex: 1, justifyContent: 'center', paddingHorizontal: spacing.lg },
  hero: {
    color: colors.textPrimary,
    fontFamily: typeface.display,
    fontSize: font.display,
    lineHeight: font.display * 1.08,
    letterSpacing: tracking.display,
  },
  sub: {
    color: colors.textSecondary,
    fontFamily: typeface.body,
    fontSize: font.md,
    lineHeight: font.md * 1.5,
    marginTop: spacing.md,
    maxWidth: 420,
  },

  retry: {
    alignSelf: 'flex-start',
    marginTop: spacing.lg,
    borderWidth: 1,
    borderColor: colors.textPrimary,
    borderRadius: radius.full,
    paddingVertical: 10,
    paddingHorizontal: spacing.md,
  },
  stale: { marginTop: spacing.md },

  // Wide gaps rather than rules or boxes: the separation is whitespace, which
  // is the only separator this screen uses anywhere else.
  metrics: { flexDirection: 'row', gap: spacing.xl, marginTop: spacing.lg },
  // paddingVertical is the TAP TARGET, not decoration: the number plus its
  // label is ~34pt tall, and 8 either side (plus hitSlop 8 at the call site)
  // clears the 44pt minimum without moving anything on screen.
  metric: { gap: 2, paddingVertical: spacing.sm },
  metricN: {
    color: colors.textPrimary,
    fontFamily: typeface.display,
    fontSize: font.xl,
    letterSpacing: tracking.display,
  },
  tips: { marginTop: spacing.lg, borderBottomWidth: 0 },

  ticks: { flexDirection: 'row', gap: 4, marginTop: spacing.xl },
  tick: { flex: 1, height: 4, borderRadius: radius.full, backgroundColor: colors.ghostLine },
  tickOn: { backgroundColor: colors.textPrimary },

  dock: { paddingHorizontal: spacing.lg, paddingTop: spacing.md },
  composer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    borderWidth: 1,
    borderColor: colors.borderLight,
    borderRadius: radius.full,
    paddingVertical: 14,
    paddingHorizontal: spacing.md + 2,
  },
  composerText: {
    color: colors.textSecondary,
    fontFamily: typeface.body,
    fontSize: font.md,
  },
}));
