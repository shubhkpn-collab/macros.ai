# 04 — Database Architecture

> **PARTIALLY SUPERSEDED — owner rulings A–H, 2026-08-10.** Where this document conflicts with `DECISION-LOCK.md`, the Decision Lock governs. See `CHANGE-REPORT.md`.


PostgreSQL, one database, **one schema per module**. Cross-schema foreign keys are permitted only where the reference is to a stable identity (`identity.users.id`, `food.product_versions.id`); everything else goes through module interfaces.

## Schema map

```
identity   households · users · household_members · consents · profiles
device     devices · device_bindings · device_sessions · firmware_releases
food       sources · source_records · staging_products · brands · products
           product_versions · product_nutrients · product_servings · gtins
           retailers · product_availability · product_images · merge_events
nutrition  nutrients · calc_versions
intake     food_logs · food_log_items · meals · recipes · recipe_items
energy     energy_models · expenditure_events · intake_events · balance_snapshots
           weight_measurements
macros     macro_targets
prediction forecasts · model_runs
wearable   provider_connections · sync_runs · activity_samples
scale      calibrations · weight_captures
ai         conversations · turns · tool_calls · refusals · eval_runs
knowledge  documents · chunks · embeddings   ← guidance text only, never nutrition
billing    subscriptions · seats · entitlements
analytics  events (partitioned monthly)
```

## 1. Identity & isolation

```sql
identity.users            (id, auth_user_id, display_name, created_at, ...)
identity.households       (id, name, owner_user_id, created_at)
identity.household_members(household_id, user_id, role, seat_status, joined_at, PK(household_id,user_id))
```

Users are **global identities that join households**, not children of households (A8). This makes "Jackson has profiles in two households", "Mom leaves and keeps her data", and "device is sold" all tractable.

**Row-level security is the isolation mechanism, on every user-scoped table, deny-by-default.** Three principals:

| Principal | Sees |
|---|---|
| `app_user` (a person, via Supabase JWT) | own rows; household rows only for non-personal facts (household name, device) |
| `app_device` (the tablet, device-scoped token) | only the **currently active session's** user rows, and only for the household it is bound to |
| `app_service` (backend worker) | bypasses RLS, but every query is user-scoped in code and audited |

The device principal is the important one: a shared tablet must not be able to enumerate every household member's nutrition data just because it is physically present. Session activation issues a short-lived, user-scoped token.

## 2. Food catalog — versioned by construction

```sql
food.products          (id, canonical_name, brand_id, preparation_state, category, is_active)
food.product_versions  (id, product_id, version_no, effective_from, effective_to,
                        source_id, confidence, verification_status, last_verified_at,
                        supersedes_version_id, created_at)
food.product_nutrients (product_version_id, nutrient_id, amount_per_100g, unit)
food.product_servings  (product_version_id, label, grams, is_default, household_serving)
food.gtins             (gtin, product_version_id, gtin_type, first_seen, last_seen)
food.brands            (id, name, normalized_name, owner_org, is_private_label, retailer_id)
food.retailers         (id, name, country, banner_group)
food.product_availability (product_version_id, retailer_id, region_code,
                           first_observed, last_observed, status)
```

Non-negotiable rules:
- **Nutrition is stored per 100 g (or per 100 ml with a density) only.** Declared serving sizes are a presentation layer. All math runs off the canonical basis. This eliminates an entire class of serving-unit bugs.
- **Logs reference `product_version_id`, never `product_id`.** A September correction cannot alter an August log (B4).
- **Retailer is an availability edge**, not a product column (B3).
- **`preparation_state`** ∈ {raw, cooked, as_packaged, prepared_per_instructions} with optional `yield_factor` to a sibling version (A2).
- Products are never hard-deleted; `is_active=false` plus `product_versions.effective_to`.

## 3. Intake

```sql
intake.food_logs      (id, user_id, logged_at, source, device_id, session_id, status)
intake.food_log_items (id, log_id, product_version_id, grams, weight_source,
                       weight_stability, calibration_id, nutrition_snapshot jsonb,
                       calc_version, created_at)
```

`nutrition_snapshot` denormalizes the computed values *at log time*. Recomputation is possible but never required to render history, and any recompute writes a new row rather than mutating. Corrections are **append-only**: a correction row references the original with `supersedes_item_id`; `status` handles voids. Never `UPDATE` a log; the energy engine's audit trail depends on it.

## 4. Energy — event-sourced

```sql
energy.energy_models      (id, user_id, effective_from, bmr_kcal, method, pal_factor,
                           tdee_baseline, target_delta_kcal, calc_version)
energy.expenditure_events (id, user_id, occurred_at, kind, kcal, source, source_ref,
                           confidence, superseded_by)
energy.intake_events      (id, user_id, occurred_at, kcal, protein_g, carb_g, fat_g,
                           log_item_id)
energy.balance_snapshots  (id, user_id, as_of, realized_kcal, projected_eod_kcal,
                           target_kcal, inputs_hash, calc_version, computed_at)
energy.weight_measurements(id, user_id, measured_at, kg, source, is_outlier)
```

`kind` ∈ {`bmr_accrual`, `activity_wearable`, `activity_baseline`, `tef`, `manual`}. Wearable backfills append events and mark superseded ones rather than editing — so "why did yesterday change?" is always answerable (D5).

`balance_snapshots.inputs_hash` is the hash of the ordered event set + model + calc version. Identical hash ⇒ identical output, forever. This is the auditability guarantee for the north-star KPI.

## 5. Knowledge (vector store for guidance text)

> **Corrected:** the rule is *no product nutrition facts in vectors*. Name/description embeddings in the `food` schema are permitted as one search signal (see `05`). The earlier "pgvector only in `knowledge`" wording was wrong.

```sql
knowledge.chunks     (id, document_id, content, metadata jsonb)
knowledge.embeddings (chunk_id, embedding vector(1536))  -- HNSW index
```

Contains nutrition guidance, food-science reference, and product-help content. **It does not contain product nutrition data.** Per the brief: product facts stay structured. The only vectors touching the catalog are *name/description embeddings* used as one search signal (`05`), stored in `food`, never as a source of nutritional truth.

## 6. Analytics

Append-only, monthly-partitioned, pseudonymous user keys, no free-text utterances by default. Kept out of the OLTP hot path; exported for analysis rather than queried live.

## 7. Migrations & operations

- Forward-only SQL migrations, reviewed alongside RLS policy diffs.
- **Every migration touching a user-scoped table must include or reaffirm its RLS policy**; CI rejects tables with RLS disabled.
- PITR on; nightly logical backup of `food` (catalog rebuild is expensive).
- Seed data: golden product set + synthetic households for E2E.
