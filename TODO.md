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

## ⚠️ THE OTA CHANNEL IS FROZEN — read this before publishing an update

**State on 2026-09-24:** `develop` carries NATIVE changes that no build contains
(PR #120 — the iOS share receipt, the Kotlin strings, the Threads label, the podspec
URLs). The owner chose to hold the build so the to-do reminders work can ride along in
one build instead of two. That decision has one consequence, and it is the silent kind:

> **Any `eas update` published from `develop` right now reaches ZERO devices.**

The runtime version moved off `a86bf3fd…` (iOS build 1.0.11) and `90573df5…` (Android
build 11), and a mismatched update does not warn — it simply never applies. So until the
next build ships:

- **Do not publish JS-only fixes from `develop` and tell the owner they can test them.**
  They cannot. If something urgent must go out over the air, it has to be published from
  a branch off the last built commit (`cf05b96`), not from `develop`.
- The next build's runtime version is whatever **EAS computes at build time**. ⚠️ Local
  `fingerprint:generate` measured THREE different values for the same commit on 2026-09-24
  (`b8879267…`, `f046ecc5…`, `c5badda2…`) depending on line endings in the working tree —
  this machine has `core.autocrlf=true`, so a file written by a tool with LF hashes
  differently from the same file after a checkout. **`eas build:view <id>` is the only
  authority**, and the number `eas update` prints must equal it. Never publish an update
  because a local fingerprint "looked right".
- ⚠️ **Builds and updates should be run from the SAME machine.** A build run from a Linux
  cloud session and an update published from this Windows checkout can disagree for the
  same reason.

Delete this section the day the build ships and the channel is live again.

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
- [~] 🔴 **Share sheet — Phase B (invisible Android share).** Built 2026-08-13 on
  `feat/android-invisible-share`; **never compiled or run** — no Android SDK on the dev
  box, so it needs an EAS build to confirm. A translucent `ShareActivity` (config plugin
  `mobile/plugins/withInvisibleShare.js` + one Kotlin file) receives `ACTION_SEND`, hands
  the URL to a foreground service and finishes, so the app never flashes.
  ⚠️ Auth uses a **save-scoped share key** (`backend/app/sharekey.py`), not a mirrored
  Supabase token — those expire in ~1h and refreshing from Kotlin would revoke the
  refresh token and sign the user out. ⚠️ `share_key_tier` + `share_key_subject`
  snapshots are load-bearing: without them a Pro user's silent share is entitled as free
  and charges a different daily bucket. ⚠️ Costs a `FOREGROUND_SERVICE_DATA_SYNC`
  declaration in the Play Console at launch.
- [~] 🔴 **Share sheet — Phase A (iOS).** Android done 2026-08-12 (`expo-share-intent@7`
  wired in `mobile/app/_layout.tsx`). iOS needs only a Mac/Xcode build — the package
  covers both platforms. ⚠️ **A native module cannot ship by OTA**: SaveHere appears in
  the share sheet only after the next EAS build is installed.

---

## iOS share — invisible, like Android

- [~] 🔴 **iOS Share Extension saves without opening the app.** Re-enabled 2026-09-10
  after four builds. ⚠️ **`./plugins/withInvisibleShareIOS` MUST be listed BEFORE
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
- [x] **The `FREE_SAVE_LIMIT=500` override is GONE** (owner, 2026-09-13). Staging now
  runs the real numbers: **free 50, pro 500**, both stated explicitly in `render.yaml`
  rather than inherited from `config.py`. ⚠️ **A free account that reaches 50 now gets a
  403 offering a product that cannot be bought** — `app/pro.tsx` renders a paywall with
  no purchase flow behind it. That is the accepted trade: testing the real wall beats
  hiding it. It stops being acceptable the moment a real user is behind it, which makes
  RevenueCat below the true gate on public launch.




- [~] 🔴 👤 **RevenueCat — deliberately AFTER testing, on the move to production**
  (owner, 2026-09-13). ⚠️ Until it exists, free accounts hit a hard 50-save wall with no
  way to buy past it (see the save-caps item above). That is fine for TestFlight and not
  fine for a public listing, so this is the real gate on launch — not a follow-up.
  Manages IAP entitlements, per-territory pricing and promo experiments across
  iOS/Android. **No quota code change needed** — `daily_limit_for()`
  already reads `app_metadata.tier`.
  **The webhook is written but is a SKETCH and is NOT wired** — `app/routes/billing.py`
  exists and is deliberately not registered, because it mints revenue entitlements. Four
  preconditions, all required:
  1. **Mobile must call `Purchases.logIn(supabaseUserId)`** at login. If RevenueCat
     generates an anonymous id, `event.app_user_id` can't be mapped back to a Supabase
     user and the webhook logs a warning and does nothing.
  2. Set `REVENUECAT_WEBHOOK_TOKEN` (plus the existing `SUPABASE_URL` /
     `SUPABASE_SERVICE_ROLE_KEY`). ⚠️ Auth is a shared secret compared constant-time and
     **fail-closed** — an unset token rejects every call, which is the safe default but
     also means it silently does nothing until configured.
  3. Register the router in `app/main.py`.
  4. In RevenueCat: Integrations → Webhooks → point at
     `https://<backend>/api/billing/revenuecat` with the same Authorization value.
  ⚠️ Tier takes effect on the user's **next token refresh (≤1h) or re-login**, not
  instantly — the JWT claim is what `entitlements.py` reads.
- [x] 🔴 👤 **Apple Small Business Program.** Enrolled — **15%**, not 30%. Every margin
  below assumes this.
- [ ] 👤 **Two intro prices still unset — deliberately not guessed.** The **USD monthly
  revert price** (₹99→₹120 is a 17.5% discount; the analogue is ~$8.49) and whether the
  **weekly** plans carry an offer at all. A plan without `introMonths` renders the plain
  renewal sentence, which is true for a plan with no offer — so the gap is safe, just
  incomplete. Needed before App Store Connect setup.
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
- [ ] 👤 **iOS silent shares still cannot report SUCCESS OR FAILURE** — the one part of the
  owner's request that is not done, and it is architectural rather than an oversight. The
  Share Extension's upload is a background `URLSession`; iOS completes it after the
  extension process is dead and delivers that completion to the **containing app** via
  `application(_:handleEventsForBackgroundURLSessionIdentifier:)`. So the extension's
  notification says "Saving…", never "Saved", and there is no second notification. Fixing
  it properly means a `withAppDelegate` config plugin that recreates the session with a
  delegate and posts the outcome — ~100 lines of Swift in a file Expo owns. Worth doing
  once the current build is out and the softer wording has been tried in practice.
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

- [ ] **Deep linking** — `savehere://reel/{id}` so a share-extension save opens the
  detail screen directly.
- [ ] **To-do reminders** — local notification the evening before / morning of a due date.
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
