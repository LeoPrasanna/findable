import { useState, useEffect, useRef } from 'react';
import { View, Text, StyleSheet, Modal, Dimensions, Animated } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Pressable } from './Pressable';
import { Label, Body, Rule, Rail, FilledButton } from './kit';
import { Icon } from './Icon';
import { colors, spacing, font, tracking, typeface, motion, themed } from '../constants/theme';
import { useAuth } from '../contexts/AuthContext';
import { getCachedUsage, onUsage } from '../services/usageCache';

const ONBOARDING_KEY = '@savehere:onboarding:v1';
const { width: SCREEN_W } = Dimensions.get('window');

/**
 * First-run tour, full-bleed on the canvas.
 *
 * Structure follows the brief's reference: title, a short paragraph, one square
 * hero, a progress indicator, and a persistent CTA pinned at the bottom. What
 * differs is everything about the execution — the hero is a monochrome
 * geometric figure rather than a photograph, the progress is a numbered rail
 * rather than dots (whose active dot is that app's only spot of colour, which
 * this system cannot have), and the CTA is square rather than a white pill.
 */

type Figure = 'grid' | 'ask' | 'plan' | 'steps' | 'check' | 'share' | 'save';

interface Step {
  eyebrow: string;
  title: string;
  description: string;
  figure: Figure;
}

const STEPS: Step[] = [
  {
    eyebrow: 'Welcome',
    title: 'A contact sheet\nfor everything you save.',
    description:
      'You start with a 10-day full trial — 500 saves and 30 AI actions a day, no card needed. After that you keep everything you saved, with 50 saves and 3 AI actions a day. Pro restores the full 500.',
    figure: 'grid',
  },
  {
    eyebrow: 'Ask',
    title: 'Ask your own library.',
    description:
      'Ask in plain words — "what was that high-protein recipe?" — and get an answer built only from what you saved, with the sources it used. No generic web results.',
    figure: 'ask',
  },
  {
    eyebrow: 'Workouts',
    title: 'Turn a gym reel\ninto a real plan.',
    description:
      'Save any fitness video and tap Build Workout. Exercises, sets, reps and rest times become a hands-free session with countdown timers.',
    figure: 'plan',
  },
  {
    eyebrow: 'Recipes',
    title: 'Cook along,\nstep by step.',
    description:
      'Save a cooking video and tap Get Recipe. Ingredients and numbered steps you can tick off as you go. Edit anything, any time.',
    figure: 'steps',
  },
  {
    eyebrow: 'Study',
    title: 'Do the thing,\nnot just watch it.',
    description:
      'Save a tutorial or lesson and turn it into an actionable checklist — so what the video teaches actually gets done.',
    figure: 'check',
  },
  {
    /**
     * ⚠️ THIS STEP EXISTS BECAUSE THE FEATURE IS INVISIBLE BY DESIGN (owner,
     * 2026-09-11). Sharing to Findable saves without opening it — which is the
     * whole point, and also means a new user gets no confirmation that anything
     * happened. Nothing else in the app has that property; every other action
     * shows its own result. Told once, up front, it reads as magic; discovered
     * by accident it reads as a share that failed.
     */
    eyebrow: 'Sharing',
    title: 'Share to Findable\nwithout leaving the app.',
    description:
      'Hit Share in Instagram, YouTube, Threads or LinkedIn and pick Findable. The save happens in the background — you stay exactly where you were, and it’s waiting in your library.',
    figure: 'share',
  },
  {
    eyebrow: 'Ready',
    title: 'Save your first link.',
    description:
      'Tap + to save from YouTube, Instagram, TikTok, Threads or LinkedIn. The summary and tags appear on their own.',
    figure: 'save',
  },
];

