# DEFERRED DECISIONS

Non-blocking items recorded during domain closure. **Do not derail a milestone
to implement these.** Each is revisited when its own milestone arrives.

## From PERSISTENCE DOMAIN CLOSURE (2026-08-13)

### IMPORTANT BUT DEFERABLE

| # | Item | Why deferred | Revisit at |
|---|---|---|---|
| P-1 | **Correction / void workflow for food logs.** Today logs are strictly append-only with `status` fixed at `'active'`. A user who mis-logs cannot correct it. | Correctness of *this* milestone does not require it, and the ruling explicitly says corrections are modelled later as append-only corrections. Designing it now would guess at product behaviour. | Tablet UX milestone, once we see how users actually mis-log |
| P-2 | **Privileged curation path for the catalog.** `catalog_products` and `product_versions` have no INSERT/UPDATE policy for `authenticated` — correct — but no privileged writer role is defined either, so nothing can currently populate the catalog in production. | Catalog ingestion is explicitly out of scope, and inventing a writer role now would prejudge the ingestion security model. | Catalog ingestion milestone |
| P-3 | **`auth.uid()` ↔ domain `userId` binding.** RLS compares `user_id` to `auth.uid()` (uuid). The domain treats `userId` as an opaque string. Nothing yet enforces that the application's `userId` *is* the authenticated uuid. | The application layer that holds a session does not exist yet. The invariant is recorded in the SQL and in §31. | Tablet application milestone |
| P-4 | **Connection-level `SET LOCAL role` / JWT plumbing.** The Postgres adapter emits SQL but no connection strategy exists, so "runs under user identity" is currently an architectural rule rather than executable code. | No runtime DB and no API layer exist. | Runtime DB integration |
| P-5 | **Retention and deletion (DSAR/erasure).** Append-only with no DELETE policy satisfies integrity, but a user erasure request currently has no mechanism. | Legal review of consumer-health-data obligations is still open; building a mechanism before the policy is decided would be guesswork. | Privacy/compliance milestone |
| P-6 | **Migration runner.** Migrations are ordered SQL files with no applied-versions table or runner. | Deliberate: no ORM/framework, and there is no database to run them against. | Runtime DB integration |

### FUTURE OPTIMIZATION — not implemented

- Partitioning `food_logs` by month; covering indexes for the daily-intake path.
- Materialized daily totals (today they are summed from stored snapshots on read).
- Connection pooling, read replicas, query timing instrumentation.
- Richer catalog search columns (trigram/FTS/vector) — belongs to the catalog milestone.

## From MVP-0 TABLET APPLICATION CLOSURE (2026-08-15)

### IMPORTANT BUT DEFERABLE

| # | Item | Why deferred | Revisit at |
|---|---|---|---|
| T-1 | **Renderer (`apps/tablet` React Native source).** React Native, Expo and Metro are not installed and there is no network to install them. Screen specifications, component boundaries and the full application layer exist; only the renderer is absent. | Writing `.tsx` against unresolvable packages produces code that neither typechecks nor runs. | When RN tooling is available |
| T-2 | **Real auth/session binding.** `AppSubject` closes the identity contract (`authenticatedSubjectId === userId`, UUID-shaped), but nothing yet fills it from a real session. | Supabase Auth and JWT plumbing are explicitly out of scope. | MVP-1 / runtime-backend |
| T-3 | **18+ age gate UI.** No onboarding screen is surfaced in MVP-0, so the gate has nowhere to live; the development profile already satisfies the constraint. | Onboarding is not part of this slice. | Onboarding milestone |
| T-4 | **Editing a completed flow.** After a successful log, changing the weight and confirming again correctly raises `idempotency_conflict` rather than silently editing. Honest, but a real correction workflow would be better UX. | Correction workflow is already deferred (P-1). | Correction workflow milestone |
| T-5 | **Search history/recency source.** The ranking supports a recency boost, but nothing yet supplies the user's recent product versions from the log repository. | Ranking quality belongs to the catalog + search data milestone. | Catalog + search closure |
| T-6 | **oz/lb presentation.** Grams only in MVP-0; conversion would be presentation-only. | Not needed for an internal harness. | Consumer UI polish |

### FUTURE OPTIMIZATION — not implemented

- Fuzzy/typo-tolerant matching, synonyms, stemming — belongs to search-quality evaluation in the catalog milestone.
- Result pagination beyond the top four options.
- Optimistic dashboard updates before the repository confirms.
- Undo/redo of an add-food flow.

