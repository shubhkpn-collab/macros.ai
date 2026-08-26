# MACROS.AI — PRODUCT DECISION LOCK (v2)

**Status:** Owner rulings applied 2026-08-10. Decisions A–H are LOCKED unless marked otherwise.
**Authority:** These rulings supersede any conflicting recommendation in the Validation Gate or the 16 architecture documents.
**Scope:** No new architecture, features, or scope introduced. No code written.

---

## A — ACTIVE ENERGY / WEARABLES — `LOCKED`

**Ruling.** Daily expenditure must reflect the actual day: a remote-work day, gym day, hiking day, rest day and highly active day must not receive the same estimate.

**The canonical equation never changes:**

```
TOTAL ENERGY EXPENDITURE = BMR + ACTIVE ENERGY + TEF
```

What varies is the **provider of the ACTIVE component**:

| Stage | Provider |
|---|---|
| MVP-0 | `SimulatedActivityProvider` — drives the production equation, not a stand-in engine |
| MVP-1 | wearable provider (Apple Health / Health Connect), `activeKcal` ≈ EAT + NEAT |
| No wearable | explicit `EstimatedActivityProvider` (onboarding / historical), reserved and unimplemented |
| Coverage gaps | versioned `ActivityGapFillPolicy` estimates **only the missing interval** |

**There is no PAL-style fallback concept anywhere.** Wearable output is normalized, source-tagged, confidence-aware, replaceable and calibratable later. It is never treated as ground truth, and it is never added on top of a modelled activity term — there is no modelled activity term.

**Integrity rules, all mechanically enforced:**
- Canonical activity intervals must not overlap. Overlapping records from multiple devices are rejected with a structured error, never summed. Deduplication belongs in provider adapters.
- A rejected sample surrenders its calories **and** leaves its interval unresolved, unless another accepted sample covers those minutes.
- Unresolved time = (provider gaps ∪ rejected intervals ∪ stale tail) − accepted intervals, unioned so overlaps are never double counted.
- A partial wearable day is never discarded for a whole-day estimate. Observed energy is always retained; only the missing interval is a gap-fill candidate.
- **MISSING ≠ ZERO.** No usable activity → `unavailable` with a reason, never an estimate of zero. A genuine zero requires an explicit valid zero observation.
- **Quality ≠ completeness.** Quality is provenance (`observed` / `partially_estimated` / `estimated`); completeness is whether every elapsed interval is accounted for. They are independent.

## B — MOBILE COMPANION — `LOCKED`

**Ruling.** MVP-0 is tablet only. **MVP-1 requires the mobile companion.** The tablet remains the PRIMARY product. Mobile exists for health-platform connection, viewing balance away from the kitchen, manual logging when away from the appliance, profile/settings, weight entry, and later notifications. Mobile requirements must not compromise the kitchen-first tablet UX.

**What changes.** Mobile returns to MVP-1 scope with a bounded remit. It is the delivery mechanism for Apple Health / Health Connect data. `10` re-cut accordingly.

**Irreversible/expensive.** Low — API contracts are client-agnostic. The standing risk is scope drift: any mobile requirement that degrades the tablet experience is rejected by default.

**Deadline.** Was pre-Phase-0. **Satisfied.**

---

## C — FOOD DATA — `DIRECTION APPROVED` + `REQUIRES LEGAL VALIDATION`

**Ruling.** Start with USDA FoodData Central where legally appropriate, owned/authorized manually curated foods, curated private-label foods, and household-private user-created entries. **Do not ingest ODbL data or commercial datasets** until licensing, caching and redistribution terms are reviewed. **Do not build a large license-firewall subsystem.** Keep source, provenance, verification status and licensing metadata in the data model so sources can be added safely later.

**What changes.** `05` corrected: the firewall subsystem is replaced by licensing metadata on `product_versions`; T4 crowd-sourced data marked NOT INGESTED pending review.

**Irreversible/expensive.** Ingesting share-alike data before review can encumber the derived catalog; unpicking it later means auditing every product version and every log referencing one. This is why the block is absolute rather than advisory.

