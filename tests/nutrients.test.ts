import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  CORE_NUTRIENTS, DEFAULT_VISIBLE_NUTRIENTS, MAX_VISIBLE_NUTRIENTS, NUTRIENTS,
  aggregateDailyNutrients, buildNutrientMap, convertAmount, defaultViewPreferences,
  hasNutrient, isNutrientId, normalizeUnit, nutrientDefinition, nutrientDetails,
  nutrientValue, scaleNutrientMap, setVisibleNutrients, visibleFor, isMeasured,
  type NutrientMap, type RawNutrientReading,
} from '@macros/domain-nutrients';
import { fingerprintOf } from '@macros/domain-catalog';
import { USER_A, USER_B, approx } from '@macros/testkit';
import { DeterministicVoiceParser } from '@macros/domain-voice';
import { TOOL_REGISTRY, validateProposals } from '@macros/assistant-core';

const reading = (
  nutrientId: string, amount: number, unit: string, precedence = 0,
): RawNutrientReading => ({
  nutrientId: nutrientId as never,
  amount, unit, precedence,
  source: {
    sourceNutrientId: `usda-${nutrientId}`,
    sourceNutrientName: nutrientId,
    sourceUnit: unit,
    sourceAmount: amount,
  },
});

// ---------------------------------------------------------------------------

describe('B2 — canonical nutrient identity', () => {
  test('identity is a stable internal id, never a display name', () => {
    assert.equal(isNutrientId('vitamin_d'), true);
    assert.equal(isNutrientId('Vitamin D'), false, 'display strings are not identity');
    assert.equal(isNutrientId('1114'), false, 'a USDA id is not our identity');
    assert.equal(isNutrientId('made_up_nutrient'), false);
  });

  test('the registry covers the required product nutrient set', () => {
    for (const id of ['fiber', 'total_sugars', 'added_sugars', 'sodium', 'potassium',
                      'calcium', 'iron', 'magnesium', 'phosphorus', 'zinc', 'selenium',
                      'cholesterol', 'vitamin_a', 'vitamin_c', 'vitamin_d', 'vitamin_e',
                      'vitamin_k', 'thiamin', 'riboflavin', 'niacin', 'pantothenic_acid',
                      'vitamin_b6', 'folate', 'vitamin_b12', 'choline']) {
      assert.equal(isNutrientId(id), true, id);
    }
  });

  test('core nutrients remain exactly the energy/macro four', () => {
    assert.deepEqual([...CORE_NUTRIENTS].sort(),
      ['carbohydrate', 'energy_kcal', 'fat', 'protein']);
  });

  test('every nutrient declares exactly one canonical unit', () => {
    for (const n of NUTRIENTS) {
      assert.ok(['kcal', 'g', 'mg', 'ug', 'IU'].includes(n.unit), n.id);
      assert.equal(nutrientDefinition(n.id).unit, n.unit);
    }
  });
});

describe('B3 — unit authority', () => {
  test('mass conversions are exact and reversible', () => {
    const toG = convertAmount(1500, 'mg', 'g');
    assert.ok(toG.ok && approx(toG.amount, 1.5, 1e-9));
    const toMg = convertAmount(1.5, 'g', 'mg');
    assert.ok(toMg.ok && approx(toMg.amount, 1500, 1e-9));
    const toUg = convertAmount(2, 'mg', 'ug');
    assert.ok(toUg.ok && approx(toUg.amount, 2000, 1e-9));
  });

  test('mg is NEVER silently treated as g', () => {
    const r = convertAmount(1000, 'mg', 'g');
    assert.ok(r.ok);
    assert.notEqual(r.ok && r.amount, 1000, 'a real conversion happened');
  });

  test('kcal cannot be converted to a mass', () => {
    const r = convertAmount(100, 'kcal', 'g');
    assert.equal(r.ok, false);
  });

  test('IU is refused — the factor differs per substance', () => {
    assert.equal(convertAmount(400, 'IU', 'ug').ok, false);
    assert.equal(convertAmount(10, 'ug', 'IU').ok, false);
  });

  test('unit aliases normalize, unknown units do not', () => {
    assert.equal(normalizeUnit('µg'), 'ug');
    assert.equal(normalizeUnit('MCG'), 'ug');
    assert.equal(normalizeUnit('IU'), 'IU');
    assert.equal(normalizeUnit('cups'), null);
  });
});