## From CATALOG + SEARCH CLOSURE (2026-08-17)

### IMPORTANT BUT DEFERABLE

| # | Item | Why deferred | Revisit at |
|---|---|---|---|
| C-1 | **Real USDA FDC adapter.** The boundary exists and throws; the field/nutrient mapping must be written against an inspected source file, never from memory. | No source file and no network in this environment. | When an FDC file is supplied |
| C-2 | **The 200–500 food curated catalog.** The curation manifest, importer and reports are ready to produce it. | Requires C-1. Faking it would mean model-memory values labelled USDA. | With C-1 |
| C-3 | **Real search benchmark corpus.** The current 23 cases target synthetic fixtures; a real corpus must be authored against the real catalog. | A corpus names exact product-version ids, so it only scores the catalog it was written for. | With C-2 |
| C-4 | **Typo tolerance.** Deliberately not implemented: the benchmark shows no failure it would fix, and a wrong correction silently logs the wrong food. | Only add where measurement demonstrates a problem. | If a real benchmark shows typo failures |
| C-5 | **Alias persistence migration.** Aliases live in version-controlled data files; `catalog_product_aliases` was not added because nothing yet reads aliases from the database. | Not needed until the catalog is served from PostgreSQL. | Runtime DB integration |
| C-6 | **Branded/GTIN ingestion.** Contract compatibility exists (`brandName`, label serving); ingestion does not. | Brand identity, UPC, manufacturer updates and duplicate SKUs are a distinct problem. | Branded catalog milestone |
| C-7 | **Semantic/embedding search.** Explicitly excluded this milestone. | Only justified if measured quality on a real catalog shows lexical search failing. | After C-3 |

### FUTURE OPTIMIZATION — not implemented

- Search index materialization; the projection is rebuilt from versions + heads.
- Category-aware ranking and per-category benchmark gates.
- Steward review software (curation is version-controlled data by design).

## From BRANDED GROCERY PRODUCT CLOSURE (2026-08-18)

### IMPORTANT BUT DEFERABLE

| # | Item | Why deferred | Revisit at |
|---|---|---|---|
| B-1 | **Real branded source adapter.** The `SourceAdapter` contract accepts branded records; no real adapter exists. | Requires an approved source, reviewed usage rights and an inspected schema. None exist. | When an approved branded source is obtained |
| B-2 | **Density table for volume-only servings.** A label reading "1 cup" with no gram equivalent goes to curation. | A generic density assumption would produce confident wrong nutrition. | When a source-backed density set exists |
| B-3 | **Identifier history/supersession workflow.** The `superseded`/`conflicted` states and the unique partial index exist; no reassignment workflow drives them. | No real source produces reassignments yet. | Branded ingestion milestone |
| B-4 | **Package images.** `imageRef` is reserved on the card; nothing populates it and no product is unselectable without one. | Image rights are a separate sourcing concern. | Image sourcing milestone |
| B-5 | **Migration 0003 runtime validation.** Authored and statically tested; never executed. | No PostgreSQL in this environment. | Runtime DB gate |
| B-6 | **Branded search benchmark as real evidence.** The synthetic branded cases prove the architecture, not search quality. | Real metrics need a real branded catalog. | With B-1 |

### FUTURE OPTIMIZATION — not implemented

- Brand-token weighting tuned against a real branded corpus.
- Multi-source merge policies beyond strict priority ordering.
- Serving-size presets on the card (e.g. "log one serving").

## From MVP-1 VOICE ORCHESTRATION CLOSURE (2026-08-19)

| # | Item | Why deferred | Revisit at |
|---|---|---|---|
| VO-1 | **Microphone, wake word, STT and TTS integration.** The seam exists (`transcript → intent → application → response`); no vendor is chosen. | Explicitly out of scope; needs hardware and a vendor decision. | Runtime integration gate |
| VO-2 | **Richer NLU behind `VoiceParser`.** The deterministic grammar covers the MVP vocabulary only. | Only justified once real transcripts show where the grammar fails. | After real STT transcripts exist |
| VO-3 | **V-1: label macros outside version identity.** Declared per-serving protein/carb/fat and the serving description can change without producing a new ProductVersion, so a label-only correction is silently dropped. Documented with a falsifiable test; **A7 not changed unilaterally.** | A7 is a closed classification; widening the fingerprint is an owner decision. | Owner ruling |
| VO-4 | **Reverse quantity targets** ("200 calories of oats"). Currently refused. | Requires an explicit, deterministic reverse-calculation feature. | If the product wants it |

