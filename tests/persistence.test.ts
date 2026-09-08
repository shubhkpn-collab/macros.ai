import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  InMemoryEnergyGoalRepository,
  InMemoryFoodLogRepository,
  InMemoryProductVersionRepository,
  InMemoryUserProfileRepository,
  PostgresFoodLogRepository,
  logFoodPersisted,
  recomputeDayFromStorage,
  rowToFoodLog,
  foodLogToRow,
  toColumnScale,
  COLUMN_SCALE,
  INSERT_FOOD_LOG_SQL,
  SELECT_FOOD_LOGS_BY_DAY_SQL,
  type FoodLogRow,
  type PersistedLoopRepositories,
  type SqlExecutor,
} from '@macros/persistence';
import { appendFoodLog, createFoodLogItem, foodLogFingerprint } from '@macros/domain-food-log';
import {
  grams,
  instant,
  type EnergyGoalVersion,
  type ProductVersion,
  type TefPolicyHandle,
  type UserProfileSnapshot,
  type WeightCapture,
} from '@macros/contracts';
import type { LoopPolicies } from '@macros/core-loop';
import {
  PROFILE_MALE_35,
  PROFILE_FEMALE_29,
  SYNTHETIC_PRODUCTS,
  SYNTHETIC_CATALOG_HEADS,
  TEST_TEF_POLICY,
  activeEnergy,
  approx,
  USER_A,
  USER_B,
} from '@macros/testkit';

const ROOT = new URL('..', import.meta.url).pathname;
const TZ = 'America/Chicago';
const AT = instant('2026-08-11T17:00:00.000Z'); // 12:00 local CDT
const POLICIES: LoopPolicies = { tefPolicy: { status: 'available', policy: TEST_TEF_POLICY } };
const ACTIVITY = activeEnergy(500);
const NO_TEF: TefPolicyHandle = { status: 'unavailable', reason: 'no_approved_policy_exists' };

const chicken = SYNTHETIC_PRODUCTS.find((p) => p.productId === 'syn-chicken-breast')!;
const rice = SYNTHETIC_PRODUCTS.find((p) => p.productId === 'syn-white-rice')!;

