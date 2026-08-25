import { searchFood, type SearchableFood } from '@macros/domain-food-search';

/**
 * SEARCH QUALITY BENCHMARK.
 *
 * Hand-authored cases, kept in version control and independent of the ranking
 * implementation. Deriving a benchmark from the catalog and then scoring
 * against it proves nothing; these are queries a person would actually type.
 */
export interface BenchmarkCase {
  readonly query: string;
  readonly category: string;
  /** Any of these counts as a correct answer. */
  readonly acceptableProductVersionIds: readonly string[];
  /** The single best answer, when there is one. */
  readonly preferredProductVersionId?: string;
  /** Results that would be actively wrong — a dangerous false match. */
  readonly mustNotReturn?: readonly string[];
  readonly expectZeroResults?: boolean;
  readonly notes?: string;
}

export interface BenchmarkCorpus {
  readonly corpusVersion: string;
  readonly cases: readonly BenchmarkCase[];
}

/**
 * A metric with no applicable cases is `null`, not 100%.
 *
 * Reporting "zero-result correctness: 100%" when the corpus contained no
 * nonsense queries is a claim about nothing, and it reads exactly like success.
 */
export interface BenchmarkMetrics {
  readonly cases: number;
  readonly scoredCases: number;
  readonly top1HitRate: number | null;
  readonly top4Recall: number | null;
  readonly mrr: number | null;
  readonly zeroResultCorrectness: number | null;
  readonly preparationDisambiguationRate: number | null;
  readonly falsePositiveRate: number | null;
  readonly failures: readonly BenchmarkFailure[];
}

export interface BenchmarkFailure {
  readonly query: string;
  readonly category: string;
  readonly problem:
    | 'missed_top1'
    | 'missed_top4'
    | 'returned_forbidden'
    | 'expected_zero_results'
    | 'unexpected_zero_results';
  readonly returned: readonly string[];
}

/**
 * Deterministic scoring. No hidden cases: every failure is reported, so a poor
 * result cannot be quietly averaged away.
 */
export function runBenchmark(
  corpus: BenchmarkCorpus,
  catalog: readonly SearchableFood[],
): BenchmarkMetrics {
  let top1 = 0, top4 = 0, reciprocalRankTotal = 0;
  let zeroExpected = 0, zeroCorrect = 0;
  let falsePositives = 0, nonsenseCases = 0;
  let disambiguationCases = 0, disambiguationCorrect = 0;
  let scoredCases = 0;
  const failures: BenchmarkFailure[] = [];

  for (const testCase of corpus.cases) {
    const results = searchFood(catalog, { text: testCase.query, limit: 4 });
    const ids = results.map((r) => r.productVersion.productVersionId);

    if (testCase.expectZeroResults === true) {
      zeroExpected += 1;
      nonsenseCases += 1;
      if (ids.length === 0) {
        zeroCorrect += 1;
      } else {
        falsePositives += 1;
        failures.push({ query: testCase.query, category: testCase.category, problem: 'expected_zero_results', returned: ids });
      }
      continue;
    }

    if (testCase.mustNotReturn !== undefined) {
      const forbidden = ids.filter((id) => testCase.mustNotReturn!.includes(id));
      if (forbidden.length > 0) {
        failures.push({ query: testCase.query, category: testCase.category, problem: 'returned_forbidden', returned: ids });
      }
    }

    scoredCases += 1;
    if (ids.length === 0) {
      failures.push({ query: testCase.query, category: testCase.category, problem: 'unexpected_zero_results', returned: [] });
      continue;
    }

    const acceptable = testCase.acceptableProductVersionIds;
    const preferred = testCase.preferredProductVersionId;

    const firstAcceptableIndex = ids.findIndex((id) => acceptable.includes(id));
    if (firstAcceptableIndex >= 0) {
      top4 += 1;
      reciprocalRankTotal += 1 / (firstAcceptableIndex + 1);
    } else {
      failures.push({ query: testCase.query, category: testCase.category, problem: 'missed_top4', returned: ids });
    }

    const target = preferred ?? acceptable[0];
    if (ids[0] !== undefined && (preferred === undefined ? acceptable.includes(ids[0]) : ids[0] === target)) {
      top1 += 1;
    } else {
      failures.push({ query: testCase.query, category: testCase.category, problem: 'missed_top1', returned: ids });
    }

    if (testCase.category === 'preparation_state' || testCase.category === 'raw_cooked_ambiguity') {
      disambiguationCases += 1;
      if (firstAcceptableIndex >= 0) disambiguationCorrect += 1;
    }
  }

  // null means "no applicable cases", never "perfect".
  const rate = (a: number, b: number): number | null => (b === 0 ? null : a / b);

  return {
    cases: corpus.cases.length,
    scoredCases,
    top1HitRate: rate(top1, scoredCases),
    top4Recall: rate(top4, scoredCases),
    mrr: rate(reciprocalRankTotal, scoredCases),
    zeroResultCorrectness: rate(zeroCorrect, zeroExpected),
    preparationDisambiguationRate: rate(disambiguationCorrect, disambiguationCases),
    falsePositiveRate: rate(falsePositives, nonsenseCases),
    failures,
  };
}
