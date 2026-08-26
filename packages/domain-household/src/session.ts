import {
  membershipFor, memberSelector,
  type ActiveUserSession, type DeviceBinding, type HouseholdMembership,
  type MemberSelectorEntry, type SeatEntitlement,
} from './model.js';

/**
 * SHARED-DEVICE ACTIVE USER SESSIONS.
 *
 * The device may have NO active user or exactly one. Knowing a userId is never
 * sufficient to become active: activation is checked against device binding,
 * active membership, the 18+ gate and seat entitlement, and fails closed.
 */
export const SESSION_POLICY_VERSION = 'device-session@1.0.0';

export type ActivationDenial =
  | 'device_not_bound'
  | 'wrong_household'
  | 'no_active_membership'
  | 'age_eligibility_required'
  | 'seat_suspended'
  | 'membership_snapshot_expired'
  | 'not_authorized_on_this_device';

export type ActivationResult =
  | { readonly ok: true; readonly session: ActiveUserSession }
  | { readonly ok: false; readonly reason: ActivationDenial };

/**
 * The last trusted membership snapshot cached on the device.
 *
 * Offline activation is permitted only for users who were ALREADY authorised
 * here. New members can never be added offline, and this is emphatically not
 * authentication — it is a cached authorisation list with an expiry.
 */
export interface MembershipSnapshot {
  readonly householdId: string;
  readonly deviceId: string;
  readonly capturedAt: string;
  readonly expiresAt: string;
  readonly snapshotVersion: number;
  readonly authorizedUserIds: readonly string[];
}

export interface ActivationRequest {
  readonly deviceId: string;
  readonly userId: string;
  /** From the auth boundary. A caller may never supply this itself. */
  readonly authenticatedSubjectId: string;
  readonly nowIso: string;
}

export interface ActivationContext {
  readonly binding: DeviceBinding | null;
  readonly memberships: readonly HouseholdMembership[];
  readonly seat: SeatEntitlement | null;
  readonly currentSession: ActiveUserSession | null;
  /** Present when operating offline against cached authorisation. */
  readonly snapshot?: MembershipSnapshot;
  readonly offline: boolean;
}

export function activateUser(
  request: ActivationRequest,
  context: ActivationContext,
): ActivationResult {
  const { binding } = context;
  if (binding === null || binding.status !== 'bound') {
    return { ok: false, reason: 'device_not_bound' };
  }
  // Identity comes from the verified session, never from the request body.
  if (request.userId !== request.authenticatedSubjectId) {
    return { ok: false, reason: 'not_authorized_on_this_device' };
  }

  const membership = membershipFor(context.memberships, binding.householdId, request.userId);
  if (membership === null) return { ok: false, reason: 'wrong_household' };
  if (membership.status !== 'active') return { ok: false, reason: 'no_active_membership' };
  if (membership.ageEligibility?.attested !== true) {
    return { ok: false, reason: 'age_eligibility_required' };
  }
  if (context.seat !== null && context.seat.state !== 'active') {
    return { ok: false, reason: 'seat_suspended' };
  }

  if (context.offline) {
    const snap = context.snapshot;
    if (snap === undefined || snap.deviceId !== request.deviceId
        || snap.householdId !== binding.householdId) {
      return { ok: false, reason: 'not_authorized_on_this_device' };
    }
    // Honest about revocation: we cannot learn offline that the server removed
    // someone, so cached authorisation is bounded by an explicit expiry rather
    // than pretending revocation is instant.
    if (Date.parse(request.nowIso) >= Date.parse(snap.expiresAt)) {
      return { ok: false, reason: 'membership_snapshot_expired' };
    }
    if (!snap.authorizedUserIds.includes(request.userId)) {
      return { ok: false, reason: 'not_authorized_on_this_device' };
    }
  }

  return {
    ok: true,
    session: {
      householdId: binding.householdId,
      userId: request.userId,
      deviceId: request.deviceId,
      // ONE generation, shared with the voice delivery boundary. It always
      // advances, so A → B → A produces a third distinct generation and work
      // captured in A's first session can never execute in A's second.
      sessionGeneration: (context.currentSession?.sessionGeneration ?? 0) + 1,
      startedAt: request.nowIso,
      lastActivityAt: request.nowIso,
    },
  };
}

/** Ending a session returns the device to neutral. Confirmed logs are untouched. */
export function endSession(): null { return null; }

export interface InactivityPolicy {
  readonly version: string;
  readonly inactivityMs: number;
}

export const isExpired = (
  session: ActiveUserSession, nowIso: string, policy: InactivityPolicy,
): boolean =>
  Date.parse(nowIso) - Date.parse(session.lastActivityAt) >= policy.inactivityMs;

/**
 * NEUTRAL STATE.
 *
 * With no active user the device must reveal nothing personal — not the last
 * user's calories, goals, history or pending sync. Every personal read refuses.
 */
export type NeutralRefusal = 'no_active_user';

export interface NeutralState {
  readonly householdId: string | null;
  readonly householdDisplayName: string | null;
  readonly memberSelector: readonly MemberSelectorEntry[];
}

export function neutralState(
  binding: DeviceBinding | null,
  household: { displayName: string } | null,
  memberships: readonly HouseholdMembership[],
  displayNames: Readonly<Record<string, string>>,
): NeutralState {
  if (binding === null || binding.status !== 'bound') {
    return { householdId: null, householdDisplayName: null, memberSelector: [] };
  }
  return {
    householdId: binding.householdId,
    householdDisplayName: household?.displayName ?? null,
    // Names and roles only — deliberately no weight, goals or history.
    memberSelector: memberSelector(memberships, binding.householdId, displayNames),
  };
}
