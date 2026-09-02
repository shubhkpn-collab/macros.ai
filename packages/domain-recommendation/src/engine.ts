import { SCALE_RANGE_G, grams as toGrams, type Grams, type ProductVersion } from '@macros/contracts';
import { calculateNutrition } from '@macros/domain-nutrition';
import type {
  EnergyConfidence, HistoryObservation, PortionProposal, RationaleCode, Recommendation,
  RecommendationCandidate, RecommendationHistorySnapshot, RecommendationInput,
  RecommendationSet, ScoreComponents,
} from './contracts.js';
import { assessActionability, type ActionabilityClass } from '@macros/domain-catalog';
import type { RecommendationPolicy } from './policy.js';

/**
 * THE RECOMMENDATION ENGINE.
 *
 * PURE: no clock, no repository, no network, no LLM, no randomness. Same inputs
 * always produce the same ranking, with deterministic tie-breaking.
 *
 * It performs NO nutrition arithmetic of its own: portion nutrition comes from
 * `calculateNutrition`, and every energy and macro figure is read from state
 * the energy and macro engines already produced.
 */

const MACROS = ['protein', 'carbohydrate', 'fat'] as const;
type MacroName = (typeof MACROS)[number];

/** Energy contributed per gram, used only to express a candidate's PROFILE. */
const KCAL_PER_G: Readonly<Record<MacroName, number>> = {
  protein: 4, carbohydrate: 4, fat: 9,
};

const macroGrams = (v: ProductVersion, m: MacroName): number =>
  m === 'protein' ? v.basis.proteinG : m === 'carbohydrate' ? v.basis.carbohydrateG : v.basis.fatG;

/**
 * ELIGIBILITY — hard filters. A candidate failing any of these is removed, not
 * ranked lower.
 */
export function isEligible(
  candidate: RecommendationCandidate,
  input: RecommendationInput,
): boolean {
  const { productVersion: v, head } = candidate;

  if (!head.isActive) return false;
  // Only the CURRENT head version may be recommended. A superseded version is
  // history, and recommending it would present outdated nutrition as current.
  if (head.currentProductVersionId !== v.productVersionId) return false;
  if (head.productId !== v.productId) return false;

  // Core nutrition must be complete. Missing is never treated as zero.
  const n = v.basis;
  for (const value of [n.kcal, n.proteinG, n.carbohydrateG, n.fatG]) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return false;
  }
  if (v.preparationState === undefined || String(v.preparationState).length === 0) return false;

  // Synthetic fixtures must never be presented as real food in production.
  if (
    (input.environment === 'production' || input.environment === 'staging') &&
    v.source.verificationStatus === 'synthetic_test'
  ) {
    return false;
  }

  // An avoid is a HARD filter; a preference is only a nudge.
  if (input.preferences?.avoidedProductIds.includes(v.productId) === true) return false;

  return true;
}

/**
 * MACRO DEFICIT WEIGHTS — dimensionless.
 *
 * Raw grams cannot be compared across macros: 100 g of carbohydrate remaining
 * is not "more needed" than 30 g of protein remaining. Each gap is normalized
 * against that macro's own configured target, giving a remaining FRACTION, and
 * the fractions are then normalized to sum to 1.
 */
export function macroDeficitWeights(
  remaining: Readonly<Record<MacroName, number>>,
  targets: Readonly<Record<MacroName, number>>,
): Record<MacroName, number> {
  const fractions: Record<MacroName, number> = { protein: 0, carbohydrate: 0, fat: 0 };
  for (const m of MACROS) {
    const target = targets[m];
    if (!Number.isFinite(target) || target <= 0) { fractions[m] = 0; continue; }
    fractions[m] = Math.max(0, Math.min(1, remaining[m] / target));
  }
  const total = MACROS.reduce((s, m) => s + fractions[m], 0);
  if (total <= 0) return { protein: 0, carbohydrate: 0, fat: 0 };
  return {
    protein: fractions.protein / total,
    carbohydrate: fractions.carbohydrate / total,
    fat: fractions.fat / total,
  };
}

/**
 * A candidate's macro PROFILE — the share of its energy from each macro.
 * Dimensionless and portion-independent, so it works for foods with no
 * defensible serving size.
 */