/**
 * The hero slot.
 *
 * ⚠️ REWRITTEN 2026-08-10. This used to hold six ABSTRACT figures built from
 * the system's primitives — a 3x3 cell grid, stacked bars, rows of dots, a
 * giant plus. Defensible as composition, and the owner's verdict after
 * watching first-run was blunt: they don't read. Rows of dots do not say
 * "workout", and numbered bars do not say "recipe".
 *
 * They are now the app's OWN icons, and that is the point rather than a
 * fallback: four of these six glyphs are the tab bar the user will tap within
 * the minute (`layers` = Library, `ask` = Ask, `checkbox` = Slate, `add` =
 * Save), and the other two are the buttons the steps describe (`barbell` =
 * Build Workout, `restaurant` = Get Recipe, both in app/reel/[id].tsx). So the
 * tour now teaches the actual interface instead of decorating next to it. The
 * `save` step was always the one figure that worked — because it was already a
 * giant version of the Save button's plus. This applies that logic to the rest.
 *
 * Zero new imports, zero new icon keys, zero bytes added to the bundle.
 * (Canva-generated artwork was evaluated for this and rejected: raster only,
 * no transparent export on the current plan, so it could not survive the
 * light/dark inversion. See TODO.md.)
 *
 * Fixed 1:1 so the slot never reflows between steps.
 */

/** Step -> the glyph the user will actually tap for that feature. */
const FIGURE_ICON: Record<Figure, string> = {
  grid: 'layers',       // Library tab
  ask: 'ask',           // Ask tab
  plan: 'barbell',      // "Build Workout" on the reel screen
  steps: 'restaurant',  // "Get Recipe" on the reel screen
  check: 'checkbox',    // Slate tab
  share: 'send',        // the system share sheet's own verb
  save: 'add',          // Save tab / centre FAB
};

/** ⚠️ Lucide's `strokeWidth` is in VIEWBOX units, not pixels — rendered px is
 *  `strokeWidth * size / 24`. Icon.tsx's default of 1.1 at this size would draw
 *  a ~4px stroke, by far the heaviest mark on a screen whose display face runs
 *  at 300. 0.45 lands at ~1.65px, in line with the hairline rules everywhere
 *  else. Do not delete this prop "because the default is fine". */
const FIGURE_SIZE = 88;
const FIGURE_STROKE = 0.45;

function StepFigure({ kind }: { kind: Figure }) {
  return (
    <View style={styles.figure}>
      <View style={styles.figureFrame}>
        <Icon
          name={FIGURE_ICON[kind]}
          size={FIGURE_SIZE}
          strokeWidth={FIGURE_STROKE}
          color={colors.textPrimary}
        />
      </View>
    </View>
  );
}

