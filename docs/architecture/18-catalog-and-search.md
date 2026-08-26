# 18 — Food Catalog + Search Data

> **CATALOG/SEARCH ENGINEERING — CLOSED.**
> **REAL CATALOG POPULATION — PENDING SOURCE DATA.**
>
> No USDA FoodData Central file exists in this environment and there is no
> network egress. **0 real source records ingested. 0 real canonical foods
> published.** Every stage of the pipeline is implemented and tested against
> synthetic fixtures that are tagged synthetic end to end.

## 1. Sources and licence

| Source | Status |
|---|---|
| USDA FDC — Foundation Foods, SR Legacy | Registered. **Public domain, CC0 1.0**, owner-verified 2026-08-17 from the official FDC documentation. No source file present. |
| Synthetic fixtures | Test only. Never publishable as source-backed nutrition. |
| USDA Branded | Out of scope — brand identity, GTIN, serving labels and manufacturer updates are a distinct problem. |
| Open Food Facts / ODbL | **Not ingested.** Blocked pending licensing and legal review. |
| Retailers, manufacturers, commercial databases, images | **Not ingested.** No reviewed terms. |

**The CC0 finding applies to USDA FDC only.** It is not a precedent for any other
dataset. A source may be published from only when `licenseClass !== 'unreviewed'`
**and** a `licenseVerification` record names who verified it and when —
`isPublishable()` enforces this, and the importer throws otherwise.

## 2. The USDA adapter is deliberately unimplemented

`UsdaFdcAdapterPending` throws. Writing the parser needs the actual file and
schema: the nutrient identifiers, the energy-nutrient rows (FDC publishes more
than one energy representation), and the data-type-specific layout.

**Hard-coding nutrient ids from memory would produce confident, wrong food data
attributed to USDA.** That is worse than no importer. When the file arrives:
inspect the schema, write the mapping against what was inspected, add golden
parser tests from real excerpts, then enable publication.

## 3. Pipeline

```
source file → raw source record → adapter parse/normalize → structural + nutrition
validation → curation decision → canonical ProductVersion → catalog head →
search projection
```

Each stage is separately testable. No stage performs nutrition arithmetic,
writes to a database, or reads a clock. Ids and time enter only at the CLI.

## 4. Provenance

Every published version retains its source key, source record id, release id and
source-file SHA-256, plus a `rawSourcePayloadRef` locating the exact record. The
source's own declared basis is retained verbatim in `labelFacts` — it is never
reconstructed from normalized values.

## 5. Identity

A source record id is **provenance, not our identity**. Curation assigns the
forever-stable `productId`. Adopting an external publisher's identifier as our
primary key would hand our identity model to that publisher.

Deduplication is automated only where it is safe: the same source record twice,
or an identical canonical fingerprint within a release. **Names are never merged
on similarity** — same name with different preparation, species, fat level or
formulation are different foods.

## 6. Versioning

The canonical fingerprint covers display name, preparation state and the
per-100 g facts — and deliberately **not** import time, release id, file hash,
verification status or aliases.

```
facts unchanged  → no new version (a re-import is not a food fact)
facts changed    → new ProductVersion; the head advances; V1 is never rewritten
```

A food log referencing V1 keeps meaning exactly what it meant.

## 7. Immutable facts vs mutable review metadata

`ProductSource.verificationStatus` and `lastVerifiedAt` record what was known
**at publication** — immutable facts about that moment. Current review state
lives in `CatalogReviewMetadata`, which is mutable by design, so a steward
re-reading a food neither mutates an immutable version nor manufactures a new
nutrition version.

Aliases are **search metadata** in `CatalogAliasSet`. Editing them can never
produce a new ProductVersion.

## 8. Preparation state

`raw` / `cooked` / `prepared` / `as_sold`, always explicit. An unresolved state
routes to curation — it is never published as an assumption. **No yield factors,
ever.** Raw and cooked chicken are separate products; logging one as the other is
roughly a 35% error.

## 9. Calories

Source-declared energy is carried through unchanged. Atwater is computed as a
**quality flag** and recorded when the discrepancy exceeds 25%; it never
overwrites a source value. A missing nutrient stays **absent** — zero is a claim
about the food, absence is a claim about our knowledge.

## 10. Quarantine

Every record lands in exactly one bucket with machine-readable reasons:
`accepted` / `rejected` / `needs_curation`. Rejections cover negative and
non-finite nutrients, missing energy, missing required macros, mass balance
beyond 100 g per 100 g, implausible energy, and invalid source identity. **One
malformed record never stops the batch and never publishes silently.**

## 11. Search

Deterministic and lexical: exact → alias-exact → prefix → token-prefix / token →
alias-token → brand, with a bounded recency nudge that cannot outrank a better
textual match. Punctuation and spacing are normalized; crude singularization
handles plurals; **word order does not matter**. An unmatched query token
disqualifies the food outright — partial matching is how a search silently logs
the wrong thing.

Only versions behind an **active** head are searchable. Superseded and de-listed
versions stay resolvable by id so historical logs never break.

**No LLM, no embeddings, no vector store, no external API.**

## 12. Benchmark

23 hand-authored queries in version control, covering exact names, short names,
word order, case, spacing and punctuation, preparation state, raw/cooked
ambiguity, plurals, brand, alias-only, nonsense, dangerous false matches and
de-listed foods. Deriving a benchmark from the catalog it scores would prove
nothing, so these are written as a person would type.

Measured: top-1, top-4 recall, MRR, zero-result correctness, preparation
disambiguation, false-positive rate. Every failure is printed; none is averaged
away.

**Current synthetic result: top-1 100%, top-4 100%, false positives 0%. Aliases
move top-1 from 84.2% → 100%.**

> These numbers demonstrate that the harness works — **not** that search quality
> is proven. Twenty-three queries against six synthetic foods is not evidence
> about a real catalog. Real metrics require real data.

## 13. Recent-history ranking

`listRecentProductVersionIds(userId, limit)` — one user, most recent first,
de-duplicated, bounded, no nutrition recalculation. One user's history can never
bias another's search; asserted by test.

## 14. What is not built

No catalog images, no branded ingestion, no steward UI, no food-log correction
workflow, no estimated-food entry. An unknown food returns **no result** rather
than an invented one, and no LLM fills the gap.
