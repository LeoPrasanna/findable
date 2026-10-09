import { ReactNode } from 'react';
import { View, Text, StyleSheet, TextStyle, ViewStyle, StyleProp, ScrollView } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Pressable } from './Pressable';
import { colors, spacing, font, radius, tracking, typeface, themed } from '../constants/theme';

/**
 * The "Contact Sheet" primitive set.
 *
 * Every component here exists because the direction has no colour to spend:
 * hierarchy is carried by SIZE, WEIGHT and LETTER-SPACING alone. Getting those
 * three right by hand at 40 call sites is how a system drifts, so they live
 * here once.
 *
 * See the reference lock at the top of constants/theme.ts.
 */

/* ── Type ──────────────────────────────────────────────────────────────────── */

/**
 * The metadata voice — small, uppercase, widely tracked.
 *
 * This is Julia Krantz's Category Label component, and it is doing most of the
 * work that colour used to do: platform, category, status, section headers and
 * counts are all this one component at different tones.
 */
export function Label({
  children, tone = 'muted', wide = false, style, numberOfLines,
}: {
  children: ReactNode;
  tone?: 'muted' | 'ink' | 'veil';
  wide?: boolean;
  style?: StyleProp<TextStyle>;
  numberOfLines?: number;
}) {
  return (
    <Text
      numberOfLines={numberOfLines}
      style={[
        styles.label,
        wide && styles.labelWide,
        tone === 'ink' && { color: colors.textPrimary },
        tone === 'veil' && { color: colors.veil },
        style,
      ]}
    >
      {typeof children === 'string' ? children.toUpperCase() : children}
    </Text>
  );
}

/** Screen title. Light weight at large size with negative tracking — the
 *  signature move. Never bold this; 300 is the point. */
export function Title({ children, style, numberOfLines }: {
  children: ReactNode; style?: StyleProp<TextStyle>; numberOfLines?: number;
}) {
  return <Text numberOfLines={numberOfLines} style={[styles.title, style]}>{children}</Text>;
}

/**
 * The wordmark.
 *
 * Tracking is computed from the size rather than taken from `tracking.display`,
 * because this renders at anything from 22px (headers) to 52px (welcome) and a
 * fixed point value would be far too tight at the small end. The -0.025em ratio
 * matches the scale — see the note on `tracking` in constants/theme.ts for why
 * it loosened when the face went from weight 300 to 600.
 */
export function Wordmark({ size = font.display, style }: { size?: number; style?: StyleProp<TextStyle> }) {
  return (
    <Text
      style={[
        styles.wordmark,
        {
          fontSize: size,
          letterSpacing: size * -0.025,
          /**
           * ⚠️ THE PADDING IS A FIX, NOT SPACING — removing it clips the final
           * "e" (owner report, first TestFlight build, 2026-09-09).
           *
           * Negative letterSpacing is subtracted after the LAST glyph too, so
           * the frame iOS measures ends inside that glyph's ink. The letter is
           * drawn and then cropped by its own text box. It only shows on a
           * device: the web export lays text out with the browser's metrics
           * and looks fine, which is why it survived to a build.
           *
           * ⚠️ 0.06 WAS TOO SMALL — it bought 2px at size 22 and the gap is
           * visibly wider than that (owner, still clipped after the first fix).
           * The wordmark sits at the left of a `space-between` row with a 36px
           * button at the other end, so there is nothing to compete with and
           * over-reserving costs the layout nothing; under-reserving costs a
           * letter. Sized to the whole tracking debt (8 glyphs x 0.025em) plus
           * the face's right side bearing, rounded up.
           *
           * flexShrink 0 is belt-and-braces: RN defaults to 0, but the home
           * header nests this inside a `flex:1, minWidth:0` column, and that is
           * exactly the shape where a future change starts shrinking it.
           */
          paddingRight: Math.ceil(size * 0.3),
          flexShrink: 0,
        },
        style,
      ]}
    >
      Findable
    </Text>
  );
}

/** Body copy. */
export function Body({ children, tone = 'secondary', style, numberOfLines }: {
  children: ReactNode;
  tone?: 'primary' | 'secondary';
  style?: StyleProp<TextStyle>;
  numberOfLines?: number;
}) {
  return (
    <Text
      numberOfLines={numberOfLines}
      style={[styles.body, tone === 'primary' && { color: colors.textPrimary }, style]}
    >
      {children}
    </Text>
  );
}

/**
 * An archival index number — "01", "02".
 *
 * `tabular-nums` is load-bearing: without it the digits have proportional
 * widths and a column of indices visibly jitters as it scrolls.
 */
