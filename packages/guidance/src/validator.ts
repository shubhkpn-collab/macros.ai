import type {
  EnvelopeCandidate, GuidanceEnvelope, GuidanceIntent, GuidanceNextAction,
  GuidanceProviderResult, GuidanceRejection, GuidanceTone,
} from './contracts.js';
import { TEMPLATES, renderTemplate } from './templates.js';

/**
 * STRICT POST-VALIDATION.
 *
 * Everything a provider returns is untrusted until it passes here. The
 * validator is deterministic and knows nothing about language quality — it
 * checks only whether the result asserts anything MACROS did not compute.
 *
 * A failure is never surfaced as an error to the user; it falls back to
 * deterministic guidance, because an appliance that says something wrong is
 * worse than one that says something plain.
 */
export const VALIDATOR_VERSION = 'guidance-validator@1.0.0';

const VALID_INTENTS = new Set<GuidanceIntent>([
  'what_should_i_eat', 'request_alternative', 'choose_candidate',
  'prefer_quick', 'prefer_meal', 'decline', 'clarification_needed',
]);

const VALID_ACTIONS = new Set<GuidanceNextAction>([
  'await_choice', 'await_weight', 'await_clarification', 'none',
]);

const VALID_TONES = new Set<GuidanceTone>(['neutral', 'brief', 'encouraging']);

export interface ValidationResult {
  readonly ok: boolean;
  readonly rejections: readonly GuidanceRejection[];
  readonly candidates: readonly EnvelopeCandidate[];
  readonly nextAction: GuidanceNextAction;
  readonly text: string;
}

const reject = (...r: GuidanceRejection[]): ValidationResult =>
  ({ ok: false, rejections: r, candidates: [], nextAction: 'none', text: '' });

/**
 * Validate a provider result against the envelope it was given.
 *
 * There is no prose to police any more. The provider returns references and an
 * enum, so validation is entirely structural — every check below is a fact
 * about identity, arity or authority rather than a guess about language.
 */
export function validateGuidance(
  result: GuidanceProviderResult | null | undefined,
  envelope: GuidanceEnvelope,
): ValidationResult {
  if (result === null || result === undefined || typeof result !== 'object') {
    return reject('malformed_result');
  }
  if (!Array.isArray(result.selectedProductVersionIds)) return reject('malformed_result');
  if (!VALID_INTENTS.has(result.intent)) return reject('malformed_result');
  if (!VALID_ACTIONS.has(result.suggestedNextAction)) return reject('unsupported_action');
  if (result.tone !== undefined && !VALID_TONES.has(result.tone)) {
    return reject('malformed_result');
  }

  const spec = TEMPLATES[result.templateId];
  if (spec === undefined) return reject('unknown_template');

  const known = new Map<string, EnvelopeCandidate>();
  for (const c of [...envelope.planComponents, ...envelope.alternatives]) {
    known.set(c.productVersionId, c);
  }

  // The planner already refused; the conversation must not reopen it.
  const planAvailable = envelope.plannerStatus === 'available';
  if (!planAvailable && result.selectedProductVersionIds.length > 0) {
    return reject('recommendation_after_exhausted_budget');
  }
  if (spec.requiresEmptyPlan === true && planAvailable && envelope.planComponents.length > 0) {
    return reject('unsupported_action');
  }

  // --- candidate identity ------------------------------------------------
  const selected: EnvelopeCandidate[] = [];
  for (const id of result.selectedProductVersionIds) {
    if (typeof id !== 'string') return reject('malformed_result');
    const candidate = known.get(id);
    // A food outside the envelope has no trusted nutrition behind it.
    if (candidate === undefined) return reject('unknown_candidate');
    selected.push(candidate);
  }
  for (const id of result.alternativeProductVersionIds ?? []) {
    if (!known.has(id)) return reject('unknown_candidate');
  }

  // A template renders exactly as many names as it declares.
  if (selected.length !== spec.candidates) return reject('template_arity_mismatch');

  // --- slots and objectives -----------------------------------------------
  for (const slot of result.slotRefs ?? []) {
    if (!(slot in envelope.slots)) return reject('unknown_slot');
  }
  if (spec.usesObjective) {
    const index = result.objectiveIndex ?? 0;
    if (!Number.isInteger(index) || index < 0 || index >= envelope.objectives.length) {
      return reject('unknown_objective');
    }
  }

  // --- quantity authority ---------------------------------------------------
  // Only a template that states an amount could breach this, and none does; the
  // check stays so a future template cannot quietly introduce one.
  if (result.templateId === 'confirm_choice_await_weight'
      && selected[0]?.groundedPortionGrams === null
      && result.suggestedNextAction !== 'await_weight') {
    return reject('quantity_without_authority');
  }

  let nextAction = result.suggestedNextAction;
  if (selected.length === 1 && selected[0]!.groundedPortionGrams === null
      && nextAction === 'none') {
    // With no grounded portion the only honest next step is the scale.
    nextAction = 'await_weight';
  }

  const text = renderTemplate(result.templateId, selected, envelope, {
    ...(result.objectiveIndex !== undefined ? { objectiveIndex: result.objectiveIndex } : {}),
    ...(result.tone !== undefined ? { tone: result.tone } : {}),
  });

  return { ok: true, rejections: [], candidates: selected, nextAction, text };
}
