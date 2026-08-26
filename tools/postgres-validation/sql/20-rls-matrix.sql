-- =====================================================================
-- RLS MATRIX — executed as `macros_app`, a NON-superuser NON-bypassrls role.
-- =====================================================================
-- Every assertion raises an exception on failure, so psql -v ON_ERROR_STOP=1
-- turns any violation into a nonzero exit.

\set A '11111111-1111-4111-8111-111111111111'
\set B '22222222-2222-4222-8222-222222222222'

-- --- 0. The role itself must not be able to bypass what we are testing ------
DO $$
DECLARE r record;
BEGIN
  SELECT rolsuper, rolbypassrls INTO r FROM pg_roles WHERE rolname = current_user;
  IF r.rolsuper THEN
    RAISE EXCEPTION 'FALSE GREEN: tests are running as SUPERUSER (%)', current_user;
  END IF;
  IF r.rolbypassrls THEN
    RAISE EXCEPTION 'FALSE GREEN: current role BYPASSES RLS (%)', current_user;
  END IF;
  RAISE NOTICE 'PASS role-not-privileged: % rolsuper=false rolbypassrls=false', current_user;
END;
$$;

-- --- 1. Profile isolation ---------------------------------------------------
BEGIN;
SELECT auth.set_test_uid(:'A'::uuid);
DO $$
DECLARE own int; other int;
BEGIN
  SELECT count(*) INTO own   FROM user_profile_versions WHERE user_id = auth.uid();
  SELECT count(*) INTO other FROM user_profile_versions WHERE user_id <> auth.uid();
  IF own < 1 THEN RAISE EXCEPTION 'FAIL profile-self: A cannot read its own profile'; END IF;
  IF other <> 0 THEN RAISE EXCEPTION 'FAIL profile-isolation: A sees % other rows', other; END IF;
  RAISE NOTICE 'PASS profile-isolation: A reads own, sees 0 of B';
END;
$$;
ROLLBACK;

-- --- 2. Goal isolation ------------------------------------------------------
BEGIN;
SELECT auth.set_test_uid(:'A'::uuid);
DO $$
DECLARE other int;
BEGIN
  SELECT count(*) INTO other FROM energy_goal_versions WHERE user_id <> auth.uid();
  IF other <> 0 THEN RAISE EXCEPTION 'FAIL goal-isolation: A sees % of B goals', other; END IF;
  RAISE NOTICE 'PASS goal-isolation';
END;
$$;
ROLLBACK;

-- --- 3. Food-log isolation, both directions --------------------------------
BEGIN;
SELECT auth.set_test_uid(:'A'::uuid);
DO $$
DECLARE own int; other int;
BEGIN
  SELECT count(*) INTO own   FROM food_logs WHERE user_id = auth.uid();
  SELECT count(*) INTO other FROM food_logs WHERE user_id <> auth.uid();
  IF own < 1 THEN RAISE EXCEPTION 'FAIL foodlog-self'; END IF;
  IF other <> 0 THEN RAISE EXCEPTION 'FAIL foodlog-isolation: A sees % of B logs', other; END IF;
  RAISE NOTICE 'PASS foodlog-isolation A->B';
END;
$$;
ROLLBACK;

BEGIN;
SELECT auth.set_test_uid(:'B'::uuid);
DO $$
DECLARE other int;
BEGIN
  SELECT count(*) INTO other FROM food_logs WHERE user_id <> auth.uid();
  IF other <> 0 THEN RAISE EXCEPTION 'FAIL foodlog-isolation B->A'; END IF;
  RAISE NOTICE 'PASS foodlog-isolation B->A (symmetric)';
END;
$$;
ROLLBACK;

-- --- 4. A cannot INSERT a log claiming to be B ------------------------------
BEGIN;
SELECT auth.set_test_uid(:'A'::uuid);
DO $$
BEGIN
  BEGIN
    INSERT INTO food_logs (
      user_id, log_id, product_id, product_version_id, grams, logged_at,
      event_timezone, event_utc_offset_minutes, local_date, nutrition_calc_version,
      weight_capture, nutrition_snapshot, kcal, protein_g, carbohydrate_g, fat_g)
    -- FULLY VALID payload. With `{}` here a broken RLS policy could let the
    -- forged row through and the JSON CHECK would reject it instead — the test
    -- would report PASS while authorization was wide open. The row must be
    -- refusable for exactly one reason: it is not this caller's to write.
    VALUES ('22222222-2222-4222-8222-222222222222', 'forged', 'prod-test-1',
      'prod-test-1@v1', 50, now(), 'UTC', 0, current_date, 'test',
      '{"grams":50}'::jsonb,
      '{"gramsConsumed":50,"productVersionId":"prod-test-1@v1","totals":{"kcal":50,"proteinG":5,"carbohydrateG":2.5,"fatG":1}}'::jsonb,
      50, 5, 2.5, 1);
    RAISE EXCEPTION 'FAIL forged-insert: A inserted a log owned by B (RLS did not deny)';
  EXCEPTION
    WHEN insufficient_privilege THEN
      RAISE NOTICE 'PASS forged-insert refused by authorization (SQLSTATE 42501)';
    WHEN check_violation THEN
      -- A constraint failure proves nothing about authorization.
      RAISE EXCEPTION 'INVALID TEST forged-insert: rejected by CHECK, not RLS — %', SQLERRM;
  END;
END;
$$;
ROLLBACK;

-- --- 5. Append-only: no UPDATE or DELETE of anyone's logs -------------------
BEGIN;
SELECT auth.set_test_uid(:'A'::uuid);
DO $$
DECLARE n int;
BEGIN
  BEGIN
    UPDATE food_logs SET grams = 999 WHERE user_id <> auth.uid();
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n > 0 THEN RAISE EXCEPTION 'FAIL update-B: A modified % of B rows', n; END IF;
    RAISE NOTICE 'PASS update-B affected 0 rows';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS update-B refused outright (no UPDATE grant)';
  END;
  BEGIN
    DELETE FROM food_logs WHERE user_id <> auth.uid();
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n > 0 THEN RAISE EXCEPTION 'FAIL delete-B: A deleted % of B rows', n; END IF;
    RAISE NOTICE 'PASS delete-B affected 0 rows';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS delete-B refused outright (no DELETE grant)';
  END;
END;
$$;
ROLLBACK;

-- --- 6. Composite identity: same log_id, two users --------------------------
BEGIN;
SELECT auth.set_test_uid(:'A'::uuid);
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM food_logs WHERE log_id = 'shared-log-id' AND user_id = auth.uid();
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL composite-identity: expected 1, got %', n; END IF;
  RAISE NOTICE 'PASS composite-identity: (user_id, log_id) keeps A and B separate';
END;
$$;
ROLLBACK;

-- --- 7. NO identity set => sees nothing -------------------------------------
BEGIN;
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM food_logs;
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL anonymous: unidentified session saw % rows', n; END IF;
  RAISE NOTICE 'PASS anonymous-sees-nothing';
END;
$$;
ROLLBACK;
