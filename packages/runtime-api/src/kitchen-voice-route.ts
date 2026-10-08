import { appError } from '@macros/runtime-config';
import { validOffer } from '../../voice-openai/src/realtime.js';
import type { Route } from './server.js';

/** Production host supplies its authenticated provider; local preview is separate. */
export function kitchenVoiceRoute(provider: {
  connect(sdp: string, userId: string): Promise<{sdp: string} | null>;
} | null): Route {
  return {
    method: 'POST', path: '/voice/conversation',
    handler: async ctx => {
      if (ctx.subject === undefined) return appError('authentication', 'missing_credential', 'Not signed in.');
      if (Object.keys(ctx.body).some(key => key !== 'sdp') || !validOffer(ctx.body['sdp'])) {
        return appError('validation', 'invalid_audio_offer', 'Invalid audio offer.');
      }
      const result = await provider?.connect(ctx.body['sdp'], ctx.userId);
      return result ?? appError('dependency_unavailable', 'voice_unavailable', 'Kitchen voice is unavailable.');
    },
  };
}
