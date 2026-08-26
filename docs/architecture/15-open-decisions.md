# 15 — Decision Register (resolved status)

> **SUPERSEDED BY `DECISION-LOCK.md`.** This register is retained for traceability only. Owner rulings A–H, 2026-08-10, govern.

| # | Original decision | Status | Resolution |
|---|---|---|---|
| D-01 | Food data sourcing & licensing | **DIRECTION APPROVED, PENDING LEGAL** | Ruling C: USDA FDC where legally appropriate + owned/authorized curated foods + curated private-label + household-private entries. No ODbL, no commercial datasets until reviewed. |
| D-02 | Caching / redistribution rights | **PENDING LEGAL** | Ruling C: remains a hard vendor filter. No license-firewall subsystem; licensing metadata in the data model instead. |
| D-05 | Balance semantics | **LOCKED** | Owner correction: five quantities, `current_balance` primary. Earlier "consumed − full-day TDEE as hero KPI" recommendation rejected. See `06 §3`. |
| D-06 | TEF | **RE-LOCKED (v3)** | **Reversed.** TEF is now a first-class deterministic component computed by MACROS.AI from logged macros via a versioned `TefPolicy` (coefficients `PENDING_EXTERNAL_REVIEW`). Summed only in `wearable_component` mode; embedded in PAL and therefore not summed in `baseline`/`fallback`. Individualized per `06 §3` (base macro TEF + bounded, reviewed profile adjustment; neutral while unreviewed). Mode rules per `§6.2`. |
| D-07 | Raw vs cooked | **LOCKED** | Disambiguate at selection, never convert. No yield-factor subsystem. |
| D-09 | Speaker identity | **LOCKED** | Explicit user tile, idle timeout, every confirmation names the user. No voice biometrics. MVP-1. |
| D-10 | Wearables | **RE-LOCKED (v3)** | Ruling A + component-based TDEE: required in MVP-1 via `EnergyActivityProvider`. When trusted activity exists the model is `BMR + ACTIVE + TEF` and **PAL leaves the expenditure sum entirely**. PAL is retained as fallback and as a forecast bound only. |
| D-11 | Household lifecycle | **OPEN** — MVP-1 scope | Global user identities joining households. Seat suspension vs. deletion still needs its own ruling before Phase 7. |
| D-12 | Minors | **LOCKED** | Ruling E: 18+ only. No minor profiles in MVP-0 or MVP-1. Dependent profiles are a separate future track. |
| D-13 | Prediction scope | **DEFERRED** | Post-MVP. Calibration fields (`k_user`, `k_provider`) reserved in the energy contract. |
| D-14 | Tablet platform | **LOCKED** | Ruling F: 13.3" portrait ~2K, 4–6 GB RAM, ~32 GB storage, Wi-Fi + BLE 5.x, multi-mic array with AEC, mains powered, **no front camera**, mute switch, rugged premium enclosure, headroom for a future offline command model. |
| D-15 | Scale hardware | **LOCKED** | Ruling F: BLE, 0–5 kg, 1 g resolution target, high repeatability, corner-load controlled mechanically and tested explicitly, tare/overload/stability/calibration required. |
| D-16 | Hardware security | **OPEN** — pre-procurement | Secure element and secure boot still unruled. |
| D-17 | Assistant voice identity | **OPEN** — MVP-1 | Not yet needed. |
| D-18 | Barcode | **LOCKED** | Ruling F: no front camera for barcode. MVP-1 barcode via companion phone. Rear scanner / 2D module evaluated on cost, reliability and industrial design — **not a Phase 0 blocker**. |
| D-19 | Guardrail values | **PENDING EXTERNAL** | Registered dietitian review of target floors and safety scripts still required before ship. |
| D-20 | Multi-item / partial consumption | **PARTIALLY LOCKED** | Meal grouping in MVP-1. Recipes, leftovers and true multi-ingredient dishes remain Post-MVP. |

**Decisions that were never defined:** D-03, D-04, D-08 were referenced but never written. They are void; nothing depends on them.
