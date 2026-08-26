/**
 * REAL USDA INGESTION.
 *
 * Reads the supplied FDC archives, extracts canonical nutrients, curates a
 * usable generic seed, and writes it plus honest reports. Nothing here invents
 * a value: a food missing core nutrients is rejected, and an extended nutrient
 * the source never reported stays absent.
 */
import { sourceFile } from './repo-paths.js';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import {
  buildNutrientMap, type NutrientId,
} from '@macros/domain-nutrients';
import {
  CATALOG_POLICY_VERSION, GENERIC_IDENTITY_VERSION, PREPARATION_CLASSIFIER_VERSION,
  categoryEligibility, classifyPreparation, conceptKeyFor, consumerDisplayName,
  eligibleForRecommendation, extractUsdaRecord, genericProductId, isPublishableState,
  publishesToConsumerCatalog, aliasesFor, assessOverlap, disambiguateSameSource, preferredSource,
  ALIAS_POLICY_VERSION, USDA_NUTRIENT_MAP,
} from '@macros/catalog-ingestion';

/**
 * Source archives, discovered rather than assumed.
 *
 * The owner supplies these; whichever are present are ingested, and the report
 * records exactly which were used. A missing archive is reported honestly, not
 * substituted with remembered data.
 */
const CANDIDATE_FILES = [
  // Owner-supplied archives live outside Git. sourceFile() defaults to a
  // repository-relative directory and honours MACROS_SOURCE_DIR, so no
  // machine-specific path is baked into the pipeline.
  ['Foundation', sourceFile('FoodData_Central_foundation_food_json_2026-04-30.json')],
  ['SR Legacy', sourceFile('FoodData_Central_sr_legacy_food_json_2018-04.json')],
] as const;
const FILES = CANDIDATE_FILES.filter(([, p]) => existsSync(p));
const MISSING_ARCHIVES = CANDIDATE_FILES.filter(([, p]) => !existsSync(p)).map(([d]) => d);

interface Seed {
  /** Internal identity, derived from food semantics — never from a source id. */
  readonly productId: string;
  readonly conceptKey: string;
  /** Consumer-facing label. The original description is retained separately. */
  readonly displayName: string;
  readonly sourceDescription: string;
  readonly preparationState: string;
  readonly preparationRule: string;
  readonly category: string | null;
  readonly categoryEligibility: string;
  readonly recommendable: boolean;
  readonly aliases: readonly string[];
  readonly per100g: Record<string, { nutrientId: string; amount: number; unit: string }>;
  /** External source identity lives HERE, as provenance. */
  readonly externalIdentity: {
    readonly provider: string; readonly dataset: string;
    readonly sourceRecordId: string; readonly release: string | null;
    readonly archiveSha256: string;
  };
}

const stats = {
  recordsRead: 0, nullRecords: 0, malformed: 0,
  missingCore: 0, unresolvedPrep: 0, accepted: 0,
  excludedCategory: 0, duplicateConcept: 0, crossSourceConvergence: 0,
  /** Over ALL SOURCE RECORDS scanned — not the published catalog. */
  sourcePreparationCounts: {} as Record<string, number>,
  categoryCounts: {} as Record<string, number>,
  byDataset: {} as Record<string, { read: number; accepted: number }>,
  unmapped: new Map<number, number>(),
  issues: { unit_conflict: 0, duplicate_conflict: 0, invalid_amount: 0, unknown_nutrient: 0 },
};

const CORE = ['energy_kcal', 'protein', 'carbohydrate', 'fat'] as const;

/**
 * COLLISION INVARIANT.
 *
 * Ids are a 16-hex truncation of SHA-256. Collision is improbable, but
 * improbable is not a guarantee — and a silent collision would attach one
 * food's nutrition to another. The build fails loudly instead of relying on
 * probability.
 */
