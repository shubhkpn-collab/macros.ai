import type {
  EnvelopeCandidate, GuidanceEnvelope, GuidanceIntent, GuidanceNextAction,
  GuidanceProviderResult, GuidanceRejection,
} from './contracts.js';

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

/**
 * Any bare number in model text is a fabricated fact.
 *
 * Trusted figures arrive through `{slot}` placeholders, which are substituted
 * AFTER validation — so by construction the model never types a digit that
 * reaches a screen. Digits inside placeholders are not matched.
 */
const BARE_NUMBER = /(?<!\{[^}]{0,80})\b\d+(?:[.,]\d+)?\b/;

/** Nutrition vocabulary the model must not assert around a number. */
const NUTRITION_CLAIM = /\b(kcal|calorie|calories|grams?|\bg\b|protein|carb|carbohydrate|fat)\b/i;

const PLACEHOLDER = /\{([a-z0-9_:@.\-]+)\}/gi;

export interface ValidationResult {
  readonly ok: boolean;
  readonly rejections: readonly GuidanceRejection[];
  readonly candidates: readonly EnvelopeCandidate[];
  readonly nextAction: GuidanceNextAction;
}

const reject = (...r: GuidanceRejection[]): ValidationResult =>
  ({ ok: false, rejections: r, candidates: [], nextAction: 'none' });

/**
 * Validate a provider result against the envelope it was given.
 */
export function validateGuidance(
  result: GuidanceProviderResult | null | undefined,
  envelope: GuidanceEnvelope,
): ValidationResult {
  // --- shape ------------------------------------------------------------
  if (result === null || result === undefined || typeof result !== 'object') {
    return reject('malformed_result');
  }
  if (typeof result.text !== 'string' || !Array.isArray(result.selectedProductVersionIds)) {
    return reject('malformed_result');
  }
  if (!VALID_INTENTS.has(result.intent)) return reject('malformed_result');
  if (!VALID_ACTIONS.has(result.suggestedNextAction)) return reject('unsupported_action');

  const known = new Map<string, EnvelopeCandidate>();
  for (const c of [...envelope.planComponents, ...envelope.alternatives]) {
    known.set(c.productVersionId, c);
  }

  // --- exhausted budget --------------------------------------------------
  // The planner already refused; the conversation must not reopen it.
  if (envelope.plannerStatus !== 'available'
      && result.selectedProductVersionIds.length > 0) {
    return reject('recommendation_after_exhausted_budget');
  }

  // --- candidate identity -------------------------------------------------
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

  // --- placeholders --------------------------------------------------------
  const rejections: GuidanceRejection[] = [];
  for (const match of result.text.matchAll(PLACEHOLDER)) {
    const token = match[1]!;
    if (token.startsWith('candidate:')) {
      const id = token.slice('candidate:'.length);
      if (!known.has(id)) rejections.push('unknown_candidate');
      continue;
    }
    // Every other placeholder must be a slot MACROS actually supplied.
    if (!(token in envelope.slots)) rejections.push('unknown_slot');
  }

  // --- fabricated numbers ---------------------------------------------------
  const withoutPlaceholders = result.text.replace(PLACEHOLDER, '');
  if (BARE_NUMBER.test(withoutPlaceholders)) {
    // A digit outside a trusted slot is either invented nutrition or an
    // invented quantity; both are refused.
    rejections.push(NUTRITION_CLAIM.test(withoutPlaceholders)
      ? 'fabricated_nutrition' : 'fabricated_portion');
  }

  // --- quantity without authority ------------------------------------------
  const claimsWeight = /\b(gram|grams|\d\s*g\b|portion|serving|scoop|slice)\b/i
    .test(withoutPlaceholders);
  if (claimsWeight && selected.some((c) => c.groundedPortionGrams === null)) {
    rejections.push('quantity_without_authority');
  }

  // --- next action coherence ------------------------------------------------
  let nextAction = result.suggestedNextAction;
  if (nextAction === 'await_weight') {
    if (selected.length === 0) rejections.push('unsupported_action');
  }
  // With no grounded portion the only honest next step is the scale.
  if (selected.length === 1 && selected[0]!.groundedPortionGrams === null
      && nextAction === 'none') {
    nextAction = 'await_weight';
  }

  if (rejections.length > 0) {
    return { ok: false, rejections, candidates: [], nextAction: 'none' };
  }
  return { ok: true, rejections: [], candidates: selected, nextAction };
}

/**
 * Substitute trusted values into validated text.
 *
 * Runs only AFTER validation, so every inserted string is one MACROS computed.
 */
export function renderGuidanceText(
  text: string,
  envelope: GuidanceEnvelope,
): string {
  const known = new Map<string, EnvelopeCandidate>();
  for (const c of [...envelope.planComponents, ...envelope.alternatives]) {
    known.set(c.productVersionId, c);
  }
  return text.replace(PLACEHOLDER, (whole, token: string) => {
    if (token.startsWith('candidate:')) {
      return known.get(token.slice('candidate:'.length))?.displayName ?? whole;
    }
    return envelope.slots[token] ?? whole;
  });
}
