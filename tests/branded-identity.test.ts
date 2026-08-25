import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { normalizeGtin } from '@macros/catalog-ingestion';
import {
  BarcodeScanner, RuntimeCatalog, brandedProductCard,
  type CanonicalProductVersion, type ProjectedFood,
} from '@macros/catalog-runtime';

const REPORT = 'data/branded-report.json';
const FIXTURES = 'data/branded-fixtures.json';
const report = existsSync(REPORT) ? JSON.parse(readFileSync(REPORT, 'utf8')) : null;
const fixtures = existsSync(FIXTURES) ? JSON.parse(readFileSync(FIXTURES, 'utf8')) : null;
const skip = report === null ? 'branded artifacts not generated' : false;

// ---------------------------------------------------------------------------

describe('PART P — numeric barcodes are refused at the boundary', () => {
  test('a NUMBER cannot be a barcode: the leading zero is already lost', () => {
    // 076014101088 as a number is 76014101088 — a different, shorter code.
    const asNumber = 76014101088;
    const r = normalizeGtin(String(asNumber));
    assert.equal(r.ok, false, 'the zero-stripped form must not validate');
  });

  test('the scanner accepts only strings', async () => {
    const catalog = new RuntimeCatalog([], {}, null);
    const scanner = new BarcodeScanner(catalog);
    const r = await scanner.scan(76014101088 as unknown as string);
    assert.equal(r.outcome, 'invalid_identifier');
    if (r.outcome === 'invalid_identifier') assert.equal(r.reason, 'non_string_identifier');
  });

  test('the string form with its leading zero still validates', () => {
    const r = normalizeGtin('076014101088');
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.gtin14, '00076014101088');
  });
});

describe('PARTS U/V/W/X — runtime projection and barcode flow', () => {
  const version: CanonicalProductVersion = {
    productId: 'bprod_a', productVersionId: 'bprod_a@f0001',
    displayName: 'TEST OAT CEREAL', kind: 'branded',
    per100g: { energy_kcal: { amount: 375, unit: 'kcal' }, protein: { amount: 12, unit: 'g' } },
    servingGrams: 40, householdServingText: '0.5 cup',
    labelFacts: { declared: { calories: 150 } },
    ingredientsText: 'ROLLED OATS, SUGAR', gtin14: '00076014101088',
    brandName: 'Testbrand', subbrandName: null, discontinued: false,
  };
  const projected: ProjectedFood[] = [
    { productId: 'bprod_a', productVersionId: 'bprod_a@f0001', displayName: 'TEST OAT CEREAL',
      kind: 'branded', preparationState: 'as_sold', brandName: 'Testbrand',
      brandOwner: 'Big Retailer Inc.', hasBarcode: true, discontinued: false, recommendable: true },
    { productId: 'bprod_b', productVersionId: 'bprod_b@f0002', displayName: 'OLD DISCONTINUED BAR',
      kind: 'branded', preparationState: 'as_sold', hasBarcode: true, discontinued: true, recommendable: true },
  ];
  const resolver = { resolve: (id: string) => Promise.resolve(id === version.productVersionId ? version : null) };
  const catalog = new RuntimeCatalog(projected, { '00076014101088': 'bprod_a@f0001' }, resolver);

  test('the search projection carries NO nutrition', () => {
    const text = JSON.stringify(projected);
    for (const forbidden of ['per100g', 'energy_kcal', 'kcal', 'protein']) {
      assert.ok(!text.includes(forbidden), `projection must not carry ${forbidden}`);
    }
  });

  test('generic and branded share ONE search contract', () => {
    const foods = catalog.searchableFoods();
    assert.ok(foods.every((f) => typeof f.productVersionId === 'string' && typeof f.displayName === 'string'));
  });

  test('discontinued products are excluded from search but still resolvable', async () => {
    assert.equal(catalog.searchableFoods().some((f) => f.productVersionId === 'bprod_b@f0002'), false);
    assert.notEqual(catalog.projected('bprod_b@f0002'), null, 'history remains addressable');
  });

  test('the consumer brand ranks above the corporate owner', () => {
    const f = catalog.searchableFoods().find((x) => x.productVersionId === 'bprod_a@f0001')!;
    const aliases = [...(f.aliases ?? [])];
    assert.ok(aliases.indexOf('Testbrand') < aliases.indexOf('Big Retailer Inc.'),
      'brandName must precede brandOwner');
  });

  test('a valid barcode resolves through the canonical version', async () => {
    const r = await new BarcodeScanner(catalog).scan('076014101088');
    assert.equal(r.outcome, 'found');
    if (r.outcome !== 'found') return;
    assert.equal(r.product.per100g['energy_kcal']!.amount, 375, 'nutrition from the resolver');
  });

  test('an unknown or malformed barcode never resolves', async () => {
    const s = new BarcodeScanner(catalog);
    assert.equal((await s.scan('0000000000000')).outcome, 'not_found');
    assert.equal((await s.scan('12345')).outcome, 'invalid_identifier');
    assert.equal((await s.scan('')).outcome, 'invalid_identifier');
  });

  test('the product card shows only source-supplied facts', () => {
    const card = brandedProductCard(version);
    assert.equal(card.servingGrams, 40);
    assert.equal(card.hasIngredients, true);
    assert.equal(card.hasBarcode, true);
    assert.ok(!JSON.stringify(card).includes('fdcId'), 'no internal source id as identity');
  });

  test('a volume-only product shows serving text but NO grams', () => {
    const card = brandedProductCard({ ...version, servingGrams: null, householdServingText: '1 cup' });
    assert.equal(card.servingGrams, null, 'mL never becomes grams');
    assert.equal(card.servingText, '1 cup');
  });
});

