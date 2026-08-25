import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import {
  CAPABILITY_MATRIX, FakeAuthSessionProvider, MemoryLogSink, MemoryTimingRecorder,
  PERFORMANCE_BUDGETS, StructuredLogger, allowsSyntheticProviders,
  appError, assertImplementationAllowed, checksumOf, computeHealth, fromUnknown,
  loadRuntimeConfig, orderMigrations, planComposition, redactConfig, runMigrations,
  subjectFromSession, subjectRef, toWireError,
  type AppliedMigration, type MigrationDriver, type MigrationFile, type RuntimeConfig,
  type VersionManifest,
} from '@macros/runtime-config';
import { MacrosApi, validateBody } from '@macros/runtime-api';

const ROOT = new URL('..', import.meta.url).pathname;
const USER = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-000000000002';

const baseRaw = {
  environment: 'production',
  appVersion: '1.0.0',
  apiVersion: 'macros-api@1.0.0',
  expectedSchemaVersion: '0004',
  databaseAppUrl: 'postgres://app:secret@db/macros',
  auth: 'real', assistant: 'real', scale: 'real', activity: 'real', catalog: 'real',
  logLevel: 'info',
  maxRequestBytes: 65536,
};
const okConfig = (over: Record<string, unknown> = {}): RuntimeConfig => {
  const r = loadRuntimeConfig({ ...baseRaw, ...over });
  assert.equal(r.ok, true);
  if (!r.ok) throw new Error('config invalid');
  return r.config;
};

// ---------------------------------------------------------------------------

describe('B5/B6 — production refuses synthetic providers', () => {
  for (const field of ['auth', 'assistant', 'scale', 'activity', 'catalog']) {
    test(`synthetic ${field} fails production startup`, () => {
      const r = loadRuntimeConfig({ ...baseRaw, [field]: 'synthetic' });
      assert.equal(r.ok, false);
      if (r.ok) return;
      assert.ok(r.violations.some((v) => v.field === field && /forbidden/.test(v.problem)));
    });

    test(`synthetic ${field} is allowed in development`, () => {
      const r = loadRuntimeConfig({ ...baseRaw, environment: 'development', [field]: 'synthetic' });
      assert.equal(r.ok, true);
    });
  }

  test('staging is treated as production for synthetic guards', () => {
    assert.equal(allowsSyntheticProviders('staging'), false);
    const r = loadRuntimeConfig({ ...baseRaw, environment: 'staging', assistant: 'synthetic' });
    assert.equal(r.ok, false);
  });

  test('the composition plan refuses a synthetic production component', () => {
    // Bypass config validation to prove the SECOND, independent guard works.
    const forced = { ...okConfig(), assistant: 'synthetic' } as RuntimeConfig;
    const plan = planComposition(forced);
    assert.ok('kind' in plan);
    if ('kind' in plan) assert.equal(plan.code, 'synthetic_provider_in_production');
  });

  test('construction-time guard catches a miswired factory', () => {
    // Config says 'real' but the factory returned a simulator anyway.
    for (const name of ['DevScaleAdapter', 'FakeAssistantInterpreter', 'InMemoryFoodLogRepository']) {
      const err = assertImplementationAllowed('production', name);
      assert.notEqual(err, null, `${name} must be refused`);
    }
    assert.equal(assertImplementationAllowed('production', 'BleScaleAdapter'), null);
    assert.equal(assertImplementationAllowed('test', 'DevScaleAdapter'), null);
  });

  test('debug logging is forbidden in production', () => {
    const r = loadRuntimeConfig({ ...baseRaw, logLevel: 'debug' });
    assert.equal(r.ok, false);
  });

  test('an unknown environment is refused outright', () => {
    const r = loadRuntimeConfig({ ...baseRaw, environment: 'prod' });
    assert.equal(r.ok, false);
  });

  test('missing required production config fails fast', () => {
    const { databaseAppUrl, ...without } = baseRaw;
    void databaseAppUrl;
    const r = loadRuntimeConfig(without);
    assert.equal(r.ok, false);
    if (!r.ok) assert.ok(r.violations.some((v) => v.field === 'databaseAppUrl'));
  });
});

