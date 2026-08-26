# 17 — MVP-0 Tablet Application

> **APPLICATION DOMAIN — CLOSED FOR MVP-0.**
> **RENDERER EXECUTION PENDING TOOLCHAIN AVAILABILITY.**
>
> The complete application layer is implemented and adversarially tested.
> React Native / Expo are not installed and there is no network to install
> them, so no renderer source exists yet. Screen specifications and component
> boundaries are defined in `apps/tablet/README.md`.

## 1. Architecture

```
apps/tablet (renderer)        renders AppState, emits intents          [pending toolchain]
packages/tablet-app-core      ALL application behaviour                 ✅
packages/domain-food-search   deterministic ranking, PURE               ✅
packages/domain-*             closed deterministic domains              ✅
packages/persistence          repository boundary (in-memory adapter)   ✅
```

**LOCKED: touch and future voice are two input adapters onto the same
application intents.** No business rule lives in a button handler. The whole
loop runs with no presentation layer at all — that is a test, not a claim.

Intents: `beginAddFood` · `searchFood` · `selectProduct` · `selectOption` ·
`applyScaleEvent` · `requestStableWeight` · `enterManualWeight` ·
`cancelWeight` · `confirmFoodLog` · `cancelFoodFlow` · `switchActiveUser` ·
`refreshDashboard`.

## 2. Identity

`AppSubject { authenticatedSubjectId, userId, displayName }` is the single
place where the future authenticated subject meets the domain user id. Both
must be equal and **UUID-shaped**, because production stores `user_id uuid` and
RLS compares it to `auth.uid()`.

This closed a latent defect: the synthetic fixtures were `'user-a'`, which
cannot be inserted into a `uuid` column at all.

The active user is **never implicit** — it is owned by the session, displayed
on every screen, and every operation flows through it. Real auth/session
binding is an MVP-1 / runtime-backend concern.

## 3. Search

Pure, deterministic, transparent. No LLM, no embeddings, no vector store, no
network. Normalized text; exact > prefix > token-prefix > token > brand; an
unmatched query token disqualifies the product outright, so nothing is ever
half-matched into a guess. Recency is a bounded nudge that cannot outrank a
better textual match.

Ties break explicitly: **score DESC, displayName ASC, productVersionId ASC** —
never map iteration order. Reversing the catalog input produces identical
output, and that is tested.

Results carry `optionLabel` (A/B/C/D) so future voice can say "Option B"
without a screen coordinate, and `preparationStateDisambiguates` so raw and
cooked are visibly distinguished. **Raw and cooked are separate versions and
are never yield-converted.**

Only versions reachable through an **active** catalog head are searchable. A
de-listed product stays resolvable by id forever, so historical logs keep their
meaning.

## 4. Add-food flow

```
idle → searching → waiting_for_weight → reviewing → logging → completed
                                                          ↘ error
```

Business state lives in the controller; navigation is a projection of it.

**Both kitchen orders work.** Food-then-weight, and weight-then-food: a weight
already captured survives product selection, so the user is never made to lift
and re-place food because they named it second. (That was a real defect caught
in adversarial testing.)

**A stable candidate is not a capture.** The application must explicitly ask.
Twenty further stable readings produce nothing.

## 5. Weight

The scale provider is `ScaleSimulator` behind the existing logical protocol.
Low-level controls (tare, fault, overload, disconnect) live in a hidden
development panel; the consumer flow shows only *Scale connected / Place food
on scale / Stabilizing… / 250 g*.

**One timeline.** Device events are stamped with the application clock. Two
independent clocks made capture requests appear to travel backwards relative to
the candidate they were asking for — fixed, and a real production-shaped
constraint.

Manual weight uses `manualCapture()` and preserves manual provenance. Scale
provenance is never fabricated.

## 6. Review and logging

The preview comes from the same `calculateNutrition` the log will use — no
duplicated UI arithmetic anywhere. Confirmation routes through
`logFoodPersisted()`; the tablet never writes rows.

**Idempotency:** one logical submission holds one `logId`. A retry reuses it,
so a double tap cannot create two logs. Outcomes are distinct:
`appended` and `replayed_existing` are success; **`idempotency_conflict` is an
explicit, non-recoverable error and is never reported as success.**

## 7. Dashboard

Hero is `currentBalanceKcal`, then `targetDeltaKcal`, then `remainingIntakeKcal`
(eat to target), then remaining macros. Calories consumed is supporting
information. **There is no PAL and no PAL-derived "calories remaining".**

Every number is an engine output; presentation fabricates nothing.

## 8. Degraded states — logging is never blocked by energy

Nutrition logging and energy completeness are separate concerns. With no TEF
policy or no activity estimate the user still logs food normally; the dashboard
reports `energyIncomplete` with its reasons. Simulated activity is labelled as
`simulated`, never as wearable-measured truth, and a discreet
**DEVELOPMENT DATA** indicator marks synthetic fixtures.

## 9. Session and async safety

`sessionGeneration` increments on user switch; `flowId` identifies one add-food
interaction. A search result from a cancelled flow, or a logging response from a
previous user, cannot land on the current state. Switching users cancels the
flow, cancels any outstanding capture intent, discards the uncommitted selection
and weight, and reloads the dashboard. **User A's food can never be logged under
user B** — tested adversarially.

## 10. Restart

A new controller over the same repository rebuilds an identical dashboard.
**This is not a claim about process or database restart** — the MVP-0 adapter is
in-memory and does not survive a restart. Real restart durability depends on the
pending PostgreSQL runtime validation.
