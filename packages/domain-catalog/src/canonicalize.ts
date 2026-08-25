import type { ProductCatalogHead, ProductVersion } from '@macros/contracts';
import type { NormalizedCandidate } from './raw-record.js';
import type { CurationEntry } from './curation.js';
import { canonicalFingerprint } from './curation.js';

export const CATALOG_CANONICALIZE_VERSION = 'catalog-canonicalize@1.0.0';

export type VersionDecision =
  | { readonly kind: 'unchanged'; readonly productVersionId: string }
  | { readonly kind: 'new_version'; readonly productVersion: ProductVersion }
  | { readonly kind: 'first_version'; readonly productVersion: ProductVersion };

export interface CanonicalizeInput {
  /** Supplied by the caller: the domain reads no clock. */
  readonly effectiveFrom: string;
  readonly candidate: NormalizedCandidate;
  readonly curation: CurationEntry;
  /** The version the catalog head currently points at, if any. */
  readonly currentVersion: ProductVersion | null;
  readonly currentFingerprint: string | null;
  /** Supplied by the caller; the domain never generates ids or reads a clock. */
  readonly nextVersionId: string;
  readonly sourceKind: ProductVersion['source']['kind'];
  readonly verificationStatus: ProductVersion['source']['verificationStatus'];
  readonly licenseClass: string;
}

/**
 * Turn a curated candidate into a canonical ProductVersion decision.
 *
 * PURE. The rule that matters:
 *
 *   facts unchanged  → NO new version (import time is not a fact)
 *   facts changed    → a NEW version; V1 is never rewritten
 *
 * Verification timestamps and aliases live in mutable review metadata precisely
 * so they cannot manufacture versions here.
 */
export function canonicalize(input: CanonicalizeInput): VersionDecision {
  const { candidate, curation, currentVersion, currentFingerprint, nextVersionId } = input;

  const displayName = curation.displayName ?? candidate.displayName;
  const preparationState = curation.preparationState ?? candidate.preparationState;
  if (preparationState === 'unresolved') {
    throw new Error('canonicalize: preparation state must be resolved before publishing');
  }

  const fingerprint = canonicalFingerprint(candidate, displayName, preparationState);
  if (currentVersion !== null && currentFingerprint === fingerprint) {
    return { kind: 'unchanged', productVersionId: currentVersion.productVersionId };
  }

  const n = candidate.per100g;
  if (n.kcal === undefined || n.proteinG === undefined || n.carbohydrateG === undefined || n.fatG === undefined) {
    throw new Error('canonicalize: a publishable version requires energy and all core macros');
  }

  const productVersion: ProductVersion = {
    productId: curation.productId,
    productVersionId: nextVersionId,
    versionNo: (currentVersion?.versionNo ?? 0) + 1,
    effectiveFrom: input.effectiveFrom as ProductVersion['effectiveFrom'],
    displayName,
    preparationState,
    ...(curation.category !== undefined ? { category: curation.category } : {}),
    ...(candidate.brandName !== undefined ? { brandName: candidate.brandName } : {}),
    basis: {
      kind: 'per_100g',
      // Source-declared energy is carried through unchanged. Atwater arithmetic
      // is a quality flag elsewhere and never overwrites it.
      kcal: n.kcal,
      proteinG: n.proteinG,
      carbohydrateG: n.carbohydrateG,
      fatG: n.fatG,
      ...(n.fiberG !== undefined ? { fiberG: n.fiberG } : {}),
      ...(n.sugarG !== undefined ? { sugarG: n.sugarG } : {}),
      ...(n.sodiumMg !== undefined ? { sodiumMg: n.sodiumMg } : {}),
    },
    source: {
      kind: input.sourceKind,
      sourceId: candidate.raw.sourceRecordId,
      // Publication-time status. Current review state is mutable metadata.
      verificationStatus: input.verificationStatus,
      licenseClass: input.licenseClass,
      releaseId: candidate.raw.releaseId,
      sourceFileHash: candidate.raw.sourceFileHash,
    },
    labelFacts: {
      // The source's own declared basis, retained verbatim for audit. It is
      // never reconstructed from the normalized values.
      ...(candidate.declaredPer100 !== undefined ? { declaredPer100: candidate.declaredPer100 } : {}),
      rawSourcePayloadRef: `${candidate.raw.sourceKey}#${candidate.raw.sourceRecordId}@${candidate.raw.releaseId}`,
    },
  };

  return currentVersion === null
    ? { kind: 'first_version', productVersion }
    : { kind: 'new_version', productVersion };
}

/** Advancing the head is the ONLY mutation. V1 is never touched. */
export function advanceHead(head: ProductCatalogHead, productVersionId: string): ProductCatalogHead {
  return { ...head, currentProductVersionId: productVersionId };
}
