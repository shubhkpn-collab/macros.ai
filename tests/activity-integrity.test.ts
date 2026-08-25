import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildEnergyModel,
  computeEnergyState,
  resolveActiveEnergy,
  union,
  subtract,
  clip,
  totalMinutes,
  ACTIVITY_GAP_FILL_V1,
  loadProductionTefPolicy,
} from '@macros/domain-energy';
import {
  instant,
  kcal,
  unwrap,
  validateActiveEnergyEstimate,
  validateActivityCoverage,
  validateActivitySample,
  validateNormalizedActivityWindow,
  type ActivityCoverage,
  type ActivityGapFillPolicy,
  type Instant,
  type NormalizedActivitySample,
  type NormalizedActivityWindow,
  type TefPolicyHandle,
} from '@macros/contracts';
import {
  TEST_TEF_POLICY,
  TEST_PLAUSIBILITY_POLICY,
  PROFILE_MALE_35,
  intakeOf,
  approx,
  DAY_UTC,
  ACTIVITY_MISSING,
} from '@macros/testkit';

const at = (iso: string): Instant => instant(iso);

/** This suite reasons about a 04:00-16:00 activity window of its own. */
const W_START = at('2026-08-11T04:00:00.000Z');
const W_END = at('2026-08-11T16:00:00.000Z');

const sample = (
  start: string,
  end: string,
  activeKcal: number,
  overrides: Partial<NormalizedActivitySample> = {},
): NormalizedActivitySample => ({
  start: at(start),
  end: at(end),
  activeKcal: kcal(activeKcal),
  providerId: 'test-wearable',
  confidence: 0.9,
  isEstimated: false,
  appearsWorn: true,
  ...overrides,
});

const coverage = (overrides: Partial<ActivityCoverage> = {}): ActivityCoverage => ({
  windowStart: W_START,
  windowEnd: W_END,
  lastSampleAt: W_END,
  coveredMinutes: 720,
  gaps: [],
  coverageRatio: 1,
  ...overrides,
});

const windowOf = (
  samples: NormalizedActivitySample[],
  cov: Partial<ActivityCoverage> = {},
): NormalizedActivityWindow => ({ samples, coverage: coverage(cov) });

const FILLING_POLICY: ActivityGapFillPolicy = {
  version: 'activity-gap-fill@0.0.0-SYNTHETIC-TEST-constant-rate',
  provenance: 'SYNTHETIC_TEST',
  reviewStatus: 'PENDING_EXTERNAL_REVIEW',
  kind: 'constant_rate_per_minute',
  kcalPerMinute: 1,
};

// ---------------------------------------------------------------------------

describe('interval algebra', () => {
  const s = (a: number, b: number) => ({ start: a, end: b });

  test('union merges overlapping and touching spans, drops empties', () => {
    assert.deepEqual(union([s(0, 10), s(5, 20), s(30, 40), s(7, 7)]), [s(0, 20), s(30, 40)]);
    assert.deepEqual(union([s(0, 10), s(10, 20)]), [s(0, 20)]);
  });

  test('subtract removes holes without double counting', () => {
    assert.deepEqual(subtract([s(0, 100)], [s(20, 40), s(30, 50)]), [s(0, 20), s(50, 100)]);
    assert.deepEqual(subtract([s(0, 10)], [s(0, 10)]), []);
  });

  test('clip restricts to bounds', () => {
    assert.deepEqual(clip([s(-50, 50)], s(0, 30)), [s(0, 30)]);
  });

  test('overlapping gaps are never counted twice', () => {
    assert.equal(totalMinutes([s(0, 60000 * 60), s(0, 60000 * 60)]), 60);
  });
});

