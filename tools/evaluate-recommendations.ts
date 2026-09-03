/**
 * INT-1 — ADVERSARIAL EVALUATION OF THE RECOMMENDATION ENGINE.
 *
 * This MEASURES the existing engine. It does not correct it, and no failure
 * here is fixed in this milestone: the point is to establish what the engine
 * actually does before anyone decides what to change.
 *
 * Rules that shape the design:
 *   - the REAL `recommendFoods` is exercised; there is no second algorithm;
 *   - candidate foods come from the trusted catalog with real nutrition;
 *   - only user STATE is synthetic;
 *   - correctness is judged by deterministic nutrition arithmetic, never by
 *     asserting that one named food must beat another.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import {
  DEFAULT_RECOMMENDATION_POLICY, recommendFoods,
  type RecommendationCandidate, type RecommendationInput, type RecommendationSet,
} from '@macros/domain-recommendation';
import { assessRole as assessRoleRaw, recommendFoodPlan } from '@macros/domain-recommendation';
import { repoPath } from './repo-paths.js';

const GENERIC = repoPath('data', 'usda-seed.json');
const OUT = repoPath('data', 'recommendation-evaluation.json');

const assessRole = (v: unknown): string => assessRoleRaw(v as never).role;

const NOW = '2026-08-29T18:00:00.000Z';
const LOCAL_DATE = '2026-08-29';
const USER = '11111111-1111-4111-8111-111111111111';

// ---------------------------------------------------------------------------
// REAL catalog candidates. Nutrition is never fabricated.
// ---------------------------------------------------------------------------

interface Seed {
  productId: string;
  displayName: string;
  preparationState: string;
  per100g?: Record<string, { amount?: number }>;
  recommendable?: boolean;
  category?: string;
  sourceDescription?: string;
}

const amount = (s: Seed, key: string): number | null => {
  const node = s.per100g?.[key];
  return typeof node?.amount === 'number' ? node.amount : null;
};

function loadCandidates(): RecommendationCandidate[] {
  const seeds = JSON.parse(readFileSync(GENERIC, 'utf8')) as Seed[];
  const out: RecommendationCandidate[] = [];
  for (const s of seeds) {
    // Only foods the catalog itself marks recommendable, with complete macros.
    if (s.recommendable !== true) continue;
    const kcal = amount(s, 'energy_kcal');
    const protein = amount(s, 'protein');
    const carbs = amount(s, 'carbohydrate');
    const fat = amount(s, 'fat');
    if (kcal === null || protein === null || carbs === null || fat === null) continue;

    const productVersionId = `${s.productId}@v1`;
    out.push({
      productVersion: {
        productId: s.productId,
        productVersionId,
        versionNo: 1,
        displayName: s.displayName,
        preparationState: s.preparationState,
        basis: {
          kind: 'per_100g', kcal, proteinG: protein, carbohydrateG: carbs, fatG: fat,
        },
        source: {
          kind: 'usda_generic', sourceId: s.productId, verificationStatus: 'published',
        },
        effectiveFrom: '2026-01-01T00:00:00.000Z',
        // Real source metadata, carried through so actionability is assessed
        // from what the catalog actually says rather than a harness guess.
        category: s.category ?? null,
        sourceDescription: s.sourceDescription ?? s.displayName,
        // NO servingGrams. The generic USDA seed genuinely has none, and
        // injecting one would fabricate the very data DATA-1 identified as the
        // catalog's largest gap — then measure the engine against a catalog
        // that does not exist.
      } as never,
      head: {
        productId: s.productId,
        currentProductVersionId: productVersionId,
        isActive: true,
        updatedAt: '2026-01-01T00:00:00.000Z',
      } as never,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Scenario space
// ---------------------------------------------------------------------------

type Goal = 'lose' | 'maintain' | 'gain';
type DayPhase = 'early' | 'middle' | 'late';

interface Scenario {
  readonly id: string;
  readonly goal: Goal;
  readonly phase: DayPhase;
  readonly targetKcal: number;
  readonly consumedFraction: number;
  readonly proteinFraction: number;
  readonly carbFraction: number;
  readonly fatFraction: number;
  readonly balanceKcal: number;
}

const GOALS: Goal[] = ['lose', 'maintain', 'gain'];
const PHASES: DayPhase[] = ['early', 'middle', 'late'];
const TARGETS = [1600, 2000, 2400, 2800];
/** How much of the day's energy is already eaten. 1.15 = target exceeded. */
const CONSUMED = [0.05, 0.3, 0.55, 0.8, 0.95, 1.15];
/** Per-macro consumption as a fraction of that macro's target. */
const MACRO_MIXES: readonly [number, number, number][] = [
  [0.15, 0.60, 0.60],  // severe protein deficit
  [0.55, 0.60, 0.60],  // mild protein deficit
  [0.85, 0.25, 0.60],  // carbohydrate deficit
  [0.85, 0.70, 0.20],  // fat deficit
  [0.60, 0.60, 0.95],  // fat almost exhausted
  [0.60, 0.95, 0.60],  // carbohydrate almost exhausted
  [0.60, 0.60, 0.60],  // balanced remaining
  [1.05, 0.90, 0.90],  // protein already met
];