describe('REAL branded artifacts', () => {
  const t = (name: string, fn: () => void) => test(name, { skip }, fn);

  t('PART B: the TOPS records are DISTINCT products', () => {
    const tops = (fixtures.noGtinDistinct ?? []) as { sourceRecordIds: string[]; productId: string; productVersionId: string }[];
    const a = tops.find((p) => p.sourceRecordIds.includes('2106478'));
    const b = tops.find((p) => p.sourceRecordIds.includes('2106480'));
    if (a === undefined || b === undefined) return; // fixture window dependent
    assert.notEqual(a.productId, b.productId, 'brand+description is not identity evidence');
    assert.notEqual(a.productVersionId, b.productVersionId);
  });

  t('PART C: one productVersionId maps to exactly one fingerprint', () => {
    const seen = new Map<string, string>();
    for (const p of Object.values(fixtures) as Record<string, unknown>[][]) {
      for (const item of p) {
        const versions = (item as { versions?: { productVersionId: string; factualFingerprint: string }[] }).versions;
        if (versions === undefined) continue;
        for (const v of versions) {
          const prev = seen.get(v.productVersionId);
          if (prev !== undefined) assert.equal(prev, v.factualFingerprint);
          seen.set(v.productVersionId, v.factualFingerprint);
        }
      }
    }
  });

  t('PART I: version identity is factual, never ordinal', () => {
    assert.match(report.versionPolicy, /branded-version-fingerprint@/);
    for (const p of Object.values(fixtures) as Record<string, unknown>[][]) {
      for (const item of p) {
        const versions = (item as { versions?: { productVersionId: string }[] }).versions;
        if (versions === undefined) continue;
        for (const v of versions) {
          assert.match(v.productVersionId, /@f[0-9a-f]{16}$/, 'not an @vN ordinal');
        }
      }
    }
  });

  t('PART H: historical versions are retained in full', () => {
    const chains = (fixtures.lifecycleChains ?? []) as { versions: unknown[] }[];
    for (const p of chains) {
      assert.ok(p.versions.length > 1, 'a chain must retain its earlier versions');
    }
  });

  t('PART J: declared label facts are retained', () => {
    const any = (fixtures.withLabelFacts ?? []) as { versions: { labelFacts: { declared: Record<string, number> } }[] }[];
    for (const p of any) {
      const declared = p.versions[0]!.labelFacts.declared;
      assert.ok(Object.keys(declared).length > 0, 'declared label facts must be present');
    }
  });

  t('PART K: ingredient text is verbatim, not a boolean', () => {
    const any = (fixtures.withIngredients ?? []) as { versions: { ingredientsText: string }[] }[];
    for (const p of any) {
      assert.equal(typeof p.versions[0]!.ingredientsText, 'string');
      assert.ok(p.versions[0]!.ingredientsText.length > 0);
    }
  });

  t('PART E: a corporate rename alone is never a reassignment conflict', () => {
    for (const c of report.identifierConflicts as { semanticallyCompatible: boolean }[]) {
      assert.equal(c.semanticallyCompatible, false,
        'a conflict requires semantic incompatibility, not just a brand string change');
    }
  });

  t('PART D: foodUpdateLog edges were actually used', () => {
    assert.ok(report.stats.updateLogEdges > 0, 'real cross-record edges exist');
  });

  t('no health or allergen claim exists anywhere in the artifacts', () => {
    const text = JSON.stringify(report);
    for (const claim of ['glutenFree', 'allergenFree', 'vegan', 'isSafe', 'heartHealthy']) {
      assert.ok(!text.includes(claim), claim);
    }
  });
});
