/**
 * RECOMMENDATION ACTIONABILITY — catalog metadata, not food identity.
 *
 * INT-2 made recommendations nutritionally correct and, in doing so, exposed a
 * product problem: soy flour, cottonseed flour, raw turkey giblets and dried
 * whole egg are all defensible answers to a macro gap and terrible answers to
 * "what should I eat right now?".
 *
 * The fix must be a RULE OVER SOURCE PROPERTIES, never a list of foods. A
 * blacklist would suppress four symptoms and leave thousands of equivalent
 * records — every other flour, every other organ meat — still winning. Every
 * signal below is read from metadata the catalog already carries: the USDA
 * category, the canonical preparation state, and the descriptive FORM in the
 * source description.
 *
 * This never touches canonical food identity or nutrition. A low-actionability
 * food remains a perfectly valid catalog entry that can be searched, logged and
 * weighed; it simply is not a good DEFAULT suggestion.
 */
export const ACTIONABILITY_VERSION = 'recommendation-actionability@1.0.0';

export type ActionabilityClass =
  /** Eaten as-is with no preparation: fruit, yoghurt, a cooked meal. */
  | 'ready_to_eat'
  /** A normal component of a meal, usually cooked: chicken breast, rice. */
  | 'meal_component'
  | 'beverage'
  /** Flour, powder, isolate, meal — used to MAKE food, not eaten alone. */
  | 'ingredient'
  | 'cooking_fat'
  | 'condiment'
  /** Edible only after preparation the user must perform. */
  | 'requires_preparation'
  /** Unusual or regionally specific; a poor default for a general audience. */
  | 'specialty'
  | 'unknown';

/**
 * How suitable each class is as a DEFAULT suggestion, in [0, 1].
 *
 * These are ordering weights, not nutritional judgements. `cooking_fat` and
 * `condiment` score low because nobody eats a bowl of oil, not because fat is
 * bad.
 */
export const ACTIONABILITY_SCORE: Readonly<Record<ActionabilityClass, number>> = {
  ready_to_eat: 1.0,
  meal_component: 0.9,
  beverage: 0.55,
  requires_preparation: 0.5,
  specialty: 0.3,
  ingredient: 0.2,
  condiment: 0.2,
  cooking_fat: 0.1,
  unknown: 0.45,
};

/** Source categories that ARE the classification, with no ambiguity. */
const CATEGORY_CLASS: Readonly<Record<string, ActionabilityClass>> = {
  'Beverages': 'beverage',
  'Fats and Oils': 'cooking_fat',
  'Spices and Herbs': 'condiment',
  'American Indian/Alaska Native Foods': 'specialty',
  'Restaurant Foods': 'ready_to_eat',
  'Fast Foods': 'ready_to_eat',
  'Meals, Entrees, and Side Dishes': 'ready_to_eat',
  'Snacks': 'ready_to_eat',
  'Sweets': 'ready_to_eat',
  'Fruits and Fruit Juices': 'ready_to_eat',
  'Baked Products': 'ready_to_eat',
  'Breakfast Cereals': 'ready_to_eat',
  'Sausages and Luncheon Meats': 'ready_to_eat',
  'Dairy and Egg Products': 'meal_component',
  'Beef Products': 'meal_component',
  'Poultry Products': 'meal_component',
  'Pork Products': 'meal_component',
  'Lamb, Veal, and Game Products': 'meal_component',
  'Finfish and Shellfish Products': 'meal_component',
  'Vegetables and Vegetable Products': 'meal_component',
  'Legumes and Legume Products': 'meal_component',
  'Cereal Grains and Pasta': 'meal_component',
  'Nut and Seed Products': 'meal_component',
  'Soups, Sauces, and Gravies': 'meal_component',
};

/**
 * FORM terms in the source description.
 *
 * These describe the physical form a record takes, which is why they
 * generalise: `flour` classifies every flour in the catalog, not soy flour.
 * Word-boundary matched so "meal" does not fire on "oatmeal".
 */
