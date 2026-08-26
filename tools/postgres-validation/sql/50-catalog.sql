-- CATALOG: readable by ordinary users, never mutable by them.
BEGIN;
SELECT auth.set_test_uid('11111111-1111-4111-8111-111111111111'::uuid);
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM product_versions;
  IF n < 1 THEN RAISE EXCEPTION 'FAIL catalog-read: user cannot read the catalog'; END IF;
  RAISE NOTICE 'PASS catalog-read: % product versions visible', n;

  BEGIN
    UPDATE product_versions SET display_name = 'HIJACKED';
    RAISE EXCEPTION 'FAIL catalog-mutate: ordinary user rewrote canonical nutrition';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS catalog-update refused';
  END;

  BEGIN
    INSERT INTO product_versions (
      product_version_id, product_id, version_no, display_name, preparation_state,
      basis, source, effective_from)
    VALUES ('forged@v1', 'prod-test-1', 99, 'Forged', 'as_sold',
      '{"kind":"per_100g","kcal":1,"proteinG":1,"carbohydrateG":1,"fatG":1}'::jsonb,
      '{"kind":"synthetic_test"}'::jsonb, now());
    RAISE EXCEPTION 'FAIL catalog-insert: ordinary user inserted a catalog version';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS catalog-insert refused';
  END;

  BEGIN
    DELETE FROM product_versions;
    RAISE EXCEPTION 'FAIL catalog-delete: ordinary user deleted catalog rows';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS catalog-delete refused';
  END;
END;
$$;
ROLLBACK;
