# 16 — Persistence

> **PERSISTENCE DOMAIN — IMPLEMENTATION COMPLETE, RUNTIME DB VALIDATION PENDING.**
>
> Every executable closure criterion passes. PostgreSQL, Docker and Supabase are
> not available in this environment (and there is no network egress), so
> migrations have never been executed and RLS has never been enforced by a real
> engine. RLS and concurrency are therefore **authored and statically asserted,
> not runtime-verified.** This document must not say CLOSED until they are.

## 1. What persistence must preserve

```
exact user + exact profile version + exact goal version + exact ProductVersion
+ exact WeightCapture + exact NutritionSnapshot + exact FoodLog identity
```

must survive storage and restart **without changing meaning or leaking between users**.

## 2. Tables

| Table | Nature |
|---|---|
| `user_profile_versions` | append-only, effective-dated, user-private |
| `energy_goal_versions` | append-only, effective-dated, user-private |
| `catalog_products` | **mutable** head: current version pointer, active flag |
| `product_versions` | **immutable** food facts, append-only |
| `food_logs` | immutable, append-only, user-private |

Five tables. No supporting tables were needed.

**Age is stored; date of birth is deliberately not.** We need the physiological
input, not a birth date.

## 3. Immutable version vs mutable head

`ProductVersion` carries no `isActive` and no current-version pointer — those
live in `ProductCatalogHead`. A correction **inserts V2 and repoints the head**;
V1 is never rewritten, and a log referencing V1 keeps meaning exactly what it
meant. Both the original label facts and the normalized per-100 g basis are
retained; the source label is never reconstructed from normalized data.

## 4. Identity and idempotency

Identity is **`(user_id, log_id)`**, never `log_id` alone — two users may
generate the same client id and one must never mask the other. It is the primary
key, so concurrency safety comes from the constraint rather than from
`SELECT`-then-`INSERT`.

```
INSERT ... ON CONFLICT (user_id, log_id) DO NOTHING
  → inserted        : appended
  → conflict        : read the canonical row, compare the immutable fingerprint
                        same payload      → replayed_existing
                        different payload → idempotency_conflict
```

Nothing is ever overwritten, and the result **always returns the canonical
stored item**. A conflicting replay is never reported as duplicate success —
that would silently discard a genuinely different log.

## 5. Snapshot consistency and column scale

First-class columns (`grams`, `kcal`, `protein_g`, `carbohydrate_g`, `fat_g`)
are a **rounded projection** of the authoritative JSONB snapshot, enforced by
CHECK constraints and re-checked on read.

**They agree at the column's declared scale, which is the only agreement
`numeric` can express.** Binary floating point produces values such as
`76.57000000000001` for ordinary inputs (31 g/100 g protein at 247 g).
`numeric(10,4)` rounds that on insert; comparing the raw JSONB value to the
rounded column would have rejected every such log. The snapshot stays
byte-exact and authoritative; daily totals sum snapshots, never the projections.

The composite FK `(product_version_id, product_id)` prevents a log claiming
product X while pointing at a version of product Y. All FKs are `ON DELETE
RESTRICT` — **no cascade may destroy historical nutrition.**

## 6. RLS and append-only

`user_profile_versions`, `energy_goal_versions`, `food_logs`: RLS `ENABLE` +
`FORCE`, `SELECT` and `INSERT` for `authenticated` scoped to
`user_id = auth.uid()`, with `WITH CHECK` on every INSERT so a row cannot claim
another user's ownership.

**There are deliberately no UPDATE or DELETE policies, and no UPDATE/DELETE
grants.** A missing policy here is not an oversight — it is the control.
Corrections will be modelled later as explicit append-only corrections.

The catalog is `SELECT`-only for `authenticated`; ordinary end users never
mutate it.

**No household owner may read another member's nutrition, profile or goals.**
That privacy rule remains locked and is expressed directly in the policies.

## 7. Security invariant

> No production application code may use a service-role credential to perform an
> ordinary user operation. User-scoped operations execute under user identity,
> subject to RLS. A future trusted worker may hold privileged credentials for
> specific administrative duties; that is not part of this milestone.

## 8. Boundaries

Narrow repository contracts — `FoodLogRepository`, `ProductVersionRepository`,
`UserProfileRepository`, `EnergyGoalRepository`. No ORM, no Active Record, no
generic repository framework. DB row shapes never leak into the pure domains.

**Every persisted structure is validated when crossing back into the domain** —
`WeightCapture`, `NutritionSnapshot`, `ProductVersion`, `UserProfileSnapshot`,
`FoodLogItem`. Malformed or corrupted rows fail loudly; nothing is silently
coerced.

`logFoodPersisted` resolves the version, profile and goal, validates ownership
and subject consistency, creates the item through the existing **pure** domain,
appends idempotently, re-reads the canonical local-day logs and runs the
existing recompute. **No arithmetic lives in SQL or repository code.**
`EnergyState` is never persisted as authoritative — it is always recomputed.

## 9. Pending runtime validation

- Migration execution against a real PostgreSQL.
- RLS enforcement, including the full cross-user matrix, under a real engine.
- Concurrent `(user_id, log_id)` writes: identical payloads → one row, one
  append, one replay; conflicting payloads → one immutable row and one
  idempotency conflict.
- The `DEFERRABLE INITIALLY DEFERRED` catalog-head FK inside a real transaction.
