import { mintSubjectForTests } from '@macros/domain-auth';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DeterministicVoiceParser, type CorrelatedVoiceDelivery } from '@macros/domain-voice';
import { VoiceOrchestrator } from '@macros/voice-orchestration';
import { TabletAppController, DevScaleAdapter, type AppEnvironment, type AppSubject, appSubjectFrom } from '@macros/tablet-app-core';
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
  TEST_TEF_POLICY, USER_A, USER_B, activeEnergy,
} from '@macros/testkit';


/**
 * Stands in for household activation, which is the ONLY generation authority.
 * The controller no longer mints one, so tests must supply an authorized
 * session exactly as production does.
 */
let generationCounter = 1;
const nextGeneration = (): number => { generationCounter += 1; return generationCounter; };

const TZ = 'America/Chicago';
const START = '2026-08-27T16:50:00.000Z';
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
const subjectFor = (u: string, n: string): AppSubject =>
  appSubjectFrom(mintSubjectForTests(u, { displayName: n }));
const goalFor = (u: string, id: string, d: number): EnergyGoalVersion => ({
  goalVersionId: id, userId: u, effectiveFrom: instant('2026-01-01T00:00:00.000Z'),
  goal: d > 0 ? 'gain' : d < 0 ? 'lose' : 'maintain', targetDeltaKcal: d,
});

/** Blocks inside the interpreter so a switch can happen mid-turn. */
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
    this.signalEntered(); await this.gate;
    return { status: 'proposed', proposals: this.proposals };
  }
  open(): void { this.release(); }
}

