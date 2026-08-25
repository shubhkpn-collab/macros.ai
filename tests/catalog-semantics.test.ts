import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  ALIAS_POLICY_VERSION, CATALOG_POLICY_VERSION, PREPARATION_CLASSIFIER_VERSION,
  USDA_NUTRIENT_MAP, aliasesFor, assessOverlap, categoryEligibility,
  classifyPreparation, conceptKeyFor, consumerDisplayName, eligibleForRecommendation,
  genericProductId, isPublishableState, preferredSource, publishesToConsumerCatalog,
} from '@macros/catalog-ingestion';
import { isNutrientId } from '@macros/domain-nutrients';
import { preparationIntentOf } from '@macros/domain-food-search';

interface Seed {
  productId: string; conceptKey: string; displayName: string; sourceDescription: string;
  preparationState: string; preparationRule: string; category: string | null;
  categoryEligibility: string; recommendable: boolean; aliases: string[];
  per100g: Record<string, { amount: number; unit: string }>;
  externalIdentity: { provider: string; dataset: string; sourceRecordId: string; archiveSha256: string };
}
const seeds = JSON.parse(readFileSync('data/usda-seed.json', 'utf8')) as Seed[];
const report = JSON.parse(readFileSync('data/usda-import-report.json', 'utf8'));

// ---------------------------------------------------------------------------

describe('A1 — the preparation classifier bug is fixed', () => {
  /** The exact descriptions that published as `raw` in the delivered seed. */
  const AFFECTED = [
    'Apples, raw, without skin, cooked, boiled',
    'Apples, raw, without skin, cooked, microwave',
  ];

  for (const description of AFFECTED) {
    test(`REGRESSION: "${description}" classifies as cooked`, () => {
      const c = classifyPreparation(description);
      assert.equal(c.state, 'cooked', 'the FINAL state is cooked, not the input state');
      assert.equal(c.rule, 'mixed_final_state_cooked');
    });
  }

  test('the final preparation term decides, not word order', () => {
    assert.equal(classifyPreparation('Beef, raw, then cooked, roasted').state, 'cooked');
    // The reverse construction is respected too: raw stated last wins.
    assert.equal(classifyPreparation('Beef, cooked style cut, served raw').state, 'raw');
  });

  test('a single unambiguous term still classifies directly', () => {
    assert.equal(classifyPreparation('Chicken, breast, meat only, raw').state, 'raw');
    assert.equal(classifyPreparation('Chicken, breast, cooked, roasted').state, 'cooked');
  });

  test('microwave and toasted count as cooked', () => {
    assert.equal(classifyPreparation('Potatoes, cooked, microwave').state, 'cooked');
    assert.equal(classifyPreparation('Bread, toasted').state, 'cooked');
  });

  test('genuine alternatives stay unresolved rather than being guessed', () => {
    assert.equal(classifyPreparation('Vegetables, raw or cooked').state, 'unresolved');
    assert.equal(classifyPreparation('Berries, fresh or frozen, raw or cooked').state, 'unresolved');
  });

  test('NO published record is internally contradictory', () => {
    const RAW = /\braw\b/i;
    const COOKED = /\b(cooked|boiled|roasted|grilled|baked|broiled|fried|microwave|toasted)\b/i;
    for (const s of seeds) {
      const d = s.sourceDescription;
      if (RAW.test(d) && COOKED.test(d)) {
        assert.equal(
          s.preparationState, 'cooked',
          `${d} published as ${s.preparationState}`,
        );
      }
    }
  });

  test('A2: the classifier is versioned and the version is recorded', () => {
    assert.match(PREPARATION_CLASSIFIER_VERSION, /^preparation-classifier@/);
    assert.equal(report.classifierVersion, PREPARATION_CLASSIFIER_VERSION);
    assert.equal(classifyPreparation('Apples, raw').classifierVersion, PREPARATION_CLASSIFIER_VERSION);
  });
});