export function macroEnergyShares(v: ProductVersion): Record<MacroName, number> {
  const energy: Record<MacroName, number> = {
    protein: macroGrams(v, 'protein') * KCAL_PER_G.protein,
    carbohydrate: macroGrams(v, 'carbohydrate') * KCAL_PER_G.carbohydrate,
    fat: macroGrams(v, 'fat') * KCAL_PER_G.fat,
  };
  const total = MACROS.reduce((s, m) => s + energy[m], 0);
  if (total <= 0) return { protein: 0, carbohydrate: 0, fat: 0 };
  return {
    protein: energy.protein / total,
    carbohydrate: energy.carbohydrate / total,
    fat: energy.fat / total,
  };
}

/**
 * MACRO CONTRIBUTION on the ranking comparison basis.
 *
 * Answers "how much of the macro I still need would this food actually
 * supply?", replacing v1's "what fraction of this food's energy is that
 * macro?". The distinction is the whole of the INT-1 defect: trace protein was
 * 100% of black coffee's macro energy, so coffee scored a perfect protein fit
 * while supplying no protein.
 *
 * The returned grams are a COMPARISON quantity only. They are never presented,
 * and they never become a `portionProposal`.
 */
export function macroContributionGrams(
  v: ProductVersion,
  basisGrams: number,
): Record<MacroName, number> {
  const scale = basisGrams / 100;
  return {
    protein: macroGrams(v, 'protein') * scale,
    carbohydrate: macroGrams(v, 'carbohydrate') * scale,
    fat: macroGrams(v, 'fat') * scale,
  };
}

/**
 * How much of a remaining gap a comparison-basis amount would close, in [0, 1].
 *
 * Three properties matter:
 *   - a contribution below the meaningful floor closes NOTHING, so trace
 *     amounts cannot produce a strong score;
 *   - closure saturates at `fullClosureFraction` of the gap, so one enormous
 *     nutrient amount cannot produce an unbounded score;
 *   - normalisation is against the user's own remaining gap, so protein grams
 *     and carbohydrate grams are never compared naively.
 */
export function gapClosure(
  contributionG: number,
  remainingG: number,
  minMeaningfulG: number,
  fullClosureFraction: number,
): number {
  if (!Number.isFinite(contributionG) || contributionG < minMeaningfulG) return 0;
  if (!Number.isFinite(remainingG) || remainingG <= 0) return 0;
  const target = remainingG * fullClosureFraction;
  if (target <= 0) return 0;
  // Only the portion of the contribution that FITS inside the gap counts as
  // closing it. Beyond the gap it is overshoot, handled separately — otherwise
  // a food supplying 20 g against a 3 g deficit scores a perfect fit.
  const useful = Math.min(contributionG, remainingG);
  return Math.min(1, useful / target);
}

const daysBetween = (aIso: string, bIso: string): number =>
  Math.abs(Date.parse(aIso) - Date.parse(bIso)) / 86_400_000;

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
};

/**
 * PORTION AUTHORITY.
 *
 * Only two grounded bases are permitted, in this order:
 *   1. the CURRENT version's source-backed serving mass;
 *   2. a robust median of this user's own recent observed portions.
 *
 * There is deliberately no third option. Dividing remaining calories by energy
 * density would produce arithmetically valid nonsense — 650 g of almonds, 14 g
 * of chicken — so no quantity is proposed at all when neither basis exists.
 *
 * Reformulation safety: the serving mass is read from the CURRENT version, so a
 * V1 serving is never reused for a reformulated V2.
 */
export function proposePortion(
  candidate: RecommendationCandidate,
  input: RecommendationInput,
  remainingKcal: number | null,
): PortionProposal | null {
  const policy = input.policy;
  const v = candidate.productVersion;

  const servingGrams = v.labelFacts?.servingGrams;
  if (typeof servingGrams === 'number' && Number.isFinite(servingGrams) && servingGrams > 0) {
    const options = policy.servingMultiples
      .map((multiple) => ({ multiple, grams: servingGrams * multiple }))
      .filter((o) => withinBounds(o.grams, policy));

    if (options.length > 0) {
      // Prefer the largest multiple that still fits the remaining budget; if
      // none fits, fall back to the smallest grounded option.
      const chosen =
        remainingKcal === null
          ? options.find((o) => o.multiple === 1) ?? options[0]!
          : [...options]
              .sort((a, b) => b.grams - a.grams)
              .find((o) => kcalFor(v, o.grams) <= remainingKcal) ?? options[0]!;

      return { grams: toGrams(round1(chosen.grams)), basis: 'source_serving', servingMultiple: chosen.multiple };
    }
  }

  // The user's own behaviour with THIS product, keyed by stable productId so a
  // reformulation does not discard their history.
  const samples = input.history.observations
    .filter((h) => h.productId === v.productId)
    .filter((h) => daysBetween(h.loggedAt, input.nowIso) <= policy.history.windowDays)
    .map((h) => h.grams)
    .filter((g) => Number.isFinite(g) && g > 0 && withinBounds(g, policy));

  if (samples.length >= policy.history.minPortionSamples) {
    const value = round1(median(samples));
    if (withinBounds(value, policy)) {
      return { grams: toGrams(value), basis: 'user_history', sampleCount: samples.length };
    }
  }

  return null;
}

