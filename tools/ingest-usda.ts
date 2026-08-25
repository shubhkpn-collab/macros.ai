/**
 * REAL USDA INGESTION.
 *
 * Reads the supplied FDC archives, extracts canonical nutrients, curates a
 * usable generic seed, and writes it plus honest reports. Nothing here invents
 * a value: a food missing core nutrients is rejected, and an extended nutrient
 * the source never reported stays absent.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import {
  buildNutrientMap, type NutrientId,
} from '@macros/domain-nutrients';
import {
  extractUsdaRecord, inferPreparationState, USDA_NUTRIENT_MAP,
} from '@macros/catalog-ingestion';

const FILES = [
  ['Foundation', '/mnt/user-data/uploads/FoodData_Central_foundation_food_json_2026-04-30.json'],
  ['SR Legacy', '/mnt/user-data/uploads/FoodData_Central_sr_legacy_food_json_2018-04.json'],
] as const;

interface Seed {
  readonly productId: string;
  readonly fdcId: number;
  readonly dataset: string;
  readonly description: string;
  readonly category: string | null;
  readonly preparationState: string;
  readonly per100g: Record<string, { nutrientId: string; amount: number; unit: string }>;
  readonly publicationDate: string | null;
}

const stats = {
  recordsRead: 0, nullRecords: 0, malformed: 0,
  missingCore: 0, unresolvedPrep: 0, accepted: 0,
  byDataset: {} as Record<string, { read: number; accepted: number }>,
  unmapped: new Map<number, number>(),
  issues: { unit_conflict: 0, duplicate_conflict: 0, invalid_amount: 0, unknown_nutrient: 0 },
};

const CORE = ['energy_kcal', 'protein', 'carbohydrate', 'fat'] as const;
const seeds: Seed[] = [];
const seenFdc = new Set<number>();
const archiveHashes: Record<string, string> = {};

for (const [dataset, path] of FILES) {
  const raw = readFileSync(path);
  archiveHashes[dataset] = createHash('sha256').update(raw).digest('hex');
  const parsed = JSON.parse(raw.toString('utf8')) as Record<string, unknown[]>;
  const arr = parsed[Object.keys(parsed)[0]!]!;
  stats.byDataset[dataset] = { read: 0, accepted: 0 };

  for (const rec of arr) {
    stats.recordsRead++;
    stats.byDataset[dataset]!.read++;
    if (rec === null) { stats.nullRecords++; continue; }

    const out = extractUsdaRecord(rec);
    if (!out.ok) { stats.malformed++; continue; }
    const e = out.extraction;

    for (const id of e.unmappedUsdaIds) stats.unmapped.set(id, (stats.unmapped.get(id) ?? 0) + 1);
    for (const i of e.issues) stats.issues[i.kind]++;

    const prep = inferPreparationState(e.description);
    if (prep === 'unresolved') { stats.unresolvedPrep++; continue; }

    // Same FDC id twice across archives: keep the first (Foundation wins).
    if (seenFdc.has(e.fdcId)) continue;

    const { map } = buildNutrientMap(e.readings);

    // Gate on the BUILT MAP, not the raw readings. A reading can be present but
    // rejected during canonicalization — USDA's "carbohydrate by difference"
    // is occasionally slightly NEGATIVE for pure meats, which is not a physical
    // quantity and is refused. Checking readings alone published such foods
    // with no carbohydrate at all.
    if (!CORE.every((c) => map[c] !== undefined)) { stats.missingCore++; continue; }
    seenFdc.add(e.fdcId);
    const per100g: Seed['per100g'] = {};
    for (const [k, v] of Object.entries(map)) {
      if (v !== undefined) per100g[k] = { nutrientId: v.nutrientId, amount: v.amount, unit: v.unit };
    }

    seeds.push({
      productId: `usda-fdc-${e.fdcId}`,
      fdcId: e.fdcId,
      dataset,
      description: e.description,
      category: e.category,
      preparationState: prep,
      per100g,
      publicationDate: e.publicationDate,
    });
    stats.accepted++;
    stats.byDataset[dataset]!.accepted++;
  }
}

// --- curate a usable seed: common whole foods, capped, deterministic ---
const PRIORITY = /\b(chicken|beef|pork|turkey|salmon|tuna|cod|shrimp|egg|milk|yogurt|cheese|rice|oat|bread|pasta|potato|bean|lentil|chickpea|broccoli|spinach|carrot|tomato|apple|banana|orange|berry|almond|walnut|peanut|avocado|butter|oil|quinoa|corn|pea|onion|pepper|lettuce|cabbage|squash|mushroom)\b/i;

/**
 * Curate by RELEVANCE, never by completeness.
 *
 * Sorting by nutrient count would select only the richest records and make the
 * coverage report meaningless — it reported 100% for every nutrient, which says
 * more about the sort than about USDA. Ordering is deterministic by description
 * so the seed is reproducible.
 */
/**
 * STRATIFIED curation, round-robin across food terms.
 *
 * A plain alphabetical sort with a 500 cap silently truncated the seed at the
 * letter B — the catalog contained no chicken at all, and the search benchmark
 * scored 10% as a result. Taking a bounded slice PER TERM keeps every common
 * food represented, and ordering stays deterministic within each term.
 */
