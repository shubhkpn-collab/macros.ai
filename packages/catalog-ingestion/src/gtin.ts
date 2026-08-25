/**
 * GTIN / UPC IDENTITY.
 *
 * Derived from the ACTUAL April 2026 Branded corpus, where observed lengths are
 * 8, 12, 13 and 14 (valid GS1 families) alongside malformed lengths 5, 6, 7, 9,
 * 10, 11, 15, 17 and 18, plus non-digit values.
 *
 * A barcode is a hard identity claim: scanning it attaches specific nutrition
 * to a user's log. So an identifier is either provably valid or it is not
 * trusted for lookup — never padded, never repaired, never guessed.
 */
export const GTIN_POLICY_VERSION = 'gtin@1.0.0';

/** GS1 families MACROS.AI accepts, all normalized to 14 digits internally. */
export const VALID_GTIN_LENGTHS: readonly number[] = [8, 12, 13, 14];

export type GtinRejection =
  | 'empty'
  | 'non_digit'
  | 'unsupported_length'
  | 'bad_check_digit';

export type GtinResult =
  | {
      readonly ok: true;
      /** Exactly as the source supplied it — never overwritten. */
      readonly raw: string;
      /** Zero-padded to 14 digits: the canonical lookup key. */
      readonly gtin14: string;
      readonly family: 'GTIN-8' | 'GTIN-12' | 'GTIN-13' | 'GTIN-14';
    }
  | { readonly ok: false; readonly raw: string; readonly reason: GtinRejection };

/**
 * GS1 Mod-10 check digit.
 *
 * Weights alternate 3 and 1 from the RIGHTMOST payload digit, so they must be
 * applied by position from the end — computing them left-to-right silently
 * inverts the weighting on odd-length codes.
 */
export function gs1CheckDigit(payload: string): number {
  let sum = 0;
  for (let i = payload.length - 1, weight = 3; i >= 0; i--, weight = weight === 3 ? 1 : 3) {
    sum += Number(payload[i]) * weight;
  }
  return (10 - (sum % 10)) % 10;
}

/**
 * Normalize and validate a supplied identifier.
 *
 * Leading zeros are SIGNIFICANT: "076014101088" is a 12-digit UPC-A, and
 * trimming the zero would make it an invalid 11-digit code — or worse, a
 * different product. The raw string is therefore never trimmed, only padded
 * leftward to the canonical 14-digit form.
 */
export function normalizeGtin(raw: unknown): GtinResult {
  if (typeof raw !== 'string' && typeof raw !== 'number') {
    return { ok: false, raw: String(raw ?? ''), reason: 'empty' };
  }
  const value = String(raw).trim();
  if (value.length === 0) return { ok: false, raw: value, reason: 'empty' };

  // Whitespace and hyphens are formatting; anything else is not a digit string.
  const cleaned = value.replace(/[\s-]/g, '');
  if (!/^\d+$/.test(cleaned)) return { ok: false, raw: value, reason: 'non_digit' };
  if (!VALID_GTIN_LENGTHS.includes(cleaned.length)) {
    return { ok: false, raw: value, reason: 'unsupported_length' };
  }

  const body = cleaned.slice(0, -1);
  const supplied = Number(cleaned.slice(-1));
  if (gs1CheckDigit(body) !== supplied) {
    return { ok: false, raw: value, reason: 'bad_check_digit' };
  }

  const family =
    cleaned.length === 8 ? 'GTIN-8' :
    cleaned.length === 12 ? 'GTIN-12' :
    cleaned.length === 13 ? 'GTIN-13' : 'GTIN-14';

  return { ok: true, raw: value, gtin14: cleaned.padStart(14, '0'), family };
}

/** Lookup outcomes. There is deliberately no fuzzy barcode matching. */
export type IdentifierLookup =
  | { readonly outcome: 'found'; readonly productId: string; readonly productVersionId: string }
  | { readonly outcome: 'not_found' }
  | { readonly outcome: 'invalid_identifier'; readonly reason: GtinRejection }
  | { readonly outcome: 'conflicted_identifier'; readonly candidates: readonly string[] }
  | { readonly outcome: 'discontinued'; readonly productId: string };

export type IdentifierState = 'current' | 'superseded' | 'conflicted';

export interface IdentifierAssignment {
  readonly gtin14: string;
  readonly productId: string;
  readonly productVersionId: string;
  readonly state: IdentifierState;
  readonly discontinued: boolean;
}

/**
 * Exact lookup. A valid barcode either resolves to one current assignment or it
 * refuses — a conflicted identifier never silently picks a candidate, because
 * attaching an unrelated product's nutrition is worse than failing.
 */
export function lookupByGtin(
  raw: unknown,
  assignments: ReadonlyMap<string, readonly IdentifierAssignment[]>,
): IdentifierLookup {
  const normalized = normalizeGtin(raw);
  if (!normalized.ok) return { outcome: 'invalid_identifier', reason: normalized.reason };

  const all = assignments.get(normalized.gtin14) ?? [];
  if (all.length === 0) return { outcome: 'not_found' };

  const conflicted = all.filter((a) => a.state === 'conflicted');
  if (conflicted.length > 0) {
    return {
      outcome: 'conflicted_identifier',
      candidates: [...new Set(conflicted.map((a) => a.productId))].sort(),
    };
  }

  const current = all.filter((a) => a.state === 'current');
  if (current.length === 0) return { outcome: 'not_found' };
  if (new Set(current.map((a) => a.productId)).size > 1) {
    return {
      outcome: 'conflicted_identifier',
      candidates: [...new Set(current.map((a) => a.productId))].sort(),
    };
  }

  const hit = current[0]!;
  if (hit.discontinued) return { outcome: 'discontinued', productId: hit.productId };
  return { outcome: 'found', productId: hit.productId, productVersionId: hit.productVersionId };
}
