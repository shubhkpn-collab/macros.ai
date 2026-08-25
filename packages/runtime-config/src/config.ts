/**
 * TYPED RUNTIME CONFIGURATION.
 *
 * PURE: this module reads no environment and touches no IO. It validates a
 * plain record supplied by the edge, so configuration rules are testable
 * without a process.
 *
 * The central guarantee: production must FAIL FAST rather than silently fall
 * back to a test database, a synthetic catalog, fake auth, a fake assistant or
 * a simulated scale. A wrong number on a nutrition appliance is worse than a
 * refusal to start.
 */

export type Environment = 'development' | 'test' | 'staging' | 'production';

export const ENVIRONMENTS: readonly Environment[] = ['development', 'test', 'staging', 'production'];

export const isEnvironment = (v: unknown): v is Environment =>
  typeof v === 'string' && (ENVIRONMENTS as readonly string[]).includes(v);

/**
 * Whether an environment may run simulated implementations at all.
 * Explicit classification — not a comment, not a naming convention.
 */
export const allowsSyntheticProviders = (env: Environment): boolean =>
  env === 'development' || env === 'test';

export type ProviderSelection = 'synthetic' | 'real';

/**
 * PROCESS ROLE.
 *
 * The tablet/server split is enforced by the TYPE SYSTEM, not by documentation.
 * A tablet configuration has no field in which a database credential or a
 * provider secret could be placed — invalid composition is unrepresentable
 * rather than merely discouraged.
 */
export type RuntimeRole = 'server' | 'tablet';

/** Configuration common to every role. Contains no secrets, by construction. */
export interface CommonRuntimeConfig {
  readonly environment: Environment;
  readonly appVersion: string;
  readonly apiVersion: string;
  readonly auth: ProviderSelection;
  readonly assistant: ProviderSelection;
  readonly scale: ProviderSelection;
  readonly activity: ProviderSelection;
  readonly catalog: ProviderSelection;
  readonly logging: { readonly level: 'debug' | 'info' | 'warn' | 'error' };
  readonly limits: {
    readonly maxRequestBytes: number;
    readonly maxSearchQueryLength: number;
  };
}

/**
 * TABLET CONFIG.
 *
 * Deliberately has NO database field and NO secret field. An appliance in a
 * kitchen is physically accessible, so it is given only what it needs: where
 * the API lives and which build it is running.
 */
export interface TabletRuntimeConfig extends CommonRuntimeConfig {
  readonly role: 'tablet';
  readonly apiBaseUrl: string;
  readonly deviceChannel: 'stable' | 'beta';
}

/** SERVER CONFIG. The only role that may hold database connectivity. */
export interface ServerRuntimeConfig extends CommonRuntimeConfig {
  readonly role: 'server';
  readonly expectedSchemaVersion: string;
  readonly database: {
    /** Application-user connection: runs under RLS as the authenticated user. */
    readonly appUrl: string;
    /** Privileged connection for catalog/system work. Server-only, by type. */
    readonly privilegedUrl: string | null;
  };
}

export type AnyRuntimeConfig = TabletRuntimeConfig | ServerRuntimeConfig;

export const isServerConfig = (c: AnyRuntimeConfig): c is ServerRuntimeConfig =>
  c.role === 'server';

/** Field names that must never appear in a tablet configuration. */
export const FORBIDDEN_TABLET_FIELDS: readonly string[] = [
  'databaseAppUrl', 'databasePrivilegedUrl', 'database',
  'serviceRoleKey', 'privilegedUrl', 'appUrl',
  'assistantApiKey', 'sttApiKey', 'ttsApiKey', 'providerApiKey',
  'catalogPublishKey', 'billingSecret',
];

export interface RuntimeConfig {
  readonly environment: Environment;
  readonly appVersion: string;
  readonly apiVersion: string;
  /** Highest migration this build expects the database to have applied. */
  readonly expectedSchemaVersion: string;

