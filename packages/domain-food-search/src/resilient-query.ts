/**
 * RESILIENT QUERY RESOLUTION.
 *
 * Typo tolerance is dangerous in a nutrition product. The proven failure was
 * `chiken breast` returning TURKEY BREAST: "chiken" matched nothing, so the
 * search answered confidently using only "breast" — and turkey is not chicken.
 * A wrong food logged with total confidence is worse than no answer, because
 * the person has no signal that anything went astray.
 *
 * The rules below all follow from that:
 *
 *   1. A query token that cannot be resolved POISONS confidence. The search may
 *      still show candidates, but never as a confident selection.
 *   2. Fuzzy correction is bounded by length and must be UNAMBIGUOUS. Two
 *      equally-close candidates means unresolved, not a coin flip.
 *   3. A fuzzy-corrected query can never reach `confident`. It can reach
 *      `did_you_mean`, which asks rather than assumes.
 *   4. Preparation and brand tokens are semantic, not noise. Dropping "raw" to
 *      obtain a match changes which food you are eating.
 */
export const RESILIENT_QUERY_VERSION = 'resilient-query@1.0.0';

export type QueryConfidence =
  /** Every token resolved exactly. Safe to auto-select. */
  | 'confident'
  /** Resolved only via correction, or several equally good foods. Ask first. */
  | 'did_you_mean'
  /** Genuinely ambiguous between distinct foods. Offer the choice. */
  | 'ambiguous'
  /** A token could not be resolved at all. Never auto-select. */
  | 'unresolved';

export interface TokenResolution {
  readonly raw: string;
  readonly resolved: string | null;
  /** 0 = exact, >0 = edit distance applied. */
  readonly distance: number;
  readonly viaAbbreviation: boolean;
  readonly kind: 'food' | 'preparation' | 'brand' | 'filler' | 'unknown';
}

export interface ResolvedQuery {
  readonly original: string;
  readonly tokens: readonly TokenResolution[];
  /** Tokens that carry meaning for matching, corrections applied. */
  readonly searchTerms: readonly string[];
  readonly preparationTerms: readonly string[];
  readonly unresolvedTerms: readonly string[];
  readonly corrections: readonly { readonly from: string; readonly to: string }[];
  readonly confidence: QueryConfidence;
  /** Human-facing prompt when we corrected something. Null when we did not. */
  readonly didYouMean: string | null;
}

/**
 * Filler that carries no food meaning. Deliberately short: removing a word that
 * turns out to be part of a food name would silently change the query.
 */
const FILLER = new Set([
  'a', 'an', 'the', 'of', 'some', 'my', 'i', 'ate', 'had', 'with', 'and',
  'please', 'add', 'log', 'me', 'for', 'to', 'is', 'it',
]);

/** Quantity words. Stripped for matching; the scale supplies real amounts. */
const QUANTITY = new Set([
  'one', 'two', 'three', 'four', 'half', 'cup', 'cups', 'scoop', 'scoops',
  'slice', 'slices', 'piece', 'pieces', 'serving', 'servings', 'bowl', 'plate',
  'glass', 'tbsp', 'tsp', 'gram', 'grams', 'g', 'oz', 'ounce', 'ounces',
]);

/**
 * Preparation vocabulary. SEMANTIC — never dropped to obtain a match, because
 * raw and cooked chicken differ by roughly a third in energy.
 */
export const PREPARATION_TERMS = new Set([
  'raw', 'cooked', 'boiled', 'baked', 'grilled', 'roasted', 'fried',
  'steamed', 'poached', 'scrambled', 'dried', 'frozen', 'canned',
  'uncooked', 'prepared', 'toasted', 'smoked',
]);

/**
 * CONTROLLED abbreviation expansion. An explicit allow-list, not a heuristic:
 * guessing what an abbreviation means is exactly how `pb` became PB & J BAR.
 * Every entry here is a deliberate product decision.
 */
export const ABBREVIATIONS: Readonly<Record<string, string>> = {
  pb: 'peanut butter',
  og: 'organic',
  bbq: 'barbecue',
  veg: 'vegetable',
  choc: 'chocolate',
  yog: 'yogurt',
  gf: 'gluten free',
  ww: 'whole wheat',
  evoo: 'olive oil',
  cx: 'chicken',
};

/**
 * Bounded edit distance. Returns `max + 1` as soon as the bound is exceeded, so
 * a long word cannot cost a full matrix against every vocabulary entry.
 */
