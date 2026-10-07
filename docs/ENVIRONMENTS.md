# Environments — Dev / Staging / Prod

How SaveHere separates **local dev**, **staging**, and **production** so local work
never touches the production database or auth again. Read this alongside
[`DEPLOY.md`](DEPLOY.md) (how to deploy) and [`CONTEXT.md`](CONTEXT.md) (why).

## The three environments

| Env | Data | Auth (Supabase) | Deploy from |
|-----|------|-----------------|-------------|
| **Local dev** | `savehere-dev` Postgres (session pooler `:5432`) | `savehere-dev` project | `expo start` + local `uvicorn` |
| **Staging** | `savehere-dev` Postgres (session pooler `:5432`) | `savehere-dev` project | Render ← `develop` |
| **Prod** | `SaveHere` Postgres (session pooler `:5432`) | `SaveHere` project | Render ← `main` (+ Supabase Pro) |

Two Supabase projects (both AWS ap-south-1):
- **`SaveHere`** = PRODUCTION, ref `lukmwwcilrjqqtgqbynq` — real users, **keep clean**.
  ⚠️ **IT IS NOT READY, AND NOTHING ELSE SAYS SO.** Measured 2026-10-07 by reading both
  projects directly: see "Production database is stale" below before any prod deploy.
- **`savehere-dev`** = DEV + STAGING — disposable. **Decision 2026-07-21: SQLite is retired
  for local dev.** Local dev, GitHub Codespaces, and the staging Render service all share the
  **one** `savehere-dev` Postgres, so data persists across ephemeral machines (Codespace disks
  are wiped on rebuild). With one developer, **staging is preprod** (no separate PreProd env).
  Trade-off accepted: local experiments and the staging service share state — fine pre-launch.

## ⚠️ Production database is stale — read before deploying prod

Measured 2026-10-07 against both projects. **Staging is the only deployed environment**, so
every real account and save lives in `savehere-dev`, and `SaveHere` has been untouched since
the 2026-07-21 split. Three gaps, none of which announce themselves:

| | `savehere-dev` (dev + staging) | `SaveHere` (prod) |
|---|---|---|
| Alembic head | `e5b8d2f41c07` | **`9aa25548aadb`** — ~2.5 months behind |
| `todos` table | present (23 rows) | **absent** — the migration never ran |
| `FORCE ROW LEVEL SECURITY` | **9 / 9 tables** | **0 / 9 tables** |
| `ensure_rls` event trigger | present | present |
| Users | 9, 4 active in the last week | 16, **none active since 2026-07-20** |

1. **Run the migrations.** `alembic upgrade head` against the prod pooler. Until then prod is
   missing `todos` entirely and any schema change since July.
2. **Run `backend/scripts/enable_rls.sql`.** RLS is `ENABLE`d on prod but `FORCE` is applied to
   nothing. That script's own header explains why FORCE is the half that matters: without it the
   table OWNER role still bypasses RLS, and the anon key ships inside every copy of the app.
   ⚠️ The `ensure_rls` trigger does **not** cover this — it only ever calls `ENABLE`.
3. **The 16 user rows in prod are pre-split leftovers**, not a production userbase. Nothing has
   signed in there since 2026-07-20. Do not read that number as traffic, and decide deliberately
   whether they are carried forward or cleared before launch.

⚠️ **The GitHub "Supabase Preview" integration points at `lukmwwcilrjqqtgqbynq`** — the prod
project — and reports `skipping` on every PR. Harmless while it skips; worth knowing it is aimed
at prod and not at the database the code is actually tested against.

## No code branching — just different values

The backend is 12-factor: [`backend/app/config.py`](../backend/app/config.py) reads every
setting from `os.getenv` (`load_dotenv(override=True)`); `DATABASE_URL` defaults to SQLite
when unset, but local dev now sets it explicitly to the savehere-dev pooler. Mobile reads
`EXPO_PUBLIC_*` at build time. **Selecting an environment = supplying
different env-var values to that deployment.** There is no `if prod:` logic to maintain.

The only place `ENV` changes behavior is [`main.py`](../backend/app/main.py): it tags Sentry's
`environment` and picks the CORS default (`ENV=development` → allow any origin; otherwise use
the `ALLOWED_ORIGINS` allowlist). `ENV` is a **label + CORS toggle**, never a data/auth switch.

## Per-variable matrix

Backend (repo-root `.env` locally / Render env vars in staging+prod):

