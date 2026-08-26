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

## From GOAL-AWARE RECOMMENDATION CLOSURE (2026-08-23)

| # | Item | Why deferred | Revisit at |
|---|---|---|---|
| RC-1 | **Authoritative allergen data.** No allergy-safe capability exists and allergen absence is never inferred. Required before any restriction-aware recommendation. | No source-backed allergen metadata is ingested. | Allergen data domain |
| RC-2 | **Preference persistence.** `PreferenceSnapshot` is a contract; no repository, migration or UI stores it. | Needs a settings surface. | Preferences milestone |
| RC-3 | **User-saved portion presets.** Listed as a valid portion basis in policy; not implemented. | No UI to create one. | Preferences milestone |
| RC-4 | **Recipes, multi-food meals, meal plans.** Out of scope by instruction; each needs its own data and domain. | Different problem shape entirely. | Post-catalog |
| RC-5 | **Real-catalog ranking quality.** Scoring is validated for correctness and determinism, not for real-world usefulness — that needs hundreds of real foods. | 0 real records ingested. | After catalog population |
| RC-6 | **AI phrasing of rationale codes.** Codes are deterministic; phrasing is deterministic too. Optional AI phrasing must inject trusted numbers, never regenerate them. | Not required. | Post-provider |

## From NUTRIENT TRACKING + REAL USDA CLOSURE (2026-08-25)

| # | Item | Why deferred | Revisit at |
|---|---|---|---|
| NU-1 | **Reviewed micronutrient target policies.** Tracking and targets are separate concerns; no default vitamin/mineral targets exist and none are invented. | Requires dietitian review. | Target policy milestone |
| NU-2 | **Micronutrient-aware recommendations.** Ranking stays goal-aware on energy and the macro four; micronutrients are informational only, with no hidden weights. | Needs an explicit reviewed policy. | Post target policy |
| NU-3 | **Nutrient insights.** Contracts allow arithmetic statements ("averaged 18 g fiber over 7 days"); no interpretation, and no deficiency claims. | Medical interpretation is out of scope. | Insights milestone |
| NU-4 | **IU→µg conversion.** Refused because the factor is substance-specific. Would need per-substance, per-source rules. | Not defensible generically. | If a source forces it |
| CA-7 | **Search aliases for real vocabulary.** "cheddar cheese" and "greek yogurt" miss because USDA writes "Cheese, cheddar". | Alias curation is its own pass. | Catalog expansion |
| CA-8 | **Seed expansion beyond 500.** 3,647 defensible candidates exist; publishing more needs category curation, not more source data. | Quality over count. | Catalog expansion |
| CA-9 | **Unresolved-preparation curation.** 4,490 records rejected for not stating raw/cooked. Many are usable with human curation. | Never guessed. | Catalog expansion |
| CA-10 | **203 unmapped USDA nutrients** (fatty acids, amino acids, carotenoid fractions). Reported, never guessed. | Needs canonical registry entries first. | If product needs them |

## From GENERIC CATALOG SEMANTIC INTEGRITY CLOSURE (2026-08-25)

**CA-7 (aliases) RESOLVED** — curated consumer vocabulary shipped; Top-1 97.5%.
**CA-9 (preparation curation) RESOLVED** — taxonomy extended to `as_sold`;
unresolved fell from 4,459-equivalent to 5 of 395.

| # | Item | Why deferred | Revisit at |
|---|---|---|---|
| CA-8 | **Catalog depth.** SR Legacy archive is absent this session, so depth is bounded by Foundation (307 published). | Needs the archive re-supplied. | Owner re-upload |
| CA-11 | **Cross-source overlap resolution.** Assessment logic and source priority are implemented and tested, but no Foundation/SR pairs existed to resolve. | Requires both archives. | With CA-8 |
| CA-12 | **Remaining search misses** ("tortilla", "whole wheat bread") are catalog gaps, not ranking failures. | Source does not contain them. | With CA-8 |
| CA-13 | **Typo tolerance / embeddings.** Not added — the expanded benchmark shows no failure class lexical matching cannot handle. | Measurement first. | If a benchmark demands it |
| RC-5 | **Recommendation quality on real foods** — 7 scenarios reviewed, all sensible (protein gap → lean fish, fat gap → cream/nuts). Not user-validated. | Needs real users. | Post-pilot |

## From CATALOG INTEGRITY PATCH (2026-08-25, second pass)

