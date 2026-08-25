import type { NormalizedCandidate } from './raw-record.js';

/**
 * CURATION.
 *
 * Source availability is not publication. A steward decides what enters the
 * MACROS.AI catalog, under what canonical identity, with what aliases. Kept as
 * version-controlled data — this milestone builds no steward software.
 */
export type CurationDecision = 'publish' | 'reject' | 'unresolved';

export interface CurationEntry {
  readonly sourceKey: string;
  readonly sourceRecordId: string;
  /**
   * Our forever-stable identity, assigned by curation.
   *
   * NOT the source record id. A source identifier is provenance; it carries no
   * promise of stability across releases, and adopting it as our primary key
   * would hand our identity model to an external publisher.
   */
  readonly productId: string;
  readonly decision: CurationDecision;
  readonly displayName?: string;
  readonly preparationState?: 'raw' | 'cooked' | 'prepared' | 'as_sold';
  readonly category?: string;
  readonly aliases?: readonly string[];
  readonly notes?: string;
}

export interface CurationManifest {
  readonly manifestVersion: string;
  readonly entries: readonly CurationEntry[];
}

export function findCuration(
  manifest: CurationManifest,
  sourceKey: string,
  sourceRecordId: string,
): CurationEntry | undefined {
  return manifest.entries.find(
    (e) => e.sourceKey === sourceKey && e.sourceRecordId === sourceRecordId,
  );
}

/**
 * The canonical fingerprint of a candidate's FOOD FACTS.
 *
 * Deterministic and independent of import time, review metadata and aliases, so
 * re-importing an unchanged record produces no meaningless new version, while a
 * genuine factual change produces one.
 */
/**
 * VERSION IDENTITY — the A7 field classification.
 *
 * A factual product change creates a version; a search, curation or
 * presentation edit does not. Every ProductVersion field is classified:
 *
 * IMMUTABLE FOOD FACTS — part of version identity:
 *   displayName          the food this record is about
 *   preparationState     raw and cooked are different foods, never converted
 *   basis (per 100 g)    the nutrition itself
 *   brandName            a different brand is a different product, not a relabel
 *   variant              "Nonfat" vs "Whole" is a different formulation
 *   labelFacts servings  the declared serving basis is a source fact we retain
 *
 * MUTABLE METADATA — deliberately NOT part of version identity:
 *   category             a curation/browse decision
 *   aliases              search metadata; editing one must never re-version
 *   verificationStatus   publication-time provenance; re-review must not re-version
 *   lastVerifiedAt       same
 *   releaseId / hash     import metadata; a re-import is not a food fact
 *   packageDescriptor    "32 oz tub" identifies a package, not the food per gram.
 *                        A pack-count or carton redesign must not rewrite history.
 *   externalIdentifiers  a GTIN belongs to catalog identity, not nutrition. A
 *                        manufacturer may reassign a barcode without changing
 *                        the food, and may reformulate without changing it.
 *   imageRef             presentation only
 *
 * Deliberately excluded despite being tempting: package size and GTIN. Both
 * change for commercial reasons that have nothing to do with what a gram of the
 * food contains, and including them would manufacture versions — silently
 * splitting a product's history for a carton redesign.
 */
export interface FingerprintInput {
  readonly displayName: string;
  readonly preparationState: string;
  readonly brandName?: string;
  readonly variant?: string;
  readonly per100g: NormalizedCandidate['per100g'];
  /** Declared serving basis, when the source supplied one. A source fact. */
  readonly servingGrams?: number;
  readonly servingLabelKcal?: number;
}

export function fingerprintOf(input: FingerprintInput): string {
  const n = input.per100g;
  const parts = [
    input.displayName.trim().toLowerCase(),
    input.preparationState,
    (input.brandName ?? '').trim().toLowerCase(),
    (input.variant ?? '').trim().toLowerCase(),
    n.kcal, n.proteinG, n.carbohydrateG, n.fatG, n.fiberG, n.sugarG, n.sodiumMg,
    input.servingGrams,
    input.servingLabelKcal,
  ];
  return parts.map((p) => (p === undefined || p === '' ? '~' : String(p))).join('|');
}

/**
 * The canonical fingerprint of a candidate's FOOD FACTS.
 *
 * Deterministic and independent of import time, review metadata, aliases,
 * package descriptors and external identifiers, so re-importing an unchanged
 * record produces no meaningless new version while a genuine factual change
 * produces one.
 */
export function canonicalFingerprint(
  c: NormalizedCandidate,
  displayName: string,
  preparationState: string,
): string {
  return fingerprintOf({
    displayName,
    preparationState,
    ...(c.brandName !== undefined ? { brandName: c.brandName } : {}),
    ...(c.variant !== undefined ? { variant: c.variant } : {}),
    per100g: c.per100g,
    ...(c.labelFacts?.servingGrams !== undefined ? { servingGrams: c.labelFacts.servingGrams } : {}),
    ...(c.labelFacts?.kcalPerServing !== undefined ? { servingLabelKcal: c.labelFacts.kcalPerServing } : {}),
  });
}
