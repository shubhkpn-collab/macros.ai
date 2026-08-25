import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateBmr,
  katchMcArdle,
  selectBmrMethod,
  DEFAULT_BMR_POLICY,
} from '@macros/domain-energy';
import {
  centimetres,
  deriveFatFreeMassKg,
  instant,
  kilograms,
  years,
  type BmrPolicy,
  type UserProfileSnapshot,
} from '@macros/contracts';
import { loadGolden, approx } from '@macros/testkit';

interface BmrGolden {
  cases: {
    name: string;
    profile: { ageYears: number; sex: 'male' | 'female'; bodyWeightKg: number; heightCm: number; bodyFatPercent?: number; bodyFatMeasurementSource?: string };
    expectedBmr: number;
    expectedMethod: string;
  }[];
  katchMcArdleCases: {
    name: string;
    profile: { ageYears: number; sex: 'male' | 'female'; bodyWeightKg: number; heightCm: number; bodyFatPercent: number; bodyFatMeasurementSource: string };
    expectedFatFreeMassKg: number;
    expectedBmr: number;
  }[];
}

const golden = loadGolden<BmrGolden>('bmr.json');

const toProfile = (p: BmrGolden['cases'][number]['profile']): UserProfileSnapshot => {
  const base: UserProfileSnapshot = {
    userId: 'user-test',
    profileVersionId: 'prof-test-v1',
    effectiveFrom: instant('2026-01-01T00:00:00.000Z'),
    ageYears: years(p.ageYears),
    sex: p.sex,
    bodyWeightKg: kilograms(p.bodyWeightKg),
    heightCm: centimetres(p.heightCm),
  };
  if (p.bodyFatPercent === undefined) return base;
  const source = p.bodyFatMeasurementSource as
    | NonNullable<UserProfileSnapshot['bodyFatMeasurementSource']>
    | undefined;
  if (source === undefined) return { ...base, bodyFatPercent: p.bodyFatPercent };
  return { ...base, bodyFatPercent: p.bodyFatPercent, bodyFatMeasurementSource: source };
};

describe('golden vectors — BMR', () => {
  for (const c of golden.cases) {
    test(c.name, () => {
      const r = calculateBmr(toProfile(c.profile));
      assert.ok(approx(r.bmrKcal, c.expectedBmr, 1e-9), `expected ${c.expectedBmr}, got ${r.bmrKcal}`);
      assert.equal(r.method, c.expectedMethod);
      assert.equal(r.policyVersion, DEFAULT_BMR_POLICY.version);
    });
  }
});

describe('BMR method selection is explicit, never implicit', () => {
  test('LOCKED: body fat alone never switches away from Mifflin-St Jeor', () => {
    const withFat = toProfile(golden.katchMcArdleCases[0]!.profile);
    const r = calculateBmr(withFat, DEFAULT_BMR_POLICY);
    assert.equal(r.method, 'mifflin_st_jeor');
    assert.equal(r.bodyFatAvailableButUnused, true);
  });

  test('production policy permits no Katch-McArdle measurement source', () => {
    assert.deepEqual(DEFAULT_BMR_POLICY.katchMcArdlePermittedSources, []);
    assert.equal(DEFAULT_BMR_POLICY.defaultMethod, 'mifflin_st_jeor');
  });

  test('Katch-McArdle is reachable only through an explicit versioned policy', () => {
    const c = golden.katchMcArdleCases[0]!;
    const permissive: BmrPolicy = {
      version: 'bmr@0.0.0-TEST-permits-dexa',
      provenance: 'APPROVED_PRODUCTION',
      reviewStatus: 'APPROVED',
      defaultMethod: 'mifflin_st_jeor',
      katchMcArdlePermittedSources: ['dexa'],
    };
    const profile = toProfile(c.profile);
    assert.equal(selectBmrMethod(profile, permissive), 'katch_mcardle');
    const r = calculateBmr(profile, permissive);
    assert.ok(approx(r.bmrKcal, c.expectedBmr, 1e-9));
    assert.equal(r.policyVersion, permissive.version);
  });

  test('a permitted policy still declines when the measurement source differs', () => {
    const permissive: BmrPolicy = {
      version: 'bmr@0.0.0-TEST-permits-dexa',
      provenance: 'APPROVED_PRODUCTION',
      reviewStatus: 'APPROVED',
      defaultMethod: 'mifflin_st_jeor',
      katchMcArdlePermittedSources: ['dexa'],
    };
    const selfReported = toProfile({
      ...golden.katchMcArdleCases[0]!.profile,
      bodyFatMeasurementSource: 'self_reported',
    });
    assert.equal(selectBmrMethod(selfReported, permissive), 'mifflin_st_jeor');
  });

  test('fat-free mass derives correctly and Katch-McArdle matches it', () => {
    const c = golden.katchMcArdleCases[0]!;
    const ffm = deriveFatFreeMassKg(toProfile(c.profile));
    assert.ok(ffm !== undefined);
    assert.ok(approx(ffm, c.expectedFatFreeMassKg, 1e-9));
    assert.ok(approx(katchMcArdle(ffm), c.expectedBmr, 1e-9));
  });
});

describe('fat-free mass derivation', () => {
  const base = toProfile(golden.cases[0]!.profile);

  test('undefined — never zero — when body fat is absent', () => {
    assert.equal(deriveFatFreeMassKg(base), undefined);
  });

  test('implausible body fat is rejected, not clamped', () => {
    assert.equal(deriveFatFreeMassKg({ ...base, bodyFatPercent: 0.5 }), undefined);
    assert.equal(deriveFatFreeMassKg({ ...base, bodyFatPercent: 85 }), undefined);
    assert.equal(deriveFatFreeMassKg({ ...base, bodyFatPercent: Number.NaN }), undefined);
  });

  test('a profile with an out-of-band body fat is refused outright', () => {
    assert.throws(() => calculateBmr({ ...base, bodyFatPercent: 85 }));
  });
});
