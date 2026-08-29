import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  ABBREVIATIONS, PREPARATION_TERMS, allowedDistance, boundedEditDistance,
  finalConfidence, resolveQuery, singularize, type Vocabulary,
} from '@macros/domain-food-search';
import { toFoodCardView } from '@macros/tablet-view-model';
import { repoPath } from '../tools/repo-paths.js';

/** A vocabulary mirroring the real one: canonical words plus catalog typos. */
const vocab = (over: Partial<Vocabulary> = {}): Vocabulary => ({
  terms: new Set([
    'chicken', 'breast', 'turkey', 'thigh', 'broccoli', 'brocolli', 'peanut',
    'butter', 'banana', 'rice', 'oat', 'quaker', 'salmon', 'tuna', 'egg',
    'yogurt', 'greek', 'chiken',
  ]),
  brands: new Set(['quaker']),
  frequency: new Map([
    ['chicken', 3431], ['breast', 1200], ['turkey', 936], ['broccoli', 387],
    ['brocolli', 1], ['chiken', 2], ['peanut', 900], ['butter', 1500],
    ['banana', 793], ['rice', 2000], ['oat', 800], ['quaker', 120],
    ['salmon', 400], ['tuna', 380], ['egg', 1100], ['yogurt', 700],
    ['greek', 300], ['thigh', 200],
  ]),
  ...over,
});

describe('SEARCH-1 — the three proven failures', () => {
  test('`chiken breast` resolves to CHICKEN, never turkey', () => {
    // The original bug: "chiken" matched nothing, the search answered from
    // "breast" alone, and turkey is not chicken.
    const r = resolveQuery('chiken breast', vocab());
    assert.deepEqual(r.searchTerms, ['chicken', 'breast']);
    assert.equal(r.searchTerms.includes('turkey'), false);
    assert.equal(r.confidence, 'did_you_mean', 'a correction asks, never assumes');
    assert.equal(r.didYouMean, 'chicken breast');
  });

  test('`brocoli` resolves despite a competing catalog typo', () => {
    // `brocolli` is a real catalog term (one product is misspelled), so
    // distance alone ties. Frequency decides: 387 uses versus 1.
    const r = resolveQuery('brocoli', vocab());
    assert.deepEqual(r.searchTerms, ['broccoli']);
    assert.equal(r.confidence, 'did_you_mean');
  });

  test('an exact match on a RARE catalog typo is still corrected', () => {
    // "chiken" exists in the catalog (frequency 2). Matching it exactly is
    // matching source noise, not understanding the query.
    const r = resolveQuery('chiken', vocab());
    assert.deepEqual(r.searchTerms, ['chicken']);
    assert.equal(r.corrections.length, 1);
  });

  test('`pb` expands only through the controlled allow-list', () => {
    const r = resolveQuery('pb', vocab());
    assert.deepEqual(r.searchTerms, ['peanut', 'butter']);
    assert.equal(r.confidence, 'did_you_mean',
      'an expansion is an assumption and must be surfaced');
  });
});

