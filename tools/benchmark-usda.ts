/**
 * REAL SEARCH + CATALOG EVALUATION.
 *
 * Every metric is computed here from the published catalog and written into the
 * canonical report, so documentation and closure reporting cannot drift from
 * what the code actually produces.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { searchFood, type SearchableFood } from '@macros/domain-food-search';

interface Seed {
  productId: string; displayName: string; sourceDescription: string;
  preparationState: string; category: string | null; recommendable: boolean;
  aliases: string[];
  per100g: Record<string, { amount: number; unit: string }>;
}
const seeds = JSON.parse(readFileSync('data/usda-seed.json', 'utf8')) as Seed[];

const corpus: SearchableFood[] = seeds.map((s) => ({
  productVersionId: `${s.productId}@v1`,
  displayName: s.displayName,
  preparationState: s.preparationState,
  aliases: s.aliases,
}));

/**
 * HUMAN-AUTHORED regression corpus. Each expectation was checked against what
 * the catalog actually contains — not generated from the names it holds.
 *
 * `ambiguous` queries have no single right answer: "rice" legitimately returns
 * several foods, and the product's A/B/C/D confirmation resolves it. For those
 * we require a correct candidate in the top 4, never a forced Top-1.
 */
interface Query {
  readonly q: string;
  readonly expect: RegExp | null;
  readonly ambiguous?: boolean;
  readonly expectPreparation?: string;
}

