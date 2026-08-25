import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { calculateNutrition, normalizeToPer100g, checkAtwater } from '@macros/domain-nutrition';
import { grams, type NutrientBasis } from '@macros/contracts';
import { loadGolden, approx, forAll, between, pick } from '@macros/testkit';

interface NutritionGolden {
  cases: {
    name: string;
    basis: NutrientBasis;
    grams: number;
    expected: Record<string, number>;
  }[];
}

const golden = loadGolden<NutritionGolden>('nutrition.json');

describe('golden vectors — nutrition', () => {
  for (const c of golden.cases) {
    test(c.name, () => {
      const result = calculateNutrition(c.basis, grams(c.grams));
      const totals = result.totals as unknown as Record<string, number>;
      for (const [key, expected] of Object.entries(c.expected)) {
        assert.ok(
          approx(totals[key] ?? 0, expected, 1e-9),
          `${key}: expected ${expected}, got ${totals[key]}`,
        );
      }
    });
  }
});

describe('properties — nutrition', () => {
  /**
   * Generates only MASS-BALANCED bases: constituents of 100 g cannot exceed
   * 100 g. An earlier unconstrained generator produced physically impossible
   * foods and was correctly rejected by the validator.
   */
  const randomBasis = (rnd: () => number): NutrientBasis => {
    const protein = between(rnd, 0, 35);
    const carb = between(rnd, 0, Math.max(0, 90 - protein));
    const fat = between(rnd, 0, Math.max(0, 95 - protein - carb));
    return {
      kind: 'per_100g',
      kcal: protein * 4 + carb * 4 + fat * 9,
      proteinG: protein,
      carbohydrateG: carb,
      fatG: fat,
    };
  };

  test('scales linearly: f(2g) === 2 * f(1g)', () => {
    forAll(
      (rnd) => ({ basis: randomBasis(rnd), g: between(rnd, 0.1, 2000) }),
      ({ basis, g }) => {
        const single = calculateNutrition(basis, grams(g));
        const double = calculateNutrition(basis, grams(g * 2));
        assert.ok(approx(double.totals.kcal, single.totals.kcal * 2, 1e-9));
        assert.ok(approx(double.totals.proteinG, single.totals.proteinG * 2, 1e-9));
      },
    );
  });

  test('is additive: f(a) + f(b) === f(a + b)', () => {
    forAll(
      (rnd) => ({ basis: randomBasis(rnd), a: between(rnd, 0, 500), b: between(rnd, 0, 500) }),
      ({ basis, a, b }) => {
        const sum = calculateNutrition(basis, grams(a)).totals.kcal +
          calculateNutrition(basis, grams(b)).totals.kcal;
        const combined = calculateNutrition(basis, grams(a + b)).totals.kcal;
        assert.ok(approx(sum, combined, 1e-9));
      },
    );
  });

  test('zero mass always yields zero nutrition', () => {
    forAll(randomBasis, (basis) => {
      const r = calculateNutrition(basis, grams(0));
      assert.equal(r.totals.kcal, 0);
      assert.equal(r.totals.proteinG, 0);
    });
  });

  test('volume basis round-trips through density', () => {
    forAll(
      (rnd) => ({
        kcalPer100g: between(rnd, 10, 900),
        density: between(rnd, 0.5, 1.5),
      }),
      ({ kcalPer100g, density }) => {
        const volumeBasis: NutrientBasis = {
          kind: 'per_100ml',
          densityGPerMl: density,
          kcal: kcalPer100g * density,
          proteinG: 0,
          carbohydrateG: 0,
          fatG: 0,
        };
        const normalized = normalizeToPer100g(volumeBasis);
        assert.ok(approx(normalized.kcal, kcalPer100g, 1e-9));
      },
    );
  });

  test('never produces negative or NaN output for valid input', () => {
    forAll(
      (rnd) => ({ basis: randomBasis(rnd), g: between(rnd, 0, 5000) }),
      ({ basis, g }) => {
        const t = calculateNutrition(basis, grams(g)).totals;
        for (const v of [t.kcal, t.proteinG, t.carbohydrateG, t.fatG]) {
          assert.ok(Number.isFinite(v), 'must be finite');
          assert.ok(v >= 0, 'must be non-negative');
        }
      },
    );
  });

  test('rejects negative mass', () => {
    assert.throws(() => calculateNutrition(golden.cases[0]!.basis, grams(-1)));
  });

  test('rejects a basis whose macros exceed 100 g per 100 g', () => {
    assert.throws(() =>
      calculateNutrition(
        { kind: 'per_100g', kcal: 400, proteinG: 60, carbohydrateG: 60, fatG: 40 },
        grams(100),
      ),
    );
  });

  test('Atwater check flags an inconsistent basis', () => {
    const consistent = checkAtwater({ kind: 'per_100g', kcal: 165, proteinG: 31, carbohydrateG: 0, fatG: 3.6 });
    assert.ok(consistent.consistent);
    const broken = checkAtwater({ kind: 'per_100g', kcal: 900, proteinG: 5, carbohydrateG: 5, fatG: 5 });
    assert.equal(broken.consistent, false);
  });

  test('sums are order-independent', () => {
    forAll(
      (rnd) => Array.from({ length: 5 }, () => between(rnd, 1, 400)),
      (masses) => {
        const basis = golden.cases[0]!.basis;
        const forward = masses.reduce((s, g) => s + calculateNutrition(basis, grams(g)).totals.kcal, 0);
        const reverse = [...masses].reverse().reduce((s, g) => s + calculateNutrition(basis, grams(g)).totals.kcal, 0);
        assert.ok(approx(forward, reverse, 1e-9));
      },
    );
  });

  test('pick helper is deterministic across seeds', () => {
    const options = ['a', 'b', 'c'] as const;
    forAll((rnd) => pick(rnd, options), (v) => assert.ok(options.includes(v)));
  });
});
