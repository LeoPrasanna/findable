import { useState, useRef, useEffect } from 'react';
import {
  View, Text, TextInput, StyleSheet, KeyboardAvoidingView, Platform,
  ScrollView, ActivityIndicator, TextInputProps, Animated,
  Easing, AccessibilityInfo, Linking,
} from 'react-native';
import type { ReactNode } from 'react';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { Icon } from './Icon';
import { Pressable } from './Pressable';
import { PRIVACY_URL, TERMS_URL } from '../constants/links';
import { supabase } from '../services/supabase';
import * as AppleAuthentication from 'expo-apple-authentication';
import { signInWithProvider, signInWithApple, OAuthProvider } from '../services/oauth';
import { useAuth } from '../contexts/AuthContext';
import * as haptics from '../services/haptics';

import { Label, Body, Wordmark, GhostButton, FilledButton, Rule } from './kit';
import { MockReel, MOCK_REEL_H } from './MockReel';
import { colors, spacing, font, radius, tracking, typeface, themed, gradients, hazeLocations, isDark } from '../constants/theme';

/**
 * APPLE AND GOOGLE ARE BOTH REAL (Apple wired 2026-09-09).
 *
 * Apple uses the NATIVE sheet (`expo-apple-authentication` + Supabase's
 * `signInWithIdToken`), not the browser flow Google uses — see the long note
 * in services/oauth.ts for why that choice avoids a key that expires every six
 * months. The consequence here is that the Apple button is **iOS-only**: the
 * native API does not exist on Android or web, so the button is not rendered
 * there at all rather than shown and then failing.
 *
 * ⚠️ GUIDELINE 4.8 IS NOW SATISFIED FOR iOS — an app offering a third-party
 * social login must also offer Sign in with Apple. Do not make the Apple button
 * conditional on anything other than platform availability, and do not ship an
 * iOS build with Google present and Apple absent.
 */

type Mode = 'signin' | 'signup';
type Step = 'welcome' | 'form';

// Client-side password gate for signup. This is UX only — it can't be trusted
// (anyone can call the Supabase API directly), so the REAL floor is the
// Supabase dashboard password policy + leaked-password protection (owner
// action, see TODO). Length-first per NIST 800-63B: we require length and
// merely ENCOURAGE variety rather than forcing composition rules.
const MIN_PASSWORD = 8;

function passwordStrength(pw: string): { level: 0 | 1 | 2 | 3; label: string; ok: boolean } {
  if (pw.length < MIN_PASSWORD) {
    return { level: 0, label: `Use at least ${MIN_PASSWORD} characters`, ok: false };
  }
  const variety =
    (/[a-z]/.test(pw) ? 1 : 0) + (/[A-Z]/.test(pw) ? 1 : 0) +
    (/[0-9]/.test(pw) ? 1 : 0) + (/[^A-Za-z0-9]/.test(pw) ? 1 : 0);
  if (pw.length >= 12 && variety >= 3) return { level: 3, label: 'Strong password', ok: true };
  if (pw.length >= 10 || variety >= 3) return { level: 2, label: 'Good — longer is stronger', ok: true };
  return { level: 1, label: 'OK — add length or a number/symbol to strengthen', ok: true };
}

// Surface Supabase's auth errors as short, human messages.
function friendly(message: string): string {
  const m = message.toLowerCase();
  if (m.includes('invalid login')) return 'Wrong email or password.';
  if (m.includes('already registered')) return 'That email already has an account — sign in instead.';
  if (m.includes('password should be') || m.includes('password is too weak')) return `Password must be at least ${MIN_PASSWORD} characters.`;
  if (m.includes('unable to validate email') || m.includes('invalid email')) return 'Enter a valid email address.';
  if (m.includes('network')) return "Couldn't reach the server. Check your connection.";
  return message || 'Something went wrong. Try again.';
}

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

/** An underlined field — a rule, not a box. The system has no card chrome, so
 *  an input is defined by the same 1px seam as everything else. */
type FieldProps = TextInputProps & {
  label: string;
  trailing?: ReactNode;
  /** Renders the standard clear (×) affordance while there is text. */
  onClear?: () => void;
};

