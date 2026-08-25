import { DeterministicVoiceParser, type VoiceIntent, type VoiceParser } from '@macros/domain-voice';
import type { AssistantInterpretationInput, IntentProposal, ProposalKind } from './interpreter.js';
import { isNutrientId } from '@macros/domain-nutrients';
import { PROHIBITED_ARGUMENTS, TOOL_REGISTRY, isKnownTool, looksLikeInjection } from './registry.js';

/**
 * THE STRICT PROPOSAL VALIDATOR.
 *
 * PURE. Fails CLOSED: anything not positively recognised is rejected, and there
 * is no best-guess path. A rejected proposal produces a clarification, never a
 * "probably fine" execution.
 *
 * The validator is the only thing standing between untrusted model output and
 * real application intents, so it assumes the payload is hostile.
 */

export type ProposalRejection =
  | 'no_proposal'
  | 'unknown_tool'
  | 'unknown_argument'
  | 'prohibited_argument'
  | 'multiple_proposals'
  | 'multiple_state_changing'
  | 'action_not_allowed_here'
  | 'invalid_option_label'
  | 'option_not_current'
  | 'invalid_quantity'
  | 'quantity_not_in_transcript'
  | 'unsupported_unit'
  | 'invalid_query'
  | 'injection_payload'
  | 'invalid_nutrient';

export type ProposalValidation =
  | { readonly status: 'accepted'; readonly intent: VoiceIntent }
  | { readonly status: 'rejected'; readonly reason: ProposalRejection; readonly detail?: string };

export interface ValidateOptions {
  readonly input: AssistantInterpretationInput;
  /** Deterministic evidence for numeric arguments. Never the model's own claim. */
  readonly parser?: VoiceParser;
}

const NUTRIENTS = new Set(['calories', 'protein', 'carbohydrate', 'fat']);

export function validateProposals(
  proposals: readonly IntentProposal[],
  options: ValidateOptions,
): ProposalValidation {
  if (proposals.length === 0) {
    return { status: 'rejected', reason: 'no_proposal' };
  }

  // ONE STATE-CHANGING ACTION PER TURN. A hidden chain — search, select, guess a
  // weight, log it — is exactly the overreach this rule exists to prevent.
  const stateChanging = proposals.filter(
    (p) => isKnownTool(p.intentKind) && TOOL_REGISTRY[p.intentKind].stateChanging,
  );
  if (stateChanging.length > 1) {
    return { status: 'rejected', reason: 'multiple_state_changing' };
  }
  if (proposals.length > 1) {
    return { status: 'rejected', reason: 'multiple_proposals' };
  }

  return validateProposal(proposals[0]!, options);
}

