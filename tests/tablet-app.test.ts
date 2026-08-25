import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
import {
  TabletAppController,
  DevScaleAdapter,
  assertSubjectBinding,
  type AppEnvironment,
  type AppSubject,
} from '@macros/tablet-app-core';
import {
  InMemoryEnergyGoalRepository,
  InMemoryFoodLogRepository,
  InMemoryProductVersionRepository,
  InMemoryUserProfileRepository,
  type PersistedLoopRepositories,
} from '@macros/persistence';
import { instant, type EnergyGoalVersion, type Instant, type TefPolicyHandle } from '@macros/contracts';
import type { LoopPolicies } from '@macros/core-loop';
import {
  PROFILE_MALE_35,
  PROFILE_FEMALE_29,
  SYNTHETIC_PRODUCTS,
  SYNTHETIC_CATALOG_HEADS,
  SYNTHETIC_STABILITY_POLICY,
  TEST_TEF_POLICY,
  activeEnergy,
  approx,
  USER_A,
  USER_B,
} from '@macros/testkit';

const TZ = 'America/Chicago';
const START = '2026-08-11T16:50:00.000Z';
const POLICIES: LoopPolicies = { tefPolicy: { status: 'available', policy: TEST_TEF_POLICY } };
const NO_TEF: TefPolicyHandle = { status: 'unavailable', reason: 'no_approved_policy_exists' };

/** Deterministic edge adapters — the pure domains never see a clock or a UUID. */
class FixedClock {
  private ms = Date.parse(START);
  now(): Instant { return instant(new Date(this.ms).toISOString()); }
  advance(ms: number): void { this.ms += ms; }
  /** Jump to a specific instant — used to pin a golden scenario's recompute. */
  advanceTo(iso: string): void { this.ms = Date.parse(iso); }
}
class SequenceIds {
  private n = 0;
  next(): string {
    this.n += 1;
    return `00000000-0000-4000-8000-${String(this.n).padStart(12, '0')}`;
  }
}

const subjectFor = (userId: string, name: string): AppSubject => ({
  authenticatedSubjectId: userId,
  userId,
  displayName: name,
});

const goalFor = (userId: string, id: string, delta: number): EnergyGoalVersion => ({
  goalVersionId: id,
  userId,
  effectiveFrom: instant('2026-01-01T00:00:00.000Z'),
  goal: delta > 0 ? 'gain' : delta < 0 ? 'lose' : 'maintain',
  targetDeltaKcal: delta,
});

async function buildRepos(): Promise<PersistedLoopRepositories> {
  const repos: PersistedLoopRepositories = {
    foodLogs: new InMemoryFoodLogRepository(),
    products: new InMemoryProductVersionRepository(SYNTHETIC_PRODUCTS, SYNTHETIC_CATALOG_HEADS),
    profiles: new InMemoryUserProfileRepository(),
    goals: new InMemoryEnergyGoalRepository(),
  };
  await repos.profiles.append(PROFILE_MALE_35);
  await repos.profiles.append(PROFILE_FEMALE_29);
  await repos.goals.append(goalFor(USER_A, 'goal-a-v1', 250));
  await repos.goals.append(goalFor(USER_B, 'goal-b-v1', -400));
  return repos;
}

interface Harness {
  app: TabletAppController;
  scale: DevScaleAdapter;
  clock: FixedClock;
  repos: PersistedLoopRepositories;
}

async function harness(overrides: Partial<AppEnvironment> = {}): Promise<Harness> {
  const repos = await buildRepos();
  const clock = new FixedClock();
  const env: AppEnvironment = {
    repositories: repos,
    clock,
    ids: new SequenceIds(),
    policies: POLICIES,
    stabilityPolicy: SYNTHETIC_STABILITY_POLICY,
    timezone: TZ,
    developmentDataNotice: 'DEVELOPMENT DATA — synthetic foods, simulated activity',
    ...overrides,
  };
  const app = new TabletAppController(env, subjectFor(USER_A, 'Dev User A'), activeEnergy(500));
  const scale = new DevScaleAdapter(START, clock);
  await app.refreshDashboard();
  return { app, scale, clock, repos };
}

/** Drive the simulator through the controller, as the UI adapter would. */
const feed = (h: Harness, events: readonly unknown[]) => {
  for (const e of events) h.app.applyScaleEvent(e as never);
};

const selectCookedChicken = async (h: Harness) => {
  await h.app.searchFood('chicken breast');
  const cooked = h.app.getState().addFood.results.find(
    (r) => r.productVersion.preparationState === 'cooked',
  )!;
  await h.app.selectOption(cooked.optionLabel);
  return cooked;
};

// ---------------------------------------------------------------------------

