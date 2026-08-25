import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DeterministicVoiceParser, type VoiceUtterance } from '@macros/domain-voice';
import { VoiceOrchestrator } from '@macros/voice-orchestration';
import { TabletAppController, DevScaleAdapter, type AppEnvironment, type AppSubject } from '@macros/tablet-app-core';
import {
  InMemoryEnergyGoalRepository, InMemoryFoodLogRepository,
  InMemoryProductVersionRepository, InMemoryUserProfileRepository,
  type PersistedLoopRepositories,
} from '@macros/persistence';
import { instant, type EnergyGoalVersion, type Instant } from '@macros/contracts';
import type { LoopPolicies } from '@macros/core-loop';
import {
  PROFILE_MALE_35, PROFILE_FEMALE_29, SYNTHETIC_BRANDED_HEADS, SYNTHETIC_BRANDED_PRODUCTS,
  SYNTHETIC_CATALOG_HEADS, SYNTHETIC_PRODUCTS, SYNTHETIC_STABILITY_POLICY,
  TEST_TEF_POLICY, USER_A, USER_B, activeEnergy,
} from '@macros/testkit';

const TZ = 'America/Chicago';
const START = '2026-08-21T16:50:00.000Z';
const POLICIES: LoopPolicies = { tefPolicy: { status: 'available', policy: TEST_TEF_POLICY } };

class FixedClock {
  private ms = Date.parse(START);
  now(): Instant { return instant(new Date(this.ms).toISOString()); }
  advance(ms: number): void { this.ms += ms; }
}
class SequenceIds {
  private n = 0;
  next(): string { this.n += 1; return `00000000-0000-4000-8000-${String(this.n).padStart(12, '0')}`; }
}
const subjectFor = (u: string, n: string): AppSubject => ({ authenticatedSubjectId: u, userId: u, displayName: n });
const goalFor = (u: string, id: string, d: number): EnergyGoalVersion => ({
  goalVersionId: id, userId: u, effectiveFrom: instant('2026-01-01T00:00:00.000Z'),
  goal: d > 0 ? 'gain' : d < 0 ? 'lose' : 'maintain', targetDeltaKcal: d,
});

async function harness() {
  const repos: PersistedLoopRepositories = {
    foodLogs: new InMemoryFoodLogRepository(),
    products: new InMemoryProductVersionRepository(
      [...SYNTHETIC_PRODUCTS, ...SYNTHETIC_BRANDED_PRODUCTS],
      [...SYNTHETIC_CATALOG_HEADS, ...SYNTHETIC_BRANDED_HEADS],
    ),
    profiles: new InMemoryUserProfileRepository(),
    goals: new InMemoryEnergyGoalRepository(),
  };
  await repos.profiles.append(PROFILE_MALE_35);
  await repos.profiles.append(PROFILE_FEMALE_29);
  await repos.goals.append(goalFor(USER_A, 'ga', 250));
  await repos.goals.append(goalFor(USER_B, 'gb', -400));
  const clock = new FixedClock();
  const env: AppEnvironment = {
    repositories: repos, clock, ids: new SequenceIds(), policies: POLICIES,
    stabilityPolicy: SYNTHETIC_STABILITY_POLICY, timezone: TZ,
  };
  const app = new TabletAppController(env, subjectFor(USER_A, 'Dev A'), activeEnergy(500));
  await app.refreshDashboard();
  return { app, scale: new DevScaleAdapter(START, clock), voice: new VoiceOrchestrator(app), repos, clock };
}
type H = Awaited<ReturnType<typeof harness>>;

let seq = 0;
/** A fully correlated delivery, as a real STT adapter would produce. */
const speak = (
  h: H,
  transcript: string,
  opts: Partial<VoiceUtterance> & { turn?: number } = {},
) => {
  const state = h.app.getState();
  seq += 1;
  const u: VoiceUtterance = {
    transcript,
    receivedAt: instant(new Date(Date.parse(START) + seq * 1000).toISOString()),
    userId: opts.userId ?? state.subject.userId,
    utteranceId: opts.utteranceId ?? `stt-${seq}`,
    sessionGeneration: opts.sessionGeneration ?? state.sessionGeneration,
    turnSequence: opts.turnSequence ?? opts.turn ?? seq,
    ...(opts.flowIdAtCapture !== undefined ? { flowIdAtCapture: opts.flowIdAtCapture } : {}),
    ...(opts.receivedAt !== undefined ? { receivedAt: opts.receivedAt } : {}),
  };
  return h.voice.handle(u);
};

