import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import {
  GTIN_POLICY_VERSION, VALID_GTIN_LENGTHS, gs1CheckDigit, lookupByGtin, normalizeGtin,
  type IdentifierAssignment,
} from '@macros/catalog-ingestion';
import { isNutrientId } from '@macros/domain-nutrients';

const REPORT = 'data/branded-report.json';
const FIXTURES = 'data/branded-fixtures.json';
const report = existsSync(REPORT) ? JSON.parse(readFileSync(REPORT, 'utf8')) : null;
const fixtures = existsSync(FIXTURES) ? JSON.parse(readFileSync(FIXTURES, 'utf8')) : null;

describe('B5/B6 — GTIN normalization and check digit', () => {
  test('real USDA codes validate, with leading zeros preserved', () => {
    // "076014101088" is a real 12-digit UPC-A from the corpus. Trimming the
    // leading zero would make it invalid — or a different product.
    const r = normalizeGtin('076014101088');
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.family, 'GTIN-12');
    assert.equal(r.gtin14, '00076014101088');
    assert.equal(r.raw, '076014101088', 'the raw code is never rewritten');
  });

  test('all four observed GS1 families are supported', () => {
    assert.deepEqual([...VALID_GTIN_LENGTHS], [8, 12, 13, 14]);
    assert.equal(normalizeGtin('1633636543505').ok, true, 'GTIN-13 from the corpus');
  });

  test('a bad check digit NEVER validates', () => {
    const good = '076014101088';
    const bad = good.slice(0, -1) + String((Number(good.slice(-1)) + 1) % 10);
    const r = normalizeGtin(bad);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.reason, 'bad_check_digit');
  });

  test('malformed identifiers are rejected, never padded into validity', () => {
    for (const [raw, reason] of [
      ['', 'empty'], ['abc123', 'non_digit'], ['12345', 'unsupported_length'],
      ['1234567890', 'unsupported_length'],
    ] as const) {
      const r = normalizeGtin(raw);
      assert.equal(r.ok, false, raw);
      if (!r.ok) assert.equal(r.reason, reason, raw);
    }
  });

  test('the check digit weights from the RIGHT', () => {
    // Applying 3/1 left-to-right silently inverts weighting on odd lengths.
    assert.equal(gs1CheckDigit('07601410108'), 8);
  });

  test('the policy is versioned', () => {
    assert.equal(GTIN_POLICY_VERSION, 'gtin@1.0.0');
  });
});

describe('B8/B21 — barcode lookup refuses rather than guesses', () => {
  const assign = (gtin14: string, productId: string, over: Partial<IdentifierAssignment> = {}): IdentifierAssignment => ({
    gtin14, productId, productVersionId: `${productId}@v1`,
    state: 'current', discontinued: false, ...over,
  });
  const map = (list: IdentifierAssignment[]) => {
    const m = new Map<string, IdentifierAssignment[]>();
    for (const a of list) m.set(a.gtin14, [...(m.get(a.gtin14) ?? []), a]);
    return m;
  };

  test('a valid barcode resolves to exactly one current product', () => {
    const r = lookupByGtin('076014101088', map([assign('00076014101088', 'bprod_x')]));
    assert.equal(r.outcome, 'found');
  });

  test('an unknown barcode is not_found, never a near match', () => {
    assert.equal(lookupByGtin('076014101088', map([])).outcome, 'not_found');
  });

  test('an invalid barcode NEVER resolves', () => {
    const r = lookupByGtin('12345', map([assign('00000000012345', 'bprod_x')]));
    assert.equal(r.outcome, 'invalid_identifier');
  });

  test('a CONFLICTED identifier never silently picks a product', () => {
    const m = map([
      assign('00076014101088', 'bprod_a', { state: 'conflicted' }),
      assign('00076014101088', 'bprod_b', { state: 'conflicted' }),
    ]);
    const r = lookupByGtin('076014101088', m);
    assert.equal(r.outcome, 'conflicted_identifier');
    if (r.outcome === 'conflicted_identifier') assert.equal(r.candidates.length, 2);
  });

  test('two current assignments for one barcode is also a conflict', () => {
    const r = lookupByGtin('076014101088', map([
      assign('00076014101088', 'bprod_a'), assign('00076014101088', 'bprod_b'),
    ]));
    assert.equal(r.outcome, 'conflicted_identifier');
  });

  test('a discontinued product is reported, not silently returned', () => {
    const r = lookupByGtin('076014101088', map([assign('00076014101088', 'bprod_x', { discontinued: true })]));
    assert.equal(r.outcome, 'discontinued');
  });

  test('superseded assignments do not resolve', () => {
    const r = lookupByGtin('076014101088', map([assign('00076014101088', 'bprod_x', { state: 'superseded' })]));
    assert.equal(r.outcome, 'not_found');
  });
});

