import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  KNOWN_SOURCES,
  buildProductCard,
  buildSearchProjection,
  canonicalSourceKind,
  fingerprintOf,
  lookupByIdentifier,
  trustLabelFor,
  type CatalogSourceDefinition,
} from '@macros/domain-catalog';
import { searchFood } from '@macros/domain-food-search';
import {
  SYNTHETIC_BRANDED_ALIASES,
  SYNTHETIC_BRANDED_HEADS,
  SYNTHETIC_BRANDED_PRODUCTS,
  SYNTHETIC_CATALOG_HEADS,
  SYNTHETIC_PRODUCTS,
} from '@macros/testkit';

/** §49 — every question the milestone required be answered, as a check. */

describe('§49 — can another provider masquerade as USDA?', () => {
  test('a foreign provider with a USDA-looking dataType is refused', () => {
    const impostor = {
      sourceKey: 'someone.else', provider: 'in_house_curation', dataType: 'foundation_foods',
      releaseId: 'r1', licenseClass: 'owned_in_house', attribution: '',
      publicationScope: 'production_allowed', nutritionEvidence: 'curated_database',
    } as unknown as CatalogSourceDefinition;
    assert.throws(() => canonicalSourceKind(impostor), /unknown provider\/dataType/);
  });

  test('source kind comes from the validated provider AND dataType together', () => {
    const usda = KNOWN_SOURCES.find((s) => s.dataType === 'foundation_foods')!;
    assert.equal(canonicalSourceKind(usda), 'usda_foundation');
  });
});

describe('§49 — can licence permission imply nutrition verification?', () => {
  test('the two axes are separate fields with separate meanings', () => {
    for (const s of KNOWN_SOURCES) {
      assert.ok(s.publicationScope !== undefined, 'legal use is its own axis');
      assert.ok(s.nutritionEvidence !== undefined, 'evidence quality is its own axis');
      assert.notEqual(
        String(s.publicationScope),
        String(s.nutritionEvidence),
        'the two must not be the same value space',
      );
    }
  });

  test('an authoritative database is never presented as manufacturer-verified', () => {
    const usda = KNOWN_SOURCES.find((s) => s.dataType === 'sr_legacy')!;
    assert.equal(usda.nutritionEvidence, 'authoritative_database');
    assert.equal(trustLabelFor(usda.nutritionEvidence), 'database');
    assert.notEqual(trustLabelFor(usda.nutritionEvidence), 'manufacturer');
  });
});

describe('§49 — can a malformed barcode select a product?', () => {
  test('a bad check digit never reaches the catalog index', () => {
    const index = [{ normalizedValue: '00099000000011', productId: 'p', productVersionId: 'p@v1', state: 'current' as const }];
    const r = lookupByIdentifier('00099000000012', index);
    assert.equal(r.outcome, 'invalid_identifier');
  });

  test('a non-numeric string never resolves', () => {
    assert.equal(lookupByIdentifier('not-a-barcode', []).outcome, 'invalid_identifier');
  });
});

describe('§49 — can package or alias metadata create nutrition versions?', () => {
  const base = {
    displayName: 'Old Fashioned Oats', preparationState: 'as_sold',
    brandName: 'Demo Brand', variant: 'Original',
    per100g: { kcal: 375, proteinG: 12.5, carbohydrateG: 67.5, fatG: 7.5 },
    servingGrams: 40, servingLabelKcal: 150,
  };

  test('the fingerprint has no package or identifier input at all', () => {
    // Passing extra keys cannot change the fingerprint, because the function
    // reads a fixed set of FOOD FACTS.
    const withNoise = { ...base, packageDescriptor: '24 oz box', gtin: '00099000000011' } as typeof base;
    assert.equal(fingerprintOf(base), fingerprintOf(withNoise));
  });

  test('an alias edit changes only the search projection, not the version', () => {
    const before = buildSearchProjection({
      versions: SYNTHETIC_BRANDED_PRODUCTS, heads: SYNTHETIC_BRANDED_HEADS, aliasSets: SYNTHETIC_BRANDED_ALIASES,
    }).find((d) => d.productId === 'synb-oats-old-fashioned')!;
    const after = buildSearchProjection({
      versions: SYNTHETIC_BRANDED_PRODUCTS, heads: SYNTHETIC_BRANDED_HEADS,
      aliasSets: [{ productId: 'synb-oats-old-fashioned', aliases: ['porridge oats'], curatedBy: 'x', curatedAt: 'y' }],
    }).find((d) => d.productId === 'synb-oats-old-fashioned')!;
    assert.equal(after.productVersionId, before.productVersionId);
    assert.notDeepEqual(after.aliases, before.aliases);
  });
});

