import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  AnthropicGuidanceProvider, GuidanceProviderSettings, createAnthropicFetchTransport,
  createServerGuidanceProvider, decodeToolInput,
} from '@macros/guidance-anthropic';
import {
  createFetchTransport, createTabletGuidanceProvider,
} from '@macros/guidance-remote';
import {
  DEFAULT_ADMISSION_POLICY, GuidanceAdmissionGuard,
} from '@macros/runtime-api';
import { FakeGuidanceProvider } from '@macros/guidance';
import { repoPath } from '../tools/repo-paths.js';

const read = (...p: string[]): string => readFileSync(repoPath(...p), 'utf8');
const FAKE_KEY = 'sk-test-DO-NOT-LEAK-123';

const decision = {
  intent: 'what_should_i_eat', templateId: 'single_option',
  selectedProductVersionIds: ['chicken@v1'],
  clarificationNeeded: false, suggestedNextAction: 'await_weight',
};

describe('AI-1 FINAL — the Anthropic tool input is really decoded', () => {
  test('a valid decision decodes', () => {
    assert.notEqual(decodeToolInput(decision), null);
  });

  test('an unknown template is refused', () => {
    assert.equal(decodeToolInput({ ...decision, templateId: 'freestyle' }), null);
  });

  test('an unknown intent is refused', () => {
    assert.equal(decodeToolInput({ ...decision, intent: 'chat' }), null);
  });

  test('an unknown next action is refused', () => {
    assert.equal(decodeToolInput({ ...decision, suggestedNextAction: 'order' }), null);
  });

  test('an unknown tone is refused', () => {
    assert.equal(decodeToolInput({ ...decision, tone: 'sarcastic' }), null);
  });

  test('a missing required field is refused', () => {
    const { clarificationNeeded: _drop, ...missing } = decision;
    assert.equal(decodeToolInput(missing), null);
  });

  test('an unknown field is refused', () => {
    assert.equal(decodeToolInput({ ...decision, freeText: 'Pizza is better.' }), null);
  });

  test('wrong types are refused', () => {
    assert.equal(decodeToolInput({ ...decision, clarificationNeeded: 'yes' }), null);
    assert.equal(decodeToolInput({ ...decision, selectedProductVersionIds: 'chicken@v1' }), null);
    assert.equal(decodeToolInput({ ...decision, selectedProductVersionIds: [42] }), null);
  });

  test('excessive arrays and ids are refused', () => {
    assert.equal(decodeToolInput({
      ...decision, selectedProductVersionIds: ['a', 'b', 'c', 'd', 'e'],
    }), null);
    assert.equal(decodeToolInput({
      ...decision, selectedProductVersionIds: ['x'.repeat(500)],
    }), null);
  });

  test('an out-of-range objectiveIndex is refused', () => {
    assert.equal(decodeToolInput({ ...decision, objectiveIndex: 99 }), null);
    assert.equal(decodeToolInput({ ...decision, objectiveIndex: 1.5 }), null);
    assert.equal(decodeToolInput({ ...decision, objectiveIndex: -1 }), null);
  });

  test('the adapter itself rejects a malformed tool input', async () => {
    // Reaches the decoder: transport and JSON parsing both succeed.
    const provider = new AnthropicGuidanceProvider({
      apiKey: FAKE_KEY, model: 'fake', baseUrl: 'https://provider.invalid',
      transport: { send: async () => ({
        status: 200,
        body: JSON.stringify({ content: [{ type: 'tool_use',
          name: 'submit_guidance_decision',
          input: { ...decision, templateId: 'freestyle' } }] }),
      }) },
    });
    await assert.rejects(() => provider.generate({
      envelope: {} as never, intent: 'what_should_i_eat', recentTurns: [],
    } as never), /provider_malformed/);
  });

  test('production output is decoded, never cast', () => {
    const code = read('packages', 'guidance-anthropic', 'src', 'index.ts')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.equal(/as GuidanceProviderResult|as unknown as|as never|@ts-ignore/.test(code), false);
    assert.match(code, /decodeToolInput\(decisions\[0\]!\.input\)/);
  });
});

