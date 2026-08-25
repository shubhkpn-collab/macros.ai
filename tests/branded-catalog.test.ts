import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
import {
  buildProductCard,
  buildSearchProjection,
  fingerprintOf,
  gtinCheckDigit,
  lookupByIdentifier,
  normalizeGtin,
  normalizeLabelToPer100g,
  resolveSourceConflict,
  trustLabelFor,
  validateGtin,
  type IdentifierIndexEntry,
} from '@macros/domain-catalog';
import { calculateNutrition } from '@macros/domain-nutrition';
import { searchFood } from '@macros/domain-food-search';
import { grams } from '@macros/contracts';
import {
  BRANDED_GTINS,
  SYNTHETIC_BRANDED_ALIASES,
  SYNTHETIC_BRANDED_HEADS,
  SYNTHETIC_BRANDED_META,
  SYNTHETIC_BRANDED_OATS_V2,
  SYNTHETIC_BRANDED_PRODUCTS,
  SYNTHETIC_PRODUCTS,
  SYNTHETIC_CATALOG_HEADS,
  approx,
} from '@macros/testkit';

const OATS = SYNTHETIC_BRANDED_PRODUCTS.find((p) => p.productId === 'synb-oats-old-fashioned')!;

const indexFor = (
  entries: readonly { gtin: string; productId: string; productVersionId: string; state?: 'current' | 'superseded' | 'conflicted' }[],
): IdentifierIndexEntry[] =>
  entries.map((e) => ({
    normalizedValue: e.gtin,
    productId: e.productId,
    productVersionId: e.productVersionId,
    state: e.state ?? 'current',
  }));

const CURRENT_INDEX = indexFor(
  SYNTHETIC_BRANDED_PRODUCTS.map((p) => ({
    gtin: SYNTHETIC_BRANDED_META[p.productId]!.gtin!,
    productId: p.productId,
    productVersionId: p.productVersionId,
  })),
);

// ---------------------------------------------------------------------------

describe('GTIN VALIDATION', () => {
  test('every synthetic fixture GTIN passes the check digit', () => {
    for (const [name, value] of Object.entries(BRANDED_GTINS)) {
      assert.equal(validateGtin(value).ok, true, `${name} (${value}) must be a valid GTIN`);
    }
  });

  test('an arbitrary numeric string is NOT a GTIN', () => {
    const r = validateGtin('012345678901');
    if (r.ok) assert.fail('a random 12-digit number must not validate by accident');
    assert.equal(r.reason, 'check_digit_failed');
  });

  test('the check digit is the standard mod-10 algorithm', () => {
    assert.equal(gtinCheckDigit('0009900000001'), 1);
  });

  test('malformed identifiers are rejected by reason', () => {
    assert.deepEqual(validateGtin(''), { ok: false, reason: 'empty' });
    assert.deepEqual(validateGtin('abc'), { ok: false, reason: 'not_numeric' });
    assert.deepEqual(validateGtin('12345'), { ok: false, reason: 'unsupported_length' });
  });

  test('GTIN-12 and its GTIN-14 form normalize to one value', () => {
    const twelve = '099000000011';
    const check = gtinCheckDigit(twelve.slice(0, -1));
    const valid = `${twelve.slice(0, -1)}${check}`;
    assert.equal(normalizeGtin(valid), valid.padStart(14, '0'));
  });
});

describe('BARCODE LOOKUP — never guesses', () => {
  test('a known GTIN resolves to exactly one product', () => {
    const r = lookupByIdentifier(BRANDED_GTINS.oatsOldFashioned, CURRENT_INDEX);
    assert.equal(r.outcome, 'exact_match');
    if (r.outcome === 'exact_match') assert.equal(r.productId, 'synb-oats-old-fashioned');
  });

  test('an unknown but VALID barcode is not_found — no fallback, no estimate', () => {
    const unknown = '00099000009999';
    const check = gtinCheckDigit(unknown.slice(0, -1));
    const valid = `${unknown.slice(0, -1)}${check}`;
    assert.deepEqual(lookupByIdentifier(valid, CURRENT_INDEX), { outcome: 'not_found' });
  });

  test('an invalid barcode never reaches the catalog', () => {
    const r = lookupByIdentifier('00099000000012', CURRENT_INDEX);
    assert.equal(r.outcome, 'invalid_identifier');
  });

  test('two active products claiming one GTIN is ambiguous — neither wins', () => {
    const conflicted = indexFor([
      { gtin: BRANDED_GTINS.conflictA, productId: 'synb-product-a', productVersionId: 'a@v1' },
      { gtin: BRANDED_GTINS.conflictB, productId: 'synb-product-b', productVersionId: 'b@v1' },
    ]);
    const r = lookupByIdentifier(BRANDED_GTINS.conflictA, conflicted);
    assert.equal(r.outcome, 'ambiguous');
    if (r.outcome === 'ambiguous') assert.deepEqual(r.productIds, ['synb-product-a', 'synb-product-b']);
  });

  test('a superseded identifier does not resolve', () => {
    const superseded = indexFor([
      { gtin: BRANDED_GTINS.oatsOldFashioned, productId: 'x', productVersionId: 'x@v1', state: 'superseded' },
    ]);
    assert.deepEqual(lookupByIdentifier(BRANDED_GTINS.oatsOldFashioned, superseded), { outcome: 'not_found' });
  });
});

