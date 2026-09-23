/**
 * Deep links — the pure half.
 *
 * ⚠️ NO RUNTIME IMPORTS IN THIS FILE. It is exercised by `deepLink.test.ts`
 * under plain node (`node --experimental-strip-types`), which cannot load a
 * React Native module. The navigation that uses it lives in `app/_layout.tsx`;
 * the same split as `notifyLog.ts` / `notifyStore.ts`.
 *
 * ⚠️ A DEEP LINK IS UNTRUSTED INPUT. Any app on the device — and any web page
 * the user taps — can fire `savehere://…` at us. So the id is validated here
 * rather than handed to the router: `savehere://reel/..%2F..%2Fpro` is a link
 * someone else chose, and a router push built from it is a navigation we never
 * intended. Validation is the whole reason this file exists; the parsing is
 * the easy part.
 */

/**
 * Reel ids are `str(uuid.uuid4())` server-side (`ReelDB.id` in
 * `backend/app/database.py`), so this charset is generous, not tight. Kept as
 * a shape rather than a UUID regex because the id is the SERVER's to define —
 * a stricter pattern here would reject a future id format with a silent 404
 * instead of a fetch.
 */
const ID_SHAPE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Everything after the scheme, as expo-router itself reads it.
 *
 * ⚠️ DO NOT PARSE THIS AS A URL. `savehere://reel/123` has no authority —
 * `reel` is the first PATH segment, not a host, and `new URL()` (or any
 * `//authority` strip) eats it and leaves `/123`. expo-router treats the whole
 * remainder as a path, which is exactly why a share doorbell arrived as a
 * route called `dataUrl=savehereShareKey` rather than as a host (see
 * `app/+native-intent.ts`). Matching that reading is the point.
 */
function pathOf(url: string): string {
  let rest = url.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:/, '');
  // Expo dev client and `expo start` hand out `exp://10.0.0.2:8081/--/reel/123`,
  // where everything before `/--/` is the packager, not the route.
  const devMarker = rest.indexOf('/--/');
  if (devMarker !== -1) rest = rest.slice(devMarker + 3);
  // Query and fragment are not part of the route. Fragment first: `#` may
  // legally contain a `?`.
  return rest.split('#')[0].split('?')[0];
}

/**
 * The reel id in a deep link, or null if the link is not one.
 *
 * Accepts every shape the same link arrives in: `savehere://reel/<id>`,
 * `savehere:///reel/<id>`, the dev client's `exp://…/--/reel/<id>`, and a bare
 * `/reel/<id>` path (which is what `usePathname()` hands back, so the caller
 * can compare "where the link points" against "where we already are" with one
 * function instead of two).
 *
 * Returns null for everything else — deliberately including
 * `savehere://auth/callback`, the OAuth redirect. Anything that is not a reel
 * must fall through untouched or sign-in breaks, the same contract
 * `redirectSystemPath` carries one file over.
 */
export function reelIdFromUrl(url: unknown): string | null {
  if (typeof url !== 'string' || !url) return null;
  const segments = pathOf(url).split('/').filter(Boolean);
  // Exactly two: `reel/<id>`. `/reel/<id>/anything` is not a route this app
  // has, and accepting it would push a path the navigator cannot resolve.
  if (segments.length !== 2 || segments[0] !== 'reel') return null;
  let id: string;
  try {
    id = decodeURIComponent(segments[1]);
  } catch {
    // A malformed percent-escape throws. That is a link we did not write.
    return null;
  }
  return ID_SHAPE.test(id) ? id : null;
}

/**
 * The reel id carried by a tapped notification.
 *
 * ⚠️ `data` is typed `Record<string, unknown>` and arrives across a native
 * bridge, so every field is checked rather than trusted. A notification posted
 * before this shipped has no `reelId` at all — that is the normal case for
 * anything already in someone's shade, and it must degrade to "just open the
 * app", never to a push at `undefined`.
 */
export function reelIdFromNotificationData(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  const raw = (data as Record<string, unknown>).reelId;
  if (typeof raw !== 'string') return null;
  return ID_SHAPE.test(raw) ? raw : null;
}

/** The route for a reel. One definition, so the link, the notification and the
 *  drawer row can never drift into three spellings of the same screen. */
export function reelPath(id: string): string {
  return `/reel/${encodeURIComponent(id)}`;
}
