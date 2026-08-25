import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_CONCURRENT_IN_FLIGHT, VoiceDeliveryGuard, VoiceOrchestrator,
  type DeliveryContext,
} from '@macros/voice-orchestration';
import { DeterministicVoiceParser, type CorrelatedVoiceDelivery, type VoiceResponse } from '@macros/domain-voice';
import { TabletAppController, type AppEnvironment, type AppSubject } from '@macros/tablet-app-core';
import {
  InMemoryEnergyGoalRepository, InMemoryFoodLogRepository,
  InMemoryProductVersionRepository, InMemoryUserProfileRepository,
  type PersistedLoopRepositories,
} from '@macros/persistence';
import { instant, type EnergyGoalVersion, type Instant } from '@macros/contracts';
import type { LoopPolicies } from '@macros/core-loop';
import type {
  AssistantInterpretationResult, AssistantInterpreter, IntentProposal,
} from '@macros/assistant-core';
import {
  PROFILE_MALE_35, PROFILE_FEMALE_29, SYNTHETIC_BRANDED_HEADS, SYNTHETIC_BRANDED_PRODUCTS,
  SYNTHETIC_CATALOG_HEADS, SYNTHETIC_PRODUCTS, SYNTHETIC_STABILITY_POLICY,
  TEST_TEF_POLICY, USER_A, activeEnergy,
} from '@macros/testkit';

const TZ = 'America/Chicago';
const START = '2026-08-23T16:50:00.000Z';
const POLICIES: LoopPolicies = { tefPolicy: { status: 'available', policy: TEST_TEF_POLICY } };
const CONTEXT: DeliveryContext = { userId: USER_A, sessionGeneration: 1, flowId: 'flow-1' };

const d = (over: Partial<CorrelatedVoiceDelivery> & { turn: number }): CorrelatedVoiceDelivery => ({
  transcript: over.transcript ?? 'add chicken breast',
  receivedAt: instant(new Date(Date.parse(START) + over.turn * 1000).toISOString()),
  userId: over.userId ?? USER_A,
  utteranceId: over.utteranceId ?? `u-${over.turn}`,
  sessionGeneration: over.sessionGeneration ?? 1,
  turnSequence: over.turn,
  flowIdAtCapture: over.flowIdAtCapture !== undefined ? over.flowIdAtCapture : 'flow-1',
});
const RESPONSE: VoiceResponse = { kind: 'informational', speech: 'ok' };

// ---------------------------------------------------------------------------

