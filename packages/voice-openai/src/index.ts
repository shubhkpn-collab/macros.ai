/**
 * SERVER-SIDE PREMIUM SPEECH.
 *
 * Vendor code lives here and nowhere else — not on the tablet, not in guidance,
 * not in nutrition. The appliance asks MACROS to speak a sentence; it never
 * learns which vendor produced the audio, and it never holds the credential.
 *
 * Speech is a PRESENTATION concern. Nothing here reads or produces nutrition,
 * food identity or quantities: it turns trusted text that MACROS already
 * rendered into sound.
 */
export const OPENAI_SPEECH_VERSION = 'openai-speech@1.0.0';

export const DEFAULT_TTS_MODEL = 'gpt-4o-mini-tts';
/**
 * A male-sounding, composed voice. The product target is calm and premium; the
 * exact ChatGPT voice is not being claimed and is never named in this codebase.
 */
export const DEFAULT_TTS_VOICE = 'onyx';

/** Demo bound. MACROS sentences are short, and a long one is a long bill. */
export const MAX_SPEECH_CHARACTERS = 600;
export const SPEECH_TIMEOUT_MS = 5_000;

export const VOICE_INSTRUCTIONS =
  'Male-sounding voice. Composed, direct and confident. Calm premium '
  + 'personal-assistant delivery. Slightly deep tone, natural conversational '
  + 'pacing, crisp pronunciation and restrained emotion. Warm but never '
  + 'theatrical, overly enthusiastic or sales-like. Use short natural pauses '
  + 'and speak concisely.';

export interface SpeechFetchLike {
  (input: string, init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
  }): Promise<{
    status: number;
    arrayBuffer(): Promise<ArrayBuffer>;
    text(): Promise<string>;
  }>;
}

export interface OpenAiSpeechSettings {
  /** Supplied at the server composition edge. Never read from env in here. */
  readonly apiKey: string;
  readonly model?: string;
  readonly voice?: string;
  readonly timeoutMs?: number;
  readonly baseUrl?: string;
}

export type SpeechResult =
  | { readonly ok: true; readonly mimeType: 'audio/mpeg'; readonly audioBase64: string }
  | { readonly ok: false; readonly reason: 'unavailable' | 'provider_error' | 'invalid_text' };

export interface SpeechProvider {
  synthesize(text: string): Promise<SpeechResult>;
}

/**
 * Build the provider, or none.
 *
 * Returning null when no key is configured is deliberate: the route then
 * answers 'unavailable' immediately and the tablet falls back to native speech
 * WITHOUT a network round trip. Native speech must never depend on the cloud.
 */
export function createOpenAiSpeechProvider(
  settings: OpenAiSpeechSettings | null,
  fetchImpl: SpeechFetchLike,
): SpeechProvider | null {
  if (settings === null || settings.apiKey.length === 0) return null;

  const model = settings.model ?? DEFAULT_TTS_MODEL;
  const voice = settings.voice ?? DEFAULT_TTS_VOICE;
  const baseUrl = (settings.baseUrl ?? 'https://api.openai.com').replace(/\/$/, '');

  return {
    async synthesize(text: string): Promise<SpeechResult> {
      const trimmed = text.trim();
      if (trimmed.length === 0 || trimmed.length > MAX_SPEECH_CHARACTERS) {
        return { ok: false, reason: 'invalid_text' };
      }

      /**
       * The timeout must CANCEL the request. Abandoning a paid call while it
       * continues is a bill for audio nobody hears — and the appliance has
       * already fallen back by then.
       */
      const controller = new AbortController();
      const timer = setTimeout(() => { controller.abort(); },
        settings.timeoutMs ?? SPEECH_TIMEOUT_MS);

      try {
        const response = await fetchImpl(`${baseUrl}/v1/audio/speech`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${settings.apiKey}`,
          },
          body: JSON.stringify({
            model,
            voice,
            input: trimmed,
            instructions: VOICE_INSTRUCTIONS,
            response_format: 'mp3',
          }),
          signal: controller.signal,
        });

        // One attempt. A retry doubles the cost of a failure nobody heard.
        if (response.status !== 200) return { ok: false, reason: 'provider_error' };

        const buffer = await response.arrayBuffer();
        if (buffer.byteLength === 0) return { ok: false, reason: 'provider_error' };

        return {
          ok: true,
          mimeType: 'audio/mpeg',
          audioBase64: Buffer.from(buffer).toString('base64'),
        };
      } catch {
        // Includes the abort. The vendor's message never leaves this function.
        return { ok: false, reason: 'provider_error' };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
