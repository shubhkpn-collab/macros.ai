import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  DEFAULT_RECOMMENDATION_POLICY, type RecommendationCandidate,
} from '@macros/domain-recommendation';
import {
  FakeGuidanceProvider, UnavailableGuidanceProvider, buildGuidanceEnvelope,
  deterministicGuidance, requestGuidance, validateGuidance,
  type GuidanceProviderResult,
} from '@macros/guidance';
import { repoPath } from '../tools/repo-paths.js';

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

interface Seed {
  productId: string; displayName: string; preparationState: string;
  per100g?: Record<string, { amount?: number }>; recommendable?: boolean;
  category?: string; sourceDescription?: string;
}

const candidates = ((): RecommendationCandidate[] => {
  const seeds = JSON.parse(
    readFileSync(repoPath('data', 'usda-seed.json'), 'utf8')) as Seed[];
  const out: RecommendationCandidate[] = [];
  for (const s of seeds) {
    if (s.recommendable !== true) continue;
    const a = (k: string): number | null => {
      const n = s.per100g?.[k]?.amount;
      return typeof n === 'number' ? n : null;
    };
    const [kcal, p, c, f] = [a('energy_kcal'), a('protein'), a('carbohydrate'), a('fat')];
    if (kcal === null || p === null || c === null || f === null) continue;
    out.push({
      productVersion: {
        productId: s.productId, productVersionId: `${s.productId}@v1`, versionNo: 1,
        displayName: s.displayName, preparationState: s.preparationState,
        basis: { kind: 'per_100g', kcal, proteinG: p, carbohydrateG: c, fatG: f },
        source: { kind: 'usda_generic', sourceId: s.productId, verificationStatus: 'published' },
        effectiveFrom: '2026-01-01T00:00:00.000Z',
        category: s.category ?? null, sourceDescription: s.sourceDescription ?? s.displayName,
      } as never,
      head: {
        productId: s.productId, currentProductVersionId: `${s.productId}@v1`,
        isActive: true, updatedAt: '2026-01-01T00:00:00.000Z',
      } as never,
    });
  }
  return out;
})();

const inputFor = (over: Record<string, unknown> = {}, userId = USER) => {
  const targetKcal = 2000;
  const t = {
    targetKcal, proteinG: 150, carbohydrateG: 200, fatG: 67,
    policyVersion: 'p', policyReviewStatus: 'reviewed',
  };
  return {
    userId, nowIso: '2026-08-29T18:00:00.000Z', localDate: '2026-08-29',
    energy: {
      currentBalanceKcal: -450, targetDeltaKcal: -500, remainingIntakeKcal: 450,
      ifNoMoreFoodBalanceKcal: -450, tefStatus: 'unavailable', tefEstimatedTotalKcal: null,
      tefBaseMacroKcal: null, tefIndividualAdjustmentKcal: null, tefConfidence: null,
      completeness: 'complete', completenessGaps: [],
    },
    macros: {
      targets: t, consumedKcal: 1550, consumedProteinG: 30, consumedCarbohydrateG: 130,
      consumedFatG: 62, remainingKcal: 450, remainingProteinG: 120,
      remainingCarbohydrateG: 70, remainingFatG: 5, calcVersion: 'v',
    },
    candidates, history: { userId, observations: [] }, preferences: null,
    policy: DEFAULT_RECOMMENDATION_POLICY, environment: 'test',
    ...over,
  } as never;
};

const envelope = (over: Record<string, unknown> = {}, userId = USER) =>
  buildGuidanceEnvelope(inputFor(over, userId), { subjectId: userId, sessionId: 's1' });