const withinBounds = (g: number, policy: RecommendationPolicy): boolean =>
  g >= policy.bounds.minPortionGrams &&
  g <= policy.bounds.maxPortionGrams &&
  g > SCALE_RANGE_G.min &&
  g <= SCALE_RANGE_G.max;

const round1 = (n: number): number => Math.round(n * 10) / 10;

/** Uses the nutrition engine, never local arithmetic. */
const kcalFor = (v: ProductVersion, g: number): number =>
  calculateNutrition(v.basis, toGrams(g)).totals.kcal;

// ---------------------------------------------------------------------------

export function recommendFoods(input: RecommendationInput): RecommendationSet {
  const { policy } = input;
  const energyConfidence = confidenceOf(input);
  const base = {
    policyVersion: policy.version,
    generatedAt: input.nowIso,
    recommendations: [] as readonly Recommendation[],
    energyConfidence,
  };

  // OWNERSHIP, verified here rather than assumed of the caller. Preferences and
  // history belonging to another subject can never influence this user.
  if (input.preferences !== null && input.preferences.userId !== input.userId) {
    return { ...base, status: 'subject_mismatch', reason: 'preferences_subject_mismatch' };
  }
  if (input.history.userId !== input.userId) {
    return { ...base, status: 'subject_mismatch', reason: 'history_subject_mismatch' };
  }
  if (input.history.observations.some((o) => o.userId !== input.userId)) {
    return { ...base, status: 'subject_mismatch', reason: 'observation_subject_mismatch' };
  }

  // Missing state is never filled in. A recommendation built on assumed
  // expenditure would be a confident wrong answer.
  if (input.macros === null) {
    return { ...base, status: 'insufficient_state', reason: 'macro_target_unavailable' };
  }

  const energy = input.energy;
  const remainingKcal = energy === null ? null : energy.remainingIntakeKcal;

  // With the day's energy budget spent, the engine does not push more food
  // merely because one macro remains.
  if (remainingKcal !== null && remainingKcal <= 0) {
    return { ...base, status: 'energy_budget_exhausted', reason: 'remaining_intake_not_positive' };
  }

  const eligible = input.candidates.filter((c) => isEligible(c, input));
  if (eligible.length === 0) {
    return { ...base, status: 'no_eligible_candidates', reason: 'no_candidate_passed_eligibility' };
  }

  const m = input.macros;
  const remaining = {
    protein: m.remainingProteinG as number,
    carbohydrate: m.remainingCarbohydrateG as number,
    fat: m.remainingFatG as number,
  };
  const targets = {
    protein: m.targets.proteinG as number,
    carbohydrate: m.targets.carbohydrateG as number,
    fat: m.targets.fatG as number,
  };
  const weights = macroDeficitWeights(remaining, targets);

  const scored = eligible
    .map((c) => scoreCandidate(c, input, weights, remaining, remainingKcal))
    .filter((r): r is Recommendation => r !== null);

  if (scored.length === 0) {
    return { ...base, status: 'no_eligible_candidates', reason: 'all_candidates_filtered' };
  }

  // Deterministic ordering: score, then productVersionId. Never input order.
  const byScore = [...scored].sort(
    (a, b) => b.score - a.score || a.productVersionId.localeCompare(b.productVersionId),
  );

  /**
   * ACTIONABILITY GATE.
   *
   * A weight alone cannot express the requirement. Blending actionability into
   * the score forces a false choice: heavy enough to demote ingredients means
   * actionability overpowers nutrition, and light enough to preserve nutrition
   * means ingredients still win. Measured directly — at weight 0.45 macro fit
   * fell from 93.3% to 88.3%, and at 0.25 ingredients still won 7.5% of the
   * time.
   *
   * The requirement is really a GATE: among candidates that are all
   * nutritionally qualifying, prefer one a person would actually eat. So
   * ranking stays purely nutritional, and this promotes an actionable
   * alternative only when it is nutritionally comparable to the leader.
   *
   * Nutrition still decides which candidates qualify. Actionability only
   * chooses between candidates that already do.
   */
  const ACTIONABLE = new Set<ActionabilityClass>([
    'ready_to_eat', 'meal_component', 'beverage',
  ]);
  const isActionable = (r: Recommendation): boolean => {
    const cls = r.actionabilityClass as ActionabilityClass | undefined;
    return cls !== undefined && ACTIONABLE.has(cls);
  };

  const ranked = (() => {
    const leader = byScore[0];
    if (leader === undefined || isActionable(leader)) return byScore;

    const threshold = leader.score * policy.bounds.actionabilityPromotionRatio;
    const promoted = byScore.find((r) => isActionable(r) && r.score >= threshold);
    if (promoted === undefined) return byScore;

    // The promoted candidate is nutritionally comparable AND edible as-is.
    return [promoted, ...byScore.filter((r) => r !== promoted)];
  })();

  return {
    ...base,
    // Availability and energy confidence are separate axes: an incomplete
    // energy picture limits confidence without suppressing the suggestion.
    status: energyConfidence.level === 'complete'
      ? 'available'
      : 'available_with_limited_energy_confidence',
    recommendations: ranked.slice(0, policy.maxResults),
  };
}

