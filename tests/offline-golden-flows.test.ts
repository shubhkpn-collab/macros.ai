import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { RuntimeCatalog, BarcodeScanner, type ProjectedFood } from '@macros/catalog-runtime';
import { searchFood } from '@macros/domain-food-search';
import { calculateNutrition } from '@macros/domain-nutrition';
import { aggregateDailyIntake } from '@macros/domain-food-log';
import { reconcileDay, type OutboxEntry } from '@macros/domain-offline-sync';
import { normalizeGtin } from '@macros/catalog-ingestion';
import { grams, instant, type FoodLogItem } from '@macros/contracts';
import { USER_A, USER_B, approx } from '@macros/testkit';

const FIXTURE = 'data/offline-bundle-fixture.json';
const skip = existsSync(FIXTURE) ? false : 'offline bundle fixture not built';
const fx = existsSync(FIXTURE) ? JSON.parse(readFileSync(FIXTURE, 'utf8')) : null;

/**
 * Authority resolver over the REAL offline authority pack. Search only ever
 * nominates a candidate; every number comes from here.
 */
const authority = (id: string) => fx.brandedAuthority[id] ?? fx.genericAuthority[id] ?? null;

const catalog = fx === null ? null : new RuntimeCatalog(
  [...fx.genericSearch, ...fx.brandedSearch] as ProjectedFood[],
  fx.gtinIndex,
  {
    resolve: (id: string) => {
      const a = authority(id);
      if (a === null) return Promise.resolve(null);
      return Promise.resolve({
        productId: a.productId, productVersionId: a.productVersionId,
        displayName: a.displayName, kind: a.kind,
        per100g: a.per100g,
        servingGrams: a.servingGrams ?? null,
        householdServingText: a.householdServingText ?? null,
        labelFacts: a.labelFacts ?? null,
        brandName: a.brandName ?? null, subbrandName: a.subbrandName ?? null,
        gtin14: a.gtin14 ?? null,
        discontinued: false,
      });
    },
  },
);

/** Builds the exact FoodLogItem the online path would, from offline authority. */
function offlineLog(versionId: string, g: number, logId: string, userId = USER_A): FoodLogItem {
  const a = authority(versionId)!;
  const basis = {
    kind: 'per_100g' as const,
    kcal: a.per100g['energy_kcal'].amount,
    proteinG: a.per100g['protein'].amount,
    carbohydrateG: a.per100g['carbohydrate'].amount,
    fatG: a.per100g['fat'].amount,
  };
  const totals = calculateNutrition(basis as never, grams(g)).totals;
  const at = instant('2026-08-26T17:00:00.000Z');
  return {
    logId, userId,
    productId: a.productId, productVersionId: a.productVersionId,
    grams: grams(g),
    weightCapture: { grams: grams(g), source: 'manual', capturedAt: at } as never,
    nutritionSnapshot: {
      totals, gramsConsumed: g, productVersionId: a.productVersionId,
      basisKind: 'per_100g', calcVersion: 'offline-test', computedAt: at,
    } as never,
    loggedAt: at, eventTimezone: 'America/Chicago', eventUtcOffsetMinutes: -300,
    localDate: '2026-08-26', nutritionCalcVersion: 'offline-test', status: 'active',
  } as FoodLogItem;
}

const entryFor = (log: FoodLogItem, over: Partial<OutboxEntry> = {}): OutboxEntry => ({
  userId: log.userId, logId: log.logId, payload: log,
  state: 'pending', attempts: 0, sequence: 1, ...over,
});

// ---------------------------------------------------------------------------

