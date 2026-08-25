import {
  grams as toGrams,
  type Instant,
  type StableWeightCandidate,
  type WeightCapture,
} from '@macros/contracts';
import {
  admitReading,
  quantizeToResolution,
  validateCommandAck,
  validateScaleCommand,
  validateConnectedEvent,
  validateDisconnectedEvent,
  type AckRejection,
  type PendingScaleCommand,
  type ReadingAdmission,
  type ScaleCapabilities,
  type ScaleDeviceStatus,
  type ScaleSession,
  type WeightCaptureEvent,
  type WeightStabilityPolicy,
} from '@macros/scale-protocol';
import { EMPTY_WINDOW, evaluateStability, isClear, pushSample, type StabilityWindow } from './stability.js';

export const WEIGHT_CAPTURE_VERSION = 'weight-capture@2.0.0-explicit-intent';

/**
 * `stable` means: a valid StableWeightCandidate currently exists.
 * It does NOT mean a food was captured — capture requires explicit intent.
 */
export type CapturePhase =
  | 'disconnected'
  | 'ready'
  | 'stabilizing'
  | 'stable'
  | 'awaiting_clear'
  | 'overload'
  | 'calibration_required'
  | 'fault';

export type CaptureRequestStatus = 'completed' | 'cancelled';

/** Why an unfulfilled intent was cancelled by the machine rather than the host. */
export type CaptureCancellationReason =
  | 'platform_cleared'
  | 'tare_applied'
  | 'device_fault'
  | 'session_ended';

export interface CaptureRequestRecord {
  readonly requestId: string;
  readonly at: Instant;
}

export interface TerminalCaptureRequest {
  readonly requestId: string;
  readonly status: CaptureRequestStatus;
}

/**
 * Why an unfulfilled intent was dropped. A pending request belongs to ONE
 * physical placement; it must never survive an event that ends that placement.
 */
export type CaptureIntentCancellation =
  | 'platform_cleared'
  | 'tare_applied'
  | 'device_fault'
  | 'session_ended';

/** Bounded terminal history. The pending request is a separate field and is never evicted. */
const MAX_TERMINAL_REQUESTS = 16;

export interface WeightCaptureState {
  readonly phase: CapturePhase;
  readonly session: ScaleSession | null;
  readonly capabilities: ScaleCapabilities | null;
  readonly window: StabilityWindow;
  /** Present exactly when phase === 'stable'. */
  readonly candidate: StableWeightCandidate | null;
  readonly pendingCommand: PendingScaleCommand | null;
  /** AT MOST ONE. An intent for food A can never attach itself to food B. */
  readonly pendingCaptureRequest: CaptureRequestRecord | null;
  readonly terminalRequests: readonly TerminalCaptureRequest[];
  /** Why the machine cancelled an unfulfilled intent. Diagnostics only. */
  readonly lastCancellation:
    | { readonly requestId: string; readonly reason: CaptureCancellationReason }
    | null;
  readonly lastStatus: ScaleDeviceStatus | null;
  readonly lastGrams: number | null;
  readonly policyVersion: string;
}

export type CaptureRejection =
  | 'no_candidate'
  | 'candidate_stale'
  | 'awaiting_clear'
  | 'device_not_ready'
  | 'duplicate_request'
  | 'capture_request_already_pending'
  | 'invalid_request'
  | 'invalid_request_time';

export interface WeightCaptureOutput {
  readonly state: WeightCaptureState;
  /** Non-null exactly on the transition that accepts a portion. */
  readonly capture: WeightCapture | null;
  readonly admission: ReadingAdmission | null;
  readonly ackRejection: AckRejection | null;
  readonly captureRejection: CaptureRejection | null;
  readonly intentCancelled: CaptureIntentCancellation | null;
  readonly transition: { readonly from: CapturePhase; readonly to: CapturePhase };
}

export function initialState(policy: WeightStabilityPolicy): WeightCaptureState {
  return {
    phase: 'disconnected',
    session: null,
    capabilities: null,
    window: EMPTY_WINDOW,
    candidate: null,
    pendingCommand: null,
    pendingCaptureRequest: null,
    terminalRequests: [],
    lastCancellation: null,
    lastStatus: null,
    lastGrams: null,
    policyVersion: policy.version,
  };
}