describe('OVERLAP INVARIANT — canonical activity samples must not overlap', () => {
  test('non-overlapping samples are accepted', () => {
    const w = windowOf([
      sample('2026-08-11T04:00:00.000Z', '2026-08-11T08:00:00.000Z', 200),
      sample('2026-08-11T09:00:00.000Z', '2026-08-11T12:00:00.000Z', 150),
    ]);
    assert.equal(validateNormalizedActivityWindow(w).ok, true);
  });

  test('adjacent intervals are accepted — touching is not overlapping', () => {
    const w = windowOf([
      sample('2026-08-11T04:00:00.000Z', '2026-08-11T08:00:00.000Z', 200),
      sample('2026-08-11T08:00:00.000Z', '2026-08-11T12:00:00.000Z', 150),
    ]);
    assert.equal(validateNormalizedActivityWindow(w).ok, true);
  });

  test('exact duplicate intervals are REJECTED, never summed', () => {
    const w = windowOf([
      sample('2026-08-11T04:00:00.000Z', '2026-08-11T08:00:00.000Z', 200),
      sample('2026-08-11T04:00:00.000Z', '2026-08-11T08:00:00.000Z', 200),
    ]);
    const r = validateNormalizedActivityWindow(w);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error[0]!.message, /duplicates/);
  });

  test('partial overlap is REJECTED', () => {
    const w = windowOf([
      sample('2026-08-11T04:00:00.000Z', '2026-08-11T09:00:00.000Z', 200),
      sample('2026-08-11T08:00:00.000Z', '2026-08-11T12:00:00.000Z', 150),
    ]);
    const r = validateNormalizedActivityWindow(w);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error[0]!.message, /overlaps/);
  });

  test('two devices reporting the same hours cannot inflate active energy', () => {
    const duplicated = windowOf([
      sample('2026-08-11T04:00:00.000Z', '2026-08-11T10:00:00.000Z', 400, { providerId: 'watch' }),
      sample('2026-08-11T04:00:00.000Z', '2026-08-11T10:00:00.000Z', 400, { providerId: 'phone' }),
    ]);
    assert.throws(
      () => resolveActiveEnergy(duplicated, { source: 'wearable', localHour: 12, asOf: W_END }),
      /Contract validation failed/,
    );
  });
});

describe('REJECTED SAMPLE INTERVALS become unresolved gaps', () => {
  const mixed = () =>
    windowOf([
      sample('2026-08-11T04:00:00.000Z', '2026-08-11T08:00:00.000Z', 200),
      sample('2026-08-11T08:00:00.000Z', '2026-08-11T10:00:00.000Z', 100, { appearsWorn: false }),
      sample('2026-08-11T10:00:00.000Z', '2026-08-11T16:00:00.000Z', 300),
    ]);

  test('a not-worn sample loses its calories AND leaves its interval unresolved', () => {
    const r = resolveActiveEnergy(mixed(), { source: 'wearable', localHour: 12, asOf: W_END });
    assert.equal(r.status, 'available');
    if (r.status !== 'available') return;

    assert.ok(approx(r.estimate.activeKcalSoFar, 500, 1e-9), 'only accepted samples contribute');
    assert.equal(r.estimate.completeness, 'incomplete');
    assert.ok(r.estimate.completenessGaps.includes('rejected_sample_interval_unfilled'));
    assert.ok(approx(r.estimate.unresolvedMinutes, 120, 1e-6), 'the rejected 2 hours are unresolved');
    assert.equal(r.estimate.unresolvedIntervals.length, 1);
  });

  test('coverage stays intact when another accepted sample covers the same interval', () => {
    const w = windowOf([
      sample('2026-08-11T04:00:00.000Z', '2026-08-11T16:00:00.000Z', 500),
      sample('2026-08-11T08:00:00.000Z', '2026-08-11T10:00:00.000Z', 100, {
        appearsWorn: false,
        providerId: 'other',
      }),
    ]);
    // Overlap is rejected before any accounting happens — the adapter must dedupe.
    assert.throws(() => resolveActiveEnergy(w, { source: 'wearable', localHour: 12, asOf: W_END }));
  });

  test('provider gaps and rejected intervals are unioned, never double counted', () => {
    const w = windowOf(
      [
        sample('2026-08-11T04:00:00.000Z', '2026-08-11T08:00:00.000Z', 200),
        sample('2026-08-11T08:00:00.000Z', '2026-08-11T10:00:00.000Z', 100, { appearsWorn: false }),
        sample('2026-08-11T10:00:00.000Z', '2026-08-11T16:00:00.000Z', 300),
      ],
      {
        // Overlaps the rejected sample's interval by an hour.
        gaps: [{ start: at('2026-08-11T09:00:00.000Z'), end: at('2026-08-11T11:00:00.000Z') }],
        coverageRatio: 0.8,
      },
    );
    const r = resolveActiveEnergy(w, { source: 'wearable', localHour: 12, asOf: W_END });
    assert.equal(r.status, 'available');
    if (r.status !== 'available') return;
    // 08:00-10:00 rejected, gap 09:00-11:00, but 10:00-16:00 is accepted:
    // union = 08:00-11:00, minus accepted 10:00-16:00 => 08:00-10:00 = 120 minutes.
    assert.ok(approx(r.estimate.unresolvedMinutes, 120, 1e-6));
  });
});