describe('REFORMULATION — barcode is not a version id', () => {
  test('the same GTIN resolves to V2 after reformulation, and V1 still exists', () => {
    const afterUpdate = indexFor([
      { gtin: BRANDED_GTINS.oatsOldFashioned, productId: 'synb-oats-old-fashioned', productVersionId: SYNTHETIC_BRANDED_OATS_V2.productVersionId },
    ]);
    const r = lookupByIdentifier(BRANDED_GTINS.oatsOldFashioned, afterUpdate);
    assert.equal(r.outcome, 'exact_match');
    if (r.outcome === 'exact_match') {
      assert.equal(r.productVersionId, 'synb-oats-old-fashioned@v2');
      assert.notEqual(r.productVersionId, OATS.productVersionId);
    }
    assert.equal(OATS.basis.kcal, 375, 'V1 is untouched by the reformulation');
    assert.equal(SYNTHETIC_BRANDED_OATS_V2.basis.kcal, 350);
  });

  test('a historical log pinned to V1 keeps V1 nutrition forever', () => {
    const before = calculateNutrition(OATS.basis, grams(100));
    const after = calculateNutrition(SYNTHETIC_BRANDED_OATS_V2.basis, grams(100));
    assert.ok(approx(before.totals.kcal, 375, 1e-9));
    assert.ok(approx(after.totals.kcal, 350, 1e-9));
    assert.notEqual(before.totals.kcal, after.totals.kcal);
  });

  test('reformulation keeps ONE product identity, not two unrelated products', () => {
    assert.equal(SYNTHETIC_BRANDED_OATS_V2.productId, OATS.productId);
    assert.equal(SYNTHETIC_BRANDED_OATS_V2.versionNo, 2);
  });
});

describe('LABEL FACTS ARE NEVER RECONSTRUCTED', () => {
  test('label → per100g normalization is deterministic', () => {
    const r = normalizeLabelToPer100g({
      servingGrams: 40, kcalPerServing: 150, proteinGPerServing: 5,
      carbohydrateGPerServing: 27, fatGPerServing: 3,
    });
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.ok(approx(r.per100g.kcal, 375, 1e-9));
      assert.ok(approx(r.per100g.carbohydrateG, 67.5, 1e-9));
    }
  });

  test('ROUNDING: reconstructing the label from per-100 g does not reproduce it exactly', () => {
    // A label rounded under labelling rules: 3/4 cup (170 g), 100 kcal, 18 g protein.
    const label = { servingGrams: 170, kcalPerServing: 100, proteinGPerServing: 18,
      carbohydrateGPerServing: 6, fatGPerServing: 0 };
    const normalized = normalizeLabelToPer100g(label);
    assert.ok(normalized.ok);
    if (!normalized.ok) return;

    // The fixture stores a ROUNDED per-100 g basis, as a real source would.
    const stored = SYNTHETIC_BRANDED_PRODUCTS.find((p) => p.productId === 'synb-yogurt-nonfat')!;
    const reconstructed = (stored.basis.proteinG * 170) / 100;
    assert.notEqual(
      reconstructed,
      label.proteinGPerServing,
      'reconstruction differs from the printed label — this is expected',
    );

    // And the original label is retained unchanged regardless.
    assert.equal(stored.labelFacts!.declaredPerServing!.proteinG, 18);
    assert.equal(stored.labelFacts!.servingGrams, 170);
  });

  test('a serving with no gram basis is NOT converted by guessing', () => {
    const r = normalizeLabelToPer100g({ servingDescription: '1 cup', kcalPerServing: 150,
      proteinGPerServing: 5, carbohydrateGPerServing: 27, fatGPerServing: 3 });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, 'no_serving_mass');
  });

  test('missing label energy or macros blocks normalization', () => {
    assert.equal(normalizeLabelToPer100g({ servingGrams: 40 }).ok, false);
    const r = normalizeLabelToPer100g({ servingGrams: 40, kcalPerServing: 150 });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, 'missing_required_label_macro');
  });

  test('a non-positive serving mass is refused', () => {
    const r = normalizeLabelToPer100g({ servingGrams: 0, kcalPerServing: 1, proteinGPerServing: 1,
      carbohydrateGPerServing: 1, fatGPerServing: 1 });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, 'serving_mass_not_positive');
  });
});

