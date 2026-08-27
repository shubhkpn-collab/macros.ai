import {
  centimetres,
  grams,
  instant,
  kilograms,
  unwrap,
  validateFoodLogItem,
  validateProductVersion,
  validateUserProfile,
  years,
  type EnergyGoalVersion,
  type FoodLogItem,
  type NutritionSnapshot,
  type ProductCatalogHead,
  type ProductVersion,
  type UserProfileSnapshot,
  type WeightCapture,
} from '@macros/contracts';

/**
 * ROW CODECS — the trust boundary between the database and the domain.
 *
 * Database JSON is NEVER trusted. A row may have been written by an older
 * build, hand-edited, restored from a backup, or corrupted. Every persisted
 * structure is re-validated on the way back into the domain, and a malformed
 * row FAILS LOUDLY rather than being silently coerced — a quietly repaired
 * historical nutrition record is worse than an error.
 */

/**
 * COLUMN SCALE — the denormalized numeric columns are a rounded PROJECTION of
 * the authoritative JSONB snapshot, at the scale PostgreSQL actually stores.
 *
 * Binary floating point routinely produces values like 76.57000000000001 for
 * ordinary inputs (31 g/100 g of protein at 247 g). `numeric(10,4)` cannot hold
 * that, so PostgreSQL rounds on insert. If we wrote the raw value into the
 * column and then compared it to the raw JSONB value, every such log would be
 * rejected by the CHECK constraint — and the in-memory repository would never
 * reveal it, because JavaScript has no column scale.
 *
 * So the scale is modelled explicitly here, on both write and read. The
 * snapshot stays byte-exact and authoritative; the columns agree with it at
 * their declared scale, which is the only agreement `numeric(10,4)` can express.
 */
export const COLUMN_SCALE = { grams: 3, macro: 4 } as const;

export function toColumnScale(value: number, scale: number): number {
  if (!Number.isFinite(value)) return value;
  const f = 10 ** scale;
  const scaled = value * f;
  const rounded = scaled >= 0 ? Math.round(scaled) : -Math.round(-scaled);
  return rounded / f;
}

export interface FoodLogRow {
  user_id: string;
  log_id: string;
  product_id: string;
  product_version_id: string;
  grams: number | string;
  logged_at: string;
  event_timezone: string;
  event_utc_offset_minutes: number;
  /**
   * PostgreSQL DATE. The `pg` driver returns it as a JavaScript `Date`, while
   * fixtures and the domain use the canonical `YYYY-MM-DD` string — so the row
   * type must admit both and normalize at the boundary.
   */
  local_date: string | Date;
  meal_id: string | null;
  /** Correction lineage. Absent on legacy rows written before migration 0004. */
  entry_kind?: string | null;
  supersedes_log_id?: string | null;
  correction_reason?: string | null;
  nutrition_calc_version: string;
  weight_capture: unknown;
  nutrition_snapshot: unknown;
  kcal: number | string;
  protein_g: number | string;
  carbohydrate_g: number | string;
  fat_g: number | string;
  status: string;
}

const num = (v: number | string, path: string): number => {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) throw new Error(`row-codec: ${path} is not a finite number`);
  return n;
};

const obj = (v: unknown, path: string): Record<string, unknown> => {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) {
    throw new Error(`row-codec: ${path} is not an object`);
  }
  return v as Record<string, unknown>;
};

/** Postgres returns dates in several shapes; normalise to a strict ISO instant. */
const isoOf = (v: string | Date, path: string): string => {
  const ms = v instanceof Date ? v.getTime() : Date.parse(v);
  if (!Number.isFinite(ms)) throw new Error(`row-codec: ${path} is not a valid instant`);
  return new Date(ms).toISOString();
};

export function foodLogToRow(item: FoodLogItem): FoodLogRow {
  // Validate on the way OUT too: a contradictory item must never be written.
  unwrap(validateFoodLogItem(item));
  return {
    user_id: item.userId,
    log_id: item.logId,
    product_id: item.productId,
    product_version_id: item.productVersionId,
    grams: toColumnScale(item.grams, COLUMN_SCALE.grams),
    logged_at: item.loggedAt,
    event_timezone: item.eventTimezone,
    event_utc_offset_minutes: item.eventUtcOffsetMinutes,
    local_date: item.localDate,
    meal_id: item.mealId ?? null,
    // Correction lineage MUST round-trip. Dropping it would make a correction
    // read back as a second original and double-count the day.
    entry_kind: item.entryKind ?? 'original',
    supersedes_log_id: item.supersedesLogId ?? null,
    correction_reason: item.correctionReason ?? null,
    nutrition_calc_version: item.nutritionCalcVersion,
    weight_capture: item.weightCapture,
    nutrition_snapshot: item.nutritionSnapshot,
    kcal: toColumnScale(item.nutritionSnapshot.totals.kcal, COLUMN_SCALE.macro),
    protein_g: toColumnScale(item.nutritionSnapshot.totals.proteinG, COLUMN_SCALE.macro),
    carbohydrate_g: toColumnScale(item.nutritionSnapshot.totals.carbohydrateG, COLUMN_SCALE.macro),
    fat_g: toColumnScale(item.nutritionSnapshot.totals.fatG, COLUMN_SCALE.macro),
    status: item.status,
  };
}

