import type { ActionabilityClass } from '@macros/domain-catalog';
import { recommendFoods } from './engine.js';
import { assessRole, roleForMacro, type NutritionalRole } from './roles.js';
import type {
  PortionProposal, RationaleCode, Recommendation, RecommendationInput,
  RecommendationStatus,
} from './contracts.js';

/**
 * MULTI-FOOD PLANNER.
 *
 * INT-3 exposed a structural limit rather than a scoring bug: the engine had to
 * solve a multi-macro state with ONE food, so a record that happened to contain
 * the right ratio won even when it was an odd thing to eat. A person with a
 * protein gap, a carbohydrate gap and no fat allowance is not looking for a
 * single food containing exactly that — they want lean protein and a low-fat
 * carbohydrate beside it.
 *
 * This layer ORCHESTRATES the frozen engine. It scores nothing itself and
 * performs no nutritional arithmetic: candidates, ranking and portion authority
 * all come from `recommendFoods`.
 */
/**
 * Bumped for INT-4B. v1.0.0 inherited the engine leader as the primary
 * component even after computing the ordered macro gaps and the role each
 * would need — which is why dominant-gap role coverage sat at 66.4% and a
 * `balanced` parmesan topping led a large protein gap.
 */
export const PLANNER_VERSION = 'meal-component-planner@2.0.0';

/**
 * How competitive a role-matched candidate must be to displace the engine
 * leader. Nutrition remains the ADMISSION gate: a role match cannot rescue a
 * materially worse food, it only chooses among candidates already close enough
 * to be interchangeable on nutrition.
 */
const PRIMARY_ROLE_MIN_SCORE_RATIO = 0.8;

export type ComponentRationale = RationaleCode | 'addresses_primary_gap'
  | 'complements_primary_component' | 'avoids_exhausted_macro';

export interface PlanComponent {
  readonly productId: string;
  readonly productVersionId: string;
  readonly displayName: string;
  readonly role: NutritionalRole;
  readonly actionabilityClass: ActionabilityClass | 'unknown';
  readonly rationaleCodes: readonly ComponentRationale[];
  /**
   * Present ONLY when the engine grounded one. The planner never invents a
   * quantity and never sums hypothetical amounts across components.
   */
  readonly portionProposal?: PortionProposal;
}

export interface FoodPlan {
  readonly status: RecommendationStatus;
  readonly policyVersion: string;
  readonly plannerVersion: string;
  readonly generatedAt: string;
  /** Macro directions the plan is trying to move, most important first. */
  readonly objectives: readonly ('protein' | 'carbohydrate' | 'fat' | 'energy')[];
  readonly components: readonly PlanComponent[];
  /**
   * True when the plan is only partly grounded and weighing the first component
   * would let a better second suggestion be made. This is what makes the future
   * scale interaction possible without the planner guessing quantities now.
   */
  readonly moreGuidanceUsefulAfterWeighing: boolean;
  /**
   * Totals are present ONLY if EVERY component carries a grounded portion.
   * Summing two hypothetical 100 g amounts and calling it a meal would be a
   * fabricated quantity claim.
   */
  readonly plannedTotals: null;
}

/** How large a gap must be, as a share of target, to be worth a component. */
const MATERIAL_GAP_FRACTION = 0.2;
/** A second component must score at least this share of the primary's score. */
const COMPLEMENT_MIN_SCORE_RATIO = 0.5;

const ACTIONABLE_DEFAULTS = new Set<ActionabilityClass>([
  'ready_to_eat', 'meal_component',
]);

/** Share of name tokens two records must share to count as the same food. */
const NEAR_DUPLICATE_OVERLAP = 0.6;

const nameTokens = (name: string): Set<string> =>
  new Set(name.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2));

/**
 * Are these effectively the same food?
 *
 * "Soybeans, dry roasted" and "Soybeans, roasted, salted" have different
 * product ids but are one food to a person, and offering both as a two-part
 * plan is not guidance. Token overlap is used for DEDUPLICATION only — it never
 * decides whether a food is suitable.
 */
function nearDuplicate(a: string, b: string): boolean {
  const ta = nameTokens(a);
  const tb = nameTokens(b);
  if (ta.size === 0 || tb.size === 0) return false;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared += 1;
  return shared / Math.min(ta.size, tb.size) >= NEAR_DUPLICATE_OVERLAP;
}

const classOf = (r: Recommendation): ActionabilityClass | 'unknown' =>
  (r as unknown as { actionabilityClass?: ActionabilityClass }).actionabilityClass ?? 'unknown';

/**
 * Plan a small set of foods for the user's current state.
 *
 * Deterministic throughout: same input, same plan. No randomness, no model.
 */