const idToConceptKey = new Map<string, string>();
function assertNoCollision(productId: string, conceptKey: string): void {
  const existing = idToConceptKey.get(productId);
  if (existing !== undefined && existing !== conceptKey) {
    throw new Error(
      `productId collision: ${productId} produced by two different concepts:\n  ${existing}\n  ${conceptKey}`,
    );
  }
  idToConceptKey.set(productId, conceptKey);
}
const seeds: Seed[] = [];
const seenFdc = new Set<number>();
const seenConcepts = new Set<string>();
/** Which source first claimed each concept — used to measure convergence. */
const conceptOrigin = new Map<string, { dataset: string; description: string; sourceRecordId: string }>();
const sourcePriorityAudit = { foundationKept: 0, unexpectedPriority: [] as string[] };
const sameSourceCollisions: {
  conceptKey: string; dataset: string;
  keptSourceRecordId: string; keptDescription: string;
  disambiguatedSourceRecordId: string; disambiguatedDescription: string;
}[] = [];
const convergenceExamples: {
  productId: string; conceptKey: string;
  keptDataset: string; keptDescription: string;
  droppedDataset: string; droppedDescription: string;
}[] = [];
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

    const prep = classifyPreparation(e.description, e.category);
    stats.sourcePreparationCounts[prep.state] = (stats.sourcePreparationCounts[prep.state] ?? 0) + 1;
    if (!isPublishableState(prep.state)) { stats.unresolvedPrep++; continue; }

    const eligibility = categoryEligibility(e.category);
    stats.categoryCounts[e.category ?? '(none)'] = (stats.categoryCounts[e.category ?? '(none)'] ?? 0) + 1;
    if (!publishesToConsumerCatalog(eligibility)) { stats.excludedCategory++; continue; }

    if (seenFdc.has(e.fdcId)) continue;

    const { map } = buildNutrientMap(e.readings);

    // Gate on the BUILT MAP, not the raw readings. A reading can be present but
    // rejected during canonicalization — USDA's "carbohydrate by difference"
    // is occasionally slightly NEGATIVE for pure meats, which is not a physical
    // quantity and is refused. Checking readings alone published such foods
    // with no carbohydrate at all.
    if (!CORE.every((c) => map[c] !== undefined)) { stats.missingCore++; continue; }
    seenFdc.add(e.fdcId);

    // Internal identity from FOOD SEMANTICS. Two source records describing the
    // same food and preparation collapse to one concept rather than two
    // near-identical catalog entries.
    let conceptKey = conceptKeyFor(e.description, prep.state);
    let productId = genericProductId(conceptKey);
    assertNoCollision(productId, conceptKey);
    if (seenConcepts.has(productId)) {
      // THE CORE GATE, measured rather than assumed: when the SAME food concept
      // arrives from a DIFFERENT source, does it converge onto one identity?
      const first = conceptOrigin.get(productId);
      if (first !== undefined && first.dataset !== dataset) {
        stats.crossSourceConvergence++;
        stats.duplicateConcept++;
        // A4: source priority audited over EVERY convergence, not a sample.
        const expected = preferredSource(first.dataset, dataset);
        if (first.dataset === expected) sourcePriorityAudit.foundationKept++;
        else sourcePriorityAudit.unexpectedPriority.push(
          `${productId}: kept ${first.dataset} over ${dataset}`,
        );
        convergenceExamples.push({
          productId,
          conceptKey,
          keptDataset: first.dataset,
          keptDescription: first.description,
          droppedDataset: dataset,
          droppedDescription: e.description,
        });
        // The lower-priority source's fact set is dropped WHOLE.
        continue;
      } else if (first !== undefined) {
        // A3 FIX: a same-source key collision is NOT a duplicate. Both records
        // are published under distinct identities and the collision is reported
        // for curation rather than one record being silently discarded.
        sameSourceCollisions.push({
          conceptKey, dataset,
          keptSourceRecordId: first.sourceRecordId,
          keptDescription: first.description,
          disambiguatedSourceRecordId: String(e.fdcId),
          disambiguatedDescription: e.description,
        });
        // Fall THROUGH to normal publication under the disambiguated identity.
        conceptKey = disambiguateSameSource(conceptKey, String(e.fdcId));
        productId = genericProductId(conceptKey);
        assertNoCollision(productId, conceptKey);
      }
    }
    seenConcepts.add(productId);
    conceptOrigin.set(productId, { dataset, description: e.description, sourceRecordId: String(e.fdcId) });
    const per100g: Seed['per100g'] = {};
    for (const [k, v] of Object.entries(map)) {
      if (v !== undefined) per100g[k] = { nutrientId: v.nutrientId, amount: v.amount, unit: v.unit };
    }

    seeds.push({
      productId,
      conceptKey,
      displayName: consumerDisplayName(e.description),
      sourceDescription: e.description,
      aliases: aliasesFor(e.description),
      preparationState: prep.state,
      preparationRule: prep.rule,
      category: e.category,
      categoryEligibility: eligibility,
      recommendable: eligibleForRecommendation(eligibility),
      per100g,
      externalIdentity: {
        provider: 'usda_fdc',
        dataset,
        sourceRecordId: String(e.fdcId),
        release: e.publicationDate,
        archiveSha256: archiveHashes[dataset]!,
      },
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
 * PUBLICATION.
 *
 * Every defensible consumer-relevant food is published. There is no numeric
 * target and no stratified sampling: identity de-duplication and category
 * policy already decide what belongs, and an artificial cap previously
 * truncated the catalog alphabetically and hid whole food groups.
 */
const overlapT0 = performance.now();
const overlap = assessCrossSource(seeds);
const overlapMs = Math.round(performance.now() - overlapT0);

/**
 * Collapse only DEFINITE same concepts, by source priority. Values are never
 * averaged and no field is filled across sources: the losing record's fact set
 * is dropped whole, and its provenance is retained on the pair report.
 */
const droppedByPriority = new Set<string>();
for (const pair of overlap.pairs) {
  if (pair.verdict !== 'definite_same') continue;
  const winner = preferredSource('Foundation', 'SR Legacy');
  const loserId = winner === 'Foundation' ? pair.sr.sourceRecordId : pair.foundation.sourceRecordId;
  droppedByPriority.add(loserId);
}
const deduped = seeds.filter((s2) => !droppedByPriority.has(s2.externalIdentity.sourceRecordId));

const curated = [...deduped].sort(
  (a, b) => a.displayName.localeCompare(b.displayName) || a.productId.localeCompare(b.productId),
);

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

/**
 * THE CANONICAL MACHINE REPORT — single source of truth.
 *
 * Documentation and closure reporting derive their metrics from this file.
 * Metric names are explicit: a mapping ROW is not a canonical NUTRIENT, and
 * conflating them was how the reported mapping count drifted.
 */
/**
 * CROSS-SOURCE OVERLAP.
 *
 * BLOCKED, not all-pairs: comparing every Foundation record against every SR
 * record would be ~395 x 7,793 comparisons and would grow quadratically with
 * the catalog. Records can only be the same concept if they share preparation
 * AND a leading significant term, so blocking on that pair is safe — it can
 * never merge across a block, and identity accuracy is unchanged.
 */
interface OverlapPair {
  readonly verdict: string; readonly reason: string;
  readonly foundation: { sourceRecordId: string; description: string };
  readonly sr: { sourceRecordId: string; description: string };
  readonly preparation: string; readonly category: string | null;
  readonly foundationConceptKey: string; readonly srConceptKey: string;
}

function assessCrossSource(all: readonly Seed[]): {
  definiteSame: number; possibleDuplicate: number; distinctPairsCompared: number;
  pairs: OverlapPair[];
} {
  const blocks = new Map<string, Seed[]>();
  for (const s of all) {
    const lead = s.conceptKey.split('|')[0]!.split(' ')[0] ?? '';
    const key = `${s.preparationState}#${lead}`;
    blocks.set(key, [...(blocks.get(key) ?? []), s]);
  }

  const pairs: OverlapPair[] = [];
  let definiteSame = 0, possibleDuplicate = 0, compared = 0;

  for (const group of blocks.values()) {
    const foundation = group.filter((g) => g.externalIdentity.dataset === 'Foundation');
    const sr = group.filter((g) => g.externalIdentity.dataset === 'SR Legacy');
    for (const f of foundation) {
      for (const s2 of sr) {
        compared++;
        const verdict = assessOverlap(
          { conceptKey: f.conceptKey, category: f.category, preparation: f.preparationState as never },
          { conceptKey: s2.conceptKey, category: s2.category, preparation: s2.preparationState as never },
        );
        if (verdict.verdict === 'distinct') continue;
        if (verdict.verdict === 'definite_same') definiteSame++; else possibleDuplicate++;
        pairs.push({
          verdict: verdict.verdict, reason: verdict.reason,
          foundation: { sourceRecordId: f.externalIdentity.sourceRecordId, description: f.sourceDescription },
          sr: { sourceRecordId: s2.externalIdentity.sourceRecordId, description: s2.sourceDescription },
          preparation: f.preparationState, category: f.category,
          foundationConceptKey: f.conceptKey, srConceptKey: s2.conceptKey,
        });
      }
    }
  }
  pairs.sort((a, b) => a.foundation.sourceRecordId.localeCompare(b.foundation.sourceRecordId)
    || a.sr.sourceRecordId.localeCompare(b.sr.sourceRecordId));
  return { definiteSame, possibleDuplicate, distinctPairsCompared: compared, pairs };
}

const publishedPreparationCounts = (): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const s2 of curated) out[s2.preparationState] = (out[s2.preparationState] ?? 0) + 1;
  return out;
};