/**
 * Normalize a PostgreSQL DATE into the canonical `YYYY-MM-DD` calendar string.
 *
 * A DATE has NO timezone. `toISOString().slice(0, 10)` would convert through
 * UTC first, so a `Date` built from local calendar components can land on the
 * previous or next day depending on the machine's offset — silently moving a
 * food log to the wrong day. The local components are read directly instead.
 *
 * A string passes through UNCHANGED: `validateFoodLogItem` remains the single
 * authority on whether a calendar string is well formed, and this must not
 * become a second local-date policy.
 */
export function calendarDateOf(value: string | Date, path: string): string {
  if (typeof value === 'string') return value;

  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error(`${path}: expected a calendar date, received an invalid Date`);
  }
  const year = String(value.getFullYear()).padStart(4, '0');
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function rowToFoodLog(row: FoodLogRow): FoodLogItem {
  const capture = obj(row.weight_capture, 'weight_capture') as unknown as WeightCapture;
  const snapshot = obj(row.nutrition_snapshot, 'nutrition_snapshot') as unknown as NutritionSnapshot;

  if (row.status !== 'active') {
    throw new Error(`row-codec: unsupported food log status "${row.status}"`);
  }

  const item = {
    logId: row.log_id,
    userId: row.user_id,
    productId: row.product_id,
    productVersionId: row.product_version_id,
    // Read from the AUTHORITATIVE snapshot, not the rounded projection column,
    // so a full-precision value survives the round trip unchanged.
    grams: grams(snapshot.gramsConsumed),
    weightCapture: capture,
    nutritionSnapshot: snapshot,
    loggedAt: instant(isoOf(row.logged_at, 'logged_at')),
    eventTimezone: row.event_timezone,
    eventUtcOffsetMinutes: row.event_utc_offset_minutes,
    localDate: calendarDateOf(row.local_date, 'local_date'),
    nutritionCalcVersion: row.nutrition_calc_version,
    status: 'active' as const,
    ...(row.meal_id !== null ? { mealId: row.meal_id } : {}),
    ...(row.entry_kind === 'correction' ? { entryKind: 'correction' as const } : {}),
    ...(row.supersedes_log_id !== null && row.supersedes_log_id !== undefined
      ? { supersedesLogId: row.supersedes_log_id } : {}),
    ...(row.correction_reason !== null && row.correction_reason !== undefined
      ? { correctionReason: row.correction_reason } : {}),
  } as FoodLogItem;

  // The stored columns and the stored snapshot must still agree years later.
  const validated = unwrap(validateFoodLogItem(item));

  // Compared at the column's declared scale — see COLUMN_SCALE. A mismatch here
  // means the row was tampered with or corrupted, not merely rounded.
  if (num(row.grams, 'grams') !== toColumnScale(snapshot.gramsConsumed, COLUMN_SCALE.grams)) {
    throw new Error('row-codec: grams column contradicts the stored snapshot');
  }

  for (const [column, snapshotValue, path] of [
    [num(row.kcal, 'kcal'), snapshot.totals.kcal, 'kcal'],
    [num(row.protein_g, 'protein_g'), snapshot.totals.proteinG, 'protein_g'],
    [num(row.carbohydrate_g, 'carbohydrate_g'), snapshot.totals.carbohydrateG, 'carbohydrate_g'],
    [num(row.fat_g, 'fat_g'), snapshot.totals.fatG, 'fat_g'],
  ] as const) {
    if (column !== toColumnScale(snapshotValue, COLUMN_SCALE.macro)) {
      throw new Error(`row-codec: ${path} column contradicts the stored snapshot`);
    }
  }

  return validated;
}

export interface ProductVersionRow {
  product_version_id: string;
  product_id: string;
  version_no: number;
  display_name: string;
  brand_name: string | null;
  preparation_state: string;
  basis: unknown;
  label_facts: unknown;
  source: unknown;
  effective_from: string;
}

