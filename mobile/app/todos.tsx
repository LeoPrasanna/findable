import { useState, useCallback, useMemo, useRef, useEffect, memo } from 'react';
import { View, Text, StyleSheet, ScrollView, ActivityIndicator, RefreshControl, Modal } from 'react-native';
import { useRouter, useFocusEffect, useNavigation } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { MotiView, AnimatePresence } from 'moti';
import { api, Todo, TodoStats } from '../services/api';
import { Pressable } from '../components/Pressable';
import { Icon } from '../components/Icon';
import { TodoEditor } from '../components/TodoEditor';
import { RollingTagline } from '../components/RollingTagline';
import { MascotLoader } from '../components/MascotLoader';
import { TodoGoalBar } from '../components/TodoGoalBar';
import { Avatar } from '../components/Avatar';
import { useAuth } from '../contexts/AuthContext';
import { emitUi, useDismissOnBackground } from '../services/uiBus';
import { Label, EmptyState } from '../components/kit';
import { TAB_BAR_CLEARANCE } from '../components/TabBar';
import { TodoSettingsSheet } from '../components/TodoSettingsSheet';
import { bucketOf, formatDue, todayISO, Bucket } from '../services/todoDates';
import { mergeTodoList } from '../services/todoMerge';
import { useTodoSettings } from '../services/todoSettings';
import { TODO_QUOTES, TODO_ROLL_NAMES, TODO_ADD_LABEL } from '../constants/todoBrand';
import * as haptics from '../services/haptics';
import { colors, spacing, font, radius, tracking, typeface, gradients, shadow, themed } from '../constants/theme';

/**
 * Priority marks.
 *
 * ⚠️ This was a COLOUR map (red / amber / grey). The system is achromatic, so
 * priority is carried by mark shape instead — solid, hollow, hairline. That is
 * also the accessible version: red-vs-amber was never distinguishable to a
 * red-green colourblind reader, which is most of the people who can't read it.
 */
const PRIORITY_MARK: Record<string, 'filled' | 'hollow' | 'faint'> = {
  high: 'filled',
  medium: 'hollow',
  low: 'faint',
};

/** "Someday" sits last by default — undated items are the ones you're least
 *  committed to, and burying them keeps the top of the list honest. Settings can
 *  flip it for people who work the other way round. */
/**
 * ⚠️ THE THUMBS-UP USED TO FIRE HERE, when the fetch came back. It moved to
 * `TodoGoalBar` (owner, 2026-08-10). A celebration belongs on something the
 * PERSON did — no task app in the reference set celebrates a network response,
 * and this screen already owns a real reward gesture in the task tick below.
 * Loading now just loads. Do not reintroduce a completion beat here.
 */

const SECTIONS: { key: Bucket; label: string }[] = [
  { key: 'overdue', label: 'OVERDUE' },
  { key: 'today', label: 'TODAY' },
  { key: 'upcoming', label: 'UPCOMING' },
  { key: 'someday', label: 'SOMEDAY' },
];

/**
 * How long a deleted task can be taken back.
 *
 * ⚠️ Was 2000. Two seconds is not long enough to notice a bar appear, read
 * which task it names and move a thumb to it — the window closed while you were
 * still deciding, which is half of why undo "didn't work". (The other half was
 * that the bar was rendering underneath the floating tab bar; see
 * TAB_BAR_CLEARANCE.) Five seconds is the common bar-style-undo default.
 */
const UNDO_MS = 5000;
/** Clears the New task bar (its 50px button plus the bar's own padding). */
const UNDO_ABOVE_BAR = 74;
/** Scroll content has to clear the New task bar too, plus a little air so the
 *  last row isn't flush against it. Sits on top of TAB_BAR_CLEARANCE. */
const BOTTOM_BAR_CLEARANCE = 92;

/** Only the name + emoji rolls — "My" is fixed beside it, so it reads as one
 *  steady phrase with a changing tail rather than the whole title flickering. */
const ROLL_LINES = TODO_ROLL_NAMES.map(n => `${n.name} ${n.emoji}`);

/** Settings button that spins a full turn each time it's pressed.
 *  Press-triggered rather than always-spinning on purpose: perpetual motion in
 *  the corner of a list you're trying to read is a distraction, not a delight. */
function SpinningGear({ onPress }: { onPress: () => void }) {
  const [turns, setTurns] = useState(0);
  return (
    <Pressable
      style={styles.gearBtn}
      onPress={() => { setTurns(t => t + 1); onPress(); }}
      scaleTo={0.9}
      hitSlop={8}
    >
      <MotiView
        animate={{ rotate: `${turns * 360}deg` }}
        transition={{ type: 'timing', duration: 520 }}
      >
        <Icon name="settings" size={20} color={colors.textPrimary} />
      </MotiView>
    </Pressable>
  );
}

