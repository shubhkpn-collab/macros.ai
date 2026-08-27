/**
 * REAL Node + PostgreSQL INTEGRATION — RT-6 / RT-7 / RT-8.
 *
 * Executes against a live server through the REAL `pg` driver. psql is not the
 * implementation under test and is not used here at all.
 *
 * Everything is namespaced per run and cleaned up deterministically, so repeated
 * runs are safe. The database is never dropped.
 */
import { randomUUID } from 'node:crypto';
import {
  createPgPool, residualIdentity, withAuthenticatedDatabaseSubject,
  type PgPoolLike,
} from '@macros/postgres-driver';
import {
  PostgresEnergyGoalRepository, PostgresFoodLogRepository,
  PostgresUserProfileRepository, type SqlExecutor,
} from '@macros/persistence';
import { mintSubjectForTests } from '@macros/domain-auth';
import {
  applyResult, dueForSubmission, recoverInFlight,
  type OutboxEntry, type SubmissionResult,
} from '@macros/domain-offline-sync';
import {
  centimetres, grams, instant, kilograms, validateUserProfile, years,
  type EnergyGoalVersion, type FoodLogItem, type ProductVersion, type UserProfileSnapshot,
} from '@macros/contracts';
import { createFoodLogItem } from '@macros/domain-food-log';
import { MacrosApi, foodLogRoute } from '@macros/runtime-api';
import { FakeAuthSessionProvider, StructuredLogger, loadRoleConfig, type RuntimeConfig } from '@macros/runtime-config';

const HOST = process.env['PGHOST'] ?? '/tmp';
const PORT = Number(process.env['PGPORT'] ?? 5432);
const DB = process.env['MACROS_DB'] ?? 'macros_dev';

if (DB !== 'macros_dev') {
  console.error(`REFUSING: MACROS_DB='${DB}'. This suite only runs against macros_dev.`);
  process.exit(2);
}

const RUN = randomUUID().slice(0, 8);
const USER_A = randomUUID();
const USER_B = randomUUID();
const subjectA = mintSubjectForTests(USER_A, { displayName: 'Integration A' });
const subjectB = mintSubjectForTests(USER_B, { displayName: 'Integration B' });

let failures = 0;
const lines: string[] = [];
const say = (s: string): void => { console.log(s); lines.push(s); };
const ok = (n: string, d = ''): void => say(`  [OK] ${n}${d ? ` — ${d}` : ''}`);
const fail = (n: string, d = ''): void => { failures += 1; say(`  [FAIL] ${n}${d ? ` — ${d}` : ''}`); };
const section = (n: string): void => { say(''); say(`=== ${n} ===`); };

/**
 * Deterministic test ProductVersion. The kcal varies only so a conflicting
 * payload differs by a REALISTIC amount (100 vs 101), not an absurd one.
 */
const productVersionFor = (kcal: number): ProductVersion => ({
  productId: 'prod-test-1',
  productVersionId: 'prod-test-1@v1',
  versionNo: 1,
  displayName: 'RT integration food',
  preparationState: 'as_sold',
  basis: { kind: 'per_100g', kcal, proteinG: 10, carbohydrateG: 5, fatG: 2 },
  source: {
    kind: 'synthetic_test',
    sourceId: 'rt6-integration',
    verificationStatus: 'synthetic_test',
  },
  effectiveFrom: instant('2026-01-01T00:00:00.000Z'),
} as ProductVersion);

/**
 * Built by the PRODUCTION factory, which derives basisKind, calcVersion,
 * computedAt, nutritionCalcVersion, localDate and timezone provenance itself —
 * and validates as it goes. Hand-fabricating a NutritionSnapshot behind a cast
 * produced payloads the database would have rejected.
 */
const logFor = (userId: string, logId: string, kcal: number): FoodLogItem =>
  createFoodLogItem({
    userId, logId,
    productVersion: productVersionFor(kcal),
    weightCapture: {
      grams: grams(100),
      source: 'manual',
      capturedAt: instant('2026-08-26T12:00:00.000Z'),
    },
    loggedAt: instant('2026-08-26T12:00:00.000Z'),
    timezone: 'UTC',
  });