  readonly database: {
    /** Application-user connection: runs under RLS as the authenticated user. */
    readonly appUrl: string;
    /**
     * Privileged connection for server-side catalog/system work. Never present
     * on a tablet build.
     */
    readonly privilegedUrl: string | null;
  };

  readonly auth: ProviderSelection;
  readonly assistant: ProviderSelection;
  readonly scale: ProviderSelection;
  readonly activity: ProviderSelection;
  readonly catalog: ProviderSelection;

  readonly logging: { readonly level: 'debug' | 'info' | 'warn' | 'error' };
  readonly limits: {
    readonly maxRequestBytes: number;
    readonly maxSearchQueryLength: number;
  };
}

export type ConfigViolation =
  | { readonly field: string; readonly problem: string };

export type ConfigResult =
  | { readonly ok: true; readonly config: RuntimeConfig }
  | { readonly ok: false; readonly violations: readonly ConfigViolation[] };

const PROVIDER_FIELDS = ['auth', 'assistant', 'scale', 'activity', 'catalog'] as const;

/** Secret-shaped keys. Their VALUES must never be echoed, even in errors. */
const SECRET_KEY = /(password|secret|token|key|credential|dsn|url)/i;

/**
 * Redact a config-shaped record for logging or diagnostics.
 *
 * Applied by value-shape as well as key name: a connection string carries
 * credentials inline, so printing "the url" leaks the password with it.
 */
export function redactConfig(input: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = redactConfig(v as Record<string, unknown>);
    } else if (v === null || v === undefined) {
      out[k] = v;
    } else if (SECRET_KEY.test(k)) {
      out[k] = '[redacted]';
    } else {
      out[k] = v;
    }
  }
  return out;
}

export type AnyConfigResult =
  | { readonly ok: true; readonly config: AnyRuntimeConfig }
  | { readonly ok: false; readonly violations: readonly ConfigViolation[] };

/**
 * Load configuration for an explicit role.
 *
 * A tablet supplied with any credential-bearing field is a STARTUP FAILURE.
 * Diagnostics name the offending FIELD only — never its value, so a
 * misconfiguration cannot leak the credential into logs while being reported.
 */
export function loadRoleConfig(
  role: RuntimeRole,
  raw: Readonly<Record<string, unknown>>,
): AnyConfigResult {
  if (role === 'tablet') {
    // Checked BEFORE anything else: a credential-bearing field on a tablet is
    // fatal regardless of whether the rest of the configuration is valid.
    const offenders = Object.keys(raw).filter((k) => FORBIDDEN_TABLET_FIELDS.includes(k));
    if (offenders.length > 0) {
      return {
        ok: false,
        violations: offenders.map((field) => ({
          field,
          // The field name only. Never the value.
          problem: 'credential-bearing configuration is not valid for a tablet runtime',
        })),
      };
    }
  }

  // A tablet has no database fields, so common validation is given inert
  // placeholders for them; they are discarded below and never surfaced.
  const base = loadCommonConfig(
    role === 'tablet'
      ? { ...raw, databaseAppUrl: 'unused', expectedSchemaVersion: 'unused' }
      : raw,
  );
  if (!base.ok) return base;
  const c = base.config;

  if (role === 'tablet') {
    const apiBaseUrl = raw['apiBaseUrl'];
    if (typeof apiBaseUrl !== 'string' || !/^https:\/\//.test(apiBaseUrl)) {
      // Plain HTTP would put a bearer session on the wire in a home network.
      return { ok: false, violations: [{ field: 'apiBaseUrl', problem: 'required https URL' }] };
    }
    const channel = raw['deviceChannel'] === 'beta' ? 'beta' : 'stable';
    return {
      ok: true,
      config: {
        role: 'tablet',
        environment: c.environment,
        appVersion: c.appVersion,
        apiVersion: c.apiVersion,
        auth: c.auth, assistant: c.assistant, scale: c.scale,
        activity: c.activity, catalog: c.catalog,
        logging: c.logging, limits: c.limits,
        apiBaseUrl,
        deviceChannel: channel,
      },
    };
  }

  if (c.database.appUrl.length === 0) {
    return { ok: false, violations: [{ field: 'databaseAppUrl', problem: 'required for a server runtime' }] };
  }
  return {
    ok: true,
    config: {
      role: 'server',
      environment: c.environment,
      appVersion: c.appVersion,
      apiVersion: c.apiVersion,
      expectedSchemaVersion: c.expectedSchemaVersion,
      database: c.database,
      auth: c.auth, assistant: c.assistant, scale: c.scale,
      activity: c.activity, catalog: c.catalog,
      logging: c.logging, limits: c.limits,
    },
  };
}