const capture = (g: number, at = AT): WeightCapture => ({
  grams: grams(g),
  source: 'manual',
  capturedAt: at,
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

const logChicken = (repos: PersistedLoopRepositories, opts: Partial<{ userId: string; logId: string; grams: number; at: typeof AT }> = {}) =>
  logFoodPersisted(repos, {
    userId: opts.userId ?? USER_A,
    logId: opts.logId ?? 'log-1',
    productVersionId: chicken.productVersionId,
    weightCapture: capture(opts.grams ?? 200, opts.at ?? AT),
    loggedAt: opts.at ?? AT,
    timezone: TZ,
    activity: ACTIVITY,
    policies: POLICIES,
  });

// ---------------------------------------------------------------------------

describe('PERSISTED LOOP — the deterministic result survives storage', () => {
  test('a persisted log produces the known deterministic nutrition', async () => {
    const repos = await buildRepos();
    const r = await logChicken(repos);
    assert.equal(r.outcome, 'appended');
    assert.ok(approx(r.item.nutritionSnapshot.totals.kcal, 330, 1e-9));
    assert.ok(approx(r.item.nutritionSnapshot.totals.proteinG, 62, 1e-9));
    assert.ok(approx(r.intake.kcal, 330, 1e-9));
  });

  test('no arithmetic happens in the repository — totals come from the stored snapshot', async () => {
    const repos = await buildRepos();
    await logChicken(repos);
    const stored = await repos.foodLogs.findById(USER_A, 'log-1');
    assert.ok(stored !== null);
    assert.equal(stored!.nutritionSnapshot.totals.kcal, 330);
    assert.equal(stored!.grams, stored!.nutritionSnapshot.gramsConsumed);
  });

  test('EnergyState is never persisted — it is always derived', async () => {
    const repos = await buildRepos();
    const r = await logChicken(repos);
    const row = foodLogToRow(r.item) as unknown as Record<string, unknown>;
    for (const key of Object.keys(row)) {
      assert.ok(!/energy|balance|tef|macro/i.test(key), `row must not persist derived state: ${key}`);
    }
  });
});

describe('IDEMPOTENCY — replay vs conflict are different facts', () => {
  test('an exact replay returns the canonical stored item and does not double count', async () => {
    const repos = await buildRepos();
    const first = await logChicken(repos);
    const replay = await logChicken(repos);

    assert.equal(replay.outcome, 'replayed_existing');
    assert.deepEqual(replay.item, first.item, 'the canonical stored item is returned');
    assert.ok(approx(replay.intake.kcal, 330, 1e-9), 'intake did not double');
    assert.equal(replay.intake.itemCount, 1);
  });

  test('the same id with a DIFFERENT payload is an idempotency conflict, never a duplicate success', async () => {
    const repos = await buildRepos();
    const first = await logChicken(repos, { grams: 200 });
    const conflicting = await logChicken(repos, { grams: 300 });

    assert.equal(conflicting.outcome, 'idempotency_conflict');
    assert.equal(conflicting.item.grams, 200, 'the ORIGINAL row is returned, never overwritten');
    assert.deepEqual(conflicting.item, first.item);
    assert.ok(approx(conflicting.intake.kcal, 330, 1e-9), 'the original still governs intake');
  });

  test('the same logId under a DIFFERENT user is a separate record, not a collision', async () => {
    const repos = await buildRepos();
    await logChicken(repos, { userId: USER_A, logId: 'shared-id' });
    const b = await logChicken(repos, { userId: USER_B, logId: 'shared-id' });

    assert.equal(b.outcome, 'appended', 'identity is (userId, logId), not logId alone');
    assert.equal(b.intake.itemCount, 1, "user B sees only their own log");
  });

  test('concurrent identical appends yield exactly one row and one append', async () => {
    const repos = await buildRepos();
    const results = await Promise.all([logChicken(repos), logChicken(repos), logChicken(repos)]);
    const appended = results.filter((r) => r.outcome === 'appended');
    const replayed = results.filter((r) => r.outcome === 'replayed_existing');
    assert.equal(appended.length, 1);
    assert.equal(replayed.length, 2);
    assert.equal((repos.foodLogs as InMemoryFoodLogRepository).size, 1);
  });

  test('concurrent conflicting appends leave exactly one immutable row', async () => {
    const repos = await buildRepos();
    const results = await Promise.all([
      logChicken(repos, { grams: 200 }),
      logChicken(repos, { grams: 250 }),
    ]);
    assert.equal((repos.foodLogs as InMemoryFoodLogRepository).size, 1);
    const conflicts = results.filter((r) => r.outcome === 'idempotency_conflict');
    assert.ok(conflicts.length >= 1, 'at least one caller is told it conflicted');
    const stored = await repos.foodLogs.findById(USER_A, 'log-1');
    assert.ok(stored !== null);
  });
});

describe('USER IDENTITY BINDING', () => {
  test("user A's food can never run through user B's metabolic profile", async () => {
    const { buildEnergyModel } = await import('@macros/domain-energy');
    const { logFoodAndRecompute } = await import('@macros/core-loop');
    const bModel = buildEnergyModel(PROFILE_FEMALE_29, { targetDeltaKcal: -400, goal: 'lose' });

    assert.throws(
      () =>
        logFoodAndRecompute({
          existingLogs: [],
          logId: 'log-x',
          userId: USER_A,
          selectedProductVersion: chicken,
          weightCapture: capture(200),
          loggedAt: AT,
          timezone: TZ,
          energyModel: bModel,
          activity: ACTIVITY,
          policies: POLICIES,
        }),
      /subject mismatch/,
    );
  });

  test('the persisted loop resolves the profile and goal for the acting user only', async () => {
    const repos = await buildRepos();
    const a = await logChicken(repos, { userId: USER_A });
    const b = await logChicken(repos, { userId: USER_B, logId: 'log-b' });
    assert.equal(a.energyModel.profile.userId, USER_A);
    assert.equal(b.energyModel.profile.userId, USER_B);
    assert.notEqual(a.energyModel.bmrKcal, b.energyModel.bmrKcal);
  });

  test('logging is refused when the user has no effective profile', async () => {
    const repos = await buildRepos();
    await assert.rejects(logChicken(repos, { userId: 'user-unknown' }), /no effective profile/);
  });
});

describe('CROSS-USER ISOLATION (application layer)', () => {
  test('user B never sees user A logs, totals or days', async () => {
    const repos = await buildRepos();
    await logChicken(repos, { userId: USER_A, logId: 'a-1' });
    await logChicken(repos, { userId: USER_A, logId: 'a-2', grams: 150 });

    const bLogs = await repos.foodLogs.listByLocalDate(USER_B, '2026-08-11');
    assert.equal(bLogs.length, 0);

    const bDay = await recomputeDayFromStorage(repos, {
      userId: USER_B, at: AT, timezone: TZ, activity: ACTIVITY, policies: POLICIES,
    });
    assert.equal(bDay.intake.itemCount, 0);
    assert.equal(bDay.intake.kcal, 0);
  });

  test("user A cannot read user B's log by id", async () => {
    const repos = await buildRepos();
    await logChicken(repos, { userId: USER_B, logId: 'b-only' });
    assert.equal(await repos.foodLogs.findById(USER_A, 'b-only'), null);
  });

  test('the shared catalog is readable by both users', async () => {
    const repos = await buildRepos();
    assert.ok(await repos.products.getVersion(chicken.productVersionId));
    assert.ok(await repos.products.getCurrentVersion('syn-chicken-breast'));
  });
});

describe('IMMUTABILITY AND APPEND-ONLY', () => {
  test('a product version can never be replaced in place', async () => {
    const repo = new InMemoryProductVersionRepository(SYNTHETIC_PRODUCTS, SYNTHETIC_CATALOG_HEADS);
    assert.throws(() => repo.putVersion(chicken), /immutable/);
  });

  test('a correction inserts V2 and repoints the head; V1 keeps its meaning', async () => {
    const repo = new InMemoryProductVersionRepository(SYNTHETIC_PRODUCTS, SYNTHETIC_CATALOG_HEADS);
    const v2: ProductVersion = {
      ...chicken,
      productVersionId: `${chicken.productId}@cooked-v2`,
      versionNo: 2,
      basis: { ...chicken.basis, kcal: 999 },
      effectiveFrom: instant('2026-06-01T00:00:00.000Z'),
    };
    repo.putVersion(v2);
    repo.putHead({
      productId: chicken.productId,
      currentProductVersionId: v2.productVersionId,
      isActive: true,
      updatedAt: instant('2026-06-01T00:00:00.000Z'),
    });

    const head = await repo.getCurrentVersion(chicken.productId);
    assert.equal(head!.productVersionId, v2.productVersionId);

    const v1 = await repo.getVersion(chicken.productVersionId);
    assert.equal(v1!.basis.kcal, chicken.basis.kcal, 'V1 is untouched');
  });

  test('a corrected product never changes an existing log', async () => {
    const repos = await buildRepos();
    const before = await logChicken(repos);

    (repos.products as InMemoryProductVersionRepository).putVersion({
      ...chicken,
      productVersionId: `${chicken.productId}@cooked-v9`,
      versionNo: 9,
      basis: { ...chicken.basis, kcal: 1 },
      effectiveFrom: instant('2026-07-01T00:00:00.000Z'),
    });
    (repos.products as InMemoryProductVersionRepository).putHead({
      productId: chicken.productId,
      currentProductVersionId: `${chicken.productId}@cooked-v9`,
      isActive: true,
      updatedAt: instant('2026-07-01T00:00:00.000Z'),
    });

    const after = await recomputeDayFromStorage(repos, {
      userId: USER_A, at: AT, timezone: TZ, activity: ACTIVITY, policies: POLICIES,
    });
    assert.ok(approx(after.intake.kcal, before.intake.kcal, 1e-9), 'history is unchanged');
  });

  test('a profile or goal version id can never be reused', async () => {
    const repos = await buildRepos();
    await assert.rejects(repos.profiles.append(PROFILE_MALE_35), /immutable/);
    await assert.rejects(repos.goals.append(goalFor(USER_A, 'goal-a-v1', 0)), /immutable/);
  });

  test('the effective profile and goal are the versions in force at that instant', async () => {
    const repos = await buildRepos();
    await repos.goals.append({
      goalVersionId: 'goal-a-v2',
      userId: USER_A,
      effectiveFrom: instant('2026-08-01T00:00:00.000Z'),
      goal: 'lose',
      targetDeltaKcal: -500,
    });
    const early = await repos.goals.getEffective(USER_A, instant('2026-05-01T00:00:00.000Z'));
    const late = await repos.goals.getEffective(USER_A, AT);
    assert.equal(early!.targetDeltaKcal, 250, 'history still computes against the old goal');
    assert.equal(late!.targetDeltaKcal, -500);
  });
});

describe('ROW VALIDATION — corrupted rows fail loudly', () => {
  const validRow = async (): Promise<FoodLogRow> => {
    const item = createFoodLogItem({
      logId: 'row-1', userId: USER_A, productVersion: chicken,
      weightCapture: capture(200), loggedAt: AT, timezone: TZ,
    });
    return foodLogToRow(item);
  };

  test('a row whose kcal column contradicts its snapshot is rejected', async () => {
    const row = { ...(await validRow()), kcal: 999 };
    assert.throws(() => rowToFoodLog(row), /contradicts the stored snapshot/);
  });

  test('a row whose grams contradict the snapshot is rejected', async () => {
    const row = { ...(await validRow()), grams: 111 };
    assert.throws(() => rowToFoodLog(row));
  });

  test('a row whose product version contradicts the snapshot is rejected', async () => {
    const row = { ...(await validRow()), product_version_id: 'some-other-version' };
    assert.throws(() => rowToFoodLog(row));
  });

  test('a row with a non-object snapshot is rejected, never coerced', async () => {
    const row = { ...(await validRow()), nutrition_snapshot: 'corrupt' };
    assert.throws(() => rowToFoodLog(row as unknown as FoodLogRow));
  });

  test('a row with an unknown status is rejected', async () => {
    const row = { ...(await validRow()), status: 'deleted' };
    assert.throws(() => rowToFoodLog(row), /unsupported food log status/);
  });

  test('a corrupted stored row is caught on read, not silently repaired', async () => {
    const repos = await buildRepos();
    const repo = repos.foodLogs as InMemoryFoodLogRepository;
    repo.seedRawRow({ ...(await validRow()), protein_g: 4242 });
    await assert.rejects(repo.listByLocalDate(USER_A, '2026-08-11'));
  });

  test('a contradictory item can never be written either', async () => {
    const item = createFoodLogItem({
      logId: 'row-2', userId: USER_A, productVersion: chicken,
      weightCapture: capture(200), loggedAt: AT, timezone: TZ,
    });
    const tampered = { ...item, grams: grams(500) };
    assert.throws(() => foodLogToRow(tampered), /Contract validation failed/);
  });
});

describe('RESTART / RECONSTRUCTION', () => {
  test('discarding all in-memory state and reloading reproduces the exact result', async () => {
    const repos = await buildRepos();

    const first = await logChicken(repos, { logId: 'r-1', grams: 200 });
    const second = await logFoodPersisted(repos, {
      userId: USER_A, logId: 'r-2', productVersionId: rice.productVersionId,
      weightCapture: capture(150), loggedAt: AT, timezone: TZ,
      activity: ACTIVITY, policies: POLICIES,
    });
    void first;

    // Nothing is carried over except the repositories themselves.
    const reloaded = await recomputeDayFromStorage(repos, {
      userId: USER_A, at: AT, timezone: TZ, activity: ACTIVITY, policies: POLICIES,
    });

    assert.deepEqual(reloaded.intake, second.intake);
    assert.deepEqual(reloaded.macros, second.macros);
    assert.deepEqual(reloaded.energy, second.energy);
    assert.equal(reloaded.localDate, second.localDate);
  });

  test('reconstruction is stable across repeated reloads', async () => {
    const repos = await buildRepos();
    await logChicken(repos);
    const a = await recomputeDayFromStorage(repos, {
      userId: USER_A, at: AT, timezone: TZ, activity: ACTIVITY, policies: POLICIES,
    });
    const b = await recomputeDayFromStorage(repos, {
      userId: USER_A, at: AT, timezone: TZ, activity: ACTIVITY, policies: POLICIES,
    });
    assert.equal(JSON.stringify(a), JSON.stringify(b));
  });

  test('a missing TEF policy after restart is still reported honestly', async () => {
    const repos = await buildRepos();
    await logChicken(repos);
    const state = await recomputeDayFromStorage(repos, {
      userId: USER_A, at: AT, timezone: TZ, activity: ACTIVITY,
      policies: { tefPolicy: NO_TEF },
    });
    assert.equal(state.energy.tefStatus, 'policy_unavailable');
    assert.ok(state.energy.completenessGaps.includes('tef_policy_missing'));
  });

  test('the local day survives storage — a log stays on its own calendar day', async () => {
    const repos = await buildRepos();
    // 23:59 local on 2026-08-11 (CDT) is 04:59Z on 2026-08-12.
    const lateLocal = instant('2026-08-12T04:59:00.000Z');
    await logChicken(repos, { logId: 'late', at: lateLocal });

    const eleventh = await repos.foodLogs.listByLocalDate(USER_A, '2026-08-11');
    const twelfth = await repos.foodLogs.listByLocalDate(USER_A, '2026-08-12');
    assert.equal(eleventh.length, 1, 'stored on the local day, not the UTC day');
    assert.equal(twelfth.length, 0);
    assert.equal(eleventh[0]!.eventUtcOffsetMinutes, -300);
  });
});

describe('POSTGRES ADAPTER — SQL shape (runtime execution PENDING)', () => {
  class FakeExecutor implements SqlExecutor {
    readonly calls: { text: string; params: readonly unknown[] }[] = [];
    constructor(private readonly responses: readonly (readonly unknown[])[]) {}
    async query<T>(text: string, params: readonly unknown[]): Promise<readonly T[]> {
      this.calls.push({ text, params });
      return (this.responses[this.calls.length - 1] ?? []) as readonly T[];
    }
  }

  const item = () =>
    createFoodLogItem({
      logId: 'pg-1', userId: USER_A, productVersion: chicken,
      weightCapture: capture(200), loggedAt: AT, timezone: TZ,
    });

  test('the insert is idempotent by primary key, not by read-then-write', () => {
    assert.match(INSERT_FOOD_LOG_SQL, /ON CONFLICT \(user_id, log_id\) DO NOTHING/);
    assert.ok(!/DO UPDATE/i.test(INSERT_FOOD_LOG_SQL), 'a conflict must never overwrite');
  });

  test('every statement is parameterized', () => {
    for (const sql of [INSERT_FOOD_LOG_SQL, SELECT_FOOD_LOGS_BY_DAY_SQL]) {
      assert.ok(/\$\d/.test(sql), 'must use bound parameters');
      assert.ok(!/'\s*\+\s*/.test(sql), 'no string concatenation into SQL');
    }
  });

  test('the day query is always scoped to one user', () => {
    assert.match(SELECT_FOOD_LOGS_BY_DAY_SQL, /user_id = \$1/);
    assert.match(SELECT_FOOD_LOGS_BY_DAY_SQL, /local_date = \$2/);
  });

  test('the adapter contains no UPDATE or DELETE statement at all', () => {
    const src = readFileSync(join(ROOT, 'packages/persistence/src/postgres.ts'), 'utf8');
    assert.ok(!/\bUPDATE\s+food_logs\b/i.test(src));
    assert.ok(!/\bDELETE\s+FROM\b/i.test(src));
  });

  test('an insert that returns a row is an append', async () => {
    const created = item();
    const exec = new FakeExecutor([[foodLogToRow(created)]]);
    const repo = new PostgresFoodLogRepository(exec);
    const r = await repo.append(created);
    assert.equal(r.outcome, 'appended');
    assert.equal(exec.calls.length, 1, 'no extra read on the happy path');
  });

  test('a conflict re-reads the canonical row and classifies replay vs conflict', async () => {
    const created = item();
    const storedRow = foodLogToRow(created);

    const replayExec = new FakeExecutor([[], [storedRow]]);
    const replay = await new PostgresFoodLogRepository(replayExec).append(created);
    assert.equal(replay.outcome, 'replayed_existing');

    const differing = createFoodLogItem({
      logId: 'pg-1', userId: USER_A, productVersion: chicken,
      weightCapture: capture(250), loggedAt: AT, timezone: TZ,
    });
    const conflictExec = new FakeExecutor([[], [storedRow]]);
    const conflict = await new PostgresFoodLogRepository(conflictExec).append(differing);
    assert.equal(conflict.outcome, 'idempotency_conflict');
    assert.equal(conflict.item.grams, 200, 'the stored row is returned unchanged');
  });

  test('a conflict with no readable row fails loudly rather than guessing', async () => {
    const exec = new FakeExecutor([[], []]);
    await assert.rejects(new PostgresFoodLogRepository(exec).append(item()), /refusing to proceed/);
  });
});

describe('MIGRATIONS — static assertions (RLS runtime verification PENDING)', () => {
  const dir = join(ROOT, 'db/migrations');
  const files = readdirSync(dir).sort();
  const sql = files.map((f) => readFileSync(join(dir, f), 'utf8')).join('\n');

  test('migrations are ordered and present', () => {
    assert.deepEqual(files, [
      '0001_core_schema.sql',
      '0002_rls.sql',
      '0003_catalog_identifiers.sql',
      '0004_food_log_corrections.sql',
      '0005_households.sql',
      // AI-2: distributed guidance admission. Cost infrastructure only — no
      // nutrition, conversation or model data.
      '0006_guidance_admission.sql',
    ]);
  });

  const USER_TABLES = ['user_profile_versions', 'energy_goal_versions', 'food_logs'];
  const ALL_TABLES = [...USER_TABLES, 'catalog_products', 'product_versions'];

  for (const t of ALL_TABLES) {
    test(`${t} exists and has RLS enabled and forced`, () => {
      assert.match(sql, new RegExp(`CREATE TABLE ${t} \\(`));
      assert.match(sql, new RegExp(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`));
      assert.match(sql, new RegExp(`ALTER TABLE ${t} FORCE ROW LEVEL SECURITY`));
    });
  }

  for (const t of USER_TABLES) {
    test(`${t} SELECT policy is ownership-scoped`, () => {
      const policy = new RegExp(`ON ${t}\\s+FOR SELECT TO authenticated\\s+USING \\(user_id = \\(SELECT auth\\.uid\\(\\)\\)\\)`);
      assert.match(sql, policy);
    });

    test(`${t} INSERT policy uses WITH CHECK on ownership`, () => {
      const policy = new RegExp(`ON ${t}\\s+FOR INSERT TO authenticated\\s+WITH CHECK \\(user_id = \\(SELECT auth\\.uid\\(\\)\\)\\)`);
      assert.match(sql, policy);
    });
  }

  test('NO update or delete policy exists on any append-only table', () => {
    // Scoped to the APPEND-ONLY migrations. Household metadata (0005) is
    // legitimately mutable — a display name changes, a membership is removed,
    // a device is rebound — so a blanket ban across every migration would be
    // asserting the wrong invariant, not a stronger one.
    const appendOnly = files
      .filter((f) => !f.startsWith('0005'))
      .map((f) => readFileSync(join(dir, f), 'utf8')).join('\n');
    assert.ok(!/FOR UPDATE/i.test(appendOnly), 'append-only data must have no UPDATE policy');
    assert.ok(!/FOR DELETE/i.test(appendOnly), 'append-only data must have no DELETE policy');
  });

  test('household metadata never grants UPDATE over personal tables', () => {
    const household = readFileSync(join(dir, '0005_households.sql'), 'utf8');
    for (const personal of ['food_logs', 'user_profile_versions', 'energy_goal_versions']) {
      assert.equal(household.includes(personal), false,
        `0005 must not touch ${personal} — admin is not nutrition access`);
    }
  });

  test('authenticated grants are SELECT/INSERT only, and never on the catalog', () => {
    assert.match(sql, /GRANT SELECT, INSERT ON user_profile_versions\s+TO authenticated/);
    assert.match(sql, /GRANT SELECT, INSERT ON food_logs\s+TO authenticated/);
    assert.match(sql, /GRANT SELECT\s+ON catalog_products\s+TO authenticated/);
    assert.match(sql, /GRANT SELECT\s+ON product_versions\s+TO authenticated/);
    // Again scoped: 0005 grants UPDATE on household tables only, never on
    // personal or catalog data.
    const appendOnly = files
      .filter((f) => !f.startsWith('0005'))
      .map((f) => readFileSync(join(dir, f), 'utf8')).join('\n');
    assert.ok(!/GRANT[^;]*UPDATE[^;]*TO authenticated/i.test(appendOnly));
    assert.ok(!/GRANT[^;]*DELETE[^;]*TO authenticated/i.test(appendOnly));
    assert.ok(!/GRANT[^;]*DELETE[^;]*TO authenticated/i.test(sql), 'no DELETE grant anywhere');
    assert.ok(!/GRANT[^;]*INSERT ON (catalog_products|product_versions)/i.test(sql));
  });

  test('food log identity is the composite primary key', () => {
    assert.match(sql, /PRIMARY KEY \(user_id, log_id\)/);
  });

  test('snapshot consistency is enforced in the schema, not only in code', () => {
    for (const c of [
      'food_logs_snapshot_grams_agree',
      'food_logs_snapshot_version_agree',
      'food_logs_snapshot_kcal_agree',
      'food_logs_capture_grams_agree',
    ]) {
      assert.match(sql, new RegExp(c));
    }
  });

  test('a log cannot claim one product while referencing another product version', () => {
    assert.match(sql, /UNIQUE \(product_version_id, product_id\)/);
    assert.match(
      sql,
      /FOREIGN KEY \(product_version_id, product_id\)\s+REFERENCES product_versions \(product_version_id, product_id\)/,
    );
  });

  test('no cascade delete can destroy immutable history', () => {
    assert.ok(!/ON DELETE CASCADE/i.test(sql), 'history must never be cascade-deleted');
    assert.match(sql, /REFERENCES product_versions \(product_version_id, product_id\)\s+ON DELETE RESTRICT/);
  });

  test('the daily query path is indexed', () => {
    assert.match(sql, /CREATE INDEX idx_food_logs_user_local_date ON food_logs \(user_id, local_date\)/);
  });

  test('date of birth is never a column', () => {
    // Scan column definitions, not prose: the migration comments legitimately
    // explain that DOB is deliberately NOT stored.
    const withoutComments = sql.replace(/--.*$/gm, '').replace(/'[^']*'/g, "''");
    assert.ok(
      !/\b(date_of_birth|dob|birth_date|birthdate)\b/i.test(withoutComments),
      'age is the physiological input; a date of birth must never be a column',
    );
  });
});

describe('COLUMN SCALE — float artifacts must survive PostgreSQL numeric rounding', () => {
  /**
   * REGRESSION. Ordinary inputs produce values binary floating point cannot
   * express exactly: 31 g protein per 100 g at 247 g is 76.57000000000001.
   * numeric(10,4) rounds that on insert. Writing the raw value into the column
   * and then comparing it to the raw JSONB value made every such log fail its
   * CHECK constraint — invisible in memory, fatal against a real database.
   */
  const artefactGrams = 247;
  const decimals = (v: number) => {
    const str = String(v);
    return str.includes('.') ? str.split('.')[1]!.length : 0;
  };

  const artefactItem = () =>
    createFoodLogItem({
      logId: 'log-scale',
      userId: USER_A,
      productVersion: chicken,
      weightCapture: capture(artefactGrams),
      loggedAt: AT,
      timezone: TZ,
    });

  test('an ordinary input really does exceed the column scale', () => {
    const item = artefactItem();
    assert.ok(
      decimals(item.nutritionSnapshot.totals.proteinG) > COLUMN_SCALE.macro,
      `expected a float artifact beyond the column scale, got ${item.nutritionSnapshot.totals.proteinG}`,
    );
  });

  test('the column is a rounded projection; the snapshot stays exact', () => {
    const item = artefactItem();
    const row = foodLogToRow(item);

    assert.equal(
      row.protein_g,
      toColumnScale(item.nutritionSnapshot.totals.proteinG, COLUMN_SCALE.macro),
      'the column is written at the scale PostgreSQL would store',
    );
    assert.notEqual(row.protein_g, item.nutritionSnapshot.totals.proteinG);

    const readBack = rowToFoodLog(row);
    assert.equal(
      readBack.nutritionSnapshot.totals.proteinG,
      item.nutritionSnapshot.totals.proteinG,
      'full precision survives the round trip',
    );
    assert.equal(readBack.grams, item.grams);
    assert.deepEqual(readBack, item);
  });

  test('the persisted loop accepts such a log and totals stay exact', async () => {
    const repos = await buildRepos();
    const result = await logChicken(repos, { logId: 'log-artefact', grams: artefactGrams });
    assert.equal(result.outcome, 'appended');
    assert.equal(
      result.intake.proteinG,
      result.item.nutritionSnapshot.totals.proteinG,
      'daily totals sum the exact snapshots, not the rounded columns',
    );
  });

  test('a column that disagrees beyond rounding is still rejected', () => {
    const item = createFoodLogItem({
      logId: 'log-tamper',
      userId: USER_A,
      productVersion: chicken,
      weightCapture: capture(200),
      loggedAt: AT,
      timezone: TZ,
    });
    const tampered = { ...foodLogToRow(item), protein_g: 999 };
    assert.throws(() => rowToFoodLog(tampered), /contradicts the stored snapshot/);
  });

  test('the migration rounds the JSONB side to the same scale', () => {
    const sql = readFileSync(join(ROOT, 'db/migrations/0001_core_schema.sql'), 'utf8');
    for (const [col, scale] of [['kcal', 4], ['proteinG', 4], ['carbohydrateG', 4], ['fatG', 4]] as const) {
      assert.match(
        sql,
        new RegExp(`round\\(\\(nutrition_snapshot -> 'totals' ->> '${col}'\\)::numeric, ${scale}\\)`),
        `${col} CHECK must compare at the column scale`,
      );
    }
    assert.match(sql, /round\(\(nutrition_snapshot ->> 'gramsConsumed'\)::numeric, 3\)/);
    assert.match(sql, /round\(\(weight_capture ->> 'grams'\)::numeric, 3\)/);
  });
});

describe('REAL pg DATE boundary — local_date', () => {
  // The real run failed every FoodLog path with "localDate: must be an ISO
  // calendar date": the pg driver returns DATE as a JavaScript Date, and the
  // codec passed it straight through to the domain.
  const validItem = () => createFoodLogItem({
    logId: 'date-1', userId: USER_A, productVersion: chicken,
    weightCapture: capture(200), loggedAt: AT, timezone: TZ,
  });
  const baseRow = (): FoodLogRow => foodLogToRow(validItem());

  test('a canonical string passes through unchanged', () => {
    const row = { ...baseRow(), local_date: '2026-08-26' };
    assert.equal(rowToFoodLog(row).localDate, '2026-08-26');
  });

  test('a pg Date is normalized to the LOCAL calendar day', () => {
    // Built from local components on purpose: toISOString() would convert via
    // UTC and could move the day, silently relocating a food log.
    const row = { ...baseRow(), local_date: new Date(2026, 7, 26) };
    assert.equal(rowToFoodLog(row).localDate, '2026-08-26');
  });

  test('the local day is preserved regardless of clock time', () => {
    for (const [h, m] of [[0, 0], [12, 30], [23, 59]] as const) {
      const row = { ...baseRow(), local_date: new Date(2026, 0, 1, h, m) };
      assert.equal(rowToFoodLog(row).localDate, '2026-01-01', `${h}:${m}`);
    }
  });

  test('month and day are zero-padded', () => {
    const row = { ...baseRow(), local_date: new Date(2026, 0, 5) };
    assert.equal(rowToFoodLog(row).localDate, '2026-01-05');
  });

  test('an invalid Date is rejected LOUDLY, never coerced', () => {
    const row = { ...baseRow(), local_date: new Date(NaN) };
    assert.throws(() => rowToFoodLog(row), /local_date/);
  });

  test('calendarDateOf never routes through UTC', () => {
    const src = readFileSync('packages/persistence/src/row-codec.ts', 'utf8');
    const helper = src.slice(src.indexOf('export function calendarDateOf'),
                             src.indexOf('export function rowToFoodLog'));
    assert.equal(/toISOString/.test(helper), false,
      'a DATE has no timezone; UTC conversion can move the calendar day');
    assert.match(helper, /getFullYear\(\)/);
    assert.match(helper, /getMonth\(\) \+ 1/);
    assert.match(helper, /getDate\(\)/);
  });

  test('a malformed calendar STRING is still rejected downstream', () => {
    // calendarDateOf deliberately does not judge strings; rowToFoodLog runs the
    // canonical validator, so validateFoodLogItem stays the single authority on
    // calendar-string shape and no second local-date policy exists.
    const row = { ...baseRow(), local_date: '2026-08-26T00:00:00Z' };
    assert.throws(() => rowToFoodLog(row), /must be an ISO calendar date/);
  });

  test('the WRITE path still emits the canonical string', () => {
    assert.equal(typeof foodLogToRow(validItem()).local_date, 'string');
    assert.match(foodLogToRow(validItem()).local_date as string, /^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('JSONB ROUND-TRIP — reordered totals must still replay', () => {
  // The closest deterministic reproduction of what real PostgreSQL exposed:
  // nutrition_snapshot is JSONB, which makes no promise about key order, so a
  // read-back returns the same facts with keys in a different order.
  const item = () => createFoodLogItem({
    logId: 'jsonb-1', userId: USER_A, productVersion: chicken,
    weightCapture: capture(200), loggedAt: AT, timezone: TZ,
  });

  /** Simulates JSONB returning the SAME totals with a different key order. */
  const reorderSnapshotTotals = (row: FoodLogRow): FoodLogRow => {
    const snapshot = row.nutrition_snapshot as unknown as Record<string, unknown>;
    const totals = snapshot['totals'] as Record<string, unknown>;
    const reordered: Record<string, unknown> = {};
    for (const k of Object.keys(totals).reverse()) reordered[k] = totals[k];
    return {
      ...row,
      nutrition_snapshot: { ...snapshot, totals: reordered },
    } as unknown as FoodLogRow;
  };

  test('a reordered JSONB snapshot fingerprints identically', () => {
    const original = item();
    const row = foodLogToRow(original);
    const roundTripped = rowToFoodLog(reorderSnapshotTotals(row));

    assert.notEqual(
      JSON.stringify((row.nutrition_snapshot as Record<string, unknown>)['totals']),
      JSON.stringify(
        (reorderSnapshotTotals(row).nutrition_snapshot as Record<string, unknown>)['totals']),
      'the simulation must actually reorder keys',
    );
    assert.equal(foodLogFingerprint(original), foodLogFingerprint(roundTripped));
  });

  test('the round-tripped item REPLAYS rather than conflicting', () => {
    const original = item();
    const roundTripped = rowToFoodLog(reorderSnapshotTotals(foodLogToRow(original)));
    assert.equal(appendFoodLog([original], roundTripped).outcome, 'replayed_existing',
      'this is exactly the 31 false conflicts the real run produced');
  });
});
