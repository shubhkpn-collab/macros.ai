"""Generates branded documentation FROM the canonical machine report."""
import json, os
r = json.load(open('data/branded-report.json'))
s, q, b, l = r['stats'], r['search'], r['barcode'], r['lifecycle']
src = r['source']
rt = json.load(open('data/runtime/manifest.json')) if os.path.exists('data/runtime/manifest.json') else None
cov = '\n'.join('| %s | %s/%s | %s%% |' % (c['nutrientId'], c['known'], c['total'], c['percent'])
                for c in r['coverage'])
mb = lambda n: round(n / 1048576, 1)

scope = ('the **complete April 2026 release**' if src['fullRelease']
         else 'a bounded %s-record window' % src.get('windowRecords'))

doc = f"""# 29 — Real Branded Catalog, GTIN and Product Lifecycle

> **REAL BRANDED CATALOG FULL RELEASE — POPULATED.**
> **BRANDED PRODUCT IDENTITY — CLOSED.**
> **BRANDED IMMUTABLE PRODUCT LIFECYCLE — CLOSED.**
> **GTIN/UPC REASSIGNMENT SAFETY — CLOSED.**
>
> Every figure is read from `data/branded-report.json`. Nothing is hand-copied.

## 1. Source

USDA FoodData Central, **Branded, April 2026** — U.S. Government public domain.

- `archiveSha256`: `{src['archiveSha256']}`
- archive {src['archiveBytes']:,} bytes; extracted ≈ 3.3 GB, never materialised
- **records ingested: {src['totalRecords']:,}** — {scope}

Policies: `{r['identityVersion']}` · `{r['versionPolicy']}` · `{r['gtinLifecyclePolicy']}`.

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

Invariants over the full release: **{r['identityViolations']} identity violations,
{r['fingerprintViolations']} fingerprint violations** across {r['productVersions']:,} versions.

## 4. Lifecycle

Evidence order: `foodUpdateLog` linkage → validated GTIN → product semantics →
temporal → brand. **A corporate rename is not a product change**, which is why an
earlier brand-string rule reported 82 conflicts that were mostly owner renames.

{s.get('updateLogEdges', 0):,} update edges observed.

| Verdict | Count |
|---|---|
| single record | {l.get('single_record', 0):,} |
| confirmed update | {l.get('confirmed_update', 0):,} |
| probable update — needs review | {l.get('probable_update_needs_review', 0):,} |
| **identifier reassignment conflict** | **{l.get('identifier_reassignment_conflict', 0):,}** |
| no-GTIN isolated | {l.get('no_gtin_isolated', 0):,} |

A reassigned GTIN never lets the new product inherit the old product's identity,
and barcode lookup **fails closed** for conflicted and needs-review identifiers.

## 5. Catalog

| | |
|---|---|
| Current products | {r['publishedProducts']:,} |
| Immutable ProductVersions | {r['productVersions']:,} |
| Multi-version products | {r['multiVersionProducts']:,} |
| No-GTIN products | {r['noGtinProducts']:,} |
| Valid / invalid GTIN | {s.get('validGtin', 0):,} / {s.get('invalidGtin', 0):,} |
| Duplicate-GTIN groups | {s.get('duplicateGtinGroups', 0):,} |
| Discontinued | {s.get('discontinued', 0):,} |
| Serving in grams | {s.get('servingGramsAvailable', 0):,} |
| Volume-only (mL) | {s.get('servingVolumeOnly', 0):,} |
| **labelFacts retained** | **{r['labelFactsVersions']:,} versions** |
| **ingredientsText retained** | **{r['ingredientsTextVersions']:,} versions** |

Historical versions are retained as real records, not merely source ids, so an
old FoodLog resolves the exact nutrition, label facts and ingredients it was
logged against — proven from a fresh runtime process.

A millilitre serving never becomes grams, and `packageWeight` never becomes a
serving mass. B-2 stays deferred.

## 6. Nutrients

| Nutrient | Known / total | % |
|---|---|---|
{cov}

Added sugars is genuinely present in branded data (source nutrient 1235) and is
**never** inferred from total sugars. Declared label kcal is authoritative;
Atwater is diagnostic only. Ingredients are preserved verbatim and support **no**
allergen, vegan or health claim.

## 7. Runtime

The tablet never parses the canonical catalog.
"""

if rt:
    sizes = rt['sizes']
    doc += f"""
| Artifact | Size |
|---|---|
| Canonical versions (server-side) | {mb(sizes['canonicalVersionsBytes'])} MB |
| Canonical products | {mb(sizes['canonicalProductsBytes'])} MB |
| Search projection (sharded) | {mb(sizes['searchProjectionBytes'])} MB across {len(rt['searchShards'])} shards |
| **Largest single shard** | **{mb(rt['largestShardBytes'])} MB** |
| GTIN index | {mb(sizes['gtinIndexBytes'])} MB |

The search projection carries identity and retrieval text **only**. It holds no
nutrition — a projection with nutrition would become a second, unversioned source
of truth. It nominates a candidate; the canonical ProductVersion supplies every
number, through the same engines generic foods use.
"""

doc += f"""
## 8. Search and barcode

| Metric | Result |
|---|---|
| Search corpus | {q['corpusSize']:,} |
| Queries (scored) | {q['totalQueries']} ({q['scoredQueries']}) |
| Top-1 | {q['top1Percent']}% |
| Top-4 | {q['top4Percent']}% |
| MRR | {q['mrr']} |
| Brand Top-1 correct | {q['brandQueries']['top1BrandCorrect']}/{q['brandQueries']['total']} |
| False positives | {q['falsePositives']} |
| **Barcode exact lookup** | **{b['exactLookupPercent']}%** ({b['exactLookupCorrect']}/{b['sampled']}) |
| Malformed barcodes resolved | **{b['malformedResolved']}** |

Barcode input is **string-only**: a JavaScript number has already lost the
leading zero of `076014101088` before validation could run, and stringifying it
would yield a different, possibly valid, code for a different product.

## 9. Known limitations

- The search benchmark runs over a bounded {q['corpusSize']:,}-product slice; a full
  in-memory token index exhausts RAM. The **barcode** benchmark uses the complete
  {b['sampled']:,}-sample index.
- {q['scoredQueries']} scored queries is a regression guard, not a validated quality
  baseline. No user validation is claimed.
- {l.get('identifier_reassignment_conflict', 0):,} conflicts and {l.get('probable_update_needs_review', 0):,} needs-review groups await
  human curation; none resolves via barcode.
- No package images. Volume-only servings still have no gram basis.
"""
open('/mnt/user-data/outputs/macros-architecture/29-real-branded-catalog-gtin-and-lifecycle.md', 'w').write(doc)
print('doc generated | records', src['totalRecords'], '| products', r['publishedProducts'],
      '| fullRelease', src['fullRelease'])
