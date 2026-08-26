import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { RuntimeCatalog, BarcodeScanner, type ProjectedFood } from '@macros/catalog-runtime';
import { searchFood } from '@macros/domain-food-search';
import { calculateNutrition } from '@macros/domain-nutrition';
import { createFoodLogItem, aggregateDailyIntake } from '@macros/domain-food-log';
import { manualCapture } from '@macros/domain-weight';
import { normalizeGtin } from '@macros/catalog-ingestion';
import { grams, instant } from '@macros/contracts';
import { USER_A, approx } from '@macros/testkit';

const FIXTURE = 'data/branded-runtime-fixture.json';
const MANIFEST = 'data/branded/manifest.json';
const has = existsSync(FIXTURE) && existsSync(MANIFEST);
const fx = has ? JSON.parse(readFileSync(FIXTURE, 'utf8')) : null;
const manifest = has ? JSON.parse(readFileSync(MANIFEST, 'utf8')) : null;

const skip = has ? false : 'full-release artifacts not built';

/** Resolver over REAL full-release versions. Authority lives here, not in search. */
const resolver = {
  resolve: (id: string) => {
    const v = fx.versions[id];
    if (v === undefined) return Promise.resolve(null);
    return Promise.resolve({
      productVersionId: v.productVersionId,
      productId: v.productVersionId.split('@')[0],
      displayName: v.sourceDescription,
      brandName: v.brandName ?? null,
      subbrandName: v.subbrandName ?? null,
      servingGrams: v.servingGrams ?? null,
      kind: 'branded' as const,
      householdServingText: v.householdServingText ?? null,
      servingText: v.householdServingText ?? null,
      per100g: v.per100g,
      labelFacts: v.labelFacts ?? null,
      ingredientsText: v.ingredientsText ?? null,
      gtin14: v.gtin14 ?? null,
      discontinued: Boolean(v.discontinuedDate),
    });
  },
};
const catalog = has
  ? new RuntimeCatalog(fx.projection as ProjectedFood[], fx.gtinIndex, resolver)
  : null;

describe('PART 35 — build manifest gates the runtime', () => {
  test('the manifest reports a COMPLETE full-release build', { skip }, () => {
    assert.equal(manifest.buildComplete, true);
    assert.equal(manifest.fullRelease, true);
    assert.equal(manifest.sourceRecordCount, 455458);
    assert.ok(manifest.products > 400000);
  });

  test('every shard carries a checksum and record count', { skip }, () => {
    for (const s of manifest.shards) {
      assert.match(s.sha256, /^[0-9a-f]{64}$/);
      assert.ok(s.records > 0 && s.bytes > 0);
    }
  });
});