describe('B7 — secrets never surface', () => {
  test('redaction hides connection strings and keys', () => {
    const red = redactConfig({
      databaseAppUrl: 'postgres://app:hunter2@db/macros',
      providerApiKey: 'sk-live-abc',
      nested: { servicePassword: 'p', environment: 'production' },
      environment: 'production',
    });
    const text = JSON.stringify(red);
    assert.ok(!text.includes('hunter2'));
    assert.ok(!text.includes('sk-live-abc'));
    assert.equal(red['environment'], 'production', 'non-secrets survive');
  });

  test('config validation errors never echo a secret value', () => {
    const r = loadRuntimeConfig({ ...baseRaw, assistant: 'synthetic' });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.ok(!JSON.stringify(r.violations).includes('secret'));
  });

  test('no package source hardcodes a credential', () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.name === 'node_modules') continue;
        const p = join(dir, e.name);
        if (e.isDirectory()) { walk(p); continue; }
        if (!e.name.endsWith('.ts')) continue;
        const src = readFileSync(p, 'utf8');
        if (/(sk-live|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY)/.test(src)) offenders.push(p);
      }
    };
    walk(join(ROOT, 'packages'));
    assert.deepEqual(offenders, []);
  });

  test('domain and application packages never read process.env', () => {
    const offenders: string[] = [];
    for (const pkg of readdirSync(join(ROOT, 'packages'))) {
      if (pkg.startsWith('runtime-')) continue; // the edge is allowed
      const dir = join(ROOT, 'packages', pkg, 'src');
      let files: string[] = [];
      try { files = readdirSync(dir); } catch { continue; }
      for (const f of files) {
        if (!f.endsWith('.ts')) continue;
        const src = readFileSync(join(dir, f), 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        if (/process\.env/.test(src)) offenders.push(`${pkg}/${f}`);
      }
    }
    assert.deepEqual(offenders, [], 'config belongs at the composition root');
  });
});

describe('B12 — auth binding', () => {
  const session = (over: Record<string, unknown> = {}) => ({
    subjectId: USER,
    issuedAt: '2026-08-22T10:00:00.000Z',
    expiresAt: '2026-08-22T18:00:00.000Z',
    ...over,
  });
  const NOW = '2026-08-22T12:00:00.000Z';

  test('a valid session binds all three identities', () => {
    const r = subjectFromSession(session(), NOW);
    assert.ok(!('kind' in r));
    if ('kind' in r) return;
    assert.equal(r.userId, USER);
    assert.equal(r.authenticatedSubjectId, USER);
  });

  test('a client claiming ANOTHER user is refused', () => {
    const r = subjectFromSession(session(), NOW, OTHER);
    assert.ok('kind' in r);
    if ('kind' in r) assert.equal(r.code, 'subject_mismatch');
  });

  test('a client claiming its OWN id is accepted', () => {
    const r = subjectFromSession(session(), NOW, USER);
    assert.ok(!('kind' in r));
  });

  test('an expired session is refused', () => {
    const r = subjectFromSession(session(), '2026-08-23T00:00:00.000Z');
    assert.ok('kind' in r);
    if ('kind' in r) assert.equal(r.code, 'session_expired');
  });

  test('a non-UUID subject is refused', () => {
    const r = subjectFromSession(session({ subjectId: 'admin' }), NOW);
    assert.ok('kind' in r);
    if ('kind' in r) assert.equal(r.code, 'invalid_subject');
  });
});

