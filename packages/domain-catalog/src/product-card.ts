import type { ProductVersion } from '@macros/contracts';
import type { NutritionEvidence } from './source-registry.js';

/**
 * GROCERY PRODUCT CARD — for IDENTIFICATION, not calculation.
 *
 * A card helps the user answer "which exact product is this?". It carries only
 * source-backed facts, and every field is absent when the source did not supply
 * it. Nothing here is ever computed, estimated or inferred.
 *
 * CRITICAL: the card may show "150 kcal per 40 g serving" while the scale reads
 * 83 g. The card is not the log. The log preview always comes from
 * `calculateNutrition(ProductVersion, capturedGrams)`.
 */
export interface GroceryProductCard {
  /** Stable spoken selection label. Voice will say "Option A". */
  readonly optionLabel: string;
  readonly productId: string;
  readonly productVersionId: string;

  readonly brandName?: string;
  readonly manufacturerName?: string;
  readonly productName: string;
  readonly variant?: string;
  readonly packageDescriptor?: string;
  readonly preparationState: string;

  /** Present only when the source declared a label. Never reconstructed. */
  readonly servingDescription?: string;
  readonly servingGrams?: number;
  readonly labelKcal?: number;
  readonly labelProteinG?: number;
  readonly labelCarbohydrateG?: number;
  readonly labelFatG?: number;

  /** Displayed only when a validated identifier exists. */
  readonly gtin?: string;

  readonly evidence: NutritionEvidence;
  readonly trustLabel: TrustLabel;
  /** Reserved so a card layout need not change when images arrive. */
  readonly imageRef?: string;
}

/**
 * Data-level trust classification, not final visual copy.
 *
 * A database record is NEVER labelled manufacturer-verified merely because its
 * source is authoritative or because it passed schema validation. Licence
 * permission and nutrition evidence are different axes and stay separate.
 */
export type TrustLabel = 'manufacturer' | 'database' | 'estimated' | 'synthetic';

export function trustLabelFor(evidence: NutritionEvidence): TrustLabel {
  switch (evidence) {
    case 'manufacturer_label': return 'manufacturer';
    case 'authoritative_database':
    case 'curated_database': return 'database';
    case 'estimated': return 'estimated';
    case 'synthetic_test': return 'synthetic';
  }
}

export interface CardProjectionInput {
  readonly version: ProductVersion;
  readonly optionLabel: string;
  readonly evidence: NutritionEvidence;
  readonly branded?:
    | {
        readonly manufacturerName?: string;
        readonly variant?: string;
        readonly packageDescriptor?: string;
        readonly gtin?: string;
      }
    | undefined;
}

/**
 * Build a card from canonical data.
 *
 * PURE. Absent facts stay absent — a card never invents a serving size, a
 * package descriptor, a brand or a barcode to fill a layout.
 */
export function buildProductCard(input: CardProjectionInput): GroceryProductCard {
  const v = input.version;
  const label = v.labelFacts;
  const b = input.branded;

  return {
    optionLabel: input.optionLabel,
    productId: v.productId,
    productVersionId: v.productVersionId,
    ...(v.brandName !== undefined ? { brandName: v.brandName } : {}),
    ...(b?.manufacturerName !== undefined ? { manufacturerName: b.manufacturerName } : {}),
    productName: v.displayName,
    ...(b?.variant !== undefined ? { variant: b.variant } : {}),
    ...(b?.packageDescriptor !== undefined ? { packageDescriptor: b.packageDescriptor } : {}),
    preparationState: v.preparationState,
    ...(label?.servingLabel !== undefined ? { servingDescription: label.servingLabel } : {}),
    ...(label?.servingGrams !== undefined ? { servingGrams: label.servingGrams } : {}),
    ...(label?.declaredPerServing !== undefined
      ? {
          labelKcal: label.declaredPerServing.kcal,
          labelProteinG: label.declaredPerServing.proteinG,
          labelCarbohydrateG: label.declaredPerServing.carbohydrateG,
          labelFatG: label.declaredPerServing.fatG,
        }
      : {}),
    ...(b?.gtin !== undefined ? { gtin: b.gtin } : {}),
    evidence: input.evidence,
    trustLabel: trustLabelFor(input.evidence),
  };
}