async function harness(interpreter: AssistantInterpreter | null = null) {
  const repos: PersistedLoopRepositories = {
    foodLogs: new InMemoryFoodLogRepository(),
    products: new InMemoryProductVersionRepository(
      [...SYNTHETIC_PRODUCTS, ...SYNTHETIC_BRANDED_PRODUCTS],
      [...SYNTHETIC_CATALOG_HEADS, ...SYNTHETIC_BRANDED_HEADS]),
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
  const app = new TabletAppController(env, subjectFor(USER_A, 'Alex'), activeEnergy(500));
  await app.refreshDashboard();
  return {
    app, repos, scale: new DevScaleAdapter(START, clock),
    voice: new VoiceOrchestrator(app, new DeterministicVoiceParser(), interpreter),
  };
}
type H = Awaited<ReturnType<typeof harness>>;

const deliver = (h: H, transcript: string, turn: number, over: Partial<CorrelatedVoiceDelivery> = {}) =>
  h.voice.handle({
    transcript,
    receivedAt: instant(new Date(Date.parse(START) + turn * 1000).toISOString()),
    userId: over.userId ?? h.app.getState().subject.userId,
    utteranceId: over.utteranceId ?? `t-${turn}`,
    sessionGeneration: over.sessionGeneration ?? h.app.getState().sessionGeneration,
    turnSequence: turn,
    flowIdAtCapture: over.flowIdAtCapture !== undefined
      ? over.flowIdAtCapture : h.app.getState().addFood.flowId,
  } as CorrelatedVoiceDelivery);

const logsOf = async (h: H, userId: string) =>
  h.repos.foodLogs.listByLocalDate(userId, h.app.getState().dashboard!.localDate);

// ---------------------------------------------------------------------------

describe('B15 — an unfinished flow never crosses a user switch', () => {
  test("A's selected food and captured weight do NOT become B's", async () => {
    const h = await harness();
    await deliver(h, 'add chicken breast', 1);
    const cooked = h.app.getState().addFood.results
      .find((r) => r.productVersion.preparationState === 'cooked')!;
    await deliver(h, `option ${cooked.optionLabel}`, 2);
    await deliver(h, '180 grams', 3);
    assert.equal(h.app.getState().addFood.phase, 'reviewing');

    await h.app.switchActiveUser(subjectFor(USER_B, 'Sam'), activeEnergy(300), { userId: USER_B, sessionGeneration: nextGeneration() });

    const flow = h.app.getState().addFood;
    assert.equal(flow.selected, null, "A's selection was cancelled");
    assert.equal(flow.weightCapture, null, "A's 180 g did not carry over");
    assert.equal((await logsOf(h, USER_B)).length, 0, "A's unfinished food was not auto-logged");
    assert.equal((await logsOf(h, USER_A)).length, 0);
  });
});

describe('B43 — a slow voice turn cannot execute after a switch', () => {
  test("A's in-flight assistant result never applies to B", async () => {
    const barrier = new BarrierInterpreter([
      { intentKind: 'search_food', arguments: { query: 'chicken breast' } },
    ]);
    const h = await harness(barrier);
    const inFlight = deliver(h, 'that chicken thing again', 5);
    await barrier.entered;

    await h.app.switchActiveUser(subjectFor(USER_B, 'Sam'), activeEnergy(300), { userId: USER_B, sessionGeneration: nextGeneration() });
    const before = JSON.stringify(h.app.getState().addFood);

    barrier.open();
    const result = await inFlight;

    assert.equal(result.kind, 'error', "A's turn must not execute for B");
    assert.equal(JSON.stringify(h.app.getState().addFood), before, "B's flow untouched");
  });

  test('B17: switching BACK to A does not revive the old turn', async () => {
    const barrier = new BarrierInterpreter([
      { intentKind: 'search_food', arguments: { query: 'chicken breast' } },
    ]);
    const h = await harness(barrier);
    const firstGeneration = h.app.getState().sessionGeneration;
    const inFlight = deliver(h, 'that chicken thing again', 5);
    await barrier.entered;

    await h.app.switchActiveUser(subjectFor(USER_B, 'Sam'), activeEnergy(300), { userId: USER_B, sessionGeneration: nextGeneration() });
    await h.app.switchActiveUser(subjectFor(USER_A, 'Alex'), activeEnergy(500), { userId: USER_A, sessionGeneration: nextGeneration() });
    // Same userId again — but a THIRD generation, so the old work is still stale.
    assert.notEqual(h.app.getState().sessionGeneration, firstGeneration);

    barrier.open();
    const result = await inFlight;
    assert.equal(result.kind, 'error', 'matching userId must not resurrect it');
  });
});

describe('B44 — a pending scale capture cannot land in another user', () => {
  test("A's stability event does not populate B's flow", async () => {
    const h = await harness();
    await deliver(h, 'add chicken breast', 1);
    await deliver(h, `option ${h.app.getState().addFood.results[0]!.optionLabel}`, 2);

    for (const e of h.scale.connect()) h.app.applyScaleEvent(e as never);
    h.app.requestStableWeight();

    await h.app.switchActiveUser(subjectFor(USER_B, 'Sam'), activeEnergy(300), { userId: USER_B, sessionGeneration: nextGeneration() });

    // A's scale settles AFTER the switch.
    for (const e of h.scale.placeAndSettle(200)) h.app.applyScaleEvent(e as never);

    assert.equal(h.app.getState().addFood.weightCapture, null,
      "A's weight must never populate B's flow");
    assert.equal(h.app.getState().addFood.selected, null);
  });
});

describe('B45 — stale options cannot be selected after a switch', () => {
  test('"Option B" after a switch does not select A\'s old list', async () => {
    const h = await harness();
    await deliver(h, 'add chicken breast', 1);
    const oldFlow = h.app.getState().addFood.flowId;
    assert.ok(h.app.getState().addFood.results.length > 1);

    await h.app.switchActiveUser(subjectFor(USER_B, 'Sam'), activeEnergy(300), { userId: USER_B, sessionGeneration: nextGeneration() });

    const r = await deliver(h, 'option B', 2, { userId: USER_B, flowIdAtCapture: oldFlow });
    assert.equal(r.kind, 'error');
    assert.equal(h.app.getState().addFood.selected, null, "A's option was not selected for B");
  });
});

describe('B46 — no active user leaks nothing', () => {
  test("B's dashboard after a switch contains none of A's intake", async () => {
    const h = await harness();
    await deliver(h, 'add chicken breast', 1);
    const cooked = h.app.getState().addFood.results
      .find((r) => r.productVersion.preparationState === 'cooked')!;
    await deliver(h, `option ${cooked.optionLabel}`, 2);
    await deliver(h, '200 grams', 3);
    await deliver(h, 'log it', 4);
    assert.equal((await logsOf(h, USER_A)).length, 1);

    await h.app.switchActiveUser(subjectFor(USER_B, 'Sam'), activeEnergy(300), { userId: USER_B, sessionGeneration: nextGeneration() });

    const answer = await deliver(h, 'how many calories have I eaten today', 5, { userId: USER_B });
    assert.equal(answer.kind, 'informational');
    if (answer.kind !== 'informational') return;
    assert.equal(answer.data!['kcal'], 0, "B must not see A's 330 kcal");
  });
});
