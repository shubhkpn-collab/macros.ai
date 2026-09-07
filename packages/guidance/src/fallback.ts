import type {
  GuidanceEnvelope, GuidanceIntent, GuidanceOutcome,
} from './contracts.js';
import { renderGuidanceText } from './validator.js';

/**
 * DETERMINISTIC FALLBACK.
 *
 * A kitchen appliance must not become useless when the cloud is unreachable,
 * the provider times out, or its output fails validation. This produces plain,
 * correct guidance from the trusted planner alone — no model, no network, no
 * invented numbers.
 *
 * It is deliberately terse. Terse and right beats fluent and wrong.
 */
export const FALLBACK_VERSION = 'guidance-fallback@1.0.0';

export function deterministicGuidance(
  envelope: GuidanceEnvelope,
  intent: GuidanceIntent = 'what_should_i_eat',
): GuidanceOutcome {
  const components = envelope.planComponents;

  if (envelope.plannerStatus !== 'available' || components.length === 0) {
    // The planner's honest refusal is passed through unchanged.
    return {
      text: envelope.plannerStatus === 'energy_budget_exhausted'
        ? "You're at your energy target for today."
        : "I don't have a good suggestion right now.",
      intent, candidates: [], nextAction: 'none',
      usedFallback: true, rejections: [], providerName: null,
    };
  }

  const names = components.map((c) => `{candidate:${c.productVersionId}}`);
  const text = names.length === 1
    ? `${names[0]} fits your current needs best.`
    : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]} are good options.`;

  // Without portion authority the only honest next step is the scale.
  const nextAction = envelope.weighingRequired ? 'await_weight' as const
    : 'await_choice' as const;

  return {
    text: renderGuidanceText(text, envelope),
    intent,
    candidates: components,
    nextAction,
    usedFallback: true,
    rejections: [],
    providerName: null,
  };
}
