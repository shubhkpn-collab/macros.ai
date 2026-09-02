import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assessRole, roleForMacro } from '@macros/domain-recommendation';
import { assessActionability } from '@macros/domain-catalog';
import { repoPath } from '../tools/repo-paths.js';

const version = (over: Record<string, unknown> = {}) => ({
  productId: 'p', productVersionId: 'p@v1', versionNo: 1,
  displayName: 'Test food', preparationState: 'as_sold',
  basis: { kind: 'per_100g', kcal: 165, proteinG: 31, carbohydrateG: 0, fatG: 3.6 },
  source: { kind: 'usda_generic', sourceId: 'x', verificationStatus: 'published' },
  effectiveFrom: '2026-01-01T00:00:00.000Z',
  ...over,
}) as never;

const evaluation = () => JSON.parse(
  readFileSync(repoPath('data', 'recommendation-evaluation.json'), 'utf8'));
const namedCases = () => JSON.parse(
  readFileSync(repoPath('data', 'recommendation-named-cases.json'), 'utf8')) as {
    name: string; status: string;
    plan: {
      objectives: string[]; moreGuidanceUsefulAfterWeighing: boolean;
      plannedTotals: null;
      components: { name: string; role: string; actionability: string; portion: unknown }[];
    };
  }[];

describe('INT-4 — nutritional roles come from nutrition, not names', () => {
  test('a macro-dominant food takes that role', () => {
    assert.equal(assessRole(version()).role, 'protein_forward');
    assert.equal(assessRole(version({
      basis: { kind: 'per_100g', kcal: 360, proteinG: 7, carbohydrateG: 78, fatG: 1 },
    })).role, 'carbohydrate_forward');
    assert.equal(assessRole(version({
      basis: { kind: 'per_100g', kcal: 880, proteinG: 0, carbohydrateG: 0, fatG: 100 },
    })).role, 'fat_forward');
  });

  test('a low-density food is an accompaniment whatever its shares', () => {
    // Lettuce is technically carbohydrate-forward; calling it a carbohydrate
    // component would misrepresent what it contributes.
    assert.equal(assessRole(version({
      basis: { kind: 'per_100g', kcal: 15, proteinG: 1.4, carbohydrateG: 2.9, fatG: 0.2 },
    })).role, 'light_accompaniment');
  });

  test('a food with no macros is unknown, never guessed', () => {
    assert.equal(assessRole(version({
      basis: { kind: 'per_100g', kcal: 0, proteinG: 0, carbohydrateG: 0, fatG: 0 },
    })).role, 'unknown');
  });

  test('role classification never reads a food name', () => {
    const code = readFileSync(
      repoPath('packages', 'domain-recommendation', 'src', 'roles.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.equal(/displayName/.test(code), false, 'roles must not depend on names');
    assert.match(code, /calculateNutrition/, 'energy comes from the authoritative path');
  });

  test('roleForMacro maps a gap to the role that fills it', () => {
    assert.equal(roleForMacro('protein'), 'protein_forward');
    assert.equal(roleForMacro('carbohydrate'), 'carbohydrate_forward');
  });
});

describe('INT-4 — actionability distinguishes staple from treat', () => {
  test('sweets and snacks are no longer equal to ordinary food', () => {
    // INT-3 classed both as ready_to_eat, so fudge could lead a carbohydrate gap.
    const fudge = assessActionability({
      displayName: 'Fudge, chocolate', category: 'Sweets',
      preparationState: 'as_sold', sourceDescription: 'Fudge, chocolate',
    });
    assert.equal(fudge.actionabilityClass, 'treat');
    const crisps = assessActionability({
      displayName: 'Potato chips', category: 'Snacks',
      preparationState: 'as_sold', sourceDescription: 'Potato chips',
    });
    assert.equal(crisps.actionabilityClass, 'snack');
    assert.ok(fudge.score < 0.5 && crisps.score < 0.5);
  });

  test('ordinary staples still rank as good defaults', () => {
    const bread = assessActionability({
      displayName: 'Bread, whole wheat', category: 'Baked Products',
      preparationState: 'as_sold', sourceDescription: 'Bread, whole wheat',
    });
    assert.equal(bread.actionabilityClass, 'ready_to_eat');
    assert.ok(bread.score >= 0.9);
  });
});

describe('INT-4 — the planner makes no quantity claims', () => {
  test('no component states an ungrounded portion', () => {
    assert.equal(evaluation().topPickProfile.plan.ungroundedPortionClaims, 0);
    for (const c of namedCases()) {
      for (const comp of c.plan.components) {
        assert.equal(comp.portion, null,
          'the generic seed has no serving weights, so no amount may be stated');
      }
    }
  });

  test('plan totals are never reported without full grounding', () => {
    // Summing two hypothetical 100 g amounts and calling it a meal would be a
    // fabricated quantity claim.
    for (const c of namedCases()) {
      assert.equal(c.plan.plannedTotals, null);
    }
    const planner = readFileSync(
      repoPath('packages', 'domain-recommendation', 'src', 'planner.ts'), 'utf8');
    // Comment asterisks sit inside the wrapped phrase, so strip them first.
    const prose = planner.replace(/^\s*\*/gm, ' ').replace(/\s+/g, ' ');
    assert.match(prose, /never invents a quantity/);
    assert.match(prose, /fabricated quantity claim/);
  });

  test('the contract supports the future scale flow', () => {
    const withComponents = namedCases().filter((c) => c.plan.components.length > 0);
    assert.ok(withComponents.length > 0);
    for (const c of withComponents) {
      assert.equal(c.plan.moreGuidanceUsefulAfterWeighing, true,
        'weighing changes what should be suggested next');
    }
  });
});

describe('INT-4 — plan shape', () => {
  const plan = () => evaluation().topPickProfile.plan;

  test('one good food stays one good food', () => {
    // Adding a second component for its own sake makes the answer harder to
    // act on, not better.
    assert.ok(plan().singleFoodRatePercent > 60);
  });

  test('complementary components appear when a second gap exists', () => {
    assert.ok(plan().twoComponentRatePercent > 10);
  });

  test('three components stay rare', () => {
    assert.ok(plan().threeComponentRatePercent < 15);
  });

  test('near-identical variants never appear together', () => {
    // "Soybeans, dry roasted" plus "Soybeans, roasted, salted" is not a plan.
    assert.equal(plan().duplicateComponentRatePercent, 0);
  });

  test('components are overwhelmingly ordinary foods', () => {
    assert.ok(plan().actionableComponentRatePercent > 95);
  });

  test('a treat never leads when a staple was available', () => {
    assert.equal(plan().treatPrimaryDespiteStaplePercent, 0);
  });

  test('honest degradation survives the planner', () => {
    const exceeded = namedCases().find((c) => c.name === 'CALORIES_ALREADY_EXCEEDED');
    assert.equal(exceeded?.status, 'energy_budget_exhausted');
    assert.deepEqual(exceeded?.plan.components, []);
    const none = namedCases().find((c) => c.name === 'NO_GOOD_CANDIDATE');
    assert.deepEqual(none?.plan.components, []);
  });
});

describe('INT-4 — every earlier guarantee is preserved', () => {
  test('all frozen INT-2 and INT-3 hard requirements still hold', () => {
    const e = evaluation();
    const t = e.topPickProfile;
    assert.equal(e.hardViolationRatePercent, 0);
    assert.equal(t.nearZeroEnergyWinsPercent, 0);
    assert.equal(t.extremeDensityWinsPercent, 0);
    assert.equal(t.exhaustedMacroViolationRatePercent, 0);
    assert.equal(t.lowActionabilityDespiteAlternativePercent, 0);
    assert.equal(e.unnecessaryOvershootRatePercent, 0);
  });

  test('the planner adds no nutritional arithmetic', () => {
    const code = readFileSync(
      repoPath('packages', 'domain-recommendation', 'src', 'planner.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const q of ['kcal', 'proteinG', 'carbohydrateG', 'fatG']) {
      assert.equal(new RegExp(`\\b${q}\\b\\s*[*/+-]`).test(code), false,
        `planner computes ${q}`);
    }
    assert.match(code, /recommendFoods\(input\)/, 'it orchestrates the frozen engine');
  });

  test('the planner is deterministic', () => {
    const code = readFileSync(
      repoPath('packages', 'domain-recommendation', 'src', 'planner.ts'), 'utf8');
    assert.equal(/Math\.random|Date\.now\(\)/.test(code), false);
  });
});
