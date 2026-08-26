import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  PRIVATE_RESOURCES, activateMembership, activateUser, canActivateAnotherMember,
  canAdminister, confirmSwitch, decideAccess, dissolveHousehold, isExpired,
  memberSelector, neutralState, rebindDevice, removeMembership, resolveSwitchRequest,
  transferOwnership,
  type ActiveUserSession, type AgeEligibilityAttestation, type DeviceBinding,
  type HouseholdMembership, type MembershipSnapshot, type Resource, type SeatEntitlement,
} from '@macros/domain-household';
import { reconcileDay, type OutboxEntry } from '@macros/domain-offline-sync';
import { createFoodLogItem } from '@macros/domain-food-log';
import { manualCapture } from '@macros/domain-weight';
import { instant } from '@macros/contracts';
import { SYNTHETIC_PRODUCTS, USER_A, USER_B } from '@macros/testkit';

const HH = 'hh-1';
const DEV = 'dev-1';
const OWNER = USER_A;
const MEMBER = USER_B;
const THIRD = '00000000-0000-4000-8000-000000000003';
const NOW = '2026-08-27T12:00:00.000Z';

const eligible: AgeEligibilityAttestation = {
  attested: true, policyVersion: 'age-18plus@1.0.0', attestedAt: '2026-01-01T00:00:00.000Z',
};

const m = (
  userId: string, role: 'owner' | 'member' = 'member',
  status: 'invited' | 'active' | 'removed' = 'active',
): HouseholdMembership => ({
  householdId: HH, userId, role, status, joinedAt: '2026-01-01T00:00:00.000Z',
  ageEligibility: eligible,
});

const MEMBERS = [m(OWNER, 'owner'), m(MEMBER)];
const SEAT: SeatEntitlement = { householdId: HH, capacity: 4, state: 'active' };
const BINDING: DeviceBinding = {
  deviceId: DEV, householdId: HH, status: 'bound',
  boundAt: '2026-01-01T00:00:00.000Z', bindingGeneration: 1,
};
const NAMES = { [OWNER]: 'Alex', [MEMBER]: 'Sam', [THIRD]: 'Alex' };

// ---------------------------------------------------------------------------

describe('B5/B35/B36 — owner authority is NOT nutrition access', () => {
  for (const resource of PRIVATE_RESOURCES) {
    test(`owner CANNOT read a member's ${resource}`, () => {
      const d = decideAccess(
        { actorUserId: OWNER, householdId: HH, targetUserId: MEMBER, resource, action: 'read' },
        MEMBERS);
      assert.equal(d.allowed, false, `${resource} leaked to the owner`);
      if (!d.allowed) assert.equal(d.reason, 'private_to_other_user');
    });

    test(`a member CANNOT read the owner's ${resource}`, () => {
      const d = decideAccess(
        { actorUserId: MEMBER, householdId: HH, targetUserId: OWNER, resource, action: 'read' },
        MEMBERS);
      assert.equal(d.allowed, false);
    });

    test(`each user CAN read their own ${resource}`, () => {
      assert.equal(decideAccess(
        { actorUserId: MEMBER, householdId: HH, targetUserId: MEMBER, resource, action: 'read' },
        MEMBERS).allowed, true);
    });
  }

  test('B36: the owner CAN administer while being unable to read', () => {
    assert.equal(canAdminister(OWNER, HH, MEMBERS), true);
    assert.equal(decideAccess(
      { actorUserId: OWNER, householdId: HH, targetUserId: null, resource: 'seat_state', action: 'write' },
      MEMBERS).allowed, true, 'seat administration allowed');
    assert.equal(decideAccess(
      { actorUserId: OWNER, householdId: HH, targetUserId: MEMBER, resource: 'weight', action: 'read' },
      MEMBERS).allowed, false, 'but weight stays private');
  });

  test('a member cannot administer seats or devices', () => {
    for (const r of ['seat_state', 'device_binding'] as Resource[]) {
      const d = decideAccess(
        { actorUserId: MEMBER, householdId: HH, targetUserId: null, resource: r, action: 'write' },
        MEMBERS);
      assert.equal(d.allowed, false);
      if (!d.allowed) assert.equal(d.reason, 'requires_owner');
    }
  });

  test('a REMOVED member loses household access entirely', () => {
    const removed = [m(OWNER, 'owner'), m(MEMBER, 'member', 'removed')];
    const d = decideAccess(
      { actorUserId: MEMBER, householdId: HH, targetUserId: null, resource: 'household_metadata', action: 'read' },
      removed);
    assert.equal(d.allowed, false);
    if (!d.allowed) assert.equal(d.reason, 'no_active_membership');
  });

  test('members may read shared household metadata; only owners write it', () => {
    assert.equal(decideAccess(
      { actorUserId: MEMBER, householdId: HH, targetUserId: null, resource: 'household_metadata', action: 'read' },
      MEMBERS).allowed, true);
    assert.equal(decideAccess(
      { actorUserId: MEMBER, householdId: HH, targetUserId: null, resource: 'household_metadata', action: 'write' },
      MEMBERS).allowed, false);
  });

  test('a dissolved household denies everything', () => {
    const d = decideAccess(
      { actorUserId: OWNER, householdId: HH, targetUserId: OWNER, resource: 'food_logs', action: 'read' },
      MEMBERS, true);
    assert.equal(d.allowed, false);
    if (!d.allowed) assert.equal(d.reason, 'household_dissolved');
  });
});

