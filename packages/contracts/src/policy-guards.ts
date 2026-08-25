import type {
  BmrPolicy,
  GuardrailPolicy,
  MacroPolicy,
  TefPolicy,
  VersionedAdjustmentRule,
} from './policies.js';
import type { ActivityPlausibilityPolicy } from './activity.js';
import { err, issue, ok, type Result, type ValidationIssue } from './result.js';

type ReviewablePolicy =
  | TefPolicy
  | BmrPolicy
  | MacroPolicy
  | GuardrailPolicy
  | ActivityPlausibilityPolicy;

/**
 * THE POLICY FIREWALL.
 *
 * A physiological policy is usable in production only when BOTH hold:
 *   provenance === 'APPROVED_PRODUCTION'   (not a test fixture)
 *   reviewStatus === 'APPROVED'            (a qualified reviewer signed off)
 *
 * Provenance alone is not sufficient — an in-house policy carrying unreviewed
 * coefficients is still unreviewed. Checked by discriminant, so no
 * configuration path bypasses it.
 */
export function assertProductionPolicy<T extends ReviewablePolicy>(policy: T): Result<T> {
  const issues: ValidationIssue[] = [];
  if (policy.provenance !== 'APPROVED_PRODUCTION') {
    issues.push(
      issue('provenance', 'policy_not_production', 'synthetic test policy cannot be used in a production code path'),
    );
  }
  if (policy.reviewStatus !== 'APPROVED') {
    issues.push(
      issue('reviewStatus', 'policy_not_approved', 'policy has not passed external review'),
    );
  }
  return issues.length ? err(issues) : ok(policy);
}

/** Structural validation of one adjustment rule. */
function validateRule(name: string, rule: VersionedAdjustmentRule, out: ValidationIssue[]): void {
  const path = `individualAdjustmentModel.${name}`;

  switch (rule.kind) {
    case 'none':
      return;

    case 'linear': {
      for (const [field, v] of [['slope', rule.slope], ['intercept', rule.intercept]] as const) {
        if (!Number.isFinite(v)) out.push(issue(`${path}.${field}`, 'not_finite', 'must be finite'));
      }
      const [lo, hi] = rule.bounds;
      if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
        out.push(issue(`${path}.bounds`, 'not_finite', 'bounds must be finite'));
      } else if (lo > hi) {
        out.push(issue(`${path}.bounds`, 'invalid_combination', 'lower bound exceeds upper bound'));
      }
      return;
    }

    case 'piecewise': {
      if (rule.breakpoints.length === 0) {
        out.push(issue(`${path}.breakpoints`, 'required', 'at least one breakpoint is required'));
        return;
      }
      let previous = Number.NEGATIVE_INFINITY;
      for (const [i, bp] of rule.breakpoints.entries()) {
        if (!Number.isFinite(bp.upTo)) {
          out.push(issue(`${path}.breakpoints[${i}].upTo`, 'not_finite', 'must be finite'));
          continue;
        }
        if (!Number.isFinite(bp.kcal)) {
          out.push(issue(`${path}.breakpoints[${i}].kcal`, 'not_finite', 'must be finite'));
        }
        if (bp.upTo === previous) {
          out.push(issue(`${path}.breakpoints[${i}].upTo`, 'invalid_combination', 'duplicate threshold'));
        } else if (bp.upTo < previous) {
          out.push(
            issue(`${path}.breakpoints[${i}].upTo`, 'invalid_combination', 'thresholds must strictly increase'),
          );
        }
        previous = bp.upTo;
      }
      return;
    }

    case 'categorical': {
      for (const [field, v] of Object.entries(rule.cases)) {
        if (!Number.isFinite(v)) out.push(issue(`${path}.cases.${field}`, 'not_finite', 'must be finite'));
      }
      return;
    }
  }
}

/**
 * THE SAFETY PROPERTY.
 *
 * While a TEF policy is PENDING_EXTERNAL_REVIEW every individual-adjustment
 * rule must be neutral. There is therefore no configuration path by which an
 * invented age, sex, body-fat or lean-mass coefficient reaches a user:
 * individualAdjustmentKcal is exactly 0 until a reviewer approves the model.
 */
export function validateTefPolicy(policy: TefPolicy): Result<TefPolicy> {
  const issues: ValidationIssue[] = [];
  const { protein, carbohydrate, fat, alcohol } = policy.macroCoefficients;

  for (const [name, v] of Object.entries({ protein, carbohydrate, fat, alcohol })) {
    if (v === undefined) continue;
    if (!Number.isFinite(v) || v < 0 || v > 1) {
      issues.push(issue(`macroCoefficients.${name}`, 'out_of_range', 'must be a fraction in [0,1]'));
    }
  }

  if (!Number.isFinite(policy.adjustmentBoundFraction) || policy.adjustmentBoundFraction < 0) {
    issues.push(issue('adjustmentBoundFraction', 'out_of_range', 'must be non-negative'));
  }

  if (policy.personalCalibrationEnabled !== false) {
    issues.push(
      issue('personalCalibrationEnabled', 'invalid_combination', 'personal calibration is reserved and unused'),
    );
  }

  const rules = Object.entries(policy.individualAdjustmentModel) as [string, VersionedAdjustmentRule | undefined][];

  for (const [name, rule] of rules) {
    if (rule === undefined) continue;
    validateRule(name, rule, issues);

    if (policy.reviewStatus === 'PENDING_EXTERNAL_REVIEW' && rule.kind !== 'none') {
      issues.push(
        issue(
          `individualAdjustmentModel.${name}`,
          'policy_not_approved',
          'unreviewed policies must use only neutral (none) adjustment rules',
        ),
      );
    }

    // Sex is categorical. Encoding it as a continuous 0/1 quantity would be a
    // fake physiological number, so the type system and this check forbid it.
    if (name === 'sex' && rule.kind !== 'none' && rule.kind !== 'categorical') {
      issues.push(
        issue(
          'individualAdjustmentModel.sex',
          'invalid_combination',
          'a sex adjustment must be categorical, never a continuous rule',
        ),
      );
    }
  }

  return issues.length ? err(issues) : ok(policy);
}