describe('B4/B5 — source facts preserved, missing is not zero', () => {
  test('the original source fact survives canonicalization', () => {
    const { map } = buildNutrientMap([reading('sodium', 0.5, 'g')]);
    const sodium = map.sodium!;
    assert.equal(sodium.unit, 'mg');
    assert.ok(approx(sodium.amount, 500, 1e-9));
    assert.equal(sodium.source!.sourceUnit, 'g', 'the original unit is retained');
    assert.equal(sodium.source!.sourceAmount, 0.5);
    assert.equal(sodium.source!.conversion, 'g->mg');
  });

  test('an unreported nutrient is ABSENT, never zero', () => {
    const { map } = buildNutrientMap([reading('fiber', 3, 'g')]);
    assert.equal(hasNutrient(map, 'fiber'), true);
    assert.equal(hasNutrient(map, 'vitamin_d'), false);
    assert.equal(nutrientValue(map, 'vitamin_d'), null, 'null, not 0');
  });

  test('an unknown source nutrient is reported, not guessed', () => {
    const { map, issues } = buildNutrientMap([reading('unobtainium', 5, 'mg')]);
    assert.equal(Object.keys(map).length, 0);
    assert.equal(issues[0]!.kind, 'unknown_nutrient');
  });

  test('an unconvertible unit is a curation issue, never a silent value', () => {
    const { map, issues } = buildNutrientMap([reading('vitamin_d', 400, 'IU')]);
    assert.equal(hasNutrient(map, 'vitamin_d'), false);
    assert.equal(issues[0]!.kind, 'unit_conflict');
  });

  test('duplicate mappings resolve by precedence and REPORT disagreement', () => {
    const { map, issues } = buildNutrientMap([
      reading('total_sugars', 4, 'g', 0),
      reading('total_sugars', 9, 'g', 10),
    ]);
    assert.ok(approx(map.total_sugars!.amount, 9, 1e-9), 'higher precedence wins');
    assert.equal(issues[0]!.kind, 'duplicate_conflict');
  });

  test('agreeing duplicates raise no issue', () => {
    const { issues } = buildNutrientMap([
      reading('total_sugars', 4, 'g', 0),
      reading('total_sugars', 4, 'g', 10),
    ]);
    assert.equal(issues.length, 0);
  });

  test('a negative or non-finite amount is rejected', () => {
    const { issues } = buildNutrientMap([reading('iron', -1, 'mg'), reading('zinc', Number.NaN, 'mg')]);
    assert.equal(issues.length, 2);
    assert.ok(issues.every((i) => i.kind === 'invalid_amount'));
  });

  test('scaling to a consumed mass is proportional and keeps absence', () => {
    const { map } = buildNutrientMap([reading('fiber', 10, 'g'), reading('sodium', 200, 'mg')]);
    const scaled = scaleNutrientMap(map, 250);
    assert.ok(approx(scaled.fiber!.amount, 25, 1e-9));
    assert.ok(approx(scaled.sodium!.amount, 500, 1e-9));
    assert.equal(hasNutrient(scaled, 'vitamin_d'), false);
  });
});

