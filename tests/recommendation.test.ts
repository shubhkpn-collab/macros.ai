import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_RECOMMENDATION_POLICY, isEligible, macroDeficitWeights, macroEnergyShares,
  observationsFromLogs, proposePortion, recommendFoods,
  type HistoryObservation, type PreferenceSnapshot, type RecommendationCandidate,
  type RecommendationInput,
} from '@macros/domain-recommendation';
import { calculateNutrition } from '@macros/domain-nutrition';
import { foldFoodLogEntries, createFoodLogItem, buildVoidEntry, buildCorrectionEntry } from '@macros/domain-food-log';
import { manualCapture } from '@macros/domain-weight';
import { grams, instant, type EnergyState, type MacroState, type ProductCatalogHead, type ProductVersion } from '@macros/contracts';
import {
  SYNTHETIC_PRODUCTS, SYNTHETIC_CATALOG_HEADS, SYNTHETIC_BRANDED_PRODUCTS,
  SYNTHETIC_BRANDED_HEADS, USER_A, USER_B, approx,
} from '@macros/testkit';

const NOW = '2026-08-23T18:00:00.000Z';
const TZ = 'America/Chicago';

const headFor = (v: ProductVersion): ProductCatalogHead => ({
  productId: v.productId,
  currentProductVersionId: v.productVersionId,
  isActive: true,
  updatedAt: instant('2026-01-01T00:00:00.000Z'),
});

const ALL = [...SYNTHETIC_PRODUCTS, ...SYNTHETIC_BRANDED_PRODUCTS];
const HEADS = [...SYNTHETIC_CATALOG_HEADS, ...SYNTHETIC_BRANDED_HEADS];
const candidateFor = (v: ProductVersion): RecommendationCandidate => ({
  productVersion: v,
  head: HEADS.find((h) => h.productId === v.productId && h.currentProductVersionId === v.productVersionId)
    ?? headFor(v),
});
const CANDIDATES = ALL
  .filter((v) => HEADS.some((h) => h.currentProductVersionId === v.productVersionId && h.isActive))
  .map(candidateFor);

const CHICKEN = ALL.find((p) => p.displayName === 'Chicken breast, cooked')!;
const OATS = ALL.find((p) => p.productVersionId === 'synb-oats-old-fashioned@v1')!;

const macroState = (over: Partial<{ p: number; c: number; f: number; tp: number; tc: number; tf: number }> = {}): MacroState => ({
  targets: {
    kcal: 2400 as never,
    proteinG: (over.tp ?? 160) as never,
    carbohydrateG: (over.tc ?? 250) as never,
    fatG: (over.tf ?? 80) as never,
    policyVersion: 'test-macro@1',
  } as never,
  consumedKcal: 0 as never,
  consumedProteinG: 0 as never,
  consumedCarbohydrateG: 0 as never,
  consumedFatG: 0 as never,
  remainingKcal: 1200 as never,
  remainingProteinG: (over.p ?? 120) as never,
  remainingCarbohydrateG: (over.c ?? 100) as never,
  remainingFatG: (over.f ?? 40) as never,
  calcVersion: 'test-macro@1',
});

const energyState = (remainingIntakeKcal: number): EnergyState => ({
  projectedTotalExpenditureKcal: 2600 as never,
  currentBalanceKcal: -400 as never,
  remainingIntakeKcal: remainingIntakeKcal as never,
  ifNoMoreFoodBalanceKcal: -1200 as never,
} as unknown as EnergyState);

const input = (over: Partial<RecommendationInput> = {}): RecommendationInput => ({
  userId: USER_A,
  nowIso: NOW,
  energy: energyState(1200),
  macros: macroState(),
  candidates: CANDIDATES,
  history: [],
  preferences: null,
  policy: DEFAULT_RECOMMENDATION_POLICY,
  environment: 'test',
  ...over,
});

const obs = (productId: string, productVersionId: string, g: number, daysAgo: number): HistoryObservation => ({
  productId,
  productVersionId,
  grams: g,
  loggedAt: instant(new Date(Date.parse(NOW) - daysAgo * 86_400_000).toISOString()),
  localDate: new Date(Date.parse(NOW) - daysAgo * 86_400_000).toISOString().slice(0, 10),
});

// ---------------------------------------------------------------------------

