 — Context & Decisions (handoff)

> Read this + [`TODO.md`](../TODO.md) at the start of any session. This captures
> *why* things are the way they are — decisions and reasoning that aren't obvious
> from the code alone. The prior chat history and personal memory do **not** travel
> between machines/Codespaces; this file is the substitute.

_Last meaningful update: see git log on `develop`._

> **Dev/staging/prod split:** local dev + staging share the `savehere-dev` Postgres +
> Supabase (SQLite retired for local dev 2026-07-21, for Codespaces data persistence);
> staging deploys from `develop`, prod = `SaveHere` Postgres from `main`. Config is
> 12-factor (no code branching) — full env-var matrix in [`ENVIRONMENTS.md`](ENVIRONMENTS.md).

---

## 1. What SaveHere is

An **iOS-first (then Android) mobile app** that saves short-form content — Instagram Reels, YouTube Shorts, TikTok, Threads, LinkedIn posts, Facebook reels — and:
- generates **AI bullet summaries + tags** (Claude Haiku) on save,
- turns content into **action**: step-by-step recipes / task checklists, and workout plans,
- lets you **search**, **rediscover** older saves, and **ask your library** questions answered from your own saves.

Owner: solo developer, on **Windows**, pre-launch, ~1 real user (the dev). No paying users yet.

## 2. Architecture

```
backend/   FastAPI + SQLAlchemy, SQLite (dev). System Python 3.12.
  app/
    main.py              app + CORS + /health + /health/extract + /api/thumbnail proxy
    config.py            env via python-dotenv + os.getenv (reads .env OR real env vars)
    database.py          ReelDB, TaskDB, WorkoutExerciseDB, ExtractionCacheDB, AiUsageDB (+ ALTER-TABLE migrations)
    ratelimit.py         per-IP sliding-window limiter (burst/anti-loop guard)
    quota.py             per-user DB-backed daily AI quota (enforce_daily_ai_quota, AI_DAILY_LIMIT)
    routes/
      reels.py           save/list/get/delete, notes, category, resummarize; extraction cache + eviction
      workout.py         tasks (AI once) + manual add/edit/delete; workout plans
      ask.py             "ask your library" endpoint (burst guard + per-user quota)
    services/
      extractor.py       yt-dlp (process=False, ios/tv/android clients) + page/JSON-LD fallback
      summarizer.py      Claude Haiku summary + tags
      workout_extractor.py  recipe/task + workout extraction
      librarian.py       ask-your-library; retrieval (top-15 relevant) + Claude
      transcriber.py     audio transcription fallback (OpenAI Whisper; needs ffmpeg)
  tests/                 pytest (27 tests) — pure-function + rate-limit + retrieval

mobile/    Expo SDK 57 + expo-router + React Native 0.86 (dev on web).
  app/                   index (library), landing(redirect), save, ask, search, rediscover, help, support, reel/[id], workout/*
  components/            ReelCard, TaskList, Landing, ProfilePanel, Icon (Lucide), AuroraBackground, BorderBeam, …
  services/api.ts        typed API client; BASE_URL from EXPO_PUBLIC_API_URL || localhost:8000
  constants/             theme.ts, features.ts
```

## 3. Current state — what works

- **Save pipeline**: yt-dlp + caption/description fallback + extraction cache. Card persists instantly in ~2 s; AI summary runs async in a BackgroundTask (`summary_status`: `pending → ready/skipped/failed`). Detail screen polls every 2.5 s.
- **Library**: paginated (24/page, infinite scroll via FlatList `onEndReached`), full `total` count, offline banner (web `online`/`offline` events + error state retry).
- Per-reel **AI caps**: tasks generated **once** then manual add/edit/delete; workout ×3. Resummarize is **uncapped per reel** (2026-07-14) — every run charges the per-user daily AI quota, which is the real ceiling; the per-IP burst guard stops loops. The UI notes the quota cost next to the button.
- **Ask your library** — retrieval-based (only top-15 relevant saves sent to Claude).
- **AI outputs show dual units**: °F/°C, lb/g, cup/ml across all 4 prompts (summary, tasks/recipe, workout).
- **Search: removed 2026-08-10, back 2026-08-14 — on the CLIENT.** The server
  vertical (`app/services/search.py`, `GET /api/reels/search`,
  `api.searchReels()`, `tests/test_smart_search.py`) is still deleted and stays
  deleted. What returned is `mobile/services/librarySearch.ts`, a TypeScript
  port of that ranker — same stopwords, synonym groups and weights, since they
  were tuned against real failures — plus `services/libraryIndex.ts`, which
  fetches the library once through the **existing** list endpoint (no new route)
  and tokenizes it once. A keystroke is then a synchronous scan: no debounce, no
  request, no AI action, works offline.
  **The "never Claude-backed" rule is now structural rather than a rule to
  remember**, and it generalized: search fires per keystroke, so it must not hit
  the *server* either — a Render free instance cold-starts in ~50 s.
  ⚠️ It is NOT gated on the AI quota, though that is how it was asked for
  (2026-08-14). Search costs nothing, so gating it would make the app worse for
  everyone with budget left and would recreate the exact "no reachable entry
  point" problem that got the first version deleted. It lives on the library
  header and in the menu; `app/ask.tsx` merely promotes it when the AI budget is
  spent. Category bubbles still narrow the grid.
  Upgrade path if scale ever demands it: an inverted index first, embeddings
  after — neither is close to needed.
