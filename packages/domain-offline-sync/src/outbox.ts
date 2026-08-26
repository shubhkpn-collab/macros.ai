import type { FoodLogItem } from '@macros/contracts';
import type { AppendOutcome } from '@macros/domain-food-log';

/**
 * PENDING FOOD-LOG OUTBOX.
 *
 * An entry is an IMMUTABLE confirmed payload plus mutable synchronisation
 * metadata. The payload is the same `FoodLogItem` the online path produces —
 * there is no offline-specific nutrition, and nothing is recomputed at sync
 * time. Synchronising means transmitting a decision the user already made.
 */
export const OUTBOX_POLICY_VERSION = 'offline-outbox@1.0.0';

export type SyncState =
  | 'pending'
  | 'in_flight'
  | 'acked'
  | 'retryable_failure'
  | 'conflict'
  | 'blocked_auth';

export interface OutboxEntry {
  /** Identity is the EXISTING idempotency contract: (userId, logId). */
  readonly userId: string;
  readonly logId: string;
  /** Immutable. Never rewritten by a catalog update or a server response. */
  readonly payload: FoodLogItem;
  readonly state: SyncState;
  readonly attempts: number;
  /** Monotonic local sequence, for deterministic ordering. */
  readonly sequence: number;
  readonly lastError?: SyncFailureKind;
  readonly nextEligibleAttemptAtMs?: number;
  /** Opaque handle to the record's storage slot, when the store supplies one. */
  readonly storageRef?: string;
}

export type SyncFailureKind =
  | 'transport_unavailable'
  | 'server_error'
  | 'auth_expired'
  | 'idempotency_conflict'
  | 'integrity_rejected';

/** Server outcomes, reusing the established append semantics. */
export type SubmissionResult =
  | { readonly kind: 'accepted'; readonly outcome: AppendOutcome }
  | { readonly kind: 'failed'; readonly failure: SyncFailureKind };

/**
 * Classify a failure as retryable or permanent.
 *
 * Retrying a permanent rejection forever burns battery and hides a real problem
 * from the user; giving up on a transient network blip loses their food.
 */
export function classify(failure: SyncFailureKind): SyncState {
  switch (failure) {
    case 'transport_unavailable':
    case 'server_error':
      return 'retryable_failure';
    case 'auth_expired':
      return 'blocked_auth';
    case 'idempotency_conflict':
    case 'integrity_rejected':
      return 'conflict';
  }
}

export interface RetryPolicy {
  readonly version: string;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly maxAttempts: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  version: 'offline-retry@1.0.0',
  baseDelayMs: 5_000,
  maxDelayMs: 15 * 60_000,
  maxAttempts: 12,
};

/**
 * Deterministic bounded backoff. PURE: the caller supplies `nowMs`, so the
 * domain needs no timer and the schedule is reproducible in tests.
 */
export function nextAttemptAt(
  attempts: number,
  nowMs: number,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
): number {
  const exponent = Math.min(attempts, 20);
  const delay = Math.min(policy.baseDelayMs * 2 ** exponent, policy.maxDelayMs);
  return nowMs + delay;
}

/**
 * Apply a submission result to an entry.
 *
 * `replayed_existing` is an ACK, not a failure: it is exactly what a device
 * sees when it crashed after the server committed and retried afterwards. That
 * is the whole point of the idempotency contract — the retry is safe and
 * produces no duplicate.
 */
export function applyResult(
  entry: OutboxEntry,
  result: SubmissionResult,
  nowMs: number,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
): OutboxEntry {
  if (result.kind === 'accepted') {
    if (result.outcome === 'idempotency_conflict') {
      // Same identity, DIFFERENT payload. Neither side is silently overwritten.
      return { ...entry, state: 'conflict', lastError: 'idempotency_conflict' };
    }
    return { ...entry, state: 'acked', attempts: entry.attempts + 1 };
  }

  const attempts = entry.attempts + 1;
  const state = classify(result.failure);
  if (state === 'retryable_failure' && attempts >= policy.maxAttempts) {
    // Bounded: stop burning attempts and surface it for attention.
    return { ...entry, state: 'conflict', attempts, lastError: result.failure };
  }
  return {
    ...entry,
    state,
    attempts,
    lastError: result.failure,
    ...(state === 'retryable_failure'
      ? { nextEligibleAttemptAtMs: nextAttemptAt(attempts, nowMs, policy) }
      : {}),
  };
}