export function boundedEditDistance(a: string, b: string, max: number): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;

  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    let rowBest = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const value = Math.min(
        current[j - 1]! + 1,
        previous[j]! + 1,
        previous[j - 1]! + cost,
      );
      current.push(value);
      if (value < rowBest) rowBest = value;
    }
    if (rowBest > max) return max + 1;
    previous = current;
  }
  return previous[b.length]!;
}

/**
 * How much correction a word of this length may receive.
 *
 * Short words get NONE: at four characters, one edit reaches a different food
 * entirely — `oat`/`oil`, `pea`/`tea`, `rice`/`ribs`.
 */
export function allowedDistance(token: string): number {
  if (token.length <= 4) return 0;
  if (token.length <= 7) return 1;
  return 2;
}

/** Conservative singularisation. Only endings that cannot change a food. */
export function singularize(token: string): string {
  if (token.length <= 3) return token;
  if (token.endsWith('ies') && token.length > 4) return `${token.slice(0, -3)}y`;
  if (token.endsWith('ses') || token.endsWith('xes') || token.endsWith('zes')
      || token.endsWith('ches') || token.endsWith('shes')) {
    return token.slice(0, -2);
  }
  // `-ss` is not a plural: "grass", "couscous".
  if (token.endsWith('s') && !token.endsWith('ss') && !token.endsWith('us')) {
    return token.slice(0, -1);
  }
  return token;
}

/** Local tokenizer: the existing search module exports its own under the same
 *  name, and re-exporting two would be ambiguous. */
const tokenizeQuery = (text: string): string[] =>
  text.toLowerCase().split(/[^a-z0-9]+/i).filter((t) => t.length > 0);

export interface Vocabulary {
  /** Every token appearing in a catalog display name or brand. */
  readonly terms: ReadonlySet<string>;
  readonly brands: ReadonlySet<string>;
  /**
   * How often each term appears across the catalog.
   *
   * This matters more than it looks. The catalog itself contains misspellings —
   * a real product is labelled "BROCOLLI" — so a user's typo can EXACTLY match
   * a garbage term and bypass correction entirely. Frequency is what
   * distinguishes a canonical word (broccoli, 387 uses) from source-data noise
   * (brocolli, 1 use).
   */
  readonly frequency?: ReadonlyMap<string, number>;
}

/** A term this rare is more likely a source typo than a real food word. */
const RARE_TERM_THRESHOLD = 3;
/** How much more common a neighbour must be before we correct toward it. */
const DOMINANCE_RATIO = 50;

/**
 * Resolve a raw user query against the catalog vocabulary.
 *
 * Correction happens per token and only against known catalog terms, so a typo
 * can never invent a word the catalog does not contain.
 */
