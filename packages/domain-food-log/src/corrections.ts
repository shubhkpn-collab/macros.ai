import {
  isVoidEntry,
  type FoodLogEntry,
  type FoodLogItem,
  type FoodLogVoidEntry,
  type Instant,
} from '@macros/contracts';

export const FOOD_LOG_FOLD_VERSION = 'food-log-fold@1.0.0';

/**
 * DERIVING EFFECTIVE STATE FROM AN APPEND-ONLY STREAM.
 *
 * PURE: no clock, no repository, no ids generated. Entries in, effective set
 * out. Deterministic — the same stream in any delivery order yields the same
 * result, because ordering is established by recorded time then logId, never by
 * array position.
 *
 * Nothing is ever mutated. A correction supersedes; a void removes. The
 * original rows stay exactly as they were written, which is what makes a
 * disputed number auditable months later.
 */
export type FoldConflictReason =
  | 'duplicate_correction'
  | 'duplicate_void'
  | 'supersedes_unknown_entry'
  | 'voids_unknown_entry'
  | 'correction_cycle'
  | 'cross_user_entry'
  | 'correction_changes_local_day';

export interface FoldConflict {
  readonly logId: string;
  readonly reason: FoldConflictReason;
  readonly targetLogId?: string;
}

export interface FoodLogFold {
  /** What currently counts. Daily totals are computed from exactly this. */
  readonly effective: readonly FoodLogItem[];
  /** Superseded or voided entries, retained and explainable. */
  readonly superseded: readonly FoodLogItem[];
  readonly voided: readonly FoodLogItem[];
  /**
   * Entries that could not be applied. NEVER silently dropped and never
   * silently applied — a conflicted correction is reported so a human decides.
   */
  readonly conflicts: readonly FoldConflict[];
  readonly foldVersion: string;
}

const orderKey = (entry: FoodLogEntry): string =>
  `${isVoidEntry(entry) ? entry.recordedAt : entry.loggedAt}|${entry.logId}`;

/** Deterministic stream order: recorded time, then logId. Never array order. */
export function orderEntries(entries: readonly FoodLogEntry[]): readonly FoodLogEntry[] {
  return [...entries].sort((a, b) => orderKey(a).localeCompare(orderKey(b)));
}

/**
 * Fold a user's entry stream into effective state.
 *
 * A correction may only supersede an entry that is currently effective. Two
 * corrections targeting the same entry is a genuine conflict: the first in
 * deterministic order applies, and the second is REPORTED rather than silently
 * overwriting it or being silently discarded.
 */
export function foldFoodLogEntries(
  userId: string,
  entries: readonly FoodLogEntry[],
): FoodLogFold {
  const effective = new Map<string, FoodLogItem>();
  const superseded: FoodLogItem[] = [];
  const voided: FoodLogItem[] = [];
  const conflicts: FoldConflict[] = [];
  /** Terminal entry currently representing each original chain root. */
  const chainHead = new Map<string, string>();
  const removed = new Set<string>();

  for (const entry of orderEntries(entries)) {
    // One user's stream. A foreign entry is reported, never folded in.
    if (entry.userId !== userId) {
      conflicts.push({ logId: entry.logId, reason: 'cross_user_entry' });
      continue;
    }

    if (isVoidEntry(entry)) {
      applyVoid(entry, effective, chainHead, removed, voided, conflicts);
      continue;
    }

    const item = entry;
    const kind = item.entryKind ?? 'original';

    if (kind === 'original' || item.supersedesLogId === undefined) {
      if (effective.has(item.logId) || removed.has(item.logId)) {
        conflicts.push({ logId: item.logId, reason: 'duplicate_correction' });
        continue;
      }
      effective.set(item.logId, item);
      chainHead.set(item.logId, item.logId);
      continue;
    }

    // --- a correction ---
    const targetId = item.supersedesLogId;
    if (targetId === item.logId) {
      conflicts.push({ logId: item.logId, reason: 'correction_cycle', targetLogId: targetId });
      continue;
    }

    const target = effective.get(targetId);
    if (target === undefined) {
      // Either unknown, already voided, or already superseded by another
      // correction. All three are reported; none silently applies.
      conflicts.push({
        logId: item.logId,
        reason: removed.has(targetId) || chainHead.has(targetId)
          ? 'duplicate_correction'
          : 'supersedes_unknown_entry',
        targetLogId: targetId,
      });
      continue;
    }

    // A correction stays on the day it corrects. Moving a meal to another local
    // day is a different operation and is never done implicitly.
    if (item.localDate !== target.localDate) {
      conflicts.push({
        logId: item.logId,
        reason: 'correction_changes_local_day',
        targetLogId: targetId,
      });
      continue;
    }

    effective.delete(targetId);
    superseded.push(target);
    effective.set(item.logId, item);

    const root = findRoot(chainHead, targetId);
    chainHead.set(root, item.logId);
    chainHead.set(item.logId, item.logId);
  }

  return {
    effective: [...effective.values()].sort((a, b) => orderKey(a).localeCompare(orderKey(b))),
    superseded,
    voided,
    conflicts,
    foldVersion: FOOD_LOG_FOLD_VERSION,
  };
}

