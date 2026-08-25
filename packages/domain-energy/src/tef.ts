import {
  ATWATER,
  kcal,
  unwrap,
  validateTefPolicy,
  type NutritionTotals,
  type TefConfidence,
  type TefInputsUsed,
  type TefContinuousInput,
  type TefInputVariable,
  type TefPolicy,
  type TefPolicyHandle,
  type TefProfile,
  type TefResult,
  type VersionedAdjustmentRule,
} from '@macros/contracts';

/**
 * NO FAKE PRODUCTION DEFAULT.
 *
 * There is no approved physiological coefficient set yet, so this package ships
 * none. The loader reports the absence as a state rather than substituting a
 * hidden "temporary" value.
 *
 * A missing policy is NOT the same fact as a TEF estimate of zero. The engine
 * records 'tef_policy_missing' as an explicit completeness gap rather than
 * quietly presenting BMR + ACTIVE + 0 as a complete component composition.
 */
export function loadProductionTefPolicy(): TefPolicyHandle {
  return { status: 'unavailable', reason: 'no_approved_policy_exists' };
}

/**
 * Sex is deliberately absent: it is categorical, and encoding it as a 0/1
 * continuous quantity for a linear rule would be a fake physiological number.
 */
const readContinuous = (v: TefContinuousInput, profile: TefProfile): number | undefined => {
  switch (v) {
    case 'age': return profile.ageYears;
    case 'bodyFatPercent': return profile.bodyFatPercent;
    case 'fatFreeMass': return profile.fatFreeMassKg;
  }
};

interface AppliedRule {
  readonly kcal: number;
  readonly input: TefInputVariable | null;
}

/** Evaluate one adjustment rule. A neutral rule contributes exactly zero. */
function applyRule(rule: VersionedAdjustmentRule | undefined, profile: TefProfile): AppliedRule {
  if (rule === undefined || rule.kind === 'none') return { kcal: 0, input: null };

  if (rule.kind === 'categorical') {
    return { kcal: rule.cases[profile.sex], input: 'sex' };
  }

  const raw = readContinuous(rule.input, profile);
  if (raw === undefined || !Number.isFinite(raw)) return { kcal: 0, input: null };

  if (rule.kind === 'linear') {
    const v = rule.slope * raw + rule.intercept;
    const [lo, hi] = rule.bounds;
    return { kcal: Math.min(hi, Math.max(lo, v)), input: rule.input };
  }

  for (const bp of rule.breakpoints) {
    if (raw <= bp.upTo) return { kcal: bp.kcal, input: rule.input };
  }
  const last = rule.breakpoints[rule.breakpoints.length - 1];
  return last ? { kcal: last.kcal, input: rule.input } : { kcal: 0, input: null };
}

export function baseMacroTef(nutrition: NutritionTotals, policy: TefPolicy): number {
  const proteinEnergy = nutrition.proteinG * ATWATER.protein;
  const carbEnergy = nutrition.carbohydrateG * ATWATER.carbohydrate;
  const fatEnergy = nutrition.fatG * ATWATER.fat;
  const alcoholEnergy = (nutrition.alcoholG ?? 0) * ATWATER.alcohol;

  return (
    proteinEnergy * policy.macroCoefficients.protein +
    carbEnergy * policy.macroCoefficients.carbohydrate +
    fatEnergy * policy.macroCoefficients.fat +
    alcoholEnergy * (policy.macroCoefficients.alcohol ?? 0)
  );
}

/**
 * INDIVIDUALIZED TEF ESTIMATE.
 *
 *   base_macro_tef      = f(meal macro composition)
 *   individualized_tef  = base + bounded, composed adjustment from body profile
 *
 * Adjustments sum in kcal; they are never multiplied together. While the policy
 * is PENDING_EXTERNAL_REVIEW every rule is neutral, so the adjustment is
 * exactly zero and individualized === base.
 *
 * Never "exact TEF" — this is an estimate.
 */
export function calculateTef(
  nutrition: NutritionTotals,
  profile: TefProfile,
  policy: TefPolicy,
): TefResult {
  unwrap(validateTefPolicy(policy));

  const base = baseMacroTef(nutrition, policy);

  const model = policy.individualAdjustmentModel;
  const applied = [
    applyRule(model.age, profile),
    applyRule(model.sex, profile),
    applyRule(model.fatFreeMass, profile),
    applyRule(model.bodyFatPercent, profile),
  ];

  const rawAdjustment = applied.reduce((sum, a) => sum + a.kcal, 0);
  const bound = Math.abs(policy.adjustmentBoundFraction * base);
  const adjustment = Math.min(bound, Math.max(-bound, rawAdjustment));

  // A rule counts as "used" only if it materially affected the result.
  const materiallyUsed = new Set<TefInputVariable>();
  if (adjustment !== 0) {
    for (const a of applied) if (a.input !== null && a.kcal !== 0) materiallyUsed.add(a.input);
  }

  // Fat-free mass is DERIVED from body weight and body-fat percentage, so if a
  // lean-mass rule changed the result, all three inputs genuinely contributed.
  const usedFfm = materiallyUsed.has('fatFreeMass');

  const inputsUsed: TefInputsUsed = {
    macros: true,
    age: materiallyUsed.has('age'),
    sex: materiallyUsed.has('sex'),
    bodyWeight: usedFfm,
    bodyFat: usedFfm || materiallyUsed.has('bodyFatPercent'),
    fatFreeMass: usedFfm,
    personalCalibration: false,
  };

  const confidence: TefConfidence = adjustment === 0 ? 'basic' : 'profile_adjusted';

  return {
    estimatedTefKcal: kcal(base + adjustment),
    baseMacroTefKcal: kcal(base),
    individualAdjustmentKcal: kcal(adjustment),
    confidence,
    policyVersion: policy.version,
    reviewStatus: policy.reviewStatus,
    inputsUsed,
  };
}

/**
 * Physiological validation ranges are NOT hard-coded here. Unreviewed
 * assumptions such as "whole-day TEF is 5-15% of intake" are not production
 * engine truth; when a reviewer approves ranges they belong in a versioned
 * policy. Synthetic ranges used to exercise the arithmetic live in the testkit.
 */
