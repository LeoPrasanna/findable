import { memo, useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, Animated, Easing, AccessibilityInfo } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Pressable } from './Pressable';
import { Icon } from './Icon';
import {
  PROMO_ASPECT, PROMO_INTENSITY, PROMO_MOTION, type PromoCard,
} from '../services/promoSlot';
import { colors, spacing, font, radius, tracking, typeface, themed, gradients, hazeLocations } from '../constants/theme';

/**
 * A promoted tile in the library grid. Today it promotes Findable Pro — ours, not a
 * network's.
 *
 * ⚠️ IT IS LABELLED "PROMOTED" EVEN THOUGH IT IS OURS, and that is the point rather
 * than a nicety. The slot exists to measure whether a non-organic tile is tolerable in
 * a grid of the user's OWN saves (see services/promoSlot.ts and
 * docs/ADS_RESEARCH.md); an unlabelled upsell would measure a different, friendlier
 * thing than the one we would eventually put here. If the badge makes it feel like an
 * intrusion, that IS the finding.
 *
 * ⚠️ IT IS DISMISSIBLE, which a real AdMob unit would not be. A tile the user cannot
 * remove from their own library is the breach I am trying to detect, and making the
 * first one undismissable would guarantee a false positive. The dismiss rate is the
 * tolerance signal — see PROMO_SNOOZE_MS.
 *
 * ⚠️ NO IMAGE, so it costs no network request and cannot letterbox. The haze gradient
 * already in the app does the visual work (`gradients.haze`, 12 other references), so
 * this adds no asset and no new idiom.
 *
 * ⚠️ IT MOVES, and how much is one constant: PROMO_INTENSITY in promoSlot.ts, which
 * also carries the argument about why it ships at 'lively' rather than 'loud'.
 */
interface Props {
  /** Which creative to render. Built from the user's OWN live limits in
   *  services/promoSlot.ts, so the comparison is true for them specifically. */
  card: PromoCard;
  onPress: () => void;
  onDismiss: () => void;
  /** Which promo slot this is, so the grid can tell one tile's box from another's. */
  slot: number;
  /** Reports this tile's box inside the scroll content, for the haptic that fires when
   *  it comes into view. The grid owns that decision — see promoInView(). */
  onMeasure?: (slot: number, y: number, h: number) => void;
}

const M = PROMO_MOTION[PROMO_INTENSITY];

