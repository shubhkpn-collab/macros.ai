import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  resolveActiveEnergy,
  buildEnergyModel,
  computeEnergyState,
  elapsedDayFraction,
  loadProductionTefPolicy,
  ACTIVITY_GAP_FILL_V1,
  ACTIVITY_PROJECTION_HISTORICAL_MEDIAN,
  ACTIVITY_PROJECTION_V1,
  TEF_ACCRUAL_V1,
  TEF_PROJECTION_V1,
  accruedTefKcal,
  fillActivityGap,
  projectRemainingActiveKcal,
  projectTefKcal,
} from '@macros/domain-energy';
import { SimulatedActivityProvider } from '@macros/activity-provider';
import {
  centimetres,
  instant,
  kilograms,
  years,
  type Instant,
  type TefPolicyHandle,
  type UserProfileSnapshot,
} from '@macros/contracts';
import {
  TEST_TEF_POLICY,
  TEST_PLAUSIBILITY_POLICY,
  activeEnergy,
  intakeOf,
  loadGolden,
  approx,
  forAll,
  between,
  intBetween,
  pick,
  DAY_UTC,
  MIDDAY_UTC,
  DAY_START_UTC,
  ACTIVITY_MISSING,
} from '@macros/testkit';

interface EnergyGolden {
  sharedProfile: { ageYears: number; sex: 'male' | 'female'; bodyWeightKg: number; heightCm: number };
  sharedIntake: { kcal: number; proteinG: number; carbohydrateG: number; fatG: number };
  asOf: string;
  timezone: string;
  rolloverHour: number;
  cases: {
    name: string;
    activeKcalSoFar: number;
    projectedRemainingActiveKcal: number;
    targetDeltaKcal: number;
    tefPolicy: 'test' | 'none';
    expected: Record<string, number | string | null | string[]>;
  }[];
}

const golden = loadGolden<EnergyGolden>('energy-component.json');

const NO_TEF: TefPolicyHandle = loadProductionTefPolicy();
const WITH_TEST_TEF: TefPolicyHandle = { status: 'available', policy: TEST_TEF_POLICY };

const profile: UserProfileSnapshot = {
  userId: 'user-test',
  profileVersionId: 'prof-test-v1',
  effectiveFrom: instant('2026-01-01T00:00:00.000Z'),
  ageYears: years(golden.sharedProfile.ageYears),
  sex: golden.sharedProfile.sex,
  bodyWeightKg: kilograms(golden.sharedProfile.bodyWeightKg),
  heightCm: centimetres(golden.sharedProfile.heightCm),
};

const model = buildEnergyModel(profile, { targetDeltaKcal: 250, goal: 'gain' });
const intake = intakeOf(
  golden.sharedIntake.kcal,
  golden.sharedIntake.proteinG,
  golden.sharedIntake.carbohydrateG,
  golden.sharedIntake.fatG,
);

describe('golden vectors — component model (BMR + ACTIVE + TEF)', () => {
  for (const c of golden.cases) {
    test(c.name, () => {
      const m = buildEnergyModel(profile, {
        targetDeltaKcal: c.targetDeltaKcal,
        goal: c.targetDeltaKcal < 0 ? 'lose' : c.targetDeltaKcal > 0 ? 'gain' : 'maintain',
      });
      const state = computeEnergyState({
        model: m,
        intake,
        tefPolicy: c.tefPolicy === 'test' ? WITH_TEST_TEF : NO_TEF,
        activity: activeEnergy(c.activeKcalSoFar, c.projectedRemainingActiveKcal),
        asOf: instant(golden.asOf),
        day: { timezone: golden.timezone, rolloverHour: golden.rolloverHour },
      });

      for (const [key, expected] of Object.entries(c.expected)) {
        const actual = (state as unknown as Record<string, unknown>)[key];
        if (typeof expected === 'number') {
          assert.ok(
            approx(actual as number, expected, 1e-9),
            `${key}: expected ${expected}, got ${String(actual)}`,
          );
        } else if (Array.isArray(expected)) {
          assert.deepEqual(actual, expected, `${key} mismatch`);
        } else {
          assert.equal(actual, expected, `${key}: expected ${String(expected)}, got ${String(actual)}`);
        }
      }
    });
  }

  test('PRODUCT THESIS: same person, same food, different activity day -> different remaining intake', () => {
    const [, low, high] = golden.cases;
    const remaining = (activeKcal: number) =>
      computeEnergyState({
        model,
        intake,
        tefPolicy: WITH_TEST_TEF,
        activity: activeEnergy(activeKcal),
        asOf: instant(golden.asOf),
        day: DAY_UTC,
      }).remainingIntakeKcal;

    const restDay = remaining(low!.activeKcalSoFar);
    const hikeDay = remaining(high!.activeKcalSoFar);

    assert.ok(hikeDay > restDay, 'a hiking day must permit more intake than a rest day');
    assert.ok(
      approx(hikeDay - restDay, high!.activeKcalSoFar - low!.activeKcalSoFar, 1e-9),
      'the difference must equal the difference in active energy exactly',
    );
  });
});