describe('AI-1 FINAL — timeouts actually cancel', () => {
  const hangingFetch = (aborted: { value: boolean }) =>
    (_url: string, init: { signal: AbortSignal }) =>
      new Promise<never>((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          aborted.value = true;
          reject(new Error('aborted'));
        });
      });

  test('the tablet transport aborts on timeout', async () => {
    const aborted = { value: false };
    const transport = createFetchTransport(hangingFetch(aborted) as never);
    await assert.rejects(() => transport.send({
      url: 'http://example.invalid', method: 'POST', headers: {},
      body: '{}', timeoutMs: 20,
    }));
    assert.equal(aborted.value, true, 'the signal must actually abort the request');
  });

  test('the server transport aborts on timeout', async () => {
    const aborted = { value: false };
    const transport = createAnthropicFetchTransport(hangingFetch(aborted) as never);
    await assert.rejects(() => transport.send({
      url: 'http://example.invalid', method: 'POST', headers: {},
      body: '{}', timeoutMs: 20,
    }));
    // A vendor call that runs on after the appliance gave up is still billed.
    assert.equal(aborted.value, true);
  });

  test('the transports use AbortController, not a bare timer', () => {
    for (const [pkg] of [['guidance-remote'], ['guidance-anthropic']] as const) {
      const code = read('packages', pkg, 'src', 'fetch-transport.ts');
      assert.match(code, /new AbortController\(\)/);
      assert.match(code, /signal: controller\.signal/);
      assert.match(code, /controller\.abort\(\)/);
      assert.match(code, /clearTimeout\(timer\)/);
    }
  });

  test('the server transport logs nothing', () => {
    const code = read('packages', 'guidance-anthropic', 'src', 'fetch-transport.ts');
    assert.equal(/console\.|logger|log\(/.test(code), false,
      'a transport that logs is how a key escapes');
  });
});

describe('AI-1 FINAL — composition is configuration, not code', () => {
  const fetchStub = (async () => ({ status: 200, text: async () => '{}' })) as never;

  test('synthetic gives the fake provider', () => {
    const p = createTabletGuidanceProvider({
      config: { assistant: 'synthetic' },
      bearerToken: () => 'token', fetchImpl: fetchStub,
    });
    assert.ok(p instanceof FakeGuidanceProvider);
  });

  test('real gives the remote provider', () => {
    const p = createTabletGuidanceProvider({
      config: { assistant: 'real', apiBaseUrl: 'https://api.macros.invalid' },
      bearerToken: () => 'token', fetchImpl: fetchStub,
    });
    assert.equal(p.name, 'macros-backend');
  });

  test('real without a backend URL fails closed', () => {
    assert.throws(() => createTabletGuidanceProvider({
      config: { assistant: 'real' }, bearerToken: () => 't', fetchImpl: fetchStub,
    }), /missing_api_base_url/);
  });

  test('the server factory returns null for synthetic', () => {
    assert.equal(createServerGuidanceProvider({
      config: { assistant: 'synthetic' }, fetchImpl: fetchStub,
    }), null);
  });

  test('the server factory fails closed without a key or model', () => {
    assert.throws(() => createServerGuidanceProvider({
      config: { assistant: 'real' }, fetchImpl: fetchStub,
    }), /missing_provider_settings/);
    assert.throws(() => createServerGuidanceProvider({
      config: { assistant: 'real' },
      providerSettings: { apiKey: '', model: 'm' } as GuidanceProviderSettings,
      fetchImpl: fetchStub,
    }), /missing_provider_settings/);
  });

  test('provider settings are separate from RuntimeConfig', () => {
    // RuntimeConfig is serialized into health and version output; a key living
    // there escapes eventually however carefully it is handled.
    const code = read('packages', 'guidance-anthropic', 'src', 'composition.ts');
    assert.match(code, /Never serialized, never logged, never part of RuntimeConfig/);
    const config = read('packages', 'runtime-config', 'src', 'config.ts');
    assert.match(config, /providerApiKey/, 'the tablet forbids provider secrets');
  });

  test('route registration is an explicit server-edge helper', () => {
    const route = read('packages', 'runtime-api', 'src', 'guidance-route.ts');
    assert.match(route, /export function registerGuidanceRoute/);
  });
});

