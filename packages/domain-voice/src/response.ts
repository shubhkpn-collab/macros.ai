import type { ClarificationReason, InvalidReason } from './intents.js';

/**
 * BOUNDED RESPONSE MODEL.
 *
 * A structured result, not an arbitrary string per branch, so TTS, tablet text
 * and accessibility output can all render the same outcome. Authoritative
 * values stay in `data`; `speech` is presentation only and is NEVER written
 * back into nutrition or logs.
 */
export type VoiceResponse =
  | { readonly kind: 'informational'; readonly speech: string; readonly data?: Readonly<Record<string, number | string>> }
  | { readonly kind: 'options'; readonly speech: string; readonly options: readonly VoiceOption[] }
  | { readonly kind: 'review'; readonly speech: string; readonly review: VoiceReview }
  | { readonly kind: 'success'; readonly speech: string; readonly data?: Readonly<Record<string, number | string>> }
  | { readonly kind: 'clarification'; readonly speech: string; readonly reason: ClarificationReason }
  | { readonly kind: 'error'; readonly speech: string; readonly reason: string };

export interface VoiceOption {
  readonly optionLabel: string;
  readonly productVersionId: string;
  readonly displayName: string;
  readonly brandName?: string;
  readonly preparationState: string;
}

export interface VoiceReview {
  readonly productVersionId: string;
  readonly displayName: string;
  readonly grams: number;
  readonly kcal: number;
  readonly proteinG: number;
  readonly carbohydrateG: number;
  readonly fatG: number;
  readonly weightSource: string;
}

/**
 * Spoken number formatting. PRESENTATION ONLY.
 *
 * Rounding here never reaches a stored value: the caller passes the exact
 * domain number, and `data` on the response carries it unrounded.
 */
export const speakGrams = (grams: number): string =>
  `${Math.round(grams)} gram${Math.round(grams) === 1 ? '' : 's'}`;

export const speakKcal = (kcal: number): string => `${Math.round(kcal)} calories`;

export const speakGramsOf = (grams: number, nutrient: string): string =>
  `${Math.round(grams)} grams of ${nutrient}`;

export const INVALID_SPEECH: Readonly<Record<InvalidReason, string>> = {
  empty_transcript: "I didn't catch that.",
  weight_not_positive: 'That weight needs to be greater than zero.',
  weight_not_finite: "That weight doesn't look like a number.",
  weight_out_of_range: 'That weight is beyond what the scale supports.',
  unsupported_unit: 'I can only take weights in grams right now.',
};

export const CLARIFICATION_SPEECH: Readonly<Record<ClarificationReason, string>> = {
  ambiguous_option: 'I heard more than one option. Which one — say Option A or Option B.',
  no_food_named: 'Which food would you like to log?',
  quantity_target_unsupported:
    "I can't work backwards from a calorie amount. Tell me the food, then weigh it.",
  ambiguous_food_reference: 'Which product did you mean?',
};
