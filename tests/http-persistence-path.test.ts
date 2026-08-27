import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { decodeFoodLogItem, submitFoodLog } from '@macros/runtime-api';
import { withAuthenticatedDatabaseSubject, type PgClientLike, type PgPoolLike } from '@macros/postgres-driver';
import { mintSubjectForTests } from '@macros/domain-auth';
import { repoPath } from '../tools/repo-paths.js';
import { USER_A, USER_B } from '@macros/testkit';

const validPayload = (userId: string, logId: string) => ({
  logId, userId, productId: 'p1', productVersionId: 'p1@v1',
  grams: 100, loggedAt: '2026-08-26T12:00:00.000Z',
  eventTimezone: 'UTC', eventUtcOffsetMinutes: 0, localDate: '2026-08-26',
  mealId: null, nutritionCalcVersion: 'v1',
  weightCapture: { grams: 100, source: 'manual', capturedAt: '2026-08-26T12:00:00.000Z' },
  nutritionSnapshot: {
    totals: { kcal: 100, proteinG: 10, carbohydrateG: 5, fatG: 2 },
    gramsConsumed: 100, productVersionId: 'p1@v1',
    basisKind: 'per_100g', calcVersion: 'v1',
    computedAt: '2026-08-26T12:00:00.000Z', nutrients: {},
  },
  status: 'active',
});

describe('GAP 1 — the real AuthenticatedSubject reaches handlers', () => {
  const server = readFileSync(repoPath('packages', 'runtime-api', 'src', 'server.ts'), 'utf8');

  test('RequestContext carries the subject, not just a userId string', () => {
    // Reducing auth to a string destroys the capability the database identity
    // boundary requires, and forces a handler to reconstruct one.
    assert.match(server, /readonly subject\?: AuthenticatedSubject/);
    assert.match(server, /authenticated = bound/);
  });

  test('authenticate returns the SUBJECT, never a derived string', () => {
    assert.match(server, /Promise<AuthenticatedSubject \| AppError>/);
    assert.equal(/return bound\.userId;/.test(server), false,
      'the subject must not be discarded at the auth boundary');
  });

  test('public routes still work without a subject', () => {
    assert.match(server, /route\.public !== true/);
    assert.match(server, /authenticated !== undefined \? \{ subject: authenticated \}/);
  });

  test('no production route mints or casts a subject', () => {
    const walk = (d: string, out: string[] = []): string[] => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p, out); else if (p.endsWith('.ts')) out.push(p);
      }
      return out;
    };
    for (const f of walk(repoPath('packages', 'runtime-api', 'src'))) {
      const code = readFileSync(f, 'utf8');
      assert.equal(code.includes('mintSubjectForTests'), false, f);
      assert.equal(/as\s+AuthenticatedSubject/.test(code), false, f);
    }
  });
});

describe('GAP 1 — food-log payload validation at the network boundary', () => {
  test('a valid payload decodes', () => {
    const out = decodeFoodLogItem({ foodLog: validPayload(USER_A, 'L1') });
    assert.equal('kind' in (out as object), false, 'should not be an AppError');
  });

  test('a missing payload is rejected', () => {
    const out = decodeFoodLogItem({});
    assert.equal((out as { code?: string }).code, 'missing_food_log');
  });

  for (const field of ['logId', 'userId', 'productId', 'productVersionId'] as const) {
    test(`a missing ${field} is rejected before persistence`, () => {
      const payload = { ...validPayload(USER_A, 'L1') } as Record<string, unknown>;
      delete payload[field];
      const out = decodeFoodLogItem({ foodLog: payload });
      assert.equal((out as { code?: string }).code, 'invalid_food_log');
    });
  }

  for (const field of ['weightCapture', 'nutritionSnapshot'] as const) {
    test(`a malformed ${field} is rejected`, () => {
      const payload = { ...validPayload(USER_A, 'L1'), [field]: 'not an object' };
      const out = decodeFoodLogItem({ foodLog: payload });
      assert.equal((out as { code?: string }).code, 'invalid_food_log');
    });
  }

  test('unknown fields do not become authority', () => {
    const out = decodeFoodLogItem({
      foodLog: { ...validPayload(USER_A, 'L1'), injectedAuthority: 'evil', kcal: 99999 },
    });
    assert.equal('injectedAuthority' in (out as object), false,
      'the codec round-trip drops anything it cannot express');
  });
});

