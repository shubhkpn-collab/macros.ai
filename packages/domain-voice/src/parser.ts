import { SCALE_RANGE_G } from '@macros/contracts';
import type {
  NutrientQuery,
  ParseResult,
  VoiceIntent,
  VoiceUtterance,
} from './intents.js';

export const VOICE_PARSER_VERSION = 'voice-parser@1.0.0-deterministic';

/**
 * DETERMINISTIC VOICE PARSER.
 *
 * PURE: no clock, no randomness, no repository, no network, no LLM. Given the
 * same transcript it always yields the same result.
 *
 * This is deliberately a grammar, not a language model. Its job is to prove the
 * orchestration contract; a richer NLU can replace it behind `VoiceParser`
 * without any domain or application contract changing.
 */
export interface VoiceParser {
  readonly version: string;
  parse(utterance: VoiceUtterance): ParseResult;
}

/** Normalize only what parsing needs. The original transcript is always kept. */
export function normalizeTranscript(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[,!?;:"']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const OPTION_WORDS: Readonly<Record<string, string>> = {
  a: 'A', b: 'B', c: 'C', d: 'D',
  one: 'A', first: 'A',
  two: 'B', second: 'B',
  three: 'C', third: 'C',
  four: 'D', fourth: 'D',
};

const CANCEL = ['cancel', 'never mind', 'nevermind', 'start over', 'forget it', 'stop'];
const CONFIRM = ['log it', 'add it', 'confirm', 'save it', 'log that', 'yes log it'];
const WEIGH = ['weigh it', 'use the scale', 'capture the weight', 'take the weight', 'weigh this', 'read the scale'];
const HELP = ['what can i say', 'help', 'what are my options'];
/**
 * Recommendation requests. Matched BEFORE the generic question handler, since
 * "what should I eat" is a question but not a dashboard query.
 */
const RECOMMEND = [
  'what should i eat', 'what can i eat', 'what should i have',
  'what do you recommend', 'recommend something', 'give me a suggestion',
  'suggest something', 'what to eat',
];
const REPEAT = ['repeat the options', 'repeat options', 'say the options', 'what were the options'];

const SEARCH_PREFIXES = [
  'i want to log', 'i want to add', 'i am having', "i'm having", 'i am eating', "i'm eating",
  'log some', 'add some', 'find me', 'search for', 'look up', 'find', 'add', 'log', 'search',
];

/** Grams only. No density assumptions, no invented unit conversions. */
const GRAM_UNITS = ['grams', 'gram', 'g'];
const UNSUPPORTED_UNITS = ['ounces', 'ounce', 'oz', 'pounds', 'pound', 'lb', 'lbs', 'cups', 'cup', 'tablespoons', 'tbsp', 'teaspoons', 'tsp', 'ml', 'millilitres', 'milliliters'];

const NUTRIENTS: Readonly<Record<string, NutrientQuery>> = {
  calories: 'calories', calorie: 'calories', kcal: 'calories', energy: 'calories',
  protein: 'protein',
  carbs: 'carbohydrate', carbohydrate: 'carbohydrate', carbohydrates: 'carbohydrate',
  fat: 'fat', fats: 'fat',
};

const containsAny = (text: string, phrases: readonly string[]): boolean =>
  phrases.some((p) => text === p || text.startsWith(`${p} `) || text.includes(` ${p}`));

/** "maybe a or b", "option a or b" — two candidates named, so choose neither. */
function isAmbiguousOption(text: string): boolean {
  const letters = [...text.matchAll(/\boption ([a-d])\b/g)].map((m) => m[1]);
  if (letters.length > 1) return true;
  return /\b(?:option )?[a-d] or (?:option )?[a-d]\b/.test(text);
}

function parseOption(text: string): string | null {
  const explicit = /\b(?:option|choose|select|pick|number)\s+([a-d]|one|two|three|four|first|second|third|fourth)\b/.exec(text);
  if (explicit?.[1] !== undefined) return OPTION_WORDS[explicit[1]] ?? null;
  const bare = /^(?:the\s+)?([a-d]|first|second|third|fourth)(?:\s+one)?$/.exec(text);
  if (bare?.[1] !== undefined) return OPTION_WORDS[bare[1]] ?? null;
  return null;
}

export class DeterministicVoiceParser implements VoiceParser {
  readonly version = VOICE_PARSER_VERSION;

  parse(utterance: VoiceUtterance): ParseResult {
    const transcript = utterance.transcript;
    const text = normalizeTranscript(transcript);

    if (text.length === 0) {
      return { status: 'invalid', reason: 'empty_transcript', transcript };
    }

    // Ambiguity is checked BEFORE any selection, so "A or B" can never resolve.
    if (isAmbiguousOption(text)) {
      return { status: 'needs_clarification', reason: 'ambiguous_option', transcript };
    }

    if (containsAny(text, CANCEL)) return understood({ kind: 'cancel' }, transcript);
    if (containsAny(text, REPEAT)) return understood({ kind: 'repeat_options' }, transcript);
    if (containsAny(text, RECOMMEND)) return understood({ kind: 'recommend_food' }, transcript);
    if (containsAny(text, HELP)) return understood({ kind: 'help' }, transcript);
    if (containsAny(text, CONFIRM)) return understood({ kind: 'confirm_log' }, transcript);
    if (containsAny(text, WEIGH)) return understood({ kind: 'request_stable_weight' }, transcript);

    // "200 calories of oats" — a reverse quantity target. MVP-1 has no such
    // feature, and inventing a portion to hit a calorie number would be the
    // voice layer originating nutrition. Clarify instead.
    if (/\b\d+(?:\.\d+)?\s*(?:calories|kcal|cals)\b/.test(text)) {
      return { status: 'needs_clarification', reason: 'quantity_target_unsupported', transcript };
    }

    const weight = this.parseWeight(text, transcript);
    if (weight !== null) return weight;

    const option = parseOption(text);
    if (option !== null) return understood({ kind: 'select_option', optionLabel: option }, transcript);

    const question = this.parseQuestion(text, transcript);
    if (question !== null) return question;

    const search = this.parseSearch(text, transcript);
    if (search !== null) return search;

    return { status: 'unsupported', transcript };
  }

  private parseWeight(text: string, transcript: string): ParseResult | null {
    // NOTE: the sign is matched OUTSIDE \b. A word boundary cannot anchor before
    // '-', so `\b-?\d+` silently drops the minus and turns -50 into 50.
    const unsupported = new RegExp(`(-?\\b\\d+(?:\\.\\d+)?)\\s*(${UNSUPPORTED_UNITS.join('|')})\\b`).exec(text);
    if (unsupported !== null) {
      // No density table and no verified conversion, so refuse rather than guess.
      return { status: 'invalid', reason: 'unsupported_unit', transcript };
    }

    // Spoken negation. STT writes "minus fifty" as words, not as a '-' glyph,
    // so a sign check on punctuation alone would read it as POSITIVE fifty.
    const spokenNegation = new RegExp(
      `\\b(?:minus|negative)\\s+\\d+(?:\\.\\d+)?\\s*(?:${GRAM_UNITS.join('|')})\\b`,
    ).test(text);

    const match = new RegExp(`(-?\\b\\d+(?:\\.\\d+)?)\\s*(${GRAM_UNITS.join('|')})\\b`).exec(text);
    if (match?.[1] === undefined) return null;

    const grams = spokenNegation ? -Math.abs(Number(match[1])) : Number(match[1]);
    if (!Number.isFinite(grams)) return { status: 'invalid', reason: 'weight_not_finite', transcript };
    if (grams <= 0) return { status: 'invalid', reason: 'weight_not_positive', transcript };
    if (grams > SCALE_RANGE_G.max) {
      return { status: 'invalid', reason: 'weight_out_of_range', transcript };
    }
    return understood({ kind: 'manual_weight', grams }, transcript);
  }

  private parseQuestion(text: string, transcript: string): ParseResult | null {
    const isQuestion = /\b(how many|how much|what are|what's|whats|do i have)\b/.test(text);
    if (!isQuestion) return null;

    if (/\bmacros\b/.test(text)) return understood({ kind: 'ask_macros' }, transcript);

    const nutrientWord = Object.keys(NUTRIENTS).find((n) => new RegExp(`\\b${n}\\b`).test(text));
    if (nutrientWord === undefined) return null;
    const nutrient = NUTRIENTS[nutrientWord]!;

    const remaining = /\b(left|remaining|have left|to go|still)\b/.test(text);
    return understood(
      remaining ? { kind: 'ask_remaining', nutrient } : { kind: 'ask_consumed', nutrient },
      transcript,
    );
  }

  private parseSearch(text: string, transcript: string): ParseResult | null {
    for (const prefix of SEARCH_PREFIXES) {
      if (!text.startsWith(`${prefix} `)) continue;
      const query = text.slice(prefix.length).trim().replace(/^(some|a|an|the)\s+/, '').trim();
      if (query.length === 0) {
        return { status: 'needs_clarification', reason: 'no_food_named', transcript };
      }
      // "log something" / "log it" style vagueness must not invent a food.
      if (['something', 'anything', 'food', 'a meal', 'stuff'].includes(query)) {
        return { status: 'needs_clarification', reason: 'no_food_named', transcript };
      }
      return understood({ kind: 'search_food', query }, transcript);
    }
    return null;
  }
}

const understood = (intent: VoiceIntent, transcript: string): ParseResult => ({
  status: 'understood',
  intent,
  transcript,
});
