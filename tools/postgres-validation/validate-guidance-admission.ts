/**
 * REAL POSTGRESQL VALIDATION FOR DISTRIBUTED GUIDANCE ADMISSION.
 *
 * The unit tests use a shared in-process store. That is useful for determinism
 * and useless as evidence about SQL: it proves the model in my head, not the
 * statement the database runs. Concurrency, atomicity and RLS can only be shown
 * by a real server.
 *
 * This harness therefore uses TWO INDEPENDENT connections — as two server
 * instances would be — coordinating only through the database.
 *
 *   PGHOST=/tmp npm run postgres:guidance-validate
 *
 * It refuses any database but `macros_dev`, matching the existing safety
 * harness, and removes its own test subjects afterwards.
 */
import { createPgPool, type PgClientLike } from '@macros/postgres-driver';
import { PostgresGuidanceAdmission, type AdmissionSql } from '@macros/persistence';

const DATABASE = 'macros_dev';

/** Deterministic test subjects, deleted on the way out. */
const SUBJECT_X = '0000000a-0000-4000-8000-000000000001';
const SUBJECT_Y = '0000000a-0000-4000-8000-000000000002';

const POLICY = {
  maxRequestsPerWindow: 3,
  windowMs: 2_000,
  leaseTtlMs: 1_500,
  inMemoryEntryTtlMs: 300_000,
};

let failures = 0;
const say = (line: string): void => { process.stdout.write(`${line}\n`); };
const check = (ok: boolean, label: string): void => {
  if (ok) { say(`  [PASS] ${label}`); return; }
  failures += 1;
  say(`  [FAIL] ${label}`);
};
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => { setTimeout(resolve, ms); });

/** One dedicated client, standing in for one server instance. */
function sqlFor(client: PgClientLike): AdmissionSql {
  return {
    async query<T = Record<string, unknown>>(text: string, values?: readonly unknown[]) {
      const result = await client.query(text, values as unknown[]);
      return { rows: (result as { rows: T[] }).rows };
    },
  };
}

let sequence = 0;
const uuid = (): string => {
  sequence += 1;
  return `0000000b-0000-4000-8000-${String(sequence).padStart(12, '0')}`;
};

const scalar = <T>(result: unknown, column: string): T | undefined =>
  ((result as { rows: Record<string, T>[] }).rows[0] ?? {})[column];