function buildScenarios(): Scenario[] {
  const out: Scenario[] = [];
  let n = 0;
  for (const goal of GOALS) {
    for (const phase of PHASES) {
      for (const targetKcal of TARGETS) {
        for (const consumedFraction of CONSUMED) {
          for (const [p, c, f] of MACRO_MIXES) {
            n += 1;
            // Balance varies with goal and how much of the day has passed.
            const drift = goal === 'lose' ? -400 : goal === 'gain' ? 250 : 0;
            const eaten = targetKcal * consumedFraction;
            out.push({
              id: `S${String(n).padStart(4, '0')}`,
              goal, phase, targetKcal, consumedFraction,
              proteinFraction: p, carbFraction: c, fatFraction: f,
              balanceKcal: Math.round(eaten - targetKcal + drift),
            });
          }
        }
      }
    }
  }
  return out;
}

/** Macro targets in grams, derived once from the energy target. */
const macroTargets = (targetKcal: number) => ({
  targetKcal,
  proteinG: Math.round((targetKcal * 0.30) / 4),
  carbohydrateG: Math.round((targetKcal * 0.40) / 4),
  fatG: Math.round((targetKcal * 0.30) / 9),
  policyVersion: 'macro-policy@int1-eval',
  policyReviewStatus: 'reviewed',
});

function inputFor(s: Scenario, candidates: readonly RecommendationCandidate[]): RecommendationInput {
  const t = macroTargets(s.targetKcal);
  const consumedKcal = Math.round(s.targetKcal * s.consumedFraction);
  const consumedProtein = Math.round(t.proteinG * s.proteinFraction);
  const consumedCarb = Math.round(t.carbohydrateG * s.carbFraction);
  const consumedFat = Math.round(t.fatG * s.fatFraction);

  return {
    userId: USER,
    nowIso: NOW,
    localDate: LOCAL_DATE,
    energy: {
      currentBalanceKcal: s.balanceKcal,
      targetDeltaKcal: s.goal === 'lose' ? -500 : s.goal === 'gain' ? 300 : 0,
      remainingIntakeKcal: s.targetKcal - consumedKcal,
      ifNoMoreFoodBalanceKcal: s.balanceKcal,
      tefStatus: 'unavailable',
      tefEstimatedTotalKcal: null,
      tefBaseMacroKcal: null,
      tefIndividualAdjustmentKcal: null,
      tefConfidence: null,
      completeness: 'complete',
      completenessGaps: [],
    } as never,
    macros: {
      targets: t,
      consumedKcal,
      consumedProteinG: consumedProtein,
      consumedCarbohydrateG: consumedCarb,
      consumedFatG: consumedFat,
      remainingKcal: s.targetKcal - consumedKcal,
      remainingProteinG: t.proteinG - consumedProtein,
      remainingCarbohydrateG: t.carbohydrateG - consumedCarb,
      remainingFatG: t.fatG - consumedFat,
      calcVersion: 'macro@int1-eval',
    } as never,
    candidates,
    history: { userId: USER, observations: [] },
    preferences: null,
    policy: DEFAULT_RECOMMENDATION_POLICY,
    environment: 'test',
  };
}

// ---------------------------------------------------------------------------
// Metrics. Judged by arithmetic, never by naming a required food.
// ---------------------------------------------------------------------------

interface Verdict {
  readonly hardViolation: string | null;
  readonly energyFit: boolean | null;
  readonly macroFit: boolean | null;
  readonly unnecessaryOvershoot: boolean | null;
  readonly rankingRational: boolean | null;
}

const basisOf = (byId: Map<string, RecommendationCandidate>, id: string) => {
  const c = byId.get(id);
  return (c?.productVersion as unknown as {
    basis: { kcal: number; proteinG: number; carbohydrateG: number; fatG: number };
  } | undefined)?.basis;
};