const FORM_PATTERNS: readonly { readonly re: RegExp; readonly cls: ActionabilityClass }[] = [
  { re: /\b(flour|powder|powdered|isolate|concentrate|meal|starch|gluten)\b/, cls: 'ingredient' },
  // A "dry mix" or "unprepared" record is something you cook WITH, and its
  // per-100 g nutrition describes the packet rather than the finished dish.
  { re: /\b(dry mix|mix,|unprepared|instant, dry|dry form)\b/, cls: 'ingredient' },
  { re: /\b(oil|shortening|lard|tallow|suet|fat, rendered|rendered fat)\b/, cls: 'cooking_fat' },
  { re: /\b(extract|seasoning|spice|vinegar|syrup|dressing|sauce mix|bouillon)\b/, cls: 'condiment' },
  // Organ meats and preparation intermediates: edible, rarely a default answer.
  { re: /\b(giblets|gizzard|liver|kidney|heart|spleen|lung|brain|tripe|variety meats|by-products)\b/, cls: 'specialty' },
  { re: /\b(dried|dehydrated|desiccated|freeze-dried|extender|substitute)\b/, cls: 'ingredient' },
  // Bare "dry X" is a dehydrated form (dry milk, dry mix). "Dry roasted" is a
  // cooking method, not a form, so it is deliberately excluded.
  { re: /\bdry\b(?!\s+roasted)/, cls: 'ingredient' },
];

export interface ActionabilityInput {
  readonly category?: string | null;
  readonly preparationState?: string | null;
  readonly sourceDescription?: string | null;
  readonly displayName?: string | null;
}

export interface ActionabilityAssessment {
  readonly actionabilityClass: ActionabilityClass;
  readonly score: number;
  /** Which source signal decided it, for auditability. */
  readonly basis: 'form' | 'preparation' | 'category' | 'default';
  readonly version: string;
}

/**
 * Classify a catalog record.
 *
 * Precedence is deliberate: FORM beats category, because "Soy flour" sits in
 * Legumes and "Whole egg, dried" in Dairy — the category says what it is made
 * from, the form says whether you can eat it.
 */
export function assessActionability(input: ActionabilityInput): ActionabilityAssessment {
  const text = `${input.displayName ?? ''} ${input.sourceDescription ?? ''}`.toLowerCase();

  for (const { re, cls } of FORM_PATTERNS) {
    if (re.test(text)) {
      return {
        actionabilityClass: cls, score: ACTIONABILITY_SCORE[cls],
        basis: 'form', version: ACTIONABILITY_VERSION,
      };
    }
  }

  /**
   * `raw` means uncooked, not inedible. A raw banana is ready to eat; raw
   * chicken is not. Only categories that genuinely require cooking are demoted,
   * which is why this consults the category rather than the state alone.
   */
  const COOKING_REQUIRED = new Set([
    'Beef Products', 'Poultry Products', 'Pork Products',
    'Lamb, Veal, and Game Products', 'Finfish and Shellfish Products',
    'Cereal Grains and Pasta', 'Legumes and Legume Products',
  ]);
  if (input.preparationState === 'raw'
      && COOKING_REQUIRED.has(input.category ?? '')) {
    return {
      actionabilityClass: 'requires_preparation',
      score: ACTIONABILITY_SCORE.requires_preparation,
      basis: 'preparation', version: ACTIONABILITY_VERSION,
    };
  }

  const category = input.category ?? '';
  const byCategory = CATEGORY_CLASS[category];
  if (byCategory !== undefined) {
    return {
      actionabilityClass: byCategory, score: ACTIONABILITY_SCORE[byCategory],
      basis: 'category', version: ACTIONABILITY_VERSION,
    };
  }

  return {
    actionabilityClass: 'unknown', score: ACTIONABILITY_SCORE.unknown,
    basis: 'default', version: ACTIONABILITY_VERSION,
  };
}
