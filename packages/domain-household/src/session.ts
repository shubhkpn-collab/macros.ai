import { subjectUserId, type AuthenticatedSubject } from '@macros/domain-auth';
import {
  activeMemberships, membershipFor, memberSelector,
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
  | 'wrong_device'
  | 'seat_household_mismatch'
  | 'seat_capacity_exceeded'
  | 'stale_generation'
  | 'membership_snapshot_invalid'
  | 'membership_snapshot_superseded'
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
  /**
   * The device binding generation in force when this snapshot was captured.
   *
   * Rebinding advances the generation, so a snapshot captured under an OLD
   * binding must not survive it — otherwise a device unbound from a household
   * and rebound elsewhere could still activate the previous household's members
   * offline from a stale cache.
   */
  readonly bindingGeneration: number;
}

/**
 * Activation takes the SUBJECT CAPABILITY, not identity strings.
 *
 * The old shape accepted `userId` and `authenticatedSubjectId` independently
 * and compared them — two matching strings a caller could simply supply.
 * Authentication provenance is now structural: the only way to name the user is
 * to hold a subject that was actually minted.
 */
export interface ActivationRequest {
  readonly subject: AuthenticatedSubject;
  readonly deviceId: string;
  readonly nowIso: string;
  /**
   * The generation the caller believes is current. Activation is the SINGLE
   * generation authority, so it refuses to advance from a stale view.
   */
  readonly expectedCurrentGeneration?: number;
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

/**
 * THE SINGLE HOUSEHOLD/DEVICE AUTHORIZATION AUTHORITY.
 *
 * Authentication proved WHO. This decides whether that person may become active
 * on THIS bound device in THIS household — and it is also the one place that
 * mints the next session generation.
 */
export function activateUser(
  request: ActivationRequest,
  context: ActivationContext,
): ActivationResult {
  const { binding } = context;
  const userId = subjectUserId(request.subject);

  if (binding === null || binding.status !== 'bound') {
    return { ok: false, reason: 'device_not_bound' };
  }
  // EXACT device identity. A binding for some other device is not authorization
  // for this one, and the previous online path never checked it.
  if (binding.deviceId !== request.deviceId) {
    return { ok: false, reason: 'wrong_device' };
  }
  // Refuse to advance from a stale view of the generation.
  if (request.expectedCurrentGeneration !== undefined
      && request.expectedCurrentGeneration !== (context.currentSession?.sessionGeneration ?? 0)) {
    return { ok: false, reason: 'stale_generation' };
  }

  const membership = membershipFor(context.memberships, binding.householdId, userId);
  if (membership === null) return { ok: false, reason: 'wrong_household' };
  if (membership.status !== 'active') return { ok: false, reason: 'no_active_membership' };
  if (membership.ageEligibility?.attested !== true) {
    return { ok: false, reason: 'age_eligibility_required' };
  }
  if (context.seat !== null) {
    // A seat record for a DIFFERENT household authorizes nothing here.
    if (context.seat.householdId !== binding.householdId) {
      return { ok: false, reason: 'seat_household_mismatch' };
    }
    if (context.seat.state !== 'active') return { ok: false, reason: 'seat_suspended' };
    // CAPACITY, not just state. `canActivateAnotherMember` enforced this when a
    // membership was created, but activation only ever checked `state` — so a
    // household over capacity (seats reduced after the fact) could still
    // activate every member. Existing actives are counted, so an already-active
    // member re-activating is never blocked by their own seat.
    const activeCount = activeMemberships(context.memberships, binding.householdId).length;
    if (activeCount > context.seat.capacity) {
      return { ok: false, reason: 'seat_capacity_exceeded' };
    }
  }

  if (context.offline) {
    const snap = context.snapshot;
    if (snap === undefined) return { ok: false, reason: 'not_authorized_on_this_device' };

    // STRUCTURAL VALIDATION. A snapshot is cached data, so its shape is not
    // guaranteed by the type system at runtime; a corrupt or truncated record
    // must fail closed rather than read `undefined` off a field.
    if (typeof snap.deviceId !== 'string' || typeof snap.householdId !== 'string'
        || typeof snap.expiresAt !== 'string' || typeof snap.capturedAt !== 'string'
        || typeof snap.snapshotVersion !== 'number'
        || !Number.isFinite(snap.snapshotVersion)
        || typeof snap.bindingGeneration !== 'number'
        || !Number.isFinite(snap.bindingGeneration)
        || !Array.isArray(snap.authorizedUserIds)
        || snap.authorizedUserIds.some((id) => typeof id !== 'string')) {
      return { ok: false, reason: 'membership_snapshot_invalid' };
    }
    const expiresMs = Date.parse(snap.expiresAt);
    const capturedMs = Date.parse(snap.capturedAt);
    if (!Number.isFinite(expiresMs) || !Number.isFinite(capturedMs)
        || capturedMs > expiresMs) {
      return { ok: false, reason: 'membership_snapshot_invalid' };
    }

    if (snap.deviceId !== request.deviceId || snap.householdId !== binding.householdId) {
      return { ok: false, reason: 'not_authorized_on_this_device' };
    }

    // BINDING CONTINUITY. A snapshot captured under an earlier binding is
    // superseded: rebinding is exactly the event that should invalidate cached
    // household authorization.
    if (snap.bindingGeneration !== binding.bindingGeneration) {
      return { ok: false, reason: 'membership_snapshot_superseded' };
    }
    // Honest about revocation: we cannot learn offline that the server removed
    // someone, so cached authorisation is bounded by an explicit expiry rather
    // than pretending revocation is instant.
    const nowMs = Date.parse(request.nowIso);
    if (!Number.isFinite(nowMs)) return { ok: false, reason: 'membership_snapshot_invalid' };
    if (nowMs >= expiresMs) {
      return { ok: false, reason: 'membership_snapshot_expired' };
    }
    if (!snap.authorizedUserIds.includes(userId)) {
      return { ok: false, reason: 'not_authorized_on_this_device' };
    }
  }

  return {
    ok: true,
    session: {
      householdId: binding.householdId,
      userId,
      deviceId: request.deviceId,
      // ONE generation, shared with the voice delivery boundary. It always
      // advances, so A → B → A produces a third distinct generation and work
      // captured in A's first session can never execute in A's second.
      sessionGeneration: (context.currentSession?.sessionGeneration ?? 0) + 1,
      startedAt: request.nowIso,
      lastActivityAt: request.nowIso,
      ...(request.subject.assuranceLevel !== undefined
        ? { assuranceLevel: request.subject.assuranceLevel } : {}),
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
