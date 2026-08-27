import { mintSubjectForTests } from '@macros/domain-auth';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  TOOL_REGISTRY, isKnownTool, shouldConsultAssistant, validateProposals,
  type AssistantInterpreter, type IntentProposal,
} from '@macros/assistant-core';
import { DeterministicVoiceParser, type VoiceUtterance } from '@macros/domain-voice';
import { VoiceOrchestrator } from '@macros/voice-orchestration';
import { TabletAppController, type AppEnvironment, type AppSubject, appSubjectFrom } from '@macros/tablet-app-core';
import {
  InMemoryEnergyGoalRepository, InMemoryFoodLogRepository,
  InMemoryProductVersionRepository, InMemoryUserProfileRepository,
  type PersistedLoopRepositories,
} from '@macros/persistence';
import { instant, type EnergyGoalVersion, type Instant } from '@macros/contracts';
import type { LoopPolicies } from '@macros/core-loop';
import {
  AdversarialAssistantInterpreter, FakeAssistantInterpreter, ThrowingAssistantInterpreter,
  PROFILE_MALE_35, PROFILE_FEMALE_29, SYNTHETIC_BRANDED_HEADS, SYNTHETIC_BRANDED_PRODUCTS,
  SYNTHETIC_CATALOG_HEADS, SYNTHETIC_PRODUCTS, SYNTHETIC_STABILITY_POLICY,
  TEST_TEF_POLICY, USER_A, USER_B, activeEnergy, approx,
} from '@macros/testkit';

const ROOT = new URL('..', import.meta.url).pathname;


/**
 * Stands in for household activation, which is the ONLY generation authority.
 * The controller no longer mints one, so tests must supply an authorized
 * session exactly as production does.
 */
let generationCounter = 1;
const nextGeneration = (): number => { generationCounter += 1; return generationCounter; };
const TZ = 'America/Chicago';
const START = '2026-08-21T16:50:00.000Z';
const POLICIES: LoopPolicies = { tefPolicy: { status: 'available', policy: TEST_TEF_POLICY } };

class FixedClock {
  private ms = Date.parse(START);
  now(): Instant { return instant(new Date(this.ms).toISOString()); }
  advance(ms: number): void { this.ms += ms; }
}
class SequenceIds {
  private n = 0;
  next(): string { this.n += 1; return `00000000-0000-4000-8000-${String(this.n).padStart(12, '0')}`; }
}
const subjectFor = (u: string, n: string): AppSubject =>
  appSubjectFrom(mintSubjectForTests(u, { displayName: n }));
const goalFor = (u: string, id: string, d: number): EnergyGoalVersion => ({
  goalVersionId: id, userId: u, effectiveFrom: instant('2026-01-01T00:00:00.000Z'),
  goal: d > 0 ? 'gain' : d < 0 ? 'lose' : 'maintain', targetDeltaKcal: d,
});

async function harness(interpreter: AssistantInterpreter | null = null) {
  const repos: PersistedLoopRepositories = {
    foodLogs: new InMemoryFoodLogRepository(),
    products: new InMemoryProductVersionRepository(
      [...SYNTHETIC_PRODUCTS, ...SYNTHETIC_BRANDED_PRODUCTS],
      [...SYNTHETIC_CATALOG_HEADS, ...SYNTHETIC_BRANDED_HEADS],
    ),
    profiles: new InMemoryUserProfileRepository(),
    goals: new InMemoryEnergyGoalRepository(),
  };
  await repos.profiles.append(PROFILE_MALE_35);
  await repos.profiles.append(PROFILE_FEMALE_29);
  await repos.goals.append(goalFor(USER_A, 'ga', 250));
  await repos.goals.append(goalFor(USER_B, 'gb', -400));
  const clock = new FixedClock();
  const env: AppEnvironment = {
    repositories: repos, clock, ids: new SequenceIds(), policies: POLICIES,
    stabilityPolicy: SYNTHETIC_STABILITY_POLICY, timezone: TZ,
  };
  const app = new TabletAppController(env, subjectFor(USER_A, 'Dev A'), activeEnergy(500));
  await app.refreshDashboard();
  return { app, voice: new VoiceOrchestrator(app, new DeterministicVoiceParser(), interpreter), repos };
}
type H = Awaited<ReturnType<typeof harness>>;

let seq = 0;
const speak = (h: H, transcript: string, userId = USER_A) => {
  seq += 1;
  return h.voice.handle({
    transcript,
    receivedAt: instant(new Date(Date.parse(START) + seq * 1000).toISOString()),
    userId,
    utteranceId: `a-${seq}`,
    sessionGeneration: h.app.getState().sessionGeneration,
    turnSequence: seq,
    flowIdAtCapture: h.app.getState().addFood.flowId,
  });
};
const logsOf = async (h: H, userId = USER_A) =>
  h.repos.foodLogs.listByLocalDate(userId, h.app.getState().dashboard!.localDate);

