import type { Grams, Kcal } from './primitives.js';
import type { ReviewStatus } from './policies.js';

export interface MacroTargets {
  readonly targetKcal: Kcal;
  readonly proteinG: Grams;
  readonly carbohydrateG: Grams;
  readonly fatG: Grams;
  readonly policyVersion: string;
  readonly policyReviewStatus: ReviewStatus;
  readonly carbohydrateClamped: boolean;
}

export interface MacroState {
  readonly targets: MacroTargets;
  readonly consumedKcal: Kcal;
  readonly consumedProteinG: Grams;
  readonly consumedCarbohydrateG: Grams;
  readonly consumedFatG: Grams;
  readonly remainingKcal: Kcal;
  readonly remainingProteinG: Grams;
  readonly remainingCarbohydrateG: Grams;
  readonly remainingFatG: Grams;
  readonly calcVersion: string;
}

export interface GuardrailAssessment {
  readonly targetKcal: Kcal;
  readonly floorKcal: Kcal;
  readonly belowFloor: boolean;
  readonly requiresExplicitConfirmation: boolean;
  readonly policyVersion: string;
  readonly policyReviewStatus: ReviewStatus;
}
