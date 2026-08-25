/**
 * EXTERNAL PRODUCT IDENTIFIERS.
 *
 * A barcode is EXTERNAL identity and provenance. It is never the MACROS.AI
 * `productId`, because a manufacturer may reformulate a product without
 * changing its barcode, and may reassign a barcode without changing the food.
 * Our identity must survive both.
 *
 *   GTIN → catalog head → current ProductVersion
 *
 * Historical food logs keep referencing the exact ProductVersion they were
 * created with; they never follow the head.
 */
export type IdentifierScheme = 'gtin_12' | 'gtin_13' | 'gtin_14' | 'source_specific';

/** Traceable identifier state. Deliberately small — not an identifier history service. */
export type IdentifierState = 'current' | 'superseded' | 'conflicted';

export interface ExternalProductIdentifier {
  readonly scheme: IdentifierScheme;
  /** Digits only, zero-padded to 14 for GTINs so schemes compare correctly. */
  readonly normalizedValue: string;
  /** Exactly as the source supplied it, for audit. */
  readonly rawValue: string;
  readonly sourceKey: string;
  readonly state: IdentifierState;
}

export type GtinValidation =
  | { readonly ok: true; readonly scheme: IdentifierScheme; readonly normalizedValue: string }
  | { readonly ok: false; readonly reason: GtinRejection };

export type GtinRejection =
  | 'not_numeric'
  | 'unsupported_length'
  | 'check_digit_failed'
  | 'empty';

/**
 * Standard GTIN mod-10 check digit: sum digits right-to-left excluding the
 * check digit, weighting alternately 3 and 1; the check digit is whatever
 * brings the total to the next multiple of ten.
 */
export function gtinCheckDigit(digitsWithoutCheck: string): number {
  let sum = 0;
  const reversed = [...digitsWithoutCheck].reverse();
  for (const [index, char] of reversed.entries()) {
    const digit = Number(char);
    sum += index % 2 === 0 ? digit * 3 : digit;
  }
  return (10 - (sum % 10)) % 10;
}

/**
 * Validate and normalize a GTIN.
 *
 * An arbitrary numeric string is NOT a GTIN. Accepting one would let a typo
 * resolve to a real product, so a failed check digit is a hard rejection.
 */
export function validateGtin(rawValue: string): GtinValidation {
  const trimmed = rawValue.trim();
  if (trimmed.length === 0) return { ok: false, reason: 'empty' };
  if (!/^\d+$/.test(trimmed)) return { ok: false, reason: 'not_numeric' };

  const scheme: IdentifierScheme | null =
    trimmed.length === 12 ? 'gtin_12' :
    trimmed.length === 13 ? 'gtin_13' :
    trimmed.length === 14 ? 'gtin_14' :
    null;
  if (scheme === null) return { ok: false, reason: 'unsupported_length' };

  const body = trimmed.slice(0, -1);
  const provided = Number(trimmed.slice(-1));
  if (gtinCheckDigit(body) !== provided) return { ok: false, reason: 'check_digit_failed' };

  // Zero-pad to 14 so a UPC-A and its EAN-13 form are recognised as one product.
  return { ok: true, scheme, normalizedValue: trimmed.padStart(14, '0') };
}

export function normalizeGtin(rawValue: string): string | null {
  const result = validateGtin(rawValue);
  return result.ok ? result.normalizedValue : null;
}

/** Lookup outcomes. An unknown barcode NEVER falls back to a guess. */
export type IdentifierLookupResult =
  | { readonly outcome: 'exact_match'; readonly productVersionId: string; readonly productId: string }
  | { readonly outcome: 'not_found' }
  | { readonly outcome: 'ambiguous'; readonly productIds: readonly string[] }
  | { readonly outcome: 'invalid_identifier'; readonly reason: GtinRejection };

export interface IdentifierIndexEntry {
  readonly normalizedValue: string;
  readonly productId: string;
  readonly productVersionId: string;
  readonly state: IdentifierState;
}

/**
 * Resolve a barcode to exactly one active product, or refuse.
 *
 * PURE. Two active products claiming one GTIN is `ambiguous` — never an
 * arbitrary winner, because silently picking one logs the wrong food.
 */
export function lookupByIdentifier(
  rawValue: string,
  index: readonly IdentifierIndexEntry[],
): IdentifierLookupResult {
  const validated = validateGtin(rawValue);
  if (!validated.ok) return { outcome: 'invalid_identifier', reason: validated.reason };

  const matches = index.filter(
    (e) => e.normalizedValue === validated.normalizedValue && e.state === 'current',
  );
  if (matches.length === 0) return { outcome: 'not_found' };

  const distinctProducts = [...new Set(matches.map((m) => m.productId))].sort();
  if (distinctProducts.length > 1) {
    return { outcome: 'ambiguous', productIds: distinctProducts };
  }

  const match = matches[0]!;
  return { outcome: 'exact_match', productId: match.productId, productVersionId: match.productVersionId };
}
