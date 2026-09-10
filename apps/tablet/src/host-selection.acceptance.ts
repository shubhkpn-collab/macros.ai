import { developmentAuthHost } from './bootstrap.js';
import { createDevelopmentHost } from './development-host.js';
import type { TabletHost } from './bootstrap.js';
import {
  ACCEPTANCE_API_BASE_URL, ACCEPTANCE_BANNER, acceptanceBearerToken,
} from './acceptance-config.js';
import { createPremiumSpeechTransport } from './voice/premium-transport.js';

/**
 * REMOTE GUIDANCE ACCEPTANCE host selection.
 *
 * Metro aliases `host-selection` to this file when the acceptance scripts set
 * MACROS_GUIDANCE_ACCEPTANCE. That variable is read in metro.config.js — Node,
 * at build time — never in the React Native runtime, where a bundler-injected
 * global would be far less obvious.
 *
 * Still a DEVELOPMENT build: the banner stays and this is not the production
 * TabletHostFactory. There is no BLE, no production auth UI and no kiosk mode.
 */
export const HOST_SELECTION = 'remote_acceptance' as const;

export async function createSelectedHost(): Promise<TabletHost> {
  const host = await createDevelopmentHost({
    auth: developmentAuthHost(),
    // Reuses the EXISTING assistant selection; no second provider-mode concept.
    assistant: 'real',
    apiBaseUrl: ACCEPTANCE_API_BASE_URL,
    bearerToken: acceptanceBearerToken,
  });
  return {
    ...host,
    developmentNotice: ACCEPTANCE_BANNER,
    // Same URL and session as guidance; speech is not a reason to invent a
    // second networking configuration.
    premiumSpeech: createPremiumSpeechTransport({
      baseUrl: ACCEPTANCE_API_BASE_URL,
      bearerToken: acceptanceBearerToken,
      fetchImpl: fetch,
    }),
  };
}
