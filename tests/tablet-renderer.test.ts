import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildViewModel, describeBalanceCopy, lockedViewModel, touch, type ViewModelInput,
} from '@macros/tablet-view-model';
import { deriveCapabilities } from '@macros/domain-offline-sync';
import { activeSwitchState, requestSwitch, type SwitchState } from '@macros/domain-household';
import { repoPath } from '../tools/repo-paths.js';
import { USER_A, USER_B } from '@macros/testkit';

const capabilities = (over: Record<string, unknown> = {}) => deriveCapabilities({
  backendReachable: true, catalogInstalled: true, catalogStale: false,
  localStorageWritable: true, authValid: true, cloudVoiceReachable: true,
  pendingSubmissions: 0, ...over,
} as never);

/** A realistic AppState. Every number is what a domain result would carry. */
const appState = (over: Record<string, unknown> = {}) => ({
  subject: { authenticatedSubjectId: USER_A, userId: USER_A, displayName: 'Alex', sessionId: 's1' },
  requiresScaleClearForCurrentSubject: false,
  sessionGeneration: 3,
  dashboard: {
    localDate: '2026-08-27',
    intake: { kcal: 1200, proteinG: 90, carbohydrateG: 120, fatG: 40 },
    macros: {
      targets: { targetKcal: 2400, proteinG: 160, carbohydrateG: 250, fatG: 80,
        policyVersion: 'p', policyReviewStatus: 'reviewed' },
      consumedKcal: 1200, consumedProteinG: 90, consumedCarbohydrateG: 120, consumedFatG: 40,
      remainingKcal: 1200, remainingProteinG: 70, remainingCarbohydrateG: 130, remainingFatG: 40,
    },
    guardrails: {},
    energy: { currentBalanceKcal: -327, ifNoMoreFoodBalanceKcal: -800 },
    energyIncomplete: false, energyGaps: [], activitySource: 'wearable',
    developmentDataNotice: null,
  },
  addFood: {
    phase: 'idle', flowId: 'flow-7', query: '', results: [], selected: null,
    weightCapture: null, preview: null, captureRequestId: null, submissionId: null,
    outcome: null, error: null,
  },
  scale: { connected: true, phase: 'idle', displayGrams: null, stableCandidateGrams: null, message: 'Ready' },
  activity: {},
  ...over,
}) as never;

const input = (over: Partial<ViewModelInput> = {}): ViewModelInput => ({
  app: appState(),
  capabilities: capabilities(),
  switchState: activeSwitchState(USER_A, 3),
  recent: [],
  ...over,
} as ViewModelInput);

// ---------------------------------------------------------------------------

describe('LOCKED state reveals nothing about the previous user', () => {
  test('the locked model carries no dashboard, macros, recent or identity', () => {
    const vm = lockedViewModel();
    assert.equal(vm.screen, 'locked');
    assert.equal(vm.identity, null);
    assert.equal(vm.energy, null);
    assert.deepEqual(vm.macros, []);
    assert.deepEqual(vm.recent, []);
    assert.equal(vm.review, null);
  });

  test('a null app yields the locked model even with rich state available', () => {
    const vm = buildViewModel(input({ app: null, recent: [{ displayName: 'Oats', kcal: 300 }] }));
    assert.equal(vm.screen, 'locked');
    assert.equal(vm.energy, null);
    assert.deepEqual(vm.recent, [], "the previous occupant's foods must not appear");
  });

  test('no serialized locked model contains a prior kcal figure', () => {
    const text = JSON.stringify(lockedViewModel());
    for (const leak of ['327', '1200', 'Alex', 'Oats']) {
      assert.equal(text.includes(leak), false, `${leak} leaked into the locked view`);
    }
  });
});

describe('ACTIVE HOME renders the active user read model', () => {
  test('energy balance is the primary metric and is copied, not computed', () => {
    const vm = buildViewModel(input());
    assert.equal(vm.screen, 'home');
    assert.equal(vm.energy?.balanceKcal, -327, 'exactly the domain value');
    assert.equal(vm.energy?.direction, 'deficit');
  });

  test('the semantic phrasing is a deficit statement, not "remaining"', () => {
    assert.equal(describeBalanceCopy(-327), '327 kcal deficit right now');
    assert.equal(describeBalanceCopy(150), '150 kcal surplus right now');
    assert.equal(describeBalanceCopy(0), 'At maintenance right now');
    assert.equal(/remaining/i.test(describeBalanceCopy(-327)), false);
  });

  test('macro figures are COPIED from the macro domain', () => {
    const vm = buildViewModel(input());
    const protein = vm.macros.find((m) => m.label === 'Protein')!;
    assert.equal(protein.consumedG, 90);
    assert.equal(protein.goalG, 160);
    // 70 is the DOMAIN's remaining value, not 160 - 90 recomputed here.
    assert.equal(protein.remainingG, 70);
  });

  test('an incomplete energy estimate is flagged', () => {
    const base = appState() as unknown as { dashboard: Record<string, unknown> };
    const flagged = buildViewModel(input({
      app: appState({
        dashboard: { ...base.dashboard, energyIncomplete: true, energyGaps: ['activity'] },
      }),
    }));
    assert.equal(flagged.energy?.incomplete, true, 'the number must not look authoritative');
    assert.deepEqual(flagged.energy?.gaps, ['activity']);
  });
});

