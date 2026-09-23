import { useState, useRef, useEffect } from 'react';
import {
  View, Text, StyleSheet, Platform,
  ActivityIndicator, Animated,
  Easing, AccessibilityInfo, Linking,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { Icon } from './Icon';
import { Pressable } from './Pressable';
import { PRIVACY_URL, TERMS_URL } from '../constants/links';
import * as AppleAuthentication from 'expo-apple-authentication';
import { signInWithProvider, signInWithApple, OAuthProvider } from '../services/oauth';
import { useAuth } from '../contexts/AuthContext';
import * as haptics from '../services/haptics';

import { Label, Wordmark } from './kit';
import { MockReel, MOCK_REEL_H } from './MockReel';
import { colors, spacing, font, radius, typeface, themed, gradients, hazeLocations, isDark } from '../constants/theme';

/**
 * The sign-in screen. TWO WAYS IN, AND ONLY TWO: Apple and Google.
 *
 * ⚠️ EMAIL AND PASSWORD WERE REMOVED HERE (owner, 2026-09-23) — do not
 * reinstate them without being asked. This deleted the whole second step of
 * this screen: the sign-in/create-account modes, the password strength meter,
 * the profile-name fields, and every `supabase.auth.signInWithPassword` /
 * `signUp` call in the app.
 *
 * The reasoning is a cost one and it holds: an email account is only as good as
 * the mail that supports it, and confirmation, password-reset and change-of-
 * address mail all need an SMTP provider. Supabase's built-in sender caps at a
 * few messages an hour and is explicitly not for production, so email sign-in
 * meant buying and running a mail pipeline to support the least-used door.
 * Deleting the door deletes the pipeline: **SMTP is no longer a launch
 * blocker.**
 *
 * ⚠️ WHAT THIS COSTS, so it is not rediscovered as a bug:
 *   • Any account created with a password can no longer sign in ANYWHERE in
 *     this app. If such accounts exist, they are stranded — there is no screen
 *     left that accepts a password. The same address arriving via Google is a
 *     DIFFERENT user row unless Supabase is set to link identities by email.
 *   • Android now has exactly one door. Google sign-in failing there is a total
 *     lockout, not a degraded experience, because Apple's browser flow was
 *     never wired (TODO.md → "Sign in with Apple"). iOS keeps two.
 *   • Removing the UI does not close the server side. Supabase's Email provider
 *     must be switched OFF in the dashboard, or the endpoint still accepts
 *     signups this app can never sign into. 👤 Tracked in TODO.md.
 *
 * Apple uses the NATIVE sheet (`expo-apple-authentication` +
 * `signInWithIdToken`), not the browser flow Google uses — see the long note in
 * services/oauth.ts. It is iOS-only and gated on `isAvailableAsync`, never on
 * `Platform.OS` alone.
 *
 * ⚠️ App Store Guideline 4.8 binds on iOS: an app offering third-party sign-in
 * must offer Sign in with Apple with equivalent prominence. That is why Apple
 * is the FILLED button on iOS and Google the outlined one — never the reverse.
 * Android has no such rule and no Apple flow, so Google is filled there.
 */


/* ── Welcome backdrop ─────────────────────────────────────────────────────── */

const COLS = 3;
/** Tiles per column before the strip repeats. */
const PER_COL = 5;
/** One card's height — owned by MockReel, re-exported so the drift loop knows
 *  its travel distance without measuring anything on screen. */
const TILE_H = MOCK_REEL_H;
/** Seconds for one column to travel its own length. Slow on purpose — this is
 *  atmosphere behind a sign-in form, not a carousel asking to be watched. */
const DRIFT_S = 34;

/**
 * One drifting column. Renders its tiles TWICE and translates by exactly one
 * copy's height, so the wrap is seamless — at the moment it resets, the pixels
 * on screen are identical.
 *
 * `dir` alternates per column (owner direction, 2026-08-01): odd columns fall,
 * even columns rise. Opposing motion is what stops a tilted grid reading as one
 * sliding sheet, and it's the move that makes the whole thing feel alive.
 */

function DriftColumn({ seeds, dir, seconds }: { seeds: number[]; dir: 1 | -1; seconds: number }) {
  const y = useRef(new Animated.Value(0)).current;
  const [reduceMotion, setReduceMotion] = useState(false);

  useEffect(() => {
    // Respect the OS "reduce motion" switch. Continuous background movement
    // with no way to stop it is exactly what that setting exists for, and a
    // sign-in screen is not somewhere to overrule it.
    let cancelled = false;
    AccessibilityInfo.isReduceMotionEnabled()
      .then(on => { if (!cancelled) setReduceMotion(on); })
      .catch(() => {});
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
    return () => { cancelled = true; sub?.remove?.(); };
  }, []);

  const span = seeds.length * TILE_H;

  useEffect(() => {
    if (reduceMotion || span === 0) { y.setValue(0); return; }
    // Two copies are stacked, so travelling exactly one copy's height lands on
    // pixels identical to the start — the wrap is invisible.
    //   dir  1: 0 → -span   content rises
    //   dir -1: -span → 0   content falls
    // Animated.loop resets to the starting value each iteration by default,
    // which is what makes the reset seamless rather than a jump.
    const from = dir === 1 ? 0 : -span;
    const to = dir === 1 ? -span : 0;
    y.setValue(from);
    const loop = Animated.loop(
      Animated.timing(y, {
        toValue: to,
        duration: seconds * 1000,
        easing: Easing.linear,   // the one place linear is correct: a seam is
        useNativeDriver: true,   // only invisible at constant velocity
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [reduceMotion, span, dir, seconds]);

  return (
    <View style={styles.driftCol}>
      <Animated.View style={{ transform: [{ translateY: y }] }}>
        {[...seeds, ...seeds].map((seed, i) => (
          <MockReel key={i} seed={seed} />
        ))}
      </Animated.View>
    </View>
  );
}

/**
 * The backdrop: a DRIFTING WALL OF MOCK REELS.
 *
 * The reference welcome screen is image-led — a tilted, darkened mosaic of
 * content. This is the same composition rendered as pure UI: the grid is
 * oversized and rotated so the crop reads as a fragment of something larger,
 * and the columns drift in alternating directions.
 *
 * ⚠️ NO PHOTOGRAPHY, BY DESIGN. See MockReel above — there is no bitmap on this
 * screen at all, so nothing here belongs to anyone else.
 *
 * ponytail: animated in code rather than as a GIF/video asset. A GIF would be a
 * fixed-size, block-compressed file of somebody else's content shipping in every
 * bundle forever. This weighs nothing and stays sharp at any density.
 *
 * ponytail: no blur. The reference blurs its collage, which on native needs
 * `expo-blur` — a native module, on a project that has no dev build yet
 * (TODO.md). The tilt plus the scrims carries the same "atmosphere, not content"
 * read. Add expo-blur when a native build exists and it's worth it.
 */
function ReelWallBackdrop() {
  const columns = Array.from({ length: COLS }, (_, c) =>
    Array.from({ length: PER_COL }, (_, r) => c * PER_COL + r),
  );

  return (
    <View style={[styles.backdropClip, { pointerEvents: 'none' }]}>
      <View style={styles.backdrop}>
        {columns.map((seeds, c) => (
          <DriftColumn
            key={c}
            seeds={seeds}
            // Alternating: odd columns rise, even columns fall. Opposing motion
            // is what stops a tilted grid reading as one sliding sheet.
            dir={c % 2 === 0 ? 1 : -1}
            // Slightly different speeds so the columns never re-align into a
            // visible rhythm.
            seconds={DRIFT_S + c * 7}
          />
        ))}
      </View>
    </View>
  );
}

export function LoginScreen() {
  const { triggerCelebrate } = useAuth();
  const insets = useSafeAreaInsets();
  const [error, setError] = useState('');
  /** Which social provider is mid-flight, so its button can show a spinner and
   *  the others deactivate. `null` when nothing is running. */
  const [social, setSocial] = useState<OAuthProvider | null>(null);

  const shakeX = useRef(new Animated.Value(0)).current;

  // A quick left-right shake — the universal "that didn't work" cue. Kept
  // despite the direction's minimal-motion rule: this is error feedback, not
  // decoration, and it is the one place movement carries information.
  const shake = () => {
    shakeX.setValue(0);
    Animated.sequence(
      [-10, 9, -7, 6, -3, 0].map((to) =>
        Animated.timing(shakeX, { toValue: to, duration: 45, useNativeDriver: true }),
      ),
    ).start();
  };

  const fail = (msg: string) => {
    haptics.error();
    setError(msg);
    shake();
  };

  /**
   * Social sign-in. On success the AuthProvider listener flips the gate, exactly
   * like the email path — no navigation here.
   *
   * A user who backs out of the browser returns `cancelled` and gets NOTHING:
   * no error, no shake, no haptic. Dismissing a sheet you opened is a decision,
   * not a failure, and reporting it as one is the most common way this flow is
   * made to feel broken.
   */
  /**
   * Apple's native sheet exists only on iOS 13+. `isAvailableAsync` is the
   * supported check — a Platform.OS test alone would still render the button
   * on an iOS simulator/OS where the API is missing.
   */
  const [appleReady, setAppleReady] = useState(false);
  useEffect(() => {
    let alive = true;
    AppleAuthentication.isAvailableAsync()
      .then((ok) => { if (alive) setAppleReady(ok); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  const social_signin = async (provider: OAuthProvider) => {
    if (social) return;
    haptics.tap();
    setSocial(provider);
    setError('');
    const { error: err, cancelled } =
      provider === 'apple' ? await signInWithApple() : await signInWithProvider(provider);
    setSocial(null);
    if (cancelled) return;
    if (err) { fail(err); return; }
    haptics.success();
    triggerCelebrate();
  };

  return (
      <View style={styles.container}>
        {/* ── Atmosphere is DARK-ONLY (2026-08-09) ───────────────────────────
            In light, MockReel's cards are near-white on a white canvas, so the
            drift columns animate something invisible — white-on-white, paid for
            in GPU every frame. `hazeFor` already collapses the haze to a flat
            white fill in light, making that layer a wasted full-screen draw too.
            Light therefore gets the clean flat surface and none of the cost;
            dark keeps the full chromatic treatment.

            Read at render, not subscribed: `setScheme` remounts the tree via the
            root layout's scheme epoch, which is the established pattern here
            (see app/_layout.tsx and MockReel.tsx). */}
        <ReelWallBackdrop />
        {/* Flat wash over the whole wall — keeps it as atmosphere. Its opacity
            is scheme-aware (see styles.scrim): light tiles sit ~3% off the
            canvas, so the wash that reads as atmosphere in dark erased the wall
            completely in light. */}
        <View style={[styles.scrim, { pointerEvents: 'none' }]} />
        {/* Nocturnal Dimension haze. Sits ABOVE the wash but BELOW the
            bottom ramp, so the ramp keeps doing its legibility job.
            Transparent in light — see hazeFor(). */}
        <LinearGradient
          colors={gradients.haze}
          locations={hazeLocations}
          style={[StyleSheet.absoluteFill, { pointerEvents: 'none' }]}
        />
        {/* Bottom ramp, on top of the flat wash. The controls and the legal
            text sit in the lower third, and a uniform scrim was leaving them
            competing with the moving tiles behind. This drives the bottom of
            the screen to solid canvas so the actions read cleanly. */}
        <LinearGradient
          colors={['transparent', colors.background]}
          locations={[0, 0.72]}
          style={[styles.bottomFade, { pointerEvents: 'none' }]}
        />
        <View style={[styles.welcome, { paddingTop: insets.top, paddingBottom: insets.bottom + spacing.lg }]}>
          <View style={styles.welcomeMid}>
            <Wordmark size={52} />
            <Label wide style={styles.welcomeSub}>Everything you saved · actually findable</Label>
          </View>

          {/*
              ⚠️ THE FILLED BUTTON IS THE PLATFORM'S OWN, and which one that is
              differs by platform (owner, 2026-09-23):

                iOS      Apple filled, Google outlined
                Android  Google filled, Apple absent

              On iOS that is not a taste call. Guideline 4.8 requires Sign in
              with Apple to be offered with equivalent prominence wherever a
              third-party login is, so Apple may never be the quieter of the
              two. Android has no such rule and no Apple flow at all.

              Before this, EMAIL was the filled button — the app was steering
              people through the one door being closed.

              The row is wrapped in the shake transform so a failed sign-in
              still moves something. It used to shake the form's fields, and
              those are gone; an error that only appears as text is the one
              people miss. */}
          <Animated.View style={[styles.authRow, { transform: [{ translateX: shakeX }] }]}>
            {appleReady ? (
              <Pressable
                style={[
                  styles.authBtn,
                  Platform.OS === 'ios' && styles.authBtnPrimary,
                  !!social && social !== 'apple' && styles.authBtnOff,
                ]}
                onPress={() => social_signin('apple')}
                disabled={!!social}
                accessibilityRole="button"
                accessibilityLabel="Continue with Apple"
              >
                {social === 'apple'
                  ? <ActivityIndicator color={Platform.OS === 'ios' ? colors.background : colors.textPrimary} />
                  : <Ionicons
                      name="logo-apple" size={24}
                      color={Platform.OS === 'ios' ? colors.background : colors.textPrimary}
                    />}
              </Pressable>
            ) : null}
            <Pressable
              style={[
                styles.authBtn,
                Platform.OS !== 'ios' && styles.authBtnPrimary,
                !!social && social !== 'google' && styles.authBtnOff,
              ]}
              onPress={() => social_signin('google')}
              disabled={!!social}
              accessibilityRole="button"
              accessibilityLabel="Continue with Google"
            >
              {social === 'google'
                ? <ActivityIndicator color={Platform.OS !== 'ios' ? colors.background : colors.textPrimary} />
                : <Ionicons
                    name="logo-google" size={22}
                    color={Platform.OS !== 'ios' ? colors.background : colors.textPrimary}
                  />}
            </Pressable>
          </Animated.View>
          <Label tone="ink" wide style={styles.authHint}>
            {social === 'google' ? 'Opening Google…'
              : social === 'apple' ? 'Opening Apple…'
              : appleReady ? 'Continue with Apple or Google' : 'Continue with Google'}
          </Label>

          {/* The only place an error can appear now. Sign-in failures used to
              render on the form step, so a failed Google sign-in shook a screen
              that had no message on it. */}
          {error ? (
            <View style={styles.msgRow}>
              <Icon name="alert-circle" size={14} color={colors.textPrimary} />
              <Text style={styles.msgText}>{error}</Text>
            </View>
          ) : null}

          {/* ⚠️ THESE TWO WERE UNDERLINED TEXT WITH NO HANDLER — a link in every
              respect except the one that matters (owner, 2026-09-14). Underlining
              something and then not making it tappable is worse than plain text:
              it tells the user the agreement they are about to accept is readable,
              and then refuses to show it.

              `onPress` on a nested <Text> rather than wrapping in a Pressable,
              because a Pressable cannot sit inside a paragraph without breaking
              the line wrap. Failures are swallowed: the same two pages are one tap
              away in Menu → Support, and an alert thrown over the login screen is
              a worse outcome than a tap that does nothing. */}
          <Text style={styles.legal}>
            By continuing you agree to our{' '}
            <Text
              style={styles.legalStrong}
              accessibilityRole="link"
              onPress={() => { Linking.openURL(TERMS_URL).catch(() => {}); }}
            >Terms</Text> and{' '}
            <Text
              style={styles.legalStrong}
              accessibilityRole="link"
              onPress={() => { Linking.openURL(PRIVACY_URL).catch(() => {}); }}
            >Privacy Policy</Text>. Findable stores links and
            AI-generated summaries for personal reference; saved content belongs to its original
            creators, and AI summaries may be imperfect.
          </Text>
        </View>
      </View>
    );
  }

const styles = themed(() => StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },

  // ── Backdrop: a tilted collage of the user's own saves ──
  // The clip keeps the rotated, oversized grid inside the screen.
  backdropClip: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
    overflow: 'hidden',
  },
  // Deliberately larger than the viewport and rotated: at 9° a screen-sized
  // grid would show bare canvas at the corners, and the overhang is what makes
  // the mosaic read as a fragment of something bigger rather than a neat table.
  // The extra vertical room also hides the loop seam off-screen.
  backdrop: {
    position: 'absolute',
    top: '-30%', left: '-16%', right: '-16%', bottom: '-30%',
    flexDirection: 'row',
    transform: [{ rotate: '-9deg' }, { scale: 1.12 }],
  },
  driftCol: { flex: 1, overflow: 'hidden' },

  // ⚠️ The scrim is the CANVAS colour, not black — it dims the wall in dark mode
  // and lightens it in light mode. The wordmark on top is `textPrimary`, which
  // inverts to match, so legibility holds in both. A fixed black scrim would
  // leave black-on-black text in light mode.
  scrim: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: colors.background,
    // Dark tiles (#17171A card, salt-ink shapes) survive a heavy wash. Light
    // tiles are #F2F2F2 on a #FFFFFF canvas — barely 3% apart — so 0.74 white
    // over them left nothing to see. Lower in light, same atmosphere in dark.
    opacity: isDark() ? 0.74 : 0.42,
  },
  // Ramps to solid canvas across the bottom half, so the auth row and the legal
  // text sit on a clean surface instead of over moving tiles.
  bottomFade: {
    position: 'absolute', left: 0, right: 0, bottom: 0,
    height: '58%',
  },

  // ── Step 1 ──
  welcome: { flex: 1, paddingHorizontal: spacing.lg, justifyContent: 'flex-end' },
  welcomeMid: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  welcomeSub: { marginTop: spacing.md, textAlign: 'center' },
  authRow: { flexDirection: 'row', justifyContent: 'center', gap: spacing.md },
  // ⚠️ ROUND — owner direction, matching the reference app. These were square
  // on the argument that the system is 0-radius everywhere; `radius.circle` now
  // has a closed list of three sanctioned uses and this is one of them (see
  // constants/theme.ts). Do not generalise it beyond that list.
  authBtn: {
    width: 68, height: 68,
    borderRadius: radius.circle,
    borderWidth: 1,
    borderColor: colors.borderLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Email is the one that actually works, so it gets the system's inversion —
  // the same emphasis the primary button uses everywhere else.
  authBtnPrimary: { backgroundColor: colors.textPrimary, borderColor: colors.textPrimary },
  // Dimmed while another provider's flow is in-flight — the system has no
  // colour to grey with, so opacity is the whole vocabulary for "not now".
  authBtnOff: { opacity: 0.35 },
  authHint: { textAlign: 'center', marginTop: spacing.md },
  legal: {
    color: colors.textTertiary,
    fontFamily: typeface.body,
    fontSize: 11,
    lineHeight: 17,
    textAlign: 'center',
    marginTop: spacing.xl,
  },
  legalStrong: { color: colors.textSecondary, textDecorationLine: 'underline' },




  msgRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: spacing.lg },
  msgText: {
    color: colors.textPrimary,
    fontFamily: typeface.body,
    fontSize: font.sm,
    flex: 1,
    lineHeight: 18,
  },

}));
