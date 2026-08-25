/**
 * STABLE ERROR TAXONOMY.
 *
 * One vocabulary shared by application services and the API boundary, so a
 * client can branch on a machine-readable code instead of parsing prose.
 *
 * Nothing internal crosses this boundary: no SQL, no stack, no driver message,
 * no provider payload, no credential. `internalDetail` stays server-side —
 * `toWireError` is the only thing a client ever sees.
 */
export type ErrorKind =
  | 'validation'
  | 'authentication'
  | 'authorization'
  | 'not_found'
  | 'conflict'
  | 'idempotency_conflict'
  | 'stale_context'
  | 'dependency_unavailable'
  | 'internal';

export interface AppError {
  readonly kind: ErrorKind;
  /** Machine-readable, domain-specific where useful (e.g. 'stale_flow'). */
  readonly code: string;
  /** Safe for a client: no internals, no personal data. */
  readonly message: string;
  /** Server-side only. NEVER serialized to a client. */
  readonly internalDetail?: string;
}

export const appError = (
  kind: ErrorKind,
  code: string,
  message: string,
  internalDetail?: string,
): AppError => ({ kind, code, message, ...(internalDetail !== undefined ? { internalDetail } : {}) });

export const HTTP_STATUS: Readonly<Record<ErrorKind, number>> = {
  validation: 400,
  authentication: 401,
  authorization: 403,
  not_found: 404,
  conflict: 409,
  idempotency_conflict: 409,
  stale_context: 409,
  dependency_unavailable: 503,
  internal: 500,
};

export interface WireError {
  readonly error: { readonly kind: ErrorKind; readonly code: string; readonly message: string };
  readonly requestId: string;
}

/**
 * The ONLY client-facing serialization. `internalDetail` is dropped here by
 * construction rather than by remembering to omit it at each call site.
 */
export const toWireError = (error: AppError, requestId: string): WireError => ({
  error: { kind: error.kind, code: error.code, message: error.message },
  requestId,
});

/**
 * Convert an unknown thrown value into a safe error.
 *
 * A driver exception can carry a connection string or a fragment of a failing
 * query, so the original message is retained internally and never surfaced.
 */
export const fromUnknown = (thrown: unknown): AppError =>
  appError(
    'internal',
    'internal_error',
    'Something went wrong.',
    thrown instanceof Error ? `${thrown.name}: ${thrown.message}` : String(thrown),
  );