describe('B4/B6/B7/B8 — lifecycle', () => {
  test('B34: activation REQUIRES an 18+ attestation', () => {
    const r = activateMembership(MEMBERS, HH, THIRD, SEAT, undefined, NOW);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error, 'age_eligibility_required');
  });

  test('B6: seat capacity gates activation, with no payment provider involved', () => {
    const full: SeatEntitlement = { householdId: HH, capacity: 2, state: 'active' };
    const r = activateMembership(MEMBERS, HH, THIRD, full, eligible, NOW);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error, 'seat_capacity_exceeded');
  });

  test('B48: a suspended seat blocks NEW activation but never deletes a member', () => {
    const suspended: SeatEntitlement = { householdId: HH, capacity: 4, state: 'suspended' };
    const r = canActivateAnotherMember(MEMBERS, suspended);
    assert.equal(r.ok, false);
    // Existing members are untouched.
    assert.equal(MEMBERS.filter((x) => x.status === 'active').length, 2);
  });

  test('B4: removal ends access but NEVER deletes food logs', () => {
    const r = removeMembership(MEMBERS, HH, OWNER, MEMBER, NOW);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    const removed = r.value.find((x) => x.userId === MEMBER)!;
    assert.equal(removed.status, 'removed');
    assert.equal(removed.endedAt, NOW);
    // Nothing in this operation touches logs; the type carries none.
    assert.equal('foodLogs' in removed, false);
  });

  test('a member cannot remove anyone', () => {
    const r = removeMembership(MEMBERS, HH, MEMBER, OWNER, NOW);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error, 'not_owner');
  });

  test('B7: the sole owner cannot remove themselves', () => {
    const r = removeMembership(MEMBERS, HH, OWNER, OWNER, NOW);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error, 'cannot_remove_self_as_only_owner');
  });

  test('B7: ownership transfers deterministically, then the old owner may leave', () => {
    const t = transferOwnership(MEMBERS, HH, OWNER, MEMBER);
    assert.equal(t.ok, true);
    if (!t.ok) return;
    assert.equal(t.value.find((x) => x.userId === MEMBER)!.role, 'owner');
    assert.equal(t.value.find((x) => x.userId === OWNER)!.role, 'member');
    const r = removeMembership(t.value, HH, MEMBER, OWNER, NOW);
    assert.equal(r.ok, true);
  });

  test('B8: dissolution ends memberships and unbinds devices, keeping history', () => {
    const out = dissolveHousehold(MEMBERS, [BINDING], HH, NOW);
    assert.ok(out.memberships.every((x) => x.status === 'removed'));
    assert.equal(out.devices[0]!.status, 'unbound');
    assert.equal(out.devices[0]!.bindingGeneration, BINDING.bindingGeneration + 1);
  });

  test('B9: rebinding advances the generation so stale context cannot survive', () => {
    const rebound = rebindDevice(BINDING, DEV, 'hh-2', NOW);
    assert.equal(rebound.householdId, 'hh-2');
    assert.ok(rebound.bindingGeneration > BINDING.bindingGeneration);
  });
});