function judge(
  s: Scenario, set: RecommendationSet, byId: Map<string, RecommendationCandidate>,
): Verdict {
  const t = macroTargets(s.targetKcal);
  const remainingKcal = s.targetKcal - Math.round(s.targetKcal * s.consumedFraction);
  const remainingProtein = t.proteinG - Math.round(t.proteinG * s.proteinFraction);
  const remainingFat = t.fatG - Math.round(t.fatG * s.fatFraction);
  const remainingCarb = t.carbohydrateG - Math.round(t.carbohydrateG * s.carbFraction);

  const top = set.recommendations[0];

  // --- hard safety ------------------------------------------------------
  for (const r of set.recommendations) {
    if (r.portionProposal !== undefined) {
      const g = r.portionProposal.grams as unknown as number;
      if (!Number.isFinite(g) || g <= 0) {
        return { hardViolation: 'impossible_portion', energyFit: null, macroFit: null,
          unnecessaryOvershoot: null, rankingRational: null };
      }
      // A portion must have a defensible basis, never energy-density division.
      if (r.portionProposal.basis !== 'source_serving'
          && r.portionProposal.basis !== 'user_history') {
        return { hardViolation: 'ungrounded_portion', energyFit: null, macroFit: null,
          unnecessaryOvershoot: null, rankingRational: null };
      }
    }
    if (!byId.has(r.productVersionId)) {
      return { hardViolation: 'unknown_candidate', energyFit: null, macroFit: null,
        unnecessaryOvershoot: null, rankingRational: null };
    }
    if (!Number.isFinite(r.score)) {
      return { hardViolation: 'non_finite_score', energyFit: null, macroFit: null,
        unnecessaryOvershoot: null, rankingRational: null };
    }
  }

  // An exhausted budget must not yield recommendations.
  if (remainingKcal <= 0 && set.recommendations.length > 0
      && set.status === 'available') {
    return { hardViolation: 'recommended_past_budget', energyFit: null, macroFit: null,
      unnecessaryOvershoot: null, rankingRational: null };
  }

  if (top === undefined) {
    return { hardViolation: null, energyFit: null, macroFit: null,
      unnecessaryOvershoot: null, rankingRational: null };
  }

  const basis = basisOf(byId, top.productVersionId);
  if (basis === undefined) {
    return { hardViolation: 'missing_basis', energyFit: null, macroFit: null,
      unnecessaryOvershoot: null, rankingRational: null };
  }

  // --- energy fit ------------------------------------------------------
  // With no source serving in the generic seed, the engine cannot propose a
  // portion, so fit is assessed at a REFERENCE 100 g. That is a measurement
  // convention, stated plainly — not a claim that anyone eats 100 g.
  const portionG = (top.portionProposal?.grams as unknown as number | undefined) ?? 100;
  const kcalAtPortion = (basis.kcal * portionG) / 100;
  const energyFit = remainingKcal > 0 ? kcalAtPortion <= remainingKcal * 1.25 : null;

  // --- macro fit: does it address the MOST deficient macro? --------------
  // Deficit is measured as a share of that macro's target, so the comparison
  // is scale-free across very different targets.
  const deficits: [string, number][] = [
    ['protein', remainingProtein / Math.max(1, t.proteinG)],
    ['carbohydrate', remainingCarb / Math.max(1, t.carbohydrateG)],
    ['fat', remainingFat / Math.max(1, t.fatG)],
  ];
  deficits.sort((a, b) => b[1] - a[1]);
  const worst = deficits[0]!;
  const worstMargin = worst[1] - deficits[1]![1];

  let macroFit: boolean | null = null;
  if (worstMargin > 0.15) {
    // INDEPENDENT of the engine. INT-1 judged this by ENERGY SHARE — the same
    // proportional logic the engine used — so two measurements shared a blind
    // spot, agreed with each other, and certified black coffee as a good
    // protein choice. INT-2 judges ABSOLUTE contribution instead: does a
    // standard comparison amount supply a materially useful quantity of the
    // macro the user actually lacks?
    const worstMacro = worst[0] as 'protein' | 'carbohydrate' | 'fat';
    const gramsPer100g = worstMacro === 'protein' ? basis.proteinG
      : worstMacro === 'carbohydrate' ? basis.carbohydrateG : basis.fatG;
    const remainingOfWorst = worstMacro === 'protein' ? remainingProtein
      : worstMacro === 'carbohydrate' ? remainingCarb : remainingFat;

    // Deliberately independent thresholds, not the engine's policy values, so
    // this cannot be satisfied by tuning the policy.
    const MEANINGFUL_GRAMS = { protein: 5, carbohydrate: 8, fat: 3 } as const;
    const suppliesMeaningfulAmount = gramsPer100g >= MEANINGFUL_GRAMS[worstMacro];
    const closesUsefulShare = remainingOfWorst > 0
      && gramsPer100g / remainingOfWorst >= 0.10;

    macroFit = suppliesMeaningfulAmount && closesUsefulShare;
  }

  // --- unnecessary overshoot -------------------------------------------
  let unnecessaryOvershoot: boolean | null = null;
  if (remainingKcal > 0) {
    const nearExhausted = deficits.filter(([, v]) => v < 0.1).map(([k]) => k);
    if (nearExhausted.length > 0) {
      const worstNearlyGone = nearExhausted[0]!;
      const grams = worstNearlyGone === 'protein' ? basis.proteinG
        : worstNearlyGone === 'carbohydrate' ? basis.carbohydrateG : basis.fatG;
      const remainingOfThat = worstNearlyGone === 'protein' ? remainingProtein
        : worstNearlyGone === 'carbohydrate' ? remainingCarb : remainingFat;
      const atPortion = (grams * portionG) / 100;
      unnecessaryOvershoot = atPortion > Math.max(2, remainingOfThat) * 1.5;
    }
  }

  /**
   * --- ORDERING INTEGRITY, against the DOCUMENTED contract ---------------
   *
   * The old check asserted plain descending score, which the actionability
   * gate legitimately violates by design. It flagged 432 scenarios CRITICAL
   * for behaviour that was intended — the order was right, the contract was
   * simply not expressed in the returned data.
   *
   * Two invariants are now checked separately:
   *   BASE  — every non-promoted item descends by baseScore;
   *   FINAL — the list is ordered by finalRank, at most one item is promoted,
   *           and a promoted item sits at position 0.
   */
  let rankingRational = true;
  const recs = set.recommendations;

  const promotedCount = recs.filter((r) => r.promotedForActionability).length;
  if (promotedCount > 1) rankingRational = false;
  if (promotedCount === 1 && !recs[0]!.promotedForActionability) rankingRational = false;
  for (let i = 0; i < recs.length; i += 1) {
    if (recs[i]!.finalRank !== i) rankingRational = false;
    if (recs[i]!.baseScore !== recs[i]!.score) rankingRational = false;
  }
  // Base ordering, ignoring the single promoted item.
  const unpromoted = recs.filter((r) => !r.promotedForActionability);
  for (let i = 1; i < unpromoted.length; i += 1) {
    if (unpromoted[i]!.baseScore > unpromoted[i - 1]!.baseScore + 1e-9) {
      rankingRational = false;
      break;
    }
  }

  return { hardViolation: null, energyFit, macroFit, unnecessaryOvershoot, rankingRational };
}

// ---------------------------------------------------------------------------

