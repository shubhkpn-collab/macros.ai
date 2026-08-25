import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveTefProfile,
  grams,
  instant,
  validateNutrientBasis,
  validateUserProfile,
  validateWeightCapture,
  unwrap,
  type WeightCapture,
} from '@macros/contracts';
import { PROFILE_MALE_35, PROFILE_MALE_35_WITH_BODYFAT, TOFU_FIRM, approx } from '@macros/testkit';

describe('nutrient basis validation', () => {
  test('accepts a well-formed basis', () => {
    assert.equal(validateNutrientBasis(TOFU_FIRM).ok, true);
  });

  test('rejects a servable product with a missing macro', () => {
    const r = validateNutrientBasis({ ...TOFU_FIRM, proteinG: undefined as unknown as number });
    assert.equal(r.ok, false);
  });

  test('rejects negative and non-finite values', () => {
    assert.equal(validateNutrientBasis({ ...TOFU_FIRM, fatG: -1 }).ok, false);
    assert.equal(validateNutrientBasis({ ...TOFU_FIRM, kcal: Number.NaN }).ok, false);
  });

  test('rejects a volume basis with no density', () => {
    const r = validateNutrientBasis({ ...TOFU_FIRM, kind: 'per_100ml' });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error[0]?.path, 'densityGPerMl');
  });

  test('rejects a mass-balance impossibility', () => {
    const r = validateNutrientBasis({ kind: 'per_100g', kcal: 500, proteinG: 50, carbohydrateG: 50, fatG: 20 });
    assert.equal(r.ok, false);
  });
});

describe('user profile validation', () => {
  test('accepts a complete adult profile', () => {
    assert.equal(validateUserProfile(PROFILE_MALE_35).ok, true);
  });

  test('rejects an under-18 age — the product is 18+ only', () => {
    assert.equal(validateUserProfile({ ...PROFILE_MALE_35, ageYears: 16 as never }).ok, false);
  });

  test('rejects implausible height and weight', () => {
    assert.equal(validateUserProfile({ ...PROFILE_MALE_35, bodyWeightKg: 5 as never }).ok, false);
    assert.equal(validateUserProfile({ ...PROFILE_MALE_35, heightCm: 30 as never }).ok, false);
  });

  test('rejects an out-of-band body fat rather than clamping it', () => {
    assert.equal(validateUserProfile({ ...PROFILE_MALE_35, bodyFatPercent: 90 }).ok, false);
  });
});

describe('TEF profile derivation — ONE profile, not two', () => {
  test('derives from the same snapshot that produces BMR', () => {
    const t = deriveTefProfile(PROFILE_MALE_35_WITH_BODYFAT);
    assert.equal(t.ageYears, PROFILE_MALE_35_WITH_BODYFAT.ageYears);
    assert.equal(t.sex, PROFILE_MALE_35_WITH_BODYFAT.sex);
    assert.equal(t.bodyWeightKg, PROFILE_MALE_35_WITH_BODYFAT.bodyWeightKg);
    assert.equal(t.heightCm, PROFILE_MALE_35_WITH_BODYFAT.heightCm);
  });

  test('fat-free mass is present only when body fat is valid', () => {
    assert.equal(deriveTefProfile(PROFILE_MALE_35).fatFreeMassKg, undefined);
    const ffm = deriveTefProfile(PROFILE_MALE_35_WITH_BODYFAT).fatFreeMassKg;
    assert.ok(ffm !== undefined);
    // 80 kg at 18% body fat -> 65.6 kg lean. Tolerance, not bit equality:
    // (1 - 18/100) is not bit-identical to 0.82 in binary floating point.
    assert.ok(approx(ffm, 65.6, 1e-12), `expected 65.6, got ${ffm}`);
  });

  test('a body fat outside the valid band yields no fat-free mass', () => {
    const t = deriveTefProfile({ ...PROFILE_MALE_35, bodyFatPercent: 75 });
    assert.equal(t.fatFreeMassKg, undefined);
  });
});

describe('weight capture validation', () => {
  const now = '2026-08-11T16:00:00.000Z';
  const base: WeightCapture = {
    grams: grams(247),
    source: 'scale',
    capturedAt: instant('2026-08-11T15:59:50.000Z'),
    deviceId: 'scale-001',
    bootId: 'boot-0',
    sequence: 42,
    tareGeneration: 1,
    stabilityPolicyVersion: 'weight-stability@0.0.0-SYNTHETIC-PENDING-HARDWARE',
  };

  test('accepts a well-formed scale capture', () => {
    assert.equal(validateWeightCapture(base, { nowIso: now }).ok, true);
  });

  test('a food capture must be greater than zero, even though raw readings may drift negative', () => {
    assert.equal(validateWeightCapture({ ...base, grams: grams(0) }, { nowIso: now }).ok, false);
    assert.equal(validateWeightCapture({ ...base, grams: grams(-0.4) }, { nowIso: now }).ok, false);
  });

  test('rejects a non-finite weight', () => {
    assert.equal(validateWeightCapture({ ...base, grams: grams(Number.NaN) }, { nowIso: now }).ok, false);
  });

  test('rejects a weight beyond the nominal range', () => {
    assert.equal(validateWeightCapture({ ...base, grams: grams(9000) }, { nowIso: now }).ok, false);
  });

  test('rejects a stale scale capture', () => {
    const stale = { ...base, capturedAt: instant('2026-08-11T15:55:00.000Z') };
    assert.equal(validateWeightCapture(stale, { nowIso: now }).ok, false);
  });

  test('a scale capture requires device provenance', () => {
    const { deviceId, ...rest } = base;
    void deviceId;
    assert.equal(validateWeightCapture(rest as WeightCapture, { nowIso: now }).ok, false);
  });

  test('a scale capture requires its stability policy version', () => {
    const { stabilityPolicyVersion, ...rest } = base;
    void stabilityPolicyVersion;
    assert.equal(validateWeightCapture(rest as WeightCapture, { nowIso: now }).ok, false);
  });

  test('a manual capture needs no device provenance and never goes stale', () => {
    const manual: WeightCapture = {
      grams: grams(200),
      source: 'manual',
      capturedAt: instant('2026-08-11T10:00:00.000Z'),
    };
    assert.equal(validateWeightCapture(manual, { nowIso: now }).ok, true);
  });

  test('a manual capture may not claim stability provenance it did not have', () => {
    const dishonest: WeightCapture = {
      grams: grams(200),
      source: 'manual',
      capturedAt: instant('2026-08-11T10:00:00.000Z'),
      stabilityPolicyVersion: 'weight-stability@0.0.0-SYNTHETIC-PENDING-HARDWARE',
    };
    assert.equal(validateWeightCapture(dishonest, { nowIso: now }).ok, false);
  });

  test('manual and scale captures remain distinguishable', () => {
    assert.notEqual(base.source, 'manual');
  });
});

describe('unwrap', () => {
  test('throws with a readable message on invalid data', () => {
    assert.throws(
      () => unwrap(validateNutrientBasis({ ...TOFU_FIRM, fatG: -5 })),
      /Contract validation failed/,
    );
  });
});
