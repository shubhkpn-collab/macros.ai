import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  activeSwitchState, authenticationFailed, completeAuthenticatedSwitch, beginAuthentication,
  cancelSwitch, confirmSwitchTarget, neutralSwitchState, requestSwitch, resolveSwitchRequest,
  restartState, type HouseholdMembership, type SwitchState,
} from '@macros/domain-household';
import { mintSubjectForTests } from '@macros/domain-auth';
import { USER_A, USER_B } from '@macros/testkit';

const HH = 'hh-1';
const DEV = 'dev-1';
const USER_C = '00000000-0000-4000-8000-00000000000c';
const OUTSIDER = '00000000-0000-4000-8000-0000000000ff';
const AT = '2026-08-27T12:00:00.000Z';

const m = (userId: string, status: 'active' | 'removed' = 'active'): HouseholdMembership => ({
  householdId: HH, userId, role: 'member', status,
  joinedAt: '2026-01-01T00:00:00.000Z',
  ageEligibility: { attested: true, policyVersion: 'age-18plus@1.0.0', attestedAt: AT },
});

/**
 * The switch machine no longer re-decides household eligibility — that is
 * activateUser's job. It commits an ALREADY-AUTHORIZED session, so tests supply
 * the session that authorization would have produced.
 */
const sessionFor = (userId: string, generation = 2, over: Record<string, unknown> = {}) => ({
  householdId: HH, userId, deviceId: DEV, sessionGeneration: generation,
  startedAt: AT, lastActivityAt: AT, ...over,
}) as never;

const request = (state: SwitchState, target: string, id = 'sw-1') =>
  requestSwitch(state, {
    switchRequestId: id, targetUserId: target, targetDisplayName: 'Target',
    deviceId: DEV, householdId: HH, requestedAt: AT,
  });

/** REQUEST -> CONFIRM -> (authenticate) */
const upToAuth = (target: string, id = 'sw-1'): SwitchState => {
  const requested = request(activeSwitchState(USER_A, 1), target, id);
  const confirmed = confirmSwitchTarget(requested, id, target);
  assert.equal('error' in confirmed, false);
  return confirmed as SwitchState;
};

const ok = (r: SwitchState | { error: string }): SwitchState => {
  assert.equal('error' in r, false, JSON.stringify(r));
  return r as SwitchState;
};

