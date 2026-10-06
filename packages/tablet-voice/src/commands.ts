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
  | { readonly kind: 'search_food'; readonly query: string }
  | { readonly kind: 'manual_weight'; readonly grams: number }
  | { readonly kind: 'use_weight' }
  | { readonly kind: 'change_weight' }
  | { readonly kind: 'log' }
  | { readonly kind: 'cancel' }
  | { readonly kind: 'unrecognized' };

const normalize = (text: string): string =>
  text.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * The product wake phrase.
 *
 * Stripped here, before intent parsing, so nothing downstream has to know the
 * product is called anything. "Hey Macros, what should I eat?" and "what should
 * I eat?" must reach the router as the same request — and later, when a real
 * always-listening engine replaces the tap, the phrase will already be handled
 * in one place.
 */
const WAKE_PHRASE = /^(hey|hi|ok|okay)?\s*macros\b[\s,]*/;

export function stripWakePhrase(text: string): string {
  return text.replace(WAKE_PHRASE, '').trim();
}

/** True when a transcript opens with the wake phrase, for the orb acknowledgement. */
export function containsWakePhrase(text: string): boolean {
  return WAKE_PHRASE.test(normalize(text));
}

/** Ordinal words the demo needs. Deliberately short — this is not a parser. */
const ORDINALS: ReadonlyArray<readonly [RegExp, number]> = [
  [/^(?:choose |select |pick )?(?:option |number |the )?(one|1|a|first)(?: one)?$/, 0],
  [/^(?:choose |select |pick )?(?:option |number |the )?(two|2|b|second)(?: one)?$/, 1],
  [/^(?:choose |select |pick )?(?:option |number |the )?(three|3|c|third)(?: one)?$/, 2],
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
  // Addressing the appliance is not part of the request.
  const text = stripWakePhrase(normalize(transcript));
  if (text.length === 0) return { kind: 'unrecognized' };

  // Cancellation is checked FIRST so it can always interrupt, whatever else the
  // phrase happens to contain.
  if (/\b(cancel|never mind|nevermind|stop|forget it)\b/.test(text)) {
    return { kind: 'cancel' };
  }

  const search = /^(?:search(?: for)?|find|add)(?: food)? (.+)$/.exec(text);
  if (search?.[1] !== undefined) return { kind: 'search_food', query: search[1] };

  // Preserve the decimal point in a dictated weight; a unit is mandatory.
  const weightText = stripWakePhrase(transcript.toLowerCase().replace(/[!,?]/g, '').trim());
  const weight = /^(?:(?:weight(?: is)?|it weighs|use|enter) )?(\d+(?:\.\d+)?) (?:g|grams?)\.?$/.exec(weightText);
  if (weight?.[1] !== undefined) {
    const grams = Number(weight[1]);
    if (Number.isFinite(grams) && grams > 0) return { kind: 'manual_weight', grams };
  }
  // Numeric or unit-bearing phrases must never accidentally select an ordinal.
  if (/\b(?:grams?|kilograms?|kg|g|weight|weighs)\b/.test(text)) {
    if (/^(?:use|capture)(?: the)? (?:scale|current|stable) weight$/.test(text)) return { kind: 'use_weight' };
    if (/^(?:change|edit)(?: the)? weight$/.test(text)) return { kind: 'change_weight' };
    return { kind: 'unrecognized' };
  }

  if (/^(?:please )?(log it|log that|log this|save it|confirm)(?: please)?$/.test(text)) {
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
