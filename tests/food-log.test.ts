import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregateDailyIntake,
  appendFoodLog,
  createFoodLogItem,
  localDayOf,
  utcOffsetMinutes,
} from '@macros/domain-food-log';
import { logFoodAndRecompute, recompute, type LoopPolicies } from '@macros/core-loop';
import { buildEnergyModel } from '@macros/domain-energy';
import { calculateNutrition } from '@macros/domain-nutrition';
import { manualCapture, initialState, reduceAll, reduceCapture } from '@macros/domain-weight';
import { ScaleSimulator } from '@macros/scale-simulator';
import {
  grams,
  instant,
  type FoodLogItem,
  type Instant,
  type ProductVersion,
  type TefPolicyHandle,
  type WeightCapture,
} from '@macros/contracts';
import {
  ALMONDS_V1,
  CHICKEN_BREAST_COOKED_V1,
  CHICKEN_BREAST_COOKED_V2_CORRECTED,
  CHICKEN_BREAST_RAW_V1,
  FIRM_TOFU_PACKAGED_V1,
  OLIVE_OIL_V1,
  PROFILE_MALE_35,
  PROFILE_FEMALE_29,
  USER_A,
  USER_B,
  SYNTHETIC_PRODUCTS,
  SYNTHETIC_STABILITY_POLICY,
  TEST_TEF_POLICY,
  WHITE_RICE_COOKED_V1,
  activeEnergy,
  approx,
  loadGolden,
} from '@macros/testkit';

const TZ = 'America/Chicago';
const AT = instant('2026-08-11T17:00:00.000Z'); // 12:00 local CDT
const POLICIES: LoopPolicies = { tefPolicy: { status: 'available', policy: TEST_TEF_POLICY } };
const MODEL = buildEnergyModel(PROFILE_MALE_35, { targetDeltaKcal: 250, goal: 'gain' });
const ACTIVITY = activeEnergy(500);

/**
 * Drive the real scale state machine to produce a capture.
 *
 * The capture request must be issued while the stable candidate is still fresh
 * — a request minutes later is rejected as stale by design — so the request
 * timestamp comes from the simulated clock, not the (later) logging instant.
 */
const scaleCapture = (g: number, startAt = '2026-08-11T16:50:00.000Z'): WeightCapture => {
  const sim = new ScaleSimulator({ startAt });
  const start = initialState(SYNTHETIC_STABILITY_POLICY);
  const connected = reduceAll(start, [sim.connect()], SYNTHETIC_STABILITY_POLICY);
  sim.setGross(g);
  const events = sim.emitSteady(6);
  const settled = reduceAll(connected.state, events, SYNTHETIC_STABILITY_POLICY);
  const requestedAt = events[events.length - 1]!.at;
  const result = reduceCapture(
    settled.state,
    { kind: 'capture_requested', requestId: `req-${g}`, at: requestedAt },
    SYNTHETIC_STABILITY_POLICY,
  );
  if (result.capture === null) throw new Error('expected a capture');
  return result.capture;
};

const logOnce = (
  product: ProductVersion,
  capture: WeightCapture,
  opts: { logId?: string; userId?: string; at?: Instant; logs?: readonly FoodLogItem[] } = {},
) =>
  logFoodAndRecompute({
    existingLogs: opts.logs ?? [],
    logId: opts.logId ?? 'log-1',
    userId: opts.userId ?? USER_A,
    selectedProductVersion: product,
    weightCapture: capture,
    loggedAt: opts.at ?? AT,
    timezone: TZ,
    energyModel: MODEL,
    activity: ACTIVITY,
    policies: POLICIES,
  });

// ---------------------------------------------------------------------------

