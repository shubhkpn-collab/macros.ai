-- =====================================================================
-- ADVERSARIAL DATA INTEGRITY (runs as the OWNER: these test CONSTRAINTS,
-- not RLS, so they must not be blocked by policy first)
-- =====================================================================

-- --- FINDING 1: a MISSING json key must be REJECTED, not accepted ----------
-- A bare `(snapshot ->> 'kcal')::numeric = kcal` evaluates to UNKNOWN when the
-- key is absent, and CHECK accepts UNKNOWN. Omitting a required authoritative
-- fact therefore passed while a wrong value failed.
-- Each case is (label, snapshot). Probes run one per transaction-less block so
-- one expected rejection cannot terminate the file — which is exactly what
-- happened on the first real run: the malformed-numeric case raised
-- invalid_text_representation (22P02) during the ->>::numeric cast, the handler
-- caught only check_violation, and psql aborted before the remaining probes.
DO $$
DECLARE
  labels text[] := ARRAY[
    'missing gramsConsumed','missing productVersionId','missing totals','missing kcal',
    'missing proteinG','missing carbohydrateG','missing fatG',
    'non-numeric gramsConsumed','wrong gramsConsumed value','wrong kcal value',
    'totals is not an object'
  ];
  cases text[] := ARRAY[
    '{"productVersionId":"prod-test-1@v1","totals":{"kcal":100,"proteinG":10,"carbohydrateG":5,"fatG":2}}',
    '{"gramsConsumed":100,"totals":{"kcal":100,"proteinG":10,"carbohydrateG":5,"fatG":2}}',
    '{"gramsConsumed":100,"productVersionId":"prod-test-1@v1"}',
    '{"gramsConsumed":100,"productVersionId":"prod-test-1@v1","totals":{"proteinG":10,"carbohydrateG":5,"fatG":2}}',
    '{"gramsConsumed":100,"productVersionId":"prod-test-1@v1","totals":{"kcal":100,"carbohydrateG":5,"fatG":2}}',
    '{"gramsConsumed":100,"productVersionId":"prod-test-1@v1","totals":{"kcal":100,"proteinG":10,"fatG":2}}',
    '{"gramsConsumed":100,"productVersionId":"prod-test-1@v1","totals":{"kcal":100,"proteinG":10,"carbohydrateG":5}}',
    '{"gramsConsumed":"one hundred","productVersionId":"prod-test-1@v1","totals":{"kcal":100,"proteinG":10,"carbohydrateG":5,"fatG":2}}',
    '{"gramsConsumed":55,"productVersionId":"prod-test-1@v1","totals":{"kcal":100,"proteinG":10,"carbohydrateG":5,"fatG":2}}',
    '{"gramsConsumed":100,"productVersionId":"prod-test-1@v1","totals":{"kcal":9999,"proteinG":10,"carbohydrateG":5,"fatG":2}}',
    '{"gramsConsumed":100,"productVersionId":"prod-test-1@v1","totals":"not an object"}'
  ];
  i int; accepted int := 0; invalid int := 0; rejected int := 0;
BEGIN
  FOR i IN 1 .. array_length(cases, 1) LOOP
    BEGIN
      INSERT INTO food_logs (
        user_id, log_id, product_id, product_version_id, grams, logged_at,
        event_timezone, event_utc_offset_minutes, local_date, nutrition_calc_version,
        weight_capture, nutrition_snapshot, kcal, protein_g, carbohydrate_g, fat_g)
      VALUES ('11111111-1111-4111-8111-111111111111', 'integrity-probe-' || i, 'prod-test-1',
        'prod-test-1@v1', 100, now(), 'UTC', 0, current_date, 'test',
        '{"grams":100}'::jsonb, cases[i]::jsonb, 100, 10, 5, 2);

      -- Reaching here means the malformed row was ACCEPTED: a real failure.
      accepted := accepted + 1;
      RAISE WARNING 'ACCEPTED malformed snapshot [%]: %', labels[i], left(cases[i], 70);
      DELETE FROM food_logs WHERE log_id = 'integrity-probe-' || i;

    EXCEPTION
      -- The specific, legitimate rejection mechanisms:
      --   23514 check_violation            — a presence/agreement CHECK failed
      --   22P02 invalid_text_representation — ->>::numeric on non-numeric text
      --   22003 numeric_value_out_of_range  — value outside the column domain
      WHEN check_violation OR invalid_text_representation OR numeric_value_out_of_range THEN
        rejected := rejected + 1;
      WHEN OTHERS THEN
        -- Deliberately NOT a pass. An unrelated error would prove nothing about
        -- the integrity constraints under test.
        invalid := invalid + 1;
        RAISE WARNING 'INVALID TEST [%]: unexpected % (%)', labels[i], SQLSTATE, SQLERRM;
    END;
  END LOOP;

  IF accepted > 0 THEN
    RAISE EXCEPTION 'FAIL snapshot-integrity: % malformed snapshots were ACCEPTED', accepted;
  END IF;
  IF invalid > 0 THEN
    RAISE EXCEPTION 'FAIL snapshot-integrity: % probes failed for unrelated reasons', invalid;
  END IF;
  RAISE NOTICE 'PASS snapshot-integrity: all % malformed snapshots rejected', rejected;