const TERMS = [
  'chicken', 'beef', 'pork', 'turkey', 'salmon', 'tuna', 'cod', 'shrimp', 'egg',
  'milk', 'yogurt', 'cheese', 'rice', 'oat', 'bread', 'pasta', 'potato', 'bean',
  'lentil', 'chickpea', 'broccoli', 'spinach', 'carrot', 'tomato', 'apple',
  'banana', 'orange', 'berry', 'almond', 'walnut', 'peanut', 'avocado', 'butter',
  'oil', 'quinoa', 'corn', 'pea', 'onion', 'pepper', 'lettuce', 'cabbage',
  'squash', 'mushroom',
];
const TARGET_SEED = 500;
const buckets = new Map<string, Seed[]>();
for (const term of TERMS) {
  const re = new RegExp(`\\b${term}`, 'i');
  buckets.set(term, seeds
    .filter((s) => re.test(s.description))
    .sort((a, b) => a.description.localeCompare(b.description) || a.fdcId - b.fdcId));
}
const curated: Seed[] = [];
const taken = new Set<number>();
let round = 0;
while (curated.length < TARGET_SEED) {
  let addedThisRound = 0;
  for (const term of TERMS) {
    if (curated.length >= TARGET_SEED) break;
    const bucket = buckets.get(term)!;
    const pick = bucket[round];
    if (pick === undefined || taken.has(pick.fdcId)) continue;
    taken.add(pick.fdcId);
    curated.push(pick);
    addedThisRound++;
  }
  if (addedThisRound === 0) break;
  round++;
}
curated.sort((a, b) => a.description.localeCompare(b.description) || a.fdcId - b.fdcId);

// --- micronutrient coverage over the PUBLISHED seed ---
const REPORTED: NutrientId[] = [
  'fiber', 'total_sugars', 'added_sugars', 'saturated_fat', 'cholesterol',
  'sodium', 'potassium', 'calcium', 'iron', 'magnesium', 'phosphorus', 'zinc',
  'selenium', 'copper', 'manganese', 'vitamin_a', 'vitamin_c', 'vitamin_d',
  'vitamin_e', 'vitamin_k', 'thiamin', 'riboflavin', 'niacin',
  'pantothenic_acid', 'vitamin_b6', 'folate', 'vitamin_b12', 'choline',
];
const coverageOver = (pool: readonly Seed[]) => REPORTED.map((id) => {
  const known = pool.filter((s) => s.per100g[id] !== undefined).length;
  return {
    nutrientId: id, known, total: pool.length,
    percent: pool.length === 0 ? 0 : Math.round((known / pool.length) * 1000) / 10,
  };
});
const coverage = coverageOver(curated);
// Reported over ALL accepted records too, so the published-seed figure can be
// checked against the wider population rather than taken on trust.
const coverageAllAccepted = coverageOver(seeds);

const report = {
  adapterVersion: 'usda-fdc-adapter@1.0.0',
  archives: FILES.map(([d, p]) => ({ dataset: d, path: p, sha256: archiveHashes[d] })),
  mappedNutrients: USDA_NUTRIENT_MAP.length,
  stats: {
    recordsRead: stats.recordsRead,
    nullRecords: stats.nullRecords,
    malformed: stats.malformed,
    rejectedMissingCore: stats.missingCore,
    rejectedUnresolvedPreparation: stats.unresolvedPrep,
    acceptedCandidates: stats.accepted,
    publishedSeed: curated.length,
    byDataset: stats.byDataset,
    nutrientIssues: stats.issues,
  },
  unmappedUsdaNutrients: [...stats.unmapped.entries()]
    .sort((a, b) => b[1] - a[1]).slice(0, 20)
    .map(([id, count]) => ({ usdaId: id, occurrences: count })),
  coverage,
  coverageAllAccepted,
};

writeFileSync('data/usda-seed.json', JSON.stringify(curated, null, 1));
writeFileSync('data/usda-import-report.json', JSON.stringify(report, null, 1));

console.log('=== REAL USDA IMPORT ===');
console.log('records read      ', stats.recordsRead, '| null', stats.nullRecords, '| malformed', stats.malformed);
console.log('rejected: missing core', stats.missingCore, '| unresolved prep', stats.unresolvedPrep);
console.log('accepted candidates', stats.accepted, '| PUBLISHED SEED', curated.length);
console.log('by dataset:', JSON.stringify(stats.byDataset));
console.log('nutrient issues:', JSON.stringify(stats.issues));
console.log('distinct unmapped USDA ids:', stats.unmapped.size);
console.log('\n=== MICRONUTRIENT COVERAGE ===');
console.log('nutrient           published seed        all accepted');
for (let i = 0; i < coverage.length; i++) {
  const c = coverage[i]!; const a = coverageAllAccepted[i]!;
  console.log(
    String(c.nutrientId).padEnd(18),
    `${String(c.known).padStart(4)}/${c.total}`.padStart(9), String(c.percent).padStart(6) + '%',
    `${String(a.known).padStart(5)}/${a.total}`.padStart(11), String(a.percent).padStart(6) + '%',
  );
}
