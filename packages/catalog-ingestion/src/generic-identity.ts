import { createHash } from 'node:crypto';
import type { ClassifiedPreparation } from './preparation-classifier.js';

/**
 * GENERIC FOOD IDENTITY.
 *
 * THREE distinct concepts, never collapsed:
 *   1. MACROS.AI food concept id  — what the food IS
 *   2. MACROS.AI ProductVersion id — what we published about it, when
 *   3. external source record id   — where a fact came from
 *
 * `usda-fdc-173928` failed this: it was a source id wearing our namespace, so
 * USDA's numbering effectively became our identity. A second source describing
 * the same food could never attach without inventing a competing id.
 */
export const GENERIC_IDENTITY_VERSION = 'generic-identity@1.2.0';

/**
 * SAME-SOURCE RECORDS ARE NEVER THE SAME CONCEPT.
 *
 * A source does not publish one food twice. Two SR records differing only by a
 * hyphen — "Pancakes, whole wheat, dry mix" and "Pancakes, whole-wheat, dry
 * mix" — carry different NDB numbers and materially different nutrition
 * (350 vs 344 kcal, 10.5 vs 12.8 g protein, fiber present vs absent). Text
 * normalization made their concept keys identical and silently discarded one.
 *
 * Cross-source convergence is the intended behaviour and is unaffected: it is
 * exactly the case where two DIFFERENT sources describe one food.
 */
export function disambiguateSameSource(
  conceptKey: string,
  sourceRecordId: string,
): string {
  return `${conceptKey}@src:${sourceRecordId}`;
}

/**
 * ADMINISTRATIVE SOURCE TEXT (CA-15).
 *
 * SR Legacy appends programme annotations to 57 real descriptions, e.g.
 * "Apples, raw, fuji, with skin (Includes foods for USDA's Food Distribution
 * Program)". That phrase records a USDA distribution programme — it says
 * nothing about the food — yet it would otherwise make an SR record a different
 * MACROS.AI concept from the identical Foundation food.
 *
 * Stripped from the SEMANTIC projection ONLY. The original description is
 * always retained verbatim in provenance.
 *
 * Deliberately NOT a general parenthesis strip: 871 SR descriptions contain
 * parentheses, and most carry real identity — "(garbanzo beans, bengal gram)"
 * names the food. Only these explicit administrative patterns are removed.
 */