function main(): void {
  const candidates = loadCandidates();
  const byId = new Map(candidates.map((c) => [
    (c.productVersion as unknown as { productVersionId: string }).productVersionId, c]));
  process.stderr.write(`candidates: ${candidates.length.toLocaleString()} recommendable foods\n`);

  const scenarios = buildScenarios();
  process.stderr.write(`scenarios : ${scenarios.length}\n`);

  const statuses: Record<string, number> = {};
  let hardViolations = 0;
  const violationKinds: Record<string, number> = {};
  let energyConsidered = 0; let energyPass = 0;
  let macroConsidered = 0; let macroPass = 0;
  let overshootConsidered = 0; let overshootBad = 0;
  let rankingConsidered = 0; let rankingBad = 0;
  let baseOrderingOk = 0; let finalOrderingOk = 0; let orderingConsidered = 0;
  let emptyWhenBudgetGone = 0; let budgetGoneScenarios = 0;
  const failures: Record<string, unknown>[] = [];
  let totalMs = 0;
  // How often the winning pick is nutritionally degenerate: near-zero energy
  // (coffee, water) or extreme density (oils, rendered fat). Both satisfy a
  // PROPORTIONAL macro-fit test while being poor meal suggestions.
  let nearZeroEnergyWins = 0;
  let extremeDensityWins = 0;
  const topNames: Record<string, number> = {};
  /** Winner supplies a materially useful amount of the most-deficient macro. */
  let meaningfulContributionWins = 0;
  let meaningfulConsidered = 0;
  /** Winner adds a material amount of an ALREADY-EXHAUSTED macro. */
  let exhaustedMacroViolations = 0;
  /** Winner is a class a normal person would actually eat as a suggestion. */
  let actionableWins = 0;
  let lowActionabilityWins = 0;
  /** Low-actionability winner DESPITE a qualifying actionable alternative. */
  let lowActionabilityDespiteAlternative = 0;
  const winnerClasses: Record<string, number> = {};
  const winnerIds: Record<string, string | null> = {};
  // --- INT-4 plan-level measurement ------------------------------------
  const planSizes: Record<number, number> = { 0: 0, 1: 0, 2: 0, 3: 0 };
  let planComponents = 0;
  let actionableComponents = 0;
  let dominantGapCovered = 0;
  let dominantGapConsidered = 0;
  let complementaryGapCovered = 0;
  let complementaryGapConsidered = 0;
  let duplicateComponents = 0;
  let ungroundedPortionClaims = 0;
  let treatPrimaryDespiteStaple = 0;
  let lowActionabilityComponentDespiteAlternative = 0;
  const planRoles: Record<string, number> = {};
  /**
   * A QUALIFYING opportunity: a candidate that is nutritionally competitive,
   * actionable, and carries the dominant gap's role. Measuring missed
   * opportunities is fairer than demanding raw coverage, which would blame the
   * planner for gaps the catalog cannot fill.
   */
  let dominantRoleOpportunities = 0;
  let missedDominantRoleOpportunities = 0;

  for (const s of scenarios) {
    const input = inputFor(s, candidates);
    const started = performance.now();
    const set = recommendFoods(input);
    totalMs += performance.now() - started;

    statuses[set.status] = (statuses[set.status] ?? 0) + 1;

    const remainingKcal = s.targetKcal - Math.round(s.targetKcal * s.consumedFraction);
    if (remainingKcal <= 0) {
      budgetGoneScenarios += 1;
      if (set.recommendations.length === 0) emptyWhenBudgetGone += 1;
    }

    const winner = set.recommendations[0];
    if (winner !== undefined) {
      topNames[winner.displayName] = (topNames[winner.displayName] ?? 0) + 1;
      const b = basisOf(byId, winner.productVersionId);
      if (b !== undefined) {
        if (b.kcal < 25) nearZeroEnergyWins += 1;
        if (b.kcal > 700) extremeDensityWins += 1;
      }
    }

    if (winner !== undefined) {
      const b = basisOf(byId, winner.productVersionId);
      if (b !== undefined) {
        const tt = macroTargets(s.targetKcal);
        const remP = tt.proteinG - Math.round(tt.proteinG * s.proteinFraction);
        const remC = tt.carbohydrateG - Math.round(tt.carbohydrateG * s.carbFraction);
        const remF = tt.fatG - Math.round(tt.fatG * s.fatFraction);
        // Independent thresholds, not the engine's policy.
        const MEANINGFUL = { protein: 5, carbohydrate: 8, fat: 3 } as const;
        const gaps: [keyof typeof MEANINGFUL, number, number][] = [
          ['protein', remP / Math.max(1, tt.proteinG), b.proteinG],
          ['carbohydrate', remC / Math.max(1, tt.carbohydrateG), b.carbohydrateG],
          ['fat', remF / Math.max(1, tt.fatG), b.fatG],
        ];
        gaps.sort((x, y) => y[1] - x[1]);
        const [worstName, worstFrac, worstGrams] = gaps[0]!;
        if (worstFrac - gaps[1]![1] > 0.15) {
          meaningfulConsidered += 1;
          if (worstGrams >= MEANINGFUL[worstName]) meaningfulContributionWins += 1;
        }
        for (const [name, , grams] of gaps) {
          const rem = name === 'protein' ? remP : name === 'carbohydrate' ? remC : remF;
          if (rem > 0 || grams < MEANINGFUL[name]) continue;
          // A violation only counts if a QUALIFYING ALTERNATIVE existed: a food
          // that addresses the dominant gap without materially adding the
          // exhausted macro. Otherwise the engine had no better answer, and
          // calling it a violation would blame it for the catalog.
          const alternativeExists = candidates.some((cand) => {
            const cb = (cand.productVersion as unknown as {
              basis: { proteinG: number; carbohydrateG: number; fatG: number };
            }).basis;
            const addsExhausted = name === 'protein' ? cb.proteinG
              : name === 'carbohydrate' ? cb.carbohydrateG : cb.fatG;
            if (addsExhausted >= MEANINGFUL[name]) return false;
            const addressesGap = worstName === 'protein' ? cb.proteinG
              : worstName === 'carbohydrate' ? cb.carbohydrateG : cb.fatG;
            return addressesGap >= MEANINGFUL[worstName];
          });
          if (alternativeExists) exhaustedMacroViolations += 1;
          break;
        }
      }
    }

    if (winner !== undefined) {
      const cls = (winner as unknown as { actionabilityClass?: string })
        .actionabilityClass ?? 'unknown';
      winnerClasses[cls] = (winnerClasses[cls] ?? 0) + 1;
      const ACTIONABLE = new Set(['ready_to_eat', 'meal_component', 'beverage']);
      if (ACTIONABLE.has(cls)) actionableWins += 1;
      else {
        lowActionabilityWins += 1;
        // Only a violation if a qualifying actionable alternative was ranked.
        const alternative = set.recommendations.slice(1).some((r) => {
          const rc = (r as unknown as { actionabilityClass?: string }).actionabilityClass;
          return rc !== undefined && ACTIONABLE.has(rc)
            && r.score >= winner.score * 0.75;
        });
        if (alternative) lowActionabilityDespiteAlternative += 1;
      }
    }

    // The planner runs on the SAME state, so plan metrics are directly
    // comparable with the single-food numbers above.
    winnerIds[s.id] = set.recommendations[0]?.productVersionId ?? null;
    const plan = recommendFoodPlan(input);
    planSizes[Math.min(3, plan.components.length)] =
      (planSizes[Math.min(3, plan.components.length)] ?? 0) + 1;

    const ACTIONABLE_SET = new Set(['ready_to_eat', 'meal_component']);
    const seenProducts = new Set<string>();
    for (const comp of plan.components) {
      planComponents += 1;
      planRoles[comp.role] = (planRoles[comp.role] ?? 0) + 1;
      if (ACTIONABLE_SET.has(comp.actionabilityClass)) actionableComponents += 1;
      if (seenProducts.has(comp.productId)) duplicateComponents += 1;
      seenProducts.add(comp.productId);
      // A quantity may never be stated without grounded authority.
      if (comp.portionProposal !== undefined
          && comp.portionProposal.basis !== 'source_serving'
          && comp.portionProposal.basis !== 'user_history') {
        ungroundedPortionClaims += 1;
      }
    }

    if (plan.objectives.length > 0 && plan.components.length > 0) {
      const first = plan.objectives[0];
      if (first !== 'energy') {
        dominantGapConsidered += 1;
        const wantedRole = `${first}_forward`;
        const ACT = new Set(['ready_to_eat', 'meal_component']);
        const leaderScore = set.recommendations[0]!.score;
        const qualifying = set.recommendations.some((r) => {
          if (r.score < leaderScore * 0.8) return false;
          const cls = (r as unknown as { actionabilityClass?: string }).actionabilityClass;
          if (cls === undefined || !ACT.has(cls)) return false;
          const cand = byId.get(r.productVersionId);
          if (cand === undefined) return false;
          return assessRole(cand.productVersion) === wantedRole;
        });
        if (qualifying) {
          dominantRoleOpportunities += 1;
          if (plan.components[0]?.role !== wantedRole) {
            missedDominantRoleOpportunities += 1;
          }
        }
        const wanted = `${first === 'protein' ? 'protein' : first === 'carbohydrate'
          ? 'carbohydrate' : 'fat'}_forward`;
        if (plan.components.some((c) => c.role === wanted || c.role === 'balanced')) {
          dominantGapCovered += 1;
        }
      }
      const second = plan.objectives[1];
      if (second !== undefined && second !== 'energy') {
        complementaryGapConsidered += 1;
        const wanted2 = `${second}_forward`;
        if (plan.components.some((c) => c.role === wanted2 || c.role === 'balanced')) {
          complementaryGapCovered += 1;
        }
      }
      // A treat should not lead when an ordinary staple was available.
      const primaryComp = plan.components[0]!;
      if (primaryComp.actionabilityClass === 'treat'
          || primaryComp.actionabilityClass === 'snack') {
        const stapleAvailable = set.recommendations.some((r) => {
          const cls = (r as unknown as { actionabilityClass?: string }).actionabilityClass;
          return cls !== undefined && ACTIONABLE_SET.has(cls)
            && r.score >= set.recommendations[0]!.score * 0.75;
        });
        if (stapleAvailable) treatPrimaryDespiteStaple += 1;
      }
      for (const comp of plan.components) {
        if (ACTIONABLE_SET.has(comp.actionabilityClass)) continue;
        const alt = set.recommendations.some((r) => {
          const cls = (r as unknown as { actionabilityClass?: string }).actionabilityClass;
          return cls !== undefined && ACTIONABLE_SET.has(cls);
        });
        if (alt) { lowActionabilityComponentDespiteAlternative += 1; break; }
      }
    }

    if (set.recommendations.length > 0) {
      orderingConsidered += 1;
      const recs = set.recommendations;
      const unpromoted = recs.filter((r) => !r.promotedForActionability);
      let baseOk = true;
      for (let i = 1; i < unpromoted.length; i += 1) {
        if (unpromoted[i]!.baseScore > unpromoted[i - 1]!.baseScore + 1e-9) baseOk = false;
      }
      if (baseOk) baseOrderingOk += 1;

      const promoted = recs.filter((r) => r.promotedForActionability).length;
      const finalOk = promoted <= 1
        && (promoted === 0 || recs[0]!.promotedForActionability)
        && recs.every((r, i) => r.finalRank === i)
        && set.orderingContract === 'base_score_desc_with_single_actionability_promotion';
      if (finalOk) finalOrderingOk += 1;
    }

    const v = judge(s, set, byId);
    if (v.hardViolation !== null) {
      hardViolations += 1;
      violationKinds[v.hardViolation] = (violationKinds[v.hardViolation] ?? 0) + 1;
      failures.push({ id: s.id, kind: 'CRITICAL', reason: v.hardViolation, scenario: s });
      continue;
    }
    if (v.energyFit !== null) {
      energyConsidered += 1;
      if (v.energyFit) energyPass += 1;
      else failures.push({
        id: s.id, kind: 'MAJOR', reason: 'energy_fit',
        top: set.recommendations[0]?.displayName, scenario: s,
      });
    }
    if (v.macroFit !== null) {
      macroConsidered += 1;
      if (v.macroFit) macroPass += 1;
      else failures.push({
        id: s.id, kind: 'MAJOR', reason: 'macro_fit',
        top: set.recommendations[0]?.displayName, scenario: s,
      });
    }
    if (v.unnecessaryOvershoot !== null) {
      overshootConsidered += 1;
      if (v.unnecessaryOvershoot) {
        overshootBad += 1;
        failures.push({
          id: s.id, kind: 'MINOR', reason: 'unnecessary_overshoot',
          top: set.recommendations[0]?.displayName, scenario: s,
        });
      }
    }
    if (v.rankingRational !== null) {
      rankingConsidered += 1;
      if (!v.rankingRational) {
        rankingBad += 1;
        failures.push({ id: s.id, kind: 'CRITICAL', reason: 'ranking_not_monotonic', scenario: s });
      }
    }
  }

  const pct = (a: number, b: number): number =>
    b === 0 ? 0 : Math.round((1000 * a) / b) / 10;

  // Winner identity per scenario, so a refactor can be PROVEN not to change
  // which food is recommended.
  writeFileSync(repoPath('data', 'recommendation-winners.json'),
    `${JSON.stringify(winnerIds, null, 0)}\n`);

  const withRecommendations = scenarios.length - (statuses['energy_budget_exhausted'] ?? 0);
  const topPickProfile = {
    nearZeroEnergyWinsPercent: pct(nearZeroEnergyWins, withRecommendations),
    extremeDensityWinsPercent: pct(extremeDensityWins, withRecommendations),
    distinctTopPicks: Object.keys(topNames).length,
    meaningfulContributionRatePercent: pct(meaningfulContributionWins, meaningfulConsidered),
    meaningfulContributionConsidered: meaningfulConsidered,
    exhaustedMacroViolationRatePercent: pct(exhaustedMacroViolations, withRecommendations),
    actionableWinnerRatePercent: pct(actionableWins, withRecommendations),
    lowActionabilityWinnerRatePercent: pct(lowActionabilityWins, withRecommendations),
    lowActionabilityDespiteAlternativePercent:
      pct(lowActionabilityDespiteAlternative, withRecommendations),
    winnerClasses,
    plan: {
      singleFoodRatePercent: pct(planSizes[1] ?? 0, withRecommendations),
      twoComponentRatePercent: pct(planSizes[2] ?? 0, withRecommendations),
      threeComponentRatePercent: pct(planSizes[3] ?? 0, withRecommendations),
      actionableComponentRatePercent: pct(actionableComponents, planComponents),
      dominantGapCoveragePercent: pct(dominantGapCovered, dominantGapConsidered),
      dominantRoleOpportunities,
      missedDominantRoleOpportunityRatePercent:
        pct(missedDominantRoleOpportunities, dominantRoleOpportunities),
      complementaryGapCoveragePercent: pct(complementaryGapCovered, complementaryGapConsidered),
      duplicateComponentRatePercent: pct(duplicateComponents, planComponents),
      ungroundedPortionClaims,
      treatPrimaryDespiteStaplePercent: pct(treatPrimaryDespiteStaple, withRecommendations),
      lowActionabilityComponentDespiteAlternativePercent:
        pct(lowActionabilityComponentDespiteAlternative, withRecommendations),
      noCandidateHonest: statuses['no_eligible_candidates'] === undefined
        || (planSizes[0] ?? 0) > 0,
      roles: planRoles,
    },
    mostFrequentTopPicks: Object.entries(topNames)
      .sort((a, b) => b[1] - a[1]).slice(0, 8),
  };

  const summary = {
    evaluationVersion: 'int1-recommendation-eval@1.0.0',
    engine: 'recommendFoods (production)',
    policyVersion: DEFAULT_RECOMMENDATION_POLICY.version,
    scenarios: scenarios.length,
    candidatePool: candidates.length,
    meanRecommendMs: Math.round((totalMs / scenarios.length) * 100) / 100,
    statuses,
    hardViolationRatePercent: pct(hardViolations, scenarios.length),
    violationKinds,
    energyFitRatePercent: pct(energyPass, energyConsidered),
    energyFitConsidered: energyConsidered,
    macroFitRatePercent: pct(macroPass, macroConsidered),
    macroFitConsidered: macroConsidered,
    unnecessaryOvershootRatePercent: pct(overshootBad, overshootConsidered),
    overshootConsidered,
    // Named unambiguously: "ranking monotonic" hid WHICH ranking was meant.
    baseRankingIntegrityPercent: pct(baseOrderingOk, orderingConsidered),
    finalOrderingIntegrityPercent: pct(finalOrderingOk, orderingConsidered),
    orderingContractChecked: 'base_score_desc_with_single_actionability_promotion',
    budgetExhaustedScenarios: budgetGoneScenarios,
    budgetExhaustedHandledHonestly: emptyWhenBudgetGone,
    failureCounts: failures.reduce<Record<string, number>>((acc, f) => {
      const k = `${f['kind']}:${f['reason']}`;
      acc[k] = (acc[k] ?? 0) + 1;
      return acc;
    }, {}),
    exampleFailures: failures.slice(0, 25),
    topPickProfile,
  };

  writeFileSync(OUT, `${JSON.stringify(summary, null, 2)}\n`);

  console.log(`\nengine            : ${summary.engine}`);
  console.log(`scenarios         : ${summary.scenarios}`);
  console.log(`candidate pool    : ${summary.candidatePool.toLocaleString()} real foods`);
  console.log(`mean recommend    : ${summary.meanRecommendMs} ms`);
  console.log(`\nstatuses          : ${JSON.stringify(statuses)}`);
  console.log(`\nHARD VIOLATIONS   : ${summary.hardViolationRatePercent}%  ${JSON.stringify(violationKinds)}`);
  console.log(`energy fit        : ${summary.energyFitRatePercent}%  (n=${energyConsidered})`);
  console.log(`macro fit         : ${summary.macroFitRatePercent}%  (n=${macroConsidered})`);
  console.log(`unnecessary overshoot: ${summary.unnecessaryOvershootRatePercent}%  (n=${overshootConsidered})`);
  console.log(`base ranking      : ${summary.baseRankingIntegrityPercent}%`);
  console.log(`final ordering    : ${summary.finalOrderingIntegrityPercent}%`);
  console.log(`budget exhausted  : ${emptyWhenBudgetGone}/${budgetGoneScenarios} handled honestly`);
  console.log(`\nfailure counts    : ${JSON.stringify(summary.failureCounts, null, 2)}`);

  const named = runNamedCases(candidates);
  for (const c of named) {
    console.log(`  ${c.name.padEnd(26)} ${c.status.padEnd(26)} ${(c.top ?? '(none)').slice(0, 38)}`);
    const sh = c.topMacroShares;
    if (sh !== null) {
      console.log(`      P${sh['protein']}% C${sh['carbohydrate']}% F${sh['fat']}%`
        + `  ${sh['kcalPer100g']} kcal/100g`);
    }
  }
  writeFileSync(repoPath('data', 'recommendation-named-cases.json'),
    `${JSON.stringify(named, null, 2)}\n`);
}