const report = {
  adapterVersion: 'usda-fdc-adapter@1.0.0',
  classifierVersion: PREPARATION_CLASSIFIER_VERSION,
  identityVersion: GENERIC_IDENTITY_VERSION,
  catalogPolicyVersion: CATALOG_POLICY_VERSION,
  aliasPolicyVersion: ALIAS_POLICY_VERSION,
  archives: FILES.map(([d, p]) => ({ dataset: d, path: p, sha256: archiveHashes[d] })),
  missingArchives: MISSING_ARCHIVES,
  sourceMappingRows: USDA_NUTRIENT_MAP.length,
  canonicalNutrientsMapped: new Set(USDA_NUTRIENT_MAP.map((m) => m.canonical)).size,
  stats: {
    recordsRead: stats.recordsRead,
    nullRecords: stats.nullRecords,
    malformed: stats.malformed,
    rejectedMissingCore: stats.missingCore,
    rejectedUnresolvedPreparation: stats.unresolvedPrep,
    rejectedExcludedCategory: stats.excludedCategory,
    duplicateConceptsCollapsed: stats.duplicateConcept,
    // SCOPED NAMES. An unscoped `preparationCounts` left the denominator
    // ambiguous and was mis-cited in a closure report; both populations are now
    // reported explicitly and can never be confused.
    sourcePreparationCounts: stats.sourcePreparationCounts,
    publishedPreparationCounts: publishedPreparationCounts(),
    categoryCounts: stats.categoryCounts,
    recommendableCount: curated.filter((s2) => s2.recommendable).length,
    searchableNotRecommendedCount: curated.filter((s2) => !s2.recommendable).length,
    crossSourceDuplicatesCollapsed: droppedByPriority.size,
    duplicateConceptsCollapsedCrossSource: stats.crossSourceConvergence,
    duplicateConceptsCollapsedSameSource: stats.duplicateConcept - stats.crossSourceConvergence,
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
  crossSource: {
    definiteSame: overlap.definiteSame,
    possibleDuplicate: overlap.possibleDuplicate,
    pairsCompared: overlap.distinctPairsCompared,
    // NOTE: overlapMs is deliberately NOT stored here. A wall-clock measurement
    // inside a deterministic artifact makes byte-identical re-import
    // impossible. Timings are printed for development instead.
    // Steward queue: possible duplicates are NEVER auto-merged.
    pairs: overlap.pairs.slice(0, 200),
    /**
     * Identical-concept convergence: the same food from two sources resolving
     * to ONE MACROS.AI identity. This is the proof that identity is
     * source-independent, and it happens at the concept key — before overlap
     * assessment ever runs, which is why definiteSame there can be 0.
     */
    conceptConvergence: {
      count: stats.crossSourceConvergence,
      examples: convergenceExamples.slice(0, 25),
    },
    /** A4: audited over EVERY convergence. unexpectedPriority must be empty. */
    sourcePriorityAudit: {
      convergencesAudited: stats.crossSourceConvergence,
      preferredSourceKept: sourcePriorityAudit.foundationKept,
      unexpectedPriority: sourcePriorityAudit.unexpectedPriority,
    },
    /** A3: every same-source collapse, in full, for audit. */
    sameSourceCollisions,
  },
};

writeFileSync('data/usda-seed.json', JSON.stringify(curated, null, 1));
writeFileSync('data/usda-import-report.json', JSON.stringify(report, null, 1));

console.log('=== REAL USDA IMPORT ===');
console.log('records read      ', stats.recordsRead, '| null', stats.nullRecords, '| malformed', stats.malformed);
console.log('rejected: missing core', stats.missingCore, '| unresolved prep', stats.unresolvedPrep);
console.log('accepted candidates', stats.accepted, '| PUBLISHED SEED', curated.length);
console.log('by dataset:', JSON.stringify(stats.byDataset));
if (MISSING_ARCHIVES.length > 0) console.log('MISSING ARCHIVES:', MISSING_ARCHIVES.join(', '));
console.log('source preparation:', JSON.stringify(stats.sourcePreparationCounts));
console.log('published preparation:', JSON.stringify(publishedPreparationCounts()));
console.log('overlap assessment took', overlapMs, 'ms (operational timing, not in the artifact)');
console.log('cross-source: definiteSame', overlap.definiteSame, '| possibleDuplicate', overlap.possibleDuplicate, '| pairs compared', overlap.distinctPairsCompared, 'in', overlapMs, 'ms');
console.log('source-priority audit: preferredKept', sourcePriorityAudit.foundationKept, '| unexpected', sourcePriorityAudit.unexpectedPriority.length);
console.log('same-source key collisions (both published):', sameSourceCollisions.length);
console.log('CROSS-SOURCE CONCEPT CONVERGENCE:', stats.crossSourceConvergence, '| same-source dupes', stats.duplicateConcept - stats.crossSourceConvergence);
console.log('collapsed by source priority', droppedByPriority.size);
console.log('excluded by category', stats.excludedCategory, '| duplicate concepts collapsed', stats.duplicateConcept);
console.log('recommendable', curated.filter((s2) => s2.recommendable).length, 'of', curated.length);
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
