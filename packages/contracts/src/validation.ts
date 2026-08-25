import type { NutrientBasis } from './nutrition.js';
import {
  AGE_VALID_YEARS,
  BODY_FAT_VALID_PERCENT,
  HEIGHT_VALID_CM,
  WEIGHT_VALID_KG,
  type TefProfile,
  type UserProfileSnapshot,
} from './profile.js';
import { kilograms, type Kilograms } from './primitives.js';
import { err, issue, ok, type Result, type ValidationIssue } from './result.js';
import { MAX_WEIGHT_AGE_SECONDS, SCALE_RANGE_G, type WeightCapture } from './weight.js';

const finiteNonNegative = (
  v: number | undefined,
  path: string,
  out: ValidationIssue[],
  required = true,
): void => {
  if (v === undefined) {
    if (required) out.push(issue(path, 'required', 'is required'));
    return;
  }
  if (!Number.isFinite(v)) out.push(issue(path, 'not_finite', 'must be a finite number'));
  else if (v < 0) out.push(issue(path, 'out_of_range', 'must not be negative'));
};

const inRange = (
  v: number,
  range: { min: number; max: number },
  path: string,
  out: ValidationIssue[],
): void => {
  if (!Number.isFinite(v)) out.push(issue(path, 'not_finite', 'must be a finite number'));
  else if (v < range.min || v > range.max) {
    out.push(issue(path, 'out_of_range', `must be between ${range.min} and ${range.max}`));
  }
};

export function validateNutrientBasis(basis: NutrientBasis): Result<NutrientBasis> {
  const issues: ValidationIssue[] = [];

  // A servable product may not have a null macro.
  finiteNonNegative(basis.kcal, 'kcal', issues);
  finiteNonNegative(basis.proteinG, 'proteinG', issues);
  finiteNonNegative(basis.carbohydrateG, 'carbohydrateG', issues);
  finiteNonNegative(basis.fatG, 'fatG', issues);

  finiteNonNegative(basis.fiberG, 'fiberG', issues, false);
  finiteNonNegative(basis.sugarG, 'sugarG', issues, false);
  finiteNonNegative(basis.sodiumMg, 'sodiumMg', issues, false);
  finiteNonNegative(basis.saturatedFatG, 'saturatedFatG', issues, false);
  finiteNonNegative(basis.alcoholG, 'alcoholG', issues, false);

  if (basis.kind === 'per_100ml') {
    if (basis.densityGPerMl === undefined) {
      issues.push(issue('densityGPerMl', 'required', 'required for a per_100ml basis'));
    } else if (!Number.isFinite(basis.densityGPerMl) || basis.densityGPerMl <= 0) {
      issues.push(issue('densityGPerMl', 'out_of_range', 'must be greater than zero'));
    }
  }

  // Mass balance: constituents of 100 g cannot exceed 100 g.
  const mass =
    basis.proteinG +
    basis.carbohydrateG +
    basis.fatG +
    (basis.alcoholG ?? 0);
  if (Number.isFinite(mass) && mass > 100.5) {
    issues.push(issue('massBalance', 'invalid_combination', 'macros exceed 100 g per 100 g'));
  }

  return issues.length ? err(issues) : ok(basis);
}

export function validateUserProfile(p: UserProfileSnapshot): Result<UserProfileSnapshot> {
  const issues: ValidationIssue[] = [];
  inRange(p.ageYears, AGE_VALID_YEARS, 'ageYears', issues);
  inRange(p.bodyWeightKg, WEIGHT_VALID_KG, 'bodyWeightKg', issues);
  inRange(p.heightCm, HEIGHT_VALID_CM, 'heightCm', issues);
  if (p.sex !== 'male' && p.sex !== 'female') {
    issues.push(issue('sex', 'invalid_enum', 'must be male or female'));
  }
  // Body fat is optional; when present it must be plausible. Rejected, never clamped.
  if (p.bodyFatPercent !== undefined) {
    inRange(p.bodyFatPercent, BODY_FAT_VALID_PERCENT, 'bodyFatPercent', issues);
  }
  return issues.length ? err(issues) : ok(p);
}

/** Fat-free mass. Undefined when body fat is absent or implausible — never zero. */
export function deriveFatFreeMassKg(p: UserProfileSnapshot): Kilograms | undefined {
  const bf = p.bodyFatPercent;
  if (bf === undefined) return undefined;
  if (!Number.isFinite(bf)) return undefined;
  if (bf < BODY_FAT_VALID_PERCENT.min || bf > BODY_FAT_VALID_PERCENT.max) return undefined;
  return kilograms(p.bodyWeightKg * (1 - bf / 100));
}

