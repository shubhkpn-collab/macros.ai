# 37 — SEARCH-1 Food Discovery Resilience and Safety

> **SEARCH DOMAIN — CLOSED AND FROZEN** (SEARCH-1B).
>
> All seven closure criteria pass. The controller, the QA browser and the
> benchmark now call ONE function, `resilientSearch`. Reopening requires new
> runtime evidence of a defect.
>
> **SEARCH-1 — ENGINEERING COMPLETE.** Measured against the real catalog:
> 416,429 records, 37,090 vocabulary terms,
> 255 golden queries.

## 1. The problem SEARCH-1 exists to solve

DATA-1 measured `chiken breast` returning **TURKEY BREAST**. That is worse than
returning nothing: a confident wrong food gives the person no signal to doubt
it, and everything downstream — the log, the day's balance, the recommendation
engine — inherits the error silently.

So the headline metric is not relevance. It is **unsafe wrong-result rate**.

## 2. Results

| Metric | Value |
|---|---|
| Corpus | **255 queries**, 14 categories |
| Top-1 relevance | **94.7%** |
| Top-3 relevance | **95.1%** |
| No-result | 3.5% |
| **Unsafe wrong result** | **0.0%** |
| Ambiguous | 75.3% |
| Did-you-mean | 9.4% |

| Category | n | top-1 | top-3 | none | unsafe |
|---|---|---|---|---|---|
| abbreviation | 11 | 11 | 11 | 0 | **0** |
| absent | 8 | 0 | 0 | 8 | **0** |
| ambiguous | 16 | 16 | 16 | 0 | **0** |
| branded | 18 | 18 | 18 | 0 | **0** |
| cuisine | 18 | 18 | 18 | 0 | **0** |
| dairy | 18 | 18 | 18 | 0 | **0** |
| fats_condiments | 19 | 19 | 19 | 0 | **0** |
| grain | 28 | 24 | 24 | 0 | **0** |
| misspelling | 25 | 17 | 18 | 1 | **0** |
| morphology | 10 | 10 | 10 | 0 | **0** |
| natural_language | 12 | 12 | 12 | 0 | **0** |
| preparation | 12 | 12 | 12 | 0 | **0** |
| produce | 28 | 28 | 28 | 0 | **0** |
| protein | 32 | 31 | 31 | 0 | **0** |

### The three proven failures

| Query | Before | After |
|---|---|---|
| `chiken breast` | **TURKEY BREAST** (confident) | CHICKEN BREAST · `did_you_mean` |
| `brocoli` | no result | Broccoli, raw · `did_you_mean` |
| `pb` | PB & J BAR | PEANUT BUTTER · `did_you_mean` |

None became `confident`. A correction asks; it does not assume.

## 3. Algorithm

Per token: expand controlled abbreviations → strip filler and quantity → keep
preparation terms → exact match → conservative singularisation → bounded fuzzy
correction.

**Bounded distance by length.** ≤4 chars get **zero** correction: at four
characters one edit reaches a different food — `oat`/`oil`, `pea`/`tea`. 5–7
chars allow 1, 8+ allow 2.

**Frequency-aware resolution.** The catalog contains its own misspellings — one
real product is labelled `BROCOLLI` — so a user typo can exactly match source
noise and bypass correction entirely. Frequency separates a canonical word
(`broccoli`, 387 uses) from noise (`brocolli`, 1 use). Two rules follow:

- a tie is broken only by a **decisive** margin (50×); otherwise it stays a tie
  and the query is refused rather than guessed;
- an exact match on a **rare** term (≤3 uses) with a dominant neighbour is
  corrected anyway, because matching a typo exactly is not understanding.

## 4. Safety rules

1. **An unresolved token poisons confidence.** This is the `chiken breast` fix:
   not understanding part of a query means any answer from the remainder is a
   guess about a different food.
2. **Corrections can never reach `confident`** — only `did_you_mean`.
3. **Ties are refused**, never resolved by coin flip.
4. **Preparation and brand terms are semantic** and never dropped to obtain a
   match. Losing "raw" changes which food you are eating.
