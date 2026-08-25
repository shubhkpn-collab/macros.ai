import type {
  EnergyState, Grams, MacroState, NutritionTotals,
  ProductCatalogHead, ProductVersion,
} from '@macros/contracts';
import type { RecommendationPolicy } from './policy.js';

/**
 * GOAL-AWARE FOOD RECOMMENDATION CONTRACTS.
 *
 * The engine never computes nutrition or energy. It CONSUMES trusted domain
 * state and SELECTS among canonical products. Every number it reports was
 * produced elsewhere by an authoritative engine.
 */

/**
 * Explicit user food preferences.
 *
 * Minimal on purpose. `avoided` is a HARD FILTER; `preferred` is only a ranking
 * nudge. Nothing here is inferred — a food not eaten recently is not a dislike,
 * and this carries no allergy or medical meaning whatsoever.
 */
export interface PreferenceSnapshot {
  readonly userId: string;
  readonly preferredProductIds: readonly string[];
  readonly avoidedProductIds: readonly string[];
}

export interface RecommendationCandidate {
  readonly productVersion: ProductVersion;
  readonly head: ProductCatalogHead;
}

/** One user's own effective log history, already folded (corrections applied). */
export interface HistoryObservation {
  readonly userId: string;
  readonly productId: string;
  readonly productVersionId: string;
  readonly grams: number;
  readonly loggedAt: string;
  readonly localDate: string;
}

/**
 * A user's own observations, carrying the subject explicitly.
 *
 * The engine verifies ownership itself rather than trusting that the caller
 * filtered correctly — a mis-wired caller is exactly the failure this guards.
 */
export interface RecommendationHistorySnapshot {
  readonly userId: string;
  readonly observations: readonly HistoryObservation[];
}

export interface RecommendationInput {
  readonly userId: string;
  readonly nowIso: string;
  /**
   * The canonical local calendar day from daily state. NEVER derived by
   * slicing a UTC timestamp — near midnight, `nowIso.slice(0,10)` names the
   * wrong day for most of the world.
   */
  readonly localDate: string;
  /** Null when the energy engine could not produce a state. NEVER assumed zero. */
  readonly energy: EnergyState | null;
  readonly macros: MacroState | null;
  readonly candidates: readonly RecommendationCandidate[];
  readonly history: RecommendationHistorySnapshot;
  readonly preferences: PreferenceSnapshot | null;
  readonly policy: RecommendationPolicy;
  /** Production refuses synthetic catalog data. */
  readonly environment: 'development' | 'test' | 'staging' | 'production';
}

export type RecommendationStatus =
  | 'available'
  | 'subject_mismatch'
  | 'available_with_limited_energy_confidence'
  | 'insufficient_state'
  | 'no_eligible_candidates'
  | 'energy_budget_exhausted';

/** Deterministic codes. Presentation phrases them; it never invents them. */
export type RationaleCode =
  | 'strong_protein_fit'
  | 'strong_carb_fit'
  | 'strong_fat_fit'
  | 'fits_remaining_energy'
  | 'recently_used'
  | 'preferred'
  | 'would_overshoot_energy'
  | 'would_overshoot_macro'
  | 'portion_from_source_serving'
  | 'portion_from_your_history'
  | 'portion_unavailable';

export type PortionBasis = 'source_serving' | 'user_history';

/**
 * A proposed portion. Exists ONLY when grounded in a defensible basis — a
 * source-backed serving mass or this user's own observed portions. It is never
 * derived by dividing remaining calories by energy density, which is
 * arithmetically valid and product nonsense.
 */
export interface PortionProposal {
  readonly grams: Grams;
  readonly basis: PortionBasis;
  /** For a source serving, which multiple of the declared serving this is. */
  readonly servingMultiple?: number;
  /** For history, how many of this user's observations informed it. */
  readonly sampleCount?: number;
}

/**
 * How much the day's energy picture can be trusted. Derived from the canonical
 * `EnergyState` completeness — never recomputed here.
 */
export interface EnergyConfidence {
  readonly level: 'complete' | 'incomplete' | 'unavailable';
  readonly gaps: readonly string[];
}

export interface ScoreComponents {
  readonly macroFit: number;
  readonly energyFit: number;
  readonly historyNudge: number;
  readonly preferenceNudge: number;
  readonly energyOvershootPenalty: number;
  readonly macroOvershootPenalty: number;
  readonly repetitionPenalty: number;
}

export interface Recommendation {
  readonly productId: string;
  readonly productVersionId: string;
  readonly displayName: string;
  readonly brandName?: string;
  readonly preparationState: string;
  readonly score: number;
  readonly scoreComponents: ScoreComponents;
  readonly rationaleCodes: readonly RationaleCode[];
  readonly portionProposal?: PortionProposal;
  /** Produced by calculateNutrition(), never by recommendation arithmetic. */
  readonly nutritionAtProposedPortion?: NutritionTotals;
}

export interface RecommendationSet {
  readonly status: RecommendationStatus;
  readonly policyVersion: string;
  readonly generatedAt: string;
  readonly recommendations: readonly Recommendation[];
  /** Present when status explains an absence rather than a result. */
  readonly reason?: string;
  /**
   * Energy confidence is reported SEPARATELY from availability.
   *
   * A recommendation can be available while the day's energy picture is
   * incomplete; conflating the two would either suppress useful suggestions or
   * present a shaky calorie budget as firm.
   */
  readonly energyConfidence: EnergyConfidence;
}
