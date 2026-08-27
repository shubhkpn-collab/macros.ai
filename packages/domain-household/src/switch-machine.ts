import type { AuthenticatedSubject } from '@macros/domain-auth';
import { subjectUserId } from '@macros/domain-auth';
import type { ActiveUserSession } from './model.js';

/**
 * TWO-PHASE USER SWITCH.
 *
 * REQUEST → CONFIRM → AUTHENTICATE → ACTIVATE.
 *
 * The invariant this exists to enforce: a name, a voice statement, a userId, a
 * roster row or a UI selection identifies WHO IS BEING REQUESTED. None of them
 * authenticates anyone. Only a verified `AuthenticatedSubject` for the
 * confirmed target can activate a session.
 *
 * A is deliberately kept active throughout. Tearing A's session down at request
 * time would turn every mistaken or failed switch into a logout, which is a
 * poor outcome on a shared kitchen appliance.
 */
export const SWITCH_MACHINE_VERSION = 'shared-device-switch@1.0.0';

export type SwitchPhase =
  | 'neutral'
  | 'active'
  | 'switch_requested'
  | 'awaiting_authentication'
  | 'activating'
  | 'failed';

export interface SwitchAttempt {
  readonly switchRequestId: string;
  /**
   * The device binding generation when the request was made. A rebind during a
   * pending switch invalidates the attempt: the household context it was
   * requested against no longer exists.
   */
  readonly bindingGeneration?: number;
  /** Absolute deadline. An abandoned attempt must not stay pending forever. */
  readonly expiresAt?: string;
  readonly targetUserId: string;
  readonly targetDisplayName: string;
  readonly deviceId: string;
  readonly householdId: string;
  /** The generation in force when the request was made — the staleness guard. */
  readonly sessionGeneration: number;
  readonly requestedAt: string;
  readonly confirmed: boolean;
}

export interface SwitchState {
  readonly phase: SwitchPhase;
  /** Stays populated while a switch is pending: A is not logged out. */
  readonly activeUserId: string | null;
  readonly sessionGeneration: number;
  readonly attempt: SwitchAttempt | null;
  readonly lastFailure?: SwitchFailure;
}

export type SwitchFailure =
  | 'not_confirmed'
  | 'attempt_expired'
  | 'binding_changed'
  | 'no_attempt_in_progress'
  | 'stale_attempt'
  | 'target_mismatch'
  | 'authentication_failed'
  | 'cancelled'
  | 'no_active_membership'
  | 'wrong_household'
  | 'device_not_bound'
  | 'already_activated';

export const neutralSwitchState = (): SwitchState => ({
  phase: 'neutral', activeUserId: null, sessionGeneration: 0, attempt: null,
});

export const activeSwitchState = (userId: string, generation: number): SwitchState => ({
  phase: 'active', activeUserId: userId, sessionGeneration: generation, attempt: null,
});

export interface RequestSwitchInput {
  readonly switchRequestId: string;
  readonly bindingGeneration?: number;
  readonly expiresAt?: string;
  readonly targetUserId: string;
  readonly targetDisplayName: string;
  readonly deviceId: string;
  readonly householdId: string;
  readonly requestedAt: string;
}

/**
 * Phase 1 — REQUEST. Records who is being asked for. Nothing is authenticated,
 * and the current user remains active and usable.
 */
export function requestSwitch(state: SwitchState, input: RequestSwitchInput): SwitchState {
  return {
    ...state,
    phase: 'switch_requested',
    // A stays active.
    activeUserId: state.activeUserId,
    attempt: {
      switchRequestId: input.switchRequestId,
      targetUserId: input.targetUserId,
      targetDisplayName: input.targetDisplayName,
      deviceId: input.deviceId,
      householdId: input.householdId,
      sessionGeneration: state.sessionGeneration,
      requestedAt: input.requestedAt,
      confirmed: false,
      ...(input.bindingGeneration !== undefined
        ? { bindingGeneration: input.bindingGeneration } : {}),
      ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
    },
  };
}

/**
 * Phase 2 — CONFIRM. The person acknowledges the target is who they meant.
 * This is target SELECTION, still not authentication.
 */
export function confirmSwitchTarget(
  state: SwitchState, switchRequestId: string, targetUserId: string,
): SwitchState | { readonly error: SwitchFailure } {
  const attempt = state.attempt;
  if (attempt === null || state.phase !== 'switch_requested') {
    return { error: 'no_attempt_in_progress' };
  }
  if (attempt.switchRequestId !== switchRequestId) return { error: 'stale_attempt' };
  if (attempt.targetUserId !== targetUserId) return { error: 'target_mismatch' };
  return { ...state, phase: 'awaiting_authentication', attempt: { ...attempt, confirmed: true } };
}