const exhausted = () => envelope({
  // The engine reads remaining ENERGY, so overriding macros alone leaves the
  // budget open and the fixture proves nothing.
  energy: {
    currentBalanceKcal: 300, targetDeltaKcal: -500, remainingIntakeKcal: -300,
    ifNoMoreFoodBalanceKcal: 300, tefStatus: 'unavailable', tefEstimatedTotalKcal: null,
    tefBaseMacroKcal: null, tefIndividualAdjustmentKcal: null, tefConfidence: null,
    completeness: 'complete', completenessGaps: [],
  },
  macros: {
    targets: { targetKcal: 2000, proteinG: 150, carbohydrateG: 200, fatG: 67,
      policyVersion: 'p', policyReviewStatus: 'reviewed' },
    consumedKcal: 2300, consumedProteinG: 140, consumedCarbohydrateG: 210,
    consumedFatG: 70, remainingKcal: -300, remainingProteinG: 10,
    remainingCarbohydrateG: -10, remainingFatG: -3, calcVersion: 'v',
  },
});

const ok = (over: Partial<GuidanceProviderResult> = {}): GuidanceProviderResult => ({
  intent: 'what_should_i_eat', templateId: 'need_clarification',
  selectedProductVersionIds: [],
  clarificationNeeded: false, suggestedNextAction: 'await_choice', ...over,
});

describe('INT-5 — the envelope exposes only trusted facts', () => {
  test('it carries plan components, alternatives and formatted slots', () => {
    const e = envelope();
    assert.ok(e.planComponents.length > 0);
    assert.ok(e.alternatives.length > 0);
    assert.equal(typeof e.slots['remaining_protein_g'], 'string');
    // Slots are pre-formatted strings, never raw numbers for a model to re-derive.
    assert.equal(/^\d+(\.\d)?$/.test(e.slots['remaining_protein_g']!), true);
  });

  test('no repository or raw domain object crosses the boundary', () => {
    const serialized = JSON.stringify(envelope());
    for (const leak of ['repositor', 'basis', 'per100g', 'observations', 'policy']) {
      assert.equal(serialized.toLowerCase().includes(leak), false, `envelope leaks ${leak}`);
    }
  });

  test('alternatives come from the frozen ranking, not a new search', () => {
    const src = readFileSync(
      repoPath('packages', 'guidance', 'src', 'envelope.ts'), 'utf8');
    assert.match(src, /recommendFoods\(input\)/);
    assert.equal(/searchFood|resilientSearch/.test(src), false,
      'the guidance layer must never search the catalog');
  });

  test('an ungrounded plan reports that weighing is required', () => {
    const e = envelope();
    assert.equal(e.weighingRequired, true);
    for (const c of e.planComponents) assert.equal(c.groundedPortionGrams, null);
  });
});

describe('INT-5 — adversarial provider output is refused', () => {
  test('a food outside the envelope is rejected', () => {
    const e = envelope();
    const v = validateGuidance(ok({
      templateId: 'single_option', selectedProductVersionIds: ['not-a-real-food@v1'],
    }), e);
    assert.equal(v.ok, false);
    assert.deepEqual(v.rejections, ['unknown_candidate']);
  });

  test('an unknown template is rejected', () => {
    const e = envelope();
    const v = validateGuidance(ok({ templateId: 'freestyle_prose' as never }), e);
    assert.equal(v.ok, false);
    assert.deepEqual(v.rejections, ['unknown_template']);
  });

  test('a template arity mismatch is rejected', () => {
    // Two names promised, one supplied: the rendered sentence would dangle.
    const e = envelope();
    const v = validateGuidance(ok({
      templateId: 'two_options',
      selectedProductVersionIds: [e.planComponents[0]!.productVersionId],
    }), e);
    assert.equal(v.ok, false);
    assert.deepEqual(v.rejections, ['template_arity_mismatch']);
  });

  test('an unknown slot is rejected', () => {
    const e = envelope();
    const v = validateGuidance(ok({ slotRefs: ['invented_slot'] }), e);
    assert.equal(v.ok, false);
    assert.deepEqual(v.rejections, ['unknown_slot']);
  });

  test('an out-of-range objective is rejected', () => {
    const e = envelope();
    const v = validateGuidance(ok({
      templateId: 'option_with_objective',
      selectedProductVersionIds: [e.planComponents[0]!.productVersionId],
      objectiveIndex: 99,
    }), e);
    assert.equal(v.ok, false);
    assert.deepEqual(v.rejections, ['unknown_objective']);
  });

  test('malformed output is rejected', () => {
    const e = envelope();
    assert.equal(validateGuidance(null, e).ok, false);
    assert.equal(validateGuidance({} as never, e).ok, false);
    assert.equal(validateGuidance(ok({ intent: 'sing_a_song' as never }), e).ok, false);
    assert.equal(validateGuidance(ok({ tone: 'sarcastic' as never }), e).ok, false);
  });

  test('an unsupported action is rejected', () => {
    const e = envelope();
    const v = validateGuidance(ok({ suggestedNextAction: 'order_takeaway' as never }), e);
    assert.equal(v.ok, false);
    assert.deepEqual(v.rejections, ['unsupported_action']);
  });

  test('recommending after an exhausted budget is rejected', () => {
    const e = exhausted();
    assert.notEqual(e.plannerStatus, 'available');
    const v = validateGuidance(ok({
      templateId: 'single_option', selectedProductVersionIds: ['anything@v1'],
    }), e);
    assert.equal(v.ok, false);
    assert.deepEqual(v.rejections, ['recommendation_after_exhausted_budget']);
  });
});