**Deadline.** Legal opinion required **before Phase 2**. Phase 0 and Phase 1 unblocked.

---

## D — PRODUCT IMAGES — `DIRECTION APPROVED` + `REQUIRES RIGHTS VALIDATION`

**Ruling.** MVP-0 uses a small curated catalog with images we own or have explicit rights to use. MVP-1 uses a mixture of owned photography, manufacturer-authorized assets, retailer-authorized assets, and properly licensed product-image providers. **We do not assume we must photograph every product ourselves. We never use unauthorized retailer or manufacturer images.** The A/B/C/D visual product-selection experience remains a core product requirement.

**What changes.** `05 §5` corrected: image sourcing is a mixed-supply program, not an in-house photography mandate. MVP-0 catalog size is bounded by rights-cleared imagery, not by data availability.

**Irreversible/expensive.** Unauthorized imagery is a copyright exposure that grows with every unit shipped and is not cured by later removal. In-house photography is a sunk per-SKU cost. The mixed approach limits both.

**Deadline.** Rights position required **before Phase 2**.

---

## E — AGE POLICY — `LOCKED`

**Ruling.** The initial commercial product is **18+ only**. No personal nutrition or deficit profiles for minors in MVP-0 or MVP-1. Dependent/minor household profiles may be designed later as a separate safety and legal product track.

**What changes.** `12` corrected: the `minor` role is removed; roles are `owner` and `member`. COPPA machinery leaves scope entirely. Onboarding carries an 18+ gate. Minor-specific voice-retention and guardrail branches are deferred with the future track.

**Irreversible/expensive.** Raising the floor later is trivial; lowering it later is a compliance programme. The eligibility gate records eligibility, **not** a date of birth.

**Deadline.** Was pre-Phase-0. **Satisfied.** Open sub-item: verification method (self-attestation vs. checked) — see §Open.

---

## F — HARDWARE — `LOCKED PRODUCT DIRECTION` + `REQUIRES SUPPLIER VALIDATION`

**Ruling — tablet.** 13.3" portrait, ~2K · 4 GB RAM min / 6 GB preferred · ~32 GB storage preferred · Wi-Fi · BLE 5.x · strong multi-mic array with AEC/noise suppression · clear speakers · **no front-facing camera requirement** · mains powered, no consumer battery · no user-facing USB (internal service port permitted) · aluminum or premium durable polymer, rugged for kitchen use · chemically strengthened/tempered cover glass, oleophobic coating · physical mic mute control with clear indicator · ambient light sensor preferred · portrait-first industrial design · counter stand / mounting capability.

**Ruling — barcode.** A front camera is not mandated for barcode. MVP-1 handles barcode through the companion phone. A discreet rear-facing scanner or dedicated 2D barcode module may be evaluated on supplier cost, reliability and industrial design — **not a Phase 0 blocker**.

**Ruling — scale.** Wireless BLE · 0–5 kg · 1 g resolution target · high repeatability · **corner-load error controlled through mechanical/load-cell design and tested explicitly** · tare, overload, stability detection and calibration required.

**What changes.** `09` gains a locked hardware section; the earlier "camera mandatory for barcode" recommendation is withdrawn; corner-load moves from a flagged gap to an explicit design and test requirement. G's headroom requirement is folded into the SoC selection.

**Irreversible/expensive.** Corner-load error cannot be fixed in firmware on shipped units. SoC headroom for a future offline command model must be specified now or offline voice becomes a hardware revision.

**Deadline.** Supplier quotations and lead times before procurement. Phases 0–2 unblocked; the scale simulator keeps Phase 3's software half unblocked.

---

## G — ON-DEVICE ASR — `LOCKED`

**Ruling.** Do not build on-device ASR for MVP-1. Use on-device wake word plus cloud streaming ASR. Hardware selection must leave enough CPU/RAM headroom for a small offline command-recognition model later. **Offline in MVP-1 = touch/manual interaction over cached foods. Voice requires connectivity. Offline voice is not marketed until it exists.**

**What changes.** `08` latency budget corrected to ≤1,300 ms (cloud-ASR finalization included). `09 §5` corrected: the previous claim that voice "degrades to fast paths" offline was false and is removed.

