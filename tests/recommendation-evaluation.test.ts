import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { repoPath } from '../tools/repo-paths.js';

/**
 * INT-1 baseline assertions.
 *
 * These lock in what the engine ACTUALLY does today. They are not aspirations,
 * and none of them was allowed to change the engine: INT-1 measures, and the
 * corrections it identifies are deliberately left unimplemented so the baseline
 * stays honest.
 */
const evaluation = () => JSON.parse(
  readFileSync(repoPath('data', 'recommendation-evaluation.json'), 'utf8'));
const namedCases = () => JSON.parse(
  readFileSync(repoPath('data', 'recommendation-named-cases.json'), 'utf8')) as {
    name: string; status: string; top: string | null;
    topMacroShares: Record<string, number> | null;
  }[];

describe('INT-1 — evaluation exercises the real engine', () => {
  test('the production entry point was measured', () => {
    const e = evaluation();
    assert.equal(e.engine, 'recommendFoods (production)');
    assert.match(e.policyVersion, /recommendation-policy@/);
  });

  test('the scenario space is large enough to claim coverage', () => {
    const e = evaluation();
    assert.ok(e.scenarios >= 500, `only ${e.scenarios} scenarios`);
  });

  test('candidates are real recommendable catalog foods', () => {
    const e = evaluation();
    assert.ok(e.candidatePool > 6000);
    const harness = readFileSync(
      repoPath('tools', 'evaluate-recommendations.ts'), 'utf8');
    // No fabricated nutrition, and no fabricated serving weight either — the
    // generic seed genuinely has none, and inventing one would measure the
    // engine against a catalog that does not exist.
    assert.match(harness, /NO servingGrams/);
    assert.match(harness, /s\.recommendable !== true/);
  });
});

describe('INT-1 — hard safety is clean', () => {
  test('zero hard violations across every scenario', () => {
    const e = evaluation();
    assert.equal(e.hardViolationRatePercent, 0);
    assert.deepEqual(e.violationKinds, {});
  });

  test('no impossible or ungrounded portion was ever proposed', () => {
    const e = evaluation();
    for (const kind of ['impossible_portion', 'ungrounded_portion',
                        'unknown_candidate', 'non_finite_score']) {
      assert.equal(e.violationKinds[kind], undefined);
    }
  });

  test('ranking is monotonic by the engine\'s own score', () => {
    assert.equal(evaluation().rankingMonotonicPercent, 100);
  });

  test('an exhausted budget degrades honestly, every time', () => {
    const e = evaluation();
    assert.ok(e.budgetExhaustedScenarios > 0);
    assert.equal(e.budgetExhaustedHandledHonestly, e.budgetExhaustedScenarios);
    assert.ok(e.statuses.energy_budget_exhausted > 0);
  });

  test('an empty candidate pool is reported, not papered over', () => {
    const c = namedCases().find((x) => x.name === 'NO_GOOD_CANDIDATE');
    assert.equal(c?.status, 'no_eligible_candidates');
    assert.equal(c?.top, null);
  });

  test('an exceeded target produces no manufactured suggestion', () => {
    const c = namedCases().find((x) => x.name === 'CALORIES_ALREADY_EXCEEDED');
    assert.equal(c?.status, 'energy_budget_exhausted');
    assert.equal(c?.top, null);
  });
});

describe('INT-1 — the measured weakness, recorded not fixed', () => {
  test('the winner set collapses to a handful of foods', () => {
    // 7 distinct winners across 1,440 scenarios. A recommender that answers
    // almost every question with the same food is not reading the question.
    const e = evaluation();
    assert.ok(e.topPickProfile.distinctTopPicks < 20,
      `${e.topPickProfile.distinctTopPicks} distinct winners — baseline recorded`);
  });

  test('near-zero-energy foods win a large share of scenarios', () => {
    // Coffee scores a perfect PROPORTIONAL protein fit because its trivial
    // protein is 100% of its trivial macro energy. Share is scale-free, so
    // magnitude never enters the comparison.
    const e = evaluation();
    assert.ok(e.topPickProfile.nearZeroEnergyWinsPercent > 20,
      'baseline: proportional macro fit rewards nutritionally empty foods');
  });

  test('extreme-energy-density foods win fat-gap scenarios', () => {
    const e = evaluation();
    assert.ok(e.topPickProfile.extremeDensityWinsPercent > 15,
      'baseline: pure fats satisfy a fat gap perfectly by proportion');
  });

  test('energy fit is the weakest measured dimension', () => {
    const e = evaluation();
    assert.ok(e.energyFitRatePercent < 95);
    assert.ok(e.energyFitRatePercent > 80);
  });

  test('LEAN_PROTEIN_LATE_DAY does not return a lean protein food', () => {
    // The headline named case. Recorded as failing; NOT corrected here.
    const c = namedCases().find((x) => x.name === 'LEAN_PROTEIN_LATE_DAY');
    assert.equal(c?.status, 'available');
    assert.ok((c?.topMacroShares?.['kcalPer100g'] ?? 0) < 25,
      'baseline: a near-zero-energy beverage wins a protein-gap scenario');
  });

  test('CONTROLLED_SURPLUS returns an extreme-density fat', () => {
    const c = namedCases().find((x) => x.name === 'CONTROLLED_SURPLUS');
    assert.ok((c?.topMacroShares?.['kcalPer100g'] ?? 0) > 700,
      'baseline recorded: acceptable in surplus, alarming as a general pattern');
  });

  test('macro fit passing at 100% is a metric limitation, not a triumph', () => {
    // My own metric judged macro fit PROPORTIONALLY — the same blind spot the
    // engine has — so it certified coffee as a good protein choice. Recorded
    // so the number is not misread as engine quality.
    const e = evaluation();
    assert.equal(e.macroFitRatePercent, 100);
    const harness = readFileSync(
      repoPath('tools', 'evaluate-recommendations.ts'), 'utf8');
    assert.match(harness, /share >= 0\.30/, 'the proportional test that shares the blind spot');
  });
});
