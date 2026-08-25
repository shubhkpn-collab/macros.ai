import type { NutrientBasis } from '@macros/contracts';
import type { ExternalProductIdentifier } from './identifiers.js';

/**
 * BRANDED GROCERY PRODUCTS.
 *
 * Branded and generic foods resolve to the SAME `ProductVersion` and the same
 * `calculateNutrition`. Branded products add identification, label and package
 * metadata — they never introduce a second nutrition engine.
 */

/** Kept structured. Concatenating these into one string loses the query signal. */
export interface BrandIdentity {
  readonly brandName: string;
  /** The company behind the brand, when the source distinguishes them. */
  readonly manufacturerName?: string;
}

/**
 * THE ORIGINAL LABEL, RETAINED VERBATIM.
 *
 * The declared label is a historical source fact. It is NEVER reconstructed by
 * multiplying per-100 g values: label values are rounded under labelling rules,
 * so a reconstruction can disagree with what the package actually says. When
 * they differ, the original label wins as the record of what the source stated.
 *
 * Every field is optional ONLY because a source may genuinely omit it. A
 * missing label fact stays missing; it is never invented.
 */
export interface PackageLabelFacts {
  /** e.g. "1/2 cup dry". The household description as printed. */
  readonly servingDescription?: string;
  readonly servingGrams?: number;
  readonly servingMillilitres?: number;
  readonly servingsPerContainer?: number;
  /** e.g. "18 oz box", "12-pack". Identifies the package, not the food. */
  readonly netQuantityDescription?: string;

  readonly kcalPerServing?: number;
  readonly proteinGPerServing?: number;
  readonly carbohydrateGPerServing?: number;
  readonly fatGPerServing?: number;
  readonly fiberGPerServing?: number;
  readonly sugarGPerServing?: number;
  readonly sodiumMgPerServing?: number;
}

export interface BrandedProductFacts {
  readonly brand: BrandIdentity;
  /** "Original", "Vanilla", "Nonfat". A different variant is a different food. */
  readonly variant?: string;
  readonly label?: PackageLabelFacts;
  readonly identifiers?: readonly ExternalProductIdentifier[];
}

export const LABEL_NORMALIZATION_VERSION = 'label-normalization@1.0.0';

export type LabelNormalizationResult =
  | { readonly ok: true; readonly per100g: NutrientBasis; readonly algorithmVersion: string }
  | { readonly ok: false; readonly reason: LabelNormalizationRejection };

export type LabelNormalizationRejection =
  | 'no_serving_mass'
  | 'serving_mass_not_positive'
  | 'missing_label_energy'
  | 'missing_required_label_macro';

/**
 * Normalize a serving label to the canonical per-100 g basis.
 *
 *     per100g = perServing / servingGrams × 100
 *
 * Requires a DEFENSIBLE serving mass. A label reading "1 cup" with no gram
 * equivalent cannot be normalized: inventing a generic density would produce
 * confident wrong nutrition, so it goes to curation instead.
 *
 * The original label is retained separately and untouched. Rounding differences
 * between label and reconstruction are expected and are never hidden.
 */
export function normalizeLabelToPer100g(label: PackageLabelFacts): LabelNormalizationResult {
  const grams = label.servingGrams;
  if (grams === undefined) return { ok: false, reason: 'no_serving_mass' };
  if (!Number.isFinite(grams) || grams <= 0) {
    return { ok: false, reason: 'serving_mass_not_positive' };
  }
  if (label.kcalPerServing === undefined) return { ok: false, reason: 'missing_label_energy' };
  if (
    label.proteinGPerServing === undefined ||
    label.carbohydrateGPerServing === undefined ||
    label.fatGPerServing === undefined
  ) {
    return { ok: false, reason: 'missing_required_label_macro' };
  }

  const factor = 100 / grams;
  const scale = (v: number | undefined): number | undefined =>
    v === undefined ? undefined : v * factor;

  return {
    ok: true,
    algorithmVersion: LABEL_NORMALIZATION_VERSION,
    per100g: {
      kind: 'per_100g',
      kcal: label.kcalPerServing * factor,
      proteinG: label.proteinGPerServing * factor,
      carbohydrateG: label.carbohydrateGPerServing * factor,
      fatG: label.fatGPerServing * factor,
      ...(scale(label.fiberGPerServing) !== undefined ? { fiberG: scale(label.fiberGPerServing)! } : {}),
      ...(scale(label.sugarGPerServing) !== undefined ? { sugarG: scale(label.sugarGPerServing)! } : {}),
      ...(scale(label.sodiumMgPerServing) !== undefined ? { sodiumMg: scale(label.sodiumMgPerServing)! } : {}),
    },
  };
}

/**
 * Source priority for conflicting facts about ONE product. Lower is stronger.
 * Values are never averaged: averaging two disagreeing sources produces a
 * number neither source stands behind.
 */
export const SOURCE_PRIORITY: Readonly<Record<string, number>> = {
  manufacturer_label: 1,
  approved_retailer: 2,
  authoritative_database: 3,
  curated_database: 4,
  estimated: 5,
  synthetic_test: 99,
};

export type ConflictResolution =
  | { readonly kind: 'resolved'; readonly winningEvidence: string }
  | { readonly kind: 'needs_curation'; readonly reason: 'source_conflict' };

/**
 * Resolve disagreeing sources by explicit priority, or refuse.
 *
 * Equal priority with different facts is a genuine conflict — a curator
 * decides. Nothing is merged or averaged.
 */
export function resolveSourceConflict(
  candidates: readonly { readonly evidence: string; readonly fingerprint: string }[],
): ConflictResolution {
  if (candidates.length <= 1) {
    return { kind: 'resolved', winningEvidence: candidates[0]?.evidence ?? 'none' };
  }
  if (new Set(candidates.map((c) => c.fingerprint)).size === 1) {
    return { kind: 'resolved', winningEvidence: candidates[0]!.evidence };
  }

  const ranked = [...candidates].sort(
    (a, b) => (SOURCE_PRIORITY[a.evidence] ?? 50) - (SOURCE_PRIORITY[b.evidence] ?? 50),
  );
  const best = SOURCE_PRIORITY[ranked[0]!.evidence] ?? 50;
  const tied = ranked.filter((c) => (SOURCE_PRIORITY[c.evidence] ?? 50) === best);
  if (tied.length > 1) return { kind: 'needs_curation', reason: 'source_conflict' };
  return { kind: 'resolved', winningEvidence: ranked[0]!.evidence };
}
