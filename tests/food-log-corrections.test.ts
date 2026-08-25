import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCorrectionEntry,
  buildVoidEntry,
  createFoodLogItem,
  foldFoodLogEntries,
  orderEntries,
  FOOD_LOG_FOLD_VERSION,
} from '@macros/domain-food-log';
import { calculateNutrition } from '@macros/domain-nutrition';
import { grams, instant, type FoodLogEntry, type FoodLogItem } from '@macros/contracts';
import { manualCapture } from '@macros/domain-weight';
import { SYNTHETIC_PRODUCTS, USER_A, USER_B, approx } from '@macros/testkit';
import { foodLogToRow, rowToFoodLog } from '@macros/persistence';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;

const TZ = 'America/Chicago';
const CHICKEN = SYNTHETIC_PRODUCTS.find((p) => p.displayName === 'Chicken breast, cooked')!;
const RICE = SYNTHETIC_PRODUCTS.find((p) => p.displayName.includes('rice'))!;
const at = (m: number) => instant(`2026-08-20T17:${String(m).padStart(2, '0')}:00.000Z`);

const original = (logId: string, g: number, minute = 0, userId = USER_A): FoodLogItem =>
  createFoodLogItem({
    logId, userId, productVersion: CHICKEN,
    weightCapture: manualCapture(g, at(minute)),
    loggedAt: at(minute), timezone: TZ,
  });

const correctionOf = (item: FoodLogItem, logId: string, g: number, minute: number) =>
  buildCorrectionEntry(item, {
    logId,
    grams: grams(g),
    weightCapture: manualCapture(g, at(minute)),
    nutritionSnapshot: {
      ...item.nutritionSnapshot,
      gramsConsumed: g,
      totals: calculateNutrition(CHICKEN.basis, grams(g)).totals,
    },
    loggedAt: at(minute),
    reason: 'weighed again',
  });

const fold = (entries: readonly FoodLogEntry[], userId = USER_A) => foldFoodLogEntries(userId, entries);

// ---------------------------------------------------------------------------

describe('APPEND-ONLY — originals are never mutated', () => {
  test('a correction leaves the original entry byte-identical', () => {
    const a = original('log-1', 200);
    const snapshot = JSON.parse(JSON.stringify(a));
    const b = correctionOf(a, 'log-2', 250, 5);

    const result = fold([a, b]);
    assert.deepEqual(a, snapshot, 'the original object was not touched');
    assert.equal(result.effective.length, 1);
    assert.equal(result.effective[0]!.logId, 'log-2');
    assert.equal(result.superseded[0]!.logId, 'log-1');
    void b;
  });

  test('the superseded original stays retrievable and explainable', () => {
    const a = original('log-1', 200);
    const result = fold([a, correctionOf(a, 'log-2', 250, 5)]);
    assert.ok(approx(result.superseded[0]!.nutritionSnapshot.totals.kcal, 330, 1e-9));
    assert.equal(result.effective[0]!.correctionReason, 'weighed again');
    assert.equal(result.effective[0]!.supersedesLogId, 'log-1');
  });

  test('status on a stored entry never changes — effect is derived', () => {
    const a = original('log-1', 200);
    const result = fold([a, correctionOf(a, 'log-2', 250, 5)]);
    assert.equal(result.superseded[0]!.status, 'active', 'the row was written once and stays');
    assert.equal(result.foldVersion, FOOD_LOG_FOLD_VERSION);
  });
});

describe('EFFECTIVE TOTALS', () => {
  test('only the corrected value counts', () => {
    const a = original('log-1', 200);
    const result = fold([a, correctionOf(a, 'log-2', 100, 5)]);
    assert.equal(result.effective.length, 1);
    assert.ok(approx(result.effective[0]!.nutritionSnapshot.totals.kcal, 165, 1e-9));
  });

  test('a chain of corrections leaves exactly one effective entry', () => {
    const a = original('log-1', 200);
    const b = correctionOf(a, 'log-2', 250, 5);
    const c = correctionOf(b, 'log-3', 300, 10);
    const result = fold([a, b, c]);
    assert.equal(result.effective.length, 1);
    assert.equal(result.effective[0]!.logId, 'log-3');
    assert.equal(result.superseded.length, 2);
  });

  test('a void removes the entry entirely', () => {
    const a = original('log-1', 200);
    const v = buildVoidEntry(a, { logId: 'void-1', recordedAt: at(5), reason: 'did not eat it' });
    const result = fold([a, v]);
    assert.equal(result.effective.length, 0);
    assert.equal(result.voided[0]!.logId, 'log-1');
  });

  test('a void carries no nutrition of its own', () => {
    const a = original('log-1', 200);
    const v = buildVoidEntry(a, { logId: 'void-1', recordedAt: at(5) });
    assert.equal('nutritionSnapshot' in v, false, 'a voided meal did not happen');
    assert.equal('grams' in v, false);
  });

  test('voiding a corrected entry removes the whole chain', () => {
    const a = original('log-1', 200);
    const b = correctionOf(a, 'log-2', 250, 5);
    // The user voids the meal by the id they remember: the original.
    const v = buildVoidEntry(a, { logId: 'void-1', recordedAt: at(10) });
    const result = fold([a, b, v]);
    assert.equal(result.effective.length, 0, 'the meal is gone, not resurrected as V1');
  });

  test('unrelated entries are untouched by a correction', () => {
    const a = original('log-1', 200);
    const other = createFoodLogItem({
      logId: 'log-other', userId: USER_A, productVersion: RICE,
      weightCapture: manualCapture(150, at(2)), loggedAt: at(2), timezone: TZ,
    });
    const result = fold([a, other, correctionOf(a, 'log-2', 250, 5)]);
    assert.equal(result.effective.length, 2);
    assert.ok(result.effective.some((e) => e.logId === 'log-other'));
  });
});