describe('weight capture → deterministic nutrition', () => {
  test('200 g scale capture of cooked chicken produces the known values', () => {
    const result = logOnce(CHICKEN_BREAST_COOKED_V1, scaleCapture(200));
    const totals = result.item.nutritionSnapshot.totals;
    assert.ok(approx(totals.kcal, 330, 1e-9), `expected 330 kcal, got ${totals.kcal}`);
    assert.ok(approx(totals.proteinG, 62, 1e-9));
    assert.ok(approx(totals.fatG, 7.2, 1e-9));
  });

  test('MANUAL PARITY: manual and scale captures of the same grams give identical nutrition', () => {
    const fromScale = logOnce(CHICKEN_BREAST_COOKED_V1, scaleCapture(200));
    const fromManual = logOnce(CHICKEN_BREAST_COOKED_V1, manualCapture(200, AT));
    assert.deepEqual(fromManual.item.nutritionSnapshot.totals, fromScale.item.nutritionSnapshot.totals);
    assert.deepEqual(fromManual.intake, fromScale.intake);
  });

  test('but provenance stays different forever', () => {
    const fromScale = logOnce(CHICKEN_BREAST_COOKED_V1, scaleCapture(200));
    const fromManual = logOnce(CHICKEN_BREAST_COOKED_V1, manualCapture(200, AT));
    assert.equal(fromScale.item.weightCapture.source, 'scale');
    assert.equal(fromManual.item.weightCapture.source, 'manual');
    assert.ok(fromScale.item.weightCapture.evidence !== undefined);
    assert.equal(fromManual.item.weightCapture.evidence, undefined);
    assert.equal(fromManual.item.weightCapture.deviceId, undefined);
  });

  test('a raw ScaleReading can never be used where a WeightCapture is required', () => {
    const sim = new ScaleSimulator();
    reduceAll(initialState(SYNTHETIC_STABILITY_POLICY), [sim.connect()], SYNTHETIC_STABILITY_POLICY);
    sim.setGross(200);
    const event = sim.emit();
    if (event.kind !== 'reading') throw new Error('expected reading');
    const reading = event.reading;

    // Structurally: a reading has netWeightGrams, not grams/source/capturedAt.
    assert.equal((reading as unknown as Record<string, unknown>)['grams'], undefined);
    assert.equal((reading as unknown as Record<string, unknown>)['source'], undefined);
    assert.throws(
      () =>
        createFoodLogItem({
          logId: 'x', userId: USER_A, productVersion: CHICKEN_BREAST_COOKED_V1,
          weightCapture: reading as unknown as WeightCapture,
          loggedAt: AT, timezone: TZ,
        }),
      // Rejected by the CANONICAL runtime validator, not an ad-hoc check:
      // a reading has netWeightGrams, so it has no `grams` at all.
      /Contract validation failed/,
    );
  });

  test('a zero or negative weight is refused', () => {
    for (const g of [0, -5]) {
      assert.throws(() =>
        createFoodLogItem({
          logId: 'x', userId: USER_A, productVersion: CHICKEN_BREAST_COOKED_V1,
          weightCapture: { grams: grams(g), source: 'manual', capturedAt: AT },
          loggedAt: AT, timezone: TZ,
        }),
      );
    }
  });

  test('calories come from the source product, not recomputed from macros', () => {
    // Almonds: Atwater from macros would be ~633 kcal/100 g, but the declared
    // value is 579. The snapshot must honour the source.
    const result = logOnce(ALMONDS_V1, manualCapture(100, AT));
    assert.ok(approx(result.item.nutritionSnapshot.totals.kcal, 579, 1e-9));
    const atwater = 21.2 * 4 + 21.6 * 4 + 49.9 * 9;
    assert.ok(Math.abs(atwater - 579) > 20, 'the fixture genuinely differs from Atwater');
  });

  test('a volume basis is normalized to mass before any arithmetic', () => {
    const result = logOnce(OLIVE_OIL_V1, manualCapture(13.74, AT));
    assert.ok(approx(result.item.nutritionSnapshot.totals.kcal, 121.4616, 1e-6));
  });
});

