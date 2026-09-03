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
    remaining: Record<string, number>;
    remainingKcal: number;
    comparisonBasis: Record<string, number> | null;
    groundedPortionGrams: number | null;
    portionStatable: boolean;
    whyItWon: readonly string[];
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

  test('ordering integrity is checked against the documented contract', () => {
    // This assertion previously accepted >= 60%, which is how a 70% result and
    // 432 CRITICAL failures coexisted with a green report. A weakened threshold
    // is not a passing test; the contract is now explicit and must be 100%.
    const e = evaluation();
    assert.equal(e.baseRankingIntegrityPercent, 100);
    assert.equal(e.finalOrderingIntegrityPercent, 100);
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

describe('INT-2 — the proven defect is corrected', () => {
  test('the winner set is no longer collapsed', () => {
    // INT-1 baseline: 7 distinct winners across 1,440 scenarios.
    const e = evaluation();
    assert.ok(e.topPickProfile.distinctTopPicks > 30,
      `only ${e.topPickProfile.distinctTopPicks} distinct winners`);
  });

  test('near-zero-energy foods no longer win', () => {
    // INT-1 baseline: 31.3%. Black coffee scored a perfect PROPORTIONAL protein
    // fit because trace protein was 100% of its macro energy.
    assert.equal(evaluation().topPickProfile.nearZeroEnergyWinsPercent, 0);
  });

  test('extreme-density foods no longer win', () => {
    // INT-1 baseline: 21.9%, led by whale oil.
    assert.equal(evaluation().topPickProfile.extremeDensityWinsPercent, 0);
  });

  test('a materially useful contribution is now the norm', () => {
    // Judged by ABSOLUTE grams against the gap, on thresholds independent of
    // the engine's policy — so this cannot be satisfied by tuning the policy.
    assert.ok(evaluation().topPickProfile.meaningfulContributionRatePercent >= 90);
  });

  test('an already-exhausted macro is never materially worsened', () => {
    // Counted only where a qualifying alternative existed, so the engine is not
    // blamed for gaps in the catalog.
    assert.equal(evaluation().topPickProfile.exhaustedMacroViolationRatePercent, 0);
  });

  test('unnecessary overshoot is eliminated', () => {
    assert.equal(evaluation().unnecessaryOvershootRatePercent, 0);
  });

  test('energy fit no longer rewards contributing nothing', () => {
    // v1 scored `1 - ratio`, so a zero-energy food earned the maximum.
    assert.equal(evaluation().energyFitRatePercent, 100);
  });

  test('LEAN_PROTEIN_LATE_DAY returns a real protein source', () => {
    const c = namedCases().find((x) => x.name === 'LEAN_PROTEIN_LATE_DAY');
    assert.equal(c?.status, 'available');
    const b = c?.comparisonBasis;
    assert.ok(b !== null && b !== undefined);
    assert.ok((b['protein'] ?? 0) >= 5, 'a trace-protein food must not qualify');
    assert.ok((b['kcal'] ?? 0) > 25, 'a nutritionally negligible beverage must not win');
  });

  test('FAT_ALREADY_HIGH does not pile on fat', () => {
    const c = namedCases().find((x) => x.name === 'FAT_ALREADY_HIGH');
    assert.ok((c?.remaining['fat'] ?? 0) <= 0, 'the scenario really is exhausted');
    assert.ok((c?.comparisonBasis?.fat ?? 99) < 10,
      'the winner must not materially worsen an exhausted allowance');
  });

  test('PROTEIN_ALREADY_MET stops chasing protein', () => {
    const c = namedCases().find((x) => x.name === 'PROTEIN_ALREADY_MET');
    assert.ok((c?.remaining['protein'] ?? 0) <= 0);
    assert.ok((c?.comparisonBasis?.protein ?? 99) < 5,
      'protein is met; a high-protein percentage must not keep winning');
  });

  test('CARBS_NEEDED_PRE_WORKOUT materially addresses carbohydrate', () => {
    const c = namedCases().find((x) => x.name === 'CARBS_NEEDED_PRE_WORKOUT');
    assert.ok((c?.comparisonBasis?.carbohydrate ?? 0) >= 8);
  });

  test('SMALL_CALORIE_BUDGET makes real progress within the budget', () => {
    const c = namedCases().find((x) => x.name === 'SMALL_CALORIE_BUDGET');
    const b = c?.comparisonBasis;
    assert.ok((b?.kcal ?? 0) > 25, 'zero-calorie irrelevance must not be rewarded');
    assert.ok((b?.protein ?? 0) + (b?.carbohydrate ?? 0) >= 5,
      'it must contribute something the user still needs');
  });

  test('CONTROLLED_SURPLUS allows density but not a pathological pure fat', () => {
    const c = namedCases().find((x) => x.name === 'CONTROLLED_SURPLUS');
    const shares = c?.topMacroShares;
    assert.ok((shares?.['fat'] ?? 100) < 90,
      'a near-pure-fat candidate must not win on density alone');
  });

  test('honest degradation is preserved exactly as in INT-1', () => {
    const exceeded = namedCases().find((x) => x.name === 'CALORIES_ALREADY_EXCEEDED');
    assert.equal(exceeded?.status, 'energy_budget_exhausted');
    assert.equal(exceeded?.top, null);
    const none = namedCases().find((x) => x.name === 'NO_GOOD_CANDIDATE');
    assert.equal(none?.status, 'no_eligible_candidates');
    assert.equal(none?.top, null);
  });
});

describe('INT-2 — comparison basis is not portion authority', () => {
  test('no named case fabricates a portion', () => {
    // The generic seed has no serving weights, so the engine must recommend the
    // FOOD while declining to state an amount. Ranking on a 100 g basis must
    // never leak out as "eat 100 g".
    for (const c of namedCases()) {
      if (c.top === null) continue;
      assert.equal(c.groundedPortionGrams, null);
      assert.equal(c.portionStatable, false);
    }
  });

  test('the engine separates the two concepts in code', () => {
    const engine = readFileSync(
      repoPath('packages', 'domain-recommendation', 'src', 'engine.ts'), 'utf8');
    assert.match(engine, /COMPARISON quantity only/);
    assert.match(engine, /never become a `portionProposal`/);
    // Portion authority is unchanged: still only source serving or history.
    assert.match(engine, /PORTION AUTHORITY/);
  });

  test('portion authority still has exactly two grounded bases', () => {
    const engine = readFileSync(
      repoPath('packages', 'domain-recommendation', 'src', 'engine.ts'), 'utf8');
    assert.match(engine, /There is deliberately no third option/);
  });

  test('the policy version records the semantic change', () => {
    const e = evaluation();
    // INT-3 changes ranking semantics again, so the version moves with it.
    assert.equal(e.policyVersion, 'recommendation-policy@3.0.0');
  });

  test('thresholds live in the typed policy, not scattered constants', () => {
    const policy = readFileSync(
      repoPath('packages', 'domain-recommendation', 'src', 'policy.ts'), 'utf8');
    for (const field of ['basisGrams', 'minMeaningfulGrams', 'fullClosureFraction',
                         'usefulEnergyFraction', 'exhaustedMacro']) {
      assert.ok(policy.includes(field), `${field} must be policy-versioned`);
    }
  });

  test('no food name is hard-coded anywhere in the engine or policy', () => {
    // The fix had to be a scoring principle, not a blacklist. Comments may name
    // the foods that EXPOSED the defect — that is the explanation of why the
    // rule exists — but no executable line may branch on a food name.
    for (const f of ['engine.ts', 'policy.ts']) {
      const code = readFileSync(repoPath('packages', 'domain-recommendation', 'src', f), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
        .toLowerCase();
      for (const name of ['coffee', 'whale', 'beluga', 'juice']) {
        assert.equal(code.includes(name), false, `${f} branches on ${name}`);
      }
      assert.equal(/displayname\s*(===|!==|\.includes)/.test(code), false,
        `${f} must not match on food names at all`);
    }
  });
});


describe('INT-3 — actionability is derived, never blacklisted', () => {
  test('no food name appears in the classifier', () => {
    // A blacklist would suppress the four foods that surfaced in testing and
    // leave every other flour, oil and organ meat still winning.
    const code = readFileSync(
      repoPath('packages', 'domain-catalog', 'src', 'actionability.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').toLowerCase();
    //  is deliberately NOT in this list: it sits among liver, kidney
    // and tripe as an organ-meat FORM term, which classifies thousands of
    // records rather than one food.
    for (const name of ['soy flour', 'cottonseed', 'whale', 'beluga', 'coffee']) {
      assert.equal(code.includes(name), false, `classifier names ${name}`);
    }
    // `giblets` DOES appear as an organ-meat form term, which generalises to
    // liver, kidney and tripe alike — a form rule, not a named food.
    const raw = readFileSync(
      repoPath('packages', 'domain-catalog', 'src', 'actionability.ts'), 'utf8');
    assert.match(raw, /variety meats/, 'organ meats are matched as a FORM class');
  });

  test('classification comes from source metadata', async () => {
    const { assessActionability } = await import('@macros/domain-catalog');
    // Form beats category: "Soy flour" is filed under Legumes, but the form is
    // what decides whether a person can eat it.
    const flour = assessActionability({
      displayName: 'Soy flour, defatted', category: 'Legumes and Legume Products',
      preparationState: 'as_sold', sourceDescription: 'Soy flour, defatted',
    });
    assert.equal(flour.actionabilityClass, 'ingredient');
    assert.equal(flour.basis, 'form');

    const chicken = assessActionability({
      displayName: 'Chicken breast, cooked', category: 'Poultry Products',
      preparationState: 'cooked', sourceDescription: 'Chicken breast, cooked',
    });
    assert.equal(chicken.actionabilityClass, 'meal_component');
  });

  test('raw means uncooked, not inedible', async () => {
    const { assessActionability } = await import('@macros/domain-catalog');
    const banana = assessActionability({
      displayName: 'Banana, raw', category: 'Fruits and Fruit Juices',
      preparationState: 'raw', sourceDescription: 'Banana, raw',
    });
    assert.equal(banana.actionabilityClass, 'ready_to_eat');
    const rawChicken = assessActionability({
      displayName: 'Chicken breast, raw', category: 'Poultry Products',
      preparationState: 'raw', sourceDescription: 'Chicken breast, raw',
    });
    assert.equal(rawChicken.actionabilityClass, 'requires_preparation');
  });

  test('the rule generalises beyond the foods that exposed it', async () => {
    const { assessActionability } = await import('@macros/domain-catalog');
    for (const [name, cat] of [
      ['Rice flour, brown', 'Cereal Grains and Pasta'],
      ['Almond flour', 'Nut and Seed Products'],
      ['Canola oil', 'Fats and Oils'],
      ['Beef liver, raw', 'Beef Products'],
    ] as const) {
      const a = assessActionability({
        displayName: name, category: cat, preparationState: 'as_sold',
        sourceDescription: name,
      });
      assert.notEqual(a.actionabilityClass, 'ready_to_eat', `${name} classed as ready to eat`);
      assert.ok(a.score <= 0.5, `${name} scored ${a.score}`);
    }
  });
});

describe('INT-3 — authoritative energy, no second calculator', () => {
  test('the engine no longer computes calories itself', () => {
    const engine = readFileSync(
      repoPath('packages', 'domain-recommendation', 'src', 'engine.ts'), 'utf8');
    // INT-2 computed protein*4 + carb*4 + fat*9 for the comparison basis.
    assert.equal(/KCAL_PER_G\.protein\s*\n?\s*\+.*KCAL_PER_G\.carbohydrate/.test(engine), false);
    assert.match(engine, /AUTHORITATIVE energy/);
    assert.match(engine, /calculateNutrition\(\s*\n?\s*v\.basis, comparison\.basisGrams/);
  });
});

describe('INT-3 — hard closure requirements', () => {
  const e = () => evaluation();
  const t = () => evaluation().topPickProfile;

  test('every INT-2 pathology remains eliminated', () => {
    assert.equal(e().hardViolationRatePercent, 0);
    assert.equal(t().nearZeroEnergyWinsPercent, 0);
    assert.equal(t().extremeDensityWinsPercent, 0);
    assert.equal(t().exhaustedMacroViolationRatePercent, 0);
    assert.equal(e().unnecessaryOvershootRatePercent, 0);
  });

  test('a low-actionability record never wins over a qualifying alternative', () => {
    assert.equal(t().lowActionabilityDespiteAlternativePercent, 0);
  });

  test('actionable foods now win almost always', () => {
    assert.ok(t().actionableWinnerRatePercent > 95);
  });

  test('no named case fabricates a portion', () => {
    for (const c of namedCases()) {
      if (c.top === null) continue;
      assert.equal(c.portionStatable, false);
    }
  });

  test('honest degradation is still preserved', () => {
    const exceeded = namedCases().find((x) => x.name === 'CALORIES_ALREADY_EXCEEDED');
    assert.equal(exceeded?.status, 'energy_budget_exhausted');
    const none = namedCases().find((x) => x.name === 'NO_GOOD_CANDIDATE');
    assert.equal(none?.status, 'no_eligible_candidates');
  });

  test('the measured nutritional cost of the gate is recorded, not hidden', () => {
    // INT-2 frozen baseline was 93.3% on the same independent metric.
    // The gate trades some nutritional targeting for actionability; the number
    // stays visible rather than being tuned away.
    assert.ok(e().macroFitRatePercent < 93.3);
    assert.ok(e().macroFitRatePercent > 80);
  });
});
