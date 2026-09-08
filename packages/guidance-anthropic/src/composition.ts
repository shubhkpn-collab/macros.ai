import type { GuidanceProvider } from '@macros/guidance';
import { AnthropicGuidanceProvider } from './index.js';
import { createAnthropicFetchTransport, type ServerFetchLike } from './fetch-transport.js';

/**
 * SERVER GUIDANCE COMPOSITION — the only place secrets appear.
 *
 * `providerSettings` is deliberately a SEPARATE argument from runtime config.
 * RuntimeConfig is serialized into health and version output and logged; a key
 * that lives there escapes eventually, however carefully it is handled.
 */
export const SERVER_GUIDANCE_COMPOSITION_VERSION = 'server-guidance-composition@1.0.0';

export interface ServerGuidanceConfig {
  readonly assistant: 'synthetic' | 'real';
}

/** Never serialized, never logged, never part of RuntimeConfig. */
export interface GuidanceProviderSettings {
  readonly apiKey: string;
  readonly model: string;
  readonly timeoutMs?: number;
  readonly baseUrl?: string;
  /** Bounded on the demo path so a runaway response cannot become a bill. */
  readonly maxTokens?: number;
}

export interface ServerGuidanceCompositionOptions {
  readonly config: ServerGuidanceConfig;
  readonly providerSettings?: GuidanceProviderSettings;
  readonly fetchImpl: ServerFetchLike;
}

/**
 * Build the server-side provider, or none.
 *
 * Returns null for `synthetic`, so the route refuses guidance rather than
 * inventing it. `real` without a key or model FAILS CLOSED at composition:
 * discovering a missing credential at startup is cheap, discovering it when a
 * person asks what to eat is not.
 */
export function createServerGuidanceProvider(
  options: ServerGuidanceCompositionOptions,
): GuidanceProvider | null {
  if (options.config.assistant === 'synthetic') return null;

  const settings = options.providerSettings;
  if (settings === undefined
      || settings.apiKey.length === 0 || settings.model.length === 0) {
    throw new Error('guidance_composition_missing_provider_settings');
  }

  return new AnthropicGuidanceProvider({
    apiKey: settings.apiKey,
    model: settings.model,
    transport: createAnthropicFetchTransport(options.fetchImpl),
    ...(settings.timeoutMs !== undefined ? { timeoutMs: settings.timeoutMs } : {}),
    ...(settings.baseUrl !== undefined ? { baseUrl: settings.baseUrl } : {}),
    ...(settings.maxTokens !== undefined ? { maxTokens: settings.maxTokens } : {}),
  });
}
