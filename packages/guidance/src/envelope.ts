import type { RecommendationInput, RecommendationSet } from '@macros/domain-recommendation';
import { assessRole, recommendFoodPlan, recommendFoods } from '@macros/domain-recommendation';
import { formatGrams, formatKcal } from '@macros/tablet-view-model';
import type {
  EnvelopeCandidate, GuidanceEnvelope, GuidanceSlots, ProviderFacingEnvelope,
} from './contracts.js';

/**
 * ENVELOPE CONSTRUCTION.
 *
 * Everything the conversational layer is permitted to know. No repository, no
 * raw database object and no unnecessary history crosses this boundary — a
 * model cannot leak what it was never given.
 */
export const ENVELOPE_VERSION = 'guidance-envelope@1.0.0';

/** Bounded on purpose: choice enough to sound natural, not a catalog dump. */
const MAX_ALTERNATIVES = 4;

export interface EnvelopeSubject {
  readonly subjectId: string;
  readonly sessionId: string;
}

/**
 * Project a ranked recommendation into an envelope candidate.
 *
 * `role` is resolved from the REAL ProductVersion through the frozen role
 * model. It previously defaulted to 'unknown' for every non-plan candidate,
 * because the role lookup was populated only from plan components — which
 * silently made the claim of role-diverse alternatives false while the code
 * looked correct.
 */
const toCandidate = (
  r: RecommendationSet['recommendations'][number],
  isPlanComponent: boolean,
  role: string,
): EnvelopeCandidate => ({
  productId: r.productId,
  productVersionId: r.productVersionId,
  displayName: r.displayName,
  role,
  actionabilityClass:
    (r as unknown as { actionabilityClass?: string }).actionabilityClass ?? 'unknown',
  rationaleCodes: r.rationaleCodes,
  rank: r.finalRank,
  isPlanComponent,
  // Grounded ONLY when the engine grounded it. Null means genuinely unknown.
  groundedPortionGrams: (r.portionProposal?.grams as unknown as number | undefined) ?? null,
});

/**
 * Build the guidance envelope for one authenticated member.
 *
 * `subject` is passed explicitly rather than read from ambient state, so a
 * stale envelope from a previous member cannot survive a device switch: a new
 * member produces a new envelope or none at all.
 */
export function buildGuidanceEnvelope(
  input: RecommendationInput,
  subject: EnvelopeSubject,
): GuidanceEnvelope {
  const plan = recommendFoodPlan(input);
  const set = recommendFoods(input);

  const componentIds = new Set(plan.components.map((c) => c.productVersionId));
  // Authoritative role for EVERY candidate, from the real ProductVersion via
  // the frozen role model — never from a display name, and never defaulted.
  const versionById = new Map(
    input.candidates.map((c) => [c.productVersion.productVersionId, c.productVersion]));
  const roleOf = (productVersionId: string): string => {
    const v = versionById.get(productVersionId);
    return v === undefined ? 'unknown' : assessRole(v).role;
  };

  const planComponents: EnvelopeCandidate[] = plan.components.map((c) => {
    const r = set.recommendations.find((x) => x.productVersionId === c.productVersionId);
    return {
      productId: c.productId,
      productVersionId: c.productVersionId,
      displayName: c.displayName,
      role: c.role,
      actionabilityClass: c.actionabilityClass,
      rationaleCodes: c.rationaleCodes,
      rank: r?.finalRank ?? 0,
      isPlanComponent: true,
      groundedPortionGrams: (c.portionProposal?.grams as unknown as number | undefined) ?? null,
    };
  });

  /**
   * SAFE ALTERNATIVES.
   *
   * Taken from the SAME frozen ranking — no new scoring, and the model never
   * searches the catalog. Diversity is by role and actionability so the
   * conversation can offer a real choice rather than four near-identical
   * records, but every entry is already nutritionally qualified.
   */
  const alternatives: EnvelopeCandidate[] = [];
  const seenRoles = new Set<string>(planComponents.map((c) => c.role));
  const seenProducts = new Set<string>(planComponents.map((c) => c.productId));

  for (const pass of [0, 1]) {
    for (const r of set.recommendations) {
      if (alternatives.length >= MAX_ALTERNATIVES) break;
      if (componentIds.has(r.productVersionId)) continue;
      if (seenProducts.has(r.productId)) continue;
      const role = roleOf(r.productVersionId);
      // First pass prefers unseen roles; second fills remaining slots.
      if (pass === 0 && seenRoles.has(role)) continue;
      alternatives.push(toCandidate(r, false, role));
      seenRoles.add(role);
      seenProducts.add(r.productId);
    }
  }

  /**
   * TRUSTED SLOTS — every number the user may see, already formatted.
   *
   * The model emits slot names; application code substitutes these strings
   * after validation. That is why a fabricated figure cannot reach a screen.
   */
  const slots: GuidanceSlots = {};
  const macros = input.macros;
  const mutableSlots = slots as Record<string, string>;
  if (macros !== null) {
    mutableSlots['remaining_protein_g'] =
      formatGrams(macros.remainingProteinG as unknown as number);
    mutableSlots['remaining_carbohydrate_g'] =
      formatGrams(macros.remainingCarbohydrateG as unknown as number);
    mutableSlots['remaining_fat_g'] = formatGrams(macros.remainingFatG as unknown as number);
    mutableSlots['remaining_kcal'] = formatKcal(macros.remainingKcal as unknown as number);
  }
  if (input.energy !== null) {
    mutableSlots['energy_balance_kcal'] =
      formatKcal(input.energy.currentBalanceKcal as unknown as number, { sign: true });
  }

  const weighingRequired = planComponents.length > 0
    && planComponents.every((c) => c.groundedPortionGrams === null);

  return {
    envelopeVersion: ENVELOPE_VERSION,
    subjectId: subject.subjectId,
    sessionId: subject.sessionId,
    generatedAt: plan.generatedAt,
    plannerStatus: plan.status,
    objectives: plan.objectives,
    planComponents,
    alternatives,
    slots,
    weighingRequired,
    moreGuidanceUsefulAfterWeighing: plan.moreGuidanceUsefulAfterWeighing,
  };
}

/**
 * Strip everything a provider does not need.
 *
 * `subjectId` and `sessionId` are removed because a conversational model has no
 * use for them and every identifier that crosses a network boundary is one that
 * can leak. Isolation is enforced internally, before this point.
 */
export function toProviderFacing(envelope: GuidanceEnvelope): ProviderFacingEnvelope {
  return {
    envelopeVersion: envelope.envelopeVersion,
    plannerStatus: envelope.plannerStatus,
    objectives: envelope.objectives,
    planComponents: envelope.planComponents,
    alternatives: envelope.alternatives,
    slots: envelope.slots,
    weighingRequired: envelope.weighingRequired,
    moreGuidanceUsefulAfterWeighing: envelope.moreGuidanceUsefulAfterWeighing,
  };
}
