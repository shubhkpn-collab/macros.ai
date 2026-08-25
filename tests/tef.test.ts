import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateTef,
  baseMacroTef,
  loadProductionTefPolicy,
} from '@macros/domain-energy';
import {
  deriveTefProfile,
  grams,
  kcal,
  validateTefPolicy,
  assertProductionPolicy,
  type NutritionTotals,
  type TefPolicy,
} from '@macros/contracts';
import {
  TEST_TEF_POLICY,
  TEST_TEF_POLICY_APPROVED_RULES,
  PROFILE_MALE_35,
  PROFILE_MALE_35_WITH_BODYFAT,
  loadGolden,
  approx,
  forAll,
  between,
  SYNTHETIC_TEF_SANITY,
  withinSyntheticTefSanity,
} from '@macros/testkit';

interface TefGolden {
  cases: {
    name: string;
    nutrition: { kcal: number; proteinG: number; carbohydrateG: number; fatG: number; alcoholG?: number };
    expectedBaseMacroTefKcal: number;
    expectedIndividualAdjustmentKcal: number;
    expectedConfidence: string;
  }[];
}

const golden = loadGolden<TefGolden>('tef.json');

const toTotals = (n: TefGolden['cases'][number]['nutrition']): NutritionTotals => ({
  kcal: kcal(n.kcal),
  proteinG: grams(n.proteinG),
  carbohydrateG: grams(n.carbohydrateG),
  fatG: grams(n.fatG),
  ...(n.alcoholG !== undefined ? { alcoholG: grams(n.alcoholG) } : {}),
});

const profile = deriveTefProfile(PROFILE_MALE_35);
const profileWithFat = deriveTefProfile(PROFILE_MALE_35_WITH_BODYFAT);

describe('golden vectors — TEF (synthetic test policy)', () => {
  for (const c of golden.cases) {
    test(c.name, () => {
      const r = calculateTef(toTotals(c.nutrition), profile, TEST_TEF_POLICY);
      assert.ok(
        approx(r.baseMacroTefKcal, c.expectedBaseMacroTefKcal, 1e-9),
        `base: expected ${c.expectedBaseMacroTefKcal}, got ${r.baseMacroTefKcal}`,
      );
      assert.equal(r.individualAdjustmentKcal, c.expectedIndividualAdjustmentKcal);
      assert.equal(r.confidence, c.expectedConfidence);
      assert.equal(r.policyVersion, TEST_TEF_POLICY.version);
    });
  }

  test('macro composition matters: isocaloric meals differ in thermic cost', () => {
    const highProtein = calculateTef(toTotals(golden.cases[0]!.nutrition), profile, TEST_TEF_POLICY);
    const highFat = calculateTef(toTotals(golden.cases[1]!.nutrition), profile, TEST_TEF_POLICY);
    assert.equal(golden.cases[0]!.nutrition.kcal, golden.cases[1]!.nutrition.kcal);
    assert.ok(
      highProtein.estimatedTefKcal > highFat.estimatedTefKcal * 2,
      'a high-protein meal must carry a materially larger estimated thermic cost',
    );
  });

  test('larger caloric amounts produce proportionally larger estimates', () => {
    const single = calculateTef(toTotals({ kcal: 330, proteinG: 62, carbohydrateG: 0, fatG: 7.2 }), profile, TEST_TEF_POLICY);
    const double = calculateTef(toTotals({ kcal: 660, proteinG: 124, carbohydrateG: 0, fatG: 14.4 }), profile, TEST_TEF_POLICY);
    assert.ok(approx(double.baseMacroTefKcal, single.baseMacroTefKcal * 2, 1e-9));
  });

  test('a mixed day lands inside the sanity band', () => {
    const day = golden.cases[2]!;
    const r = calculateTef(toTotals(day.nutrition), profile, TEST_TEF_POLICY);
    const fractionOfIntake = r.estimatedTefKcal / day.nutrition.kcal;
    assert.ok(
      fractionOfIntake >= SYNTHETIC_TEF_SANITY.expectedDayFraction.min &&
        fractionOfIntake <= SYNTHETIC_TEF_SANITY.expectedDayFraction.max,
      `whole-day TEF was ${(fractionOfIntake * 100).toFixed(1)}% of intake`,
    );
  });
});