- **Safety surfaces**: all disclaimer copy lives in ONE place, `mobile/components/Disclaimer.tsx` (variants: ai / fitness / recipe / ownership / medical). Sensitive (medical/high-stakes) saves are flagged by the summarizer (`is_sensitive`), show the medical disclaimer, and the server refuses tasks/workout generation for them (`routes/workout.py`, 422 before quota charge). A pre-build workout modal sets "generic template, not coaching" expectations.
- Rediscover, Help, landing page.
- Landing: hamburger (☰) opens profile panel; "Ask your library" card shown prominently once ≥3 reels saved; card hidden from panel when shown on landing; "Open my library" below the Ask card.
- Re-summarize button hidden when summary already exists (shown only when summary is empty).
- Editable category, auto-saved notes, link-only bookmarks for login-walled platforms (FB/LinkedIn).
- Per-IP rate limiting incl. daily cap on `/api/ask`; audio download size guard; cache eviction; `/health/extract` self-test.
- 27 pytest tests; `npm run typecheck` and `npx expo export --platform web` both pass.

**Not built yet:** deployment, payments, iOS share extension. (Auth + per-user data ARE built — Phases 1–5 below.)

### Reliability/tier revamp (branch `revamp/reliability-tiers`, 2026-07-09)
SQLite FK enforcement + explicit cascade deletes (no more orphaned tasks/exercises on reel/account delete); the save-time auto-summary now charges the per-user AI quota (was the last uncapped Claude path — over budget the card still saves, summary marked `failed`); workout regeneration no longer destroys the old plan on a failed extraction; thumbnail proxy host check hardened (substring → domain-suffix, https-only, rate-limited); `GET /api/account/usage` powers a mobile AI-usage meter + live tier badge. Full change list, guardrails, and copy-paste prompts for follow-up work: **[`docs/HANDOFF.md`](HANDOFF.md)**.

### Recipe extraction fallback — FIXED (was "highest priority")

The "Could not extract actionable tasks" failure on cooking reels (caption says
"recipe in pinned comment" → no steps) is resolved in `workout_extractor.extract_tasks()`:
when a cooking prompt returns empty tasks it now falls through to `_infer_recipe`
(title/notes-based), and a genuinely un-inferable dish returns `needs_input` →
a friendly 422 asking for a note. Mobile shows this **inline** (`taskError` state +
alert-circle icon in `reel/[id].tsx`), not a `window.alert()`. Locked by
`tests/test_workout_extractor.py` (mock-based, 6 cases covering the fallthrough).

## 4. Key decisions (the "why")

### AI cost & caps
- Model: Claude Haiku `claude-haiku-4-5-20251001`. Pricing **$1/1M input, $5/1M output** `[Certain]`.
- Est. per-ask cost ~**$0.0015** after retrieval (was ~$0.0055 when dumping 60 reels) `[Guessing on tokens]`.
- **Per-user daily AI quota (Phase 5) ✓** — every AI action (ask/tasks/workout/(re)summarize) draws from one **per-user, DB-backed daily budget** keyed on the Supabase user id (`app/quota.py` + `ai_usage` table). Routes call `charge_ai_action(db, user)`. Replaces the old interim per-IP 15/day ask cap: it persists across restarts/redeploys and can't be bypassed by rotating IPs. A per-IP **burst** guard still sits beneath it (anti-loop). Charged *before* the call (a failed gen still cost tokens).
  - **Race-safe:** the charge is a single atomic conditional `UPDATE ... WHERE count < limit` (after an idempotent `INSERT ... ON CONFLICT DO NOTHING`), so concurrent requests can't overshoot the cap — correct on SQLite *and* Postgres, single- or multi-instance.
  - **Tier-aware (the paywall lever):** `daily_limit_for(user)` reads `tier_for(user)` from the JWT's **`app_metadata.tier`** claim (server-set, so a user can't self-upgrade via `user_metadata`). trial → `AI_DAILY_LIMIT` (10); post-trial free → `AI_FREE_DAILY_LIMIT` (3); `pro` → `AI_PRO_DAILY_LIMIT` (20). **Caps finalized by the owner 2026-08-10** alongside pricing — see "Pricing" below for the INR shortfall that was accepted knowingly. **Remaining owner work:** the RevenueCat/IAP webhook must write `app_metadata.tier="pro"` on purchase — no code change to the quota.
