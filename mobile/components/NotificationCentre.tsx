import { useEffect, useState } from 'react';
import { View, StyleSheet } from 'react-native';
import { Pressable } from './Pressable';
import { Icon } from './Icon';
import { Body, Index, Label, Rule, TextAction } from './kit';
import { ago, markRead, markAllRead, removeNote, unreadCount, type Note } from '../services/notifyLog';
import { deleteNote, loadNotes, markAllNotesRead, markNoteRead } from '../services/notifyStore';
import { reelPath } from '../services/deepLink';
import { colors, font, spacing, themed } from '../constants/theme';

/**
 * The notification drawer, rendered inline inside ProfilePanel.
 *
 * ⚠️ NOT A ROUTE, deliberately. It borrows the panel's own AI-usage drill-down
 * grammar — collapsed summary line, chevron, expanded list — so "tap to see the
 * detail" means one thing in this panel rather than two. A whole screen for ten
 * rows would also cost a navigation the user has to come back from, and this is
 * something you glance at on the way to somewhere else.
 *
 * Every mutation writes through to storage AND updates local state with the
 * same pure function, so the drawer never shows a state the store disagrees
 * with. The writes are fire-and-forget: a failed one costs a read mark, and
 * blocking the UI on AsyncStorage for that would be a worse trade.
 *
 * `onOpen` is the panel's own "close, then navigate" — the panel owns its
 * dismissal, and a drawer row that pushed a route while leaving the panel
 * covering it would land the user on a screen they cannot see. Rows for a
 * receipt with no reel (a FAILED save, or anything posted before `reelId`
 * existed) simply do not call it.
 */
export function NotificationCentre({
  visible, onOpen,
}: { visible: boolean; onOpen?: (path: string) => void }) {
  const [notes, setNotes] = useState<Note[]>([]);
  const [open, setOpen] = useState(false);

  // Reload on each open — the share Activity appends while the app is
  // backgrounded, so a list read once at mount goes stale the moment the
  // feature is actually used.
  useEffect(() => {
    if (!visible) { setOpen(false); return; }
    loadNotes().then(setNotes);
  }, [visible]);

  const unread = unreadCount(notes);

  const onRowPress = (n: Note) => {
    if (!n.read) {
      setNotes(list => markRead(list, n.id));
      markNoteRead(n.id);
    }
    // The receipt exists to lead back to the thing it is about. A row the user
    // has already read still opens it — marking read is bookkeeping, not the
    // reason they tapped.
    if (n.reelId && onOpen) onOpen(reelPath(n.reelId));
  };

  const onDelete = (n: Note) => {
    setNotes(list => removeNote(list, n.id));
    deleteNote(n.id);
  };

  const onMarkAll = () => {
    setNotes(markAllRead);
    markAllNotesRead();
  };

  return (
    <>
      <Label wide style={styles.section}>Notifications</Label>
      <Rule />

      <Pressable
        onPress={notes.length > 0 ? () => setOpen(o => !o) : undefined}
        disabled={notes.length === 0}
        style={styles.head}
        accessibilityLabel={
          notes.length === 0 ? 'No notifications'
            : `${notes.length} notifications, ${unread} unread`
        }
      >
        <Body tone="primary" style={styles.headLabel}>
          {notes.length === 0
            ? 'No notifications'
            : unread > 0
              ? `${unread} unread of ${notes.length}`
              : `${notes.length} recent`}
        </Body>
        {notes.length > 0 && (
          <Icon
            name="chevron-right" size={14} color={colors.textTertiary}
            style={{ transform: [{ rotate: open ? '90deg' : '0deg' }] }}
          />
        )}
      </Pressable>

      {open ? (
        <View style={styles.list}>
          {unread > 0 && (
            <View style={styles.listHead}>
              <Label>{`Last ${notes.length} · newest first`}</Label>
              <TextAction label="Mark all read" onPress={onMarkAll} />
            </View>
          )}
          {notes.map((n, i) => (
            <View key={n.id} style={styles.row}>
              {/* Unread reads as SHAPE, not colour — the system has no accent
                  to spend, and a filled square beside a hollow one survives
                  every kind of colour blindness. */}
              <View style={[styles.mark, !n.read && styles.markUnread]} />
              <Pressable
                onPress={() => onRowPress(n)}
                style={styles.rowBody}
                accessibilityLabel={
                  `${n.title}${n.read ? '' : ', unread'}`
                  + (n.reelId ? ', opens the saved link' : '')
                }
              >
                <View style={styles.rowHead}>
                  <Index n={i + 1} />
                  <Label>{ago(n.at)}</Label>
                </View>
                <Body tone="primary" style={styles.rowTitle} numberOfLines={2}>{n.title}</Body>
                {n.body ? <Label numberOfLines={2}>{n.body}</Label> : null}
              </Pressable>
              <Pressable
                onPress={() => onDelete(n)}
                hitSlop={10}
                style={styles.del}
                accessibilityLabel={`Delete notification: ${n.title}`}
              >
                <Icon name="close" size={14} color={colors.textTertiary} />
              </Pressable>
            </View>
          ))}
        </View>
      ) : (
        <Body style={styles.hint}>
          {notes.length === 0
            // Says where they COME FROM. Empty here is the normal state until
            // the user shares something into the app, and an empty list with no
            // explanation reads as broken.
            ? 'Saves you make from another app’s share sheet report here.'
            : 'Tap one to open the save, or clear it.'}
        </Body>
      )}
      <Rule style={{ marginTop: spacing.md }} />
    </>
  );
}

const styles = themed(() => StyleSheet.create({
  section: { marginTop: spacing.xl, marginBottom: spacing.sm },

  head: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingVertical: spacing.md, gap: spacing.sm,
  },
  headLabel: { flex: 1, fontSize: font.md },

  list: { gap: spacing.md, paddingBottom: spacing.md },
  listHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },

  row: { flexDirection: 'row', gap: spacing.sm, alignItems: 'flex-start' },
  // Sits on the title's optical line rather than the top of the row.
  mark: {
    width: 6, height: 6, marginTop: 5,
    borderWidth: 1, borderColor: colors.ghostLine,
  },
  markUnread: { backgroundColor: colors.textPrimary, borderColor: colors.textPrimary },
  rowBody: { flex: 1, minWidth: 0, gap: 2 },
  rowHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  rowTitle: { fontSize: font.sm },
  del: { paddingTop: 2 },

  hint: { fontSize: font.sm, lineHeight: 19, paddingBottom: spacing.sm },
}));