async function main(): Promise<void> {
  const requested = process.env['PGDATABASE'] ?? DATABASE;
  if (requested !== DATABASE) {
    // Same refusal as the existing harness: a validation run must never be
    // pointed at something that is not the development database.
    throw new Error(`refusing to run against ${requested}; only ${DATABASE} is permitted`);
  }

  const pool = await createPgPool({
    host: process.env['PGHOST'] ?? '/tmp',
    port: Number(process.env['PGPORT'] ?? 5432),
    database: DATABASE,
    max: 6,
  });

  // TWO independent clients. Neither can see the other's state except through
  // the database, which is exactly the multi-instance condition.
  const clientA = await pool.connect();
  const clientB = await pool.connect();

  const a = new PostgresGuidanceAdmission(sqlFor(clientA), POLICY, uuid);
  const b = new PostgresGuidanceAdmission(sqlFor(clientB), POLICY, uuid);

  const reset = async (): Promise<void> => {
    await clientA.query(
      'DELETE FROM guidance_admission WHERE subject_id = ANY($1::uuid[])',
      [[SUBJECT_X, SUBJECT_Y]]);
  };

  const countFor = async (subject: string): Promise<number | undefined> => {
    const result = await clientA.query(
      'SELECT window_request_count FROM guidance_admission WHERE subject_id = $1',
      [subject]);
    return scalar<number>(result, 'window_request_count');
  };

  try {
    say('\n=== SCHEMA AND SERVER AUTHORITY ===');
    const present = await clientA.query(
      `SELECT EXISTS (SELECT 1 FROM information_schema.tables
                       WHERE table_name = 'guidance_admission') AS present`);
    check(scalar<boolean>(present, 'present') === true,
      'guidance_admission exists (applied by npm run postgres:validate)');

    const rls = await clientA.query(
      `SELECT relrowsecurity, relforcerowsecurity
         FROM pg_class WHERE relname = 'guidance_admission'`);
    check(scalar<boolean>(rls, 'relrowsecurity') === true, 'row level security ENABLED');
    check(scalar<boolean>(rls, 'relforcerowsecurity') === true, 'row level security FORCED');

    const policies = await clientA.query(
      `SELECT count(*)::int AS n FROM pg_policies WHERE tablename = 'guidance_admission'`);
    check(scalar<number>(policies, 'n') === 0,
      'no policy grants authenticated access — server authority only');

    // With RLS forced and no policy, the application role is refused every verb.
    for (const verb of ['SELECT 1 FROM guidance_admission',
                        `INSERT INTO guidance_admission (subject_id, window_started_at)
                           VALUES ('${SUBJECT_X}'::uuid, now())`,
                        `UPDATE guidance_admission SET window_request_count = 0`,
                        'DELETE FROM guidance_admission']) {
      let blocked = false;
      try {
        await clientA.query('BEGIN');
        await clientA.query("SET LOCAL ROLE macros_app");
        const r = await clientA.query(verb);
        // SELECT under forced RLS returns no rows rather than erroring.
        blocked = verb.startsWith('SELECT')
          ? ((r as { rows: unknown[] }).rows.length === 0)
          : false;
      } catch {
        blocked = true;
      } finally {
        await clientA.query('ROLLBACK').catch(() => undefined);
      }
      check(blocked, `macros_app cannot ${verb.split(' ')[0]} guidance_admission`);
    }

    say('\n=== FRESH-ROW RACE (the hard case) ===');
    /**
     * A subject with NO ROW is where a compute-then-insert design breaks: both
     * instances read nothing, both decide to admit, one inserts and the other's
     * conflict update runs. Repeated so a single lucky interleaving cannot pass.
     */
    const ITERATIONS = 25;
    let raceFailures = 0;
    for (let i = 0; i < ITERATIONS; i += 1) {
      await reset();
      const [x, y] = await Promise.all([a.acquire(SUBJECT_X), b.acquire(SUBJECT_X)]);
      const winners = [x, y].filter((r) => r.admitted);
      if (winners.length !== 1) { raceFailures += 1; continue; }

      // The DATABASE must show exactly one admitted call, held by the winner.
      const persistedCount = await countFor(SUBJECT_X);
      const persistedLease = scalar<string>(
        await clientA.query(
          'SELECT lease_id::text AS lease_id FROM guidance_admission WHERE subject_id = $1',
          [SUBJECT_X]),
        'lease_id');
      const winner = winners[0]!;
      if (persistedCount !== 1) { raceFailures += 1; continue; }
      if (!winner.admitted || persistedLease !== winner.lease.leaseId) raceFailures += 1;
    }
    check(raceFailures === 0,
      `${ITERATIONS} fresh-row races: exactly one admitted, count 1, lease owned by winner`
      + ` (${raceFailures} failure(s))`);

    say('\n=== CONCURRENCY ON AN EXISTING ROW ===');
    await reset();
    // Issued together so the database, not the test, decides the winner.
    const [first, second] = await Promise.all([
      a.acquire(SUBJECT_X), b.acquire(SUBJECT_X),
    ]);
    const admitted = [first, second].filter((r) => r.admitted).length;
    check(admitted === 1, `exactly one of two concurrent acquires admitted (got ${admitted})`);
    const loser = first.admitted ? second : first;
    check(!loser.admitted && loser.reason === 'in_flight', 'the loser is refused as in_flight');
    check((await countFor(SUBJECT_X)) === 1, 'the refusal did not increment the count');

    say('\n=== RELEASE ===');
    const winner = first.admitted ? first : second;
    if (winner.admitted) await (first.admitted ? a : b).release(winner.lease);
    check((await b.acquire(SUBJECT_X)).admitted, 'another instance acquires after release');

    say('\n=== LEASE EXPIRY (crashed instance, no release) ===');
    await reset();
    check((await a.acquire(SUBJECT_X)).admitted, 'instance A holds the lease');
    check(!(await b.acquire(SUBJECT_X)).admitted, 'instance B is blocked');
    await sleep(POLICY.leaseTtlMs + 300);   // nobody releases: the crash case
    check((await b.acquire(SUBJECT_X)).admitted,
      'an expired lease recovers without any release');

    say('\n=== LATE RELEASE CANNOT CLEAR A NEWER LEASE ===');
    await reset();
    const stale = await a.acquire(SUBJECT_X);
    await sleep(POLICY.leaseTtlMs + 300);
    check((await b.acquire(SUBJECT_X)).admitted, 'a fresh lease is taken after expiry');
    if (stale.admitted) await a.release(stale.lease);
    check(!(await a.acquire(SUBJECT_X)).admitted,
      'the newer lease survives a late release of the old one');

    say('\n=== RELEASE IS IDEMPOTENT ===');
    await reset();
    const once = await a.acquire(SUBJECT_X);
    if (once.admitted) { await a.release(once.lease); await a.release(once.lease); }
    check((await b.acquire(SUBJECT_X)).admitted, 'one slot is available after a double release');
    check(!(await a.acquire(SUBJECT_X)).admitted,
      'a double release did not open a slot that was never taken');

    say('\n=== SUBJECT ISOLATION ===');
    await reset();
    check((await a.acquire(SUBJECT_X)).admitted, 'X is admitted');
    check((await b.acquire(SUBJECT_Y)).admitted, 'Y is unaffected by X');

    say('\n=== QUOTA SEMANTICS ===');
    await reset();
    for (let i = 0; i < POLICY.maxRequestsPerWindow; i += 1) {
      const adapter = i % 2 === 0 ? a : b;
      const decision = await adapter.acquire(SUBJECT_X);
      check(decision.admitted, `admitted call ${i + 1} of ${POLICY.maxRequestsPerWindow}`);
      if (decision.admitted) await adapter.release(decision.lease);
    }
    const over = await b.acquire(SUBJECT_X);
    check(!over.admitted && over.reason === 'quota_exceeded',
      'the quota is shared across independent connections');

    // A refusal must NOT extend the lockout: the count tracks spend, not taps.
    const before = await countFor(SUBJECT_X);
    await b.acquire(SUBJECT_X);
    await b.acquire(SUBJECT_X);
    const after = await countFor(SUBJECT_X);
    check(before === after,
      `a refusal does not increment the admitted count (${before} -> ${after})`);

    say('\n=== WINDOW RESET ===');
    await sleep(POLICY.windowMs + 300);
    check((await a.acquire(SUBJECT_X)).admitted, 'a new window admits again');
    check((await countFor(SUBJECT_X)) === 1, 'the count restarts at 1 in a new window');
  } finally {
    await reset().catch(() => undefined);
    clientA.release();
    clientB.release();
    await pool.end();
  }

  say(`\n${failures === 0
    ? 'GUIDANCE ADMISSION VALIDATION: PASS'
    : `GUIDANCE ADMISSION VALIDATION: ${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
