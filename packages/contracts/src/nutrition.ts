import type { Grams, Kcal } from './primitives.js';

/**
 * CANONICAL NUTRITION BASIS.
 *
 * Nutrition is stored per 100 g and nothing else. Declared serving sizes are
 * presentation metadata. A volume-based product carries a density so it can be
 * reduced to the mass basis before any arithmetic happens.
 */
export type BasisKind = 'per_100g' | 'per_100ml';

/**
 * Extended per-basis nutrients, keyed by canonical MACROS.AI nutrient id.
 *
 * Deliberately a MAP, not dozens of optional columns: a food may report five
 * nutrients or a hundred, and ABSENT MEANS UNKNOWN. Structurally identical to
 * `NutrientMap` in @macros/domain-nutrients, declared here so contracts stay
 * dependency-free.
 */
export type ExtendedNutrients = Readonly<Record<string, {
  readonly nutrientId: string;
  readonly amount: number;
  readonly unit: string;
  readonly source?: Readonly<Record<string, unknown>>;
}>>;

export interface NutrientBasis {
  readonly kind: BasisKind;
  /** Required when kind === 'per_100ml'. Grams per millilitre. */
  readonly densityGPerMl?: number;

  readonly kcal: number;
  readonly proteinG: number;
  readonly carbohydrateG: number;
  readonly fatG: number;

  readonly fiberG?: number;
  /**
   * Everything beyond the core four, per basis. Never zero-filled.
   * Fiber also appears here canonically; it does NOT add energy of its own,
   * because the source kcal already accounts for the food's declared energy.
   */
  readonly extended?: ExtendedNutrients;
  readonly sugarG?: number;
  readonly sodiumMg?: number;
  readonly saturatedFatG?: number;
  readonly alcoholG?: number;
}

/** Absolute nutrient amounts for a specific consumed mass. */
export interface NutritionTotals {
  readonly kcal: Kcal;
  readonly proteinG: Grams;
  readonly carbohydrateG: Grams;
  readonly fatG: Grams;
  readonly fiberG?: Grams;
  readonly sugarG?: Grams;
  readonly sodiumMg?: number;
  readonly saturatedFatG?: Grams;
  readonly alcoholG?: Grams;
}

export interface NutritionResult {
  readonly totals: NutritionTotals;
  readonly consumedGrams: Grams;
  readonly basisKind: BasisKind;
  readonly calcVersion: string;
}

export const EMPTY_TOTALS: NutritionTotals = {
  kcal: 0 as Kcal,
  proteinG: 0 as Grams,
  carbohydrateG: 0 as Grams,
  fatG: 0 as Grams,
};