/** A hostile interpreter that always answers with one payload. */
const hostile = (proposals: readonly IntentProposal[]) =>
  new AdversarialAssistantInterpreter({ status: 'proposed', proposals });

const baseInput = {
  transcript: 'i am having chicken',
  appPhase: 'idle',
  optionLabels: ['A', 'B'],
  optionDisplayNames: ['Chicken breast, cooked', 'Chicken breast, raw'],
  selectedDisplayName: null,
  hasWeightCapture: false,
  allowedActions: [...Object.keys(TOOL_REGISTRY)] as never,
};

// ---------------------------------------------------------------------------

describe('B1 — deterministic fast path is never delegated', () => {
  test('known commands do not consult the interpreter', async () => {
    const fake = new FakeAssistantInterpreter([{ match: '', proposals: [{ intentKind: 'cancel' }] }]);
    const h = await harness(fake);
    await speak(h, 'add chicken breast');
    assert.equal(fake.lastInput, null, 'the model was never asked');
    assert.equal(h.voice.lastTrace().path, 'deterministic');
  });

  test('a deterministic safety refusal is never escalated to the model', () => {
    const parser = new DeterministicVoiceParser();
    const u = (t: string): VoiceUtterance =>
      ({ transcript: t, receivedAt: instant(START), userId: USER_A }) as VoiceUtterance;

    for (const transcript of ['-50 grams', '3 ounces', '0 grams', '']) {
      const decision = shouldConsultAssistant(parser.parse(u(transcript)));
      assert.equal(decision.use, false, transcript);
      if (!decision.use) assert.equal(decision.why, 'deterministic_refusal');
    }
  });

  test('structural ambiguity is clarified, not handed to a model', () => {
    const parser = new DeterministicVoiceParser();
    const parsed = parser.parse(
      { transcript: 'maybe option A or B', receivedAt: instant(START), userId: USER_A } as VoiceUtterance,
    );
    assert.equal(shouldConsultAssistant(parsed).use, false);
  });

  test('only unsupported phrasing reaches the interpreter', () => {
    const parser = new DeterministicVoiceParser();
    const parsed = parser.parse(
      { transcript: 'i reckon those oats again', receivedAt: instant(START), userId: USER_A } as VoiceUtterance,
    );
    assert.equal(parsed.status, 'unsupported');
    assert.equal(shouldConsultAssistant(parsed).use, true);
  });
});

describe('B21 — golden assistant flows', () => {
  test('FLOW 1: natural food search proposes a search and selects nothing', async () => {
    const fake = new FakeAssistantInterpreter([
      { match: 'oats again', proposals: [{ intentKind: 'search_food', arguments: { query: 'oats' } }] },
    ]);
    const h = await harness(fake);
    const r = await speak(h, "i'm gonna have some of those oats again");

    assert.equal(r.kind, 'options');
    if (r.kind !== 'options') return;
    assert.ok(r.options.length > 0);
    assert.equal(h.app.getState().addFood.selected, null, 'NOTHING auto-selected');
    assert.equal(h.voice.lastTrace().path, 'assistant_fallback');
    assert.equal(h.voice.lastTrace().validation, 'accepted');
  });

  test('FLOW 2: read-only question returns the exact macro-engine value', async () => {
    const fake = new FakeAssistantInterpreter([
      { match: 'where am i on protein', proposals: [{ intentKind: 'ask_remaining', arguments: { nutrient: 'protein' } }] },
    ]);
    const h = await harness(fake);
    const r = await speak(h, 'where am i on protein');

    assert.equal(r.kind, 'informational');
    if (r.kind !== 'informational') return;
    assert.equal(r.data!['remainingG'], h.app.getState().dashboard!.macros.remainingProteinG);
  });

  test('FLOW 3: natural cancel logs nothing', async () => {
    const fake = new FakeAssistantInterpreter([
      { match: 'scrap that', proposals: [{ intentKind: 'cancel' }] },
    ]);
    const h = await harness(fake);
    await speak(h, 'add chicken breast');
    await speak(h, 'option A');
    const r = await speak(h, 'ah scrap that idea');

    assert.equal(r.kind, 'informational');
    assert.equal(h.app.getState().addFood.selected, null);
    assert.equal((await logsOf(h)).length, 0);
  });

  test('FLOW 4: branded search still requires explicit selection', async () => {
    const fake = new FakeAssistantInterpreter([
      { match: 'demo brand', proposals: [{ intentKind: 'search_food', arguments: { query: 'demo brand oats' } }] },
    ]);
    const h = await harness(fake);
    const r = await speak(h, 'grab my demo brand oats would you');

    assert.equal(r.kind, 'options');
    if (r.kind !== 'options') return;
    assert.ok(r.options.some((o) => o.productVersionId.startsWith('synb-')));
    assert.equal(h.app.getState().addFood.selected, null, 'explicit selection still required');
  });

  test('FLOW 5: hallucinated weight, calories and product id are all rejected', async () => {
    const h = await harness(hostile([{
      intentKind: 'manual_weight',
      arguments: { grams: 200, calories: 330, productVersionId: 'synb-oats-old-fashioned@v1' },
    }]));
    const r = await speak(h, "i'm eating chicken");

    assert.equal(r.kind, 'clarification');
    assert.equal(h.app.getState().addFood.weightCapture, null);
    assert.equal(h.app.getState().addFood.selected, null);
    assert.equal((await logsOf(h)).length, 0);
    assert.equal(h.voice.lastTrace().validation, 'prohibited_argument');
  });

  test('FLOW 6: deterministic commands work with NO interpreter at all', async () => {
    const h = await harness(null);
    await speak(h, 'add chicken breast');
    const cooked = h.app.getState().addFood.results
      .find((r) => r.productVersion.preparationState === 'cooked')!;
    await speak(h, `option ${cooked.optionLabel}`);
    await speak(h, '200 grams');
    const done = await speak(h, 'log it');

    assert.equal(done.kind, 'success');
    assert.equal((await logsOf(h)).length, 1);
    assert.equal(h.voice.lastTrace().path, 'deterministic');
  });
});