describe('SAFETY PROPERTY — unreviewed policies cannot personalise', () => {
  test('an unreviewed policy must carry only neutral rules', () => {
    const smuggled: TefPolicy = {
      ...TEST_TEF_POLICY,
      reviewStatus: 'PENDING_EXTERNAL_REVIEW',
      individualAdjustmentModel: {
        ...TEST_TEF_POLICY.individualAdjustmentModel,
        age: { kind: 'linear', input: 'age', slope: -0.5, intercept: 20, bounds: [-50, 50] },
      },
    };
    const result = validateTefPolicy(smuggled);
    assert.equal(result.ok, false);
    assert.throws(() => calculateTef(toTotals(golden.cases[0]!.nutrition), profile, smuggled));
  });

  test('individualized === base EXACTLY under an unreviewed policy, for every input', () => {
    forAll(
      (rnd) => ({
        protein: between(rnd, 0, 200),
        carb: between(rnd, 0, 400),
        fat: between(rnd, 0, 150),
      }),
      ({ protein, carb, fat }) => {
        const totals = toTotals({
          kcal: protein * 4 + carb * 4 + fat * 9,
          proteinG: protein,
          carbohydrateG: carb,
          fatG: fat,
        });
        for (const p of [profile, profileWithFat]) {
          const r = calculateTef(totals, p, TEST_TEF_POLICY);
          assert.equal(r.individualAdjustmentKcal, 0, 'adjustment must be exactly zero');
          assert.equal(r.estimatedTefKcal, r.baseMacroTefKcal, 'individualized must equal base');
          assert.equal(r.confidence, 'basic');
        }
      },
    );
  });

  test('no approved production TEF policy exists — the absence is a state, not a default', () => {
    const handle = loadProductionTefPolicy();
    assert.equal(handle.status, 'unavailable');
    if (handle.status === 'unavailable') {
      assert.equal(handle.reason, 'no_approved_policy_exists');
    }
  });

  test('a synthetic test policy is rejected by a production code path', () => {
    const result = assertProductionPolicy(TEST_TEF_POLICY);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error[0]?.code, 'policy_not_production');
  });

  test('personal calibration is reserved and cannot be enabled', () => {
    assert.equal(TEST_TEF_POLICY.personalCalibrationEnabled, false);
    const enabled = { ...TEST_TEF_POLICY, personalCalibrationEnabled: true } as unknown as TefPolicy;
    assert.equal(validateTefPolicy(enabled).ok, false);
  });
});

