import {
  DEFAULT_DAY_BOUNDARY,
  deriveTefProfile,
  kcal,
  type ActiveEnergyEstimate,
  type ActiveEnergyResolution,
  type ActivityProjectionPolicy,
  type DayBoundary,
  type EnergyCompletenessGap,
  type EnergyModelSnapshot,
  type EnergyQuality,
  type EnergyState,
  type Goal,
  type Instant,
  type IntakeTotals,
  type TefAccrualPolicy,
  type TefPolicyHandle,
  type TefProjectionPolicy,
  type TefResult,
  type UserProfileSnapshot,
} from '@macros/contracts';
import { calculateBmr, DEFAULT_BMR_POLICY } from './bmr.js';
import { elapsedDayFraction } from './day-boundary.js';
import { TEF_PROJECTION_V1, projectTefKcal } from './projection.js';
import { TEF_ACCRUAL_V1, accruedTefKcal } from './accrual.js';
import { calculateTef } from './tef.js';

export const ENERGY_CALC_VERSION = 'energy@2.0.0-component';

export interface EnergyStateInput {
  /** Carries its own profile snapshot — BMR and TEF cannot see different profiles. */
  readonly model: EnergyModelSnapshot;
  readonly intake: IntakeTotals;
  readonly tefPolicy: TefPolicyHandle;
  /**
   * A resolution, not a bare estimate. 'unavailable' means we have no usable
   * activity value — which is NOT the same fact as an activity value of zero.
   */
  readonly activity: ActiveEnergyResolution;
  readonly tefProjectionPolicy?: TefProjectionPolicy;
  readonly tefAccrualPolicy?: TefAccrualPolicy;
  readonly asOf: Instant;
  readonly day?: DayBoundary;
}

/**
 * Build an effective-dated energy model. The profile is bound in, so every
 * downstream calculation reads the same snapshot.
 *
 * There is no activityLevel parameter: an onboarding activity questionnaire, if
 * one ever exists, feeds an EstimatedActivityProvider. It never multiplies BMR.
 */
export function buildEnergyModel(
  profile: UserProfileSnapshot,
  opts: { targetDeltaKcal: number; goal: Goal },
  bmrPolicy = DEFAULT_BMR_POLICY,
): EnergyModelSnapshot {
  const bmr = calculateBmr(profile, bmrPolicy);
  return {
    effectiveFrom: profile.effectiveFrom,
    profile,
    bmrKcal: bmr.bmrKcal,
    bmrMethod: bmr.method,
    bmrPolicyVersion: bmr.policyVersion,
    targetDeltaKcal: opts.targetDeltaKcal,
    goal: opts.goal,
  };
}

function computeTef(input: EnergyStateInput): TefResult | null {
  if (input.tefPolicy.status === 'unavailable') return null;
  // The TEF profile is derived from the model's own bound profile snapshot.
  const tefProfile = deriveTefProfile(input.model.profile);
  return calculateTef(input.intake, tefProfile, input.tefPolicy.policy);
}

const qualityOf = (activity: ActiveEnergyEstimate | null): EnergyQuality => {
  if (activity === null) return 'no_activity_source';
  switch (activity.quality) {
    case 'observed':
      return 'observed_activity';
    case 'partially_estimated':
      return 'partially_estimated_activity';
    case 'estimated':
      return 'estimated_activity';
  }
};

/**
 * THE ENERGY ENGINE.
 *
 * PURE: no clock, no IO, no network, no randomness. Time is an argument.
 *
 * ONE EQUATION, ALWAYS:
 *     TOTAL ENERGY EXPENDITURE = BMR + ACTIVE ENERGY + TEF
 *
 * PAL does not appear in this file, this package, or this architecture. What
 * changes between users and days is the SOURCE and QUALITY of the ACTIVE
 * component, never the equation.
 *
 *     expenditure_so_far = basal_so_far + active_so_far + tef_accrued
 *     projected_total    = BMR + active_so_far + projected_remaining_active + projected_tef
 */
