# 33 — PostgreSQL Validation Harness

> **POSTGRESQL VALIDATION HARNESS — ENGINEERING READY FOR MAC EXECUTION**
> **POSTGRESQL RUNTIME VALIDATION — PENDING OWNER MAC EXECUTION**
>
> Authored in a sandbox with no database. **Nothing here is claimed as executed.**

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
