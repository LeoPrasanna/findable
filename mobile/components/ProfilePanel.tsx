import { useEffect, useState } from 'react';
import { View, Text, StyleSheet, Modal, useWindowDimensions, Alert, Platform, ScrollView, Animated, ActivityIndicator, Switch } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { api, Reel, Usage, UsageLog } from '../services/api';
import { getCachedUsage, refreshUsage, onUsage } from '../services/usageCache';
import { resumesAtSentence } from '../services/quotaReset';
import { shareKeyReady, ensureShareKey, clearShareKey } from '../services/shareKey';
import { Pressable } from './Pressable';
import { Icon } from './Icon';
import { Label, Body, Title, Rule, GhostButton, FilledButton, Index } from './kit';
import { useAuth } from '../contexts/AuthContext';
import { Avatar } from './Avatar';
import { markReopenPanel } from '../services/sessionFlags';
import { useAppUpdate } from '../services/appUpdate';
import { clearSaveCount } from '../services/saveCount';
import { clearNotes } from '../services/notifyStore';
import { NotificationCentre } from './NotificationCentre';
import {
  colors, spacing, font, tracking, typeface, themed,
  SchemePreference, getSchemePreference, setScheme,
} from '../constants/theme';

const APP_VERSION = '1.0.0';

/** How many of today's AI actions the drill-down shows. The endpoint returns up
 *  to 200, but a short, honest list reads better than a wall — and the footer
 *  below says exactly how many more there are. */
const LOG_LIMIT = 10;

const SCHEMES: { key: SchemePreference; label: string }[] = [
  { key: 'light', label: 'Light' },
  { key: 'dark', label: 'Dark' },
  { key: 'system', label: 'System' },
];

/** "3 days" / "1 day" / "a few hours" from an ISO end date. */
function trialDaysLeft(endsAt: string): string {
  const ms = new Date(endsAt).getTime() - Date.now();
  const days = Math.floor(ms / 86400000);
  if (days >= 2) return `${days} days`;
  if (days === 1) return '1 day';
  return 'a few hours';
}

interface Props {
  visible: boolean;
  onClose: () => void;
  reels: Reel[];
  showAsk?: boolean;
  total?: number;
}

