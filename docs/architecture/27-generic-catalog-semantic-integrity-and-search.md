# 27 — Generic Catalog Semantic Integrity and Search

> **GENERIC CATALOG SEMANTIC INTEGRITY — CLOSED.**
> **REAL GENERIC CATALOG DEPTH — ESTABLISHED (bounded by supplied archives).**
> **REAL GENERIC SEARCH QUALITY BASELINE — ESTABLISHED.**
>
> Every metric below is read from `data/usda-import-report.json`, the single
> machine-generated source of truth. Nothing is hand-copied.

## 1. Archives actually available

Ingested: Foundation (`27d1fe3fd89edfbe…`), SR Legacy (`70d4235ae3a2bdf4…`)

**Missing this session: none**

All expected archives were present for this run, so catalog depth reflects
the full supplied source population.

## 2. The preparation bug

USDA writes `Apples, raw, without skin, cooked, boiled`. The old classifier
tested `raw` **before** cooked terms, so a leading word describing the INPUT
overrode the trailing FINAL state — two records published as `raw` carrying
cooked nutrition.

`preparation-classifier@2.3.0` now resolves by **final state**: when both appear the
LAST preparation term wins. Genuine alternatives ("raw or cooked") stay
`unresolved` and route to curation rather than being guessed.

## 3. Taxonomy

The contract already had four states; no parallel field was invented.

| State | Meaning |
|---|---|
| raw | weighed uncooked |
| cooked | weighed after cooking |
| as_sold | weighed exactly as purchased — cheese, yogurt, hummus, dried egg, fresh produce |
| unresolved | never published |

**Cheese is not raw milk; bread is not cooked flour.** Forcing ready-to-eat
foods into raw/cooked merely to permit publication would state something false
about what is on the scale.

Published distribution: `{"cooked":2194,"raw":1480,"as_sold":3203}`

Source-scan distribution (larger population): `{"as_sold":3446,"raw":1548,"cooked":2207,"unresolved":955}`

These are **different populations**. An unscoped `preparationCounts` left the
denominator ambiguous and was mis-cited in a prior closure report; both are now
named explicitly and asserted against the catalog file.

## 4. Identity

| Concept | Form |
|---|---|
| MACROS.AI food identity | `food_<16 hex>`, content-addressed from the food concept |
| ProductVersion identity | unchanged |
| External source identity | `{provider, dataset, sourceRecordId, release, archiveSha256}` |

`usda-fdc-173928` was a source id wearing our namespace — USDA numbering was
effectively our identity, and a second source could never attach to the same
food. Preparation is part of the concept key, so raw and cooked chicken breast
can never share an id.

## 5. Overlap and source priority

Deterministic evidence only — normalized description, preparation, category.
Verdicts: `definite_same` / `possible_duplicate` / `distinct`. **No embeddings,
no LLM, no fuzzy merge**: a wrong merge silently attaches the wrong nutrition
to a logged food. Foundation outranks SR Legacy where concepts genuinely match;
values are never averaged.

## 6. Category policy (`catalog-policy@1.0.0`)

Three separate questions: what we ingest, what enters the consumer catalog,
and what may be recommended. Baby Foods and Infant Formula remain ingestable
but are **excluded from the adult catalog** — their macros can fit a gap
perfectly and still be an absurd suggestion. Spices, oils and alcohol are
searchable but not recommended.

Recommendable: **6630 of 6877**.

## 7. Import results

| | |
|---|---|
| Records read | 8188 |
| Null / malformed | 32 / 0 |
| Rejected — unresolved preparation | 955 |
| Rejected — missing core nutrients | 49 |
| Rejected — excluded category | 183 |
| Duplicate concepts collapsed | 92 |
| **Published catalog** | **6877** |

Source mapping rows: **35**. Canonical nutrients mapped:
**32**. These are different metrics — the ambiguous
`mappedNutrients` is gone, which is what allowed the count to drift.

## 8. Search (`consumer-aliases@1.0.0`)

| Metric | Result |
|---|---|
| Corpus | 6877 |
| Queries (scored) | 164 (160) |
| Top-1 | **98.8%** |
| Top-4 | **99.4%** |
| MRR | **0.991** |
| Unambiguous Top-1 | 23/23 (100%) |
| Ambiguous Top-4 | 136/137 (99.3%) |
| Zero-result correctness | 4/4 |
| False positives | **0** |
| Misses | green beans |

### Preparation-sensitive search

Wrong preparation is a **high-severity** error — cooked beef is roughly a
third denser in energy than raw, so a mix-up silently corrupts a log.

| Metric | Result |
|---|---|
| Preparation-sensitive queries | 30 |
| Correct preparation Top-1 | 30/30 (100%) |
| Correct preparation Top-4 | 30/30 (100%) |
| **Wrong preparation outranking correct** | **0** |

This metric previously read `0/0` — preparation correctness was declared but
never actually measured.

Ambiguous queries are scored on **Top-4, not Top-1**: "rice" legitimately
returns several foods and the A/B/C/D confirmation resolves it. A wrong food is
worse than asking, so ambiguity is preserved rather than optimized away, and no
search result auto-logs. No embeddings and no typo correction were added — the
benchmark shows no failure class lexical matching cannot handle.

Common-food coverage: **48/48** concepts available.

## 9. Nutrient coverage (published catalog)

| Nutrient | Known / total | % |
|---|---|---|
| fiber | 6295/6877 | 91.5% |
| total_sugars | 5073/6877 | 73.8% |
| added_sugars | 0/6877 | 0% |
| saturated_fat | 6402/6877 | 93.1% |
| cholesterol | 6355/6877 | 92.4% |
| sodium | 6812/6877 | 99.1% |
| potassium | 6658/6877 | 96.8% |
| calcium | 6801/6877 | 98.9% |
| iron | 6803/6877 | 98.9% |
| magnesium | 6575/6877 | 95.6% |
| phosphorus | 6607/6877 | 96.1% |
| zinc | 6564/6877 | 95.4% |
| selenium | 5963/6877 | 86.7% |
| copper | 6452/6877 | 93.8% |
| manganese | 5918/6877 | 86.1% |
| vitamin_a | 5946/6877 | 86.5% |
| vitamin_c | 6324/6877 | 92% |
| vitamin_d | 4441/6877 | 64.6% |
| vitamin_e | 4693/6877 | 68.2% |
| vitamin_k | 4239/6877 | 61.6% |
| thiamin | 6437/6877 | 93.6% |
| riboflavin | 6421/6877 | 93.4% |
| niacin | 6440/6877 | 93.6% |
| pantothenic_acid | 5558/6877 | 80.8% |
| vitamin_b6 | 6354/6877 | 92.4% |
| folate | 5943/6877 | 86.4% |
| vitamin_b12 | 6113/6877 | 88.9% |
| choline | 3849/6877 | 56% |

**Added sugars remains 0%** — genuinely absent from Foundation. A description
saying "with added sugar" never produces a numeric added-sugar amount.

## 10. Known limitations

- Depth reflects all supplied archives (Foundation + SR Legacy).
- 1 search misses are catalog gaps, not ranking failures.
- Cross-source identity is validated: 92 convergences, with
  source priority upheld 92/92.
- Search metrics come from a human-authored regression corpus, not real users.