function findRoot(chainHead: Map<string, string>, logId: string): string {
  for (const [root, head] of chainHead) if (head === logId) return root;
  return logId;
}

function applyVoid(
  entry: FoodLogVoidEntry,
  effective: Map<string, FoodLogItem>,
  chainHead: Map<string, string>,
  removed: Set<string>,
  voided: FoodLogItem[],
  conflicts: FoldConflict[],
): void {
  // A void may name the original the user remembers, even after corrections —
  // it resolves to whatever currently represents that chain.
  const head = chainHead.get(entry.voidsLogId) ?? entry.voidsLogId;
  const target = effective.get(head) ?? effective.get(entry.voidsLogId);

  if (target === undefined) {
    conflicts.push({
      logId: entry.logId,
      reason: removed.has(entry.voidsLogId) || removed.has(head)
        ? 'duplicate_void'
        : 'voids_unknown_entry',
      targetLogId: entry.voidsLogId,
    });
    return;
  }

  effective.delete(target.logId);
  voided.push(target);
  removed.add(target.logId);
  removed.add(entry.voidsLogId);
}

/**
 * Build a correction entry from the entry it supersedes.
 *
 * PURE. The caller supplies the new logId and the recomputed snapshot, so this
 * function performs no nutrition arithmetic and reads no clock. Immutable
 * provenance — original product, day and timezone — is carried forward
 * explicitly rather than re-derived.
 */
export function buildCorrectionEntry(
  original: FoodLogItem,
  changes: {
    readonly logId: string;
    readonly grams: FoodLogItem['grams'];
    readonly weightCapture: FoodLogItem['weightCapture'];
    readonly nutritionSnapshot: FoodLogItem['nutritionSnapshot'];
    readonly productId?: string;
    readonly productVersionId?: string;
    readonly loggedAt: Instant;
    readonly reason?: string;
  },
): FoodLogItem {
  return {
    ...original,
    logId: changes.logId,
    entryKind: 'correction',
    supersedesLogId: original.logId,
    productId: changes.productId ?? original.productId,
    productVersionId: changes.productVersionId ?? original.productVersionId,
    grams: changes.grams,
    weightCapture: changes.weightCapture,
    nutritionSnapshot: changes.nutritionSnapshot,
    loggedAt: changes.loggedAt,
    // The corrected meal stays on the day it happened.
    eventTimezone: original.eventTimezone,
    eventUtcOffsetMinutes: original.eventUtcOffsetMinutes,
    localDate: original.localDate,
    ...(changes.reason !== undefined ? { correctionReason: changes.reason } : {}),
  };
}

/** Build a void entry. Carries no nutrition, by design. */
export function buildVoidEntry(
  original: FoodLogItem,
  changes: { readonly logId: string; readonly recordedAt: Instant; readonly reason?: string },
): FoodLogVoidEntry {
  return {
    entryKind: 'void',
    logId: changes.logId,
    userId: original.userId,
    voidsLogId: original.logId,
    recordedAt: changes.recordedAt,
    eventTimezone: original.eventTimezone,
    eventUtcOffsetMinutes: original.eventUtcOffsetMinutes,
    localDate: original.localDate,
    ...(changes.reason !== undefined ? { reason: changes.reason } : {}),
  };
}
