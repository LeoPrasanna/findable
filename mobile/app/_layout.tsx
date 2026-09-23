import * as Sentry from '@sentry/react-native';
import { useEffect, useRef, useState } from 'react';
import { Stack } from 'expo-router/stack';
import { useRouter, usePathname } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { View, StyleSheet, Platform, BackHandler, AppState, Linking } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ShareIntentProvider, useShareIntentContext } from 'expo-share-intent';
import * as Notifications from 'expo-notifications';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  useFonts, Inter_400Regular, Inter_500Medium, Inter_600SemiBold,
} from '@expo-google-fonts/inter';
import { HeaderMenuButton } from '../components/HomeButton';
import { MascotLoader } from '../components/MascotLoader';
import { saveSharedLink } from '../services/shareSave';
import { LoginScreen } from '../components/LoginScreen';
import { Confetti } from '../components/Confetti';
import { TabBar } from '../components/TabBar';
import { ProfilePanel } from '../components/ProfilePanel';
import { AuthProvider, useAuth } from '../contexts/AuthContext';
import { retryShareKeyIfNeeded } from '../services/shareKey';
import { reelIdFromUrl, reelIdFromNotificationData, reelPath } from '../services/deepLink';
import { OnboardingModal } from '../components/OnboardingModal';
import { WelcomeBack } from '../components/WelcomeBack';
import { onUi, emitUi, useDismissOnBackground } from '../services/uiBus';
import { consumeReopenPanel } from '../services/sessionFlags';
import { refreshUsage } from '../services/usageCache';
import {
  colors, font, typeface, themed, onSchemeChange, setScheme, isDark, SCHEME_STORAGE_KEY,
} from '../constants/theme';

/** Screen titles are tracked uppercase labels, not headline type — the nav is
 *  metadata, and metadata speaks in the small voice. */
const headerTitle = (t: string) => t.toUpperCase();

function AppStack() {
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: colors.background },
        headerTintColor: colors.textPrimary,
        // No letterSpacing here — react-navigation's headerTitleStyle only
        // accepts fontFamily/fontSize/fontWeight/color. The tracking that the
        // rest of the system carries has to come from the title text itself,
        // which is why these are pre-uppercased instead.
        headerTitleStyle: {
          fontFamily: typeface.label,
          fontSize: font.xs,
          color: colors.textSecondary,
        },
        headerShadowVisible: false,
        /**
         * ⚠️ WITHOUT THIS, iOS LABELS EVERY BACK BUTTON WITH THE ROUTE'S
         * FILENAME — the owner saw "‹ index" on the search screen.
         *
         * react-navigation defaults the back label to the previous screen's
         * title, and index.tsx sets `headerShown: false`, so it has no title
         * to borrow and falls through to the route name. Naming the file is a
         * leak of the codebase into the product. 'minimal' shows the chevron
         * alone, which is also what every stack here wants anyway.
         */
        headerBackButtonDisplayMode: 'minimal',
        // Hamburger on every stack route — the owner's requirement that it be
        // reachable everywhere. It was a Home button; Home is a tab now.
        headerRight: () => <HeaderMenuButton />,
        contentStyle: { backgroundColor: colors.background },
      }}
    >
      <Stack.Screen name="index" options={{ headerShown: false }} />
      {/* The OAuth deep-link landing route. headerShown:false so the redirect
          through it never flashes a header + hamburger. See auth/callback.tsx
          for why the route has to exist at all. */}
      <Stack.Screen name="auth/callback" options={{ headerShown: false }} />
      <Stack.Screen name="landing" options={{ headerShown: false }} />
      <Stack.Screen name="save" options={{ title: headerTitle('Save'), presentation: 'modal' }} />
      <Stack.Screen name="ask" options={{ title: headerTitle('Ask your library') }} />
      {/* Search is the free sibling of Ask — no AI, no quota, works offline. */}
      <Stack.Screen name="search" options={{ title: headerTitle('Search your library') }} />
      <Stack.Screen name="rediscover" options={{ title: headerTitle('Rediscover') }} />
      {/* Title stays blank — the screen's own hero is the title. */}
      <Stack.Screen name="todos" options={{ title: '' }} />
      <Stack.Screen name="help" options={{ title: headerTitle('What you can do') }} />
      <Stack.Screen name="support" options={{ title: headerTitle('Support') }} />
      <Stack.Screen name="profile" options={{ title: headerTitle('Profile') }} />
      {/* Appearance is not a route — it's three inline words in ProfilePanel.
          A whole screen for one three-way choice was never worth the tap. */}
      {/* The paywall owns its whole surface — no nav chrome competing with it. */}
      <Stack.Screen name="pro" options={{ headerShown: false, presentation: 'modal' }} />
      <Stack.Screen name="reel/[id]" options={{ title: '' }} />
      <Stack.Screen name="workout/[reelId]" options={{ title: headerTitle('Workout') }} />
      <Stack.Screen name="workout/session/[reelId]" options={{ title: '', headerShown: false }} />
    </Stack>
  );
}

