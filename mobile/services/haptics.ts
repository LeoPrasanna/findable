// Thin web-safe wrapper around expo-haptics. Haptics are a native-only API; on web
// the calls are no-ops (and can reject), so every call is guarded by Platform and
// swallowed — a missing buzz must never surface an error to the user.
import { Platform } from 'react-native';
import * as Haptics from 'expo-haptics';

const enabled = Platform.OS === 'ios' || Platform.OS === 'android';

/** Save succeeded, summary finished — a positive confirmation. */
export function success() {
  if (!enabled) return;
  Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
}

/** A destructive prompt is about to appear (e.g. delete confirm). */
export function warning() {
  if (!enabled) return;
  Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
}

/** Something went wrong — save/extraction failed. */
export function error() {
  if (!enabled) return;
  Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
}

/** A light tap for routine actions (card delete, toggles). */
export function tap() {
  if (!enabled) return;
  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
}

/**
 * A promoted tile just scrolled into view.
 *
 * ⚠️ A DOUBLE PULSE, AND THE SHAPE IS THE POINT. Every other haptic in this app is a
 * single event — one light `tap`, or one of the three system notification patterns. A
 * two-beat buzz is therefore unlike anything else the app does, which is the only way a
 * vibration can come to MEAN something: on its own, a buzz says "something happened",
 * never "this tile is an advert". The label on the tile says that; this makes you look
 * at the label.
 *
 * ⚠️ IT FIRES ONCE PER TILE PER SESSION, enforced by the caller (app/index.tsx), not
 * here. Re-buzzing every time the same tile crosses the viewport turns a library into a
 * pager, and the user scrolls their library constantly.
 *
 * Medium, not Heavy: Heavy on Android maps to a long, dull vibration that reads as an
 * incoming call. Two mediums read as deliberate.
 */
export function promo() {
  if (!enabled) return;
  const buzz = () => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
  buzz();
  setTimeout(buzz, 130);
}