// ---------------------------------------------------------------------------

describe('the canonical decomposition', () => {
  test('expenditure_so_far = basal + active + tef_accrued, for ALL states', () => {
    forAll(
      (rnd) => ({
        active: between(rnd, 0, 1500),
        protein: between(rnd, 0, 250),
        carb: between(rnd, 0, 400),
        fat: between(rnd, 0, 150),
        hour: intBetween(rnd, 5, 23),
        hasTef: rnd() > 0.5,
        hasActivity: rnd() > 0.2,
      }),
      ({ active, protein, carb, fat, hour, hasTef, hasActivity }) => {
        const state = computeEnergyState({
          model,
          intake: intakeOf(protein * 4 + carb * 4 + fat * 9, protein, carb, fat),
          tefPolicy: hasTef ? WITH_TEST_TEF : NO_TEF,
          activity: hasActivity ? activeEnergy(active) : ACTIVITY_MISSING,
          asOf: instant(`2026-08-11T${String(hour).padStart(2, '0')}:00:00.000Z`),
          day: DAY_UTC,
        });
        assert.ok(
          approx(
            state.expenditureSoFarKcal,
            state.basalSoFarKcal + state.activeSoFarKcal + state.tefAccruedKcal,
            1e-9,
          ),
        );
      },
    );
  });

  test('projected_total = BMR + active_so_far + remaining_active + projected_tef, for ALL states', () => {
    forAll(
      (rnd) => ({
        active: between(rnd, 0, 1500),
        remaining: between(rnd, 0, 800),
        protein: between(rnd, 0, 250),
        hour: intBetween(rnd, 5, 23),
      }),
      ({ active, remaining, protein, hour }) => {
        const state = computeEnergyState({
          model,
          intake: intakeOf(protein * 4, protein, 0, 0),
          tefPolicy: WITH_TEST_TEF,
          activity: activeEnergy(active, remaining),
          asOf: instant(`2026-08-11T${String(hour).padStart(2, '0')}:00:00.000Z`),
          day: DAY_UTC,
        });
        assert.ok(
          approx(
            state.projectedTotalExpenditureKcal,
            state.projectedBasalKcal +
              state.activeSoFarKcal +
              state.projectedRemainingActiveKcal +
              state.projectedTefKcal,
            1e-9,
          ),
        );
        assert.equal(state.projectedBasalKcal, model.bmrKcal);
      },
    );
  });

  test('the five locked identities hold everywhere', () => {
    forAll(
      (rnd) => ({
        active: between(rnd, 0, 1200),
        intakeKcal: between(rnd, 0, 4000),
        target: pick(rnd, [-500, -250, 0, 250, 500]),
        hour: intBetween(rnd, 5, 23),
      }),
      ({ active, intakeKcal, target, hour }) => {
        const m = buildEnergyModel(profile, { targetDeltaKcal: target, goal: 'maintain' });
        const state = computeEnergyState({
          model: m,
          intake: intakeOf(intakeKcal, 100, 100, 50),
          tefPolicy: WITH_TEST_TEF,
          activity: activeEnergy(active),
          asOf: instant(`2026-08-11T${String(hour).padStart(2, '0')}:00:00.000Z`),
          day: DAY_UTC,
        });
        assert.ok(approx(state.currentBalanceKcal, state.intakeSoFarKcal - state.expenditureSoFarKcal, 1e-9));
        assert.ok(
          approx(
            state.remainingIntakeKcal,
            state.projectedTotalExpenditureKcal + state.targetDeltaKcal - state.intakeSoFarKcal,
            1e-9,
          ),
        );
        assert.ok(
          approx(state.ifNoMoreFoodBalanceKcal, state.intakeSoFarKcal - state.projectedTotalExpenditureKcal, 1e-9),
        );
      },
    );
  });
});