describe('B9 — migration runner', () => {
  class FakeDriver implements MigrationDriver {
    applied: AppliedMigration[] = [];
    readonly executed: string[] = [];
    failOn: string | null = null;
    constructor(seed: AppliedMigration[] = []) { this.applied = seed; }
    ensureTrackingTable(): Promise<void> { return Promise.resolve(); }
    listApplied(): Promise<readonly AppliedMigration[]> { return Promise.resolve(this.applied); }
    applyInTransaction(file: MigrationFile, checksum: string): Promise<void> {
      if (this.failOn === file.name) return Promise.reject(new Error('DDL failed'));
      this.executed.push(file.name);
      this.applied.push({ name: file.name, checksum, appliedAt: 'now', succeeded: true });
      return Promise.resolve();
    }
  }
  const files: MigrationFile[] = [
    { name: '0001_core.sql', sql: 'CREATE TABLE a();' },
    { name: '0002_energy.sql', sql: 'CREATE TABLE b();' },
    { name: '0003_catalog.sql', sql: 'CREATE TABLE c();' },
    { name: '0004_corrections.sql', sql: 'CREATE TABLE d();' },
  ];

  test('migrations run in numeric order regardless of input order', () => {
    const shuffled = [files[2]!, files[0]!, files[3]!, files[1]!];
    assert.deepEqual(orderMigrations(shuffled).map((f) => f.name), files.map((f) => f.name));
  });

  test('a clean database applies everything once', async () => {
    const d = new FakeDriver();
    const r = await runMigrations(files, d);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.deepEqual(r.applied, files.map((f) => f.name));
  });

  test('re-running is idempotent', async () => {
    const d = new FakeDriver();
    await runMigrations(files, d);
    const second = await runMigrations(files, d);
    assert.equal(second.ok, true);
    if (!second.ok) return;
    assert.deepEqual(second.applied, [], 'nothing re-applied');
    assert.equal(d.executed.length, files.length);
  });

  test('an edited applied migration is detected by checksum', async () => {
    const d = new FakeDriver();
    await runMigrations(files, d);
    const tampered = [...files];
    tampered[1] = { name: '0002_energy.sql', sql: 'CREATE TABLE b_but_different();' };
    const r = await runMigrations(tampered, d);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.error.code, 'migration_checksum_mismatch');
  });

  test('a partially applied migration halts the run', async () => {
    const d = new FakeDriver([{ name: '0001_core.sql', checksum: checksumOf(files[0]!.sql), appliedAt: 'x', succeeded: false }]);
    const r = await runMigrations(files, d);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.error.code, 'migration_partially_applied');
  });

  test('a database ahead of the build is refused', async () => {
    const d = new FakeDriver([{ name: '0009_future.sql', checksum: 'x', appliedAt: 'x', succeeded: true }]);
    const r = await runMigrations(files, d);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.error.code, 'schema_ahead_of_build');
  });

  test('a failing migration stops immediately and does not continue', async () => {
    const d = new FakeDriver();
    d.failOn = '0002_energy.sql';
    const r = await runMigrations(files, d);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.error.code, 'migration_failed');
    assert.deepEqual(d.executed, ['0001_core.sql'], 'later migrations never attempted');
  });

  test('the real repository migrations are ordered and checksummable', () => {
    const dir = join(ROOT, 'db/migrations');
    const real = readdirSync(dir).filter((f) => f.endsWith('.sql'))
      .map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') }));
    assert.ok(real.length >= 4);
    assert.deepEqual(orderMigrations(real).map((f) => f.name), [...real.map((f) => f.name)].sort());
    for (const f of real) assert.match(checksumOf(f.sql), /^[0-9a-f]{8}$/);
  });
});

describe('B16 — error taxonomy never leaks internals', () => {
  test('internalDetail is dropped from the wire form', () => {
    const e = appError('internal', 'boom', 'Something went wrong.', 'SELECT * FROM users WHERE token=abc');
    const wire = toWireError(e, 'req-1');
    const text = JSON.stringify(wire);
    assert.ok(!text.includes('SELECT'));
    assert.ok(!text.includes('token'));
    assert.equal(wire.error.code, 'boom');
  });

  test('an unknown thrown value becomes a safe internal error', () => {
    const e = fromUnknown(new Error('connect ECONNREFUSED postgres://app:pw@db'));
    assert.equal(e.kind, 'internal');
    assert.ok(!JSON.stringify(toWireError(e, 'r')).includes('pw@db'));
  });
});

describe('B17 — observability privacy', () => {
  test('transcripts, nutrition and credentials are stripped by the logger', () => {
    const sink = new MemoryLogSink();
    new StructuredLogger(sink, 'info').log({
      level: 'info', component: 'voice', event: 'handled',
      fields: {
        transcript: 'I ate 200 grams of chicken',
        kcal: 330, proteinG: 62,
        authorization: 'Bearer abc',
        intentKind: 'confirm_log',
      },
    });
    const text = JSON.stringify(sink.records[0]);
    assert.ok(!text.includes('chicken'), 'no raw transcript');
    assert.ok(!text.includes('330'), 'no nutrition');
    assert.ok(!text.includes('Bearer abc'), 'no credential');
    assert.ok(text.includes('confirm_log'), 'safe fields survive');
  });

  test('subject references are pseudonymous and stable', () => {
    const a = subjectRef(USER);
    assert.equal(a, subjectRef(USER), 'stable for correlation');
    assert.notEqual(a, subjectRef(OTHER));
    assert.ok(!a.includes(USER), 'never the raw id');
  });

  test('level filtering suppresses lower levels', () => {
    const sink = new MemoryLogSink();
    const log = new StructuredLogger(sink, 'warn');
    log.log({ level: 'info', component: 'x', event: 'y' });
    log.log({ level: 'error', component: 'x', event: 'z' });
    assert.equal(sink.records.length, 1);
  });
});

