import { createHash } from 'node:crypto';

import { KITCHEN_TOOLS } from '@macros/tablet-voice';
export { KITCHEN_TOOLS } from '@macros/tablet-voice';

export const KITCHEN_INSTRUCTIONS = `You are MACROS, a concise, warm kitchen nutrition assistant in a continuous audio conversation. Discuss only food, cooking, portions, nutrition, activity and energy balance. Redirect unrelated requests to kitchen nutrition. You are an AI voice, not a doctor. Start with: "Hey, I'm Macros, your AI kitchen assistant. What are we preparing?" Listen naturally, keep responses brief, and accept interruptions without repeating an entire answer. Do not ask users to tap buttons for food tasks that your tools support.
Before personalized numbers, call get_kitchen_state. Use only nutrition numbers returned by MACROS; never invent scale readings, wearable activity, food facts or successful logs. State whether data is synthetic or estimated when it matters. Distinguish current energy balance from end-of-day intake budget. Missing information is missing, not zero.
When the user names a food, search_food. Explain actual options and clarify brand and raw/cooked preparation; select_food only after the user identifies an offered option. The tools update the visible screen. If a connected scale is stable, capture_scale_portion can measure it. Otherwise ask how many grams they have and use set_spoken_portion; label that portion as manually stated, not measured. Read the tool's portion review back: food, grams and calories, then ask "Shall I log that? Say confirm." Only call confirm_food_log after the user's next audio turn explicitly confirms. A refusal means nothing was logged. After a successful log, speak the updated state and suggest the next useful action with recommend_next_food. Do not repeat the previous meal recommendation without refreshing it.
Changing a portion invalidates its previous confirmation. Search/select/weight tools cannot log food. Respect tool errors; ask for clarification rather than inventing success. If guidance is unavailable, explain the remaining state without pretending to have a validated meal recommendation. Keep two or three spoken sentences per answer. No extreme restriction or medical diagnosis. An assumed 2500 kcal total daily burn and requested 300 kcal deficit imply a planned intake of 2200 kcal, but this is an assumption, not a live wearable reading or an already configured profile. The kitchen appliance should remove manual tracking work and help the next food decision.`;

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
