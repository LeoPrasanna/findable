import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import {
  View, Text, FlatList, ScrollView, StyleSheet, ActivityIndicator,
  RefreshControl, useWindowDimensions, Platform, Alert,
} from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { api, Reel } from '../services/api';
import { ReelCard, aspectFor } from '../components/ReelCard';
import { SkeletonGrid } from '../components/SkeletonCard';
import { Pressable } from '../components/Pressable';
import { Icon } from '../components/Icon';
import { Landing } from '../components/Landing';
import { Label, Body, Rule, GhostButton, Wordmark, EmptyState } from '../components/kit';
import { hasEnteredLibrary, markEnteredLibrary, claimSaveCeilingWarning } from '../services/sessionFlags';
import { onUi, emitUi } from '../services/uiBus';
import { applyEdits, markDeleted, unmarkDeleted } from '../services/libraryEdits';
import { ASK_MIN_REELS } from '../constants/limits';
import { TAB_BAR_CLEARANCE } from '../components/TabBar';
import { LinearGradient } from 'expo-linear-gradient';
import { RollingTagline } from '../components/RollingTagline';
import { useAuth } from '../contexts/AuthContext';
import { getCachedUsage, onUsage } from '../services/usageCache';
import { saveQuota } from '../services/saveQuota';
import { Avatar } from '../components/Avatar';
import { colors, spacing, font, radius, tracking, typeface, categoryMeta, CATEGORY_OPTIONS, GRID_GAP, columnsForWidth, themed, gradients, hazeLocations } from '../constants/theme';

const CATEGORIES = ['all', ...CATEGORY_OPTIONS];
const PAGE = 24;

/** Category names are stored lowercase; sentence copy needs them capitalised.
 *  Single word by definition (see ALLOWED_CATEGORIES on the backend), so this
 *  does not need to handle spaces. */
const titleCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Module-level so the reference is stable — RollingTagline is memoized and an
 *  inline array would defeat that on every render. */
const LIBRARY_CAPABILITIES = [
  'Summarize any reel you save',
  'Extract cooking recipes, step by step',
  'Build guided workouts with rest timers',
  'Turn a tutorial into a checklist you can tick off',
  'Ask your library — answered from your own saves',
  'Rediscover saves you forgot you had',
];