describe('component independence', () => {
  const at = (opts: { active?: number; intakeKcal?: number; target?: number }) => {
    const m = buildEnergyModel(profile, { targetDeltaKcal: opts.target ?? 250, goal: 'maintain' });
    return computeEnergyState({
      model: m,
      intake: intakeOf(opts.intakeKcal ?? 1200, 90, 120, 40),
      tefPolicy: WITH_TEST_TEF,
      activity: activeEnergy(opts.active ?? 500),
      asOf: MIDDAY_UTC,
      day: DAY_UTC,
    });
  };

  test('changing activity never changes BMR', () => {
    forAll(
      (rnd) => between(rnd, 0, 2000),
      (active) => {
        const s = at({ active });
        assert.equal(s.basalSoFarKcal, at({ active: 0 }).basalSoFarKcal);
        assert.equal(s.projectedBasalKcal, model.bmrKcal);
      },
    );
  });

  test('changing intake never changes active energy', () => {
    forAll(
      (rnd) => between(rnd, 0, 5000),
      (intakeKcal) => {
        assert.equal(at({ intakeKcal }).activeSoFarKcal, at({ intakeKcal: 0 }).activeSoFarKcal);
      },
    );
  });

  test('changing the target delta never changes expenditure', () => {
    const base = at({ target: 0 });
    for (const target of [-1000, -400, 250, 700]) {
      const s = at({ target });
      assert.equal(s.expenditureSoFarKcal, base.expenditureSoFarKcal);
      assert.equal(s.projectedTotalExpenditureKcal, base.projectedTotalExpenditureKcal);
      assert.equal(s.currentBalanceKcal, base.currentBalanceKcal);
      assert.ok(approx(s.remainingIntakeKcal - base.remainingIntakeKcal, target, 1e-9));
    }
  });

  test('more activity strictly raises projected expenditure and remaining intake', () => {
    forAll(
      (rnd) => ({ low: between(rnd, 0, 500), extra: between(rnd, 50, 900) }),
      ({ low, extra }) => {
        const lower = at({ active: low });
        const higher = at({ active: low + extra });
        assert.ok(higher.projectedTotalExpenditureKcal > lower.projectedTotalExpenditureKcal);
        assert.ok(higher.remainingIntakeKcal > lower.remainingIntakeKcal);
        assert.ok(approx(higher.remainingIntakeKcal - lower.remainingIntakeKcal, extra, 1e-9));
      },
    );
  });
});

describe('TEF policy availability is never conflated with a zero estimate', () => {
  test('missing policy is reported as an explicit gap, not a silent zero', () => {
    const state = computeEnergyState({
      model,
      intake,
      tefPolicy: NO_TEF,
      activity: activeEnergy(500),
      asOf: MIDDAY_UTC,
      day: DAY_UTC,
    });
    assert.equal(state.tefStatus, 'policy_unavailable');
    assert.equal(state.tefEstimatedTotalKcal, null, 'null, not 0');
    assert.equal(state.energyCompleteness, 'incomplete');
    assert.deepEqual(state.completenessGaps, ['tef_policy_missing']);
    assert.equal(state.tefPolicyVersion, null);
  });

  test('a genuine zero-TEF estimate is a DIFFERENT state from a missing policy', () => {
    const zeroIntake = computeEnergyState({
      model,
      intake: intakeOf(0, 0, 0, 0),
      tefPolicy: WITH_TEST_TEF,
      activity: activeEnergy(500),
      asOf: MIDDAY_UTC,
      day: DAY_UTC,
    });
    assert.equal(zeroIntake.tefStatus, 'computed');
    assert.equal(zeroIntake.tefEstimatedTotalKcal, 0, 'zero, not null');
    assert.equal(zeroIntake.energyCompleteness, 'complete');
  });

  test('no activity estimate is also an explicit gap — there is no PAL to fall back to', () => {
    const state = computeEnergyState({
      model,
      intake,
      tefPolicy: WITH_TEST_TEF,
      activity: ACTIVITY_MISSING,
      asOf: MIDDAY_UTC,
      day: DAY_UTC,
    });
    assert.equal(state.energyQuality, 'no_activity_source');
    assert.deepEqual(state.completenessGaps, ['activity_estimate_missing']);
    assert.equal(state.activeSoFarKcal, 0);
    assert.ok(approx(state.expenditureSoFarKcal, state.basalSoFarKcal, 1e-9));
  });

  test('both gaps are reported together', () => {
    const state = computeEnergyState({
      model, intake, tefPolicy: NO_TEF, activity: ACTIVITY_MISSING, asOf: MIDDAY_UTC, day: DAY_UTC,
    });
    assert.deepEqual([...state.completenessGaps].sort(), ['activity_estimate_missing', 'tef_policy_missing']);
  });
});

