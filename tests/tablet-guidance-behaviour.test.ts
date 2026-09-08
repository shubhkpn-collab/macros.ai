import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  DEFAULT_RECOMMENDATION_POLICY, type RecommendationCandidate,
} from '@macros/domain-recommendation';
import { FakeGuidanceProvider, type GuidanceProvider } from '@macros/guidance';
import { buildViewModel, lockedViewModel } from '@macros/tablet-view-model';
import { repoPath } from '../tools/repo-paths.js';

const read = (...p: string[]): string => readFileSync(repoPath(...p), 'utf8');

/**
 * Behavioural coverage of the guidance lifecycle using the real controller
 * pieces where they can run here, and the real state shapes throughout.
 */
const candidate = (id: string, name: string): RecommendationCandidate => ({
  productVersion: {
    productId: id, productVersionId: `${id}@v1`, versionNo: 1, displayName: name,
    preparationState: 'cooked',
    basis: { kind: 'per_100g', kcal: 165, proteinG: 31, carbohydrateG: 0, fatG: 3.6 },
    source: { kind: 'usda_generic', sourceId: id, verificationStatus: 'published' },
    effectiveFrom: '2026-01-01T00:00:00.000Z',
    category: 'Poultry Products', sourceDescription: name,
  } as never,
  head: {
    productId: id, currentProductVersionId: `${id}@v1`, isActive: true,
    updatedAt: '2026-01-01T00:00:00.000Z',
  } as never,
});

const guidanceState = (over: Record<string, unknown> = {}) => ({
  phase: 'guidance_available', text: 'A fits your needs best.',
  candidates: [{ productId: 'a', productVersionId: 'a@v1', displayName: 'A', role: 'protein_forward' }],
  alternatives: [
    { productId: 'b', productVersionId: 'b@v1', displayName: 'B', role: 'carbohydrate_forward' },
    { productId: 'c', productVersionId: 'c@v1', displayName: 'C', role: 'balanced' },
  ],
  envelopeId: 'env-1', sessionGeneration: 1, usedFallback: false,
  ...over,
});

const appState = (over: Record<string, unknown> = {}) => ({
  subject: { authenticatedSubjectId: 'u', userId: 'u', displayName: 'Demo', sessionId: 's1' },
  requiresScaleClearForCurrentSubject: false,
  sessionGeneration: 1,
  guidance: guidanceState(),
  dashboard: {
    localDate: '2026-08-29',
    intake: { kcal: 1200, proteinG: 90, carbohydrateG: 120, fatG: 40 },
    macros: {
      targets: { targetKcal: 2400, proteinG: 160, carbohydrateG: 250, fatG: 80,
        policyVersion: 'p', policyReviewStatus: 'reviewed' },
      consumedKcal: 1200, consumedProteinG: 90, consumedCarbohydrateG: 120, consumedFatG: 40,
      remainingKcal: 1200, remainingProteinG: 70, remainingCarbohydrateG: 130,
      remainingFatG: 40, calcVersion: 'v',
    },
    guardrails: {},
    energy: { currentBalanceKcal: -327, ifNoMoreFoodBalanceKcal: -800 },
    energyIncomplete: false, energyGaps: [], activitySource: 'wearable',
    developmentDataNotice: null,
  },
  addFood: {
    phase: 'idle', flowId: 'f1', query: '', results: [], selected: null,
    weightCapture: null, preview: null, captureRequestId: null, submissionId: null,
    outcome: null, error: null,
  },
  scale: { connected: false, phase: 'idle', displayGrams: null,
    stableCandidateGrams: null, message: 'Scale not connected' },
  activity: {},
  ...over,
}) as never;

const vmFor = (app: unknown) => buildViewModel({
  app: app as never,
  capabilities: { foodLogging: { status: 'available', reason: null },
    catalogSearch: { status: 'available' }, pendingSubmissions: 0 } as never,
  switchState: { phase: 'active', attempt: null } as never,
  recent: [],
});

