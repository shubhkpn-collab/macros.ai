import type { ProductCatalogHead, ProductVersion } from '@macros/contracts';
import type { PackageLabelFacts } from '@macros/domain-catalog';

/**
 * SYNTHETIC BRANDED TEST FIXTURES.
 *
 * FICTIONAL BRANDS AND FICTIONAL NUTRITION. These exist to exercise the branded
 * architecture. They are not real grocery products, they do not carry real
 * brand nutrition, and their GTINs are computed test values — not registered
 * barcodes belonging to any company.
 *
 * Every record is tagged `synthetic_test` in source kind, verification status
 * and licence class, so none can be mistaken for a licensed source.
 */
export const SYNTHETIC_BRANDED_MARKER = 'SYNTHETIC_BRANDED_TEST';

const AT = '2026-08-18T00:00:00.000Z' as ProductVersion['effectiveFrom'];

interface BrandedFixtureSpec {
  productId: string;
  versionId: string;
  versionNo?: number;
  brand: string;
  name: string;
  variant?: string;
  pkg?: string;
  gtin?: string;
  label?: PackageLabelFacts;
  per100g: { kcal: number; proteinG: number; carbohydrateG: number; fatG: number };
}

const version = (s: BrandedFixtureSpec): ProductVersion =>
  ({
    productId: s.productId,
    productVersionId: s.versionId,
    versionNo: s.versionNo ?? 1,
    displayName: s.name,
    brandName: s.brand,
    preparationState: 'as_sold',
    basis: { kind: 'per_100g', ...s.per100g },
    ...(s.label !== undefined
      ? {
          labelFacts: {
            ...(s.label.servingDescription !== undefined ? { servingLabel: s.label.servingDescription } : {}),
            ...(s.label.servingGrams !== undefined ? { servingGrams: s.label.servingGrams } : {}),
            ...(s.label.kcalPerServing !== undefined
              ? {
                  declaredPerServing: {
                    kcal: s.label.kcalPerServing,
                    proteinG: s.label.proteinGPerServing ?? 0,
                    carbohydrateG: s.label.carbohydrateGPerServing ?? 0,
                    fatG: s.label.fatGPerServing ?? 0,
                  },
                }
              : {}),
          },
        }
      : {}),
    source: {
      kind: 'synthetic_test',
      sourceId: `${SYNTHETIC_BRANDED_MARKER}:${s.productId}`,
      verificationStatus: 'synthetic_test',
      licenseClass: 'synthetic_test_data',
      releaseId: 'branded-fixture-2026-08',
      sourceFileHash: 'synthetic-branded-fixture',
    },
    effectiveFrom: AT,
  }) as ProductVersion;

/** Deterministic, obviously-fictional GTINs (prefix 099 reserved for fixtures). */
export const BRANDED_GTINS = {
  oatsOldFashioned: '00099000000011',
  oatsQuick: '00099000000028',
  yogurtNonfat: '00099000000035',
  yogurtVanilla: '00099000000042',
  breadWholegrain: '00099000000059',
  milkWhole: '00099000000066',
  proteinDrink: '00099000000073',
  frozenPeas: '00099000000080',
  crackers: '00099000000097',
  tomatoSauce: '00099000000103',
  conflictA: '00099000000110',
  conflictB: '00099000000110',
} as const;

