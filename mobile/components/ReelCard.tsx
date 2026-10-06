import { memo, useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, Platform, Animated, ActivityIndicator, Alert } from 'react-native';
import { useRouter } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { Icon } from './Icon';
import { cardTitle } from '../services/cardTitle';
import { GeneratedCover } from './GeneratedCover';
import { Reel, thumbCandidates } from '../services/api';
import * as haptics from '../services/haptics';
import { getCachedUsage } from '../services/usageCache';
import { resetsAtLabel } from '../services/quotaReset';
import { canRefreshThumb, refreshThumb } from '../services/thumbRefresh';
import { Pressable } from './Pressable';
import { Label } from './kit';
import {
  colors, spacing, font, radius, tracking, typeface, platformMeta, gradients, onImage, motion, themed,
} from '../constants/theme';

interface ReelCardProps {
  reel: Reel;
  index?: number;
  onDelete?: (id: string) => void;
  /** Height/width of the image well. Supplied by the masonry grid so tiles
   *  stagger; defaults to 3:4 portrait for the fixed-row grids. */
  aspect?: number;
}

/**
 * The intrinsic ratio of a thumbnail is unknown until the image loads, and
 * resizing the tile at that point reflows every tile below it — so the mosaic
 * picks a stable ratio up front, hashed from the reel id. Deterministic: a tile
 * never changes height between renders or sessions.
 *
 * ⚠️ EVERY RATIO IS PORTRAIT. Reels are vertical, and an earlier version handed
 * YouTube and LinkedIn *landscape* wells on the theory that they serve landscape
 * thumbnails. That put two different tile shapes in one grid, which is what made
 * the wall look inconsistent — and it framed YouTube's baked-in pillarbox bars
 * instead of cutting them. (The bars are now solved properly upstream, by
 * requesting `oardefault.jpg` — see `thumbCandidates` in services/api.ts.)
 */
const RATIOS = [3 / 4, 4 / 5, 2 / 3, 9 / 16];

export function aspectFor(reel: { id: string; platform?: string | null }): number {
  let h = 0;
  const s = reel.id || '';
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return RATIOS[h % RATIOS.length];
}

/**
 * A mosaic tile. THE IMAGE IS THE TILE — and nothing else is.
 *
 * Square-cornered, no card, no radius, no shadow, no chrome, and (after two
 * rounds of owner review) no text either. It went caption-block → scrim overlay
 * → bare picture, because each layer of metadata was the thing making a wall of
 * images read as a list of panels. Title, category and platform all live one tap
 * away on the detail screen, which has room for them.
 */