async function main(): Promise<void> {
  say('MACROS.AI — real Node/PostgreSQL integration (RT-6 / RT-7 / RT-8)');

  // Fixtures are constructed and validated BEFORE opening PostgreSQL, so an
  // invalid fixture fails fast instead of looking like a database problem.
  try {
    logFor(USER_A, 'fixture-probe', 100);
  } catch (e) {
    say(`FATAL: integration FoodLog fixture invalid — ${String(e)}`);
    process.exit(2);
  }
  say(`database: ${DB} @ ${HOST}:${PORT}`);

  let pool: PgPoolLike;
  try {
    pool = await createPgPool({ host: HOST, port: PORT, database: DB, max: 40 });
  } catch (e) {
    say(`FATAL: ${String(e)}`);
    process.exit(2);
  }

  // --- RT-6: driver + identity ------------------------------------------
  section('RT-6 — REAL pg DRIVER AND REQUEST IDENTITY');
  try {
    const version = await withAuthenticatedDatabaseSubject(pool, subjectA, async (sql) => {
      const r = await sql.query<{ v: string }>('SELECT version() AS v', []);
      return r[0]!.v;
    });
    ok('real pg driver connected', version.split(',')[0]);
  } catch (e) { fail('pg driver connection', String(e)); }

  try {
    const seen = await withAuthenticatedDatabaseSubject(pool, subjectA, async (sql) => {
      const r = await sql.query<{ uid: string; role: string }>(
        'SELECT auth.uid()::text AS uid, current_user AS role', []);
      return r[0]!;
    });
    seen.uid === USER_A
      ? ok('auth.uid() equals the authenticated subject')
      : fail('auth.uid() mismatch', `${seen.uid} vs ${USER_A}`);
    seen.role === 'macros_app'
      ? ok('queries execute as the ordinary application role')
      : fail('wrong effective role', seen.role);
  } catch (e) { fail('identity establishment', String(e)); }

  try {
    const priv = await withAuthenticatedDatabaseSubject(pool, subjectA, async (sql) => {
      const r = await sql.query<{ s: boolean; b: boolean }>(
        'SELECT rolsuper AS s, rolbypassrls AS b FROM pg_roles WHERE rolname = current_user', []);
      return r[0]!;
    });
    !priv.s && !priv.b
      ? ok('application role is NOSUPERUSER and NOBYPASSRLS')
      : fail('application role can bypass RLS');
  } catch (e) { fail('role privilege check', String(e)); }

  // --- RT-6: pool isolation ---------------------------------------------
  section('RT-6 — POOL REUSE CANNOT LEAK IDENTITY');
  try {
    await withAuthenticatedDatabaseSubject(pool, subjectA, async () => null);
    const residual = await residualIdentity(pool);
    residual === null
      ? ok('no identity outside the transaction after COMMIT')
      : fail('identity leaked after COMMIT', residual);

    const bSees = await withAuthenticatedDatabaseSubject(pool, subjectB, async (sql) => {
      const r = await sql.query<{ uid: string }>('SELECT auth.uid()::text AS uid', []);
      return r[0]!.uid;
    });
    bSees === USER_B ? ok("B's request sees B, never A") : fail('cross-request leak', bSees);

    try {
      await withAuthenticatedDatabaseSubject(pool, subjectA, async () => {
        throw new Error('deliberate failure');
      });
    } catch { /* expected */ }
    const afterRollback = await residualIdentity(pool);
    afterRollback === null
      ? ok('no identity after ROLLBACK')
      : fail('identity leaked after ROLLBACK', afterRollback);
  } catch (e) { fail('pool isolation', String(e)); }

  // --- RT-6: FORCED same-connection proof --------------------------------
  section('RT-6 — FORCED POOL REUSE (max=1)');
  try {
    // The main pool has max=40, so A and B might simply get different backends
    // and the isolation claim would rest on pg's reuse strategy rather than on
    // evidence. A max=1 pool makes reuse certain, and pg_backend_pid() proves it.
    const solo = await createPgPool({ host: HOST, port: PORT, database: DB, max: 1 });
    try {
      const pidA = await withAuthenticatedDatabaseSubject(solo, subjectA, async (sql) => {
        const r = await sql.query<{ pid: string }>('SELECT pg_backend_pid()::text AS pid', []);
        return r[0]!.pid;
      });

      const b = await withAuthenticatedDatabaseSubject(solo, subjectB, async (sql) => {
        const r = await sql.query<{ pid: string; uid: string }>(
          'SELECT pg_backend_pid()::text AS pid, auth.uid()::text AS uid', []);
        return r[0]!;
      });

      pidA === b.pid
        ? ok('A and B used the SAME physical backend', `pid ${pidA}`)
        : fail('connections were not reused', `${pidA} vs ${b.pid}`);
      b.uid === USER_B
        ? ok('B sees its own identity on the reused connection')
        : fail('identity leaked across reuse', String(b.uid));

      // And after a FAILED transaction on the same single connection.
      try {
        await withAuthenticatedDatabaseSubject(solo, subjectA, async () => {
          throw new Error('deliberate failure');
        });
      } catch { /* expected */ }
      const after = await withAuthenticatedDatabaseSubject(solo, subjectB, async (sql) => {
        const r = await sql.query<{ uid: string; pid: string }>(
          'SELECT auth.uid()::text AS uid, pg_backend_pid()::text AS pid', []);
        return r[0]!;
      });
      after.uid === USER_B
        ? ok('no A claim survives a failed transaction on the reused connection')
        : fail('stale claim after failure', String(after.uid));
    } finally {
      await solo.end();
    }
  } catch (e) { fail('forced pool reuse', String(e)); }

  // --- Real repositories --------------------------------------------------
  section('RT-6 — REAL REPOSITORIES');
  const profileId = `pv-${RUN}`;
  const goalId = `gv-${RUN}`;

  const profileFixture: UserProfileSnapshot = {
    userId: USER_A,
    profileVersionId: profileId,
    effectiveFrom: instant('2026-01-01T00:00:00.000Z'),
    ageYears: years(35),
    sex: 'male',
    bodyWeightKg: kilograms(82.5),
    heightCm: centimetres(180),
  };
  const profileCheck = validateUserProfile(profileFixture);
  if (!profileCheck.ok) {
    say('FATAL: integration profile fixture invalid');
    process.exit(2);
  }

  const goalFixture: EnergyGoalVersion = {
    goalVersionId: goalId,
    userId: USER_A,
    effectiveFrom: instant('2026-01-01T00:00:00.000Z'),
    goal: 'gain',
    targetDeltaKcal: 250,
  };
  try {
    await withAuthenticatedDatabaseSubject(pool, subjectA, async (sql: SqlExecutor) => {
      const profiles = new PostgresUserProfileRepository(sql);
      await profiles.append(profileFixture);
      const eff = await profiles.getEffective(USER_A, '2026-08-26T12:00:00.000Z');
      eff !== null && eff.profileVersionId === profileId
        ? ok('profile append + effective-dated read')
        : fail('profile effective read');

      const goals = new PostgresEnergyGoalRepository(sql);
      await goals.append(goalFixture);
      const g = await goals.getEffective(USER_A, '2026-08-26T12:00:00.000Z');
      g !== null && g.goalVersionId === goalId
        ? ok('goal append + effective-dated read')
        : fail('goal effective read');
      return null;
    });
  } catch (e) { fail('real repositories', String(e)); }

  // --- RT-7: concurrency THROUGH the repository ---------------------------
  section('RT-7 — 32 CONCURRENT APPLICATION SUBMISSIONS');
  const raceLog = `race-${RUN}`;
  try {
    const item = logFor(USER_A, raceLog, 100);
    const results = await Promise.all(
      Array.from({ length: 32 }, () =>
        withAuthenticatedDatabaseSubject(pool, subjectA, (sql) =>
          new PostgresFoodLogRepository(sql).append(item))
          .catch((e) => ({ outcome: `error:${String(e).slice(0, 60)}` } as never))),
    );
    const counts = results.reduce<Record<string, number>>((acc, r) => {
      acc[r.outcome] = (acc[r.outcome] ?? 0) + 1; return acc;
    }, {});
    say(`  classifications: ${JSON.stringify(counts)}`);

    counts['appended'] === 1
      ? ok('exactly 1 appended')
      : fail('appended count', String(counts['appended'] ?? 0));
    counts['replayed_existing'] === 31
      ? ok('exactly 31 replayed_existing')
      : fail('replayed_existing count', String(counts['replayed_existing'] ?? 0));

    const rows = await withAuthenticatedDatabaseSubject(pool, subjectA, async (sql) => {
      const r = await sql.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM food_logs WHERE log_id = $1', [raceLog]);
      return Number(r[0]!.n);
    });
    rows === 1 ? ok('exactly 1 database row') : fail('row count', String(rows));
  } catch (e) { fail('concurrency', String(e)); }

  // --- RT-7: genuine conflict --------------------------------------------
  section('RT-7 — IDEMPOTENCY CONFLICT');
  try {
    const conflicting = logFor(USER_A, raceLog, 101);
    const out = await withAuthenticatedDatabaseSubject(pool, subjectA, (sql) =>
      new PostgresFoodLogRepository(sql).append(conflicting));
    out.outcome === 'idempotency_conflict'
      ? ok('differing payload classifies as idempotency_conflict')
      : fail('conflict classification', out.outcome);

    const stored = await withAuthenticatedDatabaseSubject(pool, subjectA, async (sql) => {
      const r = await sql.query<{ kcal: string }>(
        'SELECT kcal::text AS kcal FROM food_logs WHERE log_id = $1', [raceLog]);
      return Number(r[0]!.kcal);
    });
    stored === 100
      ? ok('canonical row unchanged (kcal 100, not 101)')
      : fail('canonical row was overwritten', String(stored));
  } catch (e) { fail('conflict', String(e)); }

  // --- Cross-user same logId ---------------------------------------------
  section('RT-7 — SAME logId, DIFFERENT USERS');
  try {
    const out = await withAuthenticatedDatabaseSubject(pool, subjectB, (sql) =>
      new PostgresFoodLogRepository(sql).append(logFor(USER_B, raceLog, 200)));
    out.outcome === 'appended'
      ? ok("B's identical logId is an independent record")
      : fail('cross-user logId', out.outcome);

    const visible = await withAuthenticatedDatabaseSubject(pool, subjectA, async (sql) => {
      const r = await sql.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM food_logs WHERE log_id = $1', [raceLog]);
      return Number(r[0]!.n);
    });
    visible === 1
      ? ok("A sees only A's row — RLS holds through the driver")
      : fail('cross-user visibility', String(visible));
  } catch (e) { fail('cross-user', String(e)); }

  // --- RT-8: settlement through the REAL HTTP application path ------------
  section('RT-8 — REAL HTTP: outbox -> MacrosApi auth -> pg -> PostgreSQL');
  const httpLog = `http-${RUN}`;
  let api: { close: () => Promise<void> } | undefined;
  try {
    const started = await startApi(pool);
    api = started;
    const url = `http://127.0.0.1:${started.port}/food-logs`;
    const payload = logFor(USER_A, httpLog, 250);

    let entry: OutboxEntry = {
      userId: USER_A, logId: httpLog, payload,
      state: 'pending', attempts: 0, sequence: 1,
    };
    entry = { ...entry, state: 'in_flight' };

    // 1-6. The OUTBOX ENTRY drives the send — not a parallel payload variable.
    const first = decodeAcceptedFoodLogResponse(
      await post(url, started.tokenA, { foodLog: entry.payload }), entry.logId);
    if (first.kind !== 'accepted' || first.outcome !== 'appended') {
      throw new Error(`first submission returned ${JSON.stringify(first)}`);
    }
    ok('HTTP submission committed through the real server path');

    // 7-8. CRASH before the ACK: applyResult is deliberately NOT called.
    const recovered = recoverInFlight([entry]);
    if (recovered[0]!.state !== 'pending') {
      throw new Error(`crash recovery left state ${recovered[0]!.state}`);
    }
    ok('crash before ACK recovers to pending');

    const due = dueForSubmission(recovered, Date.now(), []);
    if (due.length !== 1) throw new Error(`${due.length} entries due, expected 1`);
    ok('exactly one entry is due for resubmission');

    // 9-12. Retry from the ACTUAL due entry.
    const retryEntry = due[0]!;
    const retry = decodeAcceptedFoodLogResponse(
      await post(url, started.tokenA, { foodLog: retryEntry.payload }), retryEntry.logId);
    if (retry.kind !== 'accepted' || retry.outcome !== 'replayed_existing') {
      throw new Error(`retry returned ${JSON.stringify(retry)}`);
    }
    ok('HTTP retry returns replayed_existing');

    const settled = applyResult(retryEntry, retry, Date.now());
    settled.state === 'acked' ? ok('outbox settles ACKED via HTTP') : fail('settlement', settled.state);

    // 13. Exactly one row.
    const rows = await withAuthenticatedDatabaseSubject(pool, subjectA, async (sql) => {
      const r = await sql.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM food_logs WHERE log_id = $1', [httpLog]);
      return Number(r[0]!.n);
    });
    rows === 1 ? ok('exactly 1 row after HTTP crash + retry') : fail('duplicate via HTTP', String(rows));

    // --- Conflict: a SECOND entry carrying the DIFFERENT payload -----------
    // The response must settle the entry that actually carries that payload;
    // applying it to the already-ACKED 250-kcal entry proved nothing.
    const conflictPayload = logFor(USER_A, httpLog, 101);
    const conflictEntry: OutboxEntry = {
      userId: conflictPayload.userId, logId: conflictPayload.logId,
      payload: conflictPayload, state: 'in_flight', attempts: 0, sequence: 2,
    };
    const conflict = decodeAcceptedFoodLogResponse(
      await post(url, started.tokenA, { foodLog: conflictEntry.payload }), conflictEntry.logId);
    if (conflict.kind !== 'accepted' || conflict.outcome !== 'idempotency_conflict') {
      throw new Error(`conflict returned ${JSON.stringify(conflict)}`);
    }
    const conflicted = applyResult(conflictEntry, conflict, Date.now());
    conflicted.state === 'conflict'
      ? ok('conflicting payload settles as conflict on its OWN entry')
      : fail('conflict settlement', conflicted.state);

    const canonical = await withAuthenticatedDatabaseSubject(pool, subjectA, async (sql) => {
      const r = await sql.query<{ kcal: string }>(
        'SELECT kcal::text AS kcal FROM food_logs WHERE log_id = $1', [httpLog]);
      return Number(r[0]!.kcal);
    });
    canonical === 250
      ? ok('canonical row remains 250 kcal, not 101')
      : fail('canonical row overwritten', String(canonical));

    // --- HTTP authorization adversarial cases ---------------------------
    section('HTTP AUTHORIZATION');
    const noAuth = await post(url, null, { foodLog: logFor(USER_A, `na-${RUN}`, 100) });
    noAuth.status === 401 ? ok('no Bearer token -> 401') : fail('missing token', String(noAuth.status));

    const forged = await post(url, started.tokenA, { foodLog: logFor(USER_B, `forge-${RUN}`, 100) });
    forged.status === 403
      ? ok("A's token cannot write B's log -> 403")
      : fail('forged user', `${forged.status}`);

    const forgedRows = await withAuthenticatedDatabaseSubject(pool, subjectB, async (sql) => {
      const r = await sql.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM food_logs WHERE log_id = $1', [`forge-${RUN}`]);
      return Number(r[0]!.n);
    });
    forgedRows === 0 ? ok('ZERO forged rows written') : fail('forged row written', String(forgedRows));

    const malformed = await post(url, started.tokenA, { foodLog: { logId: 'x' } });
    malformed.status === 400
      ? ok('malformed payload -> 400, no persistence')
      : fail('malformed payload', String(malformed.status));

    const leak = JSON.stringify(malformed.body ?? {}) + JSON.stringify(forged.body ?? {});
    /postgres:\/\/|password|at Object\.|SELECT |pg_/.test(leak)
      ? fail('error leaked SQL, stack or credentials')
      : ok('errors leak no SQL, stack, URL or credential');
  } catch (e) { fail('HTTP settlement', String(e)); }
  finally { if (api !== undefined) await api.close(); }

  // --- Deterministic cleanup ---------------------------------------------
  section('CLEANUP');
  try {
    // Test rows are namespaced per run; nothing else is touched and the
    // database is never dropped. Append-only tables deny DELETE to the
    // application role, so cleanup runs as the connecting (owner) role.
    await withAuthenticatedDatabaseSubject(pool, subjectA, async (sql) => {
      await sql.query('DELETE FROM food_logs WHERE log_id IN ($1, $2)', [raceLog, httpLog]);
      await sql.query('DELETE FROM energy_goal_versions WHERE goal_version_id = $1', [goalId]);
      await sql.query('DELETE FROM user_profile_versions WHERE profile_version_id = $1', [profileId]);
      return null;
    }, { assumeApplicationRole: false });
    ok('run-scoped test rows removed');
  } catch (e) {
    say(`  [note] cleanup skipped: ${String(e).slice(0, 120)}`);
    say('  (rows are namespaced per run, so repeated runs remain safe)');
  }

  await pool.end();

  section('RESULT');
  say(failures === 0
    ? 'PASS — RT-6, RT-7 and RT-8 executed against real PostgreSQL'
    : `FAIL — ${failures} check(s) failed`);

  const { mkdirSync, writeFileSync } = await import('node:fs');
  mkdirSync('artifacts', { recursive: true });
  writeFileSync('artifacts/postgres-integration-report.txt', lines.join('\n') + '\n');
  say('Report: artifacts/postgres-integration-report.txt');
  process.exit(failures === 0 ? 0 : 1);
}