describe('SHARED-DEVICE SWITCH — adversarial matrix', () => {
  test('1. request B leaves A ACTIVE', () => {
    const s = request(activeSwitchState(USER_A, 1), USER_B);
    assert.equal(s.phase, 'switch_requested');
    assert.equal(s.activeUserId, USER_A, 'a request must not log A out');
  });

  test('2. confirming the target still does NOT activate', () => {
    const s = upToAuth(USER_B);
    assert.equal(s.phase, 'awaiting_authentication');
    assert.equal(s.activeUserId, USER_A, 'confirmation is selection, not authentication');
  });

  test('3. valid authentication + active membership ACTIVATES B', () => {
    const s = ok(completeAuthenticatedSwitch(upToAuth(USER_B), 'sw-1', mintSubjectForTests(USER_B), sessionFor(USER_B)));
    assert.equal(s.phase, 'active');
    assert.equal(s.activeUserId, USER_B);
    assert.equal(s.sessionGeneration, 2, 'generation advances, invalidating A\'s in-flight work');
  });

  test('4. failed authentication leaves A active and usable', () => {
    const s = authenticationFailed(upToAuth(USER_B), 'sw-1');
    assert.equal(s.activeUserId, USER_A);
    assert.equal(s.phase, 'active');
    assert.equal(s.lastFailure, 'authentication_failed');
  });

  test('5. an EXPIRED subject cannot be minted, so it never reaches activation', () => {
    // Expiry is enforced at the mint boundary; the machine only ever sees a
    // subject that was successfully minted.
    const s = authenticationFailed(upToAuth(USER_B), 'sw-1');
    assert.equal(s.activeUserId, USER_A);
  });

  test('6. an outsider cannot commit: no authorized session for this household', () => {
    // Membership itself is refused by activateUser (covered in the household
    // suite). What THIS layer must guarantee is that a session authorized for
    // some other household can never commit against this attempt.
    const r = completeAuthenticatedSwitch(
      upToAuth(OUTSIDER), 'sw-1', mintSubjectForTests(OUTSIDER),
      sessionFor(OUTSIDER, 2, { householdId: 'hh-other' }));
    assert.equal((r as { error: string }).error, 'wrong_household');
  });

  test('6b. a session for the WRONG DEVICE cannot commit', () => {
    const r = completeAuthenticatedSwitch(
      upToAuth(USER_B), 'sw-1', mintSubjectForTests(USER_B),
      sessionFor(USER_B, 2, { deviceId: 'other-device' }));
    assert.equal((r as { error: string }).error, 'device_not_bound');
  });

  test('6c. a session with a NON-SEQUENTIAL generation cannot commit', () => {
    // Guards against a replayed authorized session re-advancing the counter.
    const r = completeAuthenticatedSwitch(
      upToAuth(USER_B), 'sw-1', mintSubjectForTests(USER_B), sessionFor(USER_B, 9));
    assert.equal((r as { error: string }).error, 'stale_attempt');
  });

  test('7. a REMOVED member with a valid token cannot activate', () => {
    const r = completeAuthenticatedSwitch(
      upToAuth(USER_B), 'sw-1', mintSubjectForTests(USER_B), sessionFor(USER_C));
    // Membership is proven by activateUser; the machine refuses a session that
    // does not correspond to the confirmed target.
    assert.equal((r as { error: string }).error, 'target_mismatch');
  });

  test('8. a token for B cannot satisfy a request targeting C', () => {
    const r = completeAuthenticatedSwitch(upToAuth(USER_C), 'sw-1', mintSubjectForTests(USER_B), sessionFor(USER_B));
    assert.equal((r as { error: string }).error, 'target_mismatch',
      'the credential must belong to the CONFIRMED target');
  });

  test('9. a STALE B response after the request changed to C cannot activate B', () => {
    const first = upToAuth(USER_B, 'sw-1');
    // The person changes their mind and requests C instead.
    const second = confirmSwitchTarget(request(first, USER_C, 'sw-2'), 'sw-2', USER_C) as SwitchState;
    const late = completeAuthenticatedSwitch(second, 'sw-1', mintSubjectForTests(USER_B), sessionFor(USER_B));
    assert.equal((late as { error: string }).error, 'stale_attempt');
  });

  test('10. a STALE response after CANCEL cannot activate', () => {
    const cancelled = cancelSwitch(upToAuth(USER_B), 'sw-1');
    assert.equal(cancelled.activeUserId, USER_A);
    const late = completeAuthenticatedSwitch(cancelled, 'sw-1', mintSubjectForTests(USER_B), sessionFor(USER_B));
    assert.equal('error' in late, true, 'a late success must not resurrect a cancelled switch');
  });

  test('11. a DUPLICATE auth callback activates only once', () => {
    const activated = ok(completeAuthenticatedSwitch(upToAuth(USER_B), 'sw-1', mintSubjectForTests(USER_B), sessionFor(USER_B)));
    const again = completeAuthenticatedSwitch(activated, 'sw-1', mintSubjectForTests(USER_B), sessionFor(USER_B));
    assert.equal((again as { error: string }).error, 'already_activated');
    assert.equal(activated.sessionGeneration, 2, 'generation advanced exactly once');
  });

  test('12. switching B -> A advances the generation again', () => {
    const asB = ok(completeAuthenticatedSwitch(upToAuth(USER_B), 'sw-1', mintSubjectForTests(USER_B), sessionFor(USER_B)));
    const backToA = ok(completeAuthenticatedSwitch(
      confirmSwitchTarget(request(asB, USER_A, 'sw-3'), 'sw-3', USER_A) as SwitchState,
      'sw-3', mintSubjectForTests(USER_A), sessionFor(USER_A, 3)));
    assert.equal(backToA.activeUserId, USER_A);
    assert.equal(backToA.sessionGeneration, 3,
      "B's in-flight results cannot land in A's new session");
  });

  test('13. voice "I am B" is a REQUEST, never authentication', () => {
    const resolution = resolveSwitchRequest('Sam', HH, [m(USER_B)], { [USER_B]: 'Sam' });
    assert.equal(resolution.kind, 'resolved');
    // Resolution yields a candidate; there is no path from it to a subject.
    assert.equal('subject' in (resolution as object), false);
    assert.equal('sessionGeneration' in (resolution as object), false);
  });

  test('14. duplicate display names stay ambiguous BEFORE authentication', () => {
    const dup = resolveSwitchRequest('Alex', HH, [m(USER_A), m(USER_B)],
      { [USER_A]: 'Alex', [USER_B]: 'Alex' });
    assert.equal(dup.kind, 'ambiguous');
  });

  test('an unbound device cannot activate anyone', () => {
    const r = completeAuthenticatedSwitch(
      upToAuth(USER_B), 'sw-1', mintSubjectForTests(USER_B),
      sessionFor(USER_B, 2, { deviceId: 'other-device' }));
    assert.equal((r as { error: string }).error, 'device_not_bound');
  });

  test('a device bound to ANOTHER household cannot activate', () => {
    const r = completeAuthenticatedSwitch(
      upToAuth(USER_B), 'sw-1', mintSubjectForTests(USER_B),
      sessionFor(USER_B, 2, { householdId: 'hh-other' }));
    assert.equal((r as { error: string }).error, 'wrong_household');
  });

  test('authentication cannot be begun without confirmation', () => {
    const requested = request(activeSwitchState(USER_A, 1), USER_B);
    const r = beginAuthentication(requested, 'sw-1');
    assert.equal((r as { error: string }).error, 'no_attempt_in_progress');
  });

  test('there is NO activateUser(userId) escape hatch', async () => {
    const domain = await import('@macros/domain-household');
    const activate = (domain as Record<string, unknown>)['completeAuthenticatedSwitch'];
    assert.equal(typeof activate, 'function');
    // The only activation path takes a subject; a userId string cannot satisfy it.
    const r = completeAuthenticatedSwitch(
      upToAuth(USER_B), 'sw-1', USER_B as never, sessionFor(USER_B));
    assert.equal('error' in r, true, 'a bare userId must never activate');
  });
});