**CA-8 / CA-11 / CA-12 REMAIN OPEN — SR Legacy was not present this session.**
The archive reported as re-supplied is absent from uploads; only Foundation
(`27d1fe3f…`) is available. Its contents were not synthesized or recalled.

| # | Item | Why deferred | Revisit at |
|---|---|---|---|
| CA-8 | Catalog depth — 307 published from Foundation alone. | SR Legacy archive absent. | Owner re-upload |
| CA-11 | Cross-source overlap resolution. Logic and source priority implemented and unit-tested; **no cross-source pairs existed to resolve**. | Requires both archives. | With CA-8 |
| CA-12 | Search misses ("tortilla", "whole wheat bread") are catalog gaps. | Source lacks them. | With CA-8 |
| CA-14 | **Preparation-aware retrieval.** "cooked ground turkey" misses because the record reads "pan-broiled crumbles" — search matches display text, not `preparationState`. Measured, not guessed. | Touches the frozen search domain; 1 of 12, and no wrong-preparation outranking. | Search ranking milestone |
| CA-15 | Administrative source-text normalization (e.g. "Includes foods for USDA's Food Distribution Program") — rule not written because no such text exists in Foundation. | Needs SR evidence to design against. | With CA-8 |

## From TWO-SOURCE CATALOG CLOSURE (2026-08-25)

**CA-8 RESOLVED** — 6,876 published foods from Foundation + SR Legacy.
**CA-11 RESOLVED** — 92 cross-source concept convergences measured; identity is
source-independent in practice, not just by construction.
**CA-12 RESOLVED** — tortilla and whole-wheat bread now available; 48/48 common
concepts covered.
**CA-14 RESOLVED** — preparation-aware retrieval matches canonical state;
30/30 preparation-sensitive queries correct, zero wrong-state outranking.
**CA-15 RESOLVED** — administrative-text rule derived from real SR evidence
(57 annotated records), with the 871 meaningful-parenthesis records untouched.

| # | Item | Why deferred | Revisit at |
|---|---|---|---|
| CA-16 | **Cross-comma display repetition** (40 cases, e.g. "cooked in skin, skin"). Mostly USDA's own wording; within-phrase inversion duplication is 0. | Cosmetic; editing risks removing real qualifiers. | Display polish |
| CA-17 | **170 possible-duplicate pairs** retained as a steward queue ("Flour, soy, defatted" vs "Soy flour, defatted"). Never auto-merged. | Needs human curation. | Curation tooling |
| CA-18 | **"green beans"** is the sole remaining search miss (USDA writes "Beans, snap, green"). | One alias would fix it; adding after the benchmark froze would be fitting to the test. | Next alias pass |
| CA-13 | Typo/fuzzy matching — still no demonstrated need at 98.8% Top-1. | Measurement first. | If a benchmark demands it |
| RC-5 | Recommendation quality — engineering evaluation only. | Needs real users. | Post-pilot |

## From BRANDED CATALOG CLOSURE (2026-08-25)

**B-1 RESOLVED** — real USDA Branded adapter populated 243,004 products.
**B-3 RESOLVED** — GTIN lifecycle validated on real duplicate groups and 82 real
identifier conflicts, with barcode lookup 500/500 exact.
**B-6 RESOLVED** — real branded search baseline established.
**B-2 REMAINS DEFERRED** — 31,508 volume-only servings still lack a defensible
gram basis; no density conversion was invented.
**B-4 REMAINS PENDING** — no package images; nothing scraped.

| # | Item | Why deferred | Revisit at |
|---|---|---|---|
| BR-1 | **Full-release ingestion.** A 250,000-record window was processed at ~1,600 rec/s; the full release is larger. | Bounded by run time, not by design — the streaming path is unchanged. | Full import run |
| BR-2 | **82 identifier conflicts** quarantined for curation. | Needs human adjudication. | Curation tooling |
| BR-3 | **Retailer brandOwner ambiguity** — bare "Wal-Mart" matches thousands of products. | Needs brand-vs-retailer modelling. | Branded search polish |
| BR-4 | **labelNutrients per-serving facts** captured in source but not yet surfaced as label facts on the card. | Card work, not ingestion. | Branded UX |

## From BRANDED FULL-RELEASE CLOSURE (2026-08-25)

