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
  | { readonly kind: 'help' }
  /**
   * "What should I eat?" — a READ-ONLY request. It returns candidates for the
   * user to choose from and never selects, weighs or logs anything.
   */
  | { readonly kind: 'recommend_food' };

export type NutrientQuery = 'calories' | 'protein' | 'carbohydrate' | 'fat';

/**
 * A transcript that has ALREADY been produced by speech-to-text.
 *
 * Audio never enters the domain. This is the seam where a real STT vendor
 * attaches later without touching anything below it.
 */
export interface VoiceUtterance {
  readonly transcript: string;

  /**
   * RULING (A6): RETAINED, with a real job and a hard limit.
   *
   * Purpose: ordering evidence and bounded replay retention. It is validated as
   * an Instant, and an unparseable value is REJECTED rather than coerced.
   *
   * It is explicitly NOT a freshness test. Wall-clock recency can never stand in
   * for `sessionGeneration`, `turnSequence` or `flowIdAtCapture`: a transcript
   * can arrive milliseconds late and still belong to a dead session, and a clock
   * that skews does not make a stale command safe. Correlation decides
   * staleness; this field only orders and ages entries.
   */
  readonly receivedAt: string;

  readonly userId: string;

  /**
   * STT delivery identity — idempotency key for one recognition.
   *
   * A speech pipeline can deliver the same recognition more than once: a retried
   * callback, a duplicated event, a reconnect replay. A repeat replays the
   * original response and executes nothing.
   */
  readonly utteranceId?: string;

  /**
   * The `TabletAppController` session this utterance was spoken into.
   *
   * A user switch increments the app's generation. A transcript captured before
   * that switch belongs to a session that no longer exists and must never act on
   * the new one.
   */
  readonly sessionGeneration?: number;

  /**
   * Monotonic turn counter within a session.
   *
   * Real STT completes out of order: a long utterance recognised slowly can land
   * after a short one spoken later. Once a newer turn has been accepted, an
   * older turn is stale — it was composed against a screen the user has already
   * moved on from.
   */
  readonly turnSequence?: number;

  /**
   * The add-food flow this utterance was spoken into, for context-dependent
   * commands only ("option B", "weigh it", "log it").
   *
   * "Option B" means *that* B — the one on screen when the user spoke. If the
   * flow has since been cancelled or replaced, the words no longer refer to
   * anything and must not be re-aimed at whatever is on screen now.
   *
   * Absent for commands that legitimately START a flow, such as search.
   */
  readonly flowIdAtCapture?: string;
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

/**
 * AN EXECUTABLE VOICE DELIVERY.
 *
 * `VoiceUtterance` above is the PARSE input — the minimum a pure parser needs.
 * This is the EXECUTION input, and correlation is MANDATORY here.
 *
 * The distinction matters: omitting a correlation field must never silently
 * disable a safety check. A pipeline that cannot supply these values is not
 * permitted to drive state changes at all, rather than being quietly granted a
 * weaker guarantee.
 */
export interface CorrelatedVoiceDelivery {
  readonly transcript: string;
  readonly receivedAt: string;
  readonly userId: string;
  readonly utteranceId: string;
  readonly sessionGeneration: number;
  readonly turnSequence: number;
  /**
   * The add-food flow this was spoken into.
   *
   * REQUIRED for flow-scoped commands and explicitly `null` for
   * flow-independent ones — null is a stated fact ("this did not belong to a
   * flow"), not an omission.
   */
  readonly flowIdAtCapture: string | null;
}

export type DeliveryContractViolation =
  | 'transcript_missing'
  | 'received_at_invalid'
  | 'user_missing'
  | 'utterance_id_missing'
  | 'session_generation_invalid'
  | 'turn_sequence_invalid'
  | 'flow_context_field_missing';

/**
 * Runtime validation of a delivery from an adapter. TypeScript types are not
 * evidence at a transport boundary — STT output crosses a process edge.
 */
export function validateDelivery(
  candidate: Partial<CorrelatedVoiceDelivery> | null | undefined,
): DeliveryContractViolation | null {
  if (candidate === null || candidate === undefined) return 'transcript_missing';
  if (typeof candidate.transcript !== 'string') return 'transcript_missing';
  if (typeof candidate.userId !== 'string' || candidate.userId.length === 0) return 'user_missing';
  if (typeof candidate.utteranceId !== 'string' || candidate.utteranceId.length === 0) {
    return 'utterance_id_missing';
  }
  if (typeof candidate.receivedAt !== 'string' || !Number.isFinite(Date.parse(candidate.receivedAt))) {
    return 'received_at_invalid';
  }
  if (!Number.isInteger(candidate.sessionGeneration)) return 'session_generation_invalid';
  if (!Number.isInteger(candidate.turnSequence)) return 'turn_sequence_invalid';
  // Absent is a contract violation; explicit null is a valid statement.
  if (!('flowIdAtCapture' in candidate)) return 'flow_context_field_missing';
  if (candidate.flowIdAtCapture !== null && typeof candidate.flowIdAtCapture !== 'string') {
    return 'flow_context_field_missing';
  }
  return null;
}