/**
 * Derive the TEF profile from the SAME snapshot that produces BMR.
 * Age, sex, weight and height cannot diverge between the two calculations.
 */
export function deriveTefProfile(p: UserProfileSnapshot): TefProfile {
  const ffm = deriveFatFreeMassKg(p);
  const base = {
    ageYears: p.ageYears,
    sex: p.sex,
    bodyWeightKg: p.bodyWeightKg,
    heightCm: p.heightCm,
  };
  if (p.bodyFatPercent !== undefined && ffm !== undefined) {
    return { ...base, bodyFatPercent: p.bodyFatPercent, fatFreeMassKg: ffm };
  }
  if (p.bodyFatPercent !== undefined) return { ...base, bodyFatPercent: p.bodyFatPercent };
  return base;
}

export interface WeightValidationContext {
  /**
   * Present only at the CAPTURE boundary, where "is this reading still live?"
   * is the question. Omit it at the LOGGING boundary.
   *
   * Reading freshness is enforced once, by the weight-capture state machine's
   * stable-candidate age policy. Re-applying it when the log is written would
   * mean the user had to identify their food within seconds of weighing it —
   * which is exactly the coupling explicit capture intent exists to remove.
   */
  readonly nowIso?: string;
}

/**
 * A capture is a FOOD weight, so it must be finite and greater than zero even
 * though a raw reading may drift slightly negative. Downstream nutrition math
 * never needs to know how the weight was acquired — only that it is valid.
 */
export function validateWeightCapture(
  w: WeightCapture,
  ctx: WeightValidationContext = {},
): Result<WeightCapture> {
  const issues: ValidationIssue[] = [];

  if (!Number.isFinite(w.grams)) {
    issues.push(issue('grams', 'not_finite', 'must be a finite number'));
  } else if (w.grams <= 0) {
    issues.push(issue('grams', 'out_of_range', 'a food capture must be greater than zero'));
  } else if (w.grams > SCALE_RANGE_G.max) {
    issues.push(issue('grams', 'out_of_range', 'exceeds the nominal scale range'));
  }

  if (w.source === 'scale') {
    if (w.deviceId === undefined) {
      issues.push(issue('deviceId', 'required', 'a scale capture requires device provenance'));
    }
    if (w.bootId === undefined) {
      issues.push(issue('bootId', 'required', 'a scale capture requires a boot id'));
    }
    if (w.stabilityPolicyVersion === undefined) {
      issues.push(issue('stabilityPolicyVersion', 'required', 'a scale capture requires its stability policy version'));
    }
    if (!Number.isFinite(Date.parse(w.capturedAt))) {
      issues.push(issue('capturedAt', 'not_finite', 'must be a valid instant'));
    } else if (ctx.nowIso !== undefined) {
      const ageSeconds = (Date.parse(ctx.nowIso) - Date.parse(w.capturedAt)) / 1000;
      if (!Number.isFinite(ageSeconds)) {
        issues.push(issue('nowIso', 'not_finite', 'must be a valid instant'));
      } else if (ageSeconds > MAX_WEIGHT_AGE_SECONDS) {
        issues.push(issue('capturedAt', 'out_of_range', 'reading is stale'));
      }
    }
  }

  if (w.source === 'manual') {
    // Manual weight carries only truthful provenance. It must never imply that
    // a stability policy or stability evidence produced the number.
    if (w.stabilityPolicyVersion !== undefined) {
      issues.push(issue('stabilityPolicyVersion', 'invalid_combination', 'a manual entry did not use a stability policy'));
    }
    if (w.evidence !== undefined) {
      issues.push(issue('evidence', 'invalid_combination', 'a manual entry has no stability evidence'));
    }
    if (w.deviceId !== undefined || w.bootId !== undefined || w.sequence !== undefined) {
      issues.push(issue('deviceId', 'invalid_combination', 'a manual entry has no device provenance'));
    }
    if (w.resolutionGrams !== undefined || w.resolutionQuantization !== undefined) {
      issues.push(issue('resolutionGrams', 'invalid_combination', 'a manual entry has no device resolution'));
    }
    if (w.resolutionGrams !== undefined || w.resolutionQuantization !== undefined) {
      issues.push(issue('resolutionGrams', 'invalid_combination', 'a manual entry was not quantized by a device resolution'));
    }
  }

  return issues.length ? err(issues) : ok(w);
}
