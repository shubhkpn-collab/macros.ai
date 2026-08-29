import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildViewModel, describeBalanceCopy, formatGrams, formatGramsWithUnit,
  formatKcal, formatProjection, lockedViewModel, progressFraction, touch,
  type ViewModelInput,
} from '@macros/tablet-view-model';
import { deriveCapabilities } from '@macros/domain-offline-sync';
import { activeSwitchState } from '@macros/domain-household';
import { repoPath } from '../tools/repo-paths.js';
import { USER_A } from '@macros/testkit';

const capabilities = (over: Record<string, unknown> = {}) => deriveCapabilities({
  backendReachable: true, catalogInstalled: true, catalogStale: false,
  localStorageWritable: true, authValid: true, cloudVoiceReachable: true,
  pendingSubmissions: 0, ...over,
} as never);

const appState = (over: Record<string, unknown> = {}) => ({
  subject: { authenticatedSubjectId: USER_A, userId: USER_A, displayName: 'Demo', sessionId: 's1' },
  requiresScaleClearForCurrentSubject: false,
  sessionGeneration: 3,
  dashboard: {
    localDate: '2026-08-28',
    intake: { kcal: 1200, proteinG: 90, carbohydrateG: 120, fatG: 40 },
    macros: {
      targets: { targetKcal: 2400, proteinG: 160, carbohydrateG: 250, fatG: 80,
        policyVersion: 'p', policyReviewStatus: 'reviewed' },
      consumedKcal: 1200,
      // The exact artifacts observed on the real device.
      consumedProteinG: 48.333333333333336,
      consumedCarbohydrateG: 303.65919999999994,
      consumedFatG: 62.0000001,
      remainingKcal: 1200,
      remainingProteinG: 111.66666666666664,
      remainingCarbohydrateG: -53.65919999999994,
      remainingFatG: 17.9999999,
    },
    guardrails: {},
    energy: { currentBalanceKcal: -1822.1109375, ifNoMoreFoodBalanceKcal: -1803.4 },
    energyIncomplete: false, energyGaps: [], activitySource: 'wearable',
    developmentDataNotice: null,
  },
  addFood: {
    phase: 'idle', flowId: 'flow-1', query: '', results: [], selected: null,
    weightCapture: null, preview: null, captureRequestId: null, submissionId: null,
    outcome: null, error: null,
  },
  scale: { connected: false, phase: 'idle', displayGrams: null, stableCandidateGrams: null,
    message: 'Scale not connected' },
  activity: {},
  ...over,
}) as never;

const input = (over: Partial<ViewModelInput> = {}): ViewModelInput => ({
  app: appState(), capabilities: capabilities(),
  switchState: activeSwitchState(USER_A, 3), recent: [],
  ...over,
} as ViewModelInput);

// ---------------------------------------------------------------------------

describe('UX-1 FORMATTING — the real float artifacts are gone', () => {
  test('energy never exposes a floating-point tail', () => {
    // -1822.1109375 was rendered verbatim on the device.
    assert.equal(formatKcal(-1822.1109375), '-1,822');
    assert.equal(formatKcal(-1505), '-1,505');
    assert.equal(formatKcal(214, { sign: true }), '+214');
    assert.equal(formatKcal(0), '0');
    for (const v of [-1822.1109375, 303.65919999999994, 48.333333333333336]) {
      assert.equal(/\.\d/.test(formatKcal(v)), false, `${v} leaked a decimal`);
    }
  });

  test('a negative rounding to zero never renders as "-0"', () => {
    assert.equal(formatKcal(-0.2), '0');
    assert.equal(formatKcal(-0.2, { sign: true }), '0');
  });

  test('macro grams are whole when effectively whole', () => {
    assert.equal(formatGrams(62.0000001), '62');
    assert.equal(formatGrams(62), '62');
    assert.equal(formatGrams(0), '0');
  });

  test('macro grams keep at most one decimal', () => {
    assert.equal(formatGrams(48.333333333333336), '48.3');
    assert.equal(formatGrams(303.65919999999994), '303.7');
    assert.equal(formatGrams(7.24), '7.2');
    assert.equal(formatGramsWithUnit(49.72), '49.7 g');
  });

  test('a negative gram value keeps its sign', () => {
    // Math.trunc(-0.2) is -0 and would silently drop the minus.
    assert.equal(formatGrams(-0.2), '-0.2');
    assert.equal(formatGrams(-53.65919999999994), '-53.7');
  });

  test('large values are grouped', () => {
    assert.equal(formatGrams(1505.5), '1,505.5');
    assert.equal(formatKcal(-12345), '-12,345');
  });

  test('semantic balance copy covers deficit, surplus and maintenance', () => {
    assert.equal(describeBalanceCopy(-1505), '1,505 kcal deficit right now');
    assert.equal(describeBalanceCopy(214), '214 kcal surplus right now');
    assert.equal(describeBalanceCopy(0), 'At maintenance right now');
    // A value rounding to zero is maintenance, not "0 kcal deficit".
    assert.equal(describeBalanceCopy(-0.4), 'At maintenance right now');
  });

  test('"calories remaining" is never the hero concept', () => {
    for (const v of [-1505, 0, 214]) {
      assert.equal(/remaining/i.test(describeBalanceCopy(v)), false);
    }
  });

  test('projection is formatted and signed', () => {
    assert.equal(formatProjection(-1803.4), 'If no more food: -1,803 kcal');
    assert.equal(formatProjection(120.6), 'If no more food: +121 kcal');
  });

  test('progress is clamped for layout without touching the values', () => {
    assert.equal(progressFraction(50, 100), 0.5);
    assert.equal(progressFraction(150, 100), 1, 'a bar cannot draw past its track');
    assert.equal(progressFraction(-10, 100), 0);
    assert.equal(progressFraction(50, 0), null);
  });

  test('non-finite input degrades to a dash, never NaN on screen', () => {
    assert.equal(formatKcal(Number.NaN), '—');
    assert.equal(formatGrams(Number.POSITIVE_INFINITY), '—');
  });
});

