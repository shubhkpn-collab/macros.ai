import type { SqlExecutor } from '@macros/persistence';
import { subjectExpired, subjectUserId, type AuthenticatedSubject } from '@macros/domain-auth';
import { executorFor, type PgClientLike, type PgPoolLike } from './pool.js';

/**
 * REQUEST-SCOPED DATABASE IDENTITY.
 *
 * Identity originates from the authenticated server subject and nowhere else —
 * never from a request body, query parameter or food-log payload. Because
 * `AuthenticatedSubject` is unforgeable, a handler cannot fabricate one.
 *
 * The identity is TRANSACTION-LOCAL. `SET LOCAL` dies with the transaction, so
 * a pooled connection reused for user B carries nothing from user A. That
 * property is enforced here rather than left to caller discipline: handlers
 * receive only a transaction-bound `SqlExecutor` and never touch the pool.
 */
export const DB_IDENTITY_VERSION = 'db-request-identity@1.0.0';

/** The claim `auth.uid()` reads, matching the frozen migrations. */
const CLAIM = 'request.jwt.claim.sub';

/** The ordinary application role: NOSUPERUSER, NOBYPASSRLS. */
export const APPLICATION_ROLE = 'macros_app';

export type DbIdentityFailure =
  | 'session_expired'
  | 'identity_mismatch'
  | 'begin_failed'
  | 'role_unavailable';

export class DatabaseIdentityError extends Error {
  constructor(readonly reason: DbIdentityFailure, message: string) {
    super(message);
    this.name = 'DatabaseIdentityError';
  }
}

export interface WithSubjectOptions {
  /** Set false only for tests that deliberately run as the connecting role. */
  readonly assumeApplicationRole?: boolean;
  readonly nowIso?: string;
}

/**
 * Run `work` inside ONE transaction bound to the authenticated subject.
 *
 * Sequence: checkout → BEGIN → assume the ordinary role → SET LOCAL the claim →
 * **assert `auth.uid()` matches the subject** → run work → COMMIT. Any failure
 * rolls back. The client is always released.
 *
 * The assertion matters: without it a misconfigured claim would silently leave
 * `auth.uid()` NULL, RLS would return zero rows, and the caller would read that
 * as "no data" rather than "identity was never established".
 */
export async function withAuthenticatedDatabaseSubject<T>(
  pool: PgPoolLike,
  subject: AuthenticatedSubject,
  work: (sql: SqlExecutor) => Promise<T>,
  options: WithSubjectOptions = {},
): Promise<T> {
  const userId = subjectUserId(subject);
  const now = options.nowIso ?? new Date().toISOString();

  // Refuse before touching the database at all.
  if (subjectExpired(subject, now)) {
    throw new DatabaseIdentityError('session_expired',
      'authenticated session expired before database access');
  }

  let client: PgClientLike;
  try {
    client = await pool.connect();
  } catch (cause) {
    throw new DatabaseIdentityError('begin_failed',
      `could not obtain a database connection: ${String(cause)}`);
  }

  let began = false;
  // A connection whose cleanup did not complete must never return to the pool.
  let discardClient = false;
  try {
    await client.query('BEGIN');
    began = true;

    if (options.assumeApplicationRole !== false) {
      try {
        await client.query(`SET LOCAL ROLE ${APPLICATION_ROLE}`);
      } catch (cause) {
        throw new DatabaseIdentityError('role_unavailable',
          `application role ${APPLICATION_ROLE} unavailable: ${String(cause)}`);
      }
    }

    // Transaction-local. Parameterized: the subject id never reaches SQL text.
    await client.query('SELECT set_config($1, $2, true)', [CLAIM, userId]);

    const check = await client.query('SELECT auth.uid()::text AS uid');
    const observed = (check.rows[0] as { uid: string | null } | undefined)?.uid ?? null;
    if (observed !== userId) {
      throw new DatabaseIdentityError('identity_mismatch',
        `auth.uid() is ${observed ?? 'NULL'} but the authenticated subject is ${userId}`);
    }

    const result = await work(executorFor(client));
    try {
      await client.query('COMMIT');
    } catch (commitError) {
      // The transaction outcome is indeterminate. Attempt cleanup, and if that
      // also fails the session is unusable.
      try {
        await client.query('ROLLBACK');
      } catch {
        discardClient = true;
      }
      throw commitError;
    }
    return result;
  } catch (error) {
    if (began) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Cleanup failed: the session may still hold an open transaction or a
        // stale SET LOCAL. Destroy it rather than return it dirty. The original
        // error is preserved — cleanup noise must not replace it.
        discardClient = true;
      }
    }
    throw error;
  } finally {
    // release(true) destroys the connection; plain release() returns it.
    client.release(discardClient ? true : undefined);
  }
}

/**
 * Read the claim currently visible OUTSIDE any transaction.
 *
 * Used by the pool-isolation tests: after a request commits or rolls back this
 * must be null, or a later request on the same physical connection could
 * inherit the previous user's identity.
 */
export async function residualIdentity(pool: PgPoolLike): Promise<string | null> {
  const client = await pool.connect();
  try {
    const r = await client.query(`SELECT current_setting('${CLAIM}', true) AS uid`);
    const uid = (r.rows[0] as { uid: string | null } | undefined)?.uid ?? null;
    return uid === '' ? null : uid;
  } finally {
    client.release();
  }
}
