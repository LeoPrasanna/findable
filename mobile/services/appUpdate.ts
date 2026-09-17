import { useCallback, useEffect, useState } from 'react';
import { Platform } from 'react-native';
import * as Updates from 'expo-updates';

/**
 * Over-the-air updates, made VISIBLE.
 *
 * ── The problem this fixes ───────────────────────────────────────────────────
 * `expo-updates` has been in this app since 2026-08-15 and nothing ever called
 * it. With the default config (`checkAutomatically: ON_LOAD`) an update is
 * checked for and downloaded during launch, and then applied on the launch
 * AFTER that — silently. So shipping a JS fix meant the user got it whenever
 * they next happened to cold-start the app twice, with no way to ask for it and
 * no way to know one was waiting. For a channel whose whole selling point is
 * "JS ships without an APK" (see CLAUDE.md → mobile), that is the feature not
 * actually being delivered.
 *
 * ── What this is, and what it is deliberately NOT ────────────────────────────
 * It is a read of the state machine `expo-updates` already runs, plus one
 * action. It does not poll, it does not run a timer, and it does not update
 * anything on its own — `apply()` is only ever called from a press. An OTA
 * update replaces the running JS bundle and restarts the app; doing that
 * underneath someone mid-save is a data-loss shape, so the restart stays a
 * decision the user makes.
 *
 * ⚠️ THIS IS AN OTA UPDATE, NOT AN APP-STORE UPDATE. It carries JS and assets
 * only. A native change (SDK bump, new native module, permissions) needs a new
 * build, and `runtimeVersion` is the `fingerprint` policy precisely so such an
 * update can never land on a binary it does not match — the server simply
 * won't offer it, and this hook will correctly report nothing available. Do not
 * repurpose this into a "new version in the store" banner; it cannot see one.
 */

/** Two states are worth a button, and they take different presses. */
export type UpdateStatus =
  /** Nothing to do — no update, or updates aren't available on this build. */
  | 'none'
  /** Found on the server, not on the device yet. Press downloads, then restarts. */
  | 'available'
  /** Already downloaded (usually by the automatic launch check). Press restarts. */
  | 'ready'
  /** Downloading now. */
  | 'downloading'
  /** Restarting into the new bundle. */
  | 'restarting';

/**
 * ⚠️ Module-level, NOT state: it must survive the panel unmounting. The panel
 * is a <Modal> that mounts and unmounts on every open, so a per-component
 * timestamp would reset each time and re-check on every single open — a
 * network request per hamburger tap.
 */
let lastCheck = 0;
const CHECK_INTERVAL_MS = 5 * 60 * 1000;

/**
 * `Updates.isEnabled` is false in Expo Go, in a dev client, and in any build
 * made without the updates config. Calling `checkForUpdateAsync()` there
 * THROWS rather than returning "no" — hence the guard rather than a try/catch
 * around a call we know will fail. Web has no bundle to swap at all.
 */
export const updatesSupported = Platform.OS !== 'web' && Updates.isEnabled;

export function useAppUpdate(active: boolean) {
  const { isUpdateAvailable, isUpdatePending, isDownloading, isChecking } = Updates.useUpdates();
  const [restarting, setRestarting] = useState(false);

  // One check per panel open, at most one per CHECK_INTERVAL_MS. `active` is
  // the panel's own `visible` flag, so this costs nothing until it is opened.
  useEffect(() => {
    if (!active || !updatesSupported) return;
    if (Date.now() - lastCheck < CHECK_INTERVAL_MS) return;
    lastCheck = Date.now();
    // Swallowed on purpose: a failed check is not something to tell the user
    // about. The honest UI for "we couldn't reach the update server" is the
    // same as for "there is no update" — no button.
    Updates.checkForUpdateAsync().catch(() => {});
  }, [active]);

  const status: UpdateStatus =
    !updatesSupported ? 'none'
    : restarting ? 'restarting'
    : isDownloading ? 'downloading'
    // `isUpdatePending` before `isUpdateAvailable`: both are true once a
    // download finishes, and "ready" is the more specific — and cheaper —
    // of the two presses.
    : isUpdatePending ? 'ready'
    : isUpdateAvailable ? 'available'
    : 'none';

  /**
   * Download if needed, then restart into the new bundle.
   *
   * ⚠️ `reloadAsync()` NEVER RESOLVES on success — the JS context it was called
   * from is torn down. So nothing may be scheduled after it, and `restarting`
   * is set BEFORE the call rather than in a `.then()` that will not run. The
   * catch exists for the failure case, where it does return: there the flag has
   * to be cleared or the button stays stuck on "Restarting…" forever.
   */
  const apply = useCallback(async () => {
    if (!updatesSupported || restarting) return;
    try {
      if (!isUpdatePending) await Updates.fetchUpdateAsync();
      setRestarting(true);
      await Updates.reloadAsync();
    } catch {
      setRestarting(false);
    }
  }, [isUpdatePending, restarting]);

  return { status, isChecking, apply };
}
