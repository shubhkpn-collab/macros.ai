import { appError, type AppError } from '@macros/runtime-config';
import {
  MAX_SPEECH_CHARACTERS, type SpeechProvider,
} from '@macros/voice-openai';
import type { RequestContext, Route } from './server.js';

/**
 * AUTHENTICATED SPEECH ROUTE.
 *
 * The appliance sends trusted text that MACROS already rendered and gets audio
 * back. It never sees a vendor, a model name or a credential.
 *
 * Audio is returned base64 in JSON because MACROS sentences are short and that
 * avoids adding a streaming audio dependency to the tablet for a few seconds of
 * speech.
 */
export const VOICE_ROUTE_VERSION = 'voice-route@1.0.0';

export interface DecodedSpeechRequest {
  readonly kind: 'decoded_speech_request';
  readonly text: string;
}

const REQUEST_KEYS = new Set(['text']);

/**
 * Decode network JSON.
 *
 * Bounded and closed: this endpoint speaks MACROS' own sentences back, and must
 * not become a general text-to-speech service for arbitrary callers.
 */
export function decodeSpeechRequest(
  body: Record<string, unknown>,
): DecodedSpeechRequest | AppError {
  const invalid = (why: string): AppError =>
    appError('validation', 'invalid_speech_request', why);

  if (Object.keys(body).some((k) => !REQUEST_KEYS.has(k))) {
    return invalid('Unexpected fields in the request.');
  }
  const text = body['text'];
  if (typeof text !== 'string') return invalid('Text is required.');

  const trimmed = text.trim();
  if (trimmed.length === 0) return invalid('Text is required.');
  if (trimmed.length > MAX_SPEECH_CHARACTERS) return invalid('Text is too long.');

  return { kind: 'decoded_speech_request', text: trimmed };
}

export interface VoiceRouteDeps {
  /** Null when no key is configured; the route then answers unavailable. */
  readonly provider: SpeechProvider | null;
}

export function voiceRoute(deps: VoiceRouteDeps): Route {
  return {
    method: 'POST',
    path: '/voice/speak',
    decode: (body) => decodeSpeechRequest(body),
    handler: async (ctx: RequestContext) => {
      if (ctx.subject === undefined) {
        return appError('authentication', 'missing_credential', 'Not signed in.');
      }
      const decoded = (ctx.body as {
        decoded?: DecodedSpeechRequest | AppError;
      }).decoded;
      if (decoded === undefined) {
        return appError('validation', 'missing_speech_request', 'Text is required.');
      }
      if (decoded.kind !== 'decoded_speech_request') return decoded;

      if (deps.provider === null) {
        // A clean, structured unavailable. The tablet falls back to native
        // speech; it must never be left silent because a key is missing.
        return appError('dependency_unavailable', 'speech_unavailable',
          'Speech is not available.');
      }

      const result = await deps.provider.synthesize(decoded.text);
      if (!result.ok) {
        // The vendor's own message never crosses this boundary.
        return appError('dependency_unavailable', 'speech_unavailable',
          'Speech is not available.');
      }
      return { mimeType: result.mimeType, audioBase64: result.audioBase64 };
    },
  };
}

/** Explicit server-edge registration, matching the guidance route. */
export function registerVoiceRoute(
  api: { route(route: Route): unknown },
  deps: VoiceRouteDeps,
): void {
  api.route(voiceRoute(deps));
}