export function OnboardingModal() {
  const [visible, setVisible] = useState(false);
  const [step, setStep] = useState(0);
  const [checked, setChecked] = useState(false);
  const insets = useSafeAreaInsets();
  const { session } = useAuth();
  const slideX = useRef(new Animated.Value(0)).current;
  const fadeIn = useRef(new Animated.Value(0)).current;

  // Shown only to a NEWLY CREATED account, once. The local storage key alone
  // isn't enough: storage is per-device/per-origin, so an existing user signing
  // in on a new device (or a new dev-server port) used to get the tour replayed
  // on every login. The "new user" signal is the Supabase account age — only an
  // account created minutes ago sees the tour; anyone older gets the key
  // stamped silently so it can never resurface.
  const userId = session?.user?.id;
  const createdAt = session?.user?.created_at;
  const storageKey = userId ? `${ONBOARDING_KEY}:${userId}` : null;
  const isFreshAccount =
    !!createdAt && Date.now() - new Date(createdAt).getTime() < 15 * 60 * 1000;

  /**
   * ⚠️ A RETURNING USER IS NOT A NEW USER, even though their account is minutes
   * old (owner, 2026-08-15). Someone who deleted their account and signed up
   * again passes `isFreshAccount` exactly like a first-timer, so both this tour
   * and the welcome-back screen would fire on top of each other — and the tour
   * is the wrong one of the two, because they already know what the app does.
   * `returning` is derived server-side from the trial grant that outlives a
   * deleted account (see backend/app/routes/account.py). The seen-flag is still
   * stamped below, so the tour can never resurface for them later either.
   */
  const [returning, setReturning] = useState(() => getCachedUsage()?.returning === true);
  useEffect(() => onUsage(u => setReturning(u.returning === true)), []);

  /**
   * ⚠️ `returning` is in the deps because it can arrive AFTER mount — this
   * component sits outside the auth gate, so the login-time /usage fetch may
   * still be in flight when it first renders. If it flips true while the tour
   * is up, the tour is retracted and the key stamped, so the welcome-back
   * screen owns the moment and the tour cannot resurface later.
   */
  useEffect(() => {
    if (!storageKey) { setChecked(false); setVisible(false); return; }
    if (returning) {
      setVisible(false);
      AsyncStorage.setItem(storageKey, 'completed');
      setChecked(true);
      return;
    }
    AsyncStorage.getItem(storageKey).then((val) => {
      if (!val && isFreshAccount) {
        setVisible(true);
        setStep(0);
        Animated.timing(fadeIn, { toValue: 1, duration: motion.micro, useNativeDriver: true }).start();
      } else if (!val) {
        AsyncStorage.setItem(storageKey, 'completed');
      }
      setChecked(true);
    });
  }, [storageKey, returning]);

  const goNext = () => {
    if (step < STEPS.length - 1) {
      Animated.timing(slideX, {
        toValue: -SCREEN_W, duration: motion.micro, useNativeDriver: true,
      }).start(() => {
        setStep((s) => s + 1);
        slideX.setValue(SCREEN_W);
        Animated.timing(slideX, {
          toValue: 0, duration: motion.micro, useNativeDriver: true,
        }).start();
      });
    } else {
      finish();
    }
  };

  const finish = () => {
    Animated.timing(fadeIn, { toValue: 0, duration: motion.micro, useNativeDriver: true }).start(() => {
      if (storageKey) AsyncStorage.setItem(storageKey, 'completed');
      setVisible(false);
    });
  };

  const current = STEPS[step];
  const isLast = step === STEPS.length - 1;

  if (!checked) return null;

  return (
    <Modal visible={visible} transparent={false} animationType="fade" statusBarTranslucent>
      <Animated.View style={[styles.screen, { opacity: fadeIn }]}>
        {/* Top: which step, out of how many. No Skip — first-run onboarding is
            shown once to a brand-new account and must be seen in full; the only
            way out is stepping through to the end (decided 2026-07-20). */}
        <View style={[styles.top, { paddingTop: insets.top + spacing.md }]}>
          <Label wide>{current.eyebrow}</Label>
          <Rail step={step + 1} total={STEPS.length} />
        </View>
        <Rule />

        <Animated.View style={[styles.page, { transform: [{ translateX: slideX }] }]}>
          <Text style={styles.title}>{current.title}</Text>
          <Body style={styles.desc}>{current.description}</Body>
          <StepFigure kind={current.figure} />
        </Animated.View>

        <View style={[styles.foot, { paddingBottom: insets.bottom + spacing.lg }]}>
          <FilledButton
            label={isLast ? 'Start saving' : 'Next'}
            trailing="→"
            onPress={goNext}
          />
          {step === 0 && (
            <Label style={styles.terms}>
              By continuing you agree to our Terms and Privacy Policy
            </Label>
          )}
        </View>
      </Animated.View>
    </Modal>
  );
}

const styles = themed(() => StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  top: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.md,
  },

  page: { flex: 1, paddingHorizontal: spacing.lg, paddingTop: spacing.xl },
  title: {
    color: colors.textPrimary,
    fontFamily: typeface.display,
    fontSize: font.xxl,
    lineHeight: font.xxl * 1.12,
    letterSpacing: tracking.title,
  },
  desc: { marginTop: spacing.md, fontSize: font.sm, lineHeight: 21, maxWidth: 460 },

  // ── Figure slot ──
  figure: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: spacing.lg,
  },
  // The frame the glyph sits in — the same hairline square the old cell grid
  // used, kept so the slot's silhouette is unchanged between releases.
  figureFrame: {
    width: 168, height: 168,
    borderWidth: 0.5,
    borderColor: colors.ghostLine,
    alignItems: 'center',
    justifyContent: 'center',
  },

  foot: { paddingHorizontal: spacing.lg, paddingTop: spacing.md, gap: spacing.md },
  terms: { textAlign: 'center' },
}));
