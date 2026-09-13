<div align="center">

<img src="mobile/assets/icon.png" width="104" alt="SaveHere logo" />

# SaveHere

**Save any Reel, Short, or Post — get an instant AI summary, then turn it into action.**

![Python](https://img.shields.io/badge/Python-3.12-3776AB?logo=python&logoColor=white)
![FastAPI](https://img.shields.io/badge/FastAPI-0.115-009688?logo=fastapi&logoColor=white)
![Expo](https://img.shields.io/badge/Expo-SDK%2056-000020?logo=expo&logoColor=white)
![Claude](https://img.shields.io/badge/AI-Claude%20Haiku-D97757)
![License](https://img.shields.io/badge/license-MIT-green)

</div>

---

SaveHere is an **iOS-first mobile app** (Android next) that turns the short-form content you save into a searchable, actionable second brain. Share a link from Instagram, YouTube, TikTok, LinkedIn, or Facebook and SaveHere extracts the content, generates a **bullet-point AI summary and tags** with Claude, and then lets you **act on it** — step-by-step recipes, task checklists, workout plans — **search** it, **rediscover** forgotten saves, and **ask your whole library** questions answered only from what you saved.

---

## ✨ Highlights

### Capture & summarize

- One-tap save from Instagram, YouTube, TikTok, LinkedIn, Facebook
- 📲 **Share directly from the source app** — SaveHere appears in the Android/iOS
  share sheet, so a reel goes from Instagram into your library without a copy-paste.
  (Needs a native build; `expo-share-intent`, wired in `mobile/app/_layout.tsx`.)
- 👻 **…and on Android it's invisible** — a translucent no-display Activity
  (`mobile/plugins/withInvisibleShare.js`) saves the link and finishes, so you
  never leave Instagram. No app flash, just a notification when it's kept.
- 🔔 **Notification centre** — a background share posts a local notification, and
  the last 10 are kept in the hamburger menu with read/unread and per-item delete.
  The OS shade is not a record; this is the only place a save made while you were
  in Instagram can still be audited afterwards (`mobile/services/notifyLog.ts`).
- AI bullet summaries + auto tags + auto category (Claude Haiku) — grounded in the actual captions/transcript, never invented
- Works in any language; summaries match the source
- Auto-saved personal notes; editable category; re-summarize (capped)
- Graceful handling of login-walled posts (saved as a labelled bookmark to annotate)

### Turn it into action

- 🍳 **Recipes & checklists** — step-by-step instructions extracted from how-to / cooking content
- 🏋️ **Workout plans** — exercises with sets/reps/rest, plus a guided session player
- 🧳 **Trip itineraries** — travel saves become a real day-by-day plan with named landmarks, neighbourhoods and food stops. Anything the reel states takes priority; Claude fills the gaps around it from its own knowledge of the destination, so a reel that only names "Tokyo, Kyoto, Osaka" still produces a usable trip rather than "Explore Tokyo". **This is the one AI surface that is deliberately not grounded-only** (see [CLAUDE.md](CLAUDE.md) quality bar #5) — unverifiable specifics like prices and opening hours are still never asserted, and an AI-organised day grouping is flagged as estimated
- ✅ **Your slate** — a cross-reel list of what you actually meant to do. Add any save to it (title + summary are copied in, so it still reads after the reel is gone), pick a date from an inline calendar, set a priority, and the home screen shows Today and Upcoming side by side. Past dates are refused, one open task per save, finishing one asks whether to clear the save from your library, and a **daily goal** tracks completions against the device's own calendar day. **Zero AI cost** — it's your own text, not a generation
- ✍️ **Manual control** — AI generates once, then you add / edit / delete items yourself (no repeat AI cost)

### Find & rediscover

- 🗂️ **Category filtering** across the library — sixteen categories assigned by the summarizer, filterable from the grid
- 🔎 **Search**, on your device — titles, tags, categories, summaries and your own notes, ranked by relevance, with synonyms ("gym" finds fitness) and typo tolerance. Every keystroke is a local scan of a library that was fetched and tokenized once: **no request per keystroke, no AI action, works offline.** *(The Aug 2026 server-side ranker was ported to TypeScript for exactly this reason — search fires per keystroke, and the free-tier backend cold-starts in ~50 s.)*
- 🧭 **Rediscover** — resurfaces older saves so they don't get forgotten
- 💬 **Ask your library** — natural-language questions answered from your own saves, with sources, **streamed token-by-token** (first words in ~1.4 s instead of a 3 s wall of silence). Unlike search, each question costs an AI action; when the daily budget is spent the screen says exactly when it comes back and points at search.

### Design

- ⬛ **"Contact Sheet"** — an achromatic system: absolute black or white canvas, one
  foreground tone, 1px hairline seams, **zero radius, zero shadows, no accent hue
  anywhere in the chrome**. The reasoning is in the reference lock at the top of
  [`mobile/constants/theme.ts`](mobile/constants/theme.ts): the app's cards are
  *thumbnails*, each arriving with its own palette, so the interface deliberately
  spends no colour of its own — the saved content is the only colour on screen.
- 🌗 **Light / Dark / System**, switched live from the profile panel. Everything that
  colour used to encode is re-encoded so it survives an achromatic palette *and*
  colourblindness: priority is mark shape, severity is a stated heading plus border
  weight, platform is a tracked wordmark, progress is discrete marks
- 🅰️ **Inter**, one family across the whole app — hierarchy is carried by size,
  weight and letter-spacing rather than colour
- 🧱 **Staggered masonry library** — tiles go to whichever column is shortest, with
  the aspect **hashed from the reel id** so it never reflows when an image loads.
  All four ratios are portrait: seeding them by *platform* was tried and reverted,
  because landscape wells for YouTube/LinkedIn put two tile shapes in one grid and
  that is what made the wall look inconsistent. A tile's width comes from its grid
  and its height comes from that ratio — one rule per dimension, never both.
  **The library is the one sanctioned exception to the zero-radius rule**
  (owner, Aug 2026): 16px corners and a 12px gutter, researched against
  Pinterest, where gutter and page margin are equal and the radius is a constant
  — never a fraction of tile width. Everything outside the grid is still square.
- 🎞️ **A live welcome wall** — the signed-out screen drifts three tilted columns
  of mock reel cards in alternating directions. Drawn entirely in code — no
  photography, no bundled assets, nothing anyone else owns; honours "reduce motion"

### Accounts, tiers & safety

- 🔐 **Supabase auth** — every route scoped to the caller; ownership 404s, JWT verified against JWKS (no shared secret)
- 🎫 **Server-side tiers** — trial → free → pro, with a per-user **daily AI quota** that is atomic and race-safe, plus feature gating enforced with real 403s (the locked buttons in the app are cosmetic)
- 🩺 **Sensitive-content containment** — the summarizer flags high-stakes medical/health advice; flagged saves keep their summary but never become action plans, and the flag is a **one-way latch** so a prompt-injected note or caption can't clear it
- 🗑️ **True account deletion** — data wipe *and* the Supabase auth record, with honest failure reporting (Apple 5.1.1(v))

### Reliability & cost control

- Extraction cache (re-saving is instant and never re-hits the platform) with TTL eviction
- Per-user daily AI quota (the real cost ceiling) + per-reel AI caps + per-IP burst guard
- Usage drill-down — see exactly what today's AI actions were spent on
- `/health` and `/health/extract` self-test endpoints; image proxy for CDN-blocked thumbnails
- 🖼️ **Thumbnails repair themselves, and fall back to a drawn cover when they can't.**
  Instagram's CDN links are *signed* and die ~5 days after the save, so every Instagram
  save eventually stops rendering — `POST /api/reels/{id}/thumbnail` re-resolves one from
  the embed page (**no AI action charged**; it's our data going stale, not something the
  user asked an AI for), bounded to one attempt per reel per session. When there is no
  picture to be had at all, the tile draws a **generated cover** instead — one gradient
  and an oversized category glyph, deterministic from the reel id, no network and no
  assets. It reads as a cover the app chose, not as a broken image.
- Backend test suite — **250 pytest tests** across 24 files

---

## 🧱 Tech stack

| Layer | Technology |
| --- | --- |
| Mobile | React Native 0.86 + **Expo SDK 57** (expo-router), Reanimated, Moti, Lucide icons, Inter |
| Backend | **FastAPI** (Python 3.12) + SQLAlchemy |
| Database | SQLite (dev) → **Supabase Postgres** (prod — migration pending, see [TODO.md](TODO.md)) |
| Auth | **Supabase Auth** (email today; Apple + Google before launch) — ES256 JWTs verified via JWKS |
| AI | Anthropic **Claude Haiku** (`claude-haiku-4-5-20251001`) |
| Extraction | yt-dlp (+ WebVTT caption parser, JSON-LD / Open Graph fallback) |
| Transcription | OpenAI Whisper (optional, audio fallback — **off unless `OPENAI_API_KEY` is set**) |
| Billing | **RevenueCat** → Apple IAP (webhook sketched, not yet activated) |

---

## 🚀 Quick start

### Prerequisites

- Python **3.12+**, Node **20+**
- An **Anthropic API key**
- [ffmpeg](https://ffmpeg.org/) on PATH (optional — only for the audio-transcription fallback)

### 1. Clone & configure

```bash
git clone https://github.com/LeoPrasanna/findable.git
cd savehere
cp .env.example .env          # then edit .env and add your ANTHROPIC_API_KEY
```

### 2. Backend

```bash
cd backend
pip install -r requirements.txt          # (a virtualenv is optional but recommended)
python -m uvicorn app.main:app --reload --port 8000
```

API runs at `http://localhost:8000` · interactive docs at `http://localhost:8000/docs`.

### 3. Mobile (Expo Web for local dev)

```bash
cd mobile
npm install
npx expo start --web
```

The app calls `http://localhost:8000` by default. To point it elsewhere (e.g. a cloud backend), set `EXPO_PUBLIC_API_URL` before starting Expo.

> **Coding remotely / while travelling?** See **[docs/REMOTE_DEV.md](docs/REMOTE_DEV.md)** for GitHub Codespaces + Claude Code setup.

---

## 🔐 Environment variables

Copy `.env.example` → `.env`. Only `ANTHROPIC_API_KEY` is required to run locally. **Never commit `.env`.**

| Variable | Required | Description |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | **Yes** | Claude Haiku — summaries, tags, recipes, workouts, itineraries, ask |
| `SUPABASE_URL` | For auth | Supabase project URL |
| `SUPABASE_PUBLISHABLE_KEY` | For auth | Publishable/anon key (safe to ship in the app bundle) |
| `SUPABASE_SERVICE_ROLE_KEY` | For auth | **Backend only — never expose.** Admin ops: account deletion, tier writes |
| `SUPABASE_JWKS_URL` | No | Defaults to `$SUPABASE_URL/auth/v1/.well-known/jwks.json` |
| `DATABASE_URL` | Prod | Postgres URL. **Unset = SQLite** — must be set in prod or Render's ephemeral disk loses the DB on every redeploy |
| `OPENAI_API_KEY` | No | Whisper audio fallback (needs ffmpeg). ⚠️ Currently **uncapped** — see [TODO.md](TODO.md) before enabling. Unset = the audio download is skipped entirely, not just the transcription |
| `APIFY_API_KEY` | No | Carried in config but **not referenced anywhere in the code** — no managed-scraper fallback is implemented |
| `EXTRACTOR_PROXY_URL` | No | Outbound proxy for all extraction traffic (yt-dlp + httpx). **Unset = free and a true no-op:** no proxy argument is passed anywhere and behaviour is identical. 💸 Setting it to a residential/mobile proxy is usage-priced (~$2–8/GB) with **no ceiling in code** — add the per-user proxy cap in [TODO.md](TODO.md) first. Never point it at a free public proxy list |
| `SENTRY_DSN` | No | Error monitoring; empty = disabled |
| `REVENUECAT_WEBHOOK_TOKEN` | Launch | Shared secret for the billing webhook (fail-closed when unset) |
| `TRUSTED_PROXY_HOPS` | No | Trusted reverse proxies in front (default `1`; `0` = never trust `X-Forwarded-For`) |
| `AI_DAILY_LIMIT` / `AI_FREE_DAILY_LIMIT` / `AI_PRO_DAILY_LIMIT` | No | Daily AI actions per tier (trial 10 / free 3 / pro 20) |
| `TRIAL_DAYS` / `FREE_SAVE_LIMIT` | No | Trial length (10) and post-trial save cap (20) |
| `ENV` | No | `development` (default) or `production` |

---

## 🗂️ Project structure

```text
savehere/
├── backend/                       # FastAPI + SQLAlchemy
│   ├── app/
│   │   ├── main.py                # app, CORS, /health, /health/extract, thumbnail proxy
│   │   ├── config.py              # settings (.env or env vars)
│   │   ├── database.py            # SQLAlchemy models + lightweight migrations
│   │   ├── auth.py                # Supabase JWT verification (JWKS, ES256)
│   │   ├── entitlements.py        # tier math — THE source of truth (trial/free/pro + feature flags)
│   │   ├── quota.py               # atomic per-user daily AI quota + ai_action_log
│   │   ├── ratelimit.py           # per-IP burst guard (proxy-aware)
│   │   ├── routes/                # reels, workout (tasks/recipes/workouts/itineraries), ask, todos, account, billing
│   │   └── services/              # extractor, summarizer, workout_extractor, librarian, transcriber
│   ├── scripts/                   # set_tier.py, dev_tier.py, enable_rls.sql
│   └── tests/                     # pytest suite (250 tests)
├── mobile/                        # Expo Router app
│   ├── app/                       # library, save, reel detail, ask, search, rediscover, todos, help, support, pro, workout
│   ├── components/                # kit.tsx (design primitives), ReelCard, TaskList, TodoEditor, Landing, Icon, …
│   ├── constants/                 # theme (design system + reference lock), pricing, features, todoBrand
│   └── services/                  # api.ts (typed client), todoDates.ts + todoSettings.ts, …
├── docs/
│   ├── CONTEXT.md                 # architecture + decisions handoff
│   └── REMOTE_DEV.md              # Codespaces + Claude Code setup guide
├── CLAUDE.md                      # project instructions for Claude Code
├── TODO.md                        # open work only — the release gate
├── docs/SHIPPED.md                 # what's done + why: decisions, rejected options, traps
└── .env.example
```

---

## 📡 API reference

All `/api/*` routes require a Supabase `Bearer` token and are scoped to the caller (someone else's id returns **404**, never 403 — that would leak its existence). The single exception is `/api/reels/share-save`, which takes an `X-Share-Key` instead — see below.

| Method | Endpoint | Description |
| --- | --- | --- |
| `POST` | `/api/reels/save` | Save a URL — returns instantly; extraction + summary run in the background |
| `POST` | `/api/reels/share-save` | Same work, authenticated by `X-Share-Key` — the Android invisible-share Activity, which runs outside the JS runtime and has no Supabase session |
| `POST` / `DELETE` | `/api/account/share-key` | Mint / revoke that key. It is save-scoped **because it authenticates only the route above** — no read, no delete, no AI, no account access |
| `GET` | `/api/reels` | List saved reels (category filter, `limit`/`offset`, returns `total`) |
| `GET` | `/api/reels/{id}` | Get a single reel |
| `POST` | `/api/reels/{id}/summarize` | Run/retry the first summary |
| `POST` | `/api/reels/{id}/resummarize` | Re-run the AI summary (notes are folded in) |
| `PATCH` | `/api/reels/{id}/notes` · `/category` | Update notes / set category |
| `DELETE` | `/api/reels/{id}` | Delete a saved reel |
| `POST` `GET` | `/api/reels/{id}/tasks` | Generate (AI, once) / fetch tasks or a recipe |
| `POST` | `/api/reels/{id}/tasks/manual` | Add a task/step by hand (no AI) |
| `PATCH` / `DELETE` | `/api/tasks/{id}` | Toggle / edit / delete a task |
| `POST` `GET` | `/api/reels/{id}/workout` | Generate (×3 max) / fetch a workout plan |
| `PATCH` | `/api/exercises/{id}` | Edit an exercise |
| `POST` `GET` | `/api/reels/{id}/itinerary` | Generate (×3 max) / fetch a trip itinerary — travel only, **Pro** |
| `POST` | `/api/ask` | Ask a question answered from your library — **Pro** |
| `POST` | `/api/ask/stream` | Same, streamed token-by-token + trailing sources — **Pro** |
| `GET` | `/api/todos` | The open list, date-then-priority ordered, plus stats (`?include_completed=true`; `?today=YYYY-MM-DD` adds today's completion count for the daily goal) |
| `POST` | `/api/todos` | Create a to-do — only `title` is required (no AI, no quota) |
| `GET` `POST` | `/api/reels/{id}/todo` | Check for / create this save's task — title + summary copied in, `reel_id` linked |
| `PATCH` / `DELETE` | `/api/todos/{id}` | Edit / complete / delete a to-do |
| `GET` | `/api/account/usage` | Tier, trial countdown, AI budget, save cap, feature flags |
| `GET` | `/api/account/usage/log` | What today's AI actions were spent on |
| `DELETE` | `/api/account` | Delete all data **and** the Supabase auth record |
| `GET` | `/health` · `/health/extract` | Service + extraction self-test (`?live=1` runs a real probe) |

---

## 🎬 Supported platforms

| Platform | Extraction | Captions / text | Audio fallback |
| --- | --- | --- | --- |
| YouTube Shorts | ✅ | ✅ Auto-captions (all languages) | ✅ |
| Instagram Reels | ✅ | ⚠️ Public only | ✅ |
| TikTok | ✅ | ⚠️ Partial | ✅ |
| LinkedIn posts | ✅ (JSON-LD) | ⚠️ Login-walled → paste text in Notes | — |
| Facebook reels | ⚠️ Bookmark | ⚠️ Login-walled | — |

> Videos longer than 10 minutes are rejected — SaveHere is built for short-form content.

---

## 💸 AI cost controls

Every AI feature spends Claude tokens, so spend is bounded in four independent layers:

1. **Per-user daily quota** — the real ceiling. Every AI action (summary, re-summary, recipe, workout, itinerary, ask) draws from one budget keyed on the Supabase user id. The charge is a single **atomic conditional `UPDATE`**, so concurrent requests can't overshoot; it's DB-backed, so it survives restarts and can't be reset by rotating IPs. Any new AI endpoint **must** call `charge_ai_action()`.
2. **Tier limits** — trial 30/day, post-trial free 3/day, pro 100/day (all env-tunable).
3. **Per-reel caps** — recipes/tasks generate once (then you edit by hand), workouts ×3, itineraries ×3.
4. **Per-IP burst guard** — an anti-loop layer beneath the quota, proxy-aware (`X-Forwarded-For` is read from the right past `TRUSTED_PROXY_HOPS`, so a client can't forge it).

Plus: **retrieval, not dumping** — ask sends only the most relevant saves to the model; and a **hard monthly cap** is set in the Anthropic console as the last-resort ceiling.

> ⚠️ Two paths are **not** yet capped: the optional Whisper audio fallback and the (future) residential extraction proxy. Both are usage-priced with no per-user ceiling — see [TODO.md](TODO.md) before enabling either.

---

## 🧪 Testing

```bash
cd backend && python -m pytest tests/ -q     # 250 tests across 24 files
cd mobile  && npm run typecheck              # mobile type check (uses --stack-size=16000)
cd mobile  && npx expo export --platform web # validate the web build
cd mobile  && npm run test:library           # library reconciliation (in-flight deletes, patches)
cd mobile  && npm run test:notifications     # notification-drawer list ops + tolerant parse
cd mobile  && npm run test:todos             # to-do list reconciliation
cd mobile  && npm run test:roll              # tagline roll geometry
cd mobile  && npm run test:search            # library search ranking (category, synonyms, typos, scale)
cd mobile  && npm run test:quota             # "AI comes back at…" day/clock arithmetic
```

CI runs both on push/PR, path-scoped so a mobile-only change doesn't run the Python suite (`.github/workflows/ci.yml`, `mobile-ci.yml`).

### Testing the tier system locally

Tiers are computed server-side, so seeing the post-trial **free** experience otherwise means waiting out the trial:

```bash
cd backend
python scripts/dev_tier.py status                # every local user + effective tier
python scripts/dev_tier.py expire <user-id>      # → free   (applies on the next request)
python scripts/dev_tier.py trial  <user-id>      # → trial
python scripts/dev_tier.py resetquota <user-id>  # clear today's AI counter
python scripts/set_tier.py <user-id> pro         # → pro — then sign out and back in
```

`dev_tier.py` refuses to run against a non-SQLite `DATABASE_URL`. **Pro behaves differently from the others**: it lives in the Supabase JWT claim, which caches for up to an hour — trial/free are recomputed from the DB on every request.

---

## 🗺️ Roadmap

**Built:** auth + per-user scoping, the tier system (trial/free/pro) with server-side feature gating, per-user AI quota, ask streaming, trip itineraries, sensitive-content containment.

**Next, in dependency order:**

1. **Postgres migration** — ⚠️ the urgent one. Render's disk is ephemeral, so on SQLite **every redeploy wipes the database**. Also unblocks `enable_rls.sql`.
2. **Environments** — dev / staging / prod (no PreProd: with one developer, staging *is* preprod).
3. **Apple + Google sign-in** — Apple's guideline 4.8 makes the pair mandatory once Google is offered; also removes the SMTP blocker for signups.
4. **iOS Share Extension** + Apple Developer account — the core capture flow.
5. **RevenueCat / Apple IAP** — the webhook is written and tested but deliberately not registered yet.

Open work in **[TODO.md](TODO.md)** — it's the release gate. The reasoning behind every decision above, plus the bugs that cost real time, is in **[docs/SHIPPED.md](docs/SHIPPED.md)**. Architecture lives in **[docs/CONTEXT.md](docs/CONTEXT.md)**.

---

## 📄 License

[MIT](mobile/LICENSE)
