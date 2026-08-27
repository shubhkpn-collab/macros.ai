import {
  grams as toGrams,
  kcal,
  unwrap,
  validateProductVersion,
  validateWeightCapture,
  validateFoodLogItem,
  type FoodLogEntry,
  type FoodLogItem,
  type Instant,
  type IntakeTotals,
  type NutritionSnapshot,
  type NutritionTotals,
  type ProductVersion,
  type WeightCapture,
} from '@macros/contracts';
import { foldFoodLogEntries } from './corrections.js';
import { calculateNutrition, NUTRITION_CALC_VERSION, sumNutrition } from '@macros/domain-nutrition';
import { localDayOf } from './local-day.js';

export const FOOD_LOG_VERSION = 'food-log@1.0.0';

export interface CreateFoodLogInput {
  readonly logId: string;
  readonly userId: string;
  readonly productVersion: ProductVersion;
  /** ONLY a WeightCapture. A raw ScaleReading may never reach this function. */
  readonly weightCapture: WeightCapture;
  readonly loggedAt: Instant;
  readonly timezone: string;
  readonly rolloverHour?: number;
  readonly mealId?: string;
}

/**
 * Selected ProductVersion + WeightCapture → immutable FoodLogItem.
 *
 * PURE: no clock, no IO, no randomness, no LLM. Time and identity are inputs.
 *
 * Nutrition is calculated ONCE here, from the selected version's canonical
 * basis and the captured grams, and then frozen. Calories come from the source
 * product data proportionally — Atwater arithmetic is a validation signal, not
 * an authority that overwrites declared label calories.
 */
export function createFoodLogItem(input: CreateFoodLogInput): FoodLogItem {
  const { productVersion, weightCapture } = input;

  if (input.logId.length === 0) throw new Error('createFoodLogItem: logId is required');
  if (input.userId.length === 0) throw new Error('createFoodLogItem: userId is required');

  // This is an application boundary: the weight and the product arrive from
  // outside the pure domain, so structural TypeScript typing is not evidence.
  // Both go through the ONE canonical runtime validator for their kind.
  unwrap(validateWeightCapture(weightCapture));
  unwrap(validateProductVersion(productVersion));

  const result = calculateNutrition(productVersion.basis, weightCapture.grams);

  const snapshot: NutritionSnapshot = {
    totals: result.totals,
    gramsConsumed: weightCapture.grams,
    productVersionId: productVersion.productVersionId,
    basisKind: result.basisKind,
    calcVersion: result.calcVersion,
    computedAt: input.loggedAt,
  };

  const day = localDayOf(input.loggedAt, input.timezone, input.rolloverHour ?? 0);

  const item: FoodLogItem = {
    logId: input.logId,
    userId: input.userId,
    productId: productVersion.productId,
    productVersionId: productVersion.productVersionId,
    grams: toGrams(weightCapture.grams),
    weightCapture,
    nutritionSnapshot: snapshot,
    loggedAt: input.loggedAt,
    eventTimezone: day.timezone,
    eventUtcOffsetMinutes: day.utcOffsetMinutes,
    localDate: day.localDate,
    nutritionCalcVersion: NUTRITION_CALC_VERSION,
    status: 'active',
    ...(input.mealId !== undefined ? { mealId: input.mealId } : {}),
  };

  // A log whose first-class fields contradict its own snapshot must never exist.
  return unwrap(validateFoodLogItem(item));
}

/**
 * Identity is `(userId, logId)`, never `logId` alone: two users may legitimately
 * generate the same client-side id, and one must never mask the other.
 *
 *   appended            a new immutable row
 *   replayed_existing   the exact same immutable payload arrived again
 *   idempotency_conflict same identity, DIFFERENT immutable payload
 *
 * The last case is the dangerous one. It must never be reported as a duplicate
 * success, because that would silently discard a genuinely different log.
 */
export type AppendOutcome = 'appended' | 'replayed_existing' | 'idempotency_conflict';

export interface AppendResult {
  readonly logs: readonly FoodLogItem[];
  readonly outcome: AppendOutcome;
  /** ALWAYS the canonical stored item — the existing one on replay/conflict. */
  readonly item: FoodLogItem;
}