describe('SESSION AND IDENTITY', () => {
  test('the active user is explicit and UUID-shaped', async () => {
    const h = await harness();
    assert.equal(h.app.getState().subject.userId, USER_A);
    assert.ok(h.app.getState().subject.displayName.length > 0, 'the UI can always show who is active');
  });

  test('a subject whose authenticated id differs from its domain id is refused', () => {
    assert.throws(
      () => assertSubjectBinding({ authenticatedSubjectId: USER_B, userId: USER_A, displayName: 'x' }),
      /does not match/,
    );
  });

  test('a non-UUID user id is refused so we cannot drift from the RLS boundary', () => {
    assert.throws(
      () => assertSubjectBinding({ authenticatedSubjectId: 'dev-1', userId: 'dev-1', displayName: 'x' }),
      /UUID-shaped/,
    );
  });
});

describe('DASHBOARD', () => {
  test('renders engine output, with the north-star quantities present', async () => {
    const h = await harness();
    const d = h.app.getState().dashboard!;
    assert.equal(typeof d.energy.currentBalanceKcal, 'number');
    assert.equal(typeof d.energy.targetDeltaKcal, 'number');
    assert.equal(typeof d.energy.remainingIntakeKcal, 'number');
    assert.equal(d.intake.kcal, 0, 'nothing logged yet');
  });

  test('the development-data notice is surfaced, not hidden', async () => {
    const h = await harness();
    assert.match(h.app.getState().dashboard!.developmentDataNotice!, /DEVELOPMENT DATA/);
  });

  test('simulated activity is reported as its own source, not as measured truth', async () => {
    const h = await harness();
    assert.equal(h.app.getState().dashboard!.activitySource, 'simulated');
  });
});

describe('HAPPY PATH — scale', () => {
  test('search → select → settle → capture → review → confirm → dashboard updates', async () => {
    const h = await harness();

    await h.app.searchFood('chicken');
    assert.ok(h.app.getState().addFood.results.length > 0);

    await selectCookedChicken(h);
    assert.equal(h.app.getState().addFood.phase, 'waiting_for_weight');

    feed(h, h.scale.connect());
    feed(h, h.scale.placeAndSettle(200));
    assert.equal(h.app.getCaptureState().phase, 'stable', 'a candidate exists');
    assert.equal(h.app.getState().addFood.weightCapture, null, 'but nothing is captured yet');

    h.app.requestStableWeight();
    const flow = h.app.getState().addFood;
    assert.equal(flow.phase, 'reviewing');
    assert.equal(flow.weightCapture!.source, 'scale');
    assert.ok(approx(flow.preview!.kcal, 330, 1e-9));
    assert.ok(approx(flow.preview!.proteinG, 62, 1e-9));

    await h.app.confirmFoodLog();
    const after = h.app.getState();
    assert.equal(after.addFood.phase, 'completed');
    assert.equal(after.addFood.outcome, 'appended');
    assert.ok(approx(after.dashboard!.intake.kcal, 330, 1e-9));
    assert.ok(approx(after.dashboard!.intake.proteinG, 62, 1e-9));
  });
});

describe('HAPPY PATH — manual', () => {
  test('identical nutrition, different provenance', async () => {
    const scaleRun = await harness();
    await selectCookedChicken(scaleRun);
    feed(scaleRun, scaleRun.scale.connect());
    feed(scaleRun, scaleRun.scale.placeAndSettle(200));
    scaleRun.app.requestStableWeight();

    const manualRun = await harness();
    await selectCookedChicken(manualRun);
    manualRun.app.enterManualWeight(200);

    assert.deepEqual(manualRun.app.getState().addFood.preview, scaleRun.app.getState().addFood.preview);
    assert.equal(scaleRun.app.getState().addFood.weightCapture!.source, 'scale');
    assert.equal(manualRun.app.getState().addFood.weightCapture!.source, 'manual');
    assert.equal(
      manualRun.app.getState().addFood.weightCapture!.stabilityPolicyVersion,
      undefined,
      'manual provenance is never fabricated',
    );
  });

  test('an invalid manual weight is refused', async () => {
    const h = await harness();
    await selectCookedChicken(h);
    for (const g of [0, -5, Number.NaN]) {
      h.app.enterManualWeight(g);
      assert.equal(h.app.getState().addFood.error!.code, 'invalid_manual_weight');
      assert.equal(h.app.getState().addFood.weightCapture, null);
    }
  });
});

describe('WEIGHT BEFORE FOOD — the voice-compatible order', () => {
  test('food already on the scale, identified afterwards, without lifting it', async () => {
    const h = await harness();
    feed(h, h.scale.connect());
    feed(h, h.scale.placeAndSettle(200));

    h.app.beginAddFood();
    h.app.requestStableWeight();
    assert.notEqual(h.app.getState().addFood.weightCapture, null, 'the settled weight is held');

    await selectCookedChicken(h);
    // Selection completes the review without re-weighing.
    assert.ok(approx(h.app.getState().addFood.weightCapture!.grams, 200, 1e-9));
  });
});

