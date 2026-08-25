import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildProductCard,
  buildSearchProjection,
  lookupByIdentifier,
  type IdentifierIndexEntry,
} from '@macros/domain-catalog';
import { TabletAppController, DevScaleAdapter, type AppEnvironment, type AppSubject } from '@macros/tablet-app-core';
import {
  InMemoryEnergyGoalRepository,
  InMemoryFoodLogRepository,
  InMemoryProductVersionRepository,
  InMemoryUserProfileRepository,
  type PersistedLoopRepositories,
} from '@macros/persistence';
import { instant, type EnergyGoalVersion, type Instant } from '@macros/contracts';
import type { LoopPolicies } from '@macros/core-loop';
import {
  BRANDED_GTINS,
  PROFILE_MALE_35,
  PROFILE_FEMALE_29,
  SYNTHETIC_BRANDED_ALIASES,
  SYNTHETIC_BRANDED_HEADS,
  SYNTHETIC_BRANDED_META,
  SYNTHETIC_BRANDED_PRODUCTS,
  SYNTHETIC_CATALOG_HEADS,
  SYNTHETIC_PRODUCTS,
  SYNTHETIC_STABILITY_POLICY,
  TEST_TEF_POLICY,
  USER_A,
  USER_B,
  activeEnergy,
  approx,
} from '@macros/testkit';

const TZ = 'America/Chicago';
const START = '2026-08-18T16:50:00.000Z';
const POLICIES: LoopPolicies = { tefPolicy: { status: 'available', policy: TEST_TEF_POLICY } };

class FixedClock {
  private ms = Date.parse(START);
  now(): Instant { return instant(new Date(this.ms).toISOString()); }
  advance(ms: number): void { this.ms += ms; }
}
class SequenceIds {
  private n = 0;
  next(): string { this.n += 1; return `00000000-0000-4000-8000-${String(this.n).padStart(12, '0')}`; }
}

const subjectFor = (userId: string, name: string): AppSubject => ({
  authenticatedSubjectId: userId, userId, displayName: name,
});
const goalFor = (userId: string, id: string, delta: number): EnergyGoalVersion => ({
  goalVersionId: id, userId, effectiveFrom: instant('2026-01-01T00:00:00.000Z'),
  goal: delta > 0 ? 'gain' : delta < 0 ? 'lose' : 'maintain', targetDeltaKcal: delta,
});

const ALL_VERSIONS = [...SYNTHETIC_PRODUCTS, ...SYNTHETIC_BRANDED_PRODUCTS];
const ALL_HEADS = [...SYNTHETIC_CATALOG_HEADS, ...SYNTHETIC_BRANDED_HEADS];

const IDENTIFIER_INDEX: IdentifierIndexEntry[] = SYNTHETIC_BRANDED_PRODUCTS.map((p) => ({
  normalizedValue: SYNTHETIC_BRANDED_META[p.productId]!.gtin!,
  productId: p.productId,
  productVersionId: p.productVersionId,
  state: 'current',
}));

async function harness() {
  const repos: PersistedLoopRepositories = {
    foodLogs: new InMemoryFoodLogRepository(),
    products: new InMemoryProductVersionRepository(ALL_VERSIONS, ALL_HEADS),
    profiles: new InMemoryUserProfileRepository(),
    goals: new InMemoryEnergyGoalRepository(),
  };
  await repos.profiles.append(PROFILE_MALE_35);
  await repos.profiles.append(PROFILE_FEMALE_29);
  await repos.goals.append(goalFor(USER_A, 'goal-a-v1', 250));
  await repos.goals.append(goalFor(USER_B, 'goal-b-v1', -400));

  const clock = new FixedClock();
  const env: AppEnvironment = {
    repositories: repos, clock, ids: new SequenceIds(), policies: POLICIES,
    stabilityPolicy: SYNTHETIC_STABILITY_POLICY, timezone: TZ,
    developmentDataNotice: 'DEVELOPMENT DATA — synthetic branded fixtures',
  };
  const app = new TabletAppController(env, subjectFor(USER_A, 'Dev User A'), activeEnergy(500));
  const scale = new DevScaleAdapter(START, clock);
  await app.refreshDashboard();
  return { app, scale, clock, repos };
}

type Harness = Awaited<ReturnType<typeof harness>>;
const feed = (h: Harness, events: readonly unknown[]) => {
  for (const e of events) h.app.applyScaleEvent(e as never);
};