// ---------------------------------------------------------------------------
// NAMED ADVERSARIAL CASES — human-readable, using only engine-supported state.
// ---------------------------------------------------------------------------

export interface NamedCase {
  readonly name: string;
  readonly description: string;
  readonly scenario: Scenario;
  /** What a nutritionally sensible engine should do, in engine terms. */
  readonly expectation: string;
}

export const NAMED_CASES: readonly NamedCase[] = [
  {
    name: 'LEAN_PROTEIN_LATE_DAY',
    description: '~450 kcal left, major protein gap, fat nearly exhausted',
    scenario: {
      id: 'N1', goal: 'lose', phase: 'late', targetKcal: 2000,
      consumedFraction: 0.775, proteinFraction: 0.20, carbFraction: 0.65,
      fatFraction: 0.92, balanceKcal: -450,
    },
    expectation: 'a comparatively lean high-protein food, not a fat-dense one',
  },
  {
    name: 'FAT_ALREADY_HIGH',
    description: 'fat target exceeded, protein and carbs still open',
    scenario: {
      id: 'N2', goal: 'maintain', phase: 'middle', targetKcal: 2400,
      consumedFraction: 0.55, proteinFraction: 0.45, carbFraction: 0.50,
      fatFraction: 1.10, balanceKcal: -80,
    },
    expectation: 'should not lead with a fat-dominant food',
  },
  {
    name: 'PROTEIN_ALREADY_MET',
    description: 'protein target reached, carbohydrate gap remains',
    scenario: {
      id: 'N3', goal: 'maintain', phase: 'middle', targetKcal: 2200,
      consumedFraction: 0.60, proteinFraction: 1.05, carbFraction: 0.35,
      fatFraction: 0.60, balanceKcal: -120,
    },
    expectation: 'should lean carbohydrate rather than more protein',
  },
  {
    name: 'CARBS_NEEDED_PRE_WORKOUT',
    description: 'large carbohydrate gap, ample energy left',
    scenario: {
      id: 'N4', goal: 'gain', phase: 'middle', targetKcal: 2800,
      consumedFraction: 0.35, proteinFraction: 0.60, carbFraction: 0.20,
      fatFraction: 0.55, balanceKcal: 150,
    },
    expectation: 'carbohydrate-dominant food',
  },
  {
    name: 'SMALL_CALORIE_BUDGET',
    description: 'only ~120 kcal of useful intake left',
    scenario: {
      id: 'N5', goal: 'lose', phase: 'late', targetKcal: 1600,
      consumedFraction: 0.925, proteinFraction: 0.70, carbFraction: 0.80,
      fatFraction: 0.75, balanceKcal: -500,
    },
    expectation: 'a low-energy-density option that fits, or honest degradation',
  },
  {
    name: 'CALORIES_ALREADY_EXCEEDED',
    description: 'target exceeded by 15%',
    scenario: {
      id: 'N6', goal: 'lose', phase: 'late', targetKcal: 1800,
      consumedFraction: 1.15, proteinFraction: 0.90, carbFraction: 1.10,
      fatFraction: 1.00, balanceKcal: 270,
    },
    expectation: 'energy_budget_exhausted, NOT a manufactured suggestion',
  },
  {
    name: 'BALANCED_MAINTENANCE',
    description: 'everything roughly on track, mid-day',
    scenario: {
      id: 'N7', goal: 'maintain', phase: 'middle', targetKcal: 2200,
      consumedFraction: 0.50, proteinFraction: 0.50, carbFraction: 0.50,
      fatFraction: 0.50, balanceKcal: 0,
    },
    expectation: 'any reasonable balanced food; no dominant gap to chase',
  },
  {
    name: 'CONTROLLED_SURPLUS',
    description: 'deliberate gain, early day, everything open',
    scenario: {
      id: 'N8', goal: 'gain', phase: 'early', targetKcal: 2800,
      consumedFraction: 0.10, proteinFraction: 0.10, carbFraction: 0.10,
      fatFraction: 0.10, balanceKcal: 200,
    },
    expectation: 'energy-dense options are acceptable here',
  },
  {
    name: 'NO_GOOD_CANDIDATE',
    description: 'empty candidate pool',
    scenario: {
      id: 'N9', goal: 'maintain', phase: 'middle', targetKcal: 2000,
      consumedFraction: 0.50, proteinFraction: 0.50, carbFraction: 0.50,
      fatFraction: 0.50, balanceKcal: 0,
    },
    expectation: 'no_eligible_candidates, never a manufactured recommendation',
  },
];