describe('INT-5B — prose hallucination is structurally impossible', () => {
  test('a provider CANNOT emit free text at all', () => {
    // The INT-5 hole: "Pizza is the better protein choice" has no number, no
    // unknown id and no bad slot, so numeric validation passed it. There is now
    // no field through which such a sentence could arrive.
    const contracts = readFileSync(
      repoPath('packages', 'guidance', 'src', 'contracts.ts'), 'utf8');
    const resultBlock = contracts.slice(
      contracts.indexOf('export interface GuidanceProviderResult'),
      contracts.indexOf('export type GuidanceNextAction'));
    assert.equal(/readonly text\s*[?]?:\s*string/.test(resultBlock), false,
      'GuidanceProviderResult must expose no free-text field');
  });

  test('an outside food name cannot surface through any template', () => {
    const e = envelope();
    // Even a valid template renders ONLY envelope names.
    const v = validateGuidance(ok({
      templateId: 'single_option',
      selectedProductVersionIds: [e.planComponents[0]!.productVersionId],
    }), e);
    assert.equal(v.ok, true);
    assert.equal(v.text.toLowerCase().includes('pizza'), false);
    assert.ok(v.text.includes(e.planComponents[0]!.displayName));
  });

  test('a qualitative nutrition claim cannot be introduced', () => {
    // Templates are a closed set of sentences the application authored.
    const templates = readFileSync(
      repoPath('packages', 'guidance', 'src', 'templates.ts'), 'utf8');
    const rendered = templates.slice(templates.indexOf('switch (templateId)'));
    for (const claim of ['better', 'healthier', 'best source', 'rich in']) {
      assert.equal(rendered.toLowerCase().includes(claim), false,
        `a template asserts "${claim}"`);
    }
  });

  test('a legitimate selection still produces natural text', () => {
    const e = envelope();
    const v = validateGuidance(ok({
      templateId: 'option_with_objective',
      selectedProductVersionIds: [e.planComponents[0]!.productVersionId],
      objectiveIndex: 0,
    }), e);
    assert.equal(v.ok, true);
    assert.match(v.text, /biggest gap/);
    assert.ok(v.text.includes(e.planComponents[0]!.displayName));
  });

  test('trusted slot rendering still works', () => {
    const e = envelope();
    const v = validateGuidance(ok({ slotRefs: ['remaining_protein_g'] }), e);
    assert.equal(v.ok, true, v.rejections.join(','));
  });

  test('no rendered template states a quantity', () => {
    const e = envelope();
    const v = validateGuidance(ok({
      templateId: 'confirm_choice_await_weight',
      selectedProductVersionIds: [e.planComponents[0]!.productVersionId],
      suggestedNextAction: 'await_weight',
    }), e);
    assert.equal(v.ok, true);
    assert.equal(/\d/.test(v.text), false, 'no digit may appear without authority');
    assert.match(v.text, /scale/i);
  });
});

