/**
 * LOCAL GUIDANCE ACCEPTANCE BACKEND — zero cost.
 *
 * A real MacrosApi with real authentication, the real guidance route and the
 * real admission boundary, wired to the real AnthropicGuidanceProvider — whose
 * transport is a FAKE that returns a canned structured tool result.
 *
 * So every MACROS boundary is genuine and only the vendor call is simulated.
 * That is the whole point: the architecture can be exercised from a real
 * Android device without a paid request ever leaving the machine.
 *
 *   node --import tsx tools/guidance-acceptance/run-backend.ts
 */
import { randomUUID } from 'node:crypto';
import {
  DEFAULT_ADMISSION_POLICY, MacrosApi, registerGuidanceRoute,
  type ApiDependencies,
} from '@macros/runtime-api';
import { PostgresGuidanceAdmission } from '@macros/persistence';
import { createPgPool } from '@macros/postgres-driver';
import {
  FakeAuthSessionProvider, StructuredLogger, loadRoleConfig, type RuntimeConfig,
} from '@macros/runtime-config';
import { createServerGuidanceProvider } from '@macros/guidance-anthropic';

/** Any UUID; the acceptance host presents the matching bearer. */
const ACCEPTANCE_SUBJECT = '11111111-1111-4111-8111-111111111111';
/**
 * A deterministic development credential shared with the acceptance host.
 *
 * NEVER printed and never logged. It is not a vendor key, but it gets the same
 * discipline: a credential in terminal output is a credential in a scrollback,
 * a screenshot and a bug report.
 */
const ACCEPTANCE_TOKEN = 'acceptance-session-token';
const PORT = Number(process.env['MACROS_ACCEPTANCE_PORT'] ?? 8787);
/** The harness refuses any other database, as the existing tooling does. */
const DATABASE = 'macros_dev';

/**
 * The FAKE vendor transport. It never reaches the network, and it is the only
 * reason this milestone costs nothing.
 */
const fakeVendorFetch = async (
  _url: string,
  init: { body: string },
): Promise<{ status: number; text(): Promise<string> }> => {
  const request = JSON.parse(init.body) as {
    messages: { content: string }[];
  };
  const payload = JSON.parse(request.messages[0]!.content) as {
    envelope: { planComponents: { productVersionId: string }[]; objectives: string[] };
  };
  const first = payload.envelope.planComponents[0]?.productVersionId;

  // Chooses a template and references a supplied candidate — exactly what a
  // real model is constrained to do.
  const input = first === undefined
    ? { intent: 'clarification_needed', templateId: 'no_suggestion',
        selectedProductVersionIds: [], clarificationNeeded: true,
        suggestedNextAction: 'none' }
    : { intent: 'what_should_i_eat',
        templateId: payload.envelope.objectives.length > 0
          ? 'option_with_objective' : 'single_option',
        selectedProductVersionIds: [first],
        ...(payload.envelope.objectives.length > 0 ? { objectiveIndex: 0 } : {}),
        clarificationNeeded: false, suggestedNextAction: 'await_weight' };

  return {
    status: 200,
    text: async () => JSON.stringify({
      content: [{ type: 'tool_use', name: 'submit_guidance_decision', input }],
    }),
  };
};

async function main(): Promise<void> {
  const loaded = loadRoleConfig('server', {
    environment: 'development',
    appVersion: '1.0.0', apiVersion: 'macros-api@1.0.0', expectedSchemaVersion: '0006',
    databaseAppUrl: 'postgres://localhost/macros_dev',
    auth: 'synthetic', assistant: 'real', scale: 'synthetic',
    activity: 'synthetic', catalog: 'synthetic',
    logLevel: 'info', maxRequestBytes: 65536,
  });
  if (!loaded.ok) throw new Error('acceptance config invalid');

  const provider = createServerGuidanceProvider({
    config: { assistant: 'real' },
    // A recognisable placeholder. No real key is needed because the transport
    // never reaches a vendor.
    providerSettings: {
      apiKey: 'sk-acceptance-NOT-A-REAL-KEY', model: 'acceptance-fake-model',
    },
    fetchImpl: fakeVendorFetch as never,
  });

  const deps: ApiDependencies = {
    config: (loaded as { config: RuntimeConfig }).config,
    auth: new FakeAuthSessionProvider({
      [ACCEPTANCE_TOKEN]: {
        subjectId: ACCEPTANCE_SUBJECT, userId: ACCEPTANCE_SUBJECT,
        sessionId: '99999999-9999-4999-8999-999999999999', issuer: 'acceptance',
        issuedAt: new Date(Date.now() - 60_000).toISOString(),
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      } as never,
    }),
    logger: new StructuredLogger({ write: (e: unknown) => {
      process.stdout.write(`${JSON.stringify(e)}\n`);
    } } as never, 'info'),
    versions: {
      appVersion: '1.0.0', apiVersion: 'macros-api@1.0.0', schemaVersion: '0006',
      scaleProtocolVersion: 's@1', nutritionCalcVersion: 'n@1', energyPolicyVersion: 'e@1',
      voiceParserVersion: 'v@1', assistantContractVersion: 'a@1', foodLogFoldVersion: 'f@1',
    } as never,
    now: () => new Date().toISOString(),
    health: () => ({ databaseReachable: 'ready', migrationsApplied: true, configValid: true }),
    newRequestId: () => randomUUID(),
  };

  /**
   * REAL PostgreSQL admission. The distributed guard is the whole architectural
   * point of AI-2, so an acceptance run quietly using the in-memory one would
   * rehearse the wrong system.
   */
  const pool = await createPgPool({
    host: process.env['PGHOST'] ?? '/tmp',
    port: Number(process.env['PGPORT'] ?? 5432),
    database: DATABASE,
  });

  /**
   * One checked-out client per statement, matching the existing driver
   * convention. The adapter needs only `query`, so the pool is adapted rather
   * than the adapter widened to understand pooling.
   */
  const sql = {
    async query<T = Record<string, unknown>>(
      text: string, values?: readonly unknown[],
    ): Promise<{ rows: T[] }> {
      const client = await pool.connect();
      try {
        const result = await client.query(text, values as unknown[]);
        return { rows: (result as { rows: T[] }).rows };
      } finally {
        client.release();
      }
    },
  };

  const probe = await sql.query<{ present: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
        WHERE table_name = 'guidance_admission'
     ) AS present`);
  if (probe.rows[0]?.present !== true) {
    // Fail loudly rather than degrading to in-memory: a silent downgrade would
    // make the acceptance run prove something other than what it claims.
    throw new Error(
      'guidance_admission table is absent — run `npm run postgres:validate` '
      + 'to apply migration 0006 before starting the acceptance backend');
  }

  const api = new MacrosApi(deps).withSystemRoutes();
  registerGuidanceRoute(api, {
    provider,
    admission: new PostgresGuidanceAdmission(
      sql, DEFAULT_ADMISSION_POLICY, () => randomUUID()),
  });

  const server = api.createServer();
  // 0.0.0.0 so the Android emulator can reach it through 10.0.2.2.
  server.listen(PORT, '0.0.0.0', () => {
    process.stdout.write(
      `guidance acceptance backend on http://0.0.0.0:${PORT}\n`
      + `  emulator base URL : http://10.0.2.2:${PORT}\n`
      + `  database          : ${DATABASE} (real PostgresGuidanceAdmission)\n`
      + '  vendor calls      : NONE (fake transport)\n'
      + '  credentials       : not printed\n');
  });
}

void main();