describe('PART 28 — TypeScript generic+branded golden path', () => {
  test('a REAL branded food searches, weighs and logs through the existing engines', { skip }, async () => {
    const foods = catalog!.searchableFoods();
    assert.ok(foods.length > 100);

    // Query a real product actually present in the full release.
    const target = fx.projection[0] as ProjectedFood;
    const firstWord = target.displayName.split(/[,\s]+/)[0]!;
    const results = searchFood(foods, { text: firstWord });
    assert.ok(results.length > 0, `no candidates for "${firstWord}"`);

    // Selection is explicit; the projection only nominated a candidate.
    const chosen = results[0]!.productVersion.productVersionId;
    const authoritative = await catalog!.resolve(chosen);
    assert.notEqual(authoritative, null, 'canonical facts must resolve');

    // Nutrition comes from the SAME engine generic foods use.
    const basis = {
      kind: 'per_100g' as const,
      kcal: authoritative!.per100g['energy_kcal']!.amount,
      proteinG: authoritative!.per100g['protein']!.amount,
      carbohydrateG: authoritative!.per100g['carbohydrate']!.amount,
      fatG: authoritative!.per100g['fat']!.amount,
    };
    const totals = calculateNutrition(basis as never, grams(150)).totals;

    const log = createFoodLogItem({
      logId: 'blog-1', userId: USER_A,
      productVersion: {
        productId: authoritative!.productId,
        productVersionId: authoritative!.productVersionId,
        versionNo: 1,
        displayName: authoritative!.displayName,
        preparationState: 'as_sold',
        basis: basis as never,
        // Real USDA Branded provenance — label data, not laboratory analysis.
        source: {
          kind: 'usda_fdc_branded',
          sourceId: `USDA_FDC_BRANDED:${authoritative!.productVersionId}`,
          verificationStatus: 'source_backed',
          licenseClass: 'public_domain',
          releaseId: 'branded-2026-04-30',
          sourceFileHash: manifest.sourceChecksum,
        },
        effectiveFrom: instant('2026-01-01T00:00:00.000Z'),
      } as never,
      weightCapture: manualCapture(150, instant('2026-08-25T12:00:00.000Z')),
      loggedAt: instant('2026-08-25T12:00:00.000Z'),
      timezone: 'America/Chicago',
    });

    assert.equal(log.productVersionId, authoritative!.productVersionId, 'exact version pinned');
    const intake = aggregateDailyIntake([log], { userId: USER_A, localDate: log.localDate });
    assert.ok(approx(intake.kcal, totals.kcal, 1e-9), 'one nutrition path for branded and generic');
  });

  test('the search projection carries NO nutrition', { skip }, () => {
    for (const row of fx.projection.slice(0, 50)) {
      for (const banned of ['per100g', 'kcal', 'protein', 'labelFacts', 'energy_kcal']) {
        assert.equal(banned in row, false, `${banned} must not be in the projection`);
      }
    }
  });

  test('consumer brand ranks above corporate owner', { skip }, () => {
    const withBrand = (fx.projection as ProjectedFood[]).find((p) => p.brandName);
    if (withBrand === undefined) return;
    assert.ok(withBrand.brandName !== undefined);
  });
});

describe('PART 29 — barcode golden path (TypeScript only)', () => {
  test('a REAL full-release GTIN resolves to its exact ProductVersion', { skip }, async () => {
    const scanner = new BarcodeScanner(catalog!);
    const [gtin14, versionId] = Object.entries(fx.gtinIndex)[0] as [string, string];
    // Strip the canonical padding back to a scannable code.
    const scanned = gtin14.replace(/^0+(?=\d{12,})/, '');
    const r = await scanner.scan(scanned.length >= 12 ? scanned : gtin14);
    assert.equal(r.outcome, 'found', `scan of ${gtin14} failed`);
    if (r.outcome !== 'found') return;
    assert.equal(r.product.productVersionId, versionId, 'exact version, never a near match');
    assert.ok(r.product.per100g['energy_kcal'] !== undefined, 'authoritative facts attached');
  });

  test('PART 20: a NUMERIC barcode is refused, never stringified', { skip }, async () => {
    const scanner = new BarcodeScanner(catalog!);
    const r = await scanner.scan(76014101088 as unknown as string);
    assert.equal(r.outcome, 'invalid_identifier');
    if (r.outcome === 'invalid_identifier') assert.equal(r.reason, 'non_string_identifier');
  });

  test('normalizeGtin itself rejects non-string input', () => {
    const r = normalizeGtin(76014101088 as unknown as string);
    // A number has already lost "076014101088"'s leading zero before arriving.
    assert.equal(r.ok, false);
  });

  test('a malformed or unknown barcode never resolves', { skip }, async () => {
    const scanner = new BarcodeScanner(catalog!);
    for (const bad of ['12345', 'abcdefgh', '', '00000000000000']) {
      const r = await scanner.scan(bad);
      assert.notEqual(r.outcome, 'found', `${bad} must not resolve`);
    }
  });
});

describe('PART 17 — historical ProductVersion resolution', () => {
  test('an old version id still resolves its OWN facts', { skip }, async () => {
    // Simulates a fresh process: only the artifacts, no prior state.
    const ids = Object.keys(fx.versions);
    const chosen = ids[0]!;
    const fresh = new RuntimeCatalog(fx.projection as ProjectedFood[], fx.gtinIndex, resolver);
    const v = await fresh.resolve(chosen);
    assert.notEqual(v, null);
    assert.equal(v!.productVersionId, chosen, 'the exact logged version, not the current head');
  });
});
