# SaveHere — Production Checklist

Open work only. Everything shipped, decided or closed lives in
[`docs/SHIPPED.md`](docs/SHIPPED.md) — nothing was deleted when this file was
condensed on 2026-09-07, it was moved.

**Current state:** backend live at `https://savehere-api-staging.onrender.com`
(Render free tier, CI-gated auto-deploy from `develop`, `savehere-dev` Supabase +
Postgres). **334 backend tests pass.** Prod is deliberately not deployed — its
service is commented out in `render.yaml`.

| Legend | |
|---|---|
| `[ ]` | not started |
| `[~]` | partially done — the remaining half is stated |
| 🔴 | blocks launch |
| 👤 | needs the owner, not code |

---

## ▶ STAGING OUTAGE 2026-09-07 → 09-09 — two days down, nothing said why

`savehere-dev` hit Supabase's **free-tier 7-day idle pause**. `create_tables()`
runs `alembic upgrade head` in the startup hook, so it raised `OperationalError`,
uvicorn exited status 3, and Render crash-looped — keeping the last-good build
live while every new deploy died. From outside it looked like nothing: TLS
connected, no HTTP response, **no error anywhere**. Diagnosis needed a Render
deploy log plus a local repro of the migration.

**Restored 2026-09-09, data intact** (PostgreSQL 17.6, 10 tables, 174 reels).

Fixed in the same pass:
- **Startup now fails loudly.** `create_tables()` logs `[STARTUP] DATABASE
  UNREACHABLE at <host>`, names a paused/deleted project when the error looks
  like one, and lists the three things to check. It still re-raises — a backend
  that cannot reach its database must not come up and answer requests.
- **Dependencies pinned.** Eight were `>=`, so Render installed whatever was
  newest: **anthropic 1.4.0** against a local **0.111.0** (a major bump) and
  **openai 3.8.0** against **2.43.0**. Tests never caught it because they mock
  the AI clients — the untested majors only ever ran in production. `yt-dlp`
  stays floating on purpose; stale yt-dlp silently rots extraction.

### ⚠️ Standing risk — this recurs
The free tier pauses again after **7 idle days**. Either accept it and unpause
when staging is needed, or move to Supabase Pro. Prod needs Pro regardless (see
the blocker below) — free has no backups, and this time the data survived only
because a pause is reversible. A deletion would not have been.

---

## ▶ OTA CHANNEL — current runtimes (updated 2026-10-09)

