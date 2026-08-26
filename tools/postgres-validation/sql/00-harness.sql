-- =====================================================================
-- TEST-ONLY LOCAL AUTH HARNESS — NOT A PRODUCTION MIGRATION
-- =====================================================================
--
-- Production migrations use Supabase-style `auth.uid()` and a role named
-- `authenticated`. Vanilla PostgreSQL provides neither, so this file supplies
-- the MINIMUM equivalent boundary needed to execute the real policies
-- faithfully.
--
-- It is deliberately NOT in db/migrations/: production RLS must not be
-- weakened to make local testing convenient, and the production schema must
-- never depend on anything defined here.
--
-- The identity is TRANSACTION-LOCAL (`SET LOCAL`), which is exactly the
-- property the future backend needs: a pooled connection reused across
-- requests must not leak one user's identity into the next request.

CREATE SCHEMA IF NOT EXISTS auth;

-- Mirrors Supabase's auth.uid(): reads the current request's identity.
-- Returns NULL when unset, so an un-identified session sees nothing rather
-- than everything.
CREATE OR REPLACE FUNCTION auth.uid()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;

-- Test helper. `SET LOCAL` scopes identity to the transaction: COMMIT or
-- ROLLBACK clears it, so it cannot survive into the next request.
CREATE OR REPLACE FUNCTION auth.set_test_uid(p_uid uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM set_config('request.jwt.claim.sub', p_uid::text, true);
END;
$$;

-- ---------------------------------------------------------------------
-- Roles
-- ---------------------------------------------------------------------
-- `authenticated` is the ordinary application role. It MUST NOT be superuser
-- and MUST NOT bypass RLS — running policy assertions as the table owner is
-- the single easiest way to get a false green on this entire validation.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END;
$$;

ALTER ROLE authenticated NOSUPERUSER NOBYPASSRLS;

-- A login role used by the harness to act AS an ordinary user.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'macros_app') THEN
    CREATE ROLE macros_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END;
$$;

ALTER ROLE macros_app NOSUPERUSER NOBYPASSRLS;
GRANT authenticated TO macros_app;
GRANT USAGE ON SCHEMA public TO authenticated;
GRANT USAGE ON SCHEMA auth TO authenticated, macros_app;
GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated, macros_app;
GRANT EXECUTE ON FUNCTION auth.set_test_uid(uuid) TO authenticated, macros_app;