describe('B16/B17 — macro deficits are normalized, not raw grams', () => {
  test('100 g of carbs remaining does not outweigh 30 g of protein remaining', () => {
    // 30/160 protein ≈ 0.1875 fraction; 100/250 carbs = 0.40 fraction.
    // But with a much smaller protein target the protein gap dominates:
    const w = macroDeficitWeights(
      { protein: 30, carbohydrate: 100, fat: 0 },
      { protein: 40, carbohydrate: 400, fat: 80 },
    );
    assert.ok(w.protein > w.carbohydrate, 'fractions of target, not raw grams');
  });

  test('weights sum to 1 and are dimensionless', () => {
    const w = macroDeficitWeights(
      { protein: 120, carbohydrate: 100, fat: 40 },
      { protein: 160, carbohydrate: 250, fat: 80 },
    );
    assert.ok(approx(w.protein + w.carbohydrate + w.fat, 1, 1e-9));
  });

  test('a met macro contributes no weight', () => {
    const w = macroDeficitWeights(
      { protein: 0, carbohydrate: 100, fat: 40 },
      { protein: 160, carbohydrate: 250, fat: 80 },
    );
    assert.equal(w.protein, 0);
  });

  test('all macros met yields zero weights rather than NaN', () => {
    const w = macroDeficitWeights(
      { protein: 0, carbohydrate: 0, fat: 0 },
      { protein: 160, carbohydrate: 250, fat: 80 },
    );
    assert.deepEqual(w, { protein: 0, carbohydrate: 0, fat: 0 });
  });

  test('a zero or missing target does not divide by zero', () => {
    const w = macroDeficitWeights(
      { protein: 30, carbohydrate: 10, fat: 5 },
      { protein: 0, carbohydrate: 250, fat: 80 },
    );
    assert.ok(Number.isFinite(w.protein));
    assert.equal(w.protein, 0);
  });

  test("a candidate's macro shares sum to 1", () => {
    const s = macroEnergyShares(CHICKEN);
    assert.ok(approx(s.protein + s.carbohydrate + s.fat, 1, 1e-9));
    assert.ok(s.protein > 0.7, 'chicken breast is protein-dominant');
  });

  test('a zero-energy candidate yields zero shares, not NaN', () => {
    const empty = { ...CHICKEN, basis: { ...CHICKEN.basis, kcal: 0, proteinG: 0, carbohydrateG: 0, fatG: 0 } };
    const s = macroEnergyShares(empty);
    assert.deepEqual(s, { protein: 0, carbohydrate: 0, fat: 0 });
  });
});

describe('B11/B12 — portions are never invented', () => {
  test('a branded product proposes a multiple of its SOURCE serving', () => {
    const p = proposePortion(candidateFor(OATS), input(), 1200);
    assert.notEqual(p, null);
    assert.equal(p!.basis, 'source_serving');
    const serving = OATS.labelFacts!.servingGrams!;
    assert.ok(DEFAULT_RECOMMENDATION_POLICY.servingMultiples.some(
      (mult) => approx(p!.grams as number, Math.round(serving * mult * 10) / 10, 1e-9),
    ), 'a grounded multiple, not an arbitrary number');
  });

  test('a generic food with NO serving basis and no history proposes nothing', () => {
    const p = proposePortion(candidateFor(CHICKEN), input(), 1200);
    assert.equal(p, null, 'no quantity is invented');
  });

  test('the engine NEVER divides remaining calories by energy density', () => {
    // 1200 kcal remaining / 1.65 kcal per g would be ~727 g of chicken.
    const set = recommendFoods(input());
    for (const r of set.recommendations) {
      if (r.portionProposal === undefined) continue;
      assert.ok((r.portionProposal.grams as number) <= DEFAULT_RECOMMENDATION_POLICY.bounds.maxPortionGrams);
    }
    const chicken = set.recommendations.find((r) => r.productVersionId === CHICKEN.productVersionId);
    if (chicken !== undefined) assert.equal(chicken.portionProposal, undefined);
  });

  test('portion proposals stay within scale range and policy bounds', () => {
    const set = recommendFoods(input());
    for (const r of set.recommendations) {
      const g = r.portionProposal?.grams as number | undefined;
      if (g === undefined) continue;
      assert.ok(g > 0 && g <= 5000);
      assert.ok(g >= DEFAULT_RECOMMENDATION_POLICY.bounds.minPortionGrams);
    }
  });
});

