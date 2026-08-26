# 11 — Testing Strategy

> **PARTIALLY SUPERSEDED — owner rulings A–H, 2026-08-10.** Where this document conflicts with `DECISION-LOCK.md`, the Decision Lock governs. See `CHANGE-REPORT.md`.


The system has four fundamentally different testing problems: **deterministic math**, **messy data**, **probabilistic AI**, and **physical hardware**. Each needs its own approach; one test pyramid does not cover them.

## 1. Deterministic engines — golden vectors + properties

`domain-energy`, `domain-macros`, `domain-nutrition` are pure, so testing is exhaustive and free.

- **Golden vectors**: a versioned JSON corpus in `data/golden` of `(input, calc_version) → expected output`, including hand-computed reference cases and every historical bug. A `calc_version` bump requires a new vector set plus an explicit diff review of what changed and why.
- **Property-based tests** (fast-check):
  - Nutrition scales linearly: `calc(v, 2g) == 2 × calc(v, 1g)` within rounding tolerance.
  - Unit conversions round-trip.
  - `balance == intake − expenditure` for all component decompositions.
  - Displayed macros always reconcile to displayed calories within rounding.
  - Monotonicity: adding a log never decreases intake; adding activity never decreases expenditure.
  - Event ordering: shuffling same-timestamp events does not change the result.
- **Reproducibility test**: recomputing any historical snapshot from `inputs_hash` yields byte-identical output.
- **Cross-runtime parity**: the same vectors run in Node and in the React Native JS runtime; divergence fails CI (the tablet computes locally, so this is a real risk).

## 2. Food data — validation as tests

- **Pipeline unit tests** on normalization: serving-string parsing, unit conversion, brand canonicalization, nutrient-code mapping, against a fixture corpus of real-world ugly inputs.
- **Data-quality assertions run as CI jobs against a catalog sample**: Atwater consistency, mass balance, category envelopes, orphan versions, GTIN collisions, missing images on high-rank items. Regressions in catalog quality fail the build the same way code regressions do.
- **Matching evaluation**: a labeled pair set (same / different product) with precision/recall gates on the merge classifier. Merges are irreversible in user perception, so precision is weighted above recall — ambiguous cases go to the review queue.
- **Search evaluation**: labeled `utterance → correct SKU` set, measuring top-1 and top-4 accuracy, split cold vs pantry-warm.

## 3. AI — evaluation, not assertion

Covered in `07 §5`. Key point: these are **statistical gates in CI**, run on every change to prompts, tools, gate, or model version, with results tracked over time. Suites: tool selection, refusal precision/recall, numeric fidelity (hard 0), style, safety scripts, latency.

Additional:
- **Adversarial suite**: prompt injection via product names and ingredient text; attempts to make the model state a calorie value without a tool call; attempts to read another household member's data.
- **Regression corpus**: every production failure becomes a permanent eval case.

## 4. Data isolation — the tests I care most about

A dedicated suite that runs against an ephemeral Postgres with real RLS policies:

- For each user-scoped table: user A cannot select, update, or delete user B's rows — including via a household-shared device session.
- A device token scoped to session user A cannot read user B's logs, weights, goals, or predictions.
- A revoked seat loses access at the next request.
- Service-role queries are audited; a test asserts that no module queries another module's schema.

These run on every PR. A cross-user leak is the only category of bug that is unrecoverable reputationally for a shared household appliance.

## 5. Hardware and device

- **Scale simulator** (`packages/testkit`): a virtual BLE peripheral replaying real weight traces — stable, drifting, motion, overload, dropout, reconnect. Every tablet-side flow is testable without hardware, from day one.
- **Firmware host tests**: filtering, stability detection, calibration math compiled and tested on the host; `packages/scale-protocol` codec tests run against both TS and C implementations using shared fixtures.
- **Hardware-in-the-loop**: a rig with certified reference masses (10 g, 100 g, 500 g, 2 kg) running accuracy, drift, temperature, and battery-cycle suites nightly against real units.
- **Acoustic testing**: wake-word and ASR accuracy measured in a reference kitchen environment with recorded noise beds (hood fan, running water, radio, conversation, blender) at defined SPLs and distances. Gates on false-accept and false-reject rates.

## 6. End-to-end

A small number of high-value E2E flows on a real device (or emulator + simulator), run nightly:
1. Onboarding → energy model established → dashboard shows target.
2. "Hey Macros" → "Tofu" → four options → "Option B" → scale weight → "Log it" → balance updates.
3. Wearable sync backfills yesterday → snapshot recomputes → user is notified of the change.
4. Second household member switches profile → logs → first member's data unchanged and unreadable.
5. Wi-Fi off → log offline → reconnect → server reconciles without duplicates.

## 7. Non-functional

- **Load**: catalog search QPS, WebSocket fan-out, ingestion throughput. Target well above projected peak; see `13`.
- **Latency budgets as tests**: the budgets in `08 §4` are asserted in CI against recorded traces, not just monitored in production.
- **Chaos**: BLE dropout mid-capture, ASR provider timeout, LLM provider 500, wearable duplicate webhooks, clock skew on the device.
- **Migration tests**: every migration runs forward against a production-shaped snapshot in CI, with RLS policies re-verified after.

## 8. What we deliberately do not test heavily

UI snapshot tests (brittle, low value on a fast-moving surface), exhaustive integration tests for CRUD wrappers, and mocked-LLM unit tests that assert exact model output (they test the mock). Effort goes to the four hard categories above.
