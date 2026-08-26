# 14 — First 10 Engineering Milestones

> **PARTIALLY SUPERSEDED — owner rulings A–H, 2026-08-10.** Where this document conflicts with `DECISION-LOCK.md`, the Decision Lock governs. See `CHANGE-REPORT.md`.


Each milestone has a **demonstrable artifact** and a **binary exit criterion**. Nothing is "done" because a ticket closed.

---

### M1 — Foundations & guardrails
**Build:** Monorepo (pnpm + Turborepo), TypeScript strict, CI, `packages/contracts` with zod→types/OpenAPI/tool-schema codegen, Postgres skeleton with schema-per-module, RLS harness, boundary lint rules, `packages/testkit` scaffolding.
**Exit:** A deliberately-bad PR fails CI on each of: cross-module schema access; `domain-energy` importing an LLM SDK; a new user-scoped table without an RLS policy.
**Blocked by:** nothing. Start here regardless of open decisions.

---

### M2 — Deterministic engines
**Build:** `domain-nutrition`, `domain-energy`, `domain-macros` as pure packages. BMR/PAL/TDEE, the canonical TEE decomposition, realized + projected balance, macro targets and remaining. Golden-vector corpus + property tests + cross-runtime parity.
**Exit:** 100% golden-vector pass in Node and RN runtimes; any balance reproducible byte-identically from `inputs_hash`.
**Blocked by:** **D-05** (balance semantics), **D-06** (TEF). Both must be answered before this milestone closes.

---

### M3 — Food catalog spine
**Build:** `food` schema with product/version/GTIN/availability modeling; source-record ingestion with license tagging; normalization; validation rules (Atwater, mass balance, category envelopes); first source adapter (T0 generics).
**Exit:** 10,000+ generic foods ingested, versioned, validated; a nutrition value traceable from a log back to its raw source record; a re-run of ingestion is a no-op.
**Blocked by:** **D-01/D-02** (source licensing) for the *branded* portion; T0 work can start immediately.

---

### M4 — Matching, review queue & search
**Build:** `food-match` blocking + scoring; admin review queue in `apps/admin`; second (branded) source adapter; search pipeline (FTS + trigram + name embeddings) with pantry/recency reranking and A/B/C/D diversification.
**Exit:** Top-4 accuracy ≥ 70% cold on the labeled utterance set; steward can resolve an ambiguous merge end-to-end in the console; merge precision gate met.

---

### M5 — Logging API & energy loop
**Build:** `intake` and `energy` modules; `logFood`, `getDailyIntake`, `getEnergyBalance`, `getRemainingMacros`; event-sourced expenditure; snapshot invalidation and recompute jobs; onboarding energy-model API.
**Exit:** Create a user via API, log three foods, receive a correct balance; correct a log and watch the snapshot recompute with a new `inputs_hash` and the old one preserved.

---

### M6 — Scale firmware & protocol
**Build:** `packages/scale-protocol` (shared codec), scale firmware (sampling, filtering, stability detection, tare, calibration, battery, OTA), BLE GATT service, and the **scale simulator** in testkit.
**Exit:** Reference masses read within ±2 g across the range on real hardware; the simulator replays dropout/motion/overload traces and the protocol codec passes identical fixtures in C and TypeScript.
**Blocked by:** **D-15** (MCU/load cell selection). Simulator and protocol work proceed without it.

---

### M7 — Tablet shell & the touch loop
**Build:** RN tablet app: dashboard with surplus/deficit as the north star, product-choice screen, BLE central, session state, SQLite cache, outbox, local engine execution, user-tile switching.
**Exit:** A weighed food is logged end-to-end **by touch**, online and offline, with the offline log reconciling on reconnect without duplication; local and server balance agree.
**Blocked by:** **D-14** (tablet platform).

---

### M8 — Voice fast path
**Build:** Wake word, VAD/endpointing, streaming ASR with domain vocabulary boosting, `voice-intents` grammar, response templates, TTS phrase cache, barge-in, follow-up window.
**Exit:** The brief's demo runs on hardware — "Hey Macros" → "Tofu" → four products → "Option B" → scale weight → "Log it" → balance updates — at ≤ 900 ms fast-path p95, in a kitchen with the hood fan running.
**Blocked by:** **D-09** (speaker identity approach) for the multi-user variant; single-user path is unblocked.

---

### M9 — AI orchestration
**Build:** Domain gate, tool registry with session-scoped authorization, orchestrator loop, response composer with the style contract, numeric-fidelity validator, RAG over `knowledge`, eval harness wired into CI.
**Exit:** All eval gates in `07 §5` green, including **zero** invented numbers across the suite, and the adversarial/injection suite passing.

---

### M10 — Household, isolation & billing
**Build:** Multi-user households, seat entitlements and `$10/mo` billing, member invite/removal, per-user PIN option, deletion and export paths, the full RLS isolation test suite.
**Exit:** The isolation suite passes — including that an owner cannot read a member's nutrition data and a device session for user A cannot reach user B's rows — and removing a member deletes their data without altering anyone else's history.
**Blocked by:** **D-11** (household lifecycle), **D-12** (minors).

---

## Sequencing notes

- **M1 → M2 → M5** is the critical path to a working product; **M3 → M4** runs in parallel with a separate team.
- **M6** firmware runs in parallel from week one against the simulator.
- **M8** cannot start before **M7**; **M9** should not start before **M8** — building the AI layer before the deterministic loop works is how the LLM ends up doing arithmetic.
- The private-label curation program (`05 §5`) starts at M3 and runs continuously; it is staffing, not engineering, and it will be the long pole for demo quality.
