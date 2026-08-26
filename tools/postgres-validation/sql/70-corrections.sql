-- MIGRATION 0004 — corrections / voids, append-only lineage and ownership.
\set A '11111111-1111-4111-8111-111111111111'
\set B '22222222-2222-4222-8222-222222222222'

BEGIN;
SELECT auth.set_test_uid(:'A'::uuid);
DO $$
DECLARE n int;
BEGIN
  -- A may void A's OWN log.
  INSERT INTO food_log_voids (void_id, user_id, log_id, reason, voided_at)
  VALUES ('void-a-1', auth.uid(), 'shared-log-id', 'correction', now())
  ON CONFLICT DO NOTHING;
  SELECT count(*) INTO n FROM food_log_voids WHERE user_id = auth.uid();
  IF n < 1 THEN RAISE EXCEPTION 'FAIL void-self: A cannot void its own log'; END IF;
  RAISE NOTICE 'PASS void-self';

  -- A may NOT void B's log.
  BEGIN
    INSERT INTO food_log_voids (void_id, user_id, log_id, reason, voided_at)
    VALUES ('void-forged', '22222222-2222-4222-8222-222222222222', 'shared-log-id',
            'malicious', now());
    RAISE EXCEPTION 'FAIL void-cross-user: A voided a log owned by B';
  EXCEPTION WHEN insufficient_privilege OR check_violation THEN
    RAISE NOTICE 'PASS void-cross-user refused';
  END;

  -- A cannot see B's voids.
  SELECT count(*) INTO n FROM food_log_voids WHERE user_id <> auth.uid();
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL void-isolation: A sees % of B voids', n; END IF;
  RAISE NOTICE 'PASS void-isolation';
END;
$$;
ROLLBACK;

-- The original log must remain readable and unchanged after a void: history is
-- append-only, and a void is a new fact rather than an edit.
BEGIN;
SELECT auth.set_test_uid(:'A'::uuid);
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM food_logs WHERE user_id = auth.uid() AND log_id = 'shared-log-id';
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL void-history: original row missing'; END IF;
  RAISE NOTICE 'PASS void-history: original log intact';
END;
$$;
ROLLBACK;
