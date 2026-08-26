#!/usr/bin/env bash
# =====================================================================
# MACROS.AI — LOCAL POSTGRESQL RUNTIME VALIDATION
# =====================================================================
# Authored in a sandbox with no database. Executed by the owner on macOS.
# Everything it asserts is executed against REAL PostgreSQL.
set -uo pipefail

DB="${MACROS_DB:-macros_dev}"
PGHOST="${PGHOST:-127.0.0.1}"
PGPORT="${PGPORT:-5432}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
SQL="$HERE/sql"
MIGRATIONS="$REPO/db/migrations"
OUT_DIR="$REPO/artifacts"
REPORT="$OUT_DIR/postgres-validation-report.txt"

mkdir -p "$OUT_DIR"
: > "$REPORT"

FAILURES=0
say() { echo "$*" | tee -a "$REPORT"; }
section() { say ""; say "=== $* ==="; }

# --- C1 SAFETY: refuse any database that is not macros_dev -------------------
case "$DB" in
  macros_dev) ;;
  *) echo "REFUSING: MACROS_DB='$DB'. This harness only operates on macros_dev." >&2; exit 2 ;;
esac
for forbidden in postgres template0 template1 production prod; do
  if [ "$DB" = "$forbidden" ]; then
    echo "REFUSING: '$DB' is a protected database." >&2; exit 2
  fi
done

psql_owner() { psql -v ON_ERROR_STOP=1 -h "$PGHOST" -p "$PGPORT" -d "$DB" "$@"; }

# The application role is reached via SET ROLE on the OWNER's already-working
# connection. macros_app is NOLOGIN on purpose: assuming the local pg_hba.conf
# happens to permit a brand-new passwordless TCP login would make validation
# depend on the owner's machine configuration, and "fix" it by weakening
# PostgreSQL authentication. SET ROLE still applies RLS, because macros_app is
# NOSUPERUSER NOBYPASSRLS.
psql_app() {
  local file="" inline="" tuples=""
  while [ $# -gt 0 ]; do
    case "$1" in
      -f)  file="$2"; shift 2 ;;
      -c)  inline="$2"; shift 2 ;;
      -tA) tuples="-tA"; shift ;;
      *)   shift ;;
    esac
  done
  if [ -n "$file" ]; then
    { echo "SET ROLE macros_app;"; cat "$file"; } |
      psql -v ON_ERROR_STOP=1 $tuples -h "$PGHOST" -p "$PGPORT" -d "$DB" -f -
  else
    # -tA (tuples-only, unaligned) whenever the shell consumes the value: the
    # default aligned table emits a header and a `-----` separator, and parsing
    # by line number picked up the separator instead of the answer.
    printf 'SET ROLE macros_app;\n%s\n' "$inline" |
      psql -v ON_ERROR_STOP=1 $tuples -h "$PGHOST" -p "$PGPORT" -d "$DB" -f -
  fi
}

step() { # step <name> <command...>
  local name="$1"; shift
  local log; log="$(mktemp)"
  if "$@" >"$log" 2>&1; then
    grep -E "PASS|NOTE" "$log" | sed 's/^psql:.*NOTICE:  //' | sed 's/^/  /' | tee -a "$REPORT" >/dev/null
    grep -cE "PASS" "$log" | xargs -I{} say "  [OK] $name ({} assertions)"
  else
    FAILURES=$((FAILURES + 1))
    say "  [FAIL] $name"
    grep -E "ERROR|FAIL|FATAL" "$log" | head -5 | sed 's/^/      /' | tee -a "$REPORT" >/dev/null
  fi
  rm -f "$log"
}

say "MACROS.AI PostgreSQL runtime validation"
say "database: $DB @ $PGHOST:$PGPORT"
say "started:  $(date -u +%Y-%m-%dT%H:%M:%SZ)"

# --- Environment -------------------------------------------------------------
section "ENVIRONMENT"
if ! command -v psql >/dev/null 2>&1; then
  say "FATAL: psql not found on PATH"; exit 2
fi
say "$(psql_owner -tAc 'SELECT version();' 2>&1 | head -1)"
say "current_database: $(psql_owner -tAc 'SELECT current_database();' 2>&1)"
psql_owner -f "$SQL/01-safety.sql" >/dev/null 2>&1 || { say "FATAL: safety guard refused"; exit 2; }
say "safety guard: PASS (database is macros_dev)"

