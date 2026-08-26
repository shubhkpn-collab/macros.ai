# 33 — PostgreSQL Validation Harness

> **POSTGRESQL VALIDATION HARNESS — ENGINEERING READY FOR MAC EXECUTION**
> **POSTGRESQL RUNTIME VALIDATION — PENDING OWNER MAC EXECUTION**
>
> **FIRST REAL EXECUTION: 2026-08-26, PostgreSQL 17.11, database `macros_dev`.**

## Real execution evidence (round 2 — PostgreSQL 17.11, `macros_dev`)

### RUNTIME VALIDATED against a live server

| Area | Evidence |
|---|---|
| Connectivity (`PGHOST=/tmp`) | validated |
| Migrations 0001–0005 | applied, then skipped on re-run; ledger = 5 |
| Migration ledger / checksum drift | drift refused, checksum restored |
| Schema | 14 tables, 13 RLS enabled+forced, 21 policies, 29 indexes |
| **RLS user isolation** | profile, goals, food logs both directions; forged insert denied **SQLSTATE 42501**; UPDATE/DELETE denied; composite `(user_id, log_id)`; anonymous sees nothing |
| **Household database privacy** | owner reads none of a member's nutrition **while administering**; member privacy symmetric; shared metadata readable; outsider denied |
| **Household ownership transfer** | legitimate transfer succeeds; non-owner, outsider, out-of-household target, self-transfer and removed target all denied; rollback leaves ownership intact |
| **No RLS recursion** | memberships, households, devices, seats |
| Authorization helper scope | returns only the caller's own fact |
| Connection identity clearing | after COMMIT, ROLLBACK **and** ERROR |
| Catalog ordinary-user immutability | read allowed; INSERT/UPDATE/DELETE denied |
| **Food-log uniqueness under 32-session race** | exactly 1 logical row |
| Food-log conflict non-overwrite | original immutable |
| Correction / void isolation | self-void allowed, cross-user denied, history intact |
| SQL-level offline duplicate/overwrite prevention | retry stays 1 row |

Development timings: daily logs 23 ms · RLS profile 22 ms · membership 22 ms.

### Precision about what these prove

- The 32-session race proves **database uniqueness**, not the application's
  `inserted` / `replayed_existing` / `idempotency_conflict` classification — no
  repository code participated.
- The offline test proves **SQL duplicate/overwrite behaviour**, not client ACK
  or outbox settlement.

### Still PARTIAL

- **DATA-INTEGRITY ADVERSARIAL MATRIX — PARTIAL.** The malformed-numeric probe
  raised `invalid_text_representation` (22P02) during the `->>::numeric` cast;
  the handler caught only `check_violation`, so psql aborted the file before the
  remaining probes. Fixed by accepting the specific legitimate rejection classes
  (23514 / 22P02 / 22003), running each probe in its own block, and asserting
  afterwards that no probe row persisted. Rerun required.
- **POSTGRESQL RUNTIME VALIDATION — PARTIAL** until that rerun is clean. RT-1
  stays open.

### Two harness parsing bugs the real server exposed

The role check compared `rolsuper||'/'||rolbypassrls` against `"f/f"`, but
PostgreSQL rendered `false/false` — a correct role failing on presentation
format. And `current_user` was read with `sed -n '3p'` from aligned output,
which picked up the `-----` separator. Both are now **asserted inside the
database**, which raises on violation, so nothing depends on how a boolean
renders or how a table is laid out. Every remaining shell-consumed gate value
uses `-tA`.

### The harness accounting bug### The harness accounting bug the real run exposed

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
