import { lookupByGtin, normalizeGtin, type IdentifierLookup } from '@macros/catalog-ingestion';
import type { CanonicalProductVersion, RuntimeCatalog } from './projection.js';

/**
 * BARCODE APPLICATION FLOW.
 *
 * barcode string → GTIN validation → identifier repository → current
 * ProductVersion → confirmation. It reuses the existing weight/review/log path;
 * there is no second logging route, no model involvement, and no auto-log.
 */
export type BarcodeScanResult =
  | { readonly outcome: 'found'; readonly product: CanonicalProductVersion }
  | { readonly outcome: 'not_found' }
  | { readonly outcome: 'invalid_identifier'; readonly reason: string }
  | { readonly outcome: 'conflicted_identifier' }
  | { readonly outcome: 'discontinued'; readonly product: CanonicalProductVersion };

export class BarcodeScanner {
  constructor(private readonly catalog: RuntimeCatalog) {}

  /**
   * Accepts a STRING only.
   *
   * A JavaScript number cannot represent "076014101088" — the leading zero is
   * already lost before this function is reached, and stringifying it would
   * yield a different, possibly valid, barcode for a different product.
   */
  async scan(raw: string): Promise<BarcodeScanResult> {
    if (typeof raw !== 'string') {
      return { outcome: 'invalid_identifier', reason: 'non_string_identifier' };
    }
    const normalized = normalizeGtin(raw);
    if (!normalized.ok) {
      return { outcome: 'invalid_identifier', reason: normalized.reason };
    }

    const versionId = this.catalog.gtinVersionId(normalized.gtin14);
    if (versionId === null) return { outcome: 'not_found' };

    const projected = this.catalog.projected(versionId);
    if (projected === null) return { outcome: 'not_found' };

    const product = await this.catalog.resolve(versionId);
    if (product === null) return { outcome: 'not_found' };

    // Authoritative facts decide, not the index.
    return product.discontinued
      ? { outcome: 'discontinued', product }
      : { outcome: 'found', product };
  }
}

export { lookupByGtin, type IdentifierLookup };
