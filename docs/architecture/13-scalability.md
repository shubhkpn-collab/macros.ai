# 13 — Scalability Strategy

> **PARTIALLY SUPERSEDED — owner rulings A–H, 2026-08-10.** Where this document conflicts with `DECISION-LOCK.md`, the Decision Lock governs. See `CHANGE-REPORT.md`.


## 1. Where the load actually is (and isn't)

Per-user transactional volume is tiny: roughly 4–8 logs, ~50 wearable samples, a handful of balance recomputes and maybe 20 voice interactions per day. **100,000 households ≈ a few million rows/day and low hundreds of write QPS.** Postgres handles this on a single well-sized instance for years.

The real scaling axes are different:

| Axis | Pressure | Grows with |
|---|---|---|
| **Catalog size & search** | Millions of product versions, fuzzy + vector search per utterance | Market coverage |
| **Ingestion** | Millions of records reprocessed on normalization changes | Sources × refresh cadence |
| **Voice concurrency** | Simultaneous ASR/TTS streams, WebSocket fan-out | Peak meal times (extremely spiky: ~6–8pm local) |
| **LLM cost & latency** | Per-interaction, not per-user | Interaction volume |
| **Recompute storms** | Wearable backfills triggering many-day recomputes | Wearable adoption |

Optimizing the OLTP path is premature. Optimizing search, ingestion and voice concurrency is not.

## 2. Load shape

Meal-time spikes are the defining characteristic: a US-wide dinner peak concentrates most daily interactions into ~3 hours, and it moves across timezones. Design for **4–6× average at peak**, autoscaled on the web process, with the worker process scaled independently (ingestion can be throttled during peak; it has no user-facing SLA).

## 3. Database strategy

**Stage 1 (0–50k households):** single Postgres. Correct indexing, connection pooling (PgBouncer transaction mode), `pg-boss` for jobs. Nothing else.

**Stage 2 (50k–250k):**
- Read replica for catalog search — it is read-only and the highest-QPS query class.
- Partition `analytics.events`, `energy.expenditure_events` and `wearable.activity_samples` monthly.
- Materialize `balance_snapshots` aggressively; the dashboard reads a snapshot, never recomputes on request.
- Cache hot product versions and household pantries (in-process LRU first; a shared cache only when measured).

**Stage 3 (250k+):**
- Extract the **food catalog** as the first service (see §5) with its own database — it shares no transactional consistency requirements with user data.
- Consider sharding user data by `household_id` only if the single instance is genuinely saturated; at this volume it likely won't be.

## 4. Search scaling

Postgres FTS + `pg_trgm` + pgvector HNSW is sufficient to several million products with correct indexing and a read replica. Beyond that, or if p95 search latency threatens the 900 ms voice budget, extract a dedicated search index — the ranking pipeline in `05 §4` is already a separate stage, so this is a swap of candidate generation, not a redesign.

**The best search optimization is the pantry model.** Most utterances resolve from a household's ~100 known products, which fits in memory and never touches the main index. This is a latency *and* accuracy *and* cost win simultaneously.

## 5. Extraction seams (in the order they should be cut)

1. **Food catalog + ingestion** — different read/write ratio, different scaling curve, no user data, license-firewall isolation benefit.
2. **AI orchestration** — bursty, IO-bound on external providers, benefits from independent scaling and independent deploy cadence for prompt changes.
3. **Voice gateway** — long-lived connections and audio streaming have a different resource profile from a request/response API.
4. **Analytics** — export to a warehouse rather than growing the OLTP database.

Everything else (identity, energy, intake, macros, billing) stays in the monolith indefinitely. Splitting the energy engine into a service buys nothing: it is a pure function.

Extraction is cheap because of `03` — pure domain packages carry no transport assumptions, and modules are already accessed through a single exported interface.

## 6. Cost scaling

Unit economics matter because the primary user pays no subscription. Per-interaction cost = ASR + LLM + TTS.

| Lever | Effect |
|---|---|
| Deterministic fast paths (`07 §1`) | Removes the LLM from ~70% of interactions |
| Cached TTS phrases | Removes synthesis cost from most confirmations |
| Tiered models (tiny gate → mid orchestrator) | Large reduction vs one big model everywhere |
| Pre-loaded balance context | Removes tool round-trips for the most common question |
| On-device ASR for fast-path grammar (later) | Removes streaming ASR cost for the majority of utterances |
| On-device wake word | Already removes all always-on audio cost |

Track **cost per active household per month** as a first-class metric from Phase 5, with per-interaction attribution in `ai.tool_calls`.

## 7. Recompute containment

Wearable backfills are the one operation that can amplify: one webhook → N days × M users of recomputes. Controls: idempotent jobs keyed by `(user, day)`, coalescing within a debounce window, priority queues (today's recompute beats a 30-day backfill), and a per-user rate limit. Closed days older than the adaptive-TDEE window are recomputed lazily on view.

## 8. International expansion (architectural readiness, not MVP work)

Already accommodated by design: `country`/`region_code` on availability and retailers, per-region catalog partitions, locale-aware units and nutrient panels (EU per-100g labeling differs from US per-serving), timezone-aware day boundaries, and a `SpeechProvider` abstraction for other languages. Expansion becomes a data and localization program rather than a re-architecture — which is the stated requirement.

## 9. Reliability targets

| Surface | Target |
|---|---|
| Core API availability | 99.9% |
| Voice end-to-end success | 99.5% |
| Offline logging | Always available |
| Data durability | PITR, tested restores quarterly |

The offline path is the real reliability strategy: a kitchen appliance that stops working when a provider has an outage is a bad appliance. Logging must never depend on the cloud.
