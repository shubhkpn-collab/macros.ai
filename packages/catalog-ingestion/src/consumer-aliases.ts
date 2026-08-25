/**
 * CURATED CONSUMER VOCABULARY.
 *
 * USDA writes "Cheese, cheddar"; a person searches "cheddar cheese". Aliases
 * close that gap.
 *
 * An alias is a SEARCH HINT, never identity. It may widen the candidate set a
 * user chooses from; it may never decide which food was meant, and it must
 * never merge nutritionally distinct foods — raw vs cooked, skim vs whole,
 * white vs brown rice all stay separate, and the A/B/C/D confirmation still
 * resolves the choice.
 */
export const ALIAS_POLICY_VERSION = 'consumer-aliases@1.0.0';

export interface AliasRule {
  /** Matched against the normalized source description. */
  readonly match: RegExp;
  /** Consumer phrasings that should retrieve this food. */
  readonly aliases: readonly string[];
}

export const CONSUMER_ALIASES: readonly AliasRule[] = [
  { match: /^cheese, cheddar/i, aliases: ['cheddar cheese', 'cheddar'] },
  { match: /^cheese, mozzarella/i, aliases: ['mozzarella cheese', 'mozzarella'] },
  { match: /^cheese, parmesan/i, aliases: ['parmesan cheese', 'parmesan'] },
  { match: /^cheese, cottage/i, aliases: ['cottage cheese'] },
  { match: /^cheese, swiss/i, aliases: ['swiss cheese'] },
  { match: /^yogurt, greek/i, aliases: ['greek yogurt', 'greek yoghurt'] },
  { match: /^yogurt, plain/i, aliases: ['plain yogurt', 'plain yoghurt'] },
  { match: /^milk, .*whole/i, aliases: ['whole milk'] },
  { match: /^milk, .*(nonfat|skim|fat free)/i, aliases: ['skim milk', 'nonfat milk'] },
  { match: /^milk, .*(reduced fat|2%)/i, aliases: ['2% milk', 'reduced fat milk'] },
  { match: /^chicken, .*breast/i, aliases: ['chicken breast'] },
  { match: /^chicken, .*thigh/i, aliases: ['chicken thigh'] },
  { match: /^beef, ground/i, aliases: ['ground beef', 'minced beef', 'hamburger meat'] },
  { match: /^pork, .*(chop|loin)/i, aliases: ['pork chop'] },
  { match: /^fish, salmon/i, aliases: ['salmon'] },
  { match: /^fish, tuna/i, aliases: ['tuna'] },
  { match: /^fish, cod/i, aliases: ['cod'] },
  { match: /^crustaceans, shrimp|^shrimp/i, aliases: ['shrimp', 'prawns'] },
  { match: /^egg, white/i, aliases: ['egg whites', 'egg white'] },
  { match: /^egg, whole/i, aliases: ['eggs', 'whole egg'] },
  { match: /^rice, white/i, aliases: ['white rice'] },
  { match: /^rice, brown/i, aliases: ['brown rice'] },
  { match: /^oats/i, aliases: ['oats', 'oatmeal', 'rolled oats'] },
  { match: /^bread, whole.wheat/i, aliases: ['whole wheat bread', 'wholemeal bread'] },
  { match: /^bread, white/i, aliases: ['white bread'] },
  { match: /^pasta|^spaghetti|^macaroni/i, aliases: ['pasta'] },
  { match: /^potatoes, .*sweet|^sweet potato/i, aliases: ['sweet potato', 'sweet potatoes'] },
  { match: /^potatoes/i, aliases: ['potato', 'potatoes'] },
  { match: /^beans, .*black/i, aliases: ['black beans'] },
  { match: /^beans, .*kidney/i, aliases: ['kidney beans'] },
  { match: /^chickpeas|^garbanzo/i, aliases: ['chickpeas', 'garbanzo beans'] },
  { match: /^lentils/i, aliases: ['lentils'] },
  { match: /^peanut butter|^peanuts/i, aliases: ['peanut butter', 'peanuts'] },
  { match: /^nuts, almond|^almonds/i, aliases: ['almonds'] },
  { match: /^nuts, walnut|^walnuts/i, aliases: ['walnuts'] },
  { match: /^oil, olive|^olive oil/i, aliases: ['olive oil'] },
  { match: /^butter, /i, aliases: ['butter'] },
  { match: /^avocado/i, aliases: ['avocado', 'avocados'] },
  { match: /^blueberries/i, aliases: ['blueberries'] },
  { match: /^strawberries/i, aliases: ['strawberries'] },
  { match: /^bananas/i, aliases: ['banana', 'bananas'] },
  { match: /^apples/i, aliases: ['apple', 'apples'] },
  { match: /^oranges/i, aliases: ['orange', 'oranges'] },
  { match: /^broccoli/i, aliases: ['broccoli'] },
  { match: /^spinach/i, aliases: ['spinach'] },
  { match: /^tomatoes/i, aliases: ['tomato', 'tomatoes'] },
  { match: /^carrots/i, aliases: ['carrot', 'carrots'] },
  { match: /^peppers, .*bell/i, aliases: ['bell pepper', 'bell peppers'] },
  { match: /^cucumber/i, aliases: ['cucumber', 'cucumbers'] },
  { match: /^quinoa/i, aliases: ['quinoa'] },
  { match: /^turkey, /i, aliases: ['turkey'] },
];

/** Aliases for one source description. Never collapses distinct foods. */
export function aliasesFor(sourceDescription: string): readonly string[] {
  const out = new Set<string>();
  for (const rule of CONSUMER_ALIASES) {
    if (rule.match.test(sourceDescription)) for (const a of rule.aliases) out.add(a);
  }
  return [...out].sort();
}
