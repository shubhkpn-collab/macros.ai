# 05 — Food Data Architecture

> **PARTIALLY SUPERSEDED — owner rulings A–H, 2026-08-10.** Where this document conflicts with `DECISION-LOCK.md`, the Decision Lock governs. See `CHANGE-REPORT.md`.


The catalog is the product's hardest asset. Treat it as a **data pipeline with a review queue**, not a database import.

## 1. Source tiers and the license firewall

Every ingested record carries `source_id`, and every source carries `license_class` and `redistribution_terms`.

| Tier | Sources | Trust | Notes |
|---|---|---|---|
| T0 | USDA Foundation Foods, SR Legacy | Highest | Generic/fresh foods; lab-analyzed |
| T1 | GS1-syndicated branded feeds; manufacturer-supplied | High | Label-declared; staleness is the risk |
| T2 | USDA Branded Foods | Medium-high | Large, uneven freshness |
| T3 | Retailer product pages / receipts | Medium | Only reliable source for some private label; ToS-constrained |
| T4 | Crowd-sourced (e.g. Open Food Facts) | Low-medium | **NOT INGESTED.** Blocked pending licensing review (ruling C) |
| T5 | User submissions inside a household | Low | Household-private by default; promoted only after review |

**Licensing metadata, not a license-firewall subsystem (ruling C).** `source_id`, `license_class`, provenance, `verification_status` and `last_verified_at` propagate to `product_versions` so further sources can be added safely later. We do **not** build a firewall subsystem in MVP — the metadata is the mechanism. ODbL-licensed and commercial datasets are not ingested until licensing, caching and redistribution terms are reviewed.

## 2. Pipeline

```
 ADAPTER          NORMALIZE         MATCH/DEDUPE        VALIDATE         PROMOTE        PUBLISH
   │                 │                  │                  │               │              │
 fetch            units →g/ml      blocking on GTIN     Atwater check   new version    search index
 checksum         nutrient map     brand canon. +       mass balance    confidence     image CDN
 raw record       serving parse    trigram + name-      outlier vs      verification   cache bust
 (immutable)      brand extract    embedding rerank     category norms  status
   │                 │                  │                  │               │
   └── food.source_records ── food.staging_products ──┬──► auto-accept ────┘
                                                       └──► admin review queue
```

**Adapter.** Fetch → store the raw payload immutably in `food.source_records` with a content checksum. Re-ingestion of an unchanged record is a no-op. Raw is never discarded; every downstream decision is replayable.

**Normalize** (`packages/food-normalize`, pure): units to grams/millilitres; vendor nutrient codes to our `nutrition.nutrients`; serving strings ("2/3 cup (55g)") parsed to `{label, grams}`; brand strings canonicalized ("KIRKLAND SIGNATURE" → brand id); density attached for liquids.

**Match/dedupe** (`packages/food-match`): candidate generation by GTIN, then by `(normalized_brand, trigram(name), net_weight)` blocking. Candidates scored by string similarity + nutrient-vector distance + name-embedding cosine. Three outcomes: auto-merge (high confidence), auto-create (clearly novel), **human review** (the ambiguous middle). The review queue is a first-class product surface in `apps/admin`, not an afterthought.

**Validate** — deterministic rules, all of which have caught real errors in public datasets:
- Atwater consistency: `|kcal − (4·protein + 4·carb + 9·fat + 7·alcohol + 2·fiber_adj)| ≤ 10%` (or ≤ 15 kcal absolute).
- Mass balance: `protein + carb + fat + fiber + ash + water ≤ 100 g` per 100 g.
- Category envelopes: per-category min/max per nutrient (a 900 kcal/100 g vegetable is a parse error).
- Sodium/sugar bounds; non-negative; unit sanity.
- Serving sanity: default serving between 1 g and 2000 g.
Failures route to review; they do not silently enter the catalog.

**Promote.** Creates an immutable `product_version` with `confidence`, `verification_status` ∈ {unverified, auto_validated, steward_verified, manufacturer_verified}, `last_verified_at`, and provenance back to the source record.

**Publish.** Refresh search artifacts (FTS vectors, trigram indexes, name embeddings), warm image CDN, bust caches.

All stages run in `apps/worker` as idempotent `pg-boss` jobs keyed by source-record checksum.

## 3. Freshness and lifecycle

| verification_status | Re-verify SLA |
|---|---|
| manufacturer_verified | 365 d |
| steward_verified | 180 d |
| auto_validated | 90 d |
| unverified | not served in ranked results without a UI marker |

Products whose availability hasn't been observed in 12 months are marked `discontinued` — hidden from search, still resolvable from history. **Nothing is ever deleted**, because logs reference versions.

## 4. Search — the "Tofu" problem

A bare voice query against ~1.5M products returns garbage unless it is heavily personalized. Ranking pipeline:

1. **Candidate generation** (Postgres): FTS on name/brand + `pg_trgm` fuzzy + optional GTIN exact + name-embedding ANN (pgvector, names only).
2. **Rerank** by a deterministic score:
   - household purchase/log recency and frequency (dominant signal — people eat the same 40 things),
   - regional availability match to the household's retailers,
   - brand match confidence,
   - verification status and confidence,
   - global popularity as tiebreak.
3. **Diversify** to 4 options (A/B/C/D), each a distinct brand or preparation state — never four near-duplicates of the same SKU.
4. **Return** with images; missing images are a ranking penalty because the tablet flow is visual.

Target: correct item in the top 4 for ≥ 90% of repeat foods, ≥ 70% cold. Measured on a labeled utterance→SKU set in `data/golden`.

**Pantry model.** A per-household `pantry` derived from log history (and later, receipt or barcode input) is what makes "Tofu" → "Kirkland Organic Firm Tofu" work. This is a small feature with an outsized effect on perceived intelligence; it belongs in MVP.

## 5. Private-label bootstrap program

For the named retailers, plan a curated seed of the top ~2,000 SKUs by household frequency: steward-entered from package labels, `manufacturer_verified`-adjacent status. Images come from owned photography, manufacturer-authorized assets, retailer-authorized assets, or a properly licensed image provider — **never unauthorized retailer or manufacturer imagery** (ruling D). We do not assume every product must be photographed in-house. This is a staffed workstream running in parallel with engineering from Milestone 2 onward. **Do not plan around it appearing automatically** — per the brief, and because it won't.

## 6. Fresh/unpackaged foods

"Chicken breast", "banana", "olive oil" resolve to T0 generic items with `preparation_state` variants and yield factors. These carry most everyday logging volume and have the best data quality — they should be the seed catalog for the first demo, with private label layered on top.