function scoreCandidate(
  candidate: RecommendationCandidate,
  input: RecommendationInput,
  weights: Record<MacroName, number>,
  remaining: Record<MacroName, number>,
  remainingKcal: number | null,
): Recommendation | null {
  const { policy } = input;
  const v = candidate.productVersion;
  const rationale: RationaleCode[] = [];
  const { comparison } = policy;

  // CONTRIBUTION, not composition. See macroContributionGrams.
  const contribution = macroContributionGrams(v, comparison.basisGrams);
  const closure: Record<MacroName, number> = {
    protein: gapClosure(contribution.protein, remaining.protein,
      comparison.minMeaningfulGrams.protein, comparison.fullClosureFraction),
    carbohydrate: gapClosure(contribution.carbohydrate, remaining.carbohydrate,
      comparison.minMeaningfulGrams.carbohydrate, comparison.fullClosureFraction),
    fat: gapClosure(contribution.fat, remaining.fat,
      comparison.minMeaningfulGrams.fat, comparison.fullClosureFraction),
  };

  // Weights sum to 1 and each closure is in [0, 1], so macroFit is bounded.
  const macroFit = MACROS.reduce((s, m) => s + weights[m] * closure[m], 0);

  for (const m of MACROS) {
    if (weights[m] >= 0.4 && closure[m] >= 0.4) {
      rationale.push(
        m === 'protein' ? 'strong_protein_fit' : m === 'carbohydrate' ? 'strong_carb_fit' : 'strong_fat_fit',
      );
    }
  }

  /**
   * ALREADY-EXHAUSTED MACROS.
   *
   * A macro at or below zero remaining cannot be "closed", so it earns nothing
   * above — but adding a material amount of it must also cost something.
   * Scaling by the macro TARGET keeps this bounded and avoids dividing by a
   * remaining value that is zero or negative.
   */
  let exhaustedMacroPenalty = 0;
  const targets = input.macros === null ? null : {
    protein: input.macros.targets.proteinG as unknown as number,
    carbohydrate: input.macros.targets.carbohydrateG as unknown as number,
    fat: input.macros.targets.fatG as unknown as number,
  };
  if (targets !== null) {
    let exhaustedLoad = 0;
    for (const m of MACROS) {
      if (remaining[m] > 0) continue;
      if (contribution[m] < comparison.minMeaningfulGrams[m]) continue;
      const target = targets[m];
      if (!Number.isFinite(target) || target <= 0) continue;
      exhaustedLoad += Math.min(1, contribution[m] / target);
    }
    if (exhaustedLoad > 0) {
      exhaustedMacroPenalty = policy.penalties.exhaustedMacro * Math.min(1, exhaustedLoad);
      rationale.push('would_overshoot_macro');
    }
  }

  /**
   * CONSUMER ACTIONABILITY, from catalog metadata. Derived from the USDA
   * category, canonical preparation state and descriptive form — never from a
   * list of food names, so it generalises to every flour and every oil rather
   * than the four that happened to surface in testing.
   */
  const v2 = v as unknown as Record<string, unknown>;
  const actionability = assessActionability({
    displayName: v.displayName,
    category: typeof v2['category'] === 'string' ? v2['category'] : null,
    preparationState: v.preparationState,
    sourceDescription: typeof v2['sourceDescription'] === 'string'
      ? v2['sourceDescription'] : null,
  });

  const portion = proposePortion(candidate, input, remainingKcal);
  let energyFit = 0;
  /**
   * Candidates WITHOUT portion authority were previously scored on composition
   * alone, because energy fit was only computed for grounded portions. They are
   * now compared on the same normalized basis — a ranking device that makes no
   * quantity claim and produces no `portionProposal`.
   */
  let usedComparisonBasisForEnergy = false;
  let energyOvershootPenalty = 0;
  let macroOvershootPenalty = 0;
  let nutrition;

  if (portion !== null) {
    nutrition = calculateNutrition(v.basis, portion.grams).totals;
    rationale.push(
      portion.basis === 'source_serving' ? 'portion_from_source_serving' : 'portion_from_your_history',
    );

    if (remainingKcal !== null && remainingKcal > 0) {
      const ratio = nutrition.kcal / remainingKcal;
      if (ratio > policy.bounds.maxEnergyOvershootRatio) {
        // HARD bound: this portion cannot sensibly be suggested today.
        return null;
      }
      if (ratio > 1) {
        energyOvershootPenalty = policy.penalties.energyOvershoot * (ratio - 1);
        rationale.push('would_overshoot_energy');
      } else {
        // USEFUL PROGRESS within the budget, not "fewest calories wins".
        // v1 used `1 - ratio`, which awarded a near-zero-energy food the maximum
        // score precisely because it contributed nothing.
        energyFit = Math.min(1, ratio / comparison.usefulEnergyFraction);
        rationale.push('fits_remaining_energy');
      }
    }

    let macroOver = 0;
    for (const m of MACROS) {
      const contributed =
        m === 'protein' ? nutrition.proteinG
        : m === 'carbohydrate' ? nutrition.carbohydrateG
        : nutrition.fatG;
      if (remaining[m] > 0 && contributed > remaining[m]) {
        macroOver += (contributed - remaining[m]) / remaining[m];
      }
    }
    if (macroOver > 0) {
      macroOvershootPenalty = policy.penalties.macroOvershoot * Math.min(1, macroOver);
      rationale.push('would_overshoot_macro');
    }
  } else {
    // NO PORTION AUTHORITY. The food may still be a good answer to "what should
    // I eat?"; only "how much?" is unanswerable. It is ranked on the normalized
    // comparison basis, and no quantity is proposed or shown.
    rationale.push('portion_unavailable');
    usedComparisonBasisForEnergy = true;
    void usedComparisonBasisForEnergy;

    if (remainingKcal !== null && remainingKcal > 0) {
      // AUTHORITATIVE energy. INT-2 computed protein*4 + carb*4 + fat*9 here,
      // making the recommendation engine a second nutrition calculator — and a
      // second calculator eventually disagrees with the first. The comparison
      // basis is a mass like any other, so the canonical path handles it.
      const comparisonKcal = calculateNutrition(
        v.basis, comparison.basisGrams as unknown as Grams).totals.kcal as unknown as number;
      const ratio = comparisonKcal / remainingKcal;
      if (ratio > 1) {
        // Density incompatible with what is left. Penalised, not rejected: with
        // no serving mass we cannot claim the person would eat this much, so
        // eliminating the food outright would overstate what we know.
        energyOvershootPenalty = policy.penalties.energyOvershoot * Math.min(2, ratio - 1);
        rationale.push('would_overshoot_energy');
      } else {
        energyFit = Math.min(1, ratio / comparison.usefulEnergyFraction);
        rationale.push('fits_remaining_energy');
      }
    }

    // Macro overshoot on the SAME comparison basis. Without this a nearly
    // exhausted macro — say 3 g of fat left — was treated as fully closed by
    // any material contribution, because closure saturates. Overfilling a
    // gap is not filling it.
    let comparisonMacroOver = 0;
    for (const m of MACROS) {
      if (remaining[m] <= 0) continue;
      if (contribution[m] > remaining[m]) {
        comparisonMacroOver += (contribution[m] - remaining[m]) / remaining[m];
      }
    }
    if (comparisonMacroOver > 0) {
      macroOvershootPenalty = policy.penalties.macroOvershoot * Math.min(1, comparisonMacroOver);
      rationale.push('would_overshoot_macro');
    }
  }

  // History and preference are RANKING nudges only — never nutrition authority
  // and never able to override a materially better nutritional fit on their own.
  const recent = input.history.observations.filter(
    (h) => h.productId === v.productId &&
      daysBetween(h.loggedAt, input.nowIso) <= policy.history.recencyWindowDays,
  );
  const historyNudge = recent.length > 0 ? policy.weights.historyNudge : 0;
  if (recent.length > 0) rationale.push('recently_used');

  const preferred = input.preferences?.preferredProductIds.includes(v.productId) === true;
  const preferenceNudge = preferred ? policy.weights.preferenceNudge : 0;
  if (preferred) rationale.push('preferred');

  // Discourage suggesting what the user has already eaten repeatedly today.
  const todayCount = input.history.observations.filter(
    (h) => h.productId === v.productId && h.localDate === todayOf(input),
  ).length;
  const repetitionPenalty = todayCount >= 2 ? policy.penalties.repetition : 0;

  const components: ScoreComponents = {
    macroFit: macroFit * policy.weights.macroFit,
    // Scaled by macroFit so actionability can only reorder candidates that
    // already solve the user's state. A nutritionally poor food gains almost
    // nothing from being familiar.
    actionability: actionability.score * macroFit * policy.weights.actionability,
    energyFit: energyFit * policy.weights.energyFit,
    historyNudge,
    preferenceNudge,
    energyOvershootPenalty,
    // Both overshoot signals share one component: exceeding a macro you still
    // have room for, and adding to one you have already exhausted, are the same
    // kind of harm.
    macroOvershootPenalty: macroOvershootPenalty + exhaustedMacroPenalty,
    repetitionPenalty,
  };

  const score =
    components.macroFit + components.energyFit + components.actionability
    + components.historyNudge + components.preferenceNudge
    - components.energyOvershootPenalty - components.macroOvershootPenalty - components.repetitionPenalty;

  return {
    productId: v.productId,
    productVersionId: v.productVersionId,
    displayName: v.displayName,
    ...(v.brandName !== undefined ? { brandName: v.brandName } : {}),
    preparationState: String(v.preparationState),
    score: Math.round(score * 1e6) / 1e6,
    scoreComponents: components,
    actionabilityClass: actionability.actionabilityClass,
    rationaleCodes: rationale,
    ...(portion !== null ? { portionProposal: portion } : {}),
    ...(nutrition !== undefined ? { nutritionAtProposedPortion: nutrition } : {}),
  };
}

