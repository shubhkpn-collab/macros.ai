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

  /**
   * CORRECTIONS ARE APPEND-ONLY.
   *
   * An original entry is NEVER mutated — not its nutrition, not its weight, not
   * even its status. The persisted schema grants INSERT only, so a stored row
   * physically cannot be rewritten. A correction is a NEW entry naming the
   * entry it supersedes, and effective state is DERIVED by folding the stream.
   *
   * `status` therefore records what this entry was at write time and stays
   * `'active'` forever; the fold decides what is currently effective.
   */
  readonly entryKind?: 'original' | 'correction';
  readonly supersedesLogId?: string;
  readonly correctionReason?: string;
  readonly mealId?: string;
}

/**
 * A VOID ENTRY.
 *
 * Deliberately carries no nutrition and no weight: a voided meal did not
 * happen, and inventing zeroed nutrition for it would put a fabricated record
 * in the log stream. It only names the entry it removes.
 *
 * The local day is inherited from the entry being voided, so a void can never
 * silently move a meal to another day.
 */
export interface FoodLogVoidEntry {
  readonly entryKind: 'void';
  readonly logId: string;
  readonly userId: string;
  readonly voidsLogId: string;
  readonly reason?: string;
  readonly recordedAt: Instant;
  readonly eventTimezone: string;
  readonly eventUtcOffsetMinutes: number;
  readonly localDate: string;
}

/** One append-only stream: originals, corrections and voids together. */
export type FoodLogEntry = FoodLogItem | FoodLogVoidEntry;

export const isVoidEntry = (entry: FoodLogEntry): entry is FoodLogVoidEntry =>
  (entry as FoodLogVoidEntry).entryKind === 'void';

export interface IntakeTotals extends NutritionTotals {
  readonly itemCount: number;
}
