import type { GuidanceProviderResult } from '@macros/guidance';

/**
 * WIRE DECODER for the model's tool input.
 *
 * Establishes STRUCTURE only: that the decision is shaped like a decision.
 * Whether it is SAFE — candidate offered, slot known, template arity correct —
 * remains the INT-5B validator's job on the tablet. Moving semantic safety here
 * would create a second authority that could drift from the first.
 *
 * Returning `null` rather than throwing keeps the caller's failure handling in
 * one place.
 */
export const TOOL_DECODER_VERSION = 'anthropic-tool-decoder@1.0.0';

const INTENTS = new Set([
  'what_should_i_eat', 'request_alternative', 'choose_candidate',
  'prefer_quick', 'prefer_meal', 'decline', 'clarification_needed',
]);
const TEMPLATES = new Set([
  'single_option', 'two_options', 'option_with_objective',
  'confirm_choice_await_weight', 'ask_quick_or_meal', 'offer_alternative',
  'need_clarification', 'budget_exhausted', 'no_suggestion', 'declined',
]);
const ACTIONS = new Set(['await_choice', 'await_weight', 'await_clarification', 'none']);
const TONES = new Set(['neutral', 'brief', 'encouraging']);

const ALLOWED = new Set([
  'intent', 'templateId', 'selectedProductVersionIds', 'slotRefs',
  'objectiveIndex', 'tone', 'clarificationNeeded', 'suggestedNextAction',
  'alternativeProductVersionIds',
]);

export const TOOL_BOUNDS = {
  maxSelected: 3,
  maxAlternatives: 4,
  maxSlotRefs: 6,
  maxIdLength: 128,
  maxObjectiveIndex: 5,
} as const;

const boundedIdArray = (v: unknown, max: number): boolean =>
  Array.isArray(v) && v.length <= max
  && v.every((x) => typeof x === 'string' && x.length > 0
    && x.length <= TOOL_BOUNDS.maxIdLength);

export function decodeToolInput(raw: unknown): GuidanceProviderResult | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;

  // Unknown fields are refused, not ignored: a field we do not understand is a
  // field we cannot reason about.
  for (const key of Object.keys(o)) if (!ALLOWED.has(key)) return null;

  // --- required -----------------------------------------------------------
  if (typeof o['intent'] !== 'string' || !INTENTS.has(o['intent'])) return null;
  if (typeof o['templateId'] !== 'string' || !TEMPLATES.has(o['templateId'])) return null;
  if (typeof o['suggestedNextAction'] !== 'string'
      || !ACTIONS.has(o['suggestedNextAction'])) return null;
  if (typeof o['clarificationNeeded'] !== 'boolean') return null;
  if (!boundedIdArray(o['selectedProductVersionIds'], TOOL_BOUNDS.maxSelected)) return null;

  // --- optional -----------------------------------------------------------
  if (o['alternativeProductVersionIds'] !== undefined
      && !boundedIdArray(o['alternativeProductVersionIds'], TOOL_BOUNDS.maxAlternatives)) {
    return null;
  }
  if (o['slotRefs'] !== undefined
      && !boundedIdArray(o['slotRefs'], TOOL_BOUNDS.maxSlotRefs)) return null;

  const objectiveIndex = o['objectiveIndex'];
  if (objectiveIndex !== undefined) {
    if (typeof objectiveIndex !== 'number' || !Number.isInteger(objectiveIndex)
        || objectiveIndex < 0 || objectiveIndex > TOOL_BOUNDS.maxObjectiveIndex) {
      return null;
    }
  }

  const tone = o['tone'];
  if (tone !== undefined && (typeof tone !== 'string' || !TONES.has(tone))) return null;

  // Every field has now been proven, so this is a narrowing rather than a cast
  // that asserts something unverified.
  return {
    intent: o['intent'] as GuidanceProviderResult['intent'],
    templateId: o['templateId'] as GuidanceProviderResult['templateId'],
    selectedProductVersionIds: o['selectedProductVersionIds'] as readonly string[],
    clarificationNeeded: o['clarificationNeeded'],
    suggestedNextAction:
      o['suggestedNextAction'] as GuidanceProviderResult['suggestedNextAction'],
    ...(o['slotRefs'] !== undefined ? { slotRefs: o['slotRefs'] as readonly string[] } : {}),
    ...(objectiveIndex !== undefined ? { objectiveIndex } : {}),
    ...(tone !== undefined ? { tone: tone as NonNullable<GuidanceProviderResult['tone']> } : {}),
    ...(o['alternativeProductVersionIds'] !== undefined
      ? { alternativeProductVersionIds: o['alternativeProductVersionIds'] as readonly string[] }
      : {}),
  };
}