## From FOOD LOG CORRECTION CLOSURE (2026-08-20)

| # | Item | Why deferred | Revisit at |
|---|---|---|---|
| FC-1 | **Void persistence adapters.** Migration 0004 creates `food_log_voids`, but no repository method writes or reads it yet, so voids currently exist only in the pure fold. | The correction path is the one the tablet needs first; void UX is undesigned. | Correction UX milestone |
| FC-2 | **Application/voice correction intents.** No `correctFoodLog` / `voidFoodLog` controller intent yet — the domain and schema are ready, the UI affordance is not designed. | Designing the affordance before the interaction is known would guess. | Correction UX milestone |
| FC-3 | **Migration 0004 runtime validation.** Authored and statically tested; never executed. | No PostgreSQL in this environment. | Runtime DB gate |
| FC-4 | **Cross-day correction.** Refused today. Moving a meal to another local day needs an explicit operation that recomputes both days. | Not needed for MVP-1. | If the product wants it |

**VO-3 is RESOLVED** — declared label facts now participate in ProductVersion
version identity.

## From ASSISTANT BRAIN + TRUSTED TOOL ROUTER CLOSURE (2026-08-21)

| # | Item | Why deferred | Revisit at |
|---|---|---|---|
| AS-1 | **Real provider adapter** (OpenAI/Anthropic/Gemini). The `AssistantInterpreter` seam is complete; no SDK, network or key exists. | Out of scope by instruction; needs a provider decision, timeout and cost policy. | Provider integration gate |
| AS-2 | **Adapter-layer timeout/cancellation.** The router handles throws and malformed output; a wall-clock timeout belongs to the IO adapter, which does not exist yet. | Nothing to time out without a provider. | With AS-1 |
| AS-3 | **AI phrasing seam.** Deterministic phrasing is retained. If AI phrasing is ever added, numbers must be injected from trusted structured results, never regenerated. | Not required for MVP-1. | Post-provider |
| ~~AS-4~~ **RESOLVED** | **Correlation fields are optional in the contract.** `sessionGeneration`, `turnSequence` and `flowIdAtCapture` are strictly enforced WHEN SUPPLIED; a pipeline that omits them loses the corresponding protection. Should become mandatory once a real STT adapter owns them. | Making them required now would break every non-STT caller for no safety gain. | STT integration |
| AS-5 | **Household voice user switching.** Locked rule recorded: switching must require visible/spoken confirmation and never happen silently. Not built. | No household domain exists. | Household milestone |

**VO-3 is RESOLVED** — declared label facts participate in ProductVersion
version identity.

## From PRODUCTION RUNTIME FOUNDATION CLOSURE (2026-08-22)

| # | Item | Why deferred | Revisit at |
|---|---|---|---|
| RT-1 | **PostgreSQL runtime validation** — migrations, RLS matrix, DB concurrency, privileged/app connection split. Runner logic is tested against a driver interface; no DDL has executed. | No PostgreSQL, Docker or Supabase CLI in this environment. | Owner unblock |
| RT-2 | **React Native tablet renderer.** Architecture and screen inventory defined; no code. | react-native/expo not installable — registry returns 403. | Owner unblock |
| RT-3 | **Local pending food-log capture** during backend loss. Declared `offline_unavailable` rather than half-built. | Sync must retain submissionId, version, snapshot, capture and timezone, and merge idempotently — a domain of its own. | Offline resilience milestone |
| RT-4 | **Offline catalog cache** for food search. | Needs a real catalog first. | After catalog population |
| RT-5 | **Real auth provider.** Contract and binding complete; only a fake provider exists. | No provider chosen or reachable. | Provider integration |
| RT-6 | **Postgres driver adapter.** `MigrationDriver` and repository interfaces exist; no `pg` client. | `pg` not installable. | With RT-1 |

**AS-4 is RESOLVED** — correlation is mandatory at the executable voice boundary.

## ROADMAP GATE — persistence runtime validation

> **Before any external or user pilot with production-like persistence:**
> run the migrations, the full cross-user RLS matrix, and the concurrent
> `(user_id, log_id)` idempotency tests against a real PostgreSQL / Supabase.
>
> Persistence remains **IMPLEMENTATION COMPLETE, RUNTIME DB VALIDATION
> PENDING** until that gate passes. It does not block product milestones.