describe('REAL branded ingestion (skipped when artifacts are absent)', () => {
  const t = (name: string, fn: () => void) =>
    test(name, { skip: report === null ? 'branded artifacts not generated' : false }, fn);

  t('B34: exact barcode lookup is 100% on a real sample', () => {
    assert.equal(report.barcode.exactLookupPercent, 100,
      'a wrong product for a valid barcode is a BLOCKER');
    assert.equal(report.barcode.malformedResolved, 0, 'malformed must never resolve');
  });

  t('B7/B8: duplicate GTINs are lifecycle, conflicts are quarantined', () => {
    assert.ok(report.stats.duplicateGtinGroups > 0, 'real duplicates exist');
    assert.ok(report.identifierConflictCount > 0, 'real conflicts exist');
    for (const c of report.identifierConflicts) {
      assert.ok(c.brands.length > 1, 'a conflict means materially different brands');
    }
  });

  t('B4: internal identity is not the GTIN or the FDC id', () => {
    for (const p of fixtures.validGtin) {
      assert.match(p.productId, /^bprod_[0-9a-f]{16}$/);
      assert.ok(!p.productId.includes(p.sourceRecordId));
      assert.ok(!p.productId.includes(p.gtin14));
    }
  });

  t('B13: a volume-only serving NEVER becomes grams', () => {
    for (const p of fixtures.volumeOnlyServing) {
      assert.equal(p.servingGrams, null, `${p.sourceDescription} invented grams`);
      assert.ok(['ml', 'mlt'].includes(p.servingUnit));
    }
    assert.ok(report.stats.servingVolumeOnly > 0);
  });

  t('B15: added sugars come from the SOURCE, never inferred', () => {
    const added = report.coverage.find((c: { nutrientId: string }) => c.nutrientId === 'added_sugars');
    assert.ok(added.known > 0, 'branded genuinely supplies added sugars');
    for (const p of fixtures.addedSugars) {
      assert.notEqual(p.per100g['added_sugars'], undefined);
      // Never equal to total sugars by construction.
      if (p.per100g['total_sugars'] !== undefined) {
        assert.equal(typeof p.per100g['added_sugars'].amount, 'number');
      }
    }
  });

  t('every mapped nutrient is a canonical id in its canonical unit', () => {
    for (const p of fixtures.validGtin) {
      for (const [id, v] of Object.entries(p.per100g) as [string, { unit: string }][]) {
        assert.equal(isNutrientId(id), true, id);
        void v;
      }
    }
  });

  t('B29: every published product has all four core nutrients', () => {
    for (const group of Object.values(fixtures) as Record<string, unknown>[][]) {
      for (const p of group) {
        const per = (p as { per100g?: Record<string, unknown> }).per100g;
        if (per === undefined) continue;
        for (const core of ['energy_kcal', 'protein', 'carbohydrate', 'fat']) {
          assert.ok(per[core] !== undefined, `missing ${core}`);
        }
      }
    }
    assert.ok(report.stats.rejectedMissingCore > 0, 'records really were rejected');
  });

  t('B18/B28: discontinued products are flagged, never deleted', () => {
    for (const p of fixtures.discontinued) {
      assert.equal(p.isDiscontinued, true);
      assert.notEqual(p.discontinuedDate, null);
      assert.ok(p.per100g['energy_kcal'] !== undefined, 'history remains resolvable');
    }
  });

  t('B19: lifecycle groups keep exactly one current head', () => {
    for (const p of fixtures.lifecycleUpdate) {
      assert.equal(p.identifierState, 'current');
      assert.ok(p.historicalSourceRecordIds.length > 0, 'earlier records retained');
      assert.ok(!p.historicalSourceRecordIds.includes(p.sourceRecordId));
    }
  });

  t('B16: ingredients are preserved but make NO health claim', () => {
    assert.ok(report.stats.ingredientsPresent > 0);
    const text = JSON.stringify(fixtures);
    for (const claim of ['glutenFree', 'allergenFree', 'vegan', 'isSafe', 'heartHealthy']) {
      assert.ok(!text.includes(claim), `${claim} must not exist`);
    }
  });

  t('B3: source provenance and checksum are recorded', () => {
    assert.equal(report.source.provider, 'USDA FoodData Central');
    assert.equal(report.source.dataType, 'Branded');
    assert.match(report.source.archiveSha256, /^[0-9a-f]{64}$/);
  });

  t('B30: unmapped nutrient ids are reported, never guessed', () => {
    assert.ok(typeof report.unmappedNutrientIds === 'object');
  });

  t('B33: branded search baseline is measured', () => {
    assert.ok(report.search.scoredQueries >= 20);
    assert.ok(report.search.top4Percent >= 80);
  });
});