describe('UX-1 VIEW MODEL — components receive display-ready strings', () => {
  test('the energy hero is pre-formatted', () => {
    const vm = buildViewModel(input());
    assert.equal(vm.energy?.displayValue, '-1,822');
    assert.equal(vm.energy?.semantic, '1,822 kcal deficit right now');
    assert.equal(vm.energy?.projectionNote, 'If no more food: -1,803 kcal');
    // The authoritative value is still carried, unrounded.
    assert.equal(vm.energy?.balanceKcal, -1822.1109375);
  });

  test('macro figures are pre-formatted and artifact-free', () => {
    const vm = buildViewModel(input());
    const protein = vm.macros.find((m) => m.label === 'Protein')!;
    assert.equal(protein.displayConsumed, '48.3');
    assert.equal(protein.displayGoal, '160');
    assert.equal(protein.displayRemaining, '111.7');
    const fat = vm.macros.find((m) => m.label === 'Fat')!;
    assert.equal(fat.displayConsumed, '62', 'effectively whole renders whole');
  });

  test('review values are formatted but semantically identical to the preview', () => {
    const base = appState() as unknown as { addFood: Record<string, unknown> };
    const vm = buildViewModel(input({
      app: appState({
        addFood: {
          ...base.addFood, phase: 'reviewing',
          selected: { productVersionId: 'p@v1', displayName: 'Chicken breast', preparationState: 'cooked' },
          weightCapture: { grams: 200, source: 'manual' },
          preview: { kcal: 330.00000004, proteinG: 62.0000001, carbohydrateG: 0, fatG: 7.2 },
        },
      }),
    }));
    assert.equal(vm.review?.displayKcal, '330');
    assert.equal(vm.review?.displayProtein, '62 g');
    assert.equal(vm.review?.displayFat, '7.2 g');
    assert.equal(vm.review?.displayGrams, '200 g');
    // The trusted numbers are unchanged underneath.
    assert.equal(vm.review?.kcal, 330.00000004);
    assert.equal(vm.review?.proteinG, 62.0000001);
  });

  test('the weighing screen knows the food before a weight exists', () => {
    const base = appState() as unknown as { addFood: Record<string, unknown> };
    const vm = buildViewModel(input({
      app: appState({
        addFood: {
          ...base.addFood, phase: 'waiting_for_weight',
          selected: { productVersionId: 'p@v1', displayName: 'Chicken breast', preparationState: 'cooked' },
        },
      }),
    }));
    assert.equal(vm.screen, 'weighing');
    assert.equal(vm.selectedFood?.displayName, 'Chicken breast',
      'a generic placeholder during weighing would hide what is being weighed');
    assert.equal(vm.selectedFood?.preparationState, 'cooked');
    assert.equal(vm.review, null, 'no preview exists yet');
  });

  test('scale weight is pre-formatted', () => {
    const vm = buildViewModel(input({
      app: appState({
        scale: { connected: true, phase: 'stable', displayGrams: 200.0000001,
          stableCandidateGrams: 200, message: 'Stable' },
      }),
    }));
    assert.equal(vm.scale.displayWeight, '200 g');
    assert.equal(vm.scale.canCommitWeight, true);
  });

  test('recent foods are pre-formatted', () => {
    const vm = buildViewModel(input({ recent: [{ displayName: 'Oats', kcal: 379.4 }] }));
    assert.equal(vm.recent[0]?.displayKcal, '379');
  });

  test('the locked view still carries zero prior-user data', () => {
    const vm = lockedViewModel();
    const text = JSON.stringify(vm);
    for (const leak of ['1,822', 'Demo', '48.3', 'Chicken']) {
      assert.equal(text.includes(leak), false, `${leak} leaked into the locked view`);
    }
    assert.equal(vm.selectedFood, null);
    assert.equal(vm.energy, null);
  });

  test('offline wording stays truthful', () => {
    const vm = buildViewModel(input({
      capabilities: capabilities({ backendReachable: false, pendingSubmissions: 2 }),
    }));
    assert.match(vm.offline.message ?? '', /sync/i);
    for (const overclaim of ['saved', 'persisted', 'uploaded']) {
      assert.equal((vm.offline.message ?? '').toLowerCase().includes(overclaim), false);
    }
  });
});