export default function HomeScreen() {
  // Seeded from the cache so the first paint already knows — a warning that
  // appears a second late reads as a glitch, and this band is load-bearing
  // layout (see the note where it renders).
  const [usage, setUsage] = useState(getCachedUsage);
  useEffect(() => onUsage(setUsage), []);
  const quota = saveQuota(usage?.saves?.used, usage?.saves?.limit);

  /**
   * The last 5% gets said out loud, once per session (owner: a popup at 950).
   *
   * ⚠️ NOT at 900 as well — that one is the line in the band above, and an
   * interruption repeated at two thresholds trains people to dismiss it before
   * reading. This fires where the number has actually become a problem.
   */
  useEffect(() => {
    if (quota.level !== 'critical' && quota.level !== 'full') return;
    if (!claimSaveCeilingWarning()) return;
    const title = quota.level === 'full' ? 'Your library is full' : 'You’re close to the save limit';
    // ⚠️ ONLY THE FREE TIER IS UPSOLD, same rule as the server's 403. Pro has
    // 500 because they bought it and TRIAL has 500 because the trial shows what
    // paying feels like — telling either that "Pro holds 500" offers them the
    // number they are already sitting on, which reads as a bug, not an offer.
    const upsell = usage?.tier === 'free' ? ' Pro holds 500.' : '';
    const body = quota.level === 'full'
      ? `You’ve used all ${quota.limit} saves. Delete a few from your library and saving starts working again — nothing you’ve kept is locked.${upsell}`
      : `${quota.used} of ${quota.limit} saves used, so there’s room for ${quota.remaining} more. Deleting anything you’re done with frees the space straight away.${upsell}`;
    if (Platform.OS === 'web') window.alert(`${title}

${body}`);
    else Alert.alert(title, body);
  }, [quota.level]);
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { profile, displayName } = useAuth();
  const { width } = useWindowDimensions();
  // One copy of the grid math, shared with Rediscover — see columnsForWidth
  // in constants/theme.ts for why it does not live in this file any more.
  const numColumns = columnsForWidth(width);
  const [reels, setReels] = useState<Reel[]>([]);
  // Read by the focus effect below, which must not depend on the list itself.
  const reelsRef = useRef<Reel[]>(reels);
  reelsRef.current = reels;
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [offline, setOffline] = useState(false);
  const [activeCategory, setActiveCategory] = useState('all');
  // Session-scoped (services/sessionFlags): remounts don't bounce back to the
  // landing, but a sign-out/sign-in resets it so new users start at Landing.
  const [entered, setEntered] = useState(hasEnteredLibrary());
  const [scrolled, setScrolled] = useState(false);

  /**
   * ⚠️ A REFRESH MUST NOT SHRINK THE LIST — this used to throw you back to the
   * top mid-scroll, on a timer.
   *
   * It always asked for `limit: PAGE` (24) at `offset: 0` and replaced the
   * whole list with the result. So after scrolling to, say, 100 tiles, ANY
   * refresh collapsed the grid back to 24 — the ScrollView's content shrank
   * under the thumb and the offset clamped, dumping you near the top.
   *
   * That is not a rare path. `load()` runs on screen focus, on `appResumed`,
   * on `libraryState`, on pull-to-refresh — and **every 4 seconds while any
   * summary is pending**, which is exactly when a user is scrolling a library
   * they just added to. Infinite scroll and the poll were fighting: `loadMore`
   * appended 24, the poll threw them away.
   *
   * (It also meant a pending reel below position 24 never got its summary
   * update at all, because the poll only ever re-read the first page.)
   *
   * Now a refresh re-reads AS MANY as are already on screen. Read through the
   * ref, not `reels`, so `load` keeps a stable identity — it sits in the
   * dependency list of the focus effect and of that 4-second interval, and
   * making it change per list change would re-arm both on every fetch.
   */
  const load = useCallback(async (category = activeCategory, reset = false) => {
    try {
      setError('');
      const data = await api.listReels({
        category: category !== 'all' ? category : undefined,
        // Server clamps to 1000 (app/routes/reels.py), so this cannot run away.
        limit: reset ? PAGE : Math.max(PAGE, reelsRef.current.length),
        offset: 0,
      });
      // Reconcile with what this device knows and the server doesn't yet: a
      // delete still in flight, a category just changed. Without this the
      // focus refetch below hands a deleted card straight back.
      setReels(applyEdits(data.items));
      setTotal(data.total);
    } catch (e: any) {
      setError('Could not connect to backend. Make sure the server is running on port 8000.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [activeCategory]);

  const loadMore = useCallback(async () => {
    if (loadingMore || reels.length >= total) return;
    setLoadingMore(true);
    try {
      const data = await api.listReels({
        category: activeCategory !== 'all' ? activeCategory : undefined,
        limit: PAGE,
        offset: reels.length,
      });
      setReels(prev => [...prev, ...applyEdits(data.items)]);
      setTotal(data.total);
    } catch {
      // transient failure
    } finally {
      setLoadingMore(false);
    }
  }, [loadingMore, reels.length, total, activeCategory]);

  /**
   * The tile is gone the instant you let go of the long-press; the request
   * follows.
   *
   * ⚠️ THE SCREEN OWNS THIS, NOT THE CARD. `ReelCard` used to fire the DELETE
   * itself and swallow the error, which meant a failed delete was invisible:
   * the tile vanished, the save survived, and it reappeared at the next refresh
   * with no explanation. A card should not be making API calls — the screen
   * that owns the list is the only thing that can honestly report the outcome.
   */
  const removeReel = useCallback(async (id: string) => {
    markDeleted(id);
    setReels(prev => prev.filter(r => r.id !== id));
    setTotal(t => Math.max(0, t - 1));
    try {
      await api.deleteReel(id);
    } catch (e: any) {
      // Stop hiding it and put it back. Saying so matters more than the tidy
      // animation — the user believes this save is gone.
      unmarkDeleted(id);
      setError(e?.message || "Couldn't delete that save — it's still in your library.");
      load();
    }
  }, [load]);

  useEffect(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return;
    setOffline(!window.navigator.onLine);
    const goOnline = () => setOffline(false);
    const goOffline = () => setOffline(true);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, []);

  /**
   * ⚠️ IT REFRESHES IN PLACE — IT DOES NOT WIPE TO A SKELETON.
   *
   * This was `setLoading(true); load()`, so every return from a reel screen
   * blanked the whole grid to skeleton tiles and rebuilt it. Against a cold
   * Render free instance that is seconds of staring at placeholders instead of
   * the library you already had on screen a moment ago — the single biggest
   * reason the app "feels slow" on the way back from a card.
   *
   * The spinner is only honest when there is nothing to show. With reels in
   * hand the right behaviour is to keep showing them and swap in the fresh list
   * when it lands.
   */
  useFocusEffect(useCallback(() => {
    if (reelsRef.current.length === 0) setLoading(true);
    load();
    // `load` alone: reading the count through a ref keeps this effect from
    // re-firing every time the list changes, which would refetch on its own
    // result.
  }, [load]));

  /**
   * ⚠️ ROUTER FOCUS IS NOT THE ONLY WAY THIS LIST GOES STALE — and until
   * 2026-08-14 it was the only thing that refreshed it. Two ways in:
   *
   *  - `appResumed` (owner report): a reel shared from Instagram while Findable
   *    sat in the background is saved by the native share Activity, which never
   *    enters the JS process at all. Returning to a still-mounted screen fires
   *    no focus event, so the grid kept showing its pre-share list until the
   *    user pulled to refresh — which is exactly what they had to do.
   *  - `libraryState`: Home and Library are the SAME route (`/`), told apart by
   *    a session flag, so switching tabs never blurs this screen. It used to
   *    only re-read the flag; a cold start that sat on Landing while a share
   *    arrived then showed a stale grid on the very first visit.
   *
   * Both refresh in place — `applyEdits` inside `load()` already makes a
   * surprise refetch safe against an in-flight delete, and the `reelsRef` guard
   * above means an existing grid is never blanked to skeletons.
   */
  useEffect(() => {
    if (!entered) return;   // Landing is on screen and does its own refresh.
    return onUi('appResumed', load);
  }, [entered, load]);

  useEffect(() => onUi('libraryState', () => {
    const now = hasEnteredLibrary();
    setEntered(now);
    if (now) load();
  }), [load]);

  /**
   * Poll ONLY the reels that are actually pending — not the whole library.
   *
   * ⚠️ This was `setInterval(() => load(), 4000)`, and it was the most
   * expensive thing on the screen. Three problems, all of them felt as scroll
   * jank while a summary was being written:
   *
   *  1. It refetched and re-parsed the ENTIRE loaded list every 4 seconds. Now
   *     that `load` preserves how far you have scrolled, that would have meant
   *     a 150-object JSON parse on the JS thread every 4 seconds — trading a
   *     scroll-position bug for a frame-rate one.
   *  2. It replaced the whole array, so every tile's element was recreated on
   *     each tick. The memo comparator absorbs that, but it is work done 100+
   *     times to learn that nothing changed.
   *  3. It only ever read the FIRST page, so a pending reel below position 24
   *     never received its summary at all — it just sat there saying "READING"
   *     until you left the screen.
   *
   * One `getReel` per pending id fixes all three. In practice that is a single
   * small request (you rarely have more than one summary in flight), and the
   * patch is applied in place: same length, same order, same aspects, so
   * nothing reflows and only the one card that changed re-renders.
   */
  const pendingKey = reels
    .filter(r => r.summary_status === 'pending')
    .map(r => r.id)
    .join(',');
  useEffect(() => {
    if (!entered || !pendingKey) return;
    const ids = pendingKey.split(',');
    const t = setInterval(async () => {
      const settled = await Promise.all(
        ids.map(id => api.getReel(id).catch(() => null)),
      );
      const done = settled.filter((r): r is Reel => !!r && r.summary_status !== 'pending');
      if (done.length === 0) return;
      setReels(prev => prev.map(r => done.find(d => d.id === r.id) ?? r));
    }, 4000);
    return () => clearInterval(t);
  }, [entered, pendingKey]);

  const onCategoryChange = (cat: string) => {
    setActiveCategory(cat);
    setLoading(true);
    // `reset` — a different category starts at page one. Without it the new
    // category would be fetched at the OLD one's length, which is neither
    // correct pagination nor a page size anyone asked for.
    load(cat, true);
  };

  // ⚠️ A local `goHome()` used to live here for a header Home button that round
  // five removed. Going home is now the tab bar's job — TabBar.tsx and
  // HomeButton.tsx both call `clearEnteredLibrary()` and emit `libraryState`,
  // which the subscription above turns into `setEntered(false)`. Do not add a
  // second copy of that logic here.

  /**
   * Distribute tiles into columns, shortest-column-first.
   *
   * Running height is tracked in WIDTH-UNITS: a tile of aspect 0.75 is 1/0.75
   * columns TALL. (An earlier version added `aspect` instead of its reciprocal,
   * which inverted the comparison — the tiles it thought were tallest were
   * actually the shortest, so the columns drifted badly out of level.) Ordering
   * within a column stays newest-first, which is what the user expects; only
   * the column assignment is height-driven.
   */
  const mosaic = useMemo(() => {
    const cols: { reel: Reel; aspect: number; idx: number }[][] =
      Array.from({ length: numColumns }, () => []);
    const heights = new Array(numColumns).fill(0);
    reels.forEach((reel, idx) => {
      const aspect = aspectFor(reel);
      let shortest = 0;
      for (let i = 1; i < numColumns; i++) if (heights[i] < heights[shortest]) shortest = i;
      cols[shortest].push({ reel, aspect, idx });
      heights[shortest] += 1 / aspect;   // height in width-units
    });
    return cols;
  }, [reels, numColumns]);

  if (!entered) {
    // ⚠️ `emitUi('libraryState')` IS LOAD-BEARING, not a tidy-up. The tab bar
    // tells Home from Library by a session flag, never by the pathname (they
    // share `/`), so nothing re-renders it when the flag flips — it re-reads
    // only on this event. Without it, tapping the home screen's "Saved" counter
    // shows the library while the tab bar's indicator stays lit on Home. Same
    // pairing TabBar.go() uses for its own Home/Library switch.
    return (
      <Landing
        onEnter={() => { markEnteredLibrary(); setEntered(true); emitUi('libraryState'); }}
      />
    );
  }

  return (
    <View style={styles.container}>
      {/* Nocturnal Dimension haze — the screen-root atmosphere. Rendered ONCE
          here, never per-card, and non-interactive so it cannot eat a tap.
          No blur anywhere: this is a single GPU draw on web/Android too. */}
      <LinearGradient
        colors={gradients.haze}
        locations={hazeLocations}
        style={[StyleSheet.absoluteFill, { pointerEvents: 'none' }]}
      />
      {/* ── Header ───────────────────────────────────────────────────────────
          Identity, a count, and the hamburger the owner wants on every page.
          Home and Save used to live here too; both are tabs now. No logo mark,
          no gradient, no shadow — the header is metadata about the sheet below
          it and speaks in the same small tracked voice. */}
      <View style={[styles.header, { paddingTop: insets.top + spacing.sm }]}>
        {/* The face, and it is a control: tapping it opens the same profile
            panel as the hamburger. An avatar that looks tappable and isn't is
            the more annoying option, and this is where every other app puts
            the way into your account. */}
        <Pressable
          style={styles.hAvatar}
          onPress={() => emitUi('openProfile')}
          accessibilityLabel="Your profile"
        >
          <Avatar value={profile.avatar} size={34} iconSize={18} />
        </Pressable>
        <View style={styles.brandRow}>
          <Wordmark size={22} />
          {/* displayName is already nickname > first name > a name derived from
              the email, so this needs no fallback logic of its own. */}
          <Label style={styles.count} numberOfLines={1}>
            {displayName} · {total > 0 ? `${total} saved` : 'nothing saved yet'}
          </Label>
        </View>
        {/* ⚠️ An ICON, not the search field that used to live under this header.
            That field was removed on purpose (owner, 2026-08-09) and replaced
            by the rolling capability line below; putting it back would undo
            that decision. A 36px button costs the layout nothing and keeps
            search one tap away — which is the half the old removal got wrong,
            since search is free (no AI, no quota) and was the only way to find
            a save by name. */}
        <Pressable style={styles.hBtn} onPress={() => router.push('/search')} accessibilityLabel="Search your library">
          <Icon name="search" size={17} color={colors.textPrimary} />
        </Pressable>
        <Pressable style={styles.hBtn} onPress={() => emitUi('openProfile')} accessibilityLabel="Menu">
          <Icon name="menu" size={17} color={colors.textPrimary} />
        </Pressable>
      </View>

      {/* The search field used to sit here. Replaced (owner, 2026-08-09) with a
          rolling list of what the library can actually do for a save, and that
          stands — search came back on 2026-08-14 as its own screen behind the
          icon above, not as a field competing with this row.
          ⚠️ It is CLIENT-SIDE now (`services/librarySearch.ts`, a TypeScript
          port of the deleted `backend/app/services/search.py`): search fires
          per keystroke, and the server it used to call is a free instance with
          a ~50 s cold start. Category bubbles still narrow the grid. */}
      {/* ⚠️ THE QUOTA WARNING TAKES THIS SLOT, it does not sit above it. The
          roll and the warning are the same 42px band by design: stacking them
          would push the whole grid down by a row the moment someone crosses
          900 saves, and a layout that shifts under you is a worse way to learn
          about a limit than the sentence itself. The roll is a nice-to-have;
          "you have room for 37 more" is not, so it wins the slot. */}
      {quota.level === 'ok' ? (
        <RollingTagline
          compact
          shuffle
          lines={LIBRARY_CAPABILITIES}
          style={styles.capabilityRoll}
          numberOfLines={1}
        />
      ) : (
        <View style={styles.capabilityRoll}>
          <Text
            style={[styles.quotaLine, quota.level !== 'warn' && styles.quotaLineHot]}
            numberOfLines={1}
          >
            {quota.message}
          </Text>
        </View>
      )}
      {/* ⚠️ A full-bleed <Rule/> used to sit here, directly under the roll's own
          inset bottom hairline — two rules, 1px apart, at different widths.
          Removed (owner, 2026-08-10); the roll keeps its own line and its 42px
          footprint, so the grid below does not shift. */}

      {/* ── Category filter ──────────────────────────────────────────────────
          Round icon bubbles with the name beneath, mirroring the reference
          app's avatar row (owner direction, 2026-08-01). `radius.circle` is the
          ONLY sanctioned circle in the system — see constants/theme.ts.
          Selection is an inversion (filled bubble, canvas-coloured icon), the
          same emphasis grammar the primary button uses. */}
      <FlatList
        horizontal
        data={CATEGORIES}
        keyExtractor={c => c}
        showsHorizontalScrollIndicator={false}
        style={styles.catList}
        contentContainerStyle={styles.catContent}
        renderItem={({ item }) => {
          const active = activeCategory === item;
          const meta = categoryMeta[item] ?? categoryMeta.other;
          return (
            <Pressable
              style={styles.cat}
              onPress={() => onCategoryChange(item)}
              accessibilityLabel={`${item}${active ? ', selected' : ''}`}
            >
              <View style={[styles.catBubble, active && styles.catBubbleOn]}>
                <Icon
                  name={meta.icon}
                  size={20}
                  color={active ? colors.background : colors.textSecondary}
                />
              </View>
              <Label tone={active ? 'ink' : 'muted'} numberOfLines={1} style={styles.catName}>
                {item}
              </Label>
            </Pressable>
          );
        }}
      />
      <Rule style={scrolled ? undefined : styles.ruleHidden} />

      {/* ── Content ─────────────────────────────────────────────────────────── */}
      {loading ? (
        <SkeletonGrid columns={numColumns} rows={3} />
      ) : error && reels.length === 0 ? (
        <EmptyState kicker="Offline" title="Can't reach the server" body={error}>
          <GhostButton label="Retry" onPress={() => { setLoading(true); load(); }} style={styles.emptyCta} />
        </EmptyState>
      ) : reels.length === 0 ? (
        <EmptyState
          kicker="Empty sheet"
          /* ⚠️ `titleCase`, not the raw value. The category bubbles render
             through `Label`, which uppercases — so the filter read FITNESS
             while this line read "Nothing in fitness", lowercase, inside the
             system's largest display type. Same word, two casings, one screen
             apart. */
          title={activeCategory === 'all'
            ? 'Nothing saved yet'
            : `Nothing in ${titleCase(activeCategory)}`}
          body={activeCategory === 'all'
            ? 'Save your first link and the summary appears in seconds.'
            : 'Saves you expected here may be filed under a different category.'}
        >
          {activeCategory === 'all' ? (
            <GhostButton label="Save your first link" trailing="→" onPress={() => router.push('/save')} style={styles.emptyCta} />
          ) : (
            <GhostButton label="Show all categories" onPress={() => onCategoryChange('all')} style={styles.emptyCta} />
          )}
        </EmptyState>
      ) : (
        <>
        {(offline || error) && (
          <Pressable style={styles.banner} onPress={() => { setLoading(true); load(); }}>
            <Icon name="alert-circle" size={13} color={colors.background} />
            <Text style={styles.bannerText}>
              {offline ? "OFFLINE — CHANGES MAY NOT SAVE" : "COULDN'T REFRESH — TAP TO RETRY"}
            </Text>
          </Pressable>
        )}
        {/* ── The mosaic ───────────────────────────────────────────────────
            Tiles are staggered, not aligned into rows: each one goes to
            whichever column is currently shortest, so neighbours sit at
            different heights the way a real contact sheet does.

            ponytail: a ScrollView, not a FlatList — EVERY loaded tile is
            mounted, so the native view count grows with the library (roughly a
            dozen views per card: frame, pressable, image, scrim, overlay,
            three texts). `removeClippedSubviews` below is what keeps that
            affordable; it is load-bearing, not a micro-optimisation.

            ⚠️ AN EARLIER VERSION OF THIS NOTE CLAIMED VIRTUALIZATION WAS
            IMPOSSIBLE HERE — "masonry and row virtualization are incompatible
            without measuring every tile". That is no longer true, and it would
            have sent the next person down the wrong road. Tile geometry in this
            grid is fully DETERMINISTIC before layout: `aspectFor(reel)` hashes
            the id, and the column width comes from `columnsForWidth(width)`. So
            every tile's exact height and y-offset is computable without
            measuring anything. If this ever needs windowing, that is the
            opening — not a third-party grid.

            It is still not worth doing yet: the screen paginates 24 at a time,
            and nothing has been profiled on a real device. Do that first. */}
        <ScrollView
          style={styles.grid}
          contentContainerStyle={styles.list}
          showsVerticalScrollIndicator={false}
          scrollEventThrottle={32}
          /* ⚠️ `removeClippedSubviews` WAS HERE AND WAS REMOVED (2026-08-16).
             It was added the same day, on Android only, to detach off-screen
             tiles from the native hierarchy — and the note justifying it also
             admitted the prop "blanks content in exactly this shape" on iOS,
             a nested column layout. Hours later the owner reported the phone
             grid mangled. It is not proven to be the cause (the frame's
             flex/aspectRatio conflict is the other suspect and was fixed in
             the same change), but it bought a scroll improvement that was
             explicitly "reasoned, not observed" — no FPS number was ever
             claimed for it. Unmeasured gain, live visual regression: it goes.
             Put it back only behind a Performance Monitor reading that shows
             the native view count actually hurting. */
          onScroll={e => {
            const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
            setScrolled(contentOffset.y > 4);
            // FlatList's onEndReached, by hand: fire once we're within a
            // screen-and-a-half of the bottom.
            const nearBottom =
              contentOffset.y + layoutMeasurement.height >= contentSize.height - layoutMeasurement.height * 1.5;
            if (nearBottom) loadMore();
          }}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => { setRefreshing(true); load(); }}
              tintColor={colors.textSecondary}
              colors={[colors.textPrimary]}
              progressBackgroundColor={colors.card}
            />
          }
        >
          <View style={styles.masonry}>
            {mosaic.map((col, ci) => (
              <View key={ci} style={styles.column}>
                {col.map(({ reel, aspect, idx }) => (
                  <ReelCard
                    key={reel.id}
                    reel={reel}
                    index={idx}
                    aspect={aspect}
                    onDelete={removeReel}
                  />
                ))}
              </View>
            ))}
          </View>
          {loadingMore && <ActivityIndicator color={colors.textPrimary} style={{ marginVertical: spacing.md }} />}
          <Body style={styles.disclaimer}>
            Summaries are generated by AI and may be wrong or have gaps — edit them and add your
            own notes freely. Saved content belongs to its original creators.
          </Body>
        </ScrollView>
        </>
      )}

    </View>
  );
}

const styles = themed(() => StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },

  header: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.sm,
    gap: spacing.md,
  },
  // minWidth:0 is load-bearing: without it a long nickname pushes the menu
  // button off the right edge instead of ellipsizing inside its own column.
  brandRow: { flex: 1, minWidth: 0, gap: 2 },
  count: { marginBottom: 2 },
  hAvatar: {
    width: 40, height: 40,
    borderWidth: 1,
    borderColor: colors.ghostLine,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  // Square hairline. No fill, no radius, no shadow.
  hBtn: {
    width: 36, height: 36,
    borderWidth: 1,
    borderColor: colors.ghostLine,
    alignItems: 'center',
    justifyContent: 'center',
  },

  catList: { flexGrow: 0 },
  catContent: { paddingHorizontal: spacing.md, gap: spacing.md, alignItems: 'flex-start' },
  cat: { alignItems: 'center', gap: spacing.sm, paddingVertical: spacing.md, width: 62 },
  // The system's one circle (radius.circle). Selection inverts rather than
  // tinting — there is no accent hue to tint with.
  catBubble: {
    width: 52, height: 52,
    borderRadius: radius.circle,
    borderWidth: 1,
    borderColor: colors.ghostLine,
    alignItems: 'center',
    justifyContent: 'center',
  },
  catBubbleOn: { backgroundColor: colors.textPrimary, borderColor: colors.textPrimary },
  catName: { textAlign: 'center', width: '100%' },
  ruleHidden: { backgroundColor: 'transparent' },

  banner: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm,
    backgroundColor: colors.textPrimary, paddingVertical: spacing.sm, paddingHorizontal: spacing.md,
  },
  bannerText: {
    color: colors.background,
    fontFamily: typeface.label,
    fontSize: font.xs,
    letterSpacing: tracking.label,
  },

  grid: { flex: 1 },
  // ⚠️ GRID_GAP is used for BOTH the column gap and the page's own side padding,
  // so the space at the screen edge matches the space between tiles. A gutter in
  // the middle with none at the edges reads as a mistake.
  masonry: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: GRID_GAP,
    paddingHorizontal: GRID_GAP,
  },
  // minWidth:0 is load-bearing on react-native-web — without it a long title
  // inside a tile can push its column wider than its share.
  column: { flex: 1, minWidth: 0, gap: GRID_GAP },
  // Clears the floating tab bar (its own height + the safe-area inset it adds).
  list: { paddingTop: GRID_GAP, paddingBottom: TAB_BAR_CLEARANCE + spacing.xl },
  disclaimer: {
    fontSize: font.sm,
    lineHeight: 19,
    textAlign: 'center',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.xl,
    // ⚠️ PROSE GETS A MEASURE; THE GRID STAYS FULL-BLEED. Without this cap a
    // 1366pt iPad renders this as ONE centred line of ~170 characters, which is
    // unreadable and is a real part of "messy on tablet". `emptyText` above
    // already caps at 380 — this was the one text block that didn't.
    // The grid itself is deliberately NOT capped (the primary style reference
    // is explicit: full-bleed, no max-width container).
    maxWidth: 560,
    alignSelf: 'center',
  },
  emptyCta: { marginTop: spacing.sm, alignSelf: 'stretch', maxWidth: 320 },

  // Keeps the exact footprint the search row occupied, so the grid below does
  // not shift.
  capabilityRoll: {
    marginHorizontal: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.ghostLine,
    height: 42,
    marginBottom: spacing.sm,
    justifyContent: 'center',
  },
  // Same band, same weight as the roll it replaces — this is information, not
  // an alarm. Only the last 5% turns the colour up.
  quotaLine: {
    fontFamily: typeface.body,
    fontSize: font.sm,
    color: colors.textSecondary,
  },
  quotaLineHot: { color: colors.danger },
}));
