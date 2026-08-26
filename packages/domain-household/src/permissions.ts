import { membershipFor, type HouseholdMembership } from './model.js';

/**
 * PRIVACY PERMISSION MATRIX.
 *
 * DEFAULT DENY. The governing invariant:
 *
 *   ADMINISTRATIVE AUTHORITY IS NOT DATA ACCESS.
 *
 * An owner can remove a member or manage a seat without ever being able to read
 * that member's food logs, weight, goals or energy state. Household admin and
 * nutrition privacy are different powers, and conflating them would make the
 * appliance unusable for any adult who does not want their eating visible to
 * whoever set up the device.
 */
export const PERMISSION_POLICY_VERSION = 'household-permissions@1.0.0';

export type Resource =
  | 'household_metadata'
  | 'membership_list'
  | 'member_selector_identity'
  | 'seat_state'
  | 'device_binding'
  | 'food_logs'
  | 'weight'
  | 'goals'
  | 'energy_state'
  | 'recommendations'
  | 'offline_outbox'
  | 'wearable_data'
  | 'personal_preferences';

export type Action = 'read' | 'write';

/** Personal resources are readable ONLY by their own subject. Never by an owner. */
export const PRIVATE_RESOURCES: readonly Resource[] = [
  'food_logs', 'weight', 'goals', 'energy_state',
  'recommendations', 'offline_outbox', 'wearable_data', 'personal_preferences',
];

/** Household administration — owner-only, and carrying no data access. */
const OWNER_ADMIN_RESOURCES: readonly Resource[] = ['seat_state', 'device_binding'];

export interface AccessRequest {
  readonly actorUserId: string;
  readonly householdId: string;
  /** The subject whose data is being touched. Null for household-level rows. */
  readonly targetUserId: string | null;
  readonly resource: Resource;
  readonly action: Action;
}

export type AccessDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: DenialReason };

export type DenialReason =
  | 'no_active_membership'
  | 'private_to_other_user'
  | 'requires_owner'
  | 'unknown_resource'
  | 'household_dissolved';

export function decideAccess(
  request: AccessRequest,
  memberships: readonly HouseholdMembership[],
  householdDissolved = false,
): AccessDecision {
  if (householdDissolved) return { allowed: false, reason: 'household_dissolved' };

  const actor = membershipFor(memberships, request.householdId, request.actorUserId);
  // A removed member loses household access entirely — but keeps their own data.
  if (actor === null || actor.status !== 'active') {
    return { allowed: false, reason: 'no_active_membership' };
  }

  if (PRIVATE_RESOURCES.includes(request.resource)) {
    // THE INVARIANT. Role is not consulted at all here: being owner grants
    // exactly nothing over another adult's nutrition.
    return request.targetUserId === request.actorUserId
      ? { allowed: true }
      : { allowed: false, reason: 'private_to_other_user' };
  }

  switch (request.resource) {
    case 'household_metadata':
      // Members read shared metadata; only an owner may change it.
      return request.action === 'read' || actor.role === 'owner'
        ? { allowed: true }
        : { allowed: false, reason: 'requires_owner' };

    case 'membership_list':
    case 'member_selector_identity':
      // Names only — the selector deliberately carries no personal state.
      return request.action === 'read'
        ? { allowed: true }
        : actor.role === 'owner'
          ? { allowed: true }
          : { allowed: false, reason: 'requires_owner' };

    default:
      if (OWNER_ADMIN_RESOURCES.includes(request.resource)) {
        return actor.role === 'owner'
          ? { allowed: true }
          : { allowed: false, reason: 'requires_owner' };
      }
      return { allowed: false, reason: 'unknown_resource' };
  }
}

/**
 * Administrative capability, kept explicitly separate from data access so the
 * two can never be confused at a call site.
 */
export function canAdminister(
  actorUserId: string,
  householdId: string,
  memberships: readonly HouseholdMembership[],
): boolean {
  const actor = membershipFor(memberships, householdId, actorUserId);
  return actor !== null && actor.status === 'active' && actor.role === 'owner';
}