describe('IMMUTABILITY — product corrections never rewrite history', () => {
  test('a stored snapshot is unaffected by a later product version', () => {
    const logged = logOnce(CHICKEN_BREAST_COOKED_V1, manualCapture(200, AT));
    const before = { ...logged.item.nutritionSnapshot.totals };

    // A corrected version exists with different nutrition.
    const corrected = calculateNutrition(CHICKEN_BREAST_COOKED_V2_CORRECTED.basis, grams(200));
    assert.ok(!approx(corrected.totals.kcal, before.kcal, 1e-9), 'the correction really differs');

    // Re-aggregating the same logs still yields the original figures.
    const again = recompute({
      logs: logged.logs, userId: USER_A, at: AT, timezone: TZ,
      energyModel: MODEL, activity: ACTIVITY, policies: POLICIES,
    });
    assert.ok(approx(again.intake.kcal, before.kcal, 1e-9));
    assert.equal(logged.item.productVersionId, 'syn-chicken-breast@cooked-v1');
  });

  test('two versions may differ, and a log keeps the one it was created with', () => {
    const v1 = logOnce(CHICKEN_BREAST_COOKED_V1, manualCapture(200, AT), { logId: 'l1' });
    const v2 = logOnce(CHICKEN_BREAST_COOKED_V2_CORRECTED, manualCapture(200, AT), { logId: 'l2' });
    assert.notEqual(v1.item.productVersionId, v2.item.productVersionId);
    assert.ok(!approx(v1.item.nutritionSnapshot.totals.kcal, v2.item.nutritionSnapshot.totals.kcal, 1e-9));
  });

  test('raw and cooked remain separate versions, never yield-converted', () => {
    const cooked = logOnce(CHICKEN_BREAST_COOKED_V1, manualCapture(200, AT), { logId: 'c' });
    const raw = logOnce(CHICKEN_BREAST_RAW_V1, manualCapture(200, AT), { logId: 'r' });
    assert.equal(cooked.item.productId === raw.item.productId, false);
    assert.ok(approx(cooked.item.nutritionSnapshot.totals.kcal, 330, 1e-9));
    assert.ok(approx(raw.item.nutritionSnapshot.totals.kcal, 240, 1e-9));
    assert.equal(CHICKEN_BREAST_COOKED_V1.preparationState, 'cooked');
    assert.equal(CHICKEN_BREAST_RAW_V1.preparationState, 'raw');
  });

  test('the original label facts are retained and never reconstructed', () => {
    assert.equal(FIRM_TOFU_PACKAGED_V1.labelFacts!.servingLabel, '1/5 block (85 g)');
    assert.equal(FIRM_TOFU_PACKAGED_V1.labelFacts!.servingGrams, 85);
    assert.ok(FIRM_TOFU_PACKAGED_V1.basis.kcal > 0, 'the normalized basis exists alongside it');
  });

  test('every synthetic fixture is marked as synthetic, never as catalog data', () => {
    for (const p of SYNTHETIC_PRODUCTS) {
      assert.equal(p.source.kind, 'synthetic_test');
      assert.equal(p.source.verificationStatus, 'synthetic_test');
    }
  });
});