/**
 * The one profile panel, owned by the root.
 *
 * Opened from any screen's hamburger via the ui bus. `reels` is empty on purpose
 * — the panel prefers the server's own whole-library counts from `getUsage()`
 * and only falls back to a passed-in sample, which was always an undercount
 * anyway (it was whatever page happened to be loaded).
 */
function AppProfilePanel() {
  // Reopens itself after a scheme switch remounts the tree (one-shot flag).
  const [open, setOpen] = useState(consumeReopenPanel);
  useEffect(() => onUi('openProfile', () => setOpen(true)), []);
  // Leaving the app — a share, or just switching to Instagram — closes it. See
  // the note on `dismissOverlays` in services/uiBus.ts for why the share
  // overlay cannot simply cover it.
  useDismissOnBackground(() => setOpen(false));
  return <ProfilePanel visible={open} onClose={() => setOpen(false)} reels={[]} />;
}

/**
 * SHARE-TO-SAVEHERE — the Android/iOS share sheet entry point.
 *
 * ⚠️ Why this needed a native module at all. Android delivers a share as an
 * `ACTION_SEND` Intent carrying `EXTRA_TEXT`; that is NOT a deep link, so
 * `Linking.getInitialURL()` and expo-router never see it. Declaring
 * `intentFilters` in app.json alone would have put Findable in the share sheet
 * and then opened it with nothing attached — visible, and broken. Reading the
 * extra requires native code, which is what `expo-share-intent` supplies.
 *
 * Mounted INSIDE the signed-in branch on purpose: a share that arrives while
 * signed out would otherwise navigate to /save behind the login gate and be
 * lost when the user finally signs in.
 *
 * ⚠️ This only works in a real build. Expo Go cannot load the native module,
 * and an OTA update cannot add one — the share sheet entry appears only after
 * the next EAS build is installed.
 */