describe('B22 — adversarial model output', () => {
  const cases: readonly {
    name: string; proposals: readonly IntentProposal[]; reason: string; needsOptions?: boolean;
  }[] = [
    { name: 'unknown tool delete_database', proposals: [{ intentKind: 'delete_database' }], reason: 'unknown_tool' },
    { name: 'arbitrary controller method', proposals: [{ intentKind: 'switchActiveUser' }], reason: 'unknown_tool' },
    { name: 'raw SQL in a query', proposals: [{ intentKind: 'search_food', arguments: { query: "x'; DROP TABLE food_logs; --" } }], reason: 'injection_payload' },
    { name: 'SQL as an argument name', proposals: [{ intentKind: 'search_food', arguments: { sql: 'SELECT * FROM food_logs' } }], reason: 'prohibited_argument' },
    { name: 'URL / network action', proposals: [{ intentKind: 'search_food', arguments: { query: 'https://evil.example/exfil' } }], reason: 'injection_payload' },
    { name: 'filesystem path', proposals: [{ intentKind: 'search_food', arguments: { query: '/etc/passwd' } }], reason: 'injection_payload' },
    { name: 'invented productVersionId', proposals: [{ intentKind: 'select_option', arguments: { productVersionId: 'made-up@v9' } }], reason: 'prohibited_argument' },
    { name: 'model-supplied calories', proposals: [{ intentKind: 'confirm_log', arguments: { calories: 500 } }], reason: 'prohibited_argument' },
    { name: 'model-supplied macros', proposals: [{ intentKind: 'confirm_log', arguments: { protein: 40, fat: 10 } }], reason: 'prohibited_argument' },
    { name: 'model-supplied TDEE', proposals: [{ intentKind: 'ask_remaining', arguments: { tdee: 2400 } }], reason: 'prohibited_argument' },
    { name: 'another user id', proposals: [{ intentKind: 'ask_consumed', arguments: { userId: USER_B } }], reason: 'prohibited_argument' },
    { name: 'option Z', proposals: [{ intentKind: 'select_option', arguments: { optionLabel: 'Z' } }], reason: 'invalid_option_label', needsOptions: true },
    { name: 'unknown argument', proposals: [{ intentKind: 'cancel', arguments: { force: true } }], reason: 'unknown_argument' },
    { name: 'two state-changing actions', proposals: [{ intentKind: 'search_food', arguments: { query: 'oats' } }, { intentKind: 'confirm_log' }], reason: 'multiple_state_changing' },
  ];

  for (const c of cases) {
    test(`${c.name} → rejected, no mutation`, async () => {
      const h = await harness(hostile(c.proposals));
      // Some proposals only reach their specific check once the action is
      // contextually available; otherwise they are refused earlier (also safe).
      if (c.needsOptions === true) await speak(h, 'add chicken breast');
      const before = JSON.stringify(h.app.getState().addFood);
      const r = await speak(h, 'do the thing please');

      assert.equal(r.kind, 'clarification');
      assert.equal(h.voice.lastTrace().validation, c.reason);
      assert.equal(JSON.stringify(h.app.getState().addFood), before, 'state untouched');
      assert.equal((await logsOf(h)).length, 0);
    });
  }

  test('an option that is not CURRENT is rejected even when well-formed', () => {
    const v = validateProposals([{ intentKind: 'select_option', arguments: { optionLabel: 'D' } }], {
      input: { ...baseInput, optionLabels: ['A', 'B'] },
    });
    assert.equal(v.status, 'rejected');
    if (v.status === 'rejected') assert.equal(v.reason, 'option_not_current');
  });

  test('confirm_log before review is refused by the application, not the model', async () => {
    const h = await harness(hostile([{ intentKind: 'confirm_log' }]));
    const r = await speak(h, 'just put it in already');
    // Not in the allowed action set while idle — refused before it reaches the app.
    assert.equal(r.kind, 'clarification');
    assert.equal((await logsOf(h)).length, 0);
  });
});

