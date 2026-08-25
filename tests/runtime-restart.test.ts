import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { TabletAppController, type AppEnvironment, type AppSubject } from '@macros/tablet-app-core';
import {
  InMemoryEnergyGoalRepository, InMemoryFoodLogRepository,
  InMemoryProductVersionRepository, InMemoryUserProfileRepository,
  foodLogToRow, rowToFoodLog, type PersistedLoopRepositories,
} from '@macros/persistence';
import { instant, type EnergyGoalVersion, type Instant } from '@macros/contracts';
import type { LoopPolicies } from '@macros/core-loop';
import {
  PROFILE_MALE_35, PROFILE_FEMALE_29, SYNTHETIC_CATALOG_HEADS, SYNTHETIC_PRODUCTS,
  SYNTHETIC_BRANDED_HEADS, SYNTHETIC_BRANDED_PRODUCTS, SYNTHETIC_STABILITY_POLICY,
  TEST_TEF_POLICY, USER_A, USER_B, activeEnergy, approx,
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
  constructor(private readonly prefix = 1) {}
  next(): string {
    this.n += 1;
    return `00000000-0000-4000-800${this.prefix}-${String(this.n).padStart(12, '0')}`;
  }
}
const subjectFor = (u: string, n: string): AppSubject => ({ authenticatedSubjectId: u, userId: u, displayName: n });
const goalFor = (u: string, id: string, d: number): EnergyGoalVersion => ({
  goalVersionId: id, userId: u, effectiveFrom: instant('2026-01-01T00:00:00.000Z'),
  goal: d > 0 ? 'gain' : d < 0 ? 'lose' : 'maintain', targetDeltaKcal: d,
});

/** Repositories persist ACROSS controller instances — this is the storage tier. */
async function storage(): Promise<PersistedLoopRepositories> {
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
  return repos;
}

const controllerFor = async (repos: PersistedLoopRepositories, userId: string, prefix = 1) => {
  const env: AppEnvironment = {
    repositories: repos, clock: new FixedClock(), ids: new SequenceIds(prefix),
    policies: POLICIES, stabilityPolicy: SYNTHETIC_STABILITY_POLICY, timezone: TZ,
  };
  const app = new TabletAppController(env, subjectFor(userId, 'Dev'), activeEnergy(500));
  await app.refreshDashboard();
  return app;
};

const logMeal = async (app: TabletAppController, query: string, prep: string, grams: number) => {
  app.beginAddFood();
  await app.searchFood(query);
  const hit = app.getState().addFood.results.find((r) => r.productVersion.preparationState === prep)!;
  await app.selectOption(hit.optionLabel);
  app.enterManualWeight(grams);
  await app.confirmFoodLog();
  return hit.productVersion.productVersionId;
};

// ---------------------------------------------------------------------------

describe('B21 — restart reconstructs the same day from storage', () => {
  test('a fresh controller on the same storage rebuilds identical state', async () => {
    const repos = await storage();

    const first = await controllerFor(repos, USER_A);
    const versionId = await logMeal(first, 'chicken breast', 'cooked', 200);
    const before = first.getState().dashboard!;
    assert.ok(approx(before.intake.kcal, 330, 1e-9));

    // Destroy the in-memory controller entirely. Only storage survives.
    const second = await controllerFor(repos, USER_A, 2);
    const after = second.getState().dashboard!;

    assert.equal(after.localDate, before.localDate);
    assert.ok(approx(after.intake.kcal, before.intake.kcal, 1e-9));
    assert.ok(approx(after.intake.proteinG, before.intake.proteinG, 1e-9));
    assert.ok(approx(after.energy.remainingIntakeKcal, before.energy.remainingIntakeKcal, 1e-9));
    assert.ok(approx(after.macros.remainingProteinG, before.macros.remainingProteinG, 1e-9));

    const logs = await repos.foodLogs.listByLocalDate(USER_A, after.localDate);
    assert.equal(logs.length, 1);
    assert.equal(logs[0]!.productVersionId, versionId, 'the exact version is still pinned');
  });

  test('multiple meals reconstruct in full', async () => {
    const repos = await storage();
    const first = await controllerFor(repos, USER_A);
    await logMeal(first, 'chicken breast', 'cooked', 200);
    await logMeal(first, 'demo brand oats', 'as_sold', 100);
    const before = first.getState().dashboard!;

    const second = await controllerFor(repos, USER_A, 2);
    assert.ok(approx(second.getState().dashboard!.intake.kcal, before.intake.kcal, 1e-9));
    assert.equal(second.getState().dashboard!.intake.itemCount, 2);
  });

  test('restart does NOT resurrect an unconfirmed in-flight flow', async () => {
    const repos = await storage();
    const first = await controllerFor(repos, USER_A);
    first.beginAddFood();
    await first.searchFood('chicken breast');
    await first.selectOption(first.getState().addFood.results[0]!.optionLabel);
    first.enterManualWeight(150);
    // Never confirmed — the meal was not logged.

    const second = await controllerFor(repos, USER_A, 2);
    assert.equal(second.getState().addFood.selected, null);
    assert.equal(second.getState().dashboard!.intake.itemCount, 0, 'nothing silently logged');
  });

  test("a restart never reconstructs another user's day", async () => {
    const repos = await storage();
    const a = await controllerFor(repos, USER_A);
    await logMeal(a, 'chicken breast', 'cooked', 200);

    const b = await controllerFor(repos, USER_B, 2);
    assert.equal(b.getState().dashboard!.intake.itemCount, 0);
    assert.ok(approx(b.getState().dashboard!.intake.kcal, 0, 1e-9));
  });

  test('stored rows survive a full codec round trip unchanged', async () => {
    const repos = await storage();
    const app = await controllerFor(repos, USER_A);
    await logMeal(app, 'chicken breast', 'cooked', 200);

    const logs = await repos.foodLogs.listByLocalDate(USER_A, app.getState().dashboard!.localDate);
    for (const log of logs) {
      assert.deepEqual(rowToFoodLog(foodLogToRow(log)), log);
    }
  });
});