function ShareIntentHandler() {
  const router = useRouter();
  const { hasShareIntent, shareIntent, resetShareIntent } = useShareIntentContext();
  const [saving, setSaving] = useState(false);

  /**
   * ⚠️ EVERY URL IS HANDLED AT MOST ONCE PER PROCESS.
   *
   * Owner report, 2026-08-12: sharing returned you to Instagram, but opening
   * Findable afterwards re-ran the share — landing you back on the platform or
   * on Home instead of the app you asked for.
   *
   * `resetShareIntent()` alone is not enough here, and the reason is specific
   * to what we do next: `BackHandler.exitApp()` finishes the activity while
   * the process may survive, so the reset can be torn down before the native
   * module has durably cleared it. The next launch then reads the SAME intent
   * and re-fires — a second save, a second notification, and a navigation the
   * user never asked for.
   *
   * A ref, not state: it must be readable synchronously inside this effect and
   * must not itself trigger a render.
   */
  const handled = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!hasShareIntent) return;

    /**
     * ⚠️ CLEAR THE SCREEN FIRST, BEFORE ANY EARLY RETURN (owner report,
     * 2026-08-13: sharing while the profile panel was open showed the panel,
     * not the save).
     *
     * The overlay below cannot solve this. Every one of these surfaces renders
     * inside a `Modal`, which on both platforms is its OWN window — an
     * absolutely positioned sibling View is in a different window and can never
     * paint over it, whatever its zIndex. So they have to be told to go away.
     *
     * ⚠️ It emits HERE, not after the URL and dedup guards below it. Those
     * return early for a photo share and for a re-delivered intent — and a
     * re-delivered intent on foreground is explicitly expected (see the note on
     * `handled`), so the old placement left the panel on screen in exactly the
     * cases the user was most likely to hit.
     */
    emitUi('dismissOverlays');

    // Instagram and YouTube share a bare URL; some apps share "Look at this
    // <url>" or append a title, so fall back to plucking the first URL out of
    // the text rather than refusing anything that isn't exactly a link.
    const raw = shareIntent?.webUrl || shareIntent?.text || '';
    const url = raw.match(/https?:\/\/\S+/)?.[0];
    // Reset FIRST. The native module holds the payload until it is cleared, so
    // an early return on a non-URL share (a photo, a plain note) must still
    // clear it — otherwise the same dead intent re-fires on every foreground.
    resetShareIntent();
    if (!url) return;
    // Re-delivery of an intent we have already acted on. Silently ignored: the
    // save happened, and the honest thing is to leave the user wherever they
    // deliberately navigated rather than hijack the screen a second time.
    if (handled.current.has(url)) return;
    handled.current.add(url);

    /**
     * ⚠️ SAVES IN THE BACKGROUND — IT DOES NOT OPEN THE SAVE SCREEN.
     *
     * A share is an interruption of something else: you are mid-scroll in
     * Instagram, you want the reel kept, you want to carry on scrolling.
     * Routing to /save and making you watch a progress screen breaks exactly
     * the flow this feature exists to protect (owner, 2026-08-12). There is
     * nothing to decide — the URL is known, the save is unconditional, and the
     * summary was always asynchronous.
     *
     * On success we hand control straight back to the app you came from.
     * `exitApp` finishes OUR activity, which returns you to Instagram; it is
     * only ever reached on a share, never on a normal launch.
     *
     * On FAILURE we deliberately stay open. A notification already said what
     * went wrong, but bouncing someone out of a failed save is how a link gets
     * quietly lost.
     */
    setSaving(true);
    saveSharedLink(url).then(ok => {
      setSaving(false);
      // The library just gained a card that no screen knows about. On Android
      // we leave immediately and `appResumed` will fire on the way back in, but
      // on iOS/web the user stays here — same staleness, no lifecycle event to
      // catch it. One signal covers both.
      if (ok) emitUi('appResumed');
      if (ok && Platform.OS === 'android') BackHandler.exitApp();
      else if (!ok) router.push({ pathname: '/save', params: { url } });
    });
  }, [hasShareIntent, shareIntent, router, resetShareIntent]);

  // Android still LAUNCHES the app to deliver ACTION_SEND (Phase B removes
  // that with a translucent activity), so there is a brief flash either way.
  // Better it says what is happening than shows a blank canvas.
  if (!saving) return null;
  return (
    <View style={styles.shareOverlay}>
      <MascotLoader label="Saving to your library" />
    </View>
  );
}

/**
 * ⚠️ EVERY LINK AND EVERY TAP IS HANDLED AT MOST ONCE PER PROCESS — and these
 * sets are MODULE-level, not refs.
 *
 * Changing the colour scheme bumps `schemeEpoch`, which remounts this entire
 * subtree. A ref would come back empty while `getInitialURL()` still returns
 * the launch URL and `useLastNotificationResponse()` still returns the tap
 * that started the app — so switching to dark mode would throw the user back
 * onto a reel they had already navigated away from. Module scope outlives the
 * remount, which is exactly the lifetime this guard needs.
 */
const handledLinks = new Set<string>();
const handledTaps = new Set<string>();

/**
 * Open a saved reel, unless we are already standing on it.
 *
 * The guard matters because the router may have routed there itself:
 * expo-router consumes the launch URL through its own linking config, and the
 * handlers below also replay it (they have to — see DeepLinkHandler). Without
 * this, both fire and the detail screen is pushed twice, so the back gesture
 * needs two goes to leave one screen.
 *
 * `reelIdFromUrl` reads `usePathname()`'s output as happily as it reads a
 * `savehere://` URL, so "where the link points" and "where we are" compare
 * through one function rather than two spellings that can drift.
 */
function openReel(
  router: ReturnType<typeof useRouter>,
  here: string,
  id: string,
) {
  if (reelIdFromUrl(here) === id) return;
  router.push(reelPath(id) as any);
}

