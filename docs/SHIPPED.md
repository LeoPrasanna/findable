# SaveHere — Shipped Record & Engineering Log

> **This is history, not a checklist.** Everything here is done, decided, or
> deliberately closed. It was split out of `TODO.md` on 2026-09-07, which had
> grown to 1,911 lines and stopped working as a release gate because the open
> items were buried in shipped-work narrative.
>
> **Nothing was deleted in the split** — this file is the previous TODO.md in
> full. Open and partial items live in [`TODO.md`](../TODO.md); the constraints
> and traps worth re-reading are summarised there under "Rules that bind".
>
> Read this when you want to know *why* something is the way it is: the reasoning,
> the rejected alternatives, and the bugs that cost real time are all recorded here.
> ⚠️ Figures quoted inside historical entries were true when written and may be
> superseded — `TODO.md` and the code are the current truth.

---

Track everything needed before the app is ready for the iOS App Store.
Items are ordered by dependency — complete top sections before bottom ones.

---

## ▶ DEEP LINKING (2026-09-23) — `savehere://reel/<id>`, and the save receipt became a door

**The TODO item's stated reason was obsolete and was NOT implemented.** It read
"so a share-extension save opens the detail screen directly" — written before
the invisible share existed. Opening the detail screen on a share is precisely
what the owner ruled out on 2026-08-12 ("a share is an interruption of something
else") and verified working on device on 2026-09-13: you share from Instagram,
you stay in Instagram. Building the item as written would have undone the
feature it was meant to decorate.

**What shipped instead:** the notification is the door, and the user decides
whether to walk through it. `saveSharedLink` already posted "Saved from
Instagram" and already knew the reel's id — it just threw it away. Tapping that
notification opened Findable on Home, which is a dead end: the one card you
wanted is somewhere in a masonry grid. Now the id rides in the notification's
`data`, the tap opens that reel, and the same id is stored on the drawer
receipt in `NotificationCentre` so a swiped-away banner is not the only chance
to use it.

Three entry points, one route:
- `savehere://reel/<id>` from outside the app (no producer yet — this is the
  addressable route the other two are built on, and what a future "share this
  save" or an emailed link would use).
- A tapped OS notification (`app/_layout.tsx` → `NotificationTapHandler`).
- A tapped row in the notification drawer (`components/NotificationCentre.tsx`).

Parsing and validation are pure and tested in `services/deepLink.ts` /
`deepLink.test.ts`, run in `mobile-ci.yml` — **not** as an npm script, because
`@expo/fingerprint` hashes package.json's `scripts` block (see the OTA trap
below, 2026-08-15).

**⚠️ Four things that cost thought and would cost it again:**

1. **`savehere://reel/123` HAS NO AUTHORITY.** `reel` is the first *path*
   segment, not a host. `new URL()` — or any `//host` strip — eats it and
   leaves `/123`, which parses as one segment and matches nothing. expo-router
   reads the whole remainder as a path, which is exactly why an iOS share
   doorbell arrived as a route called `dataUrl=savehereShareKey` rather than as
   a host (`app/+native-intent.ts`, 2026-09-09). The parser matches that
   reading deliberately, and `deepLink.test.ts` pins it.

2. **`useLastNotificationResponse()` THROWS ON WEB.** It calls
   `getLastNotificationResponse()` in a layout effect; on web that resolves to
   expo-notifications' stub emitter module, which has no such method and raises
   `UnavailabilityError` — at the root of the tree, on mount. A hook cannot be
   called conditionally, so `NotificationTapHandler` is mounted behind
   `Platform.OS !== 'web'` as a whole COMPONENT. Same family as the
   `sub?.remove()` AppState guard and the `Updates.isEnabled` web shim.

3. **The dedup sets are module-level, not refs.** Switching the colour scheme
   bumps `schemeEpoch`, which remounts the whole subtree, while
   `getInitialURL()` still returns the launch URL and the notification hook
   still returns the launch tap. With a ref, changing to dark mode would have
   thrown the user back onto a reel they had already left.

4. **The handlers live inside the signed-in branch**, like `ShareIntentHandler`
   — `AppStack` does not exist while the login gate is up, so a push issued
   then goes nowhere. On a cold start that is the NORMAL case: AuthProvider
   restores the session asynchronously, so every deep-link launch spends its
   first frames on the spinner. Known gap, accepted: a link arriving while the
   login screen is up *and stays up* is missed, and degrades to "the app comes
   to the front".

**A deep link is untrusted input.** Any app on the device can fire
`savehere://…` at us, so the id is validated (`[A-Za-z0-9_-]{1,64}`, decoded
first) before it reaches the router — `savehere://reel/..%2F..%2Fpro` is a
navigation nobody asked for. And everything the parser does not recognise falls
through untouched, because `savehere://auth/callback` is the OAuth redirect and
on Android Google is the only door into the app.

**Fingerprint verified unchanged** (`e647093a…` before and after), so this ships
over the air and costs no EAS build.

---

## ▶ OWNER ROUND (2026-09-17) — 6 items: two screens, Threads, shopping, OTA banner

All six shipped together. The reasoning that outlives the diff:

1. **Slate dashboard card: ~203pt → ~121pt** (owner: "the entire box is taking a
   lot of space"). Nothing was removed — same three counts, same tints, same
   quote. The height came from four places and all four were spending it badly:
   padding 32→16, the avatar row 42→34 (it set the card's height), the stat
   tiles 48→24 (a stacked 29pt number over a 10pt label became one baseline,
   "12 OPEN"), and the quote 65→39. ⚠️ The quote needed BOTH `numberOfLines={1}`
   **and** `height={34}`: `compact` is a fixed 60pt viewport, so dropping the
   line alone would have cost the line and saved zero height. `rollTravel(34,18,1)`
   = 8pt, still a real roll — pinned in `rollGeometry.test.ts`, the third time
   that arithmetic has needed a test.

2. **Home counters are tappable** — Saved → Library, On slate / Done today →
   `/todos`. This reverses a comment in `Landing.tsx` that said "these are a
   receipt, not destinations" and warned taps would rebuild the eight-link menu
   the redesign deleted. That worry was about ADDING links; this adds none, and
   nothing new renders (no chevrons, no underlines) — the affordance is the
   press dim every Pressable already has. ⚠️ `Saved` calls `onEnter`, it does
   NOT push a route: Home and Library are the same route `/` told apart by a
   session flag. `app/index.tsx` now also emits `libraryState` there, because
   the tab bar re-reads that flag only on that event — without it the library
   opened while the tab indicator stayed lit on Home. `onEnter` had been a
   declared-but-unused prop since the Ask CTA was removed; this is what it was
   for.

3. **"Paste a link" is gone at `ready`** (≥ ASK_MIN_REELS saves). It stays for
   `empty` and `learning` — a user with four saves hasn't met the tab bar yet,
   and for them the dock IS the instruction. Safe because the tab bar carries a
   `+ Save` tab and `/` is NOT in its `HIDE_ON` list, so the dock was a second
   button to the same screen sitting directly above the first. ⚠️ The bottom
   inset became the BODY's job in the same change — the dock was the only thing
   keeping centred content off the floating tab bar.

4. **Threads saves work.** See `docs/CONTEXT.md` → "Adding a platform is five
   lists, not one". The load-bearing detail: both `threads.net` and
   `threads.com`.

5. **`shopping` category.** See `docs/CONTEXT.md` → "Categories are one list in
   four places". The load-bearing detail: the prompt's disambiguation rule, not
   the four list edits.

6. **OTA update button in the profile panel.** See `docs/CONTEXT.md` → "OTA
   updates were installed but invisible".

---

## ▶ SILENT AI FAILURES (2026-09-07) — four paths failed without ever saying so

Found by running the ECC `silent-failure-hunter` over `backend/app/` (37 except
sites reviewed; `quota.py` came back clean and is the reference implementation).
Every one produced a **wrong diagnosis** rather than a crash, which is why
none of them ever showed up in a log.

| # | Defect | Fix |
|---|---|---|
| 1 | **A dead transcription path looked like a run of silent reels.** `transcriber.transcribe()` swallowed every Whisper failure into `return ""` — byte-identical to the success `""` meaning "no speech". The module had **zero logging**. Downstream, the `len(text) < 50` guard then wrote `summary_status="skipped"` and logged *"no extractable text"*, an actively wrong cause. The outer handler at [`reels.py:1033`](backend/app/routes/reels.py:1033) could never fire, because `transcribe()` had already eaten the exception. An expired `OPENAI_API_KEY` or a sustained 429 would have taken the whole feature down invisibly. | `logger.error` with exception type and message before the `return ""`. Contract unchanged — callers still get `""`. |
| 2 | **Users were charged for an empty result nobody could explain.** `workout_extractor._parse_model_json()` caught broad `Exception` and returned its fallback (`{"exercises": []}`, `{"tasks": []}`, `{"days": []}`, 4 call sites) with **no log**. `charge_ai_action` runs *before* the Claude call, so a malformed reply meant the quota unit was spent and the result was indistinguishable from "this reel genuinely had no exercises". The file already states the right principle three lines below, at the `max_tokens` branch: *"Loud and retryable, never silently downgraded."* | Narrowed to `json.JSONDecodeError` (a non-parse bug now surfaces instead of vanishing into the fallback) and logs the error plus a 200-char snippet of the raw reply — matching [`summarizer.py:261`](backend/app/services/summarizer.py:261), which already did this correctly. |
| 3 | **A dead ask-library path was invisible.** [`services/librarian.py`](backend/app/services/librarian.py) had **zero logging** and two broad swallows: the streaming path yielded *"Something went wrong while searching your library"* and the non-streaming path returned `{"error": True}`. The friendly sentence is the only signal either produced, and the **user** sees it — we never did. A sustained Anthropic 429 (which CLAUDE.md names by name as needing graceful handling) was indistinguishable from nobody asking. | Module logger added; both handlers log type and message. The `except Exception` stays broad on purpose — the friendly fallback must cover any failure — but it is no longer silent. |
| 4 | **An unreachable host was reported as "no text on the page".** `_fetch_page` logged 403/429 **status codes** but dropped transport exceptions across all 8 crawler identities, so DNS, TLS and timeout failures returned `None` with no trace. The yt-dlp loop 300 lines below already did this right (keeps `last_err`, reports once at :916) — the same pattern, one instrumented and one not. | Tracks `last_err` and a failure count, then logs **once** after the loop. Deliberately not once per identity: eight warnings per failed save would drown the 403/429 lines that carry real signal. |

**Verified:** `python -m pytest tests/ -q` → **331 passed** (327 + 4 new). Two of
the new tests are regression guards, not coverage padding:
`TestParseModelJson::test_non_parse_errors_are_not_swallowed` fails if the narrowed
`except` is widened back to `Exception`, and
`TestFetchPageObservability::test_transport_failures_are_reported_once` fails if the
summary line is moved back inside the identity loop.

### Still open from the same audit — LOW, deliberate silence

| Where | What |
|---|---|
| `extractor.py:326,407` · `reels.py:1068` | The caption-language loop and `_youtube_oembed` are graceful-degradation chains where silence is defensible; `reels.py:1068` is the mark-failed handler, and `recover_pending_summaries()` bounds the damage at restart. A debug line would cost nothing, but none of these produce a **wrong** diagnosis — which is what made 1–4 worth fixing. |

---

## ▶ 🔴 PHONE LIBRARY GRID MANGLED (2026-08-16) — one tile filled a whole column

Owner screenshot: a 3-reel library where the **left column's single tile is as tall
as the right column's two tiles combined**, a black letterbox band above the second
tile, and titles colliding. Not Pinterest — not even a grid.

**The defect.** `ReelCard`'s `styles.frame` set **both `flex: 1` and `aspectRatio`**
on the same view ([`components/ReelCard.tsx`](mobile/components/ReelCard.tsx)). Under
the library's masonry these are two competing rules for the *same dimension*: `flex: 1`
is `flexBasis: 0; flexGrow: 1`, and in a COLUMN parent that is the height — the exact
height `aspectRatio` is supposed to derive from the width. Which rule wins is a Yoga
implementation detail, and the screenshot is what losing looks like: tiles **dividing**
their column's height (1 tile → all of it, 2 tiles → half each) instead of deriving it.
The letterbox band is the same bug seen through the image: `cover` inside a frame of
the wrong shape.

**Fix — the one this file said to make.** Round 3 (item 1b below) found this exact
conflict, left it alone, and named the correct remedy: *per-grid sizing, not a value
tweak*. That is now done. The frame is `width: '100%'` and owns nothing but its ratio;
the two `numColumns` grids (`rediscover.tsx`, `search.tsx`) wrap each cell in their own
`flex: 1` view, because in a ROW flex is the width axis and dividing the row is the
**grid's** job, not the card's. One rule per dimension, in one place.

⚠️ **A SECOND SUSPECT WAS REMOVED IN THE SAME CHANGE, and the two cannot be told
apart from here.** `removeClippedSubviews` (added to this grid **earlier the same
day**, see the section below) is gone again. Its own justification conceded the prop
"blanks content in exactly this shape" on iOS, and the scroll win it bought was
recorded as *"reasoned, not observed"* — no FPS number was ever claimed. An unmeasured
gain does not outrank a live visual regression. Both edits are individually correct, so
nothing is being guessed at; but **if the grid is right on the next build, which of the
two fixed it is unknown.** Restore the prop only behind a Performance Monitor reading.

⚠️ **This is very likely the tablet bug from round 3 as well** (item 1, still open,
still no tablet screenshot) — same style, same conflict, and a tablet's shorter columns
make a stretched tile more obvious, not less. `[Likely]`, not confirmed: it will take
the owner's tablet to close item 1.

**Ships over the air — JS only, no native change, no new npm script** (see the OTA
trap below).

---

## ▶ LIBRARY SCROLL (2026-08-16) — a refresh was resetting your scroll position

Asked for "make library scrolling smooth". The real defect was not smoothness:
**`load()` always fetched `limit: PAGE` (24) at `offset: 0` and replaced the whole
list**, so after scrolling to ~100 tiles any refresh collapsed the grid back to 24 —
content shrank under the thumb and the offset clamped near the top.

It runs on focus, on `appResumed`, on `libraryState`, on pull-to-refresh, and
**every 4 s while a summary is pending** — exactly when you are scrolling a library
you just added to. `loadMore` appended 24; the poll threw them away.

⚠️ Same bug's second face: the poll only re-read page one, so **a pending reel below
position 24 never received its summary** — it read READING until you left the screen.

**Fixes.** `load` now re-reads as many as are already on screen (via `reelsRef`, so its
identity stays stable — it sits in the deps of both the focus effect and that
interval). And the poll no longer refetches the library at all: one `getReel` per
pending id, patched in place, so length/order/aspects are unchanged and only the one
card that changed re-renders.

**Measured (49 real reels, mean 2,578 B/reel):**

| Poll | every 4 s | per minute |
|---|---|---|
| before (24, resets scroll) | 60.4 KB | 0.9 MB |
| naive scroll fix (150) | 377.6 KB | 5.5 MB |
| **now (pending only)** | **2.5 KB** | **37.8 KB** |

Also `removeClippedSubviews` on the grid, **Android only** — it detaches off-screen
tiles from the native hierarchy. Not iOS: that prop blanks content in exactly this
nested absolutely-positioned column shape, and a blank tile beats a slow scroll.

⚠️ **REVERSED THE SAME DAY — see the section above.** The owner reported a mangled
phone grid hours after this shipped, and this prop was one of the two suspects. It is
out. The reasoning that added it never survived its own caveat: a prop known to blank
content *in this exact layout shape* was kept because Android "handles it better", in
exchange for a scroll improvement this section itself labels unmeasured.

⚠️ **NOT PROFILED ON A DEVICE — no FPS number here is claimed.** The payload figures
are measured; the scroll-feel improvement is reasoned, not observed. To settle it:
shake the device → **Performance Monitor**, scroll, and report the UI vs JS rows. JS
dropping alone = render work; both dropping = native view count.

⚠️ **A stale comment was corrected, not just the code.** It claimed masonry
virtualization was "incompatible without measuring every tile". That is false here —
`aspectFor()` hashes the id and `columnsForWidth()` gives the width, so every tile's
height and y-offset is known before layout. Windowing is available whenever a profile
justifies it; do not reach for a third-party grid.

---

## ▶ 🔴 OTA TRAP FOUND 2026-08-15 — ONE npm SCRIPT ORPHANED A WHOLE UPDATE

Round 6 was JS-only and should have shipped over the air. The published update
reached **nothing**: its runtime version was `b0a8b156…`, the installed build 9
is `dcafdcb7…`.

**`runtimeVersion` is the `fingerprint` policy, and `@expo/fingerprint` hashes
package.json's `scripts` block.** Adding one dev-only line to register a new
self-check changed the fingerprint. `eas fingerprint:compare` named the whole
diff as that single added script.

⚠️ **A mismatched runtime version does not warn or fail — the update simply
never applies to any device.** The failure mode is silence, which is why this
would otherwise have been found by the owner reporting "the fix didn't arrive".

**Rule:** new self-checks are invoked **directly** in `mobile-ci.yml`, never via
a new `package.json` script. The six existing `test:*` scripts are baked into
build 9's fingerprint — leave them alone. Recorded in `mobile/AGENTS.md`, which
is auto-loaded into every session that touches `mobile/`.

**Before publishing any update:**
```
cd mobile && npx eas-cli@latest fingerprint:generate -p android
```
must equal the installed build's Runtime Version from `eas build:view <id>`.

---

## ▶ ROUND 6 (2026-08-15) — 3 bugs, 1 consistency pass, 1 research-only item

| # | Item | Outcome |
|---|---|---|
| 1 | Instagram thumbnails missing on posts/reels, and disappearing over time | ✅ **The repair endpoint shipped in round 5 was returning nothing at all — 0/8 on the real library.** `instagram_embed()` read the thumbnail with `re.search(r'"display_url":"(.*?)"')`, but the embed page carries its JSON **escaped inside an HTML attribute** (`\"display_url\":\"https:\\\/\\\/…`) — there is a backslash between the key and its colon, so the pattern could never match. Nothing errored; it just returned `image: ""` forever, which surfaced as *"the post may be private or deleted"* on every Instagram save and read as an Instagram problem. Now reads the rendered `<img class="EmbeddedMediaImage">` — one unescaped URL, no `unicode_escape` round-trip — with `unescape()` for the `&amp;` in its query string (leaving those in turns a signed CDN URL into a 403). **Measured 0/8 → 8/8, all HTTP 200.** ⚠️ **The repaired URL itself expires in ~4.5 days** (verified `oe=` param), so repair alone can never be the whole answer — which is why (2) exists. |
| 1b | Custom thumbnail when there will never be a real one | ✅ `components/GeneratedCover.tsx` — a drawn cover: one `LinearGradient`, one oversized category glyph cropped by the frame, **no network, no AI, no assets**, deterministic from the reel id. Designed via subagent (`/anthropic-skills:canvas-design`); the palette is 8 ramps generated from one HSV descent so they read as exposures of one film stock. ⚠️ **Saturation, not luminance, was the defect** in the first pass: covers measured L 64.9/sat 0.70 against real photos at L 64.2/**sat 0.43** — they read as stickers on a photo wall until S dropped to 0.44. Deep stop lands at 0.72 so the bottom 28% is flat near-black and the card's existing title/scrim render **unchanged and unaware** (15.9–18.1:1 contrast before the scrim). Wordless on purpose — `ReelCard` already draws title + category, and a cover with its own would print them twice. Bucketing is in `components/coverStyle.ts` with a self-check (same split as `rollGeometry`). |
| 2 | Ads for free tier / trial — Pinterest-style in library, Truecaller-style in Ask | ✅ **Researched only, as asked — nothing built.** Full report: [`docs/ADS_RESEARCH.md`](docs/ADS_RESEARCH.md). **Recommendation: defer, and the reason is a hard blocker, not an opinion — AdMob requires an app to be published and publicly downloadable in a store before it can serve ads.** Pre-launch apps are structurally ineligible. Also found: rewarded-video revenue at 1,000 MAU is ~**$8/month** against a **$100 payout threshold**, so the money is not small, it is uncollectable; and the SDK is a native dependency costing 1–2 of 4 remaining EAS builds with **unverified RN 0.86 support**. ⚠️ Two design corrections recorded for the day it happens: rewarded ads should unlock **Pro-gated actions for free users** (which `entitlements.py` already anticipates in a comment), not top up an exhausted quota — post-trial free users can't use Ask at all, so today's quota-exhausted Ask screen belongs to trial and **Pro** users, and showing a payer ads is a churn mechanic. And never as an interstitial after a refusal: Truecaller's unit works because it fires on *completion*. |
| 3 | Hamburger menu not updating asynchronously (AI quota, library counts) | ✅ **Root cause: nothing ever told the usage cache that anything had changed.** Every screen was expected to re-fetch by hand and none did — the reel screen runs summarize / re-summarize / tasks / workout / itinerary and refreshed usage **only on mount**, so five spent actions later the cache still held the pre-spend numbers, and the panel painted those. Fixed in the one place every write already passes through: `request()` in `services/api.ts` fires a mutation hook on any non-GET (GET excluded so `getUsage` can't loop), and `askStream` reports its own spend since it bypasses `request()`. ⚠️ **Also fixed a latent race that would have swallowed exactly these refreshes:** `refreshUsage` deduped by handing concurrent callers the in-flight promise — correct for two screens asking the same question, wrong for a caller asking *because something changed*, which got a snapshot taken **before** the spend. Now marks the result stale and re-runs once. Panel, Ask and the reel screen all subscribe via `onUsage`. ⚠️ Ask needed it independently: `outOfAi` was read once on mount, so round 5's "hide the text box at zero" only engaged after a remount — **the screen that spends the quota was the last to know it had.** |
| 4 | Design inconsistent vs the home page (empty category sheets) | ✅ Four screens had grown their own empty state and drifted: home **centred**, search and rediscover **left-aligned** with a wider measure, and todos a raw `<Text>` at `font.lg` **weight 800** — in a system whose `Title` is weight **300** and whose own note says *"Never bold this; 300 is the point"*. One `<EmptyState>` in `components/kit.tsx` now, home's version as the reference (owner's instruction), and the four copies deleted. ⚠️ Also the specific thing reported: the category filter renders through `Label`, which **uppercases**, so the bubble read `FITNESS` while the empty sheet read *"Nothing in fitness"* — same word, two casings, one screen apart. Now title-cased. |

**Verified:** 327 backend tests (+6 new, was 321) · typecheck · **all 7** mobile self-checks (+1 new) ·
`expo export --platform web`. The Instagram fix is verified against **live Instagram**, not fixtures:
0/8 → 8/8 thumbnails resolving, every one returning HTTP 200.
⚠️ **Not verified on a device or in a browser** — browser navigation is blocked in this environment,
so the generated cover is verified as a *design* (rendered mockups, incl. an adjacency test at 45%
fallback density against real photos) and as *logic* (self-check), **not as pixels in the running app**.
⚠️ The **tablet layout from round 5 still has no screenshot** and nothing here changes that.

---

## ▶ ROUND 5 (2026-08-15) — 1 bug, 1 long-running layout bug, 4 features

| # | Item | Outcome |
|---|---|---|
| 1 | Thumbnails sometimes don't load | ✅ **Two causes, both measured against the real library (153 rows), not guessed.** (a) **26 rows have no `thumbnail_url` at all** — extraction failed at save time. (b) **6 rows hold a signed Instagram CDN URL that has ALREADY EXPIRED.** `scontent.*.cdninstagram.com` links carry an `oe=<hex>` expiry and the sampled ones died **~5 days** after the save (saved 2026-07-20, expired 2026-07-25). ⚠️ **(b) is the important half: it GROWS with the age of the library — every Instagram save eventually stops rendering — and no client-side retry can fix it, because the stored URL is permanently 403.** YouTube is immune (`i.ytimg.com` is unsigned), which is exactly why it looked intermittent: the bug is Instagram-shaped, not random. Fix: `POST /api/reels/{id}/thumbnail` re-resolves via the embed route (`EXTRACTION_ROUTES.md`) and stores it; `services/thumbRefresh.ts` calls it **once per reel per session**, max 3 concurrent / 40 per session, so a grid of dead tiles can't DDoS our own backend. **Charges no AI action** — a stale picture is our data going bad, not something the user asked an AI for; locked by a test. |
| 2 | Library still messy on tablet/iPad | ✅ **The last two rounds were fixing the wrong thing. `app.json` had `"orientation": "portrait"`, compiled into the manifest as `android:screenOrientation="portrait"`.** On a tablet that is letterboxed or force-resized into a layout nobody has ever designed against — and **no `columnsForWidth` tuning can reach it**, which is why the symptom survived two correct grid fixes. Now `"default"` (verified: the manifest reads `unspecified`). ⚠️ **Native — needs an APK, not OTA.** Researched on Refero alongside it (3 Pinterest captures): **the tile GROWS with the canvas** — Pinterest iOS renders a 181pt tile at 390pt, desktop ~221–248px at ~1280–1440px — while rounds 1 and 3 held it at 180 and added columns, producing a 6-wide filmstrip of phone-sized stamps. New `TARGET_TILE_WIDE = 232` above 700pt (phone output bit-identical); the grid stays full-bleed per the primary style reference. Scrim 55% → 38% (it multiplies with column count: 6 grey gradients on a phone, 15+ on a tablet, over the only colour the system spends). Library disclaimer capped at 560pt — it was rendering as one ~170-character centred line on a 1366pt iPad. |
| 3 | Ask shows a text box when the AI quota is gone | ✅ The field, its send button and the autofocus are all skipped when `remaining === 0`. It was rendering an inviting, keyboard-raising box whose only possible outcome was a 429 *after* you'd typed a whole question — telling someone a door is locked and leaving the handle turning. |
| 4 | Welcome-back page for a returning deleted-account user | ✅ `components/WelcomeBack.tsx` — **one screen, not the four-step tour**, because a returning user knows what the app is and re-teaching them is what makes a re-signup feel like starting from zero. Says plainly that the old library really is gone (pretending otherwise is a lie discovered ten seconds later on an empty grid) and that the trial did **not** restart. Signal is `returning` on `/api/account/usage`, **derived, no migration**: `_ensure_profile` seeds a returning user's `trial_started_at` from the `trial_grants` row that outlives account deletion, so `created_at - trial_started_at > 5min` means "been here before". ⚠️ **`OnboardingModal` now defers to it** — a returning user's Supabase account really is minutes old, so both would otherwise fire together. |
| 5 | Search should say when to use it vs Ask | ✅ A two-way comparison on the empty search screen with **one worked example**, because "use search when you know what you want" means nothing until the two sentences sit side by side: “paneer” (search, free) vs “what can I cook tonight with paneer and no oven?” (Ask, one AI action). Rule of thumb spelled out: a **thing** → search, a **question** → Ask. Matters because picking wrong is expensive in one direction only — using Ask for a lookup burns the daily budget on something search does for free. |
| 6 | Support page more polished / industrial | ✅ Added a **"Probably not a bug"** self-serve section (5 expandable cases: no summary, quota exhausted, lost picture, silent share, wrong summary) — an industrial support page answers the common cases before asking for an email, because most people writing in are describing expected behaviour they had no way to recognise as expected. Plus honest **response times** (one person, days not minutes, and what jumps the queue) and a **data** section stating that support cannot read their library. |

**Verified:** 321 backend tests (+21 new, was 300) · typecheck · all 6 mobile self-checks ·
`expo export --platform web` · `expo prebuild --platform android --clean` with the share-plugin
invariants intact and `screenOrientation="unspecified"` confirmed.
⚠️ **Not verified on a device.** In particular the tablet layout still has **no screenshot** —
the orientation lock is a strong, evidence-backed explanation but it is not proof, and
`useWindowDimensions().width` under Android letterboxing reports the *window*, not the screen,
which would have made every column calculation in rounds 1 and 3 correct-but-irrelevant.
**One logged `width`/`numColumns` from the real tablet settles it.**

---

## ▶ 🔴 SHIPPED BUG FOUND 2026-08-15 — FOUR BUILDS IN A ROW WERE UNINSTALLABLE

**Every build since 2026-08-14 produced `versionCode` 7.** Confirmed across four:
`aef10440`, `018a0e56`, `2551789f`, `42001928` — all 7, from a committed 6.

**Android refuses to install an APK whose `versionCode` equals the installed
one.** So after installing the first of those, the next three would have failed
on the phone with a bare *"App not installed"* — no reason given, discovered
after a 20-minute build and a queue. **This is exactly the trap
`build-preview.yml`'s header was written to prevent, and the automation never
actually prevented it.**

**Root cause:** `eas.json` had `"appVersionSource": "local"`. With that,
`autoIncrement` reads `android.versionCode` out of `app.json`, bumps it, and
writes the result back **on the build machine** — a filesystem nobody keeps. The
bump never reaches git, so every build starts from the same committed number and
lands on the same result. Expo names this directly: *"you need to commit your
changes on every build if you want the version change to persist. This can be
difficult to coordinate when building on CI."*

**Fix: `"appVersionSource": "remote"`** (Expo's recommendation since EAS CLI
12.0.0). The counter lives on EAS's servers and increments per build with no
local file to commit, so the treadmill disappears rather than being managed.

✅ **RESOLVED 2026-08-15 — no owner action needed after all.** The first build
after the fix seeded the remote counter from `app.json`'s 8 and emitted
**`versionCode` 9** (build `e7669501`, commit `b7a6dc4b`). That is the proof:
five builds straight had produced 7, and the first one under
`appVersionSource: remote` moved. `build:version:get` now reports 9.

⚠️ **DO NOT run `build:version:set` now.** It was queued as a manual fix while
the counter was uninitialized, and the number this file used to tell you to
enter (`7`) is now *below* what is installed on the phone. Setting it would make
the next build emit 8, which Android refuses to install over 9 — re-creating the
exact bug above. The command is only ever needed again if the counter is
somehow lost or a build is published outside EAS.

⚠️ `app.json`'s `versionCode: 8` is now **dead config** — EAS prints
*"ignored when version source is set to remote"* on every command. Leave it
there. Two reasons: it is a historical marker of where the seed came from, and
`runtimeVersion` is the **`fingerprint`** policy, so editing the app config can
move the fingerprint and orphan every OTA update from the installed APK. If it
is ever removed, remove it **in a PR that ships a native build anyway**, where
the fingerprint moves regardless.

---

## ▶ EAS UPDATE (OTA) — ADDED 2026-08-15. MOST FIXES NO LONGER NEED A BUILD

**Why:** the app is a native shell plus a JavaScript payload, and **almost every
change this project makes is the JavaScript half.** Of everything in round 4,
only the SDK upgrade and the Kotlin share Activity touched native — the search
screen, support page, quota labels and modal-dismissal fix were all JS, and every
one of them cost a full ~26-minute build because there was no other delivery
route. `expo-updates` gives one: the app checks Expo's server on launch and pulls
new JS. **No build, no queue, and it does not draw on the 15/month build quota**
(EAS Update is metered separately, on MAU + bandwidth — the dashboard showed
0 / 0 GiB, i.e. it had never been set up).

Ship a JS-only change with:
```
cd mobile && npx eas-cli@latest update --channel preview --message "what changed"
```

⚠️ **Native changes still need a build** — a new SDK, a new native module, changed
permissions. Same rule that forced a build for the share sheet. **It is also why
installing `expo-updates` itself costs one build: it cannot install itself over
the air.** Budget line: build 11 of 15 was the SDK 57 verification; this needs 12.

⚠️ **An OTA push is instant in BOTH directions.** A broken screen reaches the
device in seconds with no review gate. That is a real operational risk, not a
theoretical one.

### ⚠️ TWO THINGS `eas update:configure` GOT WRONG HERE — both corrected

**1. It set `runtimeVersion.policy` to `appVersion`, which would have shipped
guaranteed crashes.** That policy ties the JS runtime to `expo.version` in
app.json — which in this repo is **`"1.0.0"` and has never moved**, not across
SDK 56 → 57, not when the Kotlin `ShareActivity` was added, not when
`expo-share-intent` went 7 → 8. Under `appVersion`, an update built on SDK 57
would be offered to an SDK 56 APK, which cannot run it. Now
**`{"policy": "fingerprint"}`**, which hashes everything affecting the native
runtime — including `plugins/withInvisibleShare.js` — so an update is only ever
served to a build it genuinely fits. Expo recommends `fingerprint` exactly when
incompatible updates must be "extremely unlikely, at the cost of making it
necessary to create builds more often". That trade is right for this project:
a wrong-runtime update is a crash on a tester's phone; an extra build is 26
minutes. Verified in the prebuild output —
`<string name="expo_runtime_version">file:fingerprint</string>`.

**2. It injected an iOS `appExtensions` block nobody asked for.** The command
added `extra.eas.build.experimental.ios.appExtensions` declaring a
`ShareExtension` target and the App Group `group.com.savehere.app`. **Reverted.**
iOS cannot be built at all (blocked on the $99 Apple Developer account), that
App Group entitlement cannot be provisioned without it, and static native config
that has never been exercised is how a repo accumulates untested surface. It was
also unrelated to the change being made — a command run for OTA should not
silently add iOS native targets. `npx expo prebuild --platform android --clean`
was re-run after reverting and is unaffected, which proves Android never needed
it. Add it deliberately when iOS is actually tackled, with a real App Group.

**Channels** are wired in `eas.json` (`development` / `preview` / `production`),
so an update published to `--channel preview` reaches preview APKs only.

**Verified:** expo-doctor 21/21 · typecheck · all 6 self-checks · web export ·
`expo prebuild --platform android --clean` with the plugin invariants intact
(exactly ONE `ACTION_SEND` filter owned by `ShareActivity`, `ShareSave.kt` in
place) and `expo.modules.updates.*` meta-data present in the manifest.
⚠️ **The OTA path itself is unproven until an APK containing `expo-updates` is
installed** — you cannot test over-the-air delivery from a build that predates it.

---

## ▶ EAS BUILD BUDGET — 15/MONTH, NOT 30. AUTO-TRIGGER IS OFF (2026-08-15)

⚠️ **The "30 builds a month" everyone remembers is wrong, and wrong in the
dangerous direction.** The Free plan gives **15 Android + 15 iOS per calendar
month** — split per platform, not pooled — so an Android-only project has **15**,
not 30. Source: [expo.dev/pricing.md](https://expo.dev/pricing.md), *"Up to 15
Android and 15 iOS builds"*. The 30 figure comes from the
[2023-08-01 changelog](https://expo.dev/changelog/2023-08-01-eas-free-plan-limits),
which described a genuinely pooled allowance with an iOS sub-cap. That structure
is gone. **Trusting it overestimates Android headroom by 2x.**

⚠️ **Running out is a WALL, not a bill.** *"Once you use your monthly quota of
free builds, new builds are unavailable until the quota resets on the first day
of the next calendar month"* ([billing FAQ](https://docs.expo.dev/billing/faq/)).
Free plans cannot incur overage — there is **no pay-per-build escape hatch**. The
only unblocks are Starter ($19/mo, which also buys the high-priority queue and a
2-hour timeout) or waiting for the 1st.

**State on 2026-08-15, read off the owner's own usage dashboard: 9 builds counted**
(9 Android, 0 iOS). Eleven build records exist — 9 finished, 1 cancelled, 1 in
flight — so the dashboard's 9 confirms two things that were previously inferred:
**cancelled builds do not consume quota** (this was `[Likely]` from the docs, now
measured), and **no sibling project under `leo-app-dev-team` is drawing on the
allowance** (account total equals this project's total). Reset is **1 September**,
calendar month, not signup anniversary.
⚠️ The dashboard does **not** show the plan name. If the account is on a paid
plan the 15 ceiling does not apply at all and this whole section is moot —
confirm at `expo.dev/accounts/leo-app-dev-team/settings/billing`.

**Consequence: `build-preview.yml`'s auto-trigger is now `workflow_dispatch` only.**
A `paths` filter is not a budget — it stops *pointless* builds, but an auto-trigger
still spends the rest in merge order rather than on the merges that deserve an APK.
Builds are deliberate now:
```
cd mobile && npx eas-cli@latest workflow:run .eas/workflows/build-preview.yml
```
The `versionCode` write-back the workflow was built to automate still happens —
`autoIncrement` runs on the build machine either way. The push-trigger block is
kept commented in the file (verified working 2026-08-14, non-obvious path
patterns) for when the budget allows.

⚠️ **EAS Workflows minutes are metered separately (Free: 60/mo) but build jobs do
NOT draw from them** — *"Build jobs within workflows are billed using the same
flat-rate pricing as standalone EAS Build jobs."* This workflow contains exactly
one `type: build` job, so triggering through it costs no more than `eas build`.
That only changes if a non-build job (Maestro, a script) is ever added.

⚠️ **Quota is ACCOUNT-wide, `build:list` is PROJECT-scoped.** If another project
under `leo-app-dev-team` builds, the remaining figure is lower than this says.
No EAS CLI command exposes plan tier or remaining quota — verify at
`expo.dev/accounts/leo-app-dev-team/settings/billing`. Free plan is **assumed,
not proven by tooling.**

Other Free-tier caps worth knowing: **1 concurrent build**, low-priority queue
(*"wait times of 90+ minutes"* at peak — matches the 29.7 min measured here),
**45-minute build timeout** (compute has already hit 26.0 min), 90-day artifact
retention.

---

## ▶ SDK 57 UPGRADE — DONE 2026-08-15 (decided 2026-08-14)

`npx expo-doctor` fails one check: **Hermes V1 memory regression**, `expo@56.0.19`
on Hermes `250829098.0.10`. Researched properly before deciding; the doctor is
right, but **not for the reason it looks like**.

**What it actually is** `[Certain]` — Hermes V1 attaches debug metadata to every
function evaluated via `eval`, and worklets ship as strings `eval`'d onto the UI
runtime. **512 KB per unique worklet.** It is a step-function rise in the memory
FLOOR, allocated at init — not a leak, not GC pressure. Both platforms.
Evidence: a bare example app went **149 → 266 MB**; a real production app
**~580 MB → ~1.1 GB** ([expo/expo#46519](https://github.com/expo/expo/issues/46519),
[react-native#57059](https://github.com/react/react-native/issues/57059),
[Software Mansion write-up](https://swmansion.com/blog/how-worklets-bundle-mode-accidentally-fixed-Hermes-v1-memory-regression/)).

**Why it reaches SaveHere, which is not obvious.** The trigger is *importing*
`react-native-reanimated` / `react-native-worklets` — not using them heavily.
This app uses **zero Reanimated APIs directly**: every `Animated.*` in the
codebase is RN's legacy `Animated` (`ReelCard`, `LoginScreen`, `SkeletonCard`,
`OnboardingModal`, `Pressable`, `TaskList`, `save`, `workout/session`), and there
are **0 `'worklet'` directives in our own source**. The only consumer is **`moti`**,
in 5 files (`Confetti`, `MascotLoader`, `RollingTagline`, `TodoGoalBar`, `todos`).
471 worklet definitions sit in the dependency graph (reanimated 398, worklets 62,
moti 11). `[Likely]` only a subset is evaluated, so realistic cost is tens of MB.

⚠️ **The unvirtualized masonry does NOT multiply this, and assuming it did was
wrong.** Worklet cost is per-DEFINITION, not per-instance — mounting 200
`ReelCard`s allocates no extra metadata. Same for `libraryIndex`'s token `Set`s
(plain JS heap, and only built when someone opens search).
⚠️ **But `app/index.tsx`'s `loadMore` is a real, independent memory problem that
STACKS on the raised floor**: it appends pages and never unmounts (the documented
trade in the `ponytail:` note at the masonry), so decoded bitmaps for every tile
scrolled past stay resident all session. Hermes raises the floor, the grid climbs
from it, and they meet the OOM ceiling together on a cheap test device. **Capping
the retained window is worth doing on SDK 56 and 57 alike** — it is the half of
this we actually own.
⚠️ **No source anywhere confirms an actual OOM CRASH** — every report documents
elevated RSS only. The doubling is real; the crash is inference.

**All three narrower mitigations are dead — do not spend time on them:**
| Escape hatch | Verdict |
|---|---|
| Pin a fixed Hermes via `expo-build-properties` | ❌ **Impossible** — no Hermes version field exists in its option list `[Certain]` |
| `useHermesV1: false` on SDK 56 | ❌ **Reported ineffective** — expo/expo#46519 reporter still saw the rise `[Likely]` |
| Worklets Bundle Mode on the installed 0.8.3 | ❌ **Reject** — `bundleMode` does exist in 0.8.3, but setup requires **patching `metro` and `metro-runtime`**, upstream-labelled "temporary workarounds". More risk than the upgrade, for less. |

**Blast radius of 56 → 57 is smaller than feared.** 15 `~56.x` pins move via one
`npx expo install expo@^57.0.9 --fix` (RN 0.85.3→0.86, reanimated 4.3.1→4.5,
worklets 0.8.3→0.10; React stays 19.2). **`expo-share-intent` v8.0.1 exists with
`peerDependencies: {"expo": "^57"}`** — the "SDK 56 pin" note below is resolved by
a `7 → 8` bump, so it is **not** a blocker. `plugins/withInvisibleShare.js` is
`[Likely]` low risk: it touches no Gradle, no dependencies and no resources — one
manifest edit and one `writeFileSync` — and SDK 57's prebuild-cleans-native-dirs
change is a non-issue here because we are CNG and never commit `android/`.
No New Architecture default change.

⚠️ **Two things to watch, both stated as unverified.** (1) **RN 0.86 ships
edge-to-edge FIXES** to `Dimensions`, `KeyboardAvoidingView` and `measureInWindow`
— our `behavior="padding"` on all four KAVs is a *compensation* for the SDK 54
`adjustResize` breakage those fixes address, so it may now **double-compensate**.
Re-test every KAV after upgrading; this is the one concrete code change to expect.
(2) **SDK 57's Kotlin/Gradle/compileSdk versions could not be established** from
any reachable source — which matters because `ShareSave.kt` **has never been
compiled by anything**, so an SDK 57 build would put a first-time-compiled file
through a possibly-new compiler.

**DECISION: ship round 4 on SDK 56, then make SDK 57 the very next branch —
before the round-5 build.** Not either/or, sequenced. Reasons: rounds 1–3 already
shipped this exact regression with no reported crash; there is ~1 real user and
zero OOM evidence; and bundling an SDK major into a build that already carries an
`AppState` listener, `dismissOverlays` across six modals and a never-compiled
Kotlin Activity means a crash would tell us **which of four things** broke. This
repo has paid for that conflation before. The SDK 57 build then has exactly one
job — prove the upgrade and compile `ShareSave.kt` for the first time.

### ✅ UPGRADE APPLIED 2026-08-15 — branch `chore/sdk-57-upgrade`

**The regression is gone, verified by version rather than by an absent warning:**
`react-native@0.86.2` ships **`hermes-compiler 250829098.0.16`** — the exact first
fixed version the doctor names. `npx expo-doctor` is **21/21, no issues**.

**Both feared blockers were answered, and both were smaller than feared.**

1. **`expo-share-intent` 7 → 8.0.1.** It blocked the install exactly as predicted
   (`Conflicting peer dependency: expo@56.0.19`), and the bump cleared it. The
   "SDK 56 pin" note in the Blockers section is now stale and has been corrected.
2. **⚠️ THE KEYBOARDAVOIDINGVIEW FEAR WAS WRONG, AND THE REASON MATTERS.** The
   worry was that RN 0.86's edge-to-edge fixes would make our `behavior="padding"`
   workaround double-compensate. Read the actual commit (`4a6c933cce`): it fixes a
   **render loop that only affects `behavior="height"`** — we use `"padding"` at
   all 7 call sites — and replaces Android's legacy keyboard *height heuristic*
   with `WindowInsetsCompat`, computing the IME offset as
   `imeInsets.bottom - barInsets.bottom`. That makes `padding` **more accurate,
   not redundant**. It does **not** re-enable `adjustResize`, so the SDK 54 root
   cause (edge-to-edge disabling it, leaving `behavior={undefined}` inert) is
   unchanged and the fix stays load-bearing. The PR's own test plan covers
   `padding` on Android 7, 14 and 16. RN 0.86 is the second release shipped with
   [no user-facing breaking changes](https://reactnative.dev/blog/2026/06/11/react-native-0.86).
   **No code change was needed.** Still worth an eyeball on device: the offset may
   shift by the nav-bar inset now that it is measured rather than guessed.

**The "unverified toolchain" gap is CLOSED — measured off a real prebuild, not
researched.** SDK 57 / RN 0.86.2 resolves to **Kotlin 2.1.20, AGP 8.12.0, Gradle
wrapper 9.3.1, compileSdk/targetSdk 36, minSdk 24, NDK 27.1.12297006**
(`node_modules/react-native/gradle/libs.versions.toml`). `newArchEnabled=true`,
`hermesEnabled=true`, `edgeToEdgeEnabled=true`. Kotlin 2.1.20 is unremarkable —
`ShareSave.kt` uses no version-sensitive language features.

**`plugins/withInvisibleShare.js` survives SDK 57 unchanged** — `npx expo prebuild
--platform android --clean` produces exactly the same invariants as on SDK 56:
**one** `ACTION_SEND` filter in the manifest, owned by
`com.savehere.app.share.ShareActivity`, and `ShareSave.kt` in
`android/app/src/main/java/com/savehere/app/share/`.

⚠️ **Found and fixed while upgrading — a self-inflicted test defect.**
`quotaReset.test.ts` asserted `resumesAtSentence(...)` returned "5:30 AM
**tomorrow**" against a hardcoded date, but that function had no injectable
clock, so it read the real one. It passed on 2026-08-14 and **failed on
2026-08-15** when the same timestamp became "today". This is the identical bug
`backend/tests/test_quota.py` already carries a note about (asserting on the
local date while the quota keys rows on the UTC day → failed every run between
00:00 and 05:30 IST). `resumesAtSentence` now takes `now` like `resetsAtLabel`
does, and the test pins both ends. **A time-dependent assertion is not a test,
it is a scheduled outage.**

⚠️ **`mobile/AGENTS.md` was pointing every future session at the v56 docs.** It is
auto-loaded whenever `mobile/` is touched, so a stale version there misdirects
every later session. Bumped to v57, with a note to move it in the same commit as
any SDK upgrade.

⚠️ **`npx expo prebuild` rewrites `package.json`'s `android`/`ios` scripts to
`expo run:*`.** Reverted to `expo start --*`: this project is CNG, `android/` is
gitignored, and `expo run:android` tells the next developer to do a local native
build they have no Android SDK for.

**Verified locally:** expo-doctor 21/21 · typecheck clean · all 6 self-checks ·
`expo export --platform web` clean · `expo prebuild --platform android --clean`
clean with the plugin's manifest/Kotlin invariants intact · 300 backend tests
untouched (no backend change).
⚠️ **NOT verified on a device.** `ShareSave.kt` has still never been compiled —
the EAS build is what settles that, and it is the one job this build has.

---

## ▶ ANDROID TEST ROUND 4 (2026-08-14) — 2 bugs, 1 question, 3 features

Branch `feat/share-refresh-quota-support`. All six items traced before any edit.

| # | Item | What it actually was |
|---|---|---|
| 1 | Library needs a manual refresh to show reels shared while the app was closed | ✅ **Root cause: the app had NO `AppState` listener anywhere — zero occurrences repo-wide.** Every screen's only refresh trigger was `useFocusEffect`, and returning to a still-mounted screen is **not** a router focus event; the native share Activity saves without ever entering the JS process, so nothing invalidated anything. Fixed with ONE listener in `app/_layout.tsx` broadcasting `appResumed`, which `app/index.tsx` and `components/Landing.tsx` subscribe to. ⚠️ **A second, independent staleness path was found and fixed too:** Home and Library are the SAME route (`/`), told apart by a session flag, so switching tabs never blurs the screen — `index.tsx`'s `libraryState` subscriber only re-read the flag and never reloaded. A cold start that sat on Landing while a share arrived showed a stale grid on the very first visit, with no backgrounding involved. |
| 2 | Profile panel (or a to-do sheet) still open after leaving the app and coming back | ✅ **Round 3's `closeProfile` fix was aimed at one component and fired in one case.** There are **eight** modals in the app, and the event was emitted only for a *brand-new, URL-bearing* share intent — behind three early returns — so leaving the app any other way, sharing a photo, or a re-delivered intent all left everything on screen. `closeProfile` is now `dismissOverlays`, a broadcast fired by the same AppState listener (on `background` **only**, never iOS's transient `inactive`, or pulling down the notification shade would throw away a half-typed to-do). Subscribed by the panel, the to-do editor, the to-do settings sheet, the keep-or-delete ask, the category picker and the workout notice. ⚠️ `OnboardingModal` is deliberately **excluded** — it has no dismiss by design, and closing it without running `finish()` would burn the first-run tour without stamping the seen-flag. ⚠️ Found alongside: `showDeleteConfirm` was never reset when the panel closed, so **"Delete your account?" re-appeared unprompted** on the next open. |
| 3 | Q: when the quota resets, do all the pending AI summaries fire at once? | ✅ **No — and the answer inverts the feature.** Verified in code: an over-quota save is written `summary_status='quota_exceeded'`, and `recover_pending_summaries` filters on `pending` only (`routes/reels.py`), so **nothing retries automatically, ever**. There is no thundering herd, so there is nothing to ask the user about — the "should we run these?" prompt was not built. ⚠️ **The real bug is the opposite one:** `reel/[id].tsx` deliberately rendered **no** retry button in `quota_exceeded`, on the reasoning that nothing could succeed until the reset. True on the day, wrong every day after — the card said "resumes tomorrow" forever and offered no way to make tomorrow happen. The button now returns once `usage.remaining > 0` (gated on the live budget, not on a clock). |
| 3.1 | Feature: show *when* the quota comes back, everywhere AI is shown | ✅ `resets_at` was already in every `/api/account/usage` response and was simply never displayed. New `services/quotaReset.ts` (+ `npm run test:quota`) renders it in the **user's own clock**: midnight UTC is 5:30 AM in India and 8 PM the *previous* day in California, so the word "tomorrow" the app used everywhere was actively wrong for some users. Shown in ProfilePanel's meter (at zero), the save screen's pre-save notice, the reel detail quota state, the grid tile overlay and the new Ask block. Formatted by hand, not via `toLocaleTimeString` — Intl options are honoured inconsistently across Hermes builds. |
| 3.2 | Feature: when AI is exhausted, Ask is useless — offer a fast library search | ✅ Shipped, **but not gated on the quota, and that is a deliberate disagreement with the brief.** Search costs nothing, so hiding it until someone runs out makes the app worse for everyone who hasn't — and it recreates the exact reason the search vertical was deleted on 2026-08-10 (an entry point nobody could reach). It is always available (library header icon + menu row); Ask merely *promotes* it when the budget is gone, with wording that does not oversell it ("it finds the save; it won't answer the question"). ⚠️ **Client-side, not a revived endpoint.** `services/librarySearch.ts` is a TypeScript port of the deleted `backend/app/services/search.py` (commit `090a51a`) — same stopwords, same synonym groups, same weights, because they were tuned against real failures. The library is fetched once (`services/libraryIndex.ts`, reusing the existing list endpoint at its own 1000 cap — no new route) and **tokenized once**; a keystroke is then a synchronous scan, no debounce and no request. A round-trip per keystroke to a free instance that cold-starts in ~50 s is the version of this feature that reads as broken. Locked by `npm run test:search`, which includes a scale assertion (2,000 reels, <25 ms/query). |
| 4 | Support page | ✅ `app/support.tsx` + a **Support** row in ProfilePanel → Settings. `savehere.support@gmail.com`, with a copy-to-clipboard fallback because `mailto:` silently opens nothing on a device with no mail client — without it a user in that state has no route to support at all, which is what App Store guideline 1.5 requires. The draft is prefilled with account email, plan, app version and platform, which is what every support reply otherwise has to ask for. ⚠️ Uses `Linking.openURL` directly, **not** `services/openLink` — that helper prechecks non-http schemes with `canOpenURL`, which on Android 11+ returns false for any undeclared scheme without ever trying. That is the bug that made the Watch button dead (round 1, item 11); routing `mailto:` through it would have reproduced it exactly. |

**Verified:** 300 backend tests (untouched, still green), `npm run typecheck` clean,
`npx expo export --platform web` clean, all six mobile self-checks pass (two new),
and the app boots to the login wall in a real browser with **zero console errors** —
which is the check that the new root-level imports (`libraryIndex` → `librarySearch`,
`quotaReset`, the `AppState` effect) all load and run.
⚠️ **NOT verified logged in.** Every one of these surfaces sits behind the auth gate
and the agent's browser has no session — the same standing limitation as rounds 1–3.
Items 1 and 2 are Android lifecycle behaviour and need an APK regardless.

**Left undone on purpose:**
- `app/rediscover.tsx` refreshes on **mount only** — no `useFocusEffect` at all, so it
  is stale even returning from a reel inside the app. It was NOT wired to `appResumed`:
  the screen reshuffles its picks whenever the list changes, so refreshing it would
  make the grid jump under the user, and it deliberately biases toward *older* saves,
  so a just-shared reel would not appear there anyway. Real bug, separate fix.
- A hosted **Support URL** for App Store Connect (see "Mobile — App Store Requirements").
  The in-app page and the address exist; the public web page does not.
- A slim `GET /api/reels/index` endpoint for search. The full list payload is a few
  hundred KB at the sizes this app has; add the endpoint when that is measurably slow.

---

## ▶ ANDROID TEST ROUND 3 (2026-08-13) — 5 owner findings

| # | Item | Status / root cause |
|---|---|---|
| 1 | Tablet/iPad library overlaps, "not Pinterest at all" | ⚠️ **ONE CONFIRMED BUG FIXED; the reported symptom is still unconfirmed.** The confirmed part: round 1 named `width < 600 ? 2 : width < 1024 ? 3 : 4` as *the* reason grids looked wrong on tablets and replaced it — **in `app/index.tsx` only**. `app/rediscover.tsx` still had that exact line, so the Rediscover grid kept the bug the whole time (fix applied at one call site instead of the shared place — the pattern this repo keeps hitting). There is now ONE `columnsForWidth()` in `constants/theme.ts` and both screens import it; on a tablet Rediscover goes 3 → 4 columns and matches the library. **Whether that is what the owner saw is unknown** — see below, and still send a screenshot. |
| 1b | Tablet grid — what was ruled OUT | ❌ **Deliberately not guessed.** The column math was already "fixed" once (round 1, item 14 → `TARGET_TILE`), and it computes correctly: 768pt → 4 cols at 177pt, 834pt → 4 at 193pt, i.e. the same tile size as a phone. Two theories were examined and **both discarded**: `styles.frame`'s `flex: 1` + `aspectRatio` is a genuine Yoga ambiguity but resolves correctly when the parent's main axis is undefined (which is why the phone is right), and the shortest-column distribution is correct at every column count. Reproducing a NATIVE tablet layout is not possible on this dev box, and a web measurement would not be evidence for Yoga. **Do not apply a third speculative fix without a screenshot.** ⚠️ One thing found while ruling this out and left alone on purpose: `ReelCard`'s `styles.frame` uses `flex: 1`, which is the HEIGHT axis under the library's masonry column (competing with `aspectRatio`) but the WIDTH axis under Rediscover's FlatList row, where it is load-bearing. It cannot become `width: '100%'` without breaking Rediscover. If the tablet grid is ever traced here, the fix is per-grid sizing, not a value tweak — noted at the style. **→ SUPERSEDED 2026-08-16: it was this.** An owner screenshot of the *phone* showed tiles dividing their column's height, which is `flex: 1` beating `aspectRatio`. The remedy this row predicted — per-grid sizing — is what shipped (top of file). Two corrections to what is written above: calling the conflict "resolves correctly" was **wrong**, it was merely resolving in our favour at the time; and "cannot become `width: '100%'` without breaking Rediscover" was **half right** — the value moves, and Rediscover keeps working because the `flex: 1` moves to the grid cell that should always have owned it. |
| 2 | Profile panel still on screen when a share opens the app | ✅ **`ProfilePanel` is a `Modal` — its own native window.** The share overlay in `_layout.tsx` is an absolutely positioned sibling `View`, so it can never paint over it at any zIndex; that is why "cover it with the saving overlay" was never going to work. The panel is now *told* to close via a new `closeProfile` bus event. |
| 3 | EAS build doesn't fire on merge to `develop` | ✅ **RESOLVED — CONFIRMED WORKING 2026-08-14.** The diagnosis held: it was the GitHub connection's **base directory**, not a code bug. `eas workflow:list` now returns the registered workflow (`Android preview build`, `build-preview.yml`), and merging PR #70 to `develop` fired an Android `preview` build on its own — `Started by GitHub App`, on the merge commit. The GitHub-Actions-plus-`EXPO_TOKEN` fallback is therefore **not needed and should not be built**. ⚠️ Two standing consequences: the free-tier queue (88 min on this project once) now sits between every merge and a testable APK, and `autoIncrement` writes the bumped `versionCode` back into `mobile/app.json` **on the build machine, not locally** — so a local manual `eas build` still leaves an uncommitted bump behind. That is exactly where the stray `versionCode` 5 → 6 in the tree came from before PR #70 picked it up. |
| 4 | Delete a save should feel instant; tags don't update on cards | ✅ **Three causes, all fixed.** (a) `reel/[id]` *awaited* the DELETE before navigating — on a cold Render instance that is ~50 s staring at the reel you just deleted (same shape as the category bug from round 1). (b) `app/index.tsx` refetches in a `useFocusEffect`, so an optimistic delete would have flickered straight back from a server that hadn't processed it — new `services/libraryEdits.ts` holds in-flight deletes out of any server list, exactly as `todoMerge.ts` does for to-dos. (c) That same focus effect did `setLoading(true)`, **blanking the whole grid to skeletons on every return from a card** — the single biggest "feels slow" moment in the app. It now refreshes in place and only shows skeletons when there is genuinely nothing to show. Category changes are also pushed to the grid as a self-retiring patch, which is the "tags don't update" half. ⚠️ `ReelCard` no longer calls the API itself (it swallowed delete failures with `.catch(() => {})`, so a failed delete was invisible) — both call sites now own it. |
| 5 | Edit-profile Save button always enabled | ✅ Disabled until one of the three name fields differs from what's stored. The avatar is deliberately excluded — it auto-saves, so including it would light the button for something already saved. |

**Verified:** `npm run test:library` (new), typecheck, web export. ⚠️ Items 2 and 4 are behind the auth gate, so no logged-in visual pass — owner confirmation needed on a real build.

---

## ▶ ANDROID TEST ROUND 1 (2026-08-12) — 15 findings from the first real APK

First install from EAS (`preview` profile, Android APK). Branch `fix/android-round-1`.
⚠️ **The tested APK was commit `0df6ecb`, 5 commits behind `develop`** — but none of
those 5 touch the UI, so every finding was real against current code.

**Shipped in this round (15/15 owner items + 3 found in the build log):**

| # | Item | Root cause (not the symptom) |
|---|---|---|
| 1.1 | Keyboard covers login form | **Expo SDK 54+ forces edge-to-edge on Android, which disables `adjustResize`.** All four `KeyboardAvoidingView`s passed `behavior={undefined}` on Android, so nothing compensated. Now `behavior="padding"` everywhere. |
| 1.2 | Fields retain old text | No clear affordance + only `error` was reset on leaving the form. Added ×-to-clear, full reset on back, password dropped on mode switch, `autoComplete`/`textContentType` so the OS password manager engages. |
| 1.3 | Apple + Google login | Google is **real** now (Supabase PKCE OAuth + `expo-web-browser`, `services/oauth.ts`). Apple stays a mock — it cannot work without the $99 Developer account. ⚠️ **Guideline 4.8 binds at iOS review, not on Android**: Apple MUST be wired before the first App Store submission. |
| 2 | Tab capsule renders square | Android does **not** clip `overflow:hidden` children to a parent's *rounded* shape — only its bounding rect. The pill's `LinearGradient` fill painted square corners over the border. Fill now carries its own radius. |
| 3 | "Paste copied link" unintuitive | Placeholder is the instruction; tapping the empty field pastes, falls back to focusing for typing. Separate paste button became a Clear button. |
| 4 | Ask flashes before the lock | `savedCount` started at `null`, and `locked` needs non-null — so the working screen showed for the whole `/usage` round-trip. Now seeded from `services/saveCount`, which already existed for the home screen's identical bug. |
| 5 | Can't share into the app | `ACTION_SEND` is not a deep link — `Linking` can never see it, so no JS-only fix exists. Added `expo-share-intent@7` (SDK 56 pin) + handler in `_layout.tsx` → `/save?url=`. ⚠️ **Needs a new build; OTA cannot add a native module.** ✅ **The "SDK 56 pin" is resolved (2026-08-15):** bumped to `expo-share-intent@8.0.1` as part of the SDK 57 upgrade. It was a hard blocker on the install (`Conflicting peer dependency: expo@56.0.19`) and the bump cleared it. |
| 6 | Slate quotes clipped | Entries had drifted to 85 chars against a 42px/2-line viewport. Trimmed to a stated ~58-char budget + `numberOfLines={2}` so it can never slice mid-glyph again. |
| 7 | Todo sheet: keyboard + dates | THREE bugs. (a) a `Modal` is its own Android window and is never IME-resized — added its own KAV. (b) `onSubmitEditing={submit}` on the title meant Enter created the task before you reached the date chips. (c) **the real one**: the seed effect re-ran on every prop change, and `reel/[id]` re-fetches every 2.5s while a summary is pending — so it wiped the date (and title) you had just typed. Now latched to the open transition. |
| 8 | Instagram title → "Login • Instagram" | Instagram answers the phone's preview fetch with its **sign-in page at HTTP 200**, whose `og:title`/`og:image` are non-empty — so every "did we get a title?" check accepted the wall's branding. Screened client-side (`isLoginWall`) and server-side (`_is_login_wall_title`, folded into `_weak_title` so all three fill-sites are covered). |
| 9 | Category change is slow | It awaited a PATCH before touching any state; on a cold Render instance that is ~50s of nothing. Now optimistic with an explicit revert + message on failure. |
| 10 | Add `hobby` | Added to all four in-sync lists (summarizer, `ALLOWED_CATEGORIES`, `CATEGORY_OPTIONS`, `categoryMeta`) + a `Palette` icon. |
| 11 | Watch button dead | **Android 11 package visibility**: `canOpenURL` returns false for any scheme not declared in a `<queries>` block, so it reported failure *without ever calling `openURL`*. Watch could never have worked on Android. Precheck dropped for http/https. |
| 12 | Waiting copy below the button | Moved onto the button (2 lines, `minHeight: 58` so it can't jump); the standing hint hides while generating. |
| 13 | AI charged with no summary | Preflight asked "is `raw_text` non-empty?" — a link-only caption ("Follow us" + 3 URLs) is ~150 chars and passed. New `_usable_source()` applies the same `is_link_only` test the **save** path already uses, so "no summary" and "no charge" finally agree. Notes are exempt (first-party, and they're the documented recovery path). |
| 14 | Library → Pinterest | Researched on Refero against four Pinterest screens: `GRID_GAP` 8→12 (gutter and page margin are **equal** on Pinterest), tile radius `radius.lg` (16 — a constant, never a fraction of width), no shadow, no border, text stays overlaid inside the frame. Skeleton radius matched so category switches don't flash square. |
| 15 | Avatar needs Save | Auto-saves on tap, optimistic with revert. Names still need Save. |
| — | `app.json` splash invalid | Build log: `splash` is not an SDK 56 key — **your splash config was being silently ignored**. Moved to the `expo-splash-screen` plugin. |
| — | `userInterfaceStyle` a no-op | Build log: needs `expo-system-ui` installed, which it wasn't. Light/dark never applied natively. Installed. |
| — | 6 packages off SDK pins | `npx expo install --fix`. `expo-doctor` now 21/21. |

**Verified:** 271 backend tests pass (8 new), `npm run typecheck` clean,
`npx expo export --platform web` clean, `npx expo-doctor` 21/21.
✅ **EAS `preview` env vars confirmed present** (`eas env:list --environment preview`)
— the PR #55 concern that the next build would ship pointing at `localhost` is closed.

⚠️ **NOT verified on a device by me.** The Android-specific fixes (2, 5, 11, and the
keyboard work) cannot be reproduced in a web preview — they are Android platform
behaviours. They need the next APK to confirm.

⚠️ **Owner action before Google sign-in works:** Google Cloud → OAuth client of type
**Web application** (not Android — the callback is Supabase's URL), redirect URI
`https://ymclmbmmwtczspnmccsy.supabase.co/auth/v1/callback`; paste client ID+secret
into Supabase → Authentication → Providers → Google; add `savehere://auth/callback`
to Supabase → Authentication → URL Configuration → Redirect URLs.

---

## ▶ CURRENT FOCUS (2026-07-25) — staging is live; open decisions below need the owner

**Backend is deployed and healthy: https://savehere-api-staging.onrender.com**
(Render free tier, auto-deploys from `develop`, `savehere-dev` Supabase + Postgres.)
225 backend tests pass. Env separation, the Render blueprint, and the extraction
work are all DONE — see the shipped list below.

**Deploys are CI-gated.** Render `autoDeploy` is OFF; `.github/workflows/ci.yml`
fires the Render deploy hook only after backend tests pass. `RENDER_DEPLOY_HOOK_STAGING`
is set, so merging to `develop` auto-deploys. Prod is deliberately NOT deployed —
its service is commented out in `render.yaml` (a paid plan forces a credit card at
Blueprint apply). See [`docs/ENVIRONMENTS.md`](docs/ENVIRONMENTS.md) and
[`docs/DEPLOY.md`](docs/DEPLOY.md).

### ⚠️ Open decisions — need the owner, don't guess

1. ✅ **RESOLVED 2026-08-10 — tier caps applied.** Pro **20**/day, Trial **10**/day,
   Free **3**/day, live in `config.py` (`AI_PRO_DAILY_LIMIT=20`, `AI_DAILY_LIMIT=10`,
   `AI_FREE_DAILY_LIMIT=3`) and `.env.example`. Trial/free had already been applied
   on 2026-07-27 — this entry's claim that config "still ships 30/100/3" was stale;
   only Pro moved (20 → 25 → 15 → **20**, settled same day).
   ⚠️ **The last move was a deliberate cross-subsidy, not a fix.** 15 was raised to
   20 to be generous in India; raising the cap makes the INR shortfall *wider*, not
   narrower, since the cap IS the worst case. Owner accepted that and intends to
   cover it from US margin, revisiting when the 6-month intro offer expires.
   ⚠️ **Pro is only 2x the trial's 10/day**, so the upgrade story rests on
   **feature** gating (ask / tasks / itinerary are Pro-only post-trial), not the cap.
   First thing to revisit if conversion disappoints.
   ⚠️ `tests/test_entitlements.py` hardcoded 10/3/20 and broke on the change; it now
   asserts against `settings.*` because those cases test the tier→limit **mapping**,
   not the numbers. Retuning a cap should never turn a test red again.
   ⚠️ Render env vars override these per service — check the dashboard before
   assuming staging/prod match the code.
2. ✅ **RESOLVED — this entry was STALE (verified 2026-08-12).** The threshold is a
   single constant, `ASK_MIN_REELS = 5` in `mobile/constants/limits.ts`, matching
   the 2026-07-20 decision. It is imported by `Landing.tsx` and `app/ask.tsx`, so
   there is one number and no drift. (What was genuinely broken was the Ask screen
   *flashing* the unlocked state before the gate resolved — fixed in the Android
   round above, item 4.)
3. **Free auto-summary gating — the biggest lever on unit economics.** A cost
   study (2026-07-24) put break-even at **~4.2% conversion with free auto-summary
   gated vs ~7.8% without**; typical freemium conversion is 2–5%, so ungated is
   likely never profitable. Not implemented. Plumbing exists (`failed` → retry is
   already click-to-generate).
4. ✅ **RESOLVED 2026-08-10 — prices set by the owner, study overridden.**
   **₹25/week · ₹99/month** (India) and **$1.99/week · $7/month** (everywhere else),
   stated as a 6-month commitment, paired with Pro = 20 AI/day. Live in
   `mobile/constants/pricing.ts`.
   ✅ **Side effect: the inverted INR badge is fixed.** ₹20/wk was ₹86.96/mo — the
   monthly was the worse deal and `savingPct()` refused to render. At ₹25/wk the
   monthly saves ~9% (USD ~19%), so both storefronts show a truthful badge.
   ⚠️ **Accepted knowingly: ₹99 does not cover a maxed INR Pro user.** 20/day at
   ~$0.004/action is ~$2.43/mo worst case; $7 nets $5.95 after Apple's 15% and
   clears it ~2.4x, ₹99 nets ~$0.96 and does not (~2.5x underwater). Bounded per
   user, and the Anthropic console cap is the hard ceiling. ₹99 breaks even at
   ~8/day.
   **Watch item:** read the real p50/p95 of `ai_usage.count` for INR Pro users
   before renewing past 6 months; the fix, if needed, is a storefront-specific tier
   (`daily_limit_for` already branches on tier), not a price edit.
   ✅ **"6 months" = an Apple Introductory Offer** (owner, 2026-08-10): **₹99/month
   for 6 months, then ₹120**. Configured in App Store Connect + RevenueCat, not in
   code. Apple grants one intro offer per customer per subscription group, so a
   returning subscriber pays standard price.
   ✅ **The app-side obligation — disclosure — is now met.** `app/pro.tsx` had
   "Auto-renews monthly at ₹99 until cancelled" **hardcoded at two sites**, which
   the offer makes a false statement and an App Store review item (intro price,
   duration and standard price must all appear on the purchase screen). Both call
   the new `renewalTerms()` in `constants/pricing.ts`; `Plan` gained `introMonths`,
   with `wasPrice` doubling as the revert price.
   ⚠️ **Two intro prices still unset, deliberately not guessed:** the **USD monthly
   revert price** (₹99→₹120 is a 17.5% discount; the analogue is ~$8.49) and
   whether the **weekly** plans carry an offer at all. A plan without `introMonths`
   renders the plain renewal sentence, which is true for a plan with no offer — so
   the gap is safe, just incomplete. Needed before App Store Connect setup.

### Recommended next steps, in order

1. **Confirm the YouTube fix in the real app** — save a Short and check the summary
   appears WITHOUT a reload. If it still needs one, next suspect is the 60s polling
   cap in `mobile/app/reel/[id].tsx` (24 tries x 2.5 s), which a cold free-tier
   instance can exceed.
2. Apply the tier-cap decision (#1 above).
3. Implement free auto-summary gating (#3) — the economics lever.
4. **Native/EAS dev build.** Instagram/Facebook summaries rely on the client-side
   metadata fetch, which only works on native (browser CORS blocks it on web), so
   IG/FB still degrade on the deployed backend until a native build exists.
5. Owner creates the 3 standing test accounts in `savehere-dev`, then run
   `python scripts/dev_seed_tiers.py`.
6. **Before any prod deploy:** uncomment the prod service in `render.yaml`, set its
   `sync:false` env vars (incl. `YOUTUBE_API_KEY`), apply
   `backend/scripts/enable_rls.sql` to the PROD Supabase project (it now includes
   `ai_action_log` **and `todos`**), and enable Supabase Pro.
7. ✅ **RLS on `savehere-dev` — VERIFIED CLOSED (2026-08-10), this warning was stale.**
   Audited directly rather than trusted: every application table (`todos` included)
   reports `relrowsecurity = true` AND `relforcerowsecurity = true`, with **zero
   policies** — the intended deny-all. Proven from the OUTSIDE too, which is the
   check that actually matters: `GET /rest/v1/<table>` against
   `ymclmbmmwtczspnmccsy.supabase.co` using the **publishable key that ships in the
   app bundle** returns `200 []` for todos, reels, ai_usage, trial_grants, profiles,
   ai_action_log, tasks, workout_exercises and extraction_cache — including `reels`,
   which really holds 66 rows. The connecting backend role (`postgres`) has
   `rolbypassrls = true`, which is why FORCE doesn't break the API.
   ⚠️ **Still outstanding for PROD.** `enable_rls.sql` has NOT been applied to the
   `SaveHere` project (ref `lukmwwcilrjqqtgqbynq`) — that needs prod credentials and
   must happen before the first prod deploy. The standing rule holds regardless:
   **any new table needs a matching RLS line**, which is the trap `ai_action_log`
   and `todos` each fell into once.

### Shipped 2026-07-21 → 07-25 (PRs #11–#20, all merged)

env separation + prod service deferred (#11/#12) · deploy docs (#13) · client-side
metadata fetch for IG/FB (#14) · AI usage drill-down, honest AI disclaimer, no charge
for impossible AI actions (#15) · **extraction cache poisoning fix + summaries hidden
behind `skipped`** (#16) · search typo tolerance, category/search conflict, Home nav,
removed itinerary rebuild (#17) · library-first home + recent carousel + emoji profile
pictures, gender feature removed (#18) · **YouTube Data API v3 fallback** (#19) ·
summary no longer needs a page reload (#20).

### Gotchas that already cost real time — do not relearn these

- **Testing locally does NOT prove it works on Render.** YouTube/Instagram bot-block
  datacenter IPs; extraction that works from a residential IP returns title+thumbnail
  only from Render. To validate an extraction fix, SIMULATE the block (monkeypatch
  `yt_dlp.YoutubeDL` to raise, stub `_extract_from_page` to `{}`) or read the real row
  from the shared dev DB.
- **`/health/extract?live=1`'s `probe_ok` passes on a thumbnail alone** — it is NOT
  evidence that text extraction works.
- **Render's free tier kills in-flight background tasks** on spin-down, so
  `recover_pending_summaries` re-runs the whole chain on startup.
- **A status field lying about content caused TWO separate bugs.** Any path writing
  `summary_status` must consider that another path may be mid-flight. Reels holding a
  summary but a non-`ready` status now self-heal on startup.
- **Local dev, Codespaces and staging share ONE `savehere-dev` Postgres** — running
  things locally writes to the same database staging serves.
- **CI has no `ANTHROPIC_API_KEY` on purpose.** Tests must never make live AI calls;
  mock `summarizer` / `workout_extractor`. A test reaching the real client passes
  locally (your `.env` has a key = a real billed call) and fails CI.
- Bash: backticks inside `git commit -m "..."` get shell-evaluated and silently eat
  text — use `git commit -F <file>`. Git Bash also mangles `git show <ref>:<path>`;
  prefix `MSYS_NO_PATHCONV=1`.

### Known limitations (working as intended, not bugs)

- **Audio-only YouTube Shorts** (no description, content only in speech) can't be
  summarized server-side — caption download needs OAuth. The honest "couldn't read
  this" is correct behaviour.
- **Instagram/Facebook on web** can't use the client-side fetch (browser CORS). Native only.
- **YouTube Data API** recovers descriptions, not transcripts. 10,000 free units/day;
  `videos.list` costs 1 unit; the extraction cache is keyed by URL globally, so a
  popular link costs one call no matter how many users save it.

---

## Blockers (app does not work on a real phone without these)

- [~] **Share Extension / share sheet — Phase B (invisible Android share) BUILT 2026-08-13, needs an APK to confirm.** Branch `feat/android-invisible-share`. A translucent, content-less `ShareActivity` (custom config plugin `mobile/plugins/withInvisibleShare.js` + one Kotlin file) receives `ACTION_SEND`, hands the URL to a short foreground service and finishes — the 1–2 s app flash is gone and the user never leaves Instagram. ⚠️ **The auth design changed from what was briefed, and the reason matters:** both briefed options (mirror the token to SharedPreferences / read the SQLite store) hand the Activity a Supabase access token that has **usually already expired** — they live ~1 h and only refresh while the app is open — and refreshing from Kotlin would revoke the refresh token the app still holds and **sign the user out**. Owner chose a **save-scoped share key** instead (`backend/app/sharekey.py`, `POST /api/account/share-key`): no expiry, no rotation hazard, invisible every time. Scope is enforced by the routing table — the key authenticates exactly one route (`POST /api/reels/share-save`, a 3-line delegation to `save_reel`), proven by `tests/test_sharekey.py`. ⚠️ `share_key_tier` + `share_key_subject` snapshots are load-bearing: without them a Pro user's silent share is entitled as free, and its AI usage charges a *different* daily bucket than their normal saves. ⚠️ `expo-share-intent` is now `disableAndroid: true` — two components with the same `ACTION_SEND` filter means **two SaveHere entries in the share sheet**. ⚠️ Costs a `FOREGROUND_SERVICE_DATA_SYNC` declaration in the Play Console at launch. **Verified:** plugin runs clean under `npx expo prebuild --platform android` (manifest has exactly ONE `ACTION_SEND` filter, owned by `ShareActivity`; Kotlin lands in `com.savehere.app.share`), 300 backend tests, typecheck, web export. **NOT verified:** the Kotlin has never been compiled (no Android SDK on the dev box) or run — that needs the EAS build.
- [~] **Share Extension / share sheet (Phase A)** — **ANDROID DONE (2026-08-12), iOS pending a build.** `expo-share-intent@7` (the SDK 56 pin) is installed and wired: `ShareIntentProvider` at the root of `mobile/app/_layout.tsx`, `ShareIntentHandler` routes an incoming URL to `/save?url=`. `ACTION_SEND text/*` is confirmed in the introspected Android manifest (`npx expo config --type introspect`). The package covers **both** platforms, so this supersedes the old `expo-share-extension` plan — no separate iOS work beyond a Mac/Xcode build. ⚠️ **A native module cannot be added by OTA**: SaveHere only appears in the share sheet once the next EAS build is installed. ⚠️ Handler is mounted inside the signed-in branch on purpose — a share arriving while signed out would otherwise be lost behind the login gate.
- [x] **Deploy backend — DONE (2026-07-24).** Live at **https://savehere-api-staging.onrender.com** (Render free tier, CI-gated auto-deploy from `develop`, `savehere-dev` Postgres + auth). Prod service is deliberately commented out in `render.yaml` until launch. Walkthrough in [`docs/DEPLOY.md`](docs/DEPLOY.md). Live caveats: free-tier cold starts (~50 s to wake after 15 min idle); `DATABASE_URL` is load-bearing — unset on a Render service means ephemeral SQLite and silent data loss; and YouTube/Instagram bot-block the datacenter IP, which is why extraction leans on the YouTube Data API and the client-side fetch rather than a proxy.
- [x] **Switch API URL in mobile — DONE.** `EXPO_PUBLIC_API_URL` drives it (`mobile/services/api.ts`); `mobile/.env` and the `eas.json` build profiles point at the staging URL. ⚠️ `EXPO_PUBLIC_*` is inlined at bundle time — restart `expo start` after changing it, a browser refresh keeps the old value.
- [~] **User authentication** — Supabase Auth (email now; Google/Apple later). **Phases 1–4 done:** (1) `@supabase/supabase-js` client; (2) `get_current_user()` verifies ECC/ES256 tokens vs JWKS, no shared secret (`app/auth.py`); (3) `user_id` on `ReelDB` + **every** reels/workout/ask route scoped to the caller with ownership 404s (tasks/exercises owned via parent reel join) — `url` no longer globally unique (per-user dedup), isolation proven by tests; (4) mobile login/signup screen + auth gate in `_layout.tsx` + `Bearer` token injected in `api.ts` + sign-out in ProfilePanel. **Phase 5 done:** per-user, DB-backed daily AI quota (`ai_usage` table + `app/quota.py` `enforce_daily_ai_quota`) shared across all AI actions (ask/tasks/workout/(re)summarize), env-tunable `AI_DAILY_LIMIT` (default 30/day), replacing the interim per-IP ask cap. **Remaining:** Phase 6 Postgres in prod (`DATABASE_URL`). Email confirmation is OFF for dev — turn ON before launch. Apple Sign-In required for App Store once social login is added.
- [~] **Apple + Google sign-in — GOOGLE CODE-COMPLETE 2026-08-12, Apple still blocked.** `mobile/services/oauth.ts` runs Supabase's PKCE OAuth flow through `expo-web-browser` (`openAuthSessionAsync` → Custom Tabs / ASWebAuthenticationSession, so it shares the system cookie jar and a signed-in Google user gets one tap). One code path serves every provider, which is why no native Google SDK was added. Web falls through to Supabase's own redirect (`detectSessionInUrl`). ⚠️ **Owner setup required before it returns a session** — Google Cloud OAuth client of type **Web application**, NOT Android (the callback is Supabase's URL, not the app's): redirect URI `https://ymclmbmmwtczspnmccsy.supabase.co/auth/v1/callback`, then client ID + secret into Supabase → Auth → Providers → Google, and `savehere://auth/callback` added under Auth → URL Configuration → Redirect URLs. ⚠️ **THE CONSENT SCREEN'S PUBLISHING STATUS IS A TESTER BLOCKER, and it is easy to miss because it is not an app bug.** While it sits in **Testing**, only Google accounts on the test-user list (max 100) can sign in — everyone else gets "Access blocked: SaveHere has not completed the Google verification process". This is INDEPENDENT of EAS internal distribution: an Android APK installed from the QR needs no device registration, so a tester can install fine and still be refused at the Google button. Email sign-in is unaffected either way. **Fix is to set Publishing status → In production**, which should NOT require Google's verification review because the app requests only `email`/`profile`/`openid` — all non-sensitive scopes; verification and the "unverified app" screen apply to sensitive/restricted scopes (Gmail, Drive, contacts), which SaveHere never asks for. Confirm the Scopes section lists only those three before flipping it. **Cost: none.** Google Sign-In over OAuth 2.0 / OIDC is free and the project needs no billing account — there is no per-user or per-sign-in charge at any volume this app will see. Do not confuse it with **Google Cloud Identity Platform**, GCP's own managed auth product priced per MAU, which is NOT in use here (Supabase is the auth layer; Google is only the identity provider). ⚠️ **Two traps on that same Audience screen.** (1) **Never click "Make internal"** — it restricts sign-in to accounts in your Google Workspace domain, locking out every tester on a regular Gmail address; External is correct. (2) **Do not upload an app logo to the consent screen** — a logo triggers Google's *brand* verification review, a multi-day queue, and it is the one way to land in verification despite requesting only non-sensitive scopes. Leave it empty and publishing is instant. *Non-issue, so don't chase it:* Testing mode expires GOOGLE refresh tokens after 7 days, but Supabase uses Google once for identity and then issues its own session — nothing re-authenticates against Google afterwards, so users do not get logged out weekly. ⚠️ **Apple deliberately left as a mock** — it needs the $99 Developer account below for a Services ID + signing key, and a button that opens a browser onto a 400 is worse than one that explains itself. ⚠️ **Guideline 4.8 corrected:** it binds at **iOS review**, not on Android — shipping Google-only on Android is fine, but Apple MUST be wired before the first App Store submission. Supabase social providers; email auth stays enabled in **dev only**. Win: dropping email auth removes the SMTP/sending-domain blocker for signups (see "Production email SMTP" — auth no longer needs it). Caveat: trial-continuity hashes the email; Apple "Hide My Email" relays are stable per app, but revoke+re-auth mints a new relay → fresh trial (accepted residue — IAP raises the cycling cost). Owner setup: Google Cloud OAuth client + consent screen; Apple Services ID + signing key.
- [ ] **Apple Developer account** — $99/year, required to test on real iPhone and submit to App Store.
- [x] **Delete the Supabase Auth user on account deletion** — `DELETE /api/account` now wipes the user's data AND deletes the Supabase Auth record via the Admin API (service-role key), so the account truly ceases to exist (Apple 5.1.1(v)). Failures are reported honestly (`auth_deleted:false` + "contact support" message), never a fake success; the admin call can't 500 the wipe. Mobile signs out with `scope:'local'` (the server session is already dead after admin deletion — a server sign-out used to fail and made successful deletions LOOK broken) and errors are now visible on web too (`Alert.alert` is a silent no-op in react-native-web). Locked by tests (mocked admin call).
- [ ] **Production email SMTP** — Supabase's built-in email sender caps at ~2–4/hour ("email rate limit exceeded"), unusable for real signups. Before re-enabling "Confirm email" for launch, wire a custom SMTP under Authentication → Emails → SMTP. Free options: **Brevo** (300/day), **Resend** (3k/mo, best DX), **SendGrid** (100/day). ⚠️ Real prerequisite: a **verified sending domain** (SPF + DKIM DNS records) — so buy the domain first. Dev for now: keep "Confirm email" OFF (no email sent, no limit).
- [~] **Password strength on signup** — **client UX DONE (2026-07-20):** `LoginScreen` requires ≥8 chars to sign up (was 6), with a live 3-segment strength meter (length-first per NIST 800-63B — encourages variety, doesn't force composition rules). ⚠️ **This is UX only and trivially bypassable** — anyone can call the Supabase signup API directly. **The real enforcement is owner action in the Supabase dashboard:** Authentication → Policies → set minimum length to 8+ AND enable **leaked-password protection** (HaveIBeenPwned check) — the latter blocks `password123`-class passwords far better than any composition rule. ⚠️ Scope reality: this only matters for the **email** path, which is dev-only going forward (Apple/Google own the password in staging/prod, see above). Kept because beta testers use email auth in the interim.
- [ ] **Forgot-password — DEFERRED, not built (decided 2026-07-20)** — declined for now on purpose. Two blockers make it low-value work right now: (1) it needs **email delivery** — `supabase.auth.resetPasswordForEmail` sends a reset link, which hits the exact SMTP blocker above (Supabase's built-in sender is unusable for real volume), plus a reset-token deep-link/redirect page to build; (2) it's an **email-auth-only** concept, and email auth is being replaced by Apple + Google in staging/prod, both of which own their own account recovery. So it's blocked on SMTP *and* scoped to a being-removed feature. Revisit only if email auth is kept as a first-class prod method; otherwise it dies with the email path.

---

## Infrastructure

- [~] **Migrate SQLite → Supabase Postgres** — **code DONE + verified against real Postgres (2026-07-21):** `psycopg2-binary` added, `pool_pre_ping=True` on the engine, `DATABASE_URL` declared in `render.yaml` (`sync:false`), and Alembic replaces the ALTER hack (below). Verified against the live Supabase pooler (PostgreSQL 17.6, ap-south-1, session pooler :5432): connection OK, `alembic upgrade head` created all 8 tables with correct types (`is_sensitive`=boolean, `itinerary`/`summary`/`tags`=json — the exact things the old hack broke on Postgres), an ORM round-trip persisted+read JSON/boolean, and the app boots on Postgres (`/health` 200, migrate-on-startup a no-op). **Remaining = owner/deploy:** set `DATABASE_URL` (session pooler) in the Render dashboard at deploy; keep local dev on SQLite (leave it unset in the root `.env`) so local test data stays. Supabase Pro for prod (free tier pauses after 7d idle, no backups). ⚠️ **Original data-loss blocker still applies until the Render env var is set:** on SQLite, Render's ephemeral disk wipes the DB on every redeploy. Original audit gaps (all now addressed):
  1. **No Postgres driver** — `psycopg2-binary` is absent from `requirements.txt`; SQLAlchemy cannot connect at all today.
  2. **`DATABASE_URL` is not declared in `render.yaml`** — so a deploy silently falls back to `sqlite:///./savehere.db` on the ephemeral disk. Add it as `sync: false`. This gap IS the data-loss scenario.
  3. **`create_tables()`'s `ALTER TABLE … except: pass` loop breaks on Postgres** — see the Alembic item below.
  4. **Use the Supabase POOLER connection string, not the direct one** — direct connections are IPv6-only and Render's outbound generally isn't, which surfaces as confusing connection errors. Supavisor pooler = IPv4. Also add `pool_pre_ping=True` to the engine so stale pooled connections don't appear as random 500s.
  **No data migration needed:** leave `DATABASE_URL` unset locally → SQLite for dev; set it in staging/prod → Postgres, starting clean (local rows are test data). Decision 2026-07-20: **staying on Supabase Postgres for prod** — auth is already there, `enable_rls.sql` is Supabase-shaped, one vendor/one bill. Cost: free tier is fine for dev/staging but **pauses after 7 days idle and has no backups**, so production needs Pro ($25/mo). ⚠️ Owner action: put the pooler URL in the **repo-root `.env`** (NOT `backend/.env` — the app loads the root `.env` by walking up from `backend/`) yourself — never paste it into chat, it contains the DB password.
- [x] **Environments: Dev / Staging / Prod — DONE (2026-07-21..24; decided 2026-07-20, no PreProd)** — **Both Supabase projects now exist (2026-07-21):** `SaveHere` = PROD (ref `lukmwwcilrjqqtgqbynq`, ~27 real auth users incl. the seeded test accounts — keep clean), `savehere-dev` = DEV/STAGING (new, empty). Target shape: **dev** = `savehere-dev` Postgres (session pooler :5432) + `savehere-dev` auth (SQLite retired 2026-07-21 for Codespaces persistence — local shares the staging DB); **staging** = same `savehere-dev` Postgres + auth, 2nd Render service auto-deploying from `develop`; **prod** = `SaveHere` Postgres + `SaveHere` auth, Render (Starter+) from `main` + Supabase Pro. Each deployment gets its OWN env-var values (12-factor — no code branching). Mobile: EAS build profiles carry `EXPO_PUBLIC_API_URL` + `EXPO_PUBLIC_SUPABASE_*` per env (dev build → `savehere-dev`). PreProd skipped: with one developer, staging IS preprod. **Ordered next steps** (branch `chore/env-separation`): **Phase A DONE (no secrets):**
(1) ✅ reverted local root `.env` `DATABASE_URL` → SQLite (data back, `/health` 200);
(2) ✅ env matrix documented in [`docs/ENVIRONMENTS.md`](docs/ENVIRONMENTS.md) (+ cross-links
in DEPLOY/CONTEXT); (5) ✅ mobile per-env structured in `mobile/eas.json` — **as of 2026-08-12 no
values live in the file at all**: each build profile just names its `"environment"`, and the three
`EXPO_PUBLIC_*` vars are stored per-environment on EAS (`eas env:list --environment <env>`), so a
key rotation never touches git; (6) ✅ `render.yaml` split
into `savehere-api-staging` (←`develop`) + `savehere-api-prod` (←`main`), and the missing
`SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` runtime-auth vars added to each (were absent — a
deployed backend's auth would have broken). **Phase B — MOSTLY DONE (owner supplied dev secrets):**
(3) ✅ `savehere-dev` Postgres stood up: `alembic upgrade head` + `enable_rls.sql` applied, all 8
app tables enabled+forced (fixed: `ai_action_log` was missing from the RLS script); (4) ✅ local
`.env` + `mobile/.env` + `eas.json` pointed at `savehere-dev`. **Decision 2026-07-21: SQLite
RETIRED for local dev** — local runs on the `savehere-dev` pooler now (Codespaces persistence);
the 49 local reels were migrated + re-owned to a dev account (43 after dup-URL collapse); the
SQLite-guarded dev scripts (`dev_tier.py`/`dev_seed_tiers.py`) re-guarded to savehere-dev-only.
**Remaining:** owner creates the 3 test accounts in `savehere-dev` → run `dev_seed_tiers.py`;
stand up Render staging+prod services (owner sets each service's `sync:false` vars — ⚠️
`DATABASE_URL` in EACH); apply RLS + the `ai_action_log` fix to PROD before first prod deploy. **Gotchas:** auth users are PER-PROJECT (the seeded `trailtieruser`/`freetieruser`/`protieruser` are in PROD — recreate in dev, consider deleting from prod); the app `.env` is at the REPO ROOT not `backend/`; use the session pooler (:5432) not direct (IPv6) or transaction (:6543, breaks prepared statements); pro tier = JWT `app_metadata.tier` (≤1h cache, needs re-login), trial/free = local profiles clock.
- [ ] **Region + Cloudflare free (deploy-time decisions)** — pick the Render region nearest first users (Singapore for India-first) — effectively unchangeable later; once the domain exists, put Cloudflare free in front: free edge cache for `/api/thumbnail` (already sends `Cache-Control: max-age=86400`) and the only realistic DDoS layer. Decision 2026-07-20: **no paid CDN, no multi-instance, no dedicated secrets vault** until real traffic data says otherwise — secrets live in Render env groups (per-env) + Supabase config + GitHub Actions secrets; the Redis note under rate limiting is the multi-instance prerequisite.
- [ ] **HTTPS on backend** — Apple requires all network calls use HTTPS. Railway and Render provide this automatically.
- [x] **CORS lock down** — `main.py` already reads `ALLOWED_ORIGINS` env var; `"*"` in dev, locked list in prod. Set `ALLOWED_ORIGINS=https://yourapp.com` when deploying.
- [x] **Backend health check endpoint** — `GET /health` returns `{"status": "ok"}`. *(Enhanced extraction self-test tracked under Extraction Reliability & Scale.)*

---

## Security & Cost Control

- [x] **Per-user AI quota (the real cost ceiling + paywall lever)** — worst-case Claude spend is bounded by a **per-user, DB-backed daily quota** (`app/quota.py` + `ai_usage` table; routes call `charge_ai_action(db, user)`), shared across **every** AI action (ask/tasks/workout/(re)summarize) and keyed on the Supabase user id. Replaces the old per-IP 15/day ask cap; survives restarts/redeploys and can't be bypassed by rotating IPs. **Race-safe:** the charge is a single atomic conditional `UPDATE ... WHERE count < limit`, so concurrent calls can't overshoot (correct on SQLite *and* Postgres, multi-instance). **Tier-aware:** `daily_limit_for(user)` reads the tier from the JWT's server-set `app_metadata.tier` claim — trial→`AI_DAILY_LIMIT` (10), free→`AI_FREE_DAILY_LIMIT` (3), `pro`→`AI_PRO_DAILY_LIMIT` (20 — finalized 2026-08-10). ⚠️ Remaining = owner/launch: the RevenueCat/IAP webhook must write `app_metadata.tier="pro"` on purchase (no quota code change).
- [~] **Per-IP rate limiting (burst guard)** — per-IP sliding-window burst limits remain on save/resummarize/ask/tasks/workout (`app/ratelimit.py`) as an anti-loop guard beneath the per-user quota. ⚠️ In-memory + per-process: move the store to Redis for multiple instances (the quota itself is already DB-backed + atomic, so it's multi-instance-safe today). **Decision 2026-07-20: Redis is NOT needed yet** — `render.yaml`'s `startCommand` runs a single uvicorn worker on a single instance, so one in-memory bucket is correct. Redis becomes required only on horizontal scale (each instance would otherwise get its own bucket, multiplying the effective limit by N). Free options exist when that day comes (Upstash, Render Key Value), so this is not a cost blocker. **Test hygiene note:** `/api/ask` + `/api/ask/stream` share one process-global bucket while TestClient presents a single IP — suite-order traffic can 429 unrelated tests, so quota/gating fixtures clear `ratelimit._store`.
- [x] **Ask-your-library cost reduction** — `librarian.ask_library` now retrieves only the top-N most relevant saves (term-overlap scoring, title/tags weighted) instead of dumping up to 60 into every prompt. The per-user quota runs comfortably at 30/day (`AI_DAILY_LIMIT`). *(Next-level: embeddings-based retrieval for semantic matches.)*
- [x] **Ask-your-library streaming + latency trim** — measured the ask wait: retrieval is ~15 ms, the Claude call is the whole cost (TTFT ~1.4 s + generation ~1.9 s). Fixes: (1) `POST /api/ask/stream` streams the answer token-by-token via `librarian.stream_answer` + FastAPI `StreamingResponse` — first words at ~1.4 s instead of a ~3 s wall of silence; sources are computed from the finished answer (`sources_from_answer`, title-mention match) so no JSON envelope blocks streaming; (2) trimmed the prompt (TOP_N 15→12, per-item caps, max_tokens 500→400) — cut input ~35%, lowering TTFT and cost. Mobile uses **XMLHttpRequest** (incremental `responseText` works identically on RN native and web, unlike `fetch`), rendering tokens live with a caret. The non-streaming `/api/ask` stays for compatibility/tests.
- [x] **Claude cost cap (console)** — ✅ monthly spending limit set in the Anthropic console (owner, 2026-07-13). The only *hard* ceiling regardless of code; protects spend even with no auth. *(Was duplicated below — consolidated here.)*
- [ ] **API key protection** — once auth is added, all API routes should require a valid session token.
- [x] **Audio download guard** — `download_audio()` now sets `max_filesize=50MB` (+ 15s socket timeout) so it aborts before pulling an oversized file.
- [x] **Save-time summary charged against the quota (was the last uncapped AI path)** — the auto-summary on `/save` now calls `charge_ai_action` like every other AI action. Over budget → the card still saves instantly, marked `failed` so the detail screen offers a retry after the daily reset. Before this, saving in a loop was unbounded Claude spend (only the per-IP burst guard stood in the way).
- [x] **Thumbnail proxy hardened** — host check is now a domain-suffix match (`ytimg.com.evil.example` used to pass the old substring check → open proxy), https-only, plus a per-IP rate limit (120/min).
- [x] **Rate limiter trusts `X-Forwarded-For` blindly** — fixed: `_client_ip` now indexes from the right past `TRUSTED_PROXY_HOPS` (env, default 1 = one platform LB) instead of taking the client-controlled leftmost entry, so a caller can no longer forge a prefix to dodge the per-IP limit. `TRUSTED_PROXY_HOPS=0` (local/no proxy) never trusts XFF. Locked by `tests/test_ratelimit.py` (spoofed-prefix + distinct-real-client cases).
- [x] **Thumbnail proxy follows redirects** — fixed (`fix/pipeline-hardening`). `follow_redirects=False` + the allowlist re-applied to **every** hop (max 3), so an open redirect on any allowed CDN can no longer be chased to `169.254.169.254` or an internal address. Also added: a 5 MB body cap and a `content-type: image/*` check — the endpoint is unauthenticated at 120 req/min/IP, so an unbounded `r.content` read was a cheap OOM. Locked by `tests/test_pipeline_hardening.py::TestThumbnailRedirectGuard`. ⚠️ Slightly stricter than before: a CDN that legitimately redirects off-allowlist now 400s instead of serving; add the target host to `_THUMB_HOSTS` if that ever shows up in logs.
- [x] **Audio temp-file leak (was filling the disk on every deploy without an OpenAI key)** — `transcriber.transcribe()` returned **before** its `finally` block when `OPENAI_API_KEY` was unset, so the temp dir `download_audio()` created was never removed. Since the audio fallback fires on every reel with <50 chars of text, an unconfigured deploy — which is the current prod config — orphaned one directory per login-walled reel, forever. Fixed three ways: `download_audio()` cleans up its own failure paths, `cleanup_audio()` gives the caller an explicit handle, and `_summarize_reel` now **gates the download on `OPENAI_API_KEY`** (without it the transcribe call was a guaranteed no-op, so the download was pure waste). Locked by `TestAudioTempFileCleanup`.
- [x] **Double AI charge on the client-metadata race** — the app posts `/client-metadata` ~1s after `/save`, while the server's background extraction is still running. The `if reel.summary:` guard at the top of `_extract_and_summarize` was evaluated *before* extraction, so the non-destructive fill afterwards reset `summary_status` to `pending` and charged a second quota unit + made a second Claude call for an already-summarized reel. Fixed with a `db.refresh()` re-check immediately before the charge.
- [ ] **Cap residential-proxy spend per user (prerequisite of enabling the proxy)** — the residential proxy for transcript extraction (see "Bot-detection on datacenter IPs") is **bandwidth-priced (~$2–10/GB) with no ceiling in code**. Before turning it on: add a per-user daily cap on proxied extractions (mirror `app/quota.py` — a `charge_proxy_action`-style atomic counter, tier-aware so `pro` gets more), so a loop of YouTube saves can't run up an unbounded bill. Unlike Claude, there is no console-level hard cap to fall back on. ⚠️ **Same cap is required for Whisper the moment `OPENAI_API_KEY` is set** — `_summarize_reel`'s audio-transcription fallback (`transcriber.transcribe`, $0.006/audio-min) is currently dormant (key unset, `sync:false` in `render.yaml`) but uncapped; do not set the key without adding the cap first.
- [~] **Pre-launch security/abuse pass (scoped 2026-07-20)** — **(1) prompt-injection containment DONE (2026-07-20):** `is_sensitive` is now a **one-way latch** (`routes/reels.py`, both set-sites: model may set, never clear) — even a fully steered model reply ("sensitive": false, e.g. via a note or malicious caption) cannot lift the medical containment; summarizer prompt hardened (untrusted text fenced in `<CONTENT>` markers + data-not-instructions rule + "content's claims about its own status don't count"); locked by `tests/test_sensitive.py::TestSensitiveLatch` (steered-model mocks). **Decision (same date): notes-in-resummary KEPT, not removed** — notes are first-party input (self-harm only); the third-party injection vector is the reel caption, which is unremovable; removal would break the cooking-infer fallback, the paste-into-notes recovery path, and user-guided summary correction. The latch closes the only cross-cutting harm deterministically. Remaining: live-model adversarial evals (steering resistance can't be unit-tested), (2) `/security-review` on the branch before first deploy; (3) ZAP baseline scan against staging; (4) one load smoke (hey/locust, ~50 concurrent saves vs staging). NOT doing (deliberate): DDoS self-testing (can't meaningfully self-test, violates provider ToS — the answer is Cloudflare in front), formal pentest (revenue-stage). SQLi: ORM + bound `text()` params already cover it; ZAP confirms.

---

## Extraction Reliability & Scale

> The save pipeline is core functionality. These guard its success rate in production.

- [ ] **Bot-detection on datacenter IPs (deploy decision for YouTube/IG)** — saving a YouTube Short fails with "Sign in to confirm you're not a bot" from the Codespace; **Railway/Render/Fly are datacenter IPs too, so deploy does NOT fix this — usually worse.** Fix is architectural: a layered extraction gateway behind one swappable `ExtractorProvider` — (1) cache, (2) client-side oEmbed/OG metadata from the user's IP, (3) server yt-dlp **behind a residential/mobile proxy** (+ cookies/PO-token) for transcripts, (4) managed-API fallback (Apify / transcript API / YouTube Data API v3), (5) async + link-only-now/backfill-later. Residential proxy is the real prod fix (usage-priced — fold into per-user economics). See `docs/CONTEXT.md` §4 "Extraction & bot-detection". **Decide before deploy.** **Seam now exists (`fix/pipeline-hardening`):** `EXTRACTOR_PROXY_URL` threads a proxy through both yt-dlp and the pooled httpx client. **Unset by default and free** — no proxy argument is passed anywhere and behaviour is byte-for-byte unchanged; it costs money only once pointed at a paid service, and the per-user spend cap above is a hard prerequisite for that. Layers 1–4 free work (negative cache, per-host gating, header realism, circuit breaker) landed first deliberately, so the proxy decision can be made against real block-rate data from `/health/extract` rather than a guess.
- [x] **Visual-context metadata capture (the "read between the lines" inputs)** — the pipeline was fetching and then discarding almost everything that substitutes for watching the video. Now captured and passed to the summarizer: **VTT cue timings** (`_vtt_cue_starts` + `pacing_hint` → duration, spoken words/min, silent gaps >2.5s, cold-open detection — a 45s reel with 20 words of transcript is on-screen-text content, and that was indistinguishable from a talking head as flat text); **`og:image:alt`** (Meta auto-generates this from its own image classifier and it routinely includes OCR'd on-screen text — "May be an image of food and text that says 'CHICKEN 65'" — it was already in HTML we parsed, and was dropped); **audio track/artist** (on TikTok/IG the sound *is* the format convention); **aspect ratio** (9:16 native vs 16:9 repurposed long-form); **creator hashtags**. ⚠️ Passed in memory from the extraction that produced them — a re-summarize or a cache-hit save gets no pacing hint. Persist to a `meta` JSON column on `ReelDB` + `ExtractionCacheDB` if that quality gap shows up (marked with a `ponytail:` comment at the call site).
- [x] **Fast-fail the page fallback (bug)** — fixed: YouTube degrades via oEmbed (title/thumb) instead of regex-parsing the watch page; `_og` rewritten to scan per-`<meta>` (no catastrophic backtracking on 600 KB pages); page fetch bounded (preview UA, max_redirects=3, 8 s); `EXTRACT_TIMEOUT` cut 50→20 s. Bonus: Instagram/FB **captions** now read via the `facebookexternalhit` UA (the ungated link-preview surface).

- [x] **yt-dlp auto-update in production** — `render.yaml` build force-upgrades yt-dlp every deploy (`pip install -U --no-cache-dir yt-dlp`), and `.github/workflows/refresh-ytdlp.yml` triggers a monthly **prod** Render redeploy (cron, free) to pull the latest without a code push. ⚠️ Owner action: add the `RENDER_DEPLOY_HOOK_PROD` GitHub secret (from Render → savehere-api-prod → Settings → Deploy Hook) to arm the monthly job; until then it no-ops.
- [~] **CI-gated Render deploys (2026-07-21)** — Render `autoDeploy` is now **off** in `render.yaml`; deploys fire only from `ci.yml`'s `deploy` job **after the backend test suite passes** (staging hook on `develop`, prod hook on `main`), so a red build never ships. Gates on backend CI only — mobile type errors don't block a backend deploy (Render runs the backend). ⚠️ Owner action: add GitHub secrets `RENDER_DEPLOY_HOOK_STAGING` + `RENDER_DEPLOY_HOOK_PROD` (each service → Settings → Deploy Hook); until set, CI passes and simply skips the deploy step. Alternative considered + rejected: Render's native "wait for CI" dashboard toggle (no code, but less explicit/portable than the hook).
- [x] **Extraction self-test health check** — `GET /health/extract` reports the installed yt-dlp version; `?live=1` runs a real extraction against a known Short and returns `probe_ok` + latency. ⚠️ Still needs wiring to uptime monitoring / alerting in prod.
- [~] **Caption 429 mitigation at scale** — a single server IP gets rate-limited on YouTube's `timedtext` endpoint under load (saves still succeed via description fallback, but transcripts drop). **Partly mitigated (`fix/pipeline-hardening`):** a per-host semaphore (2 concurrent) + jitter removes the burst signature, one pooled `httpx.Client` reuses connections and keeps a cookie jar, and the `EXTRACTOR_PROXY_URL` seam is wired through both yt-dlp and httpx. Still open: the actual decision on whether to pay for a residential proxy (see "Cap residential-proxy spend per user" above — the cap is a prerequisite).
- [x] **Two bugs caught by testing a real reel (2026-08-11)** — `youtube.com/shorts/xzSp3iWtAp8`, a 118 s talking-head Short. **(1) The pacing hint asserted silence when a caption FETCH failed.** YouTube 429'd the `timedtext` endpoint, so `transcript` came back empty and `pacing_hint` told the summarizer *"no speech transcript — visual or text-overlay content"* — about a video that has caption tracks in dozens of languages and is nothing but a person talking. A false statement handed to Claude as evidence, i.e. exactly the confident wrongness the prompt exists to prevent. Fixed by passing `captions_offered` (did the platform LIST tracks) separately from whether we downloaded them; when tracks exist but the fetch failed the hint now says so and explicitly tells the model **not** to assume the video is silent. **(2) A promo-link caption spent an AI action to return nothing.** The whole caption was "📌Follow us on Instagram here:" plus three URLs — 150 chars, which clears every length bar in the pipeline — so it charged a quota unit and 2048 input tokens to come back `low_content: true`. `extractor.is_link_only()` strips URLs/@handles/#tags and applies the existing 40-char prose bar; such reels now save as link-only cards for **0 quota, 0 tokens**. Conservative on purpose: one real sentence alongside the links keeps the caption. Locked by `TestLinkOnlyCaptions` + `test_failed_caption_fetch_is_not_reported_as_silence`.
- [x] **Negative cache for failed extractions (stampede guard)** — `_is_cacheable` correctly refuses to cache text-less results, but the flip side was that a *currently blocked* URL got re-attempted by every user who saved it: one trending reel became N requests against a host already refusing us, which is how a soft rate-limit escalates to a hard IP ban. `reels._mark_failed` / `_recently_failed` remember a failure for 15 min, in-memory (losing it on restart is correct — a restart is a fine moment to retry) and deliberately never mistakable for a cache hit.
- [x] **Per-platform circuit breaker** — 5 consecutive failures opens a platform's circuit for 10 min; `extract_info` then returns a degraded link-only result immediately instead of spending 20s rediscovering the block and delaying every queued save behind it. One probe half-opens it. State is exposed on `GET /health/extract` (`breakers`), which is the alerting hook. **Snapshot ordering fixed 2026-08-11:** `breakers` was captured while building the response dict — i.e. *before* `?live=1` ran the probe and updated the counters — so a failing probe was returned next to a breaker count that hadn't registered it, which is exactly backwards when you're reading that endpoint to diagnose a live block. Now re-read after the probe. Locked by `TestHealthProbeReportsCurrentBreakerState`.
- [x] **Extraction cache eviction** — `save_reel` now prunes `extraction_cache` rows older than the 14-day TTL, throttled to once/hour and fail-open (`_prune_cache_if_due`).
- [~] **Per-platform success-rate monitoring** — log + track save success by platform; alert if YouTube success drops sharply (early warning that yt-dlp broke). **Half done:** `extractor.record_result()` now tracks consecutive failures per platform and `GET /health/extract` returns `breakers`. Still needed: point uptime monitoring at that field, and record a success *rate* rather than only a consecutive-failure count.
- [x] **Background work no longer starves the API (was the real concurrency ceiling)** — `save` used a FastAPI `BackgroundTask`, which Starlette runs via `run_in_threadpool` on anyio's **40-token** pool — the same pool every `def` route handler draws from. Each save held one of those tokens for its whole 20s+ chain *while also* occupying one of the 8 extraction workers, so ~40 concurrent saves froze **every** endpoint (list, detail, health, thumbnails) until extractions drained. Worse, `future.result(timeout=20)` only ever freed the *waiter* — the yt-dlp thread kept running, so 8 wedged extractions permanently exhausted the pool and the API never recovered without a restart. Now a single `_enqueue` dispatch submits straight to `reels._executor`, so a burst degrades save latency and nothing else. The nested `submit` inside `_extract_and_summarize` was removed too (running *on* the pool and submitting back *into* it deadlocks once it is full).
- [ ] **Process pool for hard timeouts** — a thread pool still cannot kill a truly hung extraction, and the fake 20s ceiling that pretended otherwise is now gone (see above). Real bounds today are per-operation: `socket_timeout=10` + `retries=1` in `_BASE_YDL_OPTS`, explicit httpx timeouts, and the circuit breaker. If hangs recur in prod, move extraction to a process pool so a timeout can actually terminate the worker, or add a deadline check between the yt-dlp / oEmbed / page-meta phases inside `extract_info`.

---

## Mobile — Design

- [~] **UI/UX overhaul — "Contact Sheet" (branch `design/contact-sheet`, 2026-08-01).**
  Briefed against the **Savee** iOS app (owner-supplied reference), then built from
  a different source so it shares Savee's *thesis* without copying its *execution*.
  Full reference lock sits at the top of `mobile/constants/theme.ts`.
  ⚠️ **This is the FOURTH direction in a week** (Cron Calendar restraint → Sticker
  Bomb → Golden Hour → this). The previous branch `design/loud-rebrand` was deleted
  as instructed; its 5 commits are preserved under the tag **`archive/loud-rebrand`**
  (`git show archive/loud-rebrand`). Delete the tag if you want them truly gone.
  **Why this one is different, and worth stopping on:** SaveHere's cards are
  THUMBNAILS. Every previous direction put brand colour on the surface *around*
  them, and colour-vs-thumbnail is a fight the chrome always loses. This system's
  governing rule — from Julia Krantz, "colour is entirely absent from the UI layer;
  all chromatic interest is delegated to the photography" — is the first one that
  matches what the product actually shows.
  **Research (Refero):** primary **Julia Krantz** (darkroom contact sheet: absolute
  #000, 1px ghost-line seams, 0 radius, weight-300 display type). Borrowed: **mono**
  (ghost outline control — no filled colour CTAs) and **entire studios** (small
  tracked uppercase labels as the metadata voice). Savee's own screens + its 13-step
  onboarding flow supplied the JOURNEY, not the styling.
  **Deliberate departures from Savee** (so this isn't a clone): ghost outline CTA
  instead of its filled white pill · square auth buttons and avatars instead of its
  circles · a numbered `01 / 06` rail instead of its dot pagination (whose active
  dot is also its only spot of colour) · weight 300 instead of its medium/semibold ·
  fully achromatic chrome, where Savee keeps a blue accent.
  **Done:**
  - **Token layer rewritten.** Absolute #000 / #FFF canvases — never a "near"
    value. One foreground tone, one muted, one ghost line. **Every radius is 0**
    (`radius.full` included, so ~30 pill/avatar call sites went square unedited).
    **No shadows** (`shadow.*` are empty objects). Gradients flattened to solid
    fills — `scrim` is the one exception and keeps real stops, because it makes
    overlay text legible over an unknown photograph.
  - **⚠️ `app.json`'s `userInterfaceStyle` was `"dark"`** — that forces
    `Appearance.getColorScheme()`, so light mode could never have worked on a
    device. Now `"automatic"`. Both schemes verified live in the browser.
  - **Accent themes deleted** (5 ember/iris/ocean/forest/rose swatches). An
    achromatic system has no accent to switch. Replaced by **Light / Dark /
    System**, inline in ProfilePanel — a whole route for one three-way choice was
    never worth the tap.
  - **Colour-carried meaning re-encoded, not dropped.** Priority marks (to-dos,
    home widget) are now SHAPE — solid / hollow / hairline. Disclaimer severity is
    a stated heading ("NOT MEDICAL ADVICE") plus border weight. Platform is a
    tracked wordmark, not a coloured badge. Progress meters are discrete marks
    rather than filled bars. Each of these is *more* accessible than what it
    replaced: red-vs-amber was never distinguishable to a red-green colourblind
    reader, and those are the notices that matter most.
  - **Grid is full-bleed and flush** — no page margin, no gutters; tiles share a
    1px seam, contact-sheet style. Frames are 3:4 portrait (was 16:10 landscape,
    which cropped the top and bottom off nearly every reel thumbnail stored).
  - **Two-step auth**, following Savee's flow: welcome (wordmark + auth choice over
    an empty contact sheet) → form. Apple/Google are deliberately ABSENT rather
    than present-and-dead; the row is built so they drop in when wired.
  - **Onboarding** recomposed full-bleed: title, copy, a monochrome geometric
    figure, numbered rail, pinned CTA. No skip (2026-07-20 decision preserved).
  - Retired glassmorphism layer **deleted** (Aurora/BorderBeam/Shimmer/
    ParticleField/LibraryBackdrop/GlassCard) — still mounted and still painting the
    old ember palette. New `components/kit.tsx` primitive set. Fredoka+Fraunces →
    **Space Grotesk + DM Sans**. Icon strokes thinned 2.4/2/1.75 → 1.6/1.35/1.1.
  - **Press feedback is opacity, not scale.** `Pressable`'s `scaleTo` is now a
    no-op prop kept for ~30 call sites; a contact sheet whose tiles bounce is a
    contradiction, and at 0 radius a scaling rectangle reads as a glitch.
  - **Bug found and fixed while verifying:** `_layout.tsx` gave `<StatusBar>` and
    the gate's child the same `key={schemeEpoch}`. Sibling keys share a namespace,
    so both were `"0"` — React warned about duplicate children on every render and
    can legally *drop* one. Keys are prefixed now.
  ⚠️ **Contrast note:** the reference's own `#707070` muted tone measures **4.24:1**
  on black and fails AA at the 10px label sizes this system leans on. Both ash
  values were walked until they pass (`#787878` = 4.8:1 dark, `#6E6E6E` = 5.1:1
  light). Preserving an accessibility bug is not preserving a signature trait.
  **Remaining — screens that inherit the tokens but were NOT recomposed:**
  `reel/[id]` and `todos` got targeted passes (whites that would have gone
  invisible on the now-white filled controls, priority marks, hero chips, display
  type) but keep their card-based layout rather than the ruled-row grammar.
  `workout/[reelId]` and `workout/session/[reelId]` are token-inherited only.
  ⚠️ **Owner visual pass required** — the agent's preview browser has no session,
  so only the login/welcome flow and the token layer were verified live. Verified:
  typecheck clean, `expo export --platform web` clean, both schemes paint
  correctly, no console errors.

- [x] **Round two — owner review (2026-08-01).** Six items, all shipped.
  1. **Typeface → Inter, one family.** Space Grotesk + DM Sans at weight 300 were
     dropped for a single neutral Helvetica-class grotesque at 400/500/600, to
     match the brief's reference app. Tracking loosened -0.04em → **-0.025em** at
     display sizes: tight negative tracking exists to stop LIGHT letterforms
     drifting apart, and applied to semibold it jams the counters shut. Four font
     packages uninstalled (space-grotesk, dm-sans, fraunces, manrope) — Inter is
     the only one left.
  2. **⚠️ `<button> cannot contain a nested <button>` — MY BUG, fixed.** Round one
     added `accessibilityRole = 'button'` as a *default* on `components/Pressable`.
     react-native-web renders that as a literal `<button>`, and this component is
     nested inside itself all over the app (a tappable row that also holds
     edit/delete controls — TaskList, TodoEditor, the reel detail hero). Invalid
     HTML, and the inner control stops receiving clicks. The role is now
     undefined by default (RN-web emits a `<div>` with correct ARIA, which nests
     legally) and passed **explicitly** on leaf controls only — `GhostButton`,
     `FilledButton`, the welcome auth button — so screen-reader semantics survive.
     Verified in the DOM: 1 button, 0 nested pairs.
  3. **Category filter → round icon bubbles** with the name beneath, mirroring the
     reference's avatar row. `radius.circle` is added to the token layer as **the
     one sanctioned circle in the system** — grep before reusing it; everything
     else is still 0. Selection inverts (filled bubble, canvas-coloured icon)
     rather than tinting, since there is no accent hue to tint with.
  4. **Library is a staggered masonry**, not aligned rows. Each tile goes to
     whichever column is currently shortest; running height is tracked in
     width-units so columns finish level without measuring anything on screen.
     Tile aspect comes from `aspectFor()` — seeded by **platform** (YouTube and
     LinkedIn serve landscape thumbnails, Instagram and TikTok vertical) plus a
     hash of the reel id, so it is real signal, deterministic, and never reflows
     on image load. ⚠️ **This traded FlatList virtualization for a ScrollView** —
     masonry and row-virtualization are incompatible without measuring every
     tile. Fine for tens-to-hundreds of saves; at a few thousand the fix is a
     windowed masonry, not a smaller diff. `onEndReached` is reimplemented by hand
     on `onScroll`.
  5. **Login backdrop is a live collage of the user's own saves.** New
     `services/thumbCache.ts` persists up to 12 recent thumbnail URLs; the
     signed-out welcome screen renders them as three tilted columns that **drift
     continuously in alternating directions** (odd rise, even fall) at three
     different speeds. First-ever launch has nothing cached and correctly falls
     back to the numbered empty sheet.
     **Why the user's own thumbnails and not stock imagery:** bundled stock is
     someone else's work plus a licence to track; hotlinking is someone else's
     bandwidth and copyright. Their own saves cost nothing, need no licence, and
     are better product — the reference app shows you strangers' content, this
     shows you what you came back for. `clearThumbs()` runs on account deletion.
     ⚠️ **Asked for as a GIF; built in code instead.** No image/video generation
     tool is available in this environment, and a GIF would have been a
     fixed-size, block-compressed asset of someone else's content shipping in
     every bundle forever. The coded version weighs nothing, stays sharp at any
     density, and adapts to the user's library.
     ⚠️ **Respects `AccessibilityInfo.isReduceMotionEnabled()`** — continuous
     unstoppable background motion is exactly what that setting exists for, and a
     sign-in screen is not the place to overrule it.
     ⚠️ Second bug caught here: the first attempt made all three columns drift the
     SAME way. `Animated.add(...).interpolate(...)` was over-clever; replaced with
     a plain from/to swap per direction. Verified in the browser: UP / DOWN / UP.
  6. **No blur on the collage** (the reference blurs its own). `expo-blur` is a
     native module and this project has no dev build yet — the tilt plus a heavy
     scrim carries the same "atmosphere, not content" read. Revisit once a native
     build exists.
  ⚠️ The scrim is the **canvas colour**, not black — it dims the wall in dark
  mode and lightens it in light mode, so the wordmark on top stays legible in
  both. A fixed black scrim would leave black-on-black text in light mode.

- [x] **Round three — welcome screen, no photography (2026-08-01).**
  1. **⚠️ ALL BITMAPS REMOVED FROM THE LOGIN SCREEN.** Owner raised the copyright
     question on the thumbnail collage. The honest resolution is not to reason
     about which images are safe — it is to have none. The tiles are now **mock
     reel cards drawn entirely from Views**: a "REEL" label, a `•••` glyph, a
     tonal well with an outlined play mark, a part-played scrubber, and an action
     row. Nothing depicts anything, so there is no licence to track and no asset
     to ship. Verified in the DOM: **0 `<img>` elements on the screen.**
     *(For the record: the cached thumbnails were never the real exposure —
     showing a user their own saves is what every other screen does. Bundled or
     hotlinked stock would have been, and that was already avoided. Synthetic is
     simply strictly safer AND a smaller diff.)*
     `services/thumbCache.ts` and all its wiring are **deleted** — it existed only
     for this screen.
  2. **The action glyph is a BOOKMARK, not a heart.** This is a saving app; save
     is the verb it cares about. Small detail, but it is the one thing on the mock
     card that says whose product it is.
  3. **Bottom ramp added.** A `LinearGradient` to solid canvas over the lower 58%,
     on top of the flat wash — the controls and legal text live down there and
     were competing with moving tiles. Measured: solid canvas behind the auth row.
  4. **Apple + Google buttons added as MOCKS.** Round one left them out on the
     grounds that a dead button is worse than no button; the owner asked for them,
     so they exist and **say so when tapped** rather than failing silently. Email
     is the one that works and carries the system's inversion (filled) to show it.
     ⚠️ Still blocked on the same two things: the $99 Apple developer account, and
     Apple guideline 4.8 — offering Google *requires* Sign in with Apple, so they
     ship together or not at all.
  5. **Scene compositions in the mock reels** (`components/MockReel.tsx`).
     Asked for as "AI-created reel content"; **no image-generation tool exists in
     this environment**, so photographic frames could not be authored. The honest
     alternative is procedural: six composition kinds — portrait, horizon,
     top-down, product, skyline, title — built from Views and gradients in the
     palette's own tones. At tile size, behind a scrim and drifting, they read as
     a wall of monochrome stills rather than a grid of grey rectangles, and the
     zero-bitmap property from item 1 is preserved exactly.
     **If real photography is ever wanted, the ONLY safe route is licensed assets
     the owner supplies** — a paid stock licence that permits app embedding, or
     shot in-house. Wiring them in is small: give `Scene` an image branch and drop
     files in `assets/`. Do not swap in scraped or hotlinked images.

  **Logged-in screens finally verified (2026-08-02).** A real staging session was
  present in the preview browser, so the screens that had been unverifiable since
  round one were checked live against a 63-save library:
  - Category bubbles render circular (`border-radius: 999px`, 15 of them).
  - **Masonry confirmed staggered**, not aligned rows — measured tile offsets of
    391/451/764 in one column against 551/923/1379 in the next.
  - Paywall page 01 renders, and the **`SAVE 20%` badge appears in USD** (where
    $2/wk = $8.70/mo against $7 is a genuine 20%). The same function returns null
    for the INR pair, so the badge cannot render there — the guard works.
  ⚠️ Still unverified: paywall page 02, reel detail, todos, workout screens.

- [x] **Round five — grid fidelity, floating tabs, pinned CTAs (2026-08-02).**
  1. **⚠️ THE BLACK BARS WERE A BUG, NOT A CROP SETTING.** YouTube's
     `hqdefault.jpg` / `hq2.jpg` are ALWAYS 480×360 (4:3) with pillarbox bars
     **baked into the JPEG** for vertical Shorts — pixels in the file, so no
     `resizeMode` removes them. Worse, `aspectFor` was handing YouTube/LinkedIn
     *landscape* wells, which framed the bars instead of cutting them AND put two
     tile shapes in one grid — the "not consistent" complaint.
     Fixed properly at the source: `thumbCandidates()` in `services/api.ts` asks
     for **`oardefault.jpg`** first, which serves the real 1080×1920 frame with no
     bars (measured live: hqdefault → 480×360, oardefault → 1080×1920). It does
     not exist for every video, so ReelCard walks the candidate list on `onError`
     and falls back to the stored URL. All tile ratios are now portrait.
  2. **The tile IS the image.** The caption block underneath was eating ~40% of
     every tile and turned the wall into a column of black panels. Title and
     category now ride a scrim over the bottom of the picture; 2px gutters
     replace the flush seam, since images running edge to edge with no gap read
     as one continuous smear.
  3. **Floating 5-tab bar** (`components/TabBar.tsx`): Home · Library · **Save**
     (centre, inverted) · Slate · Ask. Rendered ONCE at the root, above the
     router, so it cannot drift between routes. Hidden on `/save`, `/pro` and the
     workout session player — focused tasks with their own primary button, where
     a floating nav would compete and a mis-tap would lose a pasted link.
  4. **Hamburger on every page**, and only one profile panel. `HeaderHomeButton`
     → `HeaderMenuButton` (Home is a tab now, so a header Home button was a
     second way to do one thing). The panel moved to the root and is opened from
     any screen through a 30-line `services/uiBus.ts` — previously **three**
     screens each rendered their own copy with their own state.
     The library header lost home/save/menu buttons and its bottom-docked search
     (the tab bar owns that space; the two stacked left ~120px of permanent
     chrome over the grid). Search moved up under the wordmark.
  5. **CTAs pinned on `/save` and `/pro`.** "Good to know" is eight paragraphs,
     so the Save button sat below the fold — you had to scroll past the small
     print to save anything. On the paywall, five benefit paragraphs sat above
     the price, so **you could not see what it cost without scrolling through the
     sales pitch**. Both now dock: the copy scrolls, the price and the button do
     not move.
  6. **iPhone 16 Pro (393×852)** — verified no horizontal overflow, 2-column grid.
  ⚠️ **Verified this round:** typecheck, `expo export` (all routes), login screen
  at 393×852, zero console errors. **NOT verified — needs an owner pass:** the tab
  bar, the pinned CTAs and the rebuilt tile all require a signed-in session, and
  the preview browser lost its staging token when the dev server restarted.

- [x] **Round six — matching the reference more literally (2026-08-02).**
  1. **Tab bar is a PILL**, icon-only, hugging its contents rather than spanning
     the width. Active state is a filled disc behind the glyph — the system's
     inversion, just round. Labels removed; the fill is a translucent wash
     (`colors.tabBar`, new token) so content stays faintly visible through it,
     which is what makes it read as floating rather than welded to the edge.
  2. **⚠️ THE TILE NOW CARRIES NO TEXT AT ALL.** Third pass on this: caption
     block → scrim overlay → bare picture. Each layer of metadata was the thing
     making a wall of images read as a list of panels. Title, category, platform
     and index are all gone from the grid; they live one tap away on the detail
     screen, which has room for them. The only exception is a still-processing
     save, which has no picture yet and would otherwise be an unexplained grey
     rectangle.
     ⚠️ **The visible × went with them, so delete moved to LONG-PRESS** (plus the
     existing delete on the detail screen). Removing the affordance outright
     would have been a silent functional loss; `Pressable` gained `onLongPress`
     for it. If a visible control is wanted back on the grid, that is a one-line
     revert — but it will cost the clean wall again.
  3. **Auth buttons are round** (`radius.circle`, 68px). They were square on the
     argument that the system is 0-radius everywhere.
  ⚠️ `radius.circle` now has a **closed list of three sanctioned uses** — category
  bubbles, the tab bar, the auth buttons — documented at the token. Everything
  else is still 0, absolutely. Add to that list if you extend it; do not just
  reach for it.
  **Verified:** typecheck, `expo export`, auth buttons measured at 999px/68px on
  a 393×852 viewport. **Still needs an owner pass:** tab bar and library grid,
  both of which require a signed-in session.

---

## Mobile — Monetization

- [~] **Pro paywall — two pages, UI only (2026-08-01).** `app/pro.tsx`: page 01
  lists what Pro unlocks (grounded in gates that exist in the code today) plus the
  plan picker; page 02 is the order summary and card form.
  ⚠️ **PAGE 02 IS A MOCK.** No payment provider is wired up — "Pay" waits a beat
  and reports that nothing was charged. A loud TEST-MODE banner sits above the
  form and **must not be removed before real billing lands**: a payment form that
  looks real and does nothing is how someone types a real card number into a dead
  field. Real billing is StoreKit/Play Billing via RevenueCat (Apple takes its cut
  on digital goods; a raw card form would fail review anyway), whose webhook writes
  `app_metadata.tier = "pro"` — the value `app/quota.py::daily_limit_for` already
  reads, so no quota code changes.
  ✅ **PRICES SET 2026-08-10 (owner):** ₹25/week, ₹120→₹99/month; $1.99/week,
  $7/month — paired with Pro = 20 AI/day, ₹99 being a 6-month Apple Introductory
  Offer that reverts to ₹120. The INR pair used to be **upside down**
  (₹20/week = ₹86.96/month, so the ₹99 monthly was the WORSE deal and
  `savingPct()` correctly refused to render a badge). At ₹25 the monthly saves
  ~9%, USD ~19%, so both storefronts now show a truthful badge. `savingPct()`
  still computes from the real prices and returns null when there is no saving —
  the UI **physically cannot** render a false "SAVE X%". Keep it that way.
  ⚠️ **The cost study is overridden, not satisfied** (2026-07-24, see "Pricing &
  Monetization"): it put break-even at ~4.2% conversion and recommended ₹149/mo,
  calling ₹99 "underwater". Owner chose volume. Concretely: 20/day at
  ~$0.004/action is ~$2.43/mo worst case — $7 nets $5.95 after Apple's 15% and
  clears it; ₹99 nets ~$0.96 and does not (~2.5x). Accepted as a bounded per-user
  loss, cross-subsidised from US margin.
  **Watch item before renewing past 6 months:** the real p50/p95 of
  `ai_usage.count` for INR Pro users.
  **Remaining:** RevenueCat + StoreKit/Play Billing integration; real restore-
  purchases; server-side receipt validation; the tier webhook.

---

## Mobile — Features

- [ ] **Share Extension (iOS)** — same as blocker above; listed here for implementation tracking.
- [x] **To-do list — the retention surface (2026-07-30)** — a cross-reel list of what the
  user actually meant to do, the thing a bookmarking app needs so saves don't rot unseen.
  **Backend:** new `todos` table + `/api/todos` CRUD + `POST /api/reels/{id}/todo`
  (`app/routes/todos.py`, 17 tests in `tests/test_todos.py`). **Zero AI, zero quota** —
  it's the user's own text, so it adds retention without adding COGS. **Mobile:** dedicated
  `app/todos.tsx` (Overdue / Today / Upcoming / Someday), a reusable `TodoEditor` modal used
  by both entry points, an "Add to to-do list" card on the reel detail screen, and a
  Today/Upcoming preview on the home screen that collapses to one quiet row when nothing is
  due (it never fakes urgency).
  **Three decisions worth not relearning:**
  1. **Not `TaskDB`.** Those rows are recipe steps: `reel_id` is `NOT NULL`, ownership is a
     join to the parent reel, and `routes/workout.py` deletes them wholesale on regeneration
     — todos in that table would appear inside recipe checklists AND get silently wiped.
  2. **Deleting a reel does NOT delete its todo** (`ondelete SET NULL` + an explicit unlink in
     `delete_reel`, since SQLite needs `PRAGMA foreign_keys`). Title/description are *copied*
     at add time, so the todo still reads correctly afterwards. Todos are also swept on
     account deletion — they're owned by `user_id`, so the reel sweep alone would orphan them.
  3. **Due date is OPTIONAL** (owner proposed mandatory). Forcing a date on "I want to try
     this sometime" makes users either abandon the add-flow or type a junk date — and junk
     dates poison the home-screen widget, which is the entire point. Undated items land in
     "Someday" and the widget falls back to a quiet row. One-line change in
     `routes/models/todo.py` if this proves wrong.
  ⚠️ **Not verifiable by the agent:** the logged-in screens need a real session, which the
  preview browser doesn't have. Backend is covered by tests; typecheck + web export pass;
  the date/bucket logic was proven with assertions. **Owner: do a visual pass.**
- [x] **To-do polish → shipped as "Follow Through" (2026-07-30)** — owner round two:
  1. **Named.** `mobile/constants/todoBrand.ts` holds the name, the button labels and the
     quote list. Renaming is ONE edit — nothing hardcodes it. ("Follow Through" names the
     thing users actually fail at; alternates listed in the file.)
  2. **No back-dated tasks.** The calendar disables past days (real enforcement, device
     clock); the server refuses them as a backstop. ⚠️ The server allows **one day of
     slack on purpose** — a user in Honolulu setting "today" sends what is already
     yesterday in UTC, and a strict check would reject every negative-offset timezone.
     Validation also only runs when the date *changes*, or renaming a task that had merely
     slipped past its date would be impossible.
  3. **One open task per save.** `GET /api/reels/{id}/todo` drives a deactivated button on
     the reel screen; completing the task re-enables it (refetched on focus, so completing
     it on the list screen frees the button when you navigate back). Completing a linked
     task now asks **"keep the save or delete it?"** — the previously-declined prompt, built
     as asked. Keep is the primary action and the only thing a stray tap reaches; the
     delete button names what is lost (summary, notes, steps, workout — irreversible).
     The task itself survives either choice.
  4. **Dashboard.** Open / Done / Overdue tiles (Open+Done from server stats, Overdue
     computed locally so it can't disagree with the sections below it) plus rolling
     quotes — reusing `RollingTagline` with a new `lines` prop rather than a second roller.
  5. **Calendar picker.** `components/DatePicker.tsx`, dependency-free. Deliberately NOT
     `@react-native-community/datetimepicker`: another native dep that can't render in the
     web dev loop and looks different per platform. Grid math verified across 84 months
     incl. leap years and the 2100 non-leap trap.
- [x] **To-do round three: goals, settings, side-by-side home block (2026-07-31)**
  1. **Naming split.** The home screen says one steady thing — **"Things on your slate"**;
     the list screen's own hero *rolls* through "My Docket 📜 / My Almanac 🌙 / …"
     (`TODO_ROLL_NAMES`). A rolling name on the home screen would just be noise beside the
     user's actual saves. The nav header on that screen is deliberately blank — the rolling
     hero IS the title.
  2. **Home block is now two columns**, Today | Upcoming. **Overdue folds into Today**
     rather than taking a third column: it *is* today's work, just late, and three columns
     don't survive a narrow phone. Each column is `flex:1` + `minWidth:0` so a long title
     truncates inside its own column instead of shoving the other off the card.
  3. **Completion animation** — the tick springs in, a ring bursts outward, the row eases
     back to 62% opacity but stays readable so tapping again to undo is obvious.
  4. **Daily goal** (default 5, settable 0/3/5/8/10, 0 = off) with a progress bar on both
     surfaces. ⚠️ **The reset is structural, not scheduled:** the new `todos.completed_on`
     column stores the DEVICE's calendar day, so "today" rolls over at the user's own
     midnight. There is no cron to run and nothing that can get stuck showing yesterday's
     number. `completed_at` (UTC) is kept for ordering/audit but is NOT what the goal counts
     — a task finished at 9 p.m. in Los Angeles is stamped the *next* UTC day.
     `stats.completed_today` is `null`, never `0`, when the client didn't say what day it is.
  5. **Settings sheet** (gear on the list screen): daily goal, show-on-home, default
     priority, keep-completed-visible, Someday-first, and **a switch for the
     "delete the saved card?" prompt** — it's the kind of ask that gets old fast.
     Device-local (`services/todoSettings.ts`), not server-side: these are display choices,
     and a round-trip before first paint isn't worth it. Move to `profiles` if sync is asked
     for. ⚠️ Bug caught by its own check: `Number(null)` is `0` in JS, and `0` is meaningful
     here ("goal off") — so a corrupt stored value used to silently switch the goal off
     instead of falling back to the default. Now only real numbers/numeric strings count.
- [x] **To-do UX fixes (2026-07-31)** — four owner reports, all root-caused:
  1. **Home button went to the library, not home.** Not a to-do bug — `goHome()` was
     missing `clearEnteredLibrary()`. The `/` route renders EITHER the landing page or the
     library depending on that session flag, so once you'd opened the library the house
     icon dropped you back there for the rest of the session, from *every* screen.
     `sessionFlags.ts` had documented "Going Home must clear this" all along; the call was
     simply never made. Fixed in `HomeButton.tsx`, so it's fixed app-wide.
  2. **"Done — nice one." was slow.** It was rendered *after* `await api.updateTodo(...)`,
     so a cold Render instance left the user staring at a ticked box for seconds. Now shown
     immediately and dismissed if the update fails. Safe to be optimistic: the prompt only
     *offers* a deletion, which is its own separately confirmed action.
  3. **"My" is now fixed**, with only the name + emoji rolling. Stacked (small "MY" label
     above, big rolling name below) rather than inline — "My Program of Entertainment 🎪"
     on one line does not fit a narrow phone, and truncating a name mid-word looks broken.
  4. **Hamburger added** to the list screen. `ProfilePanel`'s `reels` prop is only a
     fallback for counters it otherwise reads from `/api/account/usage`, so this screen
     passes `[]` and fetches just the reel `total` lazily when the panel opens.
- [x] **To-do hero + nav layout (2026-07-31)** — **"MY"** is now large and **accent-coloured**
  (so it tracks the active Appearance theme — it lives in the `themed()` sheet, which is
  what makes accent switching repaint it), with the rolling name inline beside it. The
  rolling half sits one notch smaller (22 vs 28): inline means it only gets the row minus
  "MY", and the longest entries would ellipsize at 28 on a narrow phone. **Home + Library**
  share one pill with a hairline between them, above the hero; the stack's global Home
  button is suppressed on this screen so there aren't two. **Settings moved bottom-right**,
  beside "New task", and spins a full turn on press — press-triggered rather than
  perpetually spinning, because constant motion beside a list you're reading is a
  distraction. ⚠️ `openLibrary` must call `markEnteredLibrary()` before navigating: `/`
  renders the landing page OR the library off that flag, so without it the Library button
  would land on the greeting.
- [x] **To-do header consistency + undo-delete (2026-07-31)**
  1. **"My"** — big accent `M`, smaller `y`, as one nested `<Text>` so the two sizes share a
     baseline automatically instead of being nudged into line by hand.
  2. **Header now reuses the Library screen's trio** (`app/index.tsx`): two hairline circles
     around one gradient circle. The centre slot holds that screen's primary destination —
     Library uses "+" for Save, this one uses the bookmark mark. ⚠️ These styles are
     duplicated, not shared: **keep `headerActions`/`menuBtn`/`saveBtn` in sync with
     `app/index.tsx`**, or the two pages drift apart again.
  3. **Undo on delete (2 s)** — bar rises from behind the New task button, accent-tinted.
     ⚠️ The `DELETE` is **deferred, not sent-and-undone**: undo cancels a timer, so the task
     keeps its id, `created_at` and `completed_on`. Re-creating would mint a new row and
     silently rewrite that history. Leaving the screen commits any pending delete
     immediately (unmount effect), and a refresh landing inside the window filters the
     pending id out so the row can't resurrect itself. Undo re-inserts optimistically, then
     re-fetches so the server stays the single authority on ordering.
- [x] **Rolling names are random, not sequential (2026-07-31)** — `RollingTagline` gained an
  opt-in `shuffle` prop (on for the to-do hero and its quotes; the landing/login taglines
  keep their existing order). Uses a **shuffle bag**, not `Math.random()` per tick: picking
  independently would repeat lines back-to-back and starve others for ages, which reads as
  broken rather than random. Each pass deals a fresh permutation, so every name shows once
  per cycle in a different order, and a new deal never opens on the line the last one closed
  with. Verified with assertions over 500 deals + simulated refills (permutation, no
  back-to-back repeats across bag boundaries, varied order, even exposure, and n=1/n=2
  don't hang).
- [ ] **To-do reminders** — a local notification the evening before / morning of a due date.
  Free in money (`expo-notifications`, no push server), but needs the **custom dev build**
  (doesn't work in Expo Go, and web needs the Notification API + a permission prompt), so it
  can't be tested in the current web loop. `due_date` is already stored; this is additive.
- [ ] **Archive as a softer alternative to delete-on-completion** — the delete prompt IS
  now built (owner reaffirmed it; see "To-do polish" above), with Keep as the primary
  action and an explicit warning naming what is lost. The concern that prompted the
  original pushback still stands though: deletion cascades and there is no trash. An
  `archived` flag on `ReelDB` would let "clear it out of my library" mean *hide*, not
  *destroy*, and would be the better default for that button. Worth doing if any user
  ever reports deleting a save they wanted back.
- [ ] **Activity grid + streak (the habit surface)** — `todos.completed_at` is already
  written and cleared on undo specifically to feed this. A GitHub-style grid where a square
  lights when the user **completed something from their library** (and optionally saved).
  ⚠️ Do **not** track "opened the app": a self-referential streak measures nothing, and when
  it breaks it removes the only reason to open. Counting *saves* alone would also pay users
  in AI spend to save junk — see the free auto-summary economics above.
- [x] **Library auto-refresh while summarizing** — the home grid polls every 4s while any card is `pending` so background summaries appear without a manual reload (pull-to-refresh also available).
- [ ] **Deep linking** — when Share Extension saves a reel, open the detail screen directly (`savehere://reel/{id}`).
- [ ] **First-run coach-marks (3 features)** — after the existing new-user pop-ups, spotlight in sequence: how to add a reel, the Library button, Ask-my-Library. Reuse the account-age <15 min gate from the onboarding tour so existing accounts never see it.
- [ ] **Ask-my-Library unlocks at 5 saves (decided 2026-07-20 — saves, not logins)** — gate Ask until the library holds ≥5 saves: an ask over a near-empty library wastes an AI action and gives a weak first answer. Login-count was rejected (mobile sessions persist for weeks — "logins" are rare, arbitrary events). Client shows a locked state with progress ("Save 3 more to unlock Ask"); server already exposes the total (`/api/reels` `total`). UX gate, not a security gate — client-side is acceptable (bypassing it only wastes the user's own quota).
- [~] **"Trip Itinerary" for travel reels (Pro-only — decided 2026-07-20)** — **backend DONE (2026-07-20):** `POST/GET /api/reels/{id}/itinerary` (`routes/workout.py`) + `extract_itinerary` (`services/workout_extractor.py`, Haiku) + `itinerary` JSON column & `itinerary_count` cap (3, like workouts) on `ReelDB`. Gate order: ownership → sensitive → `category=="travel"` (422 otherwise) → Pro gate (403) → cap (429) → content check → `charge_ai_action` → Claude. Model reply defensively normalized (size caps, junk dropped) before storing; a failed regeneration never destroys an existing plan. Locked by `tests/test_itinerary.py` (10 cases).
  **⚠️ Grounding rule REVERSED 2026-08-11 (owner decision) — this is the app's one non-grounded AI surface.** The original design was extracted-only (places/prices/timings from the reel; day grouping inferrable and flagged `structure_estimated`). In practice that produced unusable plans: a title-only "10 Days in Japan — Tokyo, Kyoto, Osaka" reel yielded *"Explore Tokyo / Explore Kyoto / Explore Osaka"* for ten days, because the ANTI-PADDING rule — whose literal example was "Explore Kyoto" — forbade adding anything the reel had not named. The prompt now treats the reel as a starting point and fills the plan from Claude's own knowledge of the destination (verified: the same title-only input now yields Senso-ji, Fushimi Inari, Arashiyama, Dotonbori, a JR Pass tip and geographically-sequenced days). Reel content still takes priority and must appear. **The residual guard is accuracy, not provenance:** prices, opening hours, admission fees and booking rules must never be asserted, since a wrong one sends someone to a closed door. `structure_estimated` still flags an AI-organised grouping. Carve-out is documented in CLAUDE.md quality bar #5 and does **not** extend to summaries/recipes/tasks/workouts.
  **UI copy corrected 2026-08-11 (same change made three strings false):** the button hint said *"Built only from what the reel mentions — nothing is invented"*, the estimated-structure notice said *"The places themselves come only from the reel"*, and the tips heading said *"Tips from the reel"*. All three were true under the old grounded-only prompt and lies under the new one. Now: the hint explains the reel-plus-known-highlights split and points out prices/hours are never guessed, the notice says gaps were filled from general knowledge, and the heading is just "Tips".
  **Token budget:** `max_tokens` 1400 → 4000, and `stop_reason == "max_tokens"` now raises instead of being parsed into an empty plan — the old path returned a 422 blaming the user's reel for our own cap, *after* charging their AI action. Per-day items capped at 6 in the prompt (normalizer still permits 10) so a 14-day plan stays inside the budget. ⚠️ Cost per itinerary rises roughly 2-3x (still ~$0.01-0.015 at Haiku rates); it is Pro-gated and capped at 3 per reel. **Remaining = mobile:** "Trip Itinerary" button on travel detail screens rendering `days[]`/`tips[]`, with the Pro-locked upsell state for free tier.
- [x] **Pagination / infinite scroll** — `/api/reels` takes `limit`/`offset` + returns full `total`; library grid loads 24/page via FlatList `onEndReached`. Counts (header, Landing, ProfilePanel) use `total`.
- [n/a] ~~**Server-side search**~~ — shipped, then **DELETED 2026-08-10** (owner), and
  **not** revived when search came back on 2026-08-14. Still the right call: the
  reason it had no reachable caller is gone, but the reason to keep it off the server
  never was — see below.
- [x] **Smart search (no AI cost) — BACK 2026-08-14, on the client this time.**
  `mobile/services/librarySearch.ts` is a TypeScript port of the deleted
  `backend/app/services/search.py` (commit `090a51a`): same stopwords, same synonym
  groups, same weights, because those were tuned against real failures and rewriting
  them from scratch would have reintroduced bugs someone already paid for. It
  tokenizes the query and drops filler ("any videos on Fitness" → "fitness"), matches
  **category** (the root cause of "Fitness finds nothing but chestwork works"),
  expands synonyms (gym/workout ↔ fitness, recipe ↔ cooking), forgives one typo, and
  ranks by relevance.
  **What changed is WHERE it runs, and why:** search fires per keystroke, and the
  server it would call is a Render free instance that cold-starts in ~50 s. The
  library is fetched once (`services/libraryIndex.ts`, through the existing list
  endpoint at its own 1000 cap — no new route) and **tokenized once**; a query is then
  a synchronous scan with no debounce, no request and no AI action, and it keeps
  working offline. The old "never Claude-backed" constraint still holds and is now
  structural rather than a rule to remember.
  ⚠️ Two porting notes worth keeping: the Python leaned on `difflib`'s 0.8 ratio,
  which catches **transpositions** — plain Levenshtein ≤1 does not, so "wrokout" would
  have silently stopped finding "workout"; the replacement handles adjacent swaps
  explicitly. And typo-matching is off for the summary/notes field: ~40 tokens per
  reel against a title's ~8 is where a linear scan would stop being instant.
  Locked by `npm run test:search`, including a 2,000-reel scale assertion.
  Embeddings remain the semantic upgrade path; an inverted index is the step before
  that, and neither is needed at this scale.
- [x] **Tap-to-watch + link-open (web false-alert fixed)** — the detail-screen hero thumbnail (with a "Watch" chip) and the source-URL row open the original post via `mobile/services/openLink.ts`. **Root cause found + fixed (verified with a real click in-browser):** react-native-web's `Pressable` dispatches `onPress` asynchronously, so the user-activation gesture is gone by the time `window.open()` runs — it returns `null` for a genuinely-real click, and the old `if (!win) throw` fired a false "couldn't open this link" alert on every working tap (which auto-dismissed when the new tab stole focus). Web now uses an **anchor-element click** (`<a target=_blank rel=noopener>`), which opens reliably and hands back no null to misread; no cross-origin `win.opener=null` (throws in some browsers). Trade-off: web can't detect a genuinely-blocked open, but a false popup on every success was the real bug, and true failures (deleted/private post) open a tab showing the platform's own error — undetectable client-side anyway. **Native keeps the honest failure popup** (`canOpenURL` is a real signal there).
- [x] **Workout expectation modal** — before the FIRST "Build Workout", a modal sets expectations: generic template inspired by the reel, not personalized coaching; beginners scale down at their own pace; every set/rep/rest editable afterwards. Includes the fitness disclaimer chip.
- [x] **Modal ghost-click fix (web)** — the workout/category modals used a close-on-press overlay with a plain View card: on web a double-click's second click (or any click on the card body) bubbled to the overlay and closed the modal instantly. Fixed in `reel/[id].tsx`: card presses `stopPropagation`, overlay presses within 350 ms of opening are ignored; deliberate outside-clicks still close (verified live with scripted clicks).
- [x] **Onboarding tour only for NEW accounts** — the tour used to replay for an existing account on any new device/browser origin (per-device storage looked like a first login). Now gated on Supabase `user.created_at` < 15 min (i.e. right after sign-up); older accounts get the seen-flag stamped silently. Trade-off: a new user who first opens the app days after signing up skips the tour.
- [x] **Onboarding: Skip removed (2026-07-20)** — first-run tour must be seen in full; the only exit is stepping through to "Get Started". Still shown once per fresh account only (account-age gate unchanged), so it can't nag returning users.
- [x] **"beauty" category** — makeup/skincare/haircare/grooming get their own category (backend `ALLOWED_CATEGORIES`, summarizer prompt with definitions, mobile chips/modal with Brush icon, search synonyms). Adventure/trip content (trekking, biking, itineraries, destinations) is steered into **travel** via prompt hints + search synonyms instead of a new category.
- [x] **"Turn into Action" hidden for non-actionable saves** — entertainment, **motivation** and **news** (both added 2026-07-20 — motivation reliably produced generic filler like "Believe in yourself" / "Wake up early", and news is reporting with nothing for the reader to *do*; inventing steps from a headline is exactly the ungrounded output to avoid — either way an AI action spent for no value) and unknown-category (`other`/unset) reels no longer show the action section (fitness/sensitive rules unchanged). Client-side only by design: recategorizing a reel (e.g. a DIY save stuck in "other" → tech) re-enables it; already-generated task lists stay visible. Categories with their OWN specialised generator are excluded here too — fitness → Build Workout, travel → Trip Itinerary — so a card never shows two overlapping AI buttons (two charges for near-duplicate output).
- [x] **Statutory disclaimers for health & finance saves (2026-07-20)** — two new `Disclaimer` variants (`components/Disclaimer.tsx`): `health` ("general information only, not medical advice… consult a professional") and `finance` (explicit: "not financial, investment, tax or legal advice… SaveHere is not a licensed adviser… markets carry risk and you can lose money"). Shown on the summary card for `category==health`/`finance`, and repeated on the generated task list (the riskiest surface — where content becomes a checklist someone follows). Precedence: the AI-flagged **`medical`** notice (which also disables action plans, enforced server-side) always wins so two notices never stack. Note: `health` here is the NON-flagged case — genuinely high-stakes medical content is caught by `is_sensitive` and gets the stronger `medical` treatment. Mirrors the existing `fitness`/`recipe` disclaimer pattern.
- [x] **Appearance: accent themes — now LIVE switching (web + native)** — ProfilePanel → Appearance offers 5 accent palettes (Ember default, Iris, Ocean, Forest, Rose; `accentThemes` in `constants/theme.ts`). v1 applied via full page reload (multi-second on the dev server — owner flagged it as janky); v2 switches **in-place in ~130 ms**: `setAccentTheme()` mutates the tokens, re-runs every style factory registered through `themed()` (module-level `StyleSheet.create` freezes values, so the 12 accent-using sheets + 5 constant maps are wrapped in `themed(() => …)` factories behind a forwarding Proxy), then the root layout bumps a remount key. The panel reopens itself after the remount (one-shot session flag) so you can keep trying colors. This also unlocked **native**: no frozen styles left, so `_layout.tsx` applies the stored accent from AsyncStorage right after mount (one default-colored first frame). Verified live on web: no page reload (window marker survives), fully re-themed both directions, panel stays open, zero console errors. New sheets/maps that bake in accent MUST use `themed()` — plain `StyleSheet.create` will silently stay stale.
- [x] **Sensitive-content containment (medical etc.)** — the summarizer flags high-stakes health/safety advice (`is_sensitive` on reels, new prompt rule); flagged saves keep thumbnail+summary+notes but show a strong "reference only / not responsible / consult a professional" disclaimer and lose the tasks/workout actions. Enforced **server-side** (`routes/workout.py` refuses generation with a clean 422 *before* the quota charge — hiding the buttons is cosmetic). Locked by `tests/test_sensitive.py`. ⚠️ Reels summarized before this ship are unflagged until re-summarized.
- [x] **Offline banner** — non-blocking banner on the library when offline (web `online`/`offline` events) or when a refresh fails (tap to retry); Retry button on the cold "can't reach server" screen.
- [x] **Pull-to-refresh visual polish** — `RefreshControl` now uses accent colors, card background, and "Refreshing…" title (iOS + Android).
- [x] **Empty state illustrations** — already using lucide vector icons (Sparkles, CloudOff); emoji placeholders were already replaced. Search empty state shows the query string.
- [x] **Haptic feedback** — `services/haptics.ts` (web-safe wrapper; native-only, errors swallowed) wired to: save success/failure (`save.tsx`), re-summarize success/failure + delete-confirm warning (`reel/[id].tsx`), and card-delete tap (`ReelCard.tsx`). Web export verified clean.
- [x] **iPad layout** — detail screen content container capped at `maxWidth: 720` and centered.
- [x] **AI usage meter + live tier badge** — ProfilePanel shows "N of M AI actions left" with a progress bar (from `GET /api/account/usage`) and the real tier instead of a hardcoded "Free", so the daily-quota 429 is never a surprise.
- [~] **Usage drill-down: what the AI actions were spent on** — **backend DONE (2026-07-20):** `ai_action_log` table (`user_id, day, action, label`) written from inside `charge_ai_action` — the single choke point every AI endpoint already passes through, so no action can be missed; all 7 call sites labelled (summary / resummarize / tasks / recipe / workout / itinerary / ask) carrying the reel title or question text. `GET /api/account/usage/log` returns today's actions newest-first with both `used` (the meter) and `logged` (how many we can describe). Deliberately disposable: 2-day retention, pruned on write, documented as a UI convenience and NOT an audit trail; removed on account deletion (labels contain question text) while `ai_usage` counters stay (deleting those would reset the quota). Failure isolation is the contract and is structural — guarded inside `log_ai_action` AND at the call site, because past the charge the user has already paid and any exception would mean they were billed and got a 500. Locked by `tests/test_action_log.py` (9 cases). **Mobile DONE (2026-07-21):** the ProfilePanel AI-budget meter is now tappable (only when `used > 0`) and expands to today's actions — human label ("Trip itinerary", "Recipe", "Asked your library"…) + the reel title / question — via `GET /api/account/usage/log`. When `used > logged` (actions charged before the table existed, or a rare fail-open skip) it appends "+ N earlier actions today" rather than implying completeness. Lazy-fetched on first expand, reset when the panel closes. Verified: endpoint contract exercised against the real dev DB (correct labels, newest-first); typecheck + bundle clean. (Logged-in panel render is owner-verifiable — the agent's preview browser has no session.)
- [ ] **Profile: gender + matching avatar icon** — add a `gender` column (`male` / `female` / `other` / unset) to `profiles`, a picker in Edit Profile, and switch the avatar icon on it. Deliberately **not** asked at sign-up (decided 2026-07-20) — set later from the profile screen, so it never adds friction to onboarding.
- [x] **Local notifications ("card has been created")** — shipped as the receipt for a **background share** (`services/shareSave.ts`), which is where the original scope note said the value actually was: the app is not on screen, so the notification is the only thing that reports the save. The old caveats all held — it needs a custom dev build, and web needs the browser Notification API — which is why it is scoped to the share path and nothing else posts one.
- [x] **Notification centre (hamburger menu)** — the last 10 local notifications with read/unread, mark-one/mark-all read, and per-item delete, inline in `ProfilePanel` (`components/NotificationCentre.tsx` + `services/notifyLog.ts` pure / `notifyStore.ts` persistence). ⚠️ **The reason it has to exist:** these notifications are LOCAL, with no server copy — once the OS shade is swiped the receipt is gone, so a share saved while the user was in Instagram becomes unauditable. It is also recorded **before** the permission check, so a user who declined notifications still has one place the save is reported. Not a route on purpose: it reuses the panel's existing AI-usage drill-down grammar. Capped at 10 (a receipt drawer, not an inbox), cleared on account deletion beside `clearSaveCount()`. ⚠️ **The AsyncStorage key `@savehere:notifications:v1` and its JSON shape are a contract with Android Phase B** — the translucent share Activity posts its notification from Kotlin, outside JS, and must append to the same key (AsyncStorage on Android is the SQLite file `RKStorage`, not SharedPreferences) or invisible shares would be the only ones missing. `parseNotes` is deliberately tolerant of a payload it did not write. Locked by `npm run test:notifications` (list cap/ordering, read state, tolerant parse, clock-skew clamp). ⚠️ **Not verified on a device or in a logged-in browser** — the panel sits behind the auth gate and the agent's preview browser has no session; typecheck, web export and the self-check are green.
- [x] **Clean API error messages everywhere** — `services/api.ts` now extracts FastAPI's `detail` centrally, so no screen can ever show raw JSON to the user.
- [x] **Account deletion honesty** — if the backend data wipe fails, the app now reports the error and does NOT sign out (it used to claim success regardless).
- [x] **Visual identity — "Ember on Ink"** (branch `revamp/ui-refresh`) — full identity flip: warm ink surfaces + ember-orange accent + cream text (replacing the violet "AI look"); Fraunces serif for brand moments (login wordmark, landing greeting, reel titles); landing redesigned with a clear hierarchy — one ember Save CTA, a horizontal **recent-saves thumbnail strip** as the door to the library (replaces the misaligned stacked slabs), quiet Ask row; app icon/splash/favicon/in-app mark regenerated in ember; aurora re-tinted to candlelight; confetti/onboarding/category colors warm-harmonized.
- [x] **UI/UX revamp — "calm premium dark"** (branch `revamp/ui-refresh`) — design tokens reworked (single iris accent, hairline borders, iOS-leaning type/radius scale, soft shadows); glassmorphism/holographic chrome retired (GlassCard flattened, shimmer/particle/orbit effects removed from app screens; aurora kept on Landing/Login only); **library cards now show the real reel thumbnail** (16:10 cover with platform-tinted fallback) instead of a generic gradient pattern; flat iOS large-title header + quieter tinted category chips; save screen gained a real **"Paste copied link"** clipboard button (`expo-clipboard`), replacing the fake "Smart Paste coming soon" note. ⚠️ Owner: do a visual pass on a logged-in session (agent verified login/onboarding + zero console errors, but couldn't see the library without credentials).

---

## Mobile — App Store Requirements

- [x] **App icon** — replaced with a generated **full-bleed** 1024×1024 icon (violet gradient edge-to-edge, white bookmark + sparkle glyph, no pre-rounded corners) at `mobile/assets/icon.png`; matching `splash-icon.png` (transparent, glyph-only) and rounded `favicon.png`. Safe for Apple's mask. Source generator lives in git history (PIL script) if a tweak is needed.
- [x] **Splash screen** — `splash-icon.png` regenerated to match the new brand glyph; splash background synced to the theme background (`#0A0A0D`) in `app.json`.
- [ ] **App Store screenshots** — minimum required sizes: iPhone 6.7" (iPhone 15 Pro Max) and iPhone 6.5" (iPhone 14 Plus). At least 3 screenshots each.
- [ ] **App Store description** — written, keyword-optimised, under 4000 characters.
- [ ] **Keywords** — 100-character keyword field for App Store search ranking.
- [ ] **Age rating** — complete the age rating questionnaire in App Store Connect (likely 4+).
- [ ] **Privacy policy URL** — required for any app with network access. Host a simple one-page policy and add the URL to App Store Connect.
- [~] **Support URL** — **in-app page DONE 2026-08-14** (`mobile/app/support.tsx`, reached from
  ProfilePanel → Settings → Support): `savehere.support@gmail.com`, a prefilled mail draft
  carrying account/plan/version, and a copy-to-clipboard fallback for devices with no mail
  client. ⚠️ **The App Store Connect field still needs a public URL**, which this is not — a
  screen inside the app cannot be linked from a product page. Host one alongside the privacy
  policy (`docs/PRIVACY_POLICY.html` has the same gap: written, not hosted), and buy the
  domain first since both need it.
- [ ] **EAS Build setup** — configure `eas.json` with `production` profile, bundle ID (`com.yourname.savehere`), Apple signing certificate and provisioning profile.
- [ ] **TestFlight beta** — distribute to testers via TestFlight before submitting for review.

---

## Backend — Polish

- [x] **Pagination on list endpoint** — `GET /api/reels` accepts `?limit=N&offset=N`, plus
  `?category=`, `?tag=` and `?platform=` filters. *(The sibling `GET /api/reels/search?q=`
  was deleted 2026-08-10 — see "Server-side search".)*
- [x] **Structured logging** — `logging` configured in `main.py`; extraction/save/cache paths log with levels. *(TODO: add per-request IDs.)*
- [x] **Error monitoring** — Sentry (`sentry-sdk[fastapi]`) wired in `main.py`, guarded by `SENTRY_DSN` (no DSN = no-op, so local/CI untouched). 10% trace sampling, `send_default_pii=False`. ⚠️ Owner action: create a Sentry project, set `SENTRY_DSN` in the Render dashboard to arm it.
- [x] **Background summary (instant save)** — `POST /save` returns as soon as metadata is extracted; the Claude summary runs off the request path (`summary_status`: pending→ready/skipped/failed). ⚠️ **No longer a FastAPI `BackgroundTask`** — it dispatches via `reels._enqueue` onto `reels._executor`; see "Background work no longer starves the API" under Extraction Reliability for why that had to change. Tests run the chain inline via an autouse fixture in `backend/conftest.py`. **Durability:** orphaned `pending` summaries (in-process task lost on restart/cold-start) are re-enqueued on startup (`recover_pending_summaries`, capped at 25); the detail screen polls and offers a manual retry if it stalls past ~60s.
- [x] **Startup recovery bounded to ONE free pass per reel (2026-08-11)** — recovery charges nothing (`user=None`) because an interrupted summary is our crash, not the user's action. Unbounded, that made it **the only AI path in the app that spends Claude tokens without decrementing anyone's allowance or appearing in `ai_usage` / the action log** — and Render's free tier cold-starts constantly, so a row that could never complete was re-summarized free and invisibly on *every* boot, forever (~25 × $0.005 ≈ $0.13 per cold start, worst case, unbounded over time). New nullable `reels.recovered_at` (migration `d4a9c1e73b52`) stamps a row before its free pass, committed *before* the work is enqueued — if the process dies mid-recovery the stamp survives, which is the safe direction: a missed retry costs one manual tap, an unstamped row costs tokens on every future boot. A reel still `pending` after its free pass is flipped to **`failed`**, because leaving it `pending` spins the card on "Summarizing…" forever with nothing running, while `failed` is what surfaces the manual retry — which charges, correctly, since the user chose it. Deliberately NOT charging the owner for the automatic pass. Locked by `tests/test_summary_state.py::TestRecoveryIsBoundedToOneFreePass` (4 cases).
- [x] **Truly instant save (async extraction)** — extraction itself is now OFF the request path: `/save` persists a pending card in one DB round-trip (~200 ms) and `_extract_and_summarize` fills title/thumbnail/text, charges the quota, and runs the summary in one background chain. Cache hits still fill synchronously. Failures degrade to a retryable link-only bookmark (never a vanishing card); >10-min videos become link-only bookmarks instead of late rejections; recovery re-runs the whole chain for cards orphaned before extraction. Locked by `tests/test_instant_save.py` (6 mock-based cases). ⚠️ Trade-off: bad-but-recognized links (typo'd YouTube IDs) now save a card that ends `failed` instead of 422ing — acceptable for UX, revisit if it confuses users.
- [x] **Summarizer payload rebuilt (`fix/pipeline-hardening`)** — four fixes to the exact Anthropic call: **(1) `system=`** now carries the static rulebook instead of stuffing rules and untrusted caption text into one user turn at the same trust level — the injection boundary the TRUST RULE prose was previously asking for in words is now structural. **(2) Structured outputs** (`output_config` + a JSON schema; supported on Haiku 4.5) replace hand-stripping ``` fences — critically, a `JSONDecodeError` used to be reported to the user as *"there's nothing readable in this reel"*, a confidently wrong message about content that was actually fine. Degrades to prompt-guided JSON (once, process-wide) if the API ever rejects the param, so one unsupported field can't take summaries down. **(3) `max_tokens` 600 → 1500** — Devanagari and Tamil tokenize far less efficiently, so eight bullets in Hindi overran 600, came back as truncated JSON and surfaced as `skipped`; this silently broke the LANGUAGE RULE for exactly the users it exists for. `stop_reason == "max_tokens"` is now a loud error, never swallowed. **(4) `usage` logged** — input/output tokens per call, which turns the `[Guessing on tokens]` cost estimate in `docs/CONTEXT.md` into a measurement (directly load-bearing for the INR cross-subsidy watch item). Input cap 3000 → 8000 chars, cut on a whitespace boundary with an explicit truncation notice so the model can't "complete" a half-written ingredient.
- [ ] **Prompt caching for the summarizer — DO NOT ADD (checked 2026-08-10)** — Claude Haiku 4.5's minimum cacheable prefix is **4096 tokens** and the system prompt is ~1.2k. A `cache_control` marker below the minimum does not error; it returns `cache_creation_input_tokens: 0`, so it would look like it worked while costing full price forever. Re-check only if this endpoint moves to another model — the minimum is **not** monotonic across models (512 on Opus 5, 4096 on Haiku 4.5).
- [x] **Action prompts calibrated by harm, not blanket-loosened (2026-08-11)** — follow-up to the itinerary change. Audit first: **workouts were already non-grounded** (`WORKOUT_PROMPT`: "build a smart workout… use your expertise", flagged via `is_estimated`) and **recipes already had a two-tier design** (grounded `RECIPE_PROMPT`, falling through to `_infer_recipe` for a standard version when the reel can't be read). The genuine gap was **tasks/steps**, which had no fallback and no permission to supplement, so a thin how-to reel produced two vague lines. Changes: `TASK_PROMPT` now treats content as a starting point and fills connecting steps from subject knowledge, while never inventing numbers, settings, versions or product names (verified live: a title-only "How to speed up your slow laptop" went from near-nothing to 8 specific, correct steps). `RECIPE_PROMPT` may now fill in **standard technique** the video implies (salt the pasta water, preheat the pan, rest the meat) but **quantities, times and temperatures stay grounded-only** — for meat/poultry/eggs/preserving a wrong number is a food-safety risk, not a taste preference, so it must write "cook until the juices run clear" rather than supply a figure. `WORKOUT_PROMPT` gained a warm-up/cool-down instruction and an explicit ban on prescribing load or weight (the one number there that can injure an unseen body). ⚠️ **Deliberately NOT extended to summaries** — that stays grounded-only per CLAUDE.md quality bar #5.
- [x] **Inferred-steps disclaimer finally rendered** — the backend has always computed `_source_note()` ("Couldn't read this video — these are general steps based on the title, not the actual recipe") and shipped it on `TaskListResponse.note`; **nothing in the app ever displayed it**, so a fully-inferred recipe was indistinguishable from the creator's own method. Now rendered on the detail screen. Uses the server's own wording rather than a second copy that would drift.
- [x] **Rotating "still working" copy on AI actions** — a bare "Planning…" / "Building…" / "Working…" reads as a hang across a 3–10 s AI call. `constants/waitingMessages.ts` rotates light, non-offensive lines every 3.2 s per action kind (itinerary / recipe / tasks / workout), starting at a random index so a retry doesn't replay the same order. Tone rules documented in the file: self-deprecating about the *wait*, never about the user, and nothing about their body, diet, cooking, money or budget — those attach to the fitness, recipe and trip features where that lands badly. Hooks are declared above the screen's early returns (rules of hooks); the timer only runs while generating.
- [ ] **Whisper local fallback** — for audio-only content with no captions, add local `openai-whisper` library as a free alternative to the OpenAI Whisper API.
- [x] **Apify LinkedIn integration — NOT NEEDED (removed).** Tested `pratikdani~linkedin-posts-scraper`: it runs sync for 60+ s (would block the save path) and costs ~$0.025/post. Verified the existing free `facebookexternalhit` page scrape already returns the **full** LinkedIn post body (~2.5k chars) via JSON-LD with grounded summaries — so Apify added cost + latency for zero benefit. Reverted to page-scrape-only for all platforms.
- [x] **Foreign keys enforced + no orphan children** — SQLite now runs with `PRAGMA foreign_keys=ON` (it silently ignores `ON DELETE CASCADE` otherwise), and reel/account deletion explicitly removes `tasks` + `workout_exercises` (also sweeps orphans created before the fix). Account deletion keeps `ai_usage` rows so wiping data can't reset the daily AI quota. Locked by `tests/test_data_integrity.py`.
- [x] **Workout regeneration no longer destroys the existing plan on failure** — the old plan is deleted only after a successful extraction (the tasks route already worked this way).
- [x] **`GET /api/account/usage`** — tier + used/limit/remaining/resets_at for the day, read-only (never charges). Powers the mobile usage meter.
- [x] **Alembic migrations (DONE 2026-07-21)** — Alembic is now the single schema authority (`backend/alembic/`, baseline `9aa25548aadb` matching current models). `create_tables()` runs `alembic upgrade head` on startup (idempotent); the `ALTER … except: pass` hack is deleted. `env.py` pulls the URL from `settings.DATABASE_URL` and uses `render_as_batch` on SQLite. The existing dev SQLite DB was `alembic stamp`ed to head so it isn't re-created. Verified on both SQLite and real Postgres. Future schema changes: `alembic revision --autogenerate -m "..."` then commit the migration. **Original problem (why this was a blocker, kept for context):** the old loop had no `rollback()`, so on Postgres — which aborts the whole transaction on a failed statement — the first duplicate-column error would silently kill every later ALTER, meaning new columns would never apply to the live DB while passing locally on SQLite.

---

## Pricing & Monetization (launch — App Store Connect config, needs Apple Developer account)

> All of this is **App Store Connect / RevenueCat configuration set at launch**, not app code — except the AI-cap pieces, which need the per-user quota (auth project). Apple owns IAP billing, so discounts must use Apple's native offers, not a custom coupon.

- [ ] **Regional (PPP) pricing** — three storefront buckets, not 175 hand-tuned prices:
  - **US / high-income:** ~$4.99/mo, ~$34.99/yr (margin lever)
  - **EU:** ~€5.99/mo, ~€39.99/yr (price up vs US — displayed price is VAT-inclusive, ~20%)
  - **India + PPP-low countries:** **₹99/mo**, **₹799–₹999/yr** (volume lever)
- [ ] **India first-purchase promo — RESPECIFIED 2026-08-10: ₹99/mo for the first 6 months, then ₹120/mo** (was ₹59×3→₹99; the owner set ₹99 as the intro price and ₹120 as standard). Apple **Introductory Offer** (pay-as-you-go), India storefront, auto-renewing. Encoded app-side as `introMonths: 6` + `wasPrice: 120` in `mobile/constants/pricing.ts` and disclosed via `renewalTerms()`; the offer itself is App Store Connect + RevenueCat config. ⚠️ One intro offer per customer per subscription group — a returning subscriber pays ₹120. ⚠️ **Still needed:** the USD monthly revert price (~$8.49 mirrors the 17.5% INR discount) and a decision on whether the weekly plans get an offer.
  <!-- superseded, kept for the reasoning: -->
  ~~Apple **Introductory Offer** (pay-as-you-go): **₹59/mo for the first 3 months, then ₹99/mo**, India storefront only, auto-renewing.~~ Apple's required pre-renewal notice = the "ask to renew," handled automatically. Optionally also mint a custom **Offer Code `SAVEHEREFIRST`** for marketing/launch buzz (same ₹59×3 deal). ⚠️ Don't make it 3 months *free* (token cost + abuse) and don't use a non-renewing product (worse retention).
- [~] **Price ↔ AI-cap pairing rule** — `[Certain]` net revenue per user must stay ≥ their token cost. **As of the 2026-08-10 decision this rule holds in USD and is knowingly broken in INR:** Pro = 20/day ≈ $2.43/mo worst case at ~$0.004/action; $7 nets $5.95 after Apple's 15% ✅, ₹99 nets ~$0.96 ❌ (~2.5x underwater, accepted as a cross-subsidy). ₹99 pairs safely with ~**8/day**. Going lower still (₹49–₹79) would need ~4–5/day. The per-user quota is now **tier-aware** (`daily_limit_for(user)` reads `app_metadata.tier`; limits via `AI_DAILY_LIMIT`/`AI_PRO_DAILY_LIMIT`) — so a cheaper, tighter-capped tier just needs (a) a new limit constant and (b) the IAP/RevenueCat webhook stamping the tier on the user. Until tiers are sold the free limit is global, so ₹99 is the floor.
- [~] **Tiers — mechanics BUILT (branch `feat/tier-system`), billing pending** — server-side entitlements (`app/entitlements.py`, the single source of truth): **trial** (TRIAL_DAYS=10 from first authenticated request, 30 AI/day, unlimited saves) → **free** (trickle: 3 AI/day + 20-save cap on NEW saves; library/view/search never lock; deleting below the cap re-opens saving) → **pro** (100 AI/day, unlimited; `app_metadata.tier` stamped via `backend/scripts/set_tier.py` — deliberately a script, not an endpoint). **Loophole containment:** trial clock lives in a `profiles` row (client can't forge it) and is keyed to a SHA-256 of the normalized email (`trial_grants`, survives account deletion; gmail dots/+tags collapsed) so re-signup CONTINUES the original trial instead of resetting it. Accepted residues: brand-new emails still mint trials (fixed economically by Apple IAP at launch); JWT downgrade staleness ≤1 h (~$0.15 worst case); save cap is soft under concurrent saves. Referrals deferred (fraud surface > value pre-launch) — `trial_extra_days` is the ready seam; onboarding copy no longer promises them. 18 tests in `tests/test_entitlements.py`. **Remaining at launch:** RevenueCat webhook (signature-verified, idempotent) replaces the script; finalize pro pricing/limits.
- [~] **Feature gating: free = workout + recipe; ask/tasks/itinerary = Pro (decided 2026-07-20)** — **server side DONE (2026-07-20):** `Entitlements` carries `can_ask`/`can_tasks`/`can_itinerary` (trial + pro = all True; post-trial free = all False); `/api/ask` + `/api/ask/stream` and non-cooking `POST /reels/{id}/tasks` return 403 with `PRO_FEATURE_DETAIL` (cooking tasks = the recipe feature = stays free, workout stays free); gates fire BEFORE the quota charge so a refused call never costs an AI action; `GET /api/account/usage` exposes a `features` dict for the app's locked-button UI. Locked by `tests/test_feature_gating.py` (11 cases: tier × feature matrix, no-charge-on-403, usage flags). **Remaining = mobile:** locked-button-with-Pro-badge states driven by `usage.features` (cosmetic — server already enforces). Locked buttons must NOT link to web payment (anti-steering, India). **Trial keeps FULL access** — locks appear only after expiry. **Decision (same date): auto-summary stays ON for every tier** — cheapest AI action (~$0.005, Haiku) and the product's conversion moment; click-to-generate for post-trial free is a data-driven revisit only if summary spend dominates after launch (plumbing exists: `failed`→retry already IS click-to-generate). Known interaction: free users' 3/day quota is shared with auto-summaries.
- [ ] **RevenueCat** — manage IAP entitlements + per-territory pricing + promo experiments across iOS/Android. Webhook endpoint is sketched + tested (`app/routes/billing.py`, `tests/test_billing.py`, 15 cases) but **not registered in `main.py`** — activation needs `REVENUECAT_WEBHOOK_TOKEN` set, the 2-line router include, and the mobile app calling `Purchases.logIn(supabaseUserId)` (without which every webhook lands in the ignored-anonymous branch).
- [ ] **Apple Small Business Program** — enroll (<$1M/yr) → 15% commission instead of 30%. Materially improves every margin above.

---

## Nice to Have (post-launch)

- [ ] **Android version** — Expo build for Google Play. Share Intent equivalent for Android.
- [ ] **Biometric app-lock (Face ID / Touch ID) — opt-in, post-launch (decided 2026-07-20)** — a Settings toggle "Require Face ID to open SaveHere": `expo-local-authentication` gate over the persisted Supabase session in `_layout.tsx`. **Explicitly NOT a pre-launch item:** Sign in with Apple already delivers Face-ID *authentication* (the OS uses biometrics at the Apple sign-in step — zero code from us). This feature adds only the *reopen-the-app privacy gate*, which Apple login does NOT provide (sessions persist for weeks → app reopens with no prompt). For links+notes data that gate is low-value polish, not protection. Needs a real device + custom dev build (no Face ID on web/simulator), so it also can't be tested in the current web loop. Revisit only if the "unlocked phone → open library" scenario matters after launch.
- [ ] **Collections / folders** — group saved items beyond category tags.
- [ ] **Export** — download all saved summaries as PDF or Markdown.
- [ ] **Analytics** — PostHog or Mixpanel (free tier) to understand which features are used.
- [ ] **GDPR / data deletion** — "Delete my account and all data" flow, required for EU users.
- [~] **Supabase Row Level Security** — `backend/scripts/enable_rls.sql` is ready (deny-all: enables + FORCEs RLS on every app table, no client policies, since the mobile app only uses Supabase for auth and all data flows through the FastAPI service-role connection). ⚠️ Owner action: run it against the Supabase project once the Postgres migration above lands, and verify with the anon-key curl check in the script's comments.
- [~] **CI/CD pipeline** — GitHub Actions: backend pytest runs on push/PR (`.github/workflows/ci.yml`); **mobile `npm run typecheck` now runs on push/PR touching `mobile/`** (`.github/workflows/mobile-ci.yml`, `npm ci` + `tsc --noEmit`) — closes the gap where the `launch-prep/ui-revamp` branch shipped an `app/index.tsx` that didn't even parse. Each workflow is path-scoped so a mobile-only change doesn't run the Python suite and vice versa. TODO: EAS build on merge to main.
- [x] **Three standing test accounts (trial / free / pro)** — **DONE (2026-07-21):** owner created the accounts, `scripts/dev_seed_tiers.py` stamps all three in one command (`python scripts/dev_seed_tiers.py`). It resolves email→Supabase id, writes the pro JWT claim for `protieruser@gmail.com`, and pre-seeds the local `profiles` clock for `freetieruser` (expired→free) and `trailtieruser` (fresh→trial; note the "trail" spelling as created), clearing each day's AI counter so a flipped tier isn't instantly over cap. Verified all three resolve to the intended tier (30/3/100 AI). SQLite-guarded; needs `SUPABASE_*` in `.env`. Deliberately **not** an in-app switcher: `scripts/set_tier.py`'s own docstring rejects that ("a forgotten temporary admin endpoint is a standing self-upgrade hole"). ⚠️ pro needs a sign-out/in (JWT caches tier ≤1h); trial/free apply on the next request. Also available: `scripts/dev_tier.py status|expire|trial|resetquota` for one-offs.
- [~] **Unit tests** — `backend/tests/` (pytest, **228 tests as of 2026-08-10**, after the search
  vertical's 12 cases were removed with it and `test_search_api.py` became `test_reels_api.py`; newest: `test_feature_gating.py`, `test_itinerary.py`, `test_billing.py`, `test_action_log.py`): `normalize_url`, `detect_platform`, `_parse_vtt`, `_og` (+ backtracking-hang regression guard), `_extract_jsonld`, `_weak_title`, `_to_response` coercion, the per-IP rate limiter, the per-user daily AI quota (atomic charge, zero-limit kill-switch, tier resolution from `app_metadata`, + wired-into-`/api/ask` integration, no real Claude call), task source disclaimers, DB-backed list/pagination/search + per-user-isolation endpoint tests (in-memory SQLite + TestClient), JWT auth verification, and mock-based `extract_tasks` cooking-fallback tests, smart-search ranking (`test_smart_search.py`), and sensitive-content containment (`test_sensitive.py`). Fixed a daily flake: `test_quota.py` asserted on local `date.today()` while the quota keys rows on the UTC day — failed every run between 00:00 and 05:30 IST; now uses `_utc_today()`. Run with `python -m pytest tests/ -q` from `backend/`. **CI:** `.github/workflows/ci.yml` runs the suite on every push/PR touching `backend/`. TODO: mock-based test for `summarizer.summarize`.

---

## Done

- [x] FastAPI backend with SQLAlchemy + SQLite
- [x] yt-dlp content extraction (YouTube, Instagram, TikTok)
- [x] YouTube auto-caption extraction (VTT, all languages)
- [x] Claude Haiku summarization with quality prompt
- [x] Multi-language caption and summary support
- [x] Re-summarize (refuses empty result; per-reel 3-try cap removed 2026-07-14 — the per-user daily AI quota is the cost ceiling, UI shows a quota notice)
- [x] Auto-saved personal notes (1-second debounce)
- [x] Dark minimal UI with Expo Router
- [x] 2-column responsive grid home screen
- [x] Category filter chips + title/tag search
- [x] Clickable source URL on detail screen
- [x] Delete reel from card (X button) and detail screen
- [x] 10-minute duration guard (rejects long-form video)
- [x] LinkedIn fallback — save link, prompt user to paste text in Notes
- [x] Proper `.gitignore` (excludes `.env`, `*.db`, `node_modules`)
- [x] Extraction reliability rewrite — `process=False` + ios/tv/android clients (~2–4s, no format-selection failures)
- [x] Extraction cache (`extraction_cache` table) — survives reel deletion; re-saving is instant, never re-hits the platform
- [x] Caption 429 handling — fast-fail to description so saves never hang on rate-limited captions
- [x] ThreadPool hardening — 8 workers + bounded `socket_timeout` / `EXTRACT_TIMEOUT` to limit hung-thread blast radius
- [x] Empty-summary guard — skip Claude when there's no real text; honest "couldn't read this" message
- [x] UI/UX redesign — gradient theme, Ionicons, entrance/press animations, glowing FAB
- [x] Animated bot progress on the save screen (honest step labels retained)
- [x] Fixed card delete — sibling overlay so the X deletes instead of opening the reel

---

## Design Experiment: Refactor Home & Nav to Nocturnal Dimension

> ⚠️ **Temporary section — experiment, not a commitment.** Delete this section
> and `docs/DESIGN_PROPOSAL.md` together if the direction is rejected.
> Started 2026-08-09. Owner suspended the UI rules in `docs/HANDOFF.md` §4.5
> for this experiment.

Full spec: [`docs/DESIGN_PROPOSAL.md`](docs/DESIGN_PROPOSAL.md). No application
code has been modified yet.

- [x] **Refero research + token extraction** — Suno, Vapi, Dimension, Hyper Foundation. Real token sets, nothing invented.
- [x] **Draft the visual spec** — colours, type, spacing/radius, home hierarchy, capsule nav parameters.
- [x] **DECIDED: `danger` becomes a real red** (owner, 2026-08-09). `#E05561` dark / `#B3323E` light. ⚠️ **Derived, not sourced** — neither Suno nor Vapi ships a red; it is Suno Vivid Pink `#FD429C` rotated 337°→355°, desaturated 98%→69%. `success`/`warning` stay monochrome.
- [x] **DECIDED: `docs/HANDOFF.md` §4.5 marked ⛔ RETIRED**, with the rules that still hold (tokens-only, content-first, Icon.tsx map, subtle motion, ReelCard comparator) listed explicitly so they don't get lost with the dead brief.
- [x] ~~**Re-introduce Fraunces**~~ — **DROPPED** (owner, 2026-08-09): avoids font-loading latency on SDK 56. Headers and titles use `Inter_600SemiBold`; `typeface.serif` is unchanged.
- [x] ~~**Generate the grain asset**~~ — **DROPPED** (owner, 2026-08-09): the haze gradient carries it alone.
- [x] **Applied palette + radius changes** in `mobile/constants/theme.ts` — key names unchanged, so every screen compiles untouched. `radius.xl` 20→24, new `gradients.haze` + `hazeLocations`. `npm run typecheck` and `npx expo export --platform web` both pass.
- [x] **Audited all 24 `<LinearGradient>` call sites** (sub-agent, isolated context). 16 flat `gradients.*`, 1 `scrim`, 5 theme-derived arrays, 2 hardcoded.
- [x] **DECIDED: Option B — primary actions keep the cream inversion** (owner, 2026-08-09). `colors.accent` orange is reserved for active tabs, filter chips, and the centre FAB. Rationale: 15 orange buttons is how one accent becomes wallpaper.
- [x] **Collapsed the retired rainbow tokens** — `gradients.vibrant`/`sunset`/`cool` deleted (three names for identical flat ink; sunset=itinerary, cool=recipe, vibrant=workout — meaning colour no longer carries). 8 call sites retargeted to `gradients.primary`.
- [x] **Deleted 4 dead gradients** — `surface`, `hologram`, `neon`, `darkSurface`. Zero call sites, verified by grep before removal.
- [x] **Fixed both hardcoded ramps** — `reel/[id].tsx:366` `['transparent','rgba(0,0,0,0.88)']` → `gradients.scrim`; `workout/session/[reelId].tsx:214` `['#15131C','#1A2740','#15131C']` → `gradients.haze` (was dark-only and would not follow `setScheme`).
- [x] **Fixed the `platformMeta` drift** — was hardcoding `#F8F8F8`/`#0B0B0B`; now reads `PALETTES.dark.textPrimary`/`.card` so it can't silently desync from the palette again. This was a regression introduced by the palette swap, not pre-existing.
- [x] **Landed all 3 `gradients.haze` adoptions** — workout rest backdrop, LoginScreen (layered above the wash, below the bottom ramp so legibility is untouched), and the library-grid screen root (`app/index.tsx`, `pointerEvents="none"`).
- [x] **Verified in the browser** — `npm run typecheck` clean; dark scheme renders on `#101012`; haze confirmed painting at 989×963 with all 4 stops at the right locations; every `ReelCard` scrim now resolves through the token.
- [x] **DECIDED: haze is atmosphere for SPARSE SCREENS ONLY** (owner, 2026-08-10). It stays
  behind the library grid's full-bleed thumbnails and stays effectively invisible there —
  that is accepted, not a defect: on the grid the pictures ARE the colour, which was the
  governing rule of the whole direction. Stop opacities (10%/14%) are NOT being raised and
  the layer is NOT moving above the tiles; both would put a cast over user photography.
  No code change. And still: do not "fix" this with blur.
- [x] **`Landing.tsx` now has the haze** (owner, 2026-08-10). It early-returned before the
  patched root in `app/index.tsx`, so the editorial hero was the one sparse screen without
  it — the exact conditions (two text blocks, one control, empty canvas) where it works on
  the login wall. One `LinearGradient` at the screen root, `pointerEvents: 'none'` so it
  can't eat the composer's tap. **Verified in the browser:** all four stops resolve
  (`#101012` → pink 10% @45% → orange 14% @78% → `#101012`), hero and sub stay legible.
  In light `hazeFor()` still collapses to a flat canvas fill, so it paints nothing there —
  same behaviour as `app/index.tsx`, deliberately not special-cased.
- [x] **CLOSED: capsule tab bar + centre FAB — not doing it** (owner, 2026-08-10).
  ⚠️ **The instruction was unbuildable as written.** It said to build the bar in
  `app/(tabs)/_layout.tsx`; **there is no `app/(tabs)/` directory and never was.**
  `components/TabBar.tsx` is a custom bar rendered at the ROOT, above the router, and that
  is load-bearing: Home and Library **share the route `/`** and are told apart by a session
  flag, which expo-router's `Tabs` cannot express. Migrating would have meant splitting them
  into two real routes and re-breaking the active-indicator bug fixed in PR #39. The pill
  bar already ships with five tabs and a centre Save, so the restyle was closed in favour of
  the launch blockers. **Consequence to accept:** `colors.accent` orange now has no home in
  the nav — Option B reserved it for "active tabs, filter chips and the centre FAB", and
  none of those are built, so the app is effectively still achromatic outside `danger`.
- [ ] **Home screen**: Fraunces greeting, filter pill row. *(Haze root: done above.)*
- [ ] **Verify on web + Android** — the whole point of this hybrid is no `expo-blur`. Confirm the gradient costs nothing on scroll before calling it done.
- [ ] **Contrast audit** — `#F7F4EF` on `#101012` and `#101012` on `#E96B34` both need re-measuring; the current palette's ratios are documented in `theme.ts` comments and must not regress.

## Active Refactoring & Optimization Backlog
> **Audited 2026-08-09 against the working tree** (sub-agent, evidence-checked —
> not trusted from checkbox state). Most of this section was written twice: the
> to-do latency, haze, and setScheme items each appeared as two entries. Shipped
> in PR #39 (`da00e8a`).

- [x] **Optimize To-Do List Interaction Latency** — `TodoRow` is `memo(...)` (`todos.tsx:104`), row handlers `useCallback` (`todos.tsx:257,336,350,433,434`), `grouped`/`overdueCount` `useMemo` (`todos.tsx:440,451`). *(Duplicate of "Optimize To-Do List Click Latency" below.)*
- [x] **Light Scheme Haze Sanity Check** — `hazeFor(p, s)` returns four copies of `p.background` in light and the chromatic ramp in dark (`theme.ts:186-190`), called from both the `gradients` literal (`theme.ts:226`) and `applyScheme` (`theme.ts:306`). Verified at runtime: light computes `linear-gradient(rgb(255,255,255) ×4)`. *(Duplicate of "Light Mode Visual Sanity Check" below.)*
- [x] **Fix setScheme Runtime Key Mapping** — `Record` cast gone; each key assigned by name (`theme.ts:298-305`); `gradients.haze = hazeFor(p, s)` (`theme.ts:306`); the legacy keys survive only in the removal comments. *(Duplicate of "Clean Up Legacy Group 1 Tokens" below.)*
- [x] **Resolve Task Checkbox Tap Latency (`TaskList.tsx`)** — `onUpdate({ ...task, completed: next })` fires before `await api.toggleTask`, with rollback on catch (`TaskList.tsx:154-163`); `toggling` spinner state deleted.
- [~] **Optimize ScrollView Render Latency (`todos.tsx`)** — Steps 1 and 2 done. **Step 3 solved differently on purpose:** `{editorOpen && <TodoEditor/>}` would unmount the sheet on close and eat its `<Modal animationType="fade">` exit animation, so `TodoEditor`/`TodoSettingsSheet` are memoized and kept mounted with stable callback props instead (`TodoEditor.tsx:353`, `TodoSettingsSheet.tsx:178`). Same win, no UX regression. Still open: no virtualization (`ScrollView` + nested `.map`) — deliberately deferred until the memo work is measured, since at 10–40 rows it may buy nothing.
- [x] **Fix Floating Navigation Layout Collisions** — `/workout/` in `HIDE_ON` (`TabBar.tsx:33`); footer uses `useSafeAreaInsets` (`workout/[reelId].tsx:39,152`). ⚠️ Task 1's "Itinerary" and "Study Plan" screens **do not exist**: itinerary is a section inside `reel/[id].tsx` (whose container already clears the bar), and "Study Plan" has no code at all — the only match in `mobile/` is marketing copy in `OnboardingModal.tsx:63`. Nothing else to clear.
- [x] **Fix Workout Plan Bottom Clearance** — `HIDE_ON = ['/save', '/pro', '/workout/']` (`TabBar.tsx:33,79`); hardcoded `110` replaced by `FOOTER_HEIGHT` (`workout/[reelId].tsx:28,166`).
- [x] **Clean Up Legacy Group 1 Tokens** — duplicate of "Fix setScheme Runtime Key Mapping"; same evidence.
- [x] **Optimize To-Do List Click Latency** — duplicate of "Optimize To-Do List Interaction Latency"; same evidence.
- [x] **Light Mode Visual Sanity Check** — duplicate of "Light Scheme Haze Sanity Check"; same evidence.
- [x] **Remove stale dead theme keys (`refactor/stale-theme-cleanup`, 2026-08-09)** — deleted the seven retired compat aliases from `colors` (`hologram`, `neonPink`, `neonCyan`, `neonViolet`, `glassBg`, `glassBorder`, `glassBorderLight`) and their `applyScheme` re-point lines. Grep confirmed **zero readers outside `theme.ts`** — they were kept alive only by their own re-theme statements.
- [x] **Name the last stale hardcoded number** — `todos.tsx` scroll padding `+ 92` is now `BOTTOM_BAR_CLEARANCE`, beside the existing `UNDO_ABOVE_BAR = 74`.
- [n/a] **"Stale HMR cache assumptions"** — no code artifact exists. Grep for `HMR`/`hot reload`/`fast refresh` across the repo returns only `package-lock.json` integrity-hash false positives. This referred to a stale *browser console buffer* observed during development, not to anything in the codebase.
- [x] **Fix Workout Plan Rest-Time Contrast (Bug 1)** — root cause was NOT the plan screen (`workout/[reelId].tsx` rest tag was already on `textTertiary`/`textSecondary` and fine). It was `workout/session/[reelId].tsx` `restCount`, the 110px countdown, styled `colors.onAction` — which **is** the page background in both schemes, so it rendered near-black on the dark canvas and white-on-white in light. Now `colors.textPrimary`.
- [x] **Fix Navigation Tab Active Indicator Collision (Bug 2)** — ⚠️ **the prescribed fix was for a bug that didn't exist.** `TabBar` already exact-matched the root (`pathname === '/' || pathname === '/index'`); there was no `startsWith('/')` collision. The real cause: Home and Library **share** the route `/` and are distinguished by a session flag, so `usePathname()` never changes between them — and `TabBar` emitted `libraryState` for the route to consume but **never subscribed to it itself**, so nothing re-rendered the bar. Fixed by subscribing (`useEffect(() => onUi('libraryState', bumpActive), [])`). The `/`-exact guard was also applied to `HIDE_ON` defensively, but it is a no-op today — `HIDE_ON` contains no `/` entry.
- [x] **Remove Library Header Search Option (Feature Change 3)** — `<TextInput>` search row deleted from `app/index.tsx`, replaced by memoized `RollingTagline` over `LIBRARY_CAPABILITIES` (module-level so the memo holds). Style keeps the old 42px footprint so the grid doesn't shift. Orphaned `Search`/`XCircle`/`TextInput` imports removed.
- [x] **Follow-up to Feature 3 — dead search plumbing stripped (2026-08-10).** `app/index.tsx`
  lost `search`/`searchResults`/`searching`, the debounce effect, `searchEverywhere()`, the
  `searching` spinner branch, the `inSearchMode` empty states, the `displayList` alias and
  the `!inSearchMode` guard on `loadMore` — every one provably unreachable, since no setter
  ever wrote a non-empty query. Swept alongside it: the unused `KeyboardAvoidingView` import,
  the `headerActions`/`searchInput`/`loader` styles, and a **local `goHome()` that had been
  dead since round five** — going home is `TabBar.tsx`/`HomeButton.tsx`'s job now
  (`clearEnteredLibrary()` + the `libraryState` emit the screen subscribes to); a comment
  marks the spot so nobody adds a second copy. Net −78 lines.
  ⚠️ **One behaviour change, deliberate — the dead code was masking a live bug.** Filtering
  to a category with no saves fell through to the generic empty state and told a user with 66
  saves "Nothing saved yet", offering "Save your first link". It now reads "Nothing in
  {category}" with a **Show all categories** button. Verified live by stubbing an empty
  category response.
  **Verified:** typecheck clean, `expo export --platform web` clean, library exercised live
  against the real 66-save dev account (grid, category switching, empty-category state and
  its recovery button).
- [x] **DECIDED + DONE: the search vertical is deleted (owner, 2026-08-10).** Not disabled,
  not feature-flagged — removed, because an unreachable feature that still runs in CI is a
  maintenance bill with no user on the other end. Gone: `backend/app/services/search.py`
  (157 lines: tokenizing, stopwords, synonym groups, category matching, relevance ranking),
  `GET /api/reels/search` in `routes/reels.py`, `backend/tests/test_smart_search.py`,
  `mobile/services/api.ts::searchReels()`, and the 11-case `TestSearch` class.
  **Kept deliberately:** `tests/test_search_api.py` was renamed to **`test_reels_api.py`** —
  most of it was never about search (pagination, `?tag=`, `?platform=`, per-user isolation)
  and a file named for a deleted feature is how the next reader gets misled.
  ⚠️ **The one isolation case that died with it was replaced, not dropped.**
  `test_search_does_not_cross_users` proved a query surface can't leak across users; the
  `?tag=` filter is now the only surface that matches rows in **Python rather than SQL** —
  precisely where a `user_id` filter can go missing unnoticed — so the replacement asserts
  isolation there, using the two reels both seeded with the "cooking" tag.
  Removal notes sit at all three sites (route, api.ts, the library header comment) pointing
  at git; if search ever comes back at a scale that justifies it, **embeddings, not the
  lexical ranker** — that was always documented as the pre-scale step.
  **Verified:** `python -m pytest tests/ -q` → **228 passed**; typecheck and
  `expo export --platform web` clean. README, `docs/CONTEXT.md` and the older TODO entries
  no longer advertise a feature the app doesn't have.
- [x] **Implement Ask Screen Focus Hand-Off (Feature Change 4)** — Home card now renders an animated, high-emphasis `ASK YOUR LIBRARY` (MotiView fade/rise, no loop) instead of the static save count; `ask.tsx` focuses its input via a ref on a 350 ms timer rather than `autoFocus`, because focusing mid-push-transition is the case where iOS shows a caret but never raises the keyboard.
- [x] **MockReel tiles now render in BOTH schemes (2026-08-10)** — the wall was
  always mounted and always drifting in both; what was missing was the *scenes*.
  `MockReel.tsx` declared a scheme-aware `alpha()` ramp and then ignored it in the
  StyleSheet, hardcoding `rgba(0,0,0,…)` for all 12 scene primitives (plus a white
  `hSun`). In light that happens to read — black silhouettes on a pale well. In
  dark it is black on a faintly-lit well under the 0.74 scrim, i.e. nothing: the
  login wall showed bare card outlines and no compositions at all. Every primitive
  now goes through `alpha()`, so the vocabulary actually inverts as the docstring
  always claimed. The `hSun` highlight follows the ink too (bright disc in dark,
  dark disc in light) rather than being white in both. **The play glyph was broken
  in BOTH schemes** and is the same class of bug: `borderLeftColor:
  colors.background` is a knockout, which only works when the well is far from the
  canvas tone — it never is here, so the arrow was white-on-pale in light and
  near-black-on-near-black in dark; it is `alpha(0.9)` now. The sheet is built
  inside `themed()`, so the factory re-runs on `setScheme` and the tiles re-tint
  live. Scrim opacities (`0.74` dark / `0.42` light) deliberately untouched — they
  are what keeps the wordmark legible, and the scenes read without moving them.
  **Verified live** at 375×812 in both schemes: typecheck clean,
  `expo export --platform web` clean.
- [x] **Removed the ASK YOUR LIBRARY button from the landing page (2026-08-10)** — deleted,
  not hidden. `Landing.tsx`'s composer used to swap its label, icon and destination at the
  `ready` stage; it now always reads "Paste a link" and always pushes `/save`. Gone with it:
  the `stage === 'ready'` branch, the `MotiView` wrapper and the `moti` import, the
  `composerAsk` style, and the conditional `accessibilityLabel`/icon. **Grep confirms the
  only remaining occurrences of the string in `mobile/` are the two comments that record the
  removal.**
  ⚠️ **One thing removed that you did not name, and why.** The `ready` hero read "You saved
  it. / Now ask it." — copy written for the button underneath it. Left alone it would
  promise an action the screen no longer offers, so it is now "You saved it. / Now use it."
  with a sub-line pointing at the Ask **tab**, which still exists. The three-stage ladder and
  the `ASK_MIN_REELS` unlock ticks were **kept**: they describe the library, not the button,
  and the gate they show is still real and still enforced server-side.
  **Verified live** at 375×812 dark on the 66-save account: composer reads "Paste a link",
  no ask affordance anywhere on the screen. Typecheck + `expo export --platform web` clean.
- [x] **Bug fixed: "Go Pro" showed to Pro users right after sign-in (2026-08-10)** —
  root cause was one character class in `ProfilePanel.tsx`: the CTA was gated on
  `usage?.tier !== 'pro'`, and `usage` starts `null` and is only fetched **when the panel
  opens**. During that round-trip `usage?.tier` is `undefined`, `undefined !== 'pro'` is
  `true`, so a paying user got a live upsell button until the request landed — seconds, not
  frames, against a cold Render instance. The optional chain made "not loaded yet"
  indistinguishable from "free". Now `usage && usage.tier !== 'pro'`, matching the **tier
  badge two lines above**, which was already guarded with a comment naming this exact hazard;
  whoever wrote it guarded the badge and not the button.
  **Not a shared-state problem — do not build a UsageContext for it.** The other two
  `getUsage()` callers already handle the unknown state correctly and deliberately
  (`app/ask.tsx:51` gates on `savedCount !== null`; `app/reel/[id].tsx:344` locks only on an
  explicit `false` so loading renders unlocked). This was the one unguarded site.
  ⚠️ **A second, separate delay exists and is NOT this bug.** `/api/account/usage` reads the
  tier from the JWT's `app_metadata.tier` claim, not the database (`app/entitlements.py:47`),
  so a tier granted by `scripts/set_tier.py` to an already-signed-in session stays stale for
  up to the token's ~1 h life. That one shows as a CTA that *persists* until re-login, and
  the fix for it is a sign-out/in — don't chase it in the client.
  **Verified live** on the real Pro dev account, all three states: mid-fetch → neither badge
  nor button; loaded Pro → badge "PRO", no button; response rewritten to `tier:'free'` →
  badge "FREE" and the button returns. Typecheck clean.



- [x] **Quota-exhausted saves are honest now, not "failed" (2026-08-10)**
  ⚠️ **The brief's premise was wrong in your favour: no money was ever being wasted.**
  The AI charge is taken *before* the Claude call (`_try_charge` → `charge_ai_action`),
  so a refused charge already short-circuited the chain — over quota, zero tokens spent,
  zero API calls made. There is now a test asserting the summarizer is never invoked.
  **What was actually broken was the reporting.** Those saves were written
  `summary_status = "failed"`, so the detail screen showed "Something interrupted the AI
  summary — tap to try again" with a retry button that could not succeed until the daily
  reset, all day, on a save that had not failed. New status `quota_exceeded`
  (`QUOTA_STATUS`, `routes/reels.py`) is set at all three charge sites, and
  `client_metadata` no longer overwrites it with `skipped` — that would tell a user who
  is merely out of budget that their reel is unreadable.
  **Three surfaces now say the same true thing:**
  1. `/save` shows a hairline notice **before** you paste, from `usage.remaining === 0`.
     It deliberately does **not** block saving — saves are unrationed at every tier, and
     blocking would turn a soft limit into a hard one and lose the link entirely.
  2. Reel detail: "Saved — AI summary resumes tomorrow", **no retry button**, because
     nothing there can succeed yet.
  3. Grid tile: `AI RESUMES TOMORROW` rather than reusing `NO TEXT`, which blamed the
     reel for the user's daily cap.
  **Verified:** 229 backend tests pass incl. two new cases; typecheck + web export clean.
- [x] **Onboarding figures are the app's own icons now (2026-08-10)**
  The six first-run cards used abstract figures — a 3×3 cell grid, stacked bars, rows of
  dots, a giant plus. Rows of dots do not say "workout". `StepFigure` now renders one
  Lucide glyph per step inside the same 168px hairline frame:
  `grid→layers`, `ask→ask`, `plan→barbell`, `steps→restaurant`, `check→checkbox`,
  `save→add`. **Four of those six are the tab bar the user taps within the minute**
  (Library, Ask, Slate, Save) and the other two are the buttons those steps describe
  (Build Workout, Get Recipe) — so the tour teaches the real interface instead of
  decorating beside it. Zero new icon keys, zero new imports, zero bytes.
  ⚠️ **Lucide's `strokeWidth` is in viewBox units, not pixels** (rendered px =
  `strokeWidth × size / 24`). The default 1.1 at size 88 would draw a ~4px stroke — the
  heaviest mark on a screen whose display face runs at 300. Pinned to `0.45` (~1.65px).
  Do not delete that prop as redundant. 32 lines of orphaned figure styles removed.
  ⚠️ **Canva MCP was tried first, as asked, and rejected on evidence.** Auth works and
  `generate-design` returns candidates, but: exports are **`pdf/jpg/png/pptx/gif/mp4` —
  no SVG**; **transparent PNG is blocked on the Free plan**, so an opaque white tile
  cannot survive the light/dark inversion; it emitted a single merged 3×3 raster rather
  than six separable icons; and on the better of two draws, 2 of 6 concepts were wrong
  (a chef's hat rendered as a tombstone, the save icon an unreadable link/plus tangle).
  ⚠️ **Two throwaway designs were created in the owner's Canva account and should be
  deleted:** `DAHR4hrrGtA` and `DAHR4uSm26Y`.
- [x] **Emoji profile pictures replaced with the 102 illustrated PNGs (2026-08-10)**
  Source: `~/OneDrive/Desktop/profile_avatars_FINAL_clean_1x1`. New
  `mobile/constants/avatars.ts` holds a generated static `require()` map — Metro resolves
  `require` at build time from a string literal, so a computed path silently fails to
  bundle and throws on native; the file is generated, not hand-written. Keys keep their
  numeric prefix because five descriptive names repeat (two robots, two clouds, two cacti,
  two retro computers, two bubble teas). Wired into `app/profile.tsx` (picker) and
  `components/ProfilePanel.tsx` (the panel's 56px frame).
  **No data migration, on purpose.** `profiles.avatar` used to hold the emoji character
  and now holds an asset key. Existing rows keep their emoji, `avatarSource()` returns
  undefined for them, and both render sites fall back to drawing the stored string as
  text — so nobody's face vanishes in the release that changed the picker, and there is
  no half-finished backfill to go wrong. `isLegacyAvatar()` identifies them.
  **BUNDLE SIZE — the owner's question, answered with numbers.** The originals are
  512×512 RGBA, **15.9 MB** for the set, against a 5.1 MB JS bundle; Expo bundles
  everything under `assets/` into the binary and the web build, so shipping them raw
  would have more than quadrupled the download for art that never renders above 64pt.
  Committed at **128px** (2× the largest on-screen use, 3× the picker cell) and
  palette-quantized: **0.47 MB for all 102, ~4.5 KB each — 97% smaller**, no visible loss
  at render size (checked as a contact sheet at 40px on the dark canvas). In the built
  web output they are **0.45 MB of a 15.2 MB dist, about 3%**. Regenerate with
  `scratchpad/prep_avatars.py` if the source art changes; never drop 512px files in.
  **Runtime:** the picker mounts all 102 at once with no windowing — ~6–7 MB of decoded
  bitmap while that screen is open, freed on unmount. Fine on any recent phone; marked
  with a `ponytail:` note naming FlatList windowing as the upgrade if the set passes ~200.
  ✅ **RESOLVED — the IP avatars are deleted (owner, 2026-08-10).** On close inspection it
  was **ten**, not the eight first estimated: `19_tiny_green_creature` (Grogu),
  `20_blue_creature` (Stitch), `21_groot_like_plant` (Groot), `22_yellow_mouse` (Pikachu),
  `24_pink_blob` (Kirby), `25_blue_turtle` (Squirtle), `26_fox_rabbit` (Eevee),
  `27_pink_cat` (Mew), `35_game_controller` (Xbox trade dress) and `36_gameboy` (Nintendo
  hardware). **92 avatars remain, 0.42 MB.** Judgement calls that were KEPT, for the
  record: `14_lucky_cat` (maneki-neko is traditional), `12_shiba` (a real dog breed),
  `36_axolotl` (a real animal), `31_vr_gamer` and `29_robot`/`32_pixel_hero` (generic).
  ⚠️ **Withdrawing keys created a trap that is now closed.** `isLegacyAvatar` used to mean
  "not in the map", which after this deletion also matched a withdrawn key — so a user who
  had picked Pikachu would have had the literal string `22_yellow_mouse` printed in their
  avatar frame. It now tests the value's SHAPE (`^\d+_`), so a withdrawn key falls through
  to the neutral user icon and only real emoji render as text.
  ⚠️ **Not visually verified in-app:** the picker and the panel both need a signed-in
  session and the preview browser's session expired mid-session. Typecheck, web export
  and the rendered contact sheet all pass; **owner should do a visual pass.**
- [x] **Library header: profile picture + name, and the doubled rule removed (2026-08-10)**
  1. **The face is on the library page**, left of the wordmark, with
     `displayName · N saved` beside it. No new fallback logic was written —
     `AuthContext.displayName` already resolves **nickname → first name → a name derived
     from the email**, which is exactly the rule asked for.
  2. **The avatar is a control**, not decoration: tapping it opens the same profile panel
     as the hamburger. An avatar that looks tappable and isn't is the more annoying
     option, and it is where every other app puts the way into your account.
  3. **`brandRow` gained `flex:1, minWidth:0`** — load-bearing. Without it a long nickname
     pushes the menu button off the right edge instead of ellipsizing in its own column.
  4. **The extra line under the rolling tagline is gone.** A full-bleed `<Rule/>` sat
     directly beneath the roll's own inset bottom hairline: two rules, 1px apart, at
     different widths. The roll keeps its own line and its 42px footprint, so the grid
     below does not shift.
- [x] **Avatars load faster — the honest fix (2026-08-10)** — `fadeDuration={0}` on all
  three render sites. React Native's `Image` fades in over **300 ms on Android by
  default**, and across a 92-cell grid that reads as "the picker is loading slowly" when
  the bytes are already in the binary. ⚠️ There was **no download to optimise**: these are
  bundled 4.5 KB assets, not network fetches, so anything else (a CDN, prefetching, a
  caching image library like `expo-image`) would have been ceremony around a non-problem.
  The remaining cost is decode, which is why the unwindowed picker still carries its
  `ponytail:` note.
- [x] **Avatar picker: all 92 show instantly, and the batching is deleted (2026-08-11)**
  Opening Edit Profile now renders **every** face on the first frame. The grid had been
  mounting 24 at a time on a 250 ms timer, justified by an in-code note claiming a single
  avatar took **10.9 s** (median 12.4 s) under 92-way request contention on Metro.
  ⚠️ **That number does not reproduce, and the staggering was the actual cause of the
  complaint.** Measured in the preview browser against the Metro dev server, all 92
  distinct files, cache-busted and cold: **257–285 ms wall clock for the whole set**
  (median 150–174 ms, p90 263 ms). Off by roughly **40×**. The waves bought nothing and
  cost the requirement — you saw 24 faces and waited ~1 s for the rest. On iOS/Android it
  was never arguable at all: `require()`d PNGs are compiled into the binary, so mounting
  an `<Image>` is a disk read with no HTTP request to contend for.
  **The real cost was re-rendering, not loading.** The three name fields keep their value
  in `ProfileScreen` state, so every keystroke re-rendered all 92 cells — each allocating
  a fresh `Animated.Value` inside `<Pressable>`. A memoised `AvatarCell` plus a stable
  `useCallback` handler fixes it. **Verified by instrumenting the render count in the
  browser, then removing the instrumentation:** 92 renders at mount, **0 across 8
  keystrokes**, and **exactly 2** per selection (the face you left and the face you
  picked). Previously 8 keystrokes cost ~736 cell renders.
  **A sprite sheet was measured and rejected.** One 1280×1280 quantized PNG is 310 KB vs
  412 KB for the 92 files and would be a single request, but it needs a generated binary,
  a generator script, a second quantization pass over the art (mean RMS 7.9) and a
  refactor of four render sites — to save ~200 ms on a **dev server**, on a platform that
  is not the shipping target. Rung 1: it does not need to exist.
  ⚠️ **Fixed a real data bug found on the way.** `updateProfile` merges into existing
  metadata and ships it as JSON, and `JSON.stringify` **drops undefined keys** — so
  clearing your nickname or deselecting your avatar sent a payload that simply omitted
  the field. Supabase merged nothing, the old value stayed on the server, and it came
  back at the next token refresh while the local session claimed it was gone. `Profile`
  fields are now `string | null` and the screen sends **null** to clear. This was a
  silent partial state, i.e. quality-bar #3.
  **Selection is now visible.** It was carried by border weight alone — 0.5 px vs 1 px on
  a 48 pt tile in a grid of 92. A filled tick badge (ink block, background-coloured
  glyph — the system's existing filled-control grammar, no new hue) marks the chosen one.
- [x] **To-do dashboard: the face and the name moved onto it (2026-08-11)**
  The daily-goal card carried an unattributed statistic. It is now a two-column head —
  the picked avatar on the left (tappable, opens the profile panel via the same
  `emitUi('openProfile')` every other entry point uses), `displayName` and the goal bar
  stacked on the right. Nothing duplicates the hero above it: that rolls through **names
  for the list** ("Order of the Day", "Docket"), never the user's own name.
  The head renders unconditionally and only the bar inside it is gated, so switching the
  daily goal off (`TodoGoalBar` returns null) leaves a clean identity row rather than a
  dangling face. `minWidth: 0` on the right column is load-bearing — without it a long
  nickname shoves the `1/5` count off the right edge instead of ellipsizing.
  **New `components/Avatar.tsx`** holds the three-state fallback (asset key → legacy emoji
  as text → neutral user icon) that had been inlined at three call sites; this was the
  fourth. The emoji branch is the reason it is worth a component — it is exactly what a
  fifth copy would drop, and dropping it makes a pre-2026-08-10 user's face vanish.
  ✅ **The three original sites are converted too (2026-08-11).** `app/index.tsx`,
  `components/ProfilePanel.tsx` and `components/MascotLoader.tsx` now all render
  `<Avatar>`; their `hAvatarImg`/`hAvatarEmoji`, `avatarImg`/`avatarEmoji` and
  `face`/`faceEmoji` styles are deleted along with the `Image`/`avatarSource`/
  `isLegacyAvatar` imports each no longer needs. Four call sites, one implementation.
  ⚠️ **A size-only API was NOT enough, and assuming it would have shipped a silent
  visual regression.** The old per-site values were hand-tuned and do not sit on one
  ratio — the fallback glyph gets proportionally *smaller* as the frame grows
  (0.529 at 34pt, 0.500 at 48pt, 0.463 at 82pt). The component's 0.5 default reproduces
  ProfilePanel exactly (24) but would have rendered the header at 17 instead of 18 and
  **the to-do loader's face at 41 instead of 38 — 8% larger, on the biggest and most
  visible instance in the app.** Measured in the browser, not eyeballed. `Avatar` now
  takes an optional `iconSize`; `index.tsx` passes 18 and `MascotLoader` passes 38, and
  a re-measure confirms 18 / 24 / 38 — byte-identical to before the refactor. Fitting a
  curve to three hand-picked points would have been worse than one optional number.
  New surfaces (the to-do dashboard head) just omit it and take the ratio.
  **Verified per screen, not assumed:** library header (34 in its 40 frame), profile
  panel (48 in 56), and the loader (82 in a 96 frame, confirmed still 82×82 so the
  bobbing MotiView's layout box is unchanged — it was the one real risk in the swap).
  The loader was caught by stalling its fetch in the page for 20 s rather than hoping to
  screenshot a fast local backend mid-load.
- [x] **To-do screen: mascot loader replaces the bare spinner (2026-08-10)**
  `app/todos.tsx` showed a centred `<ActivityIndicator>` while waiting on a backend that
  cold-starts on Render's free tier — a spinning circle for what can be tens of seconds.
  New `components/MascotLoader.tsx`: the user's **own profile picture** bobs in the
  hairline square frame, and on completion two mirrored `thumbs-up` glyphs spring in
  either side with the same ring burst the task tick uses.
  **Motion is borrowed, not invented** — spring `damping:11 / stiffness:220` and the
  520 ms expanding ring are lifted from the existing task-completion animation in the
  same file, so the screen has one vocabulary rather than two competing ones.
  ⚠️ **Asked for as an animated GIF; built in code**, for the reasons the login wall's
  animation was: a GIF is fixed-size, block-compressed, can't follow the colour scheme,
  and would need **one variant per avatar (92)** to work here at all.
  ⚠️ **The "two hands" are Lucide glyphs, not artwork, and that is a compromise.** The 92
  avatars have no thumbs-up pose, no image-generation tool exists in this environment, and
  Canva was re-checked and is still raster-only with transparent export paywalled. Thin
  monochrome line icons beside a filled illustrated character **do not match in style and
  cannot be made to** in code. The real fix is one commissioned 128px transparent hand in
  the avatar art style, mirrored with `scaleX:-1` — ~4.5 KB, drops straight into the
  existing pipeline. `'thumbs-up': ThumbsUp` added to `Icon.tsx`.
  **Three guards, two of which were defects caught in review:**
  1. **Never celebrates a failure.** `setLoading(false)` lives in `finally`, so a failed
     fetch flips the same flag — gating on `loading` alone put a thumbs-up on screen with
     an error banner underneath. Now decided inside the `try`.
  2. **Never celebrates an empty list.** A thumbs-up over "Nothing to follow through on"
     reads as sarcasm on a first run.
  3. **Never fires on a fast load** (`CELEBRATE_AFTER_MS = 900`), and the mascot itself
     doesn't render for the first 350 ms — a warm backend answers in ~300 ms and the flash
     read as a rendering glitch, not warmth.
  **The most useful part is the least decorative:** past 2500 ms the loader says *"Waking
  the server — this can take a few seconds"*. Silence during a cold start is what makes it
  feel broken. Quality bar #1.
  **Verified live** on the real to-do screen: 200 ms → nothing (flash guard), 600 ms →
  mascot + "GETTING YOUR SLATE", 3000 ms → cold-start line, and the completion beat with
  both hands mirrored correctly. An empty fast load went straight to the list with no
  celebration, as designed. Typecheck + web export clean.
  ⚠️ **RESEARCH SAYS THIS REWARDS THE WRONG EVENT — worth a decision.** Refero has no task
  app that celebrates a fetch: Todoist Zero, Apple Books' Daily Goal, Opal, Drops all
  attach celebration to something the **user** did, and all have a dismiss control. This
  screen already owns a genuine reward — the spring tick + ring on completing a task.
  Firing a bigger version of that same gesture for a page load risks teaching the user it
  means nothing. **Recommendation: keep the bob (a clear win over a spinner), and move the
  two-handed thumbs-up to the daily-goal-met moment in `TodoGoalBar.tsx`**, where `hit ===
  true` currently gets only a label change. Same component, fires ~once a day, and means
  something. Owner's call.
  ⚠️ **Also flagged, not done:** the loading state still blanks the WHOLE screen (hero,
  dashboard, bottom bar all unmount). Asana's two loading screens in the reference set
  both keep their chrome and swap only the list region — a bigger perceived-speed win than
  the mascot, and it would make the handoff free rather than merely cheap.
- [x] **Avatar picker load time — measured, root-caused, fixed (2026-08-10)**
  ⚠️ **My previous answer here was wrong and the owner was right to push back.** The note
  said `fadeDuration={0}` was "the whole speed fix" and there was "no download to
  optimise". Measured in the browser instead of assumed:
  **before — 23 requests done after 18 s wall, median 12.4 s each, for 110 KB total;
  a single 1 KB avatar fetched alone took 10.9 s while the grid loaded.**
  That is not bandwidth and not decode. Mounting all 92 cells fires 92 asset requests at
  once, which saturates the Metro dev server (and on web the browser only opens ~6
  connections per host, so the rest queue). These ARE network fetches on web — in dev and
  in an exported build alike.
  **Fix: stop asking for all of them at once.** `app/profile.tsx` mounts images in waves
  of 24 every 250 ms; cells past the frontier still render their frame so nothing
  reflows, and the currently-selected avatar always mounts wherever it sits so your own
  face is never an empty box.
  **After, measured the same way: 35 avatars painted at 1 s** (vs. essentially nothing for
  12+ s), 41 at 3 s, 48 at 6 s, 60 at 10 s. `requests === painted` at every checkpoint, so
  nothing is stalling. The full set now takes marginally longer end-to-end; what the user
  can see arrives ~12× sooner, which is what "loads faster" means here.
  ponytail: still a plain grid, not a virtualized list — a nested vertical FlatList inside
  the page's vertical ScrollView breaks virtualization and warns, so it would have been
  ceremony for no gain. If the set passes ~200, restructure so the grid owns its own
  scroller, then FlatList + numColumns is right.
- [x] **Thumbs-up moved from the loader to the daily goal (owner, 2026-08-10)**
  The two-handed thumbs-up now fires in `components/TodoGoalBar.tsx` when the user
  **crosses** their daily goal, not when a fetch returns. Reasoning, which the research
  supports: no task app in the reference set (Todoist Zero, Apple Books' Daily Goal, Opal,
  Drops) celebrates a network response — every celebration is attached to something the
  person did. And this screen already owns a real reward gesture in the task tick, so
  spending a bigger version of it on a page load taught the user the gesture meant nothing.
  ⚠️ **It fires on the CROSSING, not on `hit` being true.** `wasHit` starts `undefined`, so
  re-opening the screen with the goal already met is correctly not an achievement. Holds
  1.8 s beside the count, springs in with the same `damping:11 / stiffness:220` as the tick,
  right hand mirrored with `scaleX:-1`, and degrades to opacity-only under reduce-motion.
  The `goal <= 0` early return moved BELOW the hooks — above them it would change hook
  order the moment the goal was switched off in settings.
  `MascotLoader` lost its `done` phase entirely and is now loading-only: bob, caption, and
  the cold-start line. **Do not reintroduce a completion beat there.**
