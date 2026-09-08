import { FakeGuidanceProvider, type GuidanceProvider } from '@macros/guidance';
import { RemoteGuidanceProvider } from './index.js';
import { createFetchTransport, type FetchLike } from './fetch-transport.js';

/**
 * TABLET GUIDANCE COMPOSITION.
 *
 * Activation is configuration, not code. The existing `assistant` selection
 * decides which provider exists, so a future production host supplies runtime
 * config, a session credential supplier and a fetch — and never learns that a
 * vendor exists.
 */
export const TABLET_GUIDANCE_COMPOSITION_VERSION = 'tablet-guidance-composition@1.0.0';

export interface TabletGuidanceConfig {
  /** Reuses the existing runtime selection. No second provider-mode flag. */
  readonly assistant: 'synthetic' | 'real';
  /** Required only when assistant is 'real'. */
  readonly apiBaseUrl?: string;
}

export interface TabletGuidanceCompositionOptions {
  readonly config: TabletGuidanceConfig;
  /** The MEMBER's session credential. Never a vendor secret. */
  bearerToken(): Promise<string> | string;
  readonly fetchImpl: FetchLike;
  readonly timeoutMs?: number;
}

/**
 * Choose the tablet's guidance provider.
 *
 * Fails closed: `real` without a backend URL is a configuration error, not a
 * silent downgrade — an appliance quietly running on fixtures while its owner
 * believes it is live is worse than one that refuses to start.
 */
export function createTabletGuidanceProvider(
  options: TabletGuidanceCompositionOptions,
): GuidanceProvider {
  if (options.config.assistant === 'synthetic') {
    return new FakeGuidanceProvider();
  }

  const baseUrl = options.config.apiBaseUrl;
  if (baseUrl === undefined || baseUrl.length === 0) {
    throw new Error('guidance_composition_missing_api_base_url');
  }

  return new RemoteGuidanceProvider({
    baseUrl,
    bearerToken: options.bearerToken,
    transport: createFetchTransport(options.fetchImpl),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  });
}