describe('IDEMPOTENT SUBMISSION', () => {
  test('double-tapping Log Food creates exactly one log', async () => {
    const h = await harness();
    await selectCookedChicken(h);
    h.app.enterManualWeight(200);

    await Promise.all([h.app.confirmFoodLog(), h.app.confirmFoodLog()]);
    await h.app.confirmFoodLog();

    const logs = await h.repos.foodLogs.listByLocalDate(USER_A, h.app.getState().dashboard!.localDate);
    assert.equal(logs.length, 1, 'one logical submission, one row');
    assert.ok(approx(h.app.getState().dashboard!.intake.kcal, 330, 1e-9));
  });

  test('a retry reuses the same submission id', async () => {
    const h = await harness();
    await selectCookedChicken(h);
    h.app.enterManualWeight(200);
    await h.app.confirmFoodLog();
    const first = h.app.getState().addFood.submissionId;
    await h.app.confirmFoodLog();
    assert.equal(h.app.getState().addFood.submissionId, first);
  });

  test('an idempotency conflict is an explicit error, never a silent success', async () => {
    const h = await harness();
    await selectCookedChicken(h);
    h.app.enterManualWeight(200);
    await h.app.confirmFoodLog();
    const submissionId = h.app.getState().addFood.submissionId!;

    // Same identity, materially different payload.
    const second = await harness();
    Object.assign(second, { repos: h.repos });
    const app2 = new TabletAppController(
      {
        repositories: h.repos,
        clock: new FixedClock(),
        ids: { next: () => submissionId },
        policies: POLICIES,
        stabilityPolicy: SYNTHETIC_STABILITY_POLICY,
        timezone: TZ,
      },
      subjectFor(USER_A, 'Dev User A'),
      activeEnergy(500),
    );
    await app2.refreshDashboard();
    await app2.searchFood('chicken breast');
    const cooked = app2.getState().addFood.results.find(
      (r) => r.productVersion.preparationState === 'cooked',
    )!;
    await app2.selectOption(cooked.optionLabel);
    app2.enterManualWeight(350);
    await app2.confirmFoodLog();

    assert.equal(app2.getState().addFood.phase, 'error');
    assert.equal(app2.getState().addFood.error!.code, 'idempotency_conflict');
    assert.equal(app2.getState().addFood.error!.recoverable, false);
  });
});

describe('CANCEL AND BACK', () => {
  test('cancelling after selecting and weighing commits nothing', async () => {
    const h = await harness();
    await selectCookedChicken(h);
    feed(h, h.scale.connect());
    feed(h, h.scale.placeAndSettle(200));
    h.app.requestStableWeight();

    h.app.cancelFoodFlow();
    const flow = h.app.getState().addFood;
    assert.equal(flow.phase, 'idle');
    assert.equal(flow.selected, null);
    assert.equal(flow.weightCapture, null);

    const logs = await h.repos.foodLogs.listByLocalDate(USER_A, h.app.getState().dashboard!.localDate);
    assert.equal(logs.length, 0, 'persisted logs untouched');
  });

  test('cancelling clears an outstanding capture intent', async () => {
    const h = await harness();
    await selectCookedChicken(h);
    feed(h, h.scale.connect());
    feed(h, h.scale.placeUnsettled(200));
    h.app.requestStableWeight();
    assert.notEqual(h.app.getCaptureState().pendingCaptureRequest, null);

    h.app.cancelFoodFlow();
    assert.equal(h.app.getCaptureState().pendingCaptureRequest, null);

    // The armed intent must not fire on the next settling food.
    feed(h, h.scale.placeAndSettle(400));
    assert.equal(h.app.getState().addFood.weightCapture, null);
  });

  test('cancelling only the weight keeps the selected product', async () => {
    const h = await harness();
    await selectCookedChicken(h);
    h.app.enterManualWeight(200);
    h.app.cancelWeight();
    assert.notEqual(h.app.getState().addFood.selected, null);
    assert.equal(h.app.getState().addFood.weightCapture, null);
    assert.equal(h.app.getState().addFood.phase, 'waiting_for_weight');
  });
});