function ReelCardInner({ reel, index = 0, onDelete, aspect = 3 / 4 }: ReelCardProps) {
  const router = useRouter();
  // Walk the candidate list (see api.thumbCandidates): the un-letterboxed
  // YouTube frame first, the stored URL if that 404s, an empty frame if both
  // fail. `candidate` is an index into that list.
  const candidates = thumbCandidates(reel.thumbnail_url);
  const [candidate, setCandidate] = useState(0);
  /**
   * A URL the server re-resolved for us after every stored candidate failed.
   *
   * ⚠️ Instagram CDN links are SIGNED and expire (~5 days, measured) — after
   * that the stored URL is permanently 403 and no retry of it can ever work.
   * The only repair is asking the platform again, which is what this is. Also
   * covers reels whose extraction failed at save time and never had one.
   * Bounded per session in services/thumbRefresh.ts.
   */
  const [repaired, setRepaired] = useState<string | null>(null);
  const [repairing, setRepairing] = useState(false);
  const opacity = useRef(new Animated.Value(0)).current;
  const imgOpacity = useRef(new Animated.Value(0)).current;

  // A plain fade. The outgoing card slid up, scaled and rotated away on delete;
  // this direction's motion rule is "colour and opacity only, nothing
  // decorative", and a rotating rectangle on a contact sheet reads as a fault.
  useEffect(() => {
    Animated.timing(opacity, {
      toValue: 1,
      duration: motion.micro,
      delay: Math.min(index, 8) * 25,
      useNativeDriver: true,
    }).start();
  }, []);

  /**
   * ⚠️ ON NATIVE THIS USED TO CONFIRM NOTHING — `confirmed` was hardcoded
   * `true` off web, so a long press DELETED THE SAVE INSTANTLY, with no dialog
   * and no undo (owner report, first TestFlight build, 2026-09-09: "long
   * pressing a reel on library it's getting deleted").
   *
   * A long press is not a deliberate enough gesture to destroy data on its own
   * — it is what a thumb does while scrolling, and the deletion is permanent.
   * The detail screen's delete has always confirmed; the gesture that replaced
   * the visible × simply never got the same treatment.
   */
  const runDelete = () => {
    haptics.tap();
    /**
     * ⚠️ `onDelete` FIRES IMMEDIATELY, not in the animation's completion
     * callback, and this card no longer calls the API at all.
     *
     * Two reasons. The owner asked for delete to feel instant, and waiting for
     * a fade before even telling the list is a delay we chose to add. And the
     * DELETE used to be fired here with `.catch(() => {})` — so a failure was
     * invisible: the tile vanished, the save survived on the server, and it
     * came back at the next refresh with no explanation. The screen that owns
     * the list is the only thing that can report that honestly, so it owns the
     * request now (see `removeReel` in app/index.tsx).
     *
     * The fade still runs; it just no longer gates anything.
     */
    Animated.timing(opacity, {
      toValue: 0,
      duration: motion.micro,
      useNativeDriver: true,
    }).start();
    onDelete?.(reel.id);
  };

  const handleDelete = () => {
    if (Platform.OS === 'web') {
      if (window.confirm('Remove this save?')) runDelete();
      return;
    }
    haptics.warning();
    Alert.alert(
      'Remove this save?',
      'It will be deleted from your library. This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Remove', style: 'destructive', onPress: runDelete },
      ],
    );
  };

  const platform = platformMeta[reel.platform] ?? platformMeta.unknown;
  const isPending = reel.summary_status === 'pending';
  const failed = reel.summary_status === 'failed';
  const overQuota = reel.summary_status === 'quota_exceeded';
  // Read from the cache rather than fetched — a grid can hold hundreds of these
  // and none of them should make a request. The cache is filled at login and
  // refreshed on every foreground (app/_layout.tsx).
  const quotaLabel = overQuota ? resetsAtLabel(getCachedUsage()?.resets_at) : '';
  // The repaired URL wins: it is the only one known to be currently valid.
  const thumb = repaired ?? candidates[candidate];

  /**
   * Every stored candidate has now failed. Ask the server for a live URL once.
   *
   * Only fires when there was something to fail — a reel that never had a
   * thumbnail starts with an empty candidate list, and that is handled by the
   * mount effect below rather than by an image error that can never happen.
   */
  const onImageFailed = () => {
    const next = candidate + 1;
    setCandidate(next);
    if (next < candidates.length || repaired || repairing) return;
    tryRepair();
  };

  const tryRepair = () => {
    if (repairing || repaired || !canRefreshThumb(reel.id)) return;
    setRepairing(true);
    refreshThumb(reel.id)
      .then(url => { if (url) setRepaired(url); })
      .finally(() => setRepairing(false));
  };

  // A reel with no stored thumbnail at all (extraction failed at save time)
  // never fires onError, so it needs its own nudge. Both classes of the bug end
  // up in the same repair path.
  useEffect(() => {
    if (candidates.length === 0) tryRepair();
  }, [reel.id]);

  /**
   * Tapping a locked tile explains itself rather than doing nothing.
   *
   * ⚠️ A DEAD TILE IS A BUG REPORT. The alternative was disabling the press, and a
   * tile that simply ignores a tap is indistinguishable from a broken one — which is
   * how a deliberate limit becomes "the app does not open my saves any more".
   *
   * ⚠️ IT OFFERS BOTH EXITS, and the free one first. Delete is how someone gets back
   * under the cap without paying, and a limit whose only remedy costs money reads as a
   * hostage note. Long-press still deletes from here, so the free exit is one gesture
   * away from the sentence describing it.
   */
  const explainLock = () => {
    const title = 'This save is locked';
    const body =
      "Your library is over your plan's limit, so the oldest saves are read-only. "
      + 'Nothing has been deleted — long-press a tile to remove saves you are done '
      + 'with, and the older ones unlock. Pro keeps a much larger library open.';
    if (Platform.OS === 'web') window.alert(`${title}\n\n${body}`);
    else Alert.alert(title, body, [
      { text: 'Not now', style: 'cancel' },
      { text: 'See Pro', onPress: () => router.push('/pro') },
    ]);
  };

  return (
    <Animated.View style={[styles.frame, { opacity, aspectRatio: aspect }]}>
      {/* Long-press deletes. The visible × is gone — the reference grid has no
          chrome on its tiles — but removing the affordance entirely would have
          been a silent functional loss, so it moved to a gesture. Delete also
          still lives on the detail screen, with a confirm. */}
      <Pressable
        style={styles.tap}
        onPress={reel.locked ? explainLock : () => router.push(`/reel/${reel.id}`)}
        onLongPress={handleDelete}
      >
        {thumb ? (
          <Animated.Image
            // Keyed on the candidate so a fallback actually remounts the image
            // rather than reusing the failed one's element.
            key={thumb}
            source={{ uri: thumb }}
            style={[styles.image, { opacity: imgOpacity }]}
            resizeMode="cover"
            onLoad={() => Animated.timing(imgOpacity, {
              toValue: 1, duration: motion.micro, useNativeDriver: true,
            }).start()}
            onError={onImageFailed}
          />
        ) : (
          /* ⚠️ No thumbnail, and after `tryRepair` there will never be one —
             so this is a real cover, not a placeholder. It used to be one 20px
             grey glyph on a flat panel, which is what a broken tile looks like;
             this is what a chosen one looks like. Deterministic per reel, drawn
             offline, costs nothing. See components/GeneratedCover.tsx. */
          <View style={styles.image}>
            <GeneratedCover id={reel.id} category={reel.category} />
          </View>
        )}

        {/* ⚠️ THE TEXT IS AN OVERLAY, NOT A CAPTION BLOCK — that distinction is
            the whole point. It rides on a scrim INSIDE the picture's bounds, so
            it costs the tile no height at all. The version that made the wall
            look like a list added a panel BELOW the image and grew every tile
            by ~40%; this adds nothing. */}
        <LinearGradient
          colors={gradients.scrim}
          start={{ x: 0, y: 0.35 }} end={{ x: 0, y: 1 }}
          style={[styles.scrim, { pointerEvents: 'none' }]}
        />

        <View style={styles.overlay}>
          {isPending && (
            <View style={styles.statusRow}>
              <ActivityIndicator size="small" color={onImage.primary} />
              <Text style={styles.meta}>READING</Text>
            </View>
          )}
          {failed && <Text style={styles.meta}>NO TEXT</Text>}
          {/* Out of AI actions — the save is complete, only the summary is
              waiting on the reset. Says so rather than reusing "NO TEXT",
              which blames the reel for the user's daily cap.
              ⚠️ "TOMORROW" was a guess: the reset is midnight UTC, which is
              5:30 AM the same morning in India and 8 PM the PREVIOUS day in
              California. The real time comes off the cached usage; the word
              only survives as the fallback when we have no usage to read. */}
          {overQuota && (
            <Text style={styles.meta} numberOfLines={1}>
              {quotaLabel ? `AI RESUMES ${quotaLabel.toUpperCase()}` : 'AI RESUMES AFTER RESET'}
            </Text>
          )}
          {/* cardTitle, not reel.title: the stored title is cut for the detail
              screen (90 chars) and a tile has two lines of ~30. See the note in
              services/cardTitle.ts. numberOfLines stays as the hard backstop. */}
          <Text style={styles.title} numberOfLines={2}>
            {cardTitle(reel.title) || (isPending ? 'Saving…' : 'Untitled')}
          </Text>
          <Text style={styles.meta} numberOfLines={1}>
            {(reel.category || 'other').toUpperCase()}
          </Text>
        </View>
      </Pressable>

      {/* ⚠️ A SCRIM, NOT A HIDDEN TILE. The picture stays visible on purpose: the
          point of locking rather than deleting is that the save is still THERE, and
          blanking it would look exactly like the deletion we chose not to do. The
          scrim plus the badge says "yours, not open" — pointerEvents none so the tap
          still reaches the explanation above. */}
      {reel.locked ? (
        <View style={styles.lockScrim} pointerEvents="none">
          <View style={styles.lockBadge}>
            {/* ⚠️ onImage, NOT colors.textPrimary. This sits on a 55% black scrim in
                BOTH schemes, and textPrimary inverts with the theme — in light mode
                it would be near-black ink on near-black backing. The onImage tokens
                exist for exactly this surface. */}
            <Icon name="lock-closed" size={11} color={onImage.primary} />
            <Text style={styles.lockText}>LOCKED</Text>
          </View>
        </View>
      ) : null}
    </Animated.View>
  );
}

