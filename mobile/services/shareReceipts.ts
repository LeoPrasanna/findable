import { takePendingShares } from '../modules/share-config';
import { orderReceipts } from './notifyLog';
import { recordNote } from './notifyStore';

/**
 * Move the iOS Share Extension's receipts into the notification drawer.
 *
 * ⚠️ WHY THIS EXISTS AT ALL. An iOS silent share used to report NOTHING —
 * no banner, no drawer entry, no trace (owner report, 2026-09-23). Android had
 * both from day one, so the same action left a record on one platform and
 * nothing on the other, and a save that failed looked exactly like one that
 * worked. The extension now posts its own notification and writes a receipt to
 * the App Group; this drains that queue into the same drawer every other save
 * reports to.
 *
 * ⚠️ THE EXTENSION CANNOT DO THIS PART ITSELF. It is a separate process with
 * its own container and no access to the app's AsyncStorage, which is where the
 * drawer lives. The App Group is the only surface both see, so the handover is
 * write-there / read-here, and the read is what this file is.
 *
 * Android needs none of it: its share Activity writes the drawer row directly,
 * because AsyncStorage on Android is a SQLite file the Kotlin can open.
 *
 * Best-effort and silent: a receipt is a convenience, and the library is the
 * real record of what was saved.
 */
export async function drainShareReceipts(): Promise<number> {
  const ordered = orderReceipts(takePendingShares());
  for (const note of ordered) {
    await recordNote(note.title, note.body, note.at || undefined).catch(() => {});
  }
  return ordered.length;
}
