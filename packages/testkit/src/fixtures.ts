import {
  type ActiveEnergyEstimate,
  type ActiveEnergyResolution,
  centimetres,
  grams,
  instant,
  kcal,
  kilograms,
  years,
  type IntakeTotals,
  type NutrientBasis,
  type UserProfileSnapshot,
} from '@macros/contracts';

/**
 * Synthetic users are UUID-shaped ON PURPOSE.
 *
 * Production stores `user_id uuid` and RLS compares it to `auth.uid()`. A
 * fixture like 'user-a' cannot be inserted into a uuid column, so opaque
 * string ids would let the application develop assumptions the real
 * PostgreSQL/RLS boundary would reject.
 */
export const USER_A = '00000000-0000-4000-8000-00000000000a';
export const USER_B = '00000000-0000-4000-8000-00000000000b';

export const PROFILE_MALE_35: UserProfileSnapshot = {
  userId: USER_A,
  profileVersionId: 'prof-a-v1',
  effectiveFrom: instant('2026-01-01T00:00:00.000Z'),
  ageYears: years(35),
  sex: 'male',
  bodyWeightKg: kilograms(80),
  heightCm: centimetres(180),
};

export const PROFILE_FEMALE_29: UserProfileSnapshot = {
  userId: USER_B,
  profileVersionId: 'prof-b-v1',
  effectiveFrom: instant('2026-01-01T00:00:00.000Z'),
  ageYears: years(29),
  sex: 'female',
  bodyWeightKg: kilograms(62),
  heightCm: centimetres(166),
};

export const PROFILE_MALE_35_WITH_BODYFAT: UserProfileSnapshot = {
  ...PROFILE_MALE_35,
  bodyFatPercent: 18,
  bodyFatMeasurementSource: 'dexa',
};

export const TOFU_FIRM: NutrientBasis = {
  kind: 'per_100g',
  kcal: 144,
  proteinG: 15.6,
  carbohydrateG: 3.9,
  fatG: 8.7,
  fiberG: 2.3,
  sodiumMg: 14,
};

export const CHICKEN_BREAST_RAW: NutrientBasis = {
  kind: 'per_100g',
  kcal: 120,
  proteinG: 22.5,
  carbohydrateG: 0,
  fatG: 2.6,
};

export const CHICKEN_BREAST_COOKED: NutrientBasis = {
  kind: 'per_100g',
  kcal: 165,
  proteinG: 31,
  carbohydrateG: 0,
  fatG: 3.6,
};

/**
 * Declared per 100 ml. 100 ml of olive oil weighs 91.6 g, so these values
 * normalise back to the familiar 884 kcal / 100 g mass basis.
 */
export const OLIVE_OIL: NutrientBasis = {
  kind: 'per_100ml',
  densityGPerMl: 0.916,
  kcal: 809.744,
  proteinG: 0,
  carbohydrateG: 0,
  fatG: 91.6,
};

export const emptyIntake = (): IntakeTotals => ({
  kcal: kcal(0),
  proteinG: grams(0),
  carbohydrateG: grams(0),
  fatG: grams(0),
  itemCount: 0,
});

export const intakeOf = (
  k: number,
  protein: number,
  carb: number,
  fat: number,
  itemCount = 1,
): IntakeTotals => ({
  kcal: kcal(k),
  proteinG: grams(protein),
  carbohydrateG: grams(carb),
  fatG: grams(fat),
  itemCount,
});

export const DAY_START_UTC = instant('2026-08-11T00:00:00.000Z');
export const MIDDAY_UTC = instant('2026-08-11T12:00:00.000Z');
/** Local calendar day, midnight boundary — the product default. */
export const DAY_UTC = { timezone: 'UTC', rolloverHour: 0 } as const;

/**
 * A plain ACTIVE ENERGY input. Built directly rather than through a provider so
 * engine tests exercise the composition, not the adapter.
 */
export const activeEnergyEstimate = (
  soFar: number,
  projectedRemaining = 0,
  overrides: Partial<ActiveEnergyEstimate> = {},
): ActiveEnergyEstimate => ({
  activeKcalSoFar: kcal(soFar),
  projectedRemainingActiveKcal: kcal(projectedRemaining),
  source: 'simulated',
  quality: 'observed',
  qualityReasons: [],
  completeness: 'complete',
  completenessGaps: [],
  unresolvedIntervals: [],
  unresolvedMinutes: 0,
  confidence: 0.9,
  providerId: 'simulated',
  projectionPolicyVersion: 'activity-projection@1.0.0-none',
  gapFillPolicyVersion: 'activity-gap-fill@1.0.0-none',
  ...overrides,
});

/** The engine takes a resolution, not a bare estimate. */
export const activeEnergy = (
  soFar: number,
  projectedRemaining = 0,
  overrides: Partial<ActiveEnergyEstimate> = {},
): ActiveEnergyResolution => ({
  status: 'available',
  estimate: activeEnergyEstimate(soFar, projectedRemaining, overrides),
});

export const ACTIVITY_MISSING: ActiveEnergyResolution = {
  status: 'unavailable',
  reason: 'no_provider',
};
