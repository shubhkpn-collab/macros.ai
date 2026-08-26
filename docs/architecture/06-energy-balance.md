# 06 — Energy Balance Architecture

> **v4 — PAL REMOVED FROM THE ENERGY ENGINE. LOCKED, owner ruling 2026-08-11.**
>
> `BMR × PAL` is no longer part of the canonical MACROS.AI expenditure calculation in any mode. There is one equation — `BMR + ACTIVE + TEF` — and what varies is the *source and quality* of the ACTIVE component. This supersedes every earlier baseline/fallback/PAL formulation in this document set.

This is the product. It is deterministic, auditable, explainable in one sentence, and completely independent of the LLM.

---

## 0. The production model

```
TOTAL ENERGY EXPENDITURE  =  BMR  +  ACTIVE ENERGY  +  TEF
```

| Component | Source | Owner |
|---|---|---|
| **BMR** | user profile, deterministic equation | MACROS.AI — one canonical source, never the wearable |
| **ACTIVE ENERGY** | wearable, normalized (EAT + NEAT combined) | provider adapter |
| **TEF** | logged foods and their macro composition | **MACROS.AI — this is the differentiator** |

MACROS.AI captures the food, the measured weight, and the exact macro split. It therefore computes the thermic cost of intake itself. No third-party nutrition app is required to complete the energy model.

---

## 1. BMR

Mifflin-St Jeor by default. Katch-McArdle only where a versioned `BmrPolicy` explicitly permits it for a specific body-fat measurement source — the presence of a body-fat number never switches the equation on its own. **BMR is independent of the wearable and is the single canonical basal source.** A provider's resting-energy value may later be retained as a comparison signal only; it never enters the expenditure sum.

**There is no PAL multiplier.** Onboarding no longer collects an activity level for the Energy Engine. If an activity questionnaire exists later it feeds an `EstimatedActivityProvider` and produces an ACTIVE ENERGY estimate — it never multiplies BMR.

Model rows are effective-dated **and carry their own profile snapshot**, so the profile that produced BMR is by construction the profile the TEF model sees. Divergence is not possible.

---

## 2. Active energy (EAT + NEAT)

The canonical engine consumes one field:

```ts
activeKcal   // combined non-basal physical activity ≈ EAT + NEAT
```

Adapters may carry `exerciseKcal?` and `nonExerciseKcal?` where a source distinguishes them reliably. **Those fields are optional and the engine must never depend on the split.**