export function computeEnergyState(
  input: EnergyStateInput,
  calcVersion: string = ENERGY_CALC_VERSION,
): EnergyState {
  const day = input.day ?? DEFAULT_DAY_BOUNDARY;
  const tefProjectionPolicy = input.tefProjectionPolicy ?? TEF_PROJECTION_V1;
  const tefAccrualPolicy = input.tefAccrualPolicy ?? TEF_ACCRUAL_V1;

  const { model, intake } = input;
  const activity = input.activity.status === 'available' ? input.activity.estimate : null;
  const elapsed = elapsedDayFraction(input.asOf, day);

  const tef = computeTef(input);
  const tefEstimatedTotal = tef?.estimatedTefKcal ?? null;

  // ---- expenditure so far: BMR accrued + ACTIVE accrued + TEF accrued ----
  const basalSoFar = model.bmrKcal * elapsed;
  const activeSoFar = activity?.activeKcalSoFar ?? 0;
  const tefAccrued = accruedTefKcal(tefAccrualPolicy, tefEstimatedTotal ?? 0);
  const expenditureSoFar = basalSoFar + activeSoFar + tefAccrued;

  // ---- projected total: BMR + ACTIVE (observed + remaining) + projected TEF ----
  const projectedBasal = model.bmrKcal;
  const projectedRemainingActive = activity?.projectedRemainingActiveKcal ?? 0;
  const projectedActive = activeSoFar + projectedRemainingActive;
  const projectedTef = projectTefKcal(tefProjectionPolicy, tefEstimatedTotal ?? 0);
  const projectedTotal = projectedBasal + projectedActive + projectedTef;

  const intakeSoFar = intake.kcal;
  const currentBalance = intakeSoFar - expenditureSoFar;
  const remainingIntake = projectedTotal + model.targetDeltaKcal - intakeSoFar;
  const ifNoMoreFood = intakeSoFar - projectedTotal;

  // Completeness tells the truth about what is missing. A missing TEF policy is
  // NOT the same fact as a TEF estimate of zero, and is never conflated with it.
  const gaps: EnergyCompletenessGap[] = [];
  if (tef === null) gaps.push('tef_policy_missing');
  if (activity === null) gaps.push('activity_estimate_missing');
  else if (activity.completeness === 'incomplete') gaps.push('activity_coverage_incomplete');

  return {
    intakeSoFarKcal: kcal(intakeSoFar),

    basalSoFarKcal: kcal(basalSoFar),
    activeSoFarKcal: kcal(activeSoFar),
    tefAccruedKcal: kcal(tefAccrued),
    expenditureSoFarKcal: kcal(expenditureSoFar),

    projectedBasalKcal: kcal(projectedBasal),
    projectedActiveKcal: kcal(projectedActive),
    projectedRemainingActiveKcal: kcal(projectedRemainingActive),
    projectedTefKcal: kcal(projectedTef),
    projectedTotalExpenditureKcal: kcal(projectedTotal),

    currentBalanceKcal: kcal(currentBalance),
    targetDeltaKcal: model.targetDeltaKcal,
    remainingIntakeKcal: kcal(remainingIntake),
    ifNoMoreFoodBalanceKcal: kcal(ifNoMoreFood),

    tefStatus: tef === null ? 'policy_unavailable' : 'computed',
    tefEstimatedTotalKcal: tefEstimatedTotal === null ? null : kcal(tefEstimatedTotal),
    tefBaseMacroKcal: tef === null ? null : kcal(tef.baseMacroTefKcal),
    tefIndividualAdjustmentKcal: tef === null ? null : kcal(tef.individualAdjustmentKcal),
    tefConfidence: tef?.confidence ?? null,

    activitySource: activity?.source ?? null,
    activityQuality: activity?.quality ?? null,
    activityQualityReasons: activity?.qualityReasons ?? [],
    activityCompleteness: activity?.completeness ?? null,
    activityCompletenessGaps: activity?.completenessGaps ?? [],
    activityUnresolvedMinutes: activity?.unresolvedMinutes ?? null,
    activityUnavailableReason:
      input.activity.status === 'unavailable' ? input.activity.reason : null,
    activityCoverageRatio: activity?.coverage?.coverageRatio ?? null,
    activityConfidence: activity?.confidence ?? null,
    activityProviderId: activity?.providerId ?? null,

    energyQuality: qualityOf(activity),
    energyCompleteness: gaps.length === 0 ? 'complete' : 'incomplete',
    completenessGaps: gaps,

    elapsedDayFraction: elapsed,

    calcVersion,
    bmrPolicyVersion: model.bmrPolicyVersion,
    tefPolicyVersion: tef?.policyVersion ?? null,
    tefPolicyReviewStatus: tef?.reviewStatus ?? null,
    tefProjectionPolicyVersion: tefProjectionPolicy.version,
    tefAccrualPolicyVersion: tefAccrualPolicy.version,
    activityProjectionPolicyVersion: activity?.projectionPolicyVersion ?? null,
    activityGapFillPolicyVersion: activity?.gapFillPolicyVersion ?? null,
  };
}

export type { ActivityProjectionPolicy };