describe('a coverage gap makes the ENERGY state incomplete', () => {
  const model = buildEnergyModel(PROFILE_MALE_35, { targetDeltaKcal: 250, goal: 'gain' });
  const WITH_TEST_TEF: TefPolicyHandle = { status: 'available', policy: TEST_TEF_POLICY };
  const NO_TEF: TefPolicyHandle = loadProductionTefPolicy();

  const gappyWindow = () =>
    windowOf([
      sample('2026-08-11T04:00:00.000Z', '2026-08-11T08:00:00.000Z', 200),
      sample('2026-08-11T08:00:00.000Z', '2026-08-11T10:00:00.000Z', 100, { appearsWorn: false }),
      sample('2026-08-11T10:00:00.000Z', '2026-08-11T16:00:00.000Z', 300),
    ]);

  test('gap + gap-fill none => INCOMPLETE energy state', () => {
    const activity = resolveActiveEnergy(gappyWindow(), {
      source: 'wearable', localHour: 12, asOf: W_END, gapFillPolicy: ACTIVITY_GAP_FILL_V1,
    });
    const state = computeEnergyState({
      model, intake: intakeOf(1200, 90, 120, 40), tefPolicy: WITH_TEST_TEF,
      activity, asOf: W_END, day: DAY_UTC,
    });
    assert.equal(state.energyCompleteness, 'incomplete');
    assert.ok(state.completenessGaps.includes('activity_coverage_incomplete'));
    assert.equal(state.activityCompleteness, 'incomplete');
    assert.ok((state.activityUnresolvedMinutes ?? 0) > 0);
  });

  test('gap + a policy that ACTUALLY fills it => COMPLETE, and quality drops to partially_estimated', () => {
    const activity = resolveActiveEnergy(gappyWindow(), {
      source: 'wearable', localHour: 12, asOf: W_END, gapFillPolicy: FILLING_POLICY,
    });
    assert.equal(activity.status, 'available');
    if (activity.status !== 'available') return;

    assert.equal(activity.estimate.completeness, 'complete');
    assert.equal(activity.estimate.quality, 'partially_estimated', 'filled time is estimated, not observed');
    assert.ok(approx(activity.estimate.activeKcalSoFar, 500 + 120, 1e-9), 'observed + filled interval');

    const state = computeEnergyState({
      model, intake: intakeOf(1200, 90, 120, 40), tefPolicy: WITH_TEST_TEF,
      activity, asOf: W_END, day: DAY_UTC,
    });
    assert.equal(state.energyCompleteness, 'complete');
    assert.equal(state.energyQuality, 'partially_estimated_activity');
  });

  test('QUALITY and COMPLETENESS are independent axes', () => {
    const filled = resolveActiveEnergy(gappyWindow(), {
      source: 'wearable', localHour: 12, asOf: W_END, gapFillPolicy: FILLING_POLICY,
    });
    const unfilled = resolveActiveEnergy(gappyWindow(), {
      source: 'wearable', localHour: 12, asOf: W_END, gapFillPolicy: ACTIVITY_GAP_FILL_V1,
    });
    assert.ok(filled.status === 'available' && unfilled.status === 'available');
    if (filled.status !== 'available' || unfilled.status !== 'available') return;

    assert.equal(filled.estimate.quality, 'partially_estimated');
    assert.equal(unfilled.estimate.quality, 'partially_estimated');
    assert.equal(filled.estimate.completeness, 'complete');
    assert.equal(unfilled.estimate.completeness, 'incomplete');
  });

  test('TEF missing AND activity incomplete produce BOTH reasons', () => {
    const activity = resolveActiveEnergy(gappyWindow(), {
      source: 'wearable', localHour: 12, asOf: W_END,
    });
    const state = computeEnergyState({
      model, intake: intakeOf(1200, 90, 120, 40), tefPolicy: NO_TEF,
      activity, asOf: W_END, day: DAY_UTC,
    });
    assert.deepEqual(
      [...state.completenessGaps].sort(),
      ['activity_coverage_incomplete', 'tef_policy_missing'],
    );
  });
});