describe('B19/B20 — health and readiness', () => {
  test('a healthy runtime is ready', () => {
    const h = computeHealth({ configValid: true, databaseReachable: 'ready', migrationsApplied: true });
    assert.equal(h.ready, true);
  });

  test('migration failure means NOT ready even though the process is alive', () => {
    const h = computeHealth({ configValid: true, databaseReachable: 'ready', migrationsApplied: false });
    assert.equal(h.processAlive, true);
    assert.equal(h.ready, false);
  });

  test('an unreachable database means not ready', () => {
    const h = computeHealth({ configValid: true, databaseReachable: 'unavailable', migrationsApplied: true });
    assert.equal(h.ready, false);
  });

  test('invalid config means not ready', () => {
    const h = computeHealth({ configValid: false, databaseReachable: 'ready', migrationsApplied: true });
    assert.equal(h.ready, false);
  });
});

describe('B15 — runtime input validation', () => {
  const schema = {
    query: { type: 'string', required: true, maxLength: 10 },
    grams: { type: 'number', min: 0.1, max: 5000 },
    userId: { type: 'uuid' },
  } as const;

  test('a valid body passes', () => {
    const r = validateBody({ query: 'oats', grams: 100 }, schema);
    assert.equal(r.ok, true);
  });

  const rejected: readonly [string, unknown][] = [
    ['not an object', 'hello'],
    ['array body', []],
    ['missing required', { grams: 1 }],
    ['unknown field', { query: 'a', injected: 1 }],
    ['wrong type', { query: 123 }],
    ['too long', { query: 'x'.repeat(50) }],
    ['below minimum', { query: 'a', grams: 0 }],
    ['above maximum', { query: 'a', grams: 99999 }],
    ['NaN', { query: 'a', grams: Number.NaN }],
    ['bad uuid', { query: 'a', userId: 'admin' }],
  ];
  for (const [name, body] of rejected) {
    test(`rejects: ${name}`, () => {
      const r = validateBody(body, schema);
      assert.equal(r.ok, false);
    });
  }
});