describe('AI-1 FINAL — the server admission guard', () => {
  const guard = (now: () => number) => new GuidanceAdmissionGuard(now, {
    ...DEFAULT_ADMISSION_POLICY, maxRequestsPerWindow: 3, windowMs: 1000,
  });

  test('one concurrent provider call per subject', () => {
    const g = guard(() => 0);
    const first = g.admit('u1');
    assert.equal(first.admitted, true);
    const second = g.admit('u1');
    assert.equal(second.admitted, false);
    assert.equal(second.admitted === false && second.reason, 'in_flight');
  });

  test('releasing frees the slot', () => {
    const g = guard(() => 0);
    const first = g.admit('u1');
    assert.equal(first.admitted, true);
    if (first.admitted) first.release();
    assert.equal(g.admit('u1').admitted, true);
  });

  test('release is idempotent', () => {
    const g = guard(() => 0);
    const a = g.admit('u1');
    if (a.admitted) { a.release(); a.release(); }
    assert.equal(g.admit('u1').admitted, true);
    // A double release must not open a slot that was never taken.
    assert.equal(g.admit('u1').admitted, false);
  });

  test('quota is enforced within the window', () => {
    let t = 0;
    const g = guard(() => t);
    for (let i = 0; i < 3; i += 1) {
      const d = g.admit('u1');
      assert.equal(d.admitted, true);
      if (d.admitted) d.release();
    }
    const refused = g.admit('u1');
    assert.equal(refused.admitted, false);
    assert.equal(refused.admitted === false && refused.reason, 'quota_exceeded');

    t = 1500;
    assert.equal(g.admit('u1').admitted, true, 'a new window resets the count');
  });

  test('subjects are isolated', () => {
    const g = guard(() => 0);
    assert.equal(g.admit('u1').admitted, true);
    assert.equal(g.admit('u2').admitted, true, 'one member must not block another');
  });

  test('memory is bounded by eviction', () => {
    let t = 0;
    const g = guard(() => t);
    const d = g.admit('u1');
    if (d.admitted) d.release();
    assert.equal(g.trackedSubjects(), 1);
    t = 10_000_000;
    g.admit('u2');
    assert.equal(g.trackedSubjects(), 1, 'the idle subject was evicted');
  });

  test('the guard is checked BEFORE the provider', () => {
    const route = read('packages', 'runtime-api', 'src', 'guidance-route.ts');
    const admitIndex = route.indexOf('deps.admission?.admit');
    const generateIndex = route.indexOf('deps.provider.generate');
    assert.ok(admitIndex > 0 && admitIndex < generateIndex,
      'a refused request must cost nothing');
  });

  test('the process-local limitation is documented, not glossed', () => {
    const code = read('packages', 'runtime-api', 'src', 'guidance-admission.ts');
    assert.match(code, /PROCESS-LOCAL/);
    assert.match(code, /NOT multi-instance safe/);
  });
});