- Rule to never cross: **net revenue per user ≥ their token cost.** Price-down and cap-down are ONE lever.
- **Tier mechanics (2026-07-10, `feat/tier-system`):** `app/entitlements.py` is the single source of truth — effective tier **trial** (10 d server-side clock, 30 AI/day) → **free** (3 AI/day trickle + 20-save cap on new saves; library never locks) → **pro** (100/day, unlimited; JWT `app_metadata.tier` stamped by `scripts/set_tier.py` until the RevenueCat webhook). Trial re-signup abuse contained by hashing the normalized email into `trial_grants` (survives account deletion → re-signup continues the old clock). Accepted residues: fresh emails mint fresh trials (Apple IAP fixes the economics at launch); ≤1 h downgrade lag (token TTL); soft save cap under concurrency.

### Pricing (DECIDED 2026-08-10 — see TODO "Pricing & Monetization")
- **Owner-set launch prices:** **India** ₹25/week, ₹99/month · **everywhere else**
  $1.99/week, $7/month. Paired with **Pro = 20 AI actions/day**
  (`AI_PRO_DAILY_LIMIT`). Encoded in `mobile/constants/pricing.ts`; storefront is
  picked by device locale (`/[-_]IN\b/` → INR, else USD).
- **₹99/month is an Apple Introductory Offer: ₹99 for 6 months, then ₹120**
  (owner, 2026-08-10). Configured in App Store Connect + RevenueCat, not in code;
  the app's only obligation is disclosure, which `renewalTerms()` in `pricing.ts`
  now handles — it replaced a hardcoded "auto-renews monthly at ₹99 until
  cancelled" that appeared at two sites in `app/pro.tsx` and would have been a
  false statement (and an App Store review item) the moment the offer went live.
  Apple grants one intro offer per customer per subscription group. ⚠️ The USD
  revert price and whether the weekly plans carry an offer are **still unset** —
  plans without `introMonths` render the plain (and true) renewal sentence.
- **The rule holds in USD and is knowingly broken in INR — a deliberate
  cross-subsidy.** 20/day at ~$0.004 per action is ~$2.43/mo worst case. $7 nets
  $5.95 after Apple's 15% → clears ~2.4x. ₹99 nets ~₹84 (~$0.96) → a maxing INR
  Pro user costs ~2.5x their subscription. Owner's call: run India generous on
  volume, cover it from US margin, revisit when the intro offer expires. ₹99
  breaks even at ~8/day. ⚠️ **Direction matters:** raising the cap widens this gap
  (the cap IS the worst case); the levers are a lower cap or a higher price, and
  closing it later means a storefront-specific tier (`daily_limit_for` already
  branches on tier), not a price edit.
- ⚠️ 20/day is only **2x the trial's 10/day**. The Pro upgrade story therefore
  rests on **feature** gating (ask / tasks / itinerary are Pro-only post-trial —
  `app/entitlements.py`), not on the size of the cap. If conversion disappoints,
  that asymmetry is the first thing to look at.
- The 2026-07-24 cost study recommended ₹149/$5.99 and called ₹99 underwater. The
  owner overrode it on volume grounds. **Watch item, not a resolved question:**
  read the real p50/p95 of `ai_usage.count` for INR Pro users before renewing.
- ⚠️ Prices are stated as a **6-month** commitment; the exact mechanism (Apple
  Introductory Offer that reverts, vs. a flat price reviewed at 6 months) is NOT
  yet pinned down and is App Store Connect config either way, not app code.
- Superseded earlier plan (kept for reasoning): three PPP buckets — **US** ~$4.99/mo,
  $34.99/yr · **EU** ~€5.99/€39.99 (VAT-inclusive) · **India** ₹99/mo, ₹799–999/yr.
  No annual plan is in the shipped paywall; only weekly + monthly.