export function resolveQuery(raw: string, vocab: Vocabulary): ResolvedQuery {
  const expanded: string[] = [];
  for (const token of tokenizeQuery(raw)) {
    const expansion = ABBREVIATIONS[token];
    if (expansion !== undefined) {
      for (const part of tokenizeQuery(expansion)) expanded.push(part);
    } else {
      expanded.push(token);
    }
  }

  const abbreviationUsed = new Set(
    tokenizeQuery(raw).filter((t) => ABBREVIATIONS[t] !== undefined));

  const tokens: TokenResolution[] = [];
  const searchTerms: string[] = [];
  const preparationTerms: string[] = [];
  const unresolvedTerms: string[] = [];
  const corrections: { from: string; to: string }[] = [];

  for (const token of expanded) {
    const viaAbbreviation = abbreviationUsed.size > 0;

    if (FILLER.has(token) || QUANTITY.has(token)) {
      tokens.push({ raw: token, resolved: null, distance: 0, viaAbbreviation, kind: 'filler' });
      continue;
    }

    if (PREPARATION_TERMS.has(token)) {
      // Semantic: kept, and never corrected away.
      tokens.push({ raw: token, resolved: token, distance: 0, viaAbbreviation, kind: 'preparation' });
      preparationTerms.push(token);
      searchTerms.push(token);
      continue;
    }

    const singular = singularize(token);
    const exact = vocab.terms.has(token) ? token
      : vocab.terms.has(singular) ? singular : null;
    const freq = vocab.frequency;

    if (exact !== null) {
      // An exact match is normally the end of it — UNLESS the matched term is
      // vanishingly rare and a near neighbour dominates it. That is the
      // "BROCOLLI" case: matching a typo in the source data exactly is not the
      // same as understanding the query.
      const exactFreq = freq?.get(exact) ?? Number.MAX_SAFE_INTEGER;
      if (exactFreq <= RARE_TERM_THRESHOLD && freq !== undefined) {
        const dominant = dominantNeighbour(exact, vocab, freq, exactFreq);
        if (dominant !== null) {
          tokens.push({
            raw: token, resolved: dominant, distance: 1, viaAbbreviation,
            kind: vocab.brands.has(dominant) ? 'brand' : 'food',
          });
          searchTerms.push(dominant);
          corrections.push({ from: token, to: dominant });
          continue;
        }
      }
      const kind = vocab.brands.has(exact) ? 'brand' : 'food';
      tokens.push({ raw: token, resolved: exact, distance: 0, viaAbbreviation, kind });
      searchTerms.push(exact);
      continue;
    }

    // --- bounded, unambiguous fuzzy correction --------------------------
    const max = allowedDistance(singular);
    let best: string | null = null;
    let bestDistance = max + 1;
    let tied = false;

    if (max > 0) {
      const freqOf = (t: string): number => vocab.frequency?.get(t) ?? 1;
      for (const candidate of vocab.terms) {
        if (Math.abs(candidate.length - singular.length) > max) continue;
        const d = boundedEditDistance(singular, candidate, max);
        if (d > max) continue;
        if (d < bestDistance) {
          bestDistance = d; best = candidate; tied = false;
        } else if (d === bestDistance && candidate !== best) {
          // Equally close. Frequency breaks the tie: a term used hundreds of
          // times is the real word, one used once is source noise. Only a
          // decisive margin counts — otherwise it stays a coin flip and we
          // refuse.
          const candidateFreq = freqOf(candidate);
          const bestFreq = best === null ? 0 : freqOf(best);
          if (candidateFreq > bestFreq * DOMINANCE_RATIO) {
            best = candidate; tied = false;
          } else if (bestFreq > candidateFreq * DOMINANCE_RATIO) {
            // Keep `best`; the candidate is noise.
          } else {
            tied = true;
          }
        }
      }
    }

    if (best !== null && !tied) {
      tokens.push({
        raw: token, resolved: best, distance: bestDistance, viaAbbreviation,
        kind: vocab.brands.has(best) ? 'brand' : 'food',
      });
      searchTerms.push(best);
      corrections.push({ from: token, to: best });
      continue;
    }

    tokens.push({ raw: token, resolved: null, distance: 0, viaAbbreviation, kind: 'unknown' });
    unresolvedTerms.push(token);
  }

  // --- confidence -------------------------------------------------------
  let confidence: QueryConfidence;
  if (searchTerms.length === 0) {
    confidence = 'unresolved';
  } else if (unresolvedTerms.length > 0) {
    // THE `chiken breast` RULE. An unresolved token means we do not understand
    // the whole query, so any answer built from the remainder is a guess about
    // a different food. Never confident.
    confidence = 'unresolved';
  } else if (corrections.length > 0 || abbreviationUsed.size > 0) {
    confidence = 'did_you_mean';
  } else {
    confidence = 'confident';
  }

  const didYouMean = corrections.length === 0 ? null : (() => {
    let phrase = raw.toLowerCase();
    for (const c of corrections) {
      phrase = phrase.replace(new RegExp(`\\b${c.from}\\b`, 'g'), c.to);
    }
    return phrase;
  })();

  return {
    original: raw,
    tokens,
    searchTerms,
    preparationTerms,
    unresolvedTerms,
    corrections,
    confidence,
    didYouMean,
  };
}

/**
 * Find a decisively more common neighbour one edit away.
 *
 * Requires BOTH rarity of the original and dominance of the neighbour, so a
 * legitimate uncommon food is never rewritten into a popular one.
 */
function dominantNeighbour(
  term: string,
  vocab: Vocabulary,
  freq: ReadonlyMap<string, number>,
  termFreq: number,
): string | null {
  let best: string | null = null;
  let bestFreq = termFreq * DOMINANCE_RATIO;
  for (const candidate of vocab.terms) {
    if (candidate === term) continue;
    if (Math.abs(candidate.length - term.length) > 1) continue;
    if (boundedEditDistance(term, candidate, 1) > 1) continue;
    const f = freq.get(candidate) ?? 0;
    if (f > bestFreq) { bestFreq = f; best = candidate; }
  }
  return best;
}

/**
 * Downgrade confidence based on what the catalog actually returned.
 *
 * String similarity alone must never promote an answer: several distinct foods
 * scoring alike is ambiguity, not a winner.
 */
export function finalConfidence(
  query: ResolvedQuery,
  topScore: number,
  runnerUpScore: number,
  resultCount: number,
): QueryConfidence {
  if (resultCount === 0) return 'unresolved';
  if (query.confidence !== 'confident') return query.confidence;
  // A near-tie between distinct foods is a question, not an answer.
  if (topScore > 0 && runnerUpScore / topScore > 0.92) return 'ambiguous';
  return 'confident';
}