const OATS = SYNTHETIC_BRANDED_PRODUCTS.find((p) => p.productId === 'synb-oats-old-fashioned')!;

describe('GOLDEN — branded product logged from the scale', () => {
  test('search → option A → 100 g capture → preview → log → dashboard', async () => {
    const h = await harness();

    await h.app.searchFood('demo brand oats');
    const results = h.app.getState().addFood.results;
    const oats = results.find((r) => r.productVersion.productVersionId === OATS.productVersionId)!;
    assert.ok(oats !== undefined, 'the branded oats are offered');

    await h.app.selectOption(oats.optionLabel);
    assert.equal(h.app.getState().addFood.selected!.productVersionId, OATS.productVersionId);

    feed(h, h.scale.connect());
    feed(h, h.scale.placeAndSettle(100));
    assert.equal(h.app.getState().addFood.weightCapture, null, 'a candidate is not a capture');

    h.app.requestStableWeight();
    const flow = h.app.getState().addFood;
    assert.equal(flow.phase, 'reviewing');
    assert.equal(flow.weightCapture!.source, 'scale');

    // 375 kcal/100 g at 100 g. The card's "150 kcal per 40 g" is irrelevant here.
    assert.ok(approx(flow.preview!.kcal, 375, 1e-9));
    assert.ok(approx(flow.preview!.proteinG, 12.5, 1e-9));

    await h.app.confirmFoodLog();
    assert.equal(h.app.getState().addFood.outcome, 'appended');

    const logs = await h.repos.foodLogs.listByLocalDate(USER_A, h.app.getState().dashboard!.localDate);
    assert.equal(logs.length, 1);
    assert.equal(
      logs[0]!.productVersionId,
      OATS.productVersionId,
      'the log pins the exact branded version',
    );
    assert.equal(logs[0]!.weightCapture.source, 'scale', 'weight provenance is untouched');
    assert.ok(approx(h.app.getState().dashboard!.intake.kcal, 375, 1e-9));
  });

  test('the card serving is NOT what was logged', async () => {
    const h = await harness();
    await h.app.searchFood('demo brand oats');
    const oats = h.app.getState().addFood.results.find(
      (r) => r.productVersion.productVersionId === OATS.productVersionId,
    )!;
    await h.app.selectOption(oats.optionLabel);

    const card = buildProductCard({
      version: OATS, optionLabel: oats.optionLabel, evidence: 'synthetic_test',
      branded: SYNTHETIC_BRANDED_META[OATS.productId],
    });

    feed(h, h.scale.connect());
    feed(h, h.scale.placeAndSettle(83));
    h.app.requestStableWeight();

    assert.equal(card.servingGrams, 40);
    assert.equal(card.labelKcal, 150);
    assert.ok(approx(h.app.getState().addFood.weightCapture!.grams, 83, 1e-9));
    assert.ok(approx(h.app.getState().addFood.preview!.kcal, 375 * 0.83, 1e-9));
  });
});

describe('GOLDEN — barcode flow without a camera', () => {
  test('GTIN lookup → card → select → 83 g → log', async () => {
    const h = await harness();

    const found = lookupByIdentifier(BRANDED_GTINS.yogurtNonfat, IDENTIFIER_INDEX);
    assert.equal(found.outcome, 'exact_match');
    if (found.outcome !== 'exact_match') return;

    // The barcode path uses the SAME selection intent as text search.
    h.app.beginAddFood();
    await h.app.selectProduct(found.productVersionId);
    assert.equal(h.app.getState().addFood.selected!.productVersionId, found.productVersionId);

    feed(h, h.scale.connect());
    feed(h, h.scale.placeAndSettle(83));
    h.app.requestStableWeight();
    await h.app.confirmFoodLog();

    const logs = await h.repos.foodLogs.listByLocalDate(USER_A, h.app.getState().dashboard!.localDate);
    assert.equal(logs.length, 1);
    assert.equal(logs[0]!.productVersionId, found.productVersionId);
    assert.ok(approx(logs[0]!.grams, 83, 1e-9));
  });

  test('text search and barcode reach the SAME canonical version', async () => {
    const h = await harness();
    await h.app.searchFood('fjordly yogurt');
    const viaSearch = h.app.getState().addFood.results.find(
      (r) => r.productVersion.productVersionId === 'synb-yogurt-nonfat@v1',
    )!;
    const viaBarcode = lookupByIdentifier(BRANDED_GTINS.yogurtNonfat, IDENTIFIER_INDEX);
    assert.equal(viaBarcode.outcome, 'exact_match');
    if (viaBarcode.outcome === 'exact_match') {
      assert.equal(viaSearch.productVersion.productVersionId, viaBarcode.productVersionId);
    }
  });

  test('an unknown barcode never produces a guessed food', async () => {
    const h = await harness();
    const unknown = '00099000009995';
    const r = lookupByIdentifier(unknown, IDENTIFIER_INDEX);
    assert.notEqual(r.outcome, 'exact_match');
    assert.equal(h.app.getState().addFood.selected, null);
  });
});

