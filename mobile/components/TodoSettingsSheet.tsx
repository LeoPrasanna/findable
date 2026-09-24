import { memo } from 'react';
import { View, Text, StyleSheet, Modal, ScrollView, Switch } from 'react-native';
import { Pressable } from './Pressable';
import { Icon } from './Icon';
import { TodoSettings, GOAL_OPTIONS } from '../services/todoSettings';
import { REMINDER_TIMES } from '../services/todoSettings';
import { TODO_LANDING_TITLE } from '../constants/todoBrand';
import type { TodoPriority } from '../services/api';
import { colors, spacing, font, radius, shadow, themed } from '../constants/theme';

const PRIORITIES: { key: TodoPriority; label: string }[] = [
  { key: 'high', label: 'High' },
  { key: 'medium', label: 'Medium' },
  { key: 'low', label: 'Low' },
];

interface Props {
  visible: boolean;
  settings: TodoSettings;
  onChange: (patch: Partial<TodoSettings>) => void;
  onClose: () => void;
}

function Row({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <View style={styles.row}>
      <View style={{ flex: 1 }}>
        <Text style={styles.rowTitle}>{title}</Text>
        {!!hint && <Text style={styles.rowHint}>{hint}</Text>}
      </View>
      {children}
    </View>
  );
}

/** Preferences for this screen only. Stored on the device — see
 *  services/todoSettings.ts for why these aren't server-side. */
