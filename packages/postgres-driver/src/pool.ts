/**
 * pg DRIVER EDGE.
 *
 * The only place in the product that knows about `pg`. `SqlExecutor` stays
 * driver-neutral, so repository and domain code never changes to accommodate a
 * driver — the IO edge is built around the existing contracts.
 *
 * `pg` is imported DYNAMICALLY so the repository typechecks and its unit tests
 * run in environments where the driver is not installed. A missing driver is a
 * clear runtime error at the edge, never a compile-time coupling.
 */
import type { SqlExecutor } from '@macros/persistence';

/**
 * The minimum surface this product uses. Declared structurally rather than
 * imported from `pg`'s types so nothing here depends on the package being
 * present to compile.
 */
export interface PgClientLike {
  query(text: string, params?: readonly unknown[]): Promise<{ rows: unknown[] }>;
  /**
   * `release(true)` (or an Error) tells pg to DESTROY the connection instead of
   * returning it to the pool. That matters when a ROLLBACK failed: the session
   * may still hold an open transaction or a stale `SET LOCAL`, and handing it
   * to the next request could leak one user's identity into another's.
   */
  release(destroy?: boolean | Error): void;
}

export interface PgPoolLike {
  connect(): Promise<PgClientLike>;
  end(): Promise<void>;
}

export interface PoolSettings {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly user?: string;
  readonly max?: number;
  /** Milliseconds a caller waits for a free client before failing. */
  readonly connectionTimeoutMillis?: number;
}

/**
 * Construct a real pooled connection.
 *
 * A connection string is never accepted or logged: the tablet has no database
 * credential and no database URL crosses the server boundary. Settings come
 * from server-side configuration only.
 */
export async function createPgPool(settings: PoolSettings): Promise<PgPoolLike> {
  // The specifier is built at runtime so the compiler does not resolve `pg`
  // statically. That keeps the repository buildable and its unit tests runnable
  // wherever the driver is absent, while the real driver still loads normally
  // once `npm ci` has installed it.
  const moduleName = 'pg';
  let pg: { Pool?: new (config: unknown) => PgPoolLike; default?: { Pool: new (c: unknown) => PgPoolLike } };
  try {
    pg = (await import(/* @vite-ignore */ moduleName)) as typeof pg;
  } catch {
    throw new Error(
      'postgres-driver: the `pg` package is not installed. Run `npm ci` in the repository root.',
    );
  }
  // pg ships CJS; under ESM the constructor may sit on the namespace or default.
  const PoolCtor = pg.Pool ?? pg.default?.Pool;
  if (PoolCtor === undefined) {
    throw new Error('postgres-driver: `pg` loaded but exposes no Pool constructor');
  }

  return new PoolCtor({
    host: settings.host,
    port: settings.port,
    database: settings.database,
    ...(settings.user !== undefined ? { user: settings.user } : {}),
    max: settings.max ?? 10,
    connectionTimeoutMillis: settings.connectionTimeoutMillis ?? 5_000,
  });
}

/** Binds a SqlExecutor to ONE client, so every query in a unit of work shares
 *  the same transaction — and therefore the same transaction-local identity. */
export function executorFor(client: PgClientLike): SqlExecutor {
  return {
    async query<T>(text: string, params: readonly unknown[]): Promise<readonly T[]> {
      const result = await client.query(text, params);
      return result.rows as readonly T[];
    },
  };
}

/**
 * SERVER COMPOSITION.
 *
 * The security rule is not "no connection strings" — it is that database
 * credentials exist ONLY at the server IO edge. `RuntimeConfig.database.appUrl`
 * is exactly that: already validated, server-side, and never sent to a tablet.
 *
 * The URL is consumed here and never retained, returned or logged. Errors
 * deliberately carry no connection detail, because a driver failure message is
 * a common way a credential ends up in a log.
 */
export async function createApplicationPool(appUrl: string): Promise<PgPoolLike> {
  const moduleName = 'pg';
  let pg: { Pool?: new (c: unknown) => PgPoolLike; default?: { Pool: new (c: unknown) => PgPoolLike } };
  try {
    pg = (await import(/* @vite-ignore */ moduleName)) as typeof pg;
  } catch {
    throw new Error('postgres-driver: the `pg` package is not installed. Run `npm ci`.');
  }
  const PoolCtor = pg.Pool ?? pg.default?.Pool;
  if (PoolCtor === undefined) {
    throw new Error('postgres-driver: `pg` loaded but exposes no Pool constructor');
  }
  try {
    return new PoolCtor({
      connectionString: appUrl,
      max: 10,
      connectionTimeoutMillis: 5_000,
    });
  } catch {
    // Never interpolate appUrl into an error.
    throw new Error('postgres-driver: could not construct the application pool');
  }
}
