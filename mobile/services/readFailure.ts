/**
 * Why a save has no summary — the honest version.
 *
 * ⚠️ THIS REPLACES A HARDCODED GUESS. The reel screen used to decide with
 *
 *     const loginWalled = reel.platform === 'linkedin' || reel.platform === 'facebook';
 *
 * which is not a diagnosis, it is a platform name. Every summary-less Facebook
 * card said "Facebook requires login — we couldn't read this automatically"
 * whether or not a login wall was ever involved. The card that exposed it had a
 * real title ("You just need discipline 🦅 | Anmol Sharma") and a real
 * thumbnail sitting directly above that sentence: we had plainly read the post.
 * There was simply nothing in it to summarize — Facebook's og:title *is* the
 * caption for a reel, and that caption was six words long.
 *
 * Wrong diagnoses are the specific thing the quality bar forbids ("no guessing";
 * "fail gracefully with a clear human message"). Telling someone to log in when
 * logging in would change nothing sends them to a closed door.
 *
 * The signal we already hold: a login wall yields NEITHER a real title NOR a
 * thumbnail. The server screens wall titles (`_is_login_wall_title`) and
 * `clientExtract` returns null outright when it is served a sign-in page, so a
 * walled reel keeps its "<Platform> Reel" placeholder and stays blank. Getting
 * both back means we reached the post. No new column, no migration, no build —
 * this reads fields the API already returns.
 */

/** The label the backend installs when it has nothing: "Facebook Reel". */
const PLACEHOLDER = /^(instagram|facebook|linkedin|tiktok|threads|youtube|web|unknown)\s+(reel|post)$/i;

export type ReadFailure = 'walled' | 'no-caption' | 'no-text';

export function readFailure(reel: {
  platform?: string | null;
  title?: string | null;
  thumbnail_url?: string | null;
}): ReadFailure {
  const title = (reel.title || '').trim();
  const gotThePost = !!title && !PLACEHOLDER.test(title) && !!(reel.thumbnail_url || '').trim();

  if (gotThePost) return 'no-caption';

  // Only the login-walled platforms get the login message, and only when we
  // genuinely came away empty-handed. Everything else is the honest "this reel
  // is all visuals" case.
  const p = (reel.platform || '').toLowerCase();
  return p === 'facebook' || p === 'linkedin' ? 'walled' : 'no-text';
}