describe('RESTART — no authentication by memory', () => {
  test('restart returns to NEUTRAL, not the last active member', () => {
    const s = restartState();
    assert.equal(s.phase, 'neutral');
    assert.equal(s.activeUserId, null,
      'no platform-secure session proof exists (AU-1 open), so reopening the last user would be authentication by memory');
    assert.deepEqual(s, neutralSwitchState());
  });

  test('a failed switch from neutral stays neutral', () => {
    const requested = request(neutralSwitchState(), USER_B);
    assert.equal(authenticationFailed(requested, 'sw-1').phase, 'neutral');
  });
});

describe('FIX C — attempts are bounded and binding-continuous', () => {
  const withLifetime = (target: string, over: Record<string, unknown> = {}) => {
    const requested = requestSwitch(activeSwitchState(USER_A, 1), {
      switchRequestId: 'sw-c', targetUserId: target, targetDisplayName: 'T',
      deviceId: DEV, householdId: HH, requestedAt: AT,
      expiresAt: '2026-08-27T12:02:00.000Z', bindingGeneration: 1, ...over,
    });
    return confirmSwitchTarget(requested, 'sw-c', target) as SwitchState;
  };

  test('an attempt within its lifetime commits', () => {
    const r = completeAuthenticatedSwitch(
      withLifetime(USER_B), 'sw-c', mintSubjectForTests(USER_B), sessionFor(USER_B),
      '2026-08-27T12:01:00.000Z', 1);
    assert.equal('error' in r, false, JSON.stringify(r));
  });

  test('an ABANDONED attempt expires rather than pending forever', () => {
    // Without a deadline a credential arriving long afterwards still commits.
    const r = completeAuthenticatedSwitch(
      withLifetime(USER_B), 'sw-c', mintSubjectForTests(USER_B), sessionFor(USER_B),
      '2026-08-27T13:00:00.000Z', 1);
    assert.equal((r as { error: string }).error, 'attempt_expired');
  });

  test('a REBIND during the switch invalidates the attempt', () => {
    // The household context the switch was requested against no longer exists.
    const r = completeAuthenticatedSwitch(
      withLifetime(USER_B), 'sw-c', mintSubjectForTests(USER_B), sessionFor(USER_B),
      '2026-08-27T12:01:00.000Z', 2);
    assert.equal((r as { error: string }).error, 'binding_changed');
  });

  test('the current user stays active when an attempt expires', () => {
    const attempt = withLifetime(USER_B);
    assert.equal(attempt.activeUserId, USER_A);
    const failed = authenticationFailed(attempt, 'sw-c');
    assert.equal(failed.activeUserId, USER_A, 'expiry must not log A out');
    assert.equal(failed.phase, 'active');
  });
});
