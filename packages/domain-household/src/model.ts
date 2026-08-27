/**
 * HOUSEHOLD IDENTITY.
 *
 * A user is a GLOBAL identity who JOINS a household through membership. The
 * household does not own the person: leaving or joining changes a membership
 * row, never the user's identity and never their nutrition history.
 *
 * `owner` is household ADMINISTRATION — devices, seats, invitations. It confers
 * no visibility whatsoever into another adult's nutrition, weight or goals.
 */
export const HOUSEHOLD_DOMAIN_VERSION = 'household@1.0.0';

export type HouseholdRole = 'owner' | 'member';

/** Deliberately small. No minor role exists — the product is 18+ only. */
export type MembershipStatus = 'invited' | 'active' | 'removed';

export interface Household {
  readonly householdId: string;
  readonly displayName: string;
  readonly createdAt: string;
  readonly dissolvedAt?: string;
}

export interface HouseholdMembership {
  readonly householdId: string;
  readonly userId: string;
  readonly role: HouseholdRole;
  readonly status: MembershipStatus;
  readonly joinedAt: string;
  readonly endedAt?: string;
  /**
   * 18+ attestation. We store THAT eligibility was attested and under which
   * policy — never a date of birth, which we have no other need for.
   */
  readonly ageEligibility?: AgeEligibilityAttestation;
}

export interface AgeEligibilityAttestation {
  readonly attested: true;
  readonly policyVersion: string;
  readonly attestedAt: string;
}

/**
 * Seat entitlement, expressed purely as capacity.
 *
 * Deliberately free of any payment provider or price: the domain only needs to
 * answer "may this household activate another member?". Billing decides grace
 * periods and restrictions later, and a lapsed subscription must never be
 * inferred here as "delete the member".
 */
export interface SeatEntitlement {
  readonly householdId: string;
  readonly capacity: number;
  readonly state: 'active' | 'suspended';
}

export interface DeviceBinding {
  readonly deviceId: string;
  readonly householdId: string;
  readonly status: 'bound' | 'unbound';
  readonly boundAt: string;
  /** Advances on every rebind so stale household context cannot survive. */
  readonly bindingGeneration: number;
}

export interface ActiveUserSession {
  readonly householdId: string;
  readonly userId: string;
  readonly deviceId: string;
  /** Shared with the voice delivery boundary — one generation, not two. */
  readonly sessionGeneration: number;
  readonly startedAt: string;
  readonly lastActivityAt: string;
  /** Recorded for observability. Never consulted for authorization. */
  readonly assuranceLevel?: string;
}

export const activeMemberships = (
  memberships: readonly HouseholdMembership[],
  householdId: string,
): readonly HouseholdMembership[] =>
  memberships.filter((m) => m.householdId === householdId && m.status === 'active');

export const membershipFor = (
  memberships: readonly HouseholdMembership[],
  householdId: string,
  userId: string,
): HouseholdMembership | null =>
  memberships.find((m) => m.householdId === householdId && m.userId === userId) ?? null;

/** Household-safe selector data. Deliberately excludes all personal state. */
export interface MemberSelectorEntry {
  readonly userId: string;
  readonly displayName: string;
  readonly role: HouseholdRole;
}

export function memberSelector(
  memberships: readonly HouseholdMembership[],
  householdId: string,
  displayNames: Readonly<Record<string, string>>,
): readonly MemberSelectorEntry[] {
  return activeMemberships(memberships, householdId)
    .map((m) => ({
      userId: m.userId,
      displayName: displayNames[m.userId] ?? 'Member',
      role: m.role,
    }))
    .sort((a, b) => a.displayName.localeCompare(b.displayName) || a.userId.localeCompare(b.userId));
}