function TodoSettingsSheetImpl({ visible, settings, onChange, onClose }: Props) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <Pressable style={styles.overlay} onPress={onClose} scaleTo={1}>
        <Pressable style={styles.card} onPress={(e) => e.stopPropagation()} scaleTo={1}>
          <View style={styles.headRow}>
            <Text style={styles.heading}>List settings</Text>
            <Pressable onPress={onClose} scaleTo={0.9} hitSlop={8}>
              <Icon name="close" size={18} color={colors.textSecondary} />
            </Pressable>
          </View>

          <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.body}>
            <Text style={styles.section}>DAILY GOAL</Text>
            <Text style={styles.rowHint}>
              How many tasks you're aiming to finish each day. Resets at your own midnight.
            </Text>
            <View style={styles.chipRow}>
              {GOAL_OPTIONS.map(n => {
                const on = settings.dailyGoal === n;
                return (
                  <Pressable
                    key={n}
                    style={[styles.chip, on && styles.chipOn]}
                    onPress={() => onChange({ dailyGoal: n })}
                    scaleTo={0.95}
                  >
                    <Text style={[styles.chipText, on && styles.chipTextOn]}>
                      {n === 0 ? 'Off' : n}
                    </Text>
                  </Pressable>
                );
              })}
            </View>

            <Text style={styles.section}>NEW TASKS</Text>
            <Row title="Default priority" hint="What a new task starts as.">
              <View style={styles.chipRow}>
                {PRIORITIES.map(p => {
                  const on = settings.defaultPriority === p.key;
                  return (
                    <Pressable
                      key={p.key}
                      style={[styles.chipSm, on && styles.chipOn]}
                      onPress={() => onChange({ defaultPriority: p.key })}
                      scaleTo={0.95}
                    >
                      <Text style={[styles.chipText, on && styles.chipTextOn]}>{p.label}</Text>
                    </Pressable>
                  );
                })}
              </View>
            </Row>

            <Text style={styles.section}>DISPLAY</Text>
            <Row title="Show on home screen" hint={`The "${TODO_LANDING_TITLE}" block.`}>
              <Switch
                value={settings.showOnHome}
                onValueChange={v => onChange({ showOnHome: v })}
                trackColor={{ true: colors.accent, false: colors.border }}
                thumbColor="#FFF"
              />
            </Row>
            <Row title="Keep completed tasks visible" hint="Otherwise they disappear on the next refresh.">
              <Switch
                value={settings.showCompleted}
                onValueChange={v => onChange({ showCompleted: v })}
                trackColor={{ true: colors.accent, false: colors.border }}
                thumbColor="#FFF"
              />
            </Row>
            <Row title="Someday at the top" hint="Undated tasks first instead of last.">
              <Switch
                value={settings.somedayFirst}
                onValueChange={v => onChange({ somedayFirst: v })}
                trackColor={{ true: colors.accent, false: colors.border }}
                thumbColor="#FFF"
              />
            </Row>

            {/* ── Reminders ──────────────────────────────────────────────
                ⚠️ OFF BY DEFAULT, AND THE PERMISSION IS ASKED HERE. An app that
                starts notifying before it was asked is how the whole category
                gets switched off at the OS level — and on Android 13+ a refused
                POST_NOTIFICATIONS is effectively permanent. The sheet is the one
                place the user has just said "yes, remind me", which is the only
                good moment to ask.

                ⚠️ ONE NOTIFICATION A DAY, NOT ONE PER TASK. Five tasks due on
                Monday is one reminder saying five, not five saying one. See
                services/todoDates.ts → digests. */}
            <Text style={styles.section}>REMINDERS</Text>
            <Row
              title="Remind me about due tasks"
              hint="One notification on days that have something due. Tapping it opens your slate."
            >
              <Switch
                value={settings.reminders}
                onValueChange={v => onChange({ reminders: v })}
                trackColor={{ true: colors.accent, false: colors.border }}
                thumbColor="#FFF"
              />
            </Row>
            {settings.reminders && (
              <Row title="At" hint="Your device's local time.">
                <View style={styles.chipRow}>
                  {REMINDER_TIMES.map(t => {
                    const on = settings.reminderTime === t;
                    return (
                      <Pressable
                        key={t}
                        style={[styles.chipSm, on && styles.chipOn]}
                        onPress={() => onChange({ reminderTime: t })}
                        scaleTo={0.95}
                      >
                        <Text style={[styles.chipText, on && styles.chipTextOn]}>{t}</Text>
                      </Pressable>
                    );
                  })}
                </View>
              </Row>
            )}

            <Text style={styles.section}>WHEN YOU FINISH ONE</Text>
            <Row
              title="Ask about the saved card"
              hint="After finishing a task that came from a save, offer to delete that save."
            >
              <Switch
                value={settings.askDeleteSaveOnDone}
                onValueChange={v => onChange({ askDeleteSaveOnDone: v })}
                trackColor={{ true: colors.accent, false: colors.border }}
                thumbColor="#FFF"
              />
            </Row>
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = themed(() => StyleSheet.create({
  overlay: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.6)',
    alignItems: 'center', justifyContent: 'center', padding: spacing.lg,
  },
  card: {
    width: '100%', maxWidth: 460, maxHeight: '86%',
    backgroundColor: colors.surface, borderRadius: radius.lg,
    borderWidth: 1, borderColor: colors.border, padding: spacing.lg, ...shadow.md,
  },
  headRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  heading: { color: colors.textPrimary, fontSize: font.lg, fontWeight: '800' },
  body: { paddingBottom: spacing.sm },

  section: {
    color: colors.textTertiary, fontSize: font.xs, fontWeight: '800',
    letterSpacing: 1.1, marginTop: spacing.md, marginBottom: spacing.xs,
  },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.sm,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  rowTitle: { color: colors.textPrimary, fontSize: font.sm, fontWeight: '700' },
  rowHint: { color: colors.textSecondary, fontSize: font.xs, lineHeight: 16, marginTop: 1 },

  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs, marginTop: spacing.xs },
  chip: {
    minWidth: 46, alignItems: 'center',
    paddingHorizontal: spacing.sm + 2, paddingVertical: 7, borderRadius: radius.full,
    backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border,
  },
  chipSm: {
    paddingHorizontal: spacing.sm, paddingVertical: 5, borderRadius: radius.full,
    backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border,
  },
  chipOn: { backgroundColor: colors.accent + '24', borderColor: colors.accent },
  chipText: { color: colors.textSecondary, fontSize: font.xs, fontWeight: '700' },
  chipTextOn: { color: colors.accentLight },
}));

/** Memoized for the same reason as TodoEditor — mounted-but-idle while closed. */
export const TodoSettingsSheet = memo(TodoSettingsSheetImpl);
