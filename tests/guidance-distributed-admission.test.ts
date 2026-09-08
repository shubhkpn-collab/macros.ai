import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  DEFAULT_ADMISSION_POLICY, InMemoryGuidanceAdmission, type AdmissionPolicy,
} from '@macros/runtime-api';
import { PostgresGuidanceAdmission, type AdmissionSql } from '@macros/persistence';
import { repoPath } from '../tools/repo-paths.js';

const read = (...p: string[]): string => readFileSync(repoPath(...p), 'utf8');

const POLICY: AdmissionPolicy = {
  ...DEFAULT_ADMISSION_POLICY,
  maxRequestsPerWindow: 3, windowMs: 1000, leaseTtlMs: 500,
};

/**
 * A SHARED store standing in for PostgreSQL.
 *
 * A DETERMINISTIC UNIT MODEL, not database evidence: it proves the model in my
 * head, not the statement PostgreSQL runs. Real concurrency, atomicity and RLS
 * are covered by `npm run postgres:guidance-validate`, which is owner-executed.
 *
 * The point of the multi-instance tests is that two independently constructed
 * adapters coordinate through state neither of them owns — the property a
 * per-process guard cannot have. Two references to one in-memory guard would
 * prove nothing.
 */
class SharedStore {
  readonly rows = new Map<string, {
    leaseId: string | null; leaseExpiresAt: number;
    windowStart: number; count: number;
  }>();

  now = 0;
}

/**
 * Executes the decision the SQL statement expresses, against shared state.
 * It models the atomic upsert rather than a read-then-write.
 */
const sqlFor = (store: SharedStore): AdmissionSql => ({
  async query<T>(text: string, values?: readonly unknown[]) {
    const v = (values ?? []) as string[];
    const subjectId = v[0]!;
    const t = store.now;

    if (text.includes('UPDATE guidance_admission')) {
      const existing = store.rows.get(subjectId);
      if (existing !== undefined && existing.leaseId === v[1]) {
        existing.leaseId = null;
        existing.leaseExpiresAt = 0;
      }
      return { rows: [] as T[] };
    }

    if (text.includes('SELECT (lease_id IS NOT NULL')) {
      const row = store.rows.get(subjectId);
      const live = row !== undefined && row.leaseId !== null && row.leaseExpiresAt > t;
      return { rows: [{ live_lease: live }] as T[] };
    }

    // Mirrors the INSERT ... ON CONFLICT DO UPDATE ... WHERE: the predicate is
    // evaluated against the existing row, and a returned row means admitted.
    const leaseId = v[1]!;
    const leaseTtl = Number(v[2]);
    const windowMs = Number(v[3]);
    const maxRequests = Number(v[4]);

    const row = store.rows.get(subjectId);
    if (row === undefined) {
      store.rows.set(subjectId, {
        leaseId, leaseExpiresAt: t + leaseTtl, windowStart: t, count: 1,
      });
      return { rows: [{ lease_id: leaseId }] as T[] };
    }

    const leaseLive = row.leaseId !== null && row.leaseExpiresAt > t;
    const windowReset = t - row.windowStart >= windowMs;
    if (leaseLive || (!windowReset && row.count >= maxRequests)) {
      return { rows: [] as T[] };
    }

    row.leaseId = leaseId;
    row.leaseExpiresAt = t + leaseTtl;
    if (windowReset) { row.windowStart = t; row.count = 1; } else { row.count += 1; }
    store.rows.set(subjectId, row);
    return { rows: [{ lease_id: leaseId }] as T[] };
  },
});

let sequence = 0;
const instance = (store: SharedStore): PostgresGuidanceAdmission =>
  new PostgresGuidanceAdmission(sqlFor(store), POLICY, () => {
    sequence += 1;
    return `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`;
  });