describe('B8 — the model can never invent a weight', () => {
  test('a proposed weight with no number in the transcript is rejected', () => {
    const v = validateProposals([{ intentKind: 'manual_weight', arguments: { grams: 200 } }], {
      input: { ...baseInput, transcript: "i'm having chicken" },
    });
    assert.equal(v.status, 'rejected');
    if (v.status === 'rejected') assert.equal(v.reason, 'quantity_not_in_transcript');
  });

  test('a proposed weight that contradicts the transcript is rejected', () => {
    const v = validateProposals([{ intentKind: 'manual_weight', arguments: { grams: 500 } }], {
      input: { ...baseInput, transcript: 'about 120 grams of it' },
    });
    assert.equal(v.status, 'rejected');
    if (v.status === 'rejected') assert.equal(v.reason, 'quantity_not_in_transcript');
  });

  test('the accepted value comes from the TRANSCRIPT, not the model', () => {
    const v = validateProposals([{ intentKind: 'manual_weight' }], {
      input: { ...baseInput, transcript: 'about 120 grams of it' },
    });
    assert.equal(v.status, 'accepted');
    if (v.status === 'accepted' && v.intent.kind === 'manual_weight') {
      assert.equal(v.intent.grams, 120);
    }
  });

  test('B9: the model cannot convert an unsupported unit', () => {
    const v = validateProposals([{ intentKind: 'manual_weight', arguments: { grams: 85 } }], {
      input: { ...baseInput, transcript: 'about 3 ounces' },
    });
    assert.equal(v.status, 'rejected');
    if (v.status === 'rejected') assert.equal(v.reason, 'unsupported_unit');
  });

  test('the model cannot argue a negative weight into acceptance', () => {
    const v = validateProposals([{ intentKind: 'manual_weight', arguments: { grams: 50 } }], {
      input: { ...baseInput, transcript: 'minus 50 grams' },
    });
    assert.equal(v.status, 'rejected');
  });
});

describe('B17 — model failure never mutates state', () => {
  const broken: readonly { name: string; interpreter: AssistantInterpreter }[] = [
    { name: 'throws', interpreter: new ThrowingAssistantInterpreter() },
    { name: 'returns null', interpreter: new AdversarialAssistantInterpreter(null) },
    { name: 'returns garbage', interpreter: new AdversarialAssistantInterpreter({ lol: true }) },
    { name: 'returns empty proposals', interpreter: new AdversarialAssistantInterpreter({ status: 'proposed', proposals: [] }) },
    { name: 'returns non-array proposals', interpreter: new AdversarialAssistantInterpreter({ status: 'proposed', proposals: 'oops' }) },
    { name: 'returns no_understanding', interpreter: new AdversarialAssistantInterpreter({ status: 'no_understanding' }) },
    { name: 'returns unavailable', interpreter: new AdversarialAssistantInterpreter({ status: 'unavailable' }) },
  ];

  for (const c of broken) {
    test(`interpreter ${c.name} → safe clarification, zero mutation`, async () => {
      const h = await harness(c.interpreter);
      const before = JSON.stringify(h.app.getState());
      const r = await speak(h, 'mumble mumble something');
      assert.equal(r.kind, 'clarification');
      assert.equal(JSON.stringify(h.app.getState()), before);
    });
  }

  test('deterministic commands still work after an interpreter failure', async () => {
    const h = await harness(new ThrowingAssistantInterpreter());
    await speak(h, 'blah blah nonsense');
    const r = await speak(h, 'add chicken breast');
    assert.equal(r.kind, 'options', 'the fast path is unaffected');
  });
});

