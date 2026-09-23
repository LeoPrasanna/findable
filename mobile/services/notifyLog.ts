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
   * The saved reel this receipt is about, when there is one — it makes the row
   * (and the OS notification) a door to the thing that was just saved.
   *
   * ⚠️ OPTIONAL, AND PERMANENTLY SO. Every receipt written before this field
   * existed is still in the store, a failed save has no reel to point at, and
   * Android Phase B's Kotlin Activity appends here from outside the JS runtime.
   * All three are normal, and all three must render as a plain, un-tappable
   * row rather than as a link to nothing.
   */
  reelId?: string;
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
    const note: Note = {
      id: r.id,
      title: typeof r.title === 'string' ? r.title : '',
      body: typeof r.body === 'string' ? r.body : '',
      at,
      read: r.read === true,
    };
    // Assigned only when it is really there, so a row that has no reel keeps
    // the exact shape it had before this field existed — `reelId: undefined`
    // would survive a round-trip through the store as a missing key anyway,
    // but the drawer reads the object, not the JSON.
    if (typeof r.reelId === 'string' && r.reelId) note.reelId = r.reelId;
    out.push(note);
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