describe('§49 — can brand or variant changes collapse two products?', () => {
  test('two brands with the same product name stay distinct', () => {
    const a = { displayName: 'Greek Yogurt', preparationState: 'as_sold', brandName: 'Fjordly',
      per100g: { kcal: 59, proteinG: 10, carbohydrateG: 4, fatG: 0 } };
    const b = { ...a, brandName: 'Meadowline' };
    assert.notEqual(fingerprintOf(a), fingerprintOf(b));
  });

  test('two variants of one brand stay distinct in search', () => {
    const catalog = buildSearchProjection({
      versions: SYNTHETIC_BRANDED_PRODUCTS, heads: SYNTHETIC_BRANDED_HEADS, aliasSets: SYNTHETIC_BRANDED_ALIASES,
    });
    const ids = searchFood(catalog, { text: 'fjordly', limit: 4 }).map((r) => r.productVersion.productVersionId);
    assert.ok(ids.includes('synb-yogurt-nonfat@v1') && ids.includes('synb-yogurt-vanilla@v1'));
  });
});

describe('§49 — can generic and branded products collapse by name?', () => {
  test('they remain separate product versions with separate identities', () => {
    const catalog = buildSearchProjection({
      versions: [...SYNTHETIC_PRODUCTS, ...SYNTHETIC_BRANDED_PRODUCTS],
      heads: [...SYNTHETIC_CATALOG_HEADS, ...SYNTHETIC_BRANDED_HEADS],
      aliasSets: SYNTHETIC_BRANDED_ALIASES,
    });
    const ids = new Set(catalog.map((d) => d.productVersionId));
    assert.equal(ids.size, catalog.length, 'no two documents share a version id');
  });
});

describe('§49 — can a card display a fact the source never supplied?', () => {
  test('a card built from a version with no label invents nothing', () => {
    const generic = SYNTHETIC_PRODUCTS.find((p) => p.labelFacts === undefined) ?? SYNTHETIC_PRODUCTS[0]!;
    const card = buildProductCard({ version: generic, optionLabel: 'A', evidence: 'authoritative_database' });
    for (const [key, value] of Object.entries(card)) {
      if (value === undefined) continue;
      assert.ok(
        ['optionLabel', 'productId', 'productVersionId', 'productName', 'preparationState',
         'evidence', 'trustLabel', 'brandName', 'servingDescription', 'servingGrams',
         'labelKcal', 'labelProteinG', 'labelCarbohydrateG', 'labelFatG'].includes(key),
        `unexpected populated card field ${key}`,
      );
    }
    assert.equal(card.gtin, undefined);
    assert.equal(card.packageDescriptor, undefined);
    assert.equal(card.manufacturerName, undefined);
  });
});

describe('V-1 — declared label facts ARE part of version identity (gap closed)', () => {
  const base = {
    displayName: 'Old Fashioned Oats', preparationState: 'as_sold',
    brandName: 'Demo Brand', variant: 'Original',
    per100g: { kcal: 375, proteinG: 12.5, carbohydrateG: 67.5, fatG: 7.5 },
    servingDescription: '1/2 cup dry',
    servingGrams: 40,
    servingLabelKcal: 150,
    servingLabelProteinG: 5,
    servingLabelCarbohydrateG: 27,
    servingLabelFatG: 3,
  };

  test('serving mass and label energy remain covered', () => {
    assert.notEqual(fingerprintOf(base), fingerprintOf({ ...base, servingGrams: 45 }));
    assert.notEqual(fingerprintOf(base), fingerprintOf({ ...base, servingLabelKcal: 140 }));
  });

  test('CLOSED: a label-only protein correction now produces a new version', () => {
    // per-100 g unchanged; only the printed label protein was corrected.
    assert.notEqual(
      fingerprintOf(base),
      fingerprintOf({ ...base, servingLabelProteinG: 6 }),
      'a corrected label is a real product change',
    );
  });

  test('CLOSED: label carbohydrate and fat corrections produce a new version', () => {
    assert.notEqual(fingerprintOf(base), fingerprintOf({ ...base, servingLabelCarbohydrateG: 26 }));
    assert.notEqual(fingerprintOf(base), fingerprintOf({ ...base, servingLabelFatG: 2.5 }));
  });

  test('CLOSED: a changed household measure produces a new version', () => {
    assert.notEqual(
      fingerprintOf(base),
      fingerprintOf({ ...base, servingDescription: '1 cup dry' }),
      'the household measure changes what the label means',
    );
  });

  test('a product with NO declared label is unaffected', () => {
    const unlabelled = {
      displayName: 'Chicken breast, cooked', preparationState: 'cooked',
      per100g: { kcal: 165, proteinG: 31, carbohydrateG: 0, fatG: 3.6 },
    };
    assert.equal(fingerprintOf(unlabelled), fingerprintOf({ ...unlabelled }));
  });

  test('package descriptor and GTIN remain OUTSIDE version identity', () => {
    const noisy = { ...base, packageDescriptor: '24 oz box', gtin: '00099000000011' } as typeof base;
    assert.equal(fingerprintOf(base), fingerprintOf(noisy));
  });

  test('the fingerprint stays deterministic', () => {
    assert.equal(fingerprintOf(base), fingerprintOf({ ...base }));
  });
});