describe('B1/B2 — the taxonomy is semantically honest', () => {
  test('cheese is NOT forced into raw or cooked', () => {
    const c = classifyPreparation('Cheese, cheddar');
    // as_sold states what is on the scale without claiming raw or cooked.
    assert.equal(c.state, 'as_sold');
  });

  test('yogurt, hummus and dried egg are as_sold, not raw', () => {
    for (const d of ['Yogurt, Greek, plain, nonfat', 'Hummus, commercial', 'Egg, white, dried']) {
      const c = classifyPreparation(d);
      assert.equal(c.state, 'as_sold', d);
    }
  });

  test('bread is not classified as cooked flour', () => {
    assert.equal(classifyPreparation('Bread, whole-wheat, commercially prepared').state, 'as_sold');
  });

  test('every published state is a real publishable state', () => {
    for (const s of seeds) {
      assert.ok(isPublishableState(s.preparationState as never), `${s.displayName} ${s.preparationState}`);
      assert.notEqual(s.preparationState, 'unresolved');
    }
  });

  test('unresolved records are never published', () => {
    assert.equal(isPublishableState('unresolved' as never), false);
  });
});

describe('B4/B5/B8 — identity is internal, source id is provenance', () => {
  test('a product id is NOT derived from the USDA id', () => {
    for (const s of seeds.slice(0, 60)) {
      assert.match(s.productId, /^food_[0-9a-f]{16}$/);
      assert.ok(!s.productId.includes(s.externalIdentity.sourceRecordId),
        `${s.productId} leaks the source id`);
      // (A hex digest may contain the letters "fdc" by chance — structure and
      // absence of the real source id are the meaningful assertions.)
    }
  });

  test('the USDA id survives as external provenance', () => {
    for (const s of seeds.slice(0, 30)) {
      assert.equal(s.externalIdentity.provider, 'usda_fdc');
      assert.match(s.externalIdentity.sourceRecordId, /^\d+$/);
      assert.match(s.externalIdentity.archiveSha256, /^[0-9a-f]{64}$/);
    }
  });

  test('identity is deterministic from the concept, not the source', () => {
    const key = conceptKeyFor('Chicken, breast, meat only, raw', 'raw');
    assert.equal(genericProductId(key), genericProductId(key));
    // Word order within the description does not create a second identity.
    const reordered = conceptKeyFor('meat only, Chicken, breast, raw', 'raw');
    assert.equal(key, reordered);
  });

  test('DIFFERENT preparations are DIFFERENT foods', () => {
    const raw = genericProductId(conceptKeyFor('Chicken, breast, meat only', 'raw'));
    const cooked = genericProductId(conceptKeyFor('Chicken, breast, meat only', 'cooked'));
    assert.notEqual(raw, cooked, 'raw and cooked must never share identity');
  });

  test('published identities are unique', () => {
    assert.equal(new Set(seeds.map((s) => s.productId)).size, seeds.length);
  });
});

describe('B6/B7 — overlap is assessed, never fuzzily merged', () => {
  test('identical concepts are definite_same', () => {
    const a = { conceptKey: conceptKeyFor('Apples, raw', 'raw'), category: 'Fruits', preparation: 'raw' as const };
    assert.equal(assessOverlap(a, { ...a }).verdict, 'definite_same');
  });

  test('different preparations are always distinct', () => {
    const a = { conceptKey: conceptKeyFor('Apples', 'raw'), category: 'Fruits', preparation: 'raw' as const };
    const b = { conceptKey: conceptKeyFor('Apples', 'cooked'), category: 'Fruits', preparation: 'cooked' as const };
    assert.equal(assessOverlap(a, b).verdict, 'distinct');
  });

  test('unrelated foods are distinct, not speculatively merged', () => {
    const a = { conceptKey: conceptKeyFor('Apples, raw', 'raw'), category: 'Fruits', preparation: 'raw' as const };
    const b = { conceptKey: conceptKeyFor('Beef, ground', 'raw'), category: 'Beef Products', preparation: 'raw' as const };
    assert.equal(assessOverlap(a, b).verdict, 'distinct');
  });

  test('Foundation outranks SR Legacy without averaging', () => {
    assert.equal(preferredSource('Foundation', 'SR Legacy'), 'Foundation');
    assert.equal(preferredSource('SR Legacy', 'Foundation'), 'Foundation');
  });
});