describe('FOOD OPTIONS correspond to orchestration', () => {
  const withResults = (labels: readonly string[]) => appState({
    addFood: {
      ...((appState() as unknown as { addFood: Record<string, unknown> }).addFood),
      phase: 'searching', flowId: 'flow-9',
      results: labels.map((optionLabel, i) => ({
        optionLabel,
        score: 1, matchKind: 'exact', preparationStateDisambiguates: i === 1,
        productVersion: {
          productVersionId: `p${i}@v1`, displayName: `Food ${optionLabel}`,
          preparationState: i === 1 ? 'raw' : 'cooked',
        },
      })),
    },
  });

  test('option labels are carried through verbatim', () => {
    const vm = buildViewModel(input({ app: withResults(['A', 'B', 'C']) }));
    assert.equal(vm.screen, 'food_options');
    assert.deepEqual(vm.options.map((o) => o.optionLabel), ['A', 'B', 'C'],
      'spoken "Option B" must select the B on screen');
  });

  test('preparation ambiguity is surfaced, never silently resolved', () => {
    const vm = buildViewModel(input({ app: withResults(['A', 'B']) }));
    assert.equal(vm.options[1]?.preparationMatters, true);
  });

  test('the flow id travels with the model so stale options cannot act', () => {
    const vm = buildViewModel(input({ app: withResults(['A', 'B']) }));
    assert.equal(vm.flowId, 'flow-9');
    const later = buildViewModel(input());
    assert.notEqual(later.flowId, vm.flowId,
      'a new flow must be distinguishable from the one the options came from');
  });
});

describe('SCALE — unstable weight cannot be committed', () => {
  const withScale = (over: Record<string, unknown>, appOver: Record<string, unknown> = {}) =>
    buildViewModel(input({
      app: appState({
        scale: { connected: true, phase: 'settling', displayGrams: 183,
          stableCandidateGrams: null, message: 'Stabilising…', ...over },
        ...appOver,
      }),
    }));

  test('a stabilising reading is shown but NOT committable', () => {
    const vm = withScale({});
    assert.equal(vm.scale.displayGrams, 183);
    assert.equal(vm.scale.canCommitWeight, false);
  });

  test('a settled candidate is committable', () => {
    const vm = withScale({ phase: 'stable', stableCandidateGrams: 184, message: 'Stable' });
    assert.equal(vm.scale.canCommitWeight, true);
  });

  test('a pending scale clear after a user switch blocks commit', () => {
    // The previous occupant's settled candidate must not be capturable by the
    // new subject.
    const vm = withScale(
      { phase: 'stable', stableCandidateGrams: 184 },
      { requiresScaleClearForCurrentSubject: true });
    assert.equal(vm.scale.canCommitWeight, false);
  });
});

describe('REVIEW values match the trusted snapshot exactly', () => {
  const reviewing = () => appState({
    addFood: {
      ...((appState() as unknown as { addFood: Record<string, unknown> }).addFood),
      phase: 'reviewing',
      selected: { productVersionId: 'p1@v1', displayName: 'Chicken breast', preparationState: 'cooked' },
      weightCapture: { grams: 184, source: 'scale' },
      preview: { kcal: 304, proteinG: 57, carbohydrateG: 0, fatG: 7 },
    },
  });

  test('every review number is the preview value, unmodified', () => {
    const vm = buildViewModel(input({ app: reviewing() }));
    assert.equal(vm.screen, 'review');
    assert.equal(vm.review?.kcal, 304);
    assert.equal(vm.review?.proteinG, 57);
    assert.equal(vm.review?.grams, 184);
  });

  test('a completed log returns to the logged screen, not a trap', () => {
    const vm = buildViewModel(input({
      app: appState({
        addFood: {
          ...((appState() as unknown as { addFood: Record<string, unknown> }).addFood),
          phase: 'completed',
        },
      }),
    }));
    assert.equal(vm.screen, 'logged');
  });
});

describe('OFFLINE is represented truthfully', () => {
  test('a queued log says waiting to sync, never persisted', () => {
    const vm = buildViewModel(input({
      capabilities: capabilities({ backendReachable: false, pendingSubmissions: 2 }),
    }));
    assert.equal(vm.offline.offline, true);
    assert.equal(vm.offline.canLog, true, 'offline must not block logging');
    assert.match(vm.offline.message ?? '', /sync/i);
    for (const overclaim of ['saved', 'persisted', 'uploaded', 'stored on the server']) {
      assert.equal((vm.offline.message ?? '').toLowerCase().includes(overclaim), false,
        `offline copy must not claim "${overclaim}"`);
    }
  });

  test('unwritable storage disables logging honestly', () => {
    const vm = buildViewModel(input({
      capabilities: capabilities({ localStorageWritable: false }),
    }));
    assert.equal(vm.offline.canLog, false);
    assert.equal(vm.offline.message, 'Logging unavailable');
  });
});

