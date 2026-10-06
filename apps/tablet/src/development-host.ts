import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  TabletAppController, DevScaleAdapter, appSubjectFrom,
} from '@macros/tablet-app-core';
import { mintSubjectForTests } from '@macros/domain-auth';
import { deriveCapabilities } from '@macros/domain-offline-sync';
import { activeSwitchState } from '@macros/domain-household';
import {
  LocalEnergyGoalRepository, LocalFoodLogRepository,
  InMemoryProductVersionRepository, InMemoryUserProfileRepository,
} from '@macros/persistence';
import {
  DEV_CATALOG_HEADS, DEV_GOAL, DEV_PRODUCTS, DEV_PROFILE, DEV_STABILITY_POLICY,
  DEV_TEF_POLICY, DEV_USER_ID, devActiveEnergy,
} from './development-fixtures.js';
import type { AuthHostPort } from './actions.js';
import type { TabletHost } from './bootstrap.js';
import type { TabletComposition, TabletPorts } from './composition.js';
import { toFoodCard, fallbackInitials } from '@macros/domain-catalog';
import { buildVocabulary, resilientSearch } from '@macros/domain-food-search';
import {
  DEFAULT_RECOMMENDATION_POLICY, type RecommendationCandidate,
} from '@macros/domain-recommendation';
import { createTabletGuidanceProvider } from '@macros/guidance-remote';
import { toFoodCardView, type FoodCardView } from '@macros/tablet-view-model';

/**
 * DEVELOPMENT HOST — NOT PRODUCTION.
 *
 * Exists for one reason: to make the renderer launchable on an Android emulator
 * before repositories, credentials and hardware adapters are wired on device.
 *
 * It stores demo food logs and goal history on this device using AsyncStorage,
 * with SYNTHETIC catalog fixtures and a simulated scale. It supplies no real
 * authentication or hardware connection. The shell renders a permanent notice.
 * Local storage is unencrypted and is intended only for this development host.
 *
 * The real domain code still drives everything: this supplies adapters, never
 * nutrition, energy or authorization logic.
 */
export const DEVELOPMENT_HOST_VERSION = 'development-tablet-host@1.0.0';

const DEVELOPMENT_NOTICE =
  'DEVELOPMENT BUILD — synthetic data, local storage, no real account';

class SystemClock {
  now(): never { return new Date().toISOString() as never; }
}

class SequentialIds {
  private n = 0;
  next(): string {
    this.n += 1;
    return `native-${Date.now()}-${String(this.n)}-${Math.random().toString(36).slice(2)}`;
  }
}

/**
 * Configuration for the development / acceptance host.
 *
 * `assistant` reuses the EXISTING runtime selection rather than a new flag, so
 * there is one answer to "is this build talking to the cloud?" everywhere.
 */
export interface DevelopmentHostOptions {
  readonly auth: AuthHostPort;
  readonly assistant?: 'synthetic' | 'real';
  /** Required when assistant is 'real'. Never a vendor endpoint. */
  readonly apiBaseUrl?: string;
  /** The MEMBER's MACROS session. Never a vendor credential. */
  bearerToken?(): Promise<string> | string;
  readonly fetchImpl?: typeof fetch;
}

