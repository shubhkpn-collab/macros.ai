import type { ProductCatalogHead, ProductVersion } from '@macros/contracts';
import type { CatalogAliasSet } from './review-metadata.js';

/**
 * The searchable projection of the catalog.
 *
 * Derived from the CURRENT version behind an ACTIVE head, plus curated aliases.
 * Historical and de-listed versions stay resolvable by id — a food log from
 * last year must never break — but they are not normal search results.
 */
export interface CatalogSearchDocument {
  readonly productId: string;
  readonly productVersionId: string;
  readonly displayName: string;
  readonly brandName?: string;
  readonly preparationState: ProductVersion['preparationState'];
  readonly aliases: readonly string[];
  readonly category?: string;
}

export interface ProjectionInput {
  readonly versions: readonly ProductVersion[];
  readonly heads: readonly ProductCatalogHead[];
  readonly aliasSets: readonly CatalogAliasSet[];
}

/** PURE and deterministic: same inputs, same documents, same order. */
export function buildSearchProjection(input: ProjectionInput): readonly CatalogSearchDocument[] {
  const byVersionId = new Map(input.versions.map((v) => [v.productVersionId, v]));
  const aliasesByProduct = new Map(input.aliasSets.map((a) => [a.productId, a.aliases]));

  const docs: CatalogSearchDocument[] = [];
  for (const head of input.heads) {
    if (!head.isActive) continue;
    const version = byVersionId.get(head.currentProductVersionId);
    if (version === undefined) continue;

    docs.push({
      productId: version.productId,
      productVersionId: version.productVersionId,
      displayName: version.displayName,
      ...(version.brandName !== undefined ? { brandName: version.brandName } : {}),
      preparationState: version.preparationState,
      aliases: aliasesByProduct.get(version.productId) ?? [],
    });
  }

  return docs.sort((a, b) => a.productVersionId.localeCompare(b.productVersionId));
}