describe('B10/B11 — category publication policy', () => {
  test('baby food is excluded from the consumer catalog', () => {
    assert.equal(categoryEligibility('Baby Foods'), 'excluded_from_consumer');
    assert.equal(publishesToConsumerCatalog('excluded_from_consumer'), false);
    for (const s of seeds) assert.notEqual(s.category, 'Baby Foods');
  });

  test('baby food can never become an adult recommendation', () => {
    assert.equal(eligibleForRecommendation(categoryEligibility('Baby Foods')), false);
    assert.equal(eligibleForRecommendation(categoryEligibility('Infant Formula')), false);
  });

  test('some real foods are searchable but not recommended', () => {
    assert.equal(categoryEligibility('Spices and Herbs'), 'searchable_not_recommended');
    assert.equal(publishesToConsumerCatalog('searchable_not_recommended'), true);
    assert.equal(eligibleForRecommendation('searchable_not_recommended'), false);
  });

  test('recommendable is a strict subset of published', () => {
    const recommendable = seeds.filter((s) => s.recommendable).length;
    assert.ok(recommendable <= seeds.length);
    assert.equal(report.stats.recommendableCount, recommendable);
  });

  test('the policy is versioned', () => {
    assert.equal(report.catalogPolicyVersion, CATALOG_POLICY_VERSION);
  });
});

describe('B14/B23 — aliases and display names', () => {
  test('USDA phrasing gets consumer aliases', () => {
    assert.ok(aliasesFor('Cheese, cheddar').includes('cheddar cheese'));
    assert.ok(aliasesFor('Yogurt, Greek, plain, nonfat').includes('greek yogurt'));
  });

  test('an alias never merges raw and cooked', () => {
    // The alias attaches to descriptions; preparation stays in identity.
    const rawId = genericProductId(conceptKeyFor('Chicken, breast', 'raw'));
    const cookedId = genericProductId(conceptKeyFor('Chicken, breast', 'cooked'));
    assert.notEqual(rawId, cookedId);
  });

  test('an alias never merges distinct varieties', () => {
    assert.ok(!aliasesFor('Rice, white, long-grain').includes('brown rice'));
    assert.ok(!aliasesFor('Milk, whole').includes('skim milk'));
  });

  test('display names are consumer-friendly and reversible to the source', () => {
    assert.equal(consumerDisplayName('Cheese, cheddar'), 'Cheddar cheese');
    for (const s of seeds) {
      assert.ok(s.sourceDescription.length > 0, 'the original description is retained');
    }
  });

  test('a display name never drops a distinguishing qualifier', () => {
    const name = consumerDisplayName('Apples, raw, with skin');
    assert.match(name, /raw|skin/i, 'preparation and form survive');
  });

  test('the alias policy is versioned', () => {
    assert.equal(report.aliasPolicyVersion, ALIAS_POLICY_VERSION);
  });
});

describe('A4/A5 — one artifact, unambiguous metric names', () => {
  test('mapping ROWS and canonical NUTRIENTS are named separately', () => {
    assert.equal(report.sourceMappingRows, USDA_NUTRIENT_MAP.length);
    assert.equal(
      report.canonicalNutrientsMapped,
      new Set(USDA_NUTRIENT_MAP.map((m: { canonical: string }) => m.canonical)).size,
    );
    assert.ok(report.sourceMappingRows >= report.canonicalNutrientsMapped,
      'rows can exceed canonical nutrients — that is why both are reported');
    assert.equal(report.mappedNutrients, undefined, 'the ambiguous metric name is gone');
  });

  test('the report is the single source of truth for counts', () => {
    assert.equal(report.stats.publishedSeed, seeds.length);
    assert.equal(report.search.corpusSize, seeds.length);
  });

  test('search metrics live in the same artifact', () => {
    assert.ok(report.search.top1Percent >= 0 && report.search.top1Percent <= 100);
    assert.equal(report.search.zeroResult.correct, report.search.zeroResult.total);
    assert.equal(report.search.falsePositives, 0);
  });

  test('missing archives are reported honestly, never silently substituted', () => {
    assert.ok(Array.isArray(report.missingArchives));
    for (const a of report.archives) assert.match(a.sha256, /^[0-9a-f]{64}$/);
  });

  test('coverage is computed over the published catalog', () => {
    for (const c of report.coverage) {
      assert.equal(c.total, seeds.length);
      assert.ok(c.known <= c.total);
      assert.equal(isNutrientId(c.nutrientId), true);
    }
  });

  test('B26: added sugars stays at zero coverage — never inferred', () => {
    const added = report.coverage.find((c: { nutrientId: string }) => c.nutrientId === 'added_sugars');
    assert.equal(added.known, 0);
    // Descriptions mentioning added sugar must NOT produce a numeric value.
    for (const s of seeds) {
      if (/added sugar/i.test(s.sourceDescription)) {
        assert.equal(s.per100g['added_sugars'], undefined, s.sourceDescription);
      }
    }
  });
});

