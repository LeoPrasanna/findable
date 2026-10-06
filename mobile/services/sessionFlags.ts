/**
 * In-memory, session-scoped UI flags. Module-level so they survive screen
 * remounts, but deliberately NOT persisted: they reset on app restart and are
 * cleared on auth changes (see AuthContext) so a newly signed-in user gets the
 * fresh-start flow (Landing first), not the previous user's navigation state.
 */

let enteredLibrary = false;

// Set just before an accent switch remounts the tree, so the screen that owns
// the ProfilePanel reopens it and the user can keep trying colors.
let reopenPanel = false;

export function hasEnteredLibrary(): boolean {
  return enteredLibrary;
}

export function markEnteredLibrary(): void {
  enteredLibrary = true;
}

/** Going Home must clear this, not just flip local state. The library screen
 *  seeds `entered` from this flag on every mount, so leaving it set meant the
 *  next remount (opening a reel and coming back, returning from /save) silently
 *  bounced the user back into the library — Home looked like it did nothing. */
export function clearEnteredLibrary(): void {
  enteredLibrary = false;
}

/**
 * The save-ceiling alert has been shown once this session.
 *
 * ⚠️ SESSION-SCOPED ON PURPOSE, not persisted. Someone sitting at 963/1000
 * should be told once when they open the app, not on every return to the
 * library — and equally, should be told AGAIN tomorrow, because the situation
 * has not gone away. A persisted "dismissed forever" flag would let them walk
 * into a refused save having been warned once, weeks earlier.
 */
let warnedSaveCeiling = false;

/** One-shot per session: true the first time only. */
export function claimSaveCeilingWarning(): boolean {
  if (warnedSaveCeiling) return false;
  warnedSaveCeiling = true;
  return true;
}

/**
 * The trial-overflow warning, once per session.
 *
 * ⚠️ A SEPARATE FLAG FROM THE CEILING WARNING ON PURPOSE. They fire at different
 * numbers for different reasons: the ceiling one means "you are about to be refused",
 * this one means "you are fine today and will not be in a week". Sharing one flag
 * would silence whichever happened to lose the race.
 */
let warnedTrialOverflow = false;

/** One-shot per session: true the first time only. */
export function claimTrialOverflowWarning(): boolean {
  if (warnedTrialOverflow) return false;
  warnedTrialOverflow = true;
  return true;
}

export function markReopenPanel(): void {
  reopenPanel = true;
}

/** One-shot: returns whether the panel should reopen, and clears the flag. */
export function consumeReopenPanel(): boolean {
  const v = reopenPanel;
  reopenPanel = false;
  return v;
}

export function resetSessionFlags(): void {
  enteredLibrary = false;
  reopenPanel = false;
  // The next account's library has its own count; never inherit this.
  warnedSaveCeiling = false;
}