/**
 * DEEP LINKS — `savehere://reel/<id>` opens that saved card.
 *
 * ⚠️ MOUNTED INSIDE THE SIGNED-IN BRANCH, like ShareIntentHandler and for the
 * same reason: `AppStack` does not exist while the login gate is up, so a push
 * issued then goes nowhere. On a cold start that is the NORMAL case rather
 * than an edge one — AuthProvider restores the session asynchronously, so
 * every deep-link launch spends its first frames on the spinner. Reading
 * `getInitialURL()` here, once there is somewhere to send the user, is what
 * replays the link instead of losing it.
 *
 * ⚠️ The gap this leaves, knowingly: a link arriving while the LOGIN screen is
 * up and stays up is missed — nothing is mounted to hear the `url` event, and
 * `getInitialURL()` only ever reports the launch. It degrades to "the app
 * comes to the front", which is what tapping the icon does anyway.
 *
 * Everything this does NOT recognise is left alone, and that is load-bearing:
 * `savehere://auth/callback` is the OAuth redirect for Google and Apple, and
 * on Android Google is the only door into the app. See `services/deepLink.ts`
 * and the same contract in `app/+native-intent.ts`.
 */
function DeepLinkHandler() {
  const router = useRouter();
  const pathname = usePathname();
  // A ref, not a dependency: `openReel` needs the CURRENT route at call time,
  // and putting pathname in the deps would tear down and re-register the url
  // listener on every navigation in the app.
  const here = useRef(pathname);
  here.current = pathname;

  useEffect(() => {
    let cancelled = false;

    const handle = (url: string | null | undefined) => {
      if (cancelled || typeof url !== 'string') return;
      const id = reelIdFromUrl(url);
      if (!id || handledLinks.has(url)) return;
      handledLinks.add(url);
      openReel(router, here.current, id);
    };

    // Cold start: the URL the app was launched with. Still set on a launch
    // that went through the login screen first, which is the point.
    Linking.getInitialURL().then(handle).catch(() => {});
    // Warm: a link that arrives while we are already running.
    const sub = Linking.addEventListener('url', e => handle(e.url));
    return () => { cancelled = true; sub.remove(); };
  }, [router]);

  return null;
}

/**
 * NOTIFICATION TAPS — the save receipt becomes a door.
 *
 * A background share posts "Saved from Instagram" and hands the user straight
 * back to Instagram. Tapping that notification used to open Findable on Home,
 * which is a dead end: the one card they wanted is somewhere in a masonry
 * grid, and the notification knew its id the whole time.
 * `services/shareSave.ts` now puts that id in the payload; this reads it.
 *
 * ⚠️ IT DOES NOT AUTO-OPEN ON A SHARE, and must not. Staying inside the app
 * you shared FROM is the entire point of the invisible share (owner,
 * 2026-08-12; verified on device 2026-09-13), so the notification is an
 * INVITATION, taken only if the user taps it. Anything that opens the detail
 * screen on its own undoes the feature this one decorates.
 *
 * ⚠️ MOUNTED ON NATIVE ONLY, AND NOT VIA A `Platform.OS` CHECK INSIDE THE HOOK.
 * `useLastNotificationResponse()` calls `getLastNotificationResponse()` from a
 * layout effect, and on web that resolves to expo-notifications' stub emitter
 * module, which has no such method and THROWS `UnavailabilityError` — at the
 * root of the tree, on mount. A hook cannot be called conditionally, so the
 * COMPONENT is the thing that is conditional. `Platform.OS` never changes
 * within a process, so this either always mounts or never does.
 */
function NotificationTapHandler() {
  const router = useRouter();
  const pathname = usePathname();
  const here = useRef(pathname);
  here.current = pathname;

  // Covers cold start AND warm: the hook seeds itself from the response that
  // launched the app, then follows the listener for taps after that.
  const response = Notifications.useLastNotificationResponse();

  useEffect(() => {
    if (!response) return;
    // A tap on the notification body, not on an action button. We register no
    // actions today, so this is guarding against one added later quietly
    // inheriting "open the reel".
    if (response.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) return;

    const key = response.notification.request.identifier;
    if (handledTaps.has(key)) return;

    const id = reelIdFromNotificationData(response.notification.request.content.data);
    // No id means a receipt posted before this shipped, or a FAILED save,
    // which has no card to open. Bringing the app to the front is the whole of
    // the correct behaviour there — and the OS has already done it.
    if (!id) return;

    handledTaps.add(key);
    openReel(router, here.current, id);
  }, [response, router]);

  return null;
}

