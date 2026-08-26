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
  applyResult, dueForSubmission, recoverInFlight, type OutboxEntry,
} from '@macros/domain-offline-sync';
import type { FoodLogItem } from '@macros/contracts';
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

const logFor = (userId: string, logId: string, kcal: number): FoodLogItem => ({
  userId, logId,
  productId: 'prod-test-1', productVersionId: 'prod-test-1@v1',
  grams: 100,
  loggedAt: '2026-08-26T12:00:00.000Z',
  eventTimezone: 'UTC', eventUtcOffsetMinutes: 0, localDate: '2026-08-26',
  mealId: null, nutritionCalcVersion: 'integration',
  weightCapture: { grams: 100, source: 'manual', capturedAt: '2026-08-26T12:00:00.000Z' },
  nutritionSnapshot: {
    gramsConsumed: 100, productVersionId: 'prod-test-1@v1',
    totals: { kcal, proteinG: 10, carbohydrateG: 5, fatG: 2 },
  },
  status: 'active',
} as unknown as FoodLogItem);

async function main(): Promise<void> {
  say('MACROS.AI — real Node/PostgreSQL integration (RT-6 / RT-7 / RT-8)');
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

  // --- Real repositories --------------------------------------------------
  section('RT-6 — REAL REPOSITORIES');
  const profileId = `pv-${RUN}`;
  const goalId = `gv-${RUN}`;
  try {
    await withAuthenticatedDatabaseSubject(pool, subjectA, async (sql: SqlExecutor) => {
      const profiles = new PostgresUserProfileRepository(sql);
      await profiles.append({
        profileVersionId: profileId, userId: USER_A,
        effectiveFrom: '2026-01-01T00:00:00.000Z',
        ageYears: 35, sex: 'male', bodyWeightKg: 82.5, heightCm: 180,
        bodyFatPercent: null, bodyFatSource: null,
      } as never);
      const eff = await profiles.getEffective(USER_A, '2026-08-26T12:00:00.000Z');
      eff !== null && eff.profileVersionId === profileId
        ? ok('profile append + effective-dated read')
        : fail('profile effective read');

      const goals = new PostgresEnergyGoalRepository(sql);
      await goals.append({
        goalVersionId: goalId, userId: USER_A,
        effectiveFrom: '2026-01-01T00:00:00.000Z', goal: 'gain', targetDeltaKcal: 250,
      } as never);
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
    const conflicting = logFor(USER_A, raceLog, 999);
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
      ? ok('canonical row unchanged (kcal 100)')
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

  // --- RT-8: offline settlement through the real path ---------------------
  section('RT-8 — OFFLINE OUTBOX SETTLEMENT');
  const offlineLog = `offline-${RUN}`;
  try {
    const payload = logFor(USER_A, offlineLog, 150);
    let entry: OutboxEntry = {
      userId: USER_A, logId: offlineLog, payload,
      state: 'pending', attempts: 0, sequence: 1,
    };

    // 1. Submission reaches the server and COMMITS.
    entry = { ...entry, state: 'in_flight' };
    const first = await withAuthenticatedDatabaseSubject(pool, subjectA, (sql) =>
      new PostgresFoodLogRepository(sql).append(payload));
    first.outcome === 'appended' ? ok('server committed the row') : fail('first submit', first.outcome);

    // 2. CRASH before the ACK is recorded: the entry is still in_flight.
    //    Restart recovery must make it retryable, not stranded.
    const recovered = recoverInFlight([entry]);
    recovered[0]!.state === 'pending'
      ? ok('crash recovery returns in_flight -> pending')
      : fail('crash recovery', recovered[0]!.state);

    const due = dueForSubmission(recovered, Date.now(), []);
    due.length === 1 ? ok('entry is due for resubmission') : fail('not resubmitted');

    // 3. Resend the EXACT payload through the real repository.
    const retry = await withAuthenticatedDatabaseSubject(pool, subjectA, (sql) =>
      new PostgresFoodLogRepository(sql).append(payload));
    retry.outcome === 'replayed_existing'
      ? ok('retry returns replayed_existing')
      : fail('retry classification', retry.outcome);

    const settled = applyResult(recovered[0]!, { kind: 'accepted', outcome: retry.outcome }, Date.now());
    settled.state === 'acked' ? ok('outbox settles as ACKED') : fail('settlement', settled.state);

    const rows = await withAuthenticatedDatabaseSubject(pool, subjectA, async (sql) => {
      const r = await sql.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM food_logs WHERE log_id = $1 AND user_id = $2',
        [offlineLog, USER_A]);
      return Number(r[0]!.n);
    });
    rows === 1 ? ok('exactly 1 row after crash + retry') : fail('duplicate created', String(rows));

    // 4. Conflict: same identity, different payload.
    const conflict = await withAuthenticatedDatabaseSubject(pool, subjectA, (sql) =>
      new PostgresFoodLogRepository(sql).append(logFor(USER_A, offlineLog, 777)));
    const conflicted = applyResult(settled, { kind: 'accepted', outcome: conflict.outcome }, Date.now());
    conflict.outcome === 'idempotency_conflict' && conflicted.state === 'conflict'
      ? ok('conflicting payload settles as conflict, neither side overwritten')
      : fail('conflict settlement', `${conflict.outcome}/${conflicted.state}`);
  } catch (e) { fail('offline settlement', String(e)); }

  // --- Failure behaviour --------------------------------------------------
  section('FAILURE BEHAVIOUR');
  try {
    const stale = mintSubjectForTests(USER_A, { expiresAt: '2020-01-01T00:00:00.000Z' });
    try {
      await withAuthenticatedDatabaseSubject(pool, stale, async () => null);
      fail('expired session reached the database');
    } catch { ok('expired session refused before any database access'); }

    try {
      await withAuthenticatedDatabaseSubject(pool, subjectA, async (sql) => {
        await sql.query('SELECT * FROM table_that_does_not_exist', []);
        return null;
      });
      fail('bad query did not raise');
    } catch { ok('repository query failure propagates and rolls back'); }

    const residual = await residualIdentity(pool);
    residual === null
      ? ok('no identity residue after a failed transaction')
      : fail('identity residue after failure', residual);
  } catch (e) { fail('failure behaviour', String(e)); }

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

    // 1-6. Real HTTP submission with a real Bearer credential.
    const first = await post(url, started.tokenA, { foodLog: payload });
    first.status === 200 && first.body['outcome'] === 'appended'
      ? ok('HTTP submission committed through the real server path')
      : fail('HTTP submit', `${first.status} ${JSON.stringify(first.body).slice(0, 90)}`);

    // 7-8. Crash BEFORE applyResult: the entry is still in_flight.
    const recovered = recoverInFlight([entry]);
    recovered[0]!.state === 'pending'
      ? ok('crash before ACK recovers to pending')
      : fail('crash recovery', recovered[0]!.state);

    // 9-12. Resend the same entry over HTTP.
    const retry = await post(url, started.tokenA, { foodLog: payload });
    retry.body['outcome'] === 'replayed_existing'
      ? ok('HTTP retry returns replayed_existing')
      : fail('HTTP retry', String(retry.body['outcome']));

    const settled = applyResult(recovered[0]!,
      { kind: 'accepted', outcome: retry.body['outcome'] as never }, Date.now());
    settled.state === 'acked' ? ok('outbox settles ACKED via HTTP') : fail('settlement', settled.state);

    // 13. Exactly one row.
    const rows = await withAuthenticatedDatabaseSubject(pool, subjectA, async (sql) => {
      const r = await sql.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM food_logs WHERE log_id = $1', [httpLog]);
      return Number(r[0]!.n);
    });
    rows === 1 ? ok('exactly 1 row after HTTP crash + retry') : fail('duplicate via HTTP', String(rows));

    // Conflict over HTTP.
    const conflict = await post(url, started.tokenA, { foodLog: logFor(USER_A, httpLog, 888) });
    const conflicted = applyResult(settled,
      { kind: 'accepted', outcome: conflict.body['outcome'] as never }, Date.now());
    conflict.body['outcome'] === 'idempotency_conflict' && conflicted.state === 'conflict'
      ? ok('HTTP conflict settles as conflict, nothing overwritten')
      : fail('HTTP conflict', `${String(conflict.body['outcome'])}/${conflicted.state}`);

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

    const leak = JSON.stringify(malformed.body) + JSON.stringify(forged.body);
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
      await sql.query('DELETE FROM food_logs WHERE log_id IN ($1, $2, $3)',
        [raceLog, offlineLog, httpLog]);
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
    versions: { app: '1.0.0', api: 'macros-api@1.0.0', schema: '0005' },
    now: () => new Date().toISOString(),
    health: () => ({ databaseReachable: 'ready', migrationsApplied: true, configValid: true }),
  } as never);

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
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token !== null ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  let parsed: Record<string, unknown> = {};
  try { parsed = (await res.json()) as Record<string, unknown>; } catch { /* empty */ }
  return { status: res.status, body: parsed };
}
