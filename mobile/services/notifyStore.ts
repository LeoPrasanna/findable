import AsyncStorage from '@react-native-async-storage/async-storage';
import { addNote, markAllRead, markRead, parseNotes, removeNote, type Note } from './notifyLog';

/**
 * Persistence for the notification drawer. Pure list arithmetic lives in
 * `notifyLog.ts` (and is tested there); this file is only the storage edge.
 *
 * One AsyncStorage key, best-effort, never blocking — the same shape as
 * `services/saveCount.ts`.
 *
 * ⚠️ THE KEY AND THE JSON SHAPE ARE A CONTRACT. AsyncStorage on Android is the
 * SQLite file `RKStorage` (table `catalystLocalStorage`), not SharedPreferences,
 * so Android Phase B's Kotlin share Activity can append to this exact key from
 * outside the JS runtime. Renaming either without updating the Kotlin side
 * silently drops the receipts for every invisible share.
 */
const KEY = '@savehere:notifications:v1';

async function write(list: Note[]): Promise<Note[]> {
  try {
    await AsyncStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    // A failed write must never surface as a failed save or a broken panel.
  }
  return list;
}

export async function loadNotes(): Promise<Note[]> {
  try {
    return parseNotes(await AsyncStorage.getItem(KEY));
  } catch {
    return [];
  }
}

/**
 * Record a notification we just posted. Called from the same place that calls
 * `scheduleNotificationAsync`, so the drawer cannot drift from the shade.
 *
 * ⚠️ Recorded even when the OS permission was DENIED. The user still needs to
 * know the save happened, and for someone who declined notifications this list
 * is the *only* place they will ever see it.
 */
export async function recordNote(
  title: string,
  body: string,
  reelId?: string,
): Promise<void> {
  const at = Date.now();
  await write(addNote(await loadNotes(), {
    id: `${at}-${Math.random().toString(36).slice(2, 8)}`,
    title,
    body,
    at,
    read: false,
    // A failed save has no reel to point at, so the key is simply absent —
    // see the note on `Note.reelId`.
    ...(reelId ? { reelId } : {}),
  }));
}

/**
 * Every mutation re-reads before writing. The share Activity can append while
 * the panel is open, and clobbering a save receipt is the one outcome this
 * drawer exists to prevent.
 */
const mutate = async (fn: (list: Note[]) => Note[]): Promise<Note[]> =>
  write(fn(await loadNotes()));

export const markNoteRead = (id: string) => mutate(l => markRead(l, id));
export const markAllNotesRead = () => mutate(markAllRead);
export const deleteNote = (id: string) => mutate(l => removeNote(l, id));

/** Account deletion — the next person to open the app on this device must not
 *  inherit a stranger's receipts. Mirrors `clearSaveCount()`. */
export function clearNotes() {
  AsyncStorage.removeItem(KEY).catch(() => {});
}