**Irreversible/expensive.** Only via F — a SoC without headroom makes offline voice a hardware revision.

**Deadline.** Was pre-procurement, folded into F. **Satisfied.**

---

## H — DEVELOPMENT TARGET — `LOCKED`

**Ruling.** Build MVP-0 first. **MVP-0 is not a disposable prototype** — it is the first increment of the same architecture and codebase that becomes MVP-1. MVP-0 proves: scale → food → weight → nutrition → logging → macros → energy balance. Voice, AI, household, mobile, wearable and production hardening are then layered onto the same system.

**What changes.** `10` re-cut into MVP-0 / MVP-1 / Post-MVP with that constraint explicit. No throwaway scaffolding, no prototype-grade shortcuts in the domain packages, and no parallel codebase.

**Irreversible/expensive.** The failure mode is letting MVP-0 accumulate prototype debt that MVP-1 inherits. Mitigation: MVP-0 ships against the same contracts, the same purity rules and the same test gates as MVP-1.

**Deadline.** Was pre-Phase-0. **Satisfied.**

---

## LOCKED — ENERGY ARCHITECTURE (v4: COMPONENT MODEL, PAL REMOVED)

Full detail in `06`. Supersedes the Validation Gate's Part 5.1 recommendation, the v2 "TEF is not modeled" lock, and every earlier `BMR × PAL` formulation.

> **PAL has been removed from the canonical MACROS.AI Energy Engine.**

```
TOTAL ENERGY EXPENDITURE = BMR + ACTIVE ENERGY + TEF
```

One equation, for every user and every day. What varies is the **source and quality of the ACTIVE component**, never the formula.

```
expenditure_so_far = basal_so_far + active_so_far + tef_accrued
projected_total    = BMR + active_so_far + projected_remaining_active + projected_tef
```

- **BMR** — profile, Mifflin-St Jeor default, one canonical source. Katch-McArdle only by explicit versioned policy permission.
- **ACTIVE** — `activeKcal` ≈ EAT + NEAT, from a provider: `simulated` (MVP-0), `wearable` (MVP-1), or a reserved `historical_estimate` / `onboarding_estimate`. Optional exercise/non-exercise metadata; the engine never depends on the split.
- **TEF** — computed by MACROS.AI from logged macros, individualized, versioned policy, coefficients `PENDING_EXTERNAL_REVIEW`.

**Removed from the architecture:** `PAL_FACTORS`, `palFactor`, `tdeeBaselineKcal`, `activityLevel`, the `baseline` / `wearable_component` / `fallback` modes, and `tefTreatment: embedded_in_pal`. A CI rule fails the build if any reappears in `domain-energy`.

**Provenance replaces modes:** `activitySource` and `energyQuality` (`measured_activity` | `partially_estimated_activity` | `estimated_activity` | `no_activity_source`). `measured` means *observed by a wearable*, not laboratory truth.

**No hidden fallback.** Users without wearable data get an explicit `EstimatedActivityProvider` (reserved, unimplemented), never a PAL multiplier. A missing estimate is the completeness gap `activity_estimate_missing`.

**Coverage gaps are filled per-interval, never per-day.** `ActivityGapFillPolicy` v1 contributes zero and lowers reported quality. A partial wearable day is never discarded for a whole-day population estimate.

**Five locked quantities:**
```
1  current_balance             = intake_so_far − expenditure_so_far          ← PRIMARY
2  target_delta                = chosen end-of-day surplus/deficit
3  projected_total_expenditure = deterministic forecast of today's total
4  remaining_intake            = projected_total + target_delta − intake      ← ACTIONABLE
5  if_no_more_food_balance     = intake_so_far − projected_total              ← SECONDARY ONLY
```

**TEF accrual v1:** `tefAccruedKcal = 0` — not a claim that real TEF is zero, but that we do not yet know how much has occurred by this instant. TEF is still computed, exposed, and included in projected expenditure.

**Completeness tells the truth:** `tef_policy_missing` and `activity_estimate_missing` are explicit gaps. A missing TEF policy is never conflated with a TEF estimate of zero.

