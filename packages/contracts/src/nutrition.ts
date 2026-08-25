import type { Grams, Kcal } from './primitives.js';

/**
 * CANONICAL NUTRITION BASIS.
 *
 * Nutrition is stored per 100 g and nothing else. Declared serving sizes are
 * presentation metadata. A volume-based product carries a density so it can be
 * reduced to the mass basis before any arithmetic happens.
 */
export type BasisKind = 'per_100g' | 'per_100ml';

export interface NutrientBasis {
  readonly kind: BasisKind;
  /** Required when kind === 'per_100ml'. Grams per millilitre. */
  readonly densityGPerMl?: number;

  readonly kcal: number;
  readonly proteinG: number;
  readonly carbohydrateG: number;
  readonly fatG: number;

  readonly fiberG?: number;
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
