# 39 — INT-2 Recommendation Correction and Closure

> **RECOMMENDATION ENGINE — CLOSED AND FROZEN.**
> Policy `recommendation-policy@2.0.0`. Same 1,728-scenario INT-1 harness, same
> scenario states, same nine named cases.

## 1. Root cause corrected

v1 scored macro fit as **energy share** — a food's composition. Trace protein
was 100% of black coffee's macro energy, so coffee scored a perfect protein fit
while supplying no protein. Whale oil was 100% fat energy, perfect for any fat
gap, at 900 kcal/100 g.

Energy fit compounded it: `energyFit = 1 - ratio` awarded the maximum to
whatever consumed the fewest calories, and ungrounded candidates scored `0`,
so composition alone decided the ranking.

## 2. Scoring model, before and after

| | v1.0.0 | v2.0.0 |
|---|---|---|
| Macro fit | Σ(deficit weight × **energy share**) | Σ(deficit weight × **gap closure**) |
| Trace amounts | scored fully | below `minMeaningfulGrams` → **0** |
| Huge amounts | unbounded influence | saturate at `fullClosureFraction` |
| Overfilling a gap | counted as closure | only the **fitting** part closes |
| Energy fit | `1 - ratio` (fewest calories wins) | `min(1, ratio / usefulEnergyFraction)` |
| Ungrounded candidate | `energyFit = 0` | ranked on the comparison basis |
| Exhausted macro | no penalty | `exhaustedMacro`, scaled by **target** |

## 3. Comparison basis vs portion authority

These are deliberately separate concepts:

- **Comparison basis** — the authoritative per-100 g nutrient basis, used only
  to rank candidates against each other. `macroContributionGrams` documents that
  its output is *"a COMPARISON quantity only… never become a portionProposal"*.
- **Portion authority** — unchanged. Still exactly two grounded bases: a
  source-backed serving mass, or a robust median of the user's own observations.
  *"There is deliberately no third option."*

Consequence, visible in the table below: every named case recommends a real
food and states **no portion**, because the generic seed carries no serving
weights. "Which food?" is answered; "how many grams?" honestly is not.

## 4. Policy

`recommendation-policy@1.0.0` → **`recommendation-policy@2.0.0`**. New typed fields:
`comparison.basisGrams`, `comparison.minMeaningfulGrams` (per macro),
`comparison.fullClosureFraction`, `comparison.usefulEnergyFraction`, and
`penalties.exhaustedMacro`. No magic constants in the engine.

## 5. Exhausted macros

A macro at or below zero cannot be closed, so it earns nothing — and adding a
material amount now costs `penalties.exhaustedMacro`, scaled by the macro
**target** rather than the remaining value. Dividing by a zero or negative
remaining would have been a divide-by-zero hack; scaling by target is bounded
and deterministic.

The penalty is 1.4 against a macro-fit weight of 1.0: decisive rather than
merely discouraging, because a food closing the dominant gap perfectly would
otherwise still win while piling onto an exhausted one.

## 6. Minimum meaningful contribution

Policy-versioned per macro — protein 3 g, carbohydrate 5 g, fat 2 g per
comparison basis. Below that, closure is **zero**. No food name is hard-coded
and nothing is blacklisted; a test asserts the engine never branches on a
display name. Zero-calorie foods remain valid catalog entries — they simply stop
masquerading as answers to deficits they do not move.

## 7. Metrics — same harness, same scenarios

| Metric | INT-1 | INT-2 |
|---|---|---|
| Hard violation rate | 0% | **0%** |
| Ranking monotonic | 100% | **100%** |
| Budget exhausted honest | 288/288 | **288/288** |
| Energy fit | 89.4% | **100%** |
| Macro fit *(independent metric)* | 100% *(shared blind spot)* | **93.3%** |
| Unnecessary overshoot | 0% *(masked)* | **0%** |
| Meaningful contribution | not measured | **93.3%** |
| Exhausted-macro violation | not measured | **0%** |
| Near-zero-energy winners | 31.3% | **0%** |
| Extreme-density winners | 21.9% | **0%** |
| Distinct winners | 7 | **54** |
| Mean call | 7.91 ms | 6.95 ms |

INT-1's macro-fit metric judged fit *proportionally* — the same blind spot as
the engine — so it reported 100% while certifying coffee. INT-2's metric judges
**absolute grams against the gap**, on thresholds independent of the policy, so
it cannot be satisfied by tuning. The honest reading is that 100% was
meaningless and 93.3% is real.

## 8. Nine-case sanity table

| Case | Rem kcal | Rem P/C/F | Winner | Comparison basis (100 g) | Grounded portion | Why it won | Portion statable? |
|---|---|---|---|---|---|---|---|
| `LEAN_PROTEIN_LATE_DAY` | 450 | 120/70/5 | Soy flour, defatted | 366 kcal · P51.1 C32.9 F3.3 | none | strong_protein_fit, portion_unavailable, fits_remaining_energy | **no** |
| `FAT_ALREADY_HIGH` | 1080 | 99/120/-8 | Cottonseed flour seeds, low fat (g | 332 kcal · P49.8 C36.1 F1.4 | none | strong_protein_fit, strong_carb_fit, portion_unavailable | **no** |
| `PROTEIN_ALREADY_MET` | 880 | -8/143/29 | Gluten-free cookies, lemon wafer | 515 kcal · P0 C74.4 F24.2 | none | strong_carb_fit, portion_unavailable, fits_remaining_energy | **no** |
| `CARBS_NEEDED_PRE_WORKOUT` | 1820 | 84/224/42 | Mature seeds soybeans, dry roasted | 449 kcal · P43.3 C29 F21.6 | none | portion_unavailable, fits_remaining_energy | **no** |
| `SMALL_CALORIE_BUDGET` | 120 | 36/32/13 | Whole turkey, giblets, raw | 124 kcal · P18.2 C0.1 F5.1 | none | strong_protein_fit, portion_unavailable, fits_remaining_energy | **no** |
| `CALORIES_ALREADY_EXCEEDED` | -270 | 13/-18/0 | — | — | none | — | **no** |
| `BALANCED_MAINTENANCE` | 1100 | 82/110/36 | Mature seeds soybeans, dry roasted | 449 kcal · P43.3 C29 F21.6 | none | portion_unavailable, fits_remaining_energy | **no** |
| `CONTROLLED_SURPLUS` | 2520 | 189/252/84 | Whole egg, dried, stabilized, gluc | 615 kcal · P48.2 C2.4 F44 | none | portion_unavailable, fits_remaining_energy | **no** |
| `NO_GOOD_CANDIDATE` | 1000 | 75/100/33 | — | — | none | — | **no** |

## 9. Winner distribution

INT-1: **7** distinct foods won 1,440 scenarios — 450 coffee, 315 whale oil,
540 juice drinks. INT-2: **54** distinct winners, led by soybeans, winged
beans and soy/egg protein sources.

## 10. Remaining failures

**36 MAJOR macro-fit** scenarios (6.7%). These are cases where the
dominant gap is a macro the recommendable catalog cannot serve well at that
energy budget. No CRITICAL and no MINOR failures remain. This is a catalog
coverage limit, not a scoring defect, and it is recorded rather than tuned away.

## 11. Not solved here

Serving weights are still absent from the generic seed, so exact portion
guidance remains ungrounded. That is DATA-2, deliberately untouched: INT-2 makes
*"which food is a good choice right now?"* intelligent even while
*"exactly how many grams?"* cannot yet be answered.
