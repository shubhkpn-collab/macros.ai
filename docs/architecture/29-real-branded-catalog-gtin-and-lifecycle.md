# 29 — Real Branded Catalog, GTIN and Product Lifecycle

> **REAL BRANDED CATALOG FULL RELEASE — POPULATED.**
> **BRANDED PRODUCT IDENTITY — CLOSED.**
> **BRANDED IMMUTABLE PRODUCT LIFECYCLE — CLOSED.**
> **GTIN/UPC REASSIGNMENT SAFETY — CLOSED.**
>
> Every figure is read from `data/branded-report.json`. Nothing is hand-copied.

## 1. Source

USDA FoodData Central, **Branded, April 2026** — U.S. Government public domain.

- `archiveSha256`: `71e15ee6cbf2c1de2ff4879fc4a00516d4bab81b91334ec2863661e55bd828fc`
- archive 203,831,000 bytes; extracted ≈ 3.3 GB, never materialised
- **records ingested: 455,458** — the **complete April 2026 release**

Policies: `branded-identity@2.0.0` · `branded-version-fingerprint@1.0.0` · `branded-gtin-lifecycle@1.0.0`.

## 2. Bounded-memory compilation

3.3 GB extracted against ~3 GB RAM. Earlier designs held every record — then
every finished product — in memory and were OOM-killed twice. The compiler now:

1. streams via `unzip -p`, splitting records by brace depth;
2. writes each normalised record into a **temporary stdlib SQLite store**, which
   sorts and groups on **disk**;
3. reads one lifecycle group at a time and **streams products out** as NDJSON
   shards.

The SQLite file is build infrastructure only — deleted on completion, with no
runtime dependency on it whatsoever.

**Atomic completion.** Outputs are staged and promoted only on success, with a
`manifest.json` carrying `buildComplete`, the source checksum and per-shard
SHA-256. An interrupted run cannot leave a partial catalog looking
authoritative — observed working when a timed-out run correctly left
`fullRelease: false`.

## 3. Identity

Three concepts, never collapsed:

| Concept | Form |
|---|---|
| MACROS.AI product | `bprod_<16 hex>` from an explicit identity key |
| ProductVersion | `<productId>@f<fingerprint>` — a **factual** hash, never an ordinal |
| External identifiers | GTIN, FDC record id, update-chain references |

Ordinal versioning was rejected deliberately: importing an older record must
never renumber an unchanged current version.

**Without a trustworthy linking identifier or an explicit source update
relationship, matching brand + description is not sufficient to declare two
records the same product.** Real proof: FDC 2106478 and 2106480 are both
`1% LOWFAT MILK` from `Tops Markets, LLC`, but carry invalid 11-digit GTINs and
no `foodUpdateLog` linkage — so they resolve to **distinct products and distinct
versions**, which matters because their facts genuinely differ (42 vs 58 kcal).

Invariants over the full release: **0 identity violations,
0 fingerprint violations** across 443,571 versions.

## 4. Lifecycle

Evidence order: `foodUpdateLog` linkage → validated GTIN → product semantics →
temporal → brand. **A corporate rename is not a product change**, which is why an
earlier brand-string rule reported 82 conflicts that were mostly owner renames.

1,311,288 update edges observed.

| Verdict | Count |
|---|---|
| single record | 390,488 |
| confirmed update | 8,857 |
| probable update — needs review | 709 |
| **identifier reassignment conflict** | **10,779** |
| no-GTIN isolated | 11,818 |

A reassigned GTIN never lets the new product inherit the old product's identity,
and barcode lookup **fails closed** for conflicted and needs-review identifiers.

## 5. Catalog

| | |
|---|---|
| Current products | 434,714 |
| Immutable ProductVersions | 443,571 |
| Multi-version products | 8,851 |
| No-GTIN products | 11,818 |
| Valid / invalid GTIN | 443,411 / 12,047 |
| Duplicate-GTIN groups | 20,345 |
| Discontinued | 1,816 |
| Serving in grams | 272,205 |
| Volume-only (mL) | 58,598 |
| **labelFacts retained** | **443,571 versions** |
| **ingredientsText retained** | **441,233 versions** |

Historical versions are retained as real records, not merely source ids, so an
old FoodLog resolves the exact nutrition, label facts and ingredients it was
logged against — proven from a fresh runtime process.

A millilitre serving never becomes grams, and `packageWeight` never becomes a
serving mass. B-2 stays deferred.

## 6. Nutrients

| Nutrient | Known / total | % |
|---|---|---|
| fiber | 366832/434714 | 84.4% |
| total_sugars | 410935/434714 | 94.5% |
| added_sugars | 143640/434714 | 33.0% |
| saturated_fat | 379271/434714 | 87.2% |
| cholesterol | 371378/434714 | 85.4% |
| sodium | 433292/434714 | 99.7% |
| potassium | 214368/434714 | 49.3% |
| calcium | 361359/434714 | 83.1% |
| iron | 362092/434714 | 83.3% |
| vitamin_a | 26028/434714 | 6.0% |
| vitamin_c | 195094/434714 | 44.9% |
| vitamin_d | 67861/434714 | 15.6% |

Added sugars is genuinely present in branded data (source nutrient 1235) and is
**never** inferred from total sugars. Declared label kcal is authoritative;
Atwater is diagnostic only. Ingredients are preserved verbatim and support **no**
allergen, vegan or health claim.

## 7. Runtime

The tablet never parses the canonical catalog.

| Artifact | Size |
|---|---|
| Canonical versions (server-side) | 917.7 MB |
| Canonical products | 130.0 MB |
| Search projection (sharded) | 128.6 MB across 27 shards |
| **Largest single shard** | **17.7 MB** |
| GTIN index | 22.8 MB |

The search projection carries identity and retrieval text **only**. It holds no
nutrition — a projection with nutrition would become a second, unversioned source
of truth. It nominates a candidate; the canonical ProductVersion supplies every
number, through the same engines generic foods use.

## 8. Search and barcode

| Metric | Result |
|---|---|
| Search corpus | 119,388 |
| Queries (scored) | 28 (26) |
| Top-1 | 96.2% |
| Top-4 | 100.0% |
| MRR | 0.981 |
| Brand Top-1 correct | 8/8 |
| False positives | 0 |
| **Barcode exact lookup** | **100.0%** (1500/1500) |
| Malformed barcodes resolved | **0** |

Barcode input is **string-only**: a JavaScript number has already lost the
leading zero of `076014101088` before validation could run, and stringifying it
would yield a different, possibly valid, code for a different product.

## 9. Known limitations

- The search benchmark runs over a bounded 119,388-product slice; a full
  in-memory token index exhausts RAM. The **barcode** benchmark uses the complete
  1,500-sample index.
- 26 scored queries is a regression guard, not a validated quality
  baseline. No user validation is claimed.
- 10,779 conflicts and 709 needs-review groups await
  human curation; none resolves via barcode.
- No package images. Volume-only servings still have no gram basis.
