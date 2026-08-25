import type { ActivityPlausibilityPolicy, TefPolicy } from '@macros/contracts';
import type { WeightStabilityPolicy } from '@macros/scale-protocol';

/**
 * SYNTHETIC sanity ranges. These are testkit-only expectations used to prove
 * the arithmetic behaves sensibly under TEST_TEF_POLICY. They are NOT
 * physiological validation ranges and are deliberately absent from the
 * production engine — real ranges belong in a reviewed, versioned policy.
 */
export const SYNTHETIC_TEF_SANITY = {
  expectedDayFraction: { min: 0.05, max: 0.15 },
  maxFractionOfKcal: 0.35,
} as const;

export function withinSyntheticTefSanity(estimatedTefKcal: number, loggedKcal: number): boolean {
  if (loggedKcal <= 0) return estimatedTefKcal === 0;
  return estimatedTefKcal <= SYNTHETIC_TEF_SANITY.maxFractionOfKcal * loggedKcal;
}

/** SYNTHETIC plausibility bounds — artificial, for exercising the filter only. */
export const TEST_PLAUSIBILITY_POLICY: ActivityPlausibilityPolicy = {
  version: 'activity-plausibility@0.0.0-SYNTHETIC-TEST',
  provenance: 'SYNTHETIC_TEST',
  reviewStatus: 'PENDING_EXTERNAL_REVIEW',
  maxDailyActiveKcalPerKgBodyWeight: 25,
  minSampleConfidence: 0.5,
  maxStalenessMinutes: 90,
};

/**
 * SYNTHETIC TEST POLICY — NOT MEDICALLY OR PHYSIOLOGICALLY APPROVED.
 *
 * These coefficients exist ONLY to prove the mathematics, policy versioning,
 * bounds and neutrality behaviour. They are round numbers chosen to be
 * obviously artificial. `provenance: 'SYNTHETIC_TEST'` means production code
 * paths reject this policy by discriminant.
 *
 * This package is a devDependency and no production package may import it.
 */
export const TEST_TEF_POLICY: TefPolicy = {
  version: 'tef@0.0.0-SYNTHETIC-TEST',
  provenance: 'SYNTHETIC_TEST',
  reviewStatus: 'PENDING_EXTERNAL_REVIEW',
  macroCoefficients: {
    protein: 0.25,
    carbohydrate: 0.075,
    fat: 0.02,
    alcohol: 0.15,
  },
  individualAdjustmentModel: {
    // Unreviewed policy: every rule must be neutral.
    age: { kind: 'none' },
    sex: { kind: 'none' },
    fatFreeMass: { kind: 'none' },
    bodyFatPercent: { kind: 'none' },
  },
  composition: 'additive_kcal',
  adjustmentBoundFraction: 0.25,
  personalCalibrationEnabled: false,
};

/**
 * SYNTHETIC TEST POLICY with an APPROVED review status and active adjustment
 * rules. Proves the adjustment machinery works once a reviewer signs off.
 * Coefficients remain artificial and are never shippable.
 */
export const TEST_TEF_POLICY_APPROVED_RULES: TefPolicy = {
  ...TEST_TEF_POLICY,
  version: 'tef@0.0.0-SYNTHETIC-TEST-APPROVED-RULES',
  reviewStatus: 'APPROVED',
  individualAdjustmentModel: {
    age: { kind: 'linear', input: 'age', slope: -0.1, intercept: 3, bounds: [-10, 10] },
    fatFreeMass: {
      kind: 'piecewise',
      input: 'fatFreeMass',
      breakpoints: [
        { upTo: 50, kcal: 0 },
        { upTo: 70, kcal: 2 },
        { upTo: 1000, kcal: 4 },
      ],
    },
    sex: { kind: 'none' },
    bodyFatPercent: { kind: 'none' },
  },
};

/**
 * SYNTHETIC WEIGHT STABILITY POLICY — NOT SUPPLIER VALIDATED.
 *
 * These thresholds exist only to exercise the weight-capture state machine
 * deterministically. They are NOT characterized against real load-cell
 * settling, mechanical damping or temperature drift, and must never ship as
 * production tuning. Real values come from supplier characterization in the
 * hardware milestone.
 */
export const SYNTHETIC_STABILITY_POLICY: WeightStabilityPolicy = {
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