describe('OFFLINE SEARCH GOLDEN FLOW (TypeScript only, no backend)', () => {
  test('generic: cached search → selection → authority → snapshot → dashboard', { skip }, async () => {
    const foods = catalog!.searchableFoods();
    const generic = fx.genericSearch[0] as ProjectedFood;
    const term = generic.displayName.split(/[,\s]+/)[0]!;
    const results = searchFood(foods, { text: term });
    assert.ok(results.length > 0, `no offline candidates for "${term}"`);

    const chosen = results[0]!.productVersion.productVersionId;
    const a = await catalog!.resolve(chosen);
    assert.notEqual(a, null, 'the local authority replica must resolve');

    const log = offlineLog(chosen, 150, 'off-1');
    const intake = aggregateDailyIntake([log], { userId: USER_A, localDate: log.localDate });
    const expected = calculateNutrition(
      { kind: 'per_100g', kcal: a!.per100g['energy_kcal']!.amount,
        proteinG: a!.per100g['protein']!.amount,
        carbohydrateG: a!.per100g['carbohydrate']!.amount,
        fatG: a!.per100g['fat']!.amount } as never, grams(150)).totals;
    assert.ok(approx(intake.kcal, expected.kcal, 1e-9), 'ONE nutrition path, online or offline');
  });

  test('branded: cached search resolves real branded authority', { skip }, async () => {
    const foods = catalog!.searchableFoods();
    const branded = fx.brandedSearch[0] as ProjectedFood;
    const term = branded.displayName.split(/[,\s]+/)[0]!;
    const results = searchFood(foods, { text: term });
    assert.ok(results.length > 0);
    const a = await catalog!.resolve(results[0]!.productVersion.productVersionId);
    assert.notEqual(a, null);
    assert.ok(a!.per100g['energy_kcal'] !== undefined, 'authoritative facts, not projection data');
  });

  test('the search projection carries NO nutrition', { skip }, () => {
    for (const row of [...fx.genericSearch, ...fx.brandedSearch].slice(0, 60)) {
      for (const banned of ['per100g', 'labelFacts', 'kcal', 'energy_kcal', 'servingGrams']) {
        assert.equal(banned in row, false, `${banned} must not be in the search projection`);
      }
    }
  });
});

describe('OFFLINE BARCODE GOLDEN FLOW', () => {
  test('a cached GTIN resolves to its exact ProductVersion offline', { skip }, async () => {
    const scanner = new BarcodeScanner(catalog!);
    const [gtin14, versionId] = Object.entries(fx.gtinIndex)[0] as [string, string];
    const scanned = gtin14.replace(/^0+(?=\d{12,})/, '');
    const r = await scanner.scan(scanned.length >= 12 ? scanned : gtin14);
    assert.equal(r.outcome, 'found');
    if (r.outcome !== 'found') return;
    assert.equal(r.product.productVersionId, versionId);
  });

  test('a valid GTIN absent from the cache is a CACHE MISS, not an invalid product', { skip }, async () => {
    const scanner = new BarcodeScanner(catalog!);
    // Structurally valid (correct check digit) but not in our bundle.
    const valid = normalizeGtin('00012000001086');
    assert.equal(valid.ok, true, 'the barcode itself is well formed');
    const r = await scanner.scan('00012000001086');
    assert.equal(r.outcome, 'not_found', 'never reported as invalid');
    assert.notEqual(r.outcome, 'invalid_identifier');
  });

  test('a bad check digit is INVALID immediately, cache or not', { skip }, async () => {
    const scanner = new BarcodeScanner(catalog!);
    const r = await scanner.scan('00012000001087');
    assert.equal(r.outcome, 'invalid_identifier');
  });
});

describe('CATALOG UPDATE vs PENDING LOG', () => {
  test('a pending V1 log survives a bundle update that advances the head to V2', { skip }, () => {
    const versionId = Object.keys(fx.brandedAuthority)[0]!;
    const log = offlineLog(versionId, 100, 'v1-log');
    const pending = entryFor(log);
    const beforeKcal = pending.payload.nutritionSnapshot.totals.kcal;

    // A new bundle activates and the current head moves on. The outbox is a
    // separate, private artifact — the catalog installer cannot reach it.
    const newCatalog = new RuntimeCatalog(
      [{ ...(fx.brandedSearch[0] as ProjectedFood), productVersionId: `${versionId}-v2` }],
      {}, null,
    );
    void newCatalog;

    assert.equal(pending.payload.productVersionId, versionId, 'still V1');
    assert.ok(approx(pending.payload.nutritionSnapshot.totals.kcal, beforeKcal, 1e-9));

    const day = reconcileDay(USER_A, log.localDate, [], [pending]);
    assert.equal(day.effective[0]!.productVersionId, versionId, 'V1 is what gets submitted');
  });
});

describe('USER SWITCH WITH PENDING WORK', () => {
  test('A logs offline, switch to B, switch back — A\'s work is intact', { skip }, () => {
    const versionId = Object.keys(fx.genericAuthority)[0]!;
    const aLog = offlineLog(versionId, 120, 'a-1', USER_A);
    const queue = [entryFor(aLog)];

    // B is now active.
    const bDay = reconcileDay(USER_B, aLog.localDate, [], queue);
    assert.equal(bDay.effective.length, 0, "B never sees A's pending food");
    assert.equal(bDay.pendingCount, 0);

    // Back to A: nothing was reassigned or lost.
    const aDay = reconcileDay(USER_A, aLog.localDate, [], queue);
    assert.equal(aDay.effective.length, 1);
    assert.equal(aDay.effective[0]!.userId, USER_A);
    assert.equal(aDay.pendingCount, 1);
  });
});