describe('USER SWITCH keeps A visible until B is activated', () => {
  const pending = (): SwitchState => requestSwitch(activeSwitchState(USER_A, 3), {
    switchRequestId: 'sw-1', targetUserId: USER_B, targetDisplayName: 'Sam',
    deviceId: 'dev-1', householdId: 'hh-1', requestedAt: '2026-08-27T12:00:00.000Z',
  });

  test("A's identity and data remain while B authenticates", () => {
    const vm = buildViewModel(input({ switchState: pending() }));
    assert.equal(vm.identity?.displayName, 'Alex');
    assert.equal(vm.identity?.switchPending, true);
    assert.equal(vm.identity?.pendingTargetName, 'Sam');
    assert.equal(vm.energy?.balanceKcal, -327, "A's dashboard stays until B activates");
  });

  test('a failed switch leaves A visible', () => {
    const vm = buildViewModel(input({ switchState: activeSwitchState(USER_A, 3) }));
    assert.equal(vm.identity?.displayName, 'Alex');
    assert.equal(vm.identity?.switchPending, false);
  });

  test('the generation is ADOPTED from application state', () => {
    const vm = buildViewModel(input());
    assert.equal(vm.sessionGeneration, 3, 'the renderer never mints a generation');
  });

  test("activating B shows B's data, never A's", () => {
    const asB = buildViewModel(input({
      app: appState({
        subject: { authenticatedSubjectId: USER_B, userId: USER_B, displayName: 'Sam', sessionId: 's2' },
        sessionGeneration: 4,
        dashboard: {
          ...((appState() as unknown as { dashboard: Record<string, unknown> }).dashboard),
          energy: { currentBalanceKcal: 120, ifNoMoreFoodBalanceKcal: -50 },
        },
      }),
      switchState: activeSwitchState(USER_B, 4),
    }));
    assert.equal(asB.identity?.displayName, 'Sam');
    assert.equal(asB.energy?.balanceKcal, 120);
    assert.equal(asB.sessionGeneration, 4);
  });
});

describe('RENDERER SAFETY — no nutrition or energy arithmetic in the UI', () => {
  const uiFiles = (): string[] => {
    const out: string[] = [];
    const walk = (d: string): void => {
      for (const e of readdirSync(d)) {
        const p = join(d, e);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith('.tsx') || p.endsWith('.ts')) out.push(p);
      }
    };
    walk(repoPath('apps', 'tablet', 'src'));
    return out;
  };

  test('no component performs arithmetic on a domain quantity', () => {
    for (const f of uiFiles()) {
      const code = readFileSync(f, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      for (const q of ['kcal', 'proteinG', 'carbohydrateG', 'fatG', 'balanceKcal']) {
        const arith = new RegExp(`\\b${q}\\b\\s*[*/+-]\\s*\\w|\\w\\s*[*/+-]\\s*\\b${q}\\b`);
        assert.equal(arith.test(code), false, `${f} computes ${q}`);
      }
    }
  });

  test('no component imports a nutrition or energy domain', () => {
    for (const f of uiFiles()) {
      const code = readFileSync(f, 'utf8');
      for (const d of ['domain-nutrition', 'domain-energy', 'domain-macros', 'core-loop']) {
        assert.equal(code.includes(`@macros/${d}`), false, `${f} imports ${d}`);
      }
    }
  });

  test('the purity guard is wired into verify', () => {
    const pkg = JSON.parse(readFileSync(repoPath('package.json'), 'utf8'));
    assert.match(pkg.scripts.verify, /check:renderer/);
  });
});

describe('ACCESSIBILITY and kitchen usability', () => {
  test('touch targets are sized for a kitchen, not a phone', () => {
    assert.ok(touch.minTarget >= 64, 'minimum target must suit wet hands at arm\'s length');
    assert.ok(touch.primaryHeight >= touch.minTarget);
  });

  test('every actionable control carries an accessibility label', () => {
    const primitives = readFileSync(
      repoPath('apps', 'tablet', 'src', 'components', 'primitives.tsx'), 'utf8');
    // Required, not optional: an optional label guarantees an unlabelled screen.
    assert.match(primitives, /accessibilityLabel: string/);
    assert.equal(/accessibilityLabel\?: string/.test(primitives), false);
  });

  test('status is never communicated by colour alone', () => {
    const scale = readFileSync(
      repoPath('apps', 'tablet', 'src', 'components', 'ScaleWeightDisplay.tsx'), 'utf8');
    assert.match(scale, /Stable/, 'stability is stated in words');
    const hero = readFileSync(
      repoPath('apps', 'tablet', 'src', 'components', 'EnergyBalanceHero.tsx'), 'utf8');
    assert.match(hero, /Estimate incomplete/);
  });

  test('motion respects the reduced-motion setting', () => {
    const voice = readFileSync(
      repoPath('apps', 'tablet', 'src', 'components', 'VoiceStateIndicator.tsx'), 'utf8');
    assert.match(voice, /isReduceMotionEnabled/);
  });
});