export function Index({ n, tone = 'muted', style }: {
  n: number; tone?: 'muted' | 'veil'; style?: StyleProp<TextStyle>;
}) {
  return (
    <Text style={[styles.index, tone === 'veil' && { color: colors.veil }, style]}>
      {String(n).padStart(2, '0')}
    </Text>
  );
}

/* ── Structure ─────────────────────────────────────────────────────────────── */

/** The 1px ghost line. The system's ONLY structural separator — there are no
 *  card shadows, no surface steps and no dividers of any other weight. */
export function Rule({ style }: { style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.rule, style]} />;
}

/** Full-bleed canvas with safe-area padding. `pad` adds the standard gutter. */
export function Screen({ children, pad = false, scroll = false, style }: {
  children: ReactNode; pad?: boolean; scroll?: boolean; style?: StyleProp<ViewStyle>;
}) {
  const insets = useSafeAreaInsets();
  const inner = [
    styles.screen,
    { paddingTop: insets.top },
    pad && { paddingHorizontal: spacing.md },
    style,
  ];
  if (scroll) {
    return (
      <ScrollView
        style={styles.screen}
        contentContainerStyle={[
          { paddingTop: insets.top, paddingBottom: insets.bottom + spacing.xxl },
          pad && { paddingHorizontal: spacing.md },
          style,
        ]}
        showsVerticalScrollIndicator={false}
      >
        {children}
      </ScrollView>
    );
  }
  return <View style={inner}>{children}</View>;
}

/**
 * "There is nothing here" — the one shape for every such moment in the app.
 *
 * ⚠️ WHY THIS EXISTS (owner report, 2026-08-15: "the styling is not matching
 * with Homepage content"). Four screens had grown their own version of this
 * block, and they had drifted apart in ways that are obvious side by side:
 *
 *   home        centred, `Label`+`Title`+`Body`, body maxWidth 380
 *   search      LEFT-aligned, body maxWidth 420
 *   rediscover  LEFT-aligned, body maxWidth 420
 *   todos       centred, but a raw <Text> at fontSize `lg` and **weight 800**
 *
 * That last one is the loud one: `Title` is weight **300** and the note on it
 * says "Never bold this; 300 is the point". So the todos screen was rendering
 * the system's signature type at nearly the opposite weight, in a system whose
 * entire hierarchy is carried by weight and tracking because it has no colour
 * to spend.
 *
 * Home is the reference (owner's instruction), so this is home's version:
 * centred, kicker over title over body. Passing the pieces instead of copying
 * the markup is what stops the fifth screen from drifting again.
 *
 * `children` is the slot for whatever comes after the copy — usually one
 * GhostButton, occasionally more.
 */
export function EmptyState({ kicker, title, body, children, style }: {
  kicker: string;
  title: ReactNode;
  body?: ReactNode;
  children?: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View style={[styles.emptyState, style]}>
      <Label wide>{kicker}</Label>
      {/* numberOfLines 3 because one caller echoes the user's own query back,
          and an unbounded string there can push the body off-screen. */}
      <Title numberOfLines={3} style={styles.emptyStateTitle}>{title}</Title>
      {body ? <Body style={styles.emptyStateBody}>{body}</Body> : null}
      {children}
    </View>
  );
}

/**
 * A section header: tracked uppercase label with a rule under it.
 * Replaces the coloured section pills the outgoing system used.
 */
export function SectionHead({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <View style={styles.sectionHead}>
      <View style={styles.sectionRow}>
        <Label wide>{children}</Label>
        {right}
      </View>
      <Rule style={{ marginTop: spacing.sm }} />
    </View>
  );
}

/* ── Controls ──────────────────────────────────────────────────────────────── */

interface BtnProps {
  label: string;
  onPress?: () => void;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
  /** Right-hand affordance, e.g. "→". Rendered in the same tone as the label. */
  trailing?: string;
}

/**
 * The DEFAULT control: transparent, 1px ink border, 0 radius.
 *
 * mono's rule, kept verbatim — "all buttons should be ghosted or outlined,
 * never solid background fills". This is also the deliberate departure from the
 * app this direction was briefed against, whose primary control is a filled
 * white pill.
 */
export function GhostButton({ label, onPress, disabled, style, trailing }: BtnProps) {
  return (
    // accessibilityRole is safe HERE and only here: these two are leaf controls
    // that never wrap another pressable, so they can be real <button>s on web
    // without the nesting problem documented in Pressable.tsx.
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={[styles.ghost, disabled && styles.btnOff, style]}
    >
      <Text style={styles.ghostLabel}>
        {label.toUpperCase()}{trailing ? `  ${trailing}` : ''}
      </Text>
    </Pressable>
  );
}

/**
 * The one inversion — ink fill, canvas text. At most one per screen.
 *
 * This is also how DESTRUCTIVE actions read. The system has no red, so a
 * destructive control is the inverted button plus wording that names what is
 * lost ("DELETE FOREVER", not "DELETE"). Never colour alone, never weight
 * alone — the label always carries the meaning.
 */