- **India first-purchase promo:** Apple **Introductory Offer** ₹59/mo × 3 months → ₹99 (auto-renew; Apple's pre-renewal notice = the renewal ask). Optional marketing **offer code `SAVEHEREFIRST`**. NOT a custom coupon (Apple owns IAP billing) and NOT 3 months free.
- iOS subscriptions **must** use Apple IAP (15% via Small Business Program / 30% otherwise) — can't use Stripe in-app. Manage with RevenueCat.
- "Lifetime" tier: deferred for v1 (unbounded AI-cost liability without a hard cap).

### Auth (in progress — Supabase, asymmetric JWT)
- **Supabase** (auth + Postgres in one; $0 free tier through early launch, ~$25/mo Pro for always-on at launch). Project `lukmwwcilrjqqtgqbynq`. Uses the **new key system**: `publishable` (was anon) + `secret` (was service_role), and **asymmetric ECC/ES256 JWT signing** — so the backend verifies tokens against the public **JWKS** endpoint, no shared secret.
- **Phase 1 (connect) ✓** — mobile `@supabase/supabase-js` client in `services/supabase.ts` (AsyncStorage session); env wiring (`SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_JWKS_URL`, `SUPABASE_SERVICE_ROLE_KEY`); `backend/scripts/check_supabase.py` connectivity check.
- **Phase 2 (verify primitive) ✓** — `backend/app/auth.py`: `get_current_user()` dependency verifies ES256 tokens via cached `PyJWKClient`, returns `AuthUser(id=sub, email)`, clean 401s. 9 offline tests (`test_auth.py`, locally-minted EC keypair — no network in CI).
- **Phase 3 (per-user data) ✓** — `user_id` on `ReelDB` (indexed); `url` no longer globally unique → per-user dedup in `save_reel`. Every route in `reels.py`/`workout.py`/`ask.py` now takes `Depends(get_current_user)` and filters by `user_id`; single-item ops use `_get_owned_reel_or_404` (and task/exercise ownership via a join to the parent reel) → 404 (not 403) on someone else's id. `test_search_api.py` seeds two users and proves isolation (list/get/delete/search don't cross users; unauthenticated → 401).
- **Phase 4 (mobile auth) ✓** — `contexts/AuthContext.tsx` (session + `onAuthStateChange`); `components/LoginScreen.tsx` (email/password sign-in/up); auth gate in `app/_layout.tsx` (spinner→login→app); `api.ts` `request()` injects `Authorization: Bearer` from `supabase.getAccessToken()`; sign-out in ProfilePanel. **Dev:** email confirmation OFF (turn ON before launch).
- **Phase 5 (per-user AI quota) ✓** — `app/quota.py` `enforce_daily_ai_quota` + `ai_usage` table; one daily budget across all AI actions, env-tunable per tier (`AI_DAILY_LIMIT` 10 trial / `AI_FREE_DAILY_LIMIT` 3 / `AI_PRO_DAILY_LIMIT` 20); replaces the interim per-IP ask cap. See "AI cost & caps" above.
- **Remaining:** Phase 6 Postgres in prod via `DATABASE_URL`. Keep SQLite for local dev.