void main();

// ---------------------------------------------------------------------------
// Minimal IO helpers. No business logic.
// ---------------------------------------------------------------------------

/**
 * STRICT ACCEPTED-RESPONSE DECODER.
 *
 * The harness previously did `retry.body['outcome'] as never`, which defeated
 * the SubmissionResult contract: an `undefined` outcome flowed into
 * applyResult() and settled as ACKED. applyResult is not defective — it was
 * handed an impossible typed value.
 *
 * A malformed or non-success response is an INTEGRATION FAILURE, never a domain
 * state. It throws rather than inventing one.
 */
function decodeAcceptedFoodLogResponse(
  response: { status: number; body: unknown },
  expectedLogId: string,
): SubmissionResult {
  if (response.status !== 200) {
    throw new Error(`unexpected HTTP status ${response.status}`);
  }
  const body = response.body;
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('malformed response body: expected a JSON object');
  }
  const record = body as Record<string, unknown>;

  const outcome = record['outcome'];
  if (typeof outcome !== 'string') throw new Error('missing outcome in response');
  if (outcome !== 'appended' && outcome !== 'replayed_existing'
      && outcome !== 'idempotency_conflict') {
    throw new Error(`unknown outcome "${outcome}"`);
  }

  const logId = record['logId'];
  if (typeof logId !== 'string') throw new Error('missing logId in response');
  // An ACK is only justified for the SAME (userId, logId) being settled — a
  // valid outcome for another log must never settle this entry.
  if (logId !== expectedLogId) {
    throw new Error(`wrong logId: expected ${expectedLogId}, received ${logId}`);
  }

  // Ordinary narrowing: no cast.
  return { kind: 'accepted', outcome };
}

