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
  | 'too_many_in_flight'
  | 'superseded_by_newer_turn'
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

interface InFlightDelivery {
  readonly utteranceId: string;
  readonly transcriptKey: string;
  /** Turn number, so a newer state-changing turn can supersede this one. */
  readonly turnSequence: number;
  /** Set when a newer state-changing turn has superseded this reservation. */
  superseded: boolean;
}

interface CompletedDelivery {
  readonly utteranceId: string;
  readonly transcriptKey: string;
  readonly response: VoiceResponse;
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

/**
 * Completed responses are a bounded REPLAY CACHE — safe to forget, because
 * forgetting one only costs a re-execution of an idempotent replay.
 */
const MAX_COMPLETED_CACHE = 16;

/**
 * In-flight reservations are NEVER evicted. Forgetting one would let a
 * duplicate execute a second time, so overload is refused instead.
 */
export const MAX_CONCURRENT_IN_FLIGHT = 32;

const normalize = (transcript: string): string =>
  transcript.trim().toLowerCase().replace(/\s+/g, ' ');

export class VoiceDeliveryGuard {
  /**
   * Reservations for deliveries currently executing. UNBOUNDED BY EVICTION:
   * entries leave only when their execution completes. A capacity limit exists,
   * but it refuses NEW work rather than forgetting work already accepted.
   */
  private inFlight: InFlightDelivery[] = [];

  /** Completed responses, bounded. Losing one costs at most a re-execution. */
  private completed: CompletedDelivery[] = [];

  private highestAcceptedTurn: number | null = null;
  /**
   * Turn number of the most recent STATE-CHANGING intent that has been
   * dispatched. Read-only questions never advance it.
   */
  private highestStateChangingTurn: number | null = null;
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
      this.inFlight = [];
      this.completed = [];
      this.highestAcceptedTurn = null;
      this.highestStateChangingTurn = null;
    }

    if (delivery.userId !== context.userId) {
      return { kind: 'reject', reason: 'wrong_user' };
    }
    if (delivery.sessionGeneration !== context.sessionGeneration) {
      return { kind: 'reject', reason: 'stale_session' };
    }

    const transcriptKey = normalize(delivery.transcript);

    // In-flight is checked FIRST and can never have been evicted.
    const running = this.inFlight.find((t) => t.utteranceId === delivery.utteranceId);
    if (running !== undefined) {
      if (running.transcriptKey !== transcriptKey) {
        return { kind: 'reject', reason: 'delivery_conflict' };
      }
      return { kind: 'reject', reason: 'duplicate_in_flight' };
    }

    const done = this.completed.find((t) => t.utteranceId === delivery.utteranceId);
    if (done !== undefined) {
      // Same id, different words: the pipeline contradicted itself. Neither
      // reading executes — this is an idempotency conflict, not a retry.
      if (done.transcriptKey !== transcriptKey) {
        return { kind: 'reject', reason: 'delivery_conflict' };
      }
      return { kind: 'replay', response: done.response };
    }

    if (
      this.highestAcceptedTurn !== null &&
      delivery.turnSequence <= this.highestAcceptedTurn
    ) {
      return { kind: 'reject', reason: 'stale_turn' };
    }

    // Overload is refused, never resolved by discarding a live reservation.
    if (this.inFlight.length >= MAX_CONCURRENT_IN_FLIGHT) {
      return { kind: 'reject', reason: 'too_many_in_flight' };
    }

    // RESERVE — synchronously, before the caller may await anything.
    this.inFlight.push({
      utteranceId: delivery.utteranceId,
      transcriptKey,
      turnSequence: delivery.turnSequence,
      superseded: false,
    });

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

  /**
   * Record that a state-changing intent is about to execute.
   *
   * This SUPERSEDES every older in-flight reservation, so a slow interpretation
   * from an earlier turn cannot later undo or resurrect what a newer command
   * just did. Read-only questions deliberately do not call this: asking "how
   * much protein is left" must never invalidate work already under way.
   */
  markStateChanging(delivery: CorrelatedVoiceDelivery): void {
    this.highestStateChangingTurn =
      this.highestStateChangingTurn === null
        ? delivery.turnSequence
        : Math.max(this.highestStateChangingTurn, delivery.turnSequence);

    for (const entry of this.inFlight) {
      if (entry.turnSequence < delivery.turnSequence) entry.superseded = true;
    }
  }

  /**
   * Whether an older state-changing intent may still execute.
   *
   * A proposal that was still being interpreted when a newer state-changing
   * command ran is stale: acting on it now would apply a decision the user made
   * about a screen that has since moved on.
   */
  isSupersededStateChange(delivery: CorrelatedVoiceDelivery): boolean {
    const entry = this.inFlight.find((t) => t.utteranceId === delivery.utteranceId);
    if (entry !== undefined && entry.superseded) return true;
    return (
      this.highestStateChangingTurn !== null &&
      delivery.turnSequence < this.highestStateChangingTurn
    );
  }

  /** Settle a reservation with its canonical response, so duplicates replay it. */
  complete(delivery: CorrelatedVoiceDelivery, response: VoiceResponse): void {
    const idx = this.inFlight.findIndex((t) => t.utteranceId === delivery.utteranceId);
    if (idx === -1) return;
    const entry = this.inFlight[idx]!;
    this.inFlight.splice(idx, 1);
    this.completed = [
      { utteranceId: entry.utteranceId, transcriptKey: entry.transcriptKey, response },
      ...this.completed,
    ].slice(0, MAX_COMPLETED_CACHE);
  }

  inFlightCount(): number {
    return this.inFlight.length;
  }

  reset(): void {
    this.inFlight = [];
    this.completed = [];
    this.highestAcceptedTurn = null;
    this.highestStateChangingTurn = null;
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
  too_many_in_flight: "I've got too much in progress right now — say that again in a moment.",
  superseded_by_newer_turn: "You asked for something else after that, so I skipped it.",
  stale_flow: "That referred to something that's no longer on screen.",
  missing_flow_context: "I couldn't tell which item that referred to.",
};
