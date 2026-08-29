import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  buildVocabulary, resilientSearch, type SearchableFood,
} from '@macros/domain-food-search';
import { repoPath } from '../tools/repo-paths.js';

/**
 * A small catalog with the properties that matter: canonical words, a
 * source-data misspelling (`BROCOLLI`, as the real catalog contains), a
 * confusable species, and raw/cooked pairs.
 */
const food = (
  id: string, displayName: string, preparationState = 'as_sold', brandName?: string,
): SearchableFood => ({
  productId: id, productVersionId: `${id}@v1`, displayName, preparationState,
  ...(brandName !== undefined ? { brandName } : {}),
  aliases: [],
} as unknown as SearchableFood);

const CATALOG: readonly SearchableFood[] = [
  // Names mirror real catalog phrasing ("…, cooked"), because the ranker reads
  // preparation from the display text as well as the canonical state.
  ...Array.from({ length: 40 }, (_, i) =>
    food(`chick-${i}`, `Chicken breast, cooked, portion ${i}`, 'cooked')),
  ...Array.from({ length: 20 }, (_, i) =>
    food(`chickraw-${i}`, `Chicken breast, raw, cut ${i}`, 'raw')),
  ...Array.from({ length: 30 }, (_, i) =>
    food(`turk-${i}`, `Turkey breast, cooked, slice ${i}`, 'cooked')),
  // 60 canonical spellings against ONE catalog typo, so the 50x dominance
  // margin is met exactly as it is in the real catalog (387 vs 1).
  ...Array.from({ length: 60 }, (_, i) => food(`broc-${i}`, `Broccoli floret pack ${i}`, 'raw')),
  food('broc-typo', 'BROCOLLI MIX'),
  ...Array.from({ length: 15 }, (_, i) => food(`pb-${i}`, `Peanut butter jar ${i}`)),
  ...Array.from({ length: 10 }, (_, i) => food(`oat-${i}`, `Rolled oats ${i}`, 'as_sold', 'Quaker')),
  ...Array.from({ length: 10 }, (_, i) => food(`oat2-${i}`, `Rolled oats generic ${i}`)),
];

const vocab = buildVocabulary(CATALOG);
const search = (text: string) => resilientSearch(CATALOG, vocab, { text, limit: 4 });
const names = (text: string) =>
  search(text).results.map((r) => (r.productVersion as unknown as { displayName: string }).displayName);

