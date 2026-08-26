import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  APPLICATION_ROLE, DatabaseIdentityError, executorFor, residualIdentity,
  withAuthenticatedDatabaseSubject, type PgClientLike, type PgPoolLike,
} from '@macros/postgres-driver';
import { mintSubjectForTests } from '@macros/domain-auth';
import { USER_A, USER_B } from '@macros/testkit';

/**
 * A fake driver that models the ONE property that matters: `SET LOCAL` dies
 * with the transaction. It is not a database — it exists to prove the edge
 * sequences correctly. RT-6/7/8 close on the real server, not here.
 */
class FakeClient implements PgClientLike {
  readonly log: string[] = [];
  private local: string | null = null;
  private inTx = false;
  released = false;
  constructor(
    private readonly pool: FakePool,
    private readonly failOn: { text?: string; error?: string } = {},
  ) {}

  async query(text: string, params?: readonly unknown[]): Promise<{ rows: unknown[] }> {
    this.log.push(text.trim().split('\n')[0]!.slice(0, 40));
    if (this.failOn.text !== undefined && text.includes(this.failOn.text)) {
      throw new Error(this.failOn.error ?? 'simulated failure');
    }
    if (text === 'BEGIN') { this.inTx = true; return { rows: [] }; }
    if (text === 'COMMIT' || text === 'ROLLBACK') {
      // Transaction-local settings do not survive either outcome.
      this.inTx = false; this.local = null; return { rows: [] };
    }
    if (text.startsWith('SET LOCAL ROLE')) return { rows: [] };
    if (text.startsWith('SELECT set_config')) {
      this.local = String(params?.[1] ?? ''); return { rows: [] };
    }
    if (text.includes('auth.uid()')) return { rows: [{ uid: this.local }] };
    if (text.includes('current_setting')) return { rows: [{ uid: this.local }] };
    return { rows: this.pool.nextResult() };
  }
  release(): void { this.released = true; this.pool.checkedIn.push(this); }
}

class FakePool implements PgPoolLike {
  readonly issued: FakeClient[] = [];
  readonly checkedIn: FakeClient[] = [];
  private results: unknown[][] = [];
  constructor(private readonly failOn: { text?: string; error?: string } = {}) {}
  queueResult(rows: unknown[]): void { this.results.push(rows); }
  nextResult(): unknown[] { return this.results.shift() ?? []; }
  async connect(): Promise<PgClientLike> {
    // Reuse the physical client, as a real pool does.
    const reused = this.checkedIn.pop();
    if (reused !== undefined) return reused;
    const c = new FakeClient(this, this.failOn);
    this.issued.push(c);
    return c;
  }
  async end(): Promise<void> { /* no-op */ }
}

const subjectA = () => mintSubjectForTests(USER_A, { displayName: 'A' });
const subjectB = () => mintSubjectForTests(USER_B, { displayName: 'B' });

describe('RT-6 — request-scoped database identity', () => {
  test('the transaction sequence is BEGIN, role, identity, assert, work, COMMIT', async () => {
    const pool = new FakePool();
    await withAuthenticatedDatabaseSubject(pool, subjectA(), async () => 'ok');
    const log = pool.issued[0]!.log;
    assert.equal(log[0], 'BEGIN');
    assert.ok(log[1]!.includes(APPLICATION_ROLE), 'ordinary role assumed before any query');
    assert.ok(log[2]!.startsWith('SELECT set_config'), 'identity set transaction-locally');
    assert.ok(log[3]!.includes('auth.uid()'), 'identity is ASSERTED, not assumed');
    assert.equal(log[log.length - 1], 'COMMIT');
  });

  test('identity is asserted — a NULL auth.uid() fails closed', async () => {
    const pool = new FakePool();
    // set_config silently does nothing: auth.uid() would be NULL and RLS would
    // return zero rows, which a caller could misread as "no data".
    const broken = { ...pool, connect: async () => {
      const c = new FakeClient(pool as FakePool);
      const original = c.query.bind(c);
      c.query = async (t: string, p?: readonly unknown[]) =>
        t.startsWith('SELECT set_config') ? { rows: [] } : original(t, p);
      return c;
    } } as unknown as PgPoolLike;
    await assert.rejects(
      () => withAuthenticatedDatabaseSubject(broken, subjectA(), async () => 'ok'),
      (e: DatabaseIdentityError) => e.reason === 'identity_mismatch');
  });

  test('an EXPIRED session never reaches the database', async () => {
    const pool = new FakePool();
    const stale = mintSubjectForTests(USER_A, { expiresAt: '2020-01-01T00:00:00.000Z' });
    await assert.rejects(
      () => withAuthenticatedDatabaseSubject(pool, stale, async () => 'ok',
        { nowIso: '2026-08-26T00:00:00.000Z' }),
      (e: DatabaseIdentityError) => e.reason === 'session_expired');
    assert.equal(pool.issued.length, 0, 'no connection was even checked out');
  });

  test('work failure ROLLS BACK and still releases the client', async () => {
    const pool = new FakePool();
    await assert.rejects(() => withAuthenticatedDatabaseSubject(
      pool, subjectA(), async () => { throw new Error('repository exploded'); }));
    const c = pool.issued[0]!;
    assert.ok(c.log.includes('ROLLBACK'));
    assert.equal(c.log.includes('COMMIT'), false);
    assert.equal(c.released, true);
  });

  test('BEGIN failure is reported as a database failure, not a data result', async () => {
    const pool = new FakePool({ text: 'BEGIN', error: 'server closed the connection' });
    await assert.rejects(() => withAuthenticatedDatabaseSubject(pool, subjectA(), async () => 'x'));
  });

  test('a missing application role fails closed', async () => {
    const pool = new FakePool({ text: 'SET LOCAL ROLE', error: 'role does not exist' });
    await assert.rejects(
      () => withAuthenticatedDatabaseSubject(pool, subjectA(), async () => 'x'),
      (e: DatabaseIdentityError) => e.reason === 'role_unavailable');
  });

  test('handlers receive ONLY a transaction-bound executor', async () => {
    const pool = new FakePool();
    await withAuthenticatedDatabaseSubject(pool, subjectA(), async (sql) => {
      // No pool, no client, no privileged escape hatch.
      assert.deepEqual(Object.keys(sql), ['query']);
      return null;
    });
  });
});