describe('UX-1 DESIGN SYSTEM — one presentation authority', () => {
  const uiFiles = (): string[] => {
    const out: string[] = [];
    const walk = (d: string): void => {
      for (const e of readdirSync(d)) {
        const p = join(d, e);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith('.tsx') || p.endsWith('.ts')) out.push(p);
      }
    };
    walk(repoPath('apps', 'tablet', 'src', 'components'));
    return out;
  };

  test('components import colour and spacing from tokens, not hex literals', () => {
    for (const f of uiFiles()) {
      const code = readFileSync(f, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      const hexes = [...code.matchAll(/#[0-9a-fA-F]{6}\b/g)].map((m) => m[0]);
      // A single shadowColor black is tolerable; a palette is not.
      const nonBlack = hexes.filter((h) => h.toLowerCase() !== '#000000');
      assert.equal(nonBlack.length, 0,
        `${f} hard-codes colours instead of using tokens: ${nonBlack.join(', ')}`);
    }
  });

  test('touch targets remain appliance-sized', () => {
    assert.ok(touch.minTarget >= 72, 'wet hands at arm\'s length need large targets');
    assert.ok(touch.primaryHeight >= touch.minTarget);
    assert.ok(touch.fieldHeight >= touch.minTarget);
  });

  test('no mobile navigation chrome exists', () => {
    for (const f of uiFiles()) {
      const code = readFileSync(f, 'utf8');
      for (const banned of ['TabBar', 'BottomTab', 'DrawerNavigator', 'hamburger']) {
        assert.equal(code.includes(banned), false, `${f} introduces mobile chrome: ${banned}`);
      }
    }
  });

  test('every actionable control carries an accessibility label', () => {
    const primitives = readFileSync(
      repoPath('apps', 'tablet', 'src', 'components', 'primitives.tsx'), 'utf8');
    assert.match(primitives, /accessibilityLabel: string/);
    assert.equal(/accessibilityLabel\?: string/.test(primitives), false,
      'optional labels guarantee an unlabelled screen eventually ships');
  });

  test('status is never carried by colour alone', () => {
    const scale = readFileSync(
      repoPath('apps', 'tablet', 'src', 'components', 'ScaleWeightDisplay.tsx'), 'utf8');
    assert.match(scale, /statusCopy/, 'scale state is stated in words');
    const hero = readFileSync(
      repoPath('apps', 'tablet', 'src', 'components', 'EnergyBalanceHero.tsx'), 'utf8');
    assert.match(hero, /Estimate incomplete/);
  });

  test('motion respects the reduced-motion setting', () => {
    for (const f of ['VoiceStateIndicator.tsx', 'screens.tsx']) {
      const code = readFileSync(repoPath('apps', 'tablet', 'src', 'components', f), 'utf8');
      if (code.includes('Animated')) {
        assert.match(code, /isReduceMotionEnabled/, `${f} animates without honouring reduced motion`);
      }
    }
  });

  test('the renderer performs no nutrition or energy arithmetic', () => {
    for (const f of uiFiles()) {
      const code = readFileSync(f, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      for (const q of ['kcal', 'proteinG', 'carbohydrateG', 'fatG', 'balanceKcal']) {
        const arith = new RegExp(`\\b${q}\\b\\s*[*/+-]\\s*\\w|\\w\\s*[*/+-]\\s*\\b${q}\\b`);
        assert.equal(arith.test(code), false, `${f} computes ${q}`);
      }
    }
  });

  test('no new dependency was added', () => {
    const pkg = JSON.parse(readFileSync(repoPath('apps', 'tablet', 'package.json'), 'utf8'));
    assert.deepEqual(Object.keys(pkg.dependencies).sort(), ['react', 'react-native']);
    assert.equal(pkg.dependencies['react-native'], '0.81.1');
    // No icon, gradient or UI library crept in.
    const all = JSON.stringify({ ...pkg.dependencies, ...pkg.devDependencies });
    for (const banned of ['icon', 'gradient', 'paper', 'elements', 'vector']) {
      assert.equal(all.includes(banned), false, `unexpected dependency containing "${banned}"`);
    }
  });
});
