import type { FoodPlan, PlanComponent } from '@macros/domain-recommendation';

/**
 * SAFE CONVERSATIONAL GUIDANCE — contracts.
 *
 * The conversational layer sits ABOVE deterministic truth and is never allowed
 * to become a source of it. A language model may reason about phrasing and
 * human preference; it may not decide what a food is, what it contains, or how
 * much of it to eat.
 *
 * The whole design follows from one rule: everything a user sees that is a
 * FACT comes from a trusted field MACROS computed, and everything the model
 * contributes is language around those facts.
 */
export const GUIDANCE_CONTRACT_VERSION = 'guidance-contracts@1.0.0';

/** What the user is trying to do. Deliberately small — this is not a chatbot. */
export type GuidanceIntent =
  | 'what_should_i_eat'
  | 'request_alternative'
  | 'choose_candidate'
  | 'prefer_quick'
  | 'prefer_meal'
  | 'decline'
  | 'clarification_needed';

/**
 * A candidate the model is allowed to talk about.
 *
 * Identity, role and rationale all come from the frozen planner. The model
 * receives these and may choose among them; it cannot nominate anything else,
 * because a food outside this list has no trusted nutrition behind it.
 */
export interface EnvelopeCandidate {
  readonly productId: string;
  readonly productVersionId: string;
  readonly displayName: string;
  readonly role: string;
  readonly actionabilityClass: string;
  readonly rationaleCodes: readonly string[];
  /** Position in the frozen ranking. Preserved so ordering stays inspectable. */
  readonly rank: number;
  readonly isPlanComponent: boolean;
  /**
   * Grams ONLY when the recommendation engine grounded a portion. Absent means
   * the quantity is genuinely unknown and must be discovered on the scale.
   */
  readonly groundedPortionGrams: number | null;
}

/**
 * TRUSTED DISPLAY SLOTS.
 *
 * Every number the user may see, pre-formatted by MACROS. The model never
 * computes or restates a figure: it emits a slot name, and application code
 * substitutes the trusted string after validation. That is what makes
 * "you need 43.7 g protein" impossible to fabricate.
 */
export interface GuidanceSlots {
  readonly [slot: string]: string;
}

export interface GuidanceEnvelope {
  readonly envelopeVersion: string;
  /** Which authenticated member this guidance belongs to. */
  readonly subjectId: string;
  readonly sessionId: string;
  readonly generatedAt: string;
  readonly plannerStatus: FoodPlan['status'];
  readonly objectives: readonly string[];
  readonly planComponents: readonly EnvelopeCandidate[];
  /** Bounded, role- and actionability-diverse alternatives from the same rank. */
  readonly alternatives: readonly EnvelopeCandidate[];
  readonly slots: GuidanceSlots;
  /** True when no component carries a grounded portion. */
  readonly weighingRequired: boolean;
  readonly moreGuidanceUsefulAfterWeighing: boolean;
}

export interface GuidanceRequest {
  readonly envelope: GuidanceEnvelope;
  readonly intent: GuidanceIntent;
  /** Session-scoped only. No long-term memory exists in this milestone. */
  readonly recentTurns: readonly { readonly role: 'user' | 'macros'; readonly text: string }[];
  /** Set when the user named a food; must match an envelope candidate. */
  readonly chosenProductVersionId?: string;
}

/**
 * What a provider may return.
 *
 * `text` may contain `{slot}` placeholders and `{candidate:<id>}` references,
 * nothing else that asserts a fact.
 */
export interface GuidanceProviderResult {
  readonly intent: GuidanceIntent;
  readonly selectedProductVersionIds: readonly string[];
  readonly text: string;
  readonly clarificationNeeded: boolean;
  readonly suggestedNextAction: GuidanceNextAction;
  readonly alternativeProductVersionIds?: readonly string[];
}

export type GuidanceNextAction =
  | 'await_choice'
  | 'await_weight'
  | 'await_clarification'
  | 'none';

export interface GuidanceProvider {
  readonly name: string;
  generate(request: GuidanceRequest): Promise<GuidanceProviderResult>;
}

/** Why a provider result was refused. Each maps to a real safety rule. */
export type GuidanceRejection =
  | 'unknown_candidate'
  | 'identity_changed'
  | 'fabricated_portion'
  | 'fabricated_nutrition'
  | 'unknown_slot'
  | 'recommendation_after_exhausted_budget'
  | 'quantity_without_authority'
  | 'malformed_result'
  | 'unsupported_action'
  | 'provider_unavailable';

export interface GuidanceOutcome {
  readonly text: string;
  readonly intent: GuidanceIntent;
  readonly candidates: readonly EnvelopeCandidate[];
  readonly nextAction: GuidanceNextAction;
  /** True when the deterministic fallback produced this, not the provider. */
  readonly usedFallback: boolean;
  readonly rejections: readonly GuidanceRejection[];
  readonly providerName: string | null;
}

export type { FoodPlan, PlanComponent };