describe('INT-5 — the appliance still works without a model', () => {
  test('an unavailable provider falls back deterministically', async () => {
    const e = envelope();
    const out = await requestGuidance(e, 'what_should_i_eat',
      { provider: new UnavailableGuidanceProvider() });
    assert.equal(out.usedFallback, true);
    assert.deepEqual(out.rejections, ['provider_unavailable']);
    assert.ok(out.text.length > 0);
    assert.equal(out.text.includes('{'), false, 'fallback text must be fully rendered');
  });

  test('a slow provider times out into the fallback', async () => {
    const e = envelope();
    const slow = {
      name: 'slow',
      generate: () => new Promise<never>(() => { /* never resolves */ }),
    };
    const out = await requestGuidance(e, 'what_should_i_eat',
      { provider: slow, timeoutMs: 25 });
    assert.equal(out.usedFallback, true);
    assert.deepEqual(out.rejections, ['provider_unavailable']);
  });

  test('unsafe provider output falls back rather than reaching the user', async () => {
    const e = envelope();
    const rogue = {
      name: 'rogue',
      generate: async () => ok({
        templateId: 'single_option',
        selectedProductVersionIds: ['fabricated@v1'],
      }),
    };
    const out = await requestGuidance(e, 'what_should_i_eat', { provider: rogue });
    assert.equal(out.usedFallback, true);
    assert.ok(out.rejections.length > 0);
    assert.equal(out.text.includes('fabricated'), false, 'unsafe output must never surface');
  });

  test('the fallback never invents a number', () => {
    const out = deterministicGuidance(envelope());
    assert.equal(/\d/.test(out.text), false, 'fallback text contains a digit');
    assert.ok(out.candidates.length > 0);
  });

  test('the fallback passes through an honest refusal', () => {
    const out = deterministicGuidance(exhausted());
    assert.deepEqual(out.candidates, []);
    assert.equal(out.nextAction, 'none');
  });
});

describe('INT-5 — the scale-ready flow', () => {
  test('choosing an offered food leads to awaiting weight', async () => {
    const e = envelope();
    const chosen = e.planComponents[0]!.productVersionId;
    const out = await requestGuidance(e, 'choose_candidate',
      { provider: new FakeGuidanceProvider() }, { chosenProductVersionId: chosen });
    assert.equal(out.usedFallback, false);
    assert.equal(out.nextAction, 'await_weight');
    assert.equal(out.candidates[0]?.productVersionId, chosen);
  });

  test('choosing an UNOFFERED food asks for clarification', async () => {
    const e = envelope();
    const out = await requestGuidance(e, 'choose_candidate',
      { provider: new FakeGuidanceProvider() },
      { chosenProductVersionId: 'never-offered@v1' });
    assert.equal(out.nextAction, 'await_clarification');
    assert.deepEqual(out.rejections, ['unknown_candidate']);
    assert.deepEqual(out.candidates, []);
  });

  test('with no grounded portion the flow points at the scale, never a quantity', async () => {
    const e = envelope();
    const out = await requestGuidance(e, 'what_should_i_eat',
      { provider: new FakeGuidanceProvider() });
    assert.equal(out.nextAction, 'await_weight');
    assert.equal(/\d/.test(out.text), false, 'no quantity may be stated');
  });

  test('a happy-path provider result is accepted and rendered', async () => {
    const e = envelope();
    const out = await requestGuidance(e, 'what_should_i_eat',
      { provider: new FakeGuidanceProvider() });
    assert.equal(out.usedFallback, false);
    assert.equal(out.text.includes('{'), false);
    assert.ok(out.candidates.length > 0);
  });
});

describe('INT-5 — member isolation', () => {
  test('an envelope is bound to the authenticated member', () => {
    const a = envelope({}, USER);
    const b = envelope({}, OTHER);
    assert.equal(a.subjectId, USER);
    assert.equal(b.subjectId, OTHER);
    assert.notEqual(a.subjectId, b.subjectId);
  });

  test('no previous-member fact survives a rebuild', () => {
    const b = envelope({}, OTHER);
    assert.equal(JSON.stringify(b).includes(USER), false,
      "the previous member's identity leaked into a new envelope");
  });

  test('there is no long-term memory', () => {
    const src = readFileSync(
      repoPath('packages', 'guidance', 'src', 'orchestrator.ts'), 'utf8');
    assert.match(src, /Session-scoped only/);
    assert.equal(/persist|storage|repository/i.test(src), false);
  });
});

