import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { api } from './api';
import { fetchClientMetadata } from './clientExtract';
import { recordNote } from './notifyStore';
import { refreshUsage } from './usageCache';

/**
 * Save a shared link WITHOUT the user having to look at Findable.
 *
 * ⚠️ THE POINT OF THIS FILE. A share is an interruption of something else —
 * you are mid-scroll in Instagram, you want the reel kept, you want to carry on
 * scrolling. Routing that to /save and making the user watch a progress screen
 * breaks exactly the flow the feature exists to protect. Nothing here needs a
 * decision from them: the URL is known, the save is unconditional, and the
 * summary was always asynchronous anyway.
 *
 * ⚠️ PHASE A. Android still LAUNCHES the app to deliver ACTION_SEND, so there
 * is a brief flash of Findable before it hands control back. Removing that
 * needs a translucent no-display Activity (a custom config plugin + Kotlin),
 * which is Phase B. iOS needs a Share Extension plus an App Group to share the
 * session — blocked on the Apple Developer account. This module is written so
 * both of those become "call `saveSharedLink` from somewhere else" rather than
 * a rewrite.
 */

/**
 * How long we hold the app open waiting to deliver device-fetched metadata.
 *
 * Instagram's page is ~670 KB and this runs on mobile data, so a couple of
 * seconds is normal. Capped because the alternative — waiting indefinitely —
 * keeps the user in Findable, which is the exact thing this feature exists to
 * avoid. The save is already committed by this point; only the caption is at
 * stake, and the server re-summarises on demand.
 */
const META_DELIVERY_MS = 8000;

/** Human name for the notification, from the URL alone — the server's platform
 *  field is not back yet when we post it, and waiting for it would defeat the
 *  purpose. */
export function platformLabel(url: string): string {
  const u = url.toLowerCase();
  if (u.includes('youtube.com') || u.includes('youtu.be')) return 'YouTube';
  if (u.includes('instagram.com')) return 'Instagram';
  if (u.includes('facebook.com') || u.includes('fb.watch') || u.includes('fb.com')) return 'Facebook';
  if (u.includes('tiktok.com')) return 'TikTok';
  // Both hosts stay live — see detect_platform() in backend/app/services/extractor.py.
  if (u.includes('threads.net') || u.includes('threads.com')) return 'Threads';
  if (u.includes('linkedin.com')) return 'LinkedIn';
  return 'the web';
}

/**
 * Ask once, and never block the save on the answer.
 *
 * ⚠️ Android 13+ requires runtime POST_NOTIFICATIONS. A user who declines still
 * gets their save — the notification is how we REPORT the work, not the work
 * itself, so a refusal must never cost them the link.
 */
async function canNotify(): Promise<boolean> {
  try {
    const { status } = await Notifications.getPermissionsAsync();
    if (status === 'granted') return true;
    const asked = await Notifications.requestPermissionsAsync();
    return asked.status === 'granted';
  } catch {
    return false;
  }
}

/**
 * ⚠️ WITHOUT THIS, A NOTIFICATION POSTED WHILE THE APP IS FOREGROUNDED IS
 * SILENTLY SWALLOWED — which is exactly our case: we post it and then exit, so
 * at the moment it fires Findable is still the app on screen. expo-notifications
 * defaults to "don't interrupt the user in the app they're already looking at",
 * a sensible default that is wrong for a notification whose entire job is to be
 * the receipt for work the user is about to walk away from.
 *
 * This, plus the missing `expo-notifications` entry in app.json's `plugins`
 * (which is what puts POST_NOTIFICATIONS in the Android manifest, so the
 * permission could never even be requested), is why the first Phase A build
 * saved correctly and notified nobody.
 *
 * Module scope on purpose: it must be registered before any notification is
 * scheduled, and importing this module is what guarantees that.
 */
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: false,   // a save is not worth a noise
    shouldSetBadge: false,
  }),
});

async function notify(title: string, body: string) {
  /**
   * ⚠️ RECORDED BEFORE THE PERMISSION CHECK, AND BEFORE THE POST.
   *
   * The OS shade is not a record — it is swiped away, often by accident, and
   * these are LOCAL notifications with no server copy behind them. A user who
   * declined the runtime permission gets no banner at all, so the drawer in
   * ProfilePanel is the ONLY place they will ever learn that a share was
   * saved (or that one failed). Gating the record on the same permission would
   * hide the receipt from exactly the people who have nothing else.
   */
  await recordNote(title, body);
  if (!(await canNotify())) return;
  try {
    await Notifications.scheduleNotificationAsync({
      content: { title, body },
      trigger: null,   // immediately
    });
  } catch {
    // A failed notification must never surface as a failed save.
  }
}

/**
 * Android needs a channel or notifications are silently dropped on 8.0+.
 * Idempotent, so calling it on every share is fine.
 */
export async function ensureNotificationChannel() {
  if (Platform.OS !== 'android') return;
  try {
    await Notifications.setNotificationChannelAsync('saves', {
      name: 'Saved links',
      importance: Notifications.AndroidImportance.DEFAULT,
    });
  } catch {}
}

/**
 * The whole background save. Resolves when the card exists server-side; the AI
 * summary continues on the backend after that, exactly as it does for a normal
 * save.
 *
 * Returns whether it worked, so the caller can decide whether to bounce the
 * user back out or leave the app open on an error they should see.
 */
export async function saveSharedLink(url: string): Promise<boolean> {
  const where = platformLabel(url);
  await ensureNotificationChannel();
  try {
    // Same two-step as app/save.tsx: kick the device-side metadata fetch off
    // alongside the save (never in front of it), then deliver it after. On
    // Instagram and Facebook this is the ONLY path that gets a caption, because
    // the server's datacenter IP is served a login wall.
    const metaPromise = fetchClientMetadata(url);
    const reel = await api.saveReel(url);

    /**
     * ⚠️ AWAITED, NOT FIRE-AND-FORGET — and that is the bug that made the very
     * first shared Instagram reel arrive with no summary at all.
     *
     * On the /save SCREEN this can be fire-and-forget: the app stays alive and
     * the promise settles in its own time. Here it cannot. The caller exits the
     * app the moment this function resolves, and `BackHandler.exitApp()` tears
     * the JS runtime down with the fetch still in flight — so the one payload
     * that Instagram content DEPENDS on (the server's datacenter IP is served a
     * login wall; the phone's is not) was killed every single time.
     *
     * Bounded so a slow page can never strand the user in our app: whatever has
     * not arrived by then is abandoned, and the save itself already succeeded.
     */
    await Promise.race([
      metaPromise
        .then(meta => (meta ? api.sendClientMetadata(reel.id, meta) : null))
        .catch(() => null),
      new Promise(resolve => setTimeout(resolve, META_DELIVERY_MS)),
    ]);

    // The AI budget just moved; keep the cache honest for the next screen.
    refreshUsage();

    await notify(
      `Saved from ${where}`,
      'Your summary is being written — it will be ready in your library.',
    );
    return true;
  } catch (e: any) {
    // Say what happened. A silent failure here is the worst outcome of all:
    // the user believes the link is kept, carries on scrolling, and finds
    // nothing later.
    await notify(
      `Couldn't save that ${where} link`,
      e?.message || 'Open Findable and paste it to try again.',
    );
    return false;
  }
}