/**
 * ⚠️ SHRUNK 2026-09-17 (owner: "the entire box is taking a lot of space").
 *
 * This was a stacked tile — a 29pt number in display size with a 10pt tracked
 * label UNDER it, ~48pt tall before the row's own spacing. Three of them, plus
 * a 42pt avatar row and a two-line rolling quote, made a card ~190pt tall
 * sitting above the actual list on every open of this screen.
 *
 * Now the number and its label share ONE line. Nothing was removed — the same
 * three counts in the same order, tinted the same way — so this is a size
 * change, not a content change; anyone reading OPEN / DONE / OVERDUE still
 * reads all three. The number stays visually dominant by weight and size
 * against the tracked label, which is the hierarchy the tile always used;
 * it just no longer spends a whole line on each half.
 */
function StatTile({ label, value, tint }: { label: string; value: number; tint?: string }) {
  return (
    <View style={styles.stat}>
      <Text style={[styles.statValue, tint ? { color: tint } : null]}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

/**
 * Memoized. The handlers take the todo instead of closing over it, so the
 * screen can pass ONE stable reference per action to every row — with
 * per-row arrows (`onToggle={() => toggle(t)}`) every row's props changed
 * identity on every render and memo would have been decorative.
 */
const TodoRow = memo(function TodoRow({ todo, onToggle, onEdit, onOpenReel, onDelete }: {
  todo: Todo;
  onToggle: (todo: Todo) => void;
  onEdit: (todo: Todo) => void;
  onOpenReel: (todo: Todo) => void;
  onDelete: (todo: Todo) => void;
}) {
  const overdue = bucketOf(todo.due_date) === 'overdue' && !todo.completed;
  const done = todo.completed;
  return (
    // The whole row eases back when it's done: it stays readable (so tapping
    // again to undo is obvious) but visibly stops competing with what's left.
    <MotiView
      animate={{ opacity: done ? 0.62 : 1, scale: done ? 0.99 : 1 }}
      transition={{ type: 'timing', duration: 260 }}
      style={[styles.row, done && styles.rowDone]}
    >
      <Pressable onPress={() => onToggle(todo)} scaleTo={0.85} hitSlop={8} style={styles.check}>
        <View style={[styles.checkBox, done && styles.checkBoxOn]}>
          <AnimatePresence>
            {done && (
              <MotiView
                // Springs in from nothing so the tick lands with some weight —
                // this is the moment the whole feature is asking the user to enjoy.
                from={{ scale: 0, opacity: 0, rotate: '-45deg' }}
                animate={{ scale: 1, opacity: 1, rotate: '0deg' }}
                exit={{ scale: 0, opacity: 0 }}
                transition={{ type: 'spring', damping: 11, stiffness: 220 }}
              >
                <Icon name="checkmark" size={13} color={colors.onAction} />
              </MotiView>
            )}
          </AnimatePresence>
        </View>

        {/* One-shot ring that expands and fades the instant it's ticked. */}
        <AnimatePresence>
          {done && (
            <MotiView
              key={`burst-${todo.id}`}
              pointerEvents="none"
              from={{ scale: 0.7, opacity: 0.55 }}
              animate={{ scale: 2.1, opacity: 0 }}
              transition={{ type: 'timing', duration: 520 }}
              style={styles.burst}
            />
          )}
        </AnimatePresence>
      </Pressable>

      <Pressable style={styles.rowBody} onPress={() => onEdit(todo)} scaleTo={0.99}>
        <Text style={[styles.rowTitle, todo.completed && styles.rowTitleDone]} numberOfLines={2}>
          {todo.title}
        </Text>
        {!!todo.description && !todo.completed && (
          <Text style={styles.rowDesc} numberOfLines={2}>{todo.description}</Text>
        )}
        <View style={styles.metaRow}>
          <View style={[
            styles.dot,
            PRIORITY_MARK[todo.priority] === 'filled' && styles.dotFilled,
            PRIORITY_MARK[todo.priority] === 'faint' && styles.dotFaint,
          ]} />
          <Text style={[styles.meta, overdue && styles.metaOverdue]}>{formatDue(todo.due_date)}</Text>
          {todo.reel_id && (
            <Pressable onPress={() => onOpenReel(todo)} scaleTo={0.94} hitSlop={6} style={styles.sourceChip}>
              <Icon name="play" size={9} color={colors.accentLight} />
              <Text style={styles.sourceText}>View save</Text>
            </Pressable>
          )}
        </View>
      </Pressable>

      <Pressable onPress={() => onDelete(todo)} scaleTo={0.85} hitSlop={8} style={styles.del}>
        <Icon name="trash" size={15} color={colors.textTertiary} />
      </Pressable>
    </MotiView>
  );
});

export default function TodosScreen() {
  const router = useRouter();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { profile, displayName } = useAuth();
  const [todos, setTodos] = useState<Todo[]>([]);
  const [stats, setStats] = useState<TodoStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<Todo | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Declared up here because load() reads it — see the delete/undo block below
  // for what it's for.
  const pending = useRef<{ todo: Todo; timer: ReturnType<typeof setTimeout> } | null>(null);
  /**
   * Tasks the user brought back with Undo.
   *
   * ⚠️ THE MIRROR OF `pending`. That ref keeps a deleted-but-not-yet-committed
   * row OUT of a refetch; this one keeps a restored row IN.
   *
   * Needed because `load()` asks the server for `settings.showCompleted`. Undo a
   * COMPLETED task while completed items are hidden and the server correctly
   * omits it — so every later refetch (a pull, a focus, saving another task)
   * silently dropped the row again. The task was never deleted; it was
   * invisible, which to the user is the same thing.
   *
   * Cleared when the user changes that filter themselves, or leaves the screen.
   */
  const restored = useRef<Map<string, Todo>>(new Map());
  const [undoFor, setUndoFor] = useState<Todo | null>(null);
  const { settings, update: updateSettings, ready: settingsReady } = useTodoSettings();
  // Set when a reel-linked task is completed: the "delete the saved card?" ask.
  const [finished, setFinished] = useState<Todo | null>(null);
  const [deletingReel, setDeletingReel] = useState(false);

  /**
   * Leaving the app closes this screen's sheets (owner report, 2026-08-14).
   *
   * ⚠️ `TodoEditor` is the one that matters most here: it stays MOUNTED while
   * closed on purpose (so its fade-out survives), so its state is long-lived —
   * a half-written task left open before a share was still open on return, on
   * top of whatever the user came back for. Dismissal fires on `background`
   * only, never on iOS's transient `inactive`, so pulling down the
   * notification shade does not throw away what you were typing.
   */
  useDismissOnBackground(() => {
    setEditorOpen(false);
    setSettingsOpen(false);
    setFinished(null);
  });

  const load = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    try {
      // The device's own date decides what "today" means for the goal — see
      // services/todoSettings.ts and the completed_on column.
      const d = await api.listTodos(settings.showCompleted, todayISO());
      // A refresh inside the undo window would otherwise resurrect the row the
      // user just deleted — the server hasn't been told yet, by design.
      // Both client-side facts the server can't know about, in one tested
      // place — see services/todoMerge.ts and its test.
      setTodos(mergeTodoList(d.items, {
        dropId: pending.current?.todo.id,
        restored: restored.current,
      }));
      setStats(d.stats);
      setError(null);
    } catch (e: any) {
      setError(e?.message || "Couldn't load your list.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [settings.showCompleted]);

  // Changing the filter is an explicit instruction about what to show; a row
  // held open by Undo must not outlive it.
  useEffect(() => { restored.current.clear(); }, [settings.showCompleted]);

  useFocusEffect(useCallback(() => {
    // The rolling hero is the page title, so the nav bar carries no title —
    // but it KEEPS its global hamburger (the owner's requirement that the menu
    // is reachable from every page). The body's own Home/Library/menu trio was
    // removed rather than the header's.
    navigation.setOptions({ title: '' });
    if (settingsReady) load();
  }, [load, navigation, settingsReady]));

  const toggle = useCallback(async (todo: Todo) => {
    const next = !todo.completed;
    // Optimistic, and the item STAYS in place while checked — tapping again is
    // the undo. It drops off the list on the next load, which is the natural
    // moment for it to disappear.
    setTodos(ts => ts.map(t => (t.id === todo.id ? { ...t, completed: next } : t)));
    setStats(s => s && {
      ...s,
      open: s.open + (next ? -1 : 1),
      completed: s.completed + (next ? 1 : -1),
      completed_today: s.completed_today === null
        ? null
        : Math.max(0, s.completed_today + (next ? 1 : -1)),
    });
    next ? haptics.success() : haptics.tap();

    // Shown IMMEDIATELY, before the request — not after it. Waiting on the round
    // trip meant a cold Render instance could leave the user staring at a ticked
    // box for seconds before anything acknowledged it. The prompt only offers to
    // delete a save, and that deletion is its own explicit confirmed action, so
    // there is nothing unsafe about asking optimistically; a failed update
    // dismisses it again below.
    if (next && todo.reel_id && settings.askDeleteSaveOnDone) {
      setFinished({ ...todo, completed: true });
    }

    try {
      await api.updateTodo(todo.id, {
        completed: next,
        // Stamped from the DEVICE, so the daily goal counts against the user's
        // own calendar day rather than the server's UTC one.
        completed_on: next ? todayISO() : null,
      });
    } catch (e: any) {
      // The tick didn't stick, so the celebration mustn't stand either.
      setFinished(null);
      setTodos(ts => ts.map(t => (t.id === todo.id ? { ...t, completed: !next } : t)));
      setStats(s => s && {
        ...s,
        open: s.open + (next ? 1 : -1),
        completed: s.completed + (next ? -1 : 1),
        completed_today: s.completed_today === null
          ? null
          : Math.max(0, s.completed_today + (next ? -1 : 1)),
      });
      setError(e?.message || "Couldn't update that.");
    }
  }, [settings.askDeleteSaveOnDone]);

  /** "Yes, delete the saved card." The task itself survives — the server
   *  unlinks it rather than cascading, so the record of what you did remains. */
  const deleteLinkedReel = async () => {
    if (!finished?.reel_id) return;
    setDeletingReel(true);
    try {
      await api.deleteReel(finished.reel_id);
      haptics.warning();
      setFinished(null);
      load();
    } catch (e: any) {
      setError(e?.message || "Couldn't delete that save.");
      setFinished(null);
    } finally {
      setDeletingReel(false);
    }
  };

  /**
   * Delete with a 2-second window to take it back.
   *
   * The row vanishes instantly but the DELETE is DEFERRED, not sent-and-undone:
   * undoing is then a cancelled timer rather than a re-create, so the task keeps
   * its id, its creation date and its completion stamp. Re-creating would mint a
   * new row and silently rewrite that history.
   *
   * Leaving the screen with one still pending commits it immediately (see the
   * unmount effect) — the user did ask for it; only the grace period is lost.
   */

  const commitDelete = useCallback((id: string) => {
    api.deleteTodo(id).catch(() => {/* best effort; the row is already gone */});
  }, []);

  const flushPending = useCallback(() => {
    if (!pending.current) return;
    clearTimeout(pending.current.timer);
    commitDelete(pending.current.todo.id);
    pending.current = null;
  }, [commitDelete]);

  // Anything still in the grace window when the screen goes away gets committed.
  useEffect(() => flushPending, [flushPending]);

  const remove = useCallback((todo: Todo) => {
    // A second delete inside the window commits the first — one undo slot keeps
    // the interaction honest instead of stacking toasts nobody reads.
    flushPending();
    // Deleting something previously restored retracts that restoration —
    // otherwise `load()` would keep re-inserting a row the user just binned.
    restored.current.delete(todo.id);
    setTodos(ts => ts.filter(t => t.id !== todo.id));
    setStats(s => s && {
      ...s,
      total: Math.max(0, s.total - 1),
      open: todo.completed ? s.open : Math.max(0, s.open - 1),
      completed: todo.completed ? Math.max(0, s.completed - 1) : s.completed,
    });
    haptics.warning();
    setUndoFor(todo);

    const timer = setTimeout(() => {
      commitDelete(todo.id);
      pending.current = null;
      setUndoFor(null);
    }, UNDO_MS);
    pending.current = { todo, timer };
  }, [flushPending, commitDelete]);

  const undoDelete = () => {
    if (!pending.current) return;
    clearTimeout(pending.current.timer);
    const { todo } = pending.current;
    pending.current = null;
    setUndoFor(null);
    haptics.tap();
    // Back instantly so the undo feels immediate…
    setTodos(ts => [...ts, todo]);
    setStats(s => s && {
      ...s,
      total: s.total + 1,
      open: todo.completed ? s.open : s.open + 1,
      completed: todo.completed ? s.completed + 1 : s.completed,
    });
    // Remember it, so no later refetch can drop it again — see `restored`.
    // An earlier fix merely SKIPPED the refetch for this case, which delayed the
    // disappearance to the next pull/focus/save instead of preventing it.
    restored.current.set(todo.id, todo);
    // …then a quiet refetch restores its real position. Sorting locally would
    // mean a second copy of the server's date-then-priority rule, which is
    // exactly the kind of duplicate that drifts.
    load();
  };

  /** A brand-new task, shown before the server has confirmed it. */
  const onOptimistic = useCallback((draft: Todo) => {
    setTodos(ts => [...ts, draft]);
    setStats(s => s && { ...s, total: s.total + 1, open: s.open + 1 });
  }, []);

  /**
   * The server's version of a task, replacing the draft if there was one.
   *
   * ⚠️ NO `load()` HERE ANY MORE. It used to refetch the whole list purely to
   * get ordering right, which on a cold backend meant a SECOND multi-second wait
   * after the create — the new task sat there looking stuck. Grouping is done
   * client-side from `due_date` anyway, so the row lands in the correct section
   * immediately; only its position WITHIN a section waits for the next natural
   * refresh, which nobody notices.
   */
  const onSaved = useCallback((saved: Todo, replaces?: string) => {
    setTodos(ts => [...ts.filter(t => t.id !== saved.id && t.id !== replaces), saved]);
  }, []);

  /** The create failed after the sheet closed. Take the draft back out and say why. */
  const onFailed = useCallback((draftId: string, message: string) => {
    setTodos(ts => ts.filter(t => t.id !== draftId));
    setStats(s => s && { ...s, total: Math.max(0, s.total - 1), open: Math.max(0, s.open - 1) });
    setError(message);
  }, []);

  // Stable so the memoized sheets below actually skip re-rendering. An inline
  // arrow here would defeat their memo on every parent render.
  const closeEditor = useCallback(() => { setEditorOpen(false); setEditing(null); }, []);
  const closeSettings = useCallback(() => setSettingsOpen(false), []);

  const openNew = () => { setEditing(null); setEditorOpen(true); };
  const openEdit = useCallback((t: Todo) => { setEditing(t); setEditorOpen(true); }, []);
  const openReel = useCallback((t: Todo) => { router.push(`/reel/${t.reel_id}`); }, [router]);

  // Memoized: these ran on every render, and each pass calls bucketOf() —
  // which parses a date — once per todo per section plus once more for the
  // overdue count. That is ~5N date parses on the JS thread before commit,
  // fired by anything that re-rendered the screen, including a checkbox tap.
  const grouped = useMemo(() => {
    const order = settings.somedayFirst
      ? [SECTIONS[3], SECTIONS[0], SECTIONS[1], SECTIONS[2]]
      : SECTIONS;
    return order
      .map(s => ({ ...s, items: todos.filter(t => bucketOf(t.due_date) === s.key) }))
      .filter(s => s.items.length > 0);
  }, [todos, settings.somedayFirst]);

  // Computed here, not server-side: "overdue" depends on the DEVICE's calendar
  // day, and a UTC-derived count would disagree with the sections below it.
  const overdueCount = useMemo(
    () => todos.filter(t => !t.completed && bucketOf(t.due_date) === 'overdue').length,
    [todos],
  );

  if (loading) {
    return <View style={styles.center}><MascotLoader /></View>;
  }

  return (
    <View style={styles.screen}>
      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + TAB_BAR_CLEARANCE + BOTTOM_BAR_CLEARANCE }]}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => load(true)}
            tintColor={colors.accent}
            colors={[colors.accent]}
            progressBackgroundColor={colors.card}
            title="Refreshing…"
            titleColor={colors.textSecondary}
          />
        }
      >
        {/* Header actions used to be a Home / Library / menu trio here. Home
            and Library are TABS now, and the hamburger is the stack header's
            global button — three duplicated controls removed (owner). */}

        {/* ── Hero: "My" — big M, smaller y — then the rolling name. Nested
            <Text> rather than two siblings, so the two sizes share one baseline
            automatically instead of being nudged into alignment by hand. ── */}
        {/* ⚠️ Was a "M(y)" lockup — an oversized M with a small inline y, then
            the rolling name beside it at a different size. The owner didn't like
            it, and it was the one screen in the app inventing its own header
            grammar. This is the same eyebrow-then-title pair every other screen
            uses (ask, help, save, pro, profile); the rolling name is simply the
            title, and the eyebrow carries the numbers that were buried in the
            dashboard below. */}
        <View style={styles.hero}>
          <Label wide>
            {stats
              ? `${stats.open} open${stats.completed_today ? ` · ${stats.completed_today} done today` : ''}`
              : 'Your slate'}
          </Label>
          <RollingTagline
            lines={ROLL_LINES}
            height={40}
            intervalMs={5200}
            numberOfLines={1}
            alignLeft
            shuffle
            textStyle={styles.heroText}
            style={styles.heroRoll}
          />
        </View>

        {/* ── Dashboard: whose slate, where you stand, and something to read ── */}
        <View style={styles.dash}>
          {/*
            LAYOUT CHANGE: the goal bar used to run the full width of this card
            with nobody's name on it. It is now the right-hand column of a
            two-column head, with the picked face and the display name on the
            left — so the row reads "PRASANNA · today's goal · 1/5" instead of
            an unattributed statistic.

            This is also the only place on the to-do screen the chosen avatar
            appears. The hero above rolls through NAMES FOR THE LIST ("Order of
            the Day", "Docket") — never the user's own name — so nothing here
            duplicates it.

            The head renders unconditionally; only the bar inside it is gated,
            so switching the daily goal off in settings (TodoGoalBar returns
            null) leaves a clean identity row rather than a dangling face.
          */}
          <View style={styles.dashHead}>
            <Pressable
              style={styles.dashAvatar}
              onPress={() => { haptics.tap(); emitUi('openProfile'); }}
              accessibilityLabel="Your profile"
            >
              <Avatar value={profile.avatar} size={30} />
            </Pressable>
            <View style={styles.dashHeadMain}>
              <Label numberOfLines={1}>{displayName}</Label>
              {/* Rendered only once settings have loaded, so the bar can't flash
                  the default goal and then snap to the user's real one. */}
              {settingsReady && stats?.completed_today !== null && stats?.completed_today !== undefined && (
                <TodoGoalBar done={stats.completed_today} goal={settings.dailyGoal} />
              )}
            </View>
          </View>

          <View style={styles.statRow}>
            <StatTile label="OPEN" value={stats?.open ?? 0} />
            <StatTile label="DONE" value={stats?.completed ?? 0} tint={colors.success} />
            <StatTile
              label="OVERDUE"
              value={overdueCount}
              tint={overdueCount > 0 ? colors.danger : undefined}
            />
          </View>
          {/* ⚠️ numberOfLines WAS 2 — half the height this card just gave up
              (owner, 2026-09-17). It is still capped rather than free, for the
              original reason: without a cap an over-long quote is sliced
              through the middle of a word by `overflow: hidden`, and an honest
              ellipsis beats a severed one. TODO_QUOTES' char budget was written
              for two lines, so the longest few now truncate — accepted; they
              roll, so nothing is the only thing the user ever sees. Trim the
              long entries there if it reads badly, do not restore the line.

              ⚠️ `height` IS REQUIRED HERE, not a nicety. `compact` is a FIXED
              60px viewport (RollingTagline's COMPACT_H), sized for two 18px
              lines plus roll slack — dropping to one line without it would
              have cost the second line and saved ZERO height, which is the
              opposite of the point. 34 leaves (34-18)/2 = 8px of travel, so it
              still rolls rather than degrading to a crossfade. See
              components/rollGeometry.ts for why that arithmetic is load-bearing
              (the same "the Slate lines are cut off" bug, twice). */}
          <RollingTagline
            compact
            shuffle
            numberOfLines={1}
            height={34}
            lines={TODO_QUOTES}
            style={styles.quotes}
          />
        </View>

        {error && (
          <Pressable style={styles.errorBanner} onPress={() => load()} scaleTo={0.99}>
            <Icon name="alert-circle" size={14} color={colors.danger} />
            <Text style={styles.errorText}>{error} Tap to retry.</Text>
          </Pressable>
        )}

        {todos.length === 0 && !error ? (
          /* Was a raw <Text> at weight 800 — see the note on EmptyState. The
             icon goes with it: no other empty state in the app has one, and it
             was the only thing making this screen's version look bespoke. */
          <EmptyState
            kicker="All clear"
            title="Nothing to follow through on"
            body={`Add something you want to get done — or open a save and tap “${TODO_ADD_LABEL}” to turn it into a real plan.`}
          />
        ) : (
          grouped.map((section, i) => (
            <MotiView
              key={section.key}
              from={{ opacity: 0, translateY: 8 }}
              animate={{ opacity: 1, translateY: 0 }}
              transition={{ type: 'timing', duration: 260, delay: 60 * i }}
              style={styles.section}
            >
              <View style={styles.sectionHead}>
                <Text style={[styles.sectionLabel, section.key === 'overdue' && styles.sectionLabelWarn]}>
                  {section.label}
                </Text>
                <Text style={styles.sectionCount}>{section.items.length}</Text>
              </View>
              {section.items.map(t => (
                <TodoRow
                  key={t.id}
                  todo={t}
                  onToggle={toggle}
                  onEdit={openEdit}
                  onOpenReel={openReel}
                  onDelete={remove}
                />
              ))}
            </MotiView>
          ))
        )}
      </ScrollView>

      {/* ── Undo bar. Sits above the New task button and rises from beneath
          it, so it reads as coming from the bar rather than dropping over the
          list. Works for completed and incomplete tasks alike. ── */}
      <AnimatePresence>
        {undoFor && (
          <MotiView
            key="undo"
            from={{ opacity: 0, translateY: 48 }}
            animate={{ opacity: 1, translateY: 0 }}
            exit={{ opacity: 0, translateY: 48 }}
            transition={{ type: 'timing', duration: 240 }}
            style={[styles.undoWrap, { bottom: insets.bottom + TAB_BAR_CLEARANCE + UNDO_ABOVE_BAR }]}
            pointerEvents="box-none"
          >
            <View style={styles.undoBar}>
              <Icon name="trash" size={14} color={colors.textSecondary} />
              <Text style={styles.undoText} numberOfLines={1}>
                Deleted “{undoFor.title}”
              </Text>
              <Pressable onPress={undoDelete} scaleTo={0.94} hitSlop={8} style={styles.undoBtn}>
                <Text style={styles.undoBtnText}>Undo</Text>
              </Pressable>
            </View>
          </MotiView>
        )}
      </AnimatePresence>

      <View style={[styles.bottomBar, { paddingBottom: insets.bottom + TAB_BAR_CLEARANCE }]}>
        <Pressable style={styles.addWrap} onPress={openNew} scaleTo={0.97}>
          <LinearGradient colors={gradients.primary} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.addBtn}>
            <Icon name="add" size={18} color={colors.onAction} />
            <Text style={styles.addText}>New task</Text>
          </LinearGradient>
        </Pressable>
        {/* Settings live bottom-right (owner) — out of the reading path, still
            one thumb-reach away on a phone. */}
        <SpinningGear onPress={() => setSettingsOpen(true)} />
      </View>

      <TodoEditor
        visible={editorOpen}
        editing={editing}
        defaultPriority={settings.defaultPriority}
        onClose={closeEditor}
        onOptimistic={onOptimistic}
        onFailed={onFailed}
        /* Edit failures only REPORT — the editor has already put the original
           row back. Routing them through onFailed would delete the task. */
        onError={setError}
        onSaved={onSaved}
      />


      <TodoSettingsSheet
        visible={settingsOpen}
        settings={settings}
        onChange={updateSettings}
        onClose={closeSettings}
      />

      {/* ── Done → keep or delete the save it came from ────────────────────
          "Keep it" is the primary action and the only thing a stray tap can
          reach: deleting a reel cascades to its summary, notes, tasks, workout
          and itinerary, and there is no trash to recover it from. The delete
          button is styled as the destructive secondary and says what is lost. */}
      <Modal visible={!!finished} transparent animationType="fade" onRequestClose={() => setFinished(null)} statusBarTranslucent>
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <View style={styles.modalIcon}>
              <Icon name="celebrate" size={26} color={colors.success} />
            </View>
            <Text style={styles.modalTitle}>Done — nice one.</Text>
            <Text style={styles.modalBody} numberOfLines={3}>“{finished?.title}”</Text>
            <Text style={styles.modalAsk}>
              You've followed through on this one. Want to clear the saved card out of your
              library too?
            </Text>
            <Text style={styles.modalWarn}>
              Deleting also removes its summary, notes, any generated steps or workout — and
              it can't be undone. Your completed task stays either way.
            </Text>

            <Pressable style={styles.keepWrap} onPress={() => setFinished(null)} scaleTo={0.97}>
              <LinearGradient colors={gradients.primary} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={styles.keepBtn}>
                <Text style={styles.keepText}>Keep the save</Text>
              </LinearGradient>
            </Pressable>
            <Pressable style={styles.dangerBtn} onPress={deleteLinkedReel} scaleTo={0.97} disabled={deletingReel}>
              {deletingReel
                ? <ActivityIndicator color={colors.danger} size="small" />
                : <Text style={styles.dangerText}>Delete the saved card</Text>}
            </Pressable>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = themed(() => StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.background },
  content: { padding: spacing.lg, gap: spacing.lg, flexGrow: 1 },


  // ── Hero ────────────────────────────────────────────────────────────
  hero: { gap: spacing.sm, marginBottom: spacing.md },
  heroRoll: { flex: 1, alignSelf: 'auto' },
  // Exactly kit's <Title> — this screen's heading should be indistinguishable
  // from every other screen's, the only difference being that it rolls.
  heroText: {
    fontFamily: typeface.display, fontSize: font.xxl, color: colors.textPrimary,
    letterSpacing: tracking.title,
    textAlign: 'left', paddingHorizontal: 0, lineHeight: font.xxl * 1.05,
    fontStyle: 'normal',
  },
  gearBtn: {
    width: 50, height: 50, borderRadius: radius.md,
    backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border,
    alignItems: 'center', justifyContent: 'center',
  },

  // ── Dashboard header ────────────────────────────────────────────────
  // ⚠️ EVERY NUMBER HERE IS THE "box is taking a lot of space" FIX
  // (owner, 2026-09-17) — padding md→sm, gap sm→xs. Read the note on StatTile
  // before growing any of them back. Where the ~200pt went, so a future change
  // can be weighed against it rather than guessed at:
  //
  //     padding      32 → 16      md → sm, both sides
  //     avatar row   42 → 34      it set the head height, so it set the card's
  //     stat row     48 → 24      stacked tiles → one baseline per stat
  //     quote        65 → 39      2 lines in a 60pt viewport → 1 in 34
  //     gaps         16 →  8      sm → xs, twice
  //                 ───────────
  //                 ~203 → ~121
  //
  // It earns that by being a strip above the list rather than a panel the list
  // starts below.
  dash: {
    backgroundColor: colors.card, borderRadius: radius.lg,
    borderWidth: 1, borderColor: colors.border,
    padding: spacing.sm, gap: spacing.xs,
  },
  // Two-column head: face on the left, name + goal stacked on the right.
  dashHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  // Square frame, 0 radius — the app went square on avatars everywhere (the
  // reference's circle was one of ITS signatures, not this system's).
  // 42 → 34: the avatar set the head row's height, so it set the card's.
  dashAvatar: {
    width: 34, height: 34,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: colors.border,
  },
  // minWidth 0 so the name truncates inside the row instead of shoving the
  // goal count off the right edge.
  dashHeadMain: { flex: 1, minWidth: 0, gap: spacing.xs },
  statRow: { flexDirection: 'row' },
  // `baseline` rather than `center`: a 20pt number and a 10pt label centred
  // against each other float apart — sitting them on one baseline is what makes
  // the pair read as a single word ("12 OPEN") instead of two stacked things.
  stat: {
    flex: 1, flexDirection: 'row', alignItems: 'baseline',
    justifyContent: 'center', gap: 5,
  },
  statValue: { color: colors.textPrimary, fontSize: font.lg + 2, fontWeight: '800', lineHeight: 24 },
  statLabel: { color: colors.textTertiary, fontSize: 10, fontWeight: '800', letterSpacing: 1.1 },
  quotes: { borderTopWidth: 1, borderTopColor: colors.border, paddingTop: spacing.xs },

  // ── Completion prompt ───────────────────────────────────────────────
  modalOverlay: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.68)',
    alignItems: 'center', justifyContent: 'center', padding: spacing.lg,
  },
  modalCard: {
    width: '100%', maxWidth: 420,
    backgroundColor: colors.surface, borderRadius: radius.lg,
    borderWidth: 1, borderColor: colors.border, padding: spacing.lg,
    alignItems: 'center', gap: spacing.sm, ...shadow.md,
  },
  modalIcon: {
    width: 54, height: 54, borderRadius: radius.full,
    backgroundColor: colors.success + '1E',
    alignItems: 'center', justifyContent: 'center',
  },
  modalTitle: { color: colors.textPrimary, fontSize: font.xl, fontWeight: '800', textAlign: 'center' },
  modalBody: { color: colors.textSecondary, fontSize: font.sm, textAlign: 'center', fontStyle: 'italic' },
  modalAsk: { color: colors.textPrimary, fontSize: font.sm, lineHeight: 21, textAlign: 'center', marginTop: spacing.xs },
  modalWarn: { color: colors.textTertiary, fontSize: font.xs, lineHeight: 17, textAlign: 'center' },
  keepWrap: { width: '100%', borderRadius: radius.md, marginTop: spacing.sm },
  keepBtn: { borderRadius: radius.md, paddingVertical: spacing.md, alignItems: 'center' },
  keepText: { color: colors.onAction, fontSize: font.md, fontWeight: '800' },
  dangerBtn: {
    width: '100%', borderRadius: radius.md, paddingVertical: spacing.sm + 4,
    alignItems: 'center', justifyContent: 'center', minHeight: 44,
    borderWidth: 1, borderColor: colors.danger + '55',
  },
  dangerText: { color: colors.danger, fontSize: font.sm, fontWeight: '700' },

  errorBanner: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.xs,
    backgroundColor: colors.danger + '18', borderRadius: radius.md,
    borderWidth: 1, borderColor: colors.danger + '40', padding: spacing.sm,
  },
  errorText: { flex: 1, color: colors.danger, fontSize: font.xs },


  section: { gap: spacing.sm },
  sectionHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  sectionLabel: { color: colors.textTertiary, fontSize: font.xs, fontWeight: '800', letterSpacing: 1.2 },
  sectionLabelWarn: { color: colors.danger },
  sectionCount: { color: colors.textTertiary, fontSize: font.xs, fontWeight: '700' },

  row: {
    flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm,
    backgroundColor: colors.card, borderRadius: radius.md,
    borderWidth: 1, borderColor: colors.border, padding: spacing.sm + 4,
  },
  check: { paddingTop: 1 },
  checkBox: {
    width: 21, height: 21, borderRadius: radius.full,
    borderWidth: 1.5, borderColor: colors.borderLight,
    alignItems: 'center', justifyContent: 'center',
  },
  checkBoxOn: { backgroundColor: colors.accent, borderColor: colors.accent },

  rowDone: { borderColor: colors.success + '55' },
  burst: {
    position: 'absolute', top: 1, left: 0,
    width: 21, height: 21, borderRadius: radius.full,
    borderWidth: 2, borderColor: colors.success,
  },
  rowBody: { flex: 1, gap: 3 },
  rowTitle: { color: colors.textPrimary, fontSize: font.md, fontWeight: '600', lineHeight: 21 },
  rowTitleDone: { color: colors.textTertiary, textDecorationLine: 'line-through' },
  rowDesc: { color: colors.textSecondary, fontSize: font.xs, lineHeight: 17 },

  metaRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, marginTop: 2 },
  // Priority by SHAPE, not hue — see PRIORITY_MARK at the top of this file.
  dot: { width: 7, height: 7, borderWidth: 1, borderColor: colors.textSecondary },
  dotFilled: { backgroundColor: colors.textPrimary, borderColor: colors.textPrimary },
  dotFaint: { borderColor: colors.ghostLine },
  meta: { color: colors.textTertiary, fontSize: font.xs },
  metaOverdue: { color: colors.danger, fontWeight: '700' },

  sourceChip: {
    flexDirection: 'row', alignItems: 'center', gap: 3,
    backgroundColor: colors.accent + '18', borderRadius: radius.full,
    paddingHorizontal: spacing.sm, paddingVertical: 2, marginLeft: spacing.xs,
  },
  sourceText: { color: colors.accentLight, fontSize: 10, fontWeight: '700' },

  del: { paddingTop: 2 },

  // ── Undo bar ────────────────────────────────────────────────────────
  undoWrap: { position: 'absolute', left: 0, right: 0, paddingHorizontal: spacing.lg },
  undoBar: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.sm,
    // Accent-tinted rather than a flat grey slab: the light highlight is what
    // makes it register as "something just happened, you can still act".
    backgroundColor: colors.cardElevated,
    borderRadius: radius.md, borderWidth: 1, borderColor: colors.accent + '55',
    paddingLeft: spacing.md, paddingRight: spacing.xs, paddingVertical: spacing.sm,
    ...shadow.md,
  },
  undoText: { flex: 1, color: colors.textSecondary, fontSize: font.xs },
  undoBtn: {
    paddingHorizontal: spacing.md, paddingVertical: 6,
    borderRadius: radius.full, backgroundColor: colors.accent + '22',
  },
  undoBtnText: { color: colors.accentLight, fontSize: font.xs, fontWeight: '800' },

  bottomBar: {
    position: 'absolute', left: 0, right: 0, bottom: 0,
    flexDirection: 'row', alignItems: 'center', gap: spacing.sm,
    paddingHorizontal: spacing.lg, paddingTop: spacing.sm,
    backgroundColor: colors.background,
    borderTopWidth: 1, borderTopColor: colors.border,
  },
  addWrap: { flex: 1, borderRadius: radius.md, ...shadow.glow },
  addBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm,
    borderRadius: radius.md, height: 50,
  },
  addText: { color: colors.onAction, fontSize: font.md, fontWeight: '800' },
}));
