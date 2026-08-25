import type { VoiceIntent, VoiceResponse, VoiceUtterance } from '@macros/domain-voice';

/**
 * VOICE DELIVERY GUARD.
 *
 * Transport safety, deliberately OUTSIDE the pure parser. The parser stays a
 * function of one transcript — `transcript → ParseResult` — and knows nothing
 * about sessions, replay caches, flows or delivery order. Everything that
 * depends on *when and where* an utterance arrived lives here.
 *
 * This is a bounded delivery guard, not event sourcing and not a second state
 * machine: it holds a high-water mark and a small ring of recent deliveries, and
 * it answers exactly one question — may this delivery act?
 *
 * No clock, no network, no repository. Every input is supplied by the caller,
 * so the same delivery sequence always produces the same decisions.
 */

export type DeliveryRejection =
  | 'wrong_user'
  | 'invalid_received_at'
  | 'stale_session'
  | 'stale_turn'
  | 'delivery_conflict'
  | 'stale_flow';

export type DeliveryDecision =
  | { readonly kind: 'accept' }
  | { readonly kind: 'replay'; readonly response: VoiceResponse }
  | { readonly kind: 'reject'; readonly reason: DeliveryRejection };

/** Trusted current state, read from the application — never from the utterance. */
export interface DeliveryContext {
  readonly userId: string;
  readonly sessionGeneration: number;
  readonly flowId: string;
}

interface HandledDelivery {
  readonly utteranceId: string;
  readonly transcriptKey: string;
  readonly atMs: number;
  readonly response: VoiceResponse;
}

/**
 * Commands that only mean something inside the flow they were spoken into.
 * `search_food` and `cancel` are deliberately absent: a search may legitimately
 * start a new flow, and a cancel is safe against whatever is current.
 */
const FLOW_SCOPED_INTENTS: ReadonlySet<VoiceIntent['kind']> = new Set([
  'select_option',
  'request_stable_weight',
  'manual_weight',
  'confirm_log',
]);

export const isFlowScopedIntent = (kind: VoiceIntent['kind']): boolean =>
  FLOW_SCOPED_INTENTS.has(kind);

/** Bounded: a de-duplication ring, not an audit log. */
const MAX_TRACKED_DELIVERIES = 16;

/**
 * Fallback replay window for pipelines that cannot supply an `utteranceId`.
 * Short on purpose — it only catches transport-level redelivery.
 */
export const REPLAY_WINDOW_MS = 2000;

const normalize = (transcript: string): string => transcript.trim().toLowerCase().replace(/\s+/g, ' ');

export class VoiceDeliveryGuard {
  private handled: HandledDelivery[] = [];
  private highestAcceptedTurn: number | null = null;
  private sessionKey: string | null = null;

  /**
   * Phase 1 — before parsing. Decides whether this delivery may be interpreted
   * at all, on identity and ordering alone.
   */
  admit(utterance: VoiceUtterance, context: DeliveryContext): DeliveryDecision {
    // A session is (subject, generation). Either changing invalidates the turn
    // high-water mark and every remembered delivery, so nothing can leak across.
    const sessionKey = `${context.userId}#${context.sessionGeneration}`;
    if (this.sessionKey !== sessionKey) {
      this.sessionKey = sessionKey;
      this.handled = [];
      this.highestAcceptedTurn = null;
    }

    if (utterance.userId !== context.userId) {
      return { kind: 'reject', reason: 'wrong_user' };
    }

    // Validated, not coerced: a malformed timestamp is a broken delivery.
    const atMs = Date.parse(utterance.receivedAt);
    if (!Number.isFinite(atMs)) {
      return { kind: 'reject', reason: 'invalid_received_at' };
    }

    if (
      utterance.sessionGeneration !== undefined &&
      utterance.sessionGeneration !== context.sessionGeneration
    ) {
      return { kind: 'reject', reason: 'stale_session' };
    }

    // Replay is checked BEFORE ordering: a redelivery of an accepted turn is a
    // replay, not a stale turn.
    if (utterance.utteranceId !== undefined) {
      const prior = this.handled.find((h) => h.utteranceId === utterance.utteranceId);
      if (prior !== undefined) {
        // Same id, different words: the pipeline contradicted itself. Execute
        // NEITHER reading — this is an idempotency conflict, not a retry.
        if (prior.transcriptKey !== normalize(utterance.transcript)) {
          return { kind: 'reject', reason: 'delivery_conflict' };
        }
        return { kind: 'replay', response: prior.response };
      }
    } else {
      // No delivery id: fall back to an identical transcript inside a short
      // window. Weaker, and only ever a de-duplication aid.
      const prior = this.handled.find(
        (h) =>
          h.utteranceId === '' &&
          h.transcriptKey === normalize(utterance.transcript) &&
          atMs - h.atMs >= 0 &&
          atMs - h.atMs <= REPLAY_WINDOW_MS,
      );
      if (prior !== undefined) return { kind: 'replay', response: prior.response };
    }

    if (
      utterance.turnSequence !== undefined &&
      this.highestAcceptedTurn !== null &&
      utterance.turnSequence <= this.highestAcceptedTurn
    ) {
      return { kind: 'reject', reason: 'stale_turn' };
    }

    return { kind: 'accept' };
  }

  /**
   * Phase 2 — after parsing, once the intent is known. Only flow-scoped commands
   * are checked, so a search that starts a new flow is never blocked for having
   * been spoken during an older one.
   */
  admitIntent(
    intent: VoiceIntent,
    utterance: VoiceUtterance,
    context: DeliveryContext,
  ): DeliveryDecision {
    if (!isFlowScopedIntent(intent.kind)) return { kind: 'accept' };
    if (utterance.flowIdAtCapture === undefined) return { kind: 'accept' };
    if (utterance.flowIdAtCapture !== context.flowId) {
      return { kind: 'reject', reason: 'stale_flow' };
    }
    return { kind: 'accept' };
  }

  /** Record an executed delivery so a redelivery replays instead of re-running. */
  record(utterance: VoiceUtterance, response: VoiceResponse): void {
    const atMs = Date.parse(utterance.receivedAt);
    const entry: HandledDelivery = {
      utteranceId: utterance.utteranceId ?? '',
      transcriptKey: normalize(utterance.transcript),
      atMs: Number.isFinite(atMs) ? atMs : 0,
      response,
    };
    this.handled = [entry, ...this.handled].slice(0, MAX_TRACKED_DELIVERIES);

    if (utterance.turnSequence !== undefined) {
      this.highestAcceptedTurn =
        this.highestAcceptedTurn === null
          ? utterance.turnSequence
          : Math.max(this.highestAcceptedTurn, utterance.turnSequence);
    }
  }

  reset(): void {
    this.handled = [];
    this.highestAcceptedTurn = null;
    this.sessionKey = null;
  }
}

export const DELIVERY_REJECTION_SPEECH: Readonly<Record<DeliveryRejection, string>> = {
  wrong_user: 'That request was for a different profile.',
  invalid_received_at: "I couldn't tell when that was said.",
  stale_session: "That was from an earlier session, so I didn't act on it.",
  stale_turn: "That arrived out of order, so I didn't act on it.",
  delivery_conflict: "I got two different versions of that, so I didn't act on either.",
  stale_flow: "That referred to something that's no longer on screen.",
};