describe('GAP 1 — forged userId cannot become database authority', () => {
  test('the route refuses a payload claiming another user', () => {
    const route = readFileSync(repoPath('packages', 'runtime-api', 'src', 'food-log-route.ts'), 'utf8');
    assert.match(route, /item\.userId !== authoritative/);
    assert.match(route, /subject_mismatch/);
    assert.match(route, /at most a CLAIM/i);
  });

  test('the handler never receives a Pool or client', () => {
    const route = readFileSync(repoPath('packages', 'runtime-api', 'src', 'food-log-route.ts'), 'utf8');
    assert.match(route, /withAuthenticatedDatabaseSubject/);
    assert.equal(/ctx\.pool|context\.pool/.test(route), false);
    assert.match(route, /captured in the closure/i);
  });

  test('only the canonical outcome crosses the boundary', () => {
    const route = readFileSync(repoPath('packages', 'runtime-api', 'src', 'food-log-route.ts'), 'utf8');
    assert.match(route, /return \{ outcome: result\.outcome, logId: result\.item\.logId \}/);
  });
});

// ---------------------------------------------------------------------------

class Client implements PgClientLike {
  readonly log: string[] = [];
  released: 'normal' | 'destroyed' | null = null;
  private local: string | null = null;
  constructor(private readonly fail: { on: string; times?: number }[] = []) {}
  async query(text: string, params?: readonly unknown[]): Promise<{ rows: unknown[] }> {
    this.log.push(text.split('\n')[0]!.trim().slice(0, 30));
    for (const f of this.fail) {
      if (text.startsWith(f.on)) throw new Error(`simulated ${f.on} failure`);
    }
    if (text === 'COMMIT' || text === 'ROLLBACK') { this.local = null; return { rows: [] }; }
    if (text.startsWith('SELECT set_config')) { this.local = String(params?.[1] ?? ''); return { rows: [] }; }
    if (text.includes('auth.uid()')) return { rows: [{ uid: this.local }] };
    return { rows: [] };
  }
  release(destroy?: boolean | Error): void {
    this.released = destroy === undefined || destroy === false ? 'normal' : 'destroyed';
  }
}
const poolOf = (client: Client): PgPoolLike => ({
  connect: async () => client, end: async () => undefined,
});

describe('GAP 3 — a dirty connection is never returned to the pool', () => {
  const subject = () => mintSubjectForTests(USER_A);

  test('work fails, rollback succeeds → NORMAL release', async () => {
    const c = new Client();
    await assert.rejects(() => withAuthenticatedDatabaseSubject(
      poolOf(c), subject(), async () => { throw new Error('work failed'); }));
    assert.ok(c.log.includes('ROLLBACK'));
    assert.equal(c.released, 'normal');
  });

  test('work fails and ROLLBACK FAILS → client DESTROYED', async () => {
    const c = new Client([{ on: 'ROLLBACK' }]);
    await assert.rejects(() => withAuthenticatedDatabaseSubject(
      poolOf(c), subject(), async () => { throw new Error('work failed'); }));
    assert.equal(c.released, 'destroyed',
      'the session may hold an open transaction or a stale SET LOCAL');
  });

  test('the ORIGINAL error survives cleanup noise', async () => {
    const c = new Client([{ on: 'ROLLBACK' }]);
    await assert.rejects(
      () => withAuthenticatedDatabaseSubject(
        poolOf(c), subject(), async () => { throw new Error('work failed'); }),
      /work failed/);
  });

  test('COMMIT failure attempts rollback and releases normally', async () => {
    const c = new Client([{ on: 'COMMIT' }]);
    await assert.rejects(() => withAuthenticatedDatabaseSubject(
      poolOf(c), subject(), async () => 'value'));
    assert.ok(c.log.includes('ROLLBACK'), 'cleanup attempted after a failed COMMIT');
    assert.equal(c.released, 'normal');
  });

  test('COMMIT fails AND rollback fails → client DESTROYED', async () => {
    const c = new Client([{ on: 'COMMIT' }, { on: 'ROLLBACK' }]);
    await assert.rejects(() => withAuthenticatedDatabaseSubject(
      poolOf(c), subject(), async () => 'value'));
    assert.equal(c.released, 'destroyed');
  });
});

