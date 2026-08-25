import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DeterministicVoiceParser, type CorrelatedVoiceDelivery } from '@macros/domain-voice';
import { VoiceOrchestrator } from '@macros/voice-orchestration';
import { TabletAppController, type AppEnvironment, type AppSubject } from '@macros/tablet-app-core';
import {
  InMemoryEnergyGoalRepository, InMemoryFoodLogRepository,
  InMemoryProductVersionRepository, InMemoryUserProfileRepository,
  type PersistedLoopRepositories,
} from '@macros/persistence';
import { instant, type EnergyGoalVersion, type Instant } from '@macros/contracts';
import type { LoopPolicies } from '@macros/core-loop';
import type {
  AssistantInterpretationInput, AssistantInterpretationResult,
  AssistantInterpreter, IntentProposal,
} from '@macros/assistant-core';
import {
  PROFILE_MALE_35, PROFILE_FEMALE_29, SYNTHETIC_BRANDED_HEADS, SYNTHETIC_BRANDED_PRODUCTS,
  SYNTHETIC_CATALOG_HEADS, SYNTHETIC_PRODUCTS, SYNTHETIC_STABILITY_POLICY,
  TEST_TEF_POLICY, USER_A, USER_B, activeEnergy,
} from '@macros/testkit';

const TZ = 'America/Chicago';
const START = '2026-08-22T16:50:00.000Z';
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

/** A real barrier: the interpreter blocks until the test releases it. */
class BarrierInterpreter implements AssistantInterpreter {
  readonly providerKind = 'barrier';
  readonly modelVersion = '1.0';
  private release!: () => void;
  readonly entered: Promise<void>;
  private signalEntered!: () => void;
  private readonly gate: Promise<void>;

  constructor(private readonly proposals: readonly IntentProposal[]) {
    this.gate = new Promise<void>((r) => { this.release = r; });
    this.entered = new Promise<void>((r) => { this.signalEntered = r; });
  }
  async interpret(_input: AssistantInterpretationInput): Promise<AssistantInterpretationResult> {
    this.signalEntered();
    await this.gate;
    return { status: 'proposed', proposals: this.proposals };
  }
  open(): void { this.release(); }
}

/** Blocks the food-log repository write so a confirm can be held mid-flight. */
class BlockingFoodLogRepository extends InMemoryFoodLogRepository {
  private gate: Promise<void> | null = null;
  private release: (() => void) | null = null;
  private enteredSignal: (() => void) | null = null;
  entered: Promise<void> = Promise.resolve();

  block(): void {
    this.gate = new Promise<void>((r) => { this.release = r; });
    this.entered = new Promise<void>((r) => { this.enteredSignal = r; });
  }
  open(): void { this.release?.(); this.gate = null; }
  override async append(item: Parameters<InMemoryFoodLogRepository['append']>[0]) {
    if (this.gate !== null) {
      this.enteredSignal?.();
      await this.gate;
    }
    return super.append(item);
  }
}