export function productVersionToRow(v: ProductVersion): ProductVersionRow {
  unwrap(validateProductVersion(v));
  return {
    product_version_id: v.productVersionId,
    product_id: v.productId,
    version_no: v.versionNo,
    display_name: v.displayName,
    brand_name: v.brandName ?? null,
    preparation_state: v.preparationState,
    basis: v.basis,
    label_facts: v.labelFacts ?? null,
    source: v.source,
    effective_from: v.effectiveFrom,
  };
}

export function rowToProductVersion(row: ProductVersionRow): ProductVersion {
  const v = {
    productId: row.product_id,
    productVersionId: row.product_version_id,
    versionNo: row.version_no,
    displayName: row.display_name,
    preparationState: row.preparation_state,
    basis: obj(row.basis, 'basis'),
    source: obj(row.source, 'source'),
    effectiveFrom: instant(isoOf(row.effective_from, 'effective_from')),
    ...(row.brand_name !== null ? { brandName: row.brand_name } : {}),
    ...(row.label_facts !== null ? { labelFacts: obj(row.label_facts, 'label_facts') } : {}),
  } as unknown as ProductVersion;
  return unwrap(validateProductVersion(v));
}

export interface ProfileRow {
  profile_version_id: string;
  user_id: string;
  effective_from: string;
  age_years: number | string;
  sex: string;
  body_weight_kg: number | string;
  height_cm: number | string;
  body_fat_percent: number | string | null;
  body_fat_source: string | null;
}

export function profileToRow(p: UserProfileSnapshot): ProfileRow {
  unwrap(validateUserProfile(p));
  return {
    profile_version_id: p.profileVersionId,
    user_id: p.userId,
    effective_from: p.effectiveFrom,
    age_years: p.ageYears,
    sex: p.sex,
    body_weight_kg: p.bodyWeightKg,
    height_cm: p.heightCm,
    body_fat_percent: p.bodyFatPercent ?? null,
    body_fat_source: p.bodyFatMeasurementSource ?? null,
  };
}

export function rowToProfile(row: ProfileRow): UserProfileSnapshot {
  if (row.sex !== 'male' && row.sex !== 'female') {
    throw new Error(`row-codec: unsupported sex "${row.sex}"`);
  }
  const p: UserProfileSnapshot = {
    userId: row.user_id,
    profileVersionId: row.profile_version_id,
    effectiveFrom: instant(isoOf(row.effective_from, 'effective_from')),
    ageYears: years(num(row.age_years, 'age_years')),
    sex: row.sex,
    bodyWeightKg: kilograms(num(row.body_weight_kg, 'body_weight_kg')),
    heightCm: centimetres(num(row.height_cm, 'height_cm')),
    ...(row.body_fat_percent !== null
      ? { bodyFatPercent: num(row.body_fat_percent, 'body_fat_percent') }
      : {}),
    ...(row.body_fat_source !== null
      ? {
          bodyFatMeasurementSource: row.body_fat_source as NonNullable<
            UserProfileSnapshot['bodyFatMeasurementSource']
          >,
        }
      : {}),
  };
  return unwrap(validateUserProfile(p));
}

export interface GoalRow {
  goal_version_id: string;
  user_id: string;
  effective_from: string;
  goal: string;
  target_delta_kcal: number | string;
}

export function goalToRow(g: EnergyGoalVersion): GoalRow {
  return {
    goal_version_id: g.goalVersionId,
    user_id: g.userId,
    effective_from: g.effectiveFrom,
    goal: g.goal,
    target_delta_kcal: g.targetDeltaKcal,
  };
}

export function rowToGoal(row: GoalRow): EnergyGoalVersion {
  if (row.goal !== 'lose' && row.goal !== 'maintain' && row.goal !== 'gain') {
    throw new Error(`row-codec: unsupported goal "${row.goal}"`);
  }
  if (row.user_id.length === 0 || row.goal_version_id.length === 0) {
    throw new Error('row-codec: goal row is missing identity');
  }
  return {
    goalVersionId: row.goal_version_id,
    userId: row.user_id,
    effectiveFrom: instant(isoOf(row.effective_from, 'effective_from')),
    goal: row.goal,
    targetDeltaKcal: num(row.target_delta_kcal, 'target_delta_kcal'),
  };
}

export interface CatalogHeadRow {
  product_id: string;
  current_product_version_id: string;
  is_active: boolean;
  updated_at: string;
}

export function rowToCatalogHead(row: CatalogHeadRow): ProductCatalogHead {
  if (row.product_id.length === 0 || row.current_product_version_id.length === 0) {
    throw new Error('row-codec: catalog head row is missing identity');
  }
  return {
    productId: row.product_id,
    currentProductVersionId: row.current_product_version_id,
    isActive: row.is_active,
    updatedAt: instant(isoOf(row.updated_at, 'updated_at')),
  };
}