const QUERIES: readonly Query[] = [
  // --- proteins ---
  { q: 'chicken breast', expect: /chicken/i, ambiguous: true },
  { q: 'chicken', expect: /chicken/i, ambiguous: true },
  { q: 'ground beef', expect: /beef/i, ambiguous: true },
  { q: 'beef', expect: /beef/i, ambiguous: true },
  { q: 'pork chop', expect: /pork/i, ambiguous: true },
  { q: 'turkey', expect: /turkey/i, ambiguous: true },
  { q: 'salmon', expect: /salmon/i },
  { q: 'tuna', expect: /tuna/i },
  { q: 'cod', expect: /cod/i },
  { q: 'shrimp', expect: /shrimp/i },
  { q: 'eggs', expect: /egg/i, ambiguous: true },
  { q: 'egg whites', expect: /egg.*white|white.*egg/i, ambiguous: true },
  { q: 'large egg', expect: /egg/i, ambiguous: true },
  // --- dairy ---
  { q: 'cheddar cheese', expect: /cheddar/i },
  { q: 'cheddar', expect: /cheddar/i },
  { q: 'mozzarella', expect: /mozzarella/i },
  { q: 'mozzarella cheese', expect: /mozzarella/i },
  { q: 'parmesan cheese', expect: /parmesan/i },
  { q: 'cottage cheese', expect: /cottage/i },
  { q: 'swiss cheese', expect: /swiss/i },
  { q: 'cheese', expect: /cheese/i, ambiguous: true },
  { q: 'greek yogurt', expect: /yogurt|yoghurt/i, ambiguous: true },
  { q: 'greek yoghurt', expect: /yogurt|yoghurt/i, ambiguous: true },
  { q: 'yogurt', expect: /yogurt/i, ambiguous: true },
  { q: 'whole milk', expect: /milk/i, ambiguous: true },
  { q: 'skim milk', expect: /milk/i, ambiguous: true },
  { q: 'milk', expect: /milk/i, ambiguous: true },
  { q: 'butter', expect: /butter/i, ambiguous: true },
  // --- grains and carbs ---
  { q: 'white rice', expect: /rice/i, ambiguous: true },
  { q: 'brown rice', expect: /rice/i, ambiguous: true },
  { q: 'rice', expect: /rice/i, ambiguous: true },
  { q: 'oats', expect: /oat/i, ambiguous: true },
  { q: 'oatmeal', expect: /oat/i, ambiguous: true },
  { q: 'bread', expect: /bread/i, ambiguous: true },
  { q: 'whole wheat bread', expect: /bread/i, ambiguous: true },
  { q: 'pasta', expect: /pasta|spaghetti|macaroni/i, ambiguous: true },
  { q: 'quinoa', expect: /quinoa/i },
  { q: 'potato', expect: /potato/i, ambiguous: true },
  { q: 'potatoes', expect: /potato/i, ambiguous: true },
  { q: 'sweet potato', expect: /sweet potato|potato.*sweet/i, ambiguous: true },
  { q: 'tortilla', expect: /tortilla/i, ambiguous: true },
  // --- legumes ---
  { q: 'black beans', expect: /bean/i, ambiguous: true },
  { q: 'kidney beans', expect: /bean/i, ambiguous: true },
  { q: 'chickpeas', expect: /chickpea|garbanzo/i, ambiguous: true },
  { q: 'garbanzo beans', expect: /chickpea|garbanzo|bean/i, ambiguous: true },
  { q: 'lentils', expect: /lentil/i },
  { q: 'beans', expect: /bean/i, ambiguous: true },
  // --- fruit ---
  { q: 'banana', expect: /banana/i },
  { q: 'bananas', expect: /banana/i },
  { q: 'apple', expect: /apple/i, ambiguous: true },
  { q: 'apples', expect: /apple/i, ambiguous: true },
  { q: 'orange', expect: /orange/i, ambiguous: true },
  { q: 'blueberries', expect: /blueberr/i },
  { q: 'strawberries', expect: /strawberr/i },
  { q: 'avocado', expect: /avocado/i },
  { q: 'avocados', expect: /avocado/i },
  { q: 'grapes', expect: /grape/i, ambiguous: true },
  // --- vegetables ---
  { q: 'broccoli', expect: /broccoli/i },
  { q: 'spinach', expect: /spinach/i },
  { q: 'tomato', expect: /tomato/i, ambiguous: true },
  { q: 'tomatoes', expect: /tomato/i, ambiguous: true },
  { q: 'carrot', expect: /carrot/i, ambiguous: true },
  { q: 'carrots', expect: /carrot/i, ambiguous: true },
  { q: 'cucumber', expect: /cucumber|pickle/i, ambiguous: true },
  { q: 'bell pepper', expect: /pepper/i, ambiguous: true },
  { q: 'onion', expect: /onion/i, ambiguous: true },
  { q: 'lettuce', expect: /lettuce/i, ambiguous: true },
  { q: 'mushrooms', expect: /mushroom/i, ambiguous: true },
  { q: 'cabbage', expect: /cabbage/i, ambiguous: true },
  { q: 'peas', expect: /pea\b|peas/i, ambiguous: true },
  { q: 'corn', expect: /corn/i, ambiguous: true },
  // --- fats and nuts ---
  { q: 'olive oil', expect: /olive/i, ambiguous: true },
  { q: 'peanut butter', expect: /peanut/i, ambiguous: true },
  { q: 'peanuts', expect: /peanut/i, ambiguous: true },
  { q: 'almonds', expect: /almond/i, ambiguous: true },
  { q: 'walnuts', expect: /walnut/i, ambiguous: true },
  { q: 'hummus', expect: /hummus/i },
  // --- word order / plural variants ---
  { q: 'breast chicken', expect: /chicken/i, ambiguous: true },
  { q: 'cheese cheddar', expect: /cheddar/i },
  { q: 'oil olive', expect: /olive/i, ambiguous: true },
  // --- PREPARATION-SENSITIVE (Section 16) ---
  // Wrong preparation is a HIGH-SEVERITY error: cooked beef is roughly a third
  // denser in energy than raw, so a preparation mix-up silently corrupts a log.
  // Every pair below was verified to exist in both states in the catalog.
  { q: 'raw ground turkey', expect: /turkey/i, ambiguous: true, expectPreparation: 'raw' },
  { q: 'cooked ground turkey', expect: /turkey/i, ambiguous: true, expectPreparation: 'cooked' },
  { q: 'raw beef loin', expect: /loin/i, ambiguous: true, expectPreparation: 'raw' },
  { q: 'cooked beef loin', expect: /loin/i, ambiguous: true, expectPreparation: 'cooked' },
  { q: 'raw almonds', expect: /almond/i, ambiguous: true, expectPreparation: 'raw' },
  { q: 'roasted almonds', expect: /almond/i, ambiguous: true, expectPreparation: 'cooked' },
  { q: 'raw sunflower seeds', expect: /seed/i, ambiguous: true, expectPreparation: 'raw' },
  { q: 'dry roasted sunflower seeds', expect: /seed/i, ambiguous: true, expectPreparation: 'cooked' },
  { q: 'raw egg white', expect: /egg.*white|white.*egg/i, ambiguous: true, expectPreparation: 'raw' },
  { q: 'cooked chicken breast', expect: /chicken/i, ambiguous: true, expectPreparation: 'cooked' },
  { q: 'raw snap beans', expect: /snap bean|bean/i, ambiguous: true, expectPreparation: 'raw' },
  { q: 'cooked kale', expect: /kale/i, ambiguous: true, expectPreparation: 'cooked' },

  // --- must return NOTHING ---
  { q: 'zzzqqq nonsense food', expect: null },
  { q: 'unicorn steak', expect: null },
  { q: 'dragon fruit smoothie deluxe xyzzy', expect: null },
  { q: 'qqqq', expect: null },
];