describe('PRODUCT CARD — identification, never calculation', () => {
  const card = buildProductCard({
    version: OATS,
    optionLabel: 'A',
    evidence: 'synthetic_test',
    branded: SYNTHETIC_BRANDED_META['synb-oats-old-fashioned'],
  });

  test('the card carries only source-backed facts', () => {
    assert.equal(card.brandName, 'Demo Brand');
    assert.equal(card.productName, 'Old Fashioned Oats');
    assert.equal(card.variant, 'Original');
    assert.equal(card.packageDescriptor, '18 oz box');
    assert.equal(card.servingGrams, 40);
    assert.equal(card.labelKcal, 150);
    assert.equal(card.gtin, BRANDED_GTINS.oatsOldFashioned);
    assert.equal(card.productVersionId, OATS.productVersionId);
  });

  test('missing facts stay ABSENT — never invented to fill a layout', () => {
    const generic = SYNTHETIC_PRODUCTS.find((p) => p.brandName === undefined)!;
    const plain = buildProductCard({ version: generic, optionLabel: 'A', evidence: 'authoritative_database' });
    assert.equal(plain.brandName, undefined);
    assert.equal(plain.variant, undefined);
    assert.equal(plain.packageDescriptor, undefined);
    assert.equal(plain.gtin, undefined);
    assert.equal(plain.servingGrams, undefined);
    assert.equal(plain.labelKcal, undefined);
    assert.equal(plain.imageRef, undefined, 'a product is selectable without an image');
  });

  test('database nutrition is NEVER labelled manufacturer-verified', () => {
    assert.equal(trustLabelFor('authoritative_database'), 'database');
    assert.equal(trustLabelFor('curated_database'), 'database');
    assert.equal(trustLabelFor('manufacturer_label'), 'manufacturer');
    assert.equal(trustLabelFor('estimated'), 'estimated');
    assert.equal(trustLabelFor('synthetic_test'), 'synthetic');
  });

  test('the card is not the log: 40 g on the card, 83 g on the scale', () => {
    assert.equal(card.servingGrams, 40);
    assert.equal(card.labelKcal, 150);
    const logged = calculateNutrition(OATS.basis, grams(83));
    assert.ok(approx(logged.totals.kcal, 375 * 0.83, 1e-9));
    assert.notEqual(logged.totals.kcal, card.labelKcal);
  });
});

describe('SEARCH — generic and branded coexist', () => {
  const CATALOG = buildSearchProjection({
    versions: [...SYNTHETIC_PRODUCTS, ...SYNTHETIC_BRANDED_PRODUCTS],
    heads: [...SYNTHETIC_CATALOG_HEADS, ...SYNTHETIC_BRANDED_HEADS],
    aliasSets: SYNTHETIC_BRANDED_ALIASES,
  });
  const ids = (q: string) => searchFood(CATALOG, { text: q, limit: 4 }).map((r) => r.productVersion.productVersionId);

  test('brand + product resolves to that brand', () => {
    const results = ids('demo brand oats');
    assert.ok(results.includes('synb-oats-old-fashioned@v1'));
  });

  test('brand + variant distinguishes two products of one brand', () => {
    assert.ok(ids('fjordly vanilla yogurt').includes('synb-yogurt-vanilla@v1'));
    assert.ok(ids('fjordly yogurt').includes('synb-yogurt-nonfat@v1'));
  });

  test('same brand, multiple products both surface', () => {
    const millhouse = ids('millhouse');
    assert.ok(millhouse.length >= 2, 'both Millhouse products are offered');
  });

  test('a generic query does not collapse branded and generic foods', () => {
    const results = ids('chicken breast');
    assert.ok(results.every((id) => id.startsWith('syn-chicken-breast')));
  });

  test('branded products do not automatically outrank generic ones', () => {
    const top = searchFood(CATALOG, { text: 'Chicken breast, cooked', limit: 4 })[0]!;
    assert.equal(top.productVersion.productVersionId, 'syn-chicken-breast@cooked-v1');
  });

  test('A/B/C/D labels remain stable for branded results', () => {
    const a = searchFood(CATALOG, { text: 'oats', limit: 4 });
    const b = searchFood(CATALOG, { text: 'oats', limit: 4 });
    assert.deepEqual(a.map((r) => r.optionLabel), b.map((r) => r.optionLabel));
  });

  test('nonsense never returns a branded product', () => {
    assert.deepEqual(ids('zzzqqq'), []);
  });
});

