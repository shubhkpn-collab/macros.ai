import {
  centimetres, instant, kcal, kilograms, years,
  type ActiveEnergyEstimate, type ProductVersion, type TefPolicy,
  type UserProfileSnapshot, type WeightStabilityPolicy,
} from '@macros/contracts';

/**
 * DEVELOPMENT-ONLY FIXTURES — RN-SAFE.
 *
 * These values are duplicated from `@macros/testkit` on purpose. That package
 * re-exports `golden.ts`, which imports `node:fs`, `node:url` and `node:path` —
 * Metro cannot bundle Node built-ins, so importing testkit anywhere in the app
 * graph breaks the bundle at runtime. Polyfilling `node:fs` into a kitchen
 * appliance to obtain three constants would be the wrong trade entirely.
 *
 * Only VALUES are duplicated. No nutrition, energy or stability ALGORITHM is
 * copied: those stay in the domain packages, which the host imports normally.
 *
 * `provenance: 'SYNTHETIC_TEST'` is load-bearing — production code paths reject
 * these policies by discriminant, so this data cannot silently become real.
 */
export const DEVELOPMENT_FIXTURES_VERSION = 'tablet-dev-fixtures@1.0.0';

export const DEV_USER_ID = '11111111-1111-4111-8111-111111111111';

const EFFECTIVE_FROM = instant('2026-01-01T00:00:00.000Z');

const syntheticSource = (sourceId: string) => ({
  kind: 'synthetic_test' as const,
  sourceId,
  verificationStatus: 'synthetic_test' as const,
});

export const DEV_PROFILE: UserProfileSnapshot = {
  userId: DEV_USER_ID,
  profileVersionId: 'dev-profile-v1',
  effectiveFrom: EFFECTIVE_FROM,
  ageYears: years(35),
  sex: 'male',
  bodyWeightKg: kilograms(80),
  heightCm: centimetres(180),
};

/** A handful of foods so the search and option screens have something real. */
export const DEV_PRODUCTS: readonly ProductVersion[] = [
  {
    productId: 'dev-chicken-breast',
    productVersionId: 'dev-chicken-breast@cooked-v1',
    versionNo: 1,
    displayName: 'Chicken breast, cooked',
    preparationState: 'cooked',
    basis: { kind: 'per_100g', kcal: 165, proteinG: 31, carbohydrateG: 0, fatG: 3.6 },
    source: syntheticSource('synthetic:chicken-cooked'),
    effectiveFrom: EFFECTIVE_FROM,
  },
  {
    productId: 'dev-chicken-breast',
    productVersionId: 'dev-chicken-breast@raw-v1',
    versionNo: 1,
    displayName: 'Chicken breast, raw',
    preparationState: 'raw',
    basis: { kind: 'per_100g', kcal: 120, proteinG: 22.5, carbohydrateG: 0, fatG: 2.6 },
    source: syntheticSource('synthetic:chicken-raw'),
    effectiveFrom: EFFECTIVE_FROM,
  },
  {
    productId: 'dev-rolled-oats',
    productVersionId: 'dev-rolled-oats@dry-v1',
    versionNo: 1,
    displayName: 'Rolled oats, dry',
    preparationState: 'as_sold',
    basis: { kind: 'per_100g', kcal: 379, proteinG: 13.2, carbohydrateG: 67.7, fatG: 6.5 },
    source: syntheticSource('synthetic:oats'),
    effectiveFrom: EFFECTIVE_FROM,
  },
] as readonly ProductVersion[];

export const DEV_CATALOG_HEADS: Readonly<Record<string, string>> = {
  'dev-chicken-breast': 'dev-chicken-breast@cooked-v1',
  'dev-rolled-oats': 'dev-rolled-oats@dry-v1',
};

/** SYNTHETIC — proves the mathematics, not physiologically approved. */
export const DEV_TEF_POLICY: TefPolicy = {
  version: 'tef@0.0.0-SYNTHETIC-TEST',
  provenance: 'SYNTHETIC_TEST',
  reviewStatus: 'PENDING_EXTERNAL_REVIEW',
  macroCoefficients: { protein: 0.25, carbohydrate: 0.075, fat: 0.02, alcohol: 0.15 },
  individualAdjustments: {
    age: { kind: 'none' }, sex: { kind: 'none' },
    fatFreeMass: { kind: 'none' }, bodyFatPercent: { kind: 'none' },
  },
  composition: 'additive_kcal',
  adjustmentBoundFraction: 0.25,
  personalCalibrationEnabled: false,
} as TefPolicy;

/** SYNTHETIC — pending real hardware validation. */
export const DEV_STABILITY_POLICY: WeightStabilityPolicy = {
  version: 'weight-stability@0.0.0-SYNTHETIC-PENDING-HARDWARE',
  provenance: 'SYNTHETIC_TEST',
  validationStatus: 'PENDING_HARDWARE_VALIDATION',
  minCaptureGrams: 2,
  clearBandGrams: 2,
  observationWindowMs: 1500,
  minSampleCount: 3,
  minStableDurationMs: 600,
  maxSpreadGrams: 2,
  materialChangeGrams: 5,
  maxSampleAgeMs: 3000,
  representativeMethod: 'median',
  resolutionQuantization: 'nearest_resolution',
  maxStableCandidateAgeMs: 5000,
} as WeightStabilityPolicy;

export const devActiveEnergy = (soFar: number): ActiveEnergyEstimate => ({
  activeKcalSoFar: kcal(soFar),
  projectedRemainingActiveKcal: kcal(0),
} as ActiveEnergyEstimate);