describe('B14 — real HTTP boundary (executed against a live server)', () => {
  const versions: VersionManifest = {
    appVersion: '1.0.0', apiVersion: 'macros-api@1.0.0', schemaVersion: '0004',
    scaleProtocolVersion: 'scale-protocol@1.0.0', nutritionCalcVersion: 'n@1',
    energyPolicyVersion: 'e@1', voiceParserVersion: 'v@1',
    assistantContractVersion: 'a@1', foodLogFoldVersion: 'f@1',
  };

  async function withServer(
    fn: (base: string, sink: MemoryLogSink) => Promise<void>,
    over: Record<string, unknown> = {},
  ): Promise<void> {
    const sink = new MemoryLogSink();
    const api = new MacrosApi({
      config: okConfig({ environment: 'development', ...over }),
      auth: new FakeAuthSessionProvider({
        'good-token': { subjectId: USER, issuedAt: '2026-08-22T10:00:00.000Z', expiresAt: '2026-08-22T18:00:00.000Z' },
        'expired-token': { subjectId: USER, issuedAt: '2026-08-21T10:00:00.000Z', expiresAt: '2026-08-21T11:00:00.000Z' },
      }),
      logger: new StructuredLogger(sink, 'info'),
      versions,
      now: () => '2026-08-22T12:00:00.000Z',
      health: () => ({ databaseReachable: 'ready', migrationsApplied: true, configValid: true }),
      newRequestId: () => 'req-fixed',
    }).withSystemRoutes();

    api.route({
      method: 'POST', path: '/food/search',
      schema: { query: { type: 'string', required: true, maxLength: 120 }, userId: { type: 'uuid' } },
      handler: (ctx) => Promise.resolve({ user: ctx.userId, query: ctx.body['query'] }),
    });
    api.route({
      method: 'POST', path: '/boom',
      schema: {},
      handler: () => { throw new Error('connect ECONNREFUSED postgres://app:hunter2@db'); },
    });

    const server = api.createServer();
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    try {
      await fn(`http://127.0.0.1:${port}`, sink);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  }

  const post = (base: string, path: string, body: unknown, token?: string) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token !== undefined ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });

  test('health and version are public and secret-free', async () => {
    await withServer(async (base) => {
      const h = await fetch(`${base}/health`);
      assert.equal(h.status, 200);
      const body = await h.json() as Record<string, unknown>;
      assert.equal(body['ready'], true);
      assert.ok(!JSON.stringify(body).includes('postgres://'));

      const v = await fetch(`${base}/version`);
      assert.equal((await v.json() as Record<string, unknown>)['schemaVersion'], '0004');
    });
  });

  test('an authenticated request succeeds and binds the session identity', async () => {
    await withServer(async (base) => {
      const r = await post(base, '/food/search', { query: 'oats' }, 'good-token');
      assert.equal(r.status, 200);
      assert.equal((await r.json() as Record<string, unknown>)['user'], USER);
    });
  });

  test('an unauthenticated request is refused with 401', async () => {
    await withServer(async (base) => {
      const r = await post(base, '/food/search', { query: 'oats' });
      assert.equal(r.status, 401);
    });
  });

  test('an expired session is refused', async () => {
    await withServer(async (base) => {
      const r = await post(base, '/food/search', { query: 'oats' }, 'expired-token');
      assert.equal(r.status, 401);
    });
  });

  test('a client CANNOT act as another user by sending userId', async () => {
    await withServer(async (base) => {
      const r = await post(base, '/food/search', { query: 'oats', userId: OTHER }, 'good-token');
      assert.equal(r.status, 403);
      const body = await r.json() as { error: { code: string } };
      assert.equal(body.error.code, 'subject_mismatch');
    });
  });

  test('an unknown field is rejected before authentication work', async () => {
    await withServer(async (base) => {
      const r = await post(base, '/food/search', { query: 'oats', isAdmin: true }, 'good-token');
      assert.equal(r.status, 400);
    });
  });

  test('malformed JSON is a 400, not a crash', async () => {
    await withServer(async (base) => {
      const r = await fetch(`${base}/food/search`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer good-token' },
        body: '{not json',
      });
      assert.equal(r.status, 400);
    });
  });

  test('an oversized body is refused', async () => {
    await withServer(async (base) => {
      const r = await post(base, '/food/search', { query: 'x'.repeat(3000) }, 'good-token');
      assert.equal(r.status, 400);
    }, { maxRequestBytes: 512 });
  });

  test('an internal exception leaks no SQL, stack or credential', async () => {
    await withServer(async (base, sink) => {
      const r = await post(base, '/boom', {}, 'good-token');
      assert.equal(r.status, 500);
      const text = await r.text();
      assert.ok(!text.includes('hunter2'), 'no credential to the client');
      assert.ok(!text.includes('ECONNREFUSED'), 'no driver detail');
      assert.ok(!text.includes('at '), 'no stack frames');
      // The detail IS retained server-side for diagnosis.
      assert.ok(JSON.stringify(sink.records).includes('ECONNREFUSED'));
    });
  });

  test('an unknown route is a 404', async () => {
    await withServer(async (base) => {
      assert.equal((await fetch(`${base}/nope`)).status, 404);
    });
  });

  test('every response carries a correlation id', async () => {
    await withServer(async (base) => {
      const r = await post(base, '/food/search', { query: 'oats' }, 'good-token');
      assert.equal((await r.json() as Record<string, unknown>)['requestId'], 'req-fixed');
    });
  });

  test('logs record the request without personal content', async () => {
    await withServer(async (base, sink) => {
      await post(base, '/food/search', { query: 'oats' }, 'good-token');
      const text = JSON.stringify(sink.records);
      assert.ok(text.includes('subj_'), 'pseudonymous reference');
      assert.ok(!text.includes(USER), 'never the raw user id');
    });
  });
});

describe('B25/B26/B31 — declared contracts', () => {
  test('offline tiers never promise an unimplemented capability', () => {
    const logWrite = CAPABILITY_MATRIX.find((c) => c.capability === 'food_log_write')!;
    assert.equal(logWrite.tier, 'offline_unavailable');
    assert.match(logWrite.behaviour, /NOT queued/);
    const search = CAPABILITY_MATRIX.find((c) => c.capability === 'food_search')!;
    assert.equal(search.tier, 'offline_unavailable');
  });

  test('activity remains unavailable rather than assumed zero', () => {
    const activity = CAPABILITY_MATRIX.find((c) => c.capability === 'activity')!;
    assert.match(activity.behaviour, /MISSING is never ZERO/);
  });

  test('performance budgets exist for every critical path', () => {
    for (const path of ['food_search', 'dashboard_refresh', 'food_log_confirm', 'voice_deterministic', 'assistant_fallback', 'startup']) {
      assert.ok(PERFORMANCE_BUDGETS.some((b) => b.path === path), path);
    }
  });

  test('the timing recorder is a seam, not a measurement claim', () => {
    const rec = new MemoryTimingRecorder();
    rec.record('food_search', 42, 'ok');
    assert.equal(rec.samples.length, 1);
  });
});
