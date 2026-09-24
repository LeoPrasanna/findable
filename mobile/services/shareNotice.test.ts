/**
 * Self-check for the share notification wording.
 *
 * Run directly from .github/workflows/mobile-ci.yml — NOT via a package.json
 * script, which would move the fingerprint and orphan the OTA (mobile/AGENTS.md).
 */
import assert from 'node:assert/strict';
import { popNotice, savedNotice, failedNotice, usableTitle } from './shareNotice.ts';

// ── the pop: names where it came from and where it went ─────────────────────
const pop = popNotice('Instagram');
assert.equal(pop.title, 'Instagram → Findable');

// ── success names the REEL, because by now the user is elsewhere ────────────
const ok = savedNotice('Instagram', 'How to cold brew coffee at home');
assert.equal(ok.title, 'Saved to Findable');
assert.ok(ok.body.includes('How to cold brew coffee at home'));

// ⚠️ A PLACEHOLDER IS NOT A TITLE. The backend writes "Instagram Reel" when it
// could not read the post; quoting it back claims a read that never happened.
assert.equal(usableTitle('Instagram Reel'), null);
assert.equal(usableTitle('  facebook post '), null);
assert.equal(usableTitle('Threads post'), null);
assert.equal(usableTitle(''), null);
assert.equal(usableTitle(null), null);
assert.equal(usableTitle('Reel about instagram ads'), 'Reel about instagram ads');

const noTitle = savedNotice('Facebook', 'Facebook Post');
assert.ok(!noTitle.body.includes('Facebook Post'));
assert.ok(noTitle.body.includes('library'));

// Long titles are cut, not wrapped into a wall of text.
const long = savedNotice('YouTube', 'x'.repeat(200));
assert.ok(long.body.length < 100, long.body);
assert.ok(long.body.includes('…'));

// ── failures: plain English, and always a way out ───────────────────────────
const offline = failedNotice('Instagram', 'Network request failed');
assert.equal(offline.title, "Couldn't save that Instagram link");
assert.ok(offline.body.includes('No connection'));
assert.ok(offline.body.includes('Share it again'));

// No message at all is still a message to the user, not an empty body.
assert.ok(failedNotice('TikTok', null).body.length > 10);
assert.ok(failedNotice('TikTok', '').body.includes('connection'));

assert.ok(failedNotice('LinkedIn', 'Request timed out. The server took too long — try again.')
  .body.includes('too long'));
assert.ok(failedNotice('Threads', 'Not authenticated').body.includes('sign in'));
assert.ok(failedNotice('Threads', 'Request failed: 429').body.includes('Wait a minute'));

// ⚠️ The server's own detail is already plain English AND tier-aware. It is used
// verbatim, and does not get a second instruction bolted on when it already
// carries one.
const full = failedNotice('Instagram', 'Your library is full (50 saves). Delete a save to make room.');
assert.ok(full.body.startsWith('Your library is full'));
assert.equal(full.body.includes('Share it again to retry.'), false);

// A detail with no instruction of its own does get the retry line.
const bare = failedNotice('Instagram', 'Something went wrong on our side.');
assert.ok(bare.body.endsWith('Share it again to retry.'));

console.log('shareNotice: all assertions passed');