describe('adjustment machinery works once a reviewer approves it', () => {
  const totals = toTotals(golden.cases[2]!.nutrition);

  test('approved rules produce a non-zero adjustment and profile_adjusted confidence', () => {
    const r = calculateTef(totals, profileWithFat, TEST_TEF_POLICY_APPROVED_RULES);
    assert.notEqual(r.individualAdjustmentKcal, 0);
    assert.equal(r.confidence, 'profile_adjusted');
    assert.equal(r.reviewStatus, 'APPROVED');
  });

  test('inputsUsed reports what was APPLIED, not what was AVAILABLE', () => {
    // Body fat present, but the policy is neutral: it did not influence the result.
    const neutral = calculateTef(totals, profileWithFat, TEST_TEF_POLICY);
    assert.equal(neutral.inputsUsed.bodyFat, false);
    assert.equal(neutral.inputsUsed.fatFreeMass, false);
    assert.equal(neutral.inputsUsed.age, false);
    assert.equal(neutral.inputsUsed.macros, true);

    // Same profile under approved rules: age and lean mass genuinely applied.
    const applied = calculateTef(totals, profileWithFat, TEST_TEF_POLICY_APPROVED_RULES);
    assert.equal(applied.inputsUsed.age, true);
    assert.equal(applied.inputsUsed.fatFreeMass, true);
    assert.equal(applied.inputsUsed.personalCalibration, false);
  });

  test('a profile without body fat still calculates, using only available inputs', () => {
    const r = calculateTef(totals, profile, TEST_TEF_POLICY_APPROVED_RULES);
    assert.ok(Number.isFinite(r.estimatedTefKcal));
    assert.equal(r.inputsUsed.fatFreeMass, false, 'lean-mass rule cannot fire without lean mass');
    assert.equal(r.inputsUsed.age, true);
  });

  test('the adjustment is bounded as a fraction of base TEF', () => {
    const runaway: TefPolicy = {
      ...TEST_TEF_POLICY_APPROVED_RULES,
      version: 'tef@0.0.0-SYNTHETIC-TEST-RUNAWAY',
      adjustmentBoundFraction: 0.1,
      individualAdjustmentModel: {
        age: { kind: 'linear', input: 'age', slope: 100, intercept: 0, bounds: [-1e6, 1e6] },
      },
    };
    const r = calculateTef(totals, profileWithFat, runaway);
    assert.ok(
      Math.abs(r.individualAdjustmentKcal) <= 0.1 * r.baseMacroTefKcal + 1e-9,
      'adjustment must be clamped to the policy bound',
    );
  });

  test('adjustments compose additively, never multiplicatively', () => {
    const r = calculateTef(totals, profileWithFat, TEST_TEF_POLICY_APPROVED_RULES);
    assert.ok(approx(r.estimatedTefKcal, r.baseMacroTefKcal + r.individualAdjustmentKcal, 1e-9));
    assert.equal(TEST_TEF_POLICY_APPROVED_RULES.composition, 'additive_kcal');
  });
});

describe('TEF sanity bounds (synthetic, testkit-owned)', () => {
  test('estimated TEF never exceeds the absolute ceiling for any valid input', () => {
    forAll(
      (rnd) => ({
        protein: between(rnd, 0, 300),
        carb: between(rnd, 0, 500),
        fat: between(rnd, 0, 200),
      }),
      ({ protein, carb, fat }) => {
        const loggedKcal = protein * 4 + carb * 4 + fat * 9;
        const totals = toTotals({ kcal: loggedKcal, proteinG: protein, carbohydrateG: carb, fatG: fat });
        const r = calculateTef(totals, profile, TEST_TEF_POLICY);
        assert.ok(
          withinSyntheticTefSanity(r.estimatedTefKcal, loggedKcal),
          `TEF ${r.estimatedTefKcal} exceeded ${SYNTHETIC_TEF_SANITY.maxFractionOfKcal} of ${loggedKcal}`,
        );
      },
    );
  });

  test('policy versions are traceable on every result', () => {
    const r = calculateTef(toTotals(golden.cases[0]!.nutrition), profile, TEST_TEF_POLICY);
    assert.equal(r.policyVersion, 'tef@0.0.0-SYNTHETIC-TEST');
    assert.equal(r.reviewStatus, 'PENDING_EXTERNAL_REVIEW');
  });

  test('base macro TEF is a pure function of macros and coefficients', () => {
    const totals = toTotals(golden.cases[0]!.nutrition);
    assert.equal(baseMacroTef(totals, TEST_TEF_POLICY), baseMacroTef(totals, TEST_TEF_POLICY));
  });
});