export function validateProposal(
  proposal: IntentProposal,
  options: ValidateOptions,
): ProposalValidation {
  const { input } = options;

  if (typeof proposal.intentKind !== 'string' || !isKnownTool(proposal.intentKind)) {
    return { status: 'rejected', reason: 'unknown_tool', detail: String(proposal.intentKind) };
  }
  const kind: ProposalKind = proposal.intentKind;
  const spec = TOOL_REGISTRY[kind];

  const args = proposal.arguments ?? {};
  for (const name of Object.keys(args)) {
    const lowered = name.toLowerCase();
    // Authority fields are refused by NAME, before any value is examined.
    if (PROHIBITED_ARGUMENTS.includes(lowered)) {
      return { status: 'rejected', reason: 'prohibited_argument', detail: name };
    }
    if (!spec.allowedArguments.includes(name)) {
      return { status: 'rejected', reason: 'unknown_argument', detail: name };
    }
  }

  // Any string argument carrying an injected payload is refused outright.
  for (const value of Object.values(args)) {
    if (typeof value === 'string' && looksLikeInjection(value)) {
      return { status: 'rejected', reason: 'injection_payload' };
    }
  }

  // Context check LAST, so an attempt to supply authority fields is reported as
  // exactly that rather than being masked by a milder contextual rejection.
  if (!input.allowedActions.includes(kind)) {
    return { status: 'rejected', reason: 'action_not_allowed_here', detail: kind };
  }

  switch (kind) {
    case 'search_food': {
      const query = args['query'];
      if (typeof query !== 'string' || query.trim().length === 0 || query.length > 120) {
        return { status: 'rejected', reason: 'invalid_query' };
      }
      return { status: 'accepted', intent: { kind: 'search_food', query: query.trim() } };
    }

    case 'select_option': {
      const label = args['optionLabel'];
      if (typeof label !== 'string' || !/^[A-Da-d]$/.test(label.trim())) {
        return { status: 'rejected', reason: 'invalid_option_label', detail: String(label) };
      }
      const normalized = label.trim().toUpperCase();
      // The option must exist NOW, in the CURRENT flow. A model cannot select
      // from a screen the user is no longer looking at.
      if (!input.optionLabels.includes(normalized)) {
        return { status: 'rejected', reason: 'option_not_current', detail: normalized };
      }
      return { status: 'accepted', intent: { kind: 'select_option', optionLabel: normalized } };
    }

    case 'ask_nutrient': {
      const nutrientId = args['nutrientId'];
      // Must be a known canonical id. An arbitrary string is refused rather
      // than passed through to a lookup that would quietly miss.
      if (typeof nutrientId !== 'string' || !isNutrientId(nutrientId)) {
        return { status: 'rejected', reason: 'invalid_nutrient', detail: String(nutrientId) };
      }
      return { status: 'accepted', intent: { kind: 'ask_nutrient', nutrientId } };
    }

    case 'manual_weight':
      return validateWeight(args['grams'], options);

    case 'ask_consumed':
    case 'ask_remaining': {
      const nutrient = args['nutrient'];
      if (typeof nutrient !== 'string' || !NUTRIENTS.has(nutrient)) {
        return { status: 'rejected', reason: 'invalid_nutrient', detail: String(nutrient) };
      }
      return {
        status: 'accepted',
        intent: { kind, nutrient: nutrient as 'calories' | 'protein' | 'carbohydrate' | 'fat' },
      };
    }

    default:
      return { status: 'accepted', intent: { kind } as VoiceIntent };
  }
}

/**
 * NUMERIC EVIDENCE.
 *
 * A model may recognise that the user stated a weight. It may NOT supply the
 * number. "I'm having chicken" plus a proposed 200 g is a fabricated quantity
 * that would flow straight into a food log, so the figure is re-derived from
 * the ORIGINAL transcript by the deterministic parser and the model's value is
 * accepted only if it matches what the user actually said.
 */
function validateWeight(claimed: unknown, options: ValidateOptions): ProposalValidation {
  const parser = options.parser ?? new DeterministicVoiceParser();
  const parsed = parser.parse({
    transcript: options.input.transcript,
    receivedAt: '1970-01-01T00:00:00.000Z',
    userId: 'validator',
  });

  // A deterministic safety rejection is FINAL. A model cannot argue an unsupported
  // unit or a negative weight into being acceptable.
  if (parsed.status === 'invalid') {
    return {
      status: 'rejected',
      reason: parsed.reason === 'unsupported_unit' ? 'unsupported_unit' : 'invalid_quantity',
      detail: parsed.reason,
    };
  }
  if (parsed.status !== 'understood' || parsed.intent.kind !== 'manual_weight') {
    return { status: 'rejected', reason: 'quantity_not_in_transcript' };
  }

  const grounded = parsed.intent.grams;
  if (typeof claimed === 'number' && Number.isFinite(claimed) && claimed !== grounded) {
    return {
      status: 'rejected',
      reason: 'quantity_not_in_transcript',
      detail: `proposed ${claimed}, transcript says ${grounded}`,
    };
  }
  // The accepted value is the TRANSCRIPT's, never the model's.
  return { status: 'accepted', intent: { kind: 'manual_weight', grams: grounded } };
}
