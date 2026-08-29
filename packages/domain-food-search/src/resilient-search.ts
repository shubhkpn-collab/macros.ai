import { searchFood, type FoodSearchResult, type SearchableFood } from './search.js';
import {
  finalConfidence, resolveQuery,
  type QueryConfidence, type ResolvedQuery, type Vocabulary,
} from './resilient-query.js';

/**
 * THE AUTHORITATIVE SEARCH ENTRY POINT.
 *
 * Every path — the tablet controller, future voice, and the benchmark — calls
 * exactly this. Before SEARCH-1B the benchmark carried its own Python
 * reimplementation of the fuzzy and confidence rules, which meant the measured
 * 0% unsafe rate described a program the product did not run. One algorithm in
 * one place is the only way a benchmark number means anything.
 *
 * It composes rather than replaces: resilient resolution supplies a corrected
 * query, and the EXISTING deterministic ranker does the ranking, untouched.
 */
export const RESILIENT_SEARCH_VERSION = 'resilient-search@1.0.0';

export interface ResilientSearchResponse {
  readonly results: readonly FoodSearchResult[];
  readonly resolved: ResolvedQuery;
  readonly confidence: QueryConfidence;
  /** Corrected phrasing to show the person, or null when nothing changed. */
  readonly didYouMean: string | null;
  readonly corrections: readonly { readonly from: string; readonly to: string }[];
  /** True only when a single result may be auto-selected without asking. */
  readonly autoSelectable: boolean;
}

export interface ResilientSearchQuery {
  readonly text: string;
  readonly limit?: number;
  readonly recentProductVersionIds?: readonly string[];
}

/**
 * Build the vocabulary the resolver corrects against.
 *
 * Frequency is counted here because the catalog contains its own misspellings:
 * a real product is labelled `BROCOLLI`, and without frequency a user typo can
 * match that noise exactly and bypass correction entirely.
 */
export function buildVocabulary(catalog: readonly SearchableFood[]): Vocabulary {
  const terms = new Set<string>();
  const brands = new Set<string>();
  const frequency = new Map<string, number>();

  const add = (text: string | null | undefined, isBrand: boolean): void => {
    if (text === null || text === undefined) return;
    for (const token of text.toLowerCase().split(/[^a-z0-9]+/i)) {
      if (token.length === 0) continue;
      terms.add(token);
      frequency.set(token, (frequency.get(token) ?? 0) + 1);
      if (isBrand) brands.add(token);
    }
  };

  for (const food of catalog) {
    const f = food as unknown as Record<string, unknown>;
    add(String(f['displayName'] ?? ''), false);
    const brand = f['brandName'];
    if (typeof brand === 'string') add(brand, true);
    const aliases = f['aliases'];
    if (Array.isArray(aliases)) {
      for (const a of aliases) if (typeof a === 'string') add(a, false);
    }
  }

  return { terms, brands, frequency };
}

/**
 * Resilient search.
 *
 * The corrected query is what reaches the ranker, so `chiken breast` ranks as
 * `chicken breast` rather than matching on `breast` alone and surfacing turkey.
 *
 * `autoSelectable` is the safety gate: it is true ONLY for a confident query
 * with an unambiguous winner. Everything else — a correction, an expansion, a
 * near-tie, an unresolved token — must be offered as a choice rather than
 * silently applied. A wrong food logged with full confidence gives the person
 * no signal to doubt it.
 */
export function resilientSearch(
  catalog: readonly SearchableFood[],
  vocabulary: Vocabulary,
  query: ResilientSearchQuery,
): ResilientSearchResponse {
  const resolved = resolveQuery(query.text, vocabulary);

  // The ranker receives the CORRECTED terms. Preparation words are carried
  // through unchanged so raw/cooked intent still reaches `preparationIntentOf`.
  const rankedText = resolved.searchTerms.length > 0
    ? resolved.searchTerms.join(' ')
    : query.text;

  const results = resolved.searchTerms.length === 0
    ? []
    : searchFood(catalog, {
      text: rankedText,
      limit: query.limit ?? 4,
      ...(query.recentProductVersionIds !== undefined
        ? { recentProductVersionIds: query.recentProductVersionIds } : {}),
    });

  const topScore = results[0]?.score ?? 0;
  const runnerUpScore = results[1]?.score ?? 0;
  const confidence = finalConfidence(resolved, topScore, runnerUpScore, results.length);

  return {
    results,
    resolved,
    confidence,
    didYouMean: resolved.didYouMean,
    corrections: resolved.corrections,
    autoSelectable: confidence === 'confident' && results.length === 1,
  };
}
