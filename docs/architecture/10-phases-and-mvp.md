# 10 — MVP-0 / MVP-1 / Post-MVP Boundary

> **RE-CUT AND LOCKED — owner rulings, 2026-08-10.** Replaces the previous single-MVP boundary in full.

**MVP-0 is not a disposable prototype.** It is the first increment of the same architecture and the same codebase that becomes MVP-1. Nothing in MVP-0 is built to be thrown away; voice, AI, household, mobile and wearable are layered onto it.

---

## 1. What each scope is, in one sentence

**MVP-0 — prove the loop.** Single user, tablet only, touch-first, real scale, curated catalog with owned/rights-cleared images, deterministic nutrition and energy, simulated activity provider, no voice, no LLM. Proves: **scale → food → weight → nutrition → logging → macros → energy balance.**

**MVP-1 — first real product.** Voice-first as originally specified, LLM as router/narrator, real wearable integration via Apple Health / Health Connect, mobile companion, multi-user household with billing, offline touch logging, barcode via the companion phone.

---

## 2. Feature classification

| Feature | MVP-0 | MVP-1 | Post-MVP |
|---|:--:|:--:|:--:|
| Wireless BLE scale: stable weight, tare, overload, calibration, corner-load control | ✅ | ✅ | |
| Tablet UI: dashboard, search, A/B/C/D selection, weight, confirm, log, undo | ✅ | ✅ | |
| Deterministic nutrition calculation (per-100g basis) | ✅ | ✅ | |
| Deterministic energy engine — all five locked quantities | ✅ | ✅ | |
| `TefPolicy` + `TefProfile` + `TefResult` + deterministic `calculateTef` | ✅ | ✅ | |
| Base macro TEF from logged macros | ✅ | ✅ | |
| Individual-adjustment architecture (neutral until reviewed) | ✅ (contract, neutral) | ✅ (neutral until approved) | |
| Approved profile-based TEF adjustments (`profile_adjusted`) | | pending review | |
| Fat-free-mass derivation when body fat is present and valid | ✅ | ✅ | |
| Personal TEF calibration (`personalized`) | | | ⏸ reserved, unused |
| TEF accrual policy v1 (`tefAccrued = 0`, exposed + projected) | ✅ | ✅ | |
| Intra-day TEF accrual curve | | | ⏸ |
| `wearable_component` mode (BMR + ACTIVE + TEF) | contract + simulator | ✅ | |
| Coverage-aware fallback (whole-day, no partial PAL top-up) | ✅ | ✅ | |
| Deterministic gap-fill for missing activity intervals | | | ⏸ |
| `EnergyActivityProvider` contract | ✅ (contract + simulator) | ✅ (real providers) | |
| `SimulatedActivityProvider` | ✅ | ✅ (test/dev) | |
| Apple Health / Health Connect activity providers | | ✅ | |
| Garmin / WHOOP / Oura / Fitbit providers | | | ⏸ |
| Macro targets and remaining | ✅ | ✅ | |
| Onboarding → energy model (18+ only) | ✅ | ✅ | |
| Curated catalog, images owned or rights-cleared | ✅ (small) | ✅ (expanded) | |
| USDA FDC ingestion + validation pipeline | | ✅ | |
| Curated private-label foods | ✅ (seed) | ✅ | |
| Household-private user-created foods | | ✅ | |
| Deterministic search + ranking + pantry/recency | ✅ (basic) | ✅ | |
| "Not in catalog" fallback path | ✅ | ✅ | |
| Meal grouping (sequential items → one meal) | | ✅ | |
| Manual/override weight entry | ✅ | ✅ | |
| Body-weight entry | ✅ | ✅ | |
| Wake word + cloud streaming ASR + deterministic voice grammar | | ✅ | |
| Voice-first core loop (the locked interaction) | | ✅ | |
| LLM: interpret, route, call tools, explain | | ✅ | |
| Numeric-fidelity validator + refusal gate + safety scripts | | ✅ | |
| Barcode via companion phone | | ✅ | |
| Rear scanner / 2D barcode module on the appliance | | evaluate | ⏸ |
| Mobile companion (health connection, balance, manual log, profile, weight) | | ✅ | |
| Mobile notifications | | | ⏸ |
| Multi-user household, tile switching, isolation | | ✅ | |
| Billing / seats | | ✅ | |
| Offline: cached-food touch logging, calc, balance, outbox | | ✅ | |
| Longitudinal calibration (`k_user`, `k_provider`) | | | ⏸ (fields reserved) |
| On-device ASR / offline voice | | | ⏸ |
| Minor / dependent profiles | | | ⏸ (separate safety + legal track) |
| RAG / nutrition knowledge base | | | ⏸ |
| Prediction module, `getPrediction`, `recommendFood` | | | ⏸ |
| Recipes, leftovers, meal planning, grocery lists | | | ⏸ |
| Photo food recognition, restaurant menus | | | ⏸ |
| Voice biometrics | | | ⏸ |
| Multi-device households, international, multi-language | | | ⏸ |
| Event-sourced energy replay, admin console, analytics module, WebSocket push, OTA staged rollout, partitioning, read replicas, SOC 2 | | | ⏸ |

---

## 3. Explicit non-goals for MVP-0

Not because they are unimportant — because they are layered on later without rework:

voice · LLM · wearables (real) · mobile app · multi-user · billing · offline · barcode · meal grouping · ingestion pipeline at scale · notifications.

---

## 4. Explicit non-goals for MVP-1

ODbL or commercial food datasets before legal review · unauthorized retailer or manufacturer imagery · minor profiles · on-device ASR · offline voice (and no marketing of it) · voice biometrics · recipes and meal planning · prediction and recommendation tools · international expansion.

---

## 5. Success criteria

**MVP-0**
| Metric | Target |
|---|---|
| Nutrition values incorrect vs. label | 0 |
| Place food → logged, by touch | ≤ 20 s |
| Internal users logging ≥3 foods/day for 7 days | 5 users |
| Correct product in top 4 (seed catalog) | ≥ 90% |
| Energy state reproducible from stored inputs | 100% |

**MVP-1**
| Metric | Target |
|---|---|
| Voice log success (utterance → correct log, no touch) | ≥ 85% |
| Fast-path latency p95 (speech end → audio out) | ≤ 1,300 ms |
| Correct product in top 4 (repeat foods) | ≥ 90% |
| Hallucinated numbers | 0 |
| Cross-user data leakage incidents | 0 |
| Activity double-count defects | 0 |
| Day-7 household retention | ≥ 60% |
