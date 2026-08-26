# CHANGE REPORT — Owner Rulings A–H Applied

**Date:** 2026-08-10 · **Trigger:** owner rulings A–H + energy-balance correction · **Code written:** none

---

## 1. Documents rewritten in full

| File | Why |
|---|---|
| `DECISION-LOCK.md` | v2. All eight decisions moved from REQUIRES MY APPROVAL to LOCKED or DIRECTION APPROVED + legal. Adds locked energy semantics, voice-first contract, AI contract, and a 9-item still-open list. |
| `06-energy-balance.md` | Arithmetic correction + locked semantics. The single largest change in this cycle. |
| `10-phases-and-mvp.md` | Re-cut from one MVP boundary into MVP-0 / MVP-1 / Post-MVP. |
| `15-open-decisions.md` | Converted from an open register to a resolved-status register; superseded by the Decision Lock. |

## 2. Documents edited in place

| File | Change |
|---|---|
| `02-system-architecture.md` | Dependency invariant corrected: no *deterministic* module may depend on `ai`; `voice` is an AI-adjacent edge module and may. |
| `04-database.md` | "pgvector lives ONLY in `knowledge`" corrected — the rule is *no product nutrition facts in vectors*; name embeddings in `food` are permitted. |
| `05-food-data.md` | License-firewall subsystem replaced by licensing metadata (ruling C). Crowd-sourced/ODbL tier marked NOT INGESTED. Image sourcing changed from in-house photography mandate to mixed authorized supply (ruling D). |
| `07-ai-architecture.md` | `getScaleWeight()` removed as a server-side tool; weight travels in the turn payload. |
| `08-voice.md` | Fast-path latency budget corrected 900 ms → 1,300 ms (cloud-ASR finalization was unbudgeted). |
| `09-device-and-scale.md` | Locked tablet hardware spec added (ruling F). Barcode-via-phone and optional rear module recorded. Corner-load control added to the scale requirement. False "voice degrades to fast paths offline" claim removed (ruling G). |
| `12-security-privacy.md` | 18+ only (ruling E): `minor` role removed, COPPA scope removed, minor-specific retention and guardrail branches deferred to the future dependent-profile track. |
| All 16 | Supersession banner pointing at `DECISION-LOCK.md` and this report. |

## 3. Substantive corrections (not scope changes)

1. **TEF double-count removed.** `TDEE_baseline = BMR × PAL` already embeds the thermic effect. The prior `06` added `0.10 × intake` on top — a systematic ~10% inflation of expenditure, roughly 260 kcal/day, larger than a typical target delta. The activity term was also circular (`TDEE_baseline − BMR − TEF_expected`, where TEF depends on intake). Now: `activity_component_base = TDEE_baseline − BMR`.
2. **Hero KPI rejected and replaced.** `consumed − full_day_TDEE` is demoted to `if_no_more_food_balance`, secondary context only. `current_balance = intake_so_far − expenditure_so_far` is the primary live value.
3. **Latency budget made honest** (900 → 1,300 ms).
4. **Offline voice claim withdrawn** — cloud ASR is required for every voice path, fast paths included.
5. **RLS posture** — flagged in the audit, unchanged here; the API-runs-as-session-user correction lands with Phase 7.

## 4. Scope restored (previously recommended for removal, now required)

| Item | New status |
|---|---|
| Wearable integration | **MVP-1 required** — via `EnergyActivityProvider`, normalized, source-tagged, confidence-aware, replaceable, calibratable |
| Mobile companion | **MVP-1 required** — bounded remit, must not compromise kitchen-first tablet UX |
| Optional activity input in the energy contract | **Phase 0** — present from day one specifically to avoid an MVP-1 engine rewrite |

## 5. Scope removed or deferred by ruling

| Item | Status |
|---|---|
| Minor / dependent profiles | Removed from MVP-0 and MVP-1; separate future safety + legal track |
| Front-facing camera | Not required; barcode via companion phone in MVP-1 |
| In-house photography of every product | Withdrawn; mixed authorized supply |
| License-firewall subsystem | Withdrawn; licensing metadata only |
| On-device ASR / offline voice | Post-MVP-1; SoC headroom reserved; not marketed before it exists |
| ODbL and commercial food datasets | Blocked pending legal review |

## 6. Unchanged and reaffirmed

Deterministic-first architecture · pure domain packages that cannot import an LLM SDK · LLM as router/narrator only · per-100g canonical nutrition basis · immutable product versions referenced by logs · immutable append-only logs with stored nutrition snapshots · surplus/deficit as the north-star KPI · voice-first MVP-1 core interaction · A/B/C/D visual selection as a core requirement.