describe('SEARCH-1B — one authoritative entry point', () => {
  test('the tablet controller uses resilientSearch, not the raw ranker', () => {
    const controller = readFileSync(
      repoPath('packages', 'tablet-app-core', 'src', 'controller.ts'), 'utf8');
    assert.match(controller, /resilientSearch\(catalog, vocabulary/);
    assert.match(controller, /buildVocabulary\(catalog\)/);
    // A bare searchFood call would bypass every resilience and safety rule.
    assert.equal(/=\s*searchFood\(catalog/.test(controller), false);
  });

  test('the QA browser uses the SAME function, not a private substring filter', () => {
    const host = readFileSync(
      repoPath('apps', 'tablet', 'src', 'development-host.ts'), 'utf8');
    assert.match(host, /resilientSearch\(searchable, vocabulary/);
    // Inspecting behaviour the product does not have is worse than no QA.
    assert.equal(host.includes('hay.includes'), false);
  });

  test('the benchmark runs the runtime package, not a reimplementation', () => {
    const bench = readFileSync(
      repoPath('tools', 'benchmark-search-quality.ts'), 'utf8');
    assert.match(bench, /from '@macros\/domain-food-search'/);
    assert.match(bench, /resilientSearch\(catalog, vocabulary/);
  });

  test('no second implementation of the algorithm survives', () => {
    // The Python fuzzy/confidence duplicate is gone: two implementations drift
    // apart silently, and the benchmark would then measure a program the
    // product does not run.
    const summary = JSON.parse(
      readFileSync(repoPath('data', 'search-benchmark.json'), 'utf8'));
    assert.equal(summary.runsProductionCode, true);
    assert.match(summary.benchmarkVersion, /runtime/);
  });

  test('resilientSearch composes the EXISTING ranker', () => {
    const src = readFileSync(
      repoPath('packages', 'domain-food-search', 'src', 'resilient-search.ts'), 'utf8');
    assert.match(src, /import \{ searchFood/, 'reuses the deterministic ranker');
    // No second scoring implementation.
    assert.equal(/function score(One)?\(/.test(src), false);
  });
});

describe('SEARCH-1B — required controller-path proofs', () => {
  test('`chiken breast` never confidently returns turkey', () => {
    const r = search('chiken breast');
    assert.equal(r.confidence, 'did_you_mean', 'a correction asks, never assumes');
    assert.notEqual(r.confidence, 'confident');
    assert.deepEqual(r.corrections.map((c) => [c.from, c.to]), [['chiken', 'chicken']]);
    assert.equal(r.didYouMean, 'chicken breast');
    const top = names('chiken breast')[0] ?? '';
    assert.match(top, /Chicken/i);
    assert.equal(/Turkey/i.test(top), false, 'turkey is a different species');
  });

  test('`brocoli` resolves toward broccoli despite the catalog typo', () => {
    const r = search('brocoli');
    assert.equal(r.confidence, 'did_you_mean');
    assert.deepEqual(r.corrections.map((c) => c.to), ['broccoli']);
    assert.match(names('brocoli')[0] ?? '', /Broccoli/i);
  });

  test('`pb` resolves toward peanut butter', () => {
    const r = search('pb');
    assert.equal(r.confidence, 'did_you_mean', 'an expansion is an assumption');
    assert.match(names('pb')[0] ?? '', /Peanut butter/i);
  });

  test('an unknown token cannot become confident because another token matched', () => {
    // THE core rule. "breast" alone would have surfaced turkey.
    const r = search('zzzqqq breast');
    assert.equal(r.confidence, 'unresolved');
    assert.equal(r.autoSelectable, false);
  });

  test('raw/cooked intent survives the resilient path', () => {
    const raw = names('raw chicken breast');
    const cooked = names('cooked chicken breast');
    assert.ok(raw.length > 0 && cooked.length > 0);
    assert.match(raw[0]!, /raw/i, 'raw intent must reach the ranker');
    assert.equal(/raw/i.test(cooked[0]!), false, 'cooked intent must not return raw');
  });

  test('brand intent survives the resilient path', () => {
    const r = search('quaker oats');
    assert.equal(r.confidence !== 'unresolved', true);
    const top = names('quaker oats')[0] ?? '';
    assert.match(top, /oats/i);
  });

  test('only a confident, unambiguous result is auto-selectable', () => {
    // Everything else must be offered as a choice.
    assert.equal(search('chiken breast').autoSelectable, false);
    assert.equal(search('brocoli').autoSelectable, false);
    assert.equal(search('zzzqqq').autoSelectable, false);
    assert.equal(search('chicken').autoSelectable, false, 'many matches is a question');
  });

  test('an empty or unresolvable query returns nothing, not a guess', () => {
    assert.deepEqual(search('').results, []);
    assert.deepEqual(search('zzzzqqqq').results, []);
  });
});

describe('SEARCH-1B — closure metrics', () => {
  const bench = () => JSON.parse(
    readFileSync(repoPath('data', 'search-benchmark.json'), 'utf8'));

  test('unsafe wrong-result rate remains ZERO on production code', () => {
    assert.equal(bench().unsafeWrongResultPercent, 0);
  });

  test('the corpus was not expanded or re-expected', () => {
    const b = bench();
    assert.equal(b.corpusSize, 255, 'SEARCH-1B measures, it does not change the corpus');
  });

  test('absent queries still return nothing', () => {
    const b = bench();
    assert.equal(b.byCategory.absent.none, b.byCategory.absent.n);
    assert.equal(b.byCategory.absent.unsafe, 0);
  });

  test('search latency is measured rather than assumed', () => {
    const b = bench();
    assert.equal(typeof b.meanSearchMs, 'number');
    assert.ok(b.meanSearchMs > 0);
  });
});
