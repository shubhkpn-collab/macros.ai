import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { searchFood, normalizeText, tokenize } from '@macros/domain-food-search';
import { SYNTHETIC_PRODUCTS } from '@macros/testkit';
import type { ProductVersion } from '@macros/contracts';

const CATALOG = SYNTHETIC_PRODUCTS;
const names = (q: string, limit = 4) =>
  searchFood(CATALOG, { text: q, limit }).map((r) => r.productVersion.displayName);

describe('normalization', () => {
  test('case, whitespace and punctuation are normalized', () => {
    assert.equal(normalizeText('  Chicken   BREAST,  cooked '), 'chicken breast cooked');
    assert.deepEqual(tokenize('Chicken Breast, Cooked'), ['chicken', 'breast', 'cooked']);
  });

  test('an empty or whitespace query returns nothing — never a guess', () => {
    assert.deepEqual(searchFood(CATALOG, { text: '' }), []);
    assert.deepEqual(searchFood(CATALOG, { text: '   ' }), []);
  });
});

describe('matching', () => {
  test('exact display name wins', () => {
    const results = searchFood(CATALOG, { text: 'Chicken breast, cooked' });
    assert.equal(results[0]!.productVersion.displayName, 'Chicken breast, cooked');
    assert.equal(results[0]!.matchKind, 'exact');
  });

  test('prefix match', () => {
    assert.ok(names('chicken breast').length > 0);
    assert.ok(names('chicken breast').every((n) => n.toLowerCase().startsWith('chicken breast')));
  });

  test('token match finds a word anywhere in the name', () => {
    assert.ok(names('cooked').some((n) => n.toLowerCase().includes('cooked')));
  });

  test('case-insensitive and whitespace-tolerant', () => {
    assert.deepEqual(names('CHICKEN'), names('  chicken  '));
  });

  test('brand match', () => {
    const branded = CATALOG.find((p: ProductVersion) => p.brandName !== undefined)!;
    const results = searchFood(CATALOG, { text: branded.brandName! });
    assert.ok(results.some((r) => r.productVersion.productVersionId === branded.productVersionId));
  });

  test('an unmatched token disqualifies the product — no partial guessing', () => {
    assert.deepEqual(searchFood(CATALOG, { text: 'chicken zzzz' }), []);
  });

  test('no results for nonsense', () => {
    assert.deepEqual(names('qwertyuiop'), []);
  });
});

describe('raw vs cooked ambiguity', () => {
  test('both variants surface and are distinguishable', () => {
    const results = searchFood(CATALOG, { text: 'chicken breast' });
    const states = results.map((r) => r.productVersion.preparationState);
    assert.ok(states.includes('cooked') && states.includes('raw'));
    assert.ok(
      results.every((r) => r.preparationStateDisambiguates),
      'preparation state must be flagged as the distinguishing fact',
    );
  });

  test('they remain distinct product versions — never yield-converted', () => {
    const results = searchFood(CATALOG, { text: 'chicken breast' });
    const ids = new Set(results.map((r) => r.productVersion.productVersionId));
    assert.equal(ids.size, results.length);
  });
});

describe('determinism', () => {
  test('identical catalog and query produce identical ranking', () => {
    const a = searchFood(CATALOG, { text: 'chicken' });
    const b = searchFood(CATALOG, { text: 'chicken' });
    assert.deepEqual(a.map((r) => r.productVersion.productVersionId), b.map((r) => r.productVersion.productVersionId));
  });

  test('catalog input order does not change the result order', () => {
    const forward = searchFood(CATALOG, { text: 'chicken' });
    const reversed = searchFood([...CATALOG].reverse(), { text: 'chicken' });
    assert.deepEqual(
      forward.map((r) => r.productVersion.productVersionId),
      reversed.map((r) => r.productVersion.productVersionId),
      'ranking must not depend on iteration accidents',
    );
  });

  test('ties break by displayName then productVersionId', () => {
    const tie: ProductVersion[] = [
      { ...CATALOG[0]!, productVersionId: 'zzz@v1', displayName: 'Tie food' },
      { ...CATALOG[0]!, productVersionId: 'aaa@v1', displayName: 'Tie food' },
    ];
    const results = searchFood(tie, { text: 'tie food' });
    assert.deepEqual(results.map((r) => r.productVersion.productVersionId), ['aaa@v1', 'zzz@v1']);
  });

  test('recency nudges but never outranks a better textual match', () => {
    const raw = CATALOG.find((p: ProductVersion) => p.preparationState === 'raw')!;
    const withHistory = searchFood(CATALOG, {
      text: 'Chicken breast, cooked',
      recentProductVersionIds: [raw.productVersionId],
    });
    assert.equal(withHistory[0]!.productVersion.displayName, 'Chicken breast, cooked');
  });
});

describe('A/B/C/D selection labels', () => {
  test('results carry stable spoken option labels', () => {
    const results = searchFood(CATALOG, { text: 'chicken' });
    assert.deepEqual(results.map((r) => r.optionLabel), ['A', 'B', 'C', 'D'].slice(0, results.length));
  });

  test('at most four options are offered by default', () => {
    assert.ok(searchFood(CATALOG, { text: 'c' }).length <= 4);
  });
});

describe('catalog head governs searchability', () => {
  test('a de-listed product never appears in results but stays resolvable', async () => {
    const { InMemoryProductVersionRepository } = await import('@macros/persistence');
    const { SYNTHETIC_CATALOG_HEADS } = await import('@macros/testkit');
    const repo = new InMemoryProductVersionRepository(CATALOG, SYNTHETIC_CATALOG_HEADS);

    const searchable = await repo.listSearchable();
    const oil = CATALOG.find((p: ProductVersion) => p.displayName === 'Olive oil')!;

    assert.ok(
      !searchable.some((v) => v.productVersionId === oil.productVersionId),
      'a de-listed product is not searchable',
    );
    assert.deepEqual(searchFood(searchable, { text: 'olive' }), []);

    // But a historical log referencing it must still resolve forever.
    assert.notEqual(await repo.getVersion(oil.productVersionId), null);
  });
});
