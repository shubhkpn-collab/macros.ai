/**
 * SEARCH-1B BENCHMARK — runs the REAL runtime search.
 *
 * The previous benchmark carried its own Python reimplementation of the fuzzy,
 * frequency and confidence rules. That meant the measured 0% unsafe rate
 * described a program the product did not actually run, and the two could drift
 * apart silently forever. This imports `resilientSearch` from the shipping
 * package: there is exactly one algorithm, and this measures it.
 *
 * It measures only. Corpus, expected answers and ranking are untouched.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildVocabulary, resilientSearch, type SearchableFood,
} from '@macros/domain-food-search';
import { CORPUS, type GoldenQuery } from './search-corpus.js';
import { repoPath } from './repo-paths.js';

const GENERIC = repoPath('data', 'usda-seed.json');
const AUTHORITY = repoPath('data', 'offline-bundle', 'authority');
const OUT = repoPath('data', 'search-benchmark.json');

/** How many branded shards to load. All 257 exceed the heap; 60 is ~96k foods. */
const SHARD_LIMIT = Number(process.env['MACROS_BENCH_SHARDS'] ?? 60);

interface Row {
  readonly displayName: string;
  readonly brandName: string | null;
  readonly preparationState: string;
}

function loadCatalog(): SearchableFood[] {
  const catalog: SearchableFood[] = [];

  for (const item of JSON.parse(readFileSync(GENERIC, 'utf8')) as Record<string, unknown>[]) {
    catalog.push({
      productId: String(item['productId']),
      productVersionId: `${String(item['productId'])}@v1`,
      displayName: String(item['displayName'] ?? ''),
      preparationState: String(item['preparationState'] ?? 'as_sold'),
      aliases: (item['aliases'] as string[] | undefined) ?? [],
    } as unknown as SearchableFood);
  }

  const shards = readdirSync(AUTHORITY).filter((f) => f.startsWith('branded-')).sort();
  for (const shard of shards.slice(0, SHARD_LIMIT)) {
    const text = readFileSync(join(AUTHORITY, shard), 'utf8');
    for (const line of text.split('\n')) {
      if (line.length === 0) continue;
      const v = JSON.parse(line) as Row & Record<string, unknown>;
      // The ranker treats brandName as optional, not nullable: passing null
      // reaches normalizeText and throws. Omit the key when there is no brand.
      const brand = typeof v.brandName === 'string' && v.brandName.length > 0
        ? { brandName: v.brandName } : {};
      catalog.push({
        productId: String(v['productId']),
        productVersionId: String(v['productVersionId']),
        displayName: v.displayName ?? '',
        ...brand,
        preparationState: v.preparationState ?? 'as_sold',
        aliases: [],
      } as unknown as SearchableFood);
    }
  }
  return catalog;
}

const haystack = (r: { displayName: string; brandName?: string | null }): string =>
  `${r.displayName} ${r.brandName ?? ''}`.toLowerCase();

const relevant = (r: never, q: GoldenQuery): boolean => {
  const hay = haystack(r as never);
  if (q.forbidden.some((f) => hay.includes(f))) return false;
  return q.requiredAny.every((group) => hay.includes(group));
};

const forbiddenHit = (r: never, q: GoldenQuery): boolean =>
  q.forbidden.some((f) => haystack(r as never).includes(f));