describe('activity provenance and quality', () => {
  test('energy quality describes the ACTIVE source, never a different equation', () => {
    const measured = computeEnergyState({ model, intake, tefPolicy: WITH_TEST_TEF, activity: activeEnergy(500), asOf: MIDDAY_UTC, day: DAY_UTC });
    const partial = computeEnergyState({ model, intake, tefPolicy: WITH_TEST_TEF, activity: activeEnergy(500, 0, { quality: 'partially_estimated' }), asOf: MIDDAY_UTC, day: DAY_UTC });
    const estimated = computeEnergyState({ model, intake, tefPolicy: WITH_TEST_TEF, activity: activeEnergy(500, 0, { quality: 'estimated', source: 'onboarding_estimate' }), asOf: MIDDAY_UTC, day: DAY_UTC });

    assert.equal(measured.energyQuality, 'observed_activity');
    assert.equal(partial.energyQuality, 'partially_estimated_activity');
    assert.equal(estimated.energyQuality, 'estimated_activity');
    assert.equal(estimated.activitySource, 'onboarding_estimate');

    // Same equation, same arithmetic, regardless of provenance.
    assert.equal(measured.expenditureSoFarKcal, partial.expenditureSoFarKcal);
    assert.equal(measured.expenditureSoFarKcal, estimated.expenditureSoFarKcal);
  });

  test('the simulator drives the PRODUCTION equation end to end', () => {
    const provider = new SimulatedActivityProvider({
      totalActiveKcal: 500, projectedRemainingActiveKcal: 120, sampleCount: 4,
      confidence: 0.95, isEstimated: false, appearsWorn: true, coverageRatio: 1,
      lastSampleAt: MIDDAY_UTC,
    });
    const state = computeEnergyState({
      model,
      intake,
      tefPolicy: WITH_TEST_TEF,
      activity: { status: 'available', estimate: provider.buildEstimate({ start: DAY_START_UTC, end: MIDDAY_UTC }) },
      asOf: MIDDAY_UTC,
      day: DAY_UTC,
    });
    assert.equal(state.activitySource, 'simulated');
    assert.ok(approx(state.activeSoFarKcal, 500, 1e-9));
    assert.ok(approx(state.projectedActiveKcal, 620, 1e-9));
    assert.ok(approx(state.projectedTotalExpenditureKcal, model.bmrKcal + 620 + 133.2, 1e-9));
  });
});