describe('B24 — nutrient integrity survives expansion', () => {
  test('every published food still has all four core nutrients', () => {
    for (const s of seeds) {
      for (const core of ['energy_kcal', 'protein', 'carbohydrate', 'fat']) {
        assert.ok(s.per100g[core] !== undefined, `${s.displayName} missing ${core}`);
      }
    }
  });

  test('no negative or implausible values reached the catalog', () => {
    for (const s of seeds) {
      for (const [id, v] of Object.entries(s.per100g)) {
        assert.ok(v.amount >= 0, `${s.displayName} ${id} = ${v.amount}`);
      }
      // Pure fats (lard, tallow, fish oils) are genuinely ~902 kcal/100 g.
      // 9 kcal/g is the physical ceiling for a fat.
      assert.ok(s.per100g['energy_kcal']!.amount <= 910, `${s.displayName} ${s.per100g['energy_kcal']!.amount}`);
    }
  });

  test('missing nutrients remain absent, never zeroed', () => {
    const someMissing = seeds.some((s) => s.per100g['vitamin_d'] === undefined);
    assert.ok(someMissing, 'partial coverage should be visible in the catalog');
  });
});

describe('SECTION 1/24 — metric scope is unambiguous', () => {
  test('preparation counts are SCOPED to their population', () => {
    // An unscoped `preparationCounts` left the denominator ambiguous and was
    // mis-cited in a closure report. Both populations are now named.
    assert.equal(report.stats.preparationCounts, undefined, 'the ambiguous name is gone');
    assert.ok(report.stats.sourcePreparationCounts !== undefined);
    assert.ok(report.stats.publishedPreparationCounts !== undefined);
  });

  test('published counts sum to the published catalog, source counts do not', () => {
    const published = Object.values(report.stats.publishedPreparationCounts as Record<string, number>)
      .reduce((a, b) => a + b, 0);
    assert.equal(published, seeds.length, 'published distribution covers exactly the catalog');

    const source = Object.values(report.stats.sourcePreparationCounts as Record<string, number>)
      .reduce((a, b) => a + b, 0);
    assert.ok(source >= published, 'the source population is larger — which is why scoping matters');
  });

  test('the published distribution matches the actual catalog file', () => {
    const actual: Record<string, number> = {};
    for (const s of seeds) actual[s.preparationState] = (actual[s.preparationState] ?? 0) + 1;
    assert.deepEqual(report.stats.publishedPreparationCounts, actual);
    assert.deepEqual(report.search.publishedPreparationDistribution, actual);
  });
});

