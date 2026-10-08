import { createHash } from 'node:crypto';

export const KITCHEN_INSTRUCTIONS = `You are MACROS, a concise, warm kitchen nutrition assistant. Discuss only food, cooking, portions, nutrition, activity and energy balance. Redirect unrelated requests to kitchen nutrition. You are an AI voice, not a doctor. Before giving personalized numbers, call get_kitchen_state. Use only numbers returned by MACROS; do not invent nutrition facts, scale readings, wearable readings or food logs. Distinguish current energy balance from estimated end-of-day intake budget. Treat missing data as missing. Demo data is synthetic. Help decide the next meal using the remaining macros and validated suggestions. Never claim to log, change a goal, select a food or measure a portion: this preview has read-only tools. Ask the user to use the existing food controls for those actions. A requested 300 kcal deficit with an assumed total daily burn of 2500 kcal means a planned intake of 2200 kcal; this assumption is not a live wearable measurement. Do not recommend extreme restriction. Keep answers to two or three sentences. Start by saying you are an AI nutrition assistant and asking what the user is preparing.`;

export const KITCHEN_TOOLS = [{
  type: 'function', name: 'get_kitchen_state',
  description: 'Read the current MACROS screen, trusted energy and macro state, scale and validated suggestions. Read-only.',
  parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
}];

export function validOffer(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 32_768
    && value.startsWith('v=0') && /\r?\nm=audio /.test(value);
}

/** Server-only unified WebRTC handshake. No vendor credential reaches Android. */
export function createKitchenRealtimeProvider(apiKey: string, model = 'gpt-realtime-2.1', fetchImpl = fetch) {
  return {
    async connect(sdp: string, userId: string): Promise<{ sdp: string } | null> {
      if (!apiKey || !validOffer(sdp)) return null;
      const body = new FormData();
      body.set('sdp', sdp);
      body.set('session', JSON.stringify({
        type: 'realtime', model, instructions: KITCHEN_INSTRUCTIONS,
        output_modalities: ['audio'], tools: KITCHEN_TOOLS, tool_choice: 'auto',
        audio: {
          input: { transcription: { model: 'gpt-4o-mini-transcribe' },
            turn_detection: { type: 'server_vad', create_response: true, interrupt_response: true } },
          output: { voice: 'marin' },
        },
      }));
      try {
        const response = await fetchImpl('https://api.openai.com/v1/realtime/calls', {
          method: 'POST', body, signal: AbortSignal.timeout(20_000),
          headers: { Authorization: `Bearer ${apiKey}`,
            'OpenAI-Safety-Identifier': createHash('sha256').update(userId).digest('hex') },
        });
        if (!response.ok) return null;
        const answer = await response.text();
        return validOffer(answer) ? { sdp: answer } : null;
      } catch { return null; }
    },
  };
}
