-- =====================================================================
-- ADVERSARIAL DATA INTEGRITY (runs as the OWNER: these test CONSTRAINTS,
-- not RLS, so they must not be blocked by policy first)
-- =====================================================================

-- --- FINDING 1: a MISSING json key must be REJECTED, not accepted ----------
-- A bare `(snapshot ->> 'kcal')::numeric = kcal` evaluates to UNKNOWN when the
-- key is absent, and CHECK accepts UNKNOWN. Omitting a required authoritative
-- fact therefore passed while a wrong value failed.
DO $$
DECLARE
  cases text[] := ARRAY[
    '{"productVersionId":"prod-test-1@v1","totals":{"kcal":100,"proteinG":10,"carbohydrateG":5,"fatG":2}}',           -- no gramsConsumed
    '{"gramsConsumed":100,"totals":{"kcal":100,"proteinG":10,"carbohydrateG":5,"fatG":2}}',                            -- no productVersionId
    '{"gramsConsumed":100,"productVersionId":"prod-test-1@v1"}',                                                        -- no totals
    '{"gramsConsumed":100,"productVersionId":"prod-test-1@v1","totals":{"proteinG":10,"carbohydrateG":5,"fatG":2}}',    -- no kcal
    '{"gramsConsumed":100,"productVersionId":"prod-test-1@v1","totals":{"kcal":100,"carbohydrateG":5,"fatG":2}}',       -- no proteinG
    '{"gramsConsumed":100,"productVersionId":"prod-test-1@v1","totals":{"kcal":100,"proteinG":10,"fatG":2}}',           -- no carbohydrateG
    '{"gramsConsumed":100,"productVersionId":"prod-test-1@v1","totals":{"kcal":100,"proteinG":10,"carbohydrateG":5}}',  -- no fatG
    '{"gramsConsumed":"one hundred","productVersionId":"prod-test-1@v1","totals":{"kcal":100,"proteinG":10,"carbohydrateG":5,"fatG":2}}' -- wrong type
  ];
  c text; accepted int := 0;
BEGIN
  FOREACH c IN ARRAY cases LOOP
    BEGIN
      INSERT INTO food_logs (
        user_id, log_id, product_id, product_version_id, grams, logged_at,
        event_timezone, event_utc_offset_minutes, local_date, nutrition_calc_version,
        weight_capture, nutrition_snapshot, kcal, protein_g, carbohydrate_g, fat_g)
      VALUES ('11111111-1111-4111-8111-111111111111', 'integrity-probe', 'prod-test-1',
        'prod-test-1@v1', 100, now(), 'UTC', 0, current_date, 'test',
        '{"grams":100}'::jsonb, c::jsonb, 100, 10, 5, 2);
      accepted := accepted + 1;
      RAISE WARNING 'ACCEPTED malformed snapshot: %', left(c, 60);
      DELETE FROM food_logs WHERE log_id = 'integrity-probe';
    EXCEPTION WHEN check_violation THEN
      NULL;  -- correctly rejected
    END;
  END LOOP;

  IF accepted > 0 THEN
    RAISE EXCEPTION 'FAIL snapshot-integrity: % malformed snapshots were accepted', accepted;
  END IF;
  RAISE NOTICE 'PASS snapshot-integrity: all 8 malformed snapshots rejected';
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
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS capture-integrity: missing weight_capture.grams rejected';
  END;
END;
$$;

-- --- FINDING 2: a head may only point at a version of its OWN product ------
DO $$
BEGIN
  INSERT INTO catalog_products (product_id, current_product_version_id, is_active)
  VALUES ('prod-test-2', 'prod-test-2@v1', true) ON CONFLICT DO NOTHING;
  INSERT INTO product_versions (
    product_version_id, product_id, version_no, display_name, preparation_state,
    basis, source, effective_from)
  VALUES ('prod-test-2@v1', 'prod-test-2', 1, 'Other food', 'as_sold',
    '{"kind":"per_100g","kcal":50,"proteinG":1,"carbohydrateG":1,"fatG":1}'::jsonb,
    '{"kind":"synthetic_test","verificationStatus":"synthetic_test"}'::jsonb, now())
  ON CONFLICT DO NOTHING;

  BEGIN
    -- Product 2 tries to adopt product 1's version: another food's nutrition.
    UPDATE catalog_products SET current_product_version_id = 'prod-test-1@v1'
     WHERE product_id = 'prod-test-2';
    RAISE EXCEPTION 'FAIL head-ownership: a head adopted ANOTHER product''s version';
  EXCEPTION WHEN foreign_key_violation THEN
    RAISE NOTICE 'PASS head-ownership: composite FK rejected the cross-product head';
  END;
END;
$$;
