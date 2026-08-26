# 01 — Ambiguities & Technical Risks

> **PARTIALLY SUPERSEDED — owner rulings A–H, 2026-08-10.** Where this document conflicts with `DECISION-LOCK.md`, the Decision Lock governs. See `CHANGE-REPORT.md`.


Ordered by expected damage if left unresolved.

---

## A. Product & domain ambiguities

### A1. "Surplus/deficit" is time-ambiguous — and this is the single most important gap
The spec says the system must "continuously update the user's current energy balance." But at 09:00, after a 600 kcal breakfast, a user with a 2,600 kcal TDEE is at −1,000 kcal realized balance. Displaying "−1,000 DEFICIT" every morning is technically correct and product-destroying. The example in the brief (`+187 kcal SURPLUS / Target +250`) is only reachable mid-to-late day, or under a projection model.

Three candidate semantics, each producing a different engine, different UI and different notification logic:
1. **Realized-to-now**: `intake(t) − expenditure(t)`, compared against a pro-rated target.
2. **Projected end-of-day, no further intake**: `intake(t) − TEE_projected_day`. Honest, actionable ("you have 2,250 kcal to go"), but negative all day.
3. **Projected end-of-day, modeled remaining intake**: uses the user's historical eating pattern to forecast the rest of the day. Matches the brief's example at any hour, but is a prediction presented as a KPI — and is unavailable for a new user's first days.

→ **D-05.** Not assumable. It defines the Energy Engine's public contract.

### A2. Raw vs cooked mass is an unhandled 30–40% error source
The scale reports grams. 247 g of *raw* chicken breast and 247 g of *cooked* chicken breast differ by roughly 35% in calories because of water loss. The same applies to rice, pasta, and legumes in the opposite direction. Nutrition databases mix both states without a machine-readable flag. A system whose entire value proposition is a ±50 kcal surplus number cannot silently absorb a 400 kcal error.
→ Requires a `preparation_state` dimension on products and yield factors. **D-07.**

### A3. Whose food is on the scale?
Voice on a shared kitchen appliance has no inherent identity. "Hey Macros. Tofu." spoken by Dad while Mom's profile is displayed will log to the wrong user. The household model makes per-user isolation a database concern, but *attribution at capture time* is a physical-world concern.
→ **D-09** (explicit tile / phone proximity / PIN / voiceprint). Voiceprints are biometric identifiers — see risk C3.

### A4. "Calories burned" is undefined and double-counting is the default failure
Wearables variously report *active energy*, *total energy expenditure*, and *steps-derived estimates*. Adding a wearable's active-calorie number to a Mifflin-St Jeor TDEE (which already contains an activity multiplier) inflates expenditure by 300–700 kcal/day. Users will notice, because their weight won't move.
→ One canonical decomposition, documented, enforced. See `06`.

### A5. TEF (thermic effect of food) is ~10% of intake — include it or not?
A 2,400 kcal intake carries ~240 kcal of TEF. Including it shifts the north-star number by roughly the entire size of a typical target. Silence here is a 240 kcal bug.
→ **D-06.**

### A6. Partial consumption, leftovers, and multi-item plates
The flow `product → weight → log` assumes the weighed mass is the consumed mass. Real kitchens: you weigh a 500 g pan of stir-fry and eat two-thirds of it; you put a bowl on the scale without taring; you weigh three ingredients in sequence into one bowl. The MVP must have an explicit answer even if the answer is "only single-item, tared, fully-consumed logging is supported."

### A7. "Prediction" subsystem is named but never scoped
The brief lists a Prediction subsystem and a `getPrediction()` tool but never says what is predicted. Candidates: end-of-day balance, weight trajectory, adaptive TDEE correction, remaining-intake forecast, goal ETA. These are different models with different data requirements.
→ **D-13.**