### Extraction & bot-detection (datacenter IP) — the prod risk
- **Symptom (2026-06-23):** saving a YouTube Short from the Codespace fails with `[youtube] …: Sign in to confirm you're not a bot`. yt-dlp is current (2026.06.09) — **not** staleness. `[Certain]`
- **Root cause:** YouTube (and IG/TikTok) bot-block requests from **datacenter IP ranges**. Codespaces, **Railway, Render, Fly.io all run on datacenter IPs**, so deploying does NOT fix this — usually **worse** (those ranges are more abused/flagged than GitHub's). It's about **IP reputation + missing PO token/cookies**, not dev-vs-prod. `[Likely]`
- **Decision — layered "extraction gateway", fragile bits isolated behind one swappable `ExtractorProvider`, with graceful degradation:**
  1. **Cache** (exists) — never re-hit the platform.
  2. **Client-side metadata** — app/share-ext grabs oEmbed + OpenGraph (title/desc/thumb) from the *user's* residential/mobile IP. Free, clean distributed IPs, enough for many summaries. No transcript.
  3. **Server yt-dlp behind a residential/mobile proxy** (+ cookies + PO-token plugin), ONLY when a transcript is wanted. Proxy/vendor swappable via env. **The real prod fix.**
  4. **Managed-API fallback** — Apify (we already carry `APIFY_API_KEY`), a transcript API, or YouTube Data API v3 (metadata only) — when self-host extraction fails.
  5. **Async + link-only-now / backfill-later** — never block the request on this path; retry off the request path.
- **Cost:** residential proxies are usage-priced (permanent line item; `[Guessing]` ~$tens/mo early) — fold into the per-user economics rule.
- **Bug found same day:** when yt-dlp is blocked, `_extract_from_page`'s DOTALL regex over YouTube's ~1 MB HTML effectively hangs to the 50s `EXTRACT_TIMEOUT` instead of failing fast. Skip/bound the page-parse for YouTube + degrade gracefully. Violates quality-bar #1.
- **Key win (2026-06-23): the ungated link-preview surface needs a crawler UA.** Instagram/Facebook serve the public `og:` caption (the text that unfurls in iMessage/Slack) **only to recognized preview bots** — a normal browser UA from a server IP gets the login wall. Fetching `_extract_from_page` with UA `facebookexternalhit/1.1` returns the **full caption** (e.g. a whole recipe) even from a datacenter IP, no auth/proxy. So IG/FB **captions are readable** for free; only the video/transcript stays gated. yt-dlp still fails on IG (that's the player API) — the caption comes from the page meta. Implemented in `extractor._PREVIEW_HEADERS`. (Two parser bugs fixed alongside: `_og` catastrophic backtracking on 600 KB minified HTML → scan per-`<meta>`; and missing `DOTALL` dropped multi-line captions.)
- **Async save (2026-06-23):** `/save` now persists the card with `summary_status='pending'` and returns in ~2 s; a FastAPI BackgroundTask runs Claude (and the slow audio fallback) off the request path, flipping to `ready`/`skipped`/`failed`. Detail screen polls; `/api/reels/{id}/summarize` retries. `EXTRACT_TIMEOUT` cut 50→20 s. **Run uvicorn WITHOUT `--reload`** — the reloader's child process dodges `pkill -f uvicorn`, leaving a zombie holding port 8000 (the recurring "Can't reach the server").

### Android invisible share — Phase B (2026-08-13, branch `feat/android-invisible-share`)

Phase A worked but **flashed the app for 1–2 s**: Android delivers `ACTION_SEND`
by launching whatever component declares the filter, and Phase A's was
MainActivity. Phase B moves the filter to a **translucent, content-less
`ShareActivity`** that hands the URL to a short foreground service and finishes,
so the user never leaves Instagram. Added by a custom config plugin
(`mobile/plugins/withInvisibleShare.js` + one Kotlin file).

- **⚠️ The brief's binary — mirror the token to SharedPreferences vs. read the
  SQLite store — was the easy half, and neither option works on its own.** Both
  hand the Activity a Supabase **access token that has usually already
  expired**: they live ~1 h and only auto-refresh while the app is open, so
  someone who opened SaveHere at breakfast and shares at lunch gets a 401. That
  is the majority case, not an edge case.
- **Refreshing from Kotlin was rejected, and this is the load-bearing reason.**
  Supabase rotates refresh tokens, so a native refresh revokes the one the JS
  app still holds and the next launch **signs the user out**. Trading a 1 s
  flash for a random logout is a bad trade. `[Likely]` — rotation is the
  Supabase default; it was not verified against the project's dashboard setting.
- **Decision (owner, 2026-08-13): a dedicated save-scoped share key.** The app
  mints one while it holds a valid JWT (`POST /api/account/share-key`), and the
  Activity carries it. No expiry, no refresh, no rotation hazard, so the
  invisible path works **every** time rather than only within an hour of
  opening the app. Backend: `app/sharekey.py`.
- **Scope is enforced by the routing table, not by a claim.** The key
  authenticates exactly one route, `POST /api/reels/share-save`, which is a
  three-line delegation to the normal `save_reel`. `/save` itself was
  deliberately NOT taught to accept either credential — a stolen key can create
  a saved link and nothing else, and that is checkable by reading the routes.
  `tests/test_sharekey.py` asserts it against list/usage/ask/delete/save.
- **⚠️ Two snapshots are stored with the key and they are not optional.** A
  share-key request carries no JWT, so `tier_for()` would read the caller as
  **free** (a paying Pro user's silent share would hit the 20-save free cap)
  and `quota_subject()` would fall back to `user_id` instead of the
  normalized-email hash — **a separate daily AI bucket, i.e. share a reel to
  dodge the quota**. `share_key_tier` and `share_key_subject` are taken from
  the verified JWT at mint time. They go stale between mints, which is why the
  app re-mints on **every launch**, not just at sign-in.
- Stored as SHA-256 on `profiles` (an existing table, so **no new RLS line** —
  the trap `ai_action_log` and `todos` each fell into). Dies with the account
  automatically, because deletion already drops the profile row.
- **One key per user, latest device wins.** A second device supersedes the
  first, which then degrades to the visible launch path rather than failing.
  Fine while Android is the only platform with the Activity.
- **`expo-share-intent` is now `disableAndroid: true`.** Two components
  advertising the same `ACTION_SEND` filter puts **two SaveHere entries in the
  share sheet**. Its iOS half and its JS handler both stay — the handler is
  still the fallback path (no key yet → forward the intent to MainActivity) and
  the eventual iOS path.
- **The Kotlin does NOT call `saveSharedLink`** — there is no JS runtime in that
  Activity. It reproduces the POST, the notification and the drawer append. It
  deliberately does **not** reproduce the client-side metadata fetch: since
  2026-08-13 the server reads IG captions via the embed route and FB via oEmbed
  (`EXTRACTION_ROUTES.md`), so the phone no longer has to lend its residential IP.
- **AsyncStorage on Android is the SQLite file `RKStorage`** (table
  `catalystLocalStorage`), not SharedPreferences — which is what lets the
  Activity read `@savehere:sharekey:v1` and append to `@savehere:notifications:v1`
  with no bridge at all. Both keys and their JSON shapes are contracts.
- **A foreground service, not a bare thread.** Once the Activity finishes the
  process is cached and can be reaped mid-request; a cold free-tier Render
  instance takes ~50 s to wake, which is exactly that window. The user would
  get no save and no notification having seen nothing. ⚠️ Costs a
  `FOREGROUND_SERVICE_DATA_SYNC` declaration in the Play Console at launch.
- **iOS remains blocked** on the $99 Apple Developer account: a Share Extension
  needs an App Group to share the session, and that entitlement can't be
  provisioned without it. The share key is the piece that will make it easy —
  an extension can carry the same key.

### Visual identity — "Nocturnal Dimension" (2026-08-09, branch `design/nocturnal-dimension`)

Replaces the monochrome ink system, which itself had already replaced (undocumented)
the "Ember on Ink" identity still written up in [`HANDOFF.md`](HANDOFF.md) §4.5 —
that section is now marked **RETIRED**. Full spec: [`DESIGN_PROPOSAL.md`](DESIGN_PROPOSAL.md).

- **Where it comes from:** Refero token sets for Suno (surfaces, ink, pink haze),
  Vapi (accent orange), Dimension (layout rhythm, capsule nav, 24px card radius),
  Hyper Foundation (accent-glow elevation). Real extracted tokens, not invented.
- **Canvas moved off absolute black:** `background` `#000000` → `#101012`. Every
  contrast ratio in `theme.ts` was re-measured against the new base;
  `textTertiary` had to move `#787878` → `#7E7E7E` because the old value drops to
  **4.33:1** on `#101012` and would have shipped below AA.
- **One accent hue again:** `accent` `#F8F8F8` → `#E96B34` (Vapi Orange, 6.0:1).
  Chosen over Suno's pink specifically because it sits ~4 hue-degrees from the
  retired ember `#FF6B3D`, so the change reads as continuity. `accentLight`
  `#FD429C` is a **gradient stop only** — never a fill.
- **`danger` now carries hue** (`#E05561` dark / `#B3323E` light). ⚠️ **Derived,
  not sourced** — neither Suno nor Vapi ships a red; it is Suno Vivid Pink
  rotated 337°→355° and desaturated 98%→69%. `success`/`warning` stay monochrome
  and read by wording, so orange is still the only *decorative* colour on screen.
- **`gradients.haze` + `hazeLocations`** are the only real ramp besides `scrim`.
  Render once at the screen root, `pointerEvents="none"`, never per-card.
- **No blur, deliberately.** The whole point of this hybrid is that it avoids
  `expo-blur`/`backdrop-filter`, so Android and web render identically to iOS at
  the same cost. Do not reintroduce glassmorphism to "finish the look".
- **No Fraunces.** Owner's call — avoids font-loading latency (decided on SDK 56;
  the reasoning is about font loading, not the SDK, so it survives SDK 57).
  `typeface.serif` still resolves to `Inter_600SemiBold`; headers and titles use
  Inter. Any doc claiming Fraunces is in the app is wrong.
- **Haze backdrop visibility constraints (2026-08-09):** the `gradients.haze`
  background wash is visually blocked by full-bleed library-grid thumbnails.
  Keep haze as an atmospheric layer for **sparse screens only** (login wall,
  workout rest phase). Do **not** try to solve grid coverage with blur — that
  reintroduces the `expo-blur`/`backdrop-filter` cost this direction exists to
  avoid, on web previews and Android alike.
<!-- - **Monochrome light-scheme integrity:** the Nocturnal Dimension colour shifts
  apply **strictly to the dark scheme**. Light stays flat monochrome so the
  contrast gates hold, with one exception: the semantic `danger` state
  (`#B3323E`, 6.1:1 on white). -->
- **Not yet built:** capsule tab bar, centre FAB, home haze/pill row. `theme.ts`
  is the only source file changed so far — see the TODO section
  "Design Experiment: Refactor Home & Nav to Nocturnal Dimension".
<!-- - **Runtime Scheme Re-Theming & Light Mode Guard (2026-08-09):** The `setScheme` function in `theme.ts` erases key types via `as Record<string, readonly string[]>` casting, which masks stale references and skips runtime re-theming for `haze`. The light scheme must remain strictly flat monochrome to prevent dark/chromatic washes from rendering over a white UI and violating WCAG AA boundaries.
- **Haze Backdrop Visibility Constraints:** The `gradients.haze` background wash is visually blocked by full-bleed library grid thumbnails. Keep haze as an atmospheric layer for sparse screens only (Login wall, Workout rest phases). Do not use blur overlays due to performance overhead on web previews. -->
- **Absolute Navigation Clearance & Hiding Rules (2026-08-09):** Primary screens with pinned bottom CTAs (such as `/save`, `/pro`, and `/workout/`) must hide the absolute capsule navigation bar by registering their paths in TabBar.tsx's `HIDE_ON` array. This keeps the primary view fully interactive without introducing complex padding calculations. All other scrollable screens must clear the floating bar using the unified `TAB_BAR_CLEARANCE = 72` constant.
**Haze Backdrop Visibility Constraints (2026-08-09):** The `gradients.haze` background wash is visually blocked by full-bleed library grid thumbnails. Keep haze as an atmospheric layer for sparse screens only (Login wall, Workout rest phases). Do not try to solve grid coverage with blur due to performance overhead on web previews.
<!-- **Monochrome Light Scheme Integrity:** The "Nocturnal Dimension" color shifts apply strictly to the dark scheme. The light scheme must remain flat monochrome to avoid breaking WCAG AAA text/contrast safety gates, except for the high-contrast semantic `danger` state (#B3323E). -->

### App lifecycle — the listener that did not exist (2026-08-14)

Until this date the app had **no `AppState` listener anywhere** — zero
occurrences repo-wide. Every screen's only refresh trigger was
`useFocusEffect`, which is *router* focus, not app lifecycle. That single gap
produced two separate owner-reported bugs, and it will produce more if the
listener is ever removed or duplicated.

- **One listener, in `app/_layout.tsx`'s `Gate`.** It emits two `uiBus` events:
  `appResumed` on `'active'`, `dismissOverlays` on `'background'`. Screens
  subscribe to what they care about. Do NOT add a second listener in a screen —
  the point is that lifecycle handling lives in one place and cannot drift.
- **Dismiss on `'background'` ONLY, never `'inactive'`.** iOS emits `'inactive'`
  for transient interruptions (notification shade, app switcher preview), and
  closing someone's half-typed to-do because they glanced at a notification
  would be worse than the bug being fixed.
- **`AppState.addEventListener` returns `undefined` on react-native-web** when
  `document.visibilityState` is unavailable, so the cleanup is `sub?.remove()`.
  An unguarded call throws at the root of the tree.
- **Why the library needed it at all:** the Android share Activity saves without
  ever entering the JS process (see the Phase B section above), and returning to
  a still-mounted screen fires no focus event. The card existed on the server and
  no screen had any reason to ask again.
- **`closeProfile` became `dismissOverlays`.** The old event was aimed at one
  component and fired only for a brand-new, URL-bearing share intent, behind
  three early returns — so seven other modals, and every non-share way of
  leaving the app, were never covered. The emitter must not know the inventory.
  ⚠️ `OnboardingModal` is excluded on purpose: it has no dismiss by design, and
  closing it without running `finish()` burns the first-run tour without
  stamping its seen-flag.

### Quota reset is a display problem, not a scheduling one (2026-08-14)

- The quota day is a **UTC calendar date** and resets implicitly: `ai_usage` is
  keyed `(user_id, day)`, so at 00:00 UTC the lookup key changes and a fresh row
  is inserted at 0. There is no cron and nothing to schedule.
- **Nothing re-runs missed summaries when it resets.** An over-quota save is
  written `summary_status='quota_exceeded'`, and `recover_pending_summaries`
  filters on `pending` only — so there is no thundering herd of Claude calls at
  midnight, and no need to ask the user's permission for one. What there *was*
  instead: `quota_exceeded` rendered no retry button at all, so those reels were
  a permanent dead end. The button now returns once `usage.remaining > 0`.
- `resets_at` has always been in `/api/account/usage`; it was simply never
  displayed. `mobile/services/quotaReset.ts` renders it in the user's own clock —
  **"tomorrow" was actively wrong**, since midnight UTC is 5:30 AM in India and
  8 PM the previous day in California. Formatted by hand, not with
  `toLocaleTimeString`: Intl options are honoured inconsistently across Hermes
  builds and a meter that reads differently per device is worse than one that is
  plain everywhere.

### Adding a platform is five lists, not one (Threads, 2026-09-17)

`detect_platform()` returning `"unknown"` is a **hard 400 at save time** —
`routes/reels.py` rejects the URL before anything else runs. So a platform is
either in that function or it is not supported at all; there is no partial
state. Threads needed **both** `threads.net` and `threads.com` — Meta moved the
domain, the app shares `.com`, and every link shared before the move is a live
`.net` URL. Recognising one host would have rejected half the real links, which
is the identical bug `lnkd.in` caused for LinkedIn (see the note in
`detect_platform`).

Nothing else had to be written for it to work: yt-dlp has no Threads extractor,
so a Threads save falls through to the **public page-meta path** at the bottom
of `extract_info()` — the same route LinkedIn and Facebook take — and its images
come from `cdninstagram.com`/`fbcdn.net`, already in `_THUMB_HOSTS`. The other
four lists are parity, not plumbing: `_PROBE_HOSTS` (`main.py`), the wall/weak
title sets (`routes/reels.py`), and on mobile `platformMeta`, `platformLabel`
and `readFailure`'s placeholder regex.

⚠️ **A brand glyph fails SILENTLY.** `platformMeta.icon` goes to Ionicons, and a
name Ionicons doesn't know renders an **empty box**, not an error. `logo-threads`
is real in `@expo/vector-icons` 15 — checked against the glyph map, not assumed.
Check the next one the same way.

### Categories are one list in four places (shopping, 2026-09-17)

`summarizer.CATEGORIES`, `reels.ALLOWED_CATEGORIES`, `theme.CATEGORY_OPTIONS`
and `theme.categoryMeta` must agree, and the last one also needs a Lucide glyph
in `Icon.tsx`. The column is a plain `String` — **no migration**, and an
unrecognised value already degrades to `"other"` on both write paths.

The part that is not bookkeeping is the **prompt**. A new category with no
disambiguation line just scatters: `shopping` overlaps `fashion`, `beauty` and
`tech` on subject matter, so the rule added to the prompt tests the TAKEAWAY
instead — how to wear it is fashion, which to buy is shopping; a gadget
explained is tech, a gadget recommended is shopping. Search synonyms were kept
deliberately short for the same reason (`product`, `review` and `store` were all
rejected as too generic to be precise).

### OTA updates were installed but invisible (2026-09-17)

`expo-updates` had been a dependency since 2026-08-15 and **nothing ever called
it**. With the default `ON_LOAD` config an update downloads during one launch
and applies on a later one, silently — so "JS ships without an APK" was true of
the pipeline and not of the user's experience. `services/appUpdate.ts` now reads
that state machine and the profile panel shows a button when, and only when,
there is something to apply. It never applies on its own: an OTA swaps the
bundle and restarts, and doing that under someone mid-save is a data-loss shape.

Two traps are recorded in that file rather than here because they bite at the
call site: `Updates.isEnabled` is **hardcoded `true` in the web shim** (so the
guard is `Platform.OS !== 'web' && isEnabled`), and `reloadAsync()` **never
resolves on success** — nothing may be scheduled after it.

## 5. Known gotchas / constraints

- **Windows dev**; line endings show LF→CRLF warnings (harmless).
- **YouTube/IG bot-block on datacenter IPs** — extraction fails from the Codespace **and will fail on Railway/Render/Fly** (all datacenter IPs). Needs a residential proxy / managed API in prod — see §4 "Extraction & bot-detection". Biggest prod reliability risk for the core feature.
- Rate limiter is **in-memory + per-process** — fine for one instance; needs Redis for multiple.
- DB is **SQLite** (single file) — not for multi-user prod; migrate to Postgres with auth.
- Mobile dev is on **web**; native device testing needs EAS/Mac (deferred).
- In a Codespace, the browser's `localhost:8000` does NOT reach the container backend — set `EXPO_PUBLIC_API_URL` to the forwarded backend URL (see `docs/REMOTE_DEV.md`).
- Audio transcription needs **ffmpeg** installed (optional path).

## 6. Next steps (recommended order)

0. **Fix recipe extraction fallback** — `workout_extractor.py` `extract_tasks()` + mobile error UX (see §3 "Pending fix"). One-file backend change + one-function mobile change.
1. **Set the Anthropic console monthly budget cap** (owner action — the only hard cost ceiling today).
2. **Auth + per-user data** (Supabase): users table, `user_id` everywhere, per-user filtering, per-user AI quota. *Largest pure-code unlock; enables tiers/referrals/quota.*
3. **Deploy backend** (Railway/Render) + point `EXPO_PUBLIC_API_URL` at it + lock CORS + Postgres. Repo is deploy-ready (`render.yaml`, env-driven CORS/DATABASE_URL, `$PORT` start, `/health` check) — owner action: connect repo, set `ANTHROPIC_API_KEY`.
4. **iOS share extension** (needs Mac/EAS) — the core capture gesture.
5. ~~**Server-side search**~~ — built, **deleted 2026-08-10** when the UI entry
   point was removed and nothing could call it, and **not** revived on
   2026-08-14 when search returned client-side. Don't rebuild it. See §3.
6. Pricing/IAP config in App Store Connect (intro offer, offer code, regional prices) — at launch.

See [`TODO.md`](../TODO.md) for the full, categorized checklist.

## 7. Theme & Layout Constraints

1. **Absolute Capsule Navigation Offsets (2026-08-09):** The absolute-positioned capsule bottom navigation bar floats over app screens [4]. All primary CTAs (e.g., "Start Workout", "Create Itinerary", "Study Plan") and list footers must explicitly reserve a bottom offset container padding (e.g., `paddingBottom: insets.bottom + 80`) to remain visible and fully interactive. Never allow content to render underneath the navigation layer.

2. **Active Tab Bar Matching Rules (2026-08-09):** Custom sliding tab indicators that rely on path-matching must explicitly handle the root path `/` using exact equality (`pathname === '/'`) rather than prefix matching (`startsWith`). This prevents matcher collisions where child directories (like `/library`) activate the Home indicator [5].
3. **Mobile Focus Transitions:** To maximize typing efficiency, navigating to text-input intensive screens (such as "Ask Your Library") must programmatically trigger input focus on transition mount (`autoFocus={true}` or ref-driven delayed focus), ensuring the user's keyboard is immediately open with zero extra taps [22].