let top1 = 0, top4 = 0, mrrSum = 0;
let ambTop4 = 0, ambTotal = 0, unambTop1 = 0, unambTotal = 0;
let zeroCorrect = 0, zeroTotal = 0, falsePositive = 0;
let prepChecked = 0, prepTop1 = 0, prepTop4 = 0, prepOutranked = 0;
const prepFailures: string[] = [];
const misses: string[] = [];

for (const query of QUERIES) {
  const results = searchFood(corpus, { text: query.q });
  if (query.expect === null) {
    zeroTotal++;
    if (results.length === 0) zeroCorrect++; else falsePositive++;
    continue;
  }
  const rank = results.findIndex((r) => query.expect!.test(r.productVersion.displayName));
  if (rank === 0) top1++;
  if (rank >= 0 && rank < 4) top4++;
  if (rank >= 0) mrrSum += 1 / (rank + 1); else misses.push(query.q);

  if (query.ambiguous === true) {
    ambTotal++;
    if (rank >= 0 && rank < 4) ambTop4++;
  } else {
    unambTotal++;
    if (rank === 0) unambTop1++;
  }
  if (query.expectPreparation !== undefined) {
    prepChecked++;
    const top1Prep = results[0]?.productVersion.preparationState;
    if (top1Prep === query.expectPreparation) prepTop1++;
    const inTop4 = results.slice(0, 4).some(
      (r) => query.expect!.test(r.productVersion.displayName) &&
        r.productVersion.preparationState === query.expectPreparation,
    );
    if (inTop4) prepTop4++;
    // A result of the WRONG preparation ranking above every correct one.
    const firstCorrect = results.findIndex(
      (r) => r.productVersion.preparationState === query.expectPreparation,
    );
    const firstWrong = results.findIndex(
      (r) => query.expect!.test(r.productVersion.displayName) &&
        r.productVersion.preparationState !== query.expectPreparation,
    );
    if (firstWrong >= 0 && (firstCorrect < 0 || firstWrong < firstCorrect)) {
      prepOutranked++;
      prepFailures.push(query.q);
    }
  }
}

const scored = QUERIES.filter((x) => x.expect !== null).length;
const r1 = (n: number) => Math.round(n * 1000) / 10;

// --- common-food coverage matrix (human-authored concept list) ---
const CONCEPTS: readonly string[] = [
  'chicken breast', 'chicken thigh', 'ground beef', 'steak', 'turkey', 'salmon',
  'tuna', 'shrimp', 'eggs', 'egg whites', 'whole milk', '2% milk', 'skim milk',
  'greek yogurt', 'plain yogurt', 'cottage cheese', 'cheddar', 'mozzarella',
  'white rice', 'brown rice', 'oats', 'bread', 'pasta', 'quinoa', 'potato',
  'sweet potato', 'tortilla', 'black beans', 'kidney beans', 'chickpeas',
  'lentils', 'banana', 'apple', 'orange', 'blueberries', 'strawberries',
  'avocado', 'broccoli', 'spinach', 'tomato', 'cucumber', 'carrot',
  'bell pepper', 'olive oil', 'butter', 'peanut butter', 'almonds', 'walnuts',
];
const conceptMatrix = CONCEPTS.map((c) => {
  const hits = searchFood(corpus, { text: c });
  const preparations = [...new Set(hits.map((h) => h.productVersion.preparationState))].sort();
  return { concept: c, available: hits.length > 0, matches: hits.length, preparations };
});
const availableConcepts = conceptMatrix.filter((c) => c.available).length;

