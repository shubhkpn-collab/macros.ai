import {
  instant,
  type ProductCatalogHead,
  type ProductVersion,
} from '@macros/contracts';

/**
 * SYNTHETIC TEST PRODUCTS — NOT COMMERCIAL CATALOG DATA.
 *
 * A handful of fixtures sufficient to exercise the logging architecture:
 * cooked protein, raw protein, carbohydrate, fat-dominant, a packaged label
 * product, and a volume/density case. Nutrition values are plausible but are
 * NOT verified catalog data and must never be presented as such.
 *
 * This is not the MVP catalog. No ingestion, no licensing, no images.
 */
const syntheticSource = (id: string) =>
  ({
    kind: 'synthetic_test' as const,
    sourceId: id,
    verificationStatus: 'synthetic_test' as const,
  });

const EFFECTIVE_FROM = instant('2026-01-01T00:00:00.000Z');

export const CHICKEN_BREAST_COOKED_V1: ProductVersion = {
  productId: 'syn-chicken-breast',
  productVersionId: 'syn-chicken-breast@cooked-v1',
  versionNo: 1,
  displayName: 'Chicken breast, cooked',
  preparationState: 'cooked',
  basis: { kind: 'per_100g', kcal: 165, proteinG: 31, carbohydrateG: 0, fatG: 3.6 },
  source: syntheticSource('synthetic:chicken-cooked'),
  effectiveFrom: EFFECTIVE_FROM,
};

/** Deliberately a SEPARATE version. Never yield-converted from the cooked one. */
export const CHICKEN_BREAST_RAW_V1: ProductVersion = {
  productId: 'syn-chicken-breast-raw',
  productVersionId: 'syn-chicken-breast-raw@raw-v1',
  versionNo: 1,
  displayName: 'Chicken breast, raw',
  preparationState: 'raw',
  basis: { kind: 'per_100g', kcal: 120, proteinG: 22.5, carbohydrateG: 0, fatG: 2.6 },
  source: syntheticSource('synthetic:chicken-raw'),
  effectiveFrom: EFFECTIVE_FROM,
};

export const WHITE_RICE_COOKED_V1: ProductVersion = {
  productId: 'syn-white-rice',
  productVersionId: 'syn-white-rice@cooked-v1',
  versionNo: 1,
  displayName: 'White rice, cooked',
  preparationState: 'cooked',
  basis: { kind: 'per_100g', kcal: 130, proteinG: 2.7, carbohydrateG: 28, fatG: 0.3 },
  source: syntheticSource('synthetic:rice'),
  effectiveFrom: EFFECTIVE_FROM,
};

export const ALMONDS_V1: ProductVersion = {
  productId: 'syn-almonds',
  productVersionId: 'syn-almonds@v1',
  versionNo: 1,
  displayName: 'Almonds',
  preparationState: 'as_sold',
  basis: { kind: 'per_100g', kcal: 579, proteinG: 21.2, carbohydrateG: 21.6, fatG: 49.9, fiberG: 12.5 },
  source: syntheticSource('synthetic:almonds'),
  effectiveFrom: EFFECTIVE_FROM,
};

export const FIRM_TOFU_PACKAGED_V1: ProductVersion = {
  productId: 'syn-firm-tofu',
  productVersionId: 'syn-firm-tofu@v1',
  versionNo: 1,
  displayName: 'Firm tofu',
  brandName: 'Synthetic Brand',
  preparationState: 'as_sold',
  basis: { kind: 'per_100g', kcal: 144, proteinG: 15.6, carbohydrateG: 3.9, fatG: 8.7, fiberG: 2.3, sodiumMg: 14 },
  // The declared label is retained verbatim and is NEVER reconstructed from
  // the normalized basis.
  labelFacts: {
    servingLabel: '1/5 block (85 g)',
    servingGrams: 85,
    ingredientsText: 'water, soybeans, calcium sulfate',
  },
  source: syntheticSource('synthetic:tofu'),
  effectiveFrom: EFFECTIVE_FROM,
};

/** Volume basis with density — exercises normalization to the mass basis. */
export const OLIVE_OIL_V1: ProductVersion = {
  productId: 'syn-olive-oil',
  productVersionId: 'syn-olive-oil@v1',
  versionNo: 1,
  displayName: 'Olive oil',
  preparationState: 'as_sold',
  basis: {
    kind: 'per_100ml',
    densityGPerMl: 0.916,
    kcal: 809.744,
    proteinG: 0,
    carbohydrateG: 0,
    fatG: 91.6,
  },
  source: syntheticSource('synthetic:olive-oil'),
  effectiveFrom: EFFECTIVE_FROM,
};

/**
 * A CORRECTED version of the cooked chicken product. Used to prove that an
 * existing log keeps the version and snapshot it was created with.
 */
export const CHICKEN_BREAST_COOKED_V2_CORRECTED: ProductVersion = {
  ...CHICKEN_BREAST_COOKED_V1,
  productVersionId: 'syn-chicken-breast@cooked-v2',
  versionNo: 2,
  basis: { kind: 'per_100g', kcal: 172, proteinG: 32, carbohydrateG: 0, fatG: 4.1 },
  effectiveFrom: instant('2026-06-01T00:00:00.000Z'),
};

export const SYNTHETIC_PRODUCTS: readonly ProductVersion[] = [
  CHICKEN_BREAST_COOKED_V1,
  CHICKEN_BREAST_RAW_V1,
  WHITE_RICE_COOKED_V1,
  ALMONDS_V1,
  FIRM_TOFU_PACKAGED_V1,
  OLIVE_OIL_V1,
];


/**
 * MUTABLE catalog state, separate from the immutable versions above.
 * A correction repoints the head; it never rewrites a version.
 */
export const SYNTHETIC_CATALOG_HEADS: readonly ProductCatalogHead[] = [
  {
    productId: 'syn-chicken-breast',
    currentProductVersionId: 'syn-chicken-breast@cooked-v1',
    isActive: true,
    updatedAt: instant('2026-01-01T00:00:00.000Z'),
  },
  {
    productId: 'syn-chicken-breast-raw',
    currentProductVersionId: 'syn-chicken-breast-raw@raw-v1',
    isActive: true,
    updatedAt: instant('2026-01-01T00:00:00.000Z'),
  },
  {
    productId: 'syn-white-rice',
    currentProductVersionId: 'syn-white-rice@cooked-v1',
    isActive: true,
    updatedAt: instant('2026-01-01T00:00:00.000Z'),
  },
  {
    productId: 'syn-almonds',
    currentProductVersionId: 'syn-almonds@v1',
    isActive: true,
    updatedAt: instant('2026-01-01T00:00:00.000Z'),
  },
  {
    productId: 'syn-firm-tofu',
    currentProductVersionId: 'syn-firm-tofu@v1',
    isActive: true,
    updatedAt: instant('2026-01-01T00:00:00.000Z'),
  },
  /**
   * DE-LISTED. The version stays resolvable by id — historical logs keep their
   * meaning forever — but it must never appear in search results again.
   */
  {
    productId: 'syn-olive-oil',
    currentProductVersionId: 'syn-olive-oil@v1',
    isActive: false,
    updatedAt: instant('2026-07-01T00:00:00.000Z'),
  },
];