export function recommendFoodPlan(input: RecommendationInput): FoodPlan {
  const set = recommendFoods(input);

  const base = {
    status: set.status,
    policyVersion: set.policyVersion,
    plannerVersion: PLANNER_VERSION,
    generatedAt: set.generatedAt,
    plannedTotals: null,
  } as const;

  // Honest degradation is inherited, not re-decided.
  if (set.recommendations.length === 0) {
    return {
      ...base, objectives: [], components: [],
      moreGuidanceUsefulAfterWeighing: false,
    };
  }

  // --- what the user actually needs, from trusted state -----------------
  const macros = input.macros;
  const gaps: { macro: 'protein' | 'carbohydrate' | 'fat'; fraction: number }[] = [];
  if (macros !== null) {
    const t = macros.targets;
    const entries: [('protein' | 'carbohydrate' | 'fat'), number, number][] = [
      ['protein', macros.remainingProteinG as unknown as number, t.proteinG as unknown as number],
      ['carbohydrate', macros.remainingCarbohydrateG as unknown as number,
        t.carbohydrateG as unknown as number],
      ['fat', macros.remainingFatG as unknown as number, t.fatG as unknown as number],
    ];
    for (const [macro, remaining, target] of entries) {
      if (!Number.isFinite(target) || target <= 0) continue;
      const fraction = remaining / target;
      if (fraction >= MATERIAL_GAP_FRACTION) gaps.push({ macro, fraction });
    }
    gaps.sort((a, b) => b.fraction - a.fraction);
  }

  const objectives = gaps.length > 0
    ? gaps.map((g) => g.macro)
    : (['energy'] as const).slice();

  // Roles are resolved from the ORIGINAL candidate versions, since a
  // Recommendation carries identity rather than the full nutrient basis.
  const versionById = new Map(
    input.candidates.map((c) => [c.productVersion.productVersionId, c.productVersion]));
  const roleOf = (r: Recommendation): NutritionalRole => {
    const v = versionById.get(r.productVersionId);
    return v === undefined ? 'unknown' : assessRole(v).role;
  };

  /**
   * --- PRIMARY COMPONENT: role-aware ------------------------------------
   *
   * v1.0.0 took `set.recommendations[0]` unconditionally, so all the gap and
   * role analysis above was computed and then ignored. The engine leader is
   * still the default and still the fallback; it is displaced only by a
   * candidate that is nutritionally competitive, actionable as a normal
   * default, and carries the role the dominant gap actually needs.
   */
  const engineLeader = set.recommendations[0]!;
  const dominantGap = gaps[0];
  const dominantRole = dominantGap === undefined
    ? null : roleForMacro(dominantGap.macro);

  const roleMatchedPrimary = dominantRole === null ? undefined
    : set.recommendations.find((r) =>
      r.score >= engineLeader.score * PRIMARY_ROLE_MIN_SCORE_RATIO
      && ACTIONABLE_DEFAULTS.has(classOf(r) as ActionabilityClass)
      && roleOf(r) === dominantRole);

  const primaryRec = roleMatchedPrimary ?? engineLeader;
  const primary: PlanComponent = {
    productId: primaryRec.productId,
    productVersionId: primaryRec.productVersionId,
    displayName: primaryRec.displayName,
    role: roleOf(primaryRec),
    actionabilityClass: classOf(primaryRec),
    rationaleCodes: ['addresses_primary_gap', ...primaryRec.rationaleCodes],
    ...(primaryRec.portionProposal !== undefined
      ? { portionProposal: primaryRec.portionProposal } : {}),
  };

  const components: PlanComponent[] = [primary];

  /**
   * --- complementary components -----------------------------------------
   *
   * A second food is added only when a DIFFERENT material gap remains that the
   * primary does not address. One good food stays one good food: adding a
   * second for its own sake would make the answer harder to act on, not better.
   */
  const covered = new Set<NutritionalRole>([primary.role]);
  for (const gap of gaps) {
    if (components.length >= 3) break;
    const wanted = roleForMacro(gap.macro);
    if (covered.has(wanted)) continue;

    const candidate = set.recommendations.find((r) => {
      if (components.some((c) => c.productVersionId === r.productVersionId)) return false;
      // Two versions of one product, or two near-identical records, are not two
      // foods — a plan of "soybeans and soybeans" is not guidance.
      if (components.some((c) => c.productId === r.productId)) return false;
      if (components.some((c) => nearDuplicate(c.displayName, r.displayName))) return false;
      // Compared against the SELECTED primary, not the discarded engine leader,
      // so the threshold means the same thing whichever primary was chosen.
      if (r.score < primaryRec.score * COMPLEMENT_MIN_SCORE_RATIO) return false;
      // Actionability stays subordinate to nutrition, but a complement is a
      // free choice among qualifying candidates, so prefer an ordinary food.
      if (!ACTIONABLE_DEFAULTS.has(classOf(r) as ActionabilityClass)) return false;
      return roleOf(r) === wanted;
    });
    if (candidate === undefined) continue;

    covered.add(wanted);
    components.push({
      productId: candidate.productId,
      productVersionId: candidate.productVersionId,
      displayName: candidate.displayName,
      role: wanted,
      actionabilityClass: classOf(candidate),
      rationaleCodes: ['complements_primary_component', ...candidate.rationaleCodes],
      ...(candidate.portionProposal !== undefined
        ? { portionProposal: candidate.portionProposal } : {}),
    });
  }

  // Weighing helps whenever any component lacks portion authority: the actual
  // mass changes what, if anything, should be suggested next.
  const anyUngrounded = components.some((c) => c.portionProposal === undefined);

  return {
    ...base,
    objectives,
    components,
    moreGuidanceUsefulAfterWeighing: anyUngrounded,
  };
}
