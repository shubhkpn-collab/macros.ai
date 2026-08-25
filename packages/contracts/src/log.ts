import type { NutritionSnapshot } from './food.js';
import type { NutritionTotals } from './nutrition.js';
import type { Grams, Instant } from './primitives.js';
import type { WeightCapture } from './weight.js';

/**
 * A food log item is IMMUTABLE: a specific user consumed a specific mass of a
 * specific product VERSION at a specific instant, with the nutrition computed
 * at that moment and frozen.
 *
 * Historical nutrition never changes when product data is corrected later.
 * Corrections append; nothing is ever UPDATEd.
 */
export type FoodLogStatus = 'active' | 'superseded' | 'voided';

export interface FoodLogItem {
  readonly logId: string;
  readonly userId: string;

  readonly productId: string;
  readonly productVersionId: string;

  readonly grams: Grams;
  /** Full weight provenance, scale or manual, retained verbatim. */
  readonly weightCapture: WeightCapture;

  readonly nutritionSnapshot: NutritionSnapshot;

  readonly loggedAt: Instant;
  /**
   * Event-local time provenance. The UTC instant alone is not enough to
   * reconstruct which local calendar day this belonged to across DST changes.
   */
  readonly eventTimezone: string;
  readonly eventUtcOffsetMinutes: number;
  /** Derived local calendar day, YYYY-MM-DD. */
  readonly localDate: string;

  readonly nutritionCalcVersion: string;
  readonly status: FoodLogStatus;
  readonly supersedesLogId?: string;
  readonly mealId?: string;
}

export interface IntakeTotals extends NutritionTotals {
  readonly itemCount: number;
}
