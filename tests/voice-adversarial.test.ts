import { mintSubjectForTests } from '@macros/domain-auth';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DeterministicVoiceParser, normalizeTranscript, type VoiceUtterance } from '@macros/domain-voice';
import { VoiceOrchestrator } from '@macros/voice-orchestration';
import type { VoiceOption, VoiceResponse } from '@macros/domain-voice';
import { TabletAppController, DevScaleAdapter, type AppEnvironment, type AppSubject, appSubjectFrom } from '@macros/tablet-app-core';
import {
  InMemoryEnergyGoalRepository, InMemoryFoodLogRepository,
  InMemoryProductVersionRepository, InMemoryUserProfileRepository,
  type PersistedLoopRepositories,
} from '@macros/persistence';
import { instant, type EnergyGoalVersion, type Instant } from '@macros/contracts';
import type { LoopPolicies } from '@macros/core-loop';
import {
  PROFILE_MALE_35, PROFILE_FEMALE_29, SYNTHETIC_BRANDED_ALIASES, SYNTHETIC_BRANDED_HEADS,
  SYNTHETIC_BRANDED_PRODUCTS, SYNTHETIC_CATALOG_HEADS, SYNTHETIC_PRODUCTS,
  SYNTHETIC_STABILITY_POLICY, TEST_TEF_POLICY, USER_A, USER_B, activeEnergy, approx,
} from '@macros/testkit';

const ROOT = new URL('..', import.meta.url).pathname;
const TZ = 'America/Chicago';
const START = '2026-08-19T16:50:00.000Z';
const POLICIES: LoopPolicies = { tefPolicy: { status: 'available', policy: TEST_TEF_POLICY } };
const parser = new DeterministicVoiceParser();

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

async function harness() {
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
  return { app, scale: new DevScaleAdapter(START, clock), voice: new VoiceOrchestrator(app), repos, clock };
}
type H = Awaited<ReturnType<typeof harness>>;
let n = 0;
const say = (h: H, t: string, userId = USER_A) => {
  n += 1;
  return h.voice.handle(correlate(h, t, userId, n));
};

/** Full correlation, as a real STT adapter must now supply. */
const correlate = (h: H, transcript: string, userId: string, turn: number) => ({
  transcript,
  receivedAt: instant(new Date(Date.parse('2026-08-19T18:00:00.000Z') + turn * 1000).toISOString()),
  userId,
  utteranceId: `u-${turn}`,
  sessionGeneration: h.app.getState().sessionGeneration,
  turnSequence: turn,
  flowIdAtCapture: h.app.getState().addFood.flowId,
});

/** Narrow a response to its options, failing loudly if it was not an options reply. */
const optionsOf = (r: VoiceResponse): readonly VoiceOption[] => {
  assert.equal(r.kind, 'options', `expected options, got ${r.kind}: ${r.speech}`);
  return r.kind === 'options' ? r.options : [];
};

const feed = (h: H, e: readonly unknown[]) => { for (const x of e) h.app.applyScaleEvent(x as never); };
const utter = (t: string): VoiceUtterance =>
  ({ transcript: t, receivedAt: instant(START), userId: USER_A }) as VoiceUtterance;

// ---------------------------------------------------------------------------

describe('PARSER — malformed and vague input', () => {
  test('empty and whitespace transcripts are invalid', () => {
    for (const t of ['', '   ', '\n\t ']) {
      const r = parser.parse(utter(t));
      assert.equal(r.status, 'invalid');
      if (r.status === 'invalid') assert.equal(r.reason, 'empty_transcript');
    }
  });

  test('nonsense is unsupported, never a guess', () => {
    assert.equal(parser.parse(utter('flrbgnrb qux zzz')).status, 'unsupported');
  });

  test('the original transcript is always retained for diagnostics', () => {
    const raw = '  Add   CHICKEN Breast!!  ';
    assert.equal(parser.parse(utter(raw)).transcript, raw);
    assert.equal(normalizeTranscript(raw), 'add chicken breast');
  });

  test('parsing is deterministic', () => {
    assert.deepEqual(parser.parse(utter('add oats')), parser.parse(utter('add oats')));
  });
});