describe('AGGREGATION — user, day and idempotency isolation', () => {
  test('two foods sum exactly', () => {
    const a = logOnce(CHICKEN_BREAST_COOKED_V1, manualCapture(200, AT), { logId: 'l1' });
    const b = logOnce(WHITE_RICE_COOKED_V1, manualCapture(150, AT), { logId: 'l2', logs: a.logs });
    assert.equal(b.intake.itemCount, 2);
    assert.ok(approx(b.intake.kcal, 330 + 195, 1e-9));
    assert.ok(approx(b.intake.proteinG, 62 + 4.05, 1e-9));
    assert.ok(approx(b.intake.carbohydrateG, 0 + 42, 1e-9));
  });

  test('IDEMPOTENCY — the same logId twice does not double-count', () => {
    const first = logOnce(CHICKEN_BREAST_COOKED_V1, manualCapture(200, AT), { logId: 'same' });
    assert.equal(first.outcome, 'appended');
    const replay = logOnce(CHICKEN_BREAST_COOKED_V1, manualCapture(200, AT), { logId: 'same', logs: first.logs });
    assert.equal(replay.outcome, 'replayed_existing');
    assert.equal(replay.logs.length, 1);
    assert.ok(approx(replay.intake.kcal, 330, 1e-9));
  });

  test('USER ISOLATION — another user never contributes to these totals', () => {
    const B_MODEL = buildEnergyModel(PROFILE_FEMALE_29, { targetDeltaKcal: -400, goal: 'lose' });

    const a = logOnce(CHICKEN_BREAST_COOKED_V1, manualCapture(200, AT), { logId: 'l1', userId: USER_A });
    const b = logFoodAndRecompute({
      existingLogs: a.logs,
      logId: 'l2',
      userId: USER_B,
      selectedProductVersion: ALMONDS_V1,
      weightCapture: manualCapture(500, AT),
      loggedAt: AT,
      timezone: TZ,
      energyModel: B_MODEL,
      activity: ACTIVITY,
      policies: POLICIES,
    });
    assert.equal(b.intake.itemCount, 1, 'user B sees only their own food');

    const backToA = recompute({
      logs: b.logs, userId: USER_A, at: AT, timezone: TZ,
      energyModel: MODEL, activity: ACTIVITY, policies: POLICIES,
    });
    assert.ok(approx(backToA.intake.kcal, 330, 1e-9), 'user A is unchanged');
  });

  test('SUBJECT BINDING — a user can never be recomputed against another user model', () => {
    const B_MODEL = buildEnergyModel(PROFILE_FEMALE_29, { targetDeltaKcal: -400, goal: 'lose' });
    assert.throws(
      () =>
        recompute({
          logs: [], userId: USER_A, at: AT, timezone: TZ,
          energyModel: B_MODEL, activity: ACTIVITY, policies: POLICIES,
        }),
      /subject mismatch/,
    );
  });

  test('DAY ISOLATION — yesterday does not contribute to today', () => {
    const yesterday = instant('2026-08-10T17:00:00.000Z');
    const a = logOnce(CHICKEN_BREAST_COOKED_V1, manualCapture(200, yesterday), { logId: 'l1', at: yesterday });
    const b = logOnce(WHITE_RICE_COOKED_V1, manualCapture(150, AT), { logId: 'l2', logs: a.logs });
    assert.equal(b.intake.itemCount, 1);
    assert.ok(approx(b.intake.kcal, 195, 1e-9));
    assert.notEqual(a.localDate, b.localDate);
  });

  test('LOCAL MIDNIGHT — 23:59 and 00:01 local are different days', () => {
    // America/Chicago is UTC-5 in August (CDT).
    const before = instant('2026-08-12T04:59:00.000Z'); // 23:59 local, 11 Aug
    const after = instant('2026-08-12T05:01:00.000Z'); // 00:01 local, 12 Aug
    assert.equal(localDayOf(before, TZ).localDate, '2026-08-11');
    assert.equal(localDayOf(after, TZ).localDate, '2026-08-12');

    const a = logOnce(CHICKEN_BREAST_COOKED_V1, manualCapture(200, before), { logId: 'l1', at: before });
    const b = logOnce(WHITE_RICE_COOKED_V1, manualCapture(150, after), { logId: 'l2', at: after, logs: a.logs });
    assert.equal(b.intake.itemCount, 1, 'the late-night meal stays on the previous day');
  });

  test('DST — the stored UTC offset reflects the offset in force at that instant', () => {
    // US DST ended 2026-11-01 at 02:00 local.
    const cdt = instant('2026-10-31T17:00:00.000Z');
    const cst = instant('2026-11-02T18:00:00.000Z');
    assert.equal(utcOffsetMinutes(cdt, TZ), -300, 'CDT is UTC-5');
    assert.equal(utcOffsetMinutes(cst, TZ), -360, 'CST is UTC-6');

    const a = createFoodLogItem({
      logId: 'dst-1', userId: USER_A, productVersion: CHICKEN_BREAST_COOKED_V1,
      weightCapture: manualCapture(100, cdt), loggedAt: cdt, timezone: TZ,
    });
    const b = createFoodLogItem({
      logId: 'dst-2', userId: USER_A, productVersion: CHICKEN_BREAST_COOKED_V1,
      weightCapture: manualCapture(100, cst), loggedAt: cst, timezone: TZ,
    });
    assert.equal(a.eventUtcOffsetMinutes, -300);
    assert.equal(b.eventUtcOffsetMinutes, -360);
    assert.notEqual(a.localDate, b.localDate);
  });

  test('DST — the two 01:30 local instants on the fall-back day share one calendar day', () => {
    const firstPass = instant('2026-11-01T06:30:00.000Z'); // 01:30 CDT
    const secondPass = instant('2026-11-01T07:30:00.000Z'); // 01:30 CST
    assert.equal(localDayOf(firstPass, TZ).localDate, '2026-11-01');
    assert.equal(localDayOf(secondPass, TZ).localDate, '2026-11-01');
    assert.notEqual(utcOffsetMinutes(firstPass, TZ), utcOffsetMinutes(secondPass, TZ));
  });

  test('aggregation reads stored snapshots, not live product data', () => {
    const logged = logOnce(CHICKEN_BREAST_COOKED_V1, manualCapture(200, AT));
    const totals = aggregateDailyIntake(logged.logs, { userId: USER_A, localDate: logged.localDate });
    assert.equal(totals.kcal, logged.item.nutritionSnapshot.totals.kcal);
  });

  test('appendFoodLog is deterministic and does not mutate its input', () => {
    const item = logOnce(CHICKEN_BREAST_COOKED_V1, manualCapture(200, AT)).item;
    const base: readonly FoodLogItem[] = [];
    const r1 = appendFoodLog(base, item);
    assert.equal(base.length, 0, 'the original array is untouched');
    assert.equal(appendFoodLog(r1.logs, item).outcome, 'replayed_existing');
  });
});

