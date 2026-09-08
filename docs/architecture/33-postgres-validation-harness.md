# 33 — PostgreSQL Runtime Validation

> **RT-1 POSTGRESQL RUNTIME VALIDATION — CLOSED**
> **POSTGRESQL / RLS FOUNDATION — FROZEN**
>
> Executed against **real PostgreSQL 17.11**, database `macros_dev`, Unix socket
> `/tmp`. Final result: **PASS — all runtime assertions succeeded.**

## 1. Why this document is different

Every earlier claim about migrations 0001–0005 rested on static inspection. This
one rests on execution. The distinction mattered: the live server exposed defects
that reading the SQL had not, and it also cleared three "failures" that turned
out to be harness bugs rather than schema problems.

## 2. Validated artifact

The schema below is what actually ran. `0001` hashes to `893f053…`, which is the
file checksum the server itself reported during the drift test — the validated
schema is byte-identical to what is committed.

| Migration | SHA-256 (first 16) |
|---|---|
| `0001_core_schema.sql` | `893f053bad0fc8fa` |
| `0002_rls.sql` | `bfce51222390960f` |
| `0003_catalog_identifiers.sql` | `3e2e99c2d8e79294` |
| `0004_food_log_corrections.sql` | `d2dfaef3317cbfc1` |
| `0005_households.sql` | `6a377b9183381322` |

## 3. Runtime-validated results

| Area | Result |
|---|---|
| Connectivity | PASS |
| Migrations 0001–0005 | PASS (applied, then skipped on re-run) |
| Ledger / re-run / checksum-drift refusal | PASS |
| Data-integrity adversarial matrix | PASS |
| Catalog head-ownership FK (deferred, composite) | PASS — SQLSTATE 23503 |
| RLS user isolation | PASS — both directions; forged insert denied 42501 |
| **Household privacy** | PASS — owner reads none of a member's nutrition while administering |
| Household ownership transfer | PASS — all adversarial cases |
| RLS recursion protection | PASS |
| Connection identity clearing | PASS — after COMMIT, ROLLBACK and ERROR |
| Catalog permissions | PASS — readable, not mutable by ordinary users |
| Correction / void isolation | PASS |
| **32 concurrent submissions** | PASS — exactly 1 row |
| SQL-level offline replay / conflict | PASS |

Sandbox suite at the validated commit: **1,369 tests, 0 failures.**

Development timings (not SLAs): daily logs 23 ms · RLS profile 22 ms ·
membership 22 ms.

## 4. Precision — what these results do NOT prove

These limits are part of the evidence, not footnotes to it.

- The 32-session race proves **database uniqueness**. It does **not** prove the
  application's `inserted` / `replayed_existing` / `idempotency_conflict`
  classification, because no repository code participated in the race.
- The offline test proves **SQL-level duplicate and overwrite prevention**. It
  does **not** prove client ACK handling or outbox settlement, because the
  offline sync adapter did not participate.
- **RT-6 — a real application PostgreSQL driver — remains separate and pending.**
  The local driver for validation was `psql`. No production Node code talks to
  PostgreSQL yet.

## 5. What the live server found that reading did not

Recorded because it is the argument for executing rather than reviewing:

- `CHECK` accepts UNKNOWN, so a **missing** JSON key satisfied a constraint that
  a wrong value would have failed.
- Household RLS policies self-queried `household_memberships`, causing infinite
  recursion across the whole household schema.
- Ownership transfer was **impossible** — the unique-owner index and the admin
  policy were individually correct and jointly deadlocked.
- The catalog head FK allowed one product to adopt another product's version.
- Several harness bugs that would each have produced a false green: expected
  negatives contaminating the failure count, `check_violation` accepted as proof
  of authorization, and boolean/format parsing failing a role that was correct.

## 6. Frozen

The PostgreSQL and RLS foundation is frozen. Migrations 0001–0005 and the
policies, helpers and constraints they define are not to be modified without new
runtime evidence of a defect.


## Migration 0006 — guidance admission

`0006_guidance_admission.sql`
**checksum `9c41feed9ee7b619`**
**runtime status: pending owner execution**

Distributed cost admission for the paid guidance provider: subject, lease
expiry and a short-window count of ADMITTED calls. No prompts, conversations,
model responses or nutrition data. RLS is enabled and forced with no policy, so
the table is reachable only by server authority.

It is applied by the migration runner, which owns the file, its checksum, the
transaction, the schema change and the ledger row atomically — never by
`psql -f`:

```bash
PGHOST=/tmp npm run postgres:validate          # applies 0006 + ledger row
PGHOST=/tmp npm run postgres:guidance-validate # proves it against real PostgreSQL
```

When `postgres:guidance-validate` exits zero against `macros_dev`, this exact
checksum becomes the runtime-validated artifact and the status line above is the
only thing that changes. Until then the checksum is a candidate, and the frozen
0001–0005 pin deliberately excludes it: recording evidence that does not exist
would be worse than recording a gap.
