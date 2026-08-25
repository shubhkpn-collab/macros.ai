import {
  validateDelivery,
  type CorrelatedVoiceDelivery,
  type DeliveryContractViolation,
  type VoiceIntent,
  type VoiceResponse,
} from '@macros/domain-voice';

/**
 * VOICE DELIVERY GUARD.
 *
 * Transport safety, deliberately OUTSIDE the pure parser. The parser stays a
 * function of one transcript and knows nothing about sessions, reservations,
 * flows or delivery order.
 *
 * LIFECYCLE: admit → RESERVE → execute → complete.
 *
 * Reservation happens synchronously at admission, BEFORE any await. Speech
 * recognition is asynchronous and genuinely concurrent: two callbacks can be in
 * flight at once, and a slow interpretation can still be running when the next
 * transcript lands. If identity were only recorded after execution finished,
 * every await would be an open window in which a duplicate or an older turn
 * could also be admitted. Execution speed must never determine logical
 * ordering.
 *
 * No clock, no network, no repository. Bounded: a small ring plus a high-water
 * mark, not an event store.
 */

export type DeliveryRejection =
  | 'wrong_user'
  | 'invalid_delivery'
  | 'stale_session'
  | 'stale_turn'
  | 'delivery_conflict'
  | 'duplicate_in_flight'
  | 'stale_flow'
  | 'missing_flow_context';

export type DeliveryDecision =
  | { readonly kind: 'accept' }
  | { readonly kind: 'replay'; readonly response: VoiceResponse }
  | { readonly kind: 'reject'; readonly reason: DeliveryRejection };

/** Trusted current state, read from the application — never from the delivery. */
export interface DeliveryContext {
  readonly userId: string;
  readonly sessionGeneration: number;
  readonly flowId: string;
}

interface TrackedDelivery {
  readonly utteranceId: string;
  readonly transcriptKey: string;
  status: 'in_flight' | 'completed';
  response?: VoiceResponse;
}

/**
 * Commands that only mean something inside the flow they were spoken into.
 * `search_food` is absent because a search legitimately STARTS a flow. `cancel`
 * is absent because cancelling whatever is current is safe in any flow — it
 * only ever removes work, never commits any.
 */
const FLOW_SCOPED_INTENTS: ReadonlySet<VoiceIntent['kind']> = new Set([
  'select_option',
  'request_stable_weight',
  'manual_weight',
  'confirm_log',
]);

export const isFlowScopedIntent = (kind: VoiceIntent['kind']): boolean =>
  FLOW_SCOPED_INTENTS.has(kind);

const MAX_TRACKED_DELIVERIES = 16;

const normalize = (transcript: string): string =>
  transcript.trim().toLowerCase().replace(/\s+/g, ' ');

export class VoiceDeliveryGuard {
  private tracked: TrackedDelivery[] = [];
  private highestAcceptedTurn: number | null = null;
  private sessionKey: string | null = null;

