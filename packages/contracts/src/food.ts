import type { NutrientBasis, NutritionTotals } from './nutrition.js';
import type { Instant } from './primitives.js';

/**
 * Preparation state is EXPLICIT and never converted.
 *
 * If the user selected cooked chicken breast, the log references that cooked
 * version. We never take a raw version and apply a yield factor — that
 * compounds error and hides it. Disambiguation happens at selection.
 */
export type PreparationState = 'raw' | 'cooked' | 'prepared' | 'as_sold';

export type ProductSourceKind =
  | 'synthetic_test'
  | 'usda_foundation'
  | 'usda_sr_legacy'
  | 'usda_branded'
  | 'curated_manual'
  | 'household_private';

export type VerificationStatus =
  | 'unverified'
  | 'auto_validated'
  | 'steward_verified'
  | 'manufacturer_verified'
  | 'synthetic_test';

/**
 * The facts exactly as the source declared them.
 *
 * Kept alongside the normalized per-100 g basis so the original label can
 * always be shown and audited. The source label is NEVER reconstructed from
 * normalized data — that would silently invent a label that never existed.
 */
export interface ProductLabelFacts {
  readonly servingLabel?: string;
  readonly servingGrams?: number;
  readonly declaredPerServing?: NutritionTotals;
  readonly declaredPer100?: NutrientBasis;
  readonly ingredientsText?: string;
  readonly rawSourcePayloadRef?: string;
}

/**
 * Provenance, frozen AT PUBLICATION TIME.
 *
 * `verificationStatus` and `lastVerifiedAt` record what was known when this
 * version was published — immutable facts about that moment. They are NOT the
 * product's current review state: a steward re-reading a food later must not
 * mutate an immutable version, nor manufacture a new nutrition version merely
 * by re-reviewing. Current review state lives in `CatalogReviewMetadata`
 * (`@macros/domain-catalog`), which is mutable by design.
 */
export interface ProductSource {
  readonly kind: ProductSourceKind;
  readonly sourceId: string;
  readonly verificationStatus: VerificationStatus;
  readonly lastVerifiedAt?: Instant;
  readonly licenseClass?: string;
  /** The specific published release this record came from. Never "latest". */
  readonly releaseId?: string;
  /** Hash of the source file, so the transformation stays auditable. */
  readonly sourceFileHash?: string;
}

/**
 * An IMMUTABLE snapshot of a product's data. Logs reference a version, never a
 * product, so correcting a product tomorrow cannot rewrite what a user was
 * told today.
 */
export interface ProductVersion {
  readonly productId: string;
  readonly productVersionId: string;
  readonly versionNo: number;
  readonly displayName: string;
  readonly brandName?: string;
  readonly preparationState: PreparationState;
  /** Canonical normalized basis. All arithmetic runs off this. */
  readonly basis: NutrientBasis;
  /** The original declared facts, retained verbatim. */
  readonly labelFacts?: ProductLabelFacts;
  readonly source: ProductSource;
  readonly effectiveFrom: Instant;
}

/**
 * MUTABLE catalog state, deliberately separate from the immutable version.
 *
 * Availability, the current version pointer and de-listing all change over
 * time. Keeping them inside ProductVersion would make an "immutable" record
 * mutable in practice. A correction inserts V2 and repoints the head; V1 is
 * never rewritten, and logs that reference V1 keep meaning exactly what they
 * meant.
 */
export interface ProductCatalogHead {
  readonly productId: string;
  readonly currentProductVersionId: string;
  readonly isActive: boolean;
  readonly updatedAt: Instant;
}

/**
 * Nutrition computed once, at log time, and frozen.
 * Daily totals are summed from these — never recomputed from live product data.
 */
export interface NutritionSnapshot {
  readonly totals: NutritionTotals;
  readonly gramsConsumed: number;
  readonly productVersionId: string;
  readonly basisKind: NutrientBasis['kind'];
  readonly calcVersion: string;
  readonly computedAt: Instant;
}
