import { memo } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Pressable } from './Pressable';
import { Icon } from './Icon';
import { PROMO_ASPECT, type PromoCard } from '../services/promoSlot';
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
 */
interface Props {
  /** Which creative to render. Built from the user's OWN live limits in
   *  services/promoSlot.ts, so the comparison is true for them specifically. */
  card: PromoCard;
  onPress: () => void;
  onDismiss: () => void;
}

function PromoTileInner({ card, onPress, onDismiss }: Props) {
  return (
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
