import {
  grams,
  kcal,
  type Grams,
  type NutrientBasis,
  type NutritionResult,
  type NutritionTotals,
  unwrap,
  validateNutrientBasis,
} from '@macros/contracts';

export const NUTRITION_CALC_VERSION = 'nutrition@1.0.0';

const scaleOptional = (v: number | undefined, factor: number): number | undefined =>
  v === undefined ? undefined : v * factor;

/**
 * Reduce any basis to the canonical per-100 g mass basis BEFORE any arithmetic.
 *
 * A per_100ml basis describes 100 ml, which weighs 100 x density grams, so the
 * per-100 g values are the declared values divided by density. Doing this once,
 * here, removes an entire class of serving-unit bugs from every caller.
 */
export function normalizeToPer100g(basis: NutrientBasis): NutrientBasis {
  if (basis.kind === 'per_100g') return basis;

  const density = basis.densityGPerMl;
  if (density === undefined || !Number.isFinite(density) || density <= 0) {
    throw new Error('normalizeToPer100g: a per_100ml basis requires a positive density');
  }
  const f = 1 / density;

  return {
    kind: 'per_100g',
    kcal: basis.kcal * f,
    proteinG: basis.proteinG * f,
    carbohydrateG: basis.carbohydrateG * f,
    fatG: basis.fatG * f,
    ...(basis.fiberG !== undefined ? { fiberG: basis.fiberG * f } : {}),
    ...(basis.sugarG !== undefined ? { sugarG: basis.sugarG * f } : {}),
    ...(basis.sodiumMg !== undefined ? { sodiumMg: basis.sodiumMg * f } : {}),
    ...(basis.saturatedFatG !== undefined ? { saturatedFatG: basis.saturatedFatG * f } : {}),
    ...(basis.alcoholG !== undefined ? { alcoholG: basis.alcoholG * f } : {}),
  };
}

/**
 * Scale a canonical per-100 basis to a consumed mass.
 *
 * PURE. No clock, no IO, no randomness. The only arithmetic that turns a
 * product plus a scale reading into nutrition — nothing else may compute this,
 * and the LLM has no path to it.
 */
export function calculateNutrition(
  basis: NutrientBasis,
  consumedGrams: Grams,
  calcVersion: string = NUTRITION_CALC_VERSION,
): NutritionResult {
  unwrap(validateNutrientBasis(basis));

  if (!Number.isFinite(consumedGrams) || consumedGrams < 0) {
    throw new Error('calculateNutrition: consumedGrams must be finite and non-negative');
  }

  // Always reduce to the mass basis first. The scale reports grams; everything
  // downstream is a linear scaling of a per-100 g basis.
  const massBasis = normalizeToPer100g(basis);
  const factor = consumedGrams / 100;

  const totals: NutritionTotals = {
    kcal: kcal(massBasis.kcal * factor),
    proteinG: grams(massBasis.proteinG * factor),
    carbohydrateG: grams(massBasis.carbohydrateG * factor),
    fatG: grams(massBasis.fatG * factor),
    ...(massBasis.fiberG !== undefined ? { fiberG: grams(massBasis.fiberG * factor) } : {}),
    ...(massBasis.sugarG !== undefined ? { sugarG: grams(massBasis.sugarG * factor) } : {}),
    ...(scaleOptional(massBasis.sodiumMg, factor) !== undefined
      ? { sodiumMg: massBasis.sodiumMg! * factor }
      : {}),
    ...(massBasis.saturatedFatG !== undefined
      ? { saturatedFatG: grams(massBasis.saturatedFatG * factor) }
      : {}),
    ...(massBasis.alcoholG !== undefined ? { alcoholG: grams(massBasis.alcoholG * factor) } : {}),
  };

  return {
    totals,
    consumedGrams,
    basisKind: basis.kind,
    calcVersion,
  };
}

/**
 * Convert a measured volume to mass using the product's declared density.
 * A per_100ml basis is reduced to the mass basis before any arithmetic.
 */
export function volumeToGrams(millilitres: number, densityGPerMl: number): Grams {
  if (!Number.isFinite(millilitres) || millilitres < 0) {
    throw new Error('volumeToGrams: millilitres must be finite and non-negative');
  }
  if (!Number.isFinite(densityGPerMl) || densityGPerMl <= 0) {
    throw new Error('volumeToGrams: density must be greater than zero');
  }
  return grams(millilitres * densityGPerMl);
}

/** Sum log-item nutrition into day totals. Order-independent by construction. */
export function sumNutrition(items: readonly NutritionTotals[]): NutritionTotals {
  let k = 0, p = 0, c = 0, f = 0, fib = 0, sug = 0, sod = 0, sat = 0, alc = 0;
  let hasFib = false, hasSug = false, hasSod = false, hasSat = false, hasAlc = false;

  for (const it of items) {
    k += it.kcal; p += it.proteinG; c += it.carbohydrateG; f += it.fatG;
    if (it.fiberG !== undefined) { fib += it.fiberG; hasFib = true; }
    if (it.sugarG !== undefined) { sug += it.sugarG; hasSug = true; }
    if (it.sodiumMg !== undefined) { sod += it.sodiumMg; hasSod = true; }
    if (it.saturatedFatG !== undefined) { sat += it.saturatedFatG; hasSat = true; }
    if (it.alcoholG !== undefined) { alc += it.alcoholG; hasAlc = true; }
  }

  return {
    kcal: kcal(k),
    proteinG: grams(p),
    carbohydrateG: grams(c),
    fatG: grams(f),
    ...(hasFib ? { fiberG: grams(fib) } : {}),
    ...(hasSug ? { sugarG: grams(sug) } : {}),
    ...(hasSod ? { sodiumMg: sod } : {}),
    ...(hasSat ? { saturatedFatG: grams(sat) } : {}),
    ...(hasAlc ? { alcoholG: grams(alc) } : {}),
  };
}
