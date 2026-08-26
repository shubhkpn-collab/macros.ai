-- Deterministic fixtures, written against the ACTUAL migration columns.
-- Inserted as the database owner (privileged setup); the point of the matrices
-- is what an ORDINARY user can then do with them.
--
-- NOTE: no permission grants here. See 05-test-helpers.sql for why.

DELETE FROM food_log_voids WHERE user_id IN
  ('11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222');
DELETE FROM food_logs WHERE user_id IN
  ('11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222');
DELETE FROM energy_goal_versions WHERE user_id IN
  ('11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222');
DELETE FROM user_profile_versions WHERE user_id IN
  ('11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222');

-- Catalog: product_versions must exist before the deferred composite head FK
-- is checked at COMMIT.
INSERT INTO catalog_products (product_id, current_product_version_id, is_active)
VALUES ('prod-test-1', 'prod-test-1@v1', true)
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

-- A SECOND product, used to prove a head cannot adopt another product's version.
INSERT INTO product_versions (
  product_version_id, product_id, version_no, display_name, preparation_state,
  basis, source, effective_from
) VALUES (
  'prod-test-1@v2', 'prod-test-1', 2, 'Test food v2', 'as_sold',
  '{"kind":"per_100g","kcal":150,"proteinG":12,"carbohydrateG":6,"fatG":3}'::jsonb,
  '{"kind":"synthetic_test","verificationStatus":"synthetic_test"}'::jsonb,
  now()
) ON CONFLICT (product_version_id) DO NOTHING;

INSERT INTO user_profile_versions
  (profile_version_id, user_id, effective_from, age_years, sex, body_weight_kg, height_cm)
VALUES
  ('pv-a', '11111111-1111-4111-8111-111111111111', now(), 35, 'male',   82.5, 180),
  ('pv-b', '22222222-2222-4222-8222-222222222222', now(), 29, 'female', 64.0, 165)
ON CONFLICT (profile_version_id) DO NOTHING;

INSERT INTO energy_goal_versions
  (goal_version_id, user_id, effective_from, goal, target_delta_kcal)
VALUES
  ('gv-a', '11111111-1111-4111-8111-111111111111', now(), 'gain',  250),
  ('gv-b', '22222222-2222-4222-8222-222222222222', now(), 'lose', -400)
ON CONFLICT (goal_version_id) DO NOTHING;

-- Same log_id for both users: proves identity is composite (user_id, log_id).
INSERT INTO food_logs (
  user_id, log_id, product_id, product_version_id, grams, logged_at,
  event_timezone, event_utc_offset_minutes, local_date, nutrition_calc_version,
  weight_capture, nutrition_snapshot, kcal, protein_g, carbohydrate_g, fat_g
) VALUES
  ('11111111-1111-4111-8111-111111111111', 'shared-log-id', 'prod-test-1', 'prod-test-1@v1',
   100, now(), 'America/Chicago', -300, current_date, 'test',
   '{"grams":100}'::jsonb,
   '{"gramsConsumed":100,"productVersionId":"prod-test-1@v1","totals":{"kcal":100,"proteinG":10,"carbohydrateG":5,"fatG":2}}'::jsonb,
   100, 10, 5, 2),
  ('22222222-2222-4222-8222-222222222222', 'shared-log-id', 'prod-test-1', 'prod-test-1@v1',
   200, now(), 'America/Chicago', -300, current_date, 'test',
   '{"grams":200}'::jsonb,
   '{"gramsConsumed":200,"productVersionId":"prod-test-1@v1","totals":{"kcal":200,"proteinG":20,"carbohydrateG":10,"fatG":4}}'::jsonb,
   200, 20, 10, 4)
ON CONFLICT (user_id, log_id) DO NOTHING;

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
