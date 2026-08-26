-- =====================================================================
-- EXPECTED-NEGATIVE PROBE — this process is SUPPOSED to fail.
-- =====================================================================
-- catalog_products_head_fk is DEFERRABLE INITIALLY DEFERRED, so the violation
-- surfaces when constraints are evaluated, not at the UPDATE. However it
-- surfaces it, psql reports an ERROR and exits nonzero — which is the CORRECT
-- outcome here, and cannot be swallowed inside a shared SQL file without making
-- that whole file fail.
--
-- The runner therefore classifies this process by exit status and SQLSTATE:
--   nonzero + 23503 + catalog_products_head_fk  -> PASS
--   exit 0                                      -> FAIL (invalid head accepted)
--   nonzero + any other SQLSTATE                -> INVALID TEST
--
-- The transaction is never committed, so the invalid assignment is rolled back.

BEGIN;

-- Product 2 attempts to adopt product 1's version: another food's nutrition.
UPDATE catalog_products
   SET current_product_version_id = 'prod-test-1@v1'
 WHERE product_id = 'prod-test-2';

-- Force the deferred constraint to be evaluated now rather than at commit.
SET CONSTRAINTS catalog_products_head_fk IMMEDIATE;

-- Unreachable when the FK behaves correctly.
ROLLBACK;
