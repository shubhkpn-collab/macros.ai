import type {
  GuidanceEnvelope, GuidanceIntent, GuidanceOutcome,
} from './contracts.js';
import { renderTemplate } from './templates.js';

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
      text: renderTemplate(
        envelope.plannerStatus === 'energy_budget_exhausted'
          ? 'budget_exhausted' : 'no_suggestion', [], envelope),
      intent, candidates: [], nextAction: 'none',
      usedFallback: true, rejections: [], providerName: null,
    };
  }

  // The fallback uses the SAME closed templates as the provider path, so
  // offline guidance cannot say anything the online path could not.
  const shown = components.slice(0, 2);
  const text = renderTemplate(
    shown.length >= 2 ? 'two_options' : 'single_option', shown, envelope);

  // Without portion authority the only honest next step is the scale.
  const nextAction = envelope.weighingRequired ? 'await_weight' as const
    : 'await_choice' as const;

  return {
    text,
    intent,
    candidates: shown,
    nextAction,
    usedFallback: true,
    rejections: [],
    providerName: null,
  };
}
