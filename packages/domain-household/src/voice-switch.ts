import { memberSelector, type HouseholdMembership, type MemberSelectorEntry } from './model.js';

/**
 * VOICE USER SWITCHING (AS-5).
 *
 * A model may recognise the NAME a person said. It may never supply a userId,
 * a householdId, a permission or an authorisation — trusted household
 * membership resolution supplies all of those.
 *
 * Saying "I'm John" is a REQUEST, not authentication. There are no voiceprints,
 * no speaker recognition and no inference of identity from a voice; explicit
 * confirmation is always required.
 */
export const VOICE_SWITCH_POLICY = 'household-voice-switch@1.0.0';

export type SwitchResolution =
  | { readonly kind: 'resolved'; readonly candidate: MemberSelectorEntry }
  | { readonly kind: 'ambiguous'; readonly candidates: readonly MemberSelectorEntry[] }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'no_household' };

/**
 * Resolve a spoken name against ACTIVE memberships only.
 *
 * A household can legitimately contain two people called Alex, so a display
 * name is not identity: an ambiguous name returns candidates for the user to
 * choose between rather than letting anything guess.
 */
export function resolveSwitchRequest(
  spokenName: string,
  householdId: string | null,
  memberships: readonly HouseholdMembership[],
  displayNames: Readonly<Record<string, string>>,
): SwitchResolution {
  if (householdId === null) return { kind: 'no_household' };
  const needle = spokenName.trim().toLowerCase();
  if (needle.length === 0) return { kind: 'not_found' };

  const all = memberSelector(memberships, householdId, displayNames);
  const matches = all.filter((m) => m.displayName.toLowerCase() === needle);
  const loose = matches.length > 0
    ? matches
    : all.filter((m) => m.displayName.toLowerCase().startsWith(needle));

  if (loose.length === 0) return { kind: 'not_found' };
  if (loose.length > 1) return { kind: 'ambiguous', candidates: loose };
  return { kind: 'resolved', candidate: loose[0]! };
}

/**
 * A pending switch awaiting EXPLICIT confirmation.
 *
 * Nothing changes until `confirm_user_switch` arrives: recognising the request
 * never mutates the active user.
 */
export interface PendingUserSwitch {
  readonly requestedByUserId: string;
  readonly targetUserId: string;
  readonly targetDisplayName: string;
  readonly requestedAt: string;
  readonly sessionGeneration: number;
}

export type SwitchConfirmation =
  | { readonly ok: true; readonly targetUserId: string }
  | { readonly ok: false; readonly reason: 'no_pending_switch' | 'stale_session' | 'target_mismatch' };

/**
 * Confirm a pending switch.
 *
 * The confirmation must name the same target and belong to the same session
 * generation the request was made in — otherwise a stale confirmation could
 * activate the wrong person.
 */
export function confirmSwitch(
  pending: PendingUserSwitch | null,
  confirmedTargetUserId: string,
  currentSessionGeneration: number,
): SwitchConfirmation {
  if (pending === null) return { ok: false, reason: 'no_pending_switch' };
  if (pending.sessionGeneration !== currentSessionGeneration) {
    return { ok: false, reason: 'stale_session' };
  }
  if (pending.targetUserId !== confirmedTargetUserId) {
    return { ok: false, reason: 'target_mismatch' };
  }
  return { ok: true, targetUserId: pending.targetUserId };
}