# --- BLOCKER 1: the auth compatibility boundary must exist BEFORE migrations,
# because 0002 references auth.uid() and the authenticated role.
section "TEST-ONLY AUTH PREREQUISITE (installed BEFORE migrations)"
if psql_owner -1 -f "$SQL/00-prereq.sql" >/dev/null 2>&1; then
  say "  [OK] auth schema, auth.uid(), authenticated role"
else
  say "  [FATAL] prerequisite install failed — migrations cannot run"; exit 2
fi

# --- C4 MIGRATION LEDGER -----------------------------------------------------
section "MIGRATIONS + LEDGER"
psql_owner -q <<'SQL' >/dev/null 2>&1
CREATE TABLE IF NOT EXISTS schema_migrations (
    migration_id text PRIMARY KEY,
    checksum     text NOT NULL,
    applied_at   timestamptz NOT NULL DEFAULT now()
);
SQL

# Reports outcome through its RETURN STATUS and output. It deliberately does
# NOT touch the global FAILURES counter: only the caller knows whether a nonzero
# result is a defect or the expected outcome of a negative probe.
#
#   0 = all migrations consistent and applied/skipped
#   3 = checksum drift refused
#   1 = a migration failed to apply
apply_migrations() {
  local mode="$1" applied=0 skipped=0
  for file in "$MIGRATIONS"/*.sql; do
    local id sum recorded
    id="$(basename "$file")"
    sum="$(shasum -a 256 "$file" 2>/dev/null | cut -d' ' -f1 || sha256sum "$file" | cut -d' ' -f1)"
    recorded="$(psql_owner -tAc "SELECT checksum FROM schema_migrations WHERE migration_id='$id';")"

    if [ -n "$recorded" ]; then
      if [ "$recorded" != "$sum" ]; then
        say "  [refused] $id CHECKSUM DRIFT (recorded ${recorded:0:12}, file ${sum:0:12})"
        return 3
      fi
      skipped=$((skipped + 1)); continue
    fi

    # BLOCKER 2: DDL and the ledger insert are ONE transaction in ONE psql
    # process. Two psql invocations are two transactions: a crash between them
    # leaves the schema applied and the ledger empty, which is exactly the
    # inconsistency the ledger exists to prevent. Migration files contain DDL
    # only; this layer owns BEGIN/COMMIT.
    if { echo "BEGIN;";
         cat "$file";
         echo ";";
         echo "INSERT INTO schema_migrations (migration_id, checksum) VALUES ('$id','$sum');";
         echo "COMMIT;"; } |
       psql -v ON_ERROR_STOP=1 -h "$PGHOST" -p "$PGPORT" -d "$DB" -f - >/dev/null 2>&1; then
      applied=$((applied + 1))
    else
      say "  [error] $id failed to apply"
      local still; still="$(psql_owner -tAc "SELECT count(*) FROM schema_migrations WHERE migration_id='$id';")"
      if [ "$still" = "0" ]; then say "     [OK] not recorded as applied (correct)"; fi
      return 1
    fi
  done
  say "  [$mode] applied=$applied skipped=$skipped"
}

MIG_START=$(date +%s)
if ! apply_migrations "run 1"; then
  say "  [FAIL] migrations did not apply cleanly"; FAILURES=$((FAILURES + 1))
fi
MIG_SECS=$(( $(date +%s) - MIG_START ))
say "  migration duration: ${MIG_SECS}s"

# A second run must skip everything. An already-migrated database is a VALID
# starting state: applied=0 skipped=5 on both runs is expected after the first
# real execution.
say "  re-running (idempotency)..."
if ! apply_migrations "run 2"; then
  say "  [FAIL] re-run did not skip cleanly"; FAILURES=$((FAILURES + 1))
fi
LEDGER=$(psql_owner -tAc "SELECT count(*) FROM schema_migrations;")
say "  ledger rows: $LEDGER (expect 5)"
[ "$LEDGER" = "5" ] || { say "  [FAIL] expected 5 ledger rows"; FAILURES=$((FAILURES + 1)); }

# --- C19 CHECKSUM DRIFT REFUSAL ---------------------------------------------
section "CHECKSUM DRIFT REFUSAL (intentional negative probe)"
REAL1="$(shasum -a 256 "$MIGRATIONS/0001_core_schema.sql" 2>/dev/null | cut -d' ' -f1 \
        || sha256sum "$MIGRATIONS/0001_core_schema.sql" | cut -d' ' -f1)"

psql_owner -q -c "UPDATE schema_migrations SET checksum='deadbeef' WHERE migration_id='0001_core_schema.sql';" >/dev/null

# EXPECTED-NEGATIVE ACCOUNTING: here a nonzero result is the CORRECT outcome.
# apply_migrations no longer decides this globally, so a refusal cannot leave
# the failure counter incremented and abort the run that it just passed.
apply_migrations "drift probe" >/dev/null 2>&1
DRIFT_STATUS=$?
if [ "$DRIFT_STATUS" -eq 3 ]; then
  say "  [OK] runner refused the altered migration history (expected)"
else
  say "  [FAIL] drifted checksum was ACCEPTED (status $DRIFT_STATUS)"
  FAILURES=$((FAILURES + 1))
fi

# Restoration is mandatory: leaving a bogus checksum behind would poison every
# later run of this harness.
psql_owner -q -c "UPDATE schema_migrations SET checksum='$REAL1' WHERE migration_id='0001_core_schema.sql';" >/dev/null
RESTORED="$(psql_owner -tAc "SELECT checksum FROM schema_migrations WHERE migration_id='0001_core_schema.sql';")"
if [ "$RESTORED" = "$REAL1" ]; then
  say "  [OK] ledger checksum restored and matches the file SHA-256"
else
  say "  [FAIL] checksum NOT restored (ledger ${RESTORED:0:12}, file ${REAL1:0:12})"
  FAILURES=$((FAILURES + 1))
fi

# And the restored ledger must once again be clean.
if apply_migrations "post-restore" >/dev/null 2>&1; then
  say "  [OK] ledger consistent after restoration"
else
  say "  [FAIL] ledger still inconsistent after restoration"; FAILURES=$((FAILURES + 1))
fi

# --- C3 SCHEMA INSPECTION ----------------------------------------------------
section "SCHEMA INVARIANTS (from PostgreSQL catalogs)"
psql_owner -tA <<'SQL' 2>&1 | tee -a "$REPORT" >/dev/null
SELECT 'table ' || tablename || ' rls=' || relrowsecurity || ' force=' || relforcerowsecurity
FROM pg_tables t JOIN pg_class c ON c.relname = t.tablename
WHERE t.schemaname = 'public' ORDER BY tablename;
SQL
TBL=$(psql_owner -tAc "SELECT count(*) FROM pg_tables WHERE schemaname='public';")
RLS=$(psql_owner -tAc "SELECT count(*) FROM pg_class c JOIN pg_tables t ON t.tablename=c.relname WHERE t.schemaname='public' AND c.relrowsecurity;")
POL=$(psql_owner -tAc "SELECT count(*) FROM pg_policies WHERE schemaname='public';")
IDX=$(psql_owner -tAc "SELECT count(*) FROM pg_indexes WHERE schemaname='public';")
say "  tables=$TBL rls_enabled=$RLS policies=$POL indexes=$IDX"
[ "$POL" -gt 0 ] || { say "  [FAIL] no policies present"; FAILURES=$((FAILURES + 1)); }

# --- Setup gate: no point running 20 behavioural tests on a broken schema.
if [ "$FAILURES" -ne 0 ]; then
  section "ABORTED"
  say "Migration setup failed. Skipping behavioural tests to avoid cascade noise."
  say "Report: $REPORT"
  exit 1
fi

section "TEST HELPERS + FIXTURES"
step "test helpers"  psql_owner -f "$SQL/05-test-helpers.sql"
step "fixtures"      psql_owner -1 -f "$SQL/10-fixtures.sql"
section "DATA INTEGRITY (constraints, as owner)"
step "data integrity" psql_owner -f "$SQL/15-data-integrity.sql"
# The database asserts its own invariants and RAISEs on violation, so nothing
# depends on whether a boolean renders as `f`, `false` or `FALSE` — the previous
# check compared against "f/f" and failed against the real server's "false/false"
# while the role was in fact correct.
if psql_owner -q -f - >/dev/null 2>&1 <<'ROLECHECK'
DO $$
DECLARE ok boolean;
BEGIN
  SELECT NOT rolsuper AND NOT rolbypassrls INTO ok
    FROM pg_roles WHERE rolname = 'macros_app';
  IF ok IS NULL THEN
    RAISE EXCEPTION 'macros_app role does not exist';
  END IF;
  IF NOT ok THEN
    RAISE EXCEPTION 'macros_app can bypass RLS — every policy assertion would be meaningless';
  END IF;
END;
$$;
ROLECHECK
then
  say "  [OK] macros_app exists, is not superuser, cannot bypass RLS"
else
  say "  [FAIL] macros_app privilege invariant violated"; FAILURES=$((FAILURES + 1))
fi

# Same approach for the effective role: asserted INSIDE the SET ROLE session.
if psql_app -f - >/dev/null 2>&1 <<'USERCHECK'
DO $$
BEGIN
  IF current_user <> 'macros_app' THEN
    RAISE EXCEPTION 'assertions are running as %, not macros_app', current_user;
  END IF;
END;
$$;
USERCHECK
then
  say "  [OK] assertions execute as macros_app (asserted in-database)"
else
  say "  [FAIL] assertions are NOT running as macros_app"; FAILURES=$((FAILURES + 1))
fi

# --- C5..C9 POLICY MATRICES (as the NON-privileged role) ---------------------
section "RLS MATRIX (as macros_app)"
step "user isolation"      psql_app -f "$SQL/20-rls-matrix.sql"
section "HOUSEHOLD PRIVACY"
step "household privacy"   psql_app -f "$SQL/30-household-privacy.sql"
section "CONNECTION IDENTITY"
step "identity isolation"  psql_app -f "$SQL/40-connection-identity.sql"
section "CATALOG"
step "catalog policy"      psql_app -f "$SQL/50-catalog.sql"
section "IDEMPOTENCY CONFLICT"
step "conflict handling"   psql_app -f "$SQL/60-idempotency-conflict.sql"
section "CORRECTIONS (0004)"
step "corrections"         psql_app -f "$SQL/70-corrections.sql"

# --- C10 REAL CONCURRENCY RACE ----------------------------------------------
section "CONCURRENT IDEMPOTENCY RACE (real parallel sessions)"
RACE_ID="race-$(date +%s)"
RACERS="${MACROS_RACERS:-32}"
RACE_START=$(date +%s%N)
for i in $(seq 1 "$RACERS"); do
  psql -q -h "$PGHOST" -p "$PGPORT" -d "$DB" -c "
    SET ROLE macros_app;
    BEGIN;
    SELECT auth.set_test_uid('11111111-1111-4111-8111-111111111111'::uuid);
    INSERT INTO food_logs (
      user_id, log_id, product_id, product_version_id, grams, logged_at,
      event_timezone, event_utc_offset_minutes, local_date, nutrition_calc_version,
      weight_capture, nutrition_snapshot, kcal, protein_g, carbohydrate_g, fat_g)
    VALUES ('11111111-1111-4111-8111-111111111111','$RACE_ID','prod-test-1','prod-test-1@v1',
      100, now(),'UTC',0,current_date,'test','{\"grams\":100}'::jsonb,
      '{\"gramsConsumed\":100,\"productVersionId\":\"prod-test-1@v1\",\"totals\":{\"kcal\":100,\"proteinG\":10,\"carbohydrateG\":5,\"fatG\":2}}'::jsonb,100,10,5,2)
    ON CONFLICT (user_id, log_id) DO NOTHING;
    COMMIT;" >/dev/null 2>&1 &
done
wait
RACE_MS=$(( ( $(date +%s%N) - RACE_START ) / 1000000 ))
ROWS=$(psql_owner -tAc "SELECT count(*) FROM food_logs WHERE log_id='$RACE_ID';")
say "  $RACERS concurrent submissions of one identity -> $ROWS row(s) in ${RACE_MS}ms"
if [ "$ROWS" = "1" ]; then
  say "  [OK] exactly one logical row; no duplicates"
  say "  SCOPE: this proves DATABASE uniqueness only. Application classification"
  say "         (inserted / replayed_existing / idempotency_conflict) is NOT"
  say "         proven here — no repository code participated in this race."
else
  say "  [FAIL] expected 1 row, got $ROWS"; FAILURES=$((FAILURES + 1))
fi

# --- C13/C14 OFFLINE REPLAY + CONFLICT --------------------------------------
section "OFFLINE CRASH-AFTER-ACCEPT / CONFLICT"
BEFORE=$(psql_owner -tAc "SELECT kcal FROM food_logs WHERE log_id='$RACE_ID';")
# Crash-after-accept: the server committed, the client never saw the ACK and
# retries the IDENTICAL payload. Must settle as a replay, not a duplicate.
psql_app -q -c "
  BEGIN;
  SELECT auth.set_test_uid('11111111-1111-4111-8111-111111111111'::uuid);
  INSERT INTO food_logs (
    user_id, log_id, product_id, product_version_id, grams, logged_at,
    event_timezone, event_utc_offset_minutes, local_date, nutrition_calc_version,
    weight_capture, nutrition_snapshot, kcal, protein_g, carbohydrate_g, fat_g)
  VALUES ('11111111-1111-4111-8111-111111111111','$RACE_ID','prod-test-1','prod-test-1@v1',
    100, now(),'UTC',0,current_date,'test','{\"grams\":100}'::jsonb,
    '{\"gramsConsumed\":100,\"productVersionId\":\"prod-test-1@v1\",\"totals\":{\"kcal\":100,\"proteinG\":10,\"carbohydrateG\":5,\"fatG\":2}}'::jsonb,100,10,5,2)
  ON CONFLICT (user_id, log_id) DO NOTHING;
  COMMIT;" >/dev/null 2>&1
AFTER_ROWS=$(psql_owner -tAc "SELECT count(*) FROM food_logs WHERE log_id='$RACE_ID';")
[ "$AFTER_ROWS" = "1" ] && say "  [OK] retry after simulated crash -> still 1 row (duplicate prevented at the DB)" \
  || { say "  [FAIL] retry created duplicates ($AFTER_ROWS rows)"; FAILURES=$((FAILURES + 1)); }

# Conflict: same identity, DIFFERENT payload. Original must be untouched.
psql_app -q -c "
  BEGIN;
  SELECT auth.set_test_uid('11111111-1111-4111-8111-111111111111'::uuid);
  INSERT INTO food_logs (
    user_id, log_id, product_id, product_version_id, grams, logged_at,
    event_timezone, event_utc_offset_minutes, local_date, nutrition_calc_version,
    weight_capture, nutrition_snapshot, kcal, protein_g, carbohydrate_g, fat_g)
  VALUES ('11111111-1111-4111-8111-111111111111','$RACE_ID','prod-test-1','prod-test-1@v1',
    999, now(),'UTC',0,current_date,'test','{\"grams\":999}'::jsonb,
    '{\"gramsConsumed\":999,\"productVersionId\":\"prod-test-1@v1\",\"totals\":{\"kcal\":999,\"proteinG\":99,\"carbohydrateG\":99,\"fatG\":99}}'::jsonb,999,99,99,99)
  ON CONFLICT (user_id, log_id) DO NOTHING;
  COMMIT;" >/dev/null 2>&1
AFTER=$(psql_owner -tAc "SELECT kcal FROM food_logs WHERE log_id='$RACE_ID';")
if [ "$BEFORE" = "$AFTER" ]; then
  say "  [OK] conflicting payload did NOT overwrite (kcal $BEFORE unchanged)"
  say "  SCOPE: SQL-level duplicate/overwrite prevention only. Client ACK state and"
  say "         outbox settlement are NOT validated here — the offline sync adapter"
  say "         did not participate."
else
  say "  [FAIL] last-write-wins: kcal $BEFORE -> $AFTER"; FAILURES=$((FAILURES + 1))
fi

# --- C20 DEVELOPMENT TIMINGS -------------------------------------------------
section "DEVELOPMENT TIMINGS (no production claims)"
timeit() { local s; s=$(date +%s%N); psql_app -q -c "$2" >/dev/null 2>&1; say "  $1: $(( ( $(date +%s%N) - s ) / 1000000 ))ms"; }
timeit "daily log read"      "BEGIN; SELECT auth.set_test_uid('11111111-1111-4111-8111-111111111111'::uuid); SELECT count(*) FROM food_logs WHERE local_date = current_date; ROLLBACK;"
timeit "RLS profile lookup"  "BEGIN; SELECT auth.set_test_uid('11111111-1111-4111-8111-111111111111'::uuid); SELECT count(*) FROM user_profile_versions; ROLLBACK;"
timeit "membership lookup"   "BEGIN; SELECT auth.set_test_uid('11111111-1111-4111-8111-111111111111'::uuid); SELECT count(*) FROM household_memberships; ROLLBACK;"

# --- Cleanup: deterministic, scoped to fixtures -----------------------------
psql_owner -q -c "DELETE FROM food_logs WHERE log_id='$RACE_ID';" >/dev/null 2>&1

section "RESULT"
if [ "$FAILURES" -eq 0 ]; then
  say "PASS — all PostgreSQL runtime assertions succeeded"
  say ""
  say "Report: $REPORT"
  exit 0
fi
say "FAIL — $FAILURES check(s) failed. See details above."
say ""
say "Report: $REPORT"
exit 1