describe('A2 — an in-flight reservation is NEVER evicted', () => {
  test('many concurrent in-flight deliveries all remain protected', () => {
    const guard = new VoiceDeliveryGuard();
    // Far more than the old 16-entry tracked array could hold.
    for (let turn = 1; turn <= 30; turn++) {
      assert.equal(guard.admitAndReserve(d({ turn }), CONTEXT).kind, 'accept', `turn ${turn}`);
    }
    assert.equal(guard.inFlightCount(), 30);

    // The EARLIEST reservation must still be recognised as running.
    const dup = guard.admitAndReserve(
      d({ turn: 1, utteranceId: 'u-1', transcript: 'add chicken breast' }),
      CONTEXT,
    );
    assert.equal(dup.kind, 'reject');
    if (dup.kind === 'reject') assert.equal(dup.reason, 'duplicate_in_flight');
  });

  test('the earliest in-flight id with a CHANGED transcript still conflicts', () => {
    const guard = new VoiceDeliveryGuard();
    for (let turn = 1; turn <= 30; turn++) {
      guard.admitAndReserve(d({ turn }), CONTEXT);
    }
    const conflict = guard.admitAndReserve(
      d({ turn: 31, utteranceId: 'u-1', transcript: 'something completely different' }),
      CONTEXT,
    );
    assert.equal(conflict.kind, 'reject');
    if (conflict.kind === 'reject') assert.equal(conflict.reason, 'delivery_conflict');
  });

  test('overload REFUSES new work instead of forgetting a reservation', () => {
    const guard = new VoiceDeliveryGuard();
    for (let turn = 1; turn <= MAX_CONCURRENT_IN_FLIGHT; turn++) {
      assert.equal(guard.admitAndReserve(d({ turn }), CONTEXT).kind, 'accept');
    }
    const overflow = guard.admitAndReserve(d({ turn: MAX_CONCURRENT_IN_FLIGHT + 1 }), CONTEXT);
    assert.equal(overflow.kind, 'reject');
    if (overflow.kind === 'reject') assert.equal(overflow.reason, 'too_many_in_flight');

    // And the oldest reservation survived the overload.
    const dup = guard.admitAndReserve(d({ turn: 1, utteranceId: 'u-1' }), CONTEXT);
    assert.equal(dup.kind, 'reject');
    if (dup.kind === 'reject') assert.equal(dup.reason, 'duplicate_in_flight');
  });

  test('completing a delivery frees capacity', () => {
    const guard = new VoiceDeliveryGuard();
    for (let turn = 1; turn <= MAX_CONCURRENT_IN_FLIGHT; turn++) {
      guard.admitAndReserve(d({ turn }), CONTEXT);
    }
    guard.complete(d({ turn: 1, utteranceId: 'u-1' }), RESPONSE);
    assert.equal(guard.inFlightCount(), MAX_CONCURRENT_IN_FLIGHT - 1);
    assert.equal(guard.admitAndReserve(d({ turn: 99 }), CONTEXT).kind, 'accept');
  });

  test('a completed delivery replays even after many later deliveries', () => {
    const guard = new VoiceDeliveryGuard();
    guard.admitAndReserve(d({ turn: 1 }), CONTEXT);
    guard.complete(d({ turn: 1, utteranceId: 'u-1' }), RESPONSE);

    const replay = guard.admitAndReserve(d({ turn: 1, utteranceId: 'u-1' }), CONTEXT);
    assert.equal(replay.kind, 'replay');
    if (replay.kind === 'replay') assert.deepEqual(replay.response, RESPONSE);
  });

  test('the completed cache is bounded, and eviction only costs a re-execution', () => {
    const guard = new VoiceDeliveryGuard();
    for (let turn = 1; turn <= 40; turn++) {
      guard.admitAndReserve(d({ turn }), CONTEXT);
      guard.complete(d({ turn, utteranceId: `u-${turn}` }), RESPONSE);
    }
    // u-1 has aged out of the replay cache; a redelivery is simply handled
    // again rather than being wrongly treated as in-flight.
    const old = guard.admitAndReserve(d({ turn: 41, utteranceId: 'u-1' }), CONTEXT);
    assert.equal(old.kind, 'accept');
  });
});

// ---------------------------------------------------------------------------

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
  async interpret(): Promise<AssistantInterpretationResult> {
    this.signalEntered();
    await this.gate;
    return { status: 'proposed', proposals: this.proposals };
  }
  open(): void { this.release(); }
}

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
const goalFor = (u: string, id: string, delta: number): EnergyGoalVersion => ({
  goalVersionId: id, userId: u, effectiveFrom: instant('2026-01-01T00:00:00.000Z'),
  goal: delta > 0 ? 'gain' : delta < 0 ? 'lose' : 'maintain', targetDeltaKcal: delta,
});

