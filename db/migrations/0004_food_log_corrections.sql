-- MACROS.AI — 0004 append-only food log corrections and voids
--
-- STATUS: AUTHORED + STATICALLY TESTED. RUNTIME VALIDATION PENDING.
--
-- Additive only. No existing column changes type, and no UPDATE or DELETE
-- capability is introduced anywhere.
--
-- WHY APPEND-ONLY:
-- A stored food log is the historical record of what the user was told they
-- ate. It is never rewritten. A correction is a NEW row naming the row it
-- supersedes; a void is a NEW row naming the row it removes. Effective state is
-- DERIVED by folding the stream, so `status` on a stored row stays exactly as
-- written and the original numbers remain auditable months later.

-- ---------------------------------------------------------------------------
-- Correction lineage on food_logs
-- ---------------------------------------------------------------------------
ALTER TABLE food_logs
    ADD COLUMN IF NOT EXISTS entry_kind        text NOT NULL DEFAULT 'original'
        CHECK (entry_kind IN ('original', 'correction')),
    ADD COLUMN IF NOT EXISTS supersedes_log_id text,
    ADD COLUMN IF NOT EXISTS correction_reason text;

-- A correction must name its target; an original must not.
ALTER TABLE food_logs
    ADD CONSTRAINT food_logs_correction_shape
    CHECK (
        (entry_kind = 'correction' AND supersedes_log_id IS NOT NULL)
     OR (entry_kind = 'original'   AND supersedes_log_id IS NULL)
    );

-- Nothing may supersede itself.
ALTER TABLE food_logs
    ADD CONSTRAINT food_logs_no_self_supersede
    CHECK (supersedes_log_id IS NULL OR supersedes_log_id <> log_id);

-- The superseded entry must belong to the SAME USER. A composite reference,
-- not a bare one: a correction must never reach across users.
ALTER TABLE food_logs
    ADD CONSTRAINT food_logs_supersedes_same_user
    FOREIGN KEY (user_id, supersedes_log_id)
    REFERENCES food_logs (user_id, log_id)
    ON DELETE RESTRICT;

-- At most ONE correction may supersede a given entry. Two corrections of one
-- entry is a conflict a human resolves, not a race the database silently
-- settles by last-writer-wins.
CREATE UNIQUE INDEX IF NOT EXISTS food_logs_one_correction_per_target
    ON food_logs (user_id, supersedes_log_id)
    WHERE supersedes_log_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Voids
-- ---------------------------------------------------------------------------
--
-- A void carries NO nutrition and NO weight, deliberately. A voided meal did
-- not happen; writing zeroed nutrition for it would put a fabricated record in
-- the log stream. It lives in its own table because food_logs requires
-- nutrition on every row — and that requirement is worth keeping.
CREATE TABLE IF NOT EXISTS food_log_voids (
    user_id                 uuid        NOT NULL,
    void_id                 text        NOT NULL,
    voids_log_id            text        NOT NULL,
    reason                  text,
    recorded_at             timestamptz NOT NULL,
    event_timezone          text        NOT NULL,
    event_utc_offset_minutes integer    NOT NULL,
    local_date              date        NOT NULL,
    created_at              timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (user_id, void_id),

    -- Same-user composite reference: one user can never void another's meal.
    CONSTRAINT food_log_voids_target_same_user
        FOREIGN KEY (user_id, voids_log_id)
        REFERENCES food_logs (user_id, log_id)
        ON DELETE RESTRICT
);

-- One void per entry. A repeated void is a duplicate, not a second removal.
CREATE UNIQUE INDEX IF NOT EXISTS food_log_voids_one_per_target
    ON food_log_voids (user_id, voids_log_id);

CREATE INDEX IF NOT EXISTS food_log_voids_by_day
    ON food_log_voids (user_id, local_date);

-- ---------------------------------------------------------------------------
-- RLS — private to the user, INSERT and SELECT only
-- ---------------------------------------------------------------------------
ALTER TABLE food_log_voids ENABLE ROW LEVEL SECURITY;
ALTER TABLE food_log_voids FORCE ROW LEVEL SECURITY;

CREATE POLICY food_log_voids_select ON food_log_voids
    FOR SELECT TO authenticated USING (user_id = auth.uid());

CREATE POLICY food_log_voids_insert ON food_log_voids
    FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());

-- No UPDATE or DELETE policy and no such grant: a void is itself append-only.
GRANT SELECT, INSERT ON food_log_voids TO authenticated;
