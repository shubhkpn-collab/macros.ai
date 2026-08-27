import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  SharedDeviceAuthCoordinator, type HouseholdActivationContextPort,
} from '@macros/runtime-api';
import {
  activeSwitchState, type ActivationContext, type HouseholdMembership,
} from '@macros/domain-household';
import type { AuthSession, AuthSessionProvider, AppError } from '@macros/runtime-config';
import { repoPath } from '../tools/repo-paths.js';
import { USER_A, USER_B } from '@macros/testkit';

const HH = 'hh-1';
const DEV = 'dev-1';
const USER_C = '00000000-0000-4000-8000-00000000000c';
const NOW = '2026-08-27T12:00:00.000Z';

const member = (userId: string, status: 'active' | 'removed' = 'active'): HouseholdMembership => ({
  householdId: HH, userId, role: 'member', status, joinedAt: NOW,
  ageEligibility: { attested: true, policyVersion: 'age-18plus@1.0.0', attestedAt: NOW },
});

const contextFor = (bindingGeneration = 7): ActivationContext => ({
  binding: {
    deviceId: DEV, householdId: HH, status: 'bound', boundAt: NOW, bindingGeneration,
  },
  memberships: [member(USER_A), member(USER_B), member(USER_C)],
  seat: { householdId: HH, capacity: 5, state: 'active' },
  currentSession: null,
  offline: false,
});

/** A provider whose verification can be held open, modelling real latency. */
class GatedAuth implements AuthSessionProvider {
  readonly providerKind = 'gated';
  private release!: (v: void) => void;
  readonly gate = new Promise<void>((r) => { this.release = r; });
  entered = false;
  constructor(private readonly subjectId: string, private readonly hold = true) {}
  async verify(): Promise<AuthSession | AppError> {
    this.entered = true;
    if (this.hold) await this.gate;
    return {
      subjectId: this.subjectId, sessionId: '99999999-9999-4999-8999-999999999999',
      issuedAt: '2026-08-27T11:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z',
    };
  }
  open(): void { this.release(); }
}

const portFor = (get: () => ActivationContext): HouseholdActivationContextPort =>
  ({ load: async () => get() });

const build = (auth: AuthSessionProvider, get: () => ActivationContext = () => contextFor()) =>
  new SharedDeviceAuthCoordinator(
    { auth, context: portFor(get), now: () => NOW },
    activeSwitchState(USER_A, 0));

// ---------------------------------------------------------------------------