// Gate the whole app on auth: spinner during the initial session check, the login
// screen when signed out, the app once a session exists. LoginScreen doesn't
// navigate — AuthProvider's listener flips this gate on sign-in/out.
function Gate() {
  const { session, loading, celebrate } = useAuth();
  // One family, three weights — Inter carries the wordmark, headings, body and
  // labels alike (see constants/theme.ts). We don't block the gate on them; RN
  // falls back to the system face, which is metrically close enough that there
  // is no layout jump when they land.
  useFonts({ Inter_400Regular, Inter_500Medium, Inter_600SemiBold });

  // Scheme switching: bumping the epoch remounts the navigator so every screen
  // re-renders against the freshly regenerated themed() sheets — instant, no
  // page reload. On web the current route survives (it's URL-driven).
  const [schemeEpoch, setSchemeEpoch] = useState(0);
  useEffect(() => onSchemeChange(() => setSchemeEpoch(e => e + 1)), []);

  /**
   * ⚠️ THE APP'S ONLY LIFECYCLE LISTENER. There was none at all before
   * 2026-08-14, and its absence is the single root cause of two owner reports:
   *
   *  - a reel shared into Findable while it sat in the background never showed
   *    up in the library until a manual pull-to-refresh. The native share
   *    Activity saves without ever entering the JS process, and coming back to
   *    a still-running app is NOT a router focus event — so `useFocusEffect`,
   *    which is every screen's only refresh trigger, never fires.
   *  - the profile panel (or a to-do sheet, or the category picker) was still
   *    open on return, because nothing ever told them the app had gone away.
   *
   * One subscription, two signals, and every screen and overlay subscribes to
   * the one it cares about — rather than N screens each growing their own
   * lifecycle handling and drifting.
   *
   * ⚠️ Dismiss on 'background' ONLY, never 'inactive'. iOS emits 'inactive' for
   * transient interruptions — pulling down the notification shade, the app
   * switcher preview — and closing someone's half-typed to-do because they
   * glanced at a notification would be a worse bug than the one being fixed.
   */
  useEffect(() => {
    const sub = AppState.addEventListener('change', state => {
      if (state === 'background') { emitUi('dismissOverlays'); return; }
      if (state !== 'active') return;
      emitUi('appResumed');
      // The daily AI quota may have reset while the app was away, and every
      // "you're out of AI actions" message in the app reads from this cache.
      if (session) refreshUsage();
      // ⚠️ AND RE-ARM THE INVISIBLE SHARE. Minting runs at launch, which is
      // exactly when a cold Render instance is least likely to answer — and it
      // used to fail silently and never try again, so the share fell back to
      // opening the app for the rest of the session. A no-op once armed.
      if (session) retryShareKeyIfNeeded();
    });
    // ⚠️ Optional call, not `sub.remove()`. react-native-web's AppState returns
    // UNDEFINED when `document.visibilityState` is unavailable (static render,
    // an ancient browser) — an unguarded cleanup would throw at the root of the
    // tree, which is the worst possible place for it. On web the mapping is
    // document visibility, so switching browser tabs counts as leaving; that is
    // the right reading of "the app went away".
    return () => sub?.remove();
  }, [session]);

  // Native boot: localStorage isn't readable at module init there, so apply the
  // stored preference right after mount (one default-scheme first frame).
  useEffect(() => {
    if (Platform.OS === 'web') return;
    AsyncStorage.getItem(SCHEME_STORAGE_KEY)
      .then(k => { if (k === 'light' || k === 'dark' || k === 'system') setScheme(k, { persist: false }); })
      .catch(() => {});
  }, []);

  return (
    <>
      {/* Keyed on the scheme epoch too: the bar's own colour has to flip with
          the canvas, and `style` is read at mount.
          ⚠️ The key is PREFIXED. Sibling keys share one namespace, so a bare
          `key={schemeEpoch}` here collided with the gate's below — both were
          "0" and React warned about duplicate children on every render. */}
      <StatusBar key={`bar-${schemeEpoch}`} style={isDark() ? 'light' : 'dark'} />
      {loading ? (
        // MascotLoader holds off for 350ms before drawing anything, so a warm
        // start shows no loader at all rather than a flash of one — which is
        // also the cheapest "make it faster" there is.
        <View style={styles.center}><MascotLoader /></View>
      ) : session ? (
        <>
          <AppStack key={`app-${schemeEpoch}`} />
          {/* The app chrome lives ABOVE the router so it is identical on every
              route and cannot drift between them: the floating tab bar, and the
              single profile panel that every screen's hamburger opens through
              the ui bus. Previously each screen rendered its own panel. */}
          <TabBar key={`tabs-${schemeEpoch}`} />
          <AppProfilePanel key={`panel-${schemeEpoch}`} />
          {/* Renders nothing — it just routes an incoming share into /save. */}
          <ShareIntentHandler />
          {/* Nothing either: these two turn an arriving link, or a tapped save
              receipt, into the reel it points at. Both need AppStack above
              them to exist, which is why they live inside this branch. */}
          <DeepLinkHandler />
          {Platform.OS !== 'web' && <NotificationTapHandler />}
        </>
      ) : (
        <LoginScreen key={`login-${schemeEpoch}`} />
      )}
      {/* Welcome confetti — overlaid above the gate so it keeps playing as the app
          mounts after sign-in. */}
      {celebrate && <Confetti />}
      {/* ⚠️ These two are mutually exclusive and BOTH gate on a fresh Supabase
          account — a returning user's new account really is minutes old, so
          without the `returning` check in OnboardingModal they would fire
          together. See components/WelcomeBack.tsx. */}
      <OnboardingModal />
      <WelcomeBack />
    </>
  );
}

