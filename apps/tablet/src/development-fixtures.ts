import {
  centimetres, instant, kcal, kilograms, years,
  type ActiveEnergyResolution, type EnergyGoalVersion, type ProductCatalogHead,
  type ProductVersion, type TefPolicy, type UserProfileSnapshot,
} from '@macros/contracts';
// WeightStabilityPolicy belongs to the scale protocol, not to contracts —
// stability is a property of the weighing device, not of nutrition data.
import type { WeightStabilityPolicy } from '@macros/scale-protocol';

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

/**
 * A goal is REQUIRED for a dashboard to exist.
 *
 * Without one `refreshDashboard()` cannot resolve an effective goal, writes a
 * `goal_missing` error and Home renders with no energy hero and no macros —
 * which is exactly what the first real Android launch showed. 'maintain' with a
 * zero delta is the most neutral development choice: it demonstrates the
 * north-star Home without asserting any target for a real person.
 */
export const DEV_GOAL: EnergyGoalVersion = {
  goalVersionId: 'dev-goal-v1',
  userId: DEV_USER_ID,
  effectiveFrom: EFFECTIVE_FROM,
  goal: 'maintain',
  targetDeltaKcal: 0,
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

/** Heads for the searchable products. Cooked chicken is the head; raw is a
 *  sibling version, which is what makes the preparation disambiguation real. */
export const DEV_CATALOG_HEADS: readonly ProductCatalogHead[] = [
  {
    productId: 'dev-chicken-breast',
    currentProductVersionId: 'dev-chicken-breast@cooked-v1',
    isActive: true,
    updatedAt: EFFECTIVE_FROM,
  },
  {
    productId: 'dev-rolled-oats',
    currentProductVersionId: 'dev-rolled-oats@dry-v1',
    isActive: true,
    updatedAt: EFFECTIVE_FROM,
  },
];

/** SYNTHETIC — proves the mathematics, not physiologically approved. */
export const DEV_TEF_POLICY: TefPolicy = {
  version: 'tef@0.0.0-SYNTHETIC-TEST',
  provenance: 'SYNTHETIC_TEST',
  reviewStatus: 'PENDING_EXTERNAL_REVIEW',
  macroCoefficients: { protein: 0.25, carbohydrate: 0.075, fat: 0.02, alcohol: 0.15 },
  // Neutral: every individual adjustment is 'none', so the synthetic policy
  // exercises the mathematics without asserting any physiological claim.
  individualAdjustmentModel: {
    age: { kind: 'none' }, sex: { kind: 'none' },
    fatFreeMass: { kind: 'none' }, bodyFatPercent: { kind: 'none' },
  },
  composition: 'additive_kcal',
  adjustmentBoundFraction: 0.25,
  personalCalibrationEnabled: false,
};

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
};

/**
 * The controller consumes an ActiveEnergyResolution, not a bare estimate — the
 * distinction matters because "we have no activity data" is a real state the
 * energy engine must be able to represent rather than fake with a zero.
 */
export const devActiveEnergy = (soFar: number): ActiveEnergyResolution => ({
  status: 'available',
  estimate: {
    activeKcalSoFar: kcal(soFar),
    projectedRemainingActiveKcal: kcal(0),
    source: 'simulated',
    quality: 'observed',
    qualityReasons: [],
    completeness: 'complete',
    completenessGaps: [],
    unresolvedIntervals: [],
    unresolvedMinutes: 0,
    confidence: 1,
    providerId: 'development-host',
    projectionPolicyVersion: 'activity-projection@0.0.0-SYNTHETIC-DEVELOPMENT',
    gapFillPolicyVersion: 'activity-gap-fill@0.0.0-SYNTHETIC-DEVELOPMENT',
  },
});
