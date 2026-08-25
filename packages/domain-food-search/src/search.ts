
export const FOOD_SEARCH_VERSION = 'food-search@1.0.0';

/**
 * DETERMINISTIC FOOD SEARCH.
 *
 * PURE: no LLM, no embeddings, no vector store, no network, no clock, no
 * randomness. Ranking is transparent and explainable — a user (or a reviewer)
 * can always be told exactly why a result placed where it did.
 *
 * This is deliberately simple. The real catalog milestone will replace the
 * corpus and revisit ranking with a search-quality evaluation; nothing here
 * should be mistaken for that work.
 */
export type MatchKind =
  | 'exact'
  | 'alias_exact'
  | 'prefix'
  | 'token_prefix'
  | 'token'
  | 'alias_token'
  | 'brand'
  | 'none';

/**
 * A searchable food. The catalog projection supplies these; the ranking domain
 * never reads a repository and never sees a de-listed product.
 */
export interface SearchableFood {
  readonly productVersionId: string;
  readonly displayName: string;
  readonly brandName?: string;
  readonly preparationState: string;
  readonly aliases?: readonly string[];
}

export interface FoodSearchResult {
  readonly productVersion: SearchableFood;
  readonly score: number;
  readonly matchKind: MatchKind;
  /** Stable position label for spoken selection: A, B, C, D... */
  readonly optionLabel: string;
  /** True when another result shares this display name in a different state. */
  readonly preparationStateDisambiguates: boolean;
}

export interface FoodSearchQuery {
  readonly text: string;
  readonly limit?: number;
  /** Product version ids the user logged before, most recent first. */
  readonly recentProductVersionIds?: readonly string[];
}

