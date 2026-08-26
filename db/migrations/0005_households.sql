-- MACROS.AI — 0005 households, memberships, devices, seat entitlement
--
-- STATUS: AUTHORED + STATICALLY TESTED. RUNTIME VALIDATION PENDING POSTGRESQL.
--
-- THE GOVERNING INVARIANT:
--
--   HOUSEHOLD ADMINISTRATION IS NOT NUTRITION ACCESS.
--
-- There is deliberately NO policy anywhere below granting an owner access to
-- another member's personal rows. Every personal table stays user-scoped
-- exactly as it is today; these tables add shared household metadata only.

CREATE TABLE IF NOT EXISTS households (
    household_id  text        NOT NULL PRIMARY KEY,
    display_name  text        NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    dissolved_at  timestamptz
);

CREATE TABLE IF NOT EXISTS household_memberships (
    household_id      text        NOT NULL REFERENCES households (household_id) ON DELETE RESTRICT,
    user_id           uuid        NOT NULL,
    role              text        NOT NULL CHECK (role IN ('owner', 'member')),
    status            text        NOT NULL CHECK (status IN ('invited', 'active', 'removed')),
    joined_at         timestamptz NOT NULL DEFAULT now(),
    ended_at          timestamptz,
    -- 18+ attestation only. A date of birth is deliberately NOT stored: we have
    -- no other use for it, so collecting it would be unjustified.
    age_attested      boolean     NOT NULL DEFAULT false,
    age_policy_version text,
    age_attested_at   timestamptz,

    PRIMARY KEY (household_id, user_id),
    CONSTRAINT membership_age_shape CHECK (
        (age_attested = false) OR (age_policy_version IS NOT NULL AND age_attested_at IS NOT NULL)
    ),
    CONSTRAINT membership_ended_shape CHECK (
        (status <> 'removed') OR (ended_at IS NOT NULL)
    )
);

-- A household must never silently become ownerless: at most one ACTIVE owner,
-- and application logic requires a transfer before the last owner may leave.
--
-- ORDERING REQUIREMENT FOR TRANSFER (enforced by this index):
-- an ownership transfer MUST demote the outgoing owner BEFORE promoting the
-- incoming one, and both statements MUST run in one transaction. Promoting
-- first would momentarily create two active owners and be rejected by this
-- index. `transferOwnership` in @macros/domain-household emits exactly one
-- atomic state, so the ordering is a property of the write, not a convention.
CREATE UNIQUE INDEX IF NOT EXISTS household_single_active_owner
    ON household_memberships (household_id)
    WHERE role = 'owner' AND status = 'active';

CREATE INDEX IF NOT EXISTS household_memberships_by_user
    ON household_memberships (user_id, status);

CREATE TABLE IF NOT EXISTS household_devices (
    device_id           text        NOT NULL PRIMARY KEY,
    household_id        text        NOT NULL REFERENCES households (household_id) ON DELETE RESTRICT,
    status              text        NOT NULL CHECK (status IN ('bound', 'unbound')),
    bound_at            timestamptz NOT NULL DEFAULT now(),
    -- Advances on every rebind so stale household context cannot survive.
    binding_generation  integer     NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS household_seat_entitlements (
    household_id text    NOT NULL PRIMARY KEY REFERENCES households (household_id) ON DELETE RESTRICT,
    capacity     integer NOT NULL CHECK (capacity >= 1),
    state        text    NOT NULL CHECK (state IN ('active', 'suspended')),
    updated_at   timestamptz NOT NULL DEFAULT now()
    -- Deliberately NO price, plan or payment-provider column. Billing is a
    -- separate domain, and a lapsed subscription must never be inferred here
    -- as authority to delete a member.
);

-- ---------------------------------------------------------------------------
-- RLS — shared household rows are membership-aware; personal rows are untouched
-- ---------------------------------------------------------------------------
ALTER TABLE households                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE households                  FORCE  ROW LEVEL SECURITY;
ALTER TABLE household_memberships       ENABLE ROW LEVEL SECURITY;
ALTER TABLE household_memberships       FORCE  ROW LEVEL SECURITY;
ALTER TABLE household_devices           ENABLE ROW LEVEL SECURITY;
ALTER TABLE household_devices           FORCE  ROW LEVEL SECURITY;
ALTER TABLE household_seat_entitlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE household_seat_entitlements FORCE  ROW LEVEL SECURITY;

-- An ACTIVE member may read shared household metadata.
CREATE POLICY households_select ON households
    FOR SELECT TO authenticated USING (
        EXISTS (SELECT 1 FROM household_memberships hm
                WHERE hm.household_id = households.household_id
                  AND hm.user_id = auth.uid() AND hm.status = 'active')
    );

-- Only the ACTIVE owner may change it.
CREATE POLICY households_update ON households
    FOR UPDATE TO authenticated USING (
        EXISTS (SELECT 1 FROM household_memberships hm
                WHERE hm.household_id = households.household_id
                  AND hm.user_id = auth.uid() AND hm.status = 'active' AND hm.role = 'owner')
    );

-- Members see the roster (names/roles live in profile tables, not here).
CREATE POLICY memberships_select ON household_memberships
    FOR SELECT TO authenticated USING (
        user_id = auth.uid()
        OR EXISTS (SELECT 1 FROM household_memberships me
                   WHERE me.household_id = household_memberships.household_id
                     AND me.user_id = auth.uid() AND me.status = 'active')
    );

CREATE POLICY memberships_admin ON household_memberships
    FOR ALL TO authenticated USING (
        EXISTS (SELECT 1 FROM household_memberships me
                WHERE me.household_id = household_memberships.household_id
                  AND me.user_id = auth.uid() AND me.status = 'active' AND me.role = 'owner')
    );

CREATE POLICY devices_select ON household_devices
    FOR SELECT TO authenticated USING (
        EXISTS (SELECT 1 FROM household_memberships hm
                WHERE hm.household_id = household_devices.household_id
                  AND hm.user_id = auth.uid() AND hm.status = 'active')
    );

CREATE POLICY devices_admin ON household_devices
    FOR ALL TO authenticated USING (
        EXISTS (SELECT 1 FROM household_memberships hm
                WHERE hm.household_id = household_devices.household_id
                  AND hm.user_id = auth.uid() AND hm.status = 'active' AND hm.role = 'owner')
    );

CREATE POLICY seats_select ON household_seat_entitlements
    FOR SELECT TO authenticated USING (
        EXISTS (SELECT 1 FROM household_memberships hm
                WHERE hm.household_id = household_seat_entitlements.household_id
                  AND hm.user_id = auth.uid() AND hm.status = 'active')
    );

CREATE POLICY seats_admin ON household_seat_entitlements
    FOR ALL TO authenticated USING (
        EXISTS (SELECT 1 FROM household_memberships hm
                WHERE hm.household_id = household_seat_entitlements.household_id
                  AND hm.user_id = auth.uid() AND hm.status = 'active' AND hm.role = 'owner')
    );

GRANT SELECT, INSERT, UPDATE ON households, household_memberships,
      household_devices, household_seat_entitlements TO authenticated;