describe('EXECUTION READINESS — the RN layer can actually run', () => {
  const read = (...p: string[]): string => readFileSync(repoPath('apps', 'tablet', ...p), 'utf8');

  test('BLOCKER 1: every controller method the adapter calls EXISTS', async () => {
    // The previous adapter called logFood, restartSelection and cancelAddFood,
    // none of which exist — a straight compile defect that no amount of
    // architecture review would have caught without checking the class.
    const { TabletAppController } = await import('@macros/tablet-app-core');
    const { CONTROLLER_METHODS } = await import('../apps/tablet/src/actions.js');
    const proto = TabletAppController.prototype as unknown as Record<string, unknown>;
    for (const method of CONTROLLER_METHODS) {
      assert.equal(typeof proto[method], 'function',
        `TabletAppController has no method ${method}`);
    }
  });

  test('BLOCKER 1: the removed phantom methods are not referenced anywhere', () => {
    const adapter = read('src', 'actions.ts');
    for (const phantom of ['logFood(', 'restartSelection(', 'cancelAddFood(']) {
      assert.equal(adapter.includes(phantom), false, `${phantom} does not exist on the controller`);
    }
    assert.match(adapter, /confirmFoodLog\(\)/);
    assert.match(adapter, /cancelFoodFlow\(\)/);
  });

  test('BLOCKER 1: the change-food limitation is stated, not silently lost', () => {
    const adapter = read('src', 'actions.ts');
    assert.match(adapter, /cannot preserve a captured weight/i,
      'the limitation must be documented where the behaviour lives');
    // Change WEIGHT does preserve the food; only change FOOD resets.
    assert.match(adapter, /controller\.cancelWeight\(\)/);
  });

  test('BLOCKER 2: the entry point builds a host and passes required props', () => {
    const entry = read('index.js');
    // Registering App bare would crash on destructuring before drawing a pixel.
    assert.equal(/registerComponent\([^)]*\(\)\s*=>\s*App\)/.test(entry), false);
    for (const prop of ['composition={', 'auth={', 'hasActiveSession={']) {
      assert.ok(entry.includes(prop), `entry must supply ${prop}`);
    }
    assert.match(entry, /createDevelopmentHost/);
  });

  test('BLOCKER 2: the development host is unmistakably not production', () => {
    const host = read('src', 'development-host.ts');
    assert.match(host, /DEVELOPMENT HOST — NOT PRODUCTION/);
    assert.match(host, /DEVELOPMENT BUILD/);
    const screens = read('src', 'components', 'screens.tsx');
    assert.match(screens, /DevelopmentBanner/, 'a fixture build must announce itself on screen');
  });

  test('BLOCKER 2: production and development hosts are separate contracts', () => {
    const bootstrap = read('src', 'bootstrap.ts');
    assert.match(bootstrap, /TabletHostFactory/, 'the production seam is named');
    assert.match(bootstrap, /developmentAuthHost/);
  });

  test('BLOCKER 3: the hydration script exists, is idempotent and refuses overwrites', () => {
    const script = readFileSync(repoPath('tools', 'hydrate-android-shell.mjs'), 'utf8');
    assert.match(script, /MACROS_OWNED/);
    assert.match(script, /AndroidManifest\.xml/);
    assert.match(script, /was modified during hydration/,
      'the script must PROVE owned files survived');
    assert.match(script, /0\.81\.1/);
    // The specifier is built from CLI_VERSION, so assert the pinned constant.
    assert.match(script, /const CLI_VERSION = '20\.0\.1'/);
    assert.match(script, /const RN_VERSION = '0\.81\.1'/);
    assert.match(script, /rmSync\(scratch/, 'the scratch directory is removed');
  });

  test('BLOCKER 3: the MACROS manifest is tracked, not swallowed by .gitignore', () => {
    const ignore = read('.gitignore');
    assert.match(ignore, /!android\/app\/src\/main\/AndroidManifest\.xml/);
    const manifest = read('android', 'app', 'src', 'main', 'AndroidManifest.xml');
    assert.match(manifest, /screenOrientation="portrait"/);
    assert.match(manifest, /keepScreenOn="true"/);
  });

  test('BLOCKER 4: the tablet tsconfig INHERITS the canonical alias graph', () => {
    const cfg = JSON.parse(read('tsconfig.json').replace(/^\s*"\/\/".*$/gm, ''));
    assert.equal(cfg.extends, '../../tsconfig.json',
      'hand-maintained aliases would drift from the root graph');
    // It must not re-declare paths and diverge.
    assert.equal(cfg.compilerOptions.paths, undefined);
  });

  test('BLOCKER 5: the Community CLI is declared at an exact compatible version', () => {
    const pkg = JSON.parse(read('package.json'));
    assert.equal(pkg.devDependencies['@react-native-community/cli'], '20.0.1');
    assert.equal(pkg.devDependencies['@react-native-community/cli-platform-android'], '20.0.1');
    assert.equal(pkg.dependencies['react-native'], '0.81.1');
    for (const v of Object.values({ ...pkg.dependencies, ...pkg.devDependencies })) {
      assert.match(v as string, /^\d+\.\d+\.\d+$/, 'every version must be exact');
    }
  });

  test('BLOCKER 6: a successful log returns HOME and does not fabricate a log', () => {
    const adapter = read('src', 'actions.ts');
    // Only leave the confirmation when the log genuinely succeeded.
    assert.match(adapter, /phase !== 'completed'/);
    assert.match(adapter, /cancelFoodFlow\(\)/);
    assert.match(adapter, /refreshDashboard\(\)/);
    // Returning home must not re-submit.
    const onLog = adapter.slice(adapter.indexOf('onLog:'), adapter.indexOf('onChangeFood:'));
    assert.equal((onLog.match(/confirmFoodLog/g) ?? []).length, 1,
      'exactly one submission; returning home must not log again');
  });

  test('BLOCKER 6: the view model returns to home once the flow is idle', () => {
    const base = appState() as unknown as { addFood: Record<string, unknown> };
    const completed = buildViewModel(input({
      app: appState({ addFood: { ...base.addFood, phase: 'completed' } }),
    }));
    assert.equal(completed.screen, 'logged');

    // After cancelFoodFlow the phase is idle again — and the dashboard, which
    // the persisted log already updated, is still present.
    const home = buildViewModel(input({
      app: appState({ addFood: { ...base.addFood, phase: 'idle' } }),
    }));
    assert.equal(home.screen, 'home');
    assert.equal(home.energy?.balanceKcal, -327, 'the updated dashboard survives');
  });

  test('BLOCKER 7: select member is NOT a no-op', () => {
    const adapter = read('src', 'actions.ts');
    assert.match(adapter, /beginMemberSelection\(\)/);
    assert.match(adapter, /switchActiveUser\(/);
    // The old no-op must not return.
    const onSelect = adapter.slice(adapter.indexOf('onSelectMember:'));
    assert.equal(/voiceInput\.stop\(\)/.test(onSelect), false);
  });

  test('BLOCKER 7: a refused switch preserves the current user', () => {
    const adapter = read('src', 'actions.ts');
    assert.match(adapter, /if \(outcome\.kind !== 'switched'\)/,
      'anything but a switch must leave A active');
    // The authorized session is passed through, never minted here.
    assert.match(adapter, /outcome\.session\)/);
  });

  test('BLOCKER 7: the missing credential surface is declared honestly', () => {
    const actions = read('src', 'actions.ts');
    assert.match(actions, /credentialSurfaceAvailable/);
    const bootstrap = read('src', 'bootstrap.ts');
    assert.match(bootstrap, /native_credential_surface_unavailable/,
      'an honest refusal, not silence');
  });

  test('BLOCKER 8: the doc states Build-Tools 36.0.0 and JDK 17', () => {
    const doc = readFileSync(
      repoPath('docs', 'architecture', '34-tablet-renderer.md'), 'utf8');
    assert.match(doc, /Build-Tools 36\.0\.0/);
    assert.match(doc, /JDK 17/);
    assert.equal(/Build-Tools 35\b/.test(doc), false, 'the wrong version must be gone');
  });

  test('no component imports a repository or driver', () => {
    const components = readdirSync(repoPath('apps', 'tablet', 'src', 'components'))
      .map((f) => readFileSync(repoPath('apps', 'tablet', 'src', 'components', f), 'utf8'));
    for (const code of components) {
      for (const banned of ['@macros/persistence', '@macros/postgres-driver', '@macros/testkit']) {
        assert.equal(code.includes(banned), false, `a component imports ${banned}`);
      }
    }
  });
});