describe('PARSER — weight safety', () => {
  const reason = (t: string) => {
    const r = parser.parse(utter(t));
    return r.status === 'invalid' ? r.reason : r.status;
  };

  test('zero and negative grams are rejected', () => {
    assert.equal(reason('0 grams'), 'weight_not_positive');
    assert.equal(reason('-50 grams'), 'weight_not_positive');
  });

  test('an unreasonable weight beyond the scale range is rejected', () => {
    assert.equal(reason('99999 grams'), 'weight_out_of_range');
  });

  test('unsupported units are refused — no invented conversion', () => {
    for (const t of ['3 ounces', '1 cup', '2 tablespoons', '8 oz', '1.5 pounds']) {
      assert.equal(reason(t), 'unsupported_unit', `"${t}" must not be converted`);
    }
  });

  test('grams are accepted', () => {
    const r = parser.parse(utter('83 grams'));
    assert.equal(r.status, 'understood');
    if (r.status === 'understood' && r.intent.kind === 'manual_weight') {
      assert.equal(r.intent.grams, 83);
    }
  });
});

describe('ORCHESTRATION — cannot bypass the application state machine', () => {
  test('"log it" before any selection logs nothing', async () => {
    const h = await harness();
    const r = await say(h, 'log it');
    assert.equal(r.kind, 'clarification');
    const logs = await h.repos.foodLogs.listByLocalDate(USER_A, h.app.getState().dashboard!.localDate);
    assert.equal(logs.length, 0);
  });

  test('"log it" after selection but before weight logs nothing', async () => {
    const h = await harness();
    await say(h, 'add chicken breast');
    const o = optionsOf(await say(h, 'repeat the options'));
    await say(h, `option ${o[0]!.optionLabel}`);

    const r = await say(h, 'log it');
    assert.equal(r.kind, 'clarification');
    const logs = await h.repos.foodLogs.listByLocalDate(USER_A, h.app.getState().dashboard!.localDate);
    assert.equal(logs.length, 0, 'weight capture cannot be bypassed');
  });

  test('"weigh it" cannot read an unstable sample as a final weight', async () => {
    const h = await harness();
    await say(h, 'add chicken breast');
    const o = optionsOf(await say(h, 'repeat the options'));
    await say(h, `option ${o[0]!.optionLabel}`);

    feed(h, h.scale.connect());
    feed(h, h.scale.placeUnsettled(200));

    const r = await say(h, 'weigh it');
    assert.notEqual(r.kind, 'review', 'an unsettled scale is not a capture');
    assert.equal(h.app.getState().addFood.weightCapture, null);
  });

  test('"option B" with no active options resolves nothing', async () => {
    const h = await harness();
    const r = await say(h, 'option B');
    assert.equal(r.kind, 'clarification');
    assert.equal(h.app.getState().addFood.selected, null);
  });

  test('a stale option label after a NEW search cannot select the old result', async () => {
    const h = await harness();
    await say(h, 'add chicken breast');
    const first = optionsOf(await say(h, 'repeat the options'));
    const staleId = first[first.length - 1]!.productVersionId;
    const staleLabel = first[first.length - 1]!.optionLabel;

    await say(h, 'add tofu');
    const now = optionsOf(await say(h, 'repeat the options'));

    await say(h, `option ${staleLabel}`);
    const selected = h.app.getState().addFood.selected;
    if (selected !== null) {
      assert.notEqual(selected.productVersionId, staleId, 'never the previous search result');
      assert.ok(now.some((o) => o.productVersionId === selected.productVersionId));
    }
  });
});

describe('DUPLICATE COMMANDS', () => {
  test('"log it" twice creates exactly one FoodLogItem', async () => {
    const h = await harness();
    await say(h, 'add chicken breast');
    const o = optionsOf(await say(h, 'repeat the options'));
    await say(h, `option ${o.find((x) => x.preparationState === 'cooked')!.optionLabel}`);
    await say(h, '200 grams');

    const first = await say(h, 'log it');
    const second = await say(h, 'log it');
    assert.equal(first.kind, 'success');
    assert.equal(second.kind, 'success', 'a repeat is acknowledged, not an error');

    const logs = await h.repos.foodLogs.listByLocalDate(USER_A, h.app.getState().dashboard!.localDate);
    assert.equal(logs.length, 1, 'one review state, one log');
    assert.ok(approx(h.app.getState().dashboard!.intake.kcal, 330, 1e-9));
  });

  test('a repeated STT delivery of the same utterance has no extra effect', async () => {
    const h = await harness();
    await say(h, 'add chicken breast');
    const o = optionsOf(await say(h, 'repeat the options'));
    await say(h, `option ${o.find((x) => x.preparationState === 'cooked')!.optionLabel}`);
    await say(h, '200 grams');
    await say(h, 'log it');
    await say(h, 'log it');
    await say(h, 'log it');
    const logs = await h.repos.foodLogs.listByLocalDate(USER_A, h.app.getState().dashboard!.localDate);
    assert.equal(logs.length, 1);
  });
});