/** Lower-case, trim, collapse internal whitespace, drop punctuation noise. */
export function normalizeText(value: string): string {
  return value
    .toLowerCase()
    // Punctuation is separator noise, not meaning: "chicken breast, cooked"
    // and "chicken-breast (cooked)" are the same query.
    .replace(/[,_/()[\]{}.;:!?'"`\u2019-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Crude, deliberate singularization for search only.
 *
 * Enough for "eggs" → "egg" and "almonds" → "almond"; it never touches stored
 * data, and a wrong stem can only affect ranking, never which food is logged.
 */
export function stemToken(token: string): string {
  if (token.length <= 3) return token;
  if (token.endsWith('ies')) return `${token.slice(0, -3)}y`;
  if (token.endsWith('ses') || token.endsWith('xes') || token.endsWith('hes')) return token.slice(0, -2);
  if (token.endsWith('s') && !token.endsWith('ss')) return token.slice(0, -1);
  return token;
}

export function tokenize(value: string): string[] {
  const normalized = normalizeText(value);
  return normalized.length === 0 ? [] : normalized.split(' ');
}

const SCORE = {
  exact: 1000,
  aliasExact: 950,
  prefix: 800,
  tokenPrefix: 600,
  token: 400,
  aliasToken: 380,
  brand: 300,
  /** Recency is a nudge, never enough to outrank a better textual match. */
  recentMax: 90,
  /** CA-14: canonical preparation state matching the user's stated intent. */
  preparationMatch: 120,
  /** The record's text also names the specific method the user asked for. */
  preparationMethodMatch: 60,
  /** A stated-raw query matching a cooked record, or vice versa. */
  preparationConflict: 400,
} as const;

interface Scored {
  readonly productVersion: SearchableFood;
  readonly score: number;
  readonly matchKind: MatchKind;
}

function scoreOne(
  product: SearchableFood,
  queryText: string,
  queryTokens: readonly string[],
): Scored {
  const name = normalizeText(product.displayName);
  const nameTokens = tokenize(product.displayName).map(stemToken);
  const brand = product.brandName === undefined ? '' : normalizeText(product.brandName);
  const aliases = (product.aliases ?? []).map(normalizeText);
  // Aliases are SEARCH metadata: they widen how a food can be found, and never
  // change what is logged.
  const aliasTokens = new Set(aliases.flatMap((a) => tokenize(a).map(stemToken)));

  let score = 0;
  let matchKind: MatchKind = 'none';

  if (name === queryText) {
    score = SCORE.exact;
    matchKind = 'exact';
  } else if (aliases.includes(queryText)) {
    score = SCORE.aliasExact;
    matchKind = 'alias_exact';
  } else if (name.startsWith(queryText)) {
    score = SCORE.prefix;
    matchKind = 'prefix';
  } else {
    // Every query token must be accounted for; a partial match never wins by
    // accident, because an unmatched token disqualifies the product entirely.
    let total = 0;
    let kind: MatchKind = 'none';
    // Word order must not matter: every query token is matched independently,
    // so "cooked chicken" and "chicken cooked" score identically.
    for (const qt of queryTokens) {
      const tokenPrefix = nameTokens.some((nt) => nt.startsWith(qt));
      const aliasHit = aliasTokens.has(qt) || [...aliasTokens].some((at) => at.startsWith(qt));
      const brandHit = brand.length > 0 && brand.includes(qt);
      if (tokenPrefix) {
        total += nameTokens.includes(qt) ? SCORE.token + SCORE.tokenPrefix : SCORE.tokenPrefix;
        kind = kind === 'none' ? 'token_prefix' : kind;
      } else if (aliasHit) {
        total += SCORE.aliasToken;
        kind = kind === 'none' ? 'alias_token' : kind;
      } else if (brandHit) {
        total += SCORE.brand;
        kind = kind === 'none' ? 'brand' : kind;
      } else {
        // An unmatched token disqualifies the food outright. Partial matching is
        // how a search silently logs the wrong thing.
        return { productVersion: product, score: 0, matchKind: 'none' };
      }
    }
    score = queryTokens.length === 0 ? 0 : total / queryTokens.length;
    matchKind = kind;
  }

  return { productVersion: product, score, matchKind };
}

const OPTION_LABELS = 'ABCDEFGH';

/**
 * Rank a catalog against a query.
 *
 * DETERMINISM: identical catalog + query + history always produce identical
 * ordering. Ties are broken explicitly by displayName then productVersionId —
 * never by map or object iteration order.
 */
/**
 * PREPARATION INTENT (CA-14).
 *
 * A user saying "cooked ground turkey" means the canonical cooked state — but
 * the matching record reads "pan-broiled crumbles", so display text alone
 * misses it. Intent is matched against `preparationState`, not wording.
 *
 * Method words stay meaningful: "boiled potato" still prefers a record whose
 * text says boiled over a generically cooked one.
 */
const COOKED_INTENT = /\b(cooked|boiled|roasted|grilled|fried|baked|broiled|steamed|braised|poached|toasted|sauteed)\b/i;
const RAW_INTENT = /\b(raw|uncooked|fresh)\b/i;

export interface PreparationIntent {
  readonly state: 'raw' | 'cooked' | null;
  readonly method: string | null;
}

export function preparationIntentOf(query: string): PreparationIntent {
  const cooked = COOKED_INTENT.exec(query);
  if (cooked !== null) {
    const word = cooked[0].toLowerCase();
    return { state: 'cooked', method: word === 'cooked' ? null : word };
  }
  if (RAW_INTENT.test(query)) return { state: 'raw', method: null };
  return { state: null, method: null };
}

export function searchFood(
  catalog: readonly SearchableFood[],
  query: FoodSearchQuery,
): readonly FoodSearchResult[] {
  const queryText = normalizeText(query.text);
  if (queryText.length === 0) return [];

  const queryTokens = tokenize(query.text).map(stemToken);
  const intent = preparationIntentOf(query.text);
  const recent = query.recentProductVersionIds ?? [];

  const scored: Scored[] = [];
  for (const product of catalog) {
    const base = scoreOne(product, queryText, queryTokens);
    if (base.score <= 0) continue;

    const recentIndex = recent.indexOf(product.productVersionId);
    const recencyBoost =
      recentIndex === -1 ? 0 : Math.max(1, SCORE.recentMax - recentIndex * 10);

    // CA-14 / B15: preparation intent applied to CANONICAL state.
    let preparationAdjustment = 0;
    if (intent.state !== null) {
      const state = product.preparationState;
      if (state === intent.state) {
        preparationAdjustment += SCORE.preparationMatch;
        // A method word still discriminates: "boiled potato" prefers a record
        // that actually says boiled over a generically cooked one.
        if (intent.method !== null && new RegExp(`\\b${intent.method}`, 'i').test(product.displayName)) {
          preparationAdjustment += SCORE.preparationMethodMatch;
        }
      } else if (state === 'raw' || state === 'cooked') {
        // A DIRECT conflict. Wrong preparation is high-severity — cooked beef
        // is roughly a third denser than raw — so it is pushed below every
        // correctly-stated candidate rather than merely nudged.
        preparationAdjustment -= SCORE.preparationConflict;
      }
    }

    scored.push({ ...base, score: base.score + recencyBoost + preparationAdjustment });
  }

  scored.sort(
    (a, b) =>
      b.score - a.score ||
      a.productVersion.displayName.localeCompare(b.productVersion.displayName) ||
      a.productVersion.productVersionId.localeCompare(b.productVersion.productVersionId),
  );

  const limited = scored.slice(0, query.limit ?? 4);

  // Preparation state must be visible when it is the thing that distinguishes
  // two otherwise identical-looking results.
  const nameCounts = new Map<string, number>();
  for (const s of limited) {
    const key = normalizeText(s.productVersion.displayName).replace(/\b(raw|cooked)\b/g, '').trim();
    nameCounts.set(key, (nameCounts.get(key) ?? 0) + 1);
  }

  return limited.map((s, index) => {
    const key = normalizeText(s.productVersion.displayName).replace(/\b(raw|cooked)\b/g, '').trim();
    return {
      productVersion: s.productVersion,
      score: s.score,
      matchKind: s.matchKind,
      optionLabel: OPTION_LABELS[index] ?? String(index + 1),
      preparationStateDisambiguates: (nameCounts.get(key) ?? 0) > 1,
    };
  });
}