export function FilledButton({ label, onPress, disabled, style, trailing }: BtnProps) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={[styles.filled, disabled && styles.btnOff, style]}
    >
      <Text style={styles.filledLabel}>
        {label.toUpperCase()}{trailing ? `  ${trailing}` : ''}
      </Text>
    </Pressable>
  );
}

/** A bare text action — no chrome at all. For tertiary links ("Restore", "Skip"). */
export function TextAction({ label, onPress, style }: { label: string; onPress?: () => void; style?: StyleProp<TextStyle> }) {
  return (
    <Pressable onPress={onPress} hitSlop={10}>
      <Text style={[styles.textAction, style]}>{label}</Text>
    </Pressable>
  );
}

/**
 * A list row separated by a rule rather than a card.
 * The contact-sheet answer to a settings/menu list.
 */
export function Row({ children, onPress, style }: {
  children: ReactNode; onPress?: () => void; style?: StyleProp<ViewStyle>;
}) {
  const body = <View style={[styles.row, style]}>{children}</View>;
  return (
    <>
      {onPress ? <Pressable onPress={onPress}>{body}</Pressable> : body}
      <Rule />
    </>
  );
}

/**
 * A numbered progress rail — "01 / 04".
 *
 * Replaces the dot pagination the brief's reference uses (whose active dot is
 * also its only spot of colour, which this system cannot have). Tracked
 * tabular figures carry the same information and stay achromatic.
 */
export function Rail({ step, total }: { step: number; total: number }) {
  return (
    <View style={styles.rail}>
      <Text style={styles.railNow}>{String(step).padStart(2, '0')}</Text>
      <Text style={styles.railRest}>{` / ${String(total).padStart(2, '0')}`}</Text>
    </View>
  );
}

const styles = themed(() => StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },

  emptyState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
    gap: spacing.md,
  },
  emptyStateTitle: { textAlign: 'center' },
  // 380, not 420. Long measure is what made these read as walls of text on a
  // phone; the tablet round capped body copy for the same reason.
  emptyStateBody: { textAlign: 'center', maxWidth: 380 },

  label: {
    color: colors.textTertiary,
    fontFamily: typeface.label,
    fontSize: font.xs,
    letterSpacing: tracking.label,
    lineHeight: 13,
  },
  labelWide: { letterSpacing: tracking.labelWide },

  title: {
    color: colors.textPrimary,
    fontFamily: typeface.display,
    fontSize: font.xxl,
    letterSpacing: tracking.title,
    lineHeight: font.xxl * 1.05,
  },
  wordmark: {
    color: colors.textPrimary,
    fontFamily: typeface.wordmark,
  },
  body: {
    color: colors.textSecondary,
    fontFamily: typeface.body,
    fontSize: font.md,
    lineHeight: font.md * 1.5,
  },
  index: {
    color: colors.textTertiary,
    fontFamily: typeface.label,
    fontSize: font.xs,
    letterSpacing: tracking.label,
    fontVariant: ['tabular-nums'],
  },

  rule: { height: 1, backgroundColor: colors.ghostLine },

  sectionHead: { marginTop: spacing.lg, marginBottom: spacing.md },
  sectionRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },

  ghost: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: colors.textPrimary,
    borderRadius: radius.full,
    paddingVertical: 15,
    paddingHorizontal: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ghostLabel: {
    color: colors.textPrimary,
    fontFamily: typeface.label,
    fontSize: font.sm,
    letterSpacing: tracking.labelWide,
  },
  filled: {
    backgroundColor: colors.textPrimary,
    borderWidth: 1,
    borderColor: colors.textPrimary,
    borderRadius: radius.full,
    paddingVertical: 15,
    paddingHorizontal: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  filledLabel: {
    color: colors.background,
    fontFamily: typeface.label,
    fontSize: font.sm,
    letterSpacing: tracking.labelWide,
  },
  btnOff: { opacity: 0.32 },

  textAction: {
    color: colors.textTertiary,
    fontFamily: typeface.label,
    fontSize: font.xs,
    letterSpacing: tracking.label,
    textDecorationLine: 'underline',
  },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: spacing.md,
    gap: spacing.md,
  },

  rail: { flexDirection: 'row', alignItems: 'baseline' },
  railNow: {
    color: colors.textPrimary,
    fontFamily: typeface.label,
    fontSize: font.sm,
    letterSpacing: tracking.label,
    fontVariant: ['tabular-nums'],
  },
  railRest: {
    color: colors.textTertiary,
    fontFamily: typeface.label,
    fontSize: font.sm,
    letterSpacing: tracking.label,
    fontVariant: ['tabular-nums'],
  },
}));
