-- =====================================================================
-- HOUSEHOLD PRIVACY — the product's highest-severity database invariant.
-- =====================================================================
--   ADMINISTRATIVE AUTHORITY IS NOT NUTRITION ACCESS.
-- OWNER_A administers the household. That must grant zero visibility into
-- MEMBER_B's profile, goals, food logs or corrections.

\set A '11111111-1111-4111-8111-111111111111'
\set B '22222222-2222-4222-8222-222222222222'

-- --- 1. Owner cannot read ANY of the member's private tables ---------------
BEGIN;
SELECT auth.set_test_uid(:'A'::uuid);
DO $$
DECLARE n int; leaked text := '';
BEGIN
  SELECT count(*) INTO n FROM food_logs WHERE user_id <> auth.uid();
  IF n <> 0 THEN leaked := leaked || 'food_logs '; END IF;
  SELECT count(*) INTO n FROM user_profile_versions WHERE user_id <> auth.uid();
  IF n <> 0 THEN leaked := leaked || 'profiles '; END IF;
  SELECT count(*) INTO n FROM energy_goal_versions WHERE user_id <> auth.uid();
  IF n <> 0 THEN leaked := leaked || 'goals '; END IF;

  IF leaked <> '' THEN
    RAISE EXCEPTION 'FAIL owner-privacy: household OWNER read member data in: %', leaked;
  END IF;
  RAISE NOTICE 'PASS owner-privacy: owner reads none of member private data';
END;
$$;

-- ...while the SAME owner CAN administer the household in the same session.
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM household_memberships WHERE household_id = 'hh-test';
  IF n < 2 THEN RAISE EXCEPTION 'FAIL owner-admin: owner cannot read the roster'; END IF;
  RAISE NOTICE 'PASS owner-admin: roster readable (% rows) while nutrition stays private', n;
END;
$$;
ROLLBACK;

-- --- 2. Member cannot read the owner's private data either -----------------
BEGIN;
SELECT auth.set_test_uid(:'B'::uuid);
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM food_logs WHERE user_id <> auth.uid();
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL member-privacy: member read owner logs'; END IF;
  RAISE NOTICE 'PASS member-privacy: symmetric';
END;
$$;
ROLLBACK;

-- --- 3. Shared household metadata IS readable by active members -------------
BEGIN;
SELECT auth.set_test_uid(:'B'::uuid);
DO $$
DECLARE h int; d int; s int;
BEGIN
  SELECT count(*) INTO h FROM households WHERE household_id = 'hh-test';
  SELECT count(*) INTO d FROM household_devices WHERE household_id = 'hh-test';
  SELECT count(*) INTO s FROM household_seat_entitlements WHERE household_id = 'hh-test';
  IF h < 1 THEN RAISE EXCEPTION 'FAIL shared-read: member cannot read household metadata'; END IF;
  RAISE NOTICE 'PASS shared-read: household=% devices=% seats=%', h, d, s;
END;
$$;
ROLLBACK;

-- --- 4. A non-member sees no household rows at all -------------------------
BEGIN;
SELECT auth.set_test_uid('33333333-3333-4333-8333-333333333333'::uuid);
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM households WHERE household_id = 'hh-test';
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL non-member: outsider read household metadata'; END IF;
  RAISE NOTICE 'PASS non-member-denied';
END;
$$;
ROLLBACK;

-- --- 5. Single-active-owner constraint is enforced BY THE DATABASE ----------
-- Auth context is set FIRST. Without it RLS would deny the write before the
-- unique index was ever consulted, and an RLS rejection would masquerade as a
-- constraint proof. We assert the SQLSTATE to tell the two apart.
BEGIN;
SELECT auth.set_test_uid(:'A'::uuid);
DO $$
BEGIN
  BEGIN
    INSERT INTO household_memberships
      (household_id, user_id, role, status, age_attested, age_policy_version, age_attested_at)
    VALUES ('hh-test', '44444444-4444-4444-8444-444444444444', 'owner', 'active',
            true, 'age-18plus@1.0.0', now());
    RAISE EXCEPTION 'FAIL two-owners: database accepted a second active owner';
  EXCEPTION
    WHEN unique_violation THEN
      RAISE NOTICE 'PASS two-owners rejected by household_single_active_owner (SQLSTATE 23505)';
    WHEN insufficient_privilege THEN
      RAISE EXCEPTION 'INCONCLUSIVE two-owners: RLS denied before the constraint applied';
  END;