5. **A near-tie in results (>92%) downgrades to `ambiguous`** — several equally
   good foods is a question, not a winner.
6. **Abbreviations are a closed allow-list**, not a heuristic. Guessing is how
   `pb` became PB & J BAR.

Confidence: `confident` → `did_you_mean` → `ambiguous` → `unresolved`. Only
`confident` may auto-select.

## 5. Remaining weakness, stated plainly

Misspellings are still the weakest category (17/25 top-1), and
`3.5%` of queries return nothing. Both were left visible rather than tuned
away: adjusting expected identities to lift a score would trade a real property
for a number. **Crucially, every remaining failure is a SAFE failure** — zero
unsafe results across all 255 queries.

## 6. Image-ready rendering

`FoodCardView` now carries `imageUrl`, `imageInitials` and `imageAttribution`.
A verified URL renders; anything else falls back deterministically. An
`unverified` image is deliberately **not** rendered — unproven provenance must
not reach the screen.

Image coverage remains **0%**. No provider was chosen and nothing was
downloaded; that is IMG-1. The product is technically ready without a code
change once images exist.

## 7. Development catalog browser

`DevFoodCardBrowser` is wired into the development host **only** — a production
host returns `catalogBrowser: null`, so the surface cannot appear in a shipped
configuration. It searches the same `listSearchable()` set the application uses
and projects through the real FoodCard pipeline, so what is inspected on Android
is what production logic produces. Data gaps are shown, not hidden: a food with
no gram weight says so.


---

# SEARCH-1B — Runtime integration and closure

## The defect SEARCH-1B fixed

SEARCH-1 measured 0% unsafe results with a **Python reimplementation** of the
fuzzy, frequency and confidence rules. The number described a program the
product did not run, and the two copies could have drifted apart forever
without anyone noticing. There is now exactly one algorithm.

## One entry point

`resilientSearch(catalog, vocabulary, query)` in `@macros/domain-food-search`.
It **composes** rather than replaces: resilient resolution supplies a corrected
query, and the existing deterministic ranker ranks it, untouched.

| Caller | Path |
|---|---|
| `TabletAppController.searchFood()` | `buildVocabulary` → `resilientSearch` |
| `DevFoodCardBrowser` (dev host only) | `buildVocabulary` → `resilientSearch` |
| Benchmark | imports the shipping package |

The private `hay.includes(...)` substring filter in the QA browser is deleted —
inspecting behaviour the product does not have is worse than having no QA
surface.

`autoSelectable` is the safety gate: true **only** for a confident query with a
single result. A correction, an expansion, a near-tie or an unresolved token is
offered as a choice, never applied silently.

## Measured on production code

| Metric | Value |
|---|---|
| Records searched | 102,566 |
| Top-1 relevance | **96%** |
| Top-3 relevance | **96.8%** |
| No-result | 5.1% |
| **Unsafe wrong result** | **0%** |
| Ambiguous | 79.2% |
| Mean search | **276.8 ms** |

Required proofs, through the real path:

| Query | Confidence | Top result |
|---|---|---|
| `chiken breast` | `did_you_mean` | CHICKEN, never turkey |
| `brocoli` | `did_you_mean` | broccoli |
| `pb` | `did_you_mean` | PEANUT BUTTER |

## Performance

**276.8 ms mean** over 102,566 records — a full linear scan with
per-token fuzzy resolution. No cache or index was added: the brief asks for
optimisation only on a demonstrated user-visible blocker, and on the tablet the
searchable set is the offline bundle rather than the whole branded catalog.
**This is the number to watch.** If the device set grows toward 400k, a scan at
this cost becomes user-visible and an index is the answer — not before.

## Backlog, explicitly not blockers

- ambiguity at 79.2% — genuine in a large catalog, but the UI will ask often
- misspelling top-1 20/25
- 5.1% of queries return nothing
- image coverage 0% (IMG-1)
- benchmark loads 60 shards to run in-process; the full 434k set is audited
  by DATA-1 rather than searched here
