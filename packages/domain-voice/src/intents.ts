/**
 * VOICE INTENT VOCABULARY — closed and deliberately small.
 *
 * VOICE ORCHESTRATION IS NOT A NUTRITION SOURCE. An intent names what the user
 * asked for; it never carries calories, macros, or a food's identity. Resolving
 * a food is the catalog's job, and computing nutrition is the nutrition
 * engine's job.
 */
export type VoiceIntent =
  | { readonly kind: 'search_food'; readonly query: string }
  | { readonly kind: 'select_option'; readonly optionLabel: string }
  | { readonly kind: 'request_stable_weight' }
  | { readonly kind: 'manual_weight'; readonly grams: number }
  | { readonly kind: 'confirm_log' }
  | { readonly kind: 'cancel' }
  | { readonly kind: 'ask_consumed'; readonly nutrient: NutrientQuery }
  | { readonly kind: 'ask_remaining'; readonly nutrient: NutrientQuery }
  | { readonly kind: 'ask_macros' }
  | { readonly kind: 'repeat_options' }
  | { readonly kind: 'help' };

export type NutrientQuery = 'calories' | 'protein' | 'carbohydrate' | 'fat';

/**
 * A transcript that has ALREADY been produced by speech-to-text.
 *
 * Audio never enters the domain. This is the seam where a real STT vendor
 * attaches later without touching anything below it.
 */
export interface VoiceUtterance {
  readonly transcript: string;
  readonly receivedAt: string;
  readonly userId: string;
  /**
   * Optional STT delivery identity.
   *
   * A speech pipeline can deliver the SAME recognition result more than once —
   * a retried callback, a duplicated event, a reconnect replay. When the
   * pipeline supplies a stable id for one recognition, the orchestrator treats
   * a repeat as a REPLAY of an already-handled utterance rather than a fresh
   * command.
   *
   * Absent when the pipeline cannot supply one, in which case the timestamp
   * window applies instead.
   */
  readonly utteranceId?: string;
}

/**
 * Parsing NEVER silently maps ambiguous language onto a destructive action.
 * When in doubt the result is `needs_clarification`, never a guess.
 */
export type ParseResult =
  | { readonly status: 'understood'; readonly intent: VoiceIntent; readonly transcript: string }
  | { readonly status: 'needs_clarification'; readonly reason: ClarificationReason; readonly transcript: string }
  | { readonly status: 'unsupported'; readonly transcript: string }
  | { readonly status: 'invalid'; readonly reason: InvalidReason; readonly transcript: string };

export type ClarificationReason =
  | 'ambiguous_option'
  | 'no_food_named'
  | 'quantity_target_unsupported'
  | 'ambiguous_food_reference';

export type InvalidReason =
  | 'empty_transcript'
  | 'weight_not_positive'
  | 'weight_not_finite'
  | 'weight_out_of_range'
  | 'unsupported_unit';