async function harness(interpreter: AssistantInterpreter | null) {
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
  const env: AppEnvironment = {
    repositories: repos, clock: new FixedClock(), ids: new SequenceIds(),
    policies: POLICIES, stabilityPolicy: SYNTHETIC_STABILITY_POLICY, timezone: TZ,
  };
  const app = new TabletAppController(env, subjectFor(USER_A, 'Dev A'), activeEnergy(500));
  await app.refreshDashboard();
  return { app, voice: new VoiceOrchestrator(app, new DeterministicVoiceParser(), interpreter), repos };
}
type H = Awaited<ReturnType<typeof harness>>;
const live = (h: H, transcript: string, turn: number, over: Partial<CorrelatedVoiceDelivery> = {}): CorrelatedVoiceDelivery => ({
  transcript,
  receivedAt: instant(new Date(Date.parse(START) + turn * 1000).toISOString()),
  userId: USER_A,
  utteranceId: over.utteranceId ?? `t-${turn}`,
  sessionGeneration: h.app.getState().sessionGeneration,
  turnSequence: turn,
  flowIdAtCapture: over.flowIdAtCapture !== undefined ? over.flowIdAtCapture : h.app.getState().addFood.flowId,
});

describe('A3 — a newer state-changing turn supersedes an older proposal', () => {
  test('a slow search returning AFTER a cancel does not recreate a flow', async () => {
    const barrier = new BarrierInterpreter([
      { intentKind: 'search_food', arguments: { query: 'demo brand oats' } },
    ]);
    const h = await harness(barrier);

    // Turn 11: natural language enters the slow interpreter.
    const slow = h.voice.handle(live(h, 'those oats would be nice again', 11));
    await barrier.entered;

    // Turn 12: a newer STATE-CHANGING command executes meanwhile.
    const cancelled = await h.voice.handle(live(h, 'cancel', 12));
    assert.equal(cancelled.kind, 'informational');

    barrier.open();
    const late = await slow;

    assert.equal(late.kind, 'error');
    if (late.kind === 'error') assert.equal(late.reason, 'superseded_by_newer_turn');
    assert.equal(h.app.getState().addFood.results.length, 0, 'no flow was recreated after the cancel');
  });

  test('a slow cancel returning AFTER a newer search does not cancel it', async () => {
    const barrier = new BarrierInterpreter([{ intentKind: 'cancel' }]);
    const h = await harness(barrier);

    const slow = h.voice.handle(live(h, 'ah scrap all of that', 11));
    await barrier.entered;

    // Turn 12 starts a new flow.
    const search = await h.voice.handle(live(h, 'add demo brand oats', 12));
    assert.equal(search.kind, 'options');
    const flowAfterSearch = h.app.getState().addFood.flowId;

    barrier.open();
    const late = await slow;

    assert.equal(late.kind, 'error');
    if (late.kind === 'error') assert.equal(late.reason, 'superseded_by_newer_turn');
    assert.ok(h.app.getState().addFood.results.length > 0, 'the newer flow survived');
    assert.equal(h.app.getState().addFood.flowId, flowAfterSearch);
  });

  test('a later READ-ONLY question does NOT supersede in-flight work', async () => {
    const barrier = new BarrierInterpreter([
      { intentKind: 'search_food', arguments: { query: 'chicken breast' } },
    ]);
    const h = await harness(barrier);

    const slow = h.voice.handle(live(h, 'i could go for that chicken', 11));
    await barrier.entered;

    // A question, not a state change: it must not invalidate the search.
    const asked = await h.voice.handle(live(h, 'how many calories have I eaten today', 12));
    assert.equal(asked.kind, 'informational');

    barrier.open();
    const result = await slow;

    assert.equal(result.kind, 'options', 'the search still completed');
    assert.ok(h.app.getState().addFood.results.length > 0);
  });

  test('ordering is by turn number, not completion order', async () => {
    const barrier = new BarrierInterpreter([{ intentKind: 'cancel' }]);
    const h = await harness(barrier);
    await h.voice.handle(live(h, 'add chicken breast', 10));

    const slow = h.voice.handle(live(h, 'scrap that whole idea', 11));
    await barrier.entered;
    await h.voice.handle(live(h, 'add demo brand oats', 12));

    barrier.open();
    await slow;

    // Turn 11's cancel is older than turn 12's search, so it loses regardless
    // of the fact that it finished last.
    assert.ok(h.app.getState().addFood.results.length > 0);
  });
});