export async function createDevelopmentHost(
  options: DevelopmentHostOptions,
): Promise<TabletHost> {
  const { auth } = options;
  const repositories = {
    foodLogs: await LocalFoodLogRepository.open(AsyncStorage, 'macros.preview.food-logs.v1'),
    products: new InMemoryProductVersionRepository(
      DEV_PRODUCTS, DEV_CATALOG_HEADS),
    profiles: new InMemoryUserProfileRepository(),
    goals: await LocalEnergyGoalRepository.open(AsyncStorage, 'macros.preview.goals.v1'),
  };
  // BOTH are required before refreshDashboard(): a profile alone yields
  // goal_missing and a blank Home.
  await repositories.profiles.append(DEV_PROFILE);
  if (await repositories.goals.getEffective(DEV_USER_ID, new Date().toISOString()) === null) {
    await repositories.goals.append(DEV_GOAL);
  }

  const controller = new TabletAppController(
    {
      repositories,
      clock: new SystemClock() as never,
      ids: new SequentialIds(),
      policies: { tefPolicy: { status: 'available', policy: DEV_TEF_POLICY } },
      stabilityPolicy: DEV_STABILITY_POLICY,
      timezone: 'America/Chicago',
    } as never,
    // A test-minted subject: this host cannot authenticate anyone, which is
    // exactly why it is development-only and labelled as such.
    appSubjectFrom(mintSubjectForTests(DEV_USER_ID, { displayName: 'Demo' })),
    devActiveEnergy(420),
  );
  await controller.refreshDashboard();

  const scale = new DevScaleAdapter(new Date().toISOString(), new SystemClock() as never);

  const ports: TabletPorts = {
    voiceInput: { start: () => undefined, stop: () => undefined, available: false },
    scaleTransport: {
      connect: () => { for (const e of scale.connect()) controller.applyScaleEvent(e as never); },
      disconnect: () => undefined,
      available: false,
    },
    connectivity: { backendReachable: true },
  };

  const composition: TabletComposition = {
    controller,
    coordinator: { getState: () => activeSwitchState(DEV_USER_ID, 1) },
    ports,
    capabilities: () => deriveCapabilities({
      backendReachable: ports.connectivity.backendReachable,
      catalogInstalled: true, catalogStale: false, localStorageWritable: true,
      authValid: true, cloudVoiceReachable: false, pendingSubmissions: 0,
    } as never),
    recentFoods: () => {
      const state = controller.getState();
      if (state.dashboard === null) return [];
      return repositories.foodLogs.snapshot(state.subject.userId, state.dashboard.localDate)
        .slice().reverse().map(item => ({
          displayName: DEV_PRODUCTS.find(p => p.productVersionId === item.productVersionId)?.displayName ?? 'Food',
          kcal: item.nutritionSnapshot.totals.kcal, grams: item.weightCapture.grams,
        }));
    },
    currentActivity: () => devActiveEnergy(420) as never,
  };

  /**
   * Catalog QA browser — DEVELOPMENT ONLY.
   *
   * Searches the same repository the application uses, then projects each hit
   * through the real FoodCard pipeline, so what the owner inspects on Android
   * is exactly what production logic would produce. A production host returns
   * `catalogBrowser: null` and the surface never renders.
   */
  const catalogBrowser = {
    async search(query: string): Promise<readonly FoodCardView[]> {
      // THE SAME AUTHORITATIVE PIPELINE the tablet controller uses. The private
      // substring filter that lived here was a second search implementation:
      // QA would have been inspecting behaviour the product does not have,
      // which is worse than having no QA surface.
      const searchable = await repositories.products.listSearchable();

      /**
       * Search deliberately exposes each hit as the NARROWER `SearchableFood`,
       * which carries identity and text but not the nutrient basis, source or
       * effective date a FoodCard needs. Passing that straight to `toFoodCard`
       * was the compile error.
       *
       * The authoritative versions are already in memory, so a single O(n)
       * index rehydrates each hit in O(1). Calling `getVersion()` per result
       * would be a repository round-trip for data we are already holding.
       */
      const productVersionById = new Map(
        searchable.map((version) => [version.productVersionId, version]),
      );

      const vocabulary = buildVocabulary(searchable);
      const response = resilientSearch(searchable, vocabulary, { text: query, limit: 25 });

      const cards: FoodCardView[] = [];
      for (const result of response.results) {
        const fullVersion = productVersionById.get(result.productVersion.productVersionId);
        if (fullVersion === undefined) {
          // Search ranks only what it was given, so this cannot happen. If it
          // ever does, the honest response is to omit the row rather than
          // fabricate a nutrition record for a QA surface whose whole purpose
          // is showing what the catalog really holds.
          continue;
        }
        const card = toFoodCard(fullVersion);
        cards.push(toFoodCardView(card as never, fallbackInitials(card.displayName)));
      }
      return cards;
    },
  };

  /**
   * Guidance dependencies. The FAKE provider only — no network, no key, no
   * cost. A live adapter swaps in here without touching nutrition,
   * recommendation or the renderer.
   */
  /**
   * Provider chosen by CONFIGURATION, not by editing this file. In `real` mode
   * the tablet talks to the MACROS backend over HTTP and still knows nothing
   * about any vendor.
   */
  const guidance = {
    provider: createTabletGuidanceProvider({
      config: {
        assistant: options.assistant ?? 'synthetic',
        ...(options.apiBaseUrl !== undefined ? { apiBaseUrl: options.apiBaseUrl } : {}),
      },
      bearerToken: options.bearerToken ?? (() => 'development-session'),
      fetchImpl: (options.fetchImpl ?? fetch) as never,
    }),
    // Rebuilt on EVERY request from the live repository, never cached, so
    // guidance always reflects the food actually logged so far.
    eligibleCandidates: async (): Promise<readonly RecommendationCandidate[]> => {
      const searchable = await repositories.products.listSearchable();
      return searchable.map((v): RecommendationCandidate => ({
        productVersion: v,
        head: {
          productId: v.productId,
          currentProductVersionId: v.productVersionId,
          isActive: true,
          updatedAt: '2026-01-01T00:00:00.000Z' as unknown as never,
        },
      }));
    },
    nowIso: (): string => new Date().toISOString(),
    policy: DEFAULT_RECOMMENDATION_POLICY,
    environment: 'test' as const,
  };

  return {
    composition,
    guidance,
    auth,
    hasActiveSession: true,
    developmentNotice: DEVELOPMENT_NOTICE,
    catalogBrowser,
  };
}
