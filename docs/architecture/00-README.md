# MACROS — System Architecture (Pre-Implementation)

> **PARTIALLY SUPERSEDED — owner rulings A–H, 2026-08-10.** Where this document conflicts with `DECISION-LOCK.md`, the Decision Lock governs. See `CHANGE-REPORT.md`.


**Status:** Draft for approval. No application code written.
**Date:** 2026-08-10
**Author:** Principal Architect

---

## How to read this set

| Doc | Covers | Task item |
|---|---|---|
| `01-ambiguities-and-risks.md` | What is underspecified, what will hurt us later | 2 |
| `02-system-architecture.md` | Runtime topology, subsystem boundaries | 3 |
| `03-monorepo.md` | Repo layout, boundary enforcement | 4 |
| `04-database.md` | Schemas, isolation, versioning | 5 |
| `05-food-data.md` | Ingestion → canonical catalog → search | 8 |
| `06-energy-balance.md` | The deterministic north-star engine | 7 |
| `07-ai-architecture.md` | Tools, domain gate, numeric authority | 6 |
| `08-voice.md` | Wake word → ASR → intent → TTS | 9 |
| `09-device-and-scale.md` | BLE protocol, device auth, offline | 10 |
| `10-phases-and-mvp.md` | Phasing, MVP boundary, explicit non-goals | 11, 12, 13 |
| `11-testing.md` | Test strategy per subsystem | 14 |
| `12-security-privacy.md` | Isolation, biometrics, health data law | 15 |
| `13-scalability.md` | Where load actually appears, extraction seams | 16 |
| `14-milestones.md` | First 10 engineering milestones | 17 |
| `15-open-decisions.md` | **Decisions I will not make for you** | — |

---

## The one-paragraph architecture

MACROS is a **deterministic energy-accounting system** with a voice interface bolted to the front and a large product catalog bolted to the side. The LLM is a *router and narrator*, never a calculator. Every number the user hears or sees is produced by a pure function of (profile snapshot, event log, calculation version) and is reproducible on demand. The hard engineering problems, in descending order of risk, are: (1) sourcing and maintaining a trustworthy US food catalog, (2) defining energy-balance semantics that stay honest at 9am and at 9pm, (3) sub-second voice latency on a shared kitchen device, (4) per-user data isolation on shared hardware. The stack (TS / Node / Postgres / Supabase / RN / modular monolith) is adequate for all of these through the first ~100k households.

---

## Reading order for the fastest decision

If you only read three documents before approving: `01`, `06`, `15`.

`15-open-decisions.md` contains **17 decisions that materially change the architecture**. I have given a recommendation for each and have deliberately not assumed any of them. Several (D-01 food data licensing, D-05 balance semantics, D-09 speaker identity) block Milestone 1.