export function ProfilePanel({ visible, onClose, reels, showAsk = true, total: totalProp }: Props) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const panelWidth = Math.min(340, width * 0.9);
  const { displayName, profile, signOut, deleteAccount } = useAuth();
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  // null until the first read — "Silent share" with no verdict, rather than a
  // confident "off" that is merely uninitialised.
  const [shareArmed, setShareArmed] = useState<boolean | null>(null);
  const [sharePending, setSharePending] = useState(false);
  // ⚠️ RE-READ ON EVERY OPEN, not once on mount. This panel is mounted for the
  // whole session and only hidden, so a one-shot effect showed whatever the
  // state was the first time it ever opened — which is why the row appeared
  // frozen even after a sign-out and back in (owner, 2026-09-11).
  useEffect(() => {
    if (!visible) return;
    shareKeyReady().then(setShareArmed).catch(() => {});
  }, [visible]);
  // Checks at most once per 5 minutes, and only while the panel is open — see
  // services/appUpdate.ts. `status` is 'none' on web, in Expo Go and in a dev
  // client, so the banner below simply never renders there.
  const { status: updateStatus, apply: applyUpdate } = useAppUpdate(visible);
  const [deleting, setDeleting] = useState(false);
  // Seeded from the login-time fetch (services/usageCache), so the stats row
  // and the tier badge are already correct on the panel's FIRST frame instead
  // of reading "0 saved" until a round-trip lands.
  const [usage, setUsage] = useState<Usage | null>(getCachedUsage);
  // Tap-to-expand drill-down: what today's AI actions were spent on. Lazy —
  // only fetched the first time the user opens it, kept until the panel closes.
  const [logOpen, setLogOpen] = useState(false);
  const [log, setLog] = useState<UsageLog | null>(null);
  const [logLoading, setLogLoading] = useState(false);

  // Refresh the AI budget each time the panel opens; quietly keep the last known
  // value if the request fails (the meter is informative, never blocking).
  useEffect(() => {
    // Still refreshes on open — the AI budget moves while the app is running.
    // The difference is that a stale-but-real number is on screen meanwhile,
    // rather than a placeholder that reads as fact.
    if (visible) refreshUsage().then(u => { if (u) setUsage(u); });
    else {
      setLogOpen(false); setLog(null);   // reset the drill-down on close
      // ⚠️ `showDeleteConfirm` belongs in this reset too. Without it, closing
      // the panel while the confirmation was up left the flag set, and the
      // NEXT time the panel opened it re-presented "Delete your account?"
      // unprompted — a destructive dialog appearing on its own.
      setShowDeleteConfirm(false);
    }
  }, [visible]);

  /**
   * Repaint whenever the cache changes, not only when the panel is opened.
   *
   * ⚠️ Refresh-on-open was the whole strategy, and it made the panel a snapshot
   * of the moment it was opened. Spend an AI action, leave it open, and the
   * meter still read the old number; save a reel from the share sheet and the
   * counts stayed put. Now that every write refreshes the cache (api.ts's
   * mutation hook), subscribing is what turns that into something the user can
   * actually see. Unsubscribes on unmount — `onUsage` returns its own remover.
   */
  useEffect(() => onUsage(setUsage), []);

  const toggleLog = () => {
    const next = !logOpen;
    setLogOpen(next);
    if (next && !log && !logLoading) {
      setLogLoading(true);
      api.getUsageLog().then(setLog).catch(() => {}).finally(() => setLogLoading(false));
    }
  };

  const go = (path: string) => { onClose(); router.push(path as any); };

  /**
   * ⚠️ THE SAVED COUNT MUST COME FROM THE SERVER FIRST.
   *
   * This read `totalProp ?? reels.length`, which was fine while each screen
   * rendered its own panel and passed its own list in. The panel now lives at
   * the root and is handed `reels={[]}` with no total — so it showed **0 saved**
   * next to a server-supplied "14 categories, 4 platforms". Three numbers from
   * two sources, one of them empty.
   *
   * `usage.saves.used` is the whole-library count the backend already computes
   * for the quota meter. The props are kept only as a fallback for the first
   * frame before `getUsage()` lands.
   */
  const total = usage?.saves?.used ?? totalProp ?? reels.length;
  const categories = usage?.categories ?? new Set(reels.map(r => r.category).filter(Boolean)).size;
  const platforms = usage?.platforms ?? new Set(reels.map(r => r.platform).filter(Boolean)).size;

  const handleDeleteAccount = async () => {
    if (deleting) return;
    setDeleting(true);
    const result = await deleteAccount();
    setDeleting(false);
    setShowDeleteConfirm(false);
    onClose();
    // The home screen seeds its stage from a remembered count; the next person
    // to open the app on this device must not inherit a stranger's number —
    // nor their save receipts.
    clearSaveCount();
    clearNotes();
    if (result.error) {
      // Alert.alert is a silent no-op on react-native-web — errors must be
      // visible on every platform or deletion failures look like nothing.
      if (Platform.OS === 'web') window.alert(result.error);
      else Alert.alert('Account deletion failed', result.error);
    }
  };

  /**
   * Live switch: setScheme mutates the tokens, regenerates themed() sheets and
   * remounts the tree (see constants/theme.ts) — instant, no page reload. The
   * session flag reopens this panel after the remount so the user sees the
   * result of what they just tapped.
   */
  const chooseScheme = (key: SchemePreference) => {
    if (key === getSchemePreference()) return;
    markReopenPanel();
    setScheme(key);
  };

  const Stat = ({ n, value, label }: { n: number; value: number; label: string }) => (
    <View style={styles.stat}>
      <Index n={n} />
      <Text style={styles.statValue}>{value}</Text>
      <Label>{label}</Label>
    </View>
  );

  const NavRow = ({ label, path }: { label: string; path: string }) => (
    <>
      <Pressable style={styles.row} onPress={() => go(path)}>
        <Body tone="primary" style={styles.rowLabel}>{label}</Body>
        <Icon name="chevron-right" size={15} color={colors.textTertiary} />
      </Pressable>
      <Rule />
    </>
  );

  const used = usage ? Math.min(usage.used, usage.limit) : 0;

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <View style={styles.root}>
        <Pressable style={styles.backdropTap} onPress={onClose} />

        <View style={[styles.panelWrap, { width: panelWidth }]}>
          <ScrollView
            style={styles.panel}
            contentContainerStyle={{
              paddingHorizontal: spacing.lg,
              paddingTop: insets.top + spacing.md,
              paddingBottom: insets.bottom + spacing.xl,
            }}
            showsVerticalScrollIndicator={false}
          >
            <View style={styles.header}>
              <Label wide>Account</Label>
              <Pressable onPress={onClose} hitSlop={10} accessibilityLabel="Close">
                <Icon name="close" size={19} color={colors.textPrimary} />
              </Pressable>
            </View>
            <Rule style={{ marginTop: spacing.sm }} />

            {/* ── Update banner ───────────────────────────────────────────────
                FIRST THING IN THE PANEL, above the identity block, and that
                position is the point. `expo-updates` already downloaded this
                bundle during a launch and was going to apply it on some later
                one without ever saying so (see services/appUpdate.ts) — an
                update the user cannot see or ask for is not shipped. Anywhere
                further down and it is a footnote under three sections of
                account chrome.

                ⚠️ It renders ONLY when there is genuinely something to apply.
                No "you're up to date" row: a permanent status line about
                software versions is noise in a panel whose job is the account,
                and it would be the one thing in here that is usually inert.

                Reuses FilledButton — the same control as Go Pro, deliberately.
                Inventing a banner style for this would make the rarest element
                in the panel also the loudest. The two live states take
                different presses (download-then-restart vs restart), so the
                label says which, and the line beneath says what the press
                costs: the app restarts.

                ⚠️ KEEP EVERY LABEL AT OR UNDER ~18 CHARACTERS. FilledButton
                UPPERCASES its label and sets it at font.sm with 1.4 tracking,
                and this panel is at most 340pt wide — 292 of content, 252
                inside the pill's own padding. That is roughly 26 characters
                before the pill wraps to two lines and stops reading as a
                button. "Update available — tap to update" was 32 and did. The
                instruction lives in the Label underneath, where it has the
                width for it. ── */}
            {updateStatus !== 'none' && (
              <View style={styles.update}>
                <FilledButton
                  label={
                    updateStatus === 'downloading' ? 'Downloading…'
                    : updateStatus === 'restarting' ? 'Restarting…'
                    : updateStatus === 'ready' ? 'Restart to update'
                    : 'Update available'
                  }
                  trailing={updateStatus === 'available' || updateStatus === 'ready' ? '→' : undefined}
                  disabled={updateStatus === 'downloading' || updateStatus === 'restarting'}
                  onPress={applyUpdate}
                />
                <Label>
                  {updateStatus === 'downloading'
                    ? 'Fetching the latest version.'
                    : updateStatus === 'restarting'
                    ? 'Reopening with the latest version.'
                    : updateStatus === 'ready'
                    ? 'Downloaded and ready. Tap to restart into it — your saves are on your account, so nothing is lost.'
                    : 'Tap to update. Findable restarts to finish — your saves are on your account, so nothing is lost.'}
                </Label>
              </View>
            )}

            {/* ── Identity. Square avatar, hairline frame — the reference app's
                circular avatar is one of its signatures and this system is 0
                radius everywhere regardless. ── */}
            <View style={styles.account}>
              <View style={styles.avatar}>
                {/* 48 inside the 56 frame, so the hairline reads as a frame
                    rather than being crowded out by the art. The three states
                    (illustrated key / legacy emoji as text / neutral mark) live
                    in <Avatar>. */}
                <Avatar value={profile.avatar} size={48} />
              </View>
              <View style={styles.accountText}>
                <Text style={styles.name} numberOfLines={1}>{displayName}</Text>
                {/* ⚠️ THE EMAIL WAS HERE AND IS NOT COMING BACK (owner,
                    2026-09-09). It was never useful — you know your own address
                    — and Sign in with Apple made it actively bad: a relay
                    account renders as 8WDNK9ZB6B@PRIVATERELAY.APPLEID.COM,
                    which identifies nothing and is the first thing you see in
                    the panel. `email` is still read from the session for
                    displayName's fallback; it is simply not printed. */}
                <Label numberOfLines={1}>Synced to your account</Label>
                {/* Only once usage loads — otherwise it flashes "Free" then
                    corrects, which reads as a downgrade glitch to a paying user. */}
                {usage && (
                  <View style={styles.tier}>
                    <Label tone="ink">
                      {usage.tier === 'pro' ? 'Pro' : usage.tier === 'trial' ? 'Trial' : 'Free'}
                    </Label>
                  </View>
                )}
              </View>
            </View>

            {/* ── Upgrade ──
                ⚠️ `usage &&`, not `usage?.tier !== 'pro'`. `usage` starts null
                and is only fetched when the panel OPENS, so the optional chain
                made "not loaded yet" identical to "free" and showed a paying
                user a live Go Pro button for the whole round-trip — seconds,
                against a cold Render instance. Same reasoning as the tier badge
                above: hiding an upsell for a moment costs nothing, showing one
                to a subscriber reads as a billing failure. */}
            {usage && usage.tier !== 'pro' && (
              <FilledButton
                label="Go Pro"
                trailing="→"
                onPress={() => go('/pro')}
                style={styles.upgrade}
              />
            )}

            {/* ── Library ── */}
            <Label wide style={styles.section}>Your library</Label>
            <Rule />
            <View style={styles.stats}>
              <Stat n={1} value={total} label="Saved" />
              <Stat n={2} value={categories} label="Categories" />
              <Stat n={3} value={platforms} label="Platforms" />
            </View>
            <Rule />

            {/* ── Daily AI budget — an honest meter so a quota 429 is never a
                surprise. Segmented rather than a filled bar: with no colour to
                spend, counting discrete marks reads faster than judging the
                length of a grey rectangle. ── */}
            {usage && (
              <>
                <Label wide style={styles.section}>AI usage today</Label>
                <Rule />
                <Pressable
                  onPress={usage.used > 0 ? toggleLog : undefined}
                  disabled={usage.used === 0}
                  style={styles.usage}
                >
                  <View style={styles.usageHead}>
                    <Body tone="primary" style={styles.rowLabel}>
                      {usage.remaining} of {usage.limit} left
                    </Body>
                    {usage.used > 0 && (
                      <Icon
                        name="chevron-right" size={14} color={colors.textTertiary}
                        style={{ transform: [{ rotate: logOpen ? '90deg' : '0deg' }] }}
                      />
                    )}
                  </View>
                  <View style={styles.meter}>
                    {Array.from({ length: Math.min(usage.limit, 30) }).map((_, i) => {
                      // When the limit exceeds the 30 marks we draw, each mark
                      // stands for a proportional share rather than one action.
                      const per = usage.limit / Math.min(usage.limit, 30);
                      return (
                        <View
                          key={i}
                          style={[styles.tick, i * per < used && styles.tickOn]}
                        />
                      );
                    })}
                  </View>
                </Pressable>

                {logOpen ? (
                  <View style={styles.logBox}>
                    {logLoading && !log ? (
                      <Label>Loading…</Label>
                    ) : log && log.items.length > 0 ? (
                      <>
                        {/* Say what this list is, so a short list never reads as
                            "that's everything" when it isn't. */}
                        <Label>
                          {`Last ${Math.min(LOG_LIMIT, log.items.length)} action${Math.min(LOG_LIMIT, log.items.length) > 1 ? 's' : ''} · newest first`}
                        </Label>
                        {log.items.slice(0, LOG_LIMIT).map((it, i) => (
                          <View key={i} style={styles.logRow}>
                            <Index n={i + 1} />
                            <View style={styles.logText}>
                              <Body tone="primary" style={styles.logAction}>{it.action_label}</Body>
                              {it.label ? <Label numberOfLines={1}>{it.label}</Label> : null}
                            </View>
                          </View>
                        ))}
                        {/* Covers BOTH kinds of hidden action: ones past the 10 we
                            show, and ones charged before the log existed. */}
                        {(() => {
                          const shown = Math.min(LOG_LIMIT, log.items.length);
                          const hidden = log.used - shown;
                          return hidden > 0 ? (
                            <Label>{`+ ${hidden} more action${hidden > 1 ? 's' : ''} today`}</Label>
                          ) : null;
                        })()}
                      </>
                    ) : (
                      <Label>No recorded actions yet today.</Label>
                    )}
                  </View>
                ) : (
                  <Body style={styles.hint}>
                    {usage.used > 0
                      ? "Summaries, recipes, workouts and questions all count. Tap to see today's."
                      : 'Summaries, recipes, workouts and questions all count. Resets daily.'}
                  </Body>
                )}

                {/* ⚠️ AT ZERO, THE RESET TIME IS THE ONLY USEFUL THING ON THIS
                    ROW. "0 of 20 left" with no answer to "left until when?" is
                    what makes a quota feel arbitrary. The server has always
                    returned `resets_at`; nothing showed it until 2026-08-14.
                    Rendered in the user's own clock — midnight UTC is 5:30 AM
                    in India and 8 PM the previous day in California, so the
                    word "tomorrow" was actively wrong for some people. */}
                {usage.remaining === 0 && (
                  <Body style={styles.hint}>{resumesAtSentence(usage.resets_at)}</Body>
                )}

                {usage.tier === 'trial' && usage.trial_ends_at && (
                  <Body style={styles.hint}>
                    Trial — {trialDaysLeft(usage.trial_ends_at)} left, then 3 AI actions a day and 20 saves.
                  </Body>
                )}
                {usage.tier === 'free' && usage.saves.limit != null && (
                  <Body style={styles.hint}>
                    Saves used: {usage.saves.used} of {usage.saves.limit}. Pro unlocks more.
                  </Body>
                )}
                <Rule style={{ marginTop: spacing.md }} />
              </>
            )}

            {/* ── Notifications ──
                Sits under the budget meter because both answer "what has this
                app done lately?", and above Explore because it is a receipt,
                not a destination. ── */}
            <NotificationCentre visible={visible} />

            {/* ── Explore ── */}
            <Label wide style={styles.section}>Explore</Label>
            <Rule />
            {showAsk && <NavRow label="Ask your library" path="/ask" />}
            <NavRow label="Search your library" path="/search" />
            <NavRow label="Rediscover saves" path="/rediscover" />
            <NavRow label="What you can do" path="/help" />

            {/* ── Settings ── */}
            <Label wide style={styles.section}>Settings</Label>
            <Rule />
            <NavRow label="Edit profile" path="/profile" />
            <NavRow label="Support" path="/support" />

            {/* Appearance, inline. Three tracked words; the active one is ink
                with a rule under it — the same selection grammar the category
                filter uses, so "selected" means one thing across the app. */}
            <View style={styles.appearance}>
              <Body tone="primary" style={styles.rowLabel}>Appearance</Body>
              <View style={styles.schemeRow}>
                {SCHEMES.map(s => {
                  const active = s.key === getSchemePreference();
                  return (
                    <Pressable
                      key={s.key}
                      onPress={() => chooseScheme(s.key)}
                      hitSlop={6}
                      style={styles.scheme}
                      accessibilityLabel={`${s.label} appearance`}
                    >
                      <Label tone={active ? 'ink' : 'muted'} wide>{s.label}</Label>
                      <View style={[styles.schemeRule, active && styles.schemeRuleOn]} />
                    </Pressable>
                  );
                })}
              </View>
            </View>
            <Rule />

            {/* ── Session ── */}
            <Label wide style={styles.section}>Session</Label>
            <Rule />
            {/*
              ⚠️ A REAL TOGGLE, NOT A RETRY BUTTON — and it shipped as the
              wrong one. The first version only ever re-armed: tapping it while
              it read "Silent share is on" re-minted the same key and changed
              nothing on screen, so the owner could not tell whether the tap had
              worked (2026-09-11). A row that reads "X is on" and responds to a
              tap is a switch; anything else is a lie about the control.

              It exists at all because the feature is invisible by design —
              sharing saves without opening the app, so a failure to arm looks
              exactly like the bug the share extension was built to fix, with
              nothing anywhere to tell the two apart.

              Turning it OFF is a genuine choice, not just a debugging aid: it
              revokes the key locally AND on the server, and shares then fall
              back to opening the app, where you see what you saved.
            */}
            {Platform.OS !== 'web' ? (
              <>
                <Pressable
                  style={styles.row}
                  disabled={sharePending}
                  accessibilityRole="switch"
                  accessibilityState={{ checked: shareArmed === true, disabled: sharePending }}
                  accessibilityLabel="Silent share"
                  accessibilityHint={
                    shareArmed
                      ? 'Turns off saving in the background; shares will open the app instead'
                      : 'Saves shared links in the background without opening the app'
                  }
                  onPress={async () => {
                    if (sharePending) return;
                    const turningOn = !shareArmed;
                    setSharePending(true);
                    // Optimistic, because the server round-trip is the slow part
                    // and a switch that does nothing for two seconds reads as
                    // broken. Corrected below if the real answer differs.
                    setShareArmed(turningOn);
                    try {
                      if (turningOn) {
                        setShareArmed(await ensureShareKey());
                      } else {
                        await clearShareKey();
                        setShareArmed(false);
                      }
                    } catch {
                      // Never leave the switch showing a state we did not reach.
                      setShareArmed(await shareKeyReady().catch(() => false));
                    } finally {
                      setSharePending(false);
                    }
                  }}
                >
                  <View style={styles.rowLabelWrap}>
                    <Body tone="primary" style={styles.rowLabel}>Silent share</Body>
                    <Label>
                      {shareArmed === null ? 'Checking…'
                        : shareArmed ? 'Saves without opening the app'
                        : 'Shares will open the app'}
                    </Label>
                  </View>
                  {sharePending
                    ? <ActivityIndicator size="small" color={colors.textTertiary} />
                    : <Switch
                        value={shareArmed === true}
                        onValueChange={() => {}}
                        pointerEvents="none"
                        trackColor={{ false: colors.ghostLine, true: colors.textPrimary }}
                        thumbColor={colors.background}
                        ios_backgroundColor={colors.ghostLine}
                      />}
                </Pressable>
                <Rule />
              </>
            ) : null}
            <Pressable style={styles.row} onPress={() => { onClose(); signOut(); }}>
              <Body tone="primary" style={styles.rowLabel}>Sign out</Body>
              <Icon name="login" size={15} color={colors.textTertiary} />
            </Pressable>
            <Rule />
            <Pressable style={styles.row} onPress={() => setShowDeleteConfirm(true)}>
              <Body tone="primary" style={styles.rowLabel}>Delete account</Body>
              <Icon name="trash" size={15} color={colors.textTertiary} />
            </Pressable>
            <Rule />

            <View style={styles.footer}>
              <Label>Findable</Label>
              <Label>{`v${APP_VERSION}`}</Label>
            </View>
          </ScrollView>
        </View>
      </View>

      {/* ── Delete confirmation ─────────────────────────────────────────────
          Destructive reads by INVERSION plus wording that names what is lost —
          the system has no red, and colour alone was never an accessible way
          to mark a destructive action anyway. Cancel is the ghost (larger tap
          comfort, no emphasis); the irreversible one is the filled button and
          says exactly what it destroys. ── */}
      <Modal visible={showDeleteConfirm} transparent animationType="fade" statusBarTranslucent>
        <View style={styles.confirmOverlay}>
          <View style={styles.confirmCard}>
            <Label wide>Irreversible</Label>
            <Title style={styles.confirmTitle}>Delete your account?</Title>
            <Body style={styles.confirmDesc}>
              This permanently removes every saved link, summary, note, to-do, recipe and workout
              plan, and the account itself. It cannot be undone.
            </Body>
            <View style={styles.confirmActions}>
              <GhostButton
                label="Keep my account"
                onPress={() => setShowDeleteConfirm(false)}
                style={styles.confirmBtn}
              />
              <FilledButton
                label={deleting ? 'Deleting…' : 'Delete everything'}
                onPress={handleDeleteAccount}
                disabled={deleting}
                style={styles.confirmBtn}
              />
            </View>
          </View>
        </View>
      </Modal>
    </Modal>
  );
}