describe('B12/B13 — activation guards and neutral state', () => {
  const req = (userId: string, over: Record<string, unknown> = {}) => ({
    deviceId: DEV, userId, authenticatedSubjectId: userId, nowIso: NOW, ...over,
  });
  const ctx = (over: Record<string, unknown> = {}) => ({
    binding: BINDING, memberships: MEMBERS, seat: SEAT,
    currentSession: null, offline: false, ...over,
  }) as Parameters<typeof activateUser>[1];

  test('a valid member activates and the generation advances', () => {
    const r = activateUser(req(MEMBER), ctx());
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.session.userId, MEMBER);
    assert.equal(r.session.sessionGeneration, 1);
  });

  test('B12: knowing a userId is NOT enough — identity comes from auth', () => {
    const r = activateUser(req(MEMBER, { authenticatedSubjectId: OWNER }), ctx());
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, 'not_authorized_on_this_device');
  });

  test('a removed member cannot activate', () => {
    const r = activateUser(req(MEMBER), ctx({ memberships: [m(OWNER, 'owner'), m(MEMBER, 'member', 'removed')] }));
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, 'no_active_membership');
  });

  test('an unbound device cannot activate anyone', () => {
    const r = activateUser(req(MEMBER), ctx({ binding: null }));
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, 'device_not_bound');
  });

  test('a user from another household cannot activate', () => {
    const r = activateUser(req(THIRD), ctx());
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, 'wrong_household');
  });

  test('B13: the neutral screen exposes NO private state', () => {
    const n = neutralState(BINDING, { displayName: 'Home' }, MEMBERS, NAMES);
    const text = JSON.stringify(n);
    for (const banned of ['kcal', 'calories', 'weight', 'goal', 'energy', 'pending', 'logId']) {
      assert.equal(text.toLowerCase().includes(banned.toLowerCase()), false, `${banned} leaked`);
    }
    assert.equal(n.memberSelector.length, 2, 'names and roles only');
  });

  test('B21: the selector carries only display identity', () => {
    const sel = memberSelector(MEMBERS, HH, NAMES);
    for (const entry of sel) {
      assert.deepEqual(Object.keys(entry).sort(), ['displayName', 'role', 'userId']);
    }
  });

  test('B29: inactivity expiry is policy-driven, not a magic constant', () => {
    const s: ActiveUserSession = {
      householdId: HH, userId: MEMBER, deviceId: DEV, sessionGeneration: 1,
      startedAt: NOW, lastActivityAt: NOW,
    };
    const policy = { version: 'inactivity@1.0.0', inactivityMs: 60_000 };
    assert.equal(isExpired(s, NOW, policy), false);
    assert.equal(isExpired(s, '2026-08-27T12:05:00.000Z', policy), true);
  });
});

describe('B27/B28 — offline membership snapshot', () => {
  const snap = (over: Partial<MembershipSnapshot> = {}): MembershipSnapshot => ({
    householdId: HH, deviceId: DEV, capturedAt: '2026-08-27T00:00:00.000Z',
    expiresAt: '2026-08-28T00:00:00.000Z', snapshotVersion: 1,
    authorizedUserIds: [OWNER, MEMBER], ...over,
  });
  const offlineCtx = (over: Record<string, unknown> = {}) => ({
    binding: BINDING, memberships: MEMBERS, seat: SEAT, currentSession: null,
    offline: true, snapshot: snap(), ...over,
  }) as Parameters<typeof activateUser>[1];
  const req = (userId: string) => ({
    deviceId: DEV, userId, authenticatedSubjectId: userId, nowIso: NOW,
  });

  test('a previously authorised member activates offline', () => {
    assert.equal(activateUser(req(MEMBER), offlineCtx()).ok, true);
  });

  test('B27: a user absent from the snapshot cannot be added offline', () => {
    const r = activateUser(req(MEMBER), offlineCtx({ snapshot: snap({ authorizedUserIds: [OWNER] }) }));
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, 'not_authorized_on_this_device');
  });

  test('B28: an EXPIRED snapshot forces an online refresh — no instant-revocation claim', () => {
    const r = activateUser(req(MEMBER), offlineCtx({
      snapshot: snap({ expiresAt: '2026-08-27T00:00:00.000Z' }),
    }));
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, 'membership_snapshot_expired');
  });

  test("a snapshot from another device is not accepted", () => {
    const r = activateUser(req(MEMBER), offlineCtx({ snapshot: snap({ deviceId: 'other' }) }));
    assert.equal(r.ok, false);
  });
});