| Variable | Local dev | Staging | Prod |
|----------|-----------|---------|------|
| `DATABASE_URL` | `savehere-dev` pooler `:5432` (same DB as staging) | `savehere-dev` pooler `:5432` | `SaveHere` pooler `:5432` |
| `SUPABASE_URL` | `savehere-dev` | `savehere-dev` | `SaveHere` |
| `SUPABASE_PUBLISHABLE_KEY` | `savehere-dev` | `savehere-dev` | `SaveHere` |
| `SUPABASE_SERVICE_ROLE_KEY` | `savehere-dev` (secret) | `savehere-dev` (secret) | `SaveHere` (secret) |
| `SUPABASE_JWKS_URL` | *unset* → derived from `SUPABASE_URL` | *unset* → derived | *unset* → derived |
| `ENV` | `development` | `staging` | `production` |
| `ALLOWED_ORIGINS` | `*` (dev default) | staging web origin | prod web origin |
| `ANTHROPIC_API_KEY` | shared key | shared key | shared key |

Mobile (`mobile/.env` locally / EAS build-profile `env` in [`eas.json`](../mobile/eas.json)):

| Variable | Local dev / EAS `development`+`preview` | EAS `production` |
|----------|----------------------------------------|------------------|
| `EXPO_PUBLIC_API_URL` | `http://localhost:8000` / staging Render URL | prod Render URL |
| `EXPO_PUBLIC_SUPABASE_URL` | `savehere-dev` | `SaveHere` |
| `EXPO_PUBLIC_SUPABASE_ANON_KEY` | `savehere-dev` publishable | `SaveHere` publishable |

`EXPO_PUBLIC_*` values are **baked into the app bundle** and are public by design (the anon/
publishable key is safe to ship — RLS protects the data). They are not secrets; committing
them to `eas.json` is fine. Real secrets (service-role key, DB password) live **only** in
`.env` (gitignored) and the Render dashboard (`sync:false`) — never in git, never in chat.

## Load-bearing gotchas

- **The app `.env` is at the REPO ROOT**, not `backend/`. `config.py`'s `load_dotenv` walks
  up from `backend/`. There is no `backend/.env`.
- **Session pooler only (`:5432`).** The direct connection string is IPv6-only and fails from
  Render; the transaction pooler (`:6543`) breaks SQLAlchemy prepared statements. Get it from
  Supabase → Connect → **Session pooler**. `pool_pre_ping=True` is already set on the engine
  (recycles dead pooled connections instead of 500ing).
- **`DATABASE_URL` unset on a Render service → ephemeral SQLite on the container disk → total
  data loss on every redeploy.** It MUST be set in each Render service. This is why it's
  `sync:false` (not defaulted) in `render.yaml`.
- **Auth users are per-project.** A user created in `savehere-dev` does not exist in `SaveHere`.
  The seeded test accounts (`trailtieruser` [sic], `freetieruser`, `protieruser`) must be
  created in each project you want to test them in.
- **Tiers live in two places:** `pro` is a Supabase JWT claim (`app_metadata.tier`, cached
  ≤1 h → needs sign-out/in to take effect); `trial`/`free` are computed every request from the
  local `profiles` clock (apply on the next API call). Seed dev tiers with
  `python scripts/dev_seed_tiers.py` (guarded to the savehere-dev project — refuses prod).
- **Supabase free tier pauses after 7 days idle and has no backups** — fine for dev/staging,
  so production needs **Supabase Pro** ($25/mo).

## One `.env`, pointed only at dev

Use a **single** repo-root `.env`, and point it **only at `savehere-dev`** (dev Postgres +
dev auth). Do **not** keep a `.env.prod` / `.env.staging` on your machine:

- Staging and prod read their config from **Render dashboard env vars** (`sync:false`),
  not from any `.env` file — there is nothing for a second file to feed.
- A `.env.prod` would put the **prod DB password + service-role key back on your laptop** —
  the exact thing this separation exists to prevent. The dev machine holds dev secrets only.
- Selecting an env is "different values per deployment", not "different files" (see the
  no-code-branching note above).

## Migrating the schema

**Dev** is what your local `.env` already points at, so a migration against dev is just
`cd backend; alembic upgrade head` (the app also runs it on startup). Future schema changes:
`alembic revision --autogenerate -m "..."`, then commit the migration file.

Migrating the **prod** DB (once, before the first prod deploy) is the tricky case: you must
target prod *without* leaving that URL in `.env`. **A shell `$env:DATABASE_URL` will NOT win**
— `.env`'s value overrides it (`load_dotenv(override=True)`, verified). So comment the `.env`
line first:

```powershell
# 1) comment out DATABASE_URL in .env
# 2) in THIS shell only:
$env:DATABASE_URL = "<SaveHere prod session-pooler URL>"
cd backend; alembic upgrade head
Remove-Item Env:DATABASE_URL
# 3) uncomment .env's DATABASE_URL (back to dev)
```

Then apply [`backend/scripts/enable_rls.sql`](../backend/scripts/enable_rls.sql) to prod in the
Supabase SQL editor (deny-all RLS) and run the anon-key `curl` in its comments — it MUST
return `[]`.  *(dev already has the schema + RLS applied as of 2026-07-21.)*
