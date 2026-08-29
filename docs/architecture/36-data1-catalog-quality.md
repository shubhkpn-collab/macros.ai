# 36 — DATA-1 Catalog Health, Coverage and Search Quality

> Measured against the real catalog on 2026-08-29.
> Every number below was produced by `tools/audit-catalog.py` and
> `tools/benchmark-search-quality.py` reading the actual data — none is asserted
> from a previous report.

## 1. What the catalog actually contains

| | Count |
|---|---|
| Generic foods (USDA Foundation + SR Legacy) | **6,877** |
| Branded products | **434,714** |
| Branded current versions | **409,552** |
| Branded historical version ids | 8,857 |
| Total branded version ids | 443,571 |
| Distinct brands | 33,479 |
| Searchable records (benchmark index) | 416,429 |

`data/branded-catalog.json` holds only ~98k products and is a build
intermediate. The authoritative store is the 257 authority shards plus the 36
product-identity shards; auditing the intermediate would have understated
coverage by roughly 77%.

## 2. Nutrition coverage — strong

| Metric | Generic | Branded (current) |
|---|---|---|
| Has energy (kcal) | **100.0%** | **100.0%** |
| Has protein + carbs + fat | **100.0%** | **100.0%** |
| Has preparation state | 100% | 100% (all `as_sold`) |
| Recommendable (generic) | 6,630 of 6,877 | — |

Generic preparation split:

| State | Foods |
|---|---|
| `as_sold` | 3,203 |
| `cooked` | 2,194 |
| `raw` | 1,480 |

The raw/cooked split is what makes weighing meaningful: 3,674 generic foods
carry an explicit preparation state, so "chicken breast" can be resolved to the
form actually on the scale.

This is the catalog's strength: essentially every record can produce a calorie
and macro figure.

## 3. Serving coverage — the real gap

| Serving information | Records | Share |
|---|---|---|
| Gram weight present | 257,431 | **62.86%** |
| Gram weight + household text | 257,339 | 62.8% |
| Household text only (no grams) | 143,367 | 35.0% |
| No serving information at all | 8,754 | 2.1% |

**Roughly a third of branded foods have no gram weight.** A label saying
"1 ONZ" or "8 OZA" cannot be weighed without a conversion the source does not
supply, and inventing one would be fabricating nutrition. This is the strongest
data argument for the scale being the primary input and for manual weight entry
existing as a fallback.

## 4. Display quality

**98.06%** of current branded versions are fit to show a customer
(401,611 of 409,552).

Problems found — **reported, never corrected**:

| Problem | Records |
|---|---|
| `carbohydrate_out_of_range` | 1,139 |
| `energy_macro_disagreement` | 6,532 |
| `energy_out_of_range` | 697 |
| `fat_out_of_range` | 159 |
| `no_brand` | 17,974 |
| `protein_out_of_range` | 116 |

`energy_macro_disagreement` (6,532) means the declared
calories differ from an Atwater estimate by more than 35%. That is a fact about
the USDA source data. Rewriting those rows to look tidy would hide a genuine
data-quality signal behind clean numbers.

`no_brand` (17,974) does not block display — a brandless record is
still edible — so it is excluded from the displayable calculation.

## 5. Identity and duplicates

Identifier states:

| State | Products |
|---|---|
| `current` | 399,345 |
| `conflicted` | 22,133 |
| `unknown` | 11,818 |
| `needs_review` | 1,418 |

`conflicted` and `needs_review` (23,551 combined, 5.4%) are products whose GTIN
evidence disagrees. They remain in the catalog with their conflict recorded
rather than being silently resolved to one interpretation.

Collision candidates: **28,333 name+brand pairs** covering
71,644 records. These are candidates, not confirmed duplicates —
a supermarket legitimately sells the same product in several sizes, and the
GTIN identity work already established that identical labels are not identical
products. No record was merged.

## 6. Search quality

Corpus of 32 golden queries across common foods, raw/cooked,
branded, plural/singular, misspellings, abbreviations, natural language and
cuisine terms.

| Metric | Result |
|---|---|
| Top-1 relevance | **90.6%** |
| Top-3 relevance | **90.6%** |
| No-result rate | 3.1% |

By category:

| Category | n | top-1 | top-3 | no result |
|---|---|---|---|---|
| abbreviation | 2 | 1 | 1 | 0 |
| branded | 4 | 4 | 4 | 0 |
| common | 8 | 8 | 8 | 0 |
| cuisine | 4 | 4 | 4 | 0 |
| morphology | 3 | 3 | 3 | 0 |
| natural_language | 3 | 3 | 3 | 0 |
| preparation | 5 | 5 | 5 | 0 |
| spelling | 3 | 1 | 1 | 1 |

### Known failures, left visible

- **`brocoli`** → no results. There is no fuzzy matching, so a single
  transposed letter returns nothing.
- **`chiken breast`** → *TURKEY BREAST*. Worse than no result: a confident
  wrong answer.
- **`pb`** → *PB & J BAR* rather than peanut butter. Abbreviation expansion
  does not exist.

Spelling is the one genuinely weak category (1 of 3). It was **not** tuned away:
adjusting identity or ranking to lift a benchmark number would trade a real
property for a score. Fuzzy matching is a scoped follow-up, not a DATA-1 fix.

## 7. Coverage verdict

**Covered well:** energy and macros for effectively the whole catalog; branded
breadth ({br['distinctBrands']:,} brands); generic raw/cooked distinctions, which is what
makes weighing meaningful.

**Real gaps, in priority order:**

1. **Serving grams for ~37% of branded foods** — solvable in part from existing
   USDA `servingSize`/`servingSizeUnit` fields where the unit is convertible;
   the remainder needs a density or package-weight source.
2. **Images: 0% coverage.** The architecture exists (metadata + provenance +
   deterministic fallback); no image source is wired, and none was bulk
   downloaded in this milestone.
3. **Misspelling and abbreviation handling** — needs fuzzy matching, which is a
   search change, not a data change.
4. **Ingredients text** is absent from the authority projection
   ({br['withIngredients']:,} records) even though the build reported ~441k versions carrying it,
   so it is available upstream but not projected into the runtime store.

**Not a gap:** the catalog does not need every food in the world. It needs
enough that a person logging a normal day rarely fails — and on the golden
corpus that holds for everything except misspellings.

## 8. Image architecture

Metadata and provenance only: `foodId`, `url`, `source`, `externalSourceId`,
`kind` (product / representative / fallback), `status`, `licence`,
`attribution`, `verifiedAt`. **No binaries in PostgreSQL** — images are large,
immutable and CDN-shaped, and bytes in the row store would bloat every backup
and replica for data a URL already addresses. Licence terms differ per source,
so provenance travels with the reference rather than being assumed. A test
fails the build if any migration introduces a `bytea`/`blob` image column.

When no image exists, `fallbackImage()` returns a deterministic reference and
`fallbackInitials()` derives a stable placeholder from the name — the same food
looks identical on every device and every render.