const prepDistribution: Record<string, number> = {};
for (const s of seeds) prepDistribution[s.preparationState] = (prepDistribution[s.preparationState] ?? 0) + 1;

const searchReport = {
  corpusSize: corpus.length,
  totalQueries: QUERIES.length,
  scoredQueries: scored,
  top1: top1, top1Percent: r1(top1 / scored),
  top4: top4, top4Percent: r1(top4 / scored),
  mrr: Math.round((mrrSum / scored) * 1000) / 1000,
  unambiguous: { total: unambTotal, top1: unambTop1, percent: unambTotal === 0 ? 0 : r1(unambTop1 / unambTotal) },
  ambiguous: { total: ambTotal, top4: ambTop4, percent: ambTotal === 0 ? 0 : r1(ambTop4 / ambTotal) },
  zeroResult: { total: zeroTotal, correct: zeroCorrect },
  falsePositives: falsePositive,
  preparationSensitive: {
    total: prepChecked, top1: prepTop1, top4: prepTop4,
    top1Percent: prepChecked === 0 ? 0 : r1(prepTop1 / prepChecked),
    top4Percent: prepChecked === 0 ? 0 : r1(prepTop4 / prepChecked),
    wrongPreparationOutranked: prepOutranked,
    wrongPreparationRate: prepChecked === 0 ? 0 : r1(prepOutranked / prepChecked),
    failures: prepFailures,
  },
  misses,
  conceptMatrix: { total: CONCEPTS.length, available: availableConcepts, entries: conceptMatrix },
  publishedPreparationDistribution: prepDistribution,
};

// Merge into the canonical report so ONE artifact holds every metric.
const reportPath = 'data/usda-import-report.json';
const canonical = JSON.parse(readFileSync(reportPath, 'utf8')) as Record<string, unknown>;
canonical['search'] = searchReport;
writeFileSync(reportPath, JSON.stringify(canonical, null, 1));

console.log('=== REAL SEARCH BENCHMARK ===');
console.log('corpus            ', corpus.length);
console.log('queries           ', QUERIES.length, '| scored', scored);
console.log('Top-1             ', top1, `${searchReport.top1Percent}%`);
console.log('Top-4             ', top4, `${searchReport.top4Percent}%`);
console.log('MRR               ', searchReport.mrr);
console.log('unambiguous Top-1 ', `${unambTop1}/${unambTotal}`, `${searchReport.unambiguous.percent}%`);
console.log('ambiguous Top-4   ', `${ambTop4}/${ambTotal}`, `${searchReport.ambiguous.percent}%`);
console.log('zero-result       ', `${zeroCorrect}/${zeroTotal}`, '| false positives', falsePositive);
if (misses.length > 0) console.log('misses            ', misses.join(', '));
console.log('\n=== COMMON FOOD COVERAGE ===');
console.log(`available ${availableConcepts}/${CONCEPTS.length}`);
const missing = conceptMatrix.filter((c) => !c.available).map((c) => c.concept);
if (missing.length > 0) console.log('missing:', missing.join(', '));
console.log('\n=== PREPARATION-SENSITIVE SEARCH ===');
console.log('queries', prepChecked, '| Top-1', prepTop1, '| Top-4', prepTop4, '| wrong-prep outranked', prepOutranked);
if (prepFailures.length > 0) console.log('failures:', prepFailures.join(', '));
console.log('\npublished preparation distribution:', JSON.stringify(prepDistribution));
