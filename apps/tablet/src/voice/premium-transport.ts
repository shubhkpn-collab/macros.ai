import { decodeAudioResponse, type PremiumOutcome, type PremiumSpeechTransport } from '@macros/tablet-voice';

/**
 * PREMIUM SPEECH TRANSPORT.
 *
 * Reuses the acceptance backend's URL and session credential — the tablet has
 * exactly one place it talks to MACROS, and speech is not a reason to invent a
 * second networking configuration.
 *
 * Every failure is a plain reason code. The vendor never appears, and neither
 * does any wording a user could see.
 */
export const PREMIUM_TRANSPORT_VERSION = 'premium-speech-transport@1.0.0';

export interface PremiumTransportOptions {
  readonly baseUrl: string;
  bearerToken(): Promise<string> | string;
  readonly fetchImpl: typeof fetch;
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 6_000;

export function createPremiumSpeechTransport(
  options: PremiumTransportOptions,
): PremiumSpeechTransport {
  return {
    async requestAudio(text: string): Promise<PremiumOutcome> {
      // Cancel rather than abandon: the appliance has already fallen back by
      // the time this fires, and a call left running is still billed.
      const controller = new AbortController();
      const timer = setTimeout(() => { controller.abort(); },
        options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

      try {
        const token = await options.bearerToken();
        const response = await options.fetchImpl(
          `${options.baseUrl.replace(/\/$/, '')}/voice/speak`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({ text }),
            signal: controller.signal,
          });

        if (response.status !== 200) return { ok: false, reason: 'http_error' };

        let parsed: unknown;
        try {
          parsed = await response.json();
        } catch {
          return { ok: false, reason: 'malformed' };
        }
        return decodeAudioResponse(parsed);
      } catch {
        return { ok: false, reason: 'timeout' };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
