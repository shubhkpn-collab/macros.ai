import type { CanonicalProductVersion } from './projection.js';

/**
 * BRANDED PRODUCT CARD DATA.
 *
 * Built from an authoritative ProductVersion. Internal source ids are never
 * consumer identity, and every figure shown is one the source supplied — an
 * absent label fact is absent on the card, not zero.
 */
export interface BrandedProductCard {
  readonly productVersionId: string;
  readonly displayName: string;
  readonly brandName: string | null;
  readonly subbrandName: string | null;
  readonly servingText: string | null;
  /** Only when the source gave a gram mass. mL is never converted. */
  readonly servingGrams: number | null;
  readonly per100g: Readonly<Record<string, { amount: number; unit: string }>>;
  readonly declaredLabelFacts: unknown | null;
  readonly hasIngredients: boolean;
  readonly ingredientsText: string | null;
  readonly hasBarcode: boolean;
  readonly discontinued: boolean;
}

export function brandedProductCard(v: CanonicalProductVersion): BrandedProductCard {
  return {
    productVersionId: v.productVersionId,
    displayName: v.displayName,
    brandName: v.brandName ?? null,
    subbrandName: v.subbrandName ?? null,
    servingText: v.householdServingText,
    servingGrams: v.servingGrams,
    per100g: v.per100g,
    declaredLabelFacts: v.labelFacts ?? null,
    hasIngredients: typeof v.ingredientsText === 'string' && v.ingredientsText.length > 0,
    ingredientsText: v.ingredientsText ?? null,
    hasBarcode: typeof v.gtin14 === 'string' && v.gtin14.length > 0,
    discontinued: v.discontinued,
  };
}
