import { ATWATER, type NutrientBasis } from '@macros/contracts';

/**
 * Atwater consistency: declared energy should agree with energy implied by the
 * macros. Catches unit and parse errors in ingested catalog data.
 */
export interface AtwaterCheck {
  readonly declaredKcal: number;
  readonly impliedKcal: number;
  readonly absoluteDelta: number;
  readonly relativeDelta: number;
  readonly consistent: boolean;
}

export function checkAtwater(
  basis: NutrientBasis,
  tolerance = { relative: 0.1, absoluteKcal: 15 },
): AtwaterCheck {
  const implied =
    basis.proteinG * ATWATER.protein +
    basis.carbohydrateG * ATWATER.carbohydrate +
    basis.fatG * ATWATER.fat +
    (basis.alcoholG ?? 0) * ATWATER.alcohol;

  const absoluteDelta = Math.abs(basis.kcal - implied);
  const relativeDelta = basis.kcal > 0 ? absoluteDelta / basis.kcal : absoluteDelta > 0 ? 1 : 0;

  return {
    declaredKcal: basis.kcal,
    impliedKcal: implied,
    absoluteDelta,
    relativeDelta,
    consistent: absoluteDelta <= tolerance.absoluteKcal || relativeDelta <= tolerance.relative,
  };
}