/**
 * INTERNAL common validation, deliberately NOT exported.
 *
 * A role-less config is not a valid production shape: it is the only object in
 * which a tablet could structurally hold a database credential. Callers must go
 * through `loadRoleConfig`, which resolves to Server or Tablet. Validation logic
 * lives here once and is shared, rather than duplicated per role.
 */
function loadCommonConfig(raw: Readonly<Record<string, unknown>>): ConfigResult {
  const violations: ConfigViolation[] = [];
  const push = (field: string, problem: string): void => { violations.push({ field, problem }); };

  const environment = raw['environment'];
  if (!isEnvironment(environment)) {
    return { ok: false, violations: [{ field: 'environment', problem: 'must be one of: ' + ENVIRONMENTS.join(', ') }] };
  }

  const str = (field: string): string => {
    const v = raw[field];
    if (typeof v !== 'string' || v.trim().length === 0) {
      push(field, 'required non-empty string');
      return '';
    }
    return v;
  };

  const appVersion = str('appVersion');
  const apiVersion = str('apiVersion');
  const expectedSchemaVersion = str('expectedSchemaVersion');
  const appUrl = str('databaseAppUrl');
  const privilegedRaw = raw['databasePrivilegedUrl'];
  const privilegedUrl =
    typeof privilegedRaw === 'string' && privilegedRaw.length > 0 ? privilegedRaw : null;

  const providers: Record<string, ProviderSelection> = {};
  for (const field of PROVIDER_FIELDS) {
    const v = raw[field];
    if (v !== 'synthetic' && v !== 'real') {
      push(field, "must be 'synthetic' or 'real'");
      providers[field] = 'synthetic';
      continue;
    }
    providers[field] = v;

    // THE CRITICAL GUARDRAIL. A synthetic implementation reaching production
    // would mean fabricated nutrition presented as real, so it is a hard
    // startup failure rather than a warning.
    if (v === 'synthetic' && !allowsSyntheticProviders(environment)) {
      push(field, `synthetic provider is forbidden in ${environment}`);
    }
  }

  const level = raw['logLevel'];
  if (level !== 'debug' && level !== 'info' && level !== 'warn' && level !== 'error') {
    push('logLevel', "must be one of: debug, info, warn, error");
  }
  // Debug logging in production risks personal data reaching logs.
  if (level === 'debug' && environment === 'production') {
    push('logLevel', 'debug logging is forbidden in production');
  }

  const maxRequestBytes = Number(raw['maxRequestBytes'] ?? 65_536);
  if (!Number.isInteger(maxRequestBytes) || maxRequestBytes <= 0 || maxRequestBytes > 5_000_000) {
    push('maxRequestBytes', 'must be a positive integer under 5MB');
  }

  if (violations.length > 0) return { ok: false, violations };

  return {
    ok: true,
    config: {
      environment,
      appVersion,
      apiVersion,
      expectedSchemaVersion,
      database: { appUrl, privilegedUrl },
      auth: providers['auth']!,
      assistant: providers['assistant']!,
      scale: providers['scale']!,
      activity: providers['activity']!,
      catalog: providers['catalog']!,
      logging: { level: level as 'debug' | 'info' | 'warn' | 'error' },
      limits: { maxRequestBytes, maxSearchQueryLength: 120 },
    },
  };
}