describe('SEARCH-1 — safety rules', () => {
  test('an UNRESOLVED token poisons confidence', () => {
    // The core rule: not understanding part of a query means any answer built
    // from the rest is a guess about a different food.
    const r = resolveQuery('zzzzqqq breast', vocab());
    assert.equal(r.confidence, 'unresolved');
    assert.deepEqual(r.unresolvedTerms, ['zzzzqqq']);
  });

  test('short words are NEVER fuzzy-corrected', () => {
    // At four characters one edit reaches a different food: oat/oil, pea/tea.
    assert.equal(allowedDistance('oat'), 0);
    assert.equal(allowedDistance('rice'), 0);
    assert.equal(allowedDistance('salmon'), 1);
    assert.equal(allowedDistance('broccoli'), 2);
  });

  test('a tie between equally common words is refused, not guessed', () => {
    // `beaks` is exactly one edit from BOTH candidates, and neither dominates
    // the other in frequency.
    const tied: Vocabulary = {
      terms: new Set(['beans', 'beams']),
      brands: new Set(),
      frequency: new Map([['beans', 100], ['beams', 100]]),
    };
    const r = resolveQuery('beaks', tied);
    assert.equal(r.confidence, 'unresolved', 'a coin flip is not an answer');
    assert.deepEqual(r.unresolvedTerms, ['beaks']);
  });

  test('a correction can never reach `confident`', () => {
    const r = resolveQuery('brocoli', vocab());
    assert.notEqual(r.confidence, 'confident');
  });

  test('an exact, unambiguous query IS confident', () => {
    const r = resolveQuery('chicken breast', vocab());
    assert.equal(r.confidence, 'confident');
    assert.equal(r.corrections.length, 0);
  });

  test('preparation terms are semantic and never dropped', () => {
    const r = resolveQuery('raw chicken breast', vocab());
    assert.deepEqual(r.preparationTerms, ['raw']);
    assert.ok(r.searchTerms.includes('raw'), 'dropping "raw" changes the food');
    for (const p of ['raw', 'cooked', 'grilled', 'boiled']) {
      assert.ok(PREPARATION_TERMS.has(p));
    }
  });

  test('brand terms survive resolution', () => {
    const r = resolveQuery('quaker oats', vocab());
    assert.ok(r.searchTerms.includes('quaker'));
    assert.equal(r.tokens.find((t) => t.resolved === 'quaker')?.kind, 'brand');
  });

  test('a near-tie in results downgrades to ambiguous', () => {
    const q = resolveQuery('chicken', vocab());
    assert.equal(finalConfidence(q, 1.0, 0.99, 40), 'ambiguous',
      'several equally good foods is a question, not a winner');
    assert.equal(finalConfidence(q, 1.0, 0.4, 40), 'confident');
    assert.equal(finalConfidence(q, 0, 0, 0), 'unresolved');
  });

  test('abbreviation expansion is a closed list, not a heuristic', () => {
    // Guessing what an abbreviation means is how `pb` became PB & J BAR.
    assert.equal(ABBREVIATIONS['pb'], 'peanut butter');
    assert.equal(ABBREVIATIONS['zz'], undefined);
    assert.ok(Object.keys(ABBREVIATIONS).length < 20, 'stays deliberately small');
  });

  test('singularisation never mangles a real food name', () => {
    assert.equal(singularize('bananas'), 'banana');
    assert.equal(singularize('berries'), 'berry');
    assert.equal(singularize('couscous'), 'couscous', '-us is not a plural');
    assert.equal(singularize('grass'), 'grass', '-ss is not a plural');
    assert.equal(singularize('oat'), 'oat');
  });

  test('bounded distance abandons work past the bound', () => {
    assert.equal(boundedEditDistance('chicken', 'chicken', 2), 0);
    assert.equal(boundedEditDistance('chiken', 'chicken', 2), 1);
    assert.equal(boundedEditDistance('chicken', 'turkey', 2), 3, 'exceeds the bound');
  });

  test('filler and quantity words are stripped, food words are not', () => {
    const r = resolveQuery('two scrambled eggs please', vocab());
    assert.ok(r.searchTerms.includes('egg'));
    assert.equal(r.searchTerms.includes('two'), false);
    assert.equal(r.searchTerms.includes('please'), false);
    assert.ok(r.searchTerms.includes('scrambled'), 'preparation survives');
  });
});