describe('MACRO AND ENERGY RECOMPUTE', () => {
  test('logging food increases intake, changes TEF, balance and remaining intake', () => {
    const before = recompute({
      logs: [], userId: USER_A, at: AT, timezone: TZ,
      energyModel: MODEL, activity: ACTIVITY, policies: POLICIES,
    });
    const after = logOnce(CHICKEN_BREAST_COOKED_V1, scaleCapture(200));

    assert.ok(after.intake.kcal > before.intake.kcal, 'intake rises');
    assert.ok(
      (after.energy.tefEstimatedTotalKcal ?? 0) > (before.energy.tefEstimatedTotalKcal ?? 0),
      'estimated TEF rises with logged macros',
    );
    assert.ok(after.energy.currentBalanceKcal > before.energy.currentBalanceKcal, 'balance rises');
    assert.ok(after.energy.remainingIntakeKcal < before.energy.remainingIntakeKcal, 'remaining falls');
  });

  test('ACTIVITY INDEPENDENCE — logging food never changes active energy', () => {
    const before = recompute({
      logs: [], userId: USER_A, at: AT, timezone: TZ,
      energyModel: MODEL, activity: ACTIVITY, policies: POLICIES,
    });
    const after = logOnce(CHICKEN_BREAST_COOKED_V1, scaleCapture(200));
    assert.equal(after.energy.activeSoFarKcal, before.energy.activeSoFarKcal);
    assert.equal(after.energy.basalSoFarKcal, before.energy.basalSoFarKcal);
    assert.equal(after.energy.expenditureSoFarKcal, before.energy.expenditureSoFarKcal);
  });

  test('macro state comes from the existing engine with its policy provenance', () => {
    const result = logOnce(CHICKEN_BREAST_COOKED_V1, scaleCapture(200));
    assert.ok(approx(result.macros.consumedProteinG, 62, 1e-9));
    assert.ok(result.macros.targets.proteinG > 0);
    assert.ok(approx(result.macros.remainingProteinG, result.macros.targets.proteinG - 62, 1e-9));
    assert.equal(result.macros.targets.policyReviewStatus, 'PENDING_EXTERNAL_REVIEW');
  });

  test('the loop is deterministic — identical inputs, identical output', () => {
    const a = JSON.stringify(logOnce(CHICKEN_BREAST_COOKED_V1, manualCapture(200, AT)));
    const b = JSON.stringify(logOnce(CHICKEN_BREAST_COOKED_V1, manualCapture(200, AT)));
    assert.equal(a, b);
  });
});

