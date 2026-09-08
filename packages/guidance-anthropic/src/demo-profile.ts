import type { GuidanceProviderSettings } from './composition.js';

/**
 * INVESTOR DEMO PROVIDER PROFILE.
 *
 * Conservative on purpose. The model only ever picks a template id and a few
 * candidate references — it never writes prose — so the useful output is tiny
 * and a generous token ceiling would buy nothing but exposure to a runaway
 * bill during a live demonstration.
 *
 * A short timeout matters for the same reason it does in the kitchen: the
 * appliance falls back deterministically rather than leaving someone waiting,
 * and an abandoned call is still a billed call if it is not cancelled.
 */
export const DEMO_PROFILE_VERSION = 'guidance-demo-profile@1.0.0';

/** Enough for one structured tool call and nothing more. */
export const DEMO_MAX_TOKENS = 256;
export const DEMO_TIMEOUT_MS = 5_000;

/**
 * Build demo settings from a key and model supplied at the server edge.
 *
 * Neither value is read from the environment here: a component that fetches
 * its own secrets can be constructed accidentally, including by a test.
 */
export function demoProviderSettings(
  apiKey: string,
  model: string,
): GuidanceProviderSettings {
  return {
    apiKey,
    model,
    maxTokens: DEMO_MAX_TOKENS,
    timeoutMs: DEMO_TIMEOUT_MS,
  };
}
