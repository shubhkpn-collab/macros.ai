import type {
  ActiveEnergyEstimate,
  ActiveEnergyResolution,
  ActiveEnergyUnavailableReason,
  ActivityCompleteness,
  ActivityCompletenessGap,
  ActivityQuality,
  ActivityQualityReason,
  ActivitySourceKind,
} from './activity.js';
import type { Instant, Kcal } from './primitives.js';
import type { ReviewStatus } from './policies.js';
import type { UserProfileSnapshot } from './profile.js';

export type Goal = 'lose' | 'maintain' | 'gain';

/**
 * An effective-dated goal. Changing a goal appends a new version; history is
 * never rewritten, so a past day still computes against the goal in force then.
 */
export interface EnergyGoalVersion {
  readonly goalVersionId: string;
  readonly userId: string;
  readonly effectiveFrom: Instant;
  readonly goal: Goal;
  readonly targetDeltaKcal: number;
}

/**
 * THE CANONICAL ENERGY MODEL.
 *
 * PAL IS NOT PART OF THIS ARCHITECTURE. There is no palFactor, no
 * activityLevel and no tdeeBaselineKcal, because expenditure is composed as
 * BMR + ACTIVE + TEF in every case. The equation is constant; only the
 * provenance of the ACTIVE component varies.
 *
 * The profile snapshot is BOUND INTO the model, so the profile that produced
 * BMR is by construction the same profile the TEF model sees. Divergence is
 * not possible.
 */
export interface EnergyModelSnapshot {
  readonly effectiveFrom: Instant;
  readonly profile: UserProfileSnapshot;
  readonly bmrKcal: Kcal;
  readonly bmrMethod: string;
  readonly bmrPolicyVersion: string;
  readonly targetDeltaKcal: number;
  readonly goal: Goal;
}

/**
 * ONE PROFILE. Physiological facts are read from model.profile and are never
 * duplicated onto the model, so a hand-constructed object cannot carry a
 * body weight that disagrees with its own profile snapshot.
 */

/**
 * Describes the ACTIVE ENERGY source, not a different formula.
 * 'no_activity_source' means no estimate was supplied at all — the active
 * component is genuinely absent, which the completeness gaps also record.
 */
export type EnergyQuality =
  | 'observed_activity'
  | 'partially_estimated_activity'
  | 'estimated_activity'
  | 'no_activity_source';

export type TefStatus = 'computed' | 'policy_unavailable';
export type TefConfidence = 'basic' | 'profile_adjusted' | 'personalized';

/** What is missing from a complete BMR + ACTIVE + TEF composition. */
export type EnergyCompletenessGap =
  | 'tef_policy_missing'
  | 'activity_estimate_missing'
  | 'activity_coverage_incomplete';

export interface TefInputsUsed {
  readonly macros: boolean;
  readonly age: boolean;
  readonly sex: boolean;
  readonly bodyWeight: boolean;
  readonly bodyFat: boolean;
  readonly fatFreeMass: boolean;
  readonly personalCalibration: boolean;
}

/** Never described as exact — always "estimated TEF". */
export interface TefResult {
  readonly estimatedTefKcal: Kcal;
  readonly baseMacroTefKcal: Kcal;
  readonly individualAdjustmentKcal: Kcal;
  readonly confidence: TefConfidence;
  readonly policyVersion: string;
  readonly reviewStatus: ReviewStatus;
  readonly inputsUsed: TefInputsUsed;
}

/**
 * THE CANONICAL EXPENDITURE DECOMPOSITION
 *
 *   expenditure_so_far = basal_so_far + active_so_far + tef_accrued
 *   projected_total    = BMR + active_so_far + projected_remaining_active + projected_tef
 *
 * THE FIVE LOCKED QUANTITIES
 *   1 currentBalanceKcal            = intake so far - expenditure so far   PRIMARY
 *   2 targetDeltaKcal               = chosen end-of-day surplus/deficit
 *   3 projectedTotalExpenditureKcal = deterministic forecast of today's total
 *   4 remainingIntakeKcal           = projected + target - intake          ACTIONABLE
 *   5 ifNoMoreFoodBalanceKcal       = intake - projected                   SECONDARY ONLY
 */
export interface EnergyState {
  readonly intakeSoFarKcal: Kcal;

  readonly basalSoFarKcal: Kcal;
  readonly activeSoFarKcal: Kcal;
  readonly tefAccruedKcal: Kcal;
  readonly expenditureSoFarKcal: Kcal;

  readonly projectedBasalKcal: Kcal;
  readonly projectedActiveKcal: Kcal;
  readonly projectedRemainingActiveKcal: Kcal;
  readonly projectedTefKcal: Kcal;
  readonly projectedTotalExpenditureKcal: Kcal;

  readonly currentBalanceKcal: Kcal;
  readonly targetDeltaKcal: number;
  readonly remainingIntakeKcal: Kcal;
  readonly ifNoMoreFoodBalanceKcal: Kcal;

  readonly tefStatus: TefStatus;
  readonly tefEstimatedTotalKcal: Kcal | null;
  readonly tefBaseMacroKcal: Kcal | null;
  readonly tefIndividualAdjustmentKcal: Kcal | null;
  readonly tefConfidence: TefConfidence | null;

  readonly activitySource: ActivitySourceKind | null;
  readonly activityQuality: ActivityQuality | null;
  readonly activityQualityReasons: readonly ActivityQualityReason[];
  readonly activityCompleteness: ActivityCompleteness | null;
  readonly activityCompletenessGaps: readonly ActivityCompletenessGap[];
  readonly activityUnresolvedMinutes: number | null;
  readonly activityUnavailableReason: ActiveEnergyUnavailableReason | null;
  readonly activityCoverageRatio: number | null;
  readonly activityConfidence: number | null;
  readonly activityProviderId: string | null;

  readonly energyQuality: EnergyQuality;
  readonly energyCompleteness: 'complete' | 'incomplete';
  readonly completenessGaps: readonly EnergyCompletenessGap[];

  readonly elapsedDayFraction: number;

  readonly calcVersion: string;
  readonly bmrPolicyVersion: string;
  readonly tefPolicyVersion: string | null;
  readonly tefPolicyReviewStatus: ReviewStatus | null;
  readonly tefProjectionPolicyVersion: string;
  readonly tefAccrualPolicyVersion: string;
  readonly activityProjectionPolicyVersion: string | null;
  readonly activityGapFillPolicyVersion: string | null;
}

/**
 * The MACROS.AI nutrition day is the user's LOCAL CALENDAR DAY, with midnight
 * as the boundary. There is no hidden 04:00 rollover.
 *
 * `rolloverHour` remains in the contract only for a possible future explicit
 * product setting; it defaults to 0 and is never silently assigned.
 * Production calculations should always be given the user's IANA timezone
 * rather than relying on the UTC default.
 */
export interface DayBoundary {
  readonly timezone: string;
  readonly rolloverHour: number;
}

export const DEFAULT_DAY_BOUNDARY: DayBoundary = { timezone: 'UTC', rolloverHour: 0 };

export type { ActiveEnergyEstimate, ActiveEnergyResolution };