describe('MISSING IS NOT ZERO', () => {
  const allRejected = () =>
    windowOf([
      sample('2026-08-11T04:00:00.000Z', '2026-08-11T10:00:00.000Z', 300, { appearsWorn: false }),
      sample('2026-08-11T10:00:00.000Z', '2026-08-11T16:00:00.000Z', 200, { appearsWorn: false }),
    ]);

  test('all samples rejected + no fill => UNAVAILABLE, not an estimate of zero', () => {
    const r = resolveActiveEnergy(allRejected(), { source: 'wearable', localHour: 12, asOf: W_END });
    assert.equal(r.status, 'unavailable');
    if (r.status !== 'unavailable') return;
    assert.equal(r.reason, 'all_samples_rejected');
  });

  test('an EXPLICIT zero-activity observation stays a genuine zero', () => {
    const zeroDay = windowOf([sample('2026-08-11T04:00:00.000Z', '2026-08-11T16:00:00.000Z', 0)]);
    const r = resolveActiveEnergy(zeroDay, { source: 'wearable', localHour: 12, asOf: W_END });
    assert.equal(r.status, 'available');
    if (r.status !== 'available') return;
    assert.equal(r.estimate.activeKcalSoFar, 0, 'a real zero');
    assert.equal(r.estimate.completeness, 'complete');
    assert.equal(r.estimate.quality, 'observed');
  });

  test('an empty window is unavailable, not zero', () => {
    const r = resolveActiveEnergy(windowOf([]), { source: 'wearable', localHour: 12, asOf: W_END });
    assert.equal(r.status, 'unavailable');
    if (r.status !== 'unavailable') return;
    assert.equal(r.reason, 'no_usable_samples');
  });

  test('the engine reports the unavailability reason rather than inventing a number', () => {
    const model = buildEnergyModel(PROFILE_MALE_35, { targetDeltaKcal: 250, goal: 'gain' });
    const state = computeEnergyState({
      model,
      intake: intakeOf(1200, 90, 120, 40),
      tefPolicy: { status: 'available', policy: TEST_TEF_POLICY },
      activity: resolveActiveEnergy(allRejected(), { source: 'wearable', localHour: 12, asOf: W_END }),
      asOf: W_END,
      day: DAY_UTC,
    });
    assert.equal(state.activityUnavailableReason, 'all_samples_rejected');
    assert.equal(state.energyQuality, 'no_activity_source');
    assert.ok(state.completenessGaps.includes('activity_estimate_missing'));
    assert.equal(state.activeSoFarKcal, 0, 'the arithmetic contributes nothing');
    assert.equal(state.activityQuality, null, 'but no quality is claimed');
  });

  test('a missing provider is distinguishable from rejected samples', () => {
    const model = buildEnergyModel(PROFILE_MALE_35, { targetDeltaKcal: 0, goal: 'maintain' });
    const state = computeEnergyState({
      model, intake: intakeOf(0, 0, 0, 0), tefPolicy: { status: 'available', policy: TEST_TEF_POLICY },
      activity: ACTIVITY_MISSING, asOf: W_END, day: DAY_UTC,
    });
    assert.equal(state.activityUnavailableReason, 'no_provider');
  });
});

describe('STALE TAIL becomes an unresolved interval, never a whole-day reset', () => {
  const staleWindow = () =>
    windowOf(
      [sample('2026-08-11T04:00:00.000Z', '2026-08-11T12:00:00.000Z', 400)],
      { lastSampleAt: at('2026-08-11T12:00:00.000Z'), coverageRatio: 0.66 },
    );

  test('earlier observed energy is retained and only the tail is unresolved', () => {
    const r = resolveActiveEnergy(staleWindow(), {
      source: 'wearable', localHour: 12, asOf: W_END,
      plausibilityPolicy: TEST_PLAUSIBILITY_POLICY,
    });
    assert.equal(r.status, 'available');
    if (r.status !== 'available') return;

    assert.ok(approx(r.estimate.activeKcalSoFar, 400, 1e-9), 'the observed morning is kept');
    assert.ok(r.estimate.qualityReasons.includes('stale_data'));
    assert.ok(r.estimate.completenessGaps.includes('stale_tail_unfilled'));
    assert.ok(approx(r.estimate.unresolvedMinutes, 240, 1e-6), '12:00 to 16:00 is the tail');
  });

  test('without a plausibility policy there is no staleness rule to apply', () => {
    const r = resolveActiveEnergy(staleWindow(), { source: 'wearable', localHour: 12, asOf: W_END });
    assert.equal(r.status, 'available');
    if (r.status !== 'available') return;
    assert.ok(!r.estimate.qualityReasons.includes('stale_data'));
  });
});