**Dashboard:** CURRENT · TARGET EOD · EAT TO TARGET · macros remaining; supporting: consumed, expended so far, projected expenditure, component breakdown (BMR / ACTIVE / TEF), source and quality. Surplus/deficit remains the north-star KPI.

## LOCKED — VOICE-FIRST PRODUCT CONTRACT

MVP-0 is touch-first **for validation only**. MVP-1 is VOICE-FIRST. The final core interaction is:

> "Hey Macros" → food utterance → visual A/B/C/D options → user says the option → scale provides stable weight → deterministic nutrition calculation → confirmation → food log → current surplus/deficit and remaining macros update → concise spoken response.

MVP-1 is not redesigned as a touchscreen-first calorie tracker because MVP-0 validated the loop through touch.

---

## LOCKED — AI CONTRACT

The LLM interprets, routes, calls tools, explains, and handles flexible nutrition conversation.

The LLM **never originates**: calories · macros · food nutrition · scale weights · TDEE · expenditure · surplus/deficit · remaining intake. All deterministic, all in pure packages that cannot import an LLM SDK, all CI-enforced.

---

## STILL OPEN — requires ruling or external validation

| | Item | Type | Needed before |
|---|---|---|---|
| 1 | **Legal opinion on food data** — FDC terms, caching, redistribution, user-created content rights | LEGAL | Phase 2 |
| 2 | **Rights position on product imagery** — authorized asset programs and licensed provider terms | LEGAL | Phase 2 |
| 3 | **18+ verification method** — self-attestation vs. checked | APPROVAL | Phase 1 (User contract) |
| 4 | ~~`expected_remaining_active` rule~~ — **resolved.** No PAL bound. `ActivityProjectionPolicy` v1 = `none`; `historical_median` candidate uses only the user's own history. | RESOLVED | — |
| 4b | **`projected_tef` rule** — policy v1 computes projected TEF from **logged intake only**, not from food not yet eaten. Avoids a circular definition of `remaining_intake`. Confirm or amend. | APPROVAL | Phase 1 |
| 4c | **TEF macro coefficients** — protein/carb/fat/alcohol fractions, currently `PENDING_EXTERNAL_REVIEW`. Engine ships with the policy tagged unapproved; neutral until signed off. | EXTERNAL (dietitian) | Phase 1 exit |
| 4d | **TEF individual-adjustment model** — whether and how age, sex, body fat and fat-free mass modify base TEF, plus the adjustment bound. All rules neutral until approved. | EXTERNAL (dietitian / scientific review) | Before any `profile_adjusted` result ships |
| 4e | **Body-fat validity band** for deriving fat-free mass — implausible values rejected rather than clamped. Needs a reviewed range. | EXTERNAL | Phase 1 |
| 6 | **Dietitian review** of target floors, macro rules and safety scripts (D-19) | EXTERNAL | Phase 1 exit |
| 4f | **`ActivityPlausibilityPolicy`** — the single authoritative open item for activity admission rules: impossible/implausible active energy, confidence thresholds, staleness window, and any provider-specific validation. No approved instance ships, so no filtering is applied today. | EXTERNAL (dietitian / scientific review) | Before MVP-1 wearables |
| 4h | **`ActivityGapFillPolicy` coefficients** — how a missing interval is estimated. v1 leaves gaps unfilled and marks the day incomplete. | EXTERNAL | Before MVP-1 wearables |
| 4g | **`BmrPolicy` production review** — Mifflin-St Jeor is the *selected* equation; that is not the same as an externally reviewed production policy. It now ships `PENDING_EXTERNAL_REVIEW` and does not pass the policy firewall. | EXTERNAL | Phase 1 exit |
| 7 | **Secure element / secure boot** (D-16) | APPROVAL | Procurement |
| 8 | **Household lifecycle**: seat suspension vs. deletion, member removal, device transfer (D-11) | APPROVAL | Phase 7 |
| 9 | **Rear barcode module** — supplier cost/reliability/ID evaluation | EXTERNAL | Not a blocker |

Nothing in this list blocks the first coding milestone except **item 4**, which shapes one function in the energy engine and can be confirmed in a sentence.