/** The immutable facts that define a log's identity payload. */
/**
 * Canonical, ORDER-INDEPENDENT encoding of nutrition totals.
 *
 * `JSON.stringify` preserves JavaScript property iteration order, but the
 * snapshot is persisted as PostgreSQL JSONB, which makes no such promise. A
 * real round-trip therefore returned the SAME nutrition facts with a different
 * key order, and an exact replay fingerprinted differently — producing
 * `idempotency_conflict` where `replayed_existing` was correct.
 *
 * Reading explicit scalars into a fixed-position array removes the dependency
 * entirely: the encoding is derived from the VALUES, never from the object.
 *
 * MISSING IS NOT ZERO. An absent optional nutrient encodes as `null` and a
 * measured zero as `0`, so "we have no fiber figure" never collapses into
 * "this food contains no fiber" — the same distinction the nutrition domain
 * enforces everywhere else.
 */
function canonicalNutritionTotals(totals: NutritionTotals): readonly (number | null)[] {
  return [
    totals.kcal,
    totals.proteinG,
    totals.carbohydrateG,
    totals.fatG,
    totals.fiberG ?? null,
    totals.sugarG ?? null,
    totals.sodiumMg ?? null,
    totals.saturatedFatG ?? null,
    totals.alcoholG ?? null,
  ];
}

export function foodLogFingerprint(item: FoodLogItem): string {
  return JSON.stringify({
    userId: item.userId,
    logId: item.logId,
    productVersionId: item.productVersionId,
    grams: item.grams,
    loggedAt: item.loggedAt,
    localDate: item.localDate,
    eventTimezone: item.eventTimezone,
    eventUtcOffsetMinutes: item.eventUtcOffsetMinutes,
    nutritionCalcVersion: item.nutritionCalcVersion,
    totals: canonicalNutritionTotals(item.nutritionSnapshot.totals),
    weightSource: item.weightCapture.source,
    weightGrams: item.weightCapture.grams,
  });
}

/**
 * Idempotent append keyed by `(userId, logId)`. Replaying the same logging
 * action can never double-count intake, and a conflicting replay can never
 * overwrite the original.
 */
export function appendFoodLog(
  logs: readonly FoodLogItem[],
  item: FoodLogItem,
): AppendResult {
  const existing = logs.find((l) => l.userId === item.userId && l.logId === item.logId);
  if (existing !== undefined) {
    const outcome: AppendOutcome =
      foodLogFingerprint(existing) === foodLogFingerprint(item)
        ? 'replayed_existing'
        : 'idempotency_conflict';
    // The stored row always wins. Nothing is ever rewritten.
    return { logs, outcome, item: existing };
  }
  return { logs: [...logs, item], outcome: 'appended', item };
}

export interface DailyIntakeQuery {
  readonly userId: string;
  readonly localDate: string;
}

/**
 * FoodLogEntry[] → IntakeTotals for ONE user and ONE local calendar day.
 *
 * Totals are summed from the STORED snapshots, never recomputed from current
 * product data — so correcting a product tomorrow leaves yesterday's logged
 * nutrition historically intact.
 *
 * The stream is FOLDED first, so a corrected entry contributes once (its
 * corrected value) and a voided entry contributes nothing. Superseded entries
 * are retained in storage but never counted twice.
 */
export function aggregateDailyIntake(
  logs: readonly FoodLogEntry[],
  query: DailyIntakeQuery,
): IntakeTotals {
  const fold = foldFoodLogEntries(query.userId, logs);
  const matching = fold.effective.filter((l) => l.localDate === query.localDate);
  const totals: NutritionTotals = sumNutrition(matching.map((l) => l.nutritionSnapshot.totals));
  return { ...totals, itemCount: matching.length };
}

export const EMPTY_INTAKE: IntakeTotals = {
  kcal: kcal(0),
  proteinG: toGrams(0),
  carbohydrateG: toGrams(0),
  fatG: toGrams(0),
  itemCount: 0,
};
