import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { repoPath } from '../tools/repo-paths.js';

const read = (...p: string[]): string => readFileSync(repoPath(...p), 'utf8');
const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('AI-2 FINAL — the Android remote path is really activated', () => {
  test('normal development resolves to the synthetic host', () => {
    const selection = read('apps', 'tablet', 'src', 'host-selection.ts');
    assert.match(selection, /HOST_SELECTION = 'synthetic'/);
    // No assistant override, so createDevelopmentHost defaults to synthetic.
    assert.equal(selection.includes("assistant: 'real'"), false);
    assert.equal(selection.includes('apiBaseUrl'), false);
  });

  test('the acceptance variant resolves to the remote host', () => {
    const acceptance = read('apps', 'tablet', 'src', 'host-selection.acceptance.ts');
    assert.match(acceptance, /HOST_SELECTION = 'remote_acceptance'/);
    assert.match(acceptance, /assistant: 'real'/);
    assert.match(acceptance, /apiBaseUrl: ACCEPTANCE_API_BASE_URL/);
    assert.match(acceptance, /bearerToken: acceptanceBearerToken/);
  });

  test('the acceptance URL is the MACROS backend, never a vendor', () => {
    const config = read('apps', 'tablet', 'src', 'acceptance-config.ts');
    assert.match(config, /http:\/\/10\.0\.2\.2:8787/);
    for (const banned of ['anthropic', 'openai', 'x-api-key']) {
      assert.equal(config.toLowerCase().includes(banned), false);
    }
  });

  test('the entry point delegates the choice rather than hard-coding it', () => {
    const entry = read('apps', 'tablet', 'index.js');
    assert.match(entry, /createSelectedHost/);
    // The old entry always built the development host directly, which is why
    // the reported remote flow never reached RemoteGuidanceProvider.
    assert.equal(/createDevelopmentHost\(\{\s*auth:/.test(entry), false);
  });

  test('Metro selects the variant at BUILD time, not in the RN runtime', () => {
    const metro = read('apps', 'tablet', 'metro.config.js');
    assert.match(metro, /process\.env\.MACROS_GUIDANCE_ACCEPTANCE/);
    assert.match(metro, /host-selection\.acceptance/);
    // Comments may explain the mechanism; no RN runtime code may read it.
    for (const f of ['index.js', 'src/host-selection.ts',
                     'src/host-selection.acceptance.ts', 'src/acceptance-config.ts']) {
      const code = stripComments(read('apps', 'tablet', ...f.split('/')));
      assert.equal(code.includes('MACROS_GUIDANCE_ACCEPTANCE'), false,
        `${f} reads the env var at runtime`);
      assert.equal(code.includes('process.env'), false,
        `${f} reads process.env in the React Native runtime`);
    }
  });

  test('both commands exist and neither needs a source edit', () => {
    const pkg = JSON.parse(read('apps', 'tablet', 'package.json')) as {
      scripts: Record<string, string>;
    };
    assert.match(pkg.scripts['android'] ?? '', /run-android/);
    assert.equal(pkg.scripts['android']?.includes('MACROS_GUIDANCE_ACCEPTANCE'), false,
      'normal development must not become remote');
    assert.match(pkg.scripts['android:guidance-acceptance'] ?? '',
      /MACROS_GUIDANCE_ACCEPTANCE=1/);
    assert.match(pkg.scripts['start:guidance-acceptance'] ?? '',
      /MACROS_GUIDANCE_ACCEPTANCE=1/);
  });

  test('the acceptance build stays honestly labelled', () => {
    const acceptance = read('apps', 'tablet', 'src', 'host-selection.acceptance.ts');
    assert.match(acceptance, /developmentNotice: ACCEPTANCE_BANNER/);
    assert.match(read('apps', 'tablet', 'src', 'acceptance-config.ts'),
      /DEVELOPMENT · REMOTE GUIDANCE ACCEPTANCE/);
  });

  test('the host guidance boundary is strongly typed', () => {
    const bootstrap = read('apps', 'tablet', 'src', 'bootstrap.ts');
    assert.match(bootstrap, /readonly guidance\?: GuidanceDeps/);
    assert.equal(/guidance\?: unknown/.test(bootstrap), false);
  });

  test('React components still know nothing about provider choice', () => {
    const screens = read('apps', 'tablet', 'src', 'components', 'screens.tsx');
    for (const banned of ['RemoteGuidanceProvider', 'FakeGuidanceProvider',
                          'assistant', 'host-selection']) {
      assert.equal(screens.includes(banned), false, `screens.tsx references ${banned}`);
    }
  });
});

describe('AI-2 FINAL — Android cleartext is debug-scoped', () => {
  test('the release manifest opens no cleartext', () => {
    const main = read('apps', 'tablet', 'android', 'app', 'src', 'main',
      'AndroidManifest.xml');
    assert.equal(main.includes('usesCleartextTraffic'), false,
      'the release manifest must not permit plain HTTP');
    assert.equal(main.includes('networkSecurityConfig'), false);
  });

  test('debug permits cleartext for local hosts ONLY', () => {
    const policy = read('apps', 'tablet', 'android', 'app', 'src', 'debug',
      'res', 'xml', 'network_security.xml');
    // A blanket allow would follow the build into habit and then into release.
    assert.match(policy, /<base-config cleartextTrafficPermitted="false" \/>/);
    assert.match(policy, /10\.0\.2\.2/);
    assert.match(policy, /127\.0\.0\.1/);
    // Only the three local hosts may be listed; anything else would widen the
    // exemption beyond the developer's own machine.
    const domains = [...policy.matchAll(/<domain[^>]*>([^<]+)<\/domain>/g)]
      .map((m) => m[1]!.trim());
    assert.deepEqual(domains.sort(), ['10.0.2.2', '127.0.0.1', 'localhost']);

    const debugManifest = read('apps', 'tablet', 'android', 'app', 'src', 'debug',
      'AndroidManifest.xml');
    assert.match(debugManifest, /networkSecurityConfig="@xml\/network_security"/);
  });

  test('hydration preserves the debug policy', () => {
    const script = read('tools', 'hydrate-android-shell.mjs');
    assert.match(script, /android\/app\/src\/debug\/AndroidManifest\.xml/);
    assert.match(script, /network_security\.xml/);
  });
});

describe('AI-2 FINAL — the acceptance backend is real', () => {
  const backend = () => read('tools', 'guidance-acceptance', 'run-backend.ts');

  test('it uses the PostgreSQL admission, not in-memory', () => {
    const code = stripComments(backend());
    assert.match(code, /new PostgresGuidanceAdmission\(/);
    assert.equal(code.includes('InMemoryGuidanceAdmission'), false,
      'the acceptance run must exercise the distributed guard');
  });

  test('a missing migration fails startup rather than degrading', () => {
    const code = backend();
    assert.match(code, /guidance_admission table is absent/);
    assert.match(code, /throw new Error\(/);
  });

  test('the vendor transport stays fake and no vendor host appears', () => {
    const code = backend();
    assert.match(code, /fakeVendorFetch/);
    assert.equal(code.includes('api.anthropic.com'), false);
  });

  test('no credential is printed', () => {
    const code = backend();
    const output = code.slice(code.indexOf('server.listen'));
    assert.equal(output.includes('ACCEPTANCE_TOKEN'), false,
      'a credential in terminal output is a credential in a screenshot');
    assert.match(code, /credentials       : not printed/);
  });

  test('it binds for emulator access and refuses another database', () => {
    const code = backend();
    assert.match(code, /server\.listen\(PORT, '0\.0\.0\.0'/);
    assert.match(code, /const DATABASE = 'macros_dev'/);
  });

  test('the backend command exists', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    assert.match(pkg.scripts['guidance:acceptance:backend'] ?? '', /run-backend/);
  });
});

describe('AI-2 FINAL — migration harness and 0006', () => {
  test('the ledger count is derived, not hard-coded', () => {
    const runner = read('tools', 'postgres-validation', 'run.sh');
    assert.match(runner, /EXPECTED_MIGRATIONS=\$\(find/);
    // A literal broke when 0006 arrived and would break again at 0007.
    assert.equal(/expect 5\)/.test(runner), false);
    assert.equal(/"\$LEDGER" = "5"/.test(runner), false);
  });

  test('0006 carries its exact checksum in the architecture record', async () => {
    const { createHash } = await import('node:crypto');
    const digest = createHash('sha256')
      .update(readFileSync(repoPath('db', 'migrations', '0006_guidance_admission.sql')))
      .digest('hex').slice(0, 16);
    const doc = read('docs', 'architecture', '33-postgres-validation-harness.md');
    assert.ok(doc.includes(digest), `0006 checksum ${digest} is not recorded`);
  });

  test('0006 is recorded as pending with the command that promotes it', () => {
    const doc = read('docs', 'architecture', '33-postgres-validation-harness.md');
    assert.match(doc, /runtime status: pending owner execution/);
    // Phrased so a successful run promotes the same checksum without a code edit.
    assert.match(doc, /postgres:guidance-validate/);
  });

  test('the owner never applies 0006 by hand', () => {
    const doc = read('docs', 'architecture', '33-postgres-validation-harness.md');
    assert.equal(/psql .*-f db\/migrations\/0006/.test(doc), false,
      'the migration runner owns migration and ledger atomically');
  });
});

describe('AI-2 FINAL — admission policy honesty', () => {
  test('no unimplemented concurrency knob is exposed', () => {
    const code = read('packages', 'runtime-api', 'src', 'guidance-admission.ts');
    assert.equal(code.includes('maxInFlightPerSubject:'), false,
      'the schema holds one lease; a knob above 1 would be silently ignored');
    assert.match(code, /no `maxInFlightPerSubject`/);
  });

  test('the in-memory TTL does not masquerade as durable behaviour', () => {
    const code = read('packages', 'runtime-api', 'src', 'guidance-admission.ts');
    assert.match(code, /inMemoryEntryTtlMs/);
    assert.match(code, /IN-MEMORY ONLY/);
    assert.match(code, /bounded row per authenticated subject/);
  });

  test('quota counts admitted calls, never refusals', () => {
    const pg = read('packages', 'persistence', 'src', 'guidance-admission-postgres.ts');
    // The statement only writes when the WHERE admits, so a refusal cannot
    // move the counter at all.
    assert.match(pg, /window_request_count = CASE/);
    assert.match(pg, /THEN 1 ELSE a\.window_request_count \+ 1 END/);
    assert.equal(/window_request_count[^\n]*refus/i.test(pg), false);
  });

  test('acquire is atomic, not read-then-write', () => {
    const pg = read('packages', 'persistence', 'src', 'guidance-admission-postgres.ts');
    assert.match(pg, /POSTGRESQL IS THE SERIALIZATION POINT/);
    assert.match(pg, /ON CONFLICT \(subject_id\) DO UPDATE/);
  });

  test('persistence does not import the server package', () => {
    // The tablet imports persistence; a runtime-api import would drag node:http
    // into the React Native graph.
    const code = stripComments(
      read('packages', 'persistence', 'src', 'guidance-admission-postgres.ts'));
    assert.equal(code.includes('@macros/runtime-api'), false);
  });
});

describe('AI-2 FINAL — the real PostgreSQL harness', () => {
  const harness = () =>
    read('tools', 'postgres-validation', 'validate-guidance-admission.ts');

  test('it refuses any database but macros_dev', () => {
    assert.match(harness(), /const DATABASE = 'macros_dev'/);
    assert.match(harness(), /refusing to run against/);
  });

  test('it uses TWO independent connections', () => {
    const code = harness();
    assert.match(code, /const clientA = await pool\.connect\(\)/);
    assert.match(code, /const clientB = await pool\.connect\(\)/);
    // Issued together so the database decides the winner, not the test.
    assert.match(code, /Promise\.all\(\[a\.acquire\(SUBJECT_X\), b\.acquire\(SUBJECT_X\)\]\)/);
  });

  test('the fresh-row race is exercised repeatedly with persisted proof', () => {
    // A subject with no row is where compute-then-insert breaks; one lucky
    // interleaving must not be able to pass.
    const code = harness();
    assert.match(code, /FRESH-ROW RACE/);
    assert.match(code, /const ITERATIONS = 25/);
    assert.match(code, /persistedCount !== 1/);
    assert.match(code, /persistedLease !== winner\.lease\.leaseId/);
  });

  test('it covers every required real-database case', () => {
    const code = harness();
    for (const marker of ['CONCURRENCY ON AN EXISTING ROW', 'RELEASE',
                          'LEASE EXPIRY', 'LATE RELEASE CANNOT CLEAR A NEWER LEASE',
                          'RELEASE IS IDEMPOTENT', 'SUBJECT ISOLATION',
                          'QUOTA SEMANTICS', 'WINDOW RESET']) {
      assert.ok(code.includes(marker), `missing case: ${marker}`);
    }
  });

  test('it proves RLS and server authority', () => {
    const code = harness();
    assert.match(code, /relforcerowsecurity/);
    assert.match(code, /pg_policies/);
    assert.match(code, /SET LOCAL ROLE macros_app/);
    for (const verb of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
      assert.ok(code.includes(verb), `no ${verb} probe`);
    }
  });

  test('it cleans up its own subjects', () => {
    const code = harness();
    assert.match(code, /DELETE FROM guidance_admission WHERE subject_id = ANY/);
    assert.match(code, /await reset\(\)\.catch/);
  });

  test('the command exists', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    assert.match(pkg.scripts['postgres:guidance-validate'] ?? '',
      /validate-guidance-admission/);
  });
});

describe('AI-2 FINAL — network trust boundaries', () => {
  test('no decoder asserts a whole untrusted object', () => {
    // A whole-object assertion claims correctness for fields nobody checked,
    // and keeps claiming it after the contract grows.
    for (const [pkg, file] of [
      ['guidance-remote', 'index.ts'],
      ['runtime-api', 'guidance-route.ts'],
      ['guidance-anthropic', 'decode.ts'],
    ] as const) {
      const code = stripComments(read('packages', pkg, 'src', file));
      for (const cheat of ['as unknown as GuidanceRequest',
                           'as unknown as GuidanceProviderResult',
                           'return raw as', 'return body as']) {
        assert.equal(code.includes(cheat), false, `${file} uses ${cheat}`);
      }
    }
  });

  test('the backend decoder checks closed vocabularies as closed', () => {
    const route = read('packages', 'runtime-api', 'src', 'guidance-route.ts');
    for (const set of ['VALID_PLANNER_STATUSES', 'VALID_OBJECTIVES',
                       'VALID_ROLES', 'VALID_ACTIONABILITY', 'VALID_INTENTS']) {
      assert.ok(route.includes(set), `missing closed vocabulary: ${set}`);
    }
    // Open catalog strings stay bounded, never rewritten — a sanitised food
    // name would misreport the catalog.
    assert.match(route, /boundedString\(v\['displayName'\], GUIDANCE_LIMITS\.maxNameLength\)/);
  });

  test('trusted objects are built field by field', () => {
    assert.match(read('packages', 'runtime-api', 'src', 'guidance-route.ts'),
      /const envelopeOut: GuidanceRequest\['envelope'\] = \{/);
    assert.match(read('packages', 'guidance-anthropic', 'src', 'decode.ts'),
      /intent: o\['intent'\] as GuidanceProviderResult\['intent'\]/);
  });

  test('semantic authority stays with INT-5B', () => {
    const anthropic = read('packages', 'guidance-anthropic', 'src', 'index.ts');
    assert.match(anthropic, /INT-5B validator remains\s+\*?\s*the authority/);
    const remote = read('packages', 'guidance-remote', 'src', 'index.ts');
    assert.match(remote, /single authority/);
  });

  test('the tablet graph carries no vendor or server knowledge', () => {
    for (const f of ['src/acceptance-config.ts', 'src/host-selection.ts',
                     'src/host-selection.acceptance.ts', 'src/development-host.ts',
                     'index.js']) {
      const code = stripComments(read('apps', 'tablet', ...f.split('/')));
      for (const banned of ['anthropic', 'x-api-key', 'apiKey', 'providerApiKey',
                            '@macros/guidance-anthropic', 'node:http']) {
        assert.equal(code.toLowerCase().includes(banned.toLowerCase()), false,
          `${f} references ${banned}`);
      }
    }
  });
});

describe('AI-2 FINAL FIX — PostgreSQL is the serialization point', () => {
  const pg = () => read('packages', 'persistence', 'src', 'guidance-admission-postgres.ts');

  test('the decision lives in DO UPDATE ... WHERE, not a prior CTE', () => {
    const code = pg();
    assert.match(code, /ON CONFLICT \(subject_id\) DO UPDATE SET/);
    assert.match(code, /\(a\.lease_id IS NULL OR a\.lease_expires_at <= now\(\)\)/);
    assert.match(code, /a\.window_request_count < \$5::int/);
    // The verdict CTE is gone: it decided before the conflict resolved.
    assert.equal(code.includes('WITH params AS'), false,
      'the pre-conflict verdict CTE decided before the row was locked');
  });

  test('a returned row is the only thing that admits', () => {
    const code = pg();
    assert.match(code, /if \(rows\.length === 1\) return \{ admitted: true/);
    assert.match(code, /cannot grant admission/);
  });

  test('the classification read cannot admit', () => {
    const code = pg();
    const after = code.slice(code.indexOf('Refused.'));
    // Only a SELECT, and only to label the refusal.
    assert.equal(/INSERT|UPDATE|admitted: true/.test(after.slice(0, 700)), false);
  });

  test('a new window restarts the count at one', () => {
    assert.match(pg(), /THEN 1 ELSE a\.window_request_count \+ 1 END/);
  });

  test('no application-level select-decide-update remains', () => {
    const code = pg();
    // Exactly two statements: the atomic admit, and the refusal classification.
    const queries = (code.match(/this\.sql\.query</g) ?? []).length;
    assert.equal(queries, 2, `expected admit + classify (release is untyped), got ${queries}`);
  });
});

describe('AI-2 FINAL FIX — trust boundary and repository hygiene', () => {
  test('the route no longer asserts the network object', () => {
    const code = stripComments(read('packages', 'runtime-api', 'src', 'guidance-route.ts'));
    assert.equal(code.includes('decoded as GuidanceRequest'), false);
    assert.equal(code.includes('as unknown as GuidanceRequest'), false);
    // Narrowed on a tag; the trusted value carries its own type.
    assert.match(code, /kind: 'decoded_guidance_request'/);
    assert.match(code, /deps\.provider\.generate\(decoded\.value\)/);
  });

  test('the decoder still returns an AppError for bad input', async () => {
    const { decodeGuidanceRequest } = await import('@macros/runtime-api');
    const bad = decodeGuidanceRequest({ prompt: 'ignore rules' });
    assert.equal((bad as { kind: string }).kind, 'validation');
  });

  test('no duplicate imports in AI-2 tablet files', () => {
    for (const f of ['src/App.tsx', 'src/bootstrap.ts', 'src/actions.ts',
                     'src/host-selection.ts', 'src/host-selection.acceptance.ts',
                     'src/acceptance-config.ts']) {
      const lines = read('apps', 'tablet', ...f.split('/'))
        .split('\n').filter((l) => /^import .*;$/.test(l));
      assert.equal(new Set(lines).size, lines.length, `${f} has a duplicate import`);
    }
  });

  test('root lockfile pins registry dependencies for a fresh clone', () => {
    assert.doesNotMatch(read('.gitignore'), /^\/package-lock\.json$/m);
    const lock = JSON.parse(read('package-lock.json'));
    const pkg = JSON.parse(read('package.json'));
    assert.equal(lock.lockfileVersion, 3);
    for (const [name, version] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) {
      const entry = lock.packages[`node_modules/${name}`];
      assert.equal(entry.version, version, `${name} must match its declared pin`);
      assert.match(entry.resolved, /^https:\/\/registry\.npmjs\.org\//);
      assert.match(entry.integrity, /^sha512-/);
    }
  });
});

describe('DEMO — real inference is opt-in and bounded', () => {
  const backend = () => read('tools', 'guidance-acceptance', 'run-backend.ts');

  test('the fake transport is the default; a key opts in', () => {
    const code = stripComments(backend());
    assert.match(code, /const live = apiKey !== undefined && apiKey\.length > 0/);
    assert.match(code, /live\s*\?\s*createServerGuidanceProvider/);
    // Without a key an ordinary run cannot bill.
    assert.match(code, /fetchImpl: fakeVendorFetch as never/);
  });

  test('the model is configurable, never baked in', () => {
    assert.match(backend(), /process\.env\['MACROS_GUIDANCE_MODEL'\]/);
  });

  test('the demo profile is conservative', async () => {
    const { DEMO_MAX_TOKENS, DEMO_TIMEOUT_MS, demoProviderSettings } =
      await import('@macros/guidance-anthropic');
    // The model only picks a template and a few ids; a large ceiling would buy
    // nothing but exposure during a live demonstration.
    assert.ok(DEMO_MAX_TOKENS <= 512);
    assert.ok(DEMO_TIMEOUT_MS <= 8000);
    const s = demoProviderSettings('sk-test-DO-NOT-LEAK-123', 'some-model');
    assert.equal(s.maxTokens, DEMO_MAX_TOKENS);
    assert.equal(s.timeoutMs, DEMO_TIMEOUT_MS);
  });

  test('the demo profile reads no secret itself', () => {
    const code = read('packages', 'guidance-anthropic', 'src', 'demo-profile.ts');
    assert.equal(code.includes('process.env'), false);
  });

  test('the key never reaches the tablet', () => {
    for (const f of ['src/acceptance-config.ts', 'src/development-host.ts',
                     'src/host-selection.acceptance.ts']) {
      const code = read('apps', 'tablet', ...f.split('/'));
      for (const banned of ['ANTHROPIC_API_KEY', 'anthropic', 'x-api-key']) {
        assert.equal(code.toLowerCase().includes(banned.toLowerCase()), false,
          `${f} references ${banned}`);
      }
    }
  });

  test('one request stays one billable call', () => {
    const anthropic = read('packages', 'guidance-anthropic', 'src', 'index.ts');
    assert.equal((anthropic.match(/transport\.send\(/g) ?? []).length, 1);
    assert.equal(/retry|backoff/i.test(anthropic), false);
  });
});