describe('B13 — history-derived portions require a transparent policy', () => {
  const history = (n: number, g = 150) =>
    Array.from({ length: n }, (_, i) => obs(CHICKEN.productId, CHICKEN.productVersionId, g, i + 1));

  test('insufficient samples produce NO history portion', () => {
    const p = proposePortion(candidateFor(CHICKEN), input({ history: history(2) }), 1200);
    assert.equal(p, null);
  });

  test('enough samples produce a median portion', () => {
    const samples = [
      obs(CHICKEN.productId, CHICKEN.productVersionId, 100, 1),
      obs(CHICKEN.productId, CHICKEN.productVersionId, 150, 2),
      obs(CHICKEN.productId, CHICKEN.productVersionId, 200, 3),
    ];
    const p = proposePortion(candidateFor(CHICKEN), input({ history: samples }), 1200);
    assert.notEqual(p, null);
    assert.equal(p!.basis, 'user_history');
    assert.equal(p!.grams as number, 150, 'the median, not the mean or the maximum');
    assert.equal(p!.sampleCount, 3);
  });

  test('observations outside the window do not count', () => {
    const old = history(5).map((h) => ({ ...h, loggedAt: instant('2025-01-01T00:00:00.000Z') }));
    assert.equal(proposePortion(candidateFor(CHICKEN), input({ history: old }), 1200), null);
  });

  test("another product's history is not borrowed", () => {
    const other = Array.from({ length: 5 }, (_, i) => obs('some-other-product', 'x@v1', 150, i + 1));
    assert.equal(proposePortion(candidateFor(CHICKEN), input({ history: other }), 1200), null);
  });

  test('an out-of-bounds observed portion is excluded', () => {
    const absurd = Array.from({ length: 5 }, (_, i) => obs(CHICKEN.productId, CHICKEN.productVersionId, 4000, i + 1));
    assert.equal(proposePortion(candidateFor(CHICKEN), input({ history: absurd }), 1200), null);
  });
});

describe('B6 — candidate eligibility', () => {
  test('an inactive head is excluded', () => {
    const c = candidateFor(CHICKEN);
    assert.equal(isEligible({ ...c, head: { ...c.head, isActive: false } }, input()), false);
  });

  test('a superseded version is excluded', () => {
    const c = candidateFor(CHICKEN);
    assert.equal(
      isEligible({ ...c, head: { ...c.head, currentProductVersionId: 'other@v2' } }, input()),
      false,
      'only the current head version may be recommended',
    );
  });

  test('incomplete core nutrition is excluded', () => {
    const c = candidateFor(CHICKEN);
    const broken = { ...c, productVersion: { ...CHICKEN, basis: { ...CHICKEN.basis, proteinG: Number.NaN } } };
    assert.equal(isEligible(broken, input()), false);
  });

  test('synthetic fixtures are REFUSED in production and staging', () => {
    const c = candidateFor(CHICKEN);
    const synthetic = {
      ...c,
      productVersion: { ...CHICKEN, source: { ...CHICKEN.source, verificationStatus: 'synthetic_test' as const } },
    };
    assert.equal(isEligible(synthetic, input({ environment: 'production' })), false);
    assert.equal(isEligible(synthetic, input({ environment: 'staging' })), false);
    assert.equal(isEligible(synthetic, input({ environment: 'test' })), true);
  });

  test('an avoided product is a HARD filter', () => {
    const prefs: PreferenceSnapshot = {
      userId: USER_A, preferredProductIds: [], avoidedProductIds: [CHICKEN.productId],
    };
    assert.equal(isEligible(candidateFor(CHICKEN), input({ preferences: prefs })), false);

    const set = recommendFoods(input({ preferences: prefs }));
    assert.ok(!set.recommendations.some((r) => r.productId === CHICKEN.productId));
  });

  test('a preference is only a nudge, never a filter', () => {
    const prefs: PreferenceSnapshot = {
      userId: USER_A, preferredProductIds: [CHICKEN.productId], avoidedProductIds: [],
    };
    const set = recommendFoods(input({ preferences: prefs }));
    assert.ok(set.recommendations.length > 1, 'other foods still appear');
  });
});

