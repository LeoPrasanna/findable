import assert from 'node:assert/strict';
import { reelIdFromUrl, reelIdFromNotificationData, reelPath } from './deepLink.ts';

/**
 * Run with:
 *   node --experimental-strip-types --no-warnings services/deepLink.test.ts
 *
 * ⚠️ NOT an npm script, deliberately — `@expo/fingerprint` hashes
 * package.json's `scripts` block, and a dev-only line there once orphaned an
 * OTA update from the installed build. New self-checks are invoked directly
 * from `.github/workflows/mobile-ci.yml`. See mobile/AGENTS.md.
 *
 * No framework on purpose. This pins two things that fail SILENTLY: a link
 * shape we stop recognising (the deep link just opens Home, which looks like a
 * cold start), and a link shape we start recognising that we should not (the
 * OAuth callback, where the cost is a broken sign-in).
 */

/* ── the shapes a reel link really arrives in ─────────────────────────────── */

const ID = '3f2b9c14-7a55-4d0e-9b21-0c8e4f6a1d33';   // str(uuid.uuid4())

assert.equal(reelIdFromUrl(`savehere://reel/${ID}`), ID, 'the shape we publish');
assert.equal(reelIdFromUrl(`savehere:///reel/${ID}`), ID, 'expo-linking adds a third slash');
assert.equal(reelIdFromUrl(`exp://10.0.0.2:8081/--/reel/${ID}`), ID, 'the dev client');
assert.equal(reelIdFromUrl(`/reel/${ID}`), ID, 'a bare path — what usePathname() returns');
assert.equal(reelIdFromUrl(`reel/${ID}`), ID, 'and the same with no leading slash');
assert.equal(reelIdFromUrl(`savehere://reel/${ID}?from=share`), ID, 'a query is not the route');
assert.equal(reelIdFromUrl(`savehere://reel/${ID}#top`), ID, 'nor is a fragment');
assert.equal(reelIdFromUrl(`SaveHere://reel/${ID}`), ID, 'schemes are case-insensitive');

/**
 * ⚠️ THE ONE THAT MATTERS MOST. `savehere://reel/123` has NO authority — the
 * first path segment is `reel`. Anything that strips `//host` eats it and
 * leaves `/123`, which parses as a one-segment path and returns null. If this
 * assertion ever fails, someone reached for `new URL()`.
 */
assert.equal(reelIdFromUrl('savehere://reel/abc'), 'abc', 'the host is a path segment');

/* ── everything that is NOT a reel link ───────────────────────────────────── */

// 🧨 The OAuth redirect for Google and Apple sign-in. Claiming this link is how
// you break every sign-in on the app's only door.
assert.equal(reelIdFromUrl('savehere://auth/callback'), null, 'OAuth must fall through');
assert.equal(
  reelIdFromUrl('savehere://auth/callback?code=x&state=y'), null,
  'including with its query',
);
// The iOS share doorbell — a route-shaped URL that is not a route.
assert.equal(
  reelIdFromUrl('savehere://dataUrl=savehereShareKey?nonce=B693AA52'), null,
  'the share doorbell is not a reel',
);
assert.equal(reelIdFromUrl('savehere://reel'), null, 'no id at all');
assert.equal(reelIdFromUrl('savehere://reel/'), null, 'an empty id');
assert.equal(reelIdFromUrl('savehere://reels/abc'), null, 'a near-miss route name');
assert.equal(reelIdFromUrl(`savehere://reel/${ID}/edit`), null, 'no nested route exists');
assert.equal(reelIdFromUrl('savehere://'), null);
assert.equal(reelIdFromUrl(''), null);
assert.equal(reelIdFromUrl(null), null);
assert.equal(reelIdFromUrl(undefined), null);
assert.equal(reelIdFromUrl(42), null, 'a non-string never reaches the router');

/* ── the id is untrusted input, not a formality ───────────────────────────── */

// Any app on the device can fire this at us. Decoded it is `../../pro`, and a
// router push built from it is a navigation nobody asked for.
assert.equal(reelIdFromUrl('savehere://reel/..%2F..%2Fpro'), null, 'no traversal');
assert.equal(reelIdFromUrl('savehere://reel/a b'), null, 'no whitespace');
assert.equal(reelIdFromUrl('savehere://reel/%E0%A4%A'), null, 'a malformed escape throws, not crashes');
assert.equal(reelIdFromUrl(`savehere://reel/${'x'.repeat(65)}`), null, 'length is bounded');
assert.equal(reelIdFromUrl(`savehere://reel/${'x'.repeat(64)}`), 'x'.repeat(64), 'exactly at the bound is fine');

/* ── notification payloads ────────────────────────────────────────────────── */

assert.equal(reelIdFromNotificationData({ reelId: ID }), ID);
// Every notification already sitting in someone's shade was posted before this
// field existed. It must open the app, not push at `undefined`.
assert.equal(reelIdFromNotificationData({}), null, 'a pre-existing notification');
assert.equal(reelIdFromNotificationData(undefined), null);
assert.equal(reelIdFromNotificationData(null), null);
assert.equal(reelIdFromNotificationData({ reelId: 123 }), null, 'the bridge can hand back anything');
assert.equal(reelIdFromNotificationData({ reelId: '../../pro' }), null, 'same validation as a URL');

/* ── the route spelling ───────────────────────────────────────────────────── */

assert.equal(reelPath(ID), `/reel/${ID}`);
// Round-trips: what we build is what we parse. This is the invariant that lets
// _layout.tsx compare a link against usePathname() to avoid a double push.
assert.equal(reelIdFromUrl(reelPath(ID)), ID, 'reelPath and reelIdFromUrl agree');

console.log('deepLink: all assertions passed');
