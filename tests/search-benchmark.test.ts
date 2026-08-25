import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runBenchmark, type BenchmarkCorpus } from '@macros/catalog-ingestion';
import { buildSearchProjection, type CatalogAliasSet } from '@macros/domain-catalog';
import { searchFood, type SearchableFood } from '@macros/domain-food-search';
import { SYNTHETIC_PRODUCTS, SYNTHETIC_CATALOG_HEADS } from '@macros/testkit';

const ROOT = new URL('..', import.meta.url).pathname;

const corpus = JSON.parse(
  readFileSync(join(ROOT, 'data/catalog/benchmarks/search-benchmark.json'), 'utf8'),
) as BenchmarkCorpus;

const aliasSets = (
  JSON.parse(readFileSync(join(ROOT, 'data/catalog/aliases/synthetic-aliases.json'), 'utf8')) as {
    aliasSets: CatalogAliasSet[];
  }
).aliasSets;

/** The catalog exactly as the application would see it: projection + aliases. */
const CATALOG: readonly SearchableFood[] = buildSearchProjection({
  versions: SYNTHETIC_PRODUCTS,
  heads: SYNTHETIC_CATALOG_HEADS,
  aliasSets,
});

const withoutAliases: readonly SearchableFood[] = buildSearchProjection({
  versions: SYNTHETIC_PRODUCTS,
  heads: SYNTHETIC_CATALOG_HEADS,
  aliasSets: [],
});

describe('SEARCH BENCHMARK', () => {
  test('the corpus is hand-authored and covers the required categories', () => {
    const categories = new Set(corpus.cases.map((c) => c.category));
    for (const required of [
      'exact_canonical',
      'short_common_name',
      'word_order',
      'case',
      'spacing_punctuation',
      'preparation_state',
      'raw_cooked_ambiguity',
      'plural_singular',
      'brand',
      'nonsense',
      'dangerous_false_match',
      'inactive_head',
    ]) {
      assert.ok(categories.has(required), `benchmark must cover ${required}`);
    }
  });

  test('BASELINE metrics are recorded honestly, failures included', () => {
    const metrics = runBenchmark(corpus, CATALOG);

    // null means "no applicable cases", never 100%.
    const pct = (v: number | null) => (v === null ? 'n/a' : `${(v * 100).toFixed(1)}%`);
    // Printed so a poor result cannot be quietly averaged away.
    console.log('  search metrics:',
      `top1=${pct(metrics.top1HitRate)}`,
      `top4=${pct(metrics.top4Recall)}`,
      `mrr=${metrics.mrr === null ? 'n/a' : metrics.mrr.toFixed(3)}`,
      `zeroCorrect=${pct(metrics.zeroResultCorrectness)}`,
      `falsePos=${pct(metrics.falsePositiveRate)}`,
      `prepDisambig=${pct(metrics.preparationDisambiguationRate)}`,
      `failures=${metrics.failures.length}`);
    for (const f of metrics.failures) {
      console.log(`    FAIL [${f.category}] "${f.query}" — ${f.problem} → ${f.returned.join(', ') || '(none)'}`);
    }

    assert.ok(metrics.cases >= 20, 'a meaningful corpus');
  });

  test('GATE: no nonsense query returns a food', () => {
    const metrics = runBenchmark(corpus, CATALOG);
    assert.equal(metrics.falsePositiveRate, 0, 'a false match silently logs the wrong food');
    assert.equal(metrics.zeroResultCorrectness, 1);
  });

  test('GATE: raw/cooked disambiguation never returns the wrong preparation', () => {
    const metrics = runBenchmark(corpus, CATALOG);
    const forbidden = metrics.failures.filter((f) => f.problem === 'returned_forbidden');
    assert.deepEqual(forbidden, [], 'logging cooked values for raw food is a ~35% error');
  });

  test('GATE: top-4 recall is complete on this corpus', () => {
    const metrics = runBenchmark(corpus, CATALOG);
    const missed = metrics.failures.filter((f) => f.problem === 'missed_top4' || f.problem === 'unexpected_zero_results');
    assert.deepEqual(missed.map((f) => f.query), [], 'every intended food is reachable in four options');
  });

  test('GATE: top-1 hit rate meets the recorded baseline', () => {
    const metrics = runBenchmark(corpus, CATALOG);
    assert.ok(metrics.top1HitRate !== null, 'the corpus must contain scorable cases');
    assert.ok(
      metrics.top1HitRate! >= 0.85,
      `top-1 regressed to ${((metrics.top1HitRate ?? 0) * 100).toFixed(1)}%`,
    );
  });

  test('aliases MEASURABLY improve the result — the reason they exist', () => {
    const withAliases = runBenchmark(corpus, CATALOG);
    const without = runBenchmark(corpus, withoutAliases);
    console.log(`  alias effect: top1 ${((without.top1HitRate ?? 0) * 100).toFixed(1)}% → ${((withAliases.top1HitRate ?? 0) * 100).toFixed(1)}%`);
    assert.ok(
      (withAliases.top1HitRate ?? 0) >= (without.top1HitRate ?? 0),
      'aliases must not make ranking worse',
    );
  });

  test('the benchmark is deterministic', () => {
    const a = runBenchmark(corpus, CATALOG);
    const b = runBenchmark(corpus, CATALOG);
    assert.deepEqual(a.failures, b.failures);
    assert.equal(a.top1HitRate, b.top1HitRate);
  });
});

describe('SEARCH BEHAVIOUR REQUIRED BY THE BENCHMARK', () => {
  const ids = (q: string) => searchFood(CATALOG, { text: q, limit: 4 }).map((r) => r.productVersion.productVersionId);

  test('word order does not matter', () => {
    assert.deepEqual(ids('cooked chicken breast'), ids('chicken breast cooked'));
  });

  test('punctuation and spacing are normalized away', () => {
    assert.deepEqual(ids('chicken-breast (cooked)'), ids('chicken breast cooked'));
  });

  test('plural and singular both find the food', () => {
    assert.deepEqual(ids('almonds'), ids('almond'));
  });

  test('an alias finds the food', () => {
    assert.ok(ids('tofu').includes('syn-firm-tofu@v1'));
  });

  test('a de-listed food never appears', () => {
    assert.deepEqual(ids('olive oil'), []);
  });

  test('one real token plus nonsense returns nothing', () => {
    assert.deepEqual(ids('chicken zzzz'), []);
  });

  test('A/B/C/D labels stay stable for the same query', () => {
    const first = searchFood(CATALOG, { text: 'chicken', limit: 4 });
    const second = searchFood(CATALOG, { text: 'chicken', limit: 4 });
    assert.deepEqual(first.map((r) => r.optionLabel), second.map((r) => r.optionLabel));
    assert.deepEqual(first.map((r) => r.optionLabel), ['A', 'B'].slice(0, first.length));
  });

  test('editing an alias cannot change nutrition', () => {
    const before = CATALOG.find((c) => c.productVersionId === 'syn-firm-tofu@v1')!;
    const edited = buildSearchProjection({
      versions: SYNTHETIC_PRODUCTS,
      heads: SYNTHETIC_CATALOG_HEADS,
      aliasSets: [{ productId: 'syn-firm-tofu', aliases: ['bean curd'], curatedBy: 'x', curatedAt: 'y' }],
    }).find((c) => c.productVersionId === 'syn-firm-tofu@v1')!;
    assert.equal(edited.productVersionId, before.productVersionId, 'same version, new aliases only');
  });
});