/**
 * Crash reporting. Added 2026-09-10, after a tester-visible crash on the first
 * TestFlight build that could not be diagnosed AT ALL: the app had no reporting
 * of any kind (the backend has had Sentry since day one), so the only artifact
 * was iOS's own "Findable Saves Crashed" dialog.
 *
 * ⚠️ NO DSN MEANS NO SENTRY, DELIBERATELY. `EXPO_PUBLIC_SENTRY_DSN` is inlined
 * at BUILD time, so a build made without it can never gain reporting later, and
 * `Sentry.init` with an empty dsn logs a warning on every launch and swallows
 * errors it will never send. Guarding is better than a lie.
 *
 * ⚠️ IT WILL NOT CATCH SHARE EXTENSION CRASHES. The extension is a separate
 * process with no JS runtime; this SDK only sees the app. If sharing breaks
 * silently, Sentry will be quiet and that silence is not evidence of health.
 *
 * `sendDefaultPii` stays FALSE. Saved links are personal — a URL is what
 * someone is interested in — and there is no version of crash reporting worth
 * shipping the library to a third party for.
 */
const SENTRY_DSN = process.env.EXPO_PUBLIC_SENTRY_DSN;

if (SENTRY_DSN) {
  Sentry.init({
    dsn: SENTRY_DSN,
    sendDefaultPii: false,
    // Errors only. Performance tracing on a free tier burns the quota that
    // crashes need, and nothing here is waiting on a latency question.
    tracesSampleRate: 0,
    // The channel this build listens to is the honest environment name: a
    // "production" profile build still talks to staging today (eas.json).
    environment: process.env.EXPO_PUBLIC_API_URL?.includes('staging')
      ? 'staging'
      : 'production',
  });
}

function RootLayout() {
  return (
    // ShareIntentProvider must sit ABOVE the router — expo-share-intent reads
    // the launch intent as the app starts, before any route mounts.
    <ShareIntentProvider>
      <SafeAreaProvider>
        <AuthProvider>
          <Gate />
        </AuthProvider>
      </SafeAreaProvider>
    </ShareIntentProvider>
  );
}

// Sentry.wrap is what installs the error boundary and touch/navigation
// breadcrumbs. Without it `init` alone still reports crashes, but every report
// arrives with no trail of what the user did first.
export default Sentry.wrap(RootLayout);

// themed(): this sheet bakes in the canvas colour, and the canvas inverts
// between schemes. A plain StyleSheet.create here paints white-on-white.
const styles = themed(() => StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.background },
  // Covers whatever the app happened to be showing when the share arrived —
  // the user came from Instagram and should see one thing, not a half-loaded
  // library behind a spinner.
  shareOverlay: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.background,
  },
}));