/** The canonical local day, supplied by daily state. Never sliced from UTC. */
const todayOf = (input: RecommendationInput): string => input.localDate;

/**
 * Read canonical completeness. Missing activity or unavailable TEF lowers
 * confidence; it is never silently treated as zero, and no PAL is substituted.
 */
function confidenceOf(input: RecommendationInput): EnergyConfidence {
  const e = input.energy as unknown as {
    energyCompleteness?: 'complete' | 'incomplete';
    completenessGaps?: readonly string[];
  } | null;
  if (e === null) return { level: 'unavailable', gaps: ['energy_state_unavailable'] };
  if (e.energyCompleteness === 'incomplete') {
    return { level: 'incomplete', gaps: [...(e.completenessGaps ?? [])] };
  }
  return { level: 'complete', gaps: [] };
}

/**
 * Project effective food-log entries into history observations.
 *
 * The caller must pass ALREADY-FOLDED entries, so voided and superseded logs
 * never reach ranking or portion statistics.
 */
export function observationsFromLogs(
  userId: string,
  logs: readonly {
    userId: string; productId: string; productVersionId: string;
    grams: number; loggedAt: string; localDate: string;
  }[],
): RecommendationHistorySnapshot {
  return {
    userId,
    observations: logs
      .filter((l) => l.userId === userId)
      .map((l) => ({
        userId: l.userId,
        productId: l.productId,
        productVersionId: l.productVersionId,
        grams: l.grams,
        loggedAt: l.loggedAt,
        localDate: l.localDate,
      })),
  };
}

export type { Grams };
