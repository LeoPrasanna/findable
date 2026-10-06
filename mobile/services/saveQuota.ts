/**
 * How close this library is to the save ceiling, and what to say about it.
 *
 * The cap is per tier (owner, 2026-09-11): 50 free, 500 on trial and pro.
 * `backend/app/config.py` holds both numbers and the client is TOLD its own
 * rather than knowing any of them — a client that hardcodes a limit disagrees
 * with the server the first time the server changes.
 *
 * ⚠️ THRESHOLDS ARE RATIOS, AND THAT IS WHAT SAVED THEM. They were written as
 * 90%/95% while the cap was briefly 1000-for-everyone, so the owner's "warn at
 * 900, interrupt at 950" landed as fractions. When the cap became 50/500 an
 * hour later, nothing here needed touching: free warns at 45 and interrupts at
 * 48, pro at 450 and 475. Hardcoded 900s would have meant a free user hitting a
 * refused save having never once been warned.
 *
 * Nothing here upsells. At 48/50 that is genuinely useful information, but the
 * band this renders into is one line on the library screen — the once-per-
 * session alert is where Pro gets mentioned (app/index.tsx), and the server's
 * own 403 says it too, tier-aware.
 */

export const WARN_AT = 0.9;
export const CRITICAL_AT = 0.95;

export type QuotaLevel = 'ok' | 'warn' | 'critical' | 'full';

export interface SaveQuota {
  level: QuotaLevel;
  used: number;
  limit: number;
  remaining: number;
  /**
   * How many saves must go before saving works again. 0 unless the library is at or
   * over the cap.
   *
   * ⚠️ THIS EXISTS BECAUSE A LIBRARY CAN SIT WELL ABOVE ITS CAP. The trial allows
   * 500; when it expires the same library is measured against 50, so someone who
   * saved 200 reels in their 10 trial days is 151 over. Every message here used to
   * say "delete a few", which for them was wrong by 150 and sent them round a loop:
   * delete one, retry, identical message, conclude the app is broken. It is also the
   * exact moment we ask them to pay.
   */
  toDelete: number;
  /** One line, already written. Empty at 'ok'. */
  message: string;
}

const OK: SaveQuota = { level: 'ok', used: 0, limit: 0, remaining: 0, toDelete: 0, message: '' };

/**
 * @param used  saves currently in the library
 * @param limit the server's cap; `null` means the server said unlimited, which
 *              no tier does today but the API type still allows
 */
export function saveQuota(used: number | null | undefined, limit: number | null | undefined): SaveQuota {
  if (typeof used !== 'number' || typeof limit !== 'number' || limit <= 0) return OK;

  const remaining = Math.max(0, limit - used);
  const ratio = used / limit;
  // +1 because room is needed for the NEXT save, not merely to reach the cap.
  const toDelete = used >= limit ? used - limit + 1 : 0;
  const base = { used, limit, remaining, toDelete };

  if (used > limit) {
    // Over, not merely full. "${used}/${limit}" reads as a rendering bug at 200/50,
    // so this states the two numbers as a sentence and names the real action.
    return {
      ...base, level: 'full',
      message: `${used} saves kept, ${limit} allowed — delete ${toDelete} to save again.`,
    };
  }
  if (used >= limit) {
    return {
      ...base, level: 'full',
      message: `Library full — ${used}/${limit} saves. Delete a few to keep saving.`,
    };
  }
  if (ratio >= CRITICAL_AT) {
    return {
      ...base, level: 'critical',
      // Says what happens next, not just where they are. A number alone is a
      // fact; "room for 37 more" is the thing worth acting on.
      message: `${used}/${limit} saves — room for ${remaining} more.`,
    };
  }
  if (ratio >= WARN_AT) {
    return {
      ...base, level: 'warn',
      message: `${used}/${limit} saves — delete a few if you'd rather not run out.`,
    };
  }
  return { ...base, level: 'ok', message: '' };
}
