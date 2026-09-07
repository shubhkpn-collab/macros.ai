import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  DEFAULT_RECOMMENDATION_POLICY, type RecommendationCandidate,
} from '@macros/domain-recommendation';
import {
  FakeGuidanceProvider, UnavailableGuidanceProvider, buildGuidanceEnvelope,
  deterministicGuidance, renderGuidanceText, requestGuidance, validateGuidance,
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
  intent: 'what_should_i_eat', selectedProductVersionIds: [], text: 'A good option.',
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
    const v = validateGuidance(
      ok({ selectedProductVersionIds: ['not-a-real-food@v1'] }), e);
    assert.equal(v.ok, false);
    assert.deepEqual(v.rejections, ['unknown_candidate']);
  });

  test('a fabricated quantity is rejected', () => {
    const e = envelope();
    const v = validateGuidance(ok({
      selectedProductVersionIds: [e.planComponents[0]!.productVersionId],
      text: 'Have about 180 grams of that.',
    }), e);
    assert.equal(v.ok, false);
    assert.ok(v.rejections.includes('fabricated_nutrition')
      || v.rejections.includes('fabricated_portion'));
  });

  test('an invented nutrition number is rejected', () => {
    const e = envelope();
    const v = validateGuidance(ok({ text: 'You need 43.7 g protein.' }), e);
    assert.equal(v.ok, false);
    assert.ok(v.rejections.includes('fabricated_nutrition'));
  });

  test('an unknown slot is rejected', () => {
    const e = envelope();
    const v = validateGuidance(ok({ text: 'You have {invented_slot} left.' }), e);
    assert.equal(v.ok, false);
    assert.ok(v.rejections.includes('unknown_slot'));
  });

  test('a TRUSTED slot passes and renders the real value', () => {
    const e = envelope();
    const v = validateGuidance(ok({ text: 'Protein left: {remaining_protein_g}.' }), e);
    assert.equal(v.ok, true, `unexpectedly rejected: ${v.rejections.join(',')}`);
    const rendered = renderGuidanceText('Protein left: {remaining_protein_g}.', e);
    assert.equal(rendered.includes('{'), false);
    assert.ok(rendered.includes(e.slots['remaining_protein_g']!));
  });

  test('malformed output is rejected', () => {
    const e = envelope();
    assert.equal(validateGuidance(null, e).ok, false);
    assert.equal(validateGuidance({} as never, e).ok, false);
    assert.equal(validateGuidance(ok({ intent: 'sing_a_song' as never }), e).ok, false);
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
    const v = validateGuidance(ok({ selectedProductVersionIds: ['anything@v1'] }), e);
    assert.equal(v.ok, false);
    assert.deepEqual(v.rejections, ['recommendation_after_exhausted_budget']);
  });

  test('a quantity claim without portion authority is rejected', () => {
    const e = envelope();
    const v = validateGuidance(ok({
      selectedProductVersionIds: [e.planComponents[0]!.productVersionId],
      text: 'Have a serving of that.',
    }), e);
    assert.equal(v.ok, false);
    assert.ok(v.rejections.includes('quantity_without_authority'));
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
        selectedProductVersionIds: ['fabricated@v1'],
        text: 'Eat 300 g of something I made up.',
      }),
    };
    const out = await requestGuidance(e, 'what_should_i_eat', { provider: rogue });
    assert.equal(out.usedFallback, true);
    assert.ok(out.rejections.length > 0);
    assert.equal(out.text.includes('made up'), false, 'unsafe text must never surface');
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
