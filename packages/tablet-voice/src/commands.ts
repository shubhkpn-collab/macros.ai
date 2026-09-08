/**
 * SPOKEN COMMAND INTERPRETATION.
 *
 * Pure and deterministic: a transcript in, an application intent out. It holds
 * no nutrition, search or recommendation authority — speech is INPUT ONLY, and
 * every command below maps onto an intent the touch flow already exposes.
 *
 * Kept separate from the native bridge so it can be tested exhaustively without
 * a device, which is where the real risk lives: a misheard phrase must never
 * silently become a different action.
 */
export const VOICE_COMMANDS_VERSION = 'voice-commands@1.0.0';

export type VoiceIntent =
  | { readonly kind: 'request_guidance' }
  | { readonly kind: 'choose_option'; readonly index: number }
  | { readonly kind: 'log' }
  | { readonly kind: 'cancel' }
  | { readonly kind: 'unrecognized' };

const normalize = (text: string): string =>
  text.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

/** Ordinal words the demo needs. Deliberately short — this is not a parser. */
const ORDINALS: ReadonlyArray<readonly [RegExp, number]> = [
  [/\b(option|number|the)?\s*(one|1|a|first)\b/, 0],
  [/\b(option|number|the)?\s*(two|2|b|second)\b/, 1],
  [/\b(option|number|the)?\s*(three|3|c|third)\b/, 2],
];

/**
 * Interpret a final transcript.
 *
 * `candidateCount` bounds selection to what is ACTUALLY on screen: "option two"
 * with one recommendation is not a choice, it is a misunderstanding, and
 * guessing would select a food the person never heard offered.
 */
export function interpretVoiceCommand(
  transcript: string,
  candidateCount: number,
): VoiceIntent {
  const text = normalize(transcript);
  if (text.length === 0) return { kind: 'unrecognized' };

  // Cancellation is checked FIRST so it can always interrupt, whatever else the
  // phrase happens to contain.
  if (/\b(cancel|never mind|nevermind|stop|forget it)\b/.test(text)) {
    return { kind: 'cancel' };
  }

  if (/\b(log it|log that|log this|save it|confirm)\b/.test(text)) {
    return { kind: 'log' };
  }

  /**
   * Guidance. Matched on the QUESTION, not on a wake word: "hey macros" is
   * stripped as an address, so the phrase works with or without it.
   */
  if (/\b(what should i eat|what do i eat|what can i eat|recommend|suggestion|hungry)\b/
    .test(text)) {
    return { kind: 'request_guidance' };
  }

  if (candidateCount > 0) {
    for (const [pattern, index] of ORDINALS) {
      if (pattern.test(text) && index < candidateCount) {
        return { kind: 'choose_option', index };
      }
    }
  }

  // Unrecognized is a real outcome, not a failure to try harder. Acting on a
  // half-understood phrase is worse than asking again.
  return { kind: 'unrecognized' };
}