END;
$$;

-- Nothing from the probe matrix may have survived.
DO $$
DECLARE leaked int;
BEGIN
  SELECT count(*) INTO leaked FROM food_logs WHERE log_id LIKE 'integrity-probe%';
  IF leaked <> 0 THEN
    RAISE EXCEPTION 'FAIL probe-persistence: % malformed probe rows persisted', leaked;
  END IF;
  RAISE NOTICE 'PASS probe-persistence: no malformed probe row was stored';
END;
$$;

-- weight_capture.grams must be present too.
DO $$
BEGIN
  BEGIN
    INSERT INTO food_logs (
      user_id, log_id, product_id, product_version_id, grams, logged_at,
      event_timezone, event_utc_offset_minutes, local_date, nutrition_calc_version,
      weight_capture, nutrition_snapshot, kcal, protein_g, carbohydrate_g, fat_g)
    VALUES ('11111111-1111-4111-8111-111111111111', 'integrity-capture', 'prod-test-1',
      'prod-test-1@v1', 100, now(), 'UTC', 0, current_date, 'test',
      '{}'::jsonb,
      '{"gramsConsumed":100,"productVersionId":"prod-test-1@v1","totals":{"kcal":100,"proteinG":10,"carbohydrateG":5,"fatG":2}}'::jsonb,
      100, 10, 5, 2);
    DELETE FROM food_logs WHERE log_id = 'integrity-capture';
    RAISE EXCEPTION 'FAIL capture-integrity: weight_capture without grams accepted';
  EXCEPTION
    WHEN check_violation OR invalid_text_representation OR numeric_value_out_of_range THEN
      RAISE NOTICE 'PASS capture-integrity: missing weight_capture.grams rejected (%)', SQLSTATE;
    WHEN OTHERS THEN
      RAISE EXCEPTION 'INVALID TEST capture-integrity: unexpected % (%)', SQLSTATE, SQLERRM;
  END;
END;
$$;

-- --- FINDING 2: a head may only point at a version of its OWN product ------
--
-- catalog_products_head_fk is DEFERRABLE INITIALLY DEFERRED, and that deferral
-- is REQUIRED: catalog_products.current_product_version_id references
-- product_versions, while product_versions.product_id references
-- catalog_products — a legitimate cycle that could not be populated otherwise.
--
-- The consequence for testing: an invalid UPDATE does NOT raise immediately.
-- The violation is queued until commit. The first version of this test raised
-- its own FAIL before PostgreSQL had ever been asked to evaluate the
-- constraint, so it reported a broken FK when the FK was fine.
--
-- SET CONSTRAINTS ... IMMEDIATE forces the pending check at a point we control.

-- Setup runs in its own statement so the fixtures commit normally.
INSERT INTO catalog_products (product_id, current_product_version_id, is_active)
VALUES ('prod-test-2', 'prod-test-2@v1', true) ON CONFLICT DO NOTHING;

INSERT INTO product_versions (
  product_version_id, product_id, version_no, display_name, preparation_state,
  basis, source, effective_from)
VALUES ('prod-test-2@v1', 'prod-test-2', 1, 'Other food', 'as_sold',
  '{"kind":"per_100g","kcal":50,"proteinG":1,"carbohydrateG":1,"fatG":1}'::jsonb,
  '{"kind":"synthetic_test","verificationStatus":"synthetic_test"}'::jsonb, now())
ON CONFLICT DO NOTHING;

-- The probe is wrapped in its own transaction so the invalid state is rolled
-- back whatever happens, leaving the valid head untouched for the assertion
-- that follows.
BEGIN;
DO $$
BEGIN
  BEGIN
    -- Product 2 tries to adopt product 1's version — another food's nutrition.
    UPDATE catalog_products SET current_product_version_id = 'prod-test-1@v1'
     WHERE product_id = 'prod-test-2';

    -- Force the DEFERRED constraint to be evaluated now. Without this the
    -- violation simply waits for commit and the test proves nothing.
    SET CONSTRAINTS catalog_products_head_fk IMMEDIATE;

    -- Reaching here means the constraint genuinely failed to reject it.
    RAISE EXCEPTION 'FAIL head-ownership: a head adopted ANOTHER product''s version';
  EXCEPTION
    WHEN foreign_key_violation THEN
      RAISE NOTICE 'PASS head-ownership: deferred composite FK rejected the cross-product head (SQLSTATE %)', SQLSTATE;
  END;
END;
$$;
ROLLBACK;

-- The rejected assignment must not have persisted: the original valid head
-- stands.
DO $$
DECLARE head text;
BEGIN
  SELECT current_product_version_id INTO head
    FROM catalog_products WHERE product_id = 'prod-test-2';
  IF head IS DISTINCT FROM 'prod-test-2@v1' THEN
    RAISE EXCEPTION 'FAIL head-preservation: head is % after the rejected update', head;
  END IF;
  RAISE NOTICE 'PASS head-preservation: prod-test-2 still points at prod-test-2@v1';
END;
$$;
