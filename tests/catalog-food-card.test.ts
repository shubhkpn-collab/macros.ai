import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import {
  fallbackImage, fallbackInitials, toFoodCard, type FoodImageRef,
} from '@macros/domain-catalog';
import { repoPath } from '../tools/repo-paths.js';

const version = (over: Record<string, unknown> = {}) => ({
  productId: 'p1',
  productVersionId: 'p1@v1',
  displayName: 'Chicken breast, cooked',
  preparationState: 'cooked',
  brandName: 'ACME',
  servingGrams: 140,
  householdServingText: '1 breast',
  per100g: {
    energy_kcal: { amount: 165, unit: 'kcal' },
    protein: { amount: 31, unit: 'g' },
    carbohydrate: { amount: 0, unit: 'g' },
    fat: { amount: 3.6, unit: 'g' },
  },
  source: { kind: 'usda_branded', sourceId: 'fdc:123', verificationStatus: 'published' },
  ...over,
}) as never;

describe('DATA-1 FOOD CARD — missing stays missing', () => {
  test('a complete record projects every field', () => {
    const card = toFoodCard(version());
    assert.equal(card.displayName, 'Chicken breast, cooked');
    assert.equal(card.brand.present, true);
    assert.equal(card.brand.value, 'ACME');
    assert.equal(card.kcal.value, 165);
    assert.equal(card.proteinG.value, 31);
    assert.equal(card.serving.grams, 140);
    assert.equal(card.serving.weighable, true);
    assert.equal(card.displayable, true);
  });

  test('a missing brand is EXPLICITLY absent, never an empty string', () => {
    const card = toFoodCard(version({ brandName: undefined }));
    assert.equal(card.brand.present, false);
    assert.equal(card.brand.value, null);
    assert.equal(card.brand.missingReason, 'not_in_source');
  });

  test('missing nutrition is never defaulted to zero', () => {
    // Zero is a real measurement. Rendering an unknown as 0 kcal would be a
    // fabricated claim the person could act on.
    const card = toFoodCard(version({ per100g: {} }));
    assert.equal(card.kcal.present, false);
    assert.equal(card.kcal.value, null);
    assert.notEqual(card.kcal.value, 0);
    assert.equal(card.displayable, false, 'no energy means not offerable');
  });

  test('a genuine zero is preserved as present', () => {
    const card = toFoodCard(version({
      per100g: {
        energy_kcal: { amount: 0 }, protein: { amount: 0 },
        carbohydrate: { amount: 0 }, fat: { amount: 0 },
      },
    }));
    assert.equal(card.kcal.present, true);
    assert.equal(card.kcal.value, 0);
    assert.equal(card.displayable, true, 'zero-calorie foods are real');
  });

  test('an implausible record is retained but not displayable', () => {
    // The catalog keeps the authoritative row; the product simply does not
    // offer it as a choice.
    const card = toFoodCard(version({
      per100g: { energy_kcal: { amount: 5000 }, protein: { amount: 1 },
        carbohydrate: { amount: 1 }, fat: { amount: 1 } },
    }));
    assert.equal(card.kcal.value, 5000, 'the source value is not rewritten');
    assert.equal(card.displayable, false);
  });

  test('a serving without grams is not weighable', () => {
    const card = toFoodCard(version({ servingGrams: undefined }));
    assert.equal(card.serving.weighable, false);
    assert.equal(card.serving.grams, null);
    assert.equal(card.serving.householdText, '1 breast', 'label text survives');
  });

  test('provenance travels with the card', () => {
    const card = toFoodCard(version());
    assert.equal(card.provenance.kind, 'usda_branded');
    assert.equal(card.provenance.sourceId, 'fdc:123');
    assert.equal(card.provenance.verificationStatus, 'published');
  });

  test('the card computes nothing', () => {
    const src = readFileSync(
      repoPath('packages', 'domain-catalog', 'src', 'food-card.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const q of ['kcal', 'proteinG', 'carbohydrateG', 'fatG']) {
      const arith = new RegExp(`\\b${q}\\b\\s*[*/+]\\s*\\w`);
      assert.equal(arith.test(src), false, `food-card computes ${q}`);
    }
  });
});

describe('DATA-1 IMAGE ARCHITECTURE — metadata only', () => {
  test('a food with no image gets a deterministic fallback', () => {
    const a = fallbackImage('p1');
    const b = fallbackImage('p1');
    assert.deepEqual(a, b, 'the same food must render identically every time');
    assert.equal(a.kind, 'fallback');
    assert.equal(a.status, 'none');
    assert.equal(a.url, null);
  });

  test('fallback initials are stable and derived from the name alone', () => {
    assert.equal(fallbackInitials('Chicken breast'), 'CB');
    assert.equal(fallbackInitials('Banana'), 'BA');
    assert.equal(fallbackInitials('  '), '?');
    assert.equal(fallbackInitials('Greek yogurt'), fallbackInitials('Greek yogurt'));
  });

  test('an image reference carries provenance and licence', () => {
    const ref: FoodImageRef = {
      foodId: 'p1', url: 'https://cdn.example/p1.jpg', source: 'usda',
      externalSourceId: 'fdc:123', kind: 'product', status: 'available',
      licence: 'public-domain', attribution: 'USDA FoodData Central',
      verifiedAt: '2026-08-28T00:00:00.000Z',
    };
    assert.equal(ref.licence, 'public-domain');
    assert.equal(ref.status, 'available');
  });

  test('NO image binary column exists in any migration', () => {
    // Images are large, immutable and CDN-shaped; storing bytes would bloat
    // every backup and replica for data a URL already addresses.
    const dir = repoPath('db', 'migrations');
    for (const f of ['0001_core_schema.sql', '0003_catalog_identifiers.sql']) {
      const p = repoPath('db', 'migrations', f);
      if (!existsSync(p)) continue;
      const sql = readFileSync(p, 'utf8').toLowerCase();
      for (const banned of ['bytea', 'blob', 'image_data', 'image_bytes']) {
        assert.equal(sql.includes(banned), false, `${f} stores image binary: ${banned}`);
      }
    }
    void dir;
  });
});

describe('DATA-1 AUDIT ARTIFACTS — measured, not asserted', () => {
  const audit = () => JSON.parse(
    readFileSync(repoPath('data', 'catalog-audit.json'), 'utf8'));

  test('the audit reflects the real catalog scale', () => {
    const a = audit();
    assert.equal(a.branded.products, 434714);
    assert.equal(a.generic.total, 6877);
    assert.ok(a.branded.currentVersions > 400000);
  });

  test('nutrition coverage is complete where the audit claims it', () => {
    const a = audit();
    assert.equal(a.branded.percentWithKcal, 100);
    assert.equal(a.generic.percentWithKcal, 100);
  });

  test('serving-gram coverage is reported honestly, not rounded up', () => {
    const a = audit();
    // ~63%: the real gap, and the reason manual weight entry matters.
    assert.ok(a.branded.percentWithServingGrams < 70);
    assert.ok(a.branded.percentWithServingGrams > 55);
  });

  test('problem records are reported, not silently dropped', () => {
    const a = audit();
    assert.ok(a.branded.problems.energy_macro_disagreement > 0);
    assert.ok(a.branded.displayable < a.branded.currentVersions,
      'if nothing were excluded the audit would not be measuring anything');
  });

  test('the search benchmark records real weaknesses', () => {
    const b = JSON.parse(readFileSync(repoPath('data', 'search-benchmark.json'), 'utf8'));
    assert.ok(b.searchableRecords > 400000);
    // SEARCH-1 expanded the corpus and renamed the category; misspellings
    // improved but remain the weakest area, and that must stay visible.
    assert.ok(b.corpusSize >= 250);
    assert.ok(b.byCategory.misspelling.top1 < b.byCategory.misspelling.n,
      'misspelling handling is a known gap and must stay visible');
  });
});
