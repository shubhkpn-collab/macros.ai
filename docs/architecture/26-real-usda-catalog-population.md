# 26 — Real USDA Generic Catalog Population

> **REAL USDA GENERIC CATALOG — POPULATED.**
> **REAL GENERIC SEARCH BENCHMARK — ESTABLISHED.**
>
> Licensing: FoodData Central is U.S. Government public domain (CC0). FDC only.

## 1. Archives ingested

| Dataset | Records | SHA-256 |
|---|---|---|
| Foundation Foods 2026-04-30 | 395 | `27d1fe3f…1590cc` |
| SR Legacy 2018-04 | 7,793 | `70d4235a…f500129` |

Schema was **inspected, not remembered**: `fdcId`, `description`, `dataType`,
`foodCategory.description`, `publicationDate`, and `foodNutrients[]` carrying
`nutrient.{id,number,name,unitName}` plus `amount`. 247 distinct nutrient ids
appear across both archives, with **no multi-unit conflicts** and **32 null
records**.

## 2. Mapping

34 explicit mappings, each verified against the unit the archive actually uses.

**Deliberate exclusions, recorded with reasons:**

| USDA id | Why excluded |
|---|---|
| 1062 Energy (**kJ**) | Only 1008 (kcal) is energy — taking kJ would inflate every calorie ~4.184× |
| 1104 Vitamin A (IU), 1110 Vitamin D (IU) | IU→µg differs per substance; the µg rows 1106/1114 are used |
| 1190 Folate DFE, 1187 Folate food | Different quantities from total folate (1177) |
| 1105 Retinol, 1242 Vitamin E added | Components, not totals |

Two USDA rows legitimately map to `total_sugars` (2000 and the older 1063) and
two to `fiber` (1079 and AOAC 2033); **precedence** decides and genuine
disagreement is reported — 18 duplicate conflicts were logged, not silently
resolved.

203 distinct USDA nutrient ids remain unmapped (largely individual fatty acids,
amino acids and carotenoid fractions). They are **reported**, never guessed.

## 3. Import results

| | |
|---|---|
| Records read | 8,188 |
| Null / malformed | 32 / 0 |
| Rejected — unresolved preparation | 4,490 |
| Rejected — missing core nutrients | 19 |
| Accepted candidates | 3,647 |
| **Published seed** | **500** |

Preparation state is taken only from explicit description wording; anything else
is `unresolved` and routed away from publication rather than guessed, because
raw and cooked differ materially per 100 g and no yield conversion is ever
applied. That single rule rejects more than half the corpus — correctly.

## 4. Micronutrient coverage (published seed / all accepted)

| Nutrient | Seed | All accepted |
|---|---|---|
| sodium, calcium, iron | 100% | ~99% |
| fiber | 98.4% | 90.9% |
| vitamin C | 98.8% | 93.4% |
| saturated fat, cholesterol | ~99% | ~93% |
| potassium, magnesium, phosphorus, zinc | 93.8% | ~98% |
| vitamin B12 | 92.8% | 91.7% |
| vitamin A | 96.8% | 89.8% |
| folate | 77.6% | 85.5% |
| **vitamin D** | **72%** | **63.3%** |
| choline | 71% | 54.8% |
| **vitamin K** | **70%** | **59.3%** |
| **added sugars** | **0%** | **0%** |

**Added sugars is genuinely absent** from Foundation and SR Legacy — it is
registered canonically and will populate only from a source that declares it.
Coverage is reported over both the seed and the wider accepted population so the
seed figure can be checked rather than trusted.

## 5. Search benchmark (real corpus)

| Metric | Result |
|---|---|
| Corpus | 500 real foods |
| Top-1 | **85%** (17/20) |
| Top-4 | **90%** (18/20) |
| MRR | **0.875** |
| Zero-result correctness | 2/2 |
| False positives | **0** |
| Misses | "cheddar cheese", "greek yogurt" |

No embeddings were added: the measurement does not justify them. The two misses
are vocabulary gaps (USDA writes "Cheese, cheddar"), a candidate for the alias
work already deferred.

## 6. Idempotency

Re-running the full import produces a **byte-identical** seed and report — no
duplicate products, no fact churn, no version churn.

## 7. Defects found by doing this for real

- **Coverage was 100% across every nutrient** on the first run. The curation
  sorted by nutrient count, so it selected only the richest records — the report
  described the sort, not USDA. Now curated by relevance only.
- **The seed contained no chicken.** Alphabetical ordering with a 500 cap
  truncated at the letter "B"; the search benchmark scored 10%. Curation is now
  stratified round-robin across food terms, and Top-1 rose to 85%.
- **Three foods published without carbohydrate.** The publish gate checked raw
  readings while publication used the canonicalized map, and USDA's
  "carbohydrate by difference" is occasionally slightly **negative** for pure
  meats — correctly rejected as non-physical, but leaving the food published
  without carbs. The gate now checks the built map.

## 8. Not closed

Branded catalog population remains pending approved source data. The seed is a
curated 500 of 3,647 defensible candidates; expanding it needs alias work and
category curation, not more source data.