**B-1 RESOLVED** — full April 2026 release ingested: 455,458 records →
434,714 products, 443,571 immutable ProductVersions.
**B-3 RESOLVED** — GTIN lifecycle validated over 1,311,288 real update edges.
**B-6 RESOLVED as an ENGINEERING BASELINE** — explicitly not user-validated.
**BR-1 RESOLVED** — full release, no window.
**BR-2 REPLACED** — the old 82-conflict figure was a brand-string artifact; the
adjudicated counts are 8,857 confirmed updates, 10,779 reassignment conflicts,
709 needs-review.
**BR-3 RESOLVED** — brandName / subbrandName / brandOwner modelled separately,
with consumer brand ranked above corporate owner.
**BR-4 RESOLVED** — labelFacts retained on all 443,571 versions and surfaced
through the ProductCard contract.

| # | Item | Why deferred | Revisit at |
|---|---|---|---|
| BR-5 | **Branded search corpus depth.** 26 scored queries over a bounded 119,388-product slice; a full in-memory token index OOMs. | Needs a disk-backed search index to benchmark the whole catalog. | Search scale milestone |
| BR-6 | **11,488 conflict / needs-review groups** await human adjudication. None resolves via barcode. | Requires curation tooling and human judgement. | Curation tooling |
| B-2 | **Volume→gram density.** 31,508+ volume-only servings still have no defensible gram basis. | No approved density source. | Density policy |
| B-4 | **Package images.** Nothing scraped. | Licensing. | Image sourcing |
| RC-5 | Recommendation quality — engineering evaluation only. | Needs real users. | Post-pilot |

## From OFFLINE RESILIENCE CLOSURE (2026-08-26)

**RT-3 RESOLVED** — durable pending food-log capture and idempotent sync are
engineering-closed, including crash-after-accept and in-flight recovery.
**RT-4 RESOLVED** — a real offline catalog cache exists: 6,877 generic and
409,552 branded current products with full authority, 768 MB total.

| # | Item | Why deferred | Revisit at |
|---|---|---|---|
| OF-1 | **PLATFORM SECURE LOCAL STORAGE VALIDATION.** Pending logs are private nutrition behaviour and must live in keystore-backed storage. Implemented as a port; the filesystem adapter reports `isSecure: false` and is development-only. | No Android/RN tooling. | Device tooling |
| OF-2 | **Offline correction/void sync.** Base food-log sync is closed; typed correction operations are not transported yet. The outbox payload can carry them without a rewrite. | Correction application paths are not complete. | Correction UX milestone |
| OF-3 | **Bundle download/staging over the network.** Verification, atomic activation and last-known-good rollback are implemented and tested against the filesystem. | No device update channel. | OTA milestone |
| OF-4 | **On-device ASR for offline voice.** Cloud voice is reported unavailable rather than hanging. | No local ASR. | Voice runtime |

## From HOUSEHOLD IDENTITY CLOSURE (2026-08-27)

**AS-5 RESOLVED** — household voice switching with trusted membership resolution
and explicit confirmation; no biometrics, no LLM-supplied identity.
**OFFLINE RESILIENCE REFROZEN** — corrupt records quarantined with degraded
integrity surfaced, per-entry checksums, exact eligibility ledger.

| # | Item | Why deferred | Revisit at |
|---|---|---|---|
| HH-1 | **PostgreSQL RLS runtime validation** for households. Migration 0005 authored and statically tested; no policy executed. | No PostgreSQL. | Runtime DB gate |
| HH-2 | **Real auth provider.** The domain consumes a trusted subject; only a fake provider exists. | No provider chosen. | Auth integration |
| HH-3 | **Billing provider and seat commercial policy.** Seats are capacity-only; grace periods and restrictions undesigned. | Separate domain. | Billing milestone |
| HH-4 | **Invitation delivery** (email/SMS) and multi-owner households. | Out of scope. | Household UX |
| OF-5 | **Outbox repair/export tooling** for quarantined records. They are retained, never auto-deleted. | Needs a UX decision. | Support tooling |

## From SHARED-DEVICE AUTHENTICATION (2026-08-25)

**HH-2 REMAINS OPEN.** A fake dev adapter is not a provider.