const currentFlowId = (h: H) => h.app.getState().addFood.flowId;
const optionLabels = (h: H) => h.app.getState().addFood.results.map((r) => r.optionLabel);
const logsOf = async (h: H, userId = USER_A) =>
  h.repos.foodLogs.listByLocalDate(userId, h.app.getState().dashboard!.localDate);

// ---------------------------------------------------------------------------

describe('A1 — session generation', () => {
  test('an utterance from a dead session cannot act on the new one', async () => {
    const h = await harness();
    await speak(h, 'add chicken breast');
    const deadGeneration = h.app.getState().sessionGeneration;

    await h.app.switchActiveUser(subjectFor(USER_B, 'Dev B'), activeEnergy(300));
    assert.notEqual(h.app.getState().sessionGeneration, deadGeneration);

    for (const transcript of ['add yogurt', 'option A', 'weigh it', '100 grams', 'log it',
                              'how many calories have I eaten today']) {
      const r = await speak(h, transcript, {
        userId: USER_B,
        sessionGeneration: deadGeneration,
        utteranceId: `dead-${transcript}`,
      });
      assert.equal(r.kind, 'error', transcript);
      if (r.kind === 'error') assert.equal(r.reason, 'stale_session', transcript);
    }

    assert.equal(h.app.getState().addFood.results.length, 0, 'zero side effects');
    assert.equal(h.app.getState().addFood.selected, null);
    assert.equal((await logsOf(h, USER_B)).length, 0);
  });

  test('a matching generation is accepted', async () => {
    const h = await harness();
    const r = await speak(h, 'add chicken breast');
    assert.equal(r.kind, 'options');
  });
});

describe('A2 — monotonic turn sequence', () => {
  test('a delayed older turn cannot execute after a newer one', async () => {
    const h = await harness();
    // Turn 10 ("option B") is delayed in recognition; turn 11 lands first.
    await speak(h, 'add chicken breast', { turn: 11, utteranceId: 'stt-11' });
    const labels = optionLabels(h);
    assert.ok(labels.includes('B'));

    const late = await speak(h, 'option B', { turn: 10, utteranceId: 'stt-10' });
    assert.equal(late.kind, 'error');
    if (late.kind === 'error') assert.equal(late.reason, 'stale_turn');
    assert.equal(h.app.getState().addFood.selected, null, 'nothing was selected');
  });

  test('an equal turn number is also stale', async () => {
    const h = await harness();
    await speak(h, 'add chicken breast', { turn: 5, utteranceId: 'stt-5' });
    const same = await speak(h, 'option A', { turn: 5, utteranceId: 'stt-5b' });
    assert.equal(same.kind, 'error');
    if (same.kind === 'error') assert.equal(same.reason, 'stale_turn');
  });

  test('increasing turns proceed normally', async () => {
    const h = await harness();
    await speak(h, 'add chicken breast', { turn: 1, utteranceId: 'a' });
    const r = await speak(h, 'option A', { turn: 2, utteranceId: 'b' });
    assert.notEqual(r.kind, 'error');
    assert.notEqual(h.app.getState().addFood.selected, null);
  });

  test('the turn high-water mark resets with a new session', async () => {
    const h = await harness();
    await speak(h, 'add chicken breast', { turn: 50, utteranceId: 'high' });
    await h.app.switchActiveUser(subjectFor(USER_B, 'Dev B'), activeEnergy(300));

    // A fresh session starts counting again; turn 1 is not stale here.
    const r = await speak(h, 'add chicken breast', { userId: USER_B, turn: 1, utteranceId: 'new-1' });
    assert.equal(r.kind, 'options');
  });
});

