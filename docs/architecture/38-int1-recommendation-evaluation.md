# 38 — INT-1 Recommendation Intelligence Evaluation

> **VERDICT: RECOMMENDATION ENGINE NEEDS TARGETED CORRECTION.**
>
> Hard safety is clean. Nutritional usefulness is not. Nothing was corrected in
> this milestone — the point was to establish the baseline truth first.

## 1. What was tested

The real production path: `recommendFoods()` from
`@macros/domain-recommendation`, policy `recommendation-policy@1.0.0`. No second
algorithm was written, and no LLM judged nutritional correctness — every
verdict is deterministic arithmetic over the engine's own output.

- **1,728 scenarios** — goal (lose/maintain/gain) × day phase
  (early/middle/late) × 4 energy targets × 6 consumption levels × 8 macro
  mixes, including severe and mild protein deficits, carbohydrate and fat
  deficits, near-exhausted macros, balanced remainders, and exceeded targets.
- **6,630 real recommendable foods** from the USDA generic
  catalog. Nutrition is real throughout; only user state is synthetic. No
  serving weight was injected — the seed genuinely has none, and fabricating it
  would have measured the engine against a catalog that does not exist.
- Mean call: **7.91 ms**.

## 2. Hard safety — clean

| Metric | Result |
|---|---|
| Hard violation rate | **0%** |
| Impossible / negative portions | none |
| Ungrounded portions | none |
| Non-finite scores | none |
| Ranking monotonic by own score | **100%** |
| Budget exhausted handled honestly | **288/288** |

Degradation is genuinely honest: `energy_budget_exhausted` and
`no_eligible_candidates` are returned rather than a manufactured suggestion.
That is the property that matters most and the engine has it.

## 3. Fit metrics

| Metric | Result | n |
|---|---|---|
| Energy fit | **89.4%** | 1,440 |
| Macro fit (proportional) | 100% | 540 |
| Unnecessary overshoot | 0% | 540 |

**The 100% macro fit is a metric limitation, not a triumph.** My metric judged
macro fit by ENERGY SHARE — the same proportional logic the engine uses — so it
certified black coffee as an excellent protein choice. Two measurements sharing
a blind spot agree with each other and tell you nothing. That is recorded in a
test so the number is never misread.

## 4. The finding

Across 1,440 scenarios that produced advice, only
**7 distinct foods** ever won:

| Wins | Food |
|---|---|
| 450 | Coffee beverages, brewed, prepared with tap water, decaffein |
| 315 | Beluga oil, whale (Alaska Native) |
| 270 | Beverages, Kiwi Strawberry Juice Drink |
| 270 | Beverages, pineapple and orange juice drink, canned |
| 45 | Trout fish, rainbow, farmed, raw |
| 45 | Coconut meat nuts, dried (desiccated), creamed |
| 45 | Gluten-free cookies, lemon wafer |

- **31.3%** of winners are near-zero-energy foods (< 25 kcal/100 g).
- **21.9%** are extreme-density foods (> 700 kcal/100 g).

### Root cause — one mechanism, two symptoms

The engine scores macro fit as a **proportion** of a candidate's macro energy.
Proportion is scale-free, so magnitude never enters the comparison:

- Decaffeinated coffee has trace protein and essentially nothing else, so
  protein is **100% of its macro energy**. It scores a perfect protein fit
  while supplying no protein.
- Whale oil is **100% fat energy**, so it scores a perfect fat fit for any fat
  gap, at 900 kcal/100 g.

Both are the same defect: *what fraction of this food is the macro I need?*
rather than *how much of my gap does a realistic portion of this food close,
within my remaining budget?*

## 5. Named adversarial cases

| Case | Status | Top pick | Density |
|---|---|---|---|
| `LEAN_PROTEIN_LATE_DAY` | available | Coffee beverages, brewed, prepared with tap  | 0 kcal/100g |
| `FAT_ALREADY_HIGH` | available | Coffee beverages, brewed, prepared with tap  | 0 kcal/100g |
| `PROTEIN_ALREADY_MET` | available | Beverages, Kiwi Strawberry Juice Drink | 47 kcal/100g |
| `CARBS_NEEDED_PRE_WORKOUT` | available | Beverages, Kiwi Strawberry Juice Drink | 47 kcal/100g |
| `SMALL_CALORIE_BUDGET` | available | Coffee beverages, brewed, prepared with tap  | 0 kcal/100g |
| `CALORIES_ALREADY_EXCEEDED` | energy_budget_exhausted | — | — |
| `BALANCED_MAINTENANCE` | available | Beverages, Kiwi Strawberry Juice Drink | 47 kcal/100g |
| `CONTROLLED_SURPLUS` | available | Beluga oil, whale (Alaska Native) | 900 kcal/100g |
| `NO_GOOD_CANDIDATE` | no_eligible_candidates | — | — |

Two pass outright — `CALORIES_ALREADY_EXCEEDED` and `NO_GOOD_CANDIDATE` both
degrade honestly. `CONTROLLED_SURPLUS` returning whale oil is defensible in
isolation (energy density is genuinely wanted in a surplus) but alarming as a
general pattern. The rest return nutritionally empty beverages.

## 6. Failure classification

| Class | Count | Example |
|---|---|---|
| **CRITICAL** (unsafe / materially wrong) | **0** | none found |
| **MAJOR** (direction clearly poor) | 153 energy-fit + the degenerate-winner pattern | `LEAN_PROTEIN_LATE_DAY` → black coffee for a major protein gap |
| **MINOR** (suboptimal ranking) | 0 measured | — |
| **DATA LIMITATION** | pervasive | the generic seed has **no serving weights**, so the engine cannot propose a portion and cannot judge "how much of my gap does this close" |
| **EXPECTED AMBIGUITY** | `BALANCED_MAINTENANCE` | with no dominant gap, many foods are equally reasonable |

Nothing reached CRITICAL: no recommendation was unsafe, impossible, ungrounded,
or made past an exhausted budget. The failures are usefulness failures.

## 7. Targeted correction areas — NOT implemented

1. **Weight macro fit by absolute contribution, not share alone.** A food
   should be scored on how much of the actual gap a realistic portion closes.
   This single change addresses both symptoms.
2. **Bound energy density against remaining budget.** A 900 kcal/100 g food is
   reasonable in surplus and unreasonable with 120 kcal left.
3. **Require a minimum nutritional contribution to be recommendable.** A food
   that cannot meaningfully move any macro is not an answer to
   "what should I eat?".
4. **Portion grounding depends on DATA-1's serving gap.** Without a serving
   weight the engine has no defensible portion, and correction 1 needs one.
   These are coupled: the recommendation fix is partly a catalog fix.

Each is a scoring-policy change, not an architectural one.

## 8. Verdict

**RECOMMENDATION ENGINE NEEDS TARGETED CORRECTION.**

Safety, determinism, ranking integrity and honest degradation are all sound —
the hard parts are right. What is missing is nutritional magnitude in the
scoring, and the engine currently cannot answer "what should I eat?" usefully
for a real user day.