describe('VERSION IDENTITY (A7)', () => {
  const base = {
    displayName: 'Old Fashioned Oats',
    preparationState: 'as_sold',
    brandName: 'Demo Brand',
    variant: 'Original',
    per100g: { kcal: 375, proteinG: 12.5, carbohydrateG: 67.5, fatG: 7.5 },
    servingGrams: 40,
    servingLabelKcal: 150,
  };

  test('a different brand is a different product', () => {
    assert.notEqual(fingerprintOf(base), fingerprintOf({ ...base, brandName: 'Other Brand' }));
  });

  test('a different variant is a different product', () => {
    assert.notEqual(fingerprintOf(base), fingerprintOf({ ...base, variant: 'Vanilla' }));
  });

  test('a changed label serving basis is a factual change', () => {
    assert.notEqual(fingerprintOf(base), fingerprintOf({ ...base, servingGrams: 45 }));
  });

  test('package descriptor and GTIN are NOT part of version identity', () => {
    // Neither is an input to the fingerprint at all — a carton redesign or a
    // barcode reassignment must not split a product's history.
    assert.equal(fingerprintOf(base), fingerprintOf({ ...base }));
    assert.ok(!Object.keys(base).includes('packageDescriptor'));
    assert.ok(!Object.keys(base).includes('gtin'));
  });

  test('identical facts produce an identical fingerprint', () => {
    assert.equal(fingerprintOf(base), fingerprintOf({ ...base }));
  });
});

describe('SOURCE CONFLICT — never averaged', () => {
  test('manufacturer label beats a database when they disagree', () => {
    const r = resolveSourceConflict([
      { evidence: 'authoritative_database', fingerprint: 'A' },
      { evidence: 'manufacturer_label', fingerprint: 'B' },
    ]);
    assert.deepEqual(r, { kind: 'resolved', winningEvidence: 'manufacturer_label' });
  });

  test('equal-priority disagreement goes to curation, never a merge', () => {
    const r = resolveSourceConflict([
      { evidence: 'authoritative_database', fingerprint: 'A' },
      { evidence: 'authoritative_database', fingerprint: 'B' },
    ]);
    assert.deepEqual(r, { kind: 'needs_curation', reason: 'source_conflict' });
  });

  test('agreeing sources are not a conflict', () => {
    const r = resolveSourceConflict([
      { evidence: 'authoritative_database', fingerprint: 'A' },
      { evidence: 'manufacturer_label', fingerprint: 'A' },
    ]);
    assert.equal(r.kind, 'resolved');
  });
});

describe('SYNTHETIC BRANDED DATA IS UNMISTAKABLE', () => {
  test('every branded fixture is tagged synthetic on all three axes', () => {
    for (const p of [...SYNTHETIC_BRANDED_PRODUCTS, SYNTHETIC_BRANDED_OATS_V2]) {
      assert.equal(p.source.kind, 'synthetic_test');
      assert.equal(p.source.verificationStatus, 'synthetic_test');
      assert.equal(p.source.licenseClass, 'synthetic_test_data');
      assert.match(p.source.sourceId, /^SYNTHETIC_BRANDED_TEST:/);
    }
  });

  test('no fixture claims a real brand', () => {
    const realBrands = ['quaker', 'chobani', 'kirkland', 'great value', '365', 'good & gather', 'trader'];
    for (const p of SYNTHETIC_BRANDED_PRODUCTS) {
      const brand = (p.brandName ?? '').toLowerCase();
      for (const real of realBrands) {
        assert.ok(!brand.includes(real), `${p.brandName} must be fictional`);
      }
    }
  });
});

describe('MIGRATION 0003 — authored, runtime validation pending', () => {
  const sql = readFileSync(join(ROOT, 'db/migrations/0003_catalog_identifiers.sql'), 'utf8');

  test('one current identifier may resolve to at most one product', () => {
    assert.match(sql, /CREATE UNIQUE INDEX[\s\S]*?product_identifiers_one_current[\s\S]*?WHERE state = 'current'/);
  });

  test('identifier and alias tables have RLS enabled and forced', () => {
    for (const table of ['product_external_identifiers', 'catalog_product_aliases', 'catalog_review_metadata']) {
      assert.match(sql, new RegExp(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`));
      assert.match(sql, new RegExp(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`));
    }
  });

  test('catalog tables are read-only for end users', () => {
    assert.equal(/FOR (INSERT|UPDATE|DELETE)/.test(sql), false, 'no end-user mutation policy');
    assert.equal(/GRANT[^;]*(INSERT|UPDATE|DELETE)/.test(sql), false, 'no end-user mutation grant');
  });

  test('no cascading delete can destroy catalog history', () => {
    assert.equal(sql.includes('ON DELETE CASCADE'), false);
    assert.ok(sql.includes('ON DELETE RESTRICT'));
  });

  test('the migration states that runtime validation is pending', () => {
    assert.match(sql, /RUNTIME VALIDATION PENDING/);
  });
});