END;
$$;
ROLLBACK;

-- --- 6. Transfer must DEMOTE before PROMOTE, in one transaction -------------
BEGIN;
SELECT auth.set_test_uid(:'A'::uuid);
DO $$
BEGIN
  -- Promote-first ordering is what the partial unique index rejects.
  BEGIN
    UPDATE household_memberships SET role = 'owner'
      WHERE household_id = 'hh-test' AND user_id = '22222222-2222-4222-8222-222222222222';
    RAISE EXCEPTION 'FAIL transfer-order: promote-before-demote was accepted';
  EXCEPTION
    WHEN unique_violation THEN
      RAISE NOTICE 'PASS transfer-order: promote-first rejected (SQLSTATE 23505)';
    WHEN insufficient_privilege THEN
      RAISE EXCEPTION 'INCONCLUSIVE transfer-order: RLS denied before the constraint';
  END;
END;
$$;
ROLLBACK;

BEGIN;
SELECT auth.set_test_uid(:'A'::uuid);
UPDATE household_memberships SET role = 'member'
  WHERE household_id = 'hh-test' AND user_id = '11111111-1111-4111-8111-111111111111';
UPDATE household_memberships SET role = 'owner'
  WHERE household_id = 'hh-test' AND user_id = '22222222-2222-4222-8222-222222222222';
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM household_memberships
   WHERE household_id = 'hh-test' AND role = 'owner' AND status = 'active';
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL transfer: % active owners after transfer', n; END IF;
  RAISE NOTICE 'PASS transfer: demote-then-promote in one transaction leaves exactly 1 owner';
END;
$$;
ROLLBACK;  -- leave fixtures untouched

-- --- 7. Zero-owner: document which layer actually prevents it --------------
BEGIN;
SELECT auth.set_test_uid(:'A'::uuid);
DO $$
DECLARE n int;
BEGIN
  UPDATE household_memberships SET role = 'member'
    WHERE household_id = 'hh-test' AND role = 'owner';
  SELECT count(*) INTO n FROM household_memberships
   WHERE household_id = 'hh-test' AND role = 'owner' AND status = 'active';
  IF n = 0 THEN
    RAISE NOTICE 'NOTE zero-owner: the DATABASE permits it; prevention is DOMAIN-layer only '
                 '(transferOwnership / removeMembership). Documented, not claimed as DB-enforced.';
  END IF;
END;
$$;
ROLLBACK;


-- --- 8. RECURSION PROOF: every household relation reads without recursing ---
-- Before the SECURITY DEFINER helpers, a policy on household_memberships
-- queried household_memberships, and PostgreSQL raised
-- "infinite recursion detected in policy for relation household_memberships".
BEGIN;
SELECT auth.set_test_uid(:'B'::uuid);
DO $$
DECLARE n int;
BEGIN
  BEGIN
    SELECT count(*) INTO n FROM household_memberships;  RAISE NOTICE 'PASS no-recursion memberships (%)', n;
    SELECT count(*) INTO n FROM households;             RAISE NOTICE 'PASS no-recursion households (%)', n;
    SELECT count(*) INTO n FROM household_devices;      RAISE NOTICE 'PASS no-recursion devices (%)', n;
    SELECT count(*) INTO n FROM household_seat_entitlements; RAISE NOTICE 'PASS no-recursion seats (%)', n;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM ILIKE '%recursion%' THEN
      RAISE EXCEPTION 'FAIL rls-recursion: %', SQLERRM;
    END IF;
    RAISE;
  END;
END;
$$;
ROLLBACK;

-- --- 9. The helper cannot be used to probe ANOTHER user's membership -------
BEGIN;
SELECT auth.set_test_uid('33333333-3333-4333-8333-333333333333'::uuid);
DO $$
BEGIN
  -- It derives the subject from auth.uid() internally and takes no userId, so
  -- an outsider asking about a household they do not belong to gets false.
  IF public.is_active_household_member('hh-test') THEN
    RAISE EXCEPTION 'FAIL helper-scope: outsider reported as a member';
  END IF;
  IF public.is_active_household_owner('hh-test') THEN
    RAISE EXCEPTION 'FAIL helper-scope: outsider reported as owner';
  END IF;
  RAISE NOTICE 'PASS helper-scope: returns only the CALLER''s own authorization fact';
END;
$$;
ROLLBACK;