/** Phase 3 — the credential challenge is in flight. State is unchanged. */
export function beginAuthentication(
  state: SwitchState, switchRequestId: string,
): SwitchState | { readonly error: SwitchFailure } {
  const attempt = state.attempt;
  if (attempt === null || state.phase !== 'awaiting_authentication') {
    return { error: 'no_attempt_in_progress' };
  }
  if (attempt.switchRequestId !== switchRequestId) return { error: 'stale_attempt' };
  if (!attempt.confirmed) return { error: 'not_confirmed' };
  return state;
}

/**
 * Phase 4 — COMMIT an ALREADY-AUTHORIZED session.
 *
 * This machine owns request identity, confirmation, staleness and target
 * matching. It deliberately does NOT re-decide household eligibility: doing so
 * created a second authorization authority that silently omitted the age and
 * seat rules `activateUser` already enforces. Membership, device, age and seat
 * were proven there.
 *
 * It also does not INVENT a generation — it adopts the one activation minted,
 * so there is exactly one writer.
 */
export function completeAuthenticatedSwitch(
  state: SwitchState,
  switchRequestId: string,
  subject: AuthenticatedSubject,
  activeSession: ActiveUserSession,
  nowIso?: string,
  currentBindingGeneration?: number,
): SwitchState | { readonly error: SwitchFailure } {
  const attempt = state.attempt;
  if (attempt === null) {
    // A duplicate callback after a successful activation is refused with an
    // accurate reason rather than a generic one — the switch DID happen, and
    // this second response must not advance the generation again.
    return { error: state.phase === 'active' && state.activeUserId !== null
      ? 'already_activated' : 'no_attempt_in_progress' };
  }

  // A response arriving after cancellation, a different target, or a
  // generation change must not activate anyone.
  if (state.phase !== 'awaiting_authentication') {
    return { error: state.phase === 'active' ? 'already_activated' : 'stale_attempt' };
  }
  if (attempt.switchRequestId !== switchRequestId) return { error: 'stale_attempt' };
  if (!attempt.confirmed) return { error: 'not_confirmed' };
  if (attempt.sessionGeneration !== state.sessionGeneration) return { error: 'stale_attempt' };

  // The credential must belong to the CONFIRMED target — a valid token for
  // somebody else is not a licence to activate them.
  if (subjectUserId(subject) !== attempt.targetUserId) return { error: 'target_mismatch' };

  // BOUNDED LIFETIME. Without this an abandoned attempt stays pending
  // indefinitely, and a credential arriving much later still commits it.
  if (attempt.expiresAt !== undefined && nowIso !== undefined) {
    const deadline = Date.parse(attempt.expiresAt);
    const now = Date.parse(nowIso);
    if (!Number.isFinite(deadline) || !Number.isFinite(now) || now >= deadline) {
      return { error: 'attempt_expired' };
    }
  }

  // BINDING CONTINUITY. A rebind during the switch changes the household this
  // attempt was requested against.
  if (attempt.bindingGeneration !== undefined && currentBindingGeneration !== undefined
      && attempt.bindingGeneration !== currentBindingGeneration) {
    return { error: 'binding_changed' };
  }

  // The authorized session must correspond to THIS attempt in every respect.
  if (activeSession.userId !== subjectUserId(subject)) return { error: 'target_mismatch' };
  if (activeSession.deviceId !== attempt.deviceId) return { error: 'device_not_bound' };
  if (activeSession.householdId !== attempt.householdId) return { error: 'wrong_household' };

  // Adopted, never recomputed. The generation must be exactly the next legal
  // one, so a replayed session cannot re-advance it.
  if (activeSession.sessionGeneration !== state.sessionGeneration + 1) {
    return { error: 'stale_attempt' };
  }

  return {
    phase: 'active',
    activeUserId: attempt.targetUserId,
    sessionGeneration: activeSession.sessionGeneration,
    attempt: null,
  };
}

/** Authentication failed. The CURRENT user keeps working. */
export function authenticationFailed(state: SwitchState, switchRequestId: string): SwitchState {
  const attempt = state.attempt;
  if (attempt === null || attempt.switchRequestId !== switchRequestId) return state;
  return {
    ...state,
    phase: state.activeUserId === null ? 'neutral' : 'active',
    attempt: null,
    lastFailure: 'authentication_failed',
  };
}

/** Cancel. Same rule: the current user is untouched. */
export function cancelSwitch(state: SwitchState, switchRequestId: string): SwitchState {
  const attempt = state.attempt;
  if (attempt === null || attempt.switchRequestId !== switchRequestId) return state;
  return {
    ...state,
    phase: state.activeUserId === null ? 'neutral' : 'active',
    attempt: null,
    lastFailure: 'cancelled',
  };
}

/**
 * RESTART.
 *
 * No platform-secure credential storage exists (AU-1 is open), so there is no
 * trustworthy persisted proof of who was signed in. Reopening the last active
 * member would be authentication by memory. The device returns to neutral.
 */
export const restartState = (): SwitchState => neutralSwitchState();
