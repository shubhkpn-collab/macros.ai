import {
  ATWATER,
  grams,
  kcal,
  type GuardrailAssessment,
  type GuardrailPolicy,
  type IntakeTotals,
  type Kcal,
  type MacroPolicy,
  type MacroState,
  type MacroTargets,
  type Sex,
} from '@macros/contracts';
import { DEFAULT_GUARDRAIL_POLICY, DEFAULT_MACRO_POLICY } from './policy.js';

export const MACRO_CALC_VERSION = 'macros@1.0.0';

export interface MacroTargetInput {
  readonly projectedTotalExpenditureKcal: number;
  readonly targetDeltaKcal: number;
  readonly bodyWeightKg: number;
}

/**
 * Derive macro targets from the calorie target.
 *   protein = g/kg floor, takes priority
 *   fat     = max(g/kg floor, minimum fraction of kcal)
 *   carb    = remainder, clamped at zero
 *
 * PURE. Full precision internally; rounding happens only at display.
 */
export function computeMacroTargets(
  input: MacroTargetInput,
  policy: MacroPolicy = DEFAULT_MACRO_POLICY,
): MacroTargets {
  const targetKcal = input.projectedTotalExpenditureKcal + input.targetDeltaKcal;

  const proteinG = policy.proteinGPerKg * input.bodyWeightKg;
  const fatG = Math.max(
    policy.fatGPerKgFloor * input.bodyWeightKg,
    (policy.fatMinFractionOfKcal * targetKcal) / ATWATER.fat,
  );

  const remainderKcal =
    targetKcal - proteinG * ATWATER.protein - fatG * ATWATER.fat;
  const carbohydrateClamped = remainderKcal < 0;
  const carbohydrateG = carbohydrateClamped ? 0 : remainderKcal / ATWATER.carbohydrate;

  return {
    targetKcal: kcal(targetKcal),
    proteinG: grams(proteinG),
    carbohydrateG: grams(carbohydrateG),
    fatG: grams(fatG),
    policyVersion: policy.version,
    policyReviewStatus: policy.reviewStatus,
    carbohydrateClamped,
  };
}

export function computeMacroState(
  targets: MacroTargets,
  consumed: IntakeTotals,
  calcVersion: string = MACRO_CALC_VERSION,
): MacroState {
  return {
    targets,
    consumedKcal: consumed.kcal,
    consumedProteinG: consumed.proteinG,
    consumedCarbohydrateG: consumed.carbohydrateG,
    consumedFatG: consumed.fatG,
    remainingKcal: kcal(targets.targetKcal - consumed.kcal),
    remainingProteinG: grams(targets.proteinG - consumed.proteinG),
    remainingCarbohydrateG: grams(targets.carbohydrateG - consumed.carbohydrateG),
    remainingFatG: grams(targets.fatG - consumed.fatG),
    calcVersion,
  };
}

/**
 * Target guardrails. A target below the floor is refused by the engine; large
 * deficits and surpluses require explicit confirmation.
 */
export function assessGuardrails(
  targetKcal: Kcal,
  bmrKcal: number,
  sex: Sex,
  targetDeltaKcal: number,
  policy: GuardrailPolicy = DEFAULT_GUARDRAIL_POLICY,
): GuardrailAssessment {
  const floor = Math.max(policy.absoluteFloorKcal[sex], policy.bmrFloorFraction * bmrKcal);
  return {
    targetKcal,
    floorKcal: kcal(floor),
    belowFloor: targetKcal < floor,
    requiresExplicitConfirmation:
      targetDeltaKcal < -policy.maxDeficitKcal || targetDeltaKcal > policy.maxSurplusKcal,
    policyVersion: policy.version,
    policyReviewStatus: policy.reviewStatus,
  };
}

/**
 * Macro-derived calories must reconcile to the calorie target within rounding.
 * A mismatch is the kind of small inconsistency that destroys user trust.
 */
export function macroKcal(targets: MacroTargets): number {
  return (
    targets.proteinG * ATWATER.protein +
    targets.carbohydrateG * ATWATER.carbohydrate +
    targets.fatG * ATWATER.fat
  );
}