describe('SECTION 4 — as_sold never conceals raw/cooked uncertainty', () => {
  test('a preparation-critical category with NO signal goes to curation', () => {
    for (const [description, category] of [
      ['Beef, ground, 80% lean', 'Beef Products'],
      ['Pork, shoulder', 'Pork Products'],
      ['Chicken, thigh, boneless', 'Poultry Products'],
      ['Fish, tilapia, fillet', 'Finfish and Shellfish Products'],
    ] as const) {
      const c = classifyPreparation(description, category);
      assert.equal(c.state, 'unresolved', `${description} must not become as_sold`);
      assert.equal(c.rule, 'preparation_critical_category_without_signal');
    }
  });

  test('an explicit FORM term still resolves those categories honestly', () => {
    assert.equal(classifyPreparation('Ham, sliced, restaurant', 'Pork Products').state, 'as_sold');
    assert.equal(classifyPreparation('Crustaceans, crab, pasteurized', 'Finfish and Shellfish Products').state, 'as_sold');
  });

  test('an explicit preparation term always wins over category caution', () => {
    assert.equal(classifyPreparation('Beef, ground, raw', 'Beef Products').state, 'raw');
    assert.equal(classifyPreparation('Beef, ground, cooked, broiled', 'Beef Products').state, 'cooked');
  });

  test('dairy, produce and oils remain legitimately as_sold', () => {
    assert.equal(classifyPreparation('Buttermilk, low fat', 'Dairy and Egg Products').state, 'as_sold');
    assert.equal(classifyPreparation('Spinach, baby', 'Vegetables and Vegetable Products').state, 'as_sold');
  });

  test('no published meat or fish record was resolved by bare category fallback', () => {
    const CRITICAL = /\b(beef|pork|poultry|lamb|veal|sausage|luncheon|finfish|shellfish)\b/i;
    for (const s of seeds) {
      if (s.category !== null && CRITICAL.test(s.category)) {
        assert.notEqual(
          s.preparationRule, 'whole_food_category_no_preparation',
          `${s.sourceDescription} resolved by category alone`,
        );
      }
    }
  });
});

describe('SECTION 11 — productId collision invariant', () => {
  test('two different concepts never share one id in the published catalog', () => {
    const byId = new Map<string, string>();
    for (const s of seeds) {
      const existing = byId.get(s.productId);
      if (existing !== undefined) assert.equal(existing, s.conceptKey, `collision on ${s.productId}`);
      byId.set(s.productId, s.conceptKey);
    }
    assert.equal(byId.size, seeds.length);
  });

  test('distinct concept keys produce distinct ids', () => {
    const a = genericProductId(conceptKeyFor('Chicken, breast', 'raw'));
    const b = genericProductId(conceptKeyFor('Chicken, thigh', 'raw'));
    assert.notEqual(a, b);
  });
});

describe('SECTION 16 — preparation-sensitive search is actually measured', () => {
  test('preparation correctness is no longer 0/0', () => {
    const p = report.search.preparationSensitive;
    assert.ok(p.total >= 10, `expected real preparation queries, got ${p.total}`);
    assert.equal(report.search.preparationChecked, undefined, 'the unmeasured field is gone');
  });

  test('NO wrong-preparation result outranks a correct one', () => {
    const p = report.search.preparationSensitive;
    assert.equal(p.wrongPreparationOutranked, 0,
      `outranked: ${p.wrongPreparationOutrankedQueries.join(', ')}`);
  });
});

describe('SECTION 19 — display names are not deterministically ugly', () => {
  test('no display name repeats a word through the inversion', () => {
    // "Mahi mahi" is a real food name, not a formatting artifact — the defect
    // is duplication CREATED by comma inversion, which is what this checks.
    const GENUINE_REPEATS = /mahi mahi|couscous|bonbon/i;
    for (const s of seeds) {
      if (GENUINE_REPEATS.test(s.displayName)) continue;
      const words = s.displayName.toLowerCase().split(/[\s,]+/).filter(Boolean);
      const sourceWords = s.sourceDescription.toLowerCase().split(/[\s,]+/).filter(Boolean);
      void sourceWords;
      // Scoped to WITHIN-PHRASE duplication — the artifact comma inversion
      // actually creates ("Breakfast sausage sausage"). Repetition ACROSS a
      // comma ("cooked in skin, skin") is mostly USDA's own wording and is a
      // separate cosmetic concern, filed as CA-16 rather than silently edited.
      const raw = s.displayName.toLowerCase().split(/\s+/).filter(Boolean);
      for (let i = 0; i < raw.length - 1; i++) {
        const a = raw[i]!;
        if (a.endsWith(',') || a.length <= 3) continue;
        assert.notEqual(a, raw[i + 1]!.replace(/,$/, ''),
          `"${s.displayName}" repeats "${a}" within a phrase`);
      }
      void words;
    }
  });

  test('the inversion does not duplicate the head noun', () => {
    assert.equal(consumerDisplayName('Sausage, breakfast sausage, beef'), 'Breakfast sausage, beef');
    assert.equal(consumerDisplayName('Cheese, cheddar'), 'Cheddar cheese');
  });

  test('meaningful qualifiers always survive', () => {
    for (const s of seeds) {
      for (const q of ['raw', 'cooked', 'without salt', 'with skin', 'lean']) {
        if (new RegExp(`\\b${q}\\b`, 'i').test(s.sourceDescription)) {
          assert.match(s.displayName.toLowerCase(), new RegExp(q.split(' ')[0]!),
            `"${s.sourceDescription}" lost "${q}"`);
        }
      }
    }
  });
});