describe('policies', () => {
  test('activity projection v1 forecasts nothing further', () => {
    assert.equal(projectRemainingActiveKcal(ACTIVITY_PROJECTION_V1, { localHour: 12 }), 0);
  });

  test('historical-median projection uses only the user own history', () => {
    const v = projectRemainingActiveKcal(ACTIVITY_PROJECTION_HISTORICAL_MEDIAN, {
      localHour: 12,
      history: { medianRemainingActiveKcalByHour: { 12: 180 } },
    });
    assert.equal(v, 180);
    assert.equal(
      projectRemainingActiveKcal(ACTIVITY_PROJECTION_HISTORICAL_MEDIAN, { localHour: 3 }),
      0,
      'no history means no forecast — never a population fallback',
    );
  });

  test('gap fill v1 reports UNFILLED — never a zero-kcal estimate', () => {
    assert.deepEqual(fillActivityGap(ACTIVITY_GAP_FILL_V1, 120), { status: 'unfilled' });
    assert.throws(() =>
      fillActivityGap(
        {
          version: 'x',
          provenance: 'SYNTHETIC_TEST',
          reviewStatus: 'PENDING_EXTERNAL_REVIEW',
          kind: 'deterministic_interval_estimate',
        },
        120,
      ),
    );
  });

  test('TEF accrual v1 accrues nothing; the reserved curve refuses to guess', () => {
    assert.equal(accruedTefKcal(TEF_ACCRUAL_V1, 250), 0);
    assert.throws(() => accruedTefKcal({ version: 'x', kind: 'intraday_curve' }, 250));
  });

  test('TEF projection v1 forecasts only logged intake', () => {
    assert.equal(projectTefKcal(TEF_PROJECTION_V1, 133.2), 133.2);
    assert.throws(() => projectTefKcal({ version: 'x', kind: 'target_macro_projection' }, 100));
  });
});

describe('profile binding — BMR and TEF cannot see different profiles', () => {
  test('the model carries its own profile snapshot', () => {
    assert.equal(model.profile, profile);
    assert.equal(model.profile.ageYears, profile.ageYears);
  });

  test('there is no way to pass a second, unrelated profile', () => {
    const source = readFileSync(
      join(new URL('..', import.meta.url).pathname, 'packages/domain-energy/src/energy-state.ts'),
      'utf8',
    );
    const inputBlock = source.slice(
      source.indexOf('export interface EnergyStateInput'),
      source.indexOf('export function buildEnergyModel'),
    );
    assert.ok(!/^\s*readonly profile:/m.test(inputBlock), 'EnergyStateInput must not accept a separate profile');
  });

  test('a different profile produces a different model, and TEF follows it', () => {
    const heavier = buildEnergyModel(
      { ...profile, bodyWeightKg: kilograms(100) },
      { targetDeltaKcal: 0, goal: 'maintain' },
    );
    assert.notEqual(heavier.bmrKcal, model.bmrKcal);
    assert.equal(heavier.profile.bodyWeightKg, 100);
  });
});

