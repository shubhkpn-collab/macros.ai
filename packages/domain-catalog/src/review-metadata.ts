/**
 * MUTABLE CATALOG REVIEW METADATA — deliberately separate from ProductVersion.
 *
 * A steward re-reading a food, or an alias being added, must NOT create a new
 * nutrition version or rewrite an immutable one. Verification state and search
 * aliases change on their own schedule; food facts do not change unless the
 * facts change.
 */
export type VerificationState =
  | 'source_backed'
  | 'steward_reviewed'
  | 'estimated'
  | 'unreviewed';

export interface CatalogReviewMetadata {
  readonly productId: string;
  /** The version this review refers to; reviewing does not mutate that version. */
  readonly reviewedProductVersionId: string;
  readonly verificationState: VerificationState;
  readonly lastVerifiedAt: string;
  readonly reviewedBy: string;
  readonly notes?: string;
}

/**
 * Search aliases. SEARCH METADATA, never nutrition facts — editing them can
 * never produce a new ProductVersion.
 */
export interface CatalogAliasSet {
  readonly productId: string;
  readonly aliases: readonly string[];
  readonly curatedBy: string;
  readonly curatedAt: string;
}

/**
 * Source trust, for a future UI to render honestly.
 *
 * Database-sourced nutrition is NEVER labelled manufacturer-verified. The
 * semantics are modelled; final visual copy is not, because it has not been
 * reviewed.
 */
export interface SourceTrust {
  readonly sourceKey: string;
  readonly verificationState: VerificationState;
  readonly isSourceBacked: boolean;
  readonly isEstimate: boolean;
}