const SPECS: BrandedFixtureSpec[] = [
  {
    productId: 'synb-oats-old-fashioned', versionId: 'synb-oats-old-fashioned@v1',
    brand: 'Demo Brand', name: 'Old Fashioned Oats', variant: 'Original', pkg: '18 oz box',
    gtin: BRANDED_GTINS.oatsOldFashioned,
    // Label rounds; per-100 g does not. Reconstruction will NOT reproduce these
    // exactly, which is the point of retaining both.
    label: { servingDescription: '1/2 cup dry', servingGrams: 40, servingsPerContainer: 13,
      netQuantityDescription: '18 oz box', kcalPerServing: 150, proteinGPerServing: 5,
      carbohydrateGPerServing: 27, fatGPerServing: 3 },
    per100g: { kcal: 375, proteinG: 12.5, carbohydrateG: 67.5, fatG: 7.5 },
  },
  {
    productId: 'synb-oats-quick', versionId: 'synb-oats-quick@v1',
    brand: 'Demo Brand', name: 'Quick 1-Minute Oats', variant: 'Original', pkg: '18 oz box',
    gtin: BRANDED_GTINS.oatsQuick,
    label: { servingDescription: '1/2 cup dry', servingGrams: 40, kcalPerServing: 150,
      proteinGPerServing: 5, carbohydrateGPerServing: 27, fatGPerServing: 3 },
    per100g: { kcal: 375, proteinG: 12.5, carbohydrateG: 67.5, fatG: 7.5 },
  },
  {
    productId: 'synb-yogurt-nonfat', versionId: 'synb-yogurt-nonfat@v1',
    brand: 'Fjordly', name: 'Nonfat Greek Yogurt', variant: 'Plain', pkg: '32 oz tub',
    gtin: BRANDED_GTINS.yogurtNonfat,
    label: { servingDescription: '3/4 cup', servingGrams: 170, kcalPerServing: 100,
      proteinGPerServing: 18, carbohydrateGPerServing: 6, fatGPerServing: 0 },
    per100g: { kcal: 58.8, proteinG: 10.6, carbohydrateG: 3.5, fatG: 0 },
  },
  {
    productId: 'synb-yogurt-vanilla', versionId: 'synb-yogurt-vanilla@v1',
    brand: 'Fjordly', name: 'Low Fat Greek Yogurt', variant: 'Vanilla', pkg: '5.3 oz cup',
    gtin: BRANDED_GTINS.yogurtVanilla,
    label: { servingDescription: '1 cup', servingGrams: 150, kcalPerServing: 140,
      proteinGPerServing: 12, carbohydrateGPerServing: 17, fatGPerServing: 2.5 },
    per100g: { kcal: 93.3, proteinG: 8, carbohydrateG: 11.3, fatG: 1.7 },
  },
  {
    productId: 'synb-bread-wholegrain', versionId: 'synb-bread-wholegrain@v1',
    brand: 'Millhouse', name: 'Whole Grain Bread', pkg: '24 oz loaf',
    gtin: BRANDED_GTINS.breadWholegrain,
    label: { servingDescription: '1 slice', servingGrams: 43, kcalPerServing: 110,
      proteinGPerServing: 5, carbohydrateGPerServing: 20, fatGPerServing: 1.5 },
    per100g: { kcal: 255.8, proteinG: 11.6, carbohydrateG: 46.5, fatG: 3.5 },
  },
  {
    productId: 'synb-milk-whole', versionId: 'synb-milk-whole@v1',
    brand: 'Meadowline', name: 'Whole Milk', variant: 'Whole', pkg: '1 gallon',
    gtin: BRANDED_GTINS.milkWhole,
    label: { servingDescription: '1 cup', servingGrams: 240, servingMillilitres: 240,
      kcalPerServing: 150, proteinGPerServing: 8, carbohydrateGPerServing: 12, fatGPerServing: 8 },
    per100g: { kcal: 62.5, proteinG: 3.3, carbohydrateG: 5, fatG: 3.3 },
  },
  {
    productId: 'synb-protein-drink', versionId: 'synb-protein-drink@v1',
    brand: 'Pinnacle Fuel', name: 'Protein Shake', variant: 'Chocolate', pkg: '11 fl oz bottle',
    gtin: BRANDED_GTINS.proteinDrink,
    label: { servingDescription: '1 bottle', servingGrams: 330, kcalPerServing: 160,
      proteinGPerServing: 30, carbohydrateGPerServing: 5, fatGPerServing: 3 },
    per100g: { kcal: 48.5, proteinG: 9.1, carbohydrateG: 1.5, fatG: 0.9 },
  },
  {
    productId: 'synb-frozen-peas', versionId: 'synb-frozen-peas@v1',
    brand: 'Northfield', name: 'Frozen Sweet Peas', pkg: '16 oz bag',
    gtin: BRANDED_GTINS.frozenPeas,
    label: { servingDescription: '2/3 cup', servingGrams: 89, kcalPerServing: 70,
      proteinGPerServing: 5, carbohydrateGPerServing: 12, fatGPerServing: 0 },
    per100g: { kcal: 78.7, proteinG: 5.6, carbohydrateG: 13.5, fatG: 0 },
  },
  {
    productId: 'synb-crackers', versionId: 'synb-crackers@v1',
    brand: 'Millhouse', name: 'Sea Salt Crackers', variant: 'Sea Salt', pkg: '8 oz box',
    gtin: BRANDED_GTINS.crackers,
    label: { servingDescription: '16 crackers', servingGrams: 30, kcalPerServing: 130,
      proteinGPerServing: 3, carbohydrateGPerServing: 22, fatGPerServing: 3.5 },
    per100g: { kcal: 433.3, proteinG: 10, carbohydrateG: 73.3, fatG: 11.7 },
  },
  {
    productId: 'synb-tomato-sauce', versionId: 'synb-tomato-sauce@v1',
    brand: 'Orsino', name: 'Tomato Basil Sauce', variant: 'Basil', pkg: '24 oz jar',
    gtin: BRANDED_GTINS.tomatoSauce,
    label: { servingDescription: '1/2 cup', servingGrams: 125, kcalPerServing: 70,
      proteinGPerServing: 2, carbohydrateGPerServing: 11, fatGPerServing: 2 },
    per100g: { kcal: 56, proteinG: 1.6, carbohydrateG: 8.8, fatG: 1.6 },
  },
];