Builds fired 2026-10-07 from `4f73d74` (#131, RevenueCat). **Both runtimes moved again**,
because `react-native-purchases` is a native module. An update published from `develop`
reaches only these two builds, and a mismatched update does not warn.

| Platform | Runtime | Build | Previous |
|---|---|---|---|
| iOS | `a341cf3cd345fae578dff966680f913867d5d272` | 1.0.14 (submitted 2026-10-09) | `01741a6e…` (1.0.13) |
| Android | `7bc09f03530ecf95866038dea56d20c9ee15a095` | build 15 (versionCode 15) | `7bc363b6…` (build 14) |

### ⚠️ A BACKPORT CAN REACH AN OLDER BUILD, AND IT IS NOT A HACK

On 2026-10-09 the owner was stranded on 1.0.13 for two days while #137/#138 sat on a
runtime nothing could install. The fix: **JS is not in the fingerprint**, so checking out
the commit the stranded build came from and copying the JS-only change onto it produces a
tree that fingerprints as that build's runtime.

```bash
git checkout -b tmp/backport <commit the build was made from>
git checkout <develop commit> -- <the JS files only>
npx eas-cli@latest fingerprint:compare --build-id <the stranded build>   # MUST match
npx eas-cli@latest update --channel preview --environment preview --platform ios -m "..."
```

The `fingerprint:compare` step is the gate — if it does not match, abort. Use this only to
unstick someone; the update is superseded the moment the newer build installs, so never
build on it. Verify the files have not diverged first (`git log <old>..<new> -- <files>`).

### ⚠️ "SCHEDULED" IS NOT "SUBMITTED" — TWO SILENT FAILURES IN ONE DAY

2026-10-09: an iOS submission was reported as queued and **never reached App Store
Connect**, twice, costing an afternoon of debugging the wrong layer.

1. **The Expo MCP connector's `build_submit` returned `IN_QUEUE` and delivered nothing.**
   It has no `--wait`, no status readback, and `build_info` does not carry submission
   state — the failure is invisible from inside a session. **Submit with the CLI and
   `--wait`.** `✔ Submitted your app` is the success line; `✔ Scheduled iOS submission`
   means nothing yet.
2. **The root cause was a revoked App Store Connect API key.** `8956SRK96D`
   (`[Expo] EAS Submit QVRCA5LiDi`) was revoked on 2026-10-07 during RevenueCat setup,
   while EAS kept using it. Apple answered 401 and EAS reported "Something went wrong".
   Replaced via `eas credentials --platform ios` with `XUYH77BDX6`, which RevenueCat also
   uses — **so revoking that key now breaks submissions AND billing.**

**Always confirm in App Store Connect → TestFlight → Build Uploads.** That list is the only
thing that proves a binary arrived.

### ⚠️ NOTHING CAN SEE WHAT BUILD A DEVICE IS RUNNING

EAS Observe returns empty for this project — no telemetry SDK is installed — so
`observe_versions` cannot tell you what is in the field. The in-app `v1.0.0` in
ProfilePanel is a hardcoded constant and is useless for this. Ask, or read it from
TestFlight. The update button in the profile panel is the practical tell: it renders only
when the server has something for that runtime, so **no button means mismatch**.

⚠️ **The Android runtime moved because of an iOS-only file.** `withInvisibleShareIOS.js`
is a config plugin, and config-plugin files are hashed for every platform — predicted by
`fingerprint:compare` on 2026-09-25 (`7bc363b6…`) and confirmed as the value EAS computed
for this build. See mobile/AGENTS.md.

Before every `eas update`, confirm the local project still computes the installed
build's runtime:

```bash
cd mobile && npx eas-cli@latest fingerprint:compare --build-id <build id>
```

⚠️ **Use `fingerprint:compare`, not `fingerprint:generate`.** `compare` prints both
values and names the differing source; `generate` gives a number with nothing to check it
against, and on this machine (`core.autocrlf=true`) it returned three different values for
one commit on 2026-09-24.

⚠️ **Builds and updates should be run from the SAME machine** — a build from a Linux
cloud session and an update from this Windows checkout can disagree about identical
source.

⚠️ **THE FINGERPRINT DOES NOT SEE `mobile/plugins/android/ShareSave.kt`** (measured
2026-09-25: editing it left the Android runtime unchanged). That is the trap running
backwards — the update applies happily on top of a stale native share service. A matching
fingerprint proves an update will REACH a build and nothing about whether the native half
of the change is in it.

Update the table above whenever a build ships — a stale runtime here is how a session
publishes an update that reaches nothing.

## ▶ 1.0.12 FIELD TEST — two bugs, and only one of them can be fixed over the air

Owner testing 1.0.12 on 2026-09-25.

- [x] **Android announced `“null” is in your library`** — fixed, shipped in Android
  build 13, and **confirmed working on device by the owner 2026-10-04**. It needed a
  build, not an OTA. `postSave` in `mobile/plugins/android/ShareSave.kt` read the title with
  `optString("title", "")`, and **Android's `org.json` returns the literal string
  `"null"` for a JSON null**: a JSON null is stored as the `JSONObject.NULL` sentinel,
  which is not Java null, so the `""` fallback never fires and `String.valueOf(NULL)`
  comes back. Fixed with `jsonText()`, which checks `isNull` first, on both the `title`
  and the `detail` parse.
  ⚠️ **Instagram was guaranteed to hit it.** The server has no title to give for
  Instagram (its datacenter IP gets the login wall) and the NATIVE share path has no
  device-side metadata fetch to make up for it — so the most-shared platform was the one
  that always read as broken. With the fix it says "Your Instagram link is in your
  library. The summary is being written."
- [x] **The reminder time picker was invisible** — ships over the air. The six `07:00`
  chips were the children of a `Row`, which gives its children whatever space is left
  beside a `flex: 1` label: ~264dp on a 360dp phone, minus the label, for ~320dp of
  chips. They ran off the card and the word "At" collapsed into a vertical sliver, so the
  setting looked absent. Now full width under the toggle, the same shape as DAILY GOAL.
  ⚠️ The row only exists **once the Reminders switch is on** — that is deliberate, not
  the bug.
- [ ] **A task has no time of its own, only a date** (`Todo.due_date` is `YYYY-MM-DD`).
  So "remind me at 3pm about THIS task" is not possible today: there is one daily time
  for the whole digest. Per-task times mean a backend column + migration, a time control
  in the editor, and one notification per task instead of one per day — which is the
  thing `services/todoDates.ts` deliberately avoids. Decide whether it is wanted before
  building it.
- [x] **iOS silent shares now report the OUTCOME** — built 2026-09-25, needs an iOS
  build to reach a device. See the entry further down for the mechanism; the short
  version is that it needed no `withAppDelegate` plugin at all, because Expo already
  forwards `handleEventsForBackgroundURLSession` to app-delegate subscribers.


## 🔴 Launch blockers

- [x] 🔴 👤 **Apple Developer account — $99/year.** Enrolled as **Individual**, Team ID
  `G28LWZ4B23`, renews 2027-09-02; **Small Business Program accepted** (15%, not 30%).
  Unblocked real-device testing, TestFlight and Sign in with Apple.
- [ ] 👤 **Production email SMTP — NO LONGER A BLOCKER** (owner, 2026-09-13: sign-in is
  **Google and Apple only**, no email signup). Nothing transactional is sent, so
  Supabase's ~2–4/hour built-in sender is enough for the handful of legacy test accounts.
  Wire real SMTP only if email auth ever comes back. Free tiers when that day comes:
  **Resend** (3k/mo, best DX), **Brevo** (300/day), **SendGrid** (100/day); the real
  prerequisite is a **verified sending domain** (SPF + DKIM), so buy the domain first.
  - [x] **Email/password removed from `mobile/components/LoginScreen.tsx`** (owner,
    2026-09-23: "remove completely the email part"). The whole second step went with it —
    sign-in/create-account modes, the password-strength meter, the profile-name fields,
    and both `supabase.auth.signInWithPassword` / `signUp` calls. The screen is now one
    step: Apple (iOS) and Google. The "legacy … being retired" sentence is gone from
    `site/privacy.html` §2 in the same commit, so the policy and the app agree again.
  - [x] 👤 **Email provider switched OFF in Supabase Auth → Providers** (owner,
    2026-09-23). This is what makes the removal real: `/auth/v1/signup` no longer accepts
    an email and password, so the service can no longer mint accounts the app has no
    screen to sign into, and the Privacy Policy's "You sign in with Google or Apple" is
    now true of the service as well as the app. ⚠️ **Re-check it on the prod project
    (`lukmwwcilrjqqtgqbynq`) at the move** — provider settings are per-project, and a
    fresh project ships with Email ON by default.
  - [x] **The 3 dev test accounts are stranded, and that is accepted** (owner,
    2026-09-23: "test accounts don't matter"). They signed in with a password; no screen
    takes one now. If staging logins are ever needed again, make them through Google with
    a `you+test1@gmail.com` alias — ⚠️ signing in with the SAME address as an old
    password account does NOT recover it, it creates a second, empty user row.
  - ⚠️ **The cost of Google/Apple-only — now REAL, not hypothetical** (shipped
    2026-09-23): on Android there is exactly ONE door. Apple sign-in is iOS-only (it needs
    the native `expo-apple-authentication` flow), so if Google OAuth breaks — consent
    screen misconfigured, client secret rotated, project suspended — every Android user
    is locked out with no fallback and no password reset to fall back on. Watch item, not
    a task; the mitigation if it ever bites is a magic-link, which needs the SMTP above.
- [ ] 🔴 👤 **Decide the extraction egress question BEFORE prod goes live** (owner,
  2026-09-23: "keep this as important task before production live"). SSRF on the save
  path is closed both ways in code — host matching on the submitted URL, and every
  redirect hop re-checked — but **yt-dlp does its own networking with no host policy we
  can hook**, so an open redirect on a major platform could still send it at an internal
  address. Today that reaches nothing (one Render service, no private network, no
  internal-only endpoints, Supabase on the public internet behind a credential), which is
  why it is not fixed yet. **This item is the checkpoint, not the work:** at the prod
  cutover, answer "what can our server reach that the public cannot?" — if the answer is
  still "nothing", write that down and move on; if prod adds a second service, a private
  network or a cache, the egress allowlist ships with it. Full reasoning under
  "Pre-launch security pass" below.
- [ ] 🔴 👤 **Apply `backend/scripts/enable_rls.sql` to the PROD Supabase project**
  (ref `lukmwwcilrjqqtgqbynq`) **on the day you point the app at prod** (owner,
  2026-09-13: everything is on dev today, so this waits for the move). Needs prod
  credentials. ⚠️ **Tie it to the move, not to "later"** — the failure mode is pointing
  the app at prod on a Friday and leaving every table world-readable to the publishable
  key that ships inside the app bundle. It belongs in the same checklist item as
  switching `EXPO_PUBLIC_API_URL`, not in a separate one you can forget.
  `savehere-dev` was verified closed 2026-08-10 — every table `relrowsecurity` and
  `relforcerowsecurity` true with zero policies, proven from outside with the
  publishable key that ships in the app bundle. Prod has **not** had this applied.
- [ ] 🔴 👤 **Prod deploy prerequisites.** Uncomment the prod service in `render.yaml`,
  set its `sync:false` env vars (**`DATABASE_URL` in EACH service** — unset means
  ephemeral SQLite and silent data loss), including `YOUTUBE_API_KEY`, and enable
  Supabase Pro (free tier pauses after 7 days idle and has no backups).
- [ ] 🔴 👤 **Google OAuth consent screen → "In production".** Code is complete
  (`mobile/services/oauth.ts`). While the screen sits in **Testing**, only listed test
  accounts (max 100) can sign in; everyone else gets "Access blocked: SaveHere has not
  completed the Google verification process". This is independent of EAS distribution —
  a tester can install the APK fine and still be refused at the Google button.
  Publishing should be instant because only `email`/`profile`/`openid` are requested,
  all non-sensitive. ⚠️ **Two traps on that screen:** never click **"Make internal"**
  (restricts sign-in to a Workspace domain, locking out every Gmail tester), and **do not
  upload a logo** (triggers Google's multi-day brand verification — the one way to land
  in review despite non-sensitive scopes). Setup also needs: OAuth client of type
  **Web application** (not Android — the callback is Supabase's URL), redirect URI
  `https://ymclmbmmwtczspnmccsy.supabase.co/auth/v1/callback`, client ID + secret into
  Supabase → Auth → Providers → Google, and `savehere://auth/callback` under Auth →
  URL Configuration. **Cost: none** at any volume this app will see.
  - [ ] 👤 **Set "App name" to Findable on that same screen** (owner report, 2026-09-11:
    the Google account chooser reads "continue to `<project-ref>.supabase.co`"). The
    heading follows **App name**; the small print under it is the *authorized domain*,
    which is Supabase's because the OAuth callback is. Free, and no logo — see the
    verification trap above. Removing the domain line entirely needs one of:
    (a) a Supabase **Custom Domain** add-on (paid, ~$10/mo, gives `auth.findable.app`),
    or (b) **native** Google sign-in (`@react-native-google-signin/google-signin` +
    `signInWithIdToken`, no browser at all, mirroring what Apple already does). (b) is a
    new native module → a new build + iOS/Android/Web client IDs, so it rides along with
    the next native build rather than forcing one. Not worth either for a string today.
- [~] 🔴 **Sign in with Apple.** Code done (`expo-apple-authentication` +
  `signInWithIdToken`, iOS-only, see `services/oauth.ts`). **NO Services ID and NO `.p8`
  key** — the native ID-token flow needs neither, which also removes the 6-month secret
  rotation listed under Traps. Remaining, both 👤:
  1. The App ID `com.savehere.app` does not exist in the portal yet. **EAS creates it and
     syncs the Sign In with Apple capability on the first iOS build** — no manual step.
  2. Supabase → Auth → Providers → Apple → enable, Client IDs = `com.savehere.app`,
     Secret Key **empty**. Do this in **BOTH** projects (dev `ymclmbmmwtczspnmccsy`,
     prod `lukmwwcilrjqqtgqbynq`) — the config is identical, Apple's side is per bundle
     ID, not per environment.
  ⚠️ **Guideline 4.8 binds at iOS review, not on Android** — Google-only is fine for the
  Android builds; an iOS build must not ship with Google present and Apple absent.
- [x] 🔴 **Share sheet — Phase B (invisible Android share).** Built 2026-08-13 on
  `feat/android-invisible-share`, and **confirmed on device by the owner** — silent share
  from Instagram stays in Instagram, the save lands, and the result notification names the
  reel (builds 12 and 13, 2026-09-24 → 10-04). A translucent `ShareActivity` (config plugin
  `mobile/plugins/withInvisibleShare.js` + one Kotlin file) receives `ACTION_SEND`, hands
  the URL to a foreground service and finishes, so the app never flashes.
  ⚠️ Auth uses a **save-scoped share key** (`backend/app/sharekey.py`), not a mirrored
  Supabase token — those expire in ~1h and refreshing from Kotlin would revoke the
  refresh token and sign the user out. ⚠️ `share_key_tier` + `share_key_subject`
  snapshots are load-bearing: without them a Pro user's silent share is entitled as free
  and charges a different daily bucket. ⚠️ Costs a `FOREGROUND_SERVICE_DATA_SYNC`
  declaration in the Play Console at launch.
- [x] 🔴 **Share sheet — Phase A (iOS).** Android 2026-08-12, iOS verified on device
  2026-09-13 (`expo-share-intent@7`, wired in `mobile/app/_layout.tsx`). ⚠️ The rule it
  taught stands: **a native module cannot ship by OTA** — Findable appears in the share
  sheet only after an EAS build is installed.

---

## iOS share — invisible, like Android

- [x] 🔴 **iOS Share Extension saves without opening the app.** Re-enabled 2026-09-10
  after four builds, owner-verified on device 2026-09-13 (see below). The traps are kept
  because every one of them cost a build slot. ⚠️ **`./plugins/withInvisibleShareIOS` MUST be listed BEFORE
  `expo-share-intent` in `app.json` — that looks backwards and is not.**
  `@expo/config-plugins` runs mods in **reverse** registration order
  (`withMod.js:199` runs this plugin's action, *then* `nextMod`), and
  expo-share-intent writes `ShareExtensionViewController.swift` in its own
  `withXcodeProject` mod. Registered after it, ours ran before the file existed and
  threw "found 0".
  ⚠️ **The generated file is `ShareViewController.swift`, NOT
  `ShareExtensionViewController.swift`.** The template inside `node_modules` carries the
  longer name; `constants.js:8` (`shareExtensionViewControllerFileName`) writes the
  shorter one. Searching for the template's name finds nothing, ever.
  ⚠️ **The error text only ever existed on expo.dev.** `eas build:view --json` returns
  `UNKNOWN_ERROR`, the CLI does not stream phase logs, and the downloadable log is
  encrypted at rest. **Read the Prebuild phase on expo.dev before theorising** — five
  build slots went to guessing at an error nobody had read.
  ⚠️ **A local harness that builds its own fixture can validate your mistake instead of
  catching it.** The harness created the fake Swift under the *template's* name, so it
  "passed" against the same wrong assumption the plugin held. Fixture names must come
  from the library's own constants, never retyped.
- [x] 👤 **Verified on device 2026-09-13** (owner): shared from Instagram, YouTube **and
  LinkedIn** with Silent share on — stayed in the source app, the app never opened, the
  save landed. The iOS half of the invisible share is done.

## 🔴 Monetization — required before launch

- [x] **Save caps are per tier: 50 free, 500 trial/pro** (owner, 2026-09-11).
  Replaces 20-on-free with **unlimited** above it — an unlimited storage promise
  is one you cannot price and cannot budget for. Trial gets the PAID number on
  purpose: a trial that quietly caps at the free number teaches the wrong thing
  about the product. `FREE_SAVE_LIMIT` / `PRO_SAVE_LIMIT` in
  `backend/app/config.py`, both env-overridable.
  The client warns at 90% and interrupts once per session at 95%
  (`mobile/services/saveQuota.ts`). ⚠️ **Thresholds are RATIOS, never literals** —
  they were authored against a 1000 cap that lasted an hour and needed no change
  when it became 50/500. Keep them that way.
  The upsell is **tier-aware** in both places (server 403 and client alert):
  free is offered Pro, trial and pro are not, because they already hold 500.
- [x] **The trial cap is 100, not 500** (owner, 2026-10-06) — `TRIAL_SAVE_LIMIT`,
  env-overridable, in `render.yaml` for both services. ⚠️ **This REVERSES part of the
  2026-09-11 decision** that the trial should carry the paid cap. That argument was "a
  trial that caps at the free number teaches the wrong thing about the product", and
  it was right about AI limits and wrong about storage: 500-on-trial against
  50-on-free let someone build a library the free tier could not hold, so the most
  engaged trial users — the cohort most likely to convert — landed hardest the day it
  ended. The trial still keeps the PAID AI limit, because that is what paying feels
  like. 2x leaves a cliff a person can climb down; 10x did not.
  - **Warned at the free limit, not at the trial limit.** Crossing 50 during a trial
    now says so once per session and in the library band: *"70 saves — 20 past the
    free limit of 50."* The cliff was never the bug; being told about it only
    afterwards was.
- [x] **The cliff LOCKS, it does not delete** (owner chose option 2, 2026-10-06).
  `backend/app/library_lock.py`: the newest `save_limit` saves stay open, everything
  older is read-only — still listed, still visible, still deletable — until the user
  deletes newer saves or upgrades. **Nothing is ever deleted.** Every lock is
  reversible by an action the user can take, and raising the cap unlocks the same rows
  with no migration and no restore.
  - ⚠️ **DELETE IS THE ONE OPERATION ALLOWED ON A LOCKED SAVE, and it has to be.**
    Deleting is how someone gets back under the cap; refusing it would make the lock a
    trap whose only exit is a purchase. `_get_owned_reel_or_404` refuses locked saves
    **by default** and `delete_reel` opts out explicitly — that direction is the
    load-bearing part, because an endpoint added later gets the safe behaviour without
    anyone remembering to ask for it. `test_DELETE_STILL_WORKS_on_a_locked_save`.
  - ⚠️ **Ask cannot answer out of locked saves.** Otherwise the lock hands back its
    own withheld content as prose, and charges an AI action to do it. Excluded in the
    QUERY, not filtered after.
  - ⚠️ **Locked saves still count toward the cap.** Locking does not free space, so
    the locked ones are the obvious things to delete. A lock that silently created
    room would be a second, invisible cap that the save gate disagreed with.
  - ⚠️ **The flag on a reel is a RENDERING HINT, not the enforcement.** The server
    403s a locked read regardless; a client that ignored `locked` must still be
    refused. `TestEnforcement` asserts that directly.
  - Ties at the boundary stay OPEN (strictly-older comparison), so a double-save in
    the same second can leave a library one or two over its cap. That is the direction
    an error has to go.
  - The tile keeps its picture under a scrim and a LOCKED badge rather than going
    blank — the point of locking instead of deleting is that the save is still there,
    and a blanked tile looks exactly like the deletion we chose not to do. Tapping it
    explains itself and offers the free exit first; a tile that silently ignores a tap
    is indistinguishable from a broken one.
  - 13 tests in `backend/tests/test_library_lock.py`; **369 backend tests pass.**
- [x] 👤 **DECIDED: the trial-end cliff locks rather than deletes** (owner,
  2026-10-06). Kept for the record because the rejected option was irreversible:
  The owner drafted warning copy promising *"once the trial overs you will lose older
  saves, only latest saves will be there"* (2026-10-06). **That behaviour does not
  exist and was deliberately not built** — it is irreversible destruction of content a
  user chose to keep, and the shipped warning says the opposite ("Nothing is deleted
  when your trial ends"), which is what the code actually does. A test asserts the
  copy cannot drift into threatening deletion. Three options, and this needs an
  explicit owner answer because two of them are one-way doors:
  1. **Keep today's behaviour** — nothing is deleted, new saves pause until they are
    back under the cap or go Pro. Free, shipped, honest. ⭐ Recommended.
  2. **Lock, do not delete** — saves past the cap stay in the library but greyed and
    unopenable, restored instantly by Pro or by deleting newer ones. Keeps the
    loss-aversion pressure without destroying anything, and it is what Dropbox and
    Evernote do. Costs real work: the list query, the detail screen, and Ask all need
    to know what is locked.
  3. **Delete the excess.** NOT CHOSEN. Strongest pressure, and the only one that
    cannot be undone. ⚠️ It destroys user content for non-payment, it will produce
    one-star reviews from people who did not read a notification, and it would need a
    genuine grace period plus an export before it could be defensible at all. The
    owner's drafted warning copy described this behaviour; it was never built, and the
    shipped copy says "nothing has been deleted", which is true.
- [x] **The trial→free cliff said the wrong thing, and it said it at the till**
  (owner spotted it, 2026-10-06: *"if he/she save more than 50 and after end of trial
  period, then logic fails right?"*). **The gate itself was always right** — the cap
  is enforced on NEW saves only, so nothing is deleted and the library stays fully
  usable. Three messages around it were wrong:
  - **Everything said "delete a few", which could be wrong by 150.** The trial allows
    `PRO_SAVE_LIMIT` (500); the day it expires the same library is measured against
    `FREE_SAVE_LIMIT` (50). Ten enthusiastic days at 200 saves leaves someone 151
    over, and "Delete a save to make room" sent them round a loop — delete one, retry,
    read the identical sentence, conclude the app is broken. ⚠️ **At the exact moment
    we are asking them to pay.** The 403 and `saveQuota` now compute `toDelete`
    (`used - limit + 1`, the +1 being room for THIS save) and name the number.
  - **`"200/50"` read as a rendering bug**, so the over-cap line is a sentence now:
    "200 saves kept, 50 allowed — delete 151 to save again." Exactly-full keeps its
    old `50/50` wording, which was never wrong.
  - ⚠️ **ProfilePanel promised trial users "20 saves"** — hardcoded, and 20 stopped
    being the free cap on 2026-09-11 when it became 50. A wrong PROMISE, in the one
    sentence that explains what happens when the trial ends, shown to every new user
    for three weeks. `/usage` now sends `after_trial: {save_limit, ai_limit}` and the
    client renders what it is told. **Both limits are env-overridable in
    `render.yaml`, so there is no version of this a client can safely guess** — the
    same rule `saveQuota.ts` has always stated about ratios.
  - A trial user already over the post-trial cap is now warned before the cliff
    rather than after it.
  - Covered by `test_over_cap_is_told_how_many_to_delete`,
    `test_usage_tells_the_client_the_post_trial_numbers` and the new over-cap cases in
    `saveQuota.test.ts`. 355 backend tests pass.
- [x] **The `FREE_SAVE_LIMIT=500` override is GONE** (owner, 2026-09-13). Staging now
  runs the real numbers: **free 50, pro 500**, both stated explicitly in `render.yaml`
  rather than inherited from `config.py`. ⚠️ **A free account that reaches 50 now gets a
  403 offering a product that cannot be bought** — and as of 2026-10-06 that library
  also **locks** rather than merely refusing new saves. That is the accepted trade:
  testing the real wall beats hiding it. The purchase flow behind the paywall is now
  built (see RevenueCat below); what is still missing is the store configuration, so the
  wall stops being acceptable the moment a real user is behind it.




- [ ] 🔴 **The PRODUCTION Supabase project is stale and under-hardened** (measured
  2026-10-07 by reading both projects through the Supabase connector). Staging is the only
  deployed environment, so all 9 real accounts and 294 saves live in `savehere-dev`; `SaveHere`
  (prod, `lukmwwcilrjqqtgqbynq`) has been untouched since the 2026-07-21 split. Full table in
  [`docs/ENVIRONMENTS.md`](docs/ENVIRONMENTS.md) → "Production database is stale".
  - [ ] **`alembic upgrade head`** against the prod pooler. Prod is at `9aa25548aadb` vs
    staging's `e5b8d2f41c07`, and the `todos` table **does not exist there at all**.
  - [ ] **Run `backend/scripts/enable_rls.sql`.** ⚠️ RLS is `ENABLE`d on prod but
    `FORCE` is applied to **0 of 9 tables** (staging: 9/9). That script's header is explicit
    that FORCE is the half that closes the hole — without it the table OWNER role still
    bypasses RLS, and the anon key ships inside every copy of the app. The `ensure_rls` event
    trigger does NOT cover this: it only ever calls `ENABLE`.
  - [ ] **Decide what happens to the 16 pre-split user rows in prod.** Nothing has signed in
    there since 2026-07-20. They are leftovers, not traffic — carry them forward or clear
    them, but deliberately.
  - ⚠️ **Nothing would have told you any of this.** Prod has no deployed service pointing
    at it, so no request has ever exercised it. It fails the first time it matters.
- [~] 🔴 👤 **RevenueCat — the CODE IS DONE (2026-10-07); what remains is
  dashboard work and two prices.** This is still the real gate on public launch: a free
  account at the 50-save wall is shown a paywall, and until the steps below are done
  that paywall cannot take money.

  ⏸️ **PARKED 2026-10-09 by the owner** — "resume later this week", to do features and
  cosmetic work first. Nothing below is blocked on a decision; it is all dashboard
  clicking and two prices. **Every credential is set and PROVEN**, so a cold session
  does not need to re-verify any of them:

  | credential | where | proof |
  |---|---|---|
  | `REVENUECAT_API_KEY` | Render (v1 secret) | `GET /v1/subscribers/<id>` → **201** |
  | `REVENUECAT_WEBHOOK_TOKEN` | Render + RC dashboard | RC's own test event → **200**; no/wrong header → 401 |
  | `REVENUECAT_PRO_ENTITLEMENT` | Render | `findable_pro`, matches RC exactly |
  | `EXPO_PUBLIC_RC_IOS_KEY` | EAS preview + production | `appl_…` public key, shipped via OTA |
  | EAS ↔ App Store Connect | ASC key `XUYH77BDX6` | `eas submit --wait` uploaded 1.0.14 |

  ⚠️ **`XUYH77BDX6` IS SHARED between EAS Submit and RevenueCat.** Revoking it breaks
  both, and the only symptom you get is "Something went wrong" from `eas submit`. That
  is how two days were lost on 2026-10-07–09.

  **Resume here, in this order:**
  1. Install 1.0.14 from TestFlight → **Restore purchases** → expect "Nothing to
     restore" (this is the #139 fix; it is the one thing that can be checked today).
  2. GAP 1 — fill `pro.weekly` + `pro.annually` in App Store Connect until
     `get-product-store-state` reports `ok`, not `MISSING_METADATA`.
  3. GAP 2 — create the monthly App Store product; decide the two intro prices.
  4. Attach the real products to `$rc_weekly` / `$rc_monthly` (does nothing before 2).
  5. Check the Paid Applications Agreement is signed, or nothing sells regardless.
  6. GAP 4 — Android needs a Play Console account ($25) and the app on a track.

  Cosmetic leftovers, safe to ignore: rename ASC key `XUYH77BDX6` to say that both EAS
  and RevenueCat depend on it, and delete the junk `nonexistent-test-user` RC subscriber
  created while probing the API.
  - [x] **SDK wired.** `react-native-purchases@10.11.0`, `services/billing.ts` wraps it
    and every export is safe to call when billing does not exist (web, no keys, SDK
    failed to init) — the paywall then renders read-only rather than crashing.
  - [x] **`Purchases.logIn(supabaseUserId)` at login** — `contexts/AuthContext.tsx`, on
    SIGNED_IN **and on cold start**, because a returning user never fires SIGNED_IN. This
    was precondition 1: without it a real purchase arrives at the webhook attached to
    nobody and the money is taken with no entitlement granted.
    - [x] ⚠️ **AND IDENTITY CHANGES ARE SERIALIZED, which was a real bug for a day**
      (found 2026-10-07 by RevenueCat's own `revenuecat-identify-user` skill, installed
      from their AI toolkit). RevenueCat's rule is `logOut()`, **wait for it**, then
      `logIn(newId)`; a direct swap **ALIASES the two app user ids**, so on a shared
      device one Supabase account's subscription can attach to another's. Supabase fires
      SIGNED_OUT and SIGNED_IN as separate events and neither call site awaits (the auth
      gate must not block on a billing SDK), so the order RevenueCat saw was whichever
      request returned first. `serialQueue()` in `billingPlans.ts` makes the ordering a
      property of the module; a rejected `logOut` (LogOutWithAnonymousUserError is
      normal) cannot wedge the queue behind it. The test was verified by sabotaging the
      queue and watching it report `['in','out']`.
  - [x] **Webhook registered** in `app/main.py`. ⚠️ Registration is safe because it is
    **fail-closed by configuration**, not by being unwired: the webhook 401s every call
    without `REVENUECAT_WEBHOOK_TOKEN` and `/sync` 503s without `REVENUECAT_API_KEY`.
  - [x] **`POST /api/billing/sync` — the purchase flow's actual grant path.**
    ⚠️ **THE WEBHOOK IS TOO SLOW TO BE A PURCHASE FLOW.** It lands asynchronously and
    the tier it writes only reaches the app on the next JWT refresh (≤1h), so without
    this a user who has just paid keeps seeing the free tier with a receipt in their
    hand. The app now calls `/sync` right after a purchase or restore; the server asks
    RevenueCat server-to-server, stamps the tier, and the app re-mints its session.
    ⚠️ **IT GRANTS BUT NEVER REVOKES.** `scripts/set_tier.py` is how the owner's own
    account and every test account became pro, and RevenueCat has never heard of those.
    A sync that downgraded on "no entitlement found" would wipe them the first time
    anyone tapped Restore. Only the webhook's EXPIRATION revokes.
    `test_sync_never_downgrades` is the test that keeps it that way.
  - [x] **The mock card form is DELETED** (`app/pro.tsx` is one page now). A form that
    looks real and does nothing is how someone types a real card into a dead field, and
    no TEST MODE banner is reliably louder than muscle memory. It also had nothing to
    do: digital goods go through StoreKit / Play Billing or they get rejected at review.
  - [x] **The store owns the price now.** `constants/pricing.ts` is the authored fallback
    and the copy source; once an offering loads, the displayed price is
    `product.priceString` and the renewal sentence is built by `storeTerms()`.
    ⚠️ **THE AUTHORED NUMBERS ARE CHOSEN BY DEVICE LOCALE; APPLE AND GOOGLE CHARGE BY
    THE ACCOUNT'S STOREFRONT.** An Indian phone signed into a US App Store was being
    shown ₹99 and would have been billed $7 — a refund request and a review rejection.
  - [~] 👤 **Dashboard work — STARTED by the owner 2026-10-07. Live state read through
    RevenueCat's MCP server the same day; see the snapshot and the four gaps below.**
    Remaining: `EXPO_PUBLIC_RC_IOS_KEY` / `EXPO_PUBLIC_RC_ANDROID_KEY` in EAS, and
    `REVENUECAT_WEBHOOK_TOKEN` / `REVENUECAT_API_KEY` / `REVENUECAT_PRO_ENTITLEMENT` on
    Render. ⚠️ The Render MCP connector exposes no env-var READ, so whether those three
    are set has to be confirmed in the dashboard by hand — the endpoints 401 either way,
    because they are fail-closed.

  - **📸 LIVE REVENUECAT STATE, read 2026-10-07 — a snapshot, it will drift.**
    Project `proj12bb48e9` "Findable".
    | Thing | Value |
    |---|---|
    | Entitlement | `findable_pro` (`entl15a96c7924`), active, 6 products attached |
    | Offering | `default` (`ofrng9287c2b429`), `is_current: true`, `paywall_id: null` |
    | Packages | `$rc_monthly`, `$rc_lifetime`, `$rc_weekly` |
    | iOS app | `app2209194362`, bundle `com.savehere.app`, ASC API key ✅, subscription key ✅ |
    | Android app | **none** |
    | Test Store app | `appfa2c46b8fa` (auto-created with the project) |
    | Webhooks | `whintgr281fe2bdfe` → staging, all events, all environments — ✅ verified 2026-10-09 |
    | App Store products | `pro.weekly`, `pro.annually`, `pro.lifetime` — all `duration: null` |
    | Test Store products | `weekly` (P1W), `monthly` (P1M), `lifetime` |

    - [ ] ⚠️ **GAP 1 — THE REAL APP STORE PRODUCTS ARE EMPTY SHELLS, which is a bigger
      problem than them being unattached.** Measured 2026-10-09 via `get-product-store-state`:
      both `pro.weekly` and `pro.annually` report `MISSING_METADATA` with **no territory
      prices, no availability in any territory, and no localizations**. Apple will not sell a
      product in that state and StoreKit will not return it.

      ⚠️ **SO "JUST ATTACH THEM TO THE PACKAGES" DOES NOTHING** — the paywall would still
      say "Subscriptions are not switched on in this build yet", for a third distinct reason,
      and the next person would debug the attachment rather than the product. Finish the
      products in App Store Connect FIRST: price per territory, availability, localized name
      and description, and the subscription group's own localization. Re-check with
      `get-product-store-state` until `store_status.status` is `ok`, THEN attach to
      `$rc_weekly` / `$rc_monthly`.

      The three packages currently hold Test Store SKUs only, which is why the paywall is
      safe and unsellable rather than broken.
    - [ ] ⚠️ **GAP 2 — THERE IS NO MONTHLY APP STORE PRODUCT, and monthly is the plan that
      carries the ₹99→₹120 intro offer** — the centrepiece of the 2026-08-10 pricing
      decision. Meanwhile `pro.annually` contradicts `constants/pricing.ts` ("No annual plan
      is in the shipped paywall; only weekly + monthly") and `pro.lifetime` contradicts
      `docs/CONTEXT.md`, which **deferred lifetime for v1 over unbounded AI-cost liability**.
      That reasoning still holds: a one-off payment for an app whose marginal cost is Claude
      tokens is a liability with no ceiling. **Recommendation: create monthly, leave annually
      and lifetime detached until the app has UI and a cost model for them.**
    - [x] ✅ **GAP 3 — WEBHOOK CREATED AND VERIFIED END TO END** (2026-10-09). Integration
      `whintgr281fe2bdfe` → `https://savehere-api-staging.onrender.com/api/billing/revenuecat`,
      all events, all environments (so sandbox TestFlight purchases are covered too).
      Verified: no header → 401, wrong value → 401, correct value → 200, and RevenueCat's own
      "Send test event" → 200. The test payload carried `type: TEST`, which is in neither
      `_GRANT` nor `_REVOKE`, so no tier was written.
      ⚠️ **The Authorization header cannot be set through the RevenueCat API** — neither
      `create-webhook-integration` nor `update-webhook-integration` accepts it. It is
      dashboard-only, so a webhook created programmatically is inert until someone pastes the
      token in by hand, and it looks configured the whole time.
    - [ ] ⚠️ **GAP 4 — NO ANDROID APP IN THE PROJECT**, so Android can sell nothing. Needs a
      Google Play Console account (one-time $25) and the app on a track before Play will allow
      IAP products at all — i.e. Android billing is structurally further out than iOS. Flagged
      because platform parity is a standing rule here, not because iOS-first is wrong.
    - The App Store products report `subscription.duration: null` while the Test Store ones
      report `P1M`/`P1W`: RevenueCat holds the identifiers but Apple has not confirmed the
      products, consistent with App Store Connect not being finished.
    - ✅ **`react-native-purchases@10.11.0` clears every gate we use**, checked against
      `list-sdk-feature-gates` rather than assumed: Test Store needs react-native `9.5.4`,
      custom-paywall impression tracking needs `9.14.0`. Everything gated above our version is
      a feature this app does not use. `paywall_id: null` is correct — the paywall is ours,
      not a RevenueCat-hosted one; the cost is that paywall impression metrics are not wired
      (`paywall-custom-impression-tracking` would be the hook if that is ever wanted).
  - [ ] ⚠️ **MERGING THIS BLOCKS ALL OTAs UNTIL BOTH PLATFORMS ARE REBUILT.**
    `react-native-purchases` is a native module, so the Android fingerprint moved
    `7bc363b6…` → `7bc09f03…` (measured 2026-10-07, `fingerprint:compare` against
    build 14). Budget one Android build from the 15/month and one iOS build. See
    "EAS BUILD BUDGET".
  - **On the RevenueCat Test Store** (owner asked, 2026-10-07): it removes the need for
    App Store / Play product setup, so the whole purchase → `/sync` → tier loop becomes
    testable before prices are decided. ⚠️ **But it only runs in a DEVELOPMENT build.**
    The SDK does not degrade when it finds a test key in a release build — it logs,
    alerts and then **crashes on purpose**, keyed on how the app was COMPILED, not how
    it was distributed, so TestFlight and every Play testing track crash too.
    `billingPlans.ts::billingKey` therefore gates the test key behind `__DEV__`, which
    makes that mistake unrepresentable; `forceAllowTestStoreInReleaseBuilds` would undo
    it and is deliberately unused, because the preview APK is an artifact we hand to
    other people. **Recommendation: skip it.** It costs a dev build plus
    `expo-dev-client` to buy a few days of earlier feedback, when the two prices below
    are the only thing standing between here and testing against the real Apple sandbox
    on builds that already ship.
- [x] 🔴 👤 **Apple Small Business Program.** Enrolled — **15%**, not 30%. Every margin
  below assumes this.
- [ ] 👤 **Two intro prices still unset — deliberately not guessed.** The **USD monthly
  revert price** (₹99→₹120 is a 17.5% discount; the analogue is ~$8.49) and whether the
  **weekly** plans carry an offer at all. A plan without `introMonths` renders the plain
  renewal sentence, which is true for a plan with no offer — so the gap is safe, just
  incomplete. Needed before App Store Connect setup.
  ⚠️ **AS OF 2026-10-07 THIS IS THE CRITICAL PATH, not a loose end.** The purchase code
  is built and tested; store products cannot be created without these two numbers, and
  without store products nothing can be bought. Everything else on the launch list is
  waiting behind one decision. Note also that `storeTerms()` now derives the disclosure
  sentence from the store's own `introPrice`, so once the products exist the intro terms
  are read from App Store Connect rather than kept in sync by hand here.
- [~] **Free auto-summary gating — built, then REVERTED the same day (owner).**
  The 2026-07-24 cost study still stands: break-even at **~4.2% conversion
  gated vs ~7.8% ungated**, against a 2–5% freemium norm — so ungated is likely
  never profitable and this will have to be revisited before launch.
  It is now a switch, not a decision: `FREE_AUTO_SUMMARY` (default **true** =
  every tier gets the full summary). Set it false and free saves take
  `summarizer.index_only` — tags, category, title, over 2000 chars instead of
  8000 and 350 output tokens instead of 1500. Both positions are covered by
  tests, so turning it on is config, not a rebuild.
  ⚠️ If it is ever re-enabled, `auto_summary` and `can_ask` must stay on the
  same tier boundary — Ask reads `summary`, so a tier that can open Ask but
  only indexes its saves would answer from an empty library.
- [ ] **Ads — NON-TRACKING, Pinterest-style, free tier only** (owner direction,
  2026-10-06). Full analysis and the decision record in
  [`docs/ADS_RESEARCH.md`](docs/ADS_RESEARCH.md) → "Addendum 2026-10-06". The short
  version:
  - ⚠️ **Cannot be connected before launch, and that has nothing to do with tracking.**
    AdMob will not serve an app that is not publicly downloadable in a store; the
    sequence `publish → verify → app-ads.txt → 2–3 day review → serving` cannot start
    pre-launch.
  - ⚠️ **Non-tracking is not the cheap version.** It removes the iOS ATT prompt and makes
    App Store "Data Used to Track You" a No. It does NOT remove the `AD_ID` manifest
    merge, the Play data-safety disclosure, the EEA/UK **certified CMP**, or the privacy-
    policy processor row — and non-personalized inventory clears 30–50% below
    personalized, so it moves the revenue DOWN.
  - **It earns about as much as Pro does, from the people Pro never reaches.** In-feed
    is high-volume where rewarded was high-value, so it clears the $100 payout threshold
    far sooner. At 1,000 MAU, India-weighted: **ads ~$17–44/mo vs Pro at 2% ~$19/mo** —
    same order of magnitude, completely different population (the ~98% who never
    subscribe), and they stack. ⚠️ **Neither alone is profitable in INR at that scale;
    together they are.** Full arithmetic and both scenarios in `docs/ADS_RESEARCH.md`.
    ⚠️ An earlier version of this item said ads cover "a tenth" of the free tier's AI
    cost — that compared against the CEILING (every free user maxing 3/day every day),
    which no cohort does. Corrected 2026-10-06.
  - ⚠️ **The 3/day free AI cap is what makes ads viable.** Ad revenue per user is FLAT —
    it scales with screens viewed, not with AI spend — while AI cost scales with the cap.
    Raising the free cap breaks the ad economics silently, because the revenue side does
    not move. Re-do the table in `docs/ADS_RESEARCH.md` before ever raising it.
  - **The buildable half, now, free, and OTA:** ship the SLOT with our own Pro upsell in
    it. `app/index.tsx` distributes tiles shortest-column-first, so injection is small.
    It measures the two things that decide everything — whether a non-organic tile in
    someone's OWN library reads as a breach, and whether an in-grid promo converts better
    than the existing 90%/95% quota nags. 👤 Owner decision pending on building it.
- [ ] **Regional (PPP) pricing** — three storefront buckets, not 175 hand-tuned prices.
- [~] **Tiers — mechanics built, billing pending.** Server-side entitlements
  (`app/entitlements.py`) work; the purchase flow does not exist.
- [~] **Pro paywall — UI only.** `app/pro.tsx` renders; nothing charges.

### ⚠️ Watch item, not a task
**₹99/month does not cover a maxed INR Pro user** and this was accepted knowingly. 20
actions/day at ~$0.004 is ~$2.43/mo worst case; $7 nets $5.95 after Apple's 15% and clears
it ~2.4x, ₹99 nets ~$0.96 and is ~2.5x underwater. ₹99 breaks even at ~8/day. Bounded per
user, with the Anthropic console cap as the hard ceiling. **Before renewing past the
6-month intro, read the real p50/p95 of `ai_usage.count` for INR Pro users.** The fix, if
needed, is a storefront-specific tier (`daily_limit_for` already branches on tier), not a
price edit. Also: **Pro is only 2x the trial's 10/day**, so the upgrade story rests on
*feature* gating, not the cap — first thing to revisit if conversion disappoints.

---

## 🔴 App Store submission

- [ ] 👤 **Screenshots** — iPhone 6.7" and 6.5", minimum sizes.
- [ ] 👤 **Description** — keyword-optimised, under 4000 characters.
- [ ] 👤 **Keywords** — the 100-character search field.
- [ ] 👤 **Age rating** — questionnaire in App Store Connect (likely 4+).
- [x] **Privacy policy, Terms of Use (EULA) and Support pages** — written 2026-07-29,
  rewritten for Findable and published 2026-09-13. They live in `site/` and deploy to
  GitHub Pages on every merge to `develop` (`.github/workflows/pages.yml`), so they are
  versioned with the app instead of pasted into a dashboard nobody has the login for.
  URLs are the single source in `mobile/constants/links.ts`; the app links Privacy and
  Terms from Menu → Support.
  - [ ] 🔴 👤 **Paste all three into App Store Connect** (Privacy Policy URL, Support URL,
    EULA) — they are submission fields, and App Review taps them.
  - [ ] 🔴 👤 **Confirm `findable.support.app@gmail.com` is a mailbox you actually read.**
    It is now printed on a public page and inside the app. A support address that
    bounces is a Guideline 1.5 rejection.
  - [ ] 👤 Re-read `site/privacy.html` §8 after RLS lands on prod — it currently claims
    per-request scoping only, which is what is true today. Strengthen it then, not now.
- [~] **EAS iOS profiles** — a `testflight` profile exists (store distribution, staging
  env). ⚠️ The `production` profile points at `savehere-api-prod.onrender.com`, which
  **does not exist** (commented out in `render.yaml`) — do not build TestFlight from it
  until that service is live. Signing cert + provisioning are created by EAS on the
  first iOS build.
- [ ] 👤 **TestFlight beta** before submitting for review. App record created 2026-09-09,
  App Store Connect Apple ID **6810128841** (already in `eas.json` → `submit`).
- [x] **Support URL** — in-app page done 2026-08-14 (`mobile/app/support.tsx`), public
  page live at `site/index.html` from 2026-09-13. Both point at the same address.

---

## Cost & abuse — open

- [ ] **Cap residential-proxy spend per user.** *(Hard prerequisite of enabling the
  proxy.)* Residential proxies are **bandwidth-priced (~$2–10/GB) with no ceiling in
  code**, and unlike Claude there is no console-level hard cap to fall back on. Mirror
  `app/quota.py` with a `charge_proxy_action`-style atomic, tier-aware counter.
  ⚠️ **The same cap is required for Whisper the moment `OPENAI_API_KEY` is set** —
  the audio fallback (`transcriber.transcribe`, $0.006/audio-min) is dormant today only
  because the key is unset. **Do not set that key without adding the cap first.**
- [~] **Pre-launch security pass.** Prompt-injection containment is done (`is_sensitive`
  is a one-way latch). SSRF on the save path is closed both ways (2026-09-23): the
  submitted URL is host-matched, not substring-matched, and `_fetch_page` re-checks every
  redirect hop. **Residual, accepted for now: yt-dlp.** It does its own networking with no
  host policy we can hook, so an open redirect on YouTube/Instagram/TikTok/Facebook could
  still send *it* somewhere internal. Much narrower than what was closed — it needs a live
  open redirect on a major platform, and yt-dlp parses the answer as media rather than
  handing it back as page text — but it is not zero. Options if it ever matters: run
  extraction egress through a proxy with an allowlist, or drop to a pinned-IP HTTP client.
  ⚠️ **NOT URGENT TODAY, AND THE REASON IS WHAT TO WATCH:** an SSRF is only worth as much
  as what it can reach, and right now that is nothing — one Render service, no private
  network, no internal-only endpoints, and Supabase sits on the public internet behind a
  credential rather than on a trusted subnet. **The trigger to do this is architectural,
  not calendar-based: the day a SECOND service, a private network, a cache, or any
  internal-only endpoint appears, this moves to 🔴.** Doing it before then buys almost no
  risk reduction and puts a proxy hop in the save path, which is the one path whose
  success rate the app lives on.
  Remaining: live-model adversarial evals (steering resistance can't
  be unit-tested), `/security-review` on the branch before first deploy, a ZAP baseline
  scan against staging, and one load smoke (~50 concurrent saves).
  Deliberately **not** doing: DDoS self-testing (violates provider ToS — Cloudflare is
  the answer) and a formal pentest (revenue-stage).
- [~] **Per-IP rate limiting.** In-memory and per-process. Redis is **not needed yet** —
  `render.yaml` runs a single uvicorn worker on a single instance, so one bucket is
  correct. Redis becomes required only on horizontal scale. Free options exist then
  (Upstash, Render Key Value), so this is not a cost blocker.

---

## Extraction reliability — open

- [x] **Facebook saves arrived login-walled with a noisy title** (fixed 2026-09-10).
  Two bugs on one card. (a) yt-dlp answers a Facebook reel with a title and a
  thumbnail and *no text*, and the "did yt-dlp give us anything?" guard was
  `title or thumb or text` — so the save returned before the og:/oEmbed
  fallbacks that actually carry the caption ever ran. It now requires TEXT, and
  keeps the yt-dlp metadata as a floor when it falls through. (b) The
  engagement-count prefix (`5.1M views · 189K reactions | …`) *was* being
  stripped — inline in `_extract_from_page`, one of three paths that can return
  a title, and not the one Facebook takes. Now `clean_title_text()`, called on
  every path. Tests in `test_extractor.py`.

- [ ] **Bot-detection on datacenter IPs — decide before prod.** Saving a YouTube Short
  fails with "Sign in to confirm you're not a bot" from a datacenter IP, and
  **Render/Railway/Fly are all datacenter IPs, so deploying does not fix it — usually
  worse.** The seam exists: `EXTRACTOR_PROXY_URL` threads a proxy through both yt-dlp and
  the pooled httpx client, **unset by default and free** (byte-for-byte unchanged
  behaviour). The free layers landed first on purpose — negative cache, per-host gating,
  header realism, circuit breaker — so this decision can be made against real block-rate
  data from `/health/extract` rather than a guess. See the spend cap above.
- [ ] **Wire `/health/extract` to alerting in prod.** The endpoint reports yt-dlp version,
  live probe status and per-platform `breakers`. Nothing watches it today.
- [ ] **Process pool for hard timeouts.** A thread pool cannot kill a truly hung
  extraction. Real bounds today are per-operation (`socket_timeout=10`, `retries=1`,
  explicit httpx timeouts, the circuit breaker). Only do this if hangs actually recur.
- [~] **Per-platform success-rate monitoring.** `record_result()` tracks consecutive
  failures and `/health/extract` exposes `breakers`. Still needed: record a success
  *rate*, not just a consecutive-failure count.
- [~] **Caption 429 mitigation.** Per-host semaphore + jitter + pooled client landed.
  The open half is the same residential-proxy decision above.

### Silent-failure audit (2026-09-07) — LOW residue
Four findings fixed in PR #83. Three left deliberately silent:
`extractor.py:326,407` (caption-language loop, `_youtube_oembed`) and `reels.py:1068`
(mark-failed handler, bounded by `recover_pending_summaries()`). All are
graceful-degradation chains — a debug line would cost nothing, but none produce a
**wrong** diagnosis, which is what made the other four worth fixing.

---

## Infrastructure — open

- [x] **The two stale `savehere` URLs in `ShareConfigModule.podspec` are fixed** — in a
  native-build commit, which was the whole condition (2026-09-23). Measured on 09-13:
  editing that file moved the iOS fingerprint `a86bf3fd…` → `496e1f01…`, so doing it on a
  JS-only round would have orphaned every OTA from the installed build. The rule stands
  for next time: **a local Expo module's files are hashed like any other native source —
  never touch one outside a build round.**

- [ ] 👤 **Region + Cloudflare.** Pick the Render region nearest first users (Singapore
  for India-first) — **effectively unchangeable later**. Once the domain exists, put
  Cloudflare free in front: edge cache for `/api/thumbnail` (already sends
  `Cache-Control: max-age=86400`) and the only realistic DDoS layer. Decision
  2026-07-20: no paid CDN, no multi-instance, no secrets vault until traffic says so.
- [ ] 👤 **Arm the monthly yt-dlp refresh.** Add the `RENDER_DEPLOY_HOOK_PROD` GitHub
  secret; `.github/workflows/refresh-ytdlp.yml` no-ops until then.
- [ ] 👤 **Create the 3 test accounts in `savehere-dev`,** then run
  `python scripts/dev_seed_tiers.py`. ⚠️ Auth users are **per-project** — the seeded
  `trailtieruser`/`freetieruser`/`protieruser` currently live in PROD; recreate in dev
  and consider deleting from prod.
- [~] **CI/CD.** Backend pytest runs on push/PR; mobile typecheck runs separately.
  ⚠️ Deploys gate on **backend CI only** — mobile type errors don't block a backend deploy.

---

## Features — open

- [x] **Notifications round 2 — the share pop, the result, and task reminders** (owner,
  2026-09-23/24). ⚠️ **Native: rides the held build with the round-1 fixes.**
  1. **Pop** the moment a share lands — `Instagram → Findable`. On Android it is the
     foreground service's own notification (one banner, not two) and is replaced by the
     result; the JS path auto-dismisses it after 3 s. ⚠️ **iOS cannot auto-dismiss a local
     notification** — no API for it — so it stays in Notification Centre until cleared.
     The OS decides that one, not us.
  2. **Result names the reel**: `Saved to Findable · “<title>” is in your library.` The
     title was always in the /share-save response and was being thrown away. A placeholder
     ("Instagram Reel") is never quoted back — that claims a read that never happened.
     Failures use the server's own `detail`, which is already plain English and tier-aware,
     and gain "Share it again to retry." only when they do not already say what to do.
  3. **Task reminders**: one digest per day at a chosen time on days that have something
     due, tapping opens the Slate (cold start included). Off by default; the permission is
     asked at the toggle, because Android 13+ gives you one good ask.
- [~] **iOS silent shares report SUCCESS OR FAILURE** — written 2026-09-25 in
  `mobile/modules/share-config/ios/ShareResultSubscriber.swift`. ⚠️ **Not testable until
  an iOS build ships**; it is Swift.

  The Share Extension's upload is a background `URLSession`, so iOS completes it after the
  extension is dead and delivers that completion to the **containing app** via
  `application(_:handleEventsForBackgroundURLSession:completionHandler:)`. The old plan
  here was a `withAppDelegate` config plugin. **That was not needed** — `expo-modules-core`
  already forwards this exact callback to app-delegate subscribers
  (`ExpoAppDelegateSubscriberManager`), so the handler is an ordinary class in the local
  `share-config` module plus one line of `expo-module.config.json`. Verified with
  `npx expo-modules-autolinking resolve -p ios --json`, which lists
  `share-config -> subscribers: ['ShareResultSubscriber']`.

  It re-attaches to the session by the identifier iOS hands it, reads the response body
  off the upload task, and posts the same two outcomes Android posts — plus a drawer
  receipt, so a user who denied notifications still learns what happened. The extension
  now also stashes the shared link under `findableShareLink.<session id>` in the App Group,
  because a result has to name the platform and the request body is a temp file the system
  has already consumed.

  ⚠️ **Three limits, none of them bugs:**
  1. **A force-quit app is not relaunched.** iOS suppresses background relaunch after the
     user swipes an app away, so the outcome waits until they next open Findable. The
     upload is unaffected — the system owns it.
  2. **Two drawer receipts per silent share** ("Saving…" from the extension, then the
     result). Kept on purpose: if iOS defers the relaunch for hours, the first receipt is
     the only record that exists.
  3. **iOS's completion handler will not actually fire**, and it is not our fault.
     `expo-file-system` registers `FileSystemBackgroundSessionHandler` for the same
     selector and only invokes the handler it was given when one of ITS sessions finishes;
     Expo's manager waits for every subscriber, so the count never reaches zero. Costs a
     background-launch courtesy; does not affect the notification. Do not go hunting for
     that bug in our file — there is a comment there saying the same thing.

  ⚠️ **MERGING THIS FREEZES BOTH OTA CHANNELS, not just iOS.** Measured 2026-09-25:
  the iOS fingerprint moves `6deee3ef…` → `78668ed0…` (expected — new Swift), and the
  ANDROID one moves `19e8d21e…` → `7bc363b6…` as well, because `withInvisibleShareIOS.js`
  is a config-plugin file and those are hashed for every platform regardless of what they
  contain. So this sits on branch `feat/ios-share-outcome` until an iOS build is actually
  wanted; merging it early would cost the ability to push JS fixes to the Android build 13
  that was just installed. ⚠️ Also in mobile/AGENTS.md.

  ⚠️ **The notification wording now exists in FOUR processes** (`services/shareNotice.ts`,
  `plugins/android/ShareSave.kt`, the extension's Swift, and this subscriber). None can
  call the others. When a string or a platform changes, all four change in one native
  build. The Threads label already fell a week behind once this way.
- **Notifications deliberately NOT added** (considered 2026-09-24, so they are not
  relitigated): *summary ready* — needs server push, which needs tokens, a sender and a
  privacy-policy change, for an event the user is not waiting on; *save-cap warnings* —
  already an in-app banner at 90% and a popup at 95%, and a notification about a limit you
  have not hit is a nag; *daily AI quota reset* — pure noise; *weekly "you have N unread
  saves"* — an engagement nag, and the fastest way to get every Findable notification
  switched off, including the ones people asked for. **Support needs none**: support is
  email, and the app cannot notify about a reply it never sees.

- [x] **Notifications: the three gaps are closed** (owner, 2026-09-23) — ⚠️ **NATIVE, so
  they reach nobody until the next build.** (1) Two user-facing strings still said
  "SaveHere"; (2) an iOS silent share reported NOTHING — no banner, no drawer row, so a
  failed save looked exactly like a successful one, while Android had both from day one;
  (3) Kotlin's `platformLabel` never learned Threads, so a Threads share said "Saved from
  the web" for a week. All three were native strings or native code, which is precisely
  why a JS-only release could not have carried them.
  - ⚠️ **ONE LIST, THREE PROCESSES.** `platformLabel` now exists in `services/shareSave.ts`,
    `plugins/android/ShareSave.kt` AND the injected Swift. None can call the others. When
    a platform is added, the JS copy ships instantly and the other two wait for a build —
    put them on the build's checklist rather than assuming the OTA carried them.
  - The iOS receipt says **"Saving from X"**, never "Saved": the upload is a background
    session the system completes after the extension is dead, so a confirmation would be
    a claim we have not got. Reconciling it to a definite saved/failed would mean handling
    `handleEventsForBackgroundURLSession` in the app delegate — worth doing only if the
    softer wording proves confusing in testing.

- [x] **Promoted tile in the library grid — our own Pro upsell** (owner go-ahead,
  2026-10-06). `components/PromoTile.tsx`, rules in `services/promoSlot.ts`, injected
  into the mosaic in `app/index.tsx`. **JS only, so it ships OTA.** Free tier only,
  never under 10 saves, labelled **PROMOTED**, dismissible for 7 days. The ad-network
  half is blocked on the app being live in a store — see `docs/ADS_RESEARCH.md`.
  - **Density, after the owner saw one tile in a 30-save library and said "just one is
    not enough" (2026-10-06):** first at the 8th tile, then **one every 10**, capped at
    6 per grid, never the final tile. 1-in-10 is deliberately sparser than a social
    feed (Instagram runs nearer 1-in-4) because this is a library of your own things,
    not a discovery feed — the sparse end is where the honest test is. ⚠️ No
    authoritative figure for Pinterest's own in-feed density is public; do not let
    anyone cite one.
  - ⚠️ **MORE SLOTS NEEDED MORE CARDS, NOT THE SAME CARD MORE OFTEN.** Three
    creatives rotate (saves, AI-per-day, Ask), each built from the user's OWN live
    `/usage` limits so the comparison is true for them specifically — and a card whose
    premise is false for a user is omitted, not softened. Repeating one identical tile
    would have measured "does the same thing five times annoy people", which has an
    obvious answer, instead of whether promoted inventory is tolerable here at all.
  - ⚠️ **The 6-per-grid cap is a HOUSE-AD artefact, not an ad-policy rule.** With
    three creatives, an uncapped 1-in-10 over a 500-save library repeats them fifty
    times and reads as a rendering bug. **Delete the cap the day real creatives
    arrive** — a network supplies a different one every time, and the cap would then be
    throwing away revenue.
  - [x] **Both Pro numbers now come from the server** (`/usage` -> `pro`), so the
    promo cannot advertise a cap the server does not grant. The hardcoded
    `PRO_SAVES = 500` is gone.
  - [x] **It animates** (owner, 2026-10-06: "make it more flashy and animates and
    moving... may be bit annoyingly"). A diagonal sheen sweeps the tile, the accent
    edge breathes, and the whole tile lifts very slightly — both loops on the NATIVE
    driver (transform and opacity only), because up to 6 are mounted at once and six
    JS-driven loops would be a measurable scroll stutter.
    - It shipped at `'lively'` and that was wrong on a real device — owner, 2026-10-06:
      **"your animation is very very subtle"**. A sheen tuned on a desk reads as nothing
      in a hand, on a bright screen, among photographs. **`PROMO_INTENSITY` in
      `promoSlot.ts` is now `'loud'`**; the dial is `'calm' | 'lively' | 'loud'` and any
      of them is one word and one OTA.
    - ⚠️ **WHAT `'loud'` COSTS, so the trade stays visible:** the dismiss rate is this
      slot's only measurement — whether promoted inventory is tolerable in a grid of
      your own saves. The louder the tile, the more that number measures the ANIMATION
      rather than the format, and the format is the question worth an ad SDK. It is also
      a bet against retention: the library is the screen people open to find something,
      and a shouting tile in the middle of it trains them to stop opening it. **If
      dismissals come in high, try `'calm'` before concluding promoted tiles don't work
      here.**
  - [x] **It vibrates when one comes into view** (owner, 2026-10-06, because the
    animation alone was too subtle). A **double pulse** — `haptics.promo()`, two
    `Medium` impacts 130ms apart — unlike every other haptic in the app, all of which
    are single events, so the pattern can be learned.
    - ⚠️ **A BUZZ CANNOT SAY "ADVERT", and the owner's reasoning for it ("that way user
      will understand it's a promoted slot") does not hold on its own.** A vibration
      carries no semantics; it says *something happened*. The **PROMOTED** label is what
      says what it is — the haptic only makes someone look at the label. That is still
      worth it, but if the goal is comprehension the label is the thing to improve.
    - ⚠️ **ONCE PER TILE PER SESSION, never once per crossing** (`promoFelt` in
      `app/index.tsx`). The library is scrolled up and down constantly; a tile that
      re-buzzed each pass would make the phone a pager and get the format dismissed for
      the wrong reason. Max ~6 buzzes in a long library, and a dismissal silences all of
      them for 7 days.
    - The grid is a `ScrollView`, so there is no `onViewableItemsChanged`: each tile
      reports its box from `onLayout` and **`promoInView()` in `promoSlot.ts`** decides
      visibility from the scroll offset. Pure and tested, because a haptic for an
      off-screen tile is a phone buzzing for no visible reason — indistinguishable from
      a bug. Boxes and fired-slots are **refs, not state**: this runs from `onScroll` at
      32ms, and state would re-render ~30 mounted tiles several times a second.
    - ⚠️ **NO IN-APP OFF SWITCH, by omission not decision.** iOS gates impact haptics
      behind System Haptics; Android's `Vibrator` is **not** gated by the touch-feedback
      setting, so an Android user who dislikes it can only dismiss the tile. If anyone
      complains, that is the fix — not a settings row.
    - ⚠️ **REDUCE MOTION IS HONOURED AND IS NOT NEGOTIABLE WITH THE BRIEF.** A
      sweeping, pulsing tile is exactly what triggers nausea and migraine for people
      with vestibular disorders, and both platforms expose the setting so apps can
      stop. Someone who asked their OS for less motion gets the same copy and the same
      offer with no movement at all. Attention-grabbing is a preference; this is an
      accessibility floor.
  - ⚠️ **THE DISMISS RATE IS THE MEASUREMENT, not a convenience.** A real AdMob unit is
    not dismissible; shipping the first one undismissable would have guaranteed a false
    positive about tolerance. The signal that would kill the whole idea is free users
    opening the Library *less* — and that is the signal worth losing.
  - ⚠️ **It will not appear on a trial or pro account.** `promoAt` requires the tier
    string to be exactly `'free'`; an unknown tier (the usage cache starts null) shows
    nothing, because advertising Pro to someone who bought it is a churn mechanic. Use
    `scripts/dev_seed_tiers.py` to see it.
- [ ] **Deep linking** — `savehere://reel/{id}` so a share-extension save opens the
  detail screen directly.
- [ ] **Archive as a softer alternative to delete-on-completion.**
- [ ] **Activity grid + streak.** `todos.completed_at` is already recorded, so the data
  exists.
- [ ] **First-run coach-marks** — spotlight add-a-reel, the Library, and Ask in sequence.
- [ ] **Whisper local fallback** — local `openai-whisper` for audio-only content with no
  captions, as a free alternative to the paid API. ⚠️ See the Whisper spend cap above
  before enabling the paid path.
- [~] **Trip itinerary** — backend done; remaining work is mobile.
- [~] **Usage drill-down** — backend `ai_action_log` done; remaining work is mobile.

---

## Design — open

⚠️ **Two directions are recorded and only one is live.** `mobile/constants/theme.ts`
implements **"Contact Sheet"** (achromatic, 0 radius, Inter, full-bleed masonry). The
**"Nocturnal Dimension"** experiment was partly adopted — `gradients.haze` shipped (12
references) — and its capsule tab bar was **closed as not-doing** on 2026-08-10. The
three items below are that experiment's residue. Decide whether to finish or drop them;
if dropped, delete `docs/DESIGN_PROPOSAL.md` too.

- [ ] **Home screen** — Fraunces greeting, filter pill row. *(Haze root already done.)*
  ⚠️ Fraunces was **dropped** on 2026-08-09 to avoid font-loading latency, and `serif`
  now resolves to Inter. This item contradicts that decision — resolve before building.
- [ ] **Verify haze on web + Android.** The whole point of the hybrid is avoiding
  `expo-blur`; confirm the gradient costs nothing on scroll.
- [ ] **Contrast audit** — re-measure `#F7F4EF` on `#101012` and `#101012` on `#E96B34`.
- [~] **Owner visual pass on signed-in screens.** The preview browser has no session, so
  the tab bar, the pinned CTAs, the rebuilt tile, paywall page 02, reel detail, todos and
  the workout screens have **never been seen by a human on a real build**.
- [~] **Screens not recomposed** — `workout/[reelId]` and `workout/session/[reelId]` are
  token-inherited only; `reel/[id]` and `todos` got targeted passes but keep card layouts
  rather than the ruled-row grammar.

---

## Post-launch (not blockers)

- [ ] **Biometric app-lock** (opt-in Settings toggle).
- [ ] **Collections / folders.**
- [ ] **Export** — summaries as PDF or Markdown.
- [ ] **Analytics** — PostHog or Mixpanel free tier.
- [ ] **GDPR data-deletion flow** for EU users. *(Account deletion itself is done,
  including the Supabase Auth record.)*

---

## Deliberately NOT doing — do not resurrect

- **Profile: gender + avatar icon.** Built, then **removed by owner decision** (PR #18).
  It sat in this file as an open task for weeks and would have been rebuilt. Zero
  references remain in the code — verified 2026-09-07.
- **Smart search.** Deleted 2026-08-10, not disabled — `services/search.py`, the endpoint,
  the tests and `searchReels()` are all gone. If it ever returns at a scale that justifies
  it: **embeddings, not the lexical ranker.**
- **Forgot-password.** Blocked on SMTP *and* scoped to email auth, which Apple/Google are
  replacing. It dies with the email path unless email stays a first-class prod method.
- **Prompt caching for the summarizer.** Haiku 4.5's minimum cacheable prefix is larger
  than SaveHere's whole system prompt — it would cache nothing and cost a write.
- **Capsule tab bar + centre FAB restyle.** Closed 2026-08-10. The instruction assumed an
  `app/(tabs)/` directory that has never existed; Home and Library **share the route `/`**
  and are told apart by a session flag, which expo-router's `Tabs` cannot express.
- **One account per phone / device-locked trials.** Asked 2026-10-06 ("same mobile with
  multiple gmail or apple ids can have multiple accounts, can't we restrict them to one
  phone to one account?"). **No — the mechanism is against App Store rules and does not
  work anyway.**
  - ⚠️ **Apple forbids the technique.** Guideline 5.1.1(iv): an app may not use
    device fingerprinting to identify a device or user. There is no durable device id
    to use legitimately — `identifierForVendor` resets once all of a vendor's apps are
    uninstalled, and the IDFA needs ATT consent and can be reset or zeroed at will.
  - **Android is no better**: `ANDROID_ID` is per signing-key AND per device AND per
    user profile, and a factory reset changes it. Play policy also limits tying
    persistent identifiers to personal data.
  - **It punishes the honest.** Shared family phones, a partner signing in, a work and
    a personal account, a second-hand handset — all broken, to inconvenience an
    attacker who only needs a second phone or an emulator.
  - **The loss is already bounded, which is the real answer.** A farmed trial is worth
    at most `TRIAL_DAYS × AI_DAILY_LIMIT × ~$0.004` ≈ **$0.40**, and
    `normalize_email()` already defeats the cheap version of the attack: it strips
    `+tags` for every provider and dots in Gmail local parts, and `TrialGrantDB`
    survives account deletion, so a genuinely fresh trial costs a genuinely fresh
    phone-verified Google account.
  - **And the store will enforce it for free when billing lands.** Apple's
    introductory-offer eligibility is per Apple ID and Family Sharing group, Google
    Play's equivalent is per Google account — both enforced at the store, neither
    bypassable by making Gmail accounts. If trial abuse ever shows up in the data, the
    fix is to move the trial onto a store intro offer, not to fingerprint phones.

- **DDoS self-testing and a formal pentest.** ToS violation and revenue-stage respectively.

### Closed during the 2026-09-07 condense
- **"API key protection — once auth is added, all routes should require a session
  token."** Its precondition is met and the work is done. Verified: every route in
  `account.py`, `ask.py`, `reels.py`, `todos.py` and `workout.py` carries an auth
  dependency. The three unauthenticated endpoints are deliberate — `/health`,
  `/health/extract` and `/api/thumbnail` (rate-limited and host-allowlisted).
  `billing.py`'s webhook uses a constant-time shared secret instead of a user JWT,
  which is correct for a machine caller.

---

## Rules that bind — do not relearn these

These cost real time already. Full context in [`docs/SHIPPED.md`](docs/SHIPPED.md).

**Testing & CI**
- **Testing locally does NOT prove it works on Render.** YouTube/Instagram bot-block
  datacenter IPs; extraction that works from a residential IP returns title+thumbnail only
  from Render. To validate an extraction fix, **simulate the block** (monkeypatch
  `yt_dlp.YoutubeDL` to raise, stub `_extract_from_page` to `{}`) or read the real row
  from the shared dev DB.
- **CI has no `ANTHROPIC_API_KEY` on purpose.** Mock `summarizer` / `workout_extractor`.
  A test reaching the real client passes locally (your `.env` has a key = a real billed
  call) and fails CI.
- **`/health/extract?live=1`'s `probe_ok` passes on a thumbnail alone** — it is NOT
  evidence that text extraction works.
- `/api/ask` and `/api/ask/stream` share one process-global rate-limit bucket while
  TestClient presents a single IP, so suite-order traffic can 429 unrelated tests. Quota
  and gating fixtures clear `ratelimit._store`.

**Data & environments**
- **Local dev, Codespaces and staging share ONE `savehere-dev` Postgres.** Running things
  locally writes to the database staging serves.
- The app `.env` is at the **repo root**, not `backend/` — the app walks up from `backend/`.
- Use the Supabase **session pooler (:5432)**. Direct is IPv6-only (Render's outbound
  generally isn't); transaction pooler (:6543) breaks prepared statements.
- **Render env vars override config defaults per service** — check the dashboard before
  assuming staging and prod match the code.
- **Render's free tier kills in-flight background tasks** on spin-down, which is why
  `recover_pending_summaries` re-runs the chain on startup.
- **Any new table needs a matching RLS line** in `enable_rls.sql`. `ai_action_log` and
  `todos` each fell into this trap once.
- **A status field lying about content caused two separate bugs.** Any path writing
  `summary_status` must assume another path may be mid-flight.

**Mobile**
- ⚠️ **EAS Free = 15 Android builds per calendar month**, not the 30 an old changelog
  announced. Running out is a wall, not a bill. The auto-trigger is `workflow_dispatch`
  only, on purpose.
- ⚠️ **JS-only changes ship over the air, not as a build:**
  `npx eas-cli@latest update --channel preview -m "what changed"`. Costs no build quota.
  Only native changes (SDK bump, new native module, permissions, anything touching
  `plugins/withInvisibleShare.js`) need an APK.
- `runtimeVersion` is the **`fingerprint`** policy so an update can never land on a native
  build it doesn't match. **Do not change it to `appVersion`** — `expo.version` is a frozen
  `"1.0.0"`.
- `npm run typecheck` uses `--stack-size=16000`; plain `tsc` crashes on the type graph.
  That's expected, not a real error.
- ⚠️ **Adding a save platform means `detect_platform()` FIRST** — anything it calls
  `unknown` is a hard 400 before extraction is even attempted. Then five parity lists:
  `_PROBE_HOSTS`, the wall/weak-title sets in `routes/reels.py`, and mobile's
  `platformMeta` / `platformLabel` / `readFailure` placeholder regex. Threads (2026-09-17)
  needed **both** `threads.net` and `threads.com` — Meta moved the domain and old links
  still resolve on the old one. Same shape as the `lnkd.in` bug.
- ⚠️ **An Ionicons name that doesn't exist renders an EMPTY BOX, not an error.** Verify a
  brand glyph against
  `node_modules/@expo/vector-icons/build/vendor/react-native-vector-icons/glyphmaps/Ionicons.json`
  before shipping it — the failure is invisible until someone opens a real card.
- ⚠️ **`Updates.isEnabled` is hardcoded `true` in the expo-updates WEB shim.** Any
  updates check must guard `Platform.OS !== 'web'` as well. And `reloadAsync()` never
  resolves on success (the JS context is torn down) — never schedule work after it.
  Both live in `mobile/services/appUpdate.ts`.
- **`EXPO_PUBLIC_*` is inlined at bundle time** — restart `expo start` after changing it;
  a browser refresh keeps the old value.
- `radius.circle` has a **closed list of three sanctioned uses** — category bubbles, the
  tab bar, the auth buttons. Everything else is 0. Add to the list if you extend it.
- The masonry grid traded FlatList virtualization for a ScrollView. Fine for
  tens-to-hundreds of saves; at a few thousand the fix is a **windowed masonry**, not a
  smaller diff.

**Auth**
- ⏰ **The Apple client secret is a JWT that expires — 6 months maximum**, and when it
  lapses Sign in with Apple breaks for every user with no code change and no deploy to
  blame. **This is why we do NOT use Apple's web OAuth flow** (2026-09-09): the native
  ID-token flow has no client secret, no Services ID and no `.p8`, so there is nothing to
  rotate and no calendar reminder to forget. The trap is recorded because it comes back
  the day someone wants Apple sign-in on **Android or web** — that needs the full
  Services ID + `.p8` + 6-month rotation apparatus. Don't add it without that price in
  mind.
- Apple sends the user's **name exactly once**, on the first authorisation only, and it
  is **not in the identity token**. `signInWithApple` copies it into `first_name`
  immediately; drop that and the account is permanently nameless, because Apple's relay
  addresses (`…@privaterelay.appleid.com`) make the email fallback useless too.

**Detail screen**
- 🧨 **Tags and "Your Notes" were REMOVED from the reel detail screen (owner,
  2026-09-09) — do not reinstate either.** Tags are still generated and still power
  search and the category rail; they are simply no longer printed. The `notes` COLUMN,
  `api.updateNotes` and every saved note are **untouched server-side** — this was a UI
  removal on purpose, because it is reversible and dropping the column would not be.
- ⚠️ Removing Notes removed the **input** to re-summarize. Any copy that said "paste the
  text in Notes and re-summarize" was a dead instruction the moment the field went, and
  all of it was rewritten in the same commit — `Disclaimer.tsx`'s `ai` variant included.
  If Notes ever comes back, that copy has to come back with it.

**Naming**
- 🧨 **The App Store listing name is `Findable Saves`; the app is `Findable`. THE MISMATCH
  IS DELIBERATE — do not "fix" it.** Only the listing name must be globally unique, and
  plain `Findable` was already reserved by someone else (2026-09-09). `expo.name` /
  `CFBundleDisplayName` has no uniqueness rule, so the icon still reads **Findable**.
  Changing `expo.name` to match the listing would rename the app on every home screen for
  no reason; changing the listing to `Findable` is impossible.
- ⚠️ **Searching the App Store does NOT prove a name is free.** App Store Connect reserves
  a name the moment an app record is created, and an unpublished reservation is invisible
  to store search — which is exactly how `Findable` passed a search and then failed at the
  form. The **New App form is the only authoritative check**. Test a name there BEFORE any
  rename lands in code.

**Crash reporting**
- ⚠️ **`EXPO_PUBLIC_SENTRY_DSN` is inlined at BUILD time.** A build made without it can
  never gain crash reporting later — no OTA update can add it. It is set in EAS for
  development/preview/production; if a build ever ships without reporting, that is why.
- ⚠️ **…AND AN OTA CAN SILENTLY TURN IT OFF AGAIN. The line above is only half the
  trap.** The `if (SENTRY_DSN)` guard lives in `mobile/app/_layout.tsx` — **JS**, which
  is exactly what `eas update` replaces. So a bundle published WITHOUT the DSN inlined
  strips crash reporting from a build that shipped WITH it. There is no warning: the
  guard's own comment is "Guarding is better than a lie", so a missing DSN fails
  **quiet, by design**, and the app looks perfectly healthy while reporting nothing.
  Same mechanism as the entry above, opposite direction.
  - Surfaced 2026-09-17 publishing to `preview`: expo-cli reported exporting **three**
    `EXPO_PUBLIC_*` vars from the local `.env` while the EAS `preview` environment holds
    **four** — the DSN being the odd one out. Which source wins when `eas update`
    bundles was never established, and that is the point: **do not rely on precedence.**
  - **The fix is redundancy, not a rule about ordering.** Keep every `EXPO_PUBLIC_*`
    var in BOTH the local `.env` and the EAS environment, the way `EXPO_PUBLIC_API_URL`
    already is. When the two agree, which one wins stops mattering — for the DSN and for
    anything added later.
  - **Verify after any OTA**, don't reason about it: open the app on a device on that
    channel and look for a new session in Sentry. Nothing arriving means the DSN did not
    make it into the bundle.
  - ⚠️ The same inlining applies to `EXPO_PUBLIC_API_URL` and is far worse: an OTA
    bundled against a `.env` pointing at `http://localhost:8000` sends every device on
    the channel to its own loopback, instantly and with no review gate. Check both
    sources agree BEFORE publishing; `eas update:rollback --channel <ch>` is the undo.
- ⚠️ **Sentry does NOT see Share Extension crashes.** The extension is a separate process
  with no JS runtime. If sharing breaks silently, Sentry will be quiet, and that silence
  is not evidence of health — check the device's own crash logs instead.
- The DSN is **not a secret**: it is compiled into every copy of the app and can only
  write events. It belongs in git and in chat; the `.p8` and the service role key do not.

**Share intent**
- 🧨 **`mobile/app/+native-intent.ts` is load-bearing — deleting it breaks every iOS
  share with "Unmatched Route".** expo-router scans for that exact filename and hands it
  every incoming URL. The share extension wakes the app with
  `savehere://dataUrl=savehereShareKey?nonce=…`, which is a doorbell, not a route — the
  payload is in the shared app group. Without the file the router tries to navigate to a
  path called `dataUrl=savehereShareKey` and renders its 404, so `ShareIntentHandler`
  never runs. First hit 2026-09-09, first TestFlight build.
- ⚠️ `redirectSystemPath` sees **every** deep link, `savehere://auth/callback` included.
  Anything that is not a share must be returned untouched or OAuth sign-in breaks.

**iOS build**
- 🧨 **`USE_CCACHE=0` is load-bearing in `eas.json` — do not remove it to speed builds up.**
  React Native writes `CC`/`LD` = `$(REACT_NATIVE_PATH)/scripts/xcode/ccache-clang.sh` onto
  the **project** build configuration, so it applies to every target — but
  `REACT_NATIVE_PATH` comes from the Pods xcconfig, which `expo-share-intent`'s
  **ShareExtension** target never gets. It expands to empty and fastlane dies with
  `unable to spawn process '/../../node_modules/…/ccache-clang.sh'`. Cost of the fix is a
  cold compile every build; the cost of removing it is no iOS build at all. First hit
  2026-09-09 on the first TestFlight attempt.

**Shell**
- Backticks inside `git commit -m "..."` get shell-evaluated and silently eat text — use
  `git commit -F <file>`. Git Bash also mangles `git show <ref>:<path>`; prefix
  `MSYS_NO_PATHCONV=1`.

---

## Known limitations — working as intended

- **Audio-only YouTube Shorts** (no description, content only in speech) can't be
  summarized server-side; caption download needs OAuth. The honest "couldn't read this"
  is correct behaviour.
- **Instagram/Facebook on web** can't use the client-side metadata fetch (browser CORS).
  Native only.
- **YouTube Data API** recovers descriptions, not transcripts. 10,000 free units/day;
  `videos.list` costs 1 unit; the extraction cache is keyed by URL globally, so a popular
  link costs one call no matter how many users save it.
- **Free-tier cold starts** — ~50s to wake after 15 minutes idle.