describe('B4/B19/B22 — missing state and exhausted budget', () => {
  test('no macro target yields insufficient_state', () => {
    const set = recommendFoods(input({ macros: null }));
    assert.equal(set.status, 'insufficient_state');
    assert.equal(set.recommendations.length, 0);
  });

  test('no energy state still allows macro-aware recommendations, with limited confidence', () => {
    const set = recommendFoods(input({ energy: null }));
    assert.equal(set.status, 'available_with_limited_energy_confidence');
    assert.ok(set.recommendations.length > 0);
  });

  test('missing energy is never treated as a zero budget', () => {
    const set = recommendFoods(input({ energy: null }));
    assert.notEqual(set.status, 'energy_budget_exhausted');
  });

  test('a spent energy budget stops recommending more food', () => {
    const set = recommendFoods(input({ energy: energyState(0) }));
    assert.equal(set.status, 'energy_budget_exhausted');
    assert.equal(set.recommendations.length, 0);
  });

  test('a negative remaining intake also stops', () => {
    const set = recommendFoods(input({ energy: energyState(-300) }));
    assert.equal(set.status, 'energy_budget_exhausted');
  });

  test('an empty catalog yields no_eligible_candidates', () => {
    const set = recommendFoods(input({ candidates: [] }));
    assert.equal(set.status, 'no_eligible_candidates');
  });

  test('preferences excluding everything yields no_eligible_candidates', () => {
    const prefs: PreferenceSnapshot = {
      userId: USER_A, preferredProductIds: [],
      avoidedProductIds: CANDIDATES.map((c) => c.productVersion.productId),
    };
    const set = recommendFoods(input({ preferences: prefs }));
    assert.equal(set.status, 'no_eligible_candidates');
  });
});

describe('B24/B25/B27 — result structure and determinism', () => {
  test('results are bounded and carry policy version', () => {
    const set = recommendFoods(input());
    assert.ok(set.recommendations.length <= DEFAULT_RECOMMENDATION_POLICY.maxResults);
    assert.equal(set.policyVersion, DEFAULT_RECOMMENDATION_POLICY.version);
  });

  test('identical inputs produce identical rankings', () => {
    const a = recommendFoods(input());
    const b = recommendFoods(input());
    assert.deepEqual(a.recommendations.map((r) => r.productVersionId), b.recommendations.map((r) => r.productVersionId));
  });

  test('ranking does not depend on candidate array order', () => {
    const forward = recommendFoods(input());
    const reversed = recommendFoods(input({ candidates: [...CANDIDATES].reverse() }));
    assert.deepEqual(
      forward.recommendations.map((r) => r.productVersionId),
      reversed.recommendations.map((r) => r.productVersionId),
    );
  });

  test('ties break deterministically by product version id', () => {
    const set = recommendFoods(input());
    for (let i = 1; i < set.recommendations.length; i++) {
      const prev = set.recommendations[i - 1]!;
      const cur = set.recommendations[i]!;
      if (approx(prev.score, cur.score, 1e-9)) {
        assert.ok(prev.productVersionId.localeCompare(cur.productVersionId) < 0);
      }
    }
  });

  test('score components are exposed, not hidden in one magic number', () => {
    const set = recommendFoods(input());
    const r = set.recommendations[0]!;
    for (const k of ['macroFit', 'energyFit', 'historyNudge', 'preferenceNudge',
                     'energyOvershootPenalty', 'macroOvershootPenalty', 'repetitionPenalty']) {
      assert.ok(k in r.scoreComponents, k);
    }
    assert.ok(r.rationaleCodes.length > 0);
  });

  test('nutrition at a proposed portion comes from the nutrition engine', () => {
    const set = recommendFoods(input());
    for (const r of set.recommendations) {
      if (r.portionProposal === undefined) continue;
      const version = ALL.find((v) => v.productVersionId === r.productVersionId)!;
      const expected = calculateNutrition(version.basis, r.portionProposal.grams).totals;
      assert.deepEqual(r.nutritionAtProposedPortion, expected);
    }
  });
});

describe('B20/B21 — goal direction changes the budget, never expenditure', () => {
  const runWith = (remainingIntake: number) => recommendFoods(input({ energy: energyState(remainingIntake) }));

  test('different target deltas give different budgets and can change portions', () => {
    const lose = runWith(400);
    const gain = runWith(1600);
    assert.equal(lose.status, 'available');
    assert.equal(gain.status, 'available');

    const oatsLose = lose.recommendations.find((r) => r.productVersionId === OATS.productVersionId);
    const oatsGain = gain.recommendations.find((r) => r.productVersionId === OATS.productVersionId);
    if (oatsLose?.portionProposal !== undefined && oatsGain?.portionProposal !== undefined) {
      assert.ok(
        (oatsGain.portionProposal.grams as number) >= (oatsLose.portionProposal.grams as number),
        'a larger budget never proposes a smaller grounded portion',
      );
    }
  });

  test('the engine never modifies expenditure', () => {
    const energy = energyState(1200);
    const before = JSON.stringify(energy);
    recommendFoods(input({ energy }));
    assert.equal(JSON.stringify(energy), before, 'energy state is read-only here');
  });

  test('no diet labels or moral language appears in rationale codes', () => {
    const set = recommendFoods(input());
    const codes = set.recommendations.flatMap((r) => r.rationaleCodes).join(' ');
    for (const banned of ['clean', 'cheat', 'bad', 'good_food', 'guilt', 'healthy']) {
      assert.ok(!codes.includes(banned), banned);
    }
  });
});

