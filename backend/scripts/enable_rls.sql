-- Enable Row Level Security on every application table.
--
-- WHY THIS IS NOT OPTIONAL
-- ------------------------
-- Once these tables live in Supabase Postgres, Supabase automatically exposes
-- them over PostgREST at  https://<project>.supabase.co/rest/v1/<table>  , and
-- the ONLY thing standing between the public internet and those rows is RLS.
-- The publishable/anon key (EXPO_PUBLIC_SUPABASE_ANON_KEY) ships inside the
-- mobile bundle and is trivially extractable from any installed app. With RLS
-- off, anyone holding that key can read and write EVERY user's rows directly —
-- bypassing the FastAPI ownership checks entirely. Concretely they could:
--   * read every user's saved links and notes            (privacy breach)
--   * UPDATE ai_usage SET count = 0                      (defeats the AI quota,
--                                                          i.e. the cost ceiling)
--   * forge trial_grants                                 (unlimited free trials)
--
-- THE MODEL HERE: DENY-ALL TO CLIENTS
-- -----------------------------------
-- The mobile app never queries these tables — it uses Supabase for AUTH ONLY
-- (supabase.auth.*), and all data flows through the FastAPI backend. The backend
-- connects with the service-role key, which BYPASSES RLS by design. So we enable
-- RLS and deliberately create NO policies: anon/authenticated get nothing, the
-- backend keeps working unchanged. Least privilege, zero app changes.
--
-- If you later let the client read a table directly, add a scoped policy then —
-- and only then. Template at the bottom of this file.
--
-- FORCE matters: without it the table OWNER role still bypasses RLS. Depending
-- on which role your pooled connection uses, that alone can be the hole.
--
-- Safe to re-run (idempotent).

ALTER TABLE reels                ENABLE ROW LEVEL SECURITY;
ALTER TABLE reels                FORCE  ROW LEVEL SECURITY;

ALTER TABLE profiles             ENABLE ROW LEVEL SECURITY;
ALTER TABLE profiles             FORCE  ROW LEVEL SECURITY;

ALTER TABLE ai_usage             ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_usage             FORCE  ROW LEVEL SECURITY;

ALTER TABLE trial_grants         ENABLE ROW LEVEL SECURITY;
ALTER TABLE trial_grants         FORCE  ROW LEVEL SECURITY;

ALTER TABLE tasks                ENABLE ROW LEVEL SECURITY;
ALTER TABLE tasks                FORCE  ROW LEVEL SECURITY;

ALTER TABLE workout_exercises    ENABLE ROW LEVEL SECURITY;
ALTER TABLE workout_exercises    FORCE  ROW LEVEL SECURITY;

ALTER TABLE extraction_cache     ENABLE ROW LEVEL SECURITY;
ALTER TABLE extraction_cache     FORCE  ROW LEVEL SECURITY;

-- ai_action_log holds the descriptive AI-usage log (reel titles + question text).
-- Added after the tables above — must be locked down the same way.
ALTER TABLE ai_action_log         ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_action_log         FORCE  ROW LEVEL SECURITY;

-- todos holds the user's to-do list: their own titles/notes, plus which saves
-- they intend to act on. Same deny-all treatment. NOTE: this table carries
-- `user_id` directly (a standalone to-do has no reel), so with RLS off the anon
-- key would read every user's plans AND let them rewrite each other's rows.
ALTER TABLE todos                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE todos                 FORCE  ROW LEVEL SECURITY;


-- ── Verify ───────────────────────────────────────────────────────────────────
-- Every row must show rowsecurity = true AND relforcerowsecurity = true.
--
--   SELECT c.relname            AS table,
--          c.relrowsecurity     AS rls_enabled,
--          c.relforcerowsecurity AS rls_forced
--   FROM pg_class c
--   JOIN pg_namespace n ON n.oid = c.relnamespace
--   WHERE n.nspname = 'public' AND c.relkind = 'r'
--   ORDER BY 1;
--
-- Then prove it from the outside — this MUST return [] (not rows):
--
--   curl "https://<project>.supabase.co/rest/v1/reels?select=*" \
--        -H "apikey: <your EXPO_PUBLIC_SUPABASE_ANON_KEY>"
--
-- If that returns data, RLS is not doing its job. Do not ship.