/** Start the REAL MacrosApi with the REAL food-log route on an ephemeral port. */
async function startApi(pool: PgPoolLike): Promise<{
  port: number; tokenA: string; close: () => Promise<void>;
}> {
  // The fake auth PROVIDER is acceptable (HH-2 is a separate milestone), but the
  // authentication MACHINERY below is the real MacrosApi path — Bearer header,
  // session verification and subjectFromSession — with no
  // mintSubjectForTests shortcut anywhere.
  const auth = new FakeAuthSessionProvider({
    'token-a': {
      subjectId: USER_A,
      issuedAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2099-01-01T00:00:00.000Z',
    },
  });

  const loaded = loadRoleConfig('server', {
    environment: 'development',
    appVersion: '1.0.0',
    apiVersion: 'macros-api@1.0.0',
    expectedSchemaVersion: '0005',
    // Server-side only. The pool for this harness is socket-based; this value
    // exists so the server config validates.
    databaseAppUrl: `postgres://localhost/${DB}`,
    auth: 'synthetic', assistant: 'synthetic', scale: 'synthetic',
    activity: 'synthetic', catalog: 'synthetic',
    logLevel: 'error',
    maxRequestBytes: 65536,
  });
  if (!loaded.ok) throw new Error('integration config invalid');

  const api = new MacrosApi({
    config: loaded.config as RuntimeConfig,
    auth,
    logger: new StructuredLogger({ write: () => undefined }, 'error'),
    versions: {
      appVersion: '1.0.0', apiVersion: 'macros-api@1.0.0', schemaVersion: '0005',
      scaleProtocolVersion: 'scale-protocol@1.0.0', nutritionCalcVersion: 'n@1',
      energyPolicyVersion: 'e@1', voiceParserVersion: 'v@1',
      assistantContractVersion: 'a@1', foodLogFoldVersion: 'f@1',
    },
    now: () => new Date().toISOString(),
    health: () => ({ databaseReachable: 'ready', migrationsApplied: true, configValid: true }),
    newRequestId: () => randomUUID(),
  });

  api.route(foodLogRoute({ pool }));

  const server = api.createServer();
  const port = await new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve(typeof addr === 'object' && addr !== null ? addr.port : 0);
    });
  });
  return {
    port, tokenA: 'token-a',
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function post(
  url: string, token: string | null, body: unknown,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token !== null ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  // Parsing JSON produces `unknown`. Claiming Record<string, unknown> here is
  // how an undefined outcome became an ACK.
  let parsed: unknown = undefined;
  try { parsed = await res.json(); } catch { /* body may be empty */ }
  return { status: res.status, body: parsed };
}
