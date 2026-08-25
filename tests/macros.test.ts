import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeMacroTargets,
  computeMacroState,
  assessGuardrails,
  macroKcal,
  DEFAULT_MACRO_POLICY,
  DEFAULT_GUARDRAIL_POLICY,
} from '@macros/domain-macros';
import { displayGrams, displayKcal, roundHalfUp } from '@macros/domain-nutrition';
import { ATWATER, kcal } from '@macros/contracts';
import { intakeOf, approx, forAll, between, pick } from '@macros/testkit';

describe('macro targets', () => {
  test('protein and fat are floors; carbohydrate is the remainder', () => {
    const t = computeMacroTargets({
      projectedTotalExpenditureKcal: 2720.25,
      targetDeltaKcal: 250,
      bodyWeightKg: 80,
    });
    assert.ok(approx(t.targetKcal, 2970.25, 1e-9));
    assert.ok(approx(t.proteinG, 144, 1e-9), '1.8 g/kg x 80 kg');
    // fat = max(0.6 x 80 = 48, 0.2 x 2970.25 / 9 = 66.0056) = 66.0056
    assert.ok(approx(t.fatG, (0.2 * 2970.25) / 9, 1e-9));
    assert.equal(t.carbohydrateClamped, false);
  });

  test('macro-derived calories reconcile to the calorie target, for ALL inputs', () => {
    forAll(
      (rnd) => ({
        expenditure: between(rnd, 1200, 4500),
        delta: pick(rnd, [-1000, -500, -250, 0, 250, 500, 700]),
        weight: between(rnd, 40, 160),
      }),
      ({ expenditure, delta, weight }) => {
        const t = computeMacroTargets({
          projectedTotalExpenditureKcal: expenditure,
          targetDeltaKcal: delta,
          bodyWeightKg: weight,
        });
        if (t.carbohydrateClamped) {
          // Protein and fat floors already exceed the target; carbs cannot go negative.
          assert.equal(t.carbohydrateG, 0);
          assert.ok(macroKcal(t) >= t.targetKcal - 1e-6);
          return;
        }
        assert.ok(
          approx(macroKcal(t), t.targetKcal, 1e-9),
          `macros imply ${macroKcal(t)} kcal but target is ${t.targetKcal}`,
        );
      },
    );
  });

  test('carbohydrate is clamped at zero, never negative', () => {
    const t = computeMacroTargets({
      projectedTotalExpenditureKcal: 900,
      targetDeltaKcal: -400,
      bodyWeightKg: 120,
    });
    assert.equal(t.carbohydrateG, 0);
    assert.equal(t.carbohydrateClamped, true);
  });

  test('remaining = target - consumed', () => {
    const t = computeMacroTargets({ projectedTotalExpenditureKcal: 2720.25, targetDeltaKcal: 250, bodyWeightKg: 80 });
    const s = computeMacroState(t, intakeOf(1330, 102, 100, 37.2));
    assert.ok(approx(s.remainingProteinG, 144 - 102, 1e-9), 'the brief: 42 g protein remaining');
    assert.ok(approx(s.remainingKcal, t.targetKcal - 1330, 1e-9));
  });

  test('policy version travels with the targets', () => {
    const t = computeMacroTargets({ projectedTotalExpenditureKcal: 2500, targetDeltaKcal: 0, bodyWeightKg: 75 });
    assert.equal(t.policyVersion, DEFAULT_MACRO_POLICY.version);
    assert.equal(DEFAULT_MACRO_POLICY.reviewStatus, 'PENDING_EXTERNAL_REVIEW');
  });
});

describe('safety guardrails', () => {
  test('a target below the floor is flagged', () => {
    const g = assessGuardrails(kcal(1000), 1755, 'male', -1700);
    assert.equal(g.belowFloor, true);
    assert.ok(approx(g.floorKcal, Math.max(1500, 0.7 * 1755), 1e-9));
  });

  test('extreme deficits and surpluses require explicit confirmation', () => {
    assert.equal(assessGuardrails(kcal(2000), 1755, 'male', -1200).requiresExplicitConfirmation, true);
    assert.equal(assessGuardrails(kcal(2000), 1755, 'male', 800).requiresExplicitConfirmation, true);
    assert.equal(assessGuardrails(kcal(2500), 1755, 'male', 250).requiresExplicitConfirmation, false);
  });

  test('the floor is sex-aware and BMR-aware', () => {
    const female = assessGuardrails(kcal(1300), 1351.5, 'female', -400);
    assert.ok(approx(female.floorKcal, Math.max(1200, 0.7 * 1351.5), 1e-9));
    assert.equal(female.belowFloor, false);
  });

  test('guardrails are never bypassable — the floor never drops below the absolute minimum', () => {
    forAll(
      (rnd) => ({ bmr: between(rnd, 900, 2500), sex: pick(rnd, ['male', 'female'] as const) }),
      ({ bmr, sex }) => {
        const g = assessGuardrails(kcal(2000), bmr, sex, 0);
        assert.ok(g.floorKcal >= DEFAULT_GUARDRAIL_POLICY.absoluteFloorKcal[sex]);
      },
    );
  });
});

describe('rounding', () => {
  test('round-half-up at display', () => {
    assert.equal(roundHalfUp(0.5), 1);
    assert.equal(roundHalfUp(1.5), 2);
    assert.equal(roundHalfUp(2.5), 3);
    assert.equal(roundHalfUp(-0.5), -1);
    assert.equal(roundHalfUp(2.675, 2), 2.68);
  });

  test('displayed macros never contradict displayed calories', () => {
    forAll(
      (rnd) => ({
        expenditure: between(rnd, 1500, 4000),
        delta: pick(rnd, [-500, -250, 0, 250]),
        weight: between(rnd, 45, 140),
      }),
      ({ expenditure, delta, weight }) => {
        const t = computeMacroTargets({
          projectedTotalExpenditureKcal: expenditure,
          targetDeltaKcal: delta,
          bodyWeightKg: weight,
        });
        if (t.carbohydrateClamped) return;
        const displayed =
          displayGrams(t.proteinG) * ATWATER.protein +
          displayGrams(t.carbohydrateG) * ATWATER.carbohydrate +
          displayGrams(t.fatG) * ATWATER.fat;
        const delta2 = Math.abs(displayed - displayKcal(t.targetKcal));
        assert.ok(delta2 <= 2, `displayed macros imply ${displayed} kcal vs displayed target ${displayKcal(t.targetKcal)}`);
      },
    );
  });
});