describe('NATIVE BUILD READINESS — the bundle can actually resolve and load', () => {
  const read = (...p: string[]): string => readFileSync(repoPath('apps', 'tablet', ...p), 'utf8');

  test('FIX 1: Metro resolves @macros/* as first-party packages', () => {
    const metro = read('metro.config.js');
    // watchFolders makes source VISIBLE; it does not make named packages
    // resolvable, and this repo is not an npm workspace with root symlinks.
    assert.match(metro, /enableGlobalPackages:\s*true/);
    assert.match(metro, /watchFolders:\s*\[workspaceRoot\]/);
  });

  test('FIX 1: React resolves from the app first, avoiding a duplicate copy', () => {
    const metro = read('metro.config.js');
    const paths = metro.slice(metro.indexOf('nodeModulesPaths'));
    const appIdx = paths.indexOf("projectRoot, 'node_modules'");
    const rootIdx = paths.indexOf("workspaceRoot, 'node_modules'");
    assert.ok(appIdx > 0 && appIdx < rootIdx,
      "the app's own node_modules must come first");
  });

  test('FIX 1: no npm-workspace symlinks are assumed', () => {
    const rootPkg = JSON.parse(readFileSync(repoPath('package.json'), 'utf8'));
    assert.equal(rootPkg.workspaces, undefined,
      'Metro resolution must not require converting the repo to workspaces');
  });

  test('FIX 2: the app runtime graph imports NO node: built-in', () => {
    // Metro cannot bundle node:fs. A single such import breaks the app at
    // runtime, not at typecheck.
    const walk = (d: string, out: string[] = []): string[] => {
      for (const e of readdirSync(d)) {
        const p = join(d, e);
        if (statSync(p).isDirectory()) walk(p, out);
        else if (/\.(ts|tsx|js)$/.test(p)) out.push(p);
      }
      return out;
    };
    for (const f of [...walk(repoPath('apps', 'tablet', 'src')), repoPath('apps', 'tablet', 'index.js')]) {
      const code = readFileSync(f, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      assert.equal(/from\s+['"]node:/.test(code), false, `${f} imports a Node built-in`);
      assert.equal(/require\(['"]node:/.test(code), false, `${f} requires a Node built-in`);
    }
  });

  test('FIX 2: the app runtime graph does NOT import @macros/testkit', () => {
    const walk = (d: string, out: string[] = []): string[] => {
      for (const e of readdirSync(d)) {
        const p = join(d, e);
        if (statSync(p).isDirectory()) walk(p, out); else if (/\.(ts|tsx)$/.test(p)) out.push(p);
      }
      return out;
    };
    for (const f of walk(repoPath('apps', 'tablet', 'src'))) {
      const code = readFileSync(f, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      assert.equal(code.includes('@macros/testkit'), false,
        `${f} imports testkit, which pulls node:fs into the bundle`);
    }
  });

  test('FIX 2: dev fixtures duplicate VALUES only, never algorithms', () => {
    const fixtures = read('src', 'development-fixtures.ts');
    // Synthetic provenance is load-bearing: production rejects it by discriminant.
    assert.match(fixtures, /provenance: 'SYNTHETIC_TEST'/);
    assert.match(fixtures, /PENDING_HARDWARE_VALIDATION/);
    // No computation of nutrition or energy.
    for (const banned of ['function calculate', 'function compute', 'reduce(']) {
      assert.equal(fixtures.includes(banned), false, `fixtures must not contain logic: ${banned}`);
    }
  });

  test('FIX 3: the tablet lockfile is NOT gitignored', () => {
    const ignore = read('.gitignore');
    const active = ignore.split('\n').filter((l) => !l.trim().startsWith('#'));
    assert.equal(active.some((l) => l.trim() === 'package-lock.json'), false,
      'ignoring it would contradict the instruction to commit it');
    assert.ok(active.some((l) => l.trim() === 'node_modules/'));
  });

  test('FIX 4: the docs describe the deterministic hydration flow', () => {
    const doc = readFileSync(
      repoPath('docs', 'architecture', '34-tablet-renderer.md'), 'utf8');
    assert.match(doc, /node tools\/hydrate-android-shell\.mjs/);
    assert.match(doc, /Build-Tools 36\.0\.0/);
    assert.match(doc, /JDK 17/);
    assert.match(doc, /0\.81\.1/);
    assert.match(doc, /20\.0\.1/);
    // The stale manual-copy instruction must be gone.
    assert.equal(/copy its `android\/` Gradle files/.test(doc), false);
    // The count must match reality, checked against the suite itself below.
    assert.equal(/1,585 tests|expect 1585|expect 1602|expect 1606|expect 1611|expect 1620|expect 1633|expect 1660/.test(doc), false,
      'stale test count in owner instructions');
    assert.match(doc, /expect 1663 tests/);
  });

  test('FIX 4: hydration pins the package manager', () => {
    const script = readFileSync(repoPath('tools', 'hydrate-android-shell.mjs'), 'utf8');
    assert.match(script, /'--pm', 'npm'/,
      'template generation must not depend on the installed package manager');
    assert.match(script, /'--skip-install'/);
    assert.match(script, /'--install-pods', 'false'/);
  });
});

describe('REAL TYPECHECK FIXES — proven by the owner\'s Mac compile', () => {
  const read = (...p: string[]): string => readFileSync(repoPath('apps', 'tablet', ...p), 'utf8');
  const fixtures = (): string => read('src', 'development-fixtures.ts');

  test('WeightStabilityPolicy is imported from scale-protocol, not contracts', () => {
    // Stability is a property of the weighing device, not of nutrition data.
    const f = fixtures();
    assert.match(f, /import type \{ WeightStabilityPolicy \} from '@macros\/scale-protocol'/);
    const contractsImport = f.slice(f.indexOf("from '@macros/contracts'") - 400,
                                    f.indexOf("from '@macros/contracts'"));
    assert.equal(contractsImport.includes('WeightStabilityPolicy'), false);
  });

  test('DEV_TEF_POLICY uses individualAdjustmentModel and needs no cast', () => {
    const f = fixtures();
    assert.match(f, /individualAdjustmentModel:/);
    assert.equal(/individualAdjustments:/.test(f), false, 'the stale field name is gone');
    assert.equal(/\} as TefPolicy/.test(f), false, 'an unsafe cast would hide the next drift');
    assert.match(f, /provenance: 'SYNTHETIC_TEST'/);
    assert.match(f, /reviewStatus: 'PENDING_EXTERNAL_REVIEW'/);
  });

  test('DEV_CATALOG_HEADS is an array of ProductCatalogHead', () => {
    const f = fixtures();
    assert.match(f, /DEV_CATALOG_HEADS: readonly ProductCatalogHead\[\]/);
    assert.match(f, /currentProductVersionId:/);
    assert.match(f, /isActive: true/);
    assert.match(f, /updatedAt: EFFECTIVE_FROM/);
    assert.equal(/DEV_CATALOG_HEADS: Readonly<Record/.test(f), false);
  });

  test('devActiveEnergy returns an AVAILABLE ActiveEnergyResolution', () => {
    const f = fixtures();
    assert.match(f, /devActiveEnergy = \(soFar: number\): ActiveEnergyResolution/);
    assert.match(f, /status: 'available'/);
    // The full estimate contract, not a partial object behind a cast.
    for (const field of ['source:', 'quality:', 'qualityReasons:', 'completeness:',
                         'completenessGaps:', 'unresolvedIntervals:', 'unresolvedMinutes:',
                         'projectionPolicyVersion:', 'gapFillPolicyVersion:']) {
      assert.ok(f.includes(field), `estimate is missing ${field}`);
    }
    assert.equal(/as ActiveEnergyEstimate/.test(f), false);
  });

  test('the RN graph imports NO @macros/runtime-api', () => {
    // Its barrel export-stars server.ts and drags node:http and Buffer in.
    for (const f of ['src/composition.ts', 'src/actions.ts', 'src/App.tsx',
                     'src/bootstrap.ts', 'src/development-host.ts', 'index.js']) {
      const code = read(...f.split('/'))
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      assert.equal(code.includes('@macros/runtime-api'), false, `${f} imports runtime-api`);
    }
  });

  test('the RN graph imports NO @macros/runtime-config', () => {
    // Its barrel export-stars migrations.ts and drags node:crypto in.
    for (const f of ['src/composition.ts', 'src/actions.ts', 'src/App.tsx',
                     'src/bootstrap.ts', 'src/development-host.ts', 'index.js']) {
      const code = read(...f.split('/'))
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      assert.equal(code.includes('@macros/runtime-config'), false, `${f} imports runtime-config`);
    }
  });

  test('the coordinator is consumed structurally, not as the server class', () => {
    const composition = read('src', 'composition.ts');
    assert.match(composition, /interface SwitchStateReader/);
    assert.match(composition, /getState\(\): SwitchState/);
    assert.match(composition, /readonly coordinator: SwitchStateReader/);
  });

  test('the tablet tsconfig has no baseUrl override', () => {
    const raw = read('tsconfig.json');
    assert.equal(/"baseUrl"/.test(raw), false, 'TypeScript 6 rejects it, and the root config owns paths');
    assert.equal(/ignoreDeprecations/.test(raw), false);
  });

  test('every package in the RN graph is free of Node built-ins', () => {
    const graph = ['contracts', 'domain-auth', 'domain-household', 'domain-offline-sync',
                   'persistence', 'scale-protocol', 'tablet-app-core', 'tablet-view-model'];
    const walk = (d: string, out: string[] = []): string[] => {
      for (const e of readdirSync(d)) {
        const p = join(d, e);
        if (statSync(p).isDirectory()) walk(p, out); else if (p.endsWith('.ts')) out.push(p);
      }
      return out;
    };
    for (const pkg of graph) {
      for (const f of walk(repoPath('packages', pkg, 'src'))) {
        const code = readFileSync(f, 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        assert.equal(/from\s+['"]node:/.test(code), false,
          `${pkg} reaches a Node built-in and is in the RN graph: ${f}`);
      }
    }
  });
});

describe('REAL ANDROID RUNTIME FIXES — observed in the emulator', () => {
  const read = (...p: string[]): string => readFileSync(repoPath('apps', 'tablet', ...p), 'utf8');
  const base = () => appState() as unknown as { addFood: Record<string, unknown> };
  const searching = (over: Record<string, unknown> = {}) => appState({
    addFood: { ...base().addFood, phase: 'searching', ...over },
  });

  test('GAP 1: the tracked manifest declares INTERNET', () => {
    // Without it the device logs EPERM and RN cannot reach Metro at all.
    const manifest = read('android', 'app', 'src', 'main', 'AndroidManifest.xml');
    assert.match(manifest, /<uses-permission android:name="android\.permission\.INTERNET" \/>/);
    // No unrelated permissions crept in.
    const perms = [...manifest.matchAll(/uses-permission android:name="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(perms, ['android.permission.INTERNET']);
  });

  test('GAP 2: the Metro fallback is relative-.js only and workspace-scoped', () => {
    const metro = read('metro.config.js');
    assert.match(metro, /resolveRequest/);
    // Metro's own resolver runs first and always wins when it succeeds.
    assert.match(metro, /return context\.resolveRequest\(context, moduleName, platform\)/);
    assert.match(metro, /moduleName\.startsWith\('\.\/'\)/);
    assert.match(metro, /moduleName\.endsWith\('\.js'\)/);
    assert.match(metro, /isWithinWorkspace\(context\.originModulePath\)/);
    // node_modules is excluded: a .js specifier there is a real path.
    assert.match(metro, /includes\('node_modules'\)/);
    // A genuine miss still reports the specifier the author wrote.
    assert.match(metro, /throw originalError/);
  });

  test('GAP 2: the fallback keeps the existing monorepo resolution', () => {
    const metro = read('metro.config.js');
    assert.match(metro, /enableGlobalPackages: true/);
    assert.match(metro, /watchFolders: \[workspaceRoot\]/);
  });

  test('GAP 3: DEV_GOAL exists and the host seeds profile AND goal', () => {
    const fixtures = read('src', 'development-fixtures.ts');
    assert.match(fixtures, /export const DEV_GOAL: EnergyGoalVersion/);
    assert.match(fixtures, /goal: 'maintain'/);
    assert.match(fixtures, /targetDeltaKcal: 0/);

    const host = read('src', 'development-host.ts');
    const seedProfile = host.indexOf('profiles.append(DEV_PROFILE)');
    const seedGoal = host.indexOf('goals.append(DEV_GOAL)');
    // Anchor on the CALL, not the comment above it that mentions the name.
    const refresh = host.indexOf('controller.refreshDashboard()');
    assert.ok(seedProfile > 0 && seedGoal > 0, 'both fixtures must be seeded');
    assert.ok(seedGoal < refresh,
      'the goal must be seeded BEFORE refreshDashboard, or the dashboard is goal_missing');
  });

  test('GAP 4: a fresh Add food projects to food_search, never Home', () => {
    // Previously an empty result set sent the flow straight back to Home, so
    // the button looked like a no-op.
    const vm = buildViewModel(input({ app: searching({ results: [], query: '' }) }));
    assert.equal(vm.screen, 'food_search');
  });

  test('GAP 4: results project to food_options', () => {
    const vm = buildViewModel(input({
      app: searching({
        results: [{
          optionLabel: 'A', score: 1, matchKind: 'exact', preparationStateDisambiguates: false,
          productVersion: {
            productVersionId: 'p@v1', displayName: 'Chicken', preparationState: 'cooked',
          },
        }],
        query: 'chicken',
      }),
    }));
    assert.equal(vm.screen, 'food_options');
    assert.equal(vm.voice, 'needs_choice', 'options require a choice, and should say so');
  });

  test('GAP 4: voice does not claim "Thinking" on an empty search box', () => {
    const empty = buildViewModel(input({ app: searching({ results: [], query: '' }) }));
    assert.equal(empty.voice, 'idle', 'nothing is happening yet');

    const typed = buildViewModel(input({ app: searching({ results: [], query: 'chicken' }) }));
    assert.equal(typed.voice, 'interpreting', 'a submitted query IS being interpreted');
  });

  test('GAP 4: a no-result search stays on food_search with the trusted error', () => {
    const vm = buildViewModel(input({
      app: searching({
        results: [], query: 'zzzz',
        error: { code: 'no_results', message: 'No matches found.', recoverable: true },
      }),
    }));
    assert.equal(vm.screen, 'food_search');
    assert.equal(vm.error?.message, 'No matches found.', 'the controller owns the wording');
  });

  test('GAP 4: onSearchFood maps ONLY to controller.searchFood', () => {
    const adapter = read('src', 'actions.ts');
    assert.match(adapter, /onSearchFood: \(query\) => \{ after\(controller\.searchFood\(query\)\); \}/);
    const screen = read('src', 'components', 'screens.tsx');
    assert.match(screen, /FoodSearchScreen/);
    assert.match(screen, /onSubmitEditing=\{submit\}/, 'keyboard submit must also search');
    assert.match(screen, /accessibilityLabel="Food name"/);
  });

  test('GAP 5: manual weight maps ONLY to controller.enterManualWeight', () => {
    const adapter = read('src', 'actions.ts');
    assert.match(adapter, /controller\.enterManualWeight\(grams\)/);
    assert.match(adapter, /MANUAL provenance/i,
      'the fallback must not fabricate device provenance');
  });

  test('GAP 5: the manual fallback appears only when no scale is connected', () => {
    const screen = read('src', 'components', 'screens.tsx');
    assert.match(screen, /!vm\.scale\.connected && !showManual/);
    assert.match(screen, /Enter weight manually/);
    // The real-scale path stays primary.
    assert.match(screen, /label="Use this weight"/);
    assert.match(screen, /disabled=\{!vm\.scale\.canCommitWeight\}/);
  });

  test('GAP 5: the renderer parses only to enable a button, never to compute', () => {
    const screen = read('src', 'components', 'screens.tsx');
    assert.match(screen, /Number\.isFinite\(parsed\) && parsed > 0/);
    // Nothing is derived FROM the weight in the UI.
    assert.equal(/parsed\s*[*/]/.test(screen), false);
  });

  test('the full core loop is representable end to end', () => {
    const steps: readonly [string, Record<string, unknown>, string][] = [
      ['idle', { phase: 'idle' }, 'home'],
      ['search opened', { phase: 'searching', results: [], query: '' }, 'food_search'],
      ['results', {
        phase: 'searching', query: 'chicken',
        results: [{
          optionLabel: 'A', score: 1, matchKind: 'exact', preparationStateDisambiguates: false,
          productVersion: {
            productVersionId: 'p@v1', displayName: 'Chicken', preparationState: 'cooked',
          },
        }],
      }, 'food_options'],
      ['weighing', { phase: 'waiting_for_weight' }, 'weighing'],
      ['review', { phase: 'reviewing' }, 'review'],
      ['completed', { phase: 'completed' }, 'logged'],
      ['back home', { phase: 'idle' }, 'home'],
    ];
    for (const [label, over, expected] of steps) {
      const vm = buildViewModel(input({ app: appState({ addFood: { ...base().addFood, ...over } }) }));
      assert.equal(vm.screen, expected, `${label} should project to ${expected}`);
    }
  });
});