describe('AI-2 — multi-instance admission', () => {
  test('instance B is refused while instance A holds the lease', async () => {
    const store = new SharedStore();
    const a = instance(store);
    const b = instance(store);

    const first = await a.acquire('subject-x');
    assert.equal(first.admitted, true);

    // Independently constructed adapter, shared durable state.
    const second = await b.acquire('subject-x');
    assert.equal(second.admitted, false);
    assert.equal(second.admitted === false && second.reason, 'in_flight');
  });

  test('releasing on A lets B in', async () => {
    const store = new SharedStore();
    const a = instance(store);
    const b = instance(store);

    const first = await a.acquire('subject-x');
    assert.equal(first.admitted, true);
    if (first.admitted) await a.release(first.lease);

    assert.equal((await b.acquire('subject-x')).admitted, true);
  });

  test('an expired lease recovers without any release', async () => {
    // The crashed-instance case: nobody will ever call release.
    const store = new SharedStore();
    const a = instance(store);
    const b = instance(store);

    assert.equal((await a.acquire('subject-x')).admitted, true);
    assert.equal((await b.acquire('subject-x')).admitted, false);

    store.now += POLICY.leaseTtlMs + 1;
    assert.equal((await b.acquire('subject-x')).admitted, true,
      'a dead instance must not lock a subject out forever');
  });

  test('a late release cannot clear a NEWER lease', async () => {
    const store = new SharedStore();
    const a = instance(store);
    const b = instance(store);

    const stale = await a.acquire('subject-x');
    assert.equal(stale.admitted, true);
    store.now += POLICY.leaseTtlMs + 1;

    const fresh = await b.acquire('subject-x');
    assert.equal(fresh.admitted, true);

    if (stale.admitted) await a.release(stale.lease);
    // The newer lease survives, so B is still protected.
    assert.equal((await a.acquire('subject-x')).admitted, false);
  });

  test('subjects are independent across instances', async () => {
    const store = new SharedStore();
    const a = instance(store);
    const b = instance(store);
    assert.equal((await a.acquire('subject-x')).admitted, true);
    assert.equal((await b.acquire('subject-y')).admitted, true,
      'one member must never block another');
  });

  test('the window quota is shared, not per instance', async () => {
    const store = new SharedStore();
    const a = instance(store);
    const b = instance(store);

    for (let i = 0; i < 3; i += 1) {
      const adapter = i % 2 === 0 ? a : b;
      const decision = await adapter.acquire('subject-x');
      assert.equal(decision.admitted, true);
      if (decision.admitted) await adapter.release(decision.lease);
    }
    const refused = await b.acquire('subject-x');
    assert.equal(refused.admitted, false);
    assert.equal(refused.admitted === false && refused.reason, 'quota_exceeded');

    store.now += POLICY.windowMs + 1;
    assert.equal((await a.acquire('subject-x')).admitted, true);
  });

  test('release is idempotent', async () => {
    const store = new SharedStore();
    const a = instance(store);
    const first = await a.acquire('subject-x');
    if (first.admitted) {
      await a.release(first.lease);
      await a.release(first.lease);
    }
    assert.equal((await a.acquire('subject-x')).admitted, true);
    assert.equal((await a.acquire('subject-x')).admitted, false,
      'a double release must not open a slot that was never taken');
  });
});

describe('AI-2 — admission design', () => {
  test('the route contains no SQL', () => {
    const route = read('packages', 'runtime-api', 'src', 'guidance-route.ts');
    for (const sql of ['INSERT', 'UPDATE ', 'SELECT ', 'guidance_admission']) {
      assert.equal(route.includes(sql), false, `the route contains SQL: ${sql}`);
    }
    assert.match(route, /deps\.admission\.acquire\(/);
  });

  test('acquire is atomic, not read-then-write', () => {
    // Between a SELECT and an UPDATE two instances can both decide they are
    // first, which is precisely the bug this guard exists to prevent.
    const pg = read('packages', 'persistence', 'src', 'guidance-admission-postgres.ts');
    assert.match(pg, /ON CONFLICT \(subject_id\) DO UPDATE/);
    assert.match(pg, /single atomic statement/);
  });

  test('the migration stores no conversation or nutrition data', () => {
    // Comments DECLARE what is not stored; the executable SQL must not define
    // a column for any of it.
    const raw = read('db', 'migrations', '0006_guidance_admission.sql');
    const statements = raw.replace(/^\s*--.*$/gm, '')
      .replace(/COMMENT ON[\s\S]*?;/g, '').toLowerCase();
    for (const banned of ['prompt', 'message', 'response', 'kcal', 'food']) {
      assert.equal(statements.includes(banned), false, `the migration stores ${banned}`);
    }
    const sql = raw.toLowerCase();
    assert.match(sql, /enable row level security/);
    assert.match(sql, /force  row level security/);
  });

  test('the in-memory implementation does not claim to be distributed', () => {
    const code = read('packages', 'runtime-api', 'src', 'guidance-admission.ts');
    assert.match(code, /NOT multi-instance safe/);
  });

  test('the in-memory implementation still honours the contract', async () => {
    let t = 0;
    const guard = new InMemoryGuidanceAdmission(() => t, POLICY);
    const first = await guard.acquire('u1');
    assert.equal(first.admitted, true);
    assert.equal((await guard.acquire('u1')).admitted, false);
    t += POLICY.leaseTtlMs + 1;
    assert.equal((await guard.acquire('u1')).admitted, true, 'lease expiry recovers');
  });
});

describe('AI-2 — the tablet graph stays free of the server', () => {
  test('persistence does not import runtime-api', () => {
    // The tablet imports persistence. When the admission adapter imported
    // runtime-api for its types, that dragged node:http and Buffer into the
    // React Native graph — caught only by compiling the non-JSX tablet files.
    const code = read('packages', 'persistence', 'src', 'guidance-admission-postgres.ts')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.equal(code.includes('@macros/runtime-api'), false,
      'persistence must not depend on the server package');
  });

  test('the adapter still satisfies the route port structurally', async () => {
    const { PostgresGuidanceAdmission: Adapter } = await import('@macros/persistence');
    const adapter = new Adapter(
      { query: async () => ({ rows: [] }) },
      { maxRequestsPerWindow: 1, windowMs: 1, leaseTtlMs: 1, inMemoryEntryTtlMs: 1 },
      () => 'lease',
    );
    // Structural compatibility is what lets the dependency stay inverted.
    assert.equal(typeof adapter.acquire, 'function');
    assert.equal(typeof adapter.release, 'function');
  });
});