describe('DETERMINISM', () => {
  test('delivery order does not change the result', () => {
    const a = original('log-1', 200);
    const b = correctionOf(a, 'log-2', 250, 5);
    const c = correctionOf(b, 'log-3', 300, 10);

    const forward = fold([a, b, c]);
    const shuffled = fold([c, a, b]);
    const reversed = fold([c, b, a]);

    const ids = (r: typeof forward) => r.effective.map((e) => e.logId);
    assert.deepEqual(ids(forward), ids(shuffled));
    assert.deepEqual(ids(forward), ids(reversed));
  });

  test('ordering is by recorded time then logId, never array position', () => {
    const a = original('log-b', 200, 5);
    const b = original('log-a', 100, 5);
    const ordered = orderEntries([a, b]).map((e) => e.logId);
    assert.deepEqual(ordered, ['log-a', 'log-b'], 'a stable tie-break');
  });
});

describe('CONFLICTS — reported, never silently applied or dropped', () => {
  test('two corrections of the same entry conflict', () => {
    const a = original('log-1', 200);
    const b = correctionOf(a, 'log-2', 250, 5);
    const c = correctionOf(a, 'log-3', 300, 10);
    const result = fold([a, b, c]);

    assert.equal(result.effective.length, 1);
    assert.equal(result.effective[0]!.logId, 'log-2', 'the first in deterministic order applies');
    assert.equal(result.conflicts.length, 1);
    assert.equal(result.conflicts[0]!.logId, 'log-3');
    assert.equal(result.conflicts[0]!.reason, 'duplicate_correction');
  });

  test('a correction of an unknown entry is reported, not applied', () => {
    const a = original('log-1', 200);
    const orphan = { ...correctionOf(a, 'log-9', 250, 5), supersedesLogId: 'does-not-exist' };
    const result = fold([a, orphan]);
    assert.equal(result.effective.length, 1);
    assert.equal(result.effective[0]!.logId, 'log-1', 'the real entry is untouched');
    assert.equal(result.conflicts[0]!.reason, 'supersedes_unknown_entry');
  });

  test('a double void is reported', () => {
    const a = original('log-1', 200);
    const v1 = buildVoidEntry(a, { logId: 'void-1', recordedAt: at(5) });
    const v2 = buildVoidEntry(a, { logId: 'void-2', recordedAt: at(6) });
    const result = fold([a, v1, v2]);
    assert.equal(result.voided.length, 1);
    assert.equal(result.conflicts[0]!.reason, 'duplicate_void');
  });

  test('voiding an unknown entry is reported', () => {
    const a = original('log-1', 200);
    const v = { ...buildVoidEntry(a, { logId: 'void-1', recordedAt: at(5) }), voidsLogId: 'nope' };
    const result = fold([a, v]);
    assert.equal(result.effective.length, 1);
    assert.equal(result.conflicts[0]!.reason, 'voids_unknown_entry');
  });

  test('a self-superseding entry is a cycle, not an infinite loop', () => {
    const a = original('log-1', 200);
    const cycle = { ...a, logId: 'log-2', entryKind: 'correction' as const, supersedesLogId: 'log-2' };
    const result = fold([a, cycle]);
    assert.equal(result.conflicts[0]!.reason, 'correction_cycle');
    assert.equal(result.effective.length, 1);
  });

  test('correcting an already-voided entry is reported', () => {
    const a = original('log-1', 200);
    const v = buildVoidEntry(a, { logId: 'void-1', recordedAt: at(5) });
    const late = correctionOf(a, 'log-2', 250, 10);
    const result = fold([a, v, late]);
    assert.equal(result.effective.length, 0, 'a voided meal is not revived by a late correction');
    assert.ok(result.conflicts.some((c) => c.logId === 'log-2'));
  });

  test('a duplicate original id is reported', () => {
    const a = original('log-1', 200);
    const dup = original('log-1', 999, 5);
    const result = fold([a, dup]);
    assert.equal(result.effective.length, 1);
    assert.equal(result.conflicts[0]!.reason, 'duplicate_correction');
  });
});

