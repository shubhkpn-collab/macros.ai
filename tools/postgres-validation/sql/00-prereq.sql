-- =====================================================================
-- TEST-ONLY PREREQUISITE — MUST INSTALL **BEFORE** MIGRATIONS
-- =====================================================================
-- Migration 0002 references `auth.uid()` and the `authenticated` role, which
-- vanilla PostgreSQL does not provide. Installing this after the migrations
-- (as the first draft did) means 0002 cannot execute at all.
--
-- This contains ONLY the compatibility boundary the migrations require.
-- Assertion helpers live in 05-test-helpers.sql and are installed afterwards,
-- so this file stays as small as the production schema genuinely needs.
--
-- Production migrations remain Supabase-oriented; nothing here is imported
-- into db/migrations/.

CREATE SCHEMA IF NOT EXISTS auth;

-- Transaction-local identity. NULL when unset, so an unidentified session sees
-- nothing rather than everything.
CREATE OR REPLACE FUNCTION auth.uid()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END;
$$;

-- Re-asserted every run: a role that could bypass RLS would make every policy
-- assertion below meaningless.
ALTER ROLE authenticated NOSUPERUSER NOBYPASSRLS;
GRANT USAGE ON SCHEMA auth TO authenticated;
GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated;