describe('USER SWITCH SAFETY', () => {
  test("A's selection and weight can never be logged under B", async () => {
    const h = await harness();
    await selectCookedChicken(h);
    feed(h, h.scale.connect());
    feed(h, h.scale.placeAndSettle(200));
    h.app.requestStableWeight();
    assert.equal(h.app.getState().addFood.phase, 'reviewing');

    await h.app.switchActiveUser(subjectFor(USER_B, 'Dev User B'), activeEnergy(300));

    const flow = h.app.getState().addFood;
    assert.equal(flow.phase, 'idle');
    assert.equal(flow.selected, null);
    assert.equal(flow.weightCapture, null);

    // Even an explicit confirm now must not log A's food under B.
    await h.app.confirmFoodLog();
    const bLogs = await h.repos.foodLogs.listByLocalDate(USER_B, h.app.getState().dashboard!.localDate);
    const aLogs = await h.repos.foodLogs.listByLocalDate(USER_A, h.app.getState().dashboard!.localDate);
    assert.equal(bLogs.length, 0);
    assert.equal(aLogs.length, 0);
  });

  test('switching cancels an outstanding capture intent', async () => {
    const h = await harness();
    await selectCookedChicken(h);
    feed(h, h.scale.connect());
    feed(h, h.scale.placeUnsettled(200));
    h.app.requestStableWeight();
    await h.app.switchActiveUser(subjectFor(USER_B, 'Dev User B'), activeEnergy(300));
    assert.equal(h.app.getCaptureState().pendingCaptureRequest, null);
  });

  test('the dashboard reloads for the new user', async () => {
    const h = await harness();
    await selectCookedChicken(h);
    h.app.enterManualWeight(200);
    await h.app.confirmFoodLog();
    assert.ok(h.app.getState().dashboard!.intake.kcal > 0);

    await h.app.switchActiveUser(subjectFor(USER_B, 'Dev User B'), activeEnergy(300));
    assert.equal(h.app.getState().dashboard!.intake.kcal, 0, "B sees B's day, not A's");
  });
});

describe('STALE ASYNC RESULTS', () => {
  test('a search result from a cancelled flow does not land', async () => {
    const h = await harness();
    h.app.beginAddFood();
    const pending = h.app.searchFood('chicken');
    h.app.cancelFoodFlow();
    await pending;
    assert.deepEqual(h.app.getState().addFood.results, [], 'the cancelled flow left no results');
  });

  test('a logging response from a previous user does not mutate the new session', async () => {
    const h = await harness();
    await selectCookedChicken(h);
    h.app.enterManualWeight(200);

    const pending = h.app.confirmFoodLog();
    await h.app.switchActiveUser(subjectFor(USER_B, 'Dev User B'), activeEnergy(300));
    await pending;

    assert.equal(h.app.getState().subject.userId, USER_B);
    assert.equal(h.app.getState().addFood.phase, 'idle', "A's response never lands on B's session");
  });
});

describe('SCALE ERROR STATES', () => {
  test('a fault does not create a fake manual capture', async () => {
    const h = await harness();
    await selectCookedChicken(h);
    feed(h, h.scale.connect());
    feed(h, h.scale.placeAndSettle(200));
    feed(h, h.scale.fault());

    h.app.requestStableWeight();
    assert.equal(h.app.getState().addFood.weightCapture, null);
    assert.equal(h.app.getState().addFood.error!.code, 'capture_rejected');
  });

  test('a disconnected scale is reported, not guessed around', async () => {
    const h = await harness();
    await selectCookedChicken(h);
    h.app.requestStableWeight();
    assert.equal(h.app.getState().addFood.error!.code, 'scale_disconnected');
    assert.equal(h.app.getState().addFood.weightCapture, null);
  });

  test('overload blocks capture', async () => {
    const h = await harness();
    await selectCookedChicken(h);
    feed(h, h.scale.connect());
    feed(h, h.scale.overload());
    h.app.requestStableWeight();
    assert.equal(h.app.getState().addFood.weightCapture, null);
  });

  test('a stale candidate is refused and a fresh one is required', async () => {
    const h = await harness();
    await selectCookedChicken(h);
    feed(h, h.scale.connect());
    feed(h, h.scale.placeAndSettle(200));

    h.clock.advance(10 * 60 * 1000); // far beyond the candidate age policy
    h.app.requestStableWeight();
    assert.equal(h.app.getState().addFood.weightCapture, null);
    assert.equal(h.app.getState().addFood.error!.code, 'candidate_stale');

    feed(h, h.scale.placeAndSettle(200, 4));
    assert.notEqual(h.app.getState().addFood.weightCapture, null, 'a fresh candidate satisfies it');
  });

  test('a stable candidate alone never logs anything', async () => {
    const h = await harness();
    await selectCookedChicken(h);
    feed(h, h.scale.connect());
    feed(h, h.scale.placeAndSettle(200));
    feed(h, h.scale.placeAndSettle(200, 20));

    assert.equal(h.app.getState().addFood.weightCapture, null);
    const logs = await h.repos.foodLogs.listByLocalDate(USER_A, h.app.getState().dashboard!.localDate);
    assert.equal(logs.length, 0);
  });
});