describe('B30/B34 — history integration and user isolation', () => {
  const logFor = (userId: string, version: ProductVersion, g: number, logId: string) =>
    createFoodLogItem({
      logId, userId, productVersion: version,
      weightCapture: manualCapture(g, instant(NOW)),
      loggedAt: instant(NOW), timezone: TZ,
    });

  test('voided logs never influence history', () => {
    const a = logFor(USER_A, CHICKEN, 200, 'l1');
    const v = buildVoidEntry(a, { logId: 'v1', recordedAt: instant(NOW) });
    const fold = foldFoodLogEntries(USER_A, [a, v]);
    const observations = observationsFromLogs(USER_A, fold.effective.map(toRow));
    assert.equal(observations.length, 0, 'a voided meal did not happen');
  });

  test('corrected logs contribute the CORRECTED portion only', () => {
    const a = logFor(USER_A, CHICKEN, 200, 'l1');
    const b = buildCorrectionEntry(a, {
      logId: 'l2', grams: grams(120),
      weightCapture: manualCapture(120, instant(NOW)),
      nutritionSnapshot: { ...a.nutritionSnapshot, gramsConsumed: 120, totals: calculateNutrition(CHICKEN.basis, grams(120)).totals },
      loggedAt: instant(NOW), reason: 'reweighed',
    });
    const fold = foldFoodLogEntries(USER_A, [a, b]);
    const observations = observationsFromLogs(USER_A, fold.effective.map(toRow));
    assert.equal(observations.length, 1);
    assert.equal(observations[0]!.grams, 120, 'not the superseded 200');
  });

  test("another user's history never reaches this user's observations", () => {
    const mine = logFor(USER_A, CHICKEN, 200, 'l1');
    const theirs = logFor(USER_B, CHICKEN, 400, 'l2');
    const observations = observationsFromLogs(USER_A, [mine, theirs].map(toRow));
    assert.equal(observations.length, 1);
    assert.equal(observations[0]!.grams, 200);
  });

  test('two users with identical macro state but different histories rank differently', () => {
    const aHistory = Array.from({ length: 3 }, (_, i) => obs(OATS.productId, OATS.productVersionId, 40, i + 1));
    const withHistory = recommendFoods(input({ userId: USER_A, history: aHistory }));
    const withoutHistory = recommendFoods(input({ userId: USER_B, history: [] }));

    const oatsA = withHistory.recommendations.find((r) => r.productVersionId === OATS.productVersionId);
    const oatsB = withoutHistory.recommendations.find((r) => r.productVersionId === OATS.productVersionId);
    if (oatsA !== undefined && oatsB !== undefined) {
      assert.ok(oatsA.score > oatsB.score, "A's own history nudges A only");
      assert.ok(oatsA.rationaleCodes.includes('recently_used'));
      assert.ok(!oatsB.rationaleCodes.includes('recently_used'));
    }
  });
});

const toRow = (l: { userId: string; productId: string; productVersionId: string; grams: unknown; loggedAt: string; localDate: string }) => ({
  userId: l.userId,
  productId: l.productId,
  productVersionId: l.productVersionId,
  grams: l.grams as number,
  loggedAt: l.loggedAt,
  localDate: l.localDate,
});

