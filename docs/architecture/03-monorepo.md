# 03 — Monorepo Structure

> **PARTIALLY SUPERSEDED — owner rulings A–H, 2026-08-10.** Where this document conflicts with `DECISION-LOCK.md`, the Decision Lock governs. See `CHANGE-REPORT.md`.


**Tooling:** pnpm workspaces + Turborepo. TypeScript strict, project references. Changesets for internal package versioning.

```
macros/
├── apps/
│   ├── tablet/                 React Native (Android) — primary surface
│   │   ├── src/screens/        dashboard, logging, product-choice, profile switch
│   │   ├── src/voice/          wake word, VAD, audio session, barge-in
│   │   ├── src/ble/            scale central role
│   │   ├── src/offline/        SQLite cache, outbox, conflict handling
│   │   └── src/state/
│   ├── mobile/                 React Native (iOS + Android) — companion
│   ├── api/                    Node + TS modular monolith (web process)
│   │   └── src/modules/
│   │       ├── identity/  device/  food/  nutrition/  intake/
│   │       ├── energy/  macros/  prediction/  wearable/  scale/
│   │       ├── ai/  voice/  billing/  analytics/
│   │       └── (each: index.ts = public interface, /internal = private)
│   ├── worker/                 same image, worker process: ingestion, recompute, sync
│   └── admin/                  Next.js internal ops: data stewardship, review queues
│
├── packages/
│   ├── contracts/              zod schemas → shared types + OpenAPI + tool JSON Schema
│   ├── domain-energy/          PURE. BMR/TDEE/TEE/balance. No IO.
│   ├── domain-macros/          PURE. targets, remaining, distribution.
│   ├── domain-nutrition/       PURE. per-100g basis math, unit conversion, yield factors.
│   ├── food-normalize/         PURE. unit parsing, brand canonicalization, nutrient mapping.
│   ├── food-match/             PURE-ish. blocking keys, similarity scoring, merge rules.
│   ├── ai-tools/               tool registry, schemas, authz descriptors, eval harness
│   ├── voice-intents/          PURE. deterministic intent grammar + slot extraction
│   ├── scale-protocol/         BLE GATT contract, codecs — shared with firmware tests
│   ├── ui/                     RN component library + design tokens
│   ├── telemetry/              structured logging, tracing, metric names
│   └── testkit/                fixtures, golden vectors, scale simulator, ASR transcripts
│
├── firmware/
│   └── scale/                  C/C++ (Zephyr or PlatformIO), unit tests on host
│
├── db/
│   ├── migrations/             SQL, forward-only, one schema per module
│   ├── policies/               RLS policies as reviewable SQL
│   └── seeds/
│
├── data/
│   ├── ingestion-specs/        per-source adapter specs + license metadata
│   └── golden/                 hand-verified product + nutrition ground truth
│
├── docs/
│   ├── adr/                    architecture decision records (this set becomes ADR-000x)
│   └── runbooks/
│
└── tools/                      codegen, lint rules, release scripts
```

## Boundary enforcement (mechanical, not cultural)

1. **`dependency-cruiser` rules in CI.**
   - `packages/domain-*` may import nothing outside themselves except other `domain-*`. No `fs`, `pg`, `axios`, `date` sources of nondeterminism.
   - No module under `apps/api/src/modules/X/internal/**` may be imported from outside `X`.
   - Nothing may import from `modules/ai/**` except the HTTP layer.
   - `energy`, `macros`, `nutrition` may not (transitively) import `ai`, `voice`, or any LLM SDK. **This is the CI check that proves the brief's core constraint.**
2. **Schema ownership check.** A lint rule maps SQL identifiers to owning modules; a query in `modules/energy` touching `food.*` fails the build.
3. **Contracts are generated, never hand-written twice.** `packages/contracts` is the single source for API types, DB row types, and LLM tool JSON Schemas — one zod schema, three outputs. Prevents tool-schema drift, which is the most common cause of silent LLM tool failures.
4. **`packages/testkit` is a devDependency everywhere**, so any module can spin the scale simulator or golden vectors without inventing fixtures.

## Why a monorepo with pure-domain packages

The pure packages are the extraction insurance policy. When `food` becomes its own service, the domain logic moves with zero rewriting because it never knew about transport. The modules that *do* have IO keep their public `index.ts` signature and swap the body for a client. Nothing else in the codebase changes.
