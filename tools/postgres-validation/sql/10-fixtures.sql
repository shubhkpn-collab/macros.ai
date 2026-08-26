-- Deterministic fixtures. Inserted as the OWNER (privileged setup), because the
-- point of the RLS tests is what an ORDINARY user can then do with them.
BEGIN;

-- Stable UUIDs so results are comparable across runs.
-- USER_A / OWNER_A  = 1111...  |  USER_B / MEMBER_B = 2222...
DELETE FROM food_logs WHERE user_id IN
  ('11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222');
DELETE FROM energy_goal_versions WHERE user_id IN
  ('11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222');
DELETE FROM user_profile_versions WHERE user_id IN
  ('11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222');

INSERT INTO catalog_products (product_id, kind, current_version_id, created_at)
VALUES ('prod-test-1', 'generic', 'prod-test-1@v1', now())
ON CONFLICT (product_id) DO NOTHING;

INSERT INTO product_versions (
  product_version_id, product_id, version_no, display_name, preparation_state,
  basis, source, effective_from
) VALUES (
  'prod-test-1@v1', 'prod-test-1', 1, 'Test food', 'as_sold',
  '{"kind":"per_100g","kcal":100,"proteinG":10,"carbohydrateG":5,"fatG":2}'::jsonb,
  '{"kind":"synthetic_test","verificationStatus":"synthetic_test"}'::jsonb,
  now()
) ON CONFLICT (product_version_id) DO NOTHING;

-- One profile and goal per user.
INSERT INTO user_profile_versions (profile_version_id, user_id, sex, birth_year, height_cm, effective_from)
VALUES
  ('pv-a', '11111111-1111-4111-8111-111111111111', 'male',   1990, 180, now()),
  ('pv-b', '22222222-2222-4222-8222-222222222222', 'female', 1994, 165, now())
ON CONFLICT (profile_version_id) DO NOTHING;

INSERT INTO energy_goal_versions (goal_version_id, user_id, goal, target_delta_kcal, effective_from)
VALUES
  ('gv-a', '11111111-1111-4111-8111-111111111111', 'gain',  250, now()),
  ('gv-b', '22222222-2222-4222-8222-222222222222', 'lose', -400, now())
ON CONFLICT (goal_version_id) DO NOTHING;

-- One food log per user, SAME log_id, proving identity is composite.
INSERT INTO food_logs (
  user_id, log_id, product_id, product_version_id, grams, logged_at,
  event_timezone, event_utc_offset_minutes, local_date, nutrition_calc_version,
  weight_capture, nutrition_snapshot, kcal, protein_g, carbohydrate_g, fat_g
) VALUES
  ('11111111-1111-4111-8111-111111111111', 'shared-log-id', 'prod-test-1', 'prod-test-1@v1',
   100, now(), 'America/Chicago', -300, current_date, 'test',
   '{"grams":100}'::jsonb, '{"totals":{"kcal":100}}'::jsonb, 100, 10, 5, 2),
  ('22222222-2222-4222-8222-222222222222', 'shared-log-id', 'prod-test-1', 'prod-test-1@v1',
   200, now(), 'America/Chicago', -300, current_date, 'test',
   '{"grams":200}'::jsonb, '{"totals":{"kcal":200}}'::jsonb, 200, 20, 10, 4)
ON CONFLICT (user_id, log_id) DO NOTHING;

-- Household: OWNER_A administers, MEMBER_B is an ordinary member.
INSERT INTO households (household_id, display_name)
VALUES ('hh-test', 'Test Household') ON CONFLICT (household_id) DO NOTHING;

INSERT INTO household_memberships
  (household_id, user_id, role, status, age_attested, age_policy_version, age_attested_at)
VALUES
  ('hh-test', '11111111-1111-4111-8111-111111111111', 'owner',  'active', true, 'age-18plus@1.0.0', now()),
  ('hh-test', '22222222-2222-4222-8222-222222222222', 'member', 'active', true, 'age-18plus@1.0.0', now())
ON CONFLICT (household_id, user_id) DO NOTHING;

INSERT INTO household_devices (device_id, household_id, status)
VALUES ('dev-test', 'hh-test', 'bound') ON CONFLICT (device_id) DO NOTHING;

INSERT INTO household_seat_entitlements (household_id, capacity, state)
VALUES ('hh-test', 4, 'active') ON CONFLICT (household_id) DO NOTHING;

GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA public TO authenticated;

COMMIT;