function main(): void {
  process.stderr.write('loading catalog …\n');
  const catalog = loadCatalog();
  const vocabulary = buildVocabulary(catalog);
  process.stderr.write(
    `  ${catalog.length.toLocaleString()} records, `
    + `${vocabulary.terms.size.toLocaleString()} vocabulary terms\n`);

  const results: Record<string, unknown>[] = [];
  let totalMs = 0;

  for (const q of CORPUS) {
    const started = performance.now();
    const response = resilientSearch(catalog, vocabulary, { text: q.query, limit: 3 });
    totalMs += performance.now() - started;

    const top = response.results.map((r) => r.productVersion as never);
    const confidence = response.confidence;

    const top1Relevant = top.length > 0 && relevant(top[0]!, q);
    const top3Relevant = top.some((r) => relevant(r, q));

    // UNSAFE: a CONFIDENT answer that is materially the wrong food, or any
    // confident answer to a query nothing should match.
    const unsafeWrong = confidence === 'confident' && top.length > 0
      && (forbiddenHit(top[0]!, q) || q.expectation === 'absent');

    results.push({
      query: q.query, category: q.category, expectation: q.expectation,
      confidence, resultCount: response.results.length,
      noResult: response.results.length === 0,
      top1Relevant, top3Relevant, unsafeWrong,
      corrections: response.corrections.map((c) => [c.from, c.to]),
      didYouMean: response.didYouMean,
      top3: top.map((r) => ({
        name: (r as unknown as Row).displayName,
        brand: (r as unknown as Row).brandName ?? null,
        prep: (r as unknown as Row).preparationState,
      })),
    });
  }

  const n = results.length;
  const resolvable = results.filter((r) => r['expectation'] !== 'absent');
  const pct = (count: number, denom: number): number =>
    denom === 0 ? 0 : Math.round((1000 * count) / denom) / 10;

  interface CategoryStats {
    n: number; top1: number; top3: number; none: number; unsafe: number;
  }
  const byCategory: Record<string, CategoryStats> = {};
  for (const r of results) {
    const key = r['category'] as string;
    const c = byCategory[key] ?? { n: 0, top1: 0, top3: 0, none: 0, unsafe: 0 };
    c.n += 1;
    if (r['top1Relevant'] === true) c.top1 += 1;
    if (r['top3Relevant'] === true) c.top3 += 1;
    if (r['noResult'] === true) c.none += 1;
    if (r['unsafeWrong'] === true) c.unsafe += 1;
    byCategory[key] = c;
  }

  const summary = {
    benchmarkVersion: 'search-quality@3.0.0-runtime',
    runsProductionCode: true,
    corpusSize: n,
    searchableRecords: catalog.length,
    vocabularyTerms: vocabulary.terms.size,
    shardsLoaded: SHARD_LIMIT,
    top1RelevancePercent: pct(resolvable.filter((r) => r['top1Relevant']).length, resolvable.length),
    top3RelevancePercent: pct(resolvable.filter((r) => r['top3Relevant']).length, resolvable.length),
    noResultPercent: pct(results.filter((r) => r['noResult']).length, n),
    unsafeWrongResultPercent: pct(results.filter((r) => r['unsafeWrong']).length, n),
    ambiguityPercent: pct(results.filter((r) => r['confidence'] === 'ambiguous').length, n),
    didYouMeanPercent: pct(results.filter((r) => r['confidence'] === 'did_you_mean').length, n),
    confidencePercent: pct(results.filter((r) => r['confidence'] === 'confident').length, n),
    meanSearchMs: Math.round((totalMs / n) * 10) / 10,
    byCategory,
    queries: results,
  };

  writeFileSync(OUT, `${JSON.stringify(summary, null, 2)}\n`);

  console.log(`\ncorpus            : ${n} queries (${resolvable.length} resolvable)`);
  console.log(`records searched  : ${catalog.length.toLocaleString()}`);
  console.log(`top-1 relevance   : ${summary.top1RelevancePercent}%`);
  console.log(`top-3 relevance   : ${summary.top3RelevancePercent}%`);
  console.log(`no-result         : ${summary.noResultPercent}%`);
  console.log(`UNSAFE WRONG      : ${summary.unsafeWrongResultPercent}%`);
  console.log(`ambiguous         : ${summary.ambiguityPercent}%`);
  console.log(`mean search       : ${summary.meanSearchMs} ms`);
  console.log('\nby category:');
  for (const [c, v] of Object.entries(byCategory).sort()) {
    console.log(`  ${c.padEnd(18)} n=${String(v.n).padStart(3)} `
      + `top1=${String(v.top1).padStart(3)} top3=${String(v.top3).padStart(3)} `
      + `none=${String(v.none).padStart(2)} unsafe=${v.unsafe}`);
  }
  const named = results.filter((r) =>
    ['chiken breast', 'brocoli', 'pb'].includes(r['query'] as string));
  console.log('\nrequired proofs:');
  for (const r of named) {
    const top = (r['top3'] as { name: string }[])[0]?.name ?? '(none)';
    console.log(`  ${String(r['query']).padEnd(16)} ${String(r['confidence']).padEnd(13)} `
      + `-> ${top.slice(0, 42)}`);
  }
}

main();