describe('A3 — utterance idempotency', () => {
  const stateChanging: readonly string[] = ['add chicken breast', 'cancel'];

  for (const transcript of stateChanging) {
    test(`duplicate delivery of "${transcript}" performs one action`, async () => {
      const h = await harness();
      const first = await speak(h, transcript, { utteranceId: 'dup-1', turn: 1 });
      const again = await h.voice.handle({
        transcript,
        receivedAt: instant(new Date(Date.parse(START) + 60_000).toISOString()),
        userId: USER_A,
        utteranceId: 'dup-1',
        sessionGeneration: h.app.getState().sessionGeneration,
        turnSequence: 1,
      });
      assert.deepEqual(again, first, 'the original response is replayed verbatim');
    });
  }

  test('duplicate "log it" never writes a second FoodLogItem', async () => {
    const h = await harness();
    await speak(h, 'add chicken breast', { turn: 1 });
    const cooked = h.app.getState().addFood.results.find((r) => r.productVersion.preparationState === 'cooked')!;
    await speak(h, `option ${cooked.optionLabel}`, { turn: 2 });
    await speak(h, '200 grams', { turn: 3 });

    const first = await speak(h, 'log it', { turn: 4, utteranceId: 'log-once' });
    const replay = await h.voice.handle({
      transcript: 'log it',
      receivedAt: instant(new Date(Date.parse(START) + 90_000).toISOString()),
      userId: USER_A,
      utteranceId: 'log-once',
      sessionGeneration: h.app.getState().sessionGeneration,
      turnSequence: 4,
    });

    assert.equal(first.kind, 'success');
    assert.deepEqual(replay, first);
    assert.equal((await logsOf(h)).length, 1);
  });

  test('duplicate "manual weight" does not re-apply', async () => {
    const h = await harness();
    await speak(h, 'add chicken breast', { turn: 1 });
    await speak(h, `option ${optionLabels(h)[0]}`, { turn: 2 });

    const first = await speak(h, '150 grams', { turn: 3, utteranceId: 'w-1' });
    const replay = await h.voice.handle({
      transcript: '150 grams',
      receivedAt: instant(new Date(Date.parse(START) + 30_000).toISOString()),
      userId: USER_A,
      utteranceId: 'w-1',
      sessionGeneration: h.app.getState().sessionGeneration,
      turnSequence: 3,
    });
    assert.deepEqual(replay, first);
    assert.equal(h.app.getState().addFood.weightCapture!.grams, 150);
  });
});

describe('A4 — same id, different transcript is a conflict', () => {
  test('the second reading executes neither command', async () => {
    const h = await harness();
    await speak(h, 'add chicken breast', { turn: 1 });

    const first = await speak(h, 'option A', { turn: 2, utteranceId: 'ambig' });
    assert.notEqual(first.kind, 'error');
    const selectedAfterFirst = h.app.getState().addFood.selected;

    const conflict = await h.voice.handle({
      transcript: 'option B',
      receivedAt: instant(new Date(Date.parse(START) + 20_000).toISOString()),
      userId: USER_A,
      utteranceId: 'ambig',
      sessionGeneration: h.app.getState().sessionGeneration,
      turnSequence: 3,
    });

    assert.equal(conflict.kind, 'error');
    if (conflict.kind === 'error') assert.equal(conflict.reason, 'delivery_conflict');
    assert.deepEqual(
      h.app.getState().addFood.selected,
      selectedAfterFirst,
      'not reinterpreted as a retry, and B was not selected',
    );
  });

  test('trivial whitespace/case differences are still the same delivery', async () => {
    const h = await harness();
    const first = await speak(h, 'add chicken breast', { turn: 1, utteranceId: 'same' });
    const again = await h.voice.handle({
      transcript: '  Add   Chicken Breast  ',
      receivedAt: instant(new Date(Date.parse(START) + 5_000).toISOString()),
      userId: USER_A,
      utteranceId: 'same',
      sessionGeneration: h.app.getState().sessionGeneration,
      turnSequence: 1,
    });
    assert.deepEqual(again, first, 'a replay, not a conflict');
  });
});