describe('NUTRITION AUTHORITY — voice can never originate a number', () => {
  test('every logged value traces to the nutrition engine', async () => {
    const h = await harness();
    await say(h, 'add demo brand oats');
    const o = optionsOf(await say(h, 'repeat the options'));
    const oats = o.find((x) => x.productVersionId === 'synb-oats-old-fashioned@v1')!;
    await say(h, `option ${oats.optionLabel}`);
    await say(h, '100 grams');
    await say(h, 'log it');

    const logs = await h.repos.foodLogs.listByLocalDate(USER_A, h.app.getState().dashboard!.localDate);
    const log = logs[0]!;
    assert.equal(log.productVersionId, 'synb-oats-old-fashioned@v1', 'exact version pinned');
    assert.ok(approx(log.nutritionSnapshot.totals.kcal, 375, 1e-9));
    assert.ok(log.nutritionCalcVersion.length > 0, 'the engine stamped its version');
    assert.equal(log.weightCapture.source, 'manual', 'provenance preserved');
  });

  test('the voice packages contain no nutrition arithmetic', () => {
    const files = [
      ...readdirSync(join(ROOT, 'packages/domain-voice/src')).map((f) => join(ROOT, 'packages/domain-voice/src', f)),
      ...readdirSync(join(ROOT, 'packages/voice-orchestration/src')).map((f) => join(ROOT, 'packages/voice-orchestration/src', f)),
    ];
    for (const file of files) {
      const src = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      assert.ok(!/\*\s*4\b|\*\s*9\b|ATWATER/.test(src), `${file} must not compute macros`);
      assert.ok(!/calculateNutrition|computeEnergyState|computeMacro/.test(src), `${file} must not call an engine directly`);
    }
  });

  test('no LLM, network, clock or repository in the voice packages', () => {
    for (const dir of ['packages/domain-voice/src', 'packages/voice-orchestration/src']) {
      for (const f of readdirSync(join(ROOT, dir))) {
        // Comments are stripped: documentation may legitimately mention these.
        const src = readFileSync(join(ROOT, dir, f), 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/^\s*\/\/.*$/gm, '');
        assert.ok(!/openai|anthropic|fetch\(|Date\.now|Math\.random|Repository/i.test(src), `${dir}/${f}`);
      }
    }
  });
});

describe('USER ISOLATION', () => {
  test('an utterance addressed to another subject is refused', async () => {
    const h = await harness();
    const r = await say(h, 'add chicken breast', USER_B);
    assert.equal(r.kind, 'error');
    if (r.kind === 'error') assert.equal(r.reason, 'wrong_user');
    assert.equal(h.app.getState().addFood.results.length, 0, 'zero side effects');
  });

  test("A's pending selection cannot become B's after a user switch", async () => {
    const h = await harness();
    await say(h, 'add chicken breast');
    const o = optionsOf(await say(h, 'repeat the options'));
    await say(h, `option ${o[0]!.optionLabel}`);
    await say(h, '150 grams');

    await h.app.switchActiveUser(subjectFor(USER_B, 'Dev B'), activeEnergy(300));
    assert.equal(h.app.getState().addFood.selected, null);

    const r = await say(h, 'log it', USER_B);
    assert.equal(r.kind, 'clarification');
    const bLogs = await h.repos.foodLogs.listByLocalDate(USER_B, h.app.getState().dashboard!.localDate);
    assert.equal(bLogs.length, 0);
  });

  test("A's voice option context does not survive into B's session", async () => {
    const h = await harness();
    await say(h, 'add chicken breast');
    await h.app.switchActiveUser(subjectFor(USER_B, 'Dev B'), activeEnergy(300));
    const r = await say(h, 'option A', USER_B);
    assert.equal(r.kind, 'clarification', 'no options carried over');
  });

  test("B cannot read A's dashboard through voice", async () => {
    const h = await harness();
    await say(h, 'add chicken breast');
    const o = optionsOf(await say(h, 'repeat the options'));
    await say(h, `option ${o.find((x) => x.preparationState === 'cooked')!.optionLabel}`);
    await say(h, '200 grams');
    await say(h, 'log it');

    await h.app.switchActiveUser(subjectFor(USER_B, 'Dev B'), activeEnergy(300));
    const answer = await say(h, 'how many calories have I eaten today', USER_B);
    assert.equal(answer.kind, 'informational');
    if (answer.kind !== 'informational') return;
    assert.equal(answer.data!['kcal'], 0, "B sees B's day, not A's 330");
  });
});

describe('BRANDED AND GENERIC DO NOT COLLAPSE', () => {
  test('a branded query and a generic query reach different products', async () => {
    const h = await harness();
    await say(h, 'add demo brand oats');
    const branded = optionsOf(await say(h, 'repeat the options'));
    assert.ok(branded.every((o) => o.productVersionId.startsWith('synb-')));

    await say(h, 'add chicken breast');
    const generic = optionsOf(await say(h, 'repeat the options'));
    assert.ok(generic.every((o) => o.productVersionId.startsWith('syn-chicken')));
  });
});

describe('HELP derives from application state', () => {
  test('help changes as the flow progresses', async () => {
    const h = await harness();
    const idle = await say(h, 'what can I say');
    await say(h, 'add chicken breast');
    const withOptions = await say(h, 'what can I say');
    const o = optionsOf(await say(h, 'repeat the options'));
    await say(h, `option ${o[0]!.optionLabel}`);
    const selected = await say(h, 'what can I say');

    assert.notEqual(idle.speech, withOptions.speech);
    assert.notEqual(withOptions.speech, selected.speech);
    assert.match(selected.speech, /weigh it/);
  });
});

describe('V-2 — completed-duplicate replay (mandatory delivery ids)', () => {
  /**
   * The old timestamp-window fallback is GONE. Delivery ids are now mandatory
   * at the executable boundary, so a duplicate is identified exactly rather
   * than guessed at from arrival time. Concurrency behaviour is covered in
   * tests/voice-concurrency.test.ts.
   */
  const deliver = (h: H, transcript: string, utteranceId: string, turn: number) =>
    h.voice.handle({
      transcript,
      receivedAt: instant(new Date(Date.parse(START) + turn * 1000).toISOString()),
      userId: USER_A,
      utteranceId,
      sessionGeneration: h.app.getState().sessionGeneration,
      turnSequence: turn,
      flowIdAtCapture: h.app.getState().addFood.flowId,
    });

  test('a completed duplicate replays the canonical response', async () => {
    const h = await harness();
    const first = await deliver(h, 'add chicken breast', 'stt-1', 1);
    const again = await deliver(h, 'add chicken breast', 'stt-1', 1);
    assert.deepEqual(again, first, 'the original response, re-spoken');
  });

  test('a duplicate id is authoritative regardless of elapsed time', async () => {
    const h = await harness();
    const first = await deliver(h, 'add chicken breast', 'stt-2', 1);
    const late = await deliver(h, 'add chicken breast', 'stt-2', 900);
    assert.deepEqual(late, first);
  });

  test('different utterances are never confused for replays', async () => {
    const h = await harness();
    const a = await deliver(h, 'add chicken breast', 'stt-a', 1);
    const b = await deliver(h, 'add tofu', 'stt-b', 2);
    assert.notDeepEqual(a, b);
  });

  test('delivery memory does not cross users', async () => {
    const h = await harness();
    await deliver(h, 'add chicken breast', 'stt-x', 1);
    await h.app.switchActiveUser(subjectFor(USER_B, 'Dev B'), activeEnergy(300));

    const r = await h.voice.handle({
      transcript: 'add chicken breast',
      receivedAt: instant(new Date(Date.parse(START) + 5000).toISOString()),
      userId: USER_B,
      utteranceId: 'stt-x',
      sessionGeneration: h.app.getState().sessionGeneration,
      turnSequence: 1,
      flowIdAtCapture: h.app.getState().addFood.flowId,
    });
    assert.equal(r.kind, 'options', "B's command executed for B");
  });
});