-- ── Template: ONLY if you later expose a table to the client directly ────────
-- Do not add these pre-emptively. Deny-all is the safer default for this app.
--
--   CREATE POLICY "own rows" ON reels
--     FOR ALL
--     TO authenticated
--     USING      (auth.uid()::text = user_id)   -- rows they may read
--     WITH CHECK (auth.uid()::text = user_id);  -- rows they may write
--
-- Note: ai_usage, trial_grants and profiles must NEVER get a client write
-- policy — they are the quota/trial ledgers. A user who can write them can
-- grant themselves unlimited AI spend.


-- ── THE AUTO-ENABLE EVENT TRIGGER (recorded 2026-10-07) ─────────────────────
-- ⚠️ THIS ALREADY EXISTS ON BOTH SUPABASE PROJECTS AND WAS IN NEITHER THIS
-- REPO NOR ANY MIGRATION. It was created by hand in the dashboard, so nobody
-- reading the codebase knew that new tables get RLS on their own — and a fresh
-- Supabase project would silently not have it. Recorded here verbatim from
-- `pg_get_functiondef` so it is reproducible.
--
-- ⚠️ IT GIVES `ENABLE` ONLY, NEVER `FORCE`. Read the FORCE note above: this
-- trigger is a safety net for a table someone forgets to add to this script,
-- NOT a replacement for running it. A new table protected only by the trigger
-- is still bypassable by the table OWNER role.
--
-- It also trips Supabase's linter twice (0028 / 0029: "public can execute
-- SECURITY DEFINER function"). That is a near-false-positive — a function
-- returning `event_trigger` cannot be invoked as SQL and PostgREST does not
-- expose it as an RPC, so the /rest/v1/rpc path the advisor names does not
-- work. The EXECUTE grant is just Postgres's default to PUBLIC. Revoking it
-- silences the warning and costs nothing:
--
--   REVOKE EXECUTE ON FUNCTION public.rls_auto_enable() FROM PUBLIC;
--
-- CREATE OR REPLACE FUNCTION public.rls_auto_enable()
--  RETURNS event_trigger
--  LANGUAGE plpgsql
--  SECURITY DEFINER
--  SET search_path TO 'pg_catalog'
-- AS $function$
-- DECLARE
--   cmd record;
-- BEGIN
--   FOR cmd IN
--     SELECT * FROM pg_event_trigger_ddl_commands()
--     WHERE command_tag IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
--       AND object_type IN ('table','partitioned table')
--   LOOP
--      IF cmd.schema_name IS NOT NULL AND cmd.schema_name IN ('public')
--         AND cmd.schema_name NOT IN ('pg_catalog','information_schema')
--         AND cmd.schema_name NOT LIKE 'pg_toast%'
--         AND cmd.schema_name NOT LIKE 'pg_temp%' THEN
--       BEGIN
--         EXECUTE format('alter table if exists %s enable row level security', cmd.object_identity);
--         RAISE LOG 'rls_auto_enable: enabled RLS on %', cmd.object_identity;
--       EXCEPTION WHEN OTHERS THEN
--         RAISE LOG 'rls_auto_enable: failed to enable RLS on %', cmd.object_identity;
--       END;
--      ELSE
--         RAISE LOG 'rls_auto_enable: skip % (system schema or not enforced: %.)', cmd.object_identity, cmd.schema_name;
--      END IF;
--   END LOOP;
-- END;
-- $function$;
--
-- CREATE EVENT TRIGGER ensure_rls ON ddl_command_end
--   WHEN TAG IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
--   EXECUTE FUNCTION public.rls_auto_enable();
