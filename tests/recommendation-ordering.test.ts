import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { repoPath } from '../tools/repo-paths.js';

const evaluation = () => JSON.parse(
  readFileSync(repoPath('data', 'recommendation-evaluation.json'), 'utf8'));

describe('ordering contract — the two stages are distinguishable', () => {
  test('base nutritional ordering is intact', () => {
    // Every item that was NOT promoted descends by baseScore.
    assert.equal(evaluation().baseRankingIntegrityPercent, 100);
  });

  test('final ordering matches the documented contract', () => {
    assert.equal(evaluation().finalOrderingIntegrityPercent, 100);
  });

  test('no CRITICAL ranking failure remains', () => {
    // The owner's run produced 432 of these against the old check.
    const counts = evaluation().failureCounts as Record<string, number>;
    assert.equal(counts['CRITICAL:ranking_not_monotonic'], undefined);
  });

  test('the ambiguous metric name is gone', () => {
    // "ranking monotonic" never said WHICH ranking, which is how a 70% result
    // could sit next to a green report.
    const e = evaluation();
    assert.equal(e.rankingMonotonicPercent, undefined);
    assert.equal(e.orderingContractChecked,
      'base_score_desc_with_single_actionability_promotion');
  });

  test('the contract is exposed on the returned set, not implied', () => {
    const contracts = readFileSync(
      repoPath('packages', 'domain-recommendation', 'src', 'contracts.ts'), 'utf8');
    assert.match(contracts, /orderingContract/);
    assert.match(contracts, /readonly baseScore: number/);
    assert.match(contracts, /readonly promotedForActionability: boolean/);
    assert.match(contracts, /readonly finalRank: number/);
  });

  test('promotion is inspectable from the returned data alone', () => {
    const engine = readFileSync(
      repoPath('packages', 'domain-recommendation', 'src', 'engine.ts'), 'utf8');
    assert.match(engine, /promotedForActionability: r\.productVersionId === promotedId/);
    assert.match(engine, /finalRank: index/);
  });
});

describe('ordering fix changed NO recommendation behaviour', () => {
  test('every one of the 1,728 winners is byte-identical', () => {
    // A contract fix must not move a single food. Captured before the edit and
    // compared after.
    const before = JSON.parse(readFileSync(
      repoPath('data', 'recommendation-winners-baseline.json'), 'utf8')) as Record<string, string>;
    const after = JSON.parse(readFileSync(
      repoPath('data', 'recommendation-winners.json'), 'utf8')) as Record<string, string>;
    assert.equal(Object.keys(before).length, 1728);
    const changed = Object.keys(before).filter((k) => before[k] !== after[k]);
    assert.deepEqual(changed, [], `${changed.length} winners moved`);
  });

  test('the frozen nutritional results are unchanged', () => {
    const e = evaluation();
    assert.equal(e.hardViolationRatePercent, 0);
    assert.equal(e.energyFitRatePercent, 100);
    assert.equal(e.macroFitRatePercent, 85);
    assert.equal(e.unnecessaryOvershootRatePercent, 0);
    assert.equal(e.budgetExhaustedHandledHonestly, e.budgetExhaustedScenarios);
  });
});

describe('reporting guard — a silent divergence cannot recur', () => {
  test('both integrity metrics must be PRESENT in every evaluation', () => {
    // The INT-4B report went green partly because this metric was omitted from
    // the summary rather than because it passed. A missing metric now fails.
    const e = evaluation();
    for (const key of ['baseRankingIntegrityPercent', 'finalOrderingIntegrityPercent',
                       'orderingContractChecked']) {
      assert.notEqual(e[key], undefined, `${key} missing from the evaluation output`);
    }
  });

  test('any CRITICAL failure class fails the suite, not just known ones', () => {
    // Previously a CRITICAL count could sit in failureCounts unnoticed. Any
    // CRITICAL key at all is now an assertion failure.
    const counts = evaluation().failureCounts as Record<string, number>;
    const critical = Object.keys(counts).filter((k) => k.startsWith('CRITICAL:'));
    assert.deepEqual(critical, [], `unreported CRITICAL failures: ${critical.join(', ')}`);
  });
});
