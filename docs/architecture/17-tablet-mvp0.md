# 17 — MVP-0 Tablet Application

> **APPLICATION LAYER: CLOSED for MVP-0.**
> **RENDERER: EXECUTION PENDING TOOLCHAIN AVAILABILITY.**
>
> React Native, Expo and Metro are not installed and there is no network egress
> to install them. The complete application layer, interaction contracts and
> screen specifications exist and are tested; no renderer source was written,
> because `.tsx` against unresolvable packages would be a fake app.

## 1. The locked architecture rule

> **UI taps and future voice commands are two input adapters onto the same
> application behaviour.**

No business rule lives in a button handler. `TabletAppController` owns every
intent; a screen is a projection of `AppState` and a caller of intents. The
future AI layer routes into these same methods without simulating a tap.

## 2. Packages

| Package | Role |
|---|---|
| `@macros/domain-food-search` | PURE deterministic search and ranking |
| `@macros/tablet-app-core` | Application controller, state, ports, dev scale adapter |
| `apps/tablet` | Renderer — specification only, no source yet |

`tablet-app-core` is not pure (it holds a clock and an id generator) but is
purity-scanned as a production package: no LLM/ASR/TTS SDK, no test kit, no
transport library may enter it.

## 3. Application intents

`beginAddFood` · `searchFood(query)` · `selectOption('A'|'B'|'C'|'D')` ·
`selectProduct(productVersionId)` · `applyScaleEvent(event)` ·
`requestStableWeight()` · `enterManualWeight(grams)` · `cancelWeight()` ·
`confirmFoodLog()` · `cancelFoodFlow()` · `switchActiveUser(subject, activity)` ·
`refreshDashboard()` · `getState()`

Every one is reachable without a screen event. Asserted by test.

## 4. Identity

`AppSubject { authenticatedSubjectId, userId, displayName }`. The binding
`authenticatedSubjectId === userId` is asserted at construction and on every
user switch, and `userId` must be **UUID-shaped** — production stores
`user_id uuid` and RLS compares it to `auth.uid()`, so an opaque string would let
the application drift from a boundary that will reject it.

The active user is never implicit: the session owns it, the UI shows it, and no
logging function chooses one.

Real auth/session binding → MVP-1 / runtime-backend milestone.

## 5. Ports — ids and clocks at the edge

`Clock` and `IdGenerator` are the only doors non-determinism may enter through.
Tests inject fixed implementations; the pure domains never see either.

**One timeline.** The dev scale adapter re-stamps simulator events with the
*application* clock. A transport marks when an event reached the tablet, and the
tablet has one clock — the same one that stamps capture intent. Two independent
clocks made capture requests appear to travel backwards relative to the
candidate they asked for.

## 6. Search

Deterministic, transparent, no LLM/embeddings/vector store. Normalized text →
exact (1000) → prefix (800) → token-prefix (600) / token (400) → brand (300),
with a small recency nudge that can never outrank a better textual match. **An
unmatched query token disqualifies the product entirely** — nothing is ever
partially guessed.

Ties break `score DESC, displayName ASC, productVersionId ASC`, so ranking never
depends on map iteration. Only versions reachable through an **active** catalog
head are searchable; de-listed products stay resolvable by id so historical logs
keep meaning.

Results carry stable `optionLabel` A/B/C/D and a `preparationStateDisambiguates`
flag so raw vs cooked is visible exactly when it is the distinguishing fact.
Raw and cooked remain distinct versions — never yield-converted.

## 7. Add-food flow

```
idle → searching → waiting_for_weight → reviewing → logging → completed
                                     ↘ error
```

Business state lives in the controller, never in navigation.

**Both kitchen orders work.** Food-then-weight, and weight-then-food: a weight
already captured for the flow survives selection, so the user is never made to
lift and re-place food merely because they named it second.

**A stable candidate is not a capture.** The application must ask
(`requestStableWeight`), preserving the closed invariant
`StableWeightCandidate ≠ WeightCapture ≠ FoodLogItem`.

Manual weight uses `manualCapture()` and never fabricates scale provenance.

## 8. Review and logging

The review preview is produced by the same `calculateNutrition` the log will
use. **No arithmetic is duplicated in presentation.** Confirmation routes
through `logFoodPersisted()`; the tablet never writes rows.

**Idempotency.** One logical submission holds one `submissionId`, reused on
retry, so double-tapping cannot create two logs. Outcomes are distinct:
`appended` and `replayed_existing` succeed; `idempotency_conflict` is a
non-recoverable error state and is **never** reported as success.

## 9. Dashboard

North-star order: **CURRENT** (`intake − expenditure so far`), then TARGET EOD,
then EAT TO TARGET, then remaining protein/carbs/fat. Supporting: consumed,
expended so far, projected expenditure, activity source, energy completeness.

Calories consumed is never the hero. There is no PAL anywhere.

Every value comes from an engine result; presentation fabricates nothing.

## 10. Degraded states are honest, and never block logging

Nutrition logging and energy completeness are separate concerns. With no TEF
policy or no activity estimate the user still logs food, macros and intake; the
dashboard reports `energyIncomplete` with its gaps. Simulated activity is
reported as `simulated`, never as wearable-measured truth. A
`DEVELOPMENT DATA` notice marks synthetic foods and simulated activity.

## 11. Session and async safety

`sessionGeneration` increments on user switch; `flowId` identifies one add-food
interaction. A search result from a cancelled flow, or a logging response from a
previous user, is dropped rather than landing on the new session. Switching
users cancels the flow **and** any outstanding capture intent, so user A's
selection and weight can never be logged under user B.

Cancel at any stage clears the uncommitted product, weight and capture intent,
and leaves persisted logs untouched.

## 12. Repository injection

Repositories are injected explicitly. MVP-0 uses the in-memory adapters behind
the same interfaces as PostgreSQL. **In-memory data does not survive an
application restart** — the tablet test proves only that a fresh controller
rebuilds the same dashboard from the same repository. Real process/database
restart depends on runtime PostgreSQL validation.

## 13. Screens (specification)

`Dashboard` · `Food Search / Selection` · `Weight / Capture` · `Review / Confirm`,
plus a hidden development panel for scale controls. Premium, minimal, black and
charcoal, high contrast, generous whitespace, portrait-first. Large touch
targets; status never encoded by colour alone. Low-level protocol controls never
appear in the normal flow — the user sees "Scale connected / Place food on
scale / Stabilizing… / 250 g".
