import { validateNutrientBasis } from './validation.js';
import { err, issue, ok, type Result, type ValidationIssue } from './result.js';
import type { NutritionSnapshot, ProductVersion } from './food.js';
import type { FoodLogItem } from './log.js';

const PREPARATION_STATES = ['raw', 'cooked', 'prepared', 'as_sold'] as const;

/**
 * THE canonical ProductVersion validator.
 *
 * Nutrition rules are NOT duplicated here — the basis is delegated to
 * validateNutrientBasis so there is exactly one definition of a valid basis.
 */
export function validateProductVersion(v: ProductVersion): Result<ProductVersion> {
  const out: ValidationIssue[] = [];

  if (v.productId.length === 0) out.push(issue('productId', 'required', 'is required'));
  if (v.productVersionId.length === 0) out.push(issue('productVersionId', 'required', 'is required'));
  if (v.displayName.length === 0) out.push(issue('displayName', 'required', 'is required'));
  if (!Number.isInteger(v.versionNo) || v.versionNo < 1) {
    out.push(issue('versionNo', 'out_of_range', 'must be a positive integer'));
  }
  if (!PREPARATION_STATES.includes(v.preparationState)) {
    out.push(issue('preparationState', 'invalid_enum', 'unsupported preparation state'));
  }
  if (!Number.isFinite(Date.parse(v.effectiveFrom))) {
    out.push(issue('effectiveFrom', 'not_finite', 'must be a valid instant'));
  }
  if (v.source.sourceId.length === 0) out.push(issue('source.sourceId', 'required', 'is required'));

  const basis = validateNutrientBasis(v.basis);
  if (!basis.ok) out.push(...basis.error.map((i) => issue(`basis.${i.path}`, i.code, i.message)));

  return out.length ? err(out) : ok(v);
}

export function validateNutritionSnapshot(s: NutritionSnapshot): Result<NutritionSnapshot> {
  const out: ValidationIssue[] = [];
  if (s.productVersionId.length === 0) out.push(issue('productVersionId', 'required', 'is required'));
  if (!Number.isFinite(s.gramsConsumed) || s.gramsConsumed <= 0) {
    out.push(issue('gramsConsumed', 'out_of_range', 'must be greater than zero'));
  }
  if (s.calcVersion.length === 0) out.push(issue('calcVersion', 'required', 'is required'));
  for (const [k, val] of Object.entries({
    kcal: s.totals.kcal,
    proteinG: s.totals.proteinG,
    carbohydrateG: s.totals.carbohydrateG,
    fatG: s.totals.fatG,
  })) {
    if (!Number.isFinite(val) || val < 0) {
      out.push(issue(`totals.${k}`, 'out_of_range', 'must be a finite non-negative number'));
    }
  }
  return out.length ? err(out) : ok(s);
}

/**
 * A log's first-class fields and its immutable snapshot must never contradict
 * each other. This is the single place that rule is defined, so the domain and
 * the persistence boundary cannot disagree about it.
 */
export function validateFoodLogItem(item: FoodLogItem): Result<FoodLogItem> {
  const out: ValidationIssue[] = [];

  if (item.userId.length === 0) out.push(issue('userId', 'required', 'is required'));
  if (item.logId.length === 0) out.push(issue('logId', 'required', 'is required'));
  if (item.productVersionId.length === 0) {
    out.push(issue('productVersionId', 'required', 'is required'));
  }
  if (!Number.isFinite(Date.parse(item.loggedAt))) {
    out.push(issue('loggedAt', 'not_finite', 'must be a valid instant'));
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(item.localDate)) {
    out.push(issue('localDate', 'invalid_enum', 'must be an ISO calendar date'));
  }
  if (!Number.isInteger(item.eventUtcOffsetMinutes)) {
    out.push(issue('eventUtcOffsetMinutes', 'out_of_range', 'must be an integer'));
  }

  const snapshot = validateNutritionSnapshot(item.nutritionSnapshot);
  if (!snapshot.ok) out.push(...snapshot.error);

  if (item.grams !== item.nutritionSnapshot.gramsConsumed) {
    out.push(issue('grams', 'invalid_combination', 'grams disagree with the nutrition snapshot'));
  }
  if (item.productVersionId !== item.nutritionSnapshot.productVersionId) {
    out.push(
      issue('productVersionId', 'invalid_combination', 'product version disagrees with the snapshot'),
    );
  }
  if (item.weightCapture.grams !== item.grams) {
    out.push(issue('weightCapture.grams', 'invalid_combination', 'weight capture disagrees with logged grams'));
  }

  return out.length ? err(out) : ok(item);
}
