-- MACROS.AI — 0002 row-level security
--
-- LOCKED PRIVACY RULE: personal nutrition data is private to the user. No
-- household owner may read another member's profile, goals or food logs.
--
-- LOCKED SECURITY INVARIANT: ordinary user operations execute under the user's
-- own identity, subject to these policies. No application path may use a
-- service-role credential to perform an ordinary user operation. A future
-- trusted worker may hold privileged credentials for specific administrative
-- duties; that is out of scope here.
--
-- APPEND-ONLY: the authenticated role is granted SELECT and INSERT on user data
-- and nothing else. There are deliberately NO update or delete policies on
-- immutable facts, so a missing policy is not an oversight — it is the control.

-- NOTE: no BEGIN/COMMIT here. The runner owns the transaction (see 0001).

-- ---------------------------------------------------------------------------
-- User-private tables
-- ---------------------------------------------------------------------------
ALTER TABLE user_profile_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_profile_versions FORCE ROW LEVEL SECURITY;

CREATE POLICY profile_versions_select_own ON user_profile_versions
    FOR SELECT TO authenticated
    USING (user_id = (SELECT auth.uid()));

CREATE POLICY profile_versions_insert_own ON user_profile_versions
    FOR INSERT TO authenticated
    WITH CHECK (user_id = (SELECT auth.uid()));

-- No UPDATE policy. No DELETE policy. Profile history is append-only.

ALTER TABLE energy_goal_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE energy_goal_versions FORCE ROW LEVEL SECURITY;

CREATE POLICY goal_versions_select_own ON energy_goal_versions
    FOR SELECT TO authenticated
    USING (user_id = (SELECT auth.uid()));

CREATE POLICY goal_versions_insert_own ON energy_goal_versions
    FOR INSERT TO authenticated
    WITH CHECK (user_id = (SELECT auth.uid()));

-- No UPDATE policy. No DELETE policy. Goal history is append-only.

ALTER TABLE food_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE food_logs FORCE ROW LEVEL SECURITY;

CREATE POLICY food_logs_select_own ON food_logs
    FOR SELECT TO authenticated
    USING (user_id = (SELECT auth.uid()));

-- WITH CHECK prevents inserting a row that claims another user's ownership.
CREATE POLICY food_logs_insert_own ON food_logs
    FOR INSERT TO authenticated
    WITH CHECK (user_id = (SELECT auth.uid()));

-- No UPDATE policy. No DELETE policy. Food logs are immutable.
-- Corrections will later be modelled as explicit append-only corrections.

-- ---------------------------------------------------------------------------
-- Shared catalog: readable by all authenticated users, writable by none
-- ---------------------------------------------------------------------------
ALTER TABLE catalog_products ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog_products FORCE ROW LEVEL SECURITY;

CREATE POLICY catalog_products_select_all ON catalog_products
    FOR SELECT TO authenticated
    USING (true);

ALTER TABLE product_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_versions FORCE ROW LEVEL SECURITY;

CREATE POLICY product_versions_select_all ON product_versions
    FOR SELECT TO authenticated
    USING (true);

-- No INSERT/UPDATE/DELETE policies for authenticated: ordinary end users never
-- mutate the shared catalog. Curation runs through a privileged path.

-- ---------------------------------------------------------------------------
-- Explicit grants: RLS filters rows, grants decide which verbs exist at all.
-- ---------------------------------------------------------------------------
REVOKE ALL ON user_profile_versions, energy_goal_versions, food_logs,
              catalog_products, product_versions FROM authenticated;

GRANT SELECT, INSERT ON user_profile_versions TO authenticated;
GRANT SELECT, INSERT ON energy_goal_versions  TO authenticated;
GRANT SELECT, INSERT ON food_logs             TO authenticated;
GRANT SELECT           ON catalog_products    TO authenticated;
GRANT SELECT           ON product_versions    TO authenticated;