## 7. Net effect on the plan

MVP-0 gets **smaller and sharper** (touch-first, single user, simulated activity, no voice, no LLM). MVP-1 gets **larger than the audit proposed** (wearables and mobile restored) but is unchanged in shape from the original product thesis. The Phase 0 contract set grows by exactly one interface — `EnergyActivityProvider` — which is the change that makes the restored scope cost nothing later.

---

# CHANGE REPORT — v3: Component-Based TDEE

**Date:** 2026-08-10 · **Trigger:** owner ruling, component-based energy architecture · **Code written:** none

## 1. The reversal

v2 locked "TEF is not modeled explicitly; PAL already embeds it." **That lock is reversed.** TEF becomes a first-class deterministic component computed by MACROS.AI from logged macros. The v2 lock was correct *only* for a PAL-based model; it is wrong for a component-based one, where TEF must be summed because nothing else supplies it.

Both statements are now true simultaneously, per mode — which is why §6.2 of `06` exists.

## 2. Documents changed

| File | Change |
|---|---|
| `06-energy-balance.md` | **Rewritten to v3.** Component model `BMR + ACTIVE + TEF`; `TefPolicy` and `calculateTef`; `tefEstimatedTotalKcal` vs `tefAccruedKcal`; three modes with two hard invariants; coverage contract; expanded `EnergyState`. |
| `DECISION-LOCK.md` | Energy semantics section replaced with the component model. Still-open list gains items 4b (projected TEF rule) and 4c (TEF coefficients pending external review). |
| `15-open-decisions.md` | D-06 re-locked and reversed. D-10 re-locked: PAL leaves the expenditure sum in component mode. |
| `07-ai-architecture.md` | TEF added explicitly to the never-originates list. |
| `10-phases-and-mvp.md` | TEF policy, accrual policy v1, component mode, coverage-aware fallback added to MVP-0/MVP-1; accrual curve and gap-fill to Post-MVP. |

## 3. Two arithmetic traps this ruling created, and the rules that close them

**Trap 1 — TEF double-count in baseline mode.** `BMR × PAL` already embeds TEF, because PAL factors are derived from total daily expenditure. Adding `estimated_tef` on top in baseline mode re-creates the ~10% inflation we removed in v2.
**Rule (`06 §6.2`):** TEF is computed and exposed in every mode but contributes **zero** to expenditure in `baseline` and `fallback`, tagged `tefTreatment: 'embedded_in_pal'`. Summed only in `wearable_component`.

**Trap 2 — circular `remaining_intake`.** `remaining_intake` depends on `projected_total_expenditure`, which includes projected TEF, which depends on total intake, which includes `remaining_intake`.
**Rule (`06 §9`, policy v1):** projected TEF is computed from **logged intake only**. No forecast of the thermic cost of uneaten food, no invented future macro split, no fixed-point solve. Consequence: `remaining_intake` rises slightly with each logged meal as it earns its own thermic credit. A fixed-point solve against a default macro split is the versioned upgrade path. **Requires owner confirmation (still-open item 4b).**

## 4. Invariants now enforced by test, not convention

1. `wearable_component` expenditure never contains a PAL-derived activity term.
2. `baseline` / `fallback` expenditure never sums TEF.
3. TEF derived exclusively from deterministically logged nutrition.
4. `tefAccruedKcal ≤ tefEstimatedTotalKcal`, always.
5. `estimated_tef ≤ 0.35 × logged_kcal` for any input.
6. Mixed-diet whole-day TEF lands in ~8–12% of logged kcal.
7. No `domain-*` package can reach an LLM SDK.
8. Partial wearable coverage never produces a partial PAL top-up.

## 5. Net effect

The first coding milestone grows by one pure function (`calculateTef`), one versioned policy object (`TefPolicy`), three `EnergyState` fields, and the coverage contract. No engine rewrite is required later to add real providers, the accrual curve, or gap-fill — which was the point of specifying all three now.

---

# CHANGE REPORT — v4: Individualized TEF

**Date:** 2026-08-10 · **Trigger:** owner ruling, TEF must be individualized · **Code written:** none

## 1. What changed