export function runNamedCases(candidates: readonly RecommendationCandidate[]): {
  readonly name: string; readonly status: string; readonly top: string | null;
  readonly topMacroShares: Record<string, number> | null;
  readonly expectation: string;
  readonly remainingKcal: number;
  readonly remaining: { protein: number; carbohydrate: number; fat: number };
  readonly comparisonBasis: {
    grams: number; kcal: number; protein: number; carbohydrate: number; fat: number;
  } | null;
  readonly groundedPortionGrams: number | null;
  readonly portionStatable: boolean;
  readonly whyItWon: readonly string[];
}[] {
  const byId = new Map(candidates.map((c) => [
    (c.productVersion as unknown as { productVersionId: string }).productVersionId, c]));
  return NAMED_CASES.map((c) => {
    const pool = c.name === 'NO_GOOD_CANDIDATE' ? [] : candidates;
    const planInput = inputFor(c.scenario, pool);
    const set = recommendFoods(planInput);
    const plan = recommendFoodPlan(planInput);
    const top = set.recommendations[0];
    let shares: Record<string, number> | null = null;
    if (top !== undefined) {
      const b = basisOf(byId, top.productVersionId);
      if (b !== undefined) {
        const p = b.proteinG * 4; const cb = b.carbohydrateG * 4; const f = b.fatG * 9;
        const total = p + cb + f;
        shares = total > 0
          ? {
            protein: Math.round((100 * p) / total),
            carbohydrate: Math.round((100 * cb) / total),
            fat: Math.round((100 * f) / total),
            kcalPer100g: Math.round(b.kcal),
          }
          : null;
      }
    }
    const t = macroTargets(c.scenario.targetKcal);
    const remainingKcal = c.scenario.targetKcal
      - Math.round(c.scenario.targetKcal * c.scenario.consumedFraction);
    const remaining = {
      protein: t.proteinG - Math.round(t.proteinG * c.scenario.proteinFraction),
      carbohydrate: t.carbohydrateG - Math.round(t.carbohydrateG * c.scenario.carbFraction),
      fat: t.fatG - Math.round(t.fatG * c.scenario.fatFraction),
    };

    let comparisonBasis = null;
    if (top !== undefined) {
      const b = basisOf(byId, top.productVersionId);
      if (b !== undefined) {
        // The 100 g comparison basis — a RANKING device. It is reported here so
        // the table is legible; it is never shown to a user as an amount.
        comparisonBasis = {
          grams: 100, kcal: Math.round(b.kcal),
          protein: Math.round(b.proteinG * 10) / 10,
          carbohydrate: Math.round(b.carbohydrateG * 10) / 10,
          fat: Math.round(b.fatG * 10) / 10,
        };
      }
    }

    const grounded = (top?.portionProposal?.grams as unknown as number | undefined) ?? null;

    return {
      name: c.name, status: set.status, top: top?.displayName ?? null,
      topMacroShares: shares, expectation: c.expectation,
      remainingKcal, remaining, comparisonBasis,
      groundedPortionGrams: grounded,
      actionabilityClass:
        (top as unknown as { actionabilityClass?: string } | undefined)?.actionabilityClass
        ?? null,
      plan: {
        objectives: plan.objectives,
        moreGuidanceUsefulAfterWeighing: plan.moreGuidanceUsefulAfterWeighing,
        plannedTotals: plan.plannedTotals,
        components: plan.components.map((comp) => ({
          name: comp.displayName, role: comp.role,
          actionability: comp.actionabilityClass,
          portion: comp.portionProposal?.grams ?? null,
          why: comp.rationaleCodes.slice(0, 3),
        })),
      },
      topThree: set.recommendations.slice(0, 3).map((r) => ({
        name: r.displayName,
        cls: (r as unknown as { actionabilityClass?: string }).actionabilityClass ?? 'unknown',
        score: Math.round(r.score * 1000) / 1000,
      })),
      // A portion may be stated ONLY when the engine grounded one.
      portionStatable: grounded !== null,
      whyItWon: top?.rationaleCodes ?? [],
    };
  });
}

main();