describe('ENERGY COMPLETENESS NEVER BLOCKS LOGGING', () => {
  test('with no TEF policy the user still logs food; the dashboard marks the gap', async () => {
    const h = await harness({ policies: { tefPolicy: NO_TEF } });
    await selectCookedChicken(h);
    h.app.enterManualWeight(200);
    await h.app.confirmFoodLog();

    const d = h.app.getState().dashboard!;
    assert.equal(h.app.getState().addFood.phase, 'completed');
    assert.ok(approx(d.intake.kcal, 330, 1e-9), 'nutrition is unaffected');
    assert.equal(d.energyIncomplete, true);
    assert.ok(d.energyGaps.includes('tef_policy_missing'));
  });

  test('with no activity estimate the user still logs food', async () => {
    const repos = await buildRepos();
    const app = new TabletAppController(
      {
        repositories: repos,
        clock: new FixedClock(),
        ids: new SequenceIds(),
        policies: POLICIES,
        stabilityPolicy: SYNTHETIC_STABILITY_POLICY,
        timezone: TZ,
      },
      subjectFor(USER_A, 'Dev User A'),
      { status: 'unavailable', reason: 'no_provider' },
    );
    await app.refreshDashboard();
    await app.searchFood('chicken breast');
    const cooked = app.getState().addFood.results.find(
      (r) => r.productVersion.preparationState === 'cooked',
    )!;
    await app.selectOption(cooked.optionLabel);
    app.enterManualWeight(200);
    await app.confirmFoodLog();

    assert.equal(app.getState().addFood.phase, 'completed');
    assert.equal(app.getState().dashboard!.energyIncomplete, true);
    assert.ok(app.getState().dashboard!.energyGaps.includes('activity_estimate_missing'));
  });
});

describe('SEARCH AND SELECTION EDGE CASES', () => {
  test('no results reports honestly and selects nothing', async () => {
    const h = await harness();
    await h.app.searchFood('qwertyuiop');
    assert.deepEqual(h.app.getState().addFood.results, []);
    assert.equal(h.app.getState().addFood.error!.code, 'no_results');
    assert.equal(h.app.getState().addFood.selected, null);
  });

  test('an unknown product version id is refused', async () => {
    const h = await harness();
    h.app.beginAddFood();
    await h.app.selectProduct('does-not-exist@v1');
    assert.equal(h.app.getState().addFood.error!.code, 'product_not_found');
    assert.equal(h.app.getState().addFood.selected, null);
  });

  test('an unknown option label is refused', async () => {
    const h = await harness();
    await h.app.searchFood('chicken');
    await h.app.selectOption('Z');
    assert.equal(h.app.getState().addFood.error!.code, 'product_not_found');
  });

  test('raw and cooked stay exactly distinct through selection', async () => {
    const h = await harness();
    await h.app.searchFood('chicken breast');
    const results = h.app.getState().addFood.results;
    const raw = results.find((r) => r.productVersion.preparationState === 'raw')!;
    const cooked = results.find((r) => r.productVersion.preparationState === 'cooked')!;

    await h.app.selectOption(raw.optionLabel);
    h.app.enterManualWeight(200);
    const rawPreview = h.app.getState().addFood.preview!;

    h.app.cancelFoodFlow();
    await h.app.searchFood('chicken breast');
    await h.app.selectOption(cooked.optionLabel);
    h.app.enterManualWeight(200);
    const cookedPreview = h.app.getState().addFood.preview!;

    assert.notEqual(rawPreview.kcal, cookedPreview.kcal, 'never yield-converted into each other');
  });
});

describe('DASHBOARD RECONSTRUCTION', () => {
  test('a new controller over the same repository rebuilds the same dashboard', async () => {
    const h = await harness();
    await selectCookedChicken(h);
    h.app.enterManualWeight(200);
    await h.app.confirmFoodLog();
    const before = h.app.getState().dashboard!;

    // Discard all controller state; keep only the repository.
    const rebuilt = new TabletAppController(
      {
        repositories: h.repos,
        clock: new FixedClock(),
        ids: new SequenceIds(),
        policies: POLICIES,
        stabilityPolicy: SYNTHETIC_STABILITY_POLICY,
        timezone: TZ,
      },
      subjectFor(USER_A, 'Dev User A'),
      activeEnergy(500),
    );
    const after = await rebuilt.refreshDashboard();

    assert.deepEqual(after!.intake, before.intake);
    assert.deepEqual(after!.macros, before.macros);
    assert.deepEqual(after!.energy, before.energy);
  });
});

