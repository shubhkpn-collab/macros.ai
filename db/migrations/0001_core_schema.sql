-- MACROS.AI — 0001 core schema (MVP-0 deterministic spine)
--
-- Scope is bounded to what the deterministic spine needs today. This is not the
-- future platform schema.
--
-- Design rules enforced here:
--   * immutable facts are append-only; corrections insert a new version
--   * a food log's first-class columns and its JSONB snapshot cannot disagree
--   * identity of a log is (user_id, log_id), never log_id alone
--   * history is never destroyed by a cascade

BEGIN;

-- ---------------------------------------------------------------------------
-- Versioned user profile (append-only, effective-dated)
-- ---------------------------------------------------------------------------
CREATE TABLE user_profile_versions (
    profile_version_id  text PRIMARY KEY,
    user_id             uuid        NOT NULL,
    effective_from      timestamptz NOT NULL,
    age_years           integer     NOT NULL CHECK (age_years >= 18 AND age_years <= 120),
    sex                 text        NOT NULL CHECK (sex IN ('male', 'female')),
    body_weight_kg      numeric(6,2) NOT NULL CHECK (body_weight_kg > 0),
    height_cm           numeric(6,2) NOT NULL CHECK (height_cm > 0),
    body_fat_percent    numeric(5,2) CHECK (body_fat_percent > 0 AND body_fat_percent < 100),
    body_fat_source     text,
    created_at          timestamptz NOT NULL DEFAULT now()
);
-- Age is stored, never a date of birth: we need the physiological input, not a
-- birth date, and storing DOB purely to derive age would be excess collection.
COMMENT ON COLUMN user_profile_versions.age_years IS
    'Physiological input. Date of birth is deliberately NOT stored.';

CREATE INDEX idx_profile_versions_user_effective
    ON user_profile_versions (user_id, effective_from DESC);