describe('B19 — privacy of the interpreter context', () => {
  test("the interpreter never receives another user's state", async () => {
    const fake = new FakeAssistantInterpreter([{ match: 'zzz', proposals: [{ intentKind: 'help' }] }]);
    const h = await harness(fake);

    // User A logs a meal, then the session switches to B.
    await speak(h, 'add chicken breast');
    const cooked = h.app.getState().addFood.results
      .find((r) => r.productVersion.preparationState === 'cooked')!;
    await speak(h, `option ${cooked.optionLabel}`);
    await speak(h, '200 grams');
    await speak(h, 'log it');
    await h.app.switchActiveUser(subjectFor(USER_B, 'Dev B'), activeEnergy(300), { userId: USER_B, sessionGeneration: nextGeneration() });

    await speak(h, 'zzz mystery phrasing', USER_B);
    const seen = JSON.stringify(fake.lastInput);
    assert.ok(!seen.includes(USER_A), "no reference to user A");
    assert.ok(!seen.includes('330'), "no trace of A's intake");
    assert.ok(!seen.includes('Chicken'), "no trace of A's selection");
  });

  test('the context carries no ids, numbers, rows or credentials', async () => {
    const fake = new FakeAssistantInterpreter([{ match: 'zzz', proposals: [{ intentKind: 'help' }] }]);
    const h = await harness(fake);
    await speak(h, 'add demo brand oats');
    await speak(h, 'zzz mystery phrasing');

    const seen = fake.lastInput!;
    const asText = JSON.stringify(seen);
    assert.ok(!asText.includes('@v1'), 'no productVersionId');
    assert.ok(!asText.includes('synb-'), 'no catalog identifiers');
    assert.ok(!/kcal|calories|proteinG/i.test(asText), 'no nutrition numbers');
    assert.equal('userId' in seen, false);
    assert.equal('dashboard' in seen, false);
    // Only display names of what is already on screen.
    assert.ok(Array.isArray(seen.optionDisplayNames));
  });
});

describe('B5/B23 — registry and purity', () => {
  test('every tool kind is explicitly registered', () => {
    for (const [name, spec] of Object.entries(TOOL_REGISTRY)) {
      assert.equal(spec.kind, name);
      assert.ok(isKnownTool(name));
    }
    assert.equal(isKnownTool('delete_database'), false);
  });

  test('there is NO dynamic dispatch on model-supplied strings', () => {
    for (const dir of ['packages/assistant-core/src', 'packages/voice-orchestration/src']) {
      for (const f of readdirSync(join(ROOT, dir))) {
        const src = readFileSync(join(ROOT, dir, f), 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        assert.equal(/\bapp\s*\[[^\]]/.test(src), false, `${dir}/${f}: no controller reflection`);
        assert.equal(/\beval\(|new Function\(/.test(src), false, `${dir}/${f}: no eval`);
      }
    }
  });

  test('assistant-core contains no SDK, network, clock or randomness', () => {
    for (const f of readdirSync(join(ROOT, 'packages/assistant-core/src'))) {
      const src = readFileSync(join(ROOT, 'packages/assistant-core/src', f), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      assert.equal(/openai|anthropic|gemini|fetch\(|Date\.now|Math\.random/i.test(src), false, f);
    }
  });

  test('one state-changing action per turn is enforced by the registry', () => {
    const changing = Object.values(TOOL_REGISTRY).filter((t) => t.stateChanging).map((t) => t.kind);
    assert.deepEqual(
      [...changing].sort(),
      ['cancel', 'confirm_log', 'manual_weight', 'request_stable_weight', 'search_food', 'select_option'].sort(),
    );
  });
});

describe('B14 — trusted tool result', () => {
  test('authoritative data comes from application state, not model prose', async () => {
    const fake = new FakeAssistantInterpreter([
      { match: 'how goes protein', proposals: [{ intentKind: 'ask_consumed', arguments: { nutrient: 'protein' } }] },
    ]);
    const h = await harness(fake);
    await speak(h, 'add chicken breast');
    const cooked = h.app.getState().addFood.results
      .find((r) => r.productVersion.preparationState === 'cooked')!;
    await speak(h, `option ${cooked.optionLabel}`);
    await speak(h, '200 grams');
    await speak(h, 'log it');

    const r = await speak(h, 'so how goes protein');
    assert.equal(r.kind, 'informational');
    if (r.kind !== 'informational') return;
    assert.ok(approx(r.data!['proteinG'] as number, 62, 1e-9));
    assert.equal(r.data!['proteinG'], h.app.getState().dashboard!.intake.proteinG);
  });
});
