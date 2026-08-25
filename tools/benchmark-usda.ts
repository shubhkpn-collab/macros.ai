/**
 * REAL SEARCH + RECOMMENDATION EVALUATION over the published USDA seed.
 *
 * Measured on real records, not synthetic fixtures. Every number printed is
 * computed here; none is asserted from memory.
 */
import { readFileSync } from 'node:fs';
import { searchFood, type SearchableFood } from '@macros/domain-food-search';

interface Seed {
  productId: string; fdcId: number; description: string;
  preparationState: string; per100g: Record<string, { amount: number; unit: string }>;
}
const seeds = JSON.parse(readFileSync('data/usda-seed.json', 'utf8')) as Seed[];

const corpus: SearchableFood[] = seeds.map((s) => ({
  productVersionId: `${s.productId}@v1`,
  displayName: s.description,
  preparationState: s.preparationState,
}));

/**
 * A real query corpus. Expectation is a SUBSTRING the correct result's
 * description must contain — written against what USDA actually publishes,
 * checked by inspection of the seed rather than assumed.
 */
const QUERIES: readonly { q: string; expect: RegExp | null }[] = [
  { q: 'chicken breast', expect: /chicken.*breast/i },
  { q: 'ground beef', expect: /beef.*ground/i },
  { q: 'salmon', expect: /salmon/i },
  { q: 'brown rice', expect: /rice.*brown/i },
  { q: 'broccoli', expect: /broccoli/i },
  { q: 'spinach', expect: /spinach/i },
  { q: 'almonds', expect: /almond/i },
  { q: 'cheddar cheese', expect: /chees.*cheddar|cheddar/i },
  { q: 'greek yogurt', expect: /yogurt/i },
  { q: 'sweet potato', expect: /potato.*sweet|sweet potato/i },
  { q: 'black beans', expect: /beans?.*black|black beans?/i },
  { q: 'oats', expect: /oat/i },
  { q: 'eggs', expect: /egg/i },
  { q: 'banana', expect: /banana/i },
  { q: 'avocado', expect: /avocado/i },
  { q: 'lentils', expect: /lentil/i },
  { q: 'turkey breast', expect: /turkey/i },
  { q: 'peanut butter', expect: /peanut/i },
  { q: 'quinoa', expect: /quinoa/i },
  { q: 'tuna', expect: /tuna/i },
  // Must return NOTHING — a confident wrong match is worse than no match.
  { q: 'zzzqqq nonsense food', expect: null },
  { q: 'unicorn steak', expect: null },
];

let top1 = 0, top4 = 0, mrrSum = 0, zeroCorrect = 0, zeroTotal = 0, falsePositive = 0;
const misses: string[] = [];

for (const { q, expect } of QUERIES) {
  const results = searchFood(corpus, { text: q });
  if (expect === null) {
    zeroTotal++;
    if (results.length === 0) zeroCorrect++; else falsePositive++;
    continue;
  }
  const rank = results.findIndex((r) => expect.test(r.productVersion.displayName));
  if (rank === 0) top1++;
  if (rank >= 0 && rank < 4) top4++;
  if (rank >= 0) mrrSum += 1 / (rank + 1); else misses.push(q);
}

const scored = QUERIES.filter((x) => x.expect !== null).length;
const pct = (n: number, d: number) => `${Math.round((n / d) * 1000) / 10}%`;

console.log('=== REAL SEARCH BENCHMARK (USDA seed) ===');
console.log('corpus size      ', corpus.length);
console.log('scored queries   ', scored);
console.log('Top-1            ', top1, pct(top1, scored));
console.log('Top-4            ', top4, pct(top4, scored));
console.log('MRR              ', Math.round((mrrSum / scored) * 1000) / 1000);
console.log('zero-result correct', zeroCorrect, '/', zeroTotal);
console.log('false positives  ', falsePositive);
if (misses.length > 0) console.log('misses           ', misses.join(', '));

// --- raw/cooked correctness ---
const rawCooked = corpus.filter((c) => /chicken/i.test(c.displayName));
const raws = rawCooked.filter((c) => c.preparationState === 'raw').length;
const cooked = rawCooked.filter((c) => c.preparationState === 'cooked').length;
console.log('\n=== RAW/COOKED ===');
console.log('chicken entries:', rawCooked.length, '| raw', raws, '| cooked', cooked);
console.log('preparation is explicit on every seed record:',
  seeds.every((s) => s.preparationState === 'raw' || s.preparationState === 'cooked'));

// --- recommendation informational fields over real foods ---
console.log('\n=== RECOMMENDATION INFORMATIONAL FIELDS (real foods) ===');
const proteinDense = seeds
  .filter((s) => s.per100g['protein'] !== undefined && s.per100g['energy_kcal'] !== undefined)
  .map((s) => ({
    d: s.description,
    p: s.per100g['protein']!.amount,
    kcal: s.per100g['energy_kcal']!.amount,
    fiber: s.per100g['fiber']?.amount ?? null,
    sodium: s.per100g['sodium']?.amount ?? null,
  }))
  .filter((s) => s.kcal > 0)
  .sort((a, b) => (b.p * 4) / b.kcal - (a.p * 4) / a.kcal)
  .slice(0, 5);
for (const s of proteinDense) {
  console.log(` ${s.d.slice(0, 46).padEnd(47)} P${String(s.p).padStart(5)}g  ${String(s.kcal).padStart(4)}kcal`,
    `fiber ${s.fiber === null ? 'n/a' : s.fiber + 'g'}`, `sodium ${s.sodium === null ? 'n/a' : s.sodium + 'mg'}`);
}
