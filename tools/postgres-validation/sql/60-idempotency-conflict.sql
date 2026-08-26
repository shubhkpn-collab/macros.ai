-- IDEMPOTENCY CONFLICT + immutability of the original row.
\set A '11111111-1111-4111-8111-111111111111'

BEGIN;
SELECT auth.set_test_uid(:'A'::uuid);
DO $$
DECLARE original_kcal numeric; after_kcal numeric;
BEGIN
  SELECT kcal INTO original_kcal FROM food_logs
   WHERE user_id = auth.uid() AND log_id = 'shared-log-id';

  -- Same identity, DIFFERENT payload. ON CONFLICT DO NOTHING is the contract:
  -- the original wins and the caller classifies the zero-row result as either
  -- replayed_existing (payloads equal) or idempotency_conflict (they differ).
  INSERT INTO food_logs (
    user_id, log_id, product_id, product_version_id, grams, logged_at,
    event_timezone, event_utc_offset_minutes, local_date, nutrition_calc_version,
    weight_capture, nutrition_snapshot, kcal, protein_g, carbohydrate_g, fat_g)
  VALUES (auth.uid(), 'shared-log-id', 'prod-test-1', 'prod-test-1@v1',
    777, now(), 'UTC', 0, current_date, 'test',
    '{"grams":777}'::jsonb,
    -- STRUCTURALLY VALID and self-consistent. The insert must be refused
    -- because (user_id, log_id) already identifies another immutable payload —
    -- never because the JSON was malformed, which would prove nothing.
    '{"gramsConsumed":777,"productVersionId":"prod-test-1@v1","totals":{"kcal":777,"proteinG":7,"carbohydrateG":7,"fatG":7}}'::jsonb,
    777, 7, 7, 7)
  ON CONFLICT (user_id, log_id) DO NOTHING;

  SELECT kcal INTO after_kcal FROM food_logs
   WHERE user_id = auth.uid() AND log_id = 'shared-log-id';

  IF after_kcal <> original_kcal THEN
    RAISE EXCEPTION 'FAIL conflict-immutability: kcal changed % -> % (last-write-wins!)',
      original_kcal, after_kcal;
  END IF;
  RAISE NOTICE 'PASS conflict-immutability: original kcal % unchanged; no overwrite',
    original_kcal;
END;
$$;
ROLLBACK;

-- Row count must stay exactly 1 for that identity.
BEGIN;
SELECT auth.set_test_uid(:'A'::uuid);
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM food_logs WHERE user_id = auth.uid() AND log_id = 'shared-log-id';
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL duplicate: % rows for one identity', n; END IF;
  RAISE NOTICE 'PASS single-row-per-identity';
END;
$$;
ROLLBACK;
