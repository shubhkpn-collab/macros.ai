/**
 * CATALOG SOURCE REGISTRY.
 *
 * Provenance metadata, NOT a legal-rules engine. It records what a source is,
 * which release was used, and what licence the OWNER has verified — nothing
 * here infers rights for a source nobody has reviewed.
 */
export type CatalogProvider = 'usda_fdc' | 'in_house_curation' | 'synthetic_test';

/** USDA FDC data types. Branded is deliberately out of scope for this milestone. */
export type CatalogDataType =
  | 'foundation_foods'
  | 'sr_legacy'
  | 'fndds'
  | 'branded'
  | 'in_house'
  | 'synthetic';

/**
 * A licence class may only be asserted for a source that has actually been
 * reviewed. `unreviewed` is the default and is not a placeholder for optimism —
 * an unreviewed source may not be published.
 */
/**
 * LICENCE PERMISSION AND NUTRITION EVIDENCE ARE DIFFERENT AXES.
 *
 * "May we legally publish this?" and "how good is this nutrition data?" answer
 * different questions and must never imply one another. A source being legally
 * usable says nothing about whether its numbers came from a manufacturer label
 * or from an estimate.
 */
export type PublicationScope = 'production_allowed' | 'test_only' | 'blocked';

/**
 * Where the nutrition facts actually came from. This — never the licence — is
 * what a trust indicator may be derived from.
 *
 * USDA is an authoritative database, NOT a manufacturer label. It must never be
 * presented as manufacturer-verified merely because it is authoritative.
 */
export type NutritionEvidence =
  | 'manufacturer_label'
  | 'authoritative_database'
  | 'curated_database'
  | 'estimated'
  | 'synthetic_test';

export type LicenseClass =
  | 'public_domain_cc0'
  | 'owned_in_house'
  | 'synthetic_test_data'
  | 'unreviewed';

export interface CatalogSourceDefinition {
  readonly sourceKey: string;
  readonly provider: CatalogProvider;
  readonly dataType: CatalogDataType;
  /** The specific published release. Never "latest". */
  readonly releaseId: string;
  readonly licenseClass: LicenseClass;
  /** May records from this source ever reach the production catalog? */
  readonly publicationScope: PublicationScope;
  /** The evidence class of this source's nutrition facts. Not its licence. */
  readonly nutritionEvidence: NutritionEvidence;
  readonly attribution: string;
  /** Set by the importer from the actual file it read. */
  readonly sourceFileHash?: string;
  readonly sourceFileName?: string;
  readonly importedAt?: string;
  /** How the licence was established. Absent means nobody checked. */
  readonly licenseVerification?: {
    readonly verifiedBy: string;
    readonly verifiedOn: string;
    readonly reference: string;
  };
}

/**
 * OWNER-VERIFIED, 2026-08-17, from the official USDA FoodData Central
 * documentation: FDC data are public domain under CC0 1.0.
 *
 * This applies to USDA FDC ONLY. It is not a precedent for retailers,
 * manufacturers, commercial databases, Open Food Facts, imagery, or any other
 * dataset — each needs its own review before it may be registered.
 */
export const USDA_LICENSE_VERIFICATION = {
  verifiedBy: 'owner',
  verifiedOn: '2026-08-17',
  reference: 'USDA FoodData Central official documentation',
} as const;

/** Sources are registered here only once their licence has been established. */
export const KNOWN_SOURCES: readonly CatalogSourceDefinition[] = [
  {
    sourceKey: 'usda_fdc.foundation_foods',
    provider: 'usda_fdc',
    dataType: 'foundation_foods',
    releaseId: 'PENDING_SOURCE_FILE',
    licenseClass: 'public_domain_cc0',
    publicationScope: 'production_allowed',
    // Authoritative, but a government database is not a manufacturer label.
    nutritionEvidence: 'authoritative_database',
    attribution: 'U.S. Department of Agriculture, Agricultural Research Service, FoodData Central',
    licenseVerification: USDA_LICENSE_VERIFICATION,
  },
  {
    sourceKey: 'usda_fdc.sr_legacy',
    provider: 'usda_fdc',
    dataType: 'sr_legacy',
    releaseId: 'PENDING_SOURCE_FILE',
    licenseClass: 'public_domain_cc0',
    publicationScope: 'production_allowed',
    nutritionEvidence: 'authoritative_database',
    attribution: 'U.S. Department of Agriculture, Agricultural Research Service, FoodData Central',
    licenseVerification: USDA_LICENSE_VERIFICATION,
  },
];

/**
 * CANONICAL SOURCE KIND — derived from a VALIDATED registry entry, never from
 * dataType alone.
 *
 * Inferring `usda_foundation` from `dataType === 'foundation_foods'` would let
 * any provider masquerade as USDA simply by naming its data type. Provenance is
 * a property of the registered source, so the provider must agree too, and an
 * unknown combination fails rather than falling back to a misleading kind.
 */
export function canonicalSourceKind(source: CatalogSourceDefinition): string {
  const key = `${source.provider}:${source.dataType}` as const;
  switch (key) {
    case 'usda_fdc:foundation_foods': return 'usda_foundation';
    case 'usda_fdc:sr_legacy': return 'usda_sr_legacy';
    case 'usda_fdc:branded': return 'usda_branded';
    case 'in_house_curation:in_house': return 'curated_manual';
    case 'synthetic_test:synthetic': return 'synthetic_test';
    default:
      throw new Error(
        `canonicalSourceKind: unknown provider/dataType combination "${key}" — ` +
          'provenance must come from a validated registry entry, never from dataType alone',
      );
  }
}

export type ImportMode = 'production' | 'test';

/**
 * Publication gate. Licence review alone is not enough: a test-only source may
 * never reach the production catalog, and no comment or convention is relied on
 * to prevent it.
 */
export function assertPublishable(source: CatalogSourceDefinition, mode: ImportMode): void {
  if (source.licenseClass === 'unreviewed' || source.licenseVerification === undefined) {
    throw new Error(
      `assertPublishable: source "${source.sourceKey}" has no verified licence and may not be published from`,
    );
  }
  if (source.publicationScope === 'blocked') {
    throw new Error(`assertPublishable: source "${source.sourceKey}" is blocked from publication`);
  }
  if (mode === 'production' && source.publicationScope !== 'production_allowed') {
    throw new Error(
      `assertPublishable: source "${source.sourceKey}" is ${source.publicationScope} and may never ` +
        'enter the production catalog',
    );
  }
}

/** A source may be published from only when its licence has been reviewed. */
export function isPublishable(source: CatalogSourceDefinition): boolean {
  return (
    source.licenseClass !== 'unreviewed' &&
    source.licenseVerification !== undefined &&
    source.publicationScope !== 'blocked'
  );
}

/**
 * Evidence maps to a verification status — from the SOURCE'S EVIDENCE CLASS,
 * never from the fact that a licence was reviewed or a schema validated.
 */
export function verificationStatusFor(source: CatalogSourceDefinition): string {
  switch (source.nutritionEvidence) {
    case 'manufacturer_label': return 'manufacturer_verified';
    case 'authoritative_database': return 'auto_validated';
    case 'curated_database': return 'steward_verified';
    case 'estimated': return 'unverified';
    case 'synthetic_test': return 'synthetic_test';
  }
}