describe('LOCAL DAY SAFETY', () => {
  test('a correction never moves the meal to another local day', () => {
    const a = original('log-1', 200);
    const moved = { ...correctionOf(a, 'log-2', 250, 5), localDate: '2026-08-21' };
    const result = fold([a, moved]);
    assert.equal(result.effective[0]!.logId, 'log-1', 'the move was refused');
    assert.equal(result.conflicts[0]!.reason, 'correction_changes_local_day');
  });

  test('a correction inherits the original day and timezone', () => {
    const a = original('log-1', 200);
    const b = correctionOf(a, 'log-2', 250, 5);
    assert.equal(b.localDate, a.localDate);
    assert.equal(b.eventTimezone, a.eventTimezone);
    assert.equal(b.eventUtcOffsetMinutes, a.eventUtcOffsetMinutes);
  });
});

describe('USER ISOLATION', () => {
  test("another user's entry never folds into this user's day", () => {
    const mine = original('log-1', 200);
    const theirs = original('log-2', 500, 5, USER_B);
    const result = fold([mine, theirs], USER_A);
    assert.equal(result.effective.length, 1);
    assert.equal(result.effective[0]!.logId, 'log-1');
    assert.equal(result.conflicts[0]!.reason, 'cross_user_entry');
  });

  test("another user's correction cannot supersede my entry", () => {
    const mine = original('log-1', 200);
    const hostile = { ...correctionOf(mine, 'log-2', 1, 5), userId: USER_B };
    const result = fold([mine, hostile], USER_A);
    assert.equal(result.effective[0]!.logId, 'log-1');
    assert.ok(approx(result.effective[0]!.nutritionSnapshot.totals.kcal, 330, 1e-9));
  });
});

describe('NUTRITION AUTHORITY', () => {
  test('the fold performs no arithmetic — it selects entries', () => {
    const a = original('log-1', 200);
    const b = correctionOf(a, 'log-2', 250, 5);
    const result = fold([a, b]);
    // 165 kcal/100 g × 250 g, computed by the nutrition engine before folding.
    assert.ok(approx(result.effective[0]!.nutritionSnapshot.totals.kcal, 412.5, 1e-9));
    assert.equal(result.effective[0]!.nutritionCalcVersion, a.nutritionCalcVersion);
  });

  test('an empty stream folds to nothing rather than failing', () => {
    const result = fold([]);
    assert.deepEqual(result.effective, []);
    assert.deepEqual(result.conflicts, []);
  });
});

describe('PERSISTENCE ROUND TRIP — lineage must survive storage', () => {
  test('REGRESSION: a correction read back is still a correction', () => {
    const a = original('log-1', 200);
    const b = correctionOf(a, 'log-2', 250, 5);

    const readBack = rowToFoodLog(foodLogToRow(b));
    assert.equal(readBack.entryKind, 'correction');
    assert.equal(readBack.supersedesLogId, 'log-1');
    assert.equal(readBack.correctionReason, 'weighed again');
    assert.deepEqual(readBack, b);
  });

  test('REGRESSION: a stored correction does not double-count the day', () => {
    const a = original('log-1', 200);
    const b = correctionOf(a, 'log-2', 250, 5);

    // Exactly what the repository returns: rows decoded from storage.
    const stored = [a, b].map((e) => rowToFoodLog(foodLogToRow(e)));
    const result = fold(stored);

    assert.equal(result.effective.length, 1, 'one meal, not two');
    assert.ok(approx(result.effective[0]!.nutritionSnapshot.totals.kcal, 412.5, 1e-9));
  });

  test('an original round-trips without acquiring a lineage', () => {
    const a = original('log-1', 200);
    const readBack = rowToFoodLog(foodLogToRow(a));
    assert.equal(readBack.supersedesLogId, undefined);
    assert.deepEqual(readBack, a);
  });

  test('the migration forbids self-supersession and cross-user corrections', () => {
    const sql = readFileSync(join(ROOT, 'db/migrations/0004_food_log_corrections.sql'), 'utf8');
    assert.match(sql, /supersedes_log_id <> log_id/);
    assert.match(sql, /FOREIGN KEY \(user_id, supersedes_log_id\)/);
    assert.match(sql, /food_logs_one_correction_per_target/);
    assert.match(sql, /FOREIGN KEY \(user_id, voids_log_id\)/);
    assert.equal(/GRANT[^;]*(UPDATE|DELETE)/.test(sql), false, 'still no mutation grant');
  });
});