export const SYNTHETIC_BRANDED_PRODUCTS: readonly ProductVersion[] = SPECS.map(version);

/** V2 of the oats: a reformulation under the SAME GTIN. */
export const SYNTHETIC_BRANDED_OATS_V2: ProductVersion = version({
  productId: 'synb-oats-old-fashioned', versionId: 'synb-oats-old-fashioned@v2', versionNo: 2,
  brand: 'Demo Brand', name: 'Old Fashioned Oats', variant: 'Original', pkg: '18 oz box',
  gtin: BRANDED_GTINS.oatsOldFashioned,
  label: { servingDescription: '1/2 cup dry', servingGrams: 40, kcalPerServing: 140,
    proteinGPerServing: 5, carbohydrateGPerServing: 25, fatGPerServing: 2.5 },
  per100g: { kcal: 350, proteinG: 12.5, carbohydrateG: 62.5, fatG: 6.25 },
});

export const SYNTHETIC_BRANDED_HEADS: readonly ProductCatalogHead[] = SPECS.map((s) => ({
  productId: s.productId,
  currentProductVersionId: s.versionId,
  isActive: true,
  updatedAt: AT,
}));

/** Package descriptors and GTINs, kept OUTSIDE the immutable version (A7). */
export const SYNTHETIC_BRANDED_META: Readonly<
  Record<string, { packageDescriptor?: string; variant?: string; gtin?: string; manufacturerName?: string }>
> = Object.fromEntries(
  SPECS.map((s) => [
    s.productId,
    {
      ...(s.pkg !== undefined ? { packageDescriptor: s.pkg } : {}),
      ...(s.variant !== undefined ? { variant: s.variant } : {}),
      ...(s.gtin !== undefined ? { gtin: s.gtin } : {}),
    },
  ]),
);

export const SYNTHETIC_BRANDED_ALIASES = [
  { productId: 'synb-oats-old-fashioned', aliases: ['demo brand oats', 'old fashioned oats', 'rolled oats', 'oats'], curatedBy: 'engineering', curatedAt: '2026-08-18' },
  { productId: 'synb-oats-quick', aliases: ['demo brand quick oats', 'quick oats', 'instant oats', 'oats'], curatedBy: 'engineering', curatedAt: '2026-08-18' },
  { productId: 'synb-yogurt-nonfat', aliases: ['fjordly yogurt', 'greek yogurt', 'nonfat yogurt', 'yogurt'], curatedBy: 'engineering', curatedAt: '2026-08-18' },
  { productId: 'synb-yogurt-vanilla', aliases: ['fjordly vanilla yogurt', 'vanilla yogurt', 'yogurt'], curatedBy: 'engineering', curatedAt: '2026-08-18' },
  { productId: 'synb-protein-drink', aliases: ['protein shake', 'protein drink'], curatedBy: 'engineering', curatedAt: '2026-08-18' },
  { productId: 'synb-milk-whole', aliases: ['milk', 'whole milk'], curatedBy: 'engineering', curatedAt: '2026-08-18' },
  { productId: 'synb-bread-wholegrain', aliases: ['bread', 'whole grain bread'], curatedBy: 'engineering', curatedAt: '2026-08-18' },
  { productId: 'synb-crackers', aliases: ['crackers'], curatedBy: 'engineering', curatedAt: '2026-08-18' },
  { productId: 'synb-frozen-peas', aliases: ['peas', 'frozen peas'], curatedBy: 'engineering', curatedAt: '2026-08-18' },
  { productId: 'synb-tomato-sauce', aliases: ['tomato sauce', 'pasta sauce'], curatedBy: 'engineering', curatedAt: '2026-08-18' },
];