describe('GOLDEN APPLICATION SCENARIO', () => {
  /**
   * The application layer must not distort the closed domains. This drives the
   * whole tablet flow and then asserts the dashboard against the EXISTING
   * food-vertical-slice golden vector — the arithmetic is not duplicated here.
   */
  test('search → option A/B → 200 g scale capture → confirm → golden dashboard', async () => {
    const golden = JSON.parse(
      readFileSync(join(ROOT, 'data/golden/food-vertical-slice.json'), 'utf8'),
    ) as {
      step1: {
        productVersionId: string;
        expectedIntake: { kcal: number; proteinG: number; carbohydrateG: number; fatG: number };
        expectedSnapshot: { kcal: number; proteinG: number };
        expectedTefKcal: number;
        expectedExpenditureSoFar: number;
        expectedCurrentBalance: number;
        expectedProjectedTotal: number;
      };
    };

    const h = await harness();

    // 1. Search, then choose by the spoken option label voice will later use.
    await h.app.searchFood('chicken');
    const cooked = h.app
      .getState()
      .addFood.results.find(
        (r) => r.productVersion.productVersionId === golden.step1.productVersionId,
      )!;
    assert.ok(cooked !== undefined, 'the cooked chicken version is offered');
    await h.app.selectOption(cooked.optionLabel);

    // 2. Simulated scale settles at 200 g. Nothing is captured automatically.
    feed(h, h.scale.connect());
    feed(h, h.scale.placeAndSettle(200));
    assert.equal(h.app.getState().addFood.weightCapture, null);

    // 3. Explicit capture intent.
    h.app.requestStableWeight();
    const review = h.app.getState().addFood;
    assert.equal(review.phase, 'reviewing');
    assert.ok(approx(review.preview!.kcal, golden.step1.expectedSnapshot.kcal, 1e-9));
    assert.ok(approx(review.preview!.proteinG, golden.step1.expectedSnapshot.proteinG, 1e-9));

    // 4. Confirm. The golden vector is anchored to a specific instant, and
    // expenditure-so-far depends on how much of the local day has elapsed, so
    // the confirm happens at exactly that instant.
    h.clock.advanceTo('2026-08-11T17:00:00.000Z');
    await h.app.confirmFoodLog();
    const d = h.app.getState().dashboard!;

    assert.ok(approx(d.intake.kcal, golden.step1.expectedIntake.kcal, 1e-9));
    assert.ok(approx(d.intake.proteinG, golden.step1.expectedIntake.proteinG, 1e-9));
    assert.ok(approx(d.intake.fatG, golden.step1.expectedIntake.fatG, 1e-9));
    assert.equal(d.intake.itemCount, 1);

    assert.ok(approx(d.energy.tefEstimatedTotalKcal!, golden.step1.expectedTefKcal, 1e-9));
    assert.ok(approx(d.energy.expenditureSoFarKcal, golden.step1.expectedExpenditureSoFar, 1e-9));
    assert.ok(approx(d.energy.currentBalanceKcal, golden.step1.expectedCurrentBalance, 1e-9));
    assert.ok(
      approx(d.energy.projectedTotalExpenditureKcal, golden.step1.expectedProjectedTotal, 1e-9),
    );

    // Macros come from the existing engine, not from presentation arithmetic.
    assert.ok(
      approx(d.macros.remainingProteinG, d.macros.targets.proteinG - d.intake.proteinG, 1e-9),
    );
  });
});

describe('VOICE-FIRST COMPATIBILITY AUDIT', () => {
  /**
   * Touch and future voice must be two INPUT ADAPTERS onto the same intents.
   * This asserts that every required action is reachable as a controller method
   * — never only as a screen tap — so the AI layer can route into it later
   * without simulating a UI event.
   */
  const REQUIRED_INTENTS = [
    'searchFood',
    'selectOption',
    'selectProduct',
    'requestStableWeight',
    'enterManualWeight',
    'cancelWeight',
    'confirmFoodLog',
    'cancelFoodFlow',
    'switchActiveUser',
    'refreshDashboard',
    'beginAddFood',
    'applyScaleEvent',
    'getState',
  ] as const;

  test('every required action exists as a callable application intent', () => {
    const proto = TabletAppController.prototype as unknown as Record<string, unknown>;
    for (const intent of REQUIRED_INTENTS) {
      assert.equal(typeof proto[intent], 'function', `${intent} must be an application intent`);
    }
  });

  test('spoken option selection needs no screen coordinates', async () => {
    const h = await harness();
    await h.app.searchFood('chicken');
    // "Option B" — a label, not a tap position.
    await h.app.selectOption('B');
    assert.notEqual(h.app.getState().addFood.selected, null);
  });

  test('current macro and energy state is readable without rendering anything', async () => {
    const h = await harness();
    const d = h.app.getState().dashboard!;
    // Everything a spoken answer needs is already in application state.
    assert.equal(typeof d.macros.remainingProteinG, 'number');
    assert.equal(typeof d.energy.currentBalanceKcal, 'number');
    assert.equal(typeof d.energy.remainingIntakeKcal, 'number');
  });

  test('the whole loop runs with no presentation layer at all', async () => {
    const h = await harness();
    await h.app.searchFood('chicken breast');
    await h.app.selectOption('A');
    h.app.enterManualWeight(200);
    await h.app.confirmFoodLog();
    assert.equal(h.app.getState().addFood.phase, 'completed');
  });
});