describe('RT-6 — pooled connection cannot leak identity', () => {
  test('a reused connection carries NOTHING from the previous user', async () => {
    const pool = new FakePool();
    await withAuthenticatedDatabaseSubject(pool, subjectA(), async () => 'a');
    assert.equal(await residualIdentity(pool), null, 'identity cleared after COMMIT');

    let observed: string | null = 'unset';
    await withAuthenticatedDatabaseSubject(pool, subjectB(), async (sql) => {
      const r = await sql.query<{ uid: string }>('SELECT auth.uid()::text AS uid', []);
      observed = r[0]?.uid ?? null;
      return null;
    });
    assert.equal(observed, USER_B, "B sees B's identity, never A's");
    assert.equal(pool.issued.length, 1, 'the same physical connection was reused');
  });

  test('identity does not survive a ROLLBACK either', async () => {
    const pool = new FakePool();
    await assert.rejects(() => withAuthenticatedDatabaseSubject(
      pool, subjectA(), async () => { throw new Error('boom'); }));
    assert.equal(await residualIdentity(pool), null);
  });
});

describe('RT-7 — classification is the repository\'s job, not the driver\'s', () => {
  test('the driver edge contributes identity and transaction scope ONLY', () => {
    // appended / replayed_existing / idempotency_conflict is decided by
    // PostgresFoodLogRepository comparing payload fingerprints. The driver must
    // not second-guess it, which is why the real 32-session proof has to run
    // through the repository rather than through raw SQL.
    const repo = readFileSync('packages/persistence/src/postgres.ts', 'utf8');
    assert.match(repo, /replayed_existing/);
    assert.match(repo, /idempotency_conflict/);
    assert.match(repo, /foodLogFingerprint\(existing\) === foodLogFingerprint\(item\)/,
      'payload equality is what separates a replay from a conflict');

    const driver = readFileSync('packages/postgres-driver/src/identity.ts', 'utf8');
    for (const decision of ['replayed_existing', 'idempotency_conflict', 'appended']) {
      assert.equal(driver.includes(decision), false,
        `the driver must not classify outcomes (${decision})`);
    }
  });

  test('a conflict on an unreadable row fails loudly rather than guessing', () => {
    const repo = readFileSync('packages/persistence/src/postgres.ts', 'utf8');
    assert.match(repo, /no readable row — refusing to proceed/);
  });
});

describe('executorFor', () => {
  test('returns rows unwrapped from the driver result', async () => {
    const pool = new FakePool();
    pool.queueResult([{ a: 1 }]);
    const client = await pool.connect();
    const rows = await executorFor(client).query<{ a: number }>('SELECT 1', []);
    assert.deepEqual(rows, [{ a: 1 }]);
  });
});

describe('RT-6 — integration surface and dependency declaration', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  const integration = readFileSync('tools/postgres-integration/run-integration.ts', 'utf8');

  test('pg is declared EXACTLY, not as a range', () => {
    assert.match(pkg.dependencies?.pg ?? '', /^\d+\.\d+\.\d+$/,
      'a caret would reintroduce the toolchain drift we already fixed');
  });

  test('the integration suite uses the real driver, never psql', () => {
    assert.match(integration, /createPgPool/);
    // Comments explain that psql is NOT used; what matters is that no process
    // is spawned to run SQL on the suite's behalf.
    const code = integration.replace(/^\s*(\/\/|\*|\/\*).*$/gm, '');
    assert.equal(/child_process|execSync|spawnSync/.test(code), false,
      'psql must not be the implementation under test');
  });

  test('it refuses any database but macros_dev and never drops one', () => {
    assert.match(integration, /REFUSING: MACROS_DB/);
    assert.equal(/DROP DATABASE|DROP SCHEMA|dropdb/.test(integration), false);
  });

  test('test data is namespaced per run for repeatable execution', () => {
    assert.match(integration, /const RUN = randomUUID\(\)/);
    assert.match(integration, /race-\$\{RUN\}|`race-\$\{RUN\}`/);
  });

  test('RT-7 asserts the exact classification split', () => {
    assert.match(integration, /counts\['appended'\] === 1/);
    assert.match(integration, /counts\['replayed_existing'\] === 31/);
  });

  test('RT-8 drives the real outbox state machine', () => {
    assert.match(integration, /recoverInFlight/);
    assert.match(integration, /dueForSubmission/);
    assert.match(integration, /applyResult/);
    assert.match(integration, /settled\.state === 'acked'/);
  });

  test('no database URL or credential appears in the repository', () => {
    assert.equal(/postgres:\/\/[^\s'"]*:[^\s'"]*@/.test(integration), false,
      'no connection string with credentials');
    const pool = readFileSync('packages/postgres-driver/src/pool.ts', 'utf8');
    assert.match(pool, /connection string is never accepted or logged/i);
  });
});