describe('B31/B32/B33 — reformulation safety', () => {
  test('history on V1 maps to the CURRENT V2 candidate', () => {
    const v2: ProductVersion = {
      ...OATS,
      productVersionId: `${OATS.productId}@v2`,
      versionNo: 2,
      basis: { ...OATS.basis, kcal: 390 },
      labelFacts: { ...OATS.labelFacts, servingGrams: 45 },
    };
    const candidate: RecommendationCandidate = {
      productVersion: v2,
      head: { productId: v2.productId, currentProductVersionId: v2.productVersionId, isActive: true, updatedAt: instant(NOW) },
    };
    // The user historically logged V1 of the same stable product.
    const history = Array.from({ length: 3 }, (_, i) => obs(OATS.productId, OATS.productVersionId, 40, i + 1));

    const set = recommendFoods(input({ candidates: [candidate], history }));
    assert.equal(set.recommendations.length, 1);
    const r = set.recommendations[0]!;
    assert.equal(r.productVersionId, v2.productVersionId, 'the current version is recommended');
    assert.ok(r.rationaleCodes.includes('recently_used'), 'history recognised across the reformulation');
  });

  test("a source portion uses V2's serving mass, never V1's", () => {
    const v2: ProductVersion = {
      ...OATS,
      productVersionId: `${OATS.productId}@v2`,
      versionNo: 2,
      labelFacts: { ...OATS.labelFacts, servingGrams: 45 },
    };
    const p = proposePortion(
      { productVersion: v2, head: { productId: v2.productId, currentProductVersionId: v2.productVersionId, isActive: true, updatedAt: instant(NOW) } },
      input(), 1200,
    );
    assert.notEqual(p, null);
    const multiples = DEFAULT_RECOMMENDATION_POLICY.servingMultiples.map((m) => Math.round(45 * m * 10) / 10);
    assert.ok(multiples.includes(p!.grams as number), 'grounded in the CURRENT serving mass');
    const oldMultiples = DEFAULT_RECOMMENDATION_POLICY.servingMultiples.map((m) => 40 * m);
    assert.ok(!oldMultiples.includes(p!.grams as number) || multiples.includes(p!.grams as number));
  });

  test('recommendation nutrition uses the CURRENT version basis', () => {
    const v2: ProductVersion = {
      ...OATS,
      productVersionId: `${OATS.productId}@v2`,
      versionNo: 2,
      basis: { ...OATS.basis, kcal: 390 },
    };
    const set = recommendFoods(input({
      candidates: [{ productVersion: v2, head: { productId: v2.productId, currentProductVersionId: v2.productVersionId, isActive: true, updatedAt: instant(NOW) } }],
    }));
    const r = set.recommendations[0]!;
    if (r.nutritionAtProposedPortion !== undefined && r.portionProposal !== undefined) {
      const expected = calculateNutrition(v2.basis, r.portionProposal.grams).totals;
      assert.deepEqual(r.nutritionAtProposedPortion, expected, 'V2 nutrition, never V1');
    }
  });
});

describe('B18 — overshoot policy', () => {
  test('a portion far beyond the remaining budget is HARD filtered', () => {
    // A tiny remaining budget: no grounded oats portion can fit within 125%.
    const set = recommendFoods(input({ energy: energyState(5), macros: macroState() }));
    const oats = set.recommendations.find((r) => r.productVersionId === OATS.productVersionId);
    if (oats !== undefined) {
      assert.equal(oats.portionProposal, undefined, 'no overshooting portion survives');
    }
  });

  test('a mild overshoot is penalized, not eliminated', () => {
    const set = recommendFoods(input({ energy: energyState(1200) }));
    for (const r of set.recommendations) {
      if (r.rationaleCodes.includes('would_overshoot_energy')) {
        assert.ok(r.scoreComponents.energyOvershootPenalty > 0);
      }
    }
    assert.ok(set.recommendations.length > 0);
  });

  test('a fitting portion is marked as fitting', () => {
    const set = recommendFoods(input({ energy: energyState(1200) }));
    const withPortion = set.recommendations.filter((r) => r.portionProposal !== undefined);
    for (const r of withPortion) {
      assert.ok(
        r.rationaleCodes.includes('fits_remaining_energy') ||
        r.rationaleCodes.includes('would_overshoot_energy'),
      );
    }
  });
});

describe('B40 — performance is linear, not quadratic (synthetic)', () => {
  test('scales linearly across a synthetic catalog', () => {
    const synth = (n: number): RecommendationCandidate[] =>
      Array.from({ length: n }, (_, i) => {
        const v: ProductVersion = {
          ...CHICKEN,
          productId: `perf-${i}`,
          productVersionId: `perf-${i}@v1`,
        };
        return { productVersion: v, head: { productId: v.productId, currentProductVersionId: v.productVersionId, isActive: true, updatedAt: instant(NOW) } };
      });

    const time = (n: number): number => {
      const c = synth(n);
      const t0 = performance.now();
      recommendFoods(input({ candidates: c }));
      return performance.now() - t0;
    };
    time(200); // warm up
    const small = time(500);
    const large = time(4000);

    // 8× the candidates must not cost anything like 64× the time.
    assert.ok(large < Math.max(small * 24, 250), `500:${small.toFixed(1)}ms 4000:${large.toFixed(1)}ms`);
  });
});
