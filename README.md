# MACROS.AI — Phase 0 + Phase 1

Deterministic core domain. **No Postgres, no API, no UI, no scale, no voice, no AI.**

## Verify

```bash
npm run verify     # purity -> typecheck -> tests
```

Requires the workspace symlinks in `node_modules/` (already present) or `pnpm install`.

## What is here

| Package | Purpose |
|---|---|
| `@macros/contracts` | Every shape and validator. Single source of truth. |
| `@macros/domain-nutrition` | `calculateNutrition` — per-100 g basis scaling. PURE. |
| `@macros/domain-energy` | BMR, TEF, active-energy composition, the five locked quantities. PURE. |
| `@macros/domain-macros` | Macro targets, remaining, safety guardrails. PURE. |
| `@macros/activity-provider` | `EnergyActivityProvider` + `SimulatedActivityProvider`. |
| `@macros/testkit` | Fixtures, synthetic policies, property helper. **Dev only.** |

## The energy model

**PAL has been removed from the canonical MACROS.AI Energy Engine.**

```
TOTAL ENERGY EXPENDITURE = BMR + ACTIVE ENERGY + TEF
```

One equation, always. What varies between users and days is the **source and
quality of the ACTIVE component**, never the formula.

```
expenditure_so_far = basal_so_far + active_so_far + tef_accrued
projected_total    = BMR + active_so_far + projected_remaining_active + projected_tef
```

| Component | Source |
|---|---|
| BMR | profile, Mifflin-St Jeor, one canonical source |
| ACTIVE | wearable / simulated / historical estimate / onboarding estimate — EAT + NEAT |
| TEF | computed by MACROS.AI from logged macros, individualized, versioned policy |

There is no `PAL_FACTORS`, no `palFactor`, no `tdeeBaselineKcal` and no
`activityLevel` in the energy package. A CI rule fails the build if any of them
reappears. If an activity questionnaire ever exists it feeds an
`EstimatedActivityProvider`; it never multiplies BMR.

Partial or untrusted wearable data is never discarded in favour of a whole-day
population estimate. Excluded intervals become coverage gaps handled by a
versioned `ActivityGapFillPolicy` (v1 contributes zero and lowers reported
quality).

## The safety property

No approved TEF policy exists. `loadProductionTefPolicy()` returns
`{ status: 'unavailable' }` rather than a placeholder coefficient set.

While a policy is `PENDING_EXTERNAL_REVIEW`, every individual-adjustment rule
must be `{ kind: 'none' }` — validated at load. So
`individualAdjustmentKcal === 0` and `individualized === base` exactly.
There is no configuration path by which an invented age, sex, body-fat or
lean-mass coefficient reaches a user.

Synthetic test policies carry `provenance: 'SYNTHETIC_TEST'` and are rejected
by production entry points by discriminant. `TEST_TEF_POLICY` coefficients are
artificial and prove arithmetic only — they are **not** approved values.

## Completeness tells the truth

`tef_policy_missing` and `activity_estimate_missing` are reported as explicit
completeness gaps. A missing TEF policy is **not** the same fact as a TEF
estimate of zero, and the engine never presents `BMR + ACTIVE + 0` as a
complete component composition.

## Scale spine

```
raw scale readings
  → validation → session admission → deterministic stability
  → StableWeightCandidate → explicit capture intent → WeightCapture
```

**A stable weight is not a food capture.** Stability produces a candidate; only
`capture_requested` turns one into a `WeightCapture`. That separation lets a
user place food, have it settle, and only then say what it is.

- Representative value: **median** of the stable window, quantized to the
  device's declared resolution. Both are versioned policy, not hard-coded.
- Candidates expire (`maxStableCandidateAgeMs`) and are invalidated by material
  change, clearing, tare, overload, calibration, fault, disconnect or reboot.
- Capture requests are idempotent by `requestId`.
- `awaiting_clear` prevents the same portion being captured twice.
- Command acks never change state without a matching pending command; an
  applied tare must carry exactly `currentGeneration + 1`.
- A manual capture carries truthful provenance only — no stability policy, no
  fabricated evidence, no device fields.

No BLE, no firmware, no transport library. `ScaleTransport` is types only.

**Verified:** 285 tests, 59 suites, 0 failures; purity OK; typecheck 0 errors.

## Food-logging vertical slice

```
Selected ProductVersion + WeightCapture
  → deterministic NutritionSnapshot (calculated once, frozen)
  → immutable FoodLogItem
  → daily IntakeTotals (from stored snapshots)
  → MacroState + EnergyState recompute
```

- `packages/domain-food-log` — PURE: capture + product → log item; log items → daily totals.
- `packages/core-loop` — PURE orchestration: `logFoodAndRecompute(...)`.
- Product fixtures are **SYNTHETIC test data**, not catalog data. No ingestion,
  no images, no persistence.
- **The nutrition day is the user's local calendar day, midnight boundary.**
  `DEFAULT_DAY_BOUNDARY.rolloverHour` is `0`; the old hidden 04:00 rollover is gone.
- Every log stores the UTC instant, IANA timezone and the UTC offset in force at
  that instant, so DST history reconstructs correctly.
- Daily totals sum **stored snapshots**, never live product data, so a later
  product correction cannot rewrite yesterday.