const styles = themed(() => StyleSheet.create({
  root: { flex: 1, backgroundColor: 'rgba(0,0,0,0.72)' },
  backdropTap: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  panelWrap: { position: 'absolute', top: 0, bottom: 0, right: 0 },
  panel: {
    flex: 1,
    backgroundColor: colors.background,
    borderLeftWidth: 1,
    borderLeftColor: colors.ghostLine,
  },

  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },

  account: { flexDirection: 'row', gap: spacing.md, paddingVertical: spacing.lg, alignItems: 'center' },
  avatar: {
    width: 56, height: 56,
    borderWidth: 1, borderColor: colors.ghostLine,
    alignItems: 'center', justifyContent: 'center',
  },
  accountText: { flex: 1, minWidth: 0, gap: spacing.xs },
  name: {
    color: colors.textPrimary,
    fontFamily: typeface.display,
    fontSize: font.xl,
    letterSpacing: tracking.heading,
  },
  tier: {
    alignSelf: 'flex-start',
    borderWidth: 1,
    borderColor: colors.textPrimary,
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    marginTop: spacing.xs,
  },

  upgrade: { marginBottom: spacing.md },

  update: { marginTop: spacing.md, gap: spacing.sm },
  section: { marginTop: spacing.xl, marginBottom: spacing.sm },

  stats: { flexDirection: 'row', paddingVertical: spacing.md },
  stat: { flex: 1, gap: spacing.xs },
  statValue: {
    color: colors.textPrimary,
    fontFamily: typeface.display,
    fontSize: font.xxl,
    letterSpacing: tracking.title,
    fontVariant: ['tabular-nums'],
  },

  usage: { paddingVertical: spacing.md, gap: spacing.sm },
  usageHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  meter: { flexDirection: 'row', gap: 2 },
  tick: { flex: 1, height: 6, backgroundColor: colors.ghostLine },
  tickOn: { backgroundColor: colors.textPrimary },

  logBox: { gap: spacing.sm, paddingBottom: spacing.md },
  logRow: { flexDirection: 'row', gap: spacing.sm, alignItems: 'flex-start' },
  logText: { flex: 1, minWidth: 0 },
  logAction: { fontSize: font.sm },
  hint: { fontSize: font.sm, lineHeight: 19, paddingBottom: spacing.sm },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: spacing.md,
    gap: spacing.md,
  },
  rowLabel: { flex: 1, fontSize: font.md },
  // The switch row carries a second line saying what the state MEANS. "On" and
  // "off" are not self-explanatory for a feature whose whole point is that it
  // leaves no trace.
  rowLabelWrap: { flex: 1, gap: 2 },

  appearance: { paddingVertical: spacing.md, gap: spacing.md },
  schemeRow: { flexDirection: 'row', gap: spacing.lg },
  scheme: { gap: spacing.xs },
  schemeRule: { height: 1, backgroundColor: 'transparent' },
  schemeRuleOn: { backgroundColor: colors.textPrimary },

  footer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: spacing.xl,
  },

  confirmOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.85)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.lg,
  },
  confirmCard: {
    width: '100%',
    maxWidth: 420,
    backgroundColor: colors.background,
    borderWidth: 1,
    borderColor: colors.textPrimary,
    padding: spacing.lg,
    gap: spacing.sm,
  },
  confirmTitle: { marginTop: spacing.xs },
  confirmDesc: { fontSize: font.sm, lineHeight: 20, marginTop: spacing.xs },
  confirmActions: { gap: spacing.sm, marginTop: spacing.lg },
  confirmBtn: { width: '100%' },
}));