describe('B9/B17 — daily aggregation exposes coverage', () => {
  const withFiber = (g: number): NutrientMap => buildNutrientMap([reading('fiber', g, 'g')]).map;
  const withoutFiber: NutrientMap = buildNutrientMap([reading('protein', 20, 'g')]).map;

  test('a nutrient reported by every food is complete', () => {
    const daily = aggregateDailyNutrients('2026-08-24', [withFiber(5), withFiber(13)]);
    const fiber = daily.totals.fiber!;
    assert.ok(approx(fiber.knownAmount, 18, 1e-9));
    assert.equal(fiber.complete, true);
    assert.equal(fiber.itemsWithData, 2);
  });

  test('PARTIAL coverage is visible, never presented as complete', () => {
    const daily = aggregateDailyNutrients('2026-08-24', [
      withFiber(5), withFiber(13), withFiber(0), withFiber(0), withoutFiber,
    ]);
    const fiber = daily.totals.fiber!;
    assert.equal(fiber.itemsWithData, 4);
    assert.equal(fiber.itemsTotal, 5);
    assert.equal(fiber.complete, false, '4 of 5 foods supplied fiber');
  });

  test('a nutrient no food reported does not appear as zero', () => {
    const daily = aggregateDailyNutrients('2026-08-24', [withFiber(5)]);
    assert.equal(daily.totals.vitamin_d, undefined, 'absent, not 0');
  });

  test('aggregation is from stored snapshots and order-independent', () => {
    const a = aggregateDailyNutrients('2026-08-24', [withFiber(5), withFiber(13)]);
    const b = aggregateDailyNutrients('2026-08-24', [withFiber(13), withFiber(5)]);
    assert.deepEqual(a.totals, b.totals);
  });

  test('an empty day yields no totals rather than zeroes', () => {
    const daily = aggregateDailyNutrients('2026-08-24', []);
    assert.equal(Object.keys(daily.totals).length, 0);
    assert.equal(daily.itemsTotal, 0);
  });
});

describe('B14/B15 — details and target separation', () => {
  const daily = aggregateDailyNutrients('2026-08-24', [
    buildNutrientMap([reading('fiber', 12, 'g')]).map,
    buildNutrientMap([reading('protein', 30, 'g')]).map,
  ]);

  test('with NO target, an amount is shown and no percentage is manufactured', () => {
    const [fiber] = nutrientDetails(daily, ['fiber']);
    assert.equal(fiber!.value.status, 'partial');
    if (isMeasured(fiber!.value)) assert.ok(approx(fiber!.value.amount, 12, 1e-9));
    assert.equal(fiber!.target, undefined);
    assert.equal(fiber!.progressPercent, undefined, 'no invented percentage');
  });

  test('an explicit target produces a percentage', () => {
    const [fiber] = nutrientDetails(daily, ['fiber'], {
      targets: { fiber: 30 }, policyVersion: 'explicit-user@1',
    });
    assert.equal(fiber!.target, 30);
    assert.equal(fiber!.progressPercent, 40);
  });

  test('A3: an unreported nutrient is UNAVAILABLE, never a numeric zero', () => {
    const [vitD] = nutrientDetails(daily, ['vitamin_d']);
    assert.equal(vitD!.value.status, 'unavailable');
    assert.equal('amount' in vitD!.value, false, 'there is no amount to misread as 0');
    assert.equal(vitD!.itemsWithData, 0);
    assert.equal(vitD!.target, undefined);
  });

  test('A3: a MEASURED zero is distinguishable from unreported', () => {
    // Every food reported Vitamin D, and every one reported 0.
    const measuredZero = aggregateDailyNutrients('2026-08-25', [
      buildNutrientMap([reading('vitamin_d', 0, 'ug')]).map,
      buildNutrientMap([reading('vitamin_d', 0, 'ug')]).map,
    ]);
    const [vitD] = nutrientDetails(measuredZero, ['vitamin_d']);
    assert.equal(vitD!.value.status, 'known', 'measured, complete');
    if (isMeasured(vitD!.value)) assert.equal(vitD!.value.amount, 0);
    assert.equal(vitD!.itemsWithData, 2);
  });

  test('A3: partial coverage is its own status, not silently complete', () => {
    const partial = aggregateDailyNutrients('2026-08-25', [
      buildNutrientMap([reading('vitamin_d', 2, 'ug')]).map,
      buildNutrientMap([reading('protein', 20, 'g')]).map,
    ]);
    const [vitD] = nutrientDetails(partial, ['vitamin_d']);
    assert.equal(vitD!.value.status, 'partial');
    assert.equal(vitD!.itemsWithData, 1);
    assert.equal(vitD!.itemsTotal, 2);
  });

  test('A3: an unavailable nutrient never receives a progress percentage', () => {
    const [vitD] = nutrientDetails(daily, ['vitamin_d'], {
      targets: { vitamin_d: 20 }, policyVersion: 'explicit@1',
    });
    assert.equal(vitD!.progressPercent, undefined, 'no percentage without a value');
  });
});

