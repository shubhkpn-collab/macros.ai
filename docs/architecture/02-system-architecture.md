# 02 — System Architecture

> **PARTIALLY SUPERSEDED — owner rulings A–H, 2026-08-10.** Where this document conflicts with `DECISION-LOCK.md`, the Decision Lock governs. See `CHANGE-REPORT.md`.


## 1. Topology

```
┌──────────────────────────── HOUSEHOLD ────────────────────────────┐
│                                                                    │
│   ┌─────────────┐   BLE GATT    ┌──────────────────────────────┐  │
│   │   SCALE     │◄─────────────►│         TABLET               │  │
│   │  MCU + ADC  │  weight/tare  │  RN app · wake word · VAD    │  │
│   │  load cell  │  battery/OTA  │  BLE central · local cache   │  │
│   └─────────────┘               │  outbox queue · TTS playback │  │
│                                 └──────────────┬───────────────┘  │
│                                                │ WSS + HTTPS      │
│   ┌─────────────┐  HTTPS                       │                  │
│   │  PHONE APP  │────────────────────────┐     │                  │
│   └─────────────┘                        │     │                  │
└──────────────────────────────────────────┼─────┼──────────────────┘
                                           ▼     ▼
                        ┌──────────────────────────────────────────┐
                        │            EDGE / API GATEWAY            │
                        │   authn · rate limit · device attest     │
                        └────────────────────┬─────────────────────┘
                                             ▼
   ┌─────────────────────────────────────────────────────────────────────┐
   │              MACROS CORE  (modular monolith, Node + TS)             │
   │                                                                      │
   │  ┌────────────┐ ┌──────────┐ ┌──────────┐ ┌───────────┐ ┌─────────┐ │
   │  │ identity/  │ │ device   │ │ food     │ │ nutrition │ │ energy  │ │
   │  │ household  │ │          │ │ catalog  │ │  calc     │ │ balance │ │
   │  └────────────┘ └──────────┘ └──────────┘ └───────────┘ └─────────┘ │
   │  ┌────────────┐ ┌──────────┐ ┌──────────┐ ┌───────────┐ ┌─────────┐ │
   │  │ macros     │ │prediction│ │ ai       │ │ voice     │ │wearable │ │
   │  │ engine     │ │          │ │orchestr. │ │ gateway   │ │ sync    │ │
   │  └────────────┘ └──────────┘ └──────────┘ └───────────┘ └─────────┘ │
   │  ┌────────────┐ ┌──────────┐ ┌──────────┐                           │
   │  │ scale       │ │ billing │ │analytics │                           │
   │  └────────────┘ └──────────┘ └──────────┘                           │
   └──────────┬───────────────────┬────────────────────┬─────────────────┘
              ▼                   ▼                    ▼
     ┌────────────────┐   ┌──────────────┐   ┌────────────────────┐
     │  PostgreSQL    │   │ Object store │   │  WORKERS (same repo)│
     │  + pgvector    │   │ product imgs │   │  ingestion · recompute│
     │  RLS enforced  │   │ TTS cache    │   │  predictions · sync  │
     └────────────────┘   └──────────────┘   └────────────────────┘
              ▲                                        ▲
              └──────── external: USDA FDC, syndication feeds,
                        wearable APIs, ASR, TTS, LLM ────┘
```

## 2. Subsystem contracts

Each subsystem is a **module** with: one owned Postgres schema, one exported TypeScript interface, zero direct reads of another module's tables. Cross-module access is by function call through the exported interface today; that same call becomes an HTTP/gRPC hop on extraction with no caller changes.