const BLOCKED_BY_STATUS: Partial<Record<ScaleDeviceStatus, CapturePhase>> = {
  overload: 'overload',
  calibration_required: 'calibration_required',
  fault: 'fault',
};

const out = (
  from: CapturePhase,
  state: WeightCaptureState,
  extras: Partial<Omit<WeightCaptureOutput, 'state' | 'transition'>> = {},
): WeightCaptureOutput => ({
  state,
  capture: extras.capture ?? null,
  admission: extras.admission ?? null,
  ackRejection: extras.ackRejection ?? null,
  captureRejection: extras.captureRejection ?? null,
  intentCancelled: extras.intentCancelled ?? null,
  transition: { from, to: state.phase },
});

const isKnownRequest = (state: WeightCaptureState, requestId: string): boolean =>
  state.pendingCaptureRequest?.requestId === requestId ||
  state.terminalRequests.some((r) => r.requestId === requestId);

const terminate = (
  history: readonly TerminalCaptureRequest[],
  requestId: string,
  status: CaptureRequestStatus,
): TerminalCaptureRequest[] =>
  [{ requestId, status }, ...history.filter((r) => r.requestId !== requestId)].slice(
    0,
    MAX_TERMINAL_REQUESTS,
  );

/**
 * Drop an unfulfilled intent because the physical interaction it belonged to
 * has ended. Recorded as cancelled so the same requestId cannot be replayed.
 */
const cancelPendingIntent = (
  state: WeightCaptureState,
  reason: CaptureCancellationReason,
): { state: WeightCaptureState; cancelled: boolean } => {
  const pending = state.pendingCaptureRequest;
  if (pending === null) return { state, cancelled: false };
  return {
    state: {
      ...state,
      pendingCaptureRequest: null,
      terminalRequests: terminate(state.terminalRequests, pending.requestId, 'cancelled'),
      lastCancellation: { requestId: pending.requestId, reason },
    },
    cancelled: true,
  };
};

type FreshnessVerdict = 'fresh' | 'stale' | 'invalid_time';

/**
 * A candidate is usable only when the request happened AFTER it and within the
 * freshness window. A request timestamp preceding the candidate is time travel,
 * not freshness, and is refused outright.
 */
const candidateFreshness = (
  candidate: StableWeightCandidate,
  at: Instant,
  policy: WeightStabilityPolicy,
): FreshnessVerdict => {
  const requestMs = Date.parse(at);
  const observedMs = Date.parse(candidate.observedAt);
  if (!Number.isFinite(requestMs) || !Number.isFinite(observedMs)) return 'invalid_time';
  const ageMs = requestMs - observedMs;
  if (ageMs < 0) return 'invalid_time';
  return ageMs <= policy.maxStableCandidateAgeMs ? 'fresh' : 'stale';
};

/** Carries enough provenance to explain exactly how the accepted grams arose. */
const captureFromCandidate = (
  candidate: StableWeightCandidate,
  at: Instant,
  policy: WeightStabilityPolicy,
): WeightCapture => ({
  grams: candidate.grams,
  source: 'scale',
  capturedAt: at,
  candidateObservedAt: candidate.observedAt,
  deviceId: candidate.deviceId,
  bootId: candidate.bootId,
  sequence: candidate.sequence,
  tareGeneration: candidate.tareGeneration,
  stabilityPolicyVersion: candidate.stabilityPolicyVersion,
  representativeMethod: candidate.representativeMethod,
  resolutionGrams: candidate.resolutionGrams,
  resolutionQuantization: policy.resolutionQuantization,
  evidence: candidate.evidence,
});

/** Every path that invalidates a settled candidate funnels through here. */
const invalidateCandidate = (
  state: WeightCaptureState,
  phase: CapturePhase,
): WeightCaptureState => ({ ...state, phase, window: EMPTY_WINDOW, candidate: null });