describe('B11/B12/B18 — user view preferences', () => {
  test('the default view is protein, carbs, fat, fiber', () => {
    assert.deepEqual([...DEFAULT_VISIBLE_NUTRIENTS], ['protein', 'carbohydrate', 'fat', 'fiber']);
    assert.deepEqual([...defaultViewPreferences(USER_A).visibleNutrients], ['protein', 'carbohydrate', 'fat', 'fiber']);
  });

  test('a user may add micronutrients', () => {
    const r = setVisibleNutrients(USER_A, ['protein', 'fiber', 'sodium', 'vitamin_d', 'vitamin_b12']);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.ok(r.preferences.visibleNutrients.includes('vitamin_b12'));
  });

  test('a user may hide fiber', () => {
    const r = setVisibleNutrients(USER_A, ['protein', 'carbohydrate', 'fat']);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.preferences.visibleNutrients.includes('fiber'), false);
  });

  test('hiding a nutrient does NOT stop it being tracked', () => {
    const daily = aggregateDailyNutrients('2026-08-24', [buildNutrientMap([reading('fiber', 12, 'g')]).map]);
    const hidden = setVisibleNutrients(USER_A, ['protein']);
    assert.equal(hidden.ok, true);
    // The data is still there; only the view changed.
    assert.ok(approx(daily.totals.fiber!.knownAmount, 12, 1e-9));
  });

  test('an unsupported nutrient string is rejected', () => {
    const r = setVisibleNutrients(USER_A, ['protein', 'unobtainium']);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.error.kind, 'unknown_nutrient');
  });

  test('selections are deduplicated', () => {
    const r = setVisibleNutrients(USER_A, ['protein', 'protein', 'fiber']);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.preferences.visibleNutrients.length, 2);
  });

  test('the visible list is bounded for a usable dashboard', () => {
    const many = NUTRIENTS.slice(0, MAX_VISIBLE_NUTRIENTS + 3).map((n) => n.id);
    const r = setVisibleNutrients(USER_A, many);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.error.kind, 'too_many');
  });

  test("B's preferences cannot affect A", () => {
    const b = setVisibleNutrients(USER_B, ['protein', 'sodium']);
    assert.equal(b.ok, true);
    if (!b.ok) return;
    // Deliberate miswiring: B's preferences handed to A's view resolution.
    assert.deepEqual([...visibleFor(USER_A, b.preferences)], [...DEFAULT_VISIBLE_NUTRIENTS]);
    assert.deepEqual([...visibleFor(USER_B, b.preferences)], ['protein', 'sodium']);
  });
});