describe('PRODUCTION COMPOSITION — credentials stay at the IO edge', () => {
  const pool = readFileSync(repoPath('packages', 'postgres-driver', 'src', 'pool.ts'), 'utf8');

  test('the application pool consumes RuntimeConfig.database.appUrl', () => {
    assert.match(pool, /createApplicationPool\(appUrl: string\)/);
    assert.match(pool, /connectionString: appUrl/);
    assert.match(pool, /RuntimeConfig\.database\.appUrl/);
  });

  test('the URL is never interpolated into an error or log', () => {
    assert.match(pool, /Never interpolate appUrl into an error/);
    const errors = [...pool.matchAll(/throw new Error\(([^)]*)\)/g)].map((m) => m[1]!);
    for (const e of errors) {
      assert.equal(/appUrl|connectionString|settings\./.test(e), false,
        `error message may leak connection detail: ${e.slice(0, 60)}`);
    }
  });

  test('privilegedUrl is not used by the ordinary application path', () => {
    assert.equal(pool.includes('privilegedUrl'), false);
    const route = readFileSync(repoPath('packages', 'runtime-api', 'src', 'food-log-route.ts'), 'utf8');
    assert.equal(route.includes('privilegedUrl'), false);
    const identity = readFileSync(repoPath('packages', 'postgres-driver', 'src', 'identity.ts'), 'utf8');
    assert.equal(identity.includes('privilegedUrl'), false);
    assert.match(identity, /APPLICATION_ROLE = 'macros_app'/);
  });

  test('submitFoodLog is the single application service', () => {
    assert.equal(typeof submitFoodLog, 'function');
  });
});

describe('MIGRATIONS REMAIN FROZEN', () => {
  test('0001–0005 match the runtime-validated artifact', () => {
    const doc33 = readFileSync(
      repoPath('docs', 'architecture', '33-postgres-validation-harness.md'), 'utf8');
    const dir = repoPath('db', 'migrations');
    for (const f of readdirSync(dir)) {
      const digest = createHash('sha256').update(readFileSync(join(dir, f))).digest('hex').slice(0, 16);
      assert.ok(doc33.includes(digest), `${f} drifted from the frozen foundation`);
    }
  });
});