describe('runtime activity validation rejects malformed provider data', () => {
  test('negative active energy is rejected', () => {
    assert.equal(validateActivitySample(sample('2026-08-11T04:00:00.000Z', '2026-08-11T05:00:00.000Z', -5)).ok, false);
  });

  test('non-finite values are rejected', () => {
    assert.equal(
      validateActivitySample(sample('2026-08-11T04:00:00.000Z', '2026-08-11T05:00:00.000Z', Number.NaN)).ok,
      false,
    );
  });

  test('confidence outside [0,1] is rejected', () => {
    const bad = sample('2026-08-11T04:00:00.000Z', '2026-08-11T05:00:00.000Z', 10, { confidence: 1.5 });
    assert.equal(validateActivitySample(bad).ok, false);
  });

  test('start must precede end', () => {
    assert.equal(validateActivitySample(sample('2026-08-11T05:00:00.000Z', '2026-08-11T04:00:00.000Z', 10)).ok, false);
  });

  test('negative optional exercise splits are rejected', () => {
    const bad = sample('2026-08-11T04:00:00.000Z', '2026-08-11T05:00:00.000Z', 10, { exerciseKcal: kcal(-1) });
    assert.equal(validateActivitySample(bad).ok, false);
  });

  test('coverage ratio outside [0,1] is rejected', () => {
    assert.equal(validateActivityCoverage(coverage({ coverageRatio: 1.5 })).ok, false);
  });

  test('a gap outside the window is rejected', () => {
    const bad = coverage({
      gaps: [{ start: at('2026-08-10T00:00:00.000Z'), end: at('2026-08-10T02:00:00.000Z') }],
    });
    assert.equal(validateActivityCoverage(bad).ok, false);
  });

  test('an inverted gap is rejected', () => {
    const bad = coverage({
      gaps: [{ start: at('2026-08-11T10:00:00.000Z'), end: at('2026-08-11T08:00:00.000Z') }],
    });
    assert.equal(validateActivityCoverage(bad).ok, false);
  });

  test('lastSampleAt outside the window is rejected', () => {
    assert.equal(validateActivityCoverage(coverage({ lastSampleAt: at('2026-08-12T00:00:00.000Z') })).ok, false);
  });

  test('an inverted coverage window is rejected', () => {
    assert.equal(
      validateActivityCoverage(coverage({ windowStart: W_END, windowEnd: W_START })).ok,
      false,
    );
  });

  test('a negative estimate is rejected', () => {
    const r = resolveActiveEnergy(
      windowOf([sample('2026-08-11T04:00:00.000Z', '2026-08-11T16:00:00.000Z', 100)]),
      { source: 'wearable', localHour: 12, asOf: W_END },
    );
    assert.ok(r.status === 'available');
    if (r.status !== 'available') return;
    assert.equal(validateActiveEnergyEstimate(r.estimate).ok, true);
    assert.equal(
      validateActiveEnergyEstimate({ ...r.estimate, activeKcalSoFar: kcal(-1) }).ok,
      false,
    );
  });

  test('malformed data is rejected loudly, never silently clamped', () => {
    const bad = windowOf([sample('2026-08-11T04:00:00.000Z', '2026-08-11T16:00:00.000Z', -50)]);
    assert.throws(() => unwrap(validateNormalizedActivityWindow(bad)), /Contract validation failed/);
  });
});

describe('samples must lie inside their declared window', () => {
  test('a sample fully inside the window is accepted', () => {
    const w = windowOf([sample('2026-08-11T05:00:00.000Z', '2026-08-11T15:00:00.000Z', 300)]);
    assert.equal(validateNormalizedActivityWindow(w).ok, true);
  });

  test('a sample starting before the window is rejected, never clipped', () => {
    const w = windowOf([sample('2026-08-11T02:00:00.000Z', '2026-08-11T10:00:00.000Z', 300)]);
    const r = validateNormalizedActivityWindow(w);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error[0]!.message, /before the declared window/);
  });

  test('a sample ending after the window is rejected, never clipped', () => {
    const w = windowOf([sample('2026-08-11T10:00:00.000Z', '2026-08-11T20:00:00.000Z', 300)]);
    const r = validateNormalizedActivityWindow(w);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error[0]!.message, /after the declared window/);
  });

  test('a sample exactly matching the window bounds is accepted', () => {
    const w = windowOf([sample('2026-08-11T04:00:00.000Z', '2026-08-11T16:00:00.000Z', 300)]);
    assert.equal(validateNormalizedActivityWindow(w).ok, true);
  });
});
