import type { SearchableFood } from '@macros/domain-food-search';

/**
 * BOUNDED RUNTIME CATALOG PROJECTION.
 *
 * The full branded catalog is hundreds of megabytes, so the tablet never parses
 * it. Two small structures are loaded instead:
 *
 *   - a SEARCH PROJECTION: identity and retrieval text only
 *   - a GTIN INDEX: barcode → productId
 *
 * Neither carries nutrition. A search projection that held nutrition would
 * become a second, unversioned source of truth; here it can only ever nominate
 * a candidate identity, and the canonical ProductVersion supplies every number.
 */
export const CATALOG_PROJECTION_VERSION = 'catalog-projection@1.0.0';

/** One projection entry: enough to find and disambiguate, nothing more. */
export interface ProjectedFood {
  readonly productId: string;
  readonly productVersionId: string;
  readonly displayName: string;
  readonly kind: 'generic' | 'branded';
  readonly preparationState: string;
  /** Consumer-facing brand, NOT the corporate owner. */
  readonly brandName?: string;
  readonly subbrandName?: string;
  /** Corporate/retailer owner — retrieval metadata only, ranked below brand. */
  readonly brandOwner?: string;
  readonly aliases?: readonly string[];
  readonly hasBarcode: boolean;
  readonly discontinued: boolean;
  readonly recommendable: boolean;
}

/** Resolves a candidate identity to its authoritative facts. */
export interface ProductVersionResolver {
  resolve(productVersionId: string): Promise<CanonicalProductVersion | null>;
}

export interface CanonicalProductVersion {
  readonly productId: string;
  readonly productVersionId: string;
  readonly displayName: string;
  readonly kind: 'generic' | 'branded';
  readonly per100g: Readonly<Record<string, { amount: number; unit: string }>>;
  readonly servingGrams: number | null;
  readonly householdServingText: string | null;
  readonly labelFacts?: unknown;
  readonly ingredientsText?: string | null;
  readonly gtin14?: string | null;
  readonly brandName?: string | null;
  readonly subbrandName?: string | null;
  readonly discontinued: boolean;
}

const toSearchable = (p: ProjectedFood): SearchableFood => ({
  productVersionId: p.productVersionId,
  displayName: p.displayName,
  preparationState: p.preparationState,
  ...(p.brandName !== undefined ? { brandName: p.brandName } : {}),
  aliases: [
    ...(p.aliases ?? []),
    // Brand terms are retrieval metadata. The consumer-facing brand and
    // subbrand come first; the corporate owner is included but is deliberately
    // the weakest signal — "Wal-Mart" names a retailer, not a product brand.
    ...(p.brandName !== undefined ? [p.brandName] : []),
    ...(p.subbrandName !== undefined ? [p.subbrandName] : []),
    ...(p.brandOwner !== undefined ? [p.brandOwner] : []),
  ],
});

/**
 * The single catalog surface the application searches — generic and branded
 * through ONE contract. There is no second food-search state machine.
 */
export class RuntimeCatalog {
  private readonly byVersionId = new Map<string, ProjectedFood>();
  private readonly gtinIndex = new Map<string, string>();

  constructor(
    projection: readonly ProjectedFood[],
    gtinIndex: Readonly<Record<string, string>> = {},
    private readonly resolver: ProductVersionResolver | null = null,
  ) {
    for (const p of projection) this.byVersionId.set(p.productVersionId, p);
    for (const [gtin, versionId] of Object.entries(gtinIndex)) this.gtinIndex.set(gtin, versionId);
  }

  /**
   * Searchable set: CURRENT versions only. Historical versions and
   * discontinued products never appear in normal search, but remain resolvable
   * so an old FoodLog can still render exactly what was logged.
   */
  searchableFoods(): readonly SearchableFood[] {
    const out: SearchableFood[] = [];
    for (const p of this.byVersionId.values()) {
      if (p.discontinued) continue;
      out.push(toSearchable(p));
    }
    return out.sort((a, b) => a.productVersionId.localeCompare(b.productVersionId));
  }

  /** Candidates eligible for recommendation. Stricter than searchable. */
  recommendableVersionIds(): readonly string[] {
    return [...this.byVersionId.values()]
      .filter((p) => p.recommendable && !p.discontinued)
      .map((p) => p.productVersionId)
      .sort();
  }

  projected(productVersionId: string): ProjectedFood | null {
    return this.byVersionId.get(productVersionId) ?? null;
  }

  gtinVersionId(gtin14: string): string | null {
    return this.gtinIndex.get(gtin14) ?? null;
  }

  /** Authoritative facts come from the resolver, never from the projection. */
  async resolve(productVersionId: string): Promise<CanonicalProductVersion | null> {
    if (this.resolver === null) return null;
    return this.resolver.resolve(productVersionId);
  }

  size(): { projection: number; gtinIndex: number } {
    return { projection: this.byVersionId.size, gtinIndex: this.gtinIndex.size };
  }
}
