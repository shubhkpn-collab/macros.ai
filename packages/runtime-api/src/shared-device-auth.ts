import {
  activateUser, cancelSwitch, completeAuthenticatedSwitch, confirmSwitchTarget,
  beginAuthentication, requestSwitch, authenticationFailed,
  type ActivationContext, type ActiveUserSession, type SwitchFailure, type SwitchState,
} from '@macros/domain-household';
import { subjectUserId, type AuthenticatedSubject } from '@macros/domain-auth';
import {
  subjectFromSession, type AppError, type AuthSession, type AuthSessionProvider,
} from '@macros/runtime-config';

/**
 * SHARED-DEVICE AUTH COORDINATOR.
 *
 * REQUEST → CONFIRM → VERIFY → AUTHORIZE → ACTIVATE.
 *
 * The coordinator OWNS the authoritative SwitchState. Passing a state snapshot
 * into async work was unsafe: while `auth.verify()` was pending the person could
 * cancel, retarget or rebind, and the old invocation still held — and would
 * commit or clear — a state that no longer existed.
 *
 * Every async boundary is therefore followed by a re-read of the CURRENT state
 * and a correlation check. The invocation carries only correlation FACTS, never
 * a state object.
 */
export const COORDINATOR_VERSION = 'shared-device-auth-coordinator@2.0.0';

/**
 * TRUSTED activation state. The coordinator trusts THIS PORT, never a request
 * body — which is why `householdId` and `bindingGeneration` are not accepted
 * from callers.
 */
export interface HouseholdActivationContextPort {
  load(deviceId: string): Promise<ActivationContext>;
}

export type SwitchOutcome =
  | { readonly kind: 'switched'; readonly state: SwitchState; readonly session: ActiveUserSession }
  | { readonly kind: 'refused'; readonly state: SwitchState; readonly reason: string };

export interface CoordinatorDeps {
  readonly auth: AuthSessionProvider;
  readonly context: HouseholdActivationContextPort;
  readonly now: () => string;
  /** How long a confirmed-but-unauthenticated attempt may remain pending. */
  readonly attemptTtlMs?: number;
}

/** Caller-supplied request facts. Deliberately NO household or generation. */
export interface SwitchRequestInput {
  readonly switchRequestId: string;
  readonly targetUserId: string;
  readonly targetDisplayName: string;
  readonly deviceId: string;
}

/**
 * The only thing an in-flight authentication carries across an await.
 *
 * Correlation facts, not state: a stale invocation can compare these against
 * whatever is current and refuse, but it can never write a stale state back.
 */
interface Correlation {
  readonly switchRequestId: string;
  readonly targetUserId: string;
  readonly sessionGeneration: number;
  readonly bindingGeneration: number;
  readonly deviceId: string;
  readonly householdId: string;
}

const isError = (v: unknown): v is AppError =>
  typeof v === 'object' && v !== null && 'kind' in v && 'code' in v;

export class SharedDeviceAuthCoordinator {
  private state: SwitchState;

  constructor(private readonly deps: CoordinatorDeps, initialState: SwitchState) {
    this.state = initialState;
  }

  getState(): SwitchState { return this.state; }

  /**
   * Phase 1 — REQUEST.
   *
   * The device binding is loaded from the TRUSTED port; a caller cannot assert
   * which household this device belongs to, nor which binding generation is in
   * force. Without a valid binding for exactly this device there is no attempt.
   */
  async request(input: SwitchRequestInput): Promise<SwitchState | { readonly error: string }> {
    const context = await this.deps.context.load(input.deviceId);
    const binding = context.binding;
    if (binding === null || binding.status !== 'bound') {
      return { error: 'device_not_bound' };
    }
    if (binding.deviceId !== input.deviceId) {
      return { error: 'wrong_device' };
    }

    // ONE COUNTER. The switch machine's sessionGeneration and the household
    // session generation must be the same number, because activation mints it
    // and the machine adopts it. If they have drifted, something else has been
    // writing a generation — fail closed rather than commit against a counter
    // that does not correspond to the authority.
    const householdGeneration = context.currentSession?.sessionGeneration ?? 0;
    if (this.state.sessionGeneration !== householdGeneration) {
      return { error: 'generation_desync' };
    }

    const requestedAt = this.deps.now();
    const ttl = this.deps.attemptTtlMs ?? 2 * 60_000;
    this.state = requestSwitch(this.state, {
      switchRequestId: input.switchRequestId,
      targetUserId: input.targetUserId,
      targetDisplayName: input.targetDisplayName,
      deviceId: input.deviceId,
      // DERIVED from the trusted binding, never from the caller.
      householdId: binding.householdId,
      bindingGeneration: binding.bindingGeneration,
      requestedAt,
      expiresAt: new Date(Date.parse(requestedAt) + ttl).toISOString(),
    });
    return this.state;
  }

  /** Phase 2 — CONFIRM. Target selection; still not authentication. */
  confirm(switchRequestId: string, targetUserId: string):
    SwitchState | { readonly error: SwitchFailure } {
    const next = confirmSwitchTarget(this.state, switchRequestId, targetUserId);
    if ('error' in next) return next;
    this.state = next;
    return this.state;
  }

