# 33 — PostgreSQL Validation Harness

> **POSTGRESQL VALIDATION HARNESS — ENGINEERING READY FOR MAC EXECUTION**
> **POSTGRESQL RUNTIME VALIDATION — PENDING OWNER MAC EXECUTION**
>
> **FIRST REAL EXECUTION: 2026-08-26, PostgreSQL 17.11, database `macros_dev`.**

## Real execution evidence

| Result | Status |
|---|---|
| Connectivity (`PGHOST=/tmp`) | **VALIDATED** |
| Safety guard (`macros_dev` only) | **PASS** |
| Test auth prerequisite | **PASS** |
| **Migrations 0001–0005, run 1** | **applied=5, skipped=0 — FIRST REAL EXECUTION PASSED** |
| Migrations, run 2 (idempotency) | applied=0, skipped=5 — **VALIDATED** |
| Ledger rows | 5 |
| Checksum-drift refusal | **behaviour proven** (`deadbeef` refused) |
| Schema | tables=14, rls_enabled=13, policies=21, indexes=29 |
| RLS behavioural matrix | **NOT YET EXECUTED** |
| Idempotency concurrency | **NOT YET EXECUTED** |
| Household database privacy | **NOT YET EXECUTED** |

The migrations are real now: 14 tables, 21 policies and 29 indexes exist in a
live database, and the ledger correctly skips on re-run.

### The harness accounting bug the real run exposed

`apply_migrations` both incremented the global `FAILURES` counter **and**
returned nonzero on checksum drift. That is right for unexpected drift during
normal setup — and wrong for the deliberate probe that injects drift precisely
to prove the runner refuses it. The probe printed its `[OK]`, the counter stayed
incremented, and the setup gate aborted a run that had just succeeded.

**Fix:** the helper now reports only through its return status (`0` consistent,
`3` drift refused, `1` apply failed) and touches no global state. Each caller
decides what a nonzero result means. `step()` was audited for the same pattern
and is correct, because every one of its call sites is a positive expectation.

Restoration is now asserted rather than assumed: the ledger checksum is read
back and compared against the file's SHA-256, and a failed restoration is a real
failure.

### Note on database state

`macros_dev` is legitimately no longer fresh. `applied=0 skipped=5` on both runs
is the expected result from here. The harness never drops or resets it.

## One command

```bash
npm run postgres:validate
```

Writes `artifacts/postgres-validation-report.txt` (gitignored) and exits nonzero
on any failure.

## Safety

Refuses to run unless the database is exactly `macros_dev`, with an explicit
second refusal for `postgres`, `template0`, `template1`, `production`, `prod`.
The guard runs **before** anything else, in both shell and SQL. There is no
`DROP DATABASE` or `DROP SCHEMA` anywhere in the harness.

## Test-only auth harness

Production migrations use Supabase's `auth.uid()` and an `authenticated` role;
vanilla PostgreSQL has neither. `sql/00-harness.sql` supplies the minimum
equivalent — an `auth` schema, `auth.uid()` reading a **transaction-local**
setting, and roles created `NOSUPERUSER NOBYPASSRLS`.

It lives outside `db/migrations/` deliberately: production RLS must not be
weakened for local convenience, and the production schema must never depend on
anything defined here.

**The false-green risk this guards against:** running policy assertions as the
table owner or a superuser bypasses RLS entirely and every test passes
meaninglessly. The runner asserts `rolsuper=false` and `rolbypassrls=false`
before any matrix runs, and the matrices themselves re-assert it.

## What executes

| Area | Assertions |
|---|---|
| Migrations 0001–0005 | apply, re-run skips, ledger with SHA-256 |
| Checksum drift | altered history is refused |
| Failed migration | not recorded as applied (one transaction each) |
| Schema | tables, RLS enabled/forced, policies, indexes from `pg_catalog` |
| User isolation | profile, goals, food logs — SELECT/INSERT/UPDATE/DELETE, both directions |
| Forged insert | A cannot insert a log owned by B |
| Composite identity | `(user_id, log_id)` keeps A and B separate |
| Anonymous session | sees zero rows |
| **Household privacy** | owner reads **none** of member's private data while administering |
| Shared metadata | active members read it; outsiders do not |
| Owner constraint | second active owner rejected; promote-before-demote rejected |
| Zero owners | reported honestly as **domain-enforced, not DB-enforced** |
| Catalog | readable, not mutable by ordinary users |
| Connection identity | cleared after COMMIT, ROLLBACK and error |
| Concurrency | 32 parallel sessions, one identity → exactly 1 row |
| Offline replay | retry after simulated crash → still 1 row |
| Offline conflict | differing payload never overwrites |
| Corrections (0004) | self-void allowed, cross-user refused, history intact |
| Timings | development only |

## Known limitations

- **Not executed.** Every status stays pending until the Mac run returns.
- The local driver is `psql`, not a Node Postgres client — **RT-6 remains
  pending** until real application code uses one.
- `package-lock.json` is still uncommitted; `npm ci` reproducibility is unproven.
