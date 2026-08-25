import {
  DEFAULT_RECOMMENDATION_POLICY, observationsFromLogs, recommendFoods,
  type PreferenceSnapshot, type RecommendationCandidate, type RecommendationSet,
} from '@macros/domain-recommendation';
import type { ProductVersion } from '@macros/contracts';

/**
 * TRUSTED RECOMMENDATION SERVICE.
 *
 * Assembles authoritative state and calls the deterministic engine. It performs
 * no nutrition arithmetic, no energy arithmetic and no ranking of its own — it
 * only gathers trusted inputs and returns the engine's structured result.
 *
 * A model may cause this to RUN. It can never influence what it returns.
 */
export interface RecommendationContext {
  readonly userId: string;
  readonly nowIso: string;
  readonly energy: Parameters<typeof recommendFoods>[0]['energy'];
  readonly macros: Parameters<typeof recommendFoods>[0]['macros'];
  readonly candidates: readonly RecommendationCandidate[];
  readonly effectiveLogs: readonly {
    userId: string; productId: string; productVersionId: string;
    grams: number; loggedAt: string; localDate: string;
  }[];
  readonly preferences: PreferenceSnapshot | null;
  readonly environment: 'development' | 'test' | 'staging' | 'production';
}

export function buildRecommendations(context: RecommendationContext): RecommendationSet {
  return recommendFoods({
    userId: context.userId,
    nowIso: context.nowIso,
    energy: context.energy,
    macros: context.macros,
    candidates: context.candidates,
    // Already folded by the caller, so voided and superseded logs are absent.
    history: observationsFromLogs(context.userId, context.effectiveLogs),
    preferences: context.preferences,
    policy: DEFAULT_RECOMMENDATION_POLICY,
    environment: context.environment,
  });
}

export type { ProductVersion };