describe('GOLDEN — the complete deterministic vertical slice', () => {
  interface Golden {
    step1: { grams: number; expectedSnapshot: Record<string, number>; expectedIntake: Record<string, number>;
      expectedTefKcal: number; expectedExpenditureSoFar: number; expectedCurrentBalance: number;
      expectedProjectedTotal: number; expectedRemainingIntake: number };
    step2: Golden['step1'];
  }
  const golden = loadGolden<Golden>('food-vertical-slice.json');

  const step1 = () => logOnce(CHICKEN_BREAST_COOKED_V1, scaleCapture(200), { logId: 'g1' });

  test('step 1 — 200 g cooked chicken on the scale', () => {
    const r = step1();
    const g = golden.step1;
    assert.ok(approx(r.item.nutritionSnapshot.totals.kcal, g.expectedSnapshot['kcal']!, 1e-9));
    assert.ok(approx(r.item.nutritionSnapshot.totals.proteinG, g.expectedSnapshot['proteinG']!, 1e-9));
    assert.ok(approx(r.intake.kcal, g.expectedIntake['kcal']!, 1e-9));
    assert.equal(r.intake.itemCount, g.expectedIntake['itemCount']);
    assert.ok(approx(r.energy.tefEstimatedTotalKcal ?? 0, g.expectedTefKcal, 1e-6));
    assert.ok(approx(r.energy.expenditureSoFarKcal, g.expectedExpenditureSoFar, 1e-6));
    assert.ok(approx(r.energy.currentBalanceKcal, g.expectedCurrentBalance, 1e-6));
    assert.ok(approx(r.energy.projectedTotalExpenditureKcal, g.expectedProjectedTotal, 1e-6));
    assert.ok(approx(r.energy.remainingIntakeKcal, g.expectedRemainingIntake, 1e-6));
  });

  test('step 2 — 150 g rice entered manually, on the same local day', () => {
    const first = step1();
    const r = logFoodAndRecompute({
      existingLogs: first.logs, logId: 'g2', userId: USER_A,
      selectedProductVersion: WHITE_RICE_COOKED_V1,
      weightCapture: manualCapture(150, AT),
      loggedAt: AT, timezone: TZ, energyModel: MODEL, activity: ACTIVITY, policies: POLICIES,
    });
    const g = golden.step2;
    assert.ok(approx(r.item.nutritionSnapshot.totals.kcal, g.expectedSnapshot['kcal']!, 1e-9));
    assert.ok(approx(r.intake.kcal, g.expectedIntake['kcal']!, 1e-9));
    assert.ok(approx(r.intake.proteinG, g.expectedIntake['proteinG']!, 1e-9));
    assert.equal(r.intake.itemCount, 2);
    assert.ok(approx(r.energy.tefEstimatedTotalKcal ?? 0, g.expectedTefKcal, 1e-6));
    assert.ok(approx(r.energy.currentBalanceKcal, g.expectedCurrentBalance, 1e-6));
    assert.ok(approx(r.energy.remainingIntakeKcal, g.expectedRemainingIntake, 1e-6));
  });

  test('the local day is the user calendar day, midnight boundary', () => {
    const r = step1();
    assert.equal(r.localDate, '2026-08-11');
    assert.equal(r.item.eventTimezone, TZ);
    assert.equal(r.item.eventUtcOffsetMinutes, -300);
  });
});