describe('B13 — repeated submission is idempotent (in-memory tier)', () => {
  test('confirming twice from one review state writes one log', async () => {
    const repos = await storage();
    const app = await controllerFor(repos, USER_A);
    await logMeal(app, 'chicken breast', 'cooked', 200);
    await app.confirmFoodLog();

    const logs = await repos.foodLogs.listByLocalDate(USER_A, app.getState().dashboard!.localDate);
    assert.equal(logs.length, 1);
  });

  test('a duplicate append of the same identity and payload is a replay', async () => {
    const repos = await storage();
    const app = await controllerFor(repos, USER_A);
    await logMeal(app, 'chicken breast', 'cooked', 200);
    const [stored] = await repos.foodLogs.listByLocalDate(USER_A, app.getState().dashboard!.localDate);

    const again = await repos.foodLogs.append(stored!);
    assert.equal(again.outcome, 'replayed_existing');

    const after = await repos.foodLogs.listByLocalDate(USER_A, app.getState().dashboard!.localDate);
    assert.equal(after.length, 1, 'a retry never double-logs');
  });

  test('an internally inconsistent payload is refused by contract validation', async () => {
    const repos = await storage();
    const app = await controllerFor(repos, USER_A);
    await logMeal(app, 'chicken breast', 'cooked', 200);
    const [stored] = await repos.foodLogs.listByLocalDate(USER_A, app.getState().dashboard!.localDate);

    // Grams that disagree with the snapshot would be corrupt data, so the
    // repository refuses it outright rather than storing or comparing it.
    const corrupt = { ...stored!, grams: ((stored!.grams as number) + 50) } as typeof stored;
    await assert.rejects(() => repos.foodLogs.append(corrupt!));
  });

  test('the same identity with a DIFFERENT payload is an idempotency conflict', async () => {
    const repos = await storage();
    const app = await controllerFor(repos, USER_A);
    await logMeal(app, 'chicken breast', 'cooked', 200);
    const [stored] = await repos.foodLogs.listByLocalDate(USER_A, app.getState().dashboard!.localDate);

    // Internally consistent, but a DIFFERENT logged instant under the same id —
    // the shape a retry-with-changed-payload would take.
    // (A payload that also breaks internal consistency is refused even earlier
    // by contract validation, verified above.)
    const tampered = { ...stored!, loggedAt: instant('2026-08-22T18:30:00.000Z') } as typeof stored;
    const result = await repos.foodLogs.append(tampered!);
    assert.equal(result.outcome, 'idempotency_conflict');

    const after = await repos.foodLogs.listByLocalDate(USER_A, app.getState().dashboard!.localDate);
    assert.equal(after.length, 1, 'the stored row wins and is never rewritten');
    assert.equal(after[0]!.loggedAt, stored!.loggedAt);
  });
});