/**
 * THE WEIGHT-CAPTURE STATE MACHINE.
 *
 * PURE: no clock, no IO, no randomness, no LLM. Timestamps arrive on events.
 *
 * A STABLE WEIGHT IS NOT AN ACCEPTED FOOD CAPTURE. Stability produces a
 * StableWeightCandidate; only explicit host intent turns one into a
 * WeightCapture. That separation is what lets a user place food, have it
 * settle, and only then say what it is.
 */
export function reduceCapture(
  state: WeightCaptureState,
  event: WeightCaptureEvent,
  policy: WeightStabilityPolicy,
): WeightCaptureOutput {
  const from = state.phase;

  switch (event.kind) {
    case 'connected': {
      // A validated connection is the ONLY thing that establishes a boot.
      if (!validateConnectedEvent(event).ok) return out(from, state);
      return out(from, {
        phase: 'ready',
        session: {
          deviceId: event.capabilities.deviceId,
          bootId: event.bootId,
          lastSequence: null,
          tareGeneration: event.tareGeneration,
        },
        capabilities: event.capabilities,
        window: EMPTY_WINDOW,
        candidate: null,
        pendingCommand: null,
        pendingCaptureRequest: null,
        terminalRequests: [],
        lastCancellation: null,
        lastStatus: 'ok',
        lastGrams: null,
        policyVersion: policy.version,
      });
    }

    case 'disconnected': {
      if (!validateDisconnectedEvent(event).ok) return out(from, state);
      // A disconnect for a different device must not drop this one.
      if (state.session !== null && event.deviceId !== state.session.deviceId) {
        return out(from, state);
      }
      const dropped = cancelPendingIntent(state, 'session_ended');
      return out(
        from,
        { ...invalidateCandidate(dropped.state, 'disconnected'), lastGrams: null, pendingCommand: null },
        dropped.cancelled ? { intentCancelled: 'session_ended' } : {},
      );
    }

    case 'command_issued': {
      if (state.session === null) return out(from, state);
      if (!validateScaleCommand(event.command).ok) return out(from, state);
      if (event.command.deviceId !== state.session.deviceId) return out(from, state);
      if (event.bootId !== state.session.bootId) return out(from, state);
      // A command already in flight stays authoritative until it resolves.
      if (state.pendingCommand !== null) return out(from, state);
      return out(from, {
        ...state,
        pendingCommand: {
          commandId: event.command.commandId,
          kind: event.command.kind,
          deviceId: event.command.deviceId,
          bootId: event.bootId,
        },
      });
    }

    case 'command_ack': {
      if (state.session === null) return out(from, state);
      const validated = validateCommandAck(event.ack, {
        deviceId: state.session.deviceId,
        bootId: state.session.bootId,
        tareGeneration: state.session.tareGeneration,
        pendingCommand: state.pendingCommand,
      });
      if (!validated.ok) return out(from, state, { ackRejection: validated.error });

      const { ack } = event;
      // The command is resolved either way; only 'applied' changes tare state.
      const cleared = { ...state, pendingCommand: null };

      if (ack.outcome !== 'applied') return out(from, cleared);
      if (ack.kind !== 'tare' && ack.kind !== 'zero') return out(from, cleared);

      // Buffered pre-tare samples, the settled candidate and any unfulfilled
      // intent all belong to the pre-tare placement and are discarded.
      const afterTare = cancelPendingIntent(cleared, 'tare_applied');
      return out(
        from,
        {
          ...invalidateCandidate(afterTare.state, afterTare.state.phase === 'disconnected' ? 'disconnected' : 'ready'),
          session: { ...state.session, tareGeneration: ack.tareGeneration! },
          lastGrams: null,
        },
        afterTare.cancelled ? { intentCancelled: 'tare_applied' } : {},
      );
    }

    case 'manual_entry': {
      if (!Number.isFinite(event.grams) || event.grams <= 0) return out(from, state);
      // Truthful provenance only: no device fields, no stability policy, no
      // fabricated evidence. A manual weight never used any of them.
      const capture: WeightCapture = {
        grams: toGrams(event.grams),
        source: 'manual',
        capturedAt: event.at,
      };
      return out(from, state, { capture });
    }

    case 'capture_requested': {
      if (event.requestId.length === 0) {
        return out(from, state, { captureRejection: 'invalid_request' });
      }
      if (!Number.isFinite(Date.parse(event.at))) {
        return out(from, state, { captureRejection: 'invalid_request_time' });
      }
      if (isKnownRequest(state, event.requestId)) {
        // Idempotent: the same request never produces a second capture.
        return out(from, state, { captureRejection: 'duplicate_request' });
      }
      if (state.pendingCaptureRequest !== null) {
        // Never silently supersede an in-flight intent. The application must
        // cancel the first request explicitly before issuing another.
        return out(from, state, { captureRejection: 'capture_request_already_pending' });
      }

      const record: CaptureRequestRecord = { requestId: event.requestId, at: event.at };

      if (state.phase === 'stable' && state.candidate !== null) {
        const verdict = candidateFreshness(state.candidate, event.at, policy);

        if (verdict === 'invalid_time') {
          // A request that predates the candidate is incoherent; it is refused
          // outright rather than armed.
          return out(from, state, { captureRejection: 'invalid_request_time' });
        }

        if (verdict === 'stale') {
          // Drop the stale settled reading and wait for a fresh one.
          return out(
            from,
            { ...invalidateCandidate(state, 'stabilizing'), pendingCaptureRequest: record },
            { captureRejection: 'candidate_stale' },
          );
        }

        const capture = captureFromCandidate(state.candidate, event.at, policy);
        return out(
          from,
          {
            ...invalidateCandidate(state, 'awaiting_clear'),
            terminalRequests: terminate(state.terminalRequests, record.requestId, 'completed'),
          },
          { capture },
        );
      }

      // A request may be ARMED only where capture is logically expected to
      // continue. Anywhere else it is rejected outright and NOT stored, so it
      // can never resurface and capture some later, unrelated portion.
      if (state.phase === 'ready' || state.phase === 'stabilizing') {
        return out(from, { ...state, pendingCaptureRequest: record }, {
          captureRejection: 'no_candidate',
        });
      }

      const rejection: CaptureRejection =
        state.phase === 'awaiting_clear' ? 'awaiting_clear' : 'device_not_ready';
      return out(from, state, { captureRejection: rejection });
    }

    case 'capture_cancelled': {
      const pending = state.pendingCaptureRequest;
      if (pending === null || pending.requestId !== event.requestId) return out(from, state);
      return out(from, {
        ...state,
        pendingCaptureRequest: null,
        terminalRequests: terminate(state.terminalRequests, pending.requestId, 'cancelled'),
      });
    }

    case 'reading': {
      if (state.session === null || state.phase === 'disconnected') {
        return out(from, state, { admission: 'rejected_unknown_device' });
      }

      const { reading } = event;
      const result = admitReading(state.session, reading);
      if (result.admission !== 'accepted') {
        return out(from, { ...state, session: result.session }, { admission: result.admission });
      }
      const session = result.session;

      // Device status is authoritative. Overload is never inferred from a
      // software gram threshold when the hardware reports it directly.
      const blockedPhase = BLOCKED_BY_STATUS[reading.status];
      if (blockedPhase !== undefined) {
        const dropped = cancelPendingIntent({ ...state, session }, 'device_fault');
        return out(
          from,
          {
            ...invalidateCandidate(dropped.state, blockedPhase),
            lastStatus: reading.status,
            lastGrams: reading.netWeightGrams,
          },
          { admission: 'accepted', ...(dropped.cancelled ? { intentCancelled: 'device_fault' as const } : {}) },
        );
      }

      if (state.phase === 'overload' || state.phase === 'calibration_required' || state.phase === 'fault') {
        const recovered = isClear(reading.netWeightGrams, policy) ? 'ready' : 'awaiting_clear';
        return out(
          from,
          {
            ...invalidateCandidate({ ...state, session }, recovered),
            lastStatus: 'ok',
            lastGrams: reading.netWeightGrams,
          },
          { admission: 'accepted' },
        );
      }

      const clear = isClear(reading.netWeightGrams, policy);

      if (state.phase === 'awaiting_clear') {
        // Duplicate prevention: the same portion sitting on the platform cannot
        // satisfy another request until the scale returns to the clear band.
        return out(
          from,
          {
            ...invalidateCandidate({ ...state, session }, clear ? 'ready' : 'awaiting_clear'),
            lastStatus: 'ok',
            lastGrams: reading.netWeightGrams,
          },
          { admission: 'accepted' },
        );
      }

      if (clear) {
        // The placement ended without a capture. Any unfulfilled intent belonged
        // to THAT food and must not carry over to whatever is placed next.
        const dropped = cancelPendingIntent({ ...state, session }, 'platform_cleared');
        return out(
          from,
          {
            ...invalidateCandidate(dropped.state, 'ready'),
            lastStatus: 'ok',
            lastGrams: reading.netWeightGrams,
          },
          { admission: 'accepted', ...(dropped.cancelled ? { intentCancelled: 'platform_cleared' as const } : {}) },
        );
      }

      const atMs = Date.parse(event.at);
      const window = pushSample(
        state.window,
        { atMs, grams: reading.netWeightGrams, tareGeneration: reading.tareGeneration },
        policy,
      );
      const evaluation = evaluateStability(window, policy);

      if (!evaluation.stable) {
        // A material change lands here too: the old candidate is gone and
        // stabilization restarts around the new level.
        return out(
          from,
          {
            ...state, session, phase: 'stabilizing', window, candidate: null,
            lastStatus: 'ok', lastGrams: reading.netWeightGrams,
          },
          { admission: 'accepted' },
        );
      }

      const resolutionGrams = state.capabilities?.resolutionGrams ?? 1;
      const candidate: StableWeightCandidate = {
        grams: toGrams(
          quantizeToResolution(evaluation.representativeGrams, resolutionGrams, policy.resolutionQuantization),
        ),
        observedAt: event.at,
        deviceId: session.deviceId,
        bootId: session.bootId,
        sequence: reading.sequence,
        tareGeneration: reading.tareGeneration,
        stabilityPolicyVersion: policy.version,
        representativeMethod: policy.representativeMethod,
        resolutionGrams,
        resolutionQuantization: policy.resolutionQuantization,
        evidence: {
          sampleCount: evaluation.sampleCount,
          minGrams: evaluation.minGrams,
          maxGrams: evaluation.maxGrams,
          spreadGrams: evaluation.spreadGrams,
          durationMs: evaluation.durationMs,
        },
      };

      const armed = state.pendingCaptureRequest;
      if (armed !== null) {
        // Intent was expressed before the food settled: capture now.
        const capture = captureFromCandidate(candidate, event.at, policy);
        return out(
          from,
          {
            ...invalidateCandidate({ ...state, session }, 'awaiting_clear'),
            pendingCaptureRequest: null,
            terminalRequests: terminate(state.terminalRequests, armed.requestId, 'completed'),
            lastStatus: 'ok',
            lastGrams: reading.netWeightGrams,
          },
          { capture, admission: 'accepted' },
        );
      }

      // Settled, but nobody asked for it. Hold the candidate and wait.
      return out(
        from,
        {
          ...state, session, phase: 'stable', window, candidate,
          lastStatus: 'ok', lastGrams: reading.netWeightGrams,
        },
        { admission: 'accepted' },
      );
    }
  }
}

export function reduceAll(
  state: WeightCaptureState,
  events: readonly WeightCaptureEvent[],
  policy: WeightStabilityPolicy,
): { state: WeightCaptureState; captures: WeightCapture[]; outputs: WeightCaptureOutput[] } {
  let current = state;
  const captures: WeightCapture[] = [];
  const outputs: WeightCaptureOutput[] = [];
  for (const event of events) {
    const result = reduceCapture(current, event, policy);
    current = result.state;
    outputs.push(result);
    if (result.capture !== null) captures.push(result.capture);
  }
  return { state: current, captures, outputs };
}

/** Build a manual capture directly. Truthful provenance only. */
export function manualCapture(gramsValue: number, at: Instant): WeightCapture {
  if (!Number.isFinite(gramsValue) || gramsValue <= 0) {
    throw new Error('manualCapture: a food weight must be finite and greater than zero');
  }
  return { grams: toGrams(gramsValue), source: 'manual', capturedAt: at };
}
