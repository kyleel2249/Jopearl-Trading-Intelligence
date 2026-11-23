-- 004_supabase_rls.sql
-- Locks every jpti_* table away from Supabase's public Data API (PostgREST).
--
-- Supabase exposes the public schema over HTTPS using the anon key, which ships inside
-- any browser app. JPTI only reads and writes these tables from its own server over a
-- direct Postgres connection (the table owner, which bypasses RLS), so the correct
-- policy set is: RLS enabled, no policies, no grants for anon/authenticated.
--
-- The API applies this automatically at startup (api/db-config.js). Run it by hand in
-- the Supabase SQL editor only if the startup log says it could not enforce RLS, or to
-- harden the tables before the API has ever started. Safe to run repeatedly.

DO $jpti$
DECLARE
  tbl text;
  api_roles text;
BEGIN
  SELECT string_agg(quote_ident(rolname), ', ') INTO api_roles
    FROM pg_roles WHERE rolname IN ('anon', 'authenticated');
  FOR tbl IN
    SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname LIKE 'jpti\_%' ESCAPE '\' AND NOT c.relrowsecurity
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tbl);
    IF api_roles IS NOT NULL THEN
      EXECUTE format('REVOKE ALL ON TABLE public.%I FROM %s', tbl, api_roles);
    END IF;
  END LOOP;
END
$jpti$;

-- Verification: every row should show rls_enabled = true.
SELECT c.relname AS table_name, c.relrowsecurity AS rls_enabled
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname LIKE 'jpti\_%' ESCAPE '\'
 ORDER BY 1;