/**
 * Recover entries left `in_flight` by a crash.
 *
 * An in-flight record must never be stuck forever. Because server appends are
 * idempotent, retrying is safe — a re-send of an already-committed log returns
 * `replayed_existing` and settles as ACKED.
 */
export const recoverInFlight = (entries: readonly OutboxEntry[]): readonly OutboxEntry[] =>
  entries.map((e) => (e.state === 'in_flight' ? { ...e, state: 'pending' as const } : e));

/**
 * Entries eligible to send now, in deterministic order.
 *
 * QUARANTINE IS ENFORCED HERE, not merely by callers passing the right list.
 * A quarantined record has failed integrity verification, so its payload cannot
 * be trusted to represent what the user confirmed — transmitting it could write
 * corrupt nutrition to the server permanently.
 */
export function dueForSubmission(
  entries: readonly OutboxEntry[],
  nowMs: number,
  quarantined: readonly QuarantinedEntry[] = [],
): readonly OutboxEntry[] {
  const blocked = new Set(
    quarantined.map((q) => `${q.userId ?? ''}#${q.storageRef}`),
  );
  const blockedRefs = new Set(quarantined.map((q) => q.storageRef));
  return entries
    .filter((e) => {
      // A quarantined record is never transmitted, under any state.
      if (e.storageRef !== undefined && blockedRefs.has(e.storageRef)) return false;
      if (blocked.has(`${e.userId}#${e.storageRef ?? ''}`)) return false;
      if (e.state === 'pending') return true;
      if (e.state !== 'retryable_failure') return false;
      return (e.nextEligibleAttemptAtMs ?? 0) <= nowMs;
    })
    .slice()
    .sort((a, b) => a.sequence - b.sequence || a.logId.localeCompare(b.logId));
}

/**
 * OUTBOX SCHEMA AND PER-ENTRY INTEGRITY.
 *
 * A locally confirmed log was already shown to the user as durable, so a
 * corrupt record must never simply vanish from their day. The envelope carries
 * a schema version and a payload checksum so partial or truncated files are
 * DETECTED rather than silently skipped.
 *
 * This guards against corrupt or partially written files — not against a
 * malicious device. Confidentiality remains the platform secure-storage
 * adapter's responsibility.
 */
export const OUTBOX_SCHEMA_VERSION = 1;

export interface OutboxEnvelope {
  readonly schemaVersion: number;
  readonly entry: OutboxEntry;
  /** Deterministic checksum over the canonical entry encoding. */
  readonly payloadSha256: string;
}

export type QuarantineReason =
  | 'outbox_corrupt'
  | 'outbox_checksum_mismatch'
  | 'outbox_schema_unsupported';

/**
 * A quarantined record keeps only SAFE metadata. Nutrition is never guessed at
 * or reconstructed — an unreadable log stays unreadable.
 */
export interface QuarantinedEntry {
  /**
   * OPAQUE handle. Deliberately not a filesystem path: the path embedded an
   * encoded userId, so a diagnostic list that was meant to carry safe metadata
   * would have carried an identifier in the reference itself. `userId` below is
   * the ONE place a subject appears, and it is what the isolation rules act on.
   */
  readonly storageRef: string;
  readonly reason: QuarantineReason;
  readonly detectedAt: string;
  /** Present only when the envelope was readable enough to identify an owner. */
  readonly userId?: string;
}

export interface OutboxReadResult {
  readonly validEntries: readonly OutboxEntry[];
  readonly quarantined: readonly QuarantinedEntry[];
}

export type LocalIntegrity = 'complete' | 'degraded';

/**
 * Integrity for ONE user. Another user's corrupt record must not degrade this
 * user's dashboard, and must not be counted against them either.
 */
export function localIntegrityFor(
  userId: string,
  quarantined: readonly QuarantinedEntry[],
): LocalIntegrity {
  return quarantined.some((q) => q.userId === undefined || q.userId === userId)
    ? 'degraded'
    : 'complete';
}

/** Entries counted in the local dashboard: everything not yet server-truth. */
export const unsyncedFor = (
  entries: readonly OutboxEntry[],
  userId: string,
): readonly OutboxEntry[] =>
  entries.filter((e) => e.userId === userId && e.state !== 'acked');