function Field({ label, trailing, onClear, ...rest }: FieldProps) {
  const [focused, setFocused] = useState(false);
  const hasText = !!rest.value;
  return (
    <View style={styles.field}>
      <Label>{label}</Label>
      <View style={styles.fieldRow}>
        <TextInput
          style={styles.input}
          placeholderTextColor={colors.textTertiary}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          {...rest}
        />
        {/* ⚠️ The clear button is the whole fix for "the field keeps my old
            text". Emptying a field by holding backspace on a phone keyboard is
            genuinely tedious, and every mainstream sign-in form gives you a ×.
            Shown only when there is something to clear and the field is
            editable, so it never appears on a disabled form mid-submit. */}
        {onClear && hasText && rest.editable !== false ? (
          <Pressable
            hitSlop={10}
            onPress={() => { haptics.tap(); onClear(); }}
            accessibilityLabel={`Clear ${label.toLowerCase()}`}
          >
            <Icon name="close" size={16} color={colors.textTertiary} />
          </Pressable>
        ) : null}
        {trailing}
      </View>
      <View style={[styles.fieldRule, focused && styles.fieldRuleOn]} />
    </View>
  );
}

export function LoginScreen() {
  const { triggerCelebrate } = useAuth();
  const insets = useSafeAreaInsets();
  const [step, setStep] = useState<Step>('welcome');
  const [mode, setMode] = useState<Mode>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [nickname, setNickname] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [showPw, setShowPw] = useState(false);
  /** Which social provider is mid-flight, so its button can show a spinner and
   *  the others deactivate. `null` when nothing is running. */
  const [social, setSocial] = useState<OAuthProvider | null>(null);

  const isSignup = mode === 'signup';
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

  /** Empty every field. Used when leaving the form entirely — a half-typed
   *  credential must not still be sitting there when the screen is reopened. */
  const resetForm = () => {
    setEmail(''); setPassword('');
    setFirstName(''); setLastName(''); setNickname('');
    setShowPw(false); setError(''); setNotice('');
  };

  const switchMode = (m: Mode) => {
    if (m === mode) return;
    haptics.tap();
    setMode(m);
    // ⚠️ The PASSWORD is dropped on a mode switch, the email is kept. That is
    // the industry-standard split and it is not arbitrary: the email is almost
    // always the same address either way (you mistyped which tab you were on),
    // while a password typed for "sign in" carried into "create account" is a
    // silent trap — it becomes your new account's password without you ever
    // reading it, and any strength feedback shown for it was never evaluated.
    setPassword('');
    setShowPw(false);
    setError('');
    setNotice('');
  };

  const fail = (msg: string) => {
    haptics.error();
    setError(msg);
    shake();
  };

  const pwStrength = passwordStrength(password);

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
    setError(''); setNotice('');
    const { error: err, cancelled } =
      provider === 'apple' ? await signInWithApple() : await signInWithProvider(provider);
    setSocial(null);
    if (cancelled) return;
    if (err) { fail(err); return; }
    haptics.success();
    triggerCelebrate();
  };

  const submit = async () => {
    const e = email.trim();
    if (!e || !password) { fail('Enter your email and password.'); return; }
    if (mode === 'signup' && !firstName.trim()) { fail('Enter your first name.'); return; }
    if (mode === 'signup' && !pwStrength.ok) { fail(`Use at least ${MIN_PASSWORD} characters for your password.`); return; }
    setBusy(true); setError(''); setNotice('');
    try {
      if (mode === 'signin') {
        const { error } = await supabase.auth.signInWithPassword({ email: e, password });
        if (error) throw error;
        haptics.success();
        triggerCelebrate();
        // On success, AuthProvider's listener flips the gate to the app — no nav here.
      } else {
        const { data, error } = await supabase.auth.signUp({
          email: e,
          password,
          options: {
            data: {
              first_name: firstName.trim(),
              last_name: lastName.trim() || undefined,
              nickname: nickname.trim() || undefined,
            },
          },
        });
        if (error) throw error;
        if (data.session) {
          // Email confirmation is OFF — they're signed in immediately.
          haptics.success();
          triggerCelebrate();
        } else {
          // Confirmation ON — no session yet; tell them to verify.
          haptics.success();
          setNotice('Check your email to confirm your account, then sign in.');
          setMode('signin');
        }
      }
    } catch (err: any) {
      fail(friendly(err?.message || ''));
    } finally {
      setBusy(false);
    }
  };

  /* ── Step 1: welcome ─────────────────────────────────────────────────────── */
  if (step === 'welcome') {
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

          {/* Three entry points. Apple is iOS-only (see the note above). */}
          <View style={styles.authRow}>
            {appleReady ? (
              <Pressable
                style={[styles.authBtn, !!social && social !== 'apple' && styles.authBtnOff]}
                onPress={() => social_signin('apple')}
                disabled={!!social}
                accessibilityRole="button"
                accessibilityLabel="Continue with Apple"
              >
                {social === 'apple'
                  ? <ActivityIndicator color={colors.textPrimary} />
                  : <Ionicons name="logo-apple" size={24} color={colors.textPrimary} />}
              </Pressable>
            ) : null}
            <Pressable
              style={[styles.authBtn, !!social && social !== 'google' && styles.authBtnOff]}
              onPress={() => social_signin('google')}
              disabled={!!social}
              accessibilityRole="button"
              accessibilityLabel="Continue with Google"
            >
              {social === 'google'
                ? <ActivityIndicator color={colors.textPrimary} />
                : <Ionicons name="logo-google" size={22} color={colors.textPrimary} />}
            </Pressable>
            <Pressable
              style={[styles.authBtn, styles.authBtnPrimary, !!social && styles.authBtnOff]}
              onPress={() => { haptics.tap(); setStep('form'); }}
              disabled={!!social}
              accessibilityRole="button"
              accessibilityLabel="Continue with email"
            >
              <Icon name="mail" size={22} color={colors.background} />
            </Pressable>
          </View>
          <Label tone="ink" wide style={styles.authHint}>
            {social === 'google' ? 'Opening Google…'
              : social === 'apple' ? 'Opening Apple…'
              : appleReady ? 'Apple, Google or email' : 'Google or email'}
          </Label>

          {/* Errors have to be visible on THIS step too. They used to render
              only on the form step, so a failed Google sign-in shook a screen
              with no message on it. */}
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

  /* ── Step 2: the form ────────────────────────────────────────────────────── */
  return (
    /* ⚠️ `behavior="padding"` ON ANDROID TOO — this used to be
       `Platform.OS === 'ios' ? 'padding' : undefined`, i.e. a no-op on Android.
       That was correct when Android windows resized under `adjustResize`, but
       Expo SDK 54+ forces EDGE-TO-EDGE on Android, and an edge-to-edge window
       does not resize for the IME. So nothing compensated and the keyboard sat
       on top of the form — you could not see the field you were typing into.
       Padding is exactly right here precisely because the window no longer
       shrinks: KAV adds the keyboard's own height and nothing double-counts.
       Same fix in app/save.tsx, app/ask.tsx, app/profile.tsx and TodoEditor. */
    <KeyboardAvoidingView style={styles.container} behavior="padding">
      <ScrollView
        contentContainerStyle={[styles.formInner, { paddingTop: insets.top + spacing.md }]}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <Pressable
          /* Leaving the form clears it. Previously only `error` was reset, so
             backing out and coming in again showed the last email and password
             still typed in — which is what "it retains the old data" was. */
          onPress={() => { haptics.tap(); setStep('welcome'); resetForm(); }}
          hitSlop={12}
          style={styles.back}
        >
          <Icon name="back" size={20} color={colors.textPrimary} />
        </Pressable>

        <Wordmark size={34} style={styles.formWordmark} />

        {/* Mode switch — two tracked labels and a rule, not a segmented pill.
            The active one is ink, the other ash. Hierarchy without a fill. */}
        <View style={styles.modes}>
          <Pressable onPress={() => switchMode('signin')} hitSlop={8}>
            <Label tone={!isSignup ? 'ink' : 'muted'} wide>Sign in</Label>
          </Pressable>
          <View style={styles.modeDiv} />
          <Pressable onPress={() => switchMode('signup')} hitSlop={8}>
            <Label tone={isSignup ? 'ink' : 'muted'} wide>Create account</Label>
          </Pressable>
        </View>
        <Rule />

        <Animated.View style={[styles.fields, { transform: [{ translateX: shakeX }] }]}>
          {isSignup && (
            <>
              <Field
                label="First name" value={firstName} onChangeText={setFirstName}
                onClear={() => setFirstName('')}
                placeholder="Required" autoCapitalize="words" editable={!busy}
                accessibilityLabel="First name"
              />
              <Field
                label="Last name" value={lastName} onChangeText={setLastName}
                onClear={() => setLastName('')}
                placeholder="Optional" autoCapitalize="words" editable={!busy}
                accessibilityLabel="Last name, optional"
              />
              <Field
                label="Nickname" value={nickname} onChangeText={setNickname}
                onClear={() => setNickname('')}
                placeholder="What we'll call you" autoCapitalize="words" editable={!busy}
                accessibilityLabel="Nickname, optional"
              />
            </>
          )}

          <Field
            label="Email" value={email} onChangeText={setEmail}
            onClear={() => setEmail('')}
            placeholder="you@example.com"
            autoCapitalize="none" autoCorrect={false}
            keyboardType="email-address" inputMode="email" editable={!busy}
            textContentType="emailAddress" autoComplete="email"
            accessibilityLabel="Email"
          />
          <Field
            label="Password" value={password} onChangeText={setPassword}
            onClear={() => setPassword('')}
            placeholder={isSignup ? `${MIN_PASSWORD}+ characters` : 'Your password'}
            secureTextEntry={!showPw} autoCapitalize="none" editable={!busy}
            /* Tells the OS password manager which field this is, so it offers to
               fill/save instead of leaving the user to retype. `newPassword` on
               signup is what makes Android/iOS offer a generated one. */
            textContentType={isSignup ? 'newPassword' : 'password'}
            autoComplete={isSignup ? 'new-password' : 'current-password'}
            onSubmitEditing={submit} returnKeyType="go"
            accessibilityLabel="Password"
            trailing={
              <Pressable hitSlop={10} onPress={() => { haptics.tap(); setShowPw((s) => !s); }}>
                <Icon name={showPw ? 'eye-off' : 'eye'} size={17} color={colors.textTertiary} />
              </Pressable>
            }
          />

          {/* Strength meter. With no colour available, the three segments read
              by FILL COUNT and the words say the rest — which was always the
              accessible way to do this anyway. */}
          {isSignup && password.length > 0 && (
            <View style={styles.strengthWrap} accessibilityLabel={`Password strength: ${pwStrength.label}`}>
              <View style={styles.strengthTrack}>
                {[0, 1, 2].map((i) => (
                  <View key={i} style={[styles.strengthSeg, i < pwStrength.level && styles.strengthSegOn]} />
                ))}
              </View>
              <Label>{pwStrength.label}</Label>
            </View>
          )}
        </Animated.View>

        {error ? (
          <View style={styles.msgRow}>
            <Icon name="alert-circle" size={14} color={colors.textPrimary} />
            <Text style={styles.msgText}>{error}</Text>
          </View>
        ) : null}
        {notice ? (
          <View style={styles.msgRow}>
            <Icon name="checkmark" size={14} color={colors.textPrimary} />
            <Text style={styles.msgText}>{notice}</Text>
          </View>
        ) : null}

        {busy ? (
          <View style={styles.busy}><ActivityIndicator color={colors.textPrimary} /></View>
        ) : (
          <FilledButton
            label={isSignup ? 'Create account' : 'Sign in'}
            onPress={submit}
            trailing="→"
            style={styles.submit}
          />
        )}

        <Body style={styles.helper}>
          {isSignup
            ? 'Free to start. Unlimited saves. Cancel anytime.'
            : 'Your saves, summaries and library — synced to you.'}
        </Body>
      </ScrollView>
    </KeyboardAvoidingView>
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

  // ── Step 2 ──
  formInner: { flexGrow: 1, paddingHorizontal: spacing.lg, paddingBottom: spacing.xxl },
  back: { alignSelf: 'flex-start', paddingVertical: spacing.sm, paddingRight: spacing.md },
  formWordmark: { marginTop: spacing.xl, marginBottom: spacing.xl },
  modes: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, marginBottom: spacing.sm },
  modeDiv: { width: 1, height: 10, backgroundColor: colors.ghostLine },

  fields: { marginTop: spacing.lg, gap: spacing.lg },
  field: { gap: spacing.xs },
  fieldRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  input: {
    flex: 1,
    color: colors.textPrimary,
    fontFamily: typeface.body,
    fontSize: font.lg,
    paddingVertical: spacing.sm,
  },
  fieldRule: { height: 1, backgroundColor: colors.ghostLine },
  fieldRuleOn: { backgroundColor: colors.textPrimary },

  strengthWrap: { gap: spacing.sm },
  strengthTrack: { flexDirection: 'row', gap: 3 },
  strengthSeg: { flex: 1, height: 2, backgroundColor: colors.ghostLine },
  strengthSegOn: { backgroundColor: colors.textPrimary },

  msgRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: spacing.lg },
  msgText: {
    color: colors.textPrimary,
    fontFamily: typeface.body,
    fontSize: font.sm,
    flex: 1,
    lineHeight: 18,
  },

  busy: { marginTop: spacing.xl, paddingVertical: spacing.md, alignItems: 'center' },
  submit: { marginTop: spacing.xl },
  helper: { marginTop: spacing.md, fontSize: font.sm, textAlign: 'center' },
}));