describe('PART A — CAPTURE REQUEST IDEMPOTENCY (A1)', () => {
  test('tapping "use this weight" twice while settling is a retry, not an error', async () => {
    const h = await harness();
    await selectCookedChicken(h);
    feed(h, h.scale.connect());
    feed(h, h.scale.placeUnsettled(200));

    h.app.requestStableWeight();
    const firstId = h.app.getState().addFood.captureRequestId;
    assert.notEqual(firstId, null);
    assert.equal(h.app.getState().addFood.error, null);

    h.app.requestStableWeight();
    assert.equal(h.app.getState().addFood.captureRequestId, firstId, 'the same attempt');
    assert.equal(h.app.getState().addFood.error, null, 'a retry is never an application error');

    // And it still captures exactly once when it settles. The earlier jitter
    // sample must age out of the observation window first, so this holds longer
    // than a clean placement would need.
    feed(h, h.scale.placeAndSettle(200, 10));
    assert.notEqual(h.app.getState().addFood.weightCapture, null);
  });

  test('capture identity is never the submission identity', async () => {
    const h = await harness();
    await selectCookedChicken(h);
    feed(h, h.scale.connect());
    feed(h, h.scale.placeUnsettled(200));
    h.app.requestStableWeight();
    const captureId = h.app.getState().addFood.captureRequestId;

    feed(h, h.scale.placeAndSettle(200));
    await h.app.confirmFoodLog();
    assert.notEqual(h.app.getState().addFood.submissionId, captureId, 'different operations');
  });

  test('a new placement gets a fresh capture request id', async () => {
    const h = await harness();
    await selectCookedChicken(h);
    feed(h, h.scale.connect());
    feed(h, h.scale.placeAndSettle(200));
    h.app.requestStableWeight();
    assert.equal(h.app.getState().addFood.captureRequestId, null, 'the attempt completed');

    h.app.cancelWeight();
    feed(h, h.scale.remove());
    feed(h, h.scale.placeUnsettled(300));
    h.app.requestStableWeight();
    assert.notEqual(h.app.getState().addFood.captureRequestId, null, 'a new attempt, a new id');
  });
});

describe('PART A — cancelWeight cancels the armed intent (A2)', () => {
  test('a cancelled attempt does not capture when the scale later settles', async () => {
    const h = await harness();
    await selectCookedChicken(h);
    feed(h, h.scale.connect());
    feed(h, h.scale.placeUnsettled(200));
    h.app.requestStableWeight();
    assert.notEqual(h.app.getCaptureState().pendingCaptureRequest, null);

    h.app.cancelWeight();
    assert.equal(h.app.getCaptureState().pendingCaptureRequest, null, 'the intent is cancelled');
    assert.equal(h.app.getState().addFood.captureRequestId, null);
    assert.notEqual(h.app.getState().addFood.selected, null, 'the chosen food survives');

    feed(h, h.scale.placeAndSettle(200));
    assert.equal(h.app.getState().addFood.weightCapture, null, 'the abandoned attempt never captures');
  });
});

describe('PART A — manual entry cancels an armed scale request (A3)', () => {
  test('a later scale settle cannot replace the manual choice', async () => {
    const h = await harness();
    await selectCookedChicken(h);
    feed(h, h.scale.connect());
    feed(h, h.scale.placeUnsettled(250));
    h.app.requestStableWeight();
    assert.notEqual(h.app.getCaptureState().pendingCaptureRequest, null);

    h.app.enterManualWeight(200);
    const manual = h.app.getState().addFood.weightCapture!;
    assert.equal(manual.source, 'manual');
    assert.ok(approx(manual.grams, 200, 1e-9));
    assert.equal(h.app.getCaptureState().pendingCaptureRequest, null, 'the scale intent is cancelled');

    feed(h, h.scale.placeAndSettle(250));
    const after = h.app.getState().addFood.weightCapture!;
    assert.equal(after.source, 'manual', 'still the manual choice');
    assert.ok(approx(after.grams, 200, 1e-9), 'not replaced by the 250 g settle');
  });
});