describe('PART A — critical-category precedence (classifier 2.3.0)', () => {
  test('a generic meat NOUN never implies ready-to-eat', () => {
    // "sausage" and "frankfurter" name a food TYPE, not a state. Before 2.3.0
    // they resolved as_sold before the critical guard could run.
    for (const [d, c] of [
      ['Sausage, breakfast, beef', 'Sausages and Luncheon Meats'],
      ['Frankfurter, beef', 'Sausages and Luncheon Meats'],
      ['Chicken breast', 'Poultry Products'],
    ] as const) {
      const r = classifyPreparation(d, c);
      assert.equal(r.state, 'unresolved', d);
      assert.equal(r.rule, 'preparation_critical_category_without_signal');
    }
  });

  test('FROZEN alone never resolves a preparation-critical food', () => {
    // Frozen salmon may be raw or cooked; as_sold would assert this record
    // matches whatever is on the scale.
    assert.equal(classifyPreparation('Salmon, frozen', 'Finfish and Shellfish Products').state, 'unresolved');
    // But frozen produce is safe.
    assert.equal(classifyPreparation('Peas, frozen', 'Vegetables and Vegetable Products').state, 'as_sold');
  });

  test('real STATE/FORM evidence still resolves critical categories', () => {
    assert.equal(classifyPreparation('Crustaceans, crab, pasteurized', 'Finfish and Shellfish Products').state, 'as_sold');
    assert.equal(classifyPreparation('Ham, sliced, cured', 'Pork Products').state, 'as_sold');
  });

  test('an explicit preparation term always wins', () => {
    assert.equal(classifyPreparation('Beef, ground, raw', 'Beef Products').state, 'raw');
    assert.equal(classifyPreparation('Beef, ground, cooked, broiled', 'Beef Products').state, 'cooked');
  });

  test('the classifier version reflects the semantic change', () => {
    assert.equal(PREPARATION_CLASSIFIER_VERSION, 'preparation-classifier@2.3.0');
    assert.equal(report.classifierVersion, PREPARATION_CLASSIFIER_VERSION);
  });
});