describe('AI-0B — alternatives survive to the renderer', () => {
  test('the view model projects alternatives, bounded', () => {
    const vm = vmFor(appState());
    assert.equal(vm.guidance.alternatives.length, 2);
    assert.equal(vm.guidance.alternatives[0]?.displayName, 'B');
  });

  test('alternatives are capped so the surface cannot become a list', () => {
    const many = Array.from({ length: 8 }, (_, i) => ({
      productId: `x${i}`, productVersionId: `x${i}@v1`, displayName: `X${i}`, role: 'balanced',
    }));
    const vm = vmFor(appState({ guidance: guidanceState({ alternatives: many }) }));
    assert.equal(vm.guidance.alternatives.length, 3);
  });

  test('the locked view exposes no alternatives', () => {
    assert.deepEqual(lockedViewModel().guidance.alternatives, []);
  });

  test('an alternative uses the SAME validated choice intent', () => {
    // The premium Home renders candidates and alternatives through ONE card
    // list, so a single call site now serves both. That is a stronger
    // guarantee than two identical ones: there is no second path to drift.
    const screens = read('apps', 'tablet', 'src', 'components', 'screens.tsx');
    assert.match(screens, /\[\.\.\.guidance\.candidates, \.\.\.guidance\.alternatives\]/);
    assert.match(screens, /actions\.onChooseGuidanceCandidate\(/);
    assert.equal(/selectProduct\(|searchFood\(/.test(screens), false,
      'no second selection path may exist');
  });
});

describe('AI-0B — awaiting-weight guidance reaches the weighing screen', () => {
  test('the weighing screen renders vm.guidance.text', () => {
    const screens = read('apps', 'tablet', 'src', 'components', 'screens.tsx');
    const weighing = screens.slice(screens.indexOf('export function WeighingScreen'),
      screens.indexOf('export function ReviewScreen'));
    assert.match(weighing, /vm\.guidance\.phase === 'awaiting_weight'/);
    assert.match(weighing, /\{vm\.guidance\.text\}/);
  });

  test('React does not author the wording', () => {
    const screens = read('apps', 'tablet', 'src', 'components', 'screens.tsx');
    // The sentence lives in the guidance templates, not in a component.
    assert.equal(screens.includes('Put it on the scale when'), false,
      'wording must be rendered, never duplicated in React');
  });

  test('the view model carries the text through to the weighing screen', () => {
    const vm = vmFor(appState({
      guidance: guidanceState({
        phase: 'awaiting_weight', text: "Put it on the scale when you're ready.",
      }),
      addFood: { phase: 'waiting_for_weight', flowId: 'f1', query: '', results: [],
        selected: { productVersionId: 'a@v1', displayName: 'A', preparationState: 'cooked' },
        weightCapture: null, preview: null, captureRequestId: null,
        submissionId: null, outcome: null, error: null },
    }));
    assert.equal(vm.screen, 'weighing');
    assert.equal(vm.guidance.phase, 'awaiting_weight');
    assert.match(vm.guidance.text, /scale/i);
  });
});

describe('AI-0B — a successful log invalidates guidance immediately', () => {
  const controller = () => read('packages', 'tablet-app-core', 'src', 'controller.ts');

  test('clearGuidance runs at the moment the log succeeds', () => {
    const c = controller();
    const log = c.slice(c.indexOf('async confirmFoodLog'), c.indexOf('cancelFoodFlow()'));
    assert.match(log, /this\.clearGuidance\(\)/);
    assert.match(log, /INVALIDATE GUIDANCE AT THE MOMENT THE LOG SUCCEEDS/);
  });

  test('the completed log state and the refreshed dashboard survive', () => {
    const c = controller();
    const log = c.slice(c.indexOf('async confirmFoodLog'), c.indexOf('cancelFoodFlow()'));
    assert.match(log, /phase: 'completed'/);
    // clearGuidance only touches guidance, so the log outcome is untouched.
    const clear = c.slice(c.indexOf('clearGuidance(): void'));
    assert.match(clear.slice(0, 400), /guidance: IDLE_GUIDANCE/);
    assert.equal(/addFood:/.test(clear.slice(0, 400)), false);
  });

  test('clearing nulls the envelope AND advances the generation', () => {
    const c = controller();
    const clear = c.slice(c.indexOf('clearGuidance(): void'), c.indexOf('private patchGuidance'));
    assert.match(clear, /this\.guidanceGeneration \+= 1/);
    assert.match(clear, /this\.activeEnvelope = null/);
  });

  test('an in-flight PRE-LOG request cannot land afterwards', () => {
    // The generation is re-checked after the provider await, and the log
    // advanced it — so a late result returns without patching state.
    const c = controller();
    const req = c.slice(c.indexOf('async requestFoodGuidance'),
      c.indexOf('async chooseGuidanceCandidate'));
    const guards = req.match(/generation !== this\.guidanceGeneration/g) ?? [];
    assert.ok(guards.length >= 2);
    assert.match(req, /return this\.state\.guidance;/);
  });

  test('an old candidate cannot be chosen after the log, before UI cancellation', () => {
    // activeEnvelope is null immediately, so the staleness check fires during
    // the presentation dwell rather than only after cancelFoodFlow.
    const c = controller();
    const choose = c.slice(c.indexOf('async chooseGuidanceCandidate'),
      c.indexOf('clearGuidance(): void'));
    assert.match(choose, /const stale = active === null/);
  });
});

describe('AI-0B — the typed guidance boundary', () => {
  test('no `as never` wraps the recommendation input', () => {
    const c = read('packages', 'tablet-app-core', 'src', 'controller.ts');
    // Comments may DISCUSS the cast that was removed; the code must not use it.
    const req = c.slice(c.indexOf('async requestFoodGuidance'),
      c.indexOf('async chooseGuidanceCandidate'))
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.equal(/as never/.test(req), false, 'the guidance input is type-erased again');
    assert.match(req, /const guidanceInput: RecommendationInput =/);
    assert.match(req, /buildGuidanceEnvelope\(guidanceInput, \{/);
  });

  test('the candidate contract is real, not unknown[]', () => {
    const c = read('packages', 'tablet-app-core', 'src', 'controller.ts')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.equal(/Promise<readonly unknown\[\]>/.test(c), false);
    assert.match(c, /eligibleCandidates\(\): Promise<readonly RecommendationCandidate\[\]>/);
    assert.equal(/readonly policy: unknown/.test(c), false);
    assert.match(c, /readonly policy: RecommendationPolicy/);
    assert.match(c, /readonly environment: RecommendationInput\['environment'\]/);
  });

  test('the host supplies genuinely typed dependencies', async () => {
    const host = read('apps', 'tablet', 'src', 'development-host.ts');
    assert.equal(/Promise<readonly unknown\[\]>/.test(host), false);
    // Types line up without a cast at the call site.
    const provider: GuidanceProvider = new FakeGuidanceProvider();
    assert.equal(typeof provider.generate, 'function');
    assert.equal(DEFAULT_RECOMMENDATION_POLICY.version, 'recommendation-policy@3.0.0');
    void candidate('a', 'A');
  });
});

describe('AI-0C — catalog QA rehydrates the authoritative ProductVersion', () => {
  const host = () => read('apps', 'tablet', 'src', 'development-host.ts');

  test('search results are rehydrated by productVersionId', () => {
    // resilientSearch exposes the NARROWER SearchableFood, which carries no
    // nutrient basis, source or effective date — so it cannot be handed to
    // toFoodCard, which is what the compiler caught.
    const code = host();
    assert.match(code, /const productVersionById = new Map\(/);
    assert.match(code, /searchable\.map\(\(version\) => \[version\.productVersionId, version\]\)/);
    assert.match(code,
      /productVersionById\.get\(result\.productVersion\.productVersionId\)/);
    assert.match(code, /toFoodCard\(fullVersion\)/);
  });

  test('the index is built once, not per result', () => {
    // O(n) construction, O(1) hydration — and no repository round-trip for
    // data already held in memory. Comments may DISCUSS getVersion; the code
    // must not call it.
    const code = host().replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const search = code.slice(code.indexOf('async search(query: string)'),
      code.indexOf('const guidance = {'));
    assert.equal((search.match(/new Map\(/g) ?? []).length, 1);
    assert.equal(/getVersion\(/.test(search), false,
      'a repository round-trip would refetch what is already loaded');
  });

  test('an unresolved id is omitted, never fabricated', () => {
    const code = host();
    const search = code.slice(code.indexOf('async search(query: string)'),
      code.indexOf('const guidance = {'));
    assert.match(search, /if \(fullVersion === undefined\) \{/);
    assert.match(search, /continue;/);
    // No placeholder nutrition may be invented for a QA surface whose purpose
    // is showing what the catalog really holds.
    assert.equal(/kcal:\s*0|basis:\s*\{/.test(search), false);
  });

  test('the fix uses no type-safety escape hatch', () => {
    const code = host();
    const search = code.slice(code.indexOf('async search(query: string)'),
      code.indexOf('const guidance = {'));
    for (const cheat of ['as ProductVersion', 'as unknown as ProductVersion',
                         '@ts-ignore', '@ts-expect-error', ': any']) {
      assert.equal(search.includes(cheat), false, `the fix uses ${cheat}`);
    }
  });

  test('the search contract itself is untouched', () => {
    const search = read('packages', 'domain-food-search', 'src', 'resilient-search.ts');
    // The defect belonged in the development-host projection, not the domain.
    assert.match(search, /export function resilientSearch\(/);
    assert.match(search, /readonly results: readonly FoodSearchResult\[\]/);
  });
});