describe('PART A — user switch does not inherit a placement (A4)', () => {
  test("B cannot capture A's food left on the scale until it is cleared", async () => {
    const h = await harness();
    await selectCookedChicken(h);
    feed(h, h.scale.connect());
    feed(h, h.scale.placeAndSettle(200));
    assert.equal(h.app.getCaptureState().phase, 'stable');

    await h.app.switchActiveUser(subjectFor(USER_B, 'Dev User B'), activeEnergy(300));
    assert.equal(h.app.getState().requiresScaleClearForCurrentSubject, true);

    await selectCookedChicken(h);
    h.app.requestStableWeight();
    assert.equal(h.app.getState().addFood.weightCapture, null, "B never captures A's placement");
    assert.equal(h.app.getState().addFood.error!.code, 'scale_requires_clear');

    // Clearing the platform, observed for real, lifts the gate.
    feed(h, h.scale.remove());
    assert.equal(h.app.getState().requiresScaleClearForCurrentSubject, false);

    feed(h, h.scale.placeAndSettle(150));
    h.app.requestStableWeight();
    const capture = h.app.getState().addFood.weightCapture!;
    assert.ok(approx(capture.grams, 150, 1e-9), "B captures B's own food");
  });

  test('manual weight stays available while the scale gate is set', async () => {
    const h = await harness();
    feed(h, h.scale.connect());
    feed(h, h.scale.placeAndSettle(200));
    await h.app.switchActiveUser(subjectFor(USER_B, 'Dev User B'), activeEnergy(300));
    assert.equal(h.app.getState().requiresScaleClearForCurrentSubject, true);

    await selectCookedChicken(h);
    h.app.enterManualWeight(120);
    assert.ok(approx(h.app.getState().addFood.weightCapture!.grams, 120, 1e-9));
  });

  test('an empty platform at switch time sets no gate', async () => {
    const h = await harness();
    feed(h, h.scale.connect());
    await h.app.switchActiveUser(subjectFor(USER_B, 'Dev User B'), activeEnergy(300));
    assert.equal(h.app.getState().requiresScaleClearForCurrentSubject, false);
  });
});

describe('PART A — stale async protection (A5, A6)', () => {
  test('a product resolved for a cancelled flow does not land', async () => {
    const h = await harness();
    await h.app.searchFood('chicken breast');
    const cooked = h.app.getState().addFood.results[0]!;

    const pending = h.app.selectProduct(cooked.productVersion.productVersionId);
    h.app.cancelFoodFlow();
    await pending;

    assert.equal(h.app.getState().addFood.selected, null, 'the old lookup never lands');
  });

  test('a product resolved for a previous user does not land', async () => {
    const h = await harness();
    await h.app.searchFood('chicken breast');
    const cooked = h.app.getState().addFood.results[0]!;

    const pending = h.app.selectProduct(cooked.productVersion.productVersionId);
    await h.app.switchActiveUser(subjectFor(USER_B, 'Dev User B'), activeEnergy(300));
    await pending;

    assert.equal(h.app.getState().addFood.selected, null);
    assert.equal(h.app.getState().subject.userId, USER_B);
  });

  test('a slower earlier search cannot overwrite a newer one in the same flow', async () => {
    const h = await harness();
    h.app.beginAddFood();

    const first = h.app.searchFood('chi');
    const second = h.app.searchFood('chicken breast');
    await Promise.all([second, first]);

    assert.equal(h.app.getState().addFood.query, 'chicken breast', 'the newest query wins');
    assert.ok(
      h.app.getState().addFood.results.every((r) =>
        r.productVersion.displayName.toLowerCase().includes('chicken breast'),
      ),
    );
  });
});

describe('PART A — recent history ranking (T-5 closed)', () => {
  test("a user's own recent food is boosted", async () => {
    const h = await harness();
    await h.app.searchFood('chicken breast');
    const raw = h.app.getState().addFood.results.find(
      (r) => r.productVersion.preparationState === 'raw',
    )!;

    await h.app.selectProduct(raw.productVersion.productVersionId);
    h.app.enterManualWeight(200);
    await h.app.confirmFoodLog();

    h.app.cancelFoodFlow();
    await h.app.searchFood('chicken breast');
    assert.equal(
      h.app.getState().addFood.results[0]!.productVersion.productVersionId,
      raw.productVersion.productVersionId,
      'the recently logged version ranks first',
    );
  });

  test("user A's history never boosts user B's search", async () => {
    const h = await harness();
    await h.app.searchFood('chicken breast');
    const raw = h.app.getState().addFood.results.find(
      (r) => r.productVersion.preparationState === 'raw',
    )!;
    await h.app.selectProduct(raw.productVersion.productVersionId);
    h.app.enterManualWeight(200);
    await h.app.confirmFoodLog();

    await h.app.switchActiveUser(subjectFor(USER_B, 'Dev User B'), activeEnergy(300));
    await h.app.searchFood('chicken breast');
    assert.notEqual(
      h.app.getState().addFood.results[0]!.productVersion.productVersionId,
      raw.productVersion.productVersionId,
      "B's ranking is unaffected by A's history",
    );
  });
});
