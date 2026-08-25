import type { Instant, Kcal } from './primitives.js';
import type { PolicyProvenance, ReviewStatus } from './policies.js';

/**
 * Normalized activity. The canonical field is activeKcal: combined non-basal
 * physical activity, approximately EAT + NEAT.
 *
 * ADAPTER RESPONSIBILITY, never the engine's:
 *  - if a platform reports TOTAL expenditure, the adapter subtracts that
 *    platform's own resting estimate and returns active energy only;
 *  - the value must exclude basal energy and must not embed a TEF estimate.
 *
 * Adapters supply ACTIVE ENERGY only. They are never responsible for total
 * daily expenditure — the Energy Engine owns composition.
 */
export interface NormalizedActivitySample {
  readonly start: Instant;
  readonly end: Instant;
  readonly activeKcal: Kcal;

  /** Optional metadata. The canonical engine must never depend on this split. */
  readonly exerciseKcal?: Kcal;
  readonly nonExerciseKcal?: Kcal;

  readonly providerId: string;
  readonly sourceDevice?: string;
  readonly confidence: number;
  readonly isEstimated: boolean;
  readonly appearsWorn?: boolean;
  readonly rawRef?: string;
}

export interface TimeWindow {
  readonly start: Instant;
  readonly end: Instant;
}

export interface ActivityCoverage {
  readonly windowStart: Instant;
  readonly windowEnd: Instant;
  readonly lastSampleAt: Instant | null;
  readonly coveredMinutes: number;
  readonly gaps: readonly TimeWindow[];
  readonly coverageRatio: number;
}

/** Where the active-energy component came from. Never a formula, always a source. */
export type ActivitySourceKind =
  | 'simulated'
  | 'wearable'
  | 'historical_estimate'
  | 'onboarding_estimate';

/**
 * PROVENANCE, not accuracy.
 *
 * 'observed' means the activity component came from a provider OBSERVATION
 * rather than a modelled estimate. It makes no claim that a wearable's calorie
 * figure is physiologically exact — it is not.
 *
 * Quality answers "where did the number come from". It does NOT answer "is
 * every elapsed interval accounted for" — that is ActivityCompleteness.
 */
export type ActivityQuality = 'observed' | 'partially_estimated' | 'estimated';

/** Whether every elapsed interval has a usable activity value. */
export type ActivityCompleteness = 'complete' | 'incomplete';

export type ActivityCompletenessGap =
  | 'coverage_gap_unfilled'
  | 'rejected_sample_interval_unfilled'
  | 'stale_tail_unfilled'
  | 'no_usable_activity_samples';

export type ActivityQualityReason =
  | 'coverage_gap'
  | 'not_worn_samples_excluded'
  | 'low_confidence_samples_excluded'
  | 'implausible_samples_excluded'
  | 'stale_data'
  | 'provider_estimated_samples';

/**
 * THE ONLY ACTIVITY INPUT THE ENERGY ENGINE CONSUMES.
 *
 * The engine takes active energy and its provenance. It does not know what a
 * PAL multiplier is, and it never asks how the number was produced beyond the
 * provenance recorded here.
 */
export interface ActiveEnergyEstimate {
  readonly activeKcalSoFar: Kcal;
  readonly projectedRemainingActiveKcal: Kcal;
  readonly source: ActivitySourceKind;

  /** Where the number came from. */
  readonly quality: ActivityQuality;
  readonly qualityReasons: readonly ActivityQualityReason[];

  /** Whether every elapsed interval is accounted for. Distinct from quality. */
  readonly completeness: ActivityCompleteness;
  readonly completenessGaps: readonly ActivityCompletenessGap[];
  readonly unresolvedIntervals: readonly TimeWindow[];
  readonly unresolvedMinutes: number;

  readonly confidence?: number;
  readonly coverage?: ActivityCoverage;
  readonly providerId?: string;
  readonly projectionPolicyVersion: string;
  readonly gapFillPolicyVersion: string;
}

/**
 * MISSING IS NOT ZERO.
 *
 * If no usable activity value exists, the resolution is 'unavailable' — never
 * an estimate of zero kcal. A genuine zero is valid only when a provider
 * explicitly supplies a valid zero-activity sample. This mirrors the TEF
 * policy-availability rule exactly.
 */
export type ActiveEnergyResolution =
  | { readonly status: 'available'; readonly estimate: ActiveEnergyEstimate }
  | { readonly status: 'unavailable'; readonly reason: ActiveEnergyUnavailableReason };

export type ActiveEnergyUnavailableReason =
  | 'no_provider'
  | 'no_usable_samples'
  | 'all_samples_rejected';

export interface NormalizedActivityWindow {
  readonly samples: readonly NormalizedActivitySample[];
  readonly coverage: ActivityCoverage;
}

/** Historical activity summary. Uses only the user's own past data. */
export interface ActivityHistorySummary {
  readonly medianRemainingActiveKcalByHour: Readonly<Record<number, number>>;
}

/**
 * Providers supply ACTIVE ENERGY only. Composition into total expenditure is
 * the Energy Engine's job.
 */
export interface EnergyActivityProvider {
  readonly id: string;
  readonly sourceKind: ActivitySourceKind;
  getActivity(userId: string, window: TimeWindow): Promise<NormalizedActivityWindow>;
}

/**
 * Fills unresolved intervals with an estimate for ONLY the missing interval.
 *
 * v1 is 'none': the gap stays UNFILLED and the activity estimate is marked
 * incomplete. We never discard a wearable day and substitute a whole-day
 * population estimate — that was the old PAL fallback, and it is exactly what
 * this architecture exists to prevent.
 */
export interface ActivityGapFillPolicy {
  readonly version: string;
  readonly provenance: PolicyProvenance;
  readonly reviewStatus: ReviewStatus;
  readonly kind: 'none' | 'constant_rate_per_minute' | 'deterministic_interval_estimate';
  /** Required for 'constant_rate_per_minute'. Physiological, therefore review-gated. */
  readonly kcalPerMinute?: number;
}

/**
 * Zero kcal and "no estimate available" are different facts, so the result is
 * discriminated rather than numeric.
 */
export type ActivityGapFillResult =
  | { readonly status: 'unfilled' }
  | { readonly status: 'filled'; readonly estimatedKcal: number };

/**
 * Bounds for rejecting implausible activity. Physiological, therefore versioned
 * and review-gated. No approved production instance ships: without one, no
 * plausibility filtering is applied and that fact is visible in the result.
 */
export interface ActivityPlausibilityPolicy {
  readonly version: string;
  readonly provenance: PolicyProvenance;
  readonly reviewStatus: ReviewStatus;
  readonly maxDailyActiveKcalPerKgBodyWeight: number;
  readonly minSampleConfidence: number;
  readonly maxStalenessMinutes: number;
}
