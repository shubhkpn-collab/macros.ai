-- MACROS.AI — 0003 external product identifiers and catalog search metadata
--
-- STATUS: AUTHORED + STATICALLY TESTED. RUNTIME VALIDATION PENDING.
-- No PostgreSQL is available in this environment, so this migration has never
-- been executed and its RLS has never been enforced by a real engine.
--
-- Additive only. The catalog tables from 0001 are unchanged.

-- ---------------------------------------------------------------------------
-- External identifiers (GTIN / UPC / EAN)
-- ---------------------------------------------------------------------------
--
-- A barcode belongs to CATALOG IDENTITY, not to nutrition. It points at the
-- product, which resolves through the mutable head to the current version — so
-- a manufacturer can reformulate without the barcode changing, and a historical
-- food log keeps pointing at the exact version it was created with.
CREATE TABLE IF NOT EXISTS product_external_identifiers (
    normalized_value    text        NOT NULL,
    scheme              text        NOT NULL
        CHECK (scheme IN ('gtin_12', 'gtin_13', 'gtin_14', 'source_specific')),
    product_id          text        NOT NULL REFERENCES catalog_products (product_id) ON DELETE RESTRICT,
    raw_value           text        NOT NULL,
    source_key          text        NOT NULL,
    state               text        NOT NULL DEFAULT 'current'
        CHECK (state IN ('current', 'superseded', 'conflicted')),
    created_at          timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (normalized_value, product_id),

    -- GTINs are digits only, normalized to 14 characters.
    CONSTRAINT identifier_normalized_shape
        CHECK (scheme = 'source_specific' OR normalized_value ~ '^[0-9]{14}$')
);

-- ONE current identifier may resolve to AT MOST ONE product. Two active
-- products claiming the same barcode is a curation problem, not a race the
-- database silently resolves — so the constraint makes it impossible to
-- represent, and the importer must mark the loser 'conflicted'.
CREATE UNIQUE INDEX IF NOT EXISTS product_identifiers_one_current
    ON product_external_identifiers (normalized_value)
    WHERE state = 'current';

CREATE INDEX IF NOT EXISTS product_identifiers_by_product
    ON product_external_identifiers (product_id);

-- ---------------------------------------------------------------------------
-- Search aliases
-- ---------------------------------------------------------------------------
--
-- SEARCH METADATA. Editing an alias must never create a nutrition version, so
-- aliases live here and not on product_versions.
CREATE TABLE IF NOT EXISTS catalog_product_aliases (
    product_id   text        NOT NULL REFERENCES catalog_products (product_id) ON DELETE RESTRICT,
    alias        text        NOT NULL,
    curated_by   text        NOT NULL,
    curated_at   timestamptz NOT NULL,

    PRIMARY KEY (product_id, alias),
    CONSTRAINT alias_not_blank CHECK (length(btrim(alias)) > 0)
);

CREATE INDEX IF NOT EXISTS catalog_aliases_by_alias ON catalog_product_aliases (alias);

-- ---------------------------------------------------------------------------
-- Mutable catalog review metadata
-- ---------------------------------------------------------------------------
--
-- Re-reviewing a food must not mutate an immutable version, nor manufacture a
-- new nutrition version. Current review state therefore lives here; the version
-- keeps only its publication-time provenance.
CREATE TABLE IF NOT EXISTS catalog_review_metadata (
    product_id                  text        NOT NULL PRIMARY KEY
        REFERENCES catalog_products (product_id) ON DELETE RESTRICT,
    reviewed_product_version_id text        NOT NULL,
    verification_state          text        NOT NULL
        CHECK (verification_state IN ('source_backed', 'steward_reviewed', 'estimated', 'unreviewed')),
    nutrition_evidence          text        NOT NULL
        CHECK (nutrition_evidence IN ('manufacturer_label', 'authoritative_database',
                                      'curated_database', 'estimated', 'synthetic_test')),
    last_verified_at            timestamptz NOT NULL,
    reviewed_by                 text        NOT NULL,
    notes                       text,

    -- V-2: a COMPOSITE foreign key, not two independent ones.
    --
    -- Two separate FKs would each be satisfied while the reviewed version
    -- belonged to a DIFFERENT product — a review of product B filed against
    -- product A. product_versions already carries UNIQUE (product_version_id,
    -- product_id) and food_logs uses the same composite reference, so this
    -- mirrors an existing precedent rather than inventing a constraint.
    CONSTRAINT catalog_review_version_belongs_to_product
        FOREIGN KEY (reviewed_product_version_id, product_id)
        REFERENCES product_versions (product_version_id, product_id)
        ON DELETE RESTRICT
);

-- ---------------------------------------------------------------------------
-- RLS — catalog data is shared and read-only for end users
-- ---------------------------------------------------------------------------
ALTER TABLE product_external_identifiers ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_external_identifiers FORCE ROW LEVEL SECURITY;
ALTER TABLE catalog_product_aliases ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog_product_aliases FORCE ROW LEVEL SECURITY;
ALTER TABLE catalog_review_metadata ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog_review_metadata FORCE ROW LEVEL SECURITY;

CREATE POLICY product_identifiers_select ON product_external_identifiers
    FOR SELECT TO authenticated USING (true);
CREATE POLICY catalog_aliases_select ON catalog_product_aliases
    FOR SELECT TO authenticated USING (true);
CREATE POLICY catalog_review_select ON catalog_review_metadata
    FOR SELECT TO authenticated USING (true);

-- Catalog facts are shared; catalog curation is not an end-user operation.
-- There are deliberately no INSERT/UPDATE/DELETE policies or grants: a missing
-- policy here is the control, not an oversight.
GRANT SELECT ON product_external_identifiers TO authenticated;
GRANT SELECT ON catalog_product_aliases TO authenticated;
GRANT SELECT ON catalog_review_metadata TO authenticated;
