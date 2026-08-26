# 24 — Goal-Aware Food Recommendations

> **GOAL-AWARE FOOD RECOMMENDATION ENGINE — ENGINEERING CLOSED.**
>
> **LLM NEVER DECIDES NUTRITION OR RECOMMENDATION NUMBERS.**

## 1. Scope

Answers: *"What foods from the eligible catalog are good candidates for me right
now?"* — and, only where defensible, *"here is a source-grounded portion."*

**Not** built: recipes, multi-food meal optimization, meal plans, diet coaching,
medical nutrition therapy, allergy-safe claims, disease-specific advice,
supplements, LLM-generated meals.

## 2. Not medical advice

The engine optimizes against the user's **configured MACROS.AI targets** —
nothing else. It never claims a food is healthy for a condition, safe for
diabetes, kidney disease or pregnancy, allergy-safe, or clinically optimal.
Rationale is framed as *your remaining protein*, *your calorie target*, *your
recent foods* — never as a medical outcome. A test asserts no moral or diet
language ("clean", "cheat", "good/bad food") appears in rationale codes.

## 3. Allergens — explicitly unsupported

MACROS.AI has no authoritative allergen data. Therefore **no allergy-safe
capability exists and allergen absence is never inferred.** If a future
restriction needs an allergen guarantee, the correct answer is *recommendation
safety unsupported*, never *probably safe*.

## 4. Authoritative inputs

Consumes `EnergyState`, `MacroState`, current `ProductVersion`s with active
catalog heads, this user's folded log history, and explicit preferences. It
**recomputes nothing** — no energy, no macros, no TEF, no PAL. `remaining_intake`
is the caloric action budget; `current_balance` is never redefined as
`consumed − full-day TDEE`.

## 5. Completeness

| State | Behaviour |
|---|---|
| No macro target | `insufficient_state` |
| No energy state | `available_with_limited_energy_confidence` — macro-aware ranking, no calorie-fit claim |
| `remaining_intake ≤ 0` | `energy_budget_exhausted` — does not push more food to satisfy one macro |
| Nothing eligible | `no_eligible_candidates` |

Missing is never zero. Activity gaps are never filled with PAL.

## 6. Eligibility (hard filters)

Active head · current head version only (never a superseded version) · complete
core nutrition · resolved preparation state · **not synthetic in production or
staging** · not on the user's avoid list.

## 7. Preferences

`avoided` is a **hard filter**; `preferred` is a ranking nudge only. Nothing is
inferred — a food not eaten recently is not a dislike.

## 8. Portion authority — the central safety rule

A portion is proposed **only** from:

1. the **current** version's source-backed serving mass, at policy multiples
   (0.5×, 1×, 1.5×, 2×), bounded and within scale range; or
2. a **median** of this user's own recent observed portions, requiring a
   minimum sample count inside a bounded window.

There is deliberately no third option. Dividing remaining calories by energy
density is arithmetically valid and product nonsense — it yields 650 g of
almonds or 14 g of chicken. When neither basis exists, **no quantity is
proposed**: the food is still recommended ("chicken breast is a strong protein
fit") and the user weighs their own amount.

100 g remains an arithmetic normalization basis, never a suggested serving.

## 9. Scoring

`macroFit + energyFit + historyNudge + preferenceNudge − energyOvershoot −
macroOvershoot − repetition`, every component exposed in `scoreComponents`.

**Macro normalization.** Raw grams cannot be compared across macros — 100 g of
carbs remaining is not "more needed" than 30 g of protein. Each gap is divided
by that macro's own configured target to give a remaining **fraction**, and the
fractions are normalized to sum to 1. A candidate is described by the **share of
its energy from each macro**, also dimensionless and portion-independent, so
foods without a serving basis still rank. Fit is the dot product of the two.

## 10. Overshoot

**Hard bound** (`maxEnergyOvershootRatio = 1.25`) removes a portion entirely;
**soft penalties** merely rank down. The two are separate and both configured.

## 11. History and corrections

History is a ranking preference, never nutrition authority, and is **strictly
this user's own**. It is read from the **folded** log stream, so voided and
superseded entries never contaminate frequency, recency or portion statistics —
a corrected 200 g → 120 g log contributes 120 g only.

## 12. Reformulation

History is keyed by stable `productId`, so a user's V1 history still recognises
the reformulated V2 candidate. But nutrition and the source serving come from
**V2**, and the old V1 log is never rewritten.

## 13. Assistant integration

`recommend_food` is registered **read-only with zero allowed arguments**. The
model may recognise that the user is asking for a recommendation; it cannot
supply candidate ids, scores, nutrition or quantities — every such field is
rejected by the validator. The deterministic parser also handles "what should I
eat" offline, so the feature works with no provider at all.

## 14. No auto-logging

A recommendation never selects, weighs or logs. The existing flow is unchanged:
recommendations → user chooses → exact ProductVersion → weigh → review →
explicit confirmation.

## 15. Versioning and performance

`recommendation-policy@1.0.0`; all weights and thresholds are typed, versioned
configuration marked **PRODUCT POLICY, not physiological truth**.

Performance is **synthetic only**: a test asserts 8× the candidate count does not
cost anything like 64× the time, guarding against accidental O(N²). No real
catalog exists, so no real-world performance claim is made.

## 16. Known limitations

Synthetic fixtures only (0 real USDA, 0 approved branded records). No recipes or
multi-food optimization. No allergen data. Portion proposals exist only for
products with a declared serving or sufficient user history.
