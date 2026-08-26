import { mintSubjectForTests } from '@macros/domain-auth';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DeterministicVoiceParser, type VoiceUtterance } from '@macros/domain-voice';
import { VoiceOrchestrator } from '@macros/voice-orchestration';
import type { VoiceOption, VoiceResponse } from '@macros/domain-voice';
import { TabletAppController, DevScaleAdapter, type AppEnvironment, type AppSubject, appSubjectFrom } from '@macros/tablet-app-core';
import {
  InMemoryEnergyGoalRepository, InMemoryFoodLogRepository,
  InMemoryProductVersionRepository, InMemoryUserProfileRepository,
  type PersistedLoopRepositories,
} from '@macros/persistence';
import { instant, type EnergyGoalVersion, type Instant } from '@macros/contracts';
import type { LoopPolicies } from '@macros/core-loop';
import {
  PROFILE_MALE_35, PROFILE_FEMALE_29, SYNTHETIC_BRANDED_ALIASES, SYNTHETIC_BRANDED_HEADS,
  SYNTHETIC_BRANDED_PRODUCTS, SYNTHETIC_CATALOG_HEADS, SYNTHETIC_PRODUCTS,
  SYNTHETIC_STABILITY_POLICY, TEST_TEF_POLICY, USER_A, USER_B, activeEnergy, approx,
} from '@macros/testkit';

const TZ = 'America/Chicago';
const START = '2026-08-19T16:50:00.000Z';
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
const subjectFor = (userId: string, name: string): AppSubject =>
  appSubjectFrom(mintSubjectForTests(userId, { displayName: name }));
