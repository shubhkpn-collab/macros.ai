/**
 * PREPARATION CLASSIFIER.
 *
 * Classifies the state of the FOOD BEING WEIGHED — not the processing history
 * of its ingredients. Cheddar is not "raw milk"; bread is not "cooked flour".
 *
 * Versioned because classification materially affects catalog identity: if the
 * rules change and a food's factual state moves raw → cooked, that is a real
 * catalog change and must be traceable to the classifier that produced it.
 */
export const PREPARATION_CLASSIFIER_VERSION = 'preparation-classifier@2.3.0';

/** Matches the existing `PreparationState` contract — no parallel field. */
export type ClassifiedPreparation = 'raw' | 'cooked' | 'as_sold' | 'prepared' | 'unresolved';

export interface PreparationClassification {
  readonly state: ClassifiedPreparation;
  readonly classifierVersion: string;
  /** Why this state was chosen — auditable, not a black box. */
  readonly rule: string;
}

/**
 * Terms describing a FINAL cooked state.
 *
 * "microwave" and "toasted" are included: USDA writes "cooked, microwave" and
 * "toasted" as terminal preparations, and omitting them was part of why
 * cooked apples published as raw.
 */
const COOKED_TERMS =
  /\b(cooked|boiled|roasted|grilled|baked|braised|steamed|broiled|fried|stewed|microwaved?|toasted|poached|simmered|blanched|sauteed|sautéed|barbecued|smoked)\b/i;

const RAW_TERMS = /\braw\b/i;

/**
 * Foods sold ready to eat with no further preparation by the user. These are
 * weighed exactly as purchased, so forcing them into raw/cooked would state
 * something false about what is on the scale.
 */
/**
 * FOOD-TYPE terms for products that are inherently ready to eat.
 *
 * Meat nouns are deliberately ABSENT. "sausage", "frankfurter" and "luncheon
 * meat" name a food TYPE, not a state — a raw breakfast sausage and a
 * fully-cooked frankfurter are both "sausage", and letting the noun imply
 * readiness let a raw product publish as `as_sold`.
 */
const READY_TO_EAT_FOOD_TYPE =
  /\b(cheese|yogurt|yoghurt|hummus|butter|margarine|oil|juice|milk|cream|pickles?|mustard|ketchup|mayonnaise|jam|jelly|honey|syrup|sauce|dressing|vinegar|bread|tortilla|cracker|cereal|granola|chips?|cookie|candy|chocolate|nuts?|peanut butter|almond butter|powder|flour|beverage|soda|water|infant formula)\b/i;

/**
 * STATE / FORM evidence — the food's actual condition, from source wording.
 *
 * These are strong enough to resolve even a preparation-critical category,
 * because each states how the item is sold rather than merely what it is.
 *
 * `frozen` and `fresh` are deliberately EXCLUDED: frozen salmon may be raw or
 * cooked, and calling it `as_sold` would assert that this record matches
 * whatever is on the scale.
 */
const STATE_FORM_EVIDENCE =
  /\b(fully cooked|pre-?cooked|ready[- ]to[- ]eat|pasteuri[sz]ed|cured|deli|luncheon|sliced|unheated|uncooked|canned|jerky|smoked)\b/i;

/** Non-critical form terms: fine for produce and grains, not for meat/fish. */
const NON_CRITICAL_FORM =
  /\b(dry|dried|frozen|canned|fresh)\b/i;

/** Wording that states the food was NOT cooked, without meaning "raw". */
const EXPLICIT_UNHEATED = /\b(unheated|uncooked|not heated)\b/i;

/**
 * Genuinely ambiguous constructions: the description offers alternatives rather
 * than stating one final state. These go to curation rather than a guess.
 */
const AMBIGUOUS_ALTERNATIVE = /\b(raw or cooked|cooked or raw|fresh or frozen|or raw|or cooked)\b/i;

/**
 * Classify a USDA description.
 *
 * PRECEDENCE IS BY FINAL STATE, not by which word appears first. USDA writes
 * "Apples, raw, without skin, cooked, boiled" — the leading "raw" describes the
 * INPUT and the trailing "cooked, boiled" is the final state. Checking `raw`
 * first published cooked apples as raw, with the wrong nutrition attached.
 */
/**
 * Categories of whole/unprocessed foods. A record in one of these with no
 * preparation wording describes the food AS SOLD — fresh spinach, dry lentils,
 * shelled nuts. `as_sold` states exactly what is on the scale without claiming
 * it was cooked, and without the false precision of calling it "raw".
 */
