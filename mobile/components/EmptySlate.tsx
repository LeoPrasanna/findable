import { useEffect, useRef, useState } from 'react';
import { View, StyleSheet, Animated, Easing, AccessibilityInfo } from 'react-native';
import { Icon } from './Icon';
import { colors, spacing, themed } from '../constants/theme';

/**
 * The drawing above "Nothing to follow through on" — three task rows that tick
 * themselves off, rest, and start again.
 *
 * ⚠️ IT SAYS *DONE*, NOT *EMPTY*, AND THAT IS THE WHOLE DESIGN. The screen it sits
 * on reads "0 OPEN · 8 DONE · 0 OVERDUE": arriving here is an achievement, not a
 * void. The obvious empty-state drawings — a dusty box, a shrugging character, a
 * dashed outline — all say "you have nothing", which is the wrong sentence for
 * someone who just cleared their list.
 *
 * ⚠️ IT IS MADE OF RULES AND NOTHING ELSE. The library, the plan cards and every
 * section header in this app are built from hairlines (`Rule`), so a checklist
 * drawn as three hairlines belongs to the same system. An illustration would not.
 * The note at the call site in app/todos.tsx records that an icon was REMOVED from
 * this exact spot for being the one thing that made the screen look bespoke — this
 * is deliberately quieter than that icon was, not louder.
 *
 * ⚠️ NO NEW DEPENDENCY, and that is load-bearing rather than thrifty: a Lottie or
 * Rive runtime is a NATIVE module, which moves the fingerprint and costs an Android
 * and an iOS build before anyone could see it. This is Views and `Animated`, so it
 * ships over the air. See mobile/AGENTS.md.
 */

/** Bar widths, one per row. Varying them is what stops three identical bars
 *  reading as a loading skeleton. */
const ROWS = [96, 66, 80];

const TICK_MS = 420;
/** Gap between one row ticking and the next. */
const STAGGER_MS = 260;
/** How long the finished list is held before it resets. Long on purpose: this is
 *  a resting screen, and a short loop would make it a flicker in the corner of
 *  someone's eye while they read the sentence underneath. */
const HOLD_MS = 2200;
const FADE_MS = 500;

export function EmptySlate() {
  /**
   * ⚠️ REDUCE MOTION IS HONOURED AND IS NOT A NICETY. Same floor as PromoTile: a
   * repeating animation is exactly what both platforms expose this setting to stop.
   * The still frame is the FINISHED state — all three ticked — because that is the
   * frame that still carries the meaning. Freezing on the empty state would say the
   * opposite of what the drawing is for.
   */
  const [still, setStill] = useState(false);
  useEffect(() => {
    let alive = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then(on => { if (alive) setStill(on); })
      .catch(() => {});
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', on => setStill(!!on));
    return () => { alive = false; sub?.remove(); };
  }, []);

  /** One 0 → 1 per row: 0 is an open task, 1 is a ticked one. */
  const ticks = useRef(ROWS.map(() => new Animated.Value(0))).current;

  useEffect(() => {
    if (still) {
      ticks.forEach(t => t.setValue(1));   // hold the finished frame
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.stagger(
          STAGGER_MS,
          ticks.map(t =>
            Animated.timing(t, {
              toValue: 1,
              duration: TICK_MS,
              easing: Easing.out(Easing.cubic),
              // Transform and opacity only — so the loop runs on the UI thread and
              // keeps moving while the list re-renders behind it.
              useNativeDriver: true,
            }),
          ),
        ),
        Animated.delay(HOLD_MS),
        // Clear all three together rather than un-ticking them one by one:
        // reversing the stagger would read as tasks being UNdone.
        Animated.parallel(
          ticks.map(t =>
            Animated.timing(t, { toValue: 0, duration: FADE_MS, useNativeDriver: true }),
          ),
        ),
        Animated.delay(400),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [still, ticks]);

  return (
    <View style={styles.wrap} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {ROWS.map((width, i) => {
        const t = ticks[i];
        return (
          <View key={i} style={styles.row}>
            <View style={styles.box}>
              {/* The empty box fades out as the check fades in, so the two never
                  both read as present. */}
              <Animated.View
                style={[styles.ring, { opacity: t.interpolate({ inputRange: [0, 0.6], outputRange: [1, 0] }) }]}
              />
              <Animated.View
                style={[
                  styles.check,
                  {
                    opacity: t.interpolate({ inputRange: [0.35, 1], outputRange: [0, 1] }),
                    transform: [{ scale: t.interpolate({ inputRange: [0.35, 1], outputRange: [0.4, 1] }) }],
                  },
                ]}
              >
                <Icon name="checkmark" size={13} color={colors.textPrimary} />
              </Animated.View>
            </View>

            <View style={[styles.bar, { width }]}>
              <Animated.View
                style={[
                  StyleSheet.absoluteFill,
                  styles.barFill,
                  { opacity: t.interpolate({ inputRange: [0, 1], outputRange: [0.9, 0.28] }) },
                ]}
              />
              {/* The strike is a second hairline scaled from the left, which the
                  native driver can do; animating `width` could not. */}
              <Animated.View
                style={[
                  styles.strike,
                  {
                    opacity: t.interpolate({ inputRange: [0.3, 0.8], outputRange: [0, 1] }),
                    transform: [
                      { translateX: -width / 2 },
                      { scaleX: t.interpolate({ inputRange: [0.3, 1], outputRange: [0, 1] }) },
                      { translateX: width / 2 },
                    ],
                  },
                ]}
              />
            </View>
          </View>
        );
      })}
    </View>
  );
}

/**
 * ⚠️ SIZED AND COLOURED TO ACTUALLY BE SEEN. The first pass used `ghostLine` at
 * 14px and 2px bars and read as three faint smudges — the same mistake the owner
 * had already called out once ("your animation is very very subtle"). `ghostLine`
 * is 10% white: correct for a tile seam, invisible for the subject of a drawing.
 * These use the TEXT ramp instead, so the parts carry the same weight as type.
 */
const BOX = 18;

const styles = themed(() => StyleSheet.create({
  wrap: { gap: 10, marginBottom: spacing.lg, alignItems: 'flex-start' },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  box: { width: BOX, height: BOX, alignItems: 'center', justifyContent: 'center' },
  ring: {
    position: 'absolute',
    top: 0, right: 0, bottom: 0, left: 0,
    borderWidth: 1,
    borderColor: colors.textTertiary,
    borderRadius: 5,
  },
  check: { alignItems: 'center', justifyContent: 'center' },
  bar: { height: 3, justifyContent: 'center' },
  barFill: { backgroundColor: colors.textTertiary, borderRadius: 1.5 },
  strike: {
    position: 'absolute',
    left: 0, right: 0,
    height: 1,
    backgroundColor: colors.textSecondary,
  },
}));