  /**
   * Admit and RESERVE in one synchronous step.
   *
   * There is deliberately no separate `reserve()` a caller could forget to
   * invoke: an accepted delivery is reserved by the time this returns, so no
   * await can occur between the check and the reservation.
   */
  admitAndReserve(
    delivery: CorrelatedVoiceDelivery,
    context: DeliveryContext,
  ): DeliveryDecision {
    const violation: DeliveryContractViolation | null = validateDelivery(delivery);
    if (violation !== null) {
      return { kind: 'reject', reason: 'invalid_delivery' };
    }

    // A session is (subject, generation). Either changing invalidates the turn
    // high-water mark and every tracked delivery, so nothing leaks across.
    const sessionKey = `${context.userId}#${context.sessionGeneration}`;
    if (this.sessionKey !== sessionKey) {
      this.sessionKey = sessionKey;
      this.tracked = [];
      this.highestAcceptedTurn = null;
    }

    if (delivery.userId !== context.userId) {
      return { kind: 'reject', reason: 'wrong_user' };
    }
    if (delivery.sessionGeneration !== context.sessionGeneration) {
      return { kind: 'reject', reason: 'stale_session' };
    }

    const transcriptKey = normalize(delivery.transcript);
    const prior = this.tracked.find((t) => t.utteranceId === delivery.utteranceId);
    if (prior !== undefined) {
      // Same id, different words: the pipeline contradicted itself. Neither
      // reading executes — this is an idempotency conflict, not a retry.
      if (prior.transcriptKey !== transcriptKey) {
        return { kind: 'reject', reason: 'delivery_conflict' };
      }
      if (prior.status === 'in_flight') {
        // The original is still running. The duplicate must not race it.
        return { kind: 'reject', reason: 'duplicate_in_flight' };
      }
      return { kind: 'replay', response: prior.response! };
    }

    if (
      this.highestAcceptedTurn !== null &&
      delivery.turnSequence <= this.highestAcceptedTurn
    ) {
      return { kind: 'reject', reason: 'stale_turn' };
    }

    // RESERVE — synchronously, before the caller may await anything.
    this.tracked = [
      { utteranceId: delivery.utteranceId, transcriptKey, status: 'in_flight' as const },
      ...this.tracked,
    ].slice(0, MAX_TRACKED_DELIVERIES);

    // The high-water mark advances at ADMISSION and never rolls back — an
    // admitted turn stays logically newer even if it later clarifies, fails or
    // is refused.
    this.highestAcceptedTurn =
      this.highestAcceptedTurn === null
        ? delivery.turnSequence
        : Math.max(this.highestAcceptedTurn, delivery.turnSequence);

    return { kind: 'accept' };
  }

  /**
   * Revalidate the authoritative context immediately before a state change.
   *
   * Admission-time validation is NOT sufficient for asynchronous work: an
   * interpreter call can outlive the session or the flow it was made in. This
   * runs after every untrusted/async boundary and before execution.
   */
  revalidateForExecution(
    intent: VoiceIntent,
    delivery: CorrelatedVoiceDelivery,
    context: DeliveryContext,
  ): DeliveryDecision {
    if (delivery.userId !== context.userId) {
      return { kind: 'reject', reason: 'wrong_user' };
    }
    if (delivery.sessionGeneration !== context.sessionGeneration) {
      return { kind: 'reject', reason: 'stale_session' };
    }
    if (!isFlowScopedIntent(intent.kind)) return { kind: 'accept' };

    // Flow-scoped commands must state their flow. Absence is refused rather
    // than treated as "any flow will do".
    if (delivery.flowIdAtCapture === null) {
      return { kind: 'reject', reason: 'missing_flow_context' };
    }
    if (delivery.flowIdAtCapture !== context.flowId) {
      return { kind: 'reject', reason: 'stale_flow' };
    }
    return { kind: 'accept' };
  }

  /** Settle a reservation with its canonical response, so duplicates replay it. */
  complete(delivery: CorrelatedVoiceDelivery, response: VoiceResponse): void {
    const entry = this.tracked.find((t) => t.utteranceId === delivery.utteranceId);
    if (entry === undefined) return;
    entry.status = 'completed';
    entry.response = response;
  }

  reset(): void {
    this.tracked = [];
    this.highestAcceptedTurn = null;
    this.sessionKey = null;
  }
}

export const DELIVERY_REJECTION_SPEECH: Readonly<Record<DeliveryRejection, string>> = {
  wrong_user: 'That request was for a different profile.',
  invalid_delivery: "I couldn't process that request.",
  stale_session: "That was from an earlier session, so I didn't act on it.",
  stale_turn: "That arrived out of order, so I didn't act on it.",
  delivery_conflict: "I got two different versions of that, so I didn't act on either.",
  duplicate_in_flight: "I'm already working on that one.",
  stale_flow: "That referred to something that's no longer on screen.",
  missing_flow_context: "I couldn't tell which item that referred to.",
};