const WHOLE_FOOD_CATEGORIES = /\b(vegetable|fruit|legume|nut|seed|cereal grain|pasta|spice|herb|dairy|egg|baked|snack|sweet|beverage|fats and oils|soup|sauce)\b/i;

/**
 * Categories where raw and cooked differ MATERIALLY per 100 g and the source
 * often leaves it unstated.
 *
 * Category membership alone must never resolve these: a bare "Beef, ground,
 * 80% lean" is almost certainly raw, but `as_sold` would quietly assert that
 * whatever is on the scale matches this record — and cooked beef is roughly a
 * third denser in energy. These require an explicit preparation or form term,
 * or they go to curation.
 */
const PREPARATION_CRITICAL_CATEGORIES =
  /\b(beef|pork|poultry|lamb|veal|game|sausage|luncheon|finfish|shellfish)\b/i;

export function classifyPreparation(
  description: string,
  category?: string | null,
): PreparationClassification {
  const d = description.toLowerCase();
  const v = PREPARATION_CLASSIFIER_VERSION;

  // Explicit alternatives are never resolved by picking one.
  if (AMBIGUOUS_ALTERNATIVE.test(d)) {
    return { state: 'unresolved', classifierVersion: v, rule: 'ambiguous_alternative' };
  }

  const hasRaw = RAW_TERMS.test(d);
  const hasCooked = COOKED_TERMS.test(d);

  if (hasRaw && hasCooked) {
    // Both present: the LAST preparation term states the final state.
    const lastRaw = lastIndexOfMatch(d, RAW_TERMS);
    const lastCooked = lastIndexOfMatch(d, COOKED_TERMS);
    return lastCooked > lastRaw
      ? { state: 'cooked', classifierVersion: v, rule: 'mixed_final_state_cooked' }
      : { state: 'raw', classifierVersion: v, rule: 'mixed_final_state_raw' };
  }

  if (hasCooked) return { state: 'cooked', classifierVersion: v, rule: 'cooked_term' };
  if (hasRaw) return { state: 'raw', classifierVersion: v, rule: 'raw_term' };

  if (EXPLICIT_UNHEATED.test(d)) {
    return { state: 'as_sold', classifierVersion: v, rule: 'explicitly_unheated' };
  }

  // 2. STATE/FORM evidence — strong enough for ANY category, including
  //    preparation-critical ones, because it describes the actual condition.
  if (STATE_FORM_EVIDENCE.test(d)) {
    return { state: 'as_sold', classifierVersion: v, rule: 'state_form_evidence' };
  }

  const critical =
    category !== undefined && category !== null && PREPARATION_CRITICAL_CATEGORIES.test(category);

  // 3. Preparation-critical safety, evaluated BEFORE any food-type or category
  //    inference. A generic food noun ("sausage", "chicken") is not evidence of
  //    readiness, and neither is "frozen".
  if (critical) {
    return {
      state: 'unresolved', classifierVersion: v,
      rule: 'preparation_critical_category_without_signal',
    };
  }

  // 4. Non-critical inference: inherently ready-to-eat foods and forms.
  if (READY_TO_EAT_FOOD_TYPE.test(d)) {
    return { state: 'as_sold', classifierVersion: v, rule: 'ready_to_eat_term' };
  }
  if (NON_CRITICAL_FORM.test(d)) {
    return { state: 'as_sold', classifierVersion: v, rule: 'as_sold_form_term' };
  }
  if (category !== undefined && category !== null && WHOLE_FOOD_CATEGORIES.test(category)) {
    return { state: 'as_sold', classifierVersion: v, rule: 'whole_food_category_no_preparation' };
  }

  return { state: 'unresolved', classifierVersion: v, rule: 'no_preparation_signal' };
}

function lastIndexOfMatch(text: string, pattern: RegExp): number {
  const global = new RegExp(pattern.source, 'gi');
  let last = -1;
  for (const m of text.matchAll(global)) last = m.index ?? last;
  return last;
}

/** States eligible for consumer publication. `unresolved` never publishes. */
export const PUBLISHABLE_STATES: readonly ClassifiedPreparation[] =
  ['raw', 'cooked', 'as_sold', 'prepared'];

export const isPublishableState = (s: ClassifiedPreparation): boolean =>
  PUBLISHABLE_STATES.includes(s);
