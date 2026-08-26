-- =====================================================================
-- CONNECTION IDENTITY ISOLATION
-- =====================================================================
-- The future backend pools connections. If identity outlived a transaction,
-- one user's request could inherit another's — the worst possible leak.

\set A '11111111-1111-4111-8111-111111111111'
\set B '22222222-2222-4222-8222-222222222222'

-- Request 1 on this connection.
BEGIN;
SELECT auth.set_test_uid(:'A'::uuid);
DO $$ BEGIN
  IF auth.uid() <> '11111111-1111-4111-8111-111111111111' THEN
    RAISE EXCEPTION 'FAIL identity-set';
  END IF;
  RAISE NOTICE 'PASS identity-set: request 1 is A';
END; $$;
COMMIT;

-- Request 2 on the SAME connection, with no identity set.
DO $$ BEGIN
  IF auth.uid() IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL identity-leak: reused connection inherited % after COMMIT', auth.uid();
  END IF;
  RAISE NOTICE 'PASS identity-cleared-after-commit';
END; $$;

-- Request 3: identity must not survive a ROLLBACK either.
BEGIN;
SELECT auth.set_test_uid(:'B'::uuid);
ROLLBACK;
DO $$ BEGIN
  IF auth.uid() IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL identity-leak-rollback: inherited % after ROLLBACK', auth.uid();
  END IF;
  RAISE NOTICE 'PASS identity-cleared-after-rollback';
END; $$;

-- Request 4: a failed transaction must not leave identity behind.
BEGIN;
SELECT auth.set_test_uid(:'A'::uuid);
DO $$ BEGIN
  BEGIN
    PERFORM 1 / 0;
  EXCEPTION WHEN division_by_zero THEN NULL;
  END;
END; $$;
ROLLBACK;
DO $$ BEGIN
  IF auth.uid() IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL identity-leak-after-error';
  END IF;
  RAISE NOTICE 'PASS identity-cleared-after-error';
END; $$;
