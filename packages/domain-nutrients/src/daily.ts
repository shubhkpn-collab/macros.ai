import { nutrientDefinition, type NutrientId, type NutrientUnit } from './registry.js';
import { type NutrientMap } from './amounts.js';

export const DAILY_NUTRIENT_VERSION = 'daily-nutrients@1.0.0';

/**
 * DAILY NUTRIENT TOTALS WITH COVERAGE.
 *
 * A day's total is only as trustworthy as the foods that reported the nutrient.
 * Summing known values and presenting the result as complete would turn "four
 * of five foods reported fiber" into a confident, wrong number — so coverage
 * travels with every total.
 */
export interface DailyNutrientTotal {
  readonly nutrientId: NutrientId;
  readonly displayName: string;
  readonly unit: NutrientUnit;
  /** Sum of the values that were actually reported. */
  readonly knownAmount: number;
  /** How many logged items supplied this nutrient. */
  readonly itemsWithData: number;
  readonly itemsTotal: number;
  /** True only when every logged item reported this nutrient. */
  readonly complete: boolean;
}

export interface DailyNutrientTotals {
  readonly localDate: string;
  readonly itemsTotal: number;
  readonly totals: Readonly<Partial<Record<NutrientId, DailyNutrientTotal>>>;
  readonly version: string;
}

/**
 * Aggregate from STORED snapshots — the day's truth is what was logged, never a
 * re-read of current product data. A product corrected tomorrow does not
 * retroactively change what a user was told they ate today.
 */
export function aggregateDailyNutrients(
  localDate: string,
  loggedNutrientMaps: readonly NutrientMap[],
): DailyNutrientTotals {
  const acc = new Map<NutrientId, { sum: number; count: number }>();

  for (const map of loggedNutrientMaps) {
    for (const [id, amount] of Object.entries(map)) {
      if (amount === undefined) continue;
      const key = id as NutrientId;
      const cur = acc.get(key) ?? { sum: 0, count: 0 };
      // Only reported values contribute. An absent nutrient adds nothing and,
      // crucially, does not count toward coverage either.
      cur.sum += amount.amount;
      cur.count += 1;
      acc.set(key, cur);
    }
  }

  const totals: Record<string, DailyNutrientTotal> = {};
  const itemsTotal = loggedNutrientMaps.length;

  for (const [id, { sum, count }] of acc) {
    const d = nutrientDefinition(id);
    totals[id] = {
      nutrientId: id,
      displayName: d.displayName,
      unit: d.unit,
      knownAmount: Math.round(sum * 1e6) / 1e6,
      itemsWithData: count,
      itemsTotal,
      complete: count === itemsTotal && itemsTotal > 0,
    };
  }

  return { localDate, itemsTotal, totals: totals as DailyNutrientTotals['totals'], version: DAILY_NUTRIENT_VERSION };
}

/**
 * A presentation projection.
 *
 * `target` and `progressPercent` are OPTIONAL and absent by default: MACROS.AI
 * has no reviewed micronutrient targets, and manufacturing a percentage against
 * an invented target would be a medical claim in disguise.
 */
/**
 * A nutrient's value for presentation.
 *
 * STRUCTURALLY three-way, so UI and voice cannot confuse the cases:
 *   - `known`      — every logged food reported it; the amount is the day's truth
 *   - `partial`    — some foods reported it; the amount is a KNOWN SUBSET
 *   - `unavailable`— no logged food reported it; there is NO amount
 *
 * The previous shape returned `knownAmount ?? 0`, which meant "no Vitamin D
 * data" and "measured 0 µg of Vitamin D" both arrived as the number 0 with a
 * flag the caller had to interpret. A measured zero is a fact; an unreported
 * nutrient is not, and presenting the latter as 0 is a fabricated value.
 */
export type NutrientValue =
  | { readonly status: 'known'; readonly amount: number }
  | { readonly status: 'partial'; readonly amount: number }
  | { readonly status: 'unavailable' };

export const isMeasured = (v: NutrientValue): v is { status: 'known' | 'partial'; amount: number } =>
  v.status !== 'unavailable';

export interface NutrientDetail {
  readonly nutrientId: NutrientId;
  readonly displayName: string;
  readonly unit: NutrientUnit;
  /** The ONLY way to read an amount. There is no zero fallback. */
  readonly value: NutrientValue;
  readonly itemsWithData: number;
  readonly itemsTotal: number;
  readonly target?: number;
  readonly progressPercent?: number;
}

export interface NutrientTargets {
  readonly targets: Readonly<Partial<Record<NutrientId, number>>>;
  readonly policyVersion: string;
}

export function nutrientDetails(
  daily: DailyNutrientTotals,
  visible: readonly NutrientId[],
  targets?: NutrientTargets,
): readonly NutrientDetail[] {
  return visible.map((id) => {
    const t = daily.totals[id];
    const d = nutrientDefinition(id);
    const target = targets?.targets[id];

    // No food reported it → there is no amount, not an amount of zero.
    const value: NutrientValue =
      t === undefined
        ? { status: 'unavailable' }
        : t.complete
          ? { status: 'known', amount: t.knownAmount }
          : { status: 'partial', amount: t.knownAmount };

    const base: NutrientDetail = {
      nutrientId: id,
      displayName: d.displayName,
      unit: d.unit,
      value,
      itemsWithData: t?.itemsWithData ?? 0,
      itemsTotal: daily.itemsTotal,
    };

    // A percentage requires both a target AND a measured value. An unavailable
    // nutrient never gets a progress figure.
    if (target === undefined || target <= 0 || !isMeasured(value)) return base;
    return {
      ...base,
      target,
      progressPercent: Math.round((value.amount / target) * 1000) / 10,
    };
  });
}
