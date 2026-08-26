-- DATABASE SAFETY GUARD — runs before anything destructive.
--
-- Refuses to proceed unless connected to exactly `macros_dev`. A validation
-- harness that resets schemas must never be one typo away from running against
-- a production database.
DO $$
DECLARE
  db text := current_database();
BEGIN
  IF db <> 'macros_dev' THEN
    RAISE EXCEPTION
      'REFUSING TO RUN: connected to "%" but this harness only operates on macros_dev', db;
  END IF;
  IF db IN ('postgres', 'template0', 'template1') THEN
    RAISE EXCEPTION 'REFUSING TO RUN against system database "%"', db;
  END IF;
  RAISE NOTICE 'safety: connected to %, proceeding', db;
END;
$$;