**Adapter responsibilities (never the engine's):**
- If a platform reports *total* energy expenditure, the adapter subtracts that platform's own resting estimate and returns active energy only.
- The returned figure must exclude basal energy and must not embed a thermic-effect estimate. Where a provider's model is opaque on this point, the adapter records it in provenance and the sample is marked `isEstimated`.

```ts
interface NormalizedActivitySample {
  start: Instant;
  end: Instant;
  activeKcal: number;                 // canonical, required
  exerciseKcal?: number;              // optional, never depended upon
  nonExerciseKcal?: number;           // optional, never depended upon
  providerId: string;
  sourceDevice?: string;
  confidence: number;                 // 0..1
  isEstimated: boolean;
  appearsWorn?: boolean;
  rawRef?: string;
}

interface ActivityCoverage {
  windowStart: Instant;
  windowEnd: Instant;
  lastSampleAt: Instant | null;
  coveredMinutes: number;
  gaps: TimeWindow[];
  coverageRatio: number;              // 0..1 of the elapsed day
}
```

---

## 3. TEF — computed and individualized by MACROS.AI

> **v4:** TEF is not a universal macro percentage. Meal composition is the *starting point*; the estimate is then adjusted by the individual's body/metabolic profile, and later by longitudinal personal calibration.

```
FOOD / MEAL CHARACTERISTICS  +  INDIVIDUAL BODY PROFILE  +  (LATER) PERSONAL CALIBRATION
                              ↓
                   INDIVIDUALIZED TEF ESTIMATE
```

Two clearly separated quantities, both returned:

```
base_macro_tef        = f(protein_energy, carb_energy, fat_energy, alcohol_energy, total_meal_energy)
individualized_tef    = base_macro_tef  +  individual_adjustment(profile, approved rules)
```

The adjustment is **not** a product of multiplied variables. It is a single composed, bounded adjustment produced by a versioned, evidence-reviewed policy. The engine applies the policy; it never embeds physiology.

### 3.1 Contracts

```ts
interface TefProfile {
  ageYears: number;
  sex: 'male' | 'female';
  bodyWeightKg: number;
  heightCm: number;
  bodyFatPercent?: number;
  fatFreeMassKg?: number;                 // derived when body fat is present and valid
  metabolicProfile?: TefMetabolicProfile; // reserved, unused
}

type TefInputVariable = 'age' | 'sex' | 'bodyFatPercent' | 'fatFreeMass';

type VersionedAdjustmentRule =
  | { kind: 'none' }                                       // neutral — no effect on the estimate
  | { kind: 'linear';    input: TefInputVariable; slope: number; intercept: number; bounds: [number, number] }
  | { kind: 'piecewise'; input: TefInputVariable; breakpoints: Array<{ upTo: number; factor: number }> };

interface TefPolicy {
  version: string;
  reviewStatus: 'PENDING_EXTERNAL_REVIEW' | 'APPROVED';

  macroCoefficients: {
    protein: number;
    carbohydrate: number;
    fat: number;
    alcohol?: number;
  };

  individualAdjustmentModel: {
    age:             VersionedAdjustmentRule;
    sex?:            VersionedAdjustmentRule;
    fatFreeMass?:    VersionedAdjustmentRule;
    bodyFatPercent?: VersionedAdjustmentRule;
  };

  composition: 'additive_kcal';           // adjustments sum in kcal; never multiplied together
  adjustmentBoundFraction: number;        // hard cap on |adjustment| as a fraction of base_macro_tef

  personalCalibrationEnabled: false;      // reserved; see §3.6
}

interface TefResult {
  estimatedTefKcal: number;
  baseMacroTefKcal: number;
  individualAdjustmentKcal: number;
  confidence: 'basic' | 'profile_adjusted' | 'personalized';
  policyVersion: string;
  reviewStatus: 'PENDING_EXTERNAL_REVIEW' | 'APPROVED';
  inputsUsed: {
    macros: boolean;
    age: boolean;
    sex: boolean;
    bodyWeight: boolean;
    bodyFat: boolean;
    fatFreeMass: boolean;
    personalCalibration: boolean;
  };
}

function calculateTef(
  nutrition: NutritionTotals,
  profile: TefProfile,
  policy: TefPolicy
): TefResult;
```

### 3.2 Base macro TEF

```
protein_energy = protein_g × 4
carb_energy    = carbohydrate_g × 4
fat_energy     = fat_g × 9
alcohol_energy = alcohol_g × 7        (optional)

base_macro_tef =
    protein_energy × macroCoefficients.protein
  + carb_energy    × macroCoefficients.carbohydrate
  + fat_energy     × macroCoefficients.fat
  + alcohol_energy × macroCoefficients.alcohol
```

Literature ranges for orientation only — **not values, and not physiological truth**: protein ~20–30%, carbohydrate ~5–10%, fat ~0–3%. The shipped coefficients await a registered dietitian / qualified reviewer.

### 3.3 The safety property: unreviewed policies cannot carry coefficients

> While `reviewStatus === 'PENDING_EXTERNAL_REVIEW'`, **every rule in `individualAdjustmentModel` must be `{ kind: 'none' }`.** Validated at policy load and enforced by test.

Consequence: `individualAdjustmentKcal === 0` and `individualized_tef === base_macro_tef` **exactly**, byte for byte, until a reviewer approves the model. There is no path — configuration, environment variable, or otherwise — by which an invented age, sex, body-fat or fat-free-mass coefficient reaches a user. The variables are supported model *inputs*; they are not automatic adjustments.

> **SUPPORTED MODEL INPUT ≠ AUTOMATIC ADJUSTMENT**

### 3.4 Fat-free mass

```
fat_free_mass_kg = body_weight_kg × (1 − body_fat_percent / 100)
```

Derived only when `bodyFatPercent` is present and within a validity band. Implausible values are rejected, not clamped and not silently used. Missing body-fat data leaves `fatFreeMassKg` **undefined** — never zero — and TEF calculation proceeds unaffected.

No fixed proportional relationship between lean mass and TEF is assumed. Fat-free mass is an explicit model input whose relationship is owned entirely by the versioned policy.

### 3.5 Confidence reflects what was APPLIED, not what was AVAILABLE

This distinction prevents the product from implying personalization it did not perform.

| Confidence | Condition |
|---|---|
| `basic` | no adjustment changed the estimate (`individualAdjustmentKcal === 0`) — includes every unreviewed policy |
| `profile_adjusted` | ≥1 approved rule materially changed the estimate |
| `personalized` | profile-adjusted **and** an approved personal calibration was applied |

`inputsUsed` flags mean *this input materially affected the result*, not *this input was present in the payload*. A profile carrying body fat under a neutral policy reports `bodyFat: false`.

### 3.6 Personal calibration — reserved, unused

`personalTefModifier?: number` is reserved and **must remain unused** until a scientifically defensible estimation method exists.

Weight trend does **not** uniquely identify TEF. It reflects the combined error of food logging, BMR estimation, wearable activity, water and glycogen shifts, TEF, and ordinary biological variation. Any future calibration adjusts the **complete personal energy model** under strict bounds — it never claims to isolate a personal TEF coefficient from weight change.

### 3.7 Invariants and language

- The LLM may never calculate, adjust, or reason numerically about TEF. `calculateTef` lives in `packages/domain-energy`, which cannot import an LLM SDK — CI-enforced.
- `|individualAdjustmentKcal| ≤ adjustmentBoundFraction × baseMacroTefKcal`.
- Physiological validation ranges are **not** hard-coded in the engine. Unreviewed assumptions ("whole-day TEF is 5–15%") belong in a reviewed, versioned policy; synthetic ranges used to exercise the arithmetic live in the testkit.
- `tefAccruedKcal ≤ tefEstimatedTotalKcal`, always.
- Every persisted energy result records `tefPolicyVersion` and `reviewStatus`. A coefficient change never silently rewrites history.
- **Never described in code, copy, speech or UI as "exact TEF."** The permitted terms are *estimated TEF* and *individualized TEF estimate*, until a direct metabolic measurement exists.

### 3.8 One profile, not two

`TefProfile` is **derived from the same effective-dated user-profile snapshot that produces BMR** — never passed independently. Age, sex, weight and height must not be able to disagree between the BMR calculation and the TEF calculation within a single `computeEnergyState` call. Enforced by construction: the engine derives `TefProfile` internally from `EnergyModelSnapshot`'s profile reference.

## 4. TEF is intake-dependent

Unlike BMR and activity, TEF changes when food is logged. **Every food log updates both `intake_so_far` and `estimated_tef`.** A high-protein meal carries a larger thermic cost than an isocaloric high-fat meal — which MACROS.AI knows exactly, because it captured the food.

---

## 5. Current vs projected TEF — accrual policy

Two distinct quantities, both exposed:

```ts
tefEstimatedTotalKcal   // thermic cost of everything logged today
tefAccruedKcal          // how much of it counts as already expended, per accrual policy
```

**Accrual policy v1 (MVP-0) — deliberately unsophisticated:**

> TEF does **not** contribute to `expenditure_so_far`. `tefAccruedKcal = 0`. `tefEstimatedTotalKcal` is computed, exposed, tested and included in projected expenditure.

Rationale: we cannot defensibly model intra-day digestion timing yet, and counting 100% of a meal's thermic cost the instant it is logged would be false precision that flatters the live balance. The contract distinguishes the two fields now; the accrual curve arrives as a versioned policy upgrade with no engine change.

**Never silently count all TEF immediately.** The accrual policy version is a required output field.

---

## 6. One equation, many activity sources

```
TOTAL ENERGY EXPENDITURE = BMR + ACTIVE ENERGY + TEF

expenditure_so_far = basal_so_far + active_so_far + tef_accrued
projected_total    = BMR + active_so_far + projected_remaining_active + projected_tef
```

This holds for every user, every day and every provider. **There is no second formula.** The old `baseline` / `wearable_component` / `fallback` modes are gone, along with `PAL_FACTORS`, `palFactor`, `tdeeBaselineKcal` and `activityLevel`. A CI rule fails the build if any of them reappears in `domain-energy`.

The engine consumes one activity input:

```ts
interface ActiveEnergyEstimate {
  activeKcalSoFar: number;
  projectedRemainingActiveKcal: number;
  source: 'simulated' | 'wearable' | 'historical_estimate' | 'onboarding_estimate';
  quality: 'observed' | 'partially_estimated' | 'estimated';
  qualityReasons: ActivityQualityReason[];
  confidence?: number;
  coverage?: ActivityCoverage;
  providerId?: string;
  projectionPolicyVersion: string;
  gapFillPolicyVersion: string;
}
```

`energyQuality` ∈ `observed_activity` | `partially_estimated_activity` | `estimated_activity` | `no_activity_source` describes **where the active component came from**, never which formula ran. `observed` means a provider observation rather than a modelled estimate — it makes no claim that a wearable's calorie figure is physiologically exact.

**Quality and completeness are independent axes.** Quality answers *where did the number come from*; `activityCompleteness` answers *is every elapsed interval accounted for*. Observed data with a deterministic gap fill is `partially_estimated` but COMPLETE; observed data with an unfilled two-hour hole is `partially_estimated` and INCOMPLETE.

**MISSING IS NOT ZERO.** `ActiveEnergyResolution` is `available` or `unavailable`. If every sample is rejected and the gap-fill policy supplies no replacement, the result is `unavailable` with a reason — never an estimate of zero activity. A genuine zero is valid only when a provider explicitly supplies usable zero data. Same rule as TEF policy availability.

`tefTreatment` is removed: TEF is always a component.

## 7. No-wearable and cold-start users

Not PAL. An explicit `EstimatedActivityProvider` (contract reserved, deliberately unimplemented) will consume structured onboarding inputs — occupation pattern, typical steps, exercise frequency, duration, type — plus the user's own history, and will supply `activeKcalSoFar` and `projectedRemainingActiveKcal` like any other provider.

Until one exists, a missing estimate is reported as the completeness gap `activity_estimate_missing`. It is never silently replaced by a population multiplier.

## 8. Coverage gaps — estimate the interval, never the day

```
observed active energy  +  estimated active energy for ONLY the missing interval
```

Never `discard wearable → PAL for the whole day`. Untrusted samples are excluded and the interval they covered becomes a gap, handled by a versioned `ActivityGapFillPolicy`. v1 is `none`: a gap contributes zero and lowers the reported quality. Sophisticated gap fill is unimplemented; the contract exists so it needs no engine change later.

Physiological plausibility bounds live in a versioned, review-gated `ActivityPlausibilityPolicy`. No approved production instance ships, so without one no filtering is applied — and that fact is visible in the result.

## 8b. Completeness tells the truth

`tef_policy_missing` and `activity_estimate_missing` are explicit completeness gaps on `EnergyState`. A missing TEF policy is **not** the same fact as a TEF estimate of zero, and the engine never presents `BMR + ACTIVE + 0` as a complete component composition.

## 9. LOCKED balance semantics

```
1  current_balance             = intake_so_far − expenditure_so_far          ← PRIMARY, live
2  target_delta                = chosen end-of-day surplus/deficit
3  projected_total_expenditure = deterministic forecast of today's total
4  remaining_intake            = projected_total_expenditure + target_delta − intake_so_far   ← ACTIONABLE
5  if_no_more_food_balance     = intake_so_far − projected_total_expenditure  ← SECONDARY ONLY
```

**`projected_remaining_active`** comes from a versioned `ActivityProjectionPolicy`. v1 is `none` (forecast nothing beyond what has been observed). A `historical_median` candidate uses **only the user's own past activity** at this hour. There is deliberately no PAL-derived option — a population activity class is not a permitted input to any projection policy.

**`projected_tef` (policy v1):** computed from **logged intake only** — we do not forecast the thermic cost of food not yet eaten. This avoids a circular definition (`remaining_intake` → future intake → future TEF → `projected_total_expenditure` → `remaining_intake`) and avoids inventing a macro split for a meal that hasn't happened. Consequence: `remaining_intake` ticks up slightly as each meal earns its own thermic credit. A fixed-point solve against a default macro split is the versioned upgrade path. **See open item.**

---

## 10. Engine public contract

`packages/domain-energy` is pure: no clock, no IO, no network, no randomness.

```ts
function computeEnergyState(
  input: {
    // The profile snapshot is BOUND INTO the model — no duplicated sex,
    // bodyWeightKg or height fields, so BMR and TEF cannot diverge.
    model: EnergyModelSnapshot;          // effectiveFrom, profile, bmrKcal, bmrMethod,
                                         // bmrPolicyVersion, targetDeltaKcal, goal
    intake: IntakeTotals;
    tefPolicy: TefPolicyHandle;          // available | unavailable(reason)
    activity: ActiveEnergyResolution;    // available(estimate) | unavailable(reason)
    tefProjectionPolicy?: TefProjectionPolicy;
    tefAccrualPolicy?: TefAccrualPolicy;
    asOf: Instant;
    day?: DayBoundary;                   // timezone + rolloverHour (default 04:00)
  },
  calcVersion: string,
): EnergyState;

interface ActiveEnergyEstimate {
  activeKcalSoFar: number;
  projectedRemainingActiveKcal: number;
  source: 'simulated' | 'wearable' | 'historical_estimate' | 'onboarding_estimate';

  quality: 'observed' | 'partially_estimated' | 'estimated';
  qualityReasons: ActivityQualityReason[];

  completeness: 'complete' | 'incomplete';
  completenessGaps: ActivityCompletenessGap[];
  unresolvedIntervals: TimeWindow[];
  unresolvedMinutes: number;

  confidence?: number;
  coverage?: ActivityCoverage;
  providerId?: string;
  projectionPolicyVersion: string;
  gapFillPolicyVersion: string;
}

interface EnergyState {
  intakeSoFarKcal: number;

  basalSoFarKcal: number;
  activeSoFarKcal: number;
  tefAccruedKcal: number;
  expenditureSoFarKcal: number;         // basal + active + tefAccrued

  projectedBasalKcal: number;
  projectedActiveKcal: number;
  projectedRemainingActiveKcal: number;
  projectedTefKcal: number;
  projectedTotalExpenditureKcal: number;

  currentBalanceKcal: number;           // (1) PRIMARY
  targetDeltaKcal: number;              // (2)
  remainingIntakeKcal: number;          // (4) ACTIONABLE
  ifNoMoreFoodBalanceKcal: number;      // (5) SECONDARY ONLY

  tefStatus: 'computed' | 'policy_unavailable';
  tefEstimatedTotalKcal: number | null; // null ≠ 0
  tefBaseMacroKcal: number | null;
  tefIndividualAdjustmentKcal: number | null;
  tefConfidence: 'basic' | 'profile_adjusted' | 'personalized' | null;

  activitySource: ActivitySourceKind | null;
  activityQuality: ActivityQuality | null;
  activityQualityReasons: ActivityQualityReason[];
  activityCompleteness: 'complete' | 'incomplete' | null;
  activityCompletenessGaps: ActivityCompletenessGap[];
  activityUnresolvedMinutes: number | null;
  activityUnavailableReason: ActiveEnergyUnavailableReason | null;
  activityCoverageRatio: number | null;
  activityConfidence: number | null;
  activityProviderId: string | null;

  energyQuality: EnergyQuality;
  energyCompleteness: 'complete' | 'incomplete';
  completenessGaps: ('tef_policy_missing' | 'activity_estimate_missing'
                    | 'activity_coverage_incomplete')[];

  elapsedDayFraction: number;

  calcVersion: string;
  bmrPolicyVersion: string;
  tefPolicyVersion: string | null;
  tefPolicyReviewStatus: ReviewStatus | null;
  tefProjectionPolicyVersion: string;
  tefAccrualPolicyVersion: string;
  activityProjectionPolicyVersion: string | null;
  activityGapFillPolicyVersion: string | null;
}
```

There is no `mode` field, no `palFactor`, no `tdeeBaseline` and no `tefTreatment`. TEF is always a component.

**Canonical interval accounting.** Unresolved activity time is a real set operation:

```
unresolved = ( provider gaps ∪ rejected-sample intervals ∪ stale tail )
             minus accepted-sample intervals,  clipped to the elapsed window
```

unioned and deduplicated, so overlapping gaps are never counted twice. A rejected sample does not merely lose its calories — the minutes it covered become unresolved unless another accepted sample covers them.

**No double counting of calories.** A canonical `NormalizedActivityWindow` must contain deduplicated, non-overlapping intervals. Overlapping records — two devices reporting the same hours — are rejected with a structured error, never summed. Source-priority deduplication belongs in provider adapters.

**Runtime validation** rejects malformed provider data loudly rather than clamping it: negative or non-finite energy, confidence outside [0,1], inverted intervals, gaps outside the window, coverage ratios outside [0,1], `lastSampleAt` outside the window.

## 11. Guardrails, trust gating, recompute

**Guardrails** (engine, not UI): target intake never below `max(1200 (F) / 1500 (M) kcal, 0.7 × BMR)`; deficits > 1000 kcal/day and surpluses > 700 kcal/day require explicit confirmation.

**Sample admission** is governed by the versioned, review-gated `ActivityPlausibilityPolicy` (max daily active kcal per kg body weight, minimum sample confidence, staleness window). **No approved production instance ships**, so without one no physiological filtering is applied — and that fact is visible in the result. Rejected samples surrender their calories *and* leave their interval unresolved. There is no whole-day fallback, because there is no baseline model to fall back to.

**Recompute** is invalidated by a new or corrected log (which changes TEF as well as intake), an activity sync or backfill, a model change, a weight measurement, or a version bump in `calcVersion`, `tefPolicy`, or the accrual policy. Idempotent, keyed by `(user_id, day)`, written alongside rather than over. A closed day moving beyond threshold is surfaced with its cause.

---

## 12. Calibration hook (contract now, implementation later)

```
bmr_adjusted        = BMR × k_bmr                 // basal-model calibration
activeKcal_adjusted = activeKcal × k_provider     // per-provider bias correction
tef_adjusted        = TEF × k_tef                 // only where scientifically defensible
                                                  // plus whole-model longitudinal calibration
```

Component-based, never a PAL multiplier. Derived from EWMA weight trend, logged intake and logging completeness over ≥21 days; bounded drift; effective-dated. Not implemented in MVP-0 or MVP-1 core.

Weight trend does not uniquely identify any single component — it reflects the combined error of logging, BMR, activity and TEF — so calibration adjusts the whole personal energy model under strict bounds rather than claiming to isolate one term.

---

## 13. Macro engine

```
target_kcal = projected_total_expenditure + target_delta
protein_g   = 1.6–2.2 g/kg body mass, goal-dependent    [floor, priority]
fat_g       = max(0.6 g/kg, 20% of target_kcal / 9)     [floor]
carb_g      = (target_kcal − 4·protein_g − 9·fat_g) / 4 [remainder, clamped ≥ 0]
remaining_X = target_X − consumed_X
```

Note the feedback loop this creates and which the tests must pin: a higher-protein target raises TEF, which raises `projected_total_expenditure`, which raises `target_kcal`. Under policy v1 (projected TEF from logged intake only) the loop does not run away, because targets do not feed forward into projected TEF.

Rounding centralized: full precision internally, round-half-up at display, so displayed macros never contradict displayed calories.

---

## 14. Dashboard product contract (LOCKED)

```
CURRENT            −187 kcal          ← current_balance   (1)  PRIMARY
TARGET EOD         +250 kcal          ← target_delta      (2)
EAT TO TARGET      ~725 kcal left     ← remaining_intake  (4)  ACTIONABLE

PROTEIN  42 g remaining
CARBS    XX g remaining
FAT      XX g remaining

Supporting: calories consumed · calories expended so far · projected expenditure today
            · component breakdown (BMR / active / TEF)
            · activity source, quality and completeness
```

Surplus/deficit remains the north-star KPI. The dashboard never presents "calories eaten today" as the primary figure, and `if_no_more_food_balance` never occupies the CURRENT tile.

---

## 15. The differentiator, stated plainly

```
MEASURED FOOD → DETERMINISTIC NUTRITION → MACRO-SPECIFIC TEF → PROFILE-ADJUSTED (INDIVIDUALIZED) TEF
                                                    +
                          USER PROFILE → BMR
                                                    +
                          WEARABLE → ACTIVE ENERGY (EAT + NEAT)
                                        ↓
                          PERSONAL ENERGY EXPENDITURE
                                        ↓
              CURRENT SURPLUS / DEFICIT → PROJECTED DAILY EXPENDITURE
                                        ↓
                      HOW MUCH THE USER SHOULD STILL EAT
```

This is not "food calories + Apple Watch calories." It is a component-based personal energy model in which MACROS.AI owns two of the three components outright — and the TEF component is individualized to the user's body profile rather than assumed to be a generic 10% of calories. The aim is **the best defensible individualized TEF estimate**: neither a generic assumption nor false laboratory-level precision.