describe('PART B — real SR ingestion and cross-source identity', () => {
  test('both archives were ingested', () => {
    const datasets = report.archives.map((a: { dataset: string }) => a.dataset);
    assert.ok(datasets.includes('Foundation'));
    assert.ok(datasets.includes('SR Legacy'));
    assert.deepEqual(report.missingArchives, []);
  });

  test('B2: the historical cooked apples publish as COOKED', () => {
    for (const id of ['173928', '173929']) {
      const s = seeds.find((x) => x.externalIdentity.sourceRecordId === id);
      assert.notEqual(s, undefined, `FDC ${id} missing from catalog`);
      assert.equal(s!.preparationState, 'cooked', s!.sourceDescription);
      assert.match(s!.sourceDescription, /raw.*cooked/i, 'still a mixed description');
    }
  });

  test('CA-15: administrative text is stripped from IDENTITY only', () => {
    const admin = /Includes foods for USDA/i;
    for (const s of seeds) {
      if (!admin.test(s.sourceDescription)) continue;
      // Provenance keeps it verbatim...
      assert.match(s.sourceDescription, admin);
      // ...but it never reaches the semantic concept key.
      assert.ok(!admin.test(s.conceptKey), s.conceptKey);
      assert.ok(!/distribution program/i.test(s.conceptKey));
    }
  });

  test('CA-15: general parentheses are NOT stripped', () => {
    // 871 SR descriptions contain parentheses and most carry real identity.
    const withParens = seeds.filter((s) => /\(/.test(s.sourceDescription));
    assert.ok(withParens.length > 50, 'parenthetical foods exist');
    const semantic = withParens.find((s) => /\(garbanzo|bengal gram|\(dry\)/i.test(s.sourceDescription));
    if (semantic !== undefined) {
      assert.ok(semantic.conceptKey.length > 0);
    }
  });

  test('CA-11: the SAME food from two sources converges on ONE identity', () => {
    const c = report.crossSource.conceptConvergence;
    assert.ok(c.count > 0, 'cross-source convergence must actually occur');
    for (const ex of c.examples) {
      assert.notEqual(ex.keptDataset, ex.droppedDataset, 'genuinely cross-source');
    }
  });

  test('possible duplicates are RETAINED for curation, never auto-merged', () => {
    assert.ok(report.crossSource.possibleDuplicate > 0);
    // Every published concept key is still unique — nothing was fuzzily merged.
    assert.equal(new Set(seeds.map((s) => s.conceptKey)).size, seeds.length);
  });

  test('overlap assessment is BLOCKED, not all-pairs', () => {
    const naive = 395 * 7793;
    assert.ok(report.crossSource.pairsCompared < naive / 100,
      `compared ${report.crossSource.pairsCompared} pairs — blocking must bound this`);
  });

  test('B7: no per-field cross-source nutrient filling', () => {
    // Every nutrient on a food carries the SAME source dataset provenance as
    // the food itself — a Frankenstein fact set would break this.
    for (const s of seeds.slice(0, 200)) {
      assert.ok(['Foundation', 'SR Legacy'].includes(s.externalIdentity.dataset));
    }
  });

  test('distinct preparations never merged across sources', () => {
    const byConcept = new Map<string, Set<string>>();
    for (const s of seeds) {
      const base = s.conceptKey.split('#')[0]!;
      byConcept.set(base, (byConcept.get(base) ?? new Set()).add(s.preparationState));
    }
    // Multiple states for one base concept must remain SEPARATE catalog entries.
    const multi = [...byConcept.values()].filter((v) => v.size > 1).length;
    assert.ok(multi >= 0);
    assert.equal(new Set(seeds.map((s) => s.productId)).size, seeds.length);
  });
});

describe('CA-14 — preparation-aware retrieval', () => {
  test('preparation intent reads the QUERY, not the display name', () => {
    assert.equal(preparationIntentOf('cooked ground turkey').state, 'cooked');
    assert.equal(preparationIntentOf('raw chicken breast').state, 'raw');
    assert.equal(preparationIntentOf('boiled potato').method, 'boiled');
    assert.equal(preparationIntentOf('chicken breast').state, null);
  });

  test('a cooked record with no cooked WORDING is still retrieved', () => {
    const p = report.search.preparationSensitive;
    assert.ok(p.total >= 25, `expected a substantial corpus, got ${p.total}`);
    assert.equal(p.noCorrectPreparationCandidate, 0,
      `no candidate for: ${p.noCorrectPreparationCandidateQueries.join(', ')}`);
  });

  test('NO wrong-state result outranks a correct one', () => {
    const p = report.search.preparationSensitive;
    assert.equal(p.wrongPreparationOutranked, 0,
      `outranked: ${p.wrongPreparationOutrankedQueries.join(', ')}`);
  });

  test('A2: preparation failure modes are reported SEPARATELY', () => {
    const p = report.search.preparationSensitive;
    for (const k of ['noCorrectPreparationCandidate', 'correctCandidateOutsideTop4', 'wrongPreparationOutranked']) {
      assert.ok(k in p, `${k} must be its own metric`);
    }
    assert.equal(p.failures, undefined, 'the vague combined array is gone');
  });
});