async function harness(interpreter: AssistantInterpreter | null = null) {
  const foodLogs = new BlockingFoodLogRepository();
  const repos: PersistedLoopRepositories = {
    foodLogs,
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
  return {
    app, foodLogs, repos,
    voice: new VoiceOrchestrator(app, new DeterministicVoiceParser(), interpreter),
  };
}
type H = Awaited<ReturnType<typeof harness>>;

const delivery = (h: H, transcript: string, o: Partial<CorrelatedVoiceDelivery> & { turn: number }): CorrelatedVoiceDelivery => ({
  transcript,
  receivedAt: instant(new Date(Date.parse(START) + o.turn * 1000).toISOString()),
  userId: o.userId ?? h.app.getState().subject.userId,
  utteranceId: o.utteranceId ?? `stt-${o.turn}`,
  sessionGeneration: o.sessionGeneration ?? h.app.getState().sessionGeneration,
  turnSequence: o.turn,
  flowIdAtCapture: o.flowIdAtCapture !== undefined ? o.flowIdAtCapture : h.app.getState().addFood.flowId,
});

const logsOf = async (h: H, userId = USER_A) =>
  h.repos.foodLogs.listByLocalDate(userId, h.app.getState().dashboard!.localDate);

const reachReview = async (h: H) => {
  await h.voice.handle(delivery(h, 'add chicken breast', { turn: 1 }));
  const cooked = h.app.getState().addFood.results
    .find((r) => r.productVersion.preparationState === 'cooked')!;
  await h.voice.handle(delivery(h, `option ${cooked.optionLabel}`, { turn: 2 }));
  await h.voice.handle(delivery(h, '200 grams', { turn: 3 }));
  assert.equal(h.app.getState().addFood.phase, 'reviewing');
};

// ---------------------------------------------------------------------------

describe('A10.1 — an older turn cannot execute while a newer one is in flight', () => {
  test('turn 10 arriving during turn 11 is stale', async () => {
    const barrier = new BarrierInterpreter([{ intentKind: 'cancel' }]);
    const h = await harness(barrier);
    await h.voice.handle(delivery(h, 'add chicken breast', { turn: 1 }));

    // Turn 11 enters the interpreter and BLOCKS there.
    const inFlight = h.voice.handle(delivery(h, 'mumble something novel', { turn: 11, utteranceId: 'x11' }));
    await barrier.entered;

    // Turn 10 arrives while 11 is still executing.
    const late = await h.voice.handle(delivery(h, 'option A', { turn: 10, utteranceId: 'x10' }));
    assert.equal(late.kind, 'error');
    if (late.kind === 'error') assert.equal(late.reason, 'stale_turn');
    assert.equal(h.app.getState().addFood.selected, null, 'nothing selected');

    barrier.open();
    await inFlight;
  });

  test('the high-water mark does not roll back when the newer turn fails', async () => {
    const barrier = new BarrierInterpreter([{ intentKind: 'delete_database' }]); // will be rejected
    const h = await harness(barrier);
    await h.voice.handle(delivery(h, 'add chicken breast', { turn: 1 }));

    const inFlight = h.voice.handle(delivery(h, 'mumble something novel', { turn: 11, utteranceId: 'y11' }));
    await barrier.entered;
    barrier.open();
    const refused = await inFlight;
    assert.equal(refused.kind, 'clarification', 'turn 11 was refused');

    // Turn 10 must STILL be stale — a refusal does not un-advance the sequence.
    const late = await h.voice.handle(delivery(h, 'option A', { turn: 10, utteranceId: 'y10' }));
    assert.equal(late.kind, 'error');
    if (late.kind === 'error') assert.equal(late.reason, 'stale_turn');
  });
});

describe('A10.2/A10.4 — concurrent duplicates', () => {
  test('a duplicate delivered while the original is in flight does not execute', async () => {
    const barrier = new BarrierInterpreter([{ intentKind: 'cancel' }]);
    const h = await harness(barrier);

    const first = h.voice.handle(delivery(h, 'mumble something novel', { turn: 5, utteranceId: 'dup' }));
    await barrier.entered;

    const second = await h.voice.handle(delivery(h, 'mumble something novel', { turn: 5, utteranceId: 'dup' }));
    assert.equal(second.kind, 'error');
    if (second.kind === 'error') assert.equal(second.reason, 'duplicate_in_flight');

    barrier.open();
    await first;
  });

  test('concurrent duplicate "log it" writes EXACTLY ONE FoodLogItem', async () => {
    const h = await harness();
    await reachReview(h);

    // Hold the repository write open so both confirmations overlap for real.
    h.foodLogs.block();
    const a = h.voice.handle(delivery(h, 'log it', { turn: 4, utteranceId: 'log-dup' }));
    await h.foodLogs.entered;
    const b = await h.voice.handle(delivery(h, 'log it', { turn: 4, utteranceId: 'log-dup' }));

    assert.equal(b.kind, 'error');
    if (b.kind === 'error') assert.equal(b.reason, 'duplicate_in_flight');

    h.foodLogs.open();
    const first = await a;
    assert.equal(first.kind, 'success');
    assert.equal((await logsOf(h)).length, 1, 'exactly one log');
  });

  test('two DIFFERENT ids confirming the same review still yield one log', async () => {
    const h = await harness();
    await reachReview(h);

    h.foodLogs.block();
    const a = h.voice.handle(delivery(h, 'log it', { turn: 4, utteranceId: 'log-a' }));
    await h.foodLogs.entered;
    // Different id and a newer turn, so delivery safety does not stop it —
    // the application's submission idempotency must.
    const b = h.voice.handle(delivery(h, 'log it', { turn: 5, utteranceId: 'log-b' }));

    h.foodLogs.open();
    await a; await b;
    assert.equal((await logsOf(h)).length, 1, 'one review state, one log');
  });

  test('a completed duplicate replays the canonical response', async () => {
    const h = await harness();
    const first = await h.voice.handle(delivery(h, 'add chicken breast', { turn: 1, utteranceId: 'c1' }));
    const replay = await h.voice.handle(delivery(h, 'add chicken breast', { turn: 1, utteranceId: 'c1' }));
    assert.deepEqual(replay, first);
  });
});

describe('A10.3 — same id, different transcript', () => {
  test('a conflicting transcript is refused while the original is in flight', async () => {
    const barrier = new BarrierInterpreter([{ intentKind: 'cancel' }]);
    const h = await harness(barrier);
    await h.voice.handle(delivery(h, 'add chicken breast', { turn: 1 }));

    const first = h.voice.handle(delivery(h, 'mumble something novel', { turn: 5, utteranceId: 'conf' }));
    await barrier.entered;

    const conflict = await h.voice.handle(delivery(h, 'option B', { turn: 6, utteranceId: 'conf' }));
    assert.equal(conflict.kind, 'error');
    if (conflict.kind === 'error') assert.equal(conflict.reason, 'delivery_conflict');
    assert.equal(h.app.getState().addFood.selected, null, 'B never executed');

    barrier.open();
    await first;
  });
});

describe('A10.5/A10.7 — flow changes while the interpreter is in flight', () => {
  test('a delayed selection cannot select the NEW flow\'s option', async () => {
    const barrier = new BarrierInterpreter([
      { intentKind: 'select_option', arguments: { optionLabel: 'B' } },
    ]);
    const h = await harness(barrier);

    await h.voice.handle(delivery(h, 'add chicken breast', { turn: 1 }));
    const flow1 = h.app.getState().addFood.flowId;

    // "the second one" enters interpretation, captured against flow 1.
    const inFlight = h.voice.handle(
      delivery(h, 'the second one there', { turn: 2, utteranceId: 's1', flowIdAtCapture: flow1 }),
    );
    await barrier.entered;

    // A new flow becomes active while interpretation is still running.
    await h.voice.handle(delivery(h, 'add demo brand oats', { turn: 3, utteranceId: 's2' }));
    const flow2 = h.app.getState().addFood.flowId;
    assert.notEqual(flow1, flow2);

    barrier.open();
    const result = await inFlight;

    assert.equal(result.kind, 'error');
    if (result.kind === 'error') assert.equal(result.reason, 'stale_flow');
    assert.equal(h.app.getState().addFood.selected, null, "flow 2's B was not selected");
  });

  test('a delayed "log it" cannot log a different flow', async () => {
    const barrier = new BarrierInterpreter([{ intentKind: 'confirm_log' }]);
    const h = await harness(barrier);

    await reachReview(h);
    const flow1 = h.app.getState().addFood.flowId;

    const inFlight = h.voice.handle(
      delivery(h, 'go ahead and put that in', { turn: 4, utteranceId: 'l1', flowIdAtCapture: flow1 }),
    );
    await barrier.entered;

    // Flow 1 is cancelled and a new flow reaches review.
    await h.voice.handle(delivery(h, 'cancel', { turn: 5, utteranceId: 'l2' }));
    await h.voice.handle(delivery(h, 'add demo brand oats', { turn: 6, utteranceId: 'l3' }));
    const oats = h.app.getState().addFood.results[0]!;
    await h.voice.handle(delivery(h, `option ${oats.optionLabel}`, { turn: 7, utteranceId: 'l4' }));
    await h.voice.handle(delivery(h, '100 grams', { turn: 8, utteranceId: 'l5' }));

    barrier.open();
    const result = await inFlight;

    assert.equal(result.kind, 'error');
    if (result.kind === 'error') assert.equal(result.reason, 'stale_flow');
    assert.equal((await logsOf(h)).length, 0, 'flow 2 was not logged by flow 1\'s words');
  });
});

describe('A10.6 — session switch while work is in flight', () => {
  test('an old-session interpretation cannot mutate the new session', async () => {
    const barrier = new BarrierInterpreter([
      { intentKind: 'search_food', arguments: { query: 'chicken breast' } },
    ]);
    const h = await harness(barrier);

    const inFlight = h.voice.handle(delivery(h, 'mumble something novel', { turn: 5, utteranceId: 'sess' }));
    await barrier.entered;

    // The active session changes while interpretation is still running.
    await h.app.switchActiveUser(subjectFor(USER_B, 'Dev B'), activeEnergy(300));
    const stateBefore = JSON.stringify(h.app.getState());

    barrier.open();
    const result = await inFlight;

    assert.equal(result.kind, 'error');
    // Switching users changes BOTH the subject and the generation; either is a
    // correct refusal, and 'wrong_user' is the more precise of the two.
    if (result.kind === 'error') {
      assert.ok(
        result.reason === 'wrong_user' || result.reason === 'stale_session',
        `expected a staleness refusal, got ${result.reason}`,
      );
    }
    assert.equal(JSON.stringify(h.app.getState()), stateBefore, "B's session untouched");
  });

  test("an old-session confirm cannot write into the new user's day", async () => {
    const barrier = new BarrierInterpreter([{ intentKind: 'confirm_log' }]);
    const h = await harness(barrier);
    await reachReview(h);

    const inFlight = h.voice.handle(delivery(h, 'go ahead and put that in', { turn: 4, utteranceId: 'sw' }));
    await barrier.entered;
    await h.app.switchActiveUser(subjectFor(USER_B, 'Dev B'), activeEnergy(300));

    barrier.open();
    await inFlight;

    assert.equal((await logsOf(h, USER_B)).length, 0, "nothing written for B");
    assert.equal((await logsOf(h, USER_A)).length, 0, "and nothing written for A either");
  });
});

describe('A8/A9 — correlation is mandatory at the executable boundary', () => {
  const missing = (h: H, omit: string) => {
    const base = { ...delivery(h, 'add chicken breast', { turn: 1 }) } as unknown as Record<string, unknown>;
    delete base[omit];
    return h.voice.handle(base as unknown as CorrelatedVoiceDelivery);
  };

  for (const field of ['utteranceId', 'sessionGeneration', 'turnSequence', 'receivedAt', 'userId', 'flowIdAtCapture']) {
    test(`omitting ${field} is refused, not silently downgraded`, async () => {
      const h = await harness();
      const r = await missing(h, field);
      assert.equal(r.kind, 'error');
      if (r.kind === 'error') assert.equal(r.reason, 'invalid_delivery');
      assert.equal(h.app.getState().addFood.results.length, 0, 'zero side effects');
    });
  }

  test('a flow-scoped command with null flow context is refused', async () => {
    const h = await harness();
    await h.voice.handle(delivery(h, 'add chicken breast', { turn: 1 }));
    const r = await h.voice.handle(
      delivery(h, 'option A', { turn: 2, flowIdAtCapture: null }),
    );
    assert.equal(r.kind, 'error');
    if (r.kind === 'error') assert.equal(r.reason, 'missing_flow_context');
    assert.equal(h.app.getState().addFood.selected, null);
  });

  test('a flow-INDEPENDENT command with null flow context is fine', async () => {
    const h = await harness();
    const r = await h.voice.handle(
      delivery(h, 'add chicken breast', { turn: 1, flowIdAtCapture: null }),
    );
    assert.equal(r.kind, 'options', 'search legitimately starts a flow');
  });
});
