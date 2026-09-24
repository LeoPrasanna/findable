import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import type { Todo } from './api';
import { digests, digestText, atTime, todayISO } from './todoDates';

/**
 * Scheduling the reminders that `reminderPlan.ts` decided on.
 *
 * ⚠️ ONE DIGEST PER DAY, NOT ONE NOTIFICATION PER TASK — see reminderPlan.ts
 * for why, and for the day arithmetic.
 *
 * ⚠️ NO SERVER, NO PUSH. These are local notifications scheduled on the device:
 * they work offline, cost nothing, and cannot reach a phone that has not opened
 * the app since the task was created. That honest limit is why the horizon is a
 * week rather than a day — a phone that goes quiet for six days still fires the
 * right ones when the time comes.
 */

/** Every reminder we schedule carries this prefix, so we cancel ours and leave
 *  anything else (the share pop) alone. */
const ID_PREFIX = 'findable-due-';

/** Drop everything we scheduled. Anything not ours is left alone. */
export async function clearReminders(): Promise<void> {
  try {
    const all = await Notifications.getAllScheduledNotificationsAsync();
    await Promise.all(
      all
        .filter(n => typeof n.identifier === 'string' && n.identifier.startsWith(ID_PREFIX))
        .map(n => Notifications.cancelScheduledNotificationAsync(n.identifier).catch(() => {})),
    );
  } catch {
    // An unschedulable device (web, denied permission) has nothing to clear.
  }
}

/**
 * Rebuild every reminder from the current list. Safe to call often.
 *
 * ⚠️ IT DOES NOT ASK FOR PERMISSION. Being reminded is not the reason someone
 * opened the app, and a permission sheet thrown at them mid-task is how the
 * answer becomes "no" forever. The ask lives on the Reminders toggle in the
 * profile panel, where the user has just said they want this.
 */
export async function syncReminders(
  todos: Todo[],
  opts: { enabled: boolean; time: string },
): Promise<number> {
  if (Platform.OS === 'web') return 0;
  await clearReminders();
  if (!opts.enabled) return 0;

  try {
    const { status } = await Notifications.getPermissionsAsync();
    if (status !== 'granted') return 0;
  } catch {
    return 0;
  }

  const today = todayISO();
  const now = Date.now();
  let scheduled = 0;

  for (const d of digests(todos, today)) {
    const when = atTime(d.date, opts.time);
    // A time that has already passed today is not a reminder, it is a
    // notification that fires instantly — the single most annoying thing this
    // could do on a morning when the app is opened at 10am.
    if (!when || when.getTime() <= now) continue;
    const { title, body } = digestText(d, d.date === today);
    try {
      await Notifications.scheduleNotificationAsync({
        identifier: ID_PREFIX + d.date,
        content: {
          title,
          body,
          // Read by the tap handler in app/_layout.tsx.
          data: { route: '/todos' },
          ...(Platform.OS === 'android' ? { channelId: 'reminders' } : {}),
        },
        trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: when },
      });
      scheduled++;
    } catch {
      // One unschedulable day must not cost the rest of the week.
    }
  }
  return scheduled;
}

/**
 * Ask for notification permission, once, at the moment the user turns reminders
 * on. Returns whether we may post.
 *
 * ⚠️ ANDROID 13+ ONLY GIVES YOU ONE GOOD ASK. A refusal there is sticky — the
 * system stops showing the prompt — so the ask has to happen where the answer
 * is most likely to be yes. That is the toggle, not the launch screen.
 */
export async function askReminderPermission(): Promise<boolean> {
  if (Platform.OS === 'web') return false;
  try {
    const { status } = await Notifications.getPermissionsAsync();
    if (status === 'granted') return true;
    const asked = await Notifications.requestPermissionsAsync();
    return asked.status === 'granted';
  } catch {
    return false;
  }
}