describe('rule validation and provenance (patch)', () => {
  const totals = toTotals(golden.cases[2]!.nutrition);

  test('a linear rule with inverted bounds is rejected', () => {
    const bad: TefPolicy = {
      ...TEST_TEF_POLICY_APPROVED_RULES,
      individualAdjustmentModel: {
        age: { kind: 'linear', input: 'age', slope: 1, intercept: 0, bounds: [10, -10] },
      },
    };
    assert.equal(validateTefPolicy(bad).ok, false);
  });

  test('a non-finite coefficient is rejected', () => {
    const bad: TefPolicy = {
      ...TEST_TEF_POLICY_APPROVED_RULES,
      individualAdjustmentModel: {
        age: { kind: 'linear', input: 'age', slope: Number.NaN, intercept: 0, bounds: [-1, 1] },
      },
    };
    assert.equal(validateTefPolicy(bad).ok, false);
  });

  test('piecewise breakpoints must strictly increase', () => {
    const unordered: TefPolicy = {
      ...TEST_TEF_POLICY_APPROVED_RULES,
      individualAdjustmentModel: {
        age: { kind: 'piecewise', input: 'age', breakpoints: [{ upTo: 60, kcal: 1 }, { upTo: 30, kcal: 2 }] },
      },
    };
    assert.equal(validateTefPolicy(unordered).ok, false);
  });

  test('duplicate piecewise thresholds are rejected', () => {
    const dup: TefPolicy = {
      ...TEST_TEF_POLICY_APPROVED_RULES,
      individualAdjustmentModel: {
        age: { kind: 'piecewise', input: 'age', breakpoints: [{ upTo: 30, kcal: 1 }, { upTo: 30, kcal: 2 }] },
      },
    };
    assert.equal(validateTefPolicy(dup).ok, false);
  });

  test('an empty piecewise rule is rejected', () => {
    const empty: TefPolicy = {
      ...TEST_TEF_POLICY_APPROVED_RULES,
      individualAdjustmentModel: { age: { kind: 'piecewise', input: 'age', breakpoints: [] } },
    };
    assert.equal(validateTefPolicy(empty).ok, false);
  });

  test('sex is categorical — it is never a continuous 0/1 number', () => {
    const categorical: TefPolicy = {
      ...TEST_TEF_POLICY_APPROVED_RULES,
      individualAdjustmentModel: {
        age: { kind: 'none' },
        sex: { kind: 'categorical', input: 'sex', cases: { male: 5, female: 3 } },
      },
    };
    assert.equal(validateTefPolicy(categorical).ok, true);
    const male = calculateTef(totals, profile, categorical);
    assert.ok(approx(male.individualAdjustmentKcal, 5, 1e-9));
    assert.equal(male.inputsUsed.sex, true);
  });

  test('FFM provenance implies body weight and body fat were used', () => {
    const ffmOnly: TefPolicy = {
      ...TEST_TEF_POLICY_APPROVED_RULES,
      individualAdjustmentModel: {
        age: { kind: 'none' },
        fatFreeMass: {
          kind: 'piecewise',
          input: 'fatFreeMass',
          breakpoints: [{ upTo: 50, kcal: 0 }, { upTo: 1000, kcal: 4 }],
        },
      },
    };
    const r = calculateTef(totals, profileWithFat, ffmOnly);
    assert.notEqual(r.individualAdjustmentKcal, 0);
    assert.equal(r.inputsUsed.fatFreeMass, true);
    assert.equal(r.inputsUsed.bodyWeight, true, 'FFM is derived from body weight');
    assert.equal(r.inputsUsed.bodyFat, true, 'FFM is derived from body-fat percentage');
  });

  test('POLICY FIREWALL: provenance alone is not enough — review status is required too', () => {
    const inHouseButUnreviewed: TefPolicy = {
      ...TEST_TEF_POLICY,
      version: 'tef@0.0.0-inhouse-unreviewed',
      provenance: 'APPROVED_PRODUCTION',
      reviewStatus: 'PENDING_EXTERNAL_REVIEW',
    };
    const r = assertProductionPolicy(inHouseButUnreviewed);
    assert.equal(r.ok, false);
    if (!r.ok) assert.ok(r.error.some((i) => i.code === 'policy_not_approved'));
  });

  test('a fully approved production policy passes the firewall', () => {
    const approved: TefPolicy = {
      ...TEST_TEF_POLICY,
      version: 'tef@0.0.0-TEST-approved-shape',
      provenance: 'APPROVED_PRODUCTION',
      reviewStatus: 'APPROVED',
    };
    assert.equal(assertProductionPolicy(approved).ok, true);
  });
});
