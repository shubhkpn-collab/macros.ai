import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DeterministicVoiceParser, type CorrelatedVoiceDelivery } from '@macros/domain-voice';
import { VoiceOrchestrator, buildRecommendations } from '@macros/voice-orchestration';
import { TOOL_REGISTRY, validateProposals } from '@macros/assistant-core';
import { TabletAppController, type AppEnvironment, type AppSubject } from '@macros/tablet-app-core';
import {
  InMemoryEnergyGoalRepository, InMemoryFoodLogRepository,
  InMemoryProductVersionRepository, InMemoryUserProfileRepository,
  type PersistedLoopRepositories,
} from '@macros/persistence';
import { instant, type EnergyGoalVersion, type Instant, type ProductCatalogHead, type ProductVersion } from '@macros/contracts';
import type { LoopPolicies } from '@macros/core-loop';
import type { AssistantInterpretationResult, AssistantInterpreter } from '@macros/assistant-core';
import type { RecommendationCandidate } from '@macros/domain-recommendation';
import {
  PROFILE_MALE_35, PROFILE_FEMALE_29, SYNTHETIC_BRANDED_HEADS, SYNTHETIC_BRANDED_PRODUCTS,
  SYNTHETIC_CATALOG_HEADS, SYNTHETIC_PRODUCTS, SYNTHETIC_STABILITY_POLICY,
  TEST_TEF_POLICY, USER_A, activeEnergy,
} from '@macros/testkit';

const TZ = 'America/Chicago';
const START = '2026-08-23T16:50:00.000Z';
const POLICIES: LoopPolicies = { tefPolicy: { status: 'available', policy: TEST_TEF_POLICY } };
const ALL = [...SYNTHETIC_PRODUCTS, ...SYNTHETIC_BRANDED_PRODUCTS];
const HEADS: ProductCatalogHead[] = [...SYNTHETIC_CATALOG_HEADS, ...SYNTHETIC_BRANDED_HEADS];
const CANDIDATES: RecommendationCandidate[] = ALL
  .filter((v) => HEADS.some((h) => h.currentProductVersionId === v.productVersionId && h.isActive))
  .map((v: ProductVersion) => ({
    productVersion: v,
    head: HEADS.find((h) => h.currentProductVersionId === v.productVersionId)!,
  }));

class FixedClock {
  private ms = Date.parse(START);
  now(): Instant { return instant(new Date(this.ms).toISOString()); }
  advance(ms: number): void { this.ms += ms; }
}
class SequenceIds {
  private n = 0;
  next(): string { this.n += 1; return `00000000-0000-4000-8000-${String(this.n).padStart(12, '0')}`; }
}
const subjectFor = (u: string, n: string): AppSubject => ({ authenticatedSubjectId: u, userId: u, displayName: n });
const goalFor = (u: string, id: string, d: number): EnergyGoalVersion => ({
  goalVersionId: id, userId: u, effectiveFrom: instant('2026-01-01T00:00:00.000Z'),
  goal: d > 0 ? 'gain' : d < 0 ? 'lose' : 'maintain', targetDeltaKcal: d,
});

async function harness(interpreter: AssistantInterpreter | null = null) {
  const repos: PersistedLoopRepositories = {
    foodLogs: new InMemoryFoodLogRepository(),
    products: new InMemoryProductVersionRepository(ALL, HEADS),
    profiles: new InMemoryUserProfileRepository(),
    goals: new InMemoryEnergyGoalRepository(),
  };
  await repos.profiles.append(PROFILE_MALE_35);
  await repos.profiles.append(PROFILE_FEMALE_29);
  await repos.goals.append(goalFor(USER_A, 'ga', 250));
  const env: AppEnvironment = {
    repositories: repos, clock: new FixedClock(), ids: new SequenceIds(),
    policies: POLICIES, stabilityPolicy: SYNTHETIC_STABILITY_POLICY, timezone: TZ,
  };
  const app = new TabletAppController(env, subjectFor(USER_A, 'Dev A'), activeEnergy(500));
  await app.refreshDashboard();

  const provider = () => {
    const d = app.getState().dashboard;
    return buildRecommendations({
      userId: USER_A,
      nowIso: START,
      energy: d?.energy ?? null,
      macros: d?.macros ?? null,
      candidates: CANDIDATES,
      effectiveLogs: [],
      preferences: null,
      environment: 'test',
    });
  };

  return {
    app, repos,
    voice: new VoiceOrchestrator(app, new DeterministicVoiceParser(), interpreter, provider),
  };
}
type H = Awaited<ReturnType<typeof harness>>;

let seq = 0;
const speak = (h: H, transcript: string) => {
  seq += 1;
  return h.voice.handle({
    transcript,
    receivedAt: instant(new Date(Date.parse(START) + seq * 1000).toISOString()),
    userId: USER_A,
    utteranceId: `r-${seq}`,
    sessionGeneration: h.app.getState().sessionGeneration,
    turnSequence: seq,
    flowIdAtCapture: h.app.getState().addFood.flowId,
  } as CorrelatedVoiceDelivery);
};
const logsOf = async (h: H) =>
  h.repos.foodLogs.listByLocalDate(USER_A, h.app.getState().dashboard!.localDate);

