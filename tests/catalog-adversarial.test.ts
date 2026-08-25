import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildSearchProjection, KNOWN_SOURCES, isPublishable } from '@macros/domain-catalog';
import { searchFood } from '@macros/domain-food-search';
import { SYNTHETIC_PRODUCTS, SYNTHETIC_CATALOG_HEADS } from '@macros/testkit';

const ROOT = new URL('..', import.meta.url).pathname;

const catalogOf = (aliasSets: Parameters<typeof buildSearchProjection>[0]['aliasSets']) =>
  buildSearchProjection({ versions: SYNTHETIC_PRODUCTS, heads: SYNTHETIC_CATALOG_HEADS, aliasSets });

const CATALOG = catalogOf(
  (JSON.parse(readFileSync(join(ROOT, 'data/catalog/aliases/synthetic-aliases.json'), 'utf8')) as {
    aliasSets: Parameters<typeof buildSearchProjection>[0]['aliasSets'];
  }).aliasSets,
);

/**
 * §49 adversarial review, as executable checks rather than assertions in prose.
 * Each test is one of the questions the milestone required be answered.
 */
describe('§49 — can an alias point search at the wrong food?', () => {
  test('a misdirected alias cannot outrank an exact name match', () => {
    // A deliberately wrong alias: rice is aliased to "chicken".
    const sabotaged = catalogOf([
      { productId: 'syn-white-rice', aliases: ['chicken'], curatedBy: 'x', curatedAt: 'y' },
    ]);
    const top = searchFood(sabotaged, { text: 'Chicken breast, cooked', limit: 4 })[0]!;
    assert.equal(
      top.productVersion.productVersionId,
      'syn-chicken-breast@cooked-v1',
      'an exact canonical-name match must beat any alias',
    );
  });

  test('an alias widens reach but never changes what a version means', () => {
    const sabotaged = catalogOf([
      { productId: 'syn-white-rice', aliases: ['chicken'], curatedBy: 'x', curatedAt: 'y' },
    ]);
    const rice = sabotaged.find((d) => d.productId === 'syn-white-rice')!;
    const pristine = CATALOG.find((d) => d.productId === 'syn-white-rice')!;
    assert.equal(rice.productVersionId, pristine.productVersionId);
    assert.equal(rice.displayName, pristine.displayName);
  });
});

describe('§49 — can two different foods collapse because names match?', () => {
  test('same display name with different preparation stays two search results', () => {
    const twins = catalogOf([]).map((d) => ({ ...d, displayName: 'Chicken breast' }));
    const results = searchFood(twins, { text: 'chicken breast', limit: 4 });
    const states = new Set(results.map((r) => r.productVersion.preparationState));
    assert.ok(states.size > 1, 'raw and cooked must not merge into one option');
    assert.equal(
      new Set(results.map((r) => r.productVersion.productVersionId)).size,
      results.length,
      'every option is a distinct version',
    );
  });
});

describe('§49 — licence and provenance cannot be inferred', () => {
  test('every registered source carries an explicit verification record', () => {
    for (const s of KNOWN_SOURCES) {
      assert.ok(s.licenseVerification !== undefined, `${s.sourceKey} must record who verified it`);
      assert.ok(isPublishable(s));
    }
  });

  test('the registry records blocked sources rather than silently omitting them', () => {
    const registry = JSON.parse(
      readFileSync(join(ROOT, 'data/catalog/source-registry/registry.json'), 'utf8'),
    ) as { $blocked: Record<string, string> };
    for (const key of ['open_food_facts', 'retailers_manufacturers', 'commercial_databases', 'images', 'usda_branded']) {
      assert.ok(registry.$blocked[key] !== undefined, `${key} must be explicitly recorded as blocked`);
    }
  });

  test('no synthetic fixture claims a USDA source kind', () => {
    for (const v of SYNTHETIC_PRODUCTS) {
      assert.ok(
        !v.source.kind.startsWith('usda'),
        `${v.productVersionId} must not claim USDA provenance`,
      );
    }
  });
});

describe('§49 — de-listed and historical versions', () => {
  test('an inactive head hides the food from search but not from resolution', () => {
    const inactive = SYNTHETIC_CATALOG_HEADS.filter((h) => !h.isActive);
    assert.ok(inactive.length > 0, 'the fixture set includes a de-listed product');
    for (const head of inactive) {
      assert.ok(
        !CATALOG.some((d) => d.productVersionId === head.currentProductVersionId),
        'a de-listed food must not appear in search',
      );
      assert.ok(
        SYNTHETIC_PRODUCTS.some((v) => v.productVersionId === head.currentProductVersionId),
        'but a historical log referencing it must still resolve',
      );
    }
  });
});