describe('AI-1 FINAL — a double tap costs once', () => {
  /**
   * Counts REAL provider invocations. The previous test only inspected
   * generation guards, which stop a stale result from landing but do nothing
   * to stop a second billable call from being made.
   */
  class CountingProvider {
    readonly name = 'counting';
    calls = 0;
    constructor(private readonly delayMs: number) {}
    async generate(): Promise<never> {
      this.calls += 1;
      await new Promise((r) => { setTimeout(r, this.delayMs); });
      throw new Error('provider_unavailable_for_test');
    }
  }

  const controllerFor = async (provider: CountingProvider) => {
    const { TabletAppController } = await import('@macros/tablet-app-core');
    const { mintSubjectForTests } = await import('@macros/domain-auth');
    const { appSubjectFrom } = await import('@macros/tablet-app-core');
    const {
      InMemoryEnergyGoalRepository, InMemoryFoodLogRepository,
      InMemoryProductVersionRepository, InMemoryUserProfileRepository,
    } = await import('@macros/persistence');
    const {
      PROFILE_MALE_35, SYNTHETIC_CATALOG_HEADS, SYNTHETIC_PRODUCTS,
      SYNTHETIC_STABILITY_POLICY, TEST_TEF_POLICY, USER_A, activeEnergy,
    } = await import('@macros/testkit');
    const { DEFAULT_RECOMMENDATION_POLICY } = await import('@macros/domain-recommendation');

    const repositories = {
      foodLogs: new InMemoryFoodLogRepository(),
      products: new InMemoryProductVersionRepository(
        SYNTHETIC_PRODUCTS, SYNTHETIC_CATALOG_HEADS),
      profiles: new InMemoryUserProfileRepository(),
      goals: new InMemoryEnergyGoalRepository(),
    };
    await repositories.profiles.append(PROFILE_MALE_35);
    // A goal is REQUIRED for a dashboard, and requestFoodGuidance returns early
    // without one — so the provider would never be reached and the test would
    // pass vacuously at zero calls.
    await repositories.goals.append({
      goalVersionId: 'goal-v1', userId: USER_A,
      effectiveFrom: '2026-01-01T00:00:00.000Z',
      goal: 'maintain', targetDeltaKcal: 0,
    } as never);

    const controller = new TabletAppController(
      {
        repositories,
        clock: { now: () => new Date().toISOString() },
        ids: { next: () => `00000000-0000-4000-8000-${String(Date.now()).slice(-12)}` },
        policies: { tefPolicy: { status: 'available', policy: TEST_TEF_POLICY } },
        stabilityPolicy: SYNTHETIC_STABILITY_POLICY,
        timezone: 'America/Chicago',
      } as never,
      appSubjectFrom(mintSubjectForTests(USER_A, { displayName: 'Demo' })),
      activeEnergy(420),
    );

    const deps = {
      provider: provider as never,
      eligibleCandidates: async () => [],
      nowIso: () => new Date().toISOString(),
      policy: DEFAULT_RECOMMENDATION_POLICY,
      environment: 'test' as const,
    };
    return { controller, deps };
  };

  test('two simultaneous taps produce exactly ONE provider call', async () => {
    const provider = new CountingProvider(40);
    const { controller, deps } = await controllerFor(provider);

    await Promise.all([
      controller.requestFoodGuidance(deps),
      controller.requestFoodGuidance(deps),
    ]);

    assert.equal(provider.calls, 1,
      `a double tap made ${provider.calls} provider calls — each one is billed`);
  });

  test('a later explicit tap DOES make a new call', async () => {
    const provider = new CountingProvider(10);
    const { controller, deps } = await controllerFor(provider);

    await Promise.all([
      controller.requestFoodGuidance(deps),
      controller.requestFoodGuidance(deps),
    ]);
    assert.equal(provider.calls, 1);

    // Coalescing must not become a permanent lock: the appliance still has to
    // answer when asked again.
    await controller.requestFoodGuidance(deps);
    assert.equal(provider.calls, 2);
  });

  test('coalescing is keyed to the session, not global', () => {
    const code = readFileSync(
      repoPath('packages', 'tablet-app-core', 'src', 'controller.ts'), 'utf8');
    assert.match(code, /outstanding\.sessionGeneration === this\.state\.sessionGeneration/);
    // A switch releases the slot so the new member is not served stale work.
    const clear = code.slice(code.indexOf('clearGuidance(): void'));
    assert.match(clear.slice(0, 500), /this\.inFlightGuidance = null/);
  });
});
