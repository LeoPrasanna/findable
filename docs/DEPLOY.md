# Deploying SaveHere

> **Status (2026-07-21): staging is LIVE** at
> **`https://savehere-api-staging.onrender.com`** — Render **free tier**, deploys from
> `develop`, backed by the `savehere-dev` Supabase project + Postgres.
> **Production is not deployed yet** — its service is deliberately commented out in
> [`render.yaml`](../render.yaml) (see "Why prod is commented out" below).
> For the full dev/staging/prod env-var matrix see [`ENVIRONMENTS.md`](ENVIRONMENTS.md).

This deploys the **backend** to a stable URL so it survives Codespace/session
teardown (the recurring "Can't reach the server" pain). The **web frontend** is a
separate, smaller step — see the last section.

> What's automated vs. yours: the repo is deploy-ready (`render.yaml`, env-driven
> config). **You** connect the repo in your cloud account and set the secrets —
> those never live in git or in chat.

---

## Render (Blueprint) — the flow that actually worked

Free tier = a stable public URL at $0 (with cold starts).

1. **Merge to `develop`** — the blueprint reads `render.yaml` from that branch.
2. **render.com → New + → Blueprint → New Blueprint Instance** → repo
   `LeoPrasanna/findable` → branch **`develop`**.
   ⚠️ Do **not** use New → *Web Service* / *Static Site*: the Blueprint is what applies
   `render.yaml` (rootDir `backend`, build + start commands, health check, env-var slots).
   A hand-made service means configuring all of that by hand.
3. **Fill the `sync:false` secrets** when prompted at apply (or afterwards in the service's
   **Environment** tab). Point them at `savehere-dev`:
   - `DATABASE_URL` ⚠️ **required** — Supabase **session pooler** (`:5432`).
     Unset = the app silently falls back to ephemeral SQLite → empty DB, wiped every redeploy.
   - `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` — needed for auth (token verify,
     admin account-deletion, billing webhook). Without them every signed-in request 401s.
   - `ANTHROPIC_API_KEY` (+ optional `OPENAI_API_KEY`, `APIFY_API_KEY`, `SENTRY_DSN`).

   See [`ENVIRONMENTS.md`](ENVIRONMENTS.md) for the full per-env value matrix.
4. **Apply.** First build ≈2 min (installs `requirements.txt`, force-upgrades yt-dlp, starts
   `uvicorn app.main:app --host 0.0.0.0 --port $PORT`).
5. **Verify:** `/health` → `{"status":"ok"}`; `/health/extract` → the yt-dlp version.
   Note: a **green deploy with `DATABASE_URL` set is itself proof Postgres connected** —
   startup runs `alembic upgrade head`, so an unreachable/wrong URL fails the deploy.
   (`/health` alone passes even on SQLite, so it does *not* prove the DB wiring.)

### ⚠️ Why prod is commented out in `render.yaml`
A paid service (`plan: starter`) anywhere in the blueprint forces **credit-card entry at
apply**, even though the other service is free. To keep the blueprint 100% free-tier,
`savehere-api-prod` is commented out. Re-enable it at launch (with a card + Supabase Pro)
by uncommenting that block — it's identical to staging except name, `branch: main`,
`plan: starter`, `ENV=production`, and secrets pointed at the `SaveHere` project.

### Deploys are CI-gated
`autoDeploy` is **off**. [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) fires the
Render **deploy hook** only *after* the backend suite passes (staging on `develop`, prod on
`main`), so a red build can never ship. To arm it:
- Service → **Settings → Deploy Hook** → copy the URL → GitHub → **Settings → Secrets and
  variables → Actions** → new secret **`RENDER_DEPLOY_HOOK_STAGING`**
  (and `RENDER_DEPLOY_HOOK_PROD` when prod exists).
- Until that secret exists, CI passes and simply **skips** the deploy step (no red X) — use
  the dashboard's **Manual Deploy** meanwhile.

### Point the frontend at it
`EXPO_PUBLIC_API_URL` drives the API base URL ([mobile/services/api.ts](../mobile/services/api.ts)):
- **Local web/dev:** set it in `mobile/.env`, e.g.
  `EXPO_PUBLIC_API_URL=https://savehere-api-staging.onrender.com`, then **restart
  `expo start`** — `EXPO_PUBLIC_*` is inlined at bundle time, so a browser refresh alone
  will keep using the old value. Switch back to `http://localhost:8000` for local backend work.
- **EAS builds:** already set per build profile in [`mobile/eas.json`](../mobile/eas.json).

CORS works as-is (`ALLOWED_ORIGINS=*`, and the app uses Bearer tokens, not cookies) —
verified with a cross-origin `fetch` from `localhost:8090` → 200. **(Later)** lock
`ALLOWED_ORIGINS` to the real domain once the web app has one.

---

## Caveats — read before relying on it

- **Cold starts (free tier).** The service sleeps after ~15 min idle; the next
  request takes ~30–60 s to wake. That hurts the "instant save" feel. Fix: Render
  **Starter ($7/mo)** for always-on, or Railway (below).
- **Ephemeral filesystem — SOLVED, but only while `DATABASE_URL` is set.** Staging runs on
  `savehere-dev` Postgres, so data persists across redeploys. The failure mode is silent: if
  `DATABASE_URL` is ever unset/blank on the service, the app falls back to SQLite on Render's
  ephemeral disk and every redeploy wipes it — with no error, since `/health` still passes.
  Treat that env var as load-bearing.
- **Extraction has NO residential proxy (deliberate).** Decision 2026-07-21: launching without
  one. IG/FB/LinkedIn captions work via the `facebookexternalhit` path; YouTube Shorts whose
  content is only spoken audio will summarize from title/description or honestly report they
  couldn't be read. Revisit only if data shows it hurts retention — and only with the per-user
  spend cap first (see TODO), since proxy bandwidth is uncapped in code.
- **Extraction from a datacenter IP is worse, not better.** `[Certain]` Render/Railway
  IPs are bot-blocked by YouTube/Instagram at least as hard as the Codespace. What
  still works without a proxy: YouTube **oEmbed** (title/thumbnail) and the
  **`facebookexternalhit`** caption path for IG/FB. Full **transcripts** will mostly
  fail until a **residential proxy** is added (see CONTEXT §4 "Extraction & bot-detection").
  Deploying does not fix extraction — it fixes uptime.
- **No ffmpeg in the native Python env** → audio transcription (the optional Whisper
  fallback) is disabled. Use a Docker deploy if you need it.

---

## Alternative: Railway

Always-on, ~$5/mo (no real free tier), supports volumes for persistent SQLite.

1. railway.app → **New Project → Deploy from GitHub repo** → pick the repo.
2. Set **Root Directory** = `backend`.
3. **Start command:** `uvicorn app.main:app --host 0.0.0.0 --port $PORT`.
4. Add variables: `ENV=production`, `ALLOWED_ORIGINS`, `ANTHROPIC_API_KEY`.
5. (Optional) add a **Volume** mounted where `savehere.db` lives to persist SQLite.

---

## Frontend (next step — not done here)

This guide deploys the API only. To get the **web app** off the Codespace too:

1. `cd mobile && EXPO_PUBLIC_API_URL=https://<your-service>.onrender.com npx expo export --platform web`
2. Deploy the generated `dist/` to any static host — **Render Static Site**,
   Netlify, or Vercel. The API URL is baked in at export time, so re-export if it changes.

Ask and I'll wire this up once the backend URL exists.