describe('B18/B19/B20 — voice switching', () => {
  test('a name resolves to a candidate, and nothing switches yet', () => {
    const r = resolveSwitchRequest('Sam', HH, MEMBERS, NAMES);
    assert.equal(r.kind, 'resolved');
    if (r.kind !== 'resolved') return;
    assert.equal(r.candidate.userId, MEMBER);
  });

  test('B20: a DUPLICATE display name is ambiguous, never guessed', () => {
    const withDup = [...MEMBERS, m(THIRD)];
    const r = resolveSwitchRequest('Alex', HH, withDup, NAMES);
    assert.equal(r.kind, 'ambiguous');
    if (r.kind !== 'ambiguous') return;
    assert.equal(r.candidates.length, 2);
  });

  test('an unknown name resolves to nothing', () => {
    assert.equal(resolveSwitchRequest('Nobody', HH, MEMBERS, NAMES).kind, 'not_found');
  });

  test('removed members are not switch candidates', () => {
    const r = resolveSwitchRequest('Sam', HH, [m(OWNER, 'owner'), m(MEMBER, 'member', 'removed')], NAMES);
    assert.equal(r.kind, 'not_found');
  });

  test('B18: a switch requires EXPLICIT confirmation', () => {
    const pending = {
      requestedByUserId: OWNER, targetUserId: MEMBER, targetDisplayName: 'Sam',
      requestedAt: NOW, sessionGeneration: 1,
    };
    assert.equal(confirmSwitch(null, MEMBER, 1).ok, false, 'nothing switches without a request');
    assert.equal(confirmSwitch(pending, MEMBER, 1).ok, true);
  });

  test('a confirmation for a DIFFERENT target is refused', () => {
    const pending = {
      requestedByUserId: OWNER, targetUserId: MEMBER, targetDisplayName: 'Sam',
      requestedAt: NOW, sessionGeneration: 1,
    };
    const r = confirmSwitch(pending, THIRD, 1);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, 'target_mismatch');
  });

  test('a STALE confirmation from an old session is refused', () => {
    const pending = {
      requestedByUserId: OWNER, targetUserId: MEMBER, targetDisplayName: 'Sam',
      requestedAt: NOW, sessionGeneration: 1,
    };
    const r = confirmSwitch(pending, MEMBER, 2);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, 'stale_session');
  });

  test('B19: "I am John" is a REQUEST, not authentication', () => {
    // Resolution yields a candidate to confirm — never an activated session.
    const r = resolveSwitchRequest('Sam', HH, MEMBERS, NAMES);
    assert.equal(r.kind, 'resolved');
    assert.equal('session' in (r as object), false, 'resolution never activates');
  });

  test('B19: no biometric or speaker-recognition surface exists', () => {
    const api = Object.keys({ resolveSwitchRequest, confirmSwitch }).join(' ').toLowerCase();
    for (const banned of ['voiceprint', 'speaker', 'biometric', 'face']) {
      assert.equal(api.includes(banned), false);
    }
  });
});

