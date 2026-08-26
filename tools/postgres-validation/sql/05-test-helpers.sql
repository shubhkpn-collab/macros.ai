-- TEST-ONLY assertion helpers. Installed AFTER migrations; nothing in the
-- production schema depends on these.

CREATE OR REPLACE FUNCTION auth.set_test_uid(p_uid uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  -- `true` => SET LOCAL semantics: identity dies with the transaction, which is
  -- precisely the property a pooled backend needs.
  PERFORM set_config('request.jwt.claim.sub', p_uid::text, true);
END;
$$;

-- The role the assertions run AS. Created NOLOGIN on purpose: the harness
-- reaches it via SET ROLE from the owner's already-working connection, so
-- validation never depends on the local pg_hba.conf permitting a new login.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'macros_app') THEN
    CREATE ROLE macros_app NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END;
$$;

ALTER ROLE macros_app NOSUPERUSER NOBYPASSRLS;
GRANT authenticated TO macros_app;
GRANT USAGE ON SCHEMA auth TO macros_app;
GRANT EXECUTE ON FUNCTION auth.uid() TO macros_app;
GRANT EXECUTE ON FUNCTION auth.set_test_uid(uuid) TO authenticated, macros_app;

-- Deliberately NO `GRANT ... ON ALL TABLES IN SCHEMA public`. Business-table
-- permissions must come from the migrations alone; granting them here would
-- mask a broken production grant and make the permission model untested.