describe('FIX 1 — async stale-result safety', () => {
  test('CANCEL while auth is pending: B cannot activate, A stays active', async () => {
    const auth = new GatedAuth(USER_B);
    const c = build(auth);
    await c.request({ switchRequestId: 'sw-b', targetUserId: USER_B, targetDisplayName: 'B', deviceId: DEV });
    c.confirm('sw-b', USER_B);

    const inFlight = c.authenticateAndActivate('sw-b', 'token-b');
    while (!auth.entered) await new Promise((r) => setImmediate(r));

    c.cancel('sw-b');
    auth.open();
    const out = await inFlight;

    assert.equal(out.kind, 'refused', 'a cancelled attempt must not activate');
    assert.equal(c.getState().activeUserId, USER_A, 'A remains active');
  });

  test('RETARGET while auth is pending: stale B cannot disturb the newer C attempt', async () => {
    const auth = new GatedAuth(USER_B);
    const c = build(auth);
    await c.request({ switchRequestId: 'sw-b', targetUserId: USER_B, targetDisplayName: 'B', deviceId: DEV });
    c.confirm('sw-b', USER_B);

    const inFlight = c.authenticateAndActivate('sw-b', 'token-b');
    while (!auth.entered) await new Promise((r) => setImmediate(r));

    // The person changes their mind: a NEW attempt for C is now live.
    await c.request({ switchRequestId: 'sw-c', targetUserId: USER_C, targetDisplayName: 'C', deviceId: DEV });
    c.confirm('sw-c', USER_C);

    auth.open();
    const out = await inFlight;

    assert.equal(out.kind, 'refused', 'B cannot activate');
    // THE POINT: the stale invocation must not clear or mutate C's attempt.
    const live = c.getState();
    assert.equal(live.attempt?.switchRequestId, 'sw-c', "C's attempt survived intact");
    assert.equal(live.attempt?.targetUserId, USER_C);
    assert.equal(live.phase, 'awaiting_authentication', 'C is still pending');
    assert.equal(live.activeUserId, USER_A);
  });

  test('CANCEL while the CONTEXT LOAD is pending: B cannot activate', async () => {
    // Cancellation is just as possible during authorization as during
    // verification, so the second await needs the same re-read.
    let releaseLoad!: () => void;
    const loadGate = new Promise<void>((r) => { releaseLoad = r; });
    let loadEntered = false;

    const auth: AuthSessionProvider = {
      providerKind: 'immediate',
      verify: async () => ({
        subjectId: USER_B, sessionId: '99999999-9999-4999-8999-999999999999',
        issuedAt: '2026-08-27T11:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z',
      }),
    };
    let calls = 0;
    const port: HouseholdActivationContextPort = {
      load: async () => {
        calls += 1;
        if (calls > 1) { loadEntered = true; await loadGate; }
        return contextFor();
      },
    };
    const c = new SharedDeviceAuthCoordinator(
      { auth, context: port, now: () => NOW }, activeSwitchState(USER_A, 0));

    await c.request({ switchRequestId: 'sw-b', targetUserId: USER_B, targetDisplayName: 'B', deviceId: DEV });
    c.confirm('sw-b', USER_B);

    const inFlight = c.authenticateAndActivate('sw-b', 'token-b');
    while (!loadEntered) await new Promise((r) => setImmediate(r));
    c.cancel('sw-b');
    releaseLoad();

    const out = await inFlight;
    assert.equal(out.kind, 'refused');
    assert.equal(c.getState().activeUserId, USER_A);
  });

  test('DUPLICATE completion advances the generation exactly once', async () => {
    const auth = new GatedAuth(USER_B, false);
    const c = build(auth);
    await c.request({ switchRequestId: 'sw-b', targetUserId: USER_B, targetDisplayName: 'B', deviceId: DEV });
    c.confirm('sw-b', USER_B);

    const first = await c.authenticateAndActivate('sw-b', 'token-b');
    assert.equal(first.kind, 'switched');
    const after = c.getState().sessionGeneration;

    const second = await c.authenticateAndActivate('sw-b', 'token-b');
    assert.equal(second.kind, 'refused', 'a duplicate completion must not re-commit');
    assert.equal(c.getState().sessionGeneration, after, 'generation advanced once');
  });

  test('no SwitchState is accepted into async work', () => {
    const src = readFileSync(repoPath('packages', 'runtime-api', 'src', 'shared-device-auth.ts'), 'utf8');
    assert.match(src, /authenticateAndActivate\(\s*\n?\s*switchRequestId: string,/,
      'the entry point must not take a SwitchState');
    // Correlation FACTS, not a state object, cross the await.
    assert.match(src, /interface Correlation/);
    assert.match(src, /private staleReason/);
  });

  test('there is NO await between the final stale check and the commit', () => {
    const src = readFileSync(repoPath('packages', 'runtime-api', 'src', 'shared-device-auth.ts'), 'utf8');
    const tail = src.slice(src.indexOf('NO await beyond this point'));
    const region = tail.slice(0, tail.indexOf("return { kind: 'switched'"));
    // Drop the marker line and every comment: the marker itself says "await".
    const code = region.split('\n').slice(1).join('\n').replace(/\/\/.*$/gm, '');
    assert.equal(/\bawait\b/.test(code), false,
      'authorize-and-commit must be atomic with respect to state');
  });
});

describe('FIX 2 — bindingGeneration is TRUSTED, never caller-supplied', () => {
  test('the request input carries no household or generation', () => {
    const src = readFileSync(repoPath('packages', 'runtime-api', 'src', 'shared-device-auth.ts'), 'utf8');
    const iface = src.slice(src.indexOf('interface SwitchRequestInput'),
                            src.indexOf('interface SwitchRequestInput') + 400);
    assert.equal(/householdId/.test(iface), false, 'household must be derived, not asserted');
    assert.equal(/bindingGeneration/.test(iface), false, 'generation must be derived, not asserted');
  });

  test('household and binding generation are derived from the trusted port', async () => {
    const c = build(new GatedAuth(USER_B, false), () => contextFor(7));
    await c.request({ switchRequestId: 'sw-b', targetUserId: USER_B, targetDisplayName: 'B', deviceId: DEV });
    const attempt = c.getState().attempt;
    assert.equal(attempt?.householdId, HH);
    assert.equal(attempt?.bindingGeneration, 7);
  });

  test('no valid binding means NO attempt', async () => {
    const unbound = { ...contextFor(), binding: null } as ActivationContext;
    const c = build(new GatedAuth(USER_B, false), () => unbound);
    const r = await c.request({
      switchRequestId: 'sw-b', targetUserId: USER_B, targetDisplayName: 'B', deviceId: DEV });
    assert.equal((r as { error: string }).error, 'device_not_bound');
    assert.equal(c.getState().attempt, null);
  });

  test('a binding for a DIFFERENT device means no attempt', async () => {
    const other = { ...contextFor(), binding: { ...contextFor().binding!, deviceId: 'other' } };
    const c = build(new GatedAuth(USER_B, false), () => other as ActivationContext);
    const r = await c.request({
      switchRequestId: 'sw-b', targetUserId: USER_B, targetDisplayName: 'B', deviceId: DEV });
    assert.equal((r as { error: string }).error, 'wrong_device');
  });

  test('a REBIND during authentication is rejected and A stays active', async () => {
    // Requested under generation 7; the device rebinds to 8 mid-flight.
    let generation = 7;
    const auth = new GatedAuth(USER_B);
    const c = build(auth, () => contextFor(generation));

    await c.request({ switchRequestId: 'sw-b', targetUserId: USER_B, targetDisplayName: 'B', deviceId: DEV });
    c.confirm('sw-b', USER_B);
    assert.equal(c.getState().attempt?.bindingGeneration, 7);

    const inFlight = c.authenticateAndActivate('sw-b', 'token-b');
    while (!auth.entered) await new Promise((r) => setImmediate(r));
    generation = 8;
    auth.open();

    const out = await inFlight;
    assert.equal(out.kind, 'refused');
    assert.equal(out.kind === 'refused' ? out.reason : '', 'binding_changed');
    assert.equal(c.getState().activeUserId, USER_A, 'A remains active');
  });
});

describe('FIX 3 — the tablet controller is not a generation authority', () => {
  const src = readFileSync(repoPath('packages', 'tablet-app-core', 'src', 'controller.ts'), 'utf8');

  test('NO generation increment fallback remains', () => {
    const code = src.replace(/^\s*(\/\/|\*|\/\*).*$/gm, '');
    assert.equal(/sessionGeneration\s*\+\s*1/.test(code), false,
      'the controller must never mint a generation');
  });

  test('an authorized session is REQUIRED, not optional', () => {
    assert.match(src, /activeSession: \{ readonly userId: string; readonly sessionGeneration: number \}/);
    assert.equal(/activeSession\?:/.test(src), false, 'the parameter must not be optional');
    assert.match(src, /an authorized ActiveUserSession is required/);
  });

  test('the generation is ALWAYS adopted', () => {
    assert.match(src, /sessionGeneration: activeSession\.sessionGeneration/);
    assert.equal(/activeSession\?\.sessionGeneration/.test(src), false, 'no optional-chained fallback');
  });

  test('a session whose user disagrees with the subject is refused', () => {
    assert.match(src, /activeSession\.userId !== subject\.userId/);
  });
});

describe('FIX 4 — the live gate selects a TRUSTED target first', () => {
  const gate = readFileSync(repoPath('tools', 'supabase-gate', 'run-live-gate.ts'), 'utf8');

  test('SUPABASE_TEST_USER_ID is required and validated before token work', () => {
    assert.match(gate, /SUPABASE_TEST_USER_ID/);
    const validationIdx = gate.indexOf('UUID.test(TEST_USER)');
    const verifyIdx = gate.indexOf('provider.verify(');
    assert.ok(validationIdx > 0 && validationIdx < verifyIdx,
      'the trusted id must be validated before any credential is verified');
  });

  test('the roster is built from configuration, not from the token', () => {
    assert.match(gate, /DETERMINISTIC roster built from trusted configuration/);
    const rosterIdx = gate.indexOf('const roster =');
    const rosterBody = gate.slice(rosterIdx, rosterIdx + 700);
    assert.equal(/verified\./.test(rosterBody), false,
      'the roster must not be derived from the verified token');
  });

  test('the switch is REQUESTED before the token is verified', () => {
    const requestIdx = gate.indexOf("coordinator.request({");
    const verifyIdx = gate.indexOf('provider.verify(');
    assert.ok(requestIdx > 0 && requestIdx < verifyIdx,
      'target selection must precede token trust');
  });

  test('the verified subject must equal the trusted test user', () => {
    assert.match(gate, /verified\.subjectId !== TEST_USER/);
  });

  test('it uses the production coordinator and asserts the required proofs', () => {
    assert.match(gate, /new SharedDeviceAuthCoordinator/);
    for (const proof of [
      'B is NOT active before authentication',
      'real session_id propagated',
      'generation advanced exactly once',
      "B's real token cannot satisfy a request targeting C",
      'a removed membership blocks activation',
      'a changed binding generation blocks activation',
    ]) {
      assert.ok(gate.includes(proof), `missing live proof: ${proof}`);
    }
  });
});


describe('ONE COUNTER — switch and household generations must agree', () => {
  test('a desynchronised initial generation fails closed', async () => {
    // The switch machine believes it is at 9; the household says 0.
    const c = new SharedDeviceAuthCoordinator(
      { auth: new GatedAuth(USER_B, false), context: portFor(() => contextFor()), now: () => NOW },
      activeSwitchState(USER_A, 9));
    const r = await c.request({
      switchRequestId: 'sw-b', targetUserId: USER_B, targetDisplayName: 'B', deviceId: DEV });
    assert.equal((r as { error: string }).error, 'generation_desync');
    assert.equal(c.getState().attempt, null, 'no attempt is created');
  });
});