  /** Cancel. The current user is untouched. */
  cancel(switchRequestId: string): SwitchState {
    this.state = cancelSwitch(this.state, switchRequestId);
    return this.state;
  }

  /**
   * Compare live state against the correlation facts captured before an await.
   *
   * Returns a reason when the attempt this result belongs to is no longer the
   * one in progress. Crucially it does NOT mutate anything: a stale B result
   * must not clear or disturb a newer C attempt.
   */
  private staleReason(c: Correlation): string | null {
    const attempt = this.state.attempt;
    if (attempt === null) return 'no_attempt_in_progress';
    if (this.state.phase !== 'awaiting_authentication') return 'not_awaiting_authentication';
    if (attempt.switchRequestId !== c.switchRequestId) return 'superseded_attempt';
    if (attempt.targetUserId !== c.targetUserId) return 'retargeted';
    if (this.state.sessionGeneration !== c.sessionGeneration) return 'generation_changed';
    if (attempt.bindingGeneration !== c.bindingGeneration) return 'binding_changed';
    return null;
  }

  /**
   * Phases 3–5. Verify the credential, authorize on this device, then commit.
   *
   * No SwitchState is accepted as an argument, and none is held across an await.
   */
  async authenticateAndActivate(
    switchRequestId: string,
    credential: string,
  ): Promise<SwitchOutcome> {
    const ready = beginAuthentication(this.state, switchRequestId);
    if ('error' in ready) {
      return { kind: 'refused', state: this.state, reason: ready.error };
    }
    const attempt = this.state.attempt;
    if (attempt === null) {
      return { kind: 'refused', state: this.state, reason: 'no_attempt_in_progress' };
    }

    // Capture correlation FACTS only.
    const correlation: Correlation = {
      switchRequestId,
      targetUserId: attempt.targetUserId,
      sessionGeneration: this.state.sessionGeneration,
      bindingGeneration: attempt.bindingGeneration ?? -1,
      deviceId: attempt.deviceId,
      householdId: attempt.householdId,
    };

    // ---------------------------- await #1 ----------------------------
    const session = await this.deps.auth.verify(credential);

    // The attempt this result belongs to may no longer be the live one.
    const afterVerify = this.staleReason(correlation);
    if (afterVerify !== null) {
      // Deliberately no mutation: a newer attempt must survive untouched.
      return { kind: 'refused', state: this.state, reason: afterVerify };
    }

    if (isError(session)) {
      this.state = authenticationFailed(this.state, switchRequestId);
      return { kind: 'refused', state: this.state, reason: session.code };
    }

    const minted = subjectFromSession(session as AuthSession, this.deps.now(), undefined);
    if (isError(minted)) {
      this.state = authenticationFailed(this.state, switchRequestId);
      return { kind: 'refused', state: this.state, reason: minted.code };
    }
    const authenticated: AuthenticatedSubject = minted;

    // A valid token for somebody else is not a licence to activate them.
    if (subjectUserId(authenticated) !== correlation.targetUserId) {
      this.state = authenticationFailed(this.state, switchRequestId);
      return { kind: 'refused', state: this.state, reason: 'target_mismatch' };
    }

    // ---------------------------- await #2 ----------------------------
    const context = await this.deps.context.load(correlation.deviceId);

    // Re-read and re-validate: cancellation and rebinding are just as possible
    // during a context load as during credential verification.
    const afterLoad = this.staleReason(correlation);
    if (afterLoad !== null) {
      return { kind: 'refused', state: this.state, reason: afterLoad };
    }
    const liveBinding = context.binding;
    if (liveBinding === null || liveBinding.status !== 'bound'
        || liveBinding.deviceId !== correlation.deviceId
        || liveBinding.householdId !== correlation.householdId
        || liveBinding.bindingGeneration !== correlation.bindingGeneration) {
      this.state = authenticationFailed(this.state, switchRequestId);
      return { kind: 'refused', state: this.state, reason: 'binding_changed' };
    }

    // ---- NO await beyond this point: authorize and commit atomically ----
    const activation = activateUser(
      {
        subject: authenticated,
        deviceId: correlation.deviceId,
        nowIso: this.deps.now(),
        // `expectedCurrentGeneration` guards the HOUSEHOLD session counter, not
        // the switch machine's. Passing the switch generation here compared two
        // different counters and refused every activation as stale. Switch
        // staleness is already enforced by staleReason() and the binding checks
        // above; this asserts only that the household session has not moved
        // since the context we are about to authorize against was read.
        expectedCurrentGeneration: context.currentSession?.sessionGeneration ?? 0,
      },
      context,
    );
    if (!activation.ok) {
      this.state = authenticationFailed(this.state, switchRequestId);
      return { kind: 'refused', state: this.state, reason: activation.reason };
    }

    const committed = completeAuthenticatedSwitch(
      this.state, switchRequestId, authenticated, activation.session,
      this.deps.now(), liveBinding.bindingGeneration);
    if ('error' in committed) {
      return { kind: 'refused', state: this.state, reason: committed.error };
    }
    this.state = committed;
    return { kind: 'switched', state: this.state, session: activation.session };
  }
}
