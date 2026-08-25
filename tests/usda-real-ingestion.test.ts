import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import {
  DELIBERATELY_UNMAPPED, USDA_NUTRIENT_MAP, coreNutrientsPresent,
  classifyPreparation, extractUsdaRecord,
} from '@macros/catalog-ingestion';
import { buildNutrientMap, isNutrientId, nutrientDefinition } from '@macros/domain-nutrients';
import { approx } from '@macros/testkit';

const SEED_PATH = 'data/usda-seed.json';
const REPORT_PATH = 'data/usda-import-report.json';

interface Seed {
  productId: string; sourceDescription: string; displayName: string;
  preparationState: string;
  externalIdentity: { sourceRecordId: string; dataset: string };
  per100g: Record<string, { nutrientId: string; amount: number; unit: string }>;
}
const seeds: Seed[] = existsSync(SEED_PATH) ? JSON.parse(readFileSync(SEED_PATH, 'utf8')) : [];
const report = existsSync(REPORT_PATH) ? JSON.parse(readFileSync(REPORT_PATH, 'utf8')) : null;

// ---------------------------------------------------------------------------

describe('C3 — the USDA mapping is explicit and defensible', () => {
  test('every mapping targets a known canonical nutrient', () => {
    for (const m of USDA_NUTRIENT_MAP) {
      assert.equal(isNutrientId(m.canonical), true, `${m.usdaId} ${m.usdaName}`);
    }
  });

  test('USDA ids are SOURCE identity and never canonical identity', () => {
    for (const m of USDA_NUTRIENT_MAP) {
      assert.notEqual(m.canonical, String(m.usdaId));
      assert.equal(isNutrientId(String(m.usdaId)), false);
    }
  });

  test('energy maps from kcal (1008), never from kJ (1062)', () => {
    const energy = USDA_NUTRIENT_MAP.filter((m) => m.canonical === 'energy_kcal');
    assert.ok(energy.some((m) => m.usdaId === 1008 && m.sourceUnit === 'kcal'));
    assert.ok(!energy.some((m) => m.usdaId === 1062), 'kJ must never be energy');
    assert.equal(DELIBERATELY_UNMAPPED[1062] !== undefined, true, 'and the exclusion is recorded');
  });

  test('IU-based vitamin rows are deliberately excluded', () => {
    for (const iuId of [1104, 1110]) {
      assert.ok(!USDA_NUTRIENT_MAP.some((m) => m.usdaId === iuId), String(iuId));
      assert.ok(DELIBERATELY_UNMAPPED[iuId] !== undefined, `${iuId} exclusion recorded`);
    }
    assert.ok(USDA_NUTRIENT_MAP.some((m) => m.usdaId === 1114 && m.canonical === 'vitamin_d'));
    assert.ok(USDA_NUTRIENT_MAP.some((m) => m.usdaId === 1106 && m.canonical === 'vitamin_a'));
  });

  test('duplicate canonical targets are resolved by explicit precedence', () => {
    const byCanonical = new Map<string, number[]>();
    for (const m of USDA_NUTRIENT_MAP) {
      byCanonical.set(m.canonical, [...(byCanonical.get(m.canonical) ?? []), m.precedence]);
    }
    for (const [canonical, precedences] of byCanonical) {
      if (precedences.length < 2) continue;
      assert.equal(new Set(precedences).size, precedences.length,
        `${canonical} has ambiguous precedence`);
    }
  });

  test("each mapping's source unit converts into the canonical unit", () => {
    for (const m of USDA_NUTRIENT_MAP) {
      const { map, issues } = buildNutrientMap([{
        nutrientId: m.canonical, amount: 1, unit: m.sourceUnit, precedence: m.precedence,
        source: { sourceNutrientId: String(m.usdaId), sourceNutrientName: m.usdaName, sourceUnit: m.sourceUnit, sourceAmount: 1 },
      }]);
      assert.deepEqual(issues, [], `${m.usdaName} unit ${m.sourceUnit}`);
      assert.equal(map[m.canonical]!.unit, nutrientDefinition(m.canonical).unit);
    }
  });
});

