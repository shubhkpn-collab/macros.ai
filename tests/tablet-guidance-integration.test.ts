import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { FakeGuidanceProvider, UnavailableGuidanceProvider } from '@macros/guidance';
import { DEFAULT_RECOMMENDATION_POLICY } from '@macros/domain-recommendation';
import { isGeneratedAndroidOutput } from '../tools/check-portability.js';
import { repoPath } from '../tools/repo-paths.js';

const read = (...p: string[]): string => readFileSync(repoPath(...p), 'utf8');
const strip = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('AI-0 — the architectural boundary holds', () => {
  const componentFiles = (): string[] =>
    readdirSync(repoPath('apps', 'tablet', 'src', 'components'))
      .filter((f) => f.endsWith('.tsx') || f.endsWith('.ts'))
      .map((f) => repoPath('apps', 'tablet', 'src', 'components', f));

  test('no React component calls a recommendation or guidance domain', () => {
    for (const f of componentFiles()) {
      const code = strip(readFileSync(f, 'utf8'));
      for (const banned of ['recommendFoodPlan', 'recommendFoods', 'buildGuidanceEnvelope',
                            'requestGuidance', '@macros/guidance',
                            '@macros/domain-recommendation']) {
        assert.equal(code.includes(banned), false, `${f} reaches for ${banned}`);
      }
    }
  });

  test('components never interpret provider output', () => {
    for (const f of componentFiles()) {
      const code = strip(readFileSync(f, 'utf8'));
      for (const banned of ['templateId', 'GuidanceProviderResult', 'validateGuidance']) {
        assert.equal(code.includes(banned), false, `${f} interprets provider output`);
      }
    }
  });

  test('the controller owns the guidance orchestration', () => {
    const controller = read('packages', 'tablet-app-core', 'src', 'controller.ts');
    assert.match(controller, /buildGuidanceEnvelope\(/);
    assert.match(controller, /requestGuidance\(envelope, 'what_should_i_eat'/);
  });

  test('the UI button and future voice share ONE intent', () => {
    const actions = read('apps', 'tablet', 'src', 'actions.ts');
    // A UI-only recommendation path would drift from the voice path.
    assert.match(actions, /controller\.requestFoodGuidance\(deps\.guidance\)/);
    const screens = read('apps', 'tablet', 'src', 'components', 'screens.tsx');
    assert.match(screens, /onPress=\{actions\.onRequestGuidance\}/);
  });

  test('only rendered text reaches the view model', () => {
    const vm = read('packages', 'tablet-view-model', 'src', 'view-model.ts');
    const block = vm.slice(vm.indexOf('export interface GuidanceView'),
      vm.indexOf('export interface TabletViewModel'));
    for (const banned of ['templateId', 'slotRefs', 'objectiveIndex', 'provider']) {
      assert.equal(block.includes(banned), false, `GuidanceView exposes ${banned}`);
    }
    assert.match(block, /readonly text: string/);
  });
});

describe('AI-0 — guidance session state', () => {
  test('the phases required by the appliance exist', () => {
    const state = read('packages', 'tablet-app-core', 'src', 'state.ts');
    for (const phase of ['idle', 'thinking', 'guidance_available', 'awaiting_choice',
                         'awaiting_clarification', 'awaiting_weight', 'fallback']) {
      assert.ok(state.includes(`'${phase}'`), `missing phase ${phase}`);
    }
  });

  test('there is no chat transcript architecture', () => {
    // A dedicated appliance answers a question; it does not keep a scrollback.
    // Comments may DISCUSS transcripts; the state must not model one.
    const state = strip(read('packages', 'tablet-app-core', 'src', 'state.ts'));
    for (const banned of ['messages', 'transcript', 'conversationHistory']) {
      assert.equal(state.includes(banned), false, `state models a ${banned}`);
    }
  });

  test('guidance carries identity and generation for staleness checks', () => {
    const state = read('packages', 'tablet-app-core', 'src', 'state.ts');
    assert.match(state, /readonly envelopeId: string \| null/);
    assert.match(state, /readonly sessionGeneration: number/);
  });
});

describe('AI-0 — candidate selection safety', () => {
  const controller = () => read('packages', 'tablet-app-core', 'src', 'controller.ts');

  test('a choice is validated against the ACTIVE envelope', () => {
    const c = controller();
    assert.match(c, /active\.id !== envelopeId/);
    assert.match(c, /this\.state\.guidance\.envelopeId !== envelopeId/);
  });

  test('a superseded envelope is refused', () => {
    // Bumping the guidance generation drops the active envelope, so an id from
    // an older one can no longer be chosen.
    const c = controller();
    assert.match(c, /const stale = active === null \|\| active\.id !== envelopeId/);
  });

  test('a session-generation change refuses the choice', () => {
    assert.match(controller(),
      /this\.state\.guidance\.sessionGeneration !== this\.state\.sessionGeneration/);
  });

  test('an unoffered food is refused, never searched for', () => {
    const c = controller();
    assert.match(c, /if \(stale \|\| !offered\)/);
    const choose = c.slice(c.indexOf('async chooseGuidanceCandidate'),
      c.indexOf('clearGuidance()'));
    assert.equal(/searchFood|resilientSearch/.test(choose), false,
      'an unoffered candidate must not be looked up');
  });
});

describe('AI-0 — reuse of the existing weighing and logging flow', () => {
  test('the handoff enters the EXISTING flow, not a second logger', () => {
    const c = read('packages', 'tablet-app-core', 'src', 'controller.ts');
    const choose = c.slice(c.indexOf('async chooseGuidanceCandidate'),
      c.indexOf('clearGuidance()'));
    assert.match(choose, /this\.beginAddFood\(\);/);
    assert.match(choose, /await this\.selectProduct\(productVersionId\)/);
    assert.equal(/appendFoodLog|new FoodLog/.test(choose), false,
      'guidance must not log food itself');
  });

  test('no portion authority leads to awaiting weight', () => {
    const c = read('packages', 'tablet-app-core', 'src', 'controller.ts');
    assert.match(c, /phase: 'awaiting_weight'/);
    assert.match(c, /Put it on the scale/);
  });

  test('manual weight still uses the existing controller path', () => {
    const actions = read('apps', 'tablet', 'src', 'actions.ts');
    assert.match(actions, /controller\.enterManualWeight\(grams\)/);
  });

  test('the existing Add Food flow is still reachable', () => {
    const screens = read('apps', 'tablet', 'src', 'components', 'screens.tsx');
    assert.match(screens, /accessibilityLabel="Add food"/);
    assert.match(screens, /onPress=\{actions\.onAddFood\}/);
  });
});

describe('AI-0 — post-log invalidation and freshness', () => {
  test('a successful log clears the previous guidance', () => {
    // AI-0B strengthened this: patching state alone left activeEnvelope
    // populated and the generation unchanged, so clearGuidance is now called
    // at the moment the log succeeds.
    const c = read('packages', 'tablet-app-core', 'src', 'controller.ts');
    const log = c.slice(c.indexOf('async confirmFoodLog'), c.indexOf('cancelFoodFlow()'));
    assert.match(log, /this\.clearGuidance\(\)/);
  });

  test('every request builds a FRESH envelope from current state', () => {
    const c = read('packages', 'tablet-app-core', 'src', 'controller.ts');
    const req = c.slice(c.indexOf('async requestFoodGuidance'),
      c.indexOf('async chooseGuidanceCandidate'));
    // Dashboard is refreshed and candidates re-fetched inside the request, so
    // stale nutrition from a previous answer cannot be reused.
    assert.match(req, /await this\.refreshDashboard\(\)/);
    assert.match(req, /await deps\.eligibleCandidates\(\)/);
    assert.equal(/this\.activeEnvelope\s*\?\?/.test(req), false,
      'a cached envelope must never be reused');
  });

  test('the host re-reads candidates on every request', () => {
    const host = read('apps', 'tablet', 'src', 'development-host.ts');
    assert.match(host, /eligibleCandidates: async/);
    assert.match(host, /await repositories\.products\.listSearchable\(\)/);
  });
});

describe('AI-0 — member, session and stale-async safety', () => {
  const controller = () => read('packages', 'tablet-app-core', 'src', 'controller.ts');

  test('a member switch clears guidance entirely', () => {
    const c = controller();
    const sw = c.slice(c.indexOf('async switchActiveUser'));
    assert.match(sw, /this\.clearGuidance\(\)/);
    assert.match(sw, /guidance: IDLE_GUIDANCE/);
  });

  test('a result returning after a switch is discarded', () => {
    const c = controller();
    // Checked BOTH before and after the provider await.
    const req = c.slice(c.indexOf('async requestFoodGuidance'),
      c.indexOf('async chooseGuidanceCandidate'));
    const guards = req.match(/sessionGeneration !== this\.state\.sessionGeneration/g) ?? [];
    assert.ok(guards.length >= 2, 'the session guard must run after the provider await');
  });

  test('an older request cannot overwrite a newer one', () => {
    const c = controller();
    const req = c.slice(c.indexOf('async requestFoodGuidance'),
      c.indexOf('async chooseGuidanceCandidate'));
    const guards = req.match(/generation !== this\.guidanceGeneration/g) ?? [];
    assert.ok(guards.length >= 2);
    // The established repository pattern, not a new concurrency model.
    assert.match(c, /Only the NEWEST guidance request may update guidance state/);
  });

  test('the locked view exposes no guidance', () => {
    const vm = read('packages', 'tablet-view-model', 'src', 'view-model.ts');
    assert.match(vm, /Locked state carries no guidance/);
  });
});

describe('AI-0 — provider unavailable', () => {
  test('an unavailable provider still yields safe deterministic guidance', async () => {
    const provider = new UnavailableGuidanceProvider();
    await assert.rejects(() => provider.generate());
    // The orchestrator's fallback path is proven in the guidance suite; here we
    // assert the host can construct either provider without special casing.
    assert.equal(typeof new FakeGuidanceProvider().generate, 'function');
  });

  test('no provider internals can reach the renderer', () => {
    const vm = read('packages', 'tablet-view-model', 'src', 'view-model.ts');
    const block = vm.slice(vm.indexOf('export interface GuidanceView'),
      vm.indexOf('export interface TabletViewModel'));
    assert.equal(/error|stack|providerName/.test(block), false);
  });

  test('the development host uses the FAKE provider only', () => {
    const host = read('apps', 'tablet', 'src', 'development-host.ts');
    assert.match(host, /new FakeGuidanceProvider\(\)/);
    for (const banned of ['openai', 'anthropic', 'apiKey', 'https://']) {
      assert.equal(host.toLowerCase().includes(banned), false, `host references ${banned}`);
    }
    void DEFAULT_RECOMMENDATION_POLICY;
  });
});

describe('AI-0 — portability guard scoping', () => {
  test('generated Android output is ignored', () => {
    for (const p of ['apps/tablet/android/app/.cxx/debug/x.json',
                     'apps/tablet/android/app/build/generated/y.ts',
                     'apps/tablet/android/build/z.cmake']) {
      assert.equal(isGeneratedAndroidOutput(repoPath(...p.split('/'))), true,
        `${p} should be treated as generated`);
    }
  });

  test('real Android source and config are STILL scanned', () => {
    // A blanket exclusion of apps/tablet/android would have hidden these.
    for (const p of ['apps/tablet/android/app/src/main/AndroidManifest.xml',
                     'apps/tablet/android/app/src/main/java/Main.java',
                     'apps/tablet/android/settings.gradle',
                     'apps/tablet/metro.config.js']) {
      assert.equal(isGeneratedAndroidOutput(repoPath(...p.split('/'))), false,
        `${p} must remain protected`);
    }
  });

  test('nothing outside the tablet android tree is excluded', () => {
    assert.equal(isGeneratedAndroidOutput(repoPath('packages', 'build', 'x.ts')), false);
    assert.equal(isGeneratedAndroidOutput(repoPath('tools', '.cxx', 'y.ts')), false);
  });

  test('the scanner still walks real source', () => {
    // The comment explains why a blanket rule was rejected; the CODE must not
    // implement one.
    const scanner = strip(read('tools', 'check-portability.ts'));
    assert.equal(/apps\/tablet\/android\/\*\*/.test(scanner), false,
      'the exclusion must not be a blanket android rule');
    // It matches the prefix then requires a generated segment — not the tree.
    assert.match(scanner, /rel\.split\('\/'\)\.some/);
    assert.match(scanner, /GENERATED_BUILD_DIRS/);
  });
});

describe('AI-0 — frozen domains unchanged', () => {
  test('the recommendation winner baseline is untouched', () => {
    const before = JSON.parse(read('data', 'recommendation-winners-baseline.json'));
    const after = JSON.parse(read('data', 'recommendation-winners.json'));
    const changed = Object.keys(before).filter((k) => before[k] !== after[k]);
    assert.deepEqual(changed, []);
  });

  test('guidance safety contracts still hold', () => {
    const contracts = read('packages', 'guidance', 'src', 'contracts.ts');
    const block = contracts.slice(contracts.indexOf('export interface GuidanceProviderResult'),
      contracts.indexOf('export type GuidanceNextAction'));
    assert.equal(/readonly text\s*[?]?:\s*string/.test(block), false,
      'the provider must still have no free-text field');
  });

  test('no component performs nutrition arithmetic', () => {
    const dir = repoPath('apps', 'tablet', 'src', 'components');
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) continue;
      const code = strip(readFileSync(p, 'utf8'));
      for (const q of ['kcal', 'proteinG', 'fatG']) {
        assert.equal(new RegExp(`\\b${q}\\b\\s*[*/+-]\\s*\\w`).test(code), false,
          `${f} computes ${q}`);
      }
    }
  });
});
