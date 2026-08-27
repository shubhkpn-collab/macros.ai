/**
 * LIVE SUPABASE GATE — owner-side.
 *
 * The target user is TRUSTED CONFIGURATION, not something derived from the
 * token. Deriving the household member from `verified.subjectId` meant whatever
 * the token said became the member — the token defined the roster it was then
 * checked against, which proves nothing.
 *
 * Here the roster is built from `SUPABASE_TEST_USER_ID` and the switch is
 * REQUESTED before any token is verified.
 */
import {
  activeSwitchState, type ActivationContext, type HouseholdMembership,
} from '@macros/domain-household';
import { SharedDeviceAuthCoordinator } from '@macros/runtime-api';
import { SupabaseAuthSessionProvider } from '@macros/auth-supabase';

const URL_ = process.env['SUPABASE_URL'];
const TOKEN = process.env['SUPABASE_TEST_ACCESS_TOKEN'];
const TEST_USER = process.env['SUPABASE_TEST_USER_ID'];

if (URL_ === undefined || TOKEN === undefined || TEST_USER === undefined) {
  console.error('Set SUPABASE_URL, SUPABASE_TEST_USER_ID and SUPABASE_TEST_ACCESS_TOKEN.');
  process.exit(2);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
if (!UUID.test(TEST_USER)) {
  // Validated BEFORE any token work: a malformed trusted id is a configuration
  // error, and must not be discovered only after a credential is accepted.
  console.error('SUPABASE_TEST_USER_ID is not a UUID.');
  process.exit(2);
}

let failures = 0;
const ok = (s: string, d = ''): void => console.log(`  [OK] ${s}${d ? ` — ${d}` : ''}`);
const bad = (s: string, d = ''): void => { failures += 1; console.log(`  [FAIL] ${s}${d ? ` — ${d}` : ''}`); };
const section = (s: string): void => { console.log(`\n=== ${s} ===`); };

const HH = 'hh-live';
const DEV = 'dev-live';
const USER_A = '00000000-0000-4000-8000-00000000000a';   // the currently active user
const USER_C = '00000000-0000-4000-8000-00000000000c';   // a third member
const now = (): string => new Date().toISOString();

const member = (userId: string, status: 'active' | 'removed' = 'active'): HouseholdMembership => ({
  householdId: HH, userId, role: 'member', status, joinedAt: now(),
  ageEligibility: { attested: true, policyVersion: 'age-18plus@1.0.0', attestedAt: now() },
});

/** DETERMINISTIC roster built from trusted configuration. */
const roster = (over: { bindingGeneration?: number; targetStatus?: 'active' | 'removed' } = {})
: ActivationContext => ({
  binding: {
    deviceId: DEV, householdId: HH, status: 'bound', boundAt: now(),
    bindingGeneration: over.bindingGeneration ?? 7,
  },
  memberships: [
    member(USER_A), member(USER_C),
    member(TEST_USER!, over.targetStatus ?? 'active'),
  ],
  seat: { householdId: HH, capacity: 5, state: 'active' },
  currentSession: null,
  offline: false,
});

async function main(): Promise<void> {
  console.log('MACROS.AI — live Supabase gate');
  console.log(`project:     ${URL_}`);                 // public
  console.log(`test user:   ${TEST_USER}`);            // trusted configuration
  // The token is never printed.

  const provider = new SupabaseAuthSessionProvider({ projectUrl: URL_! });

  // ---------------------------------------------------------------------
  section('TRUSTED TARGET SELECTED BEFORE ANY TOKEN WORK');
  let context = roster();
  const coordinator = new SharedDeviceAuthCoordinator(
    { auth: provider, context: { load: async () => context }, now },
    activeSwitchState(USER_A, 0),
  );

  const requested = await coordinator.request({
    switchRequestId: 'live-1', targetUserId: TEST_USER!,
    targetDisplayName: 'Live test user', deviceId: DEV,
  });
  if ('error' in requested) { bad('request', requested.error); process.exit(1); }
  ok('switch requested from the trusted roster, before verification');

  const attempt = coordinator.getState().attempt;
  attempt?.householdId === HH && attempt?.bindingGeneration === 7
    ? ok('household and binding generation derived from the trusted binding', `gen ${attempt.bindingGeneration}`)
    : bad('binding not derived from the trusted port');

  const confirmed = coordinator.confirm('live-1', TEST_USER!);
  if ('error' in confirmed) { bad('confirm', confirmed.error); process.exit(1); }
  ok('target confirmed (selection, not authentication)');

  coordinator.getState().activeUserId === USER_A
    ? ok('B is NOT active before authentication')
    : bad('B activated before any credential was verified');

  // ---------------------------------------------------------------------
  section('REAL TOKEN VERIFICATION');
  const probe = await provider.verify(TOKEN!);
  if (!('subjectId' in (probe as object))) {
    bad('token verification', (probe as { code?: string }).code ?? 'unknown');
    process.exit(1);
  }
  const verified = probe as { subjectId: string; sessionId: string; assuranceLevel?: string | null };
  ok('signature verified against the real project JWKS');

  if (verified.subjectId !== TEST_USER) {
    bad('token subject does not match SUPABASE_TEST_USER_ID',
      'the token belongs to a different user than the configured target');
    process.exit(1);
  }
  ok('verified subject equals the trusted test user');
  UUID.test(verified.sessionId)
    ? ok('real session_id propagated', verified.sessionId)
    : bad('session_id missing or malformed');
  console.log(`  assurance level: ${verified.assuranceLevel ?? '(none)'} (metadata only)`);

  // ---------------------------------------------------------------------
  section('FULL ACTIVATION THROUGH THE PRODUCTION COORDINATOR');
  const before = coordinator.getState().sessionGeneration;
  const outcome = await coordinator.authenticateAndActivate('live-1', TOKEN!);
  if (outcome.kind !== 'switched') {
    bad('activation refused', outcome.reason);
  } else {
    ok('B activated', outcome.session.userId);
    outcome.session.userId === TEST_USER
      ? ok('active session is the trusted target')
      : bad('activated the wrong user');
    outcome.state.sessionGeneration === before + 1
      ? ok('generation advanced exactly once', `${before} -> ${outcome.state.sessionGeneration}`)
      : bad('generation advance', `${before} -> ${outcome.state.sessionGeneration}`);
    outcome.state.sessionGeneration === outcome.session.sessionGeneration
      ? ok('generation adopted from activation, not recomputed')
      : bad('generation mismatch between machine and session');
  }

  // ---------------------------------------------------------------------
  section('ADVERSARIAL');

  // B's real token cannot satisfy a request targeting C.
  {
    context = roster();
    const c2 = new SharedDeviceAuthCoordinator(
      { auth: provider, context: { load: async () => context }, now },
      activeSwitchState(USER_A, 0));
    const r = await c2.request({
      switchRequestId: 'live-2', targetUserId: USER_C,
      targetDisplayName: 'Member C', deviceId: DEV });
    if (!('error' in r)) {
      c2.confirm('live-2', USER_C);
      const out = await c2.authenticateAndActivate('live-2', TOKEN!);
      out.kind === 'refused' && out.reason === 'target_mismatch'
        ? ok("B's real token cannot satisfy a request targeting C")
        : bad('wrong-target activation was not refused', JSON.stringify(out).slice(0, 70));
      c2.getState().activeUserId === USER_A
        ? ok('A remains active after the refusal')
        : bad('A was displaced by a refused switch');
    }
  }

  // A removed membership blocks activation even with a valid token.
  {
    context = roster({ targetStatus: 'removed' });
    const c3 = new SharedDeviceAuthCoordinator(
      { auth: provider, context: { load: async () => context }, now },
      activeSwitchState(USER_A, 0));
    const r = await c3.request({
      switchRequestId: 'live-3', targetUserId: TEST_USER!,
      targetDisplayName: 'Live test user', deviceId: DEV });
    if (!('error' in r)) {
      c3.confirm('live-3', TEST_USER!);
      const out = await c3.authenticateAndActivate('live-3', TOKEN!);
      out.kind === 'refused'
        ? ok('a removed membership blocks activation', out.reason)
        : bad('a removed member was activated');
    }
  }

  // A rebind between request and credential blocks activation.
  {
    context = roster({ bindingGeneration: 7 });
    const c4 = new SharedDeviceAuthCoordinator(
      { auth: provider, context: { load: async () => context }, now },
      activeSwitchState(USER_A, 0));
    const r = await c4.request({
      switchRequestId: 'live-4', targetUserId: TEST_USER!,
      targetDisplayName: 'Live test user', deviceId: DEV });
    if (!('error' in r)) {
      c4.confirm('live-4', TEST_USER!);
      // The device rebinds while the credential is in flight.
      context = roster({ bindingGeneration: 8 });
      const out = await c4.authenticateAndActivate('live-4', TOKEN!);
      out.kind === 'refused' && out.reason === 'binding_changed'
        ? ok('a changed binding generation blocks activation')
        : bad('rebind was not detected', JSON.stringify(out).slice(0, 70));
      c4.getState().activeUserId === USER_A
        ? ok('A remains active after a rebind refusal')
        : bad('A was displaced by a rebind refusal');
    }
  }

  console.log(failures === 0
    ? '\nPASS — real Supabase credential drove the full shared-device switch'
    : `\nFAIL — ${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