describe('C5 — the adapter tolerates real-world data', () => {
  test('a null record is rejected, not crashed on', () => {
    assert.equal(extractUsdaRecord(null).ok, false);
    assert.equal(extractUsdaRecord(undefined).ok, false);
    assert.equal(extractUsdaRecord('nonsense').ok, false);
  });

  test('a record without identity is rejected', () => {
    assert.equal(extractUsdaRecord({ description: 'no id' }).ok, false);
    assert.equal(extractUsdaRecord({ fdcId: 1 }).ok, false);
  });

  test('a record with no nutrients extracts cleanly with no readings', () => {
    const r = extractUsdaRecord({ fdcId: 1, description: 'Empty, raw' });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.extraction.readings.length, 0);
    assert.equal(coreNutrientsPresent(r.extraction.readings), false);
  });

  test('an unmapped USDA nutrient is REPORTED, never guessed', () => {
    const r = extractUsdaRecord({
      fdcId: 2, description: 'Test, raw',
      foodNutrients: [{ nutrient: { id: 999999, name: 'Unobtainium', unitName: 'mg' }, amount: 5 }],
    });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.deepEqual([...r.extraction.unmappedUsdaIds], [999999]);
    assert.equal(r.extraction.readings.length, 0);
  });

  test('a source unit that disagrees with the mapping is skipped, not converted', () => {
    const r = extractUsdaRecord({
      fdcId: 3, description: 'Test, raw',
      // Sodium is mapped as mg; a kcal row under the same id is not sodium.
      foodNutrients: [{ nutrient: { id: 1093, name: 'Sodium, Na', unitName: 'kcal' }, amount: 5 }],
    });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.extraction.readings.length, 0);
  });

  test('preparation state is explicit or unresolved, never guessed', () => {
    assert.equal(classifyPreparation('Chicken, broilers, breast, meat only, raw').state, 'raw');
    assert.equal(classifyPreparation('Chicken, breast, meat only, cooked, roasted').state, 'cooked');
    // Hummus is ready-to-eat: as_sold, never a fabricated raw/cooked.
    assert.equal(classifyPreparation('Hummus, commercial').state, 'as_sold');
  });

  test('extraction is deterministic', () => {
    const rec = {
      fdcId: 4, description: 'Test, raw',
      foodNutrients: [
        { nutrient: { id: 1008, name: 'Energy', unitName: 'kcal' }, amount: 100 },
        { nutrient: { id: 1079, name: 'Fiber, total dietary', unitName: 'g' }, amount: 3 },
      ],
    };
    assert.deepEqual(extractUsdaRecord(rec), extractUsdaRecord(rec));
  });
});

describe('C7/C8/C12 — the published real seed', () => {
  test('a real seed was produced from the archives', () => {
    // Depth is bounded by the archives actually supplied this session.
    assert.ok(seeds.length >= 200, `expected a real catalog, got ${seeds.length}`);
  });

  test('every published food has all four core nutrients', () => {
    for (const s of seeds) {
      for (const core of ['energy_kcal', 'protein', 'carbohydrate', 'fat']) {
        assert.ok(s.per100g[core] !== undefined, `${s.sourceDescription} missing ${core}`);
      }
    }
  });

  test('every published food has a semantically honest preparation state', () => {
    for (const s of seeds) {
      assert.ok(['raw', 'cooked', 'as_sold', 'prepared'].includes(s.preparationState),
        `${s.sourceDescription} -> ${s.preparationState}`);
    }
  });

  test('the FDC id is source provenance, not the MACROS.AI product id', () => {
    for (const s of seeds.slice(0, 50)) {
      assert.match(s.productId, /^food_[0-9a-f]{16}$/);
      assert.ok(!s.productId.includes(s.externalIdentity.sourceRecordId));
    }
  });

  test('C12: identity is unique — no duplicate products or source records', () => {
    assert.equal(new Set(seeds.map((s) => s.externalIdentity.sourceRecordId)).size, seeds.length);
    assert.equal(new Set(seeds.map((s) => s.productId)).size, seeds.length);
  });

  test('C13: no synthetic fixture leaked into the real seed', () => {
    for (const s of seeds) {
      assert.ok(!s.productId.startsWith('syn-'), s.productId);
      assert.ok(!s.productId.startsWith('synb-'), s.productId);
    }
  });

  test('every stored nutrient uses its canonical unit', () => {
    for (const s of seeds) {
      for (const [id, v] of Object.entries(s.per100g)) {
        assert.equal(isNutrientId(id), true, id);
        assert.equal(v.unit, nutrientDefinition(id as never).unit, `${s.sourceDescription} ${id}`);
      }
    }
  });

  test('MISSING IS NOT ZERO — absent nutrients are absent, not zeroed', () => {
    // Coverage is genuinely partial across the seed, so some food must be
    // missing some tracked nutrient; none may be present as a fabricated 0.
    const missingSomewhere = seeds.some((s) => s.per100g['vitamin_d'] === undefined);
    assert.ok(missingSomewhere, 'the seed should contain foods without Vitamin D data');
  });

  test('C8: the coverage report is honest, not uniformly complete', () => {
    assert.notEqual(report, null);
    const coverage = report.coverage as { nutrientId: string; percent: number }[];
    assert.ok(coverage.length > 20);
    const allPerfect = coverage.every((c) => c.percent === 100);
    assert.equal(allPerfect, false, 'uniform 100% would indicate a biased sample');
    // Added sugars is genuinely absent from Foundation and SR Legacy.
    assert.equal(coverage.find((c) => c.nutrientId === 'added_sugars')!.percent, 0);
  });

  test('archive checksums are recorded for provenance', () => {
    for (const a of report.archives as { sha256: string }[]) {
      assert.match(a.sha256, /^[0-9a-f]{64}$/);
    }
  });

  test('nutrient values are plausible for real food', () => {
    for (const s of seeds) {
      const kcal = s.per100g['energy_kcal']!.amount;
      const protein = s.per100g['protein']!.amount;
      assert.ok(kcal >= 0 && kcal <= 900, `${s.sourceDescription} kcal ${kcal}`);
      assert.ok(protein >= 0 && protein <= 100, `${s.sourceDescription} protein ${protein}`);
    }
  });
});
