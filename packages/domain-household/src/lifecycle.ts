import {
  activeMemberships, membershipFor,
  type AgeEligibilityAttestation, type DeviceBinding, type HouseholdMembership,
  type SeatEntitlement,
} from './model.js';

/**
 * MEMBERSHIP, SEAT AND OWNERSHIP LIFECYCLE.
 *
 * PURE. Every operation fails closed and returns a machine-readable reason
 * rather than throwing, so the application can explain a refusal.
 */
export const HOUSEHOLD_LIFECYCLE_VERSION = 'household-lifecycle@1.0.0';

export type LifecycleError =
  | 'not_owner'
  | 'no_such_membership'
  | 'already_member'
  | 'seat_capacity_exceeded'
  | 'seat_suspended'
  | 'age_eligibility_required'
  | 'would_leave_household_ownerless'
  | 'cannot_remove_self_as_only_owner'
  | 'household_dissolved';

export type LifecycleResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: LifecycleError };

const fail = <T>(error: LifecycleError): LifecycleResult<T> => ({ ok: false, error });
const ok = <T>(value: T): LifecycleResult<T> => ({ ok: true, value });

/** Seats bound only to capacity — no payment provider, no price in the domain. */
export function canActivateAnotherMember(
  memberships: readonly HouseholdMembership[],
  seat: SeatEntitlement,
): LifecycleResult<true> {
  if (seat.state !== 'active') return fail('seat_suspended');
  const used = activeMemberships(memberships, seat.householdId).length;
  return used >= seat.capacity ? fail('seat_capacity_exceeded') : ok(true);
}

export function activateMembership(
  memberships: readonly HouseholdMembership[],
  householdId: string,
  userId: string,
  seat: SeatEntitlement,
  eligibility: AgeEligibilityAttestation | undefined,
  at: string,
): LifecycleResult<readonly HouseholdMembership[]> {
  const existing = membershipFor(memberships, householdId, userId);
  if (existing?.status === 'active') return fail('already_member');
  // 18+ only. Activation fails closed without an attestation.
  if (eligibility?.attested !== true) return fail('age_eligibility_required');

  const capacity = canActivateAnotherMember(memberships, seat);
  if (!capacity.ok) return fail(capacity.error);

  const next: HouseholdMembership = {
    householdId, userId, role: existing?.role ?? 'member',
    status: 'active', joinedAt: at, ageEligibility: eligibility,
  };
  return ok([...memberships.filter((m) => !(m.householdId === householdId && m.userId === userId)), next]);
}

/**
 * Removal ends household access. It NEVER deletes food logs — those belong to
 * the user, not the household, and survive the membership entirely.
 */
export function removeMembership(
  memberships: readonly HouseholdMembership[],
  householdId: string,
  actorUserId: string,
  targetUserId: string,
  at: string,
): LifecycleResult<readonly HouseholdMembership[]> {
  const actor = membershipFor(memberships, householdId, actorUserId);
  if (actor === null || actor.status !== 'active' || actor.role !== 'owner') return fail('not_owner');
  const target = membershipFor(memberships, householdId, targetUserId);
  if (target === null || target.status !== 'active') return fail('no_such_membership');

  if (target.role === 'owner') {
    const owners = activeMemberships(memberships, householdId).filter((m) => m.role === 'owner');
    // A household must never silently become ownerless.
    if (owners.length <= 1) {
      return fail(actorUserId === targetUserId
        ? 'cannot_remove_self_as_only_owner'
        : 'would_leave_household_ownerless');
    }
  }
  return ok(memberships.map((m) =>
    m.householdId === householdId && m.userId === targetUserId
      ? { ...m, status: 'removed' as const, endedAt: at }
      : m));
}

/** Deterministic transfer — the only way a sole owner may step down. */
export function transferOwnership(
  memberships: readonly HouseholdMembership[],
  householdId: string,
  fromUserId: string,
  toUserId: string,
): LifecycleResult<readonly HouseholdMembership[]> {
  const from = membershipFor(memberships, householdId, fromUserId);
  if (from === null || from.status !== 'active' || from.role !== 'owner') return fail('not_owner');
  const to = membershipFor(memberships, householdId, toUserId);
  if (to === null || to.status !== 'active') return fail('no_such_membership');

  return ok(memberships.map((m) => {
    if (m.householdId !== householdId) return m;
    if (m.userId === toUserId) return { ...m, role: 'owner' as const };
    if (m.userId === fromUserId) return { ...m, role: 'member' as const };
    return m;
  }));
}

/**
 * Dissolution ends memberships and unbinds devices. It does NOT delete personal
 * nutrition history and does not merge anyone's private data.
 */
export function dissolveHousehold(
  memberships: readonly HouseholdMembership[],
  devices: readonly DeviceBinding[],
  householdId: string,
  at: string,
): {
  readonly memberships: readonly HouseholdMembership[];
  readonly devices: readonly DeviceBinding[];
} {
  return {
    memberships: memberships.map((m) =>
      m.householdId === householdId && m.status === 'active'
        ? { ...m, status: 'removed' as const, endedAt: at } : m),
    devices: devices.map((d) =>
      d.householdId === householdId
        ? { ...d, status: 'unbound' as const, bindingGeneration: d.bindingGeneration + 1 } : d),
  };
}

/** Rebinding advances the generation so stale household context cannot survive. */
export function rebindDevice(
  binding: DeviceBinding | null,
  deviceId: string,
  householdId: string,
  at: string,
): DeviceBinding {
  return {
    deviceId, householdId, status: 'bound', boundAt: at,
    bindingGeneration: (binding?.bindingGeneration ?? 0) + 1,
  };
}