// ---------------------------------------------------------------------------

describe('B38 — golden "what should I eat?" flow', () => {
  test('the deterministic parser recognises the request offline', async () => {
    const h = await harness(null);
    const r = await speak(h, 'what should I eat');
    assert.equal(r.kind, 'options');
    assert.equal(h.voice.lastTrace().path, 'deterministic', 'no cloud model needed');
  });

  test('recommendations are returned WITHOUT selecting anything', async () => {
    const h = await harness(null);
    const r = await speak(h, 'what should I eat');
    assert.equal(r.kind, 'options');
    if (r.kind !== 'options') return;
    assert.ok(r.options.length > 0);
    assert.equal(h.app.getState().addFood.selected, null, 'nothing auto-selected');
    assert.equal((await logsOf(h)).length, 0, 'nothing auto-logged');
  });

  test('the assistant fallback can route a natural request', async () => {
    const interpreter: AssistantInterpreter = {
      providerKind: 'fake', modelVersion: '1',
      interpret: (): Promise<AssistantInterpretationResult> =>
        Promise.resolve({ status: 'proposed', proposals: [{ intentKind: 'recommend_food' }] }),
    };
    const h = await harness(interpreter);
    const r = await speak(h, 'i have no idea what to make right now');
    assert.equal(r.kind, 'options');
    assert.equal(h.voice.lastTrace().path, 'assistant_fallback');
    assert.equal(h.voice.lastTrace().validation, 'accepted');
  });

  test('spoken portions are grounded, never invented', async () => {
    const h = await harness(null);
    const r = await speak(h, 'what should I eat');
    assert.equal(r.kind, 'options');
    if (r.kind !== 'options') return;
    // Any spoken gram figure must be a plausible grounded portion, never a
    // remaining-calories-divided-by-density number.
    for (const match of r.speech.matchAll(/(\d+) grams/g)) {
      const g = Number(match[1]);
      assert.ok(g > 0 && g <= 500, `spoken portion ${g} g must stay grounded`);
    }
  });

  test('recommendations are a read-only step before the normal flow', async () => {
    const h = await harness(null);
    await speak(h, 'what should I eat');
    // The existing selection flow is unchanged from here.
    assert.equal(h.app.getState().addFood.phase, 'idle');
    assert.equal((await logsOf(h)).length, 0);
  });
});

describe('B37 — the model cannot influence recommendations', () => {
  test('recommend_food is registered as READ-ONLY with no arguments', () => {
    const spec = TOOL_REGISTRY['recommend_food'];
    assert.equal(spec.stateChanging, false);
    assert.deepEqual(spec.allowedArguments, []);
  });

  const baseInput = {
    transcript: 'what should i eat',
    appPhase: 'idle',
    optionLabels: [] as string[],
    optionDisplayNames: [] as string[],
    selectedDisplayName: null,
    hasWeightCapture: false,
    allowedActions: ['recommend_food'] as never,
  };

  const rejected: readonly [string, Record<string, unknown>][] = [
    ['a candidate product id', { productVersionId: 'synb-oats-old-fashioned@v1' }],
    ['a score', { score: 0.99 }],
    ['nutrition', { calories: 400 }],
    ['a quantity', { grams: 250 }],
    ['a food name to force', { food: 'almonds' }],
  ];

  for (const [name, args] of rejected) {
    test(`the model supplying ${name} is rejected`, () => {
      const v = validateProposals([{ intentKind: 'recommend_food', arguments: args }], { input: baseInput });
      assert.equal(v.status, 'rejected');
    });
  }

  test('a bare recommend_food proposal is accepted', () => {
    const v = validateProposals([{ intentKind: 'recommend_food' }], { input: baseInput });
    assert.equal(v.status, 'accepted');
  });
});

describe('B19 — voice respects an exhausted budget', () => {
  test('a reached target is stated rather than pushing more food', async () => {
    const h = await harness(null);
    // Force an exhausted budget through the trusted provider.
    const voice = new VoiceOrchestrator(
      h.app, new DeterministicVoiceParser(), null,
      () => buildRecommendations({
        userId: USER_A, nowIso: START,
        energy: { ...h.app.getState().dashboard!.energy, remainingIntakeKcal: 0 as never },
        macros: h.app.getState().dashboard!.macros,
        candidates: CANDIDATES, effectiveLogs: [], preferences: null, environment: 'test',
      }),
    );
    const r = await voice.handle({
      transcript: 'what should I eat',
      receivedAt: instant(START), userId: USER_A, utteranceId: 'x-1',
      sessionGeneration: h.app.getState().sessionGeneration, turnSequence: 1,
      flowIdAtCapture: h.app.getState().addFood.flowId,
    } as CorrelatedVoiceDelivery);

    assert.equal(r.kind, 'informational');
    assert.match(r.speech, /target/i);
    assert.equal(h.app.getState().addFood.selected, null);
  });
});