describe('INT-5 — no live model, no new dependency', () => {
  test('no network call exists anywhere in the guidance package', () => {
    for (const f of ['contracts.ts', 'envelope.ts', 'validator.ts', 'fallback.ts',
                     'fake-provider.ts', 'orchestrator.ts']) {
      const src = readFileSync(repoPath('packages', 'guidance', 'src', f), 'utf8');
      for (const banned of ['fetch(', 'openai', 'anthropic', 'https://', 'axios']) {
        assert.equal(src.toLowerCase().includes(banned), false, `${f} references ${banned}`);
      }
    }
  });

  test('the frozen domains are consumed, never modified', () => {
    const src = readFileSync(
      repoPath('packages', 'guidance', 'src', 'envelope.ts'), 'utf8');
    assert.match(src, /recommendFoodPlan/);
    // No scoring of its own.
    assert.equal(/score\s*[*/+-]/.test(src), false);
  });
});

describe('INT-5B — provider privacy projection', () => {
  test('the provider payload carries NO subject or session identifier', async () => {
    const { toProviderFacing } = await import('@macros/guidance');
    const e = envelope();
    const payload = JSON.stringify(toProviderFacing(e));
    // Serialization, not shape inspection: this is what would cross a network.
    assert.equal(payload.includes(USER), false, 'subjectId reached the provider');
    assert.equal(payload.includes('s1'), false, 'sessionId reached the provider');
    assert.equal(payload.includes('subjectId'), false);
    assert.equal(payload.includes('sessionId'), false);
  });

  test('the projection still carries everything selection needs', async () => {
    const { toProviderFacing } = await import('@macros/guidance');
    const p = toProviderFacing(envelope());
    assert.ok(p.planComponents.length > 0);
    assert.ok(p.alternatives.length > 0);
    assert.ok(Object.keys(p.slots).length > 0);
    assert.equal(typeof p.weighingRequired, 'boolean');
  });

  test('the orchestrator sends the projection, never the envelope', () => {
    const src = readFileSync(
      repoPath('packages', 'guidance', 'src', 'orchestrator.ts'), 'utf8');
    assert.match(src, /envelope: toProviderFacing\(envelope\)/);
  });

  test('no repository or raw history reaches the provider', async () => {
    const { toProviderFacing } = await import('@macros/guidance');
    const payload = JSON.stringify(toProviderFacing(envelope())).toLowerCase();
    for (const leak of ['repositor', 'observations', 'policy', 'per100g', 'basis']) {
      assert.equal(payload.includes(leak), false, `projection leaks ${leak}`);
    }
  });
});

describe('INT-5B — alternatives carry real nutritional roles', () => {
  test('alternatives are no longer all "unknown"', () => {
    // The bug: roleById was built only from plan components, so every
    // alternative silently defaulted to unknown while the code claimed
    // role diversity.
    const e = envelope();
    const roles = e.alternatives.map((a) => a.role);
    assert.ok(roles.length > 0);
    assert.equal(roles.every((r) => r === 'unknown'), false,
      'every alternative role is unknown — the role lookup is broken again');
  });

  test('at least two distinct real roles are preserved across the envelope', () => {
    const e = envelope();
    const roles = new Set([...e.planComponents, ...e.alternatives]
      .map((c) => c.role).filter((r) => r !== 'unknown'));
    assert.ok(roles.size >= 2, `only ${roles.size} distinct role(s): ${[...roles].join(',')}`);
  });

  test('roles come from the authoritative model, not a display name', () => {
    const src = readFileSync(
      repoPath('packages', 'guidance', 'src', 'envelope.ts'), 'utf8');
    assert.match(src, /assessRole\(v\)/);
    assert.equal(/displayName.*role|role.*displayName\.includes/.test(src), false);
  });
});