describe('SEARCH-1 — benchmark results are measured, not asserted', () => {
  const bench = () => JSON.parse(
    readFileSync(repoPath('data', 'search-benchmark.json'), 'utf8'));

  test('the corpus is large enough to claim consumer readiness', () => {
    const b = bench();
    assert.ok(b.corpusSize >= 250, `corpus is ${b.corpusSize}, expected >= 250`);
    assert.ok(Object.keys(b.byCategory).length >= 12);
  });

  test('UNSAFE WRONG RESULT is the headline metric and is zero', () => {
    // A confident answer that is materially the wrong food is worse than no
    // answer: the person has no signal to doubt it.
    const b = bench();
    assert.equal(b.unsafeWrongResultPercent, 0);
  });

  test('absent queries return nothing rather than a confident guess', () => {
    const b = bench();
    assert.equal(b.byCategory.absent.top1, 0);
    assert.equal(b.byCategory.absent.unsafe, 0);
    assert.equal(b.byCategory.absent.none, b.byCategory.absent.n);
  });

  test('relevance is recorded honestly, including remaining weakness', () => {
    const b = bench();
    assert.ok(b.top1RelevancePercent >= 90);
    // Misspellings remain the weakest category. The number must stay visible
    // rather than being tuned away.
    assert.ok(b.byCategory.misspelling.top1 < b.byCategory.misspelling.n);
    assert.equal(b.byCategory.misspelling.unsafe, 0, 'weak, but never unsafe');
  });
});

describe('SEARCH-1 — image-ready food cards', () => {
  const card = (over: Record<string, unknown> = {}) => ({
    productVersionId: 'p@v1', displayName: 'Broccoli, raw',
    brand: { present: false, value: null },
    preparationState: 'raw',
    serving: { grams: 91, householdText: '1 cup', weighable: true },
    kcal: { present: true, value: 34 },
    proteinG: { present: true, value: 2.8 },
    carbohydrateG: { present: true, value: 6.6 },
    fatG: { present: true, value: 0.4 },
    image: { url: null, attribution: null, status: 'none' },
    displayable: true,
    ...over,
  }) as never;

  test('a real image URL is rendered when one exists', () => {
    const v = toFoodCardView(card({
      image: { url: 'https://cdn/x.jpg', attribution: 'USDA', status: 'available' },
    }), 'BR');
    assert.equal(v.imageUrl, 'https://cdn/x.jpg');
    assert.equal(v.imageAttribution, 'USDA', 'licence provenance travels with it');
  });

  test('no image falls back deterministically', () => {
    const v = toFoodCardView(card(), 'BR');
    assert.equal(v.imageUrl, null);
    assert.equal(v.imageInitials, 'BR');
  });

  test('an unverified image is NOT rendered', () => {
    const v = toFoodCardView(card({
      image: { url: 'https://cdn/x.jpg', attribution: null, status: 'unverified' },
    }), 'BR');
    assert.equal(v.imageUrl, null, 'unverified provenance must not reach the screen');
  });

  test('missing nutrition says unknown rather than rendering blank', () => {
    const v = toFoodCardView(card({
      kcal: { present: false, value: null },
      proteinG: { present: false, value: null },
      displayable: false,
    }), 'XX');
    assert.match(v.nutritionLine, /unknown/i);
    assert.match(v.macroLine, /P —/);
    assert.match(v.dataWarning ?? '', /Not offerable/);
  });

  test('a food without a gram weight is flagged for manual weighing', () => {
    const v = toFoodCardView(card({
      serving: { grams: null, householdText: '8 OZA', weighable: false },
    }), 'BR');
    assert.match(v.servingLine, /no gram weight/);
    assert.match(v.dataWarning ?? '', /manual weighing/);
  });

  test('the browser is development-only', () => {
    const bootstrap = readFileSync(
      repoPath('apps', 'tablet', 'src', 'bootstrap.ts'), 'utf8');
    assert.match(bootstrap, /catalogBrowser/);
    assert.match(bootstrap, /ONLY on a development host/i);
    const host = readFileSync(
      repoPath('apps', 'tablet', 'src', 'development-host.ts'), 'utf8');
    assert.match(host, /DEVELOPMENT ONLY/);
    assert.match(host, /listSearchable\(\)/, 'the QA surface uses the real searchable set');
  });
});