| Module | Owns | Exposes | Depends on |
|---|---|---|---|
| `identity` | households, users, memberships, roles, consent records | `getUser`, `getHousehold`, `assertMembership` | — |
| `device` | devices, bindings, sessions, firmware channel | `authenticateDevice`, `bindScale`, `getActiveSession` | identity |
| `food` | brands, products, versions, GTINs, retailers, availability, sources | `searchFood`, `getProduct`, `getProductVersion` | — |
| `nutrition` | nutrient definitions, computation | `calculateNutrition(versionId, grams)` | food (read via interface) |
| `intake` | food logs, log items, meals | `logFood`, `getDailyIntake`, `getFoodHistory` | nutrition, identity |
| `energy` | energy models, expenditure events, balance snapshots | `getEnergyExpenditure`, `getEnergyBalance` | intake, wearable, identity |
| `macros` | macro targets, remaining | `getMacroTargets`, `getRemainingMacros` | energy, intake |
| `prediction` | forecasts, model runs | `getPrediction` | energy, intake |
| `wearable` | provider connections, raw syncs, normalized activity | `syncProvider`, `getActivity` | identity |
| `scale` | calibration records, weight capture events | `recordWeight`, `getCalibration` | device |
| `ai` | conversations, turns, tool calls, refusals | `handleUtterance` | all of the above, via tool registry only |
| `voice` | ASR/TTS session brokerage, phrase cache | `openSession`, `synthesize` | ai |
| `billing` | subscriptions, seats, entitlements | `getEntitlements`, `assertSeat` | identity |
| `analytics` | append-only event log | `emit` | — |

**Dependency rule:** `ai` may depend on everything. No *deterministic* module (`nutrition`, `energy`, `macros`, `intake`, `food`) may depend on `ai`. `voice` is an AI-adjacent edge module and may. `energy`, `macros` and `nutrition` may not depend on `ai`, `voice`, or `prediction` — this is what makes "deterministic and independent of the LLM" mechanically true rather than aspirational, and it is enforced in CI (`03`).

## 3. The determinism spine

Three engines are implemented as **pure functions in dependency-free packages** (`packages/domain-*`): no database access, no clock, no network, no randomness. Time and data are inputs.

```ts
// shape only — not implementation
calculateNutrition(basis: NutrientBasis, grams: number, calcVersion: string): NutritionResult
computeEnergyBalance(input: EnergySnapshotInput, calcVersion: string): EnergyBalance
computeMacroState(targets: MacroTargets, consumed: MacroTotals): MacroState
```

Consequences that pay for themselves:
- Golden-vector testing with thousands of cases and no fixtures.
- The same code runs on the tablet for instant local display and on the server for the authoritative value; divergence is a caught bug, not a mystery.
- `calcVersion` is stamped on every persisted result, so an engine change never silently rewrites history.
- The AI physically cannot compute these — it has no path to the numbers except a tool call.

## 4. Request paths

**Fast path (target ≤ 900 ms, ~70% of utterances).** Wake word (on-device) → streaming ASR → intent grammar match ("option B", "log it", "how much protein left", "tare") → direct tool call → templated response → cached TTS phrase. No LLM.

**LLM path (target ≤ 2.5 s p95).** ASR → domain gate → orchestrator → tool loop (≤ 3 tools typical) → response composer → numeric-fidelity validator → streaming TTS.

**Background paths.** Wearable sync (webhook or poll) → normalize → append expenditure events → invalidate balance snapshot → push over WSS to any live tablet/phone session. Food ingestion runs entirely in workers and never touches a request path.

## 5. Real-time state

The tablet holds a **session** object: `{ activeUserId, activeProductVersionId, lastWeight, tareState, pendingLogDraft }`. It is authoritative on the device and mirrored to the server for phone continuity. Balance updates are pushed to subscribed clients over WebSocket; the phone app polls on foreground as a fallback.

## 6. Deployment

- **Core API + workers**: single deployable image, two process types (`web`, `worker`), horizontally scaled. Workers are a separate process, not a separate service.
- **Database**: Supabase Postgres with pgvector; PITR enabled; read replica added when catalog search QPS warrants (`13`).
- **Queue**: `pg-boss` on the same Postgres. Deliberately avoids Redis/SQS until measured need.
- **Environments**: `dev` → `staging` (with a device fleet channel) → `prod`. Firmware and tablet builds have independent staged-rollout channels.
- **What is not here:** no Kubernetes, no service mesh, no message bus, no separate microservices, no second datastore. Per the brief, and because none of them buy anything at this scale.