describe('BRANDED HISTORY RANKING', () => {
  test("a user's repeatedly logged branded product is nudged up", async () => {
    const h = await harness();
    await h.app.searchFood('yogurt');
    const vanilla = h.app.getState().addFood.results.find(
      (r) => r.productVersion.productVersionId === 'synb-yogurt-vanilla@v1',
    );
    assert.ok(vanilla !== undefined, 'both yogurts are candidates');

    await h.app.selectProduct('synb-yogurt-vanilla@v1');
    h.app.enterManualWeight(150);
    await h.app.confirmFoodLog();

    h.app.cancelFoodFlow();
    await h.app.searchFood('yogurt');
    assert.equal(
      h.app.getState().addFood.results[0]!.productVersion.productVersionId,
      'synb-yogurt-vanilla@v1',
      'the recently logged branded product ranks first',
    );
  });

  test('history never outranks a materially better exact match', async () => {
    const h = await harness();
    await h.app.selectProduct('synb-yogurt-vanilla@v1');
    h.app.enterManualWeight(150);
    await h.app.confirmFoodLog();
    h.app.cancelFoodFlow();

    await h.app.searchFood('Nonfat Greek Yogurt');
    assert.equal(
      h.app.getState().addFood.results[0]!.productVersion.productVersionId,
      'synb-yogurt-nonfat@v1',
      'an exact name match beats a recency nudge',
    );
  });

  test("household privacy: user A's branded history never reaches user B", async () => {
    // Baseline: what a user with NO history sees for this query. Comparing
    // against this is the only way to distinguish a real leak from the natural
    // tie-break order, which happens to put vanilla first anyway.
    const baseline = await harness();
    await baseline.app.searchFood('yogurt');
    const noHistoryOrder = baseline.app
      .getState()
      .addFood.results.map((r) => r.productVersion.productVersionId);

    const h = await harness();
    // A logs the NONFAT yogurt, which is NOT first without history.
    await h.app.selectProduct('synb-yogurt-nonfat@v1');
    h.app.enterManualWeight(170);
    await h.app.confirmFoodLog();
    h.app.cancelFoodFlow();

    await h.app.searchFood('yogurt');
    const aOrder = h.app.getState().addFood.results.map((r) => r.productVersion.productVersionId);
    assert.equal(aOrder[0], 'synb-yogurt-nonfat@v1', "A's own history reorders A's results");
    assert.notDeepEqual(aOrder, noHistoryOrder, 'so the history signal is genuinely active');

    await h.app.switchActiveUser(subjectFor(USER_B, 'Dev User B'), activeEnergy(300));
    await h.app.searchFood('yogurt');
    const bOrder = h.app.getState().addFood.results.map((r) => r.productVersion.productVersionId);
    assert.deepEqual(bOrder, noHistoryOrder, "B sees the no-history order — A's history did not leak");

    const bRecent = await h.repos.foodLogs.listRecentProductVersionIds(USER_B, 20);
    assert.deepEqual(bRecent, [], 'B has no history of their own');
  });
});

describe('SEARCH PROJECTION INCLUDES BRANDED', () => {
  test('branded products appear only behind active heads', () => {
    const docs = buildSearchProjection({
      versions: ALL_VERSIONS,
      heads: ALL_HEADS.map((h) => (h.productId === 'synb-crackers' ? { ...h, isActive: false } : h)),
      aliasSets: SYNTHETIC_BRANDED_ALIASES,
    });
    assert.ok(!docs.some((d) => d.productId === 'synb-crackers'), 'a de-listed branded product is hidden');
    assert.ok(docs.some((d) => d.productId === 'synb-oats-old-fashioned'));
  });
});