describe('A5 — flow context safety', () => {
  test('a delayed "Option B" cannot select the NEW flow\'s B', async () => {
    const h = await harness();
    await speak(h, 'add chicken breast', { turn: 1 });
    const oldFlow = currentFlowId(h);
    const oldB = h.app.getState().addFood.results.find((r) => r.optionLabel === 'B')!;

    // A new flow starts before the delayed transcript executes.
    await speak(h, 'add demo brand oats', { turn: 2 });
    const newFlow = currentFlowId(h);
    assert.notEqual(oldFlow, newFlow);
    const newB = h.app.getState().addFood.results.find((r) => r.optionLabel === 'B');

    const late = await speak(h, 'option B', { turn: 3, flowIdAtCapture: oldFlow });
    assert.equal(late.kind, 'error');
    if (late.kind === 'error') assert.equal(late.reason, 'stale_flow');

    assert.equal(h.app.getState().addFood.selected, null, "the new flow's B was not selected");
    void oldB; void newB;
  });

  test('a delayed "log it" cannot log a different flow', async () => {
    const h = await harness();
    // Flow 1 reaches review.
    await speak(h, 'add chicken breast', { turn: 1 });
    await speak(h, `option ${optionLabels(h)[0]}`, { turn: 2 });
    await speak(h, '200 grams', { turn: 3 });
    const flow1 = currentFlowId(h);
    assert.equal(h.app.getState().addFood.phase, 'reviewing');

    // Flow 1 is cancelled; flow 2 reaches review with a different food.
    await speak(h, 'cancel', { turn: 4 });
    await speak(h, 'add demo brand oats', { turn: 5 });
    await speak(h, `option ${optionLabels(h)[0]}`, { turn: 6 });
    await speak(h, '100 grams', { turn: 7 });
    const flow2 = currentFlowId(h);
    assert.notEqual(flow1, flow2);

    const late = await speak(h, 'log it', { turn: 8, flowIdAtCapture: flow1 });
    assert.equal(late.kind, 'error');
    if (late.kind === 'error') assert.equal(late.reason, 'stale_flow');
    assert.equal((await logsOf(h)).length, 0, 'flow 2 was not logged by flow 1\'s words');
  });

  test('search may legitimately start a new flow even when captured in an old one', async () => {
    const h = await harness();
    await speak(h, 'add chicken breast', { turn: 1 });
    const oldFlow = currentFlowId(h);
    await speak(h, 'cancel', { turn: 2 });

    const r = await speak(h, 'add demo brand oats', { turn: 3, flowIdAtCapture: oldFlow });
    assert.equal(r.kind, 'options', 'a search is not flow-scoped');
  });

  test('a matching flow id proceeds', async () => {
    const h = await harness();
    await speak(h, 'add chicken breast', { turn: 1 });
    const r = await speak(h, 'option A', { turn: 2, flowIdAtCapture: currentFlowId(h) });
    assert.notEqual(r.kind, 'error');
    assert.notEqual(h.app.getState().addFood.selected, null);
  });
});

describe('A6 — receivedAt is validated, not ceremonial', () => {
  test('an unparseable receivedAt is rejected with zero side effects', async () => {
    const h = await harness();
    const r = await h.voice.handle({
      transcript: 'add chicken breast',
      receivedAt: 'not-a-timestamp' as never,
      userId: USER_A,
      utteranceId: 'bad-ts',
      sessionGeneration: h.app.getState().sessionGeneration,
      turnSequence: 1,
    });
    assert.equal(r.kind, 'error');
    if (r.kind === 'error') assert.equal(r.reason, 'invalid_received_at');
    assert.equal(h.app.getState().addFood.results.length, 0);
  });

  test('wall-clock age alone never rejects a correlated turn', async () => {
    const h = await harness();
    // Very old timestamp, but session/turn/flow all current: still valid.
    const r = await h.voice.handle({
      transcript: 'add chicken breast',
      receivedAt: instant('2020-01-01T00:00:00.000Z'),
      userId: USER_A,
      utteranceId: 'ancient',
      sessionGeneration: h.app.getState().sessionGeneration,
      turnSequence: 1,
    });
    assert.equal(r.kind, 'options', 'correlation decides staleness, not the clock');
  });
});

describe('A7/A8 — parser independence and identity', () => {
  test('the parser knows nothing about delivery', () => {
    const parser = new DeterministicVoiceParser();
    const src = parser.constructor.toString();
    for (const term of ['session', 'turnSequence', 'flowId', 'replay']) {
      assert.equal(src.includes(term), false, `parser must not reference ${term}`);
    }
  });

  test('the parser still works standalone on a bare utterance', () => {
    const parser = new DeterministicVoiceParser();
    const r = parser.parse({
      transcript: '200 grams',
      receivedAt: instant(START),
      userId: USER_A,
    });
    assert.equal(r.status, 'understood');
  });

  test('a wrong user is rejected before anything else', async () => {
    const h = await harness();
    const r = await speak(h, 'add chicken breast', { userId: USER_B });
    assert.equal(r.kind, 'error');
    if (r.kind === 'error') assert.equal(r.reason, 'wrong_user');
    assert.equal(h.app.getState().addFood.results.length, 0);
  });

  test('deterministic INVALID results survive the delivery layer', async () => {
    const h = await harness();
    await speak(h, 'add chicken breast', { turn: 1 });
    await speak(h, `option ${optionLabels(h)[0]}`, { turn: 2 });

    const neg = await speak(h, '-50 grams', { turn: 3 });
    assert.equal(neg.kind, 'error');
    const oz = await speak(h, '3 ounces', { turn: 4 });
    assert.equal(oz.kind, 'error');
    assert.equal(h.app.getState().addFood.weightCapture, null);
  });
});