describe('GAP 2 — RT-8 settles through the REAL HTTP path', () => {
  const runner = readFileSync(
    repoPath('tools', 'postgres-integration', 'run-integration.ts'), 'utf8');

  test('the runner starts the REAL MacrosApi with the real route', () => {
    assert.match(runner, /new MacrosApi\(/);
    assert.match(runner, /api\.route\(foodLogRoute\(\{ pool \}\)\)/);
    assert.match(runner, /api\.createServer\(\)/);
  });

  test('RT-8 submits over HTTP, not straight into the repository', () => {
    const rt8 = runner.slice(runner.indexOf('RT-8 — REAL HTTP'));
    assert.match(rt8, /await post\(url, started\.tokenA/);
    assert.match(rt8, /dueForSubmission\(recovered/, 'the outbox state machine must be exercised');
    assert.match(rt8, /replayed_existing/);
    assert.match(rt8, /settled\.state === 'acked'/);
    assert.match(rt8, /exactly 1 row after HTTP crash \+ retry/);
    // The OUTBOX ENTRY drives every send, not a parallel payload variable.
    assert.match(rt8, /foodLog: entry\.payload/);
    assert.match(rt8, /const retryEntry = due\[0\]!/);
    assert.match(rt8, /foodLog: retryEntry\.payload/);
  });

  test('authentication machinery is real even though the provider is fake', () => {
    assert.match(runner, /FakeAuthSessionProvider/);
    assert.equal(runner.includes('mintSubjectForTests('), true,
      'test identities are minted for the repository-level proofs');
    // Every SUBMISSION in the RT-8 block goes through post(); a minted subject
    // appears only in verification reads, never to authenticate a write.
    const rt8 = runner.slice(runner.indexOf('RT-8 — REAL HTTP'),
                             runner.indexOf('HTTP AUTHORIZATION'));
    for (const submit of ['const first =', 'const retry =', 'const conflict =']) {
      const line = rt8.slice(rt8.indexOf(submit), rt8.indexOf(submit) + 120);
      assert.match(line, /await post\(/, `${submit} must submit over HTTP`);
    }
    assert.match(runner, /authorization: `Bearer \$\{token\}`/);
    // startApi builds its subject from the Bearer session, not a mint.
    // Comments explain the ABSENCE of a mint; strip them before checking.
    const startApi = runner
      .slice(runner.indexOf('async function startApi'))
      .slice(0, 2000)
      .replace(/^\s*(\/\/|\*|\/\*).*$/gm, '');
    assert.equal(/mintSubjectForTests/.test(startApi), false,
      'the server must derive the subject from the verified session');
  });

  test('adversarial HTTP cases are asserted', () => {
    for (const probe of ['no Bearer token -> 401', "A's token cannot write B's log -> 403",
                         'ZERO forged rows written', 'malformed payload -> 400',
                         'errors leak no SQL, stack, URL or credential']) {
      assert.ok(runner.includes(probe), `missing HTTP probe: ${probe}`);
    }
  });

  test('no unsafe cast turns an HTTP outcome into a SubmissionResult', () => {
    // The comment explaining the old defect must not trip the check.
    const code = runner.replace(/^\s*(\/\/|\*|\/\*).*$/gm, '');
    assert.equal(/body\['outcome'\] as never/.test(code), false,
      'an undefined outcome must never be castable into a SubmissionResult');
    assert.match(runner, /function decodeAcceptedFoodLogResponse/);
    assert.match(runner, /return \{ kind: 'accepted', outcome \};/,
      'built by narrowing, not by cast');
  });

  test('the decoder binds the response to the expected logId', () => {
    const dec = runner.slice(runner.indexOf('function decodeAcceptedFoodLogResponse'),
                             runner.indexOf('/** Start the REAL MacrosApi'));
    assert.match(dec, /response\.status !== 200/);
    assert.match(dec, /Array\.isArray\(body\)/);
    assert.match(dec, /unknown outcome/);
    assert.match(dec, /logId !== expectedLogId/);
    for (const thrown of ['unexpected HTTP status', 'missing outcome', 'missing logId']) {
      assert.ok(dec.includes(thrown), `decoder must reject: ${thrown}`);
    }
  });

  test('a failed HTTP response cannot continue to ACK', () => {
    const rt8 = runner.slice(runner.indexOf("section('RT-8"),
                             runner.indexOf('HTTP AUTHORIZATION'));
    // Each stage throws on an unexpected outcome rather than falling through.
    for (const guard of ['first submission returned', 'retry returned', 'conflict returned']) {
      assert.ok(rt8.includes(guard), `missing fail-fast guard: ${guard}`);
    }
  });

  test('the conflict response settles its OWN entry', () => {
    const rt8 = runner.slice(runner.indexOf("section('RT-8"));
    assert.match(rt8, /const conflictEntry: OutboxEntry = \{/);
    assert.match(rt8, /sequence: 2/);
    assert.match(rt8, /applyResult\(conflictEntry, conflict/);
    assert.match(rt8, /canonical === 250/);
  });

  test('post() does not claim an unvalidated body shape', () => {
    assert.match(runner, /Promise<\{ status: number; body: unknown \}>/);
  });

  test('the 32-session repository concurrency proof is retained', () => {
    assert.match(runner, /counts\['appended'\] === 1/);
    assert.match(runner, /counts\['replayed_existing'\] === 31/);
    assert.match(runner, /PostgresFoodLogRepository\(sql\)\.append\(item\)/);
  });
});

describe('FIX 5 — RT-8 evidence is single and complete', () => {
  const runner = readFileSync(
    repoPath('tools', 'postgres-integration', 'run-integration.ts'), 'utf8');

  test('the repository-only RT-8 block is gone', () => {
    // The HTTP path supersedes it; duplicate evidence invites divergence.
    assert.equal(runner.includes('OFFLINE OUTBOX SETTLEMENT'), false);
    assert.equal((runner.match(/section\('RT-8/g) ?? []).length, 1,
      'exactly one RT-8 section');
  });

  test('RT-8 exercises the full outbox state machine', () => {
    const rt8 = runner.slice(runner.indexOf("section('RT-8"));
    for (const step of ['recoverInFlight', 'dueForSubmission', 'applyResult',
                        "settled.state === 'acked'"]) {
      assert.ok(rt8.includes(step), `missing state-machine step: ${step}`);
    }
  });

  test('pool reuse is FORCED, not assumed', () => {
    // With max=40 the isolation claim would rest on pg's reuse strategy.
    assert.match(runner, /max: 1 \}\)/);
    assert.match(runner, /pg_backend_pid/);
    assert.match(runner, /pidA === b\.pid/);
  });

  test('fixtures use the production factory, not hand-built snapshots', () => {
    assert.match(runner, /createFoodLogItem\(\{/);
    assert.equal(runner.includes('as unknown as FoodLogItem'), false);
    assert.equal(/nutritionSnapshot: \{/.test(runner), false,
      'no hand-fabricated NutritionSnapshot');
    assert.equal(/mealId: null/.test(runner), false, 'mealId must not be supplied');
    assert.match(runner, /validateUserProfile\(profileFixture\)/);
  });

  test('conflicting payloads differ realistically', () => {
    assert.match(runner, /logFor\(USER_A, raceLog, 101\)/);
    assert.equal(/, 777\)|, 888\)|, 999\)/.test(runner), false);
  });

  test('MacrosApi is constructed against the real type', () => {
    assert.match(runner, /newRequestId: \(\) => randomUUID\(\)/);
    const construction = runner.slice(runner.indexOf('new MacrosApi('),
                                      runner.indexOf('api.route('));
    assert.equal(construction.includes('as never'), false);
  });
});
