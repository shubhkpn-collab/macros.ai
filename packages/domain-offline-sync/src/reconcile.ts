import type { FoodLogItem } from '@macros/contracts';
import type { LocalIntegrity, OutboxEntry, QuarantinedEntry } from './outbox.js';
import { localIntegrityFor } from './outbox.js';

/**
 * DASHBOARD RECONCILIATION.
 *
 * A day can hold server logs and local pending logs at once. Identity is the
 * established `(userId, logId)` contract, so a log the server has already
 * accepted must count exactly once even while its outbox entry lingers.
 */
export const RECONCILE_POLICY = 'offline-reconcile@1.0.0';

export interface ReconciledDay {
  /** Exactly what the dashboard should aggregate. Never double-counted. */
  readonly effective: readonly FoodLogItem[];
  readonly pendingCount: number;
  readonly conflicts: readonly { readonly logId: string; readonly reason: string }[];
  /**
   * `degraded` when a locally confirmed record could not be read back.
   *
   * The totals below are then a LOWER BOUND, not the day's truth, and must not
   * be presented as authoritative — a confirmed food silently vanishing from
   * someone's day is worse than admitting the number is incomplete.
   */
  readonly localIntegrity: LocalIntegrity;
  readonly quarantinedCount: number;
}

/**
 * Merge server-known logs with local outbox entries for ONE user and day.
 *
 * The server copy wins on presence — it is durable truth — but a genuine
 * payload disagreement is surfaced as a conflict rather than silently resolved
 * in either direction.
 */
export function reconcileDay(
  userId: string,
  localDate: string,
  serverLogs: readonly FoodLogItem[],
  outbox: readonly OutboxEntry[],
  quarantined: readonly QuarantinedEntry[] = [],
): ReconciledDay {
  const effective = new Map<string, FoodLogItem>();
  const conflicts: { logId: string; reason: string }[] = [];

  for (const log of serverLogs) {
    if (log.userId !== userId || log.localDate !== localDate) continue;
    effective.set(log.logId, log);
  }

  let pendingCount = 0;
  for (const entry of outbox) {
    // Another user's queue can never contribute to this dashboard.
    if (entry.userId !== userId) continue;
    const log = entry.payload;
    if (log.localDate !== localDate) continue;

    if (entry.state === 'conflict') {
      conflicts.push({ logId: entry.logId, reason: entry.lastError ?? 'conflict' });
      continue;
    }

    const server = effective.get(entry.logId);
    if (server !== undefined) {
      // Already counted from the server side. Counting the outbox copy too
      // would double the day's calories.
      if (server.nutritionSnapshot.totals.kcal !== log.nutritionSnapshot.totals.kcal) {
        conflicts.push({ logId: entry.logId, reason: 'payload_divergence' });
      }
      if (entry.state !== 'acked') pendingCount += 1;
      continue;
    }

    if (entry.state === 'acked') {
      // Server accepted it but this day's fetch predates that; still one entry.
      effective.set(entry.logId, log);
      continue;
    }

    effective.set(entry.logId, log);
    pendingCount += 1;
  }

  return {
    effective: [...effective.values()].sort(
      (a, b) => a.loggedAt.localeCompare(b.loggedAt) || a.logId.localeCompare(b.logId),
    ),
    pendingCount,
    conflicts,
    localIntegrity: localIntegrityFor(userId, quarantined),
    quarantinedCount: quarantined.filter(
      (q) => q.userId === undefined || q.userId === userId,
    ).length,
  };
}