| # | Item | Why deferred | Revisit at |
|---|---|---|---|
| HH-2 | **Real online auth provider.** The boundary and mint path are closed; no Supabase/Auth0/Firebase integration exists. | Deliberately out of scope. | Provider selection |
| AU-1 | **Platform secure offline member unlock.** Device-local credential verification needs Android keystore-backed storage. Explicitly NOT resolved by the existence of a port — no plaintext PIN, password or biometric material is stored anywhere, and nothing here may be called secure device unlock. | Pending Android tooling. | Android runtime work |
| AU-2 | **Session persistence across restart.** With no secure persistent session proof available, restart must degrade to a neutral/locked state rather than reopening the last user. | Depends on AU-1. | With AU-1 |
| OF-6 | **Outbox repair tooling** for quarantined records, now addressable by opaque `storageRef`. | Operational tooling. | Support tooling |

## PostgreSQL RUNTIME VALIDATION — CLOSED (2026-08-26)

Executed against real PostgreSQL 17.11 / `macros_dev`. **PASS — all runtime
assertions succeeded.** Sandbox suite at that commit: 1,369 tests, 0 failures.

**RESOLVED by execution:**

| # | Item | Proven by |
|---|---|---|
| RT-1 | PostgreSQL runtime validation | full green run |
| P-3 | auth.uid ↔ domain user binding | RLS isolation, forged-insert denial (42501) |
| P-4 | connection identity plumbing | identity cleared after COMMIT, ROLLBACK and ERROR |
| P-6 | migration runner | apply, skip-on-rerun, checksum-drift refusal |
| B-5 | migration 0003 runtime validation | catalog permissions and identifier schema |
| FC-3 | migration 0004 runtime validation | correction/void isolation |
| HH-1 | migration 0005 RLS runtime validation | household privacy, transfer, no recursion |

**POSTGRESQL / RLS FOUNDATION — FROZEN.** Migrations 0001–0005 and their
policies, helpers and constraints are not modified without new runtime evidence.

**STILL OPEN — precision preserved:**

| # | Item | Why it is NOT closed |
|---|---|---|
| RT-6 | **Real application PostgreSQL driver** | Validation used `psql`. No production Node code talks to PostgreSQL. |
| RT-7 | **Application idempotency classification** | The 32-session race proved *database* uniqueness only. `inserted` / `replayed_existing` / `idempotency_conflict` is a repository behaviour and no repository code participated. |
| RT-8 | **Offline client ACK / outbox settlement** | The offline test proved SQL-level duplicate and overwrite prevention. The sync adapter did not participate. |
| P-2 | Catalog privileged ingestion path | Not built. |
| — | `package-lock.json` / `npm ci` | Generated on the Mac; commit it to close. |

## Superseded: PostgreSQL FIRST REAL EXECUTION (2026-08-26) — PARTIAL

Executed on PostgreSQL 17.11 against `macros_dev`. **Migrations 0001–0005
applied successfully for the first time**, re-run correctly skipped all five,
and the ledger holds 5 rows. Schema verified live: 14 tables, 13 with RLS, 21
policies, 29 indexes.

A harness accounting bug aborted the run before the behavioural suites, so:

- **RT-1 REMAINS OPEN** — RLS matrix, household privacy and idempotency
  concurrency have **not** executed.
- **P-6 (migration runner) — runtime validated**: apply, skip-on-rerun,
  checksum-drift refusal all proven against a real server.
- P-3, P-4, B-5, FC-3, HH-1 remain open pending the behavioural run.

## Superseded: PostgreSQL attempt (earlier 2026-08-26) — BLOCKED, nothing resolved

A PostgreSQL 17 server is running on the owner's Mac, but this execution
environment is a sandboxed Linux VM with **no default route and no egress**;
`127.0.0.1:5432` is the container's own loopback. Reachability was tested, not
assumed. No simulation was performed and **no deferred item was resolved**.

RT-1, P-3, P-4, P-6, B-5, FC-3 and HH-1 all **remain open** — every claim about
migrations 0001–0005 still rests on static inspection alone.

Handoff artifacts: `macros-postgres-handoff.bundle` (verified complete history)
plus `README-POSTGRES-HANDOFF.md`.

## ROADMAP GATE — persistence runtime validation

> **Before any external or user pilot with production-like persistence:**
> run the migrations, the full cross-user RLS matrix, and the concurrent
> `(user_id, log_id)` idempotency tests against a real PostgreSQL / Supabase.
>
> Persistence remains **IMPLEMENTATION COMPLETE, RUNTIME DB VALIDATION
> PENDING** until that gate passes. It does not block product milestones.