TEF is no longer a universal macro percentage. `base_macro_tef` (meal composition) is now separated from `individualized_tef` (base + a single composed, bounded adjustment from the user's body profile). Contracts added: `TefProfile`, `TefPolicy` with `individualAdjustmentModel`, `VersionedAdjustmentRule`, `TefResult`. `EnergyState` gains `tefBaseMacroKcal`, `tefIndividualAdjustmentKcal`, `tefConfidence`, `tefPolicyReviewStatus`.

| File | Change |
|---|---|
| `06-energy-balance.md` | §3 rewritten and expanded to §3.1–3.8. `EnergyState` and engine inputs updated. Differentiator diagram updated. |
| `DECISION-LOCK.md` | TEF bullet rewritten for individualization; open items 4d (adjustment model review) and 4e (body-fat validity band) added. |
| `10-phases-and-mvp.md` | TEF rows split: contracts and base calculation in MVP-0; `profile_adjusted` pending review; `personalized` reserved. |
| `15-open-decisions.md` | D-06 note updated for individualization. |

## 2. The safety property that makes this shippable

> While `reviewStatus === 'PENDING_EXTERNAL_REVIEW'`, every rule in `individualAdjustmentModel` must be `{ kind: 'none' }` — validated at policy load, enforced by test.

`individualAdjustmentKcal === 0` and `individualized_tef === base_macro_tef` **exactly** until a reviewer approves the model. There is no configuration path by which an invented age, sex, body-fat or fat-free-mass coefficient reaches a user. The architecture supports the variables today; the physiology arrives later, reviewed, versioned and traceable.

## 3. Two honesty rules added

1. **Confidence reflects what was applied, not what was available.** A profile carrying body fat under a neutral policy still reports `confidence: 'basic'` and `inputsUsed.bodyFat: false`. Otherwise the product would advertise personalization it did not perform.
2. **Never "exact TEF."** Permitted language is *estimated TEF* / *individualized TEF estimate*, in code, copy, speech and UI, until a direct metabolic measurement exists.

## 4. One divergence risk closed

`TefProfile` is derived internally from the same effective-dated profile snapshot that produces BMR — never passed independently. Age, sex, weight and height cannot disagree between the BMR and TEF calculations inside one `computeEnergyState` call.

## 5. Unchanged

All v3 invariants hold: no PAL in `wearable_component` expenditure · no TEF summed in `baseline`/`fallback` (PAL embeds it) · projected TEF from logged intake only · `tefAccrued = 0` under accrual policy v1 · no LLM path to any of it.


---

# CHANGE REPORT — v5: PAL Removed from the Energy Engine

**Date:** 2026-08-11 · **Trigger:** owner ruling, component-based TDEE without PAL · **Scope:** core-domain patch only

## 1. The removal

`BMR × PAL` is gone from production domain logic. There is now one equation —
`BMR + ACTIVE + TEF` — in every case. The modes `baseline`,
`wearable_component` and `fallback` are replaced by *provenance*: what varies is
the source and quality of the ACTIVE component, never the formula.

**Deleted:** `PAL_FACTORS`, `ActivityLevel`, `palFactor`, `tdeeBaselineKcal`,
`activityLevel`, `EnergyMode`, `tefTreatment` / `embedded_in_pal`,
`assessActivityTrust`, `ACTIVITY_TRUST`, `activity-window.ts`,
`ACTIVITY_PROJECTION_CONSERVATIVE` (its PAL bound), `TEF_SANITY`,
`tefWithinSanityBounds`, and `data/golden/energy-baseline.json`.

**Added:** `ActiveEnergyEstimate`, `ActivitySourceKind`, `ActivityQuality`,
`ActivityQualityReason`, `ActivityGapFillPolicy`, `ActivityPlausibilityPolicy`,
`EnergyCompletenessGap`, `buildActiveEnergyEstimate`, `fillActivityGapKcal`,
`ACTIVITY_PROJECTION_HISTORICAL_MEDIAN`, `EstimatedActivityProviderContract`,
and `data/golden/energy-component.json`.

## 2. Documents changed

| File | Change |
|---|---|
| `06-energy-balance.md` | v4. §1 BMR de-PAL'd; §6–8 replaced with one-equation / provenance / gap-fill; §8b completeness; projection de-PAL'd; TEF sanity relocated. |
| `DECISION-LOCK.md` | Energy section rewritten as the component model. Open item 4 resolved; 4f and 4g added. |

## 3. Why one guard exists that the ruling did not ask for

Removing PAL creates a new failure mode: someone reintroduces it later "just for
cold-start users." So the purity checker now fails the build if `PAL_FACTORS`,
`palFactor`, `tdeeBaseline`, `activityLevel` or a `BMR * PAL` expression appears
anywhere in `domain-energy`, and negative tests prove the guard fires.

## 4. Remaining open scientific decisions

TEF macro coefficients · TEF individual-adjustment model · body-fat validity
band · activity plausibility bounds · macro-distribution values · guardrail
floors · confirmation of the `BmrPolicy` approved marking. All versioned, all
review-gated, none blocking the next milestone.

---

# CHANGE REPORT — v6: Activity Integrity + Document Consistency

**Date:** 2026-08-12 · **Trigger:** owner ruling, activity integrity patch · **Scope:** deterministic energy spine + docs

## 1. Activity gap accounting

Added `domain-energy/intervals.ts`: a pure interval algebra (`union`, `subtract`, `clip`, `totalMinutes`). Unresolved activity time is now a real set operation:

```
unresolved = ( provider gaps ∪ rejected-sample intervals ∪ stale tail )
             − accepted-sample intervals,  clipped to the elapsed window
```

A rejected sample no longer merely loses its calories — the minutes it covered become unresolved unless another accepted sample covers them. Overlapping gaps are unioned, never double counted.

## 2. Overlap invariant

`validateNormalizedActivityWindow` rejects overlapping samples with a structured error distinguishing exact duplicates from partial overlaps. Adjacent intervals (`end === start`) are accepted. `resolveActiveEnergy` validates before summing, so two devices reporting the same hours can no longer inflate active energy.

## 3. Missing vs zero

`resolveActiveEnergy` returns `ActiveEnergyResolution` — `available(estimate)` or `unavailable(reason)`. All samples rejected with no fill → `unavailable`, never a zero estimate. An explicit valid zero observation stays a genuine zero. Mirrors the TEF policy-availability rule.

## 4. Completeness separated from quality

`ActivityCompleteness` + `ActivityCompletenessGap` (`coverage_gap_unfilled`, `rejected_sample_interval_unfilled`, `stale_tail_unfilled`, `no_usable_activity_samples`) are independent of quality. Propagated to `EnergyState` as `activityCompleteness`, `activityCompletenessGaps`, `activityUnresolvedMinutes`, `activityUnavailableReason`, and into `energyCompleteness` via `activity_coverage_incomplete`.

## 5. Gap-fill reports whether it filled

`fillActivityGap` returns `ActivityGapFillResult` (`filled` with kcal, or `unfilled`) rather than a number. Zero no longer means both "estimated zero" and "no estimate".

## 6. Stale tail

Elapsed time after the last usable observation becomes an unresolved interval when it exceeds the policy staleness window. Earlier observed energy is retained in full — no whole-day reset.

## 7. Runtime validation

`contracts/activity-validation.ts`: sample, coverage, window and estimate validators. Malformed provider data is rejected loudly, never silently clamped.

## 8–9. Terminology and profile de-duplication

`measured` → `observed`; `measured_activity` → `observed_activity`. `EnergyModelSnapshot` no longer duplicates `sex` or `bodyWeightKg` — they are read from `model.profile`, so a hand-constructed model cannot claim different values for BMR and TEF.

## 10. BMR self-approval reversed

`DEFAULT_BMR_POLICY.reviewStatus` is now `PENDING_EXTERNAL_REVIEW`. Selecting Mifflin-St Jeor as the implementation equation is recorded as a different fact from an externally reviewed production policy. A test asserts no shipped policy in any production package claims `APPROVED`.

## 11. Document cleanup

`06-energy-balance.md` §10 public contract rewritten to match the code; stale `mode`, `tefTreatment`, `tdeeBaseline`, `0.2×–2.5×` trust gating and `PAL_effective = PAL × k_user` calibration removed. Calibration is now component-based. Decision Lock section A rewritten around providers; activity-threshold open items consolidated into a single authoritative `ActivityPlausibilityPolicy` item.

## 12. Verification

158 → **195 tests**, 40 suites, 0 failures. Architecture purity OK. Typecheck 0 errors.

---

# CHANGE REPORT — v7: Scale Protocol + Simulator + Weight Capture

**Date:** 2026-08-12 · **Trigger:** first physical-product milestone · **Scope:** scale spine only

## Cleanups applied first

**A.** `validateNormalizedActivityWindow` now rejects samples extending outside their declared coverage window — rejected, never silently clipped. Four tests added.
**B.** `06-energy-balance.md` terminology updated to `observed` / `observed_activity`; stale dashboard wording referring to an energy `mode` replaced with activity source, quality and completeness.

## Packages created

| Package | Purity | Contents |
|---|---|---|
| `@macros/scale-protocol` | PURE | Logical transport-independent protocol, capabilities, stability policy type, session/sequence admission, corner-load qualification record |
| `@macros/domain-weight` | PURE | Rolling-window stability, weight-capture state machine |
| `@macros/scale-simulator` | production | Deterministic in-memory scale |

## Key decisions

- **No BLE, no firmware, no vendor UUIDs.** The transport interface is types only.
- **No validated stability policy ships.** `loadProductionStabilityPolicy()` returns `unavailable / pending_hardware_validation`; the synthetic policy lives in the testkit. Same pattern as TEF.
- **No corner-load compensation.** Only the qualification record shape is defined. Off-centre error is a mechanical requirement.
- **Firmware stability flags are advisory** — the host runs its own policy so behaviour is consistent across suppliers.
- **Reading ≠ capture.** Raw readings may be slightly negative and are never clamped; a food capture must be greater than zero.
- **`WeightCapture` contract refined**: `source` narrowed to `scale | manual`, with device provenance, tare generation, stability policy version and stability evidence. `weightStability` removed from `FoodLogItem` in favour of evidence plus policy version.

## Purity enforcement extended

Two pure packages added to the scan, plus a new `no-transport-libs-in-production` rule covering React Native, BLE, serial, USB and HID libraries. The synthetic-policy rule was **tightened** from any occurrence of the literal to `provenance: 'SYNTHETIC_TEST'` as a value — a type union declaring the literal is legitimate. Four negative tests added.

## Verification

195 → **245 tests**, 55 suites, 0 failures. Purity OK. Typecheck 0 errors.

## Documentation

`09-device-and-scale.md` rewritten around the implemented protocol: capabilities, transport-independent messages, reading-vs-capture pipeline, stability semantics, capture lifecycle, tare, overload, reconnect, transport boundary, hardware validation requirements, open hardware decisions. Earlier BLE/OTA sketches retained as a clearly marked superseded appendix.

---

# CHANGE REPORT — v8: Stable Candidate + Explicit Capture Intent

**Date:** 2026-08-12 · **Scope:** scale spine hardening. No food-logging integration.

## 1. The product correction

**A stable weight is no longer a food capture.** Stability now produces a `StableWeightCandidate`; only explicit host intent (`capture_requested`) turns one into a `WeightCapture`. This is what lets a user place food, have it settle, and only then identify it — essential for the voice-first flow, where selection often completes after the weight is already stable.

Both flows are supported: **stable-then-request** captures immediately from the existing candidate, and **request-then-stable** arms the intent and fires when the candidate appears.

## 2. Session and protocol integrity

- **Command acks are validated** against protocol version, device, boot, a genuinely pending command id and kind. An applied tare must carry exactly `currentGeneration + 1`. An unsolicited "applied" ack changes nothing.
- **Tare generation never silently jumps** — higher is now `rejected_unexpected_tare_generation` rather than adopted.
- **Only a validated `connected` event establishes a boot.** `knownBootOrder` removed; a reading with an unknown boot is `rejected_boot_mismatch`.
- **A wrong-device disconnect no longer drops the current scale.**
- **Runtime validation** added for capabilities, acks, and connect/disconnect payloads; negative `deviceUptimeMs` rejected.

## 3. Correctness fixes

- **Representative method is now policy-driven and defaults to `median`**, replacing the hard-coded trailing sample. The earlier `latest` choice let an isolated edge-of-window jitter value become the logged weight.
- **Resolution quantization** added: the accepted value is rounded to the device's declared `resolutionGrams` by a deterministic, versioned rule.
- **Candidate freshness** (`maxStableCandidateAgeMs`) prevents a late request from capturing a stale settled reading.
- **Manual provenance corrected:** a manual capture no longer carries `stabilityPolicyVersion`, and the validator now rejects any manual capture claiming stability policy, evidence or device provenance.

## 4. Documentation

`09-device-and-scale.md`: scale component assumptions (ADC, MCU, RTOS, battery, firmware storage) demoted from LOCKED to **REFERENCE / TO EVALUATE** — only the owner-ruled requirements remain locked. The contradictory appendix (which claimed stability detection lives in firmware) has been **removed** and replaced with a short historical pointer, leaving exactly one actionable scale architecture.

## 5. Test count reconciliation

The previous report said 249 and the change report said 245; the 245 figure was recorded before the final purity negative tests were added. Both are superseded by a fresh full run: **285 tests, 59 suites, 0 failures.**

---

# CHANGE REPORT — v9: Capture-Intent Hardening + First Food Vertical Slice

**Date:** 2026-08-12

## Part A — capture-intent correctness

- **Single active intent.** `requests[]` replaced by `pendingCaptureRequest` plus bounded `terminalRequests`. A second distinct request is rejected `capture_request_already_pending`; the pending one is never evicted by the bound.
- **Rejected requests are never armed.** Requests during `awaiting_clear` / `disconnected` / `overload` / `calibration_required` / `fault` are refused and not stored.
- **Invalidating events cancel an unfulfilled intent** — platform cleared, tare applied, device fault, disconnect, new session — each with a recorded `CaptureCancellationReason`. Regression-tested: an intent for food A can never attach to food B.
- **No time travel.** Freshness is now `0 ≤ requestAt − observedAt ≤ max`; a backwards timestamp is `invalid_request_time` and is refused outright, not armed.
- **Request validation:** empty `requestId` → `invalid_request`; unparseable timestamp → `invalid_request_time`.
- **Pending command not overwritten;** `validateScaleCommand` added; ack structural validation ensures an unknown outcome cannot resolve a pending command.
- **Scale capture provenance** gains `resolutionGrams` and `resolutionQuantization`; manual captures still carry none of it, and the validator rejects manual captures claiming device or stability provenance.
- **Document fixed:** `09` no longer lists `manual_entry` under `ScaleEvent`; device events and host capture intent are shown as separate streams.

## Part B — first deterministic food vertical slice

`ProductVersion` + `WeightCapture` → `NutritionSnapshot` → immutable `FoodLogItem` → daily `IntakeTotals` → `MacroState` + `EnergyState`.

- `packages/domain-food-log` (PURE) and `packages/core-loop` (PURE) added to purity enforcement — 10 production packages, 7 pure.
- **`DEFAULT_DAY_BOUNDARY.rolloverHour` is now `0`.** The hidden 04:00 rollover is gone; the nutrition day is the user's local calendar day at midnight. `rolloverHour` remains configurable for a future explicit product setting only.
- Logs store UTC instant, IANA timezone and the UTC offset in force at that instant; DST tests cover the fall-back day.
- Daily totals sum **stored snapshots**, never live product data.
- Calories remain **source-derived**; Atwater is a validation signal, not an override.
- Synthetic product fixtures only — explicitly marked, never presented as catalog data.

## Verification

**347 tests · 73 suites · 0 failures.** Purity OK. Typecheck 0 errors.

---

# CHANGE REPORT — v10: Persistence Domain Closure

**Date:** 2026-08-14 · **Status:** IMPLEMENTATION COMPLETE, RUNTIME DB VALIDATION PENDING

## Domain corrections made BEFORE any DB work

| Finding | Class | Resolution |
|---|---|---|
| Idempotency keyed on `logId` alone | BLOCKER | Identity is now `(userId, logId)`; two users can no longer mask each other |
| Duplicate replay reported as success regardless of payload | BLOCKER | `replayed_existing` vs `idempotency_conflict`; canonical stored item always returned |
| `createFoodLogItem` did not use the canonical weight validator | BLOCKER | Uses `validateWeightCapture` and `validateProductVersion` |
| No canonical `ProductVersion` validator | BLOCKER | `validateProductVersion` added, delegating basis rules to `validateNutrientBasis` (no duplication) |
| `isActive` (mutable) inside immutable `ProductVersion` | BLOCKER | Split into `ProductCatalogHead` |
| User A's food could run through user B's model | BLOCKER | `userId` bound into `UserProfileSnapshot`; `assertSubjectConsistency` refuses mismatches |
| Reading-staleness re-applied at log time | BLOCKER | Scoped to the capture boundary; logging would otherwise force food identification within 30 s of weighing |
| `food_logs.product_id` unconstrained (found in final self-review) | BLOCKER | Composite FK `(product_version_id, product_id)` |

## Added

`db/migrations/0001_core_schema.sql`, `0002_rls.sql`, `packages/persistence`
(repository contracts, row codecs, in-memory reference adapters,
`PostgresFoodLogRepository` over an injected `SqlExecutor`, `logFoodPersisted`,
`recomputeDayFromStorage`), `tests/persistence.test.ts`, `16-persistence.md`,
`DEFERRED-DECISIONS.md`.

## Verification

**404 → 405 tests, 82 suites, 0 failures.** Purity OK (11 production packages,
7 pure). Typecheck 0 errors.

**Not verified:** RLS runtime behaviour, real concurrent writes, migration
execution. No PostgreSQL, Docker or Supabase runtime was available and the
package registry is policy-blocked.

---

# CHANGE REPORT — v10: Persistence Domain Closure

**Date:** 2026-08-13 · **Process:** first milestone run as a DOMAIN CLOSURE (preflight → contract closure → implementation → adversarial → integration → docs → gate).

## Preflight

Environment: **no PostgreSQL, psql, Docker or Supabase; no network egress; the workspace is not a git repository.** Runtime DB and RLS validation therefore cannot be executed and are reported as pending, not as tested.

Audit found the four §8 domain corrections already implemented and test-covered: `(userId, logId)` identity with replay-vs-conflict distinction, canonical runtime `WeightCapture` and `ProductVersion` validators at the boundary, `ProductVersion` free of mutable catalog state (`ProductCatalogHead` separate), and subject-consistency binding in the core loop.

## BLOCKER found in final self-review, and fixed

**Numeric column scale vs float artifacts.** Ordinary inputs produce values binary floating point cannot express exactly — 31 g/100 g protein at 247 g is `76.57000000000001`. `numeric(10,4)` rounds on insert, so the CHECK constraints comparing raw JSONB to the rounded column would have **rejected every such food log against a real database**, and the read-back equality check would have thrown. The in-memory repository could never reveal it, because JavaScript has no column scale.

Fixed at the persistence boundary only, without reopening the closed nutrition domain:
- `COLUMN_SCALE` + `toColumnScale` model PostgreSQL's declared scale explicitly on write and read.
- The migration's CHECK constraints round the JSONB side to the same scale.
- `grams` is read back from the **authoritative snapshot**, not the rounded projection column.
- Five regression tests, including one asserting the artifact genuinely occurs and one asserting the migration text rounds at the right scale.

Semantics recorded: the snapshot is authoritative and byte-exact; the first-class columns are a rounded query projection. Daily totals sum snapshots, never projections.

## Files changed

`packages/persistence/src/row-codec.ts`, `db/migrations/0001_core_schema.sql` (never applied anywhere, so amended in place rather than shipping a known-broken migration), `tests/persistence.test.ts`, plus new `DEFERRED-DECISIONS.md` and `16-persistence.md`.

## Verification

**405 → 410 tests, 83 suites, 0 failures.** Purity OK (11 production packages, 7 pure). Typecheck 0 errors.

## Status

**PERSISTENCE DOMAIN — IMPLEMENTATION COMPLETE, RUNTIME DB VALIDATION PENDING.** Not called closed: RLS, migrations and concurrency have never been executed by a real engine.

---

# CHANGE REPORT — v11: MVP-0 Tablet Application Vertical Slice

**Date:** 2026-08-15 · **Process:** domain closure.

## Source control

Workspace is now a Git repository with a `.gitignore` that excludes `node_modules`, build, coverage, env and OS/editor files while **tracking** migrations, golden vectors and documentation. Repository-local identity only; global config untouched. Two commits: the baseline of the verified spine, then this milestone. `git status` clean.

## Toolchain reality

**React Native, Expo, Metro and the RN testing libraries are not installed, and there is no network egress.** No renderer source was written — fabricating framework packages or pivoting to web were both explicitly refused. The application layer is complete; `apps/tablet/README.md` holds screen specifications and component boundaries.

## Created

`packages/tablet-app-core` (ports, state, controller, dev scale adapter), `packages/domain-food-search` (pure deterministic ranking), `apps/tablet/README.md`, `tests/tablet-app.test.ts`, `tests/food-search.test.ts`, `17-mvp0-tablet.md`.

## BLOCKERS found in adversarial testing and fixed

1. **Synthetic user ids were not UUID-shaped** (`'user-a'`). They cannot be inserted into `user_id uuid`, so the whole application would have failed at the real persistence boundary. Fixtures are now UUID-shaped and `assertSubjectBinding` enforces it.
2. **Selecting a food discarded an already-captured weight**, forcing the user to lift and re-place food when they named it second — exactly the behaviour §18 forbids. A held capture now survives selection and completes the review.
3. **The scale adapter and the controller ran on two independent clocks**, so every capture request time-travelled relative to its candidate and was refused. Device events are now stamped with the application clock — one timeline, which is also the production-shaped constraint.
4. **Most synthetic products had no catalog head**, so raw chicken, tofu and almonds were unreachable by search. Heads completed, plus one deliberately de-listed product to prove a de-listed item disappears from search while staying resolvable by id.
5. **`food-log.test.ts` hardcoded `'user-a'`** instead of the shared fixture — caught by the closure gate, not by the tablet suite.

## Verification

**410 → 466 tests, 104 suites, 0 failures.** Purity OK (12 production packages, 8 pure). Typecheck 0 errors.

## Status

**MVP-0 TABLET APPLICATION DOMAIN — CLOSED.** Renderer execution pending toolchain availability; that is a tooling limitation, not an open design question. Persistence remains IMPLEMENTATION COMPLETE / RUNTIME DB VALIDATION PENDING, with an explicit roadmap gate recorded before any external pilot.

---

# CHANGE REPORT — v11: MVP-0 Tablet Application Vertical Slice

**Date:** 2026-08-17

## Source control

The workspace is now a Git repository with a repo-local development identity
(global config untouched), a `.gitignore` that excludes `node_modules` and
secrets while **tracking** migrations, golden vectors and documentation, and
three commits: baseline → tablet slice → purity fix. `git status` is clean.

## Added

`@macros/domain-food-search` (PURE deterministic search), `@macros/tablet-app-core`
(controller, state, ports, dev scale adapter), `apps/tablet` (renderer
specification), `17-tablet-mvp0.md`, plus search and tablet test suites.

## Corrections made during the milestone

- **Synthetic user ids were `user-a` / `user-b`** — not UUID-shaped, and
  therefore **impossible to insert into `user_id uuid`**. A latent persistence
  defect as well as an application one. Fixtures are now UUID-shaped and the
  identity boundary rejects anything else.
- **Two independent clocks.** The scale adapter and the controller each had one,
  so capture requests time-travelled relative to the candidate they asked for.
  The adapter now stamps device events with the application clock — one
  timeline, as in production.
- **Weight-then-food lost the held capture** on selection, forcing the user to
  lift and re-place food. Selection now preserves a capture already taken for
  the flow.
- **`tablet-app-core` was not purity-scanned at all**, so nothing prevented an
  LLM SDK or the test kit entering the application layer. Now scanned, with
  negative tests proving the rule fires.
- `ProductVersionRepository.listSearchable()` added — search needs a catalog
  source, and only versions behind an **active** head may be offered.

## Verification

**410 → 468 tests, 104 suites, 0 failures.** Purity OK (13 production packages,
8 pure). Typecheck 0 errors.

## Status

**MVP-0 TABLET APPLICATION LAYER — CLOSED.**
**RENDERER — PENDING REACT NATIVE TOOLCHAIN.**
Persistence remains implementation-complete with runtime DB validation pending.

---

# CHANGE REPORT — v12: Tablet Correctness Patch + Catalog/Search Closure

**Date:** 2026-08-17 · Commits `7789e9a` (Part A) and `c4c441b` (Part B). Tree clean.

## Part A — six concrete tablet bugs

| | Fix |
|---|---|
| A1 | `captureRequestId`, distinct from `submissionId`. Re-tapping while settling is an idempotent retry, not an error. Released on capture, cancel, manual entry or a new placement. |
| A2 | `cancelWeight()` cancels the armed intent — an abandoned attempt can no longer capture when the scale settles moments later. |
| A3 | Manual entry cancels an armed scale intent, so a later settle cannot overwrite the user's manual choice. |
| A4 | `requiresScaleClearForCurrentSubject` blocks scale capture after a user switch with a loaded platform, lifted only when the host observes a real clear. No fabricated disconnect; the scale domain stays user-agnostic; manual weight stays available. |
| A5 | `selectProduct()` discards results resolved for a cancelled flow or a previous user. |
| A6 | `searchGeneration` ensures only the newest same-flow query lands. |

**T-5 closed:** `listRecentProductVersionIds` on both repository adapters, wired into search, with cross-user isolation proven.

## Part B — catalog and search

Two pure packages (`domain-catalog`, extended `domain-food-search`), one IO package
(`catalog-ingestion`), an import CLI, and version-controlled catalog data.

**Deliberate non-implementations, each for a stated reason:** the USDA adapter
throws rather than guess nutrient ids from memory; no typo tolerance, because the
benchmark shows no failure it would fix and a wrong correction silently logs the
wrong food; no estimated-food entry, so an unknown food returns nothing rather
than an invention.

## Two findings worth recording

**The first benchmark run scored 100% on every metric with aliases contributing
nothing.** That was a warning, not a success: the corpus was satisfiable by name
matching alone and never exercised the alias path. After adding alias-only cases,
aliases measurably move top-1 from **84.2% → 100%**. The metric now measures
something.

**The import CLI initially printed "search top-1 0.0%".** A benchmark corpus
names exact product-version ids, so it only scores the catalog it was authored
against; running it elsewhere yields a meaningless zero that reads like a quality
result. The CLI now skips the benchmark and says so.

## Verification

**468 → 538 tests, 127 suites, 0 failures.** Purity OK (15 production packages,
9 pure). Typecheck 0 errors.

## Status

```
CATALOG/SEARCH ENGINEERING — CLOSED
REAL CATALOG POPULATION — PENDING SOURCE DATA
```

0 real source records ingested. 0 real canonical foods published. Persistence
remains implementation-complete with runtime DB validation pending.
