import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { api } from './api';
import { fetchClientMetadata } from './clientExtract';
import { recordNote } from './notifyStore';
import { popNotice, savedNotice, failedNotice, usableTitle } from './shareNotice';
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

/**
 * The 2–3 second "yes, that went to Findable" pop.
 *
 * ⚠️ IT IS NOT RECORDED IN THE DRAWER. The drawer is a log of what happened to
 * your saves; "we started saving" is not an outcome, and logging both halves
 * would double every entry. Only the result below is recorded.
 *
 * ⚠️ ANDROID AUTO-DISMISSES IT, iOS CANNOT. `autoDismiss` maps to Android's
 * `setTimeoutAfter`, which removes the banner after the delay. iOS has no
 * equivalent for a local notification — it stays in Notification Centre until
 * the user clears it or the result replaces it. Naming the asymmetry rather
 * than pretending it does not exist: the OS decides this one, not us.
 */
const POP_MS = 3000;

async function pop(platform: string) {
  if (!(await canNotify())) return;
  const { title, body } = popNotice(platform);
  try {
    await Notifications.scheduleNotificationAsync({
      content: {
        title,
        body,
        // Replaced in place by the result on Android, so the two never stack.
        ...(Platform.OS === 'android'
          ? { autoDismiss: true, channelId: 'saves' }
          : {}),
      },
      identifier: SHARE_POP_ID,
      trigger: null,
    });
    if (Platform.OS === 'android') {
      setTimeout(() => {
        Notifications.dismissNotificationAsync(SHARE_POP_ID).catch(() => {});
      }, POP_MS);
    }
  } catch {
    // A missing pop must never cost the save.
  }
}

/** One id, so a second share replaces the first pop instead of stacking. */
const SHARE_POP_ID = 'findable-share-pop';

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
    // ⚠️ A SEPARATE CHANNEL, NOT A SHARED ONE. Android channels are the user's
    // controls, not ours: someone who wants save receipts but not task nags
    // must be able to have exactly that, and a single channel makes it
    // all-or-nothing. It also means their choice survives our defaults —
    // importance can be lowered by the user and we can never raise it back.
    await Notifications.setNotificationChannelAsync('reminders', {
      name: 'Task reminders',
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
  // ⚠️ BEFORE THE NETWORK, NOT AFTER IT. The pop's entire job is to confirm the
  // share landed while the user is still looking at the app they shared from —
  // posting it after the save would put it seconds later, often after they have
  // already moved on, which is the same as not posting it.
  pop(where);
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

    /**
     * ⚠️ RE-READ THE REEL BEFORE ANNOUNCING IT. `api.saveReel` answers the
     * instant the row exists, so its title is whatever the save request could
     * work out — usually the "Instagram Reel" placeholder. The real title
     * arrives from the metadata delivery above, which has just finished, so one
     * GET is the difference between "Saved to Findable" and
     * `“How to cold brew coffee at home” is in your library.`
     *
     * Best-effort: if the re-read fails we announce the save with what we have.
     * The save succeeded, and that is what the notification is about.
     */
    let title = usableTitle(reel.title);
    if (!title) {
      title = usableTitle((await api.getReel(reel.id).catch(() => null))?.title);
    }
    const ok = savedNotice(where, title);
    await notify(ok.title, ok.body);
    return true;
  } catch (e: any) {
    // Say what happened. A silent failure here is the worst outcome of all:
    // the user believes the link is kept, carries on scrolling, and finds
    // nothing later.
    // The backend's `detail` is already plain English and tier-aware, so it is
    // preferred over anything invented here — see failedNotice.
    const bad = failedNotice(where, e?.message);
    await notify(bad.title, bad.body);
    return false;
  }
}