const goalFor = (userId: string, id: string, delta: number): EnergyGoalVersion => ({
  goalVersionId: id, userId, effectiveFrom: instant('2026-01-01T00:00:00.000Z'),
  goal: delta > 0 ? 'gain' : delta < 0 ? 'lose' : 'maintain', targetDeltaKcal: delta,
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
  await repos.goals.append(goalFor(USER_A, 'goal-a-v1', 250));
  await repos.goals.append(goalFor(USER_B, 'goal-b-v1', -400));

  const clock = new FixedClock();
  const env: AppEnvironment = {
    repositories: repos, clock, ids: new SequenceIds(), policies: POLICIES,
    stabilityPolicy: SYNTHETIC_STABILITY_POLICY, timezone: TZ,
  };
  const app = new TabletAppController(env, subjectFor(USER_A, 'Dev A'), activeEnergy(500));
  const scale = new DevScaleAdapter(START, clock);
  await app.refreshDashboard();
  const voice = new VoiceOrchestrator(app);
  return { app, scale, voice, repos, clock };
}
type H = Awaited<ReturnType<typeof harness>>;

let n = 0;
const say = (h: H, transcript: string, userId = USER_A) => {
  n += 1;
  return h.voice.handle(correlate(h, transcript, userId, n));
};

/** Full correlation, as a real STT adapter must now supply. */
const correlate = (h: H, transcript: string, userId: string, turn: number) => ({
  transcript,
  receivedAt: instant(new Date(Date.parse('2026-08-19T17:00:00.000Z') + turn * 1000).toISOString()),
  userId,
  utteranceId: `u-${turn}`,
  sessionGeneration: h.app.getState().sessionGeneration,
  turnSequence: turn,
  flowIdAtCapture: h.app.getState().addFood.flowId,
});

/** Narrow a response to its options, failing loudly if it was not an options reply. */
const optionsOf = (r: VoiceResponse): readonly VoiceOption[] => {
  assert.equal(r.kind, 'options', `expected options, got ${r.kind}: ${r.speech}`);
  return r.kind === 'options' ? r.options : [];
};

const feed = (h: H, events: readonly unknown[]) => { for (const e of events) h.app.applyScaleEvent(e as never); };

// ---------------------------------------------------------------------------

describe('FLOW A — generic food, end to end by voice', () => {
  test('search → option → scale → review → confirm', async () => {
    const h = await harness();

    const found = await say(h, 'add chicken breast');
    assert.equal(found.kind, 'options');
    if (found.kind !== 'options') return;
    assert.ok(found.options.length >= 2, 'both preparations are offered');

    const cooked = found.options.find((o) => o.preparationState === 'cooked')!;
    const selected = await say(h, `option ${cooked.optionLabel}`);
    assert.equal(selected.kind, 'informational');

    feed(h, h.scale.connect());
    feed(h, h.scale.placeAndSettle(200));

    const review = await say(h, 'weigh it');
    assert.equal(review.kind, 'review');
    if (review.kind !== 'review') return;
    assert.ok(approx(review.review.kcal, 330, 1e-9), 'the nutrition engine produced this');
    assert.ok(approx(review.review.proteinG, 62, 1e-9));
    assert.equal(review.review.weightSource, 'scale');

    const done = await say(h, 'log it');
    assert.equal(done.kind, 'success');

    const logs = await h.repos.foodLogs.listByLocalDate(USER_A, h.app.getState().dashboard!.localDate);
    assert.equal(logs.length, 1);
    assert.equal(logs[0]!.productVersionId, cooked.productVersionId);
    assert.equal(logs[0]!.weightCapture.source, 'scale', 'weight provenance untouched');
  });
});

describe('FLOW B — branded food through the SAME orchestration', () => {
  test('"add demo brand oats" → option A → 100 g → 375 kcal → logged', async () => {
    const h = await harness();

    const found = await say(h, 'add demo brand oats');
    assert.equal(found.kind, 'options');
    if (found.kind !== 'options') return;
    const oats = found.options.find((o) => o.productVersionId === 'synb-oats-old-fashioned@v1')!;
    assert.ok(oats !== undefined, 'the branded oats are offered');
    assert.equal(oats.brandName, 'Demo Brand');

    await say(h, `option ${oats.optionLabel}`);
    feed(h, h.scale.connect());
    feed(h, h.scale.placeAndSettle(100));

    const review = await say(h, 'weigh it');
    assert.equal(review.kind, 'review');
    if (review.kind !== 'review') return;
    assert.ok(approx(review.review.kcal, 375, 1e-9), 'from the fixture via the nutrition engine');
    assert.ok(approx(review.review.grams, 100, 1e-9));

    await say(h, 'log it');
    const logs = await h.repos.foodLogs.listByLocalDate(USER_A, h.app.getState().dashboard!.localDate);
    assert.equal(logs[0]!.productVersionId, 'synb-oats-old-fashioned@v1', 'exact branded version pinned');
  });

  test('there is NO branded-specific voice nutrition path', async () => {
    const h = await harness();
    await say(h, 'add demo brand oats');
    const opts = optionsOf(await say(h, 'repeat the options'));
    const oats = opts.find((o) => o.productVersionId === 'synb-oats-old-fashioned@v1')!;
    await say(h, `option ${oats.optionLabel}`);
    await say(h, '100 grams');

    // Identical arithmetic to the generic path: preview comes from the engine.
    const flow = h.app.getState().addFood;
    assert.ok(approx(flow.preview!.kcal, 375, 1e-9));
    assert.equal(flow.weightCapture!.source, 'manual');
  });
});

describe('FLOW C/D — dashboard questions read existing state', () => {
  test('consumed calories equal the persisted dashboard', async () => {
    const h = await harness();
    await say(h, 'add chicken breast');
    const opts = optionsOf(await say(h, 'repeat the options'));
    await say(h, `option ${opts.find((o) => o.preparationState === 'cooked')!.optionLabel}`);
    await say(h, '200 grams');
    await say(h, 'log it');

    const answer = await say(h, 'how many calories have I eaten today');
    assert.equal(answer.kind, 'informational');
    if (answer.kind !== 'informational') return;
    assert.equal(answer.data!['kcal'], h.app.getState().dashboard!.intake.kcal, 'exactly the dashboard value');
    assert.match(answer.speech, /330 calories/);
  });

  test('protein consumed matches dashboard state', async () => {
    const h = await harness();
    await say(h, 'add chicken breast');
    const opts = optionsOf(await say(h, 'repeat the options'));
    await say(h, `option ${opts.find((o) => o.preparationState === 'cooked')!.optionLabel}`);
    await say(h, '200 grams');
    await say(h, 'log it');

    const answer = await say(h, 'how much protein have I had');
    assert.equal(answer.kind, 'informational');
    if (answer.kind !== 'informational') return;
    assert.equal(answer.data!['proteinG'], h.app.getState().dashboard!.intake.proteinG);
  });

  test('remaining calories equal the energy engine, not a voice calculation', async () => {
    const h = await harness();
    const answer = await say(h, 'how many calories do I have left');
    assert.equal(answer.kind, 'informational');
    if (answer.kind !== 'informational') return;
    assert.equal(
      answer.data!['remainingIntakeKcal'],
      h.app.getState().dashboard!.energy.remainingIntakeKcal,
    );
  });

  test('macros come from the macro engine', async () => {
    const h = await harness();
    const answer = await say(h, 'what are my macros today');
    assert.equal(answer.kind, 'informational');
    if (answer.kind !== 'informational') return;
    const m = h.app.getState().dashboard!.macros;
    assert.equal(answer.data!['remainingProteinG'], m.remainingProteinG);
    assert.equal(answer.data!['remainingCarbohydrateG'], m.remainingCarbohydrateG);
    assert.equal(answer.data!['remainingFatG'], m.remainingFatG);
  });

  test('spoken rounding never reaches stored values', async () => {
    const h = await harness();
    await say(h, 'add chicken breast');
    const opts = optionsOf(await say(h, 'repeat the options'));
    await say(h, `option ${opts.find((o) => o.preparationState === 'cooked')!.optionLabel}`);
    await say(h, '247 grams');

    const review = await say(h, 'repeat the options');
    void review;
    const flow = h.app.getState().addFood;
    // 165 kcal/100 g × 247 g = 407.55 — the log keeps full precision.
    assert.ok(approx(flow.preview!.kcal, 407.55, 1e-9));
    await say(h, 'log it');
    const logs = await h.repos.foodLogs.listByLocalDate(USER_A, h.app.getState().dashboard!.localDate);
    assert.ok(approx(logs[0]!.nutritionSnapshot.totals.kcal, 407.55, 1e-9), 'not the rounded spoken 408');
  });
});

describe('FLOW E — cancel leaves no trace', () => {
  test('"never mind" after selecting and weighing logs nothing', async () => {
    const h = await harness();
    await say(h, 'add chicken breast');
    const opts = optionsOf(await say(h, 'repeat the options'));
    await say(h, `option ${opts[0]!.optionLabel}`);
    await say(h, '100 grams');

    const cancelled = await say(h, 'never mind');
    assert.equal(cancelled.kind, 'informational');
    assert.equal(h.app.getState().addFood.selected, null);
    assert.equal(h.app.getState().addFood.weightCapture, null);

    const logs = await h.repos.foodLogs.listByLocalDate(USER_A, h.app.getState().dashboard!.localDate);
    assert.equal(logs.length, 0);
  });
});

describe('FLOW F — ambiguity and refusal', () => {
  test('"maybe option A or B" selects NEITHER', async () => {
    const h = await harness();
    await say(h, 'add chicken breast');
    const r = await say(h, 'maybe option A or B');
    assert.equal(r.kind, 'clarification');
    assert.equal(h.app.getState().addFood.selected, null, 'zero side effects');
  });

  test('"log something" invents no food', async () => {
    const h = await harness();
    const r = await say(h, 'log something');
    assert.equal(r.kind, 'clarification');
    assert.equal(h.app.getState().addFood.selected, null);
  });

  test('"200 calories of oats" is refused, not reverse-calculated', async () => {
    const h = await harness();
    const r = await say(h, '200 calories of oats');
    assert.equal(r.kind, 'clarification');
    if (r.kind !== 'clarification') return;
    assert.equal(r.reason, 'quantity_target_unsupported');
    assert.equal(h.app.getState().addFood.weightCapture, null);
  });

  test('an unknown food reports not-found and manufactures nothing', async () => {
    const h = await harness();
    const r = await say(h, 'add zzzqqq flakes');
    assert.equal(r.kind, 'error');
    if (r.kind !== 'error') return;
    assert.equal(r.reason, 'not_found');
    assert.equal(h.app.getState().addFood.selected, null);
  });

  test('"I ate some yogurt" searches but never picks a product or quantity', async () => {
    const h = await harness();
    const r = await say(h, 'i am having yogurt');
    assert.equal(r.kind, 'options');
    assert.equal(h.app.getState().addFood.selected, null, 'no silent selection');
    assert.equal(h.app.getState().addFood.weightCapture, null, 'no invented quantity');
  });
});