describe('B8 — extended nutrients participate in version identity', () => {
  const base = {
    displayName: 'Test food', preparationState: 'raw',
    per100g: { kcal: 100, proteinG: 5, carbohydrateG: 10, fatG: 2 },
  };

  test('a fiber-only change produces a NEW version', () => {
    const v1 = fingerprintOf({ ...base, extended: { fiber: { amount: 3, unit: 'g' } } });
    const v2 = fingerprintOf({ ...base, extended: { fiber: { amount: 4, unit: 'g' } } });
    assert.notEqual(v1, v2);
  });

  test('sodium, Vitamin D and calcium changes each produce a new version', () => {
    for (const [id, unit] of [['sodium', 'mg'], ['vitamin_d', 'ug'], ['calcium', 'mg']] as const) {
      const a = fingerprintOf({ ...base, extended: { [id]: { amount: 10, unit } } });
      const b = fingerprintOf({ ...base, extended: { [id]: { amount: 11, unit } } });
      assert.notEqual(a, b, id);
    }
  });

  test('adding a newly reported nutrient produces a new version', () => {
    const before = fingerprintOf({ ...base, extended: { fiber: { amount: 3, unit: 'g' } } });
    const after = fingerprintOf({ ...base, extended: { fiber: { amount: 3, unit: 'g' }, vitamin_c: { amount: 2, unit: 'mg' } } });
    assert.notEqual(before, after);
  });

  test('key ORDER never changes the fingerprint', () => {
    const a = fingerprintOf({ ...base, extended: { fiber: { amount: 3, unit: 'g' }, sodium: { amount: 10, unit: 'mg' } } });
    const b = fingerprintOf({ ...base, extended: { sodium: { amount: 10, unit: 'mg' }, fiber: { amount: 3, unit: 'g' } } });
    assert.equal(a, b);
  });

  test('a food with no extended nutrients is unaffected', () => {
    assert.equal(fingerprintOf(base), fingerprintOf({ ...base }));
  });
});

describe('B20 — trusted assistant nutrient query', () => {
  test('the deterministic parser handles nutrient questions offline', () => {
    const parser = new DeterministicVoiceParser();
    const ask = (t: string) => parser.parse({ transcript: t, receivedAt: '2026-08-24T00:00:00.000Z', userId: USER_A });

    for (const [phrase, expected] of [
      ['how much fiber have I had today', 'fiber'],
      ['how much sodium have I had', 'sodium'],
      ['how much vitamin d have I had today', 'vitamin_d'],
      ['how much b12 have I had', 'vitamin_b12'],
    ] as const) {
      const r = ask(phrase);
      assert.equal(r.status, 'understood', phrase);
      if (r.status === 'understood' && r.intent.kind === 'ask_nutrient') {
        assert.equal(r.intent.nutrientId, expected, phrase);
      } else {
        assert.fail(`${phrase} did not parse as a nutrient query`);
      }
    }
  });

  test('core macro questions still route to macro state, not nutrient state', () => {
    const parser = new DeterministicVoiceParser();
    const r = parser.parse({ transcript: 'how much protein have I had', receivedAt: '2026-08-24T00:00:00.000Z', userId: USER_A });
    assert.equal(r.status, 'understood');
    if (r.status === 'understood') assert.equal(r.intent.kind, 'ask_consumed');
  });

  test('the model may name a nutrient but never supply the amount', () => {
    const base = {
      transcript: 'how much fiber today', appPhase: 'idle',
      optionLabels: [] as string[], optionDisplayNames: [] as string[],
      selectedDisplayName: null, hasWeightCapture: false,
      allowedActions: ['ask_nutrient'] as never,
    };
    const ok = validateProposals([{ intentKind: 'ask_nutrient', arguments: { nutrientId: 'fiber' } }], { input: base });
    assert.equal(ok.status, 'accepted');

    // An invented amount is refused as a nutrition field.
    const withAmount = validateProposals(
      [{ intentKind: 'ask_nutrient', arguments: { nutrientId: 'fiber', grams: 22 } }], { input: base },
    );
    assert.equal(withAmount.status, 'rejected');

    // An unsupported nutrient id is refused.
    const unknown = validateProposals(
      [{ intentKind: 'ask_nutrient', arguments: { nutrientId: 'unobtainium' } }], { input: base },
    );
    assert.equal(unknown.status, 'rejected');
    if (unknown.status === 'rejected') assert.equal(unknown.reason, 'invalid_nutrient');
  });

  test('ask_nutrient is registered read-only', () => {
    assert.equal(TOOL_REGISTRY['ask_nutrient'].stateChanging, false);
  });
});