function PromoTileInner({ card, onPress, onDismiss, slot, onMeasure }: Props) {
  /**
   * ⚠️ REDUCE MOTION IS HONOURED, AND IT IS NOT NEGOTIABLE WITH THE BRIEF. A sweeping,
   * pulsing tile is exactly the content that triggers nausea and migraine for people
   * with vestibular disorders, and both platforms expose the setting precisely so apps
   * can stop. Someone who has asked their OS for less motion gets the tile with none
   * of it — same copy, same offer, no movement. Being attention-grabbing is a
   * preference; this is an accessibility floor.
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

  /** 0 → 1 drives the sheen's travel across the tile. */
  const sweep = useRef(new Animated.Value(0)).current;
  /** 0 → 1 breathes the accent edge and the lift. */
  const pulse = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (still) {
      sweep.setValue(0);
      pulse.setValue(0);
      return;
    }
    /**
     * ⚠️ useNativeDriver ON BOTH, which is what makes this affordable. Transform and
     * opacity are the only properties the native driver handles, and they are the only
     * two used here on purpose: the loops then run on the UI thread and keep moving
     * while JS is busy rendering the grid. Up to six of these can be mounted at once
     * (PROMO_MAX), and six JS-driven loops would be a measurable scroll stutter.
     */
    const sheen = Animated.loop(
      Animated.sequence([
        Animated.timing(sweep, {
          toValue: 1, duration: M.sweepMs, easing: Easing.inOut(Easing.cubic), useNativeDriver: true,
        }),
        // The rest between passes is what stops it reading as a loading skeleton.
        Animated.delay(M.restMs),
        Animated.timing(sweep, { toValue: 0, duration: 0, useNativeDriver: true }),
      ]),
    );
    const breathe = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 1, duration: M.pulseMs, easing: Easing.inOut(Easing.quad), useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          toValue: 0, duration: M.pulseMs, easing: Easing.inOut(Easing.quad), useNativeDriver: true,
        }),
      ]),
    );
    sheen.start();
    breathe.start();
    return () => { sheen.stop(); breathe.stop(); };
  }, [still, sweep, pulse]);

  // -120% → 120% of the tile's width, so the band enters and leaves off-frame.
  const sheenX = sweep.interpolate({ inputRange: [0, 1], outputRange: ['-120%', '120%'] });
  const edgeOpacity = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.15, M.pulseTo] });
  const lift = pulse.interpolate({ inputRange: [0, 1], outputRange: [1, M.liftTo] });

  return (
    <Animated.View
      style={{ transform: [{ scale: still ? 1 : lift }] }}
      /* `layout.y` is relative to this tile's column, and the columns start at the
         top of the scroll content, so it is usable as a content offset directly. The
         few points of list padding above it are far inside SEEN_MARGIN. */
      onLayout={e => onMeasure?.(slot, e.nativeEvent.layout.y, e.nativeEvent.layout.height)}
    >
      <Pressable
        style={styles.frame}
        onPress={onPress}
        scaleTo={0.98}
        /* ⚠️ NO accessibilityRole HERE. The dismiss control below is a nested
           Pressable, and on react-native-web `accessibilityRole="button"` emits a real
           <button> — a <button> inside a <button> is invalid, React throws, and the
           inner control silently stops receiving clicks. Left undefined, RN-web emits a
           div with the right ARIA. The long version is in components/Pressable.tsx. */
        accessibilityLabel="Promoted: Findable Pro"
        accessibilityHint="Opens the Pro page"
      >
        <LinearGradient
          colors={gradients.haze}
          locations={hazeLocations}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={StyleSheet.absoluteFill}
        />

        {/* The sheen. A soft diagonal band that crosses the tile and rests.
            pointerEvents none so it never eats the tap. */}
        {!still ? (
          <Animated.View
            pointerEvents="none"
            style={[styles.sheen, { transform: [{ translateX: sheenX }, { rotate: '18deg' }] }]}
          >
            <LinearGradient
              colors={['transparent', 'rgba(255,255,255,0.28)', 'transparent']}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 0 }}
              style={StyleSheet.absoluteFill}
            />
          </Animated.View>
        ) : null}

        {/* The breathing accent edge. A border cannot be animated on the native
            driver, so it is an overlay whose OPACITY animates instead. */}
        <Animated.View pointerEvents="none" style={[styles.edge, { opacity: edgeOpacity }]} />

        {/* Top row: the label that makes this honest, and the way out. */}
        <View style={styles.topRow}>
          <View style={styles.badge}>
            <Text style={styles.badgeText}>PROMOTED</Text>
          </View>
          {/* ⚠️ hitSlop, not a bigger button. The target has to be comfortable without
              the × becoming visually heavier than the offer it sits beside. */}
          <Pressable
            onPress={onDismiss}
            scaleTo={0.9}
            hitSlop={12}
            accessibilityRole="button"
            accessibilityLabel="Hide this"
          >
            <Icon name="close" size={14} color={colors.textSecondary} />
          </Pressable>
        </View>

        <View style={styles.body}>
          <Icon name="sparkles" size={20} color={colors.accentLight} />
          {/* ⚠️ THE NUMBER IS THE OFFER, AND IT IS THE USER'S OWN NUMBER. "Go Pro" says
              nothing a free user can act on; "500 saves instead of 50" names the wall
              they have actually met. The free half comes from the live /usage payload
              rather than a constant, so it can never contradict what the app is
              enforcing on them — see promoCards(). */}
          <Text style={styles.headline}>{card.headline}</Text>
          <Text style={styles.sub}>{card.sub}</Text>
        </View>

        <View style={styles.cta}>
          <Text style={styles.ctaText}>See Pro</Text>
          <Icon name="arrow-forward" size={13} color={colors.textPrimary} />
        </View>
      </Pressable>
    </Animated.View>
  );
}

/** Memoized like the other grid tiles — the mosaic re-renders on every list change. */
export const PromoTile = memo(PromoTileInner);

const styles = themed(() => StyleSheet.create({
  /**
   * ⚠️ `width: '100%'` + `aspectRatio`, NEVER `flex: 1` — the same rule, and the same
   * reason, as ReelCard's `frame`. In the masonry the parent is a column, so `flex`
   * is a competing opinion about this tile's height and which one wins is a Yoga
   * implementation detail that CHANGED under RN 0.86. Read the long note in
   * components/ReelCard.tsx before touching this.
   */
  frame: {
    width: '100%',
    aspectRatio: PROMO_ASPECT,
    backgroundColor: colors.card,
    overflow: 'hidden',
    // Matches the library tile's radius. The library is the one surface in the app
    // that departs from the contact sheet's 0-radius rule — see ReelCard.
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.sm + 2,
    justifyContent: 'space-between',
  },
  /* Taller and wider than the tile so a rotated band still covers the corners. */
  sheen: {
    position: 'absolute',
    top: -40, bottom: -40, left: 0,
    width: '55%',
  },
  edge: {
    position: 'absolute',
    top: 0, right: 0, bottom: 0, left: 0,
    borderRadius: radius.lg,
    borderWidth: 2,
    borderColor: colors.accent,
  },
  topRow: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between' },
  badge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: radius.full,
    backgroundColor: colors.background + 'B3',
    borderWidth: 1,
    borderColor: colors.border,
  },
  badgeText: {
    color: colors.textTertiary,
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: tracking.label,
  },
  body: { gap: 4 },
  headline: {
    color: colors.textPrimary,
    fontFamily: typeface.bodyBold,
    fontSize: font.md,
    fontWeight: '800',
    lineHeight: 20,
  },
  sub: { color: colors.textSecondary, fontSize: font.xs, lineHeight: 14 },
  cta: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  ctaText: { color: colors.textPrimary, fontSize: font.xs, fontWeight: '800' },
}));