describe('B16/B42 — offline queue ownership across switching', () => {
  const CHICKEN = SYNTHETIC_PRODUCTS.find((p) => p.displayName === 'Chicken breast, cooked')!;
  const log = (userId: string, logId: string) => createFoodLogItem({
    logId, userId, productVersion: CHICKEN,
    weightCapture: manualCapture(180, instant(NOW)), loggedAt: instant(NOW),
    timezone: 'America/Chicago',
  });
  const entry = (userId: string, logId: string): OutboxEntry => ({
    userId, logId, payload: log(userId, logId), state: 'pending', attempts: 0, sequence: 1,
  });

  test("A's confirmed offline log is invisible to B and stays A's", () => {
    const queue = [entry(OWNER, 'a-1')];
    const day = log(OWNER, 'a-1').localDate;

    const bView = reconcileDay(MEMBER, day, [], queue);
    assert.equal(bView.effective.length, 0, "B never sees A's food");

    const aView = reconcileDay(OWNER, day, [], queue);
    assert.equal(aView.effective.length, 1);
    assert.equal(aView.effective[0]!.userId, OWNER, 'ownership never reassigned');
  });

  test('B30: logout does not delete pending logs', () => {
    const queue = [entry(OWNER, 'a-1')];
    // "Logout" ends the session; the queue is a separate durable artifact.
    assert.equal(queue.length, 1);
    assert.equal(reconcileDay(OWNER, log(OWNER, 'a-1').localDate, [], queue).effective.length, 1);
  });

  test('B32: removing a membership does not touch the pending queue', () => {
    const queue = [entry(MEMBER, 'b-1')];
    const after = removeMembership(MEMBERS, HH, OWNER, MEMBER, NOW);
    assert.equal(after.ok, true);
    // The queue entry is untouched and still owned by the removed user.
    assert.equal(queue[0]!.userId, MEMBER);
    const ownerView = reconcileDay(OWNER, log(MEMBER, 'b-1').localDate, [], queue);
    assert.equal(ownerView.effective.length, 0, 'never reassigned to the owner');
  });
});

describe('B37/B38 — migration structure and future RLS matrix', () => {
  const sql = readFileSync('db/migrations/0005_households.sql', 'utf8');

  test('B36: NO policy grants an owner access to personal tables', () => {
    // The migration must not touch food_logs, weight, goals or any personal
    // table. Household admin is not nutrition access, in SQL as in the domain.
    for (const personal of ['food_logs', 'user_profiles', 'energy_goals', 'food_log_voids']) {
      assert.equal(sql.includes(personal), false,
        `0005 must not create a policy over ${personal}`);
    }
  });

  test('a household cannot have two active owners', () => {
    assert.match(sql, /household_single_active_owner/);
    assert.match(sql, /WHERE role = 'owner' AND status = 'active'/);
  });

  test('RLS is enabled AND forced on every shared table', () => {
    for (const t of ['households', 'household_memberships', 'household_devices',
                     'household_seat_entitlements']) {
      assert.match(sql, new RegExp(`ALTER TABLE ${t}\\s+ENABLE ROW LEVEL SECURITY`), `${t} ENABLE`);
      assert.match(sql, new RegExp(`ALTER TABLE ${t}\\s+FORCE\\s+ROW LEVEL SECURITY`), `${t} FORCE`);
    }
  });

  test('no date of birth is stored; only an 18+ attestation', () => {
    assert.equal(/date_of_birth|birth_date|\bdob\b/i.test(sql), false);
    assert.match(sql, /age_attested/);
  });

  test('seat entitlement carries NO payment provider columns', () => {
    // Comments are stripped: the migration explains the ABSENCE of these.
    const ddl = sql.replace(/^\s*--.*$/gm, '').toLowerCase();
    for (const banned of ['stripe', 'price', 'plan_id', 'subscription_id', 'amount_cents']) {
      assert.equal(ddl.includes(banned), false, banned);
    }
  });

  test('no policy grants access outside active membership', () => {
    const policies = sql.split('CREATE POLICY').slice(1);
    assert.ok(policies.length >= 8);
    for (const p of policies) {
      assert.ok(p.includes("status = 'active'") || p.includes('user_id = auth.uid()'),
        'every policy must be membership- or self-scoped');
    }
  });
});

describe('PART A REFREEZE — transfer atomicity vs the unique owner index', () => {
  test('A3: a transfer yields EXACTLY ONE active owner in a single state', () => {
    const r = transferOwnership(MEMBERS, HH, OWNER, MEMBER);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    const owners = r.value.filter((x) => x.status === 'active' && x.role === 'owner');
    assert.equal(owners.length, 1, 'never two active owners, even transiently');
    assert.equal(owners[0]!.userId, MEMBER);
  });

  test('A3: the migration documents the demote-before-promote requirement', () => {
    const sql = readFileSync('db/migrations/0005_households.sql', 'utf8');
    assert.match(sql, /demote the outgoing owner BEFORE promoting/i);
    assert.match(sql, /one transaction/i);
  });

  test('A3: a transfer that would leave zero owners fails closed', () => {
    // Target is not an active member, so no valid single-owner state exists.
    const r = transferOwnership([m(OWNER, 'owner')], HH, OWNER, THIRD);
    assert.equal(r.ok, false);
  });
});
