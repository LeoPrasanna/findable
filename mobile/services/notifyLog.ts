/**
 * The local record of notifications we posted — pure half.
 *
 * ⚠️ WHY THIS EXISTS AT ALL. Our notifications are LOCAL: posted by
 * `services/shareSave.ts` with expo-notifications, from a share that happens
 * while the user is still in Instagram. There is no server copy, so once the
 * OS shade is swiped away the receipt is gone forever. A background save whose
 * only evidence can be dismissed by accident is a save the user cannot audit —
 * the same failure as saving nothing.
 *
 * ⚠️ NO RUNTIME IMPORTS IN THIS FILE. It is exercised by `notifyLog.test.ts`
 * under plain node (`npm run test:notifications`), which cannot load a React
 * Native module. AsyncStorage lives next door in `notifyStore.ts` — the same
 * split as `todoMerge.ts` and `rollGeometry.ts`.
 */

export interface Note {
  id: string;
  title: string;
  body: string;
  /** Epoch ms. */
  at: number;
  read: boolean;
  /**
   * The reel this receipt is about, when there is one, so tapping the row opens
   * it. OPTIONAL and must stay optional: rows written by the Android share
   * Activity and by the iOS Share Extension carry no id yet (both are native
   * code and cannot ship over the air), and every row already in a user's
   * storage predates the field.
   */
  reelId?: string;
}

/**
 * The route a receipt should open, or null if it should only mark itself read.
 *
 * ⚠️ THE FORMAT CHECK IS THE POINT. A `reelId` reaches us from storage that
 * other processes write - the Android share Activity opens the AsyncStorage
 * SQLite file directly, and the iOS extension writes through an App Group - so
 * it is not a value this module has held the whole time. The pathname is always
 * a literal, so a bad id can only 404 rather than navigate somewhere else, but
 * a row whose id is `undefined`-as-a-string or an empty string would navigate to
 * a dead screen and look broken. Checking the shape keeps the row inert instead.
 *
 * Reel ids are uuid4 (`backend/app/database.py`: `default=lambda: str(uuid.uuid4())`).
 */
const UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function reelRoute(reelId?: string | null): string | null {
  if (typeof reelId !== 'string' || !UUID4.test(reelId)) return null;
  return `/reel/${reelId}`;
}

/** A receipt drawer, not an inbox — the library is the durable record. */
export const MAX_NOTES = 10;

/**
 * Newest first, capped. Deliberately does NOT dedupe: two saves of the same
 * link are two real events, and hiding the second would be a lie about what
 * happened.
 */
export function addNote(list: Note[], note: Note): Note[] {
  return [note, ...list].slice(0, MAX_NOTES);
}

export function markRead(list: Note[], id: string): Note[] {
  return list.map(n => (n.id === id && !n.read ? { ...n, read: true } : n));
}

export function markAllRead(list: Note[]): Note[] {
  return list.map(n => (n.read ? n : { ...n, read: true }));
}

export function removeNote(list: Note[], id: string): Note[] {
  return list.filter(n => n.id !== id);
}

export function unreadCount(list: Note[]): number {
  return list.reduce((n, x) => n + (x.read ? 0 : 1), 0);
}

/**
 * Tolerant parse. A malformed store must degrade to "no notifications", never
 * to a crash on opening the profile panel — and one bad row must not discard
 * the good ones beside it.
 *
 * ⚠️ Defensive about every field ON PURPOSE. Android Phase B (the translucent
 * no-display share Activity) posts its notification from Kotlin, outside the
 * JS runtime, and has to append to this same AsyncStorage key or invisible
 * shares would be the only ones missing from the list. So this reader must
 * survive a payload it did not write.
 */
export function parseNotes(raw: string | null): Note[] {
  if (!raw) return [];
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  const out: Note[] = [];
  for (const row of data) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    const at = Number(r.at);
    if (typeof r.id !== 'string' || !r.id || !Number.isFinite(at)) continue;
    out.push({
      id: r.id,
      title: typeof r.title === 'string' ? r.title : '',
      body: typeof r.body === 'string' ? r.body : '',
      at,
      read: r.read === true,
    });
  }
  return out.slice(0, MAX_NOTES);
}

/** "Just now" / "12m ago" / "3h ago" / "Yesterday" / "4d ago". */
export function ago(at: number, now: number = Date.now()): string {
  const secs = Math.max(0, Math.round((now - at) / 1000));
  if (secs < 60) return 'Just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? 'Yesterday' : `${days}d ago`;
}

export interface Receipt { title: string; body: string; at: number }

/**
 * The iOS Share Extension's receipts, oldest first and only the usable ones.
 *
 * ⚠️ ORDER MATTERS AND IT IS BACKWARDS FROM THE DISPLAY. The drawer renders
 * newest-first and `addNote` PREPENDS, so replaying oldest-first is what leaves
 * a batch of shares the right way up. Replaying in arrival order inverts them.
 *
 * ⚠️ IT LIVES HERE, NOT IN services/shareReceipts.ts, for one practical reason:
 * this file imports nothing, so it can be exercised by `node
 * --experimental-strip-types`. shareReceipts.ts imports the native module, and
 * a test that pulls that in cannot run outside a device. Pure list arithmetic
 * belongs in the pure half — which is what this file was already for.
 *
 * The input is whatever JSON the extension wrote, so it is typed `unknown` and
 * validated rather than trusted: a receipt written by a future version of the
 * Swift must never take the drawer down with it.
 */
export function orderReceipts(raw: unknown): Receipt[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((r): r is Receipt =>
      !!r && typeof (r as Receipt).title === 'string' && !!(r as Receipt).title)
    .map(r => ({
      title: r.title,
      body: typeof r.body === 'string' ? r.body : '',
      at: typeof r.at === 'number' ? r.at : 0,
    }))
    .sort((a, b) => a.at - b.at);
}