export const ADMINISTRATIVE_TEXT_PATTERNS: readonly RegExp[] = [
  /\(includes foods for usda'?s? food distribution program\)/gi,
  /\(commodity\)/gi,
];

export function stripAdministrativeText(description: string): string {
  let out = description;
  for (const pattern of ADMINISTRATIVE_TEXT_PATTERNS) out = out.replace(pattern, ' ');
  return out.replace(/\s+/g, ' ').trim();
}

export interface ExternalSourceIdentity {
  readonly provider: 'usda_fdc';
  readonly dataset: string;
  readonly sourceRecordId: string;
  readonly release: string | null;
  readonly archiveSha256: string;
}

export interface GenericFoodIdentity {
  /** Stable internal id. Derived from FOOD SEMANTICS, never from a source id. */
  readonly productId: string;
  /** Human-auditable key the id is derived from. */
  readonly conceptKey: string;
  readonly externalIdentities: readonly ExternalSourceIdentity[];
}

/**
 * Normalize a description into a stable concept key.
 *
 * Preparation is PART of the key: raw and cooked chicken breast are different
 * foods with different nutrition per 100 g, and merging them would be a
 * correctness failure, not a convenience.
 */
export function conceptKeyFor(
  description: string,
  preparation: ClassifiedPreparation,
): string {
  const normalized = stripAdministrativeText(description)
    .toLowerCase()
    .replace(/[^a-z0-9, ]+/g, ' ')
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    // Order-independent: "Apples, raw" and "raw, Apples" are one concept.
    .sort()
    .join('|')
    .replace(/\s+/g, ' ');
  return `${normalized}#${preparation}`;
}

/**
 * A deterministic, source-independent product id.
 *
 * Content-addressed from the concept key so the same food always yields the
 * same id, and a different source describing that food attaches to it rather
 * than creating a duplicate.
 */
export function genericProductId(conceptKey: string): string {
  const digest = createHash('sha256').update(conceptKey, 'utf8').digest('hex');
  return `food_${digest.slice(0, 16)}`;
}

export type OverlapVerdict = 'definite_same' | 'possible_duplicate' | 'distinct';

export interface OverlapAssessment {
  readonly verdict: OverlapVerdict;
  readonly reason: string;
}

/**
 * Assess whether two source records describe the same food concept.
 *
 * DETERMINISTIC EVIDENCE ONLY — normalized description, preparation and
 * category. No embeddings, no LLM, no fuzzy similarity: a wrong merge silently
 * attaches the wrong nutrition to a food a user logs, which is far worse than
 * carrying two entries a human can later link.
 */
export function assessOverlap(
  a: { conceptKey: string; category: string | null; preparation: ClassifiedPreparation },
  b: { conceptKey: string; category: string | null; preparation: ClassifiedPreparation },
): OverlapAssessment {
  if (a.preparation !== b.preparation) {
    return { verdict: 'distinct', reason: 'different_preparation_state' };
  }
  if (a.conceptKey === b.conceptKey) {
    return { verdict: 'definite_same', reason: 'identical_concept_key' };
  }
  // Same category and one description is a strict refinement of the other:
  // suggestive, never conclusive. A human decides.
  const aTerms = new Set(a.conceptKey.split(/[|# ]/).filter(Boolean));
  const bTerms = new Set(b.conceptKey.split(/[|# ]/).filter(Boolean));
  const shared = [...aTerms].filter((t) => bTerms.has(t)).length;
  const smaller = Math.min(aTerms.size, bTerms.size);
  if (a.category !== null && a.category === b.category && smaller > 0 && shared / smaller >= 0.9) {
    return { verdict: 'possible_duplicate', reason: 'near_identical_terms_same_category' };
  }
  return { verdict: 'distinct', reason: 'insufficient_evidence' };
}

/**
 * SOURCE PRIORITY. Foundation is newer and analytically stronger than SR
 * Legacy, so it wins where records genuinely represent the same concept.
 * Values are NEVER averaged, and the losing record's provenance is retained.
 */
export const SOURCE_PRIORITY: Readonly<Record<string, number>> = {
  Foundation: 100,
  'SR Legacy': 50,
};

export const preferredSource = (a: string, b: string): string =>
  (SOURCE_PRIORITY[a] ?? 0) >= (SOURCE_PRIORITY[b] ?? 0) ? a : b;

/**
 * CONSUMER DISPLAY NAME.
 *
 * USDA writes "Cheese, cheddar"; a person says "Cheddar cheese". Deterministic
 * comma inversion only — no LLM renaming of authoritative records, and the
 * original description is always retained separately.
 */
export function consumerDisplayName(description: string): string {
  const parts = description.split(',').map((p) => p.trim()).filter((p) => p.length > 0);
  if (parts.length < 2) return description.trim();

  const head = parts[0]!;
  const rest = parts.slice(1);
  // Only invert when the second part is a simple modifier — never reorder a
  // qualifier that carries distinguishing information.
  const modifier = rest[0]!;
  if (/^[a-z][a-z' -]{1,20}$/i.test(modifier) && !/\b(raw|cooked|with|without|and|or)\b/i.test(modifier)) {
    const tail = rest.slice(1);
    const headLower = head.toLowerCase();
    // Do NOT repeat the head word when the modifier already contains it.
    // "Sausage, breakfast sausage, beef" inverted to "Breakfast sausage
    // sausage, beef" — deterministic, and nonsense.
    const base = new RegExp(`\\b${escapeRegex(headLower)}\\b`).test(modifier.toLowerCase())
      ? capitalize(modifier)
      : `${capitalize(modifier)} ${headLower}`;
    return tail.length > 0 ? `${base}, ${tail.join(', ')}` : base;
  }
  return description.trim();
}

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const capitalize = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