### A8. Household lifecycle is undefined
What happens when: a paid member is removed; payment fails; the device is sold; a member wants their data exported; two households share a member (kid at two parents' houses)? Each has schema consequences (does a `user` belong to a household, or join one?).
→ **D-11.** Recommendation: users are global identities that *join* households via membership rows. Anything else makes divorce a data migration.

### A9. Minors in the household
The example household includes "Jackson." If Jackson is under 13, COPPA applies; under 18, calorie-deficit recommendations carry real clinical risk. The product must decide whether minors get profiles, and what the assistant will and will not say to them.
→ **D-12.**

---

## B. Data risks

### B1. The food catalog will not exist and cannot be scraped into existence — highest programme risk
There is no single licensable dataset covering Costco/Walmart/Aldi/Trader Joe's private-label products with verified nutrition and UPCs. Realistic components:
- **USDA FoodData Central** — Foundation Foods and SR Legacy (excellent quality, fresh/generic foods, ~10k items); Branded Foods (~1.5M items, sourced via GS1-affiliated partners, quality varies, staleness is significant).
- **Open Food Facts** — broad, crowd-sourced, **ODbL-licensed**. ODbL's share-alike provisions can encumber a derived database. This is a legal architecture decision, not a data decision.
- **Commercial syndication** (1WorldSync/Syndigo, Nutritionix, Edamam) — good coverage, per-call or per-seat cost, redistribution restrictions that may forbid caching product data in our own Postgres.
- **Retailer sites** — ToS-restricted, unstable, and the only reliable source for some private-label SKUs.

→ **D-01** and **D-02**. Until these are resolved, the cost model, the ingestion pipeline, and the ability to serve offline are all unknown. Mitigation: a **license-tagged source firewall** in the schema from day one, so encumbered data can be excluded from a build without re-architecting.

### B2. Private-label products are the demo and the hardest data
"Kirkland tofu" is in the brief's own example. Private-label SKUs are exactly the ones absent from public datasets. Expect a manual/assisted curation program for the top ~2,000 SKUs across the named retailers. Budget for a data-steward tool and human hours; this is not automatable at acceptable quality in v1.

### B3. "Retailer" is modeled in the brief as a product attribute — it is not
A product has a *brand*; it has *availability* at retailers, in regions, over time. Great Value is a Walmart-owned brand; Barilla is sold at everyone. Flattening retailer onto the product row creates duplicate products and breaks dedup permanently.
→ Modeled as `product ↔ retailer_availability` edges. See `05`.

### B4. Corrections must not rewrite history
If we fix a product's calorie value in September, the user's August logs must not silently change — their weight-vs-intake reconciliation depends on what they were told at the time. Requires immutable `product_version` rows referenced by logs. Retrofitting this later is a data migration across every log ever written.

### B5. GTIN is not a primary key
UPCs get reused, regional variants share GTINs, and multipacks have their own codes. GTIN is an *identifier edge*, many-to-one onto product versions.

---

## C. Legal / compliance risks

### C1. Consumer health data laws bite harder than HIPAA here
We are not a covered entity, so HIPAA likely does not apply — but Washington's My Health My Data Act, Nevada SB370, and CCPA/CPRA sensitive-data rules cover inferred health data (weight, body composition, dietary intake) with consent and deletion obligations. Architecture must support per-user, per-category deletion inside a shared household.

### C2. Eating-disorder liability
A device that continuously reports deficit and accepts arbitrary targets will be used by people with disordered eating. Need hard floors on targets, screening heuristics, and a refusal/redirect policy in the assistant. This is a product-safety requirement, not a nice-to-have.

### C3. Voiceprints in Illinois
If speaker identification uses voice biometrics, Illinois BIPA imposes written-consent, retention-schedule, and private-right-of-action obligations — with statutory damages per violation. This is the single most expensive way to solve A3.
→ Recommend deferring voice ID entirely (**D-09**).

### C4. Not a medical device — keep it that way
Avoid diagnostic or therapeutic claims. "You're short 42g protein" is fine. Anything framed as treatment for a condition changes our regulatory class.

---

## D. Technical risks

| # | Risk | Impact | Mitigation |
|---|---|---|---|
| D1 | Voice latency budget blown by LLM in the hot path | Product feels broken; wake-word abandonment | Deterministic intent fast-paths for the top ~40 utterances; LLM only on fallback (`07`, `08`) |
| D2 | LLM emits a number it invented | Destroys the product's core claim | Numeric-fidelity validator: every numeral in a response must trace to a tool result (`07`) |
| D3 | Kitchen acoustics (range hood, running water, radio) | Wake word and ASR failure | Mic array + AEC/beamforming; on-device wake word; domain vocabulary boosting |
| D4 | BLE dropout mid-log | Lost weight reading, user re-does the flow | Weight is captured and cached on the tablet, not fetched on demand; local outbox |
| D5 | Wearable backfill rewrites yesterday | Balance numbers change retroactively | Event-sourced energy log + explicit `recomputed_at`; never mutate historical snapshots in place |
| D6 | Supabase as both auth and DB creates coupling | Migration pain at scale | Keep all business logic in the Node service; treat Supabase as Postgres + auth + storage only, no edge-function business logic |
| D7 | Hardware unspecified (SoC, OS, MCU, load cell, certification) | Blocks firmware and tablet app milestones | **D-14/D-15/D-16**; scale simulator lets software proceed in parallel |
| D8 | Load-cell drift/temperature error | ±5 g errors → ±20 kcal, tolerable; ±30 g → not | Firmware-side calibration, median filtering, stability flag, factory calibration record |
| D9 | Cost per interaction (ASR + LLM + TTS) | Unit economics on a no-subscription primary user | Fast paths, cached TTS phrases, small model for classification (`13`) |
| D10 | Offline kitchen (Wi-Fi drop) | Cannot log dinner | Local product cache of pantry/recents + outbox queue (`09`) |

---

## E. What I explicitly did **not** assume

Every item above marked **D-xx** is deferred to `15-open-decisions.md` with a recommendation. I have designed the architecture so that each of those decisions is *swappable*, not structural — with three exceptions where the decision must be made before Milestone 1: **D-01** (food data licensing), **D-05** (balance semantics), **D-09** (speaker identity).