-- ---------------------------------------------------------------------------
-- Versioned energy goal (append-only)
-- ---------------------------------------------------------------------------
CREATE TABLE energy_goal_versions (
    goal_version_id   text PRIMARY KEY,
    user_id           uuid        NOT NULL,
    effective_from    timestamptz NOT NULL,
    goal              text        NOT NULL CHECK (goal IN ('lose', 'maintain', 'gain')),
    target_delta_kcal integer     NOT NULL,
    created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_goal_versions_user_effective
    ON energy_goal_versions (user_id, effective_from DESC);

-- ---------------------------------------------------------------------------
-- Catalog: MUTABLE head, separate from IMMUTABLE versions
-- ---------------------------------------------------------------------------
CREATE TABLE catalog_products (
    product_id                 text PRIMARY KEY,
    current_product_version_id text NOT NULL,
    is_active                  boolean NOT NULL DEFAULT true,
    updated_at                 timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE product_versions (
    product_version_id text PRIMARY KEY,
    product_id         text NOT NULL REFERENCES catalog_products (product_id) ON DELETE RESTRICT,
    version_no         integer NOT NULL CHECK (version_no >= 1),
    display_name       text NOT NULL,
    brand_name         text,
    preparation_state  text NOT NULL
        CHECK (preparation_state IN ('raw', 'cooked', 'prepared', 'as_sold')),
    -- Normalized canonical basis. All arithmetic runs off this.
    basis              jsonb NOT NULL,
    -- Original declared facts, retained verbatim. Never reconstructed.
    label_facts        jsonb,
    source             jsonb NOT NULL,
    effective_from     timestamptz NOT NULL,
    created_at         timestamptz NOT NULL DEFAULT now(),
    UNIQUE (product_id, version_no),
    -- Referenced by the composite FK on food_logs so a log's product_id and
    -- product_version_id can never disagree about which product it was.
    UNIQUE (product_version_id, product_id)
);

-- A head may only point at a version of its own product.
ALTER TABLE catalog_products
    ADD CONSTRAINT catalog_products_head_fk
    FOREIGN KEY (current_product_version_id)
    REFERENCES product_versions (product_version_id)
    DEFERRABLE INITIALLY DEFERRED;

CREATE INDEX idx_product_versions_product ON product_versions (product_id, version_no DESC);

-- ---------------------------------------------------------------------------
-- Food logs: immutable, append-only, per-user
-- ---------------------------------------------------------------------------
CREATE TABLE food_logs (
    user_id                  uuid NOT NULL,
    log_id                   text NOT NULL,
    product_id               text NOT NULL,
    product_version_id       text NOT NULL,
    grams                    numeric(10,3) NOT NULL CHECK (grams > 0),
    logged_at                timestamptz NOT NULL,
    event_timezone           text NOT NULL,
    event_utc_offset_minutes integer NOT NULL,
    local_date               date NOT NULL,
    meal_id                  text,
    nutrition_calc_version   text NOT NULL,
    weight_capture           jsonb NOT NULL,
    nutrition_snapshot       jsonb NOT NULL,
    kcal                     numeric(10,4) NOT NULL CHECK (kcal >= 0),
    protein_g                numeric(10,4) NOT NULL CHECK (protein_g >= 0),
    carbohydrate_g           numeric(10,4) NOT NULL CHECK (carbohydrate_g >= 0),
    fat_g                    numeric(10,4) NOT NULL CHECK (fat_g >= 0),
    status                   text NOT NULL DEFAULT 'active' CHECK (status IN ('active')),
    created_at               timestamptz NOT NULL DEFAULT now(),

    -- IDENTITY IS (user_id, log_id). Two users may generate the same client-side
    -- id; one must never mask or overwrite the other. This constraint is what
    -- makes idempotent append concurrency-safe.
    PRIMARY KEY (user_id, log_id),

    -- The JSONB snapshot may never contradict the first-class columns.
    --
    -- Compared at the COLUMN'S DECLARED SCALE. Binary floating point produces
    -- values such as 76.57000000000001 for ordinary inputs; numeric(10,4)
    -- cannot represent that and rounds on insert. Comparing the raw JSONB value
    -- to the rounded column would reject every such log. The snapshot remains
    -- authoritative; these columns are a rounded query projection of it.
    CONSTRAINT food_logs_snapshot_grams_agree
        CHECK (round((nutrition_snapshot ->> 'gramsConsumed')::numeric, 3) = grams),
    CONSTRAINT food_logs_snapshot_version_agree
        CHECK (nutrition_snapshot ->> 'productVersionId' = product_version_id),
    CONSTRAINT food_logs_snapshot_kcal_agree
        CHECK (round((nutrition_snapshot -> 'totals' ->> 'kcal')::numeric, 4) = kcal),
    CONSTRAINT food_logs_snapshot_protein_agree
        CHECK (round((nutrition_snapshot -> 'totals' ->> 'proteinG')::numeric, 4) = protein_g),
    CONSTRAINT food_logs_snapshot_carb_agree
        CHECK (round((nutrition_snapshot -> 'totals' ->> 'carbohydrateG')::numeric, 4) = carbohydrate_g),
    CONSTRAINT food_logs_snapshot_fat_agree
        CHECK (round((nutrition_snapshot -> 'totals' ->> 'fatG')::numeric, 4) = fat_g),
    CONSTRAINT food_logs_capture_grams_agree
        CHECK (round((weight_capture ->> 'grams')::numeric, 3) = grams),

    -- COMPOSITE reference: the version must belong to the product the log
    -- claims. A row cannot say "product X" while pointing at a version of
    -- product Y. RESTRICT, never CASCADE: deleting catalog data must never
    -- destroy a user's historical nutrition record.
    CONSTRAINT food_logs_product_version_fk
        FOREIGN KEY (product_version_id, product_id)
        REFERENCES product_versions (product_version_id, product_id)
        ON DELETE RESTRICT
);

-- The daily-intake query path: one user, one local calendar day.
CREATE INDEX idx_food_logs_user_local_date ON food_logs (user_id, local_date);
CREATE INDEX idx_food_logs_product_version ON food_logs (product_version_id);

COMMIT;