describe('NO PAL — regression guard', () => {
  const energySrc = join(new URL('..', import.meta.url).pathname, 'packages/domain-energy/src');
  /**
   * The architecture test writes a temporary `__purity_probe__.ts` here to
   * prove the purity checker catches a banned token, then deletes it. Node runs
   * test files concurrently, so this scan can discover that probe mid-flight
   * and fail on the violation the other test deliberately created.
   *
   * Excluded by name rather than by serialising the suite: the probe is the one
   * file in this directory that is not production source.
   */
  const PURITY_PROBE = '__purity_probe__.ts';
  const files = readdirSync(energySrc)
    .filter((f) => f.endsWith('.ts') && f !== PURITY_PROBE);

  const banned = ['PAL_FACTORS', 'palFactor', 'tdeeBaseline', 'activityLevel'];

  test('the architecture probe is excluded, real sources are not', () => {
    const candidate = (f: string): boolean => f.endsWith('.ts') && f !== PURITY_PROBE;
    assert.equal(candidate(PURITY_PROBE), false, 'the probe must be skipped');
    // A normal production filename is still scanned, so the exclusion cannot
    // quietly hide real sources.
    assert.equal(candidate('energy-balance.ts'), true);
    assert.ok(files.length > 0, 'production energy sources are still scanned');
    assert.equal(files.includes(PURITY_PROBE), false);
  });

  for (const f of files) {
    test(`${f} contains no PAL concept`, () => {
      const src = readFileSync(join(energySrc, f), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      for (const token of banned) {
        assert.ok(!src.includes(token), `${f} references ${token}`);
      }
      assert.ok(!/bmr\w*\s*\*\s*pal/i.test(src), `${f} multiplies BMR by PAL`);
    });
  }

  test('the energy package exports no PAL constant', async () => {
    const mod = (await import('@macros/domain-energy')) as Record<string, unknown>;
    assert.equal(mod['PAL_FACTORS'], undefined);
    for (const key of Object.keys(mod)) {
      assert.ok(!key.toLowerCase().includes('pal'), `unexpected export ${key}`);
    }
  });

  test('domain-energy never imports an onboarding activity category', () => {
    for (const f of files) {
      const src = readFileSync(join(energySrc, f), 'utf8');
      assert.ok(!/ActivityLevel/.test(src), `${f} imports ActivityLevel`);
    }
  });

  test('the whole source tree is free of the old baseline mode names', () => {
    const walk = (dir: string): string[] => {
      const out: string[] = [];
      for (const e of readdirSync(dir)) {
        const full = join(dir, e);
        if (statSync(full).isDirectory()) out.push(...walk(full));
        else if (full.endsWith('.ts')) out.push(full);
      }
      return out;
    };
    const root = new URL('..', import.meta.url).pathname;
    for (const file of walk(join(root, 'packages'))) {
      const src = readFileSync(file, 'utf8');
      assert.ok(!/'wearable_component'/.test(src), `${file} still uses the old mode name`);
      assert.ok(!/embedded_in_pal/.test(src), `${file} still uses tefTreatment embedded_in_pal`);
    }
  });
});

describe('day boundary', () => {
  test('the day is the local calendar day, anchored at midnight', () => {
    assert.ok(approx(elapsedDayFraction(DAY_START_UTC, DAY_UTC), 0, 1e-12), 'midnight is 0');
    assert.ok(approx(elapsedDayFraction(MIDDAY_UTC, DAY_UTC), 0.5, 1e-12), 'noon is half');
    assert.ok(approx(elapsedDayFraction(instant('2026-08-11T23:00:00.000Z'), DAY_UTC), 23 / 24, 1e-12));
  });

  test('there is no hidden 04:00 rollover', () => {
    assert.equal(DAY_UTC.rolloverHour, 0);
    // 01:00 local belongs to the NEW day, not late in the previous one.
    assert.ok(approx(elapsedDayFraction(instant('2026-08-12T01:00:00.000Z'), DAY_UTC), 1 / 24, 1e-12));
  });

  test('rolloverHour remains configurable for a future explicit product setting', () => {
    const shifted = { timezone: 'UTC', rolloverHour: 4 };
    assert.ok(approx(elapsedDayFraction(instant('2026-08-12T01:00:00.000Z'), shifted), 21 / 24, 1e-12));
  });

  test('uses the profile timezone, not UTC', () => {
    const chicago = { timezone: 'America/Chicago', rolloverHour: 4 };
    assert.notEqual(elapsedDayFraction(MIDDAY_UTC, DAY_UTC), elapsedDayFraction(MIDDAY_UTC, chicago));
  });

  test('elapsed fraction is always within [0, 1)', () => {
    forAll(
      (rnd) => ({ hour: intBetween(rnd, 0, 23), minute: intBetween(rnd, 0, 59) }),
      ({ hour, minute }) => {
        const iso = `2026-08-11T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00.000Z`;
        const f = elapsedDayFraction(instant(iso) as Instant, DAY_UTC);
        assert.ok(f >= 0 && f < 1);
      },
    );
  });
});

describe('determinism', () => {
  test('identical inputs produce identical output, byte for byte', () => {
    const build = () =>
      computeEnergyState({
        model, intake, tefPolicy: WITH_TEST_TEF, activity: activeEnergy(500, 100),
        asOf: MIDDAY_UTC, day: DAY_UTC,
      });
    assert.equal(JSON.stringify(build()), JSON.stringify(build()));
  });

  test('every result carries its policy versions', () => {
    const state = computeEnergyState({
      model, intake, tefPolicy: WITH_TEST_TEF, activity: activeEnergy(500),
      asOf: MIDDAY_UTC, day: DAY_UTC,
    });
    assert.match(state.calcVersion, /component/);
    assert.ok(state.bmrPolicyVersion.length > 0);
    assert.ok(state.tefProjectionPolicyVersion.length > 0);
    assert.ok(state.tefAccrualPolicyVersion.length > 0);
    assert.ok(state.activityProjectionPolicyVersion !== null);
    assert.ok(state.activityGapFillPolicyVersion !== null);
    assert.equal(state.tefPolicyReviewStatus, 'PENDING_EXTERNAL_REVIEW');
  });
});