// Memoized: infinite-scroll appends re-render only the new cards, not the whole
// grid. Compare the fields the card actually displays.
export const ReelCard = memo(ReelCardInner, (prev, next) =>
  prev.reel.id === next.reel.id &&
  prev.index === next.index &&
  prev.aspect === next.aspect &&
  prev.reel.title === next.reel.title &&
  prev.reel.summary_status === next.reel.summary_status &&
  prev.reel.category === next.reel.category &&
  prev.reel.thumbnail_url === next.reel.thumbnail_url &&
  prev.reel.tags[0] === next.reel.tags[0]
);

const styles = themed(() => StyleSheet.create({
  // The tile IS the image. aspectRatio comes from the grid (see aspectFor), so
  // the frame has no intrinsic height of its own and nothing below the picture.
  // The tile IS the image — no padding, no surface behind it, no inset around
  // the photo. That is the load-bearing part of the Pinterest read: the rounded
  // rectangle IS the picture. Wrap it in a padded card and it becomes a sticker.
  /* ⚠️ ABSOLUTE FILL, OUTSIDE THE PRESSABLE. It cannot live inside the tap target
     or it would swallow the press that explains it, and it cannot dim the frame via
     `opacity` on the parent because that animates on mount (see `opacity` above) and
     the two would fight. */
  lockScrim: {
    position: 'absolute', top: 0, right: 0, bottom: 0, left: 0,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center', justifyContent: 'center',
  },
  lockBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    paddingHorizontal: spacing.sm, paddingVertical: 5,
    borderRadius: radius.full,
    backgroundColor: 'rgba(0,0,0,0.5)',
    borderWidth: 1, borderColor: onImage.muted,
  },
  lockText: {
    color: onImage.primary, fontSize: 9, fontWeight: '800',
    letterSpacing: tracking.label,
  },

  frame: {
    /**
     * ⚠️ WIDTH, NOT `flex: 1` — AND THIS IS THE FIX FOR THE MANGLED LIBRARY
     * GRID (owner screenshot, 2026-08-16). Do not put `flex` back.
     *
     * The tile's height must come from `aspectRatio` against its width, and
     * nothing else. `flex: 1` means `flexBasis: 0; flexGrow: 1`, which is a
     * COMPETING opinion about that same height whenever the parent is a
     * column — and in the masonry it is. Two rules for one dimension, and
     * which one wins is a Yoga implementation detail.
     *
     * ⚠️ IT WON DIFFERENTLY AFTER THE SDK 57 / RN 0.86.2 UPGRADE. Under RN
     * 0.85 aspectRatio won and the grid was right; a note here even said so.
     * After the upgrade flex won, so tiles DIVIDED their column's height
     * instead of deriving it: a column holding one tile stretched that tile to
     * the full height of the tallest column, a column holding two gave each
     * half. That is the giant tile beside two squashed ones, the black
     * letterbox bands (the image keeps `cover` inside a frame of the wrong
     * shape), and the titles colliding. Nothing about the grid's own maths
     * changed — the tile's height rule did.
     *
     * ⚠️ WHY THE CARD CANNOT JUST CARRY `flex: 1` FOR EVERYONE. In
     * `app/rediscover.tsx` the parent is a FlatList ROW, where flex is the
     * WIDTH axis and IS needed to divide the row evenly. That is the grid's
     * job, not the card's, so Rediscover now wraps each card in its own
     * `flex: 1` view and the card stays purely "as wide as I am given, as tall
     * as my ratio says". One rule per dimension, in one place.
     */
    width: '100%',
    backgroundColor: colors.card,
    overflow: 'hidden',
    /**
     * ⚠️ ROUNDED — owner direction, 2026-08-12. This was pinned to 0 with a
     * comment arguing the opposite; the library is now the one surface that
     * departs from the contact sheet's absolute 0-radius rule. Everything
     * else in the app is still square. Grep before reusing this.
     *
     * 16 (`radius.lg`) is not a taste call — measured across four Pinterest
     * screens at 14–16pt. Note it is an ABSOLUTE constant, never a fraction of
     * tile width: Pinterest uses the same ~15pt on a 116pt 3-column tile as on
     * a 182pt 2-column one. And it does NOT scale up with the gutter — 16 with
     * generous spacing reads as Pinterest, 24 reads as a widget dashboard.
     */
    borderRadius: radius.lg,
  },
  tap: { flex: 1 },

  // ⚠️ The radius is repeated on the absolutely-positioned children on purpose.
  // Android does not reliably clip `position: absolute` descendants to a
  // parent's ROUNDED shape — `overflow: 'hidden'` clips to its bounding
  // rectangle — so without these the image's and scrim's square corners poke
  // out past the frame. Free on iOS/web, and it is the same class of bug that
  // made the tab bar's gradient render as a rectangle (see TabBar.tsx).
  image: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
    width: '100%', height: '100%',
    borderRadius: radius.lg,
  },

  // Inside the picture's bounds — costs the tile no height. Only the BOTTOM
  // corners are rounded: the scrim starts mid-tile, so its top edge is straight.
  scrim: {
    // ⚠️ 38%, was 55% (2026-08-15). The scrim is the thing that MULTIPLIES with
    // column count: on a phone you see ~6 tiles and so ~6 grey gradients; on a
    // tablet grid you see 15+, and the wall of saved pictures — the only colour
    // this system spends — ends up more than half covered in grey. Neither
    // reference does this: Pinterest puts no text on the tile at all, and the
    // primary style reference puts text on the tile but forbids tinted overlays
    // outright. 38% still carries two lines of title legibly.
    position: 'absolute', left: 0, right: 0, bottom: 0, height: '38%',
    borderBottomLeftRadius: radius.lg,
    borderBottomRightRadius: radius.lg,
  },
  overlay: {
    position: 'absolute',
    left: spacing.sm, right: spacing.sm, bottom: spacing.sm,
    gap: 2,
  },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, marginBottom: 2 },
  // ⚠️ Fixed light tones, not `colors.*` — this sits on a photograph, and the
  // photograph does not invert between light and dark mode.
  title: {
    color: onImage.primary,
    fontFamily: typeface.display,
    fontSize: font.sm,
    lineHeight: 16,
    letterSpacing: -0.2,
  },
  meta: {
    color: onImage.muted,
    fontFamily: typeface.label,
    fontSize: font.xs,
    letterSpacing: tracking.label,
  },
}));
