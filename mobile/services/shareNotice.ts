/**
 * What a share notification SAYS. Pure strings, no imports — so the wording can
 * be checked by `node --experimental-strip-types` (shareNotice.test.ts) and so
 * the three processes that post these can agree on one source.
 *
 * ⚠️ THREE PROCESSES POST SHARE NOTIFICATIONS AND ONLY ONE OF THEM CAN IMPORT
 * THIS FILE. `services/shareSave.ts` (JS, foreground share) uses it directly;
 * `plugins/android/ShareSave.kt` and the Swift in
 * `plugins/withInvisibleShareIOS.js` carry hand-written copies, because they run
 * outside the JS runtime. When a string here changes, those two change with it —
 * in a NATIVE BUILD, which is the part that has already caught this project out
 * (the Kotlin platform list sat a week behind the JS one).
 *
 * The wording rules, which are the actual content of this file:
 *
 *   • The pop names the PLATFORM and the destination, because it fires while
 *     the user is still looking at Instagram and its only job is "yes, that
 *     went to Findable".
 *   • The result names the REEL, because by then the user is somewhere else and
 *     "Saved from Instagram" does not tell them WHICH thing was saved.
 *   • A failure says what went wrong in words a person can act on, and always
 *     ends with how to retry. "Save failed (500)" tells them nothing they can
 *     use.
 */

export interface Notice { title: string; body: string }

/** Cap a reel title so it does not overflow a notification body. */
function short(title: string, max = 70): string {
  const t = title.trim().replace(/\s+/g, ' ');
  if (t.length <= max) return t;
  return t.slice(0, max).replace(/[\s,;:.-]+$/, '') + '…';
}

/**
 * ⚠️ A TITLE THE EXTRACTOR INVENTED IS NOT A TITLE. "Instagram Reel" and
 * friends are the placeholders the backend writes when it could not read the
 * post, and announcing `Saved: "Instagram Reel"` is worse than saying nothing —
 * it looks like the app read something when it read nothing.
 * Mirrors PLACEHOLDER in services/readFailure.ts.
 */
const PLACEHOLDER = /^(instagram|facebook|linkedin|tiktok|threads|youtube|web|unknown)\s+(reel|post|video|short|link)s?$/i;

export function usableTitle(title?: string | null): string | null {
  const t = (title || '').trim();
  return t && !PLACEHOLDER.test(t) ? t : null;
}

/** Fires the moment the share is accepted, while the user is still in the other app. */
export function popNotice(platform: string): Notice {
  return {
    title: `${platform} → Findable`,
    body: 'Saving this one to your library…',
  };
}

export function savedNotice(platform: string, reelTitle?: string | null): Notice {
  const t = usableTitle(reelTitle);
  return {
    title: 'Saved to Findable',
    body: t
      ? `“${short(t)}” is in your library.`
      : `Your ${platform} link is in your library. The summary is being written.`,
  };
}

/**
 * Plain English, and always a way out.
 *
 * ⚠️ THE SERVER'S OWN `detail` IS ALREADY PLAIN ENGLISH and is preferred over
 * anything invented here — "Your library is full (50 saves). Delete a save to
 * make room." is written once, in `routes/reels.py`, and is tier-aware in a way
 * this file cannot be. These patterns exist for the cases that never reach the
 * server at all (offline, timeout) or that arrive as a bare status.
 */
export function failedNotice(platform: string, message?: string | null): Notice {
  const raw = (message || '').trim();
  const m = raw.toLowerCase();
  const title = `Couldn't save that ${platform} link`;
  const retry = ' Share it again to retry.';

  // Network-shaped failures: the most common real cause, and the one where the
  // server never saw the request, so it has no message of its own.
  if (!raw || /network request failed|failed to fetch|network error/.test(m)) {
    return { title, body: 'No connection when it tried.' + retry };
  }
  if (/timed out|timeout/.test(m)) {
    return { title, body: 'The server took too long to answer.' + retry };
  }
  if (/sign in|signed out|401|unauthorized|not authenticated/.test(m)) {
    return {
      title,
      body: 'Findable is signed out on this device. Open the app and sign in, then share it again.',
    };
  }
  if (/429|too many|rate limit/.test(m)) {
    return { title, body: 'Too many saves in a row. Wait a minute, then share it again.' };
  }
  // A server `detail` already ends in a sentence and often carries its own
  // instruction ("Delete a save to make room."), so it is used verbatim and only
  // gains the retry line when it does not already tell them what to do.
  const tellsThemWhatToDo = /delete|open findable|try|sign in|wait/i.test(raw);
  return { title, body: raw + (tellsThemWhatToDo ? '' : retry) };
}
