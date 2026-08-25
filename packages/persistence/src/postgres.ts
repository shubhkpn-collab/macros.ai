import type { FoodLogItem } from '@macros/contracts';
import { foodLogFingerprint } from '@macros/domain-food-log';
import { foodLogToRow, rowToFoodLog, type FoodLogRow } from './row-codec.js';
import type { AppendFoodLogResult, FoodLogRepository } from './repositories.js';

/**
 * Minimal SQL port. Deliberately NOT the `pg` client type: this package must
 * not depend on a driver, and the caller supplies whatever executor it uses.
 *
 * The executor MUST be bound to the end user's identity so RLS applies. A
 * service-role connection must never be used for ordinary user operations.
 */
export interface SqlExecutor {
  query<T>(text: string, params: readonly unknown[]): Promise<readonly T[]>;
}

export const INSERT_FOOD_LOG_SQL = `
INSERT INTO food_logs (
  user_id, log_id, product_id, product_version_id, grams, logged_at,
  event_timezone, event_utc_offset_minutes, local_date, meal_id,
  nutrition_calc_version, weight_capture, nutrition_snapshot,
  kcal, protein_g, carbohydrate_g, fat_g, status
) VALUES (
  $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18
)
ON CONFLICT (user_id, log_id) DO NOTHING
RETURNING *`;

export const SELECT_FOOD_LOG_BY_ID_SQL = `
SELECT * FROM food_logs WHERE user_id = $1 AND log_id = $2`;

/**
 * Recent product versions for ONE user, most recent first, de-duplicated.
 *
 * The `user_id = $1` predicate is belt-and-braces: RLS already confines the
 * rows to the authenticated user. A search-ranking signal only.
 */
export const SELECT_RECENT_PRODUCT_VERSIONS_SQL = `
    SELECT product_version_id, MAX(logged_at) AS last_logged_at
      FROM food_logs
     WHERE user_id = $1
     GROUP BY product_version_id
     ORDER BY last_logged_at DESC
     LIMIT $2
`;

export const SELECT_FOOD_LOGS_BY_DAY_SQL = `
SELECT * FROM food_logs
WHERE user_id = $1 AND local_date = $2 AND status = 'active'
ORDER BY logged_at ASC, log_id ASC`;

/**
 * POSTGRES FOOD LOG REPOSITORY.
 *
 * Concurrency safety comes from the `(user_id, log_id)` primary key, not from
 * a SELECT-then-INSERT check. Two concurrent writers both attempt the insert;
 * exactly one wins, and `ON CONFLICT DO NOTHING` returns no row to the loser,
 * which then reads the winner's canonical row and compares immutable payloads.
 * There is no window in which a lost update or an overwrite can occur, and no
 * UPDATE statement exists in this class at all.
 *
 * RUNTIME STATUS: no PostgreSQL runtime was available in this environment, so
 * this adapter's SQL is unit-tested for shape and parameterization but has NOT
 * been executed against a real database.
 */
export class PostgresFoodLogRepository implements FoodLogRepository {
  constructor(private readonly sql: SqlExecutor) {}

  async append(item: FoodLogItem): Promise<AppendFoodLogResult> {
    const row = foodLogToRow(item);
    const params = [
      row.user_id, row.log_id, row.product_id, row.product_version_id, row.grams,
      row.logged_at, row.event_timezone, row.event_utc_offset_minutes, row.local_date,
      row.meal_id, row.nutrition_calc_version,
      JSON.stringify(row.weight_capture), JSON.stringify(row.nutrition_snapshot),
      row.kcal, row.protein_g, row.carbohydrate_g, row.fat_g, row.status,
    ];

    const inserted = await this.sql.query<FoodLogRow>(INSERT_FOOD_LOG_SQL, params);
    if (inserted.length === 1) {
      return { outcome: 'appended', item: rowToFoodLog(inserted[0]!) };
    }

    // Lost the race, or a genuine replay. Read the canonical stored row.
    const existingRows = await this.sql.query<FoodLogRow>(SELECT_FOOD_LOG_BY_ID_SQL, [
      row.user_id,
      row.log_id,
    ]);
    const existingRow = existingRows[0];
    if (existingRow === undefined) {
      // The insert reported a conflict but nothing is visible: RLS or a
      // different user owns that identity. Fail loudly rather than guess.
      throw new Error(
        `food_logs: conflict on (${row.user_id}, ${row.log_id}) but no readable row — refusing to proceed`,
      );
    }

    const existing = rowToFoodLog(existingRow);
    return {
      outcome:
        foodLogFingerprint(existing) === foodLogFingerprint(item)
          ? 'replayed_existing'
          : 'idempotency_conflict',
      item: existing,
    };
  }

  async listByLocalDate(userId: string, localDate: string): Promise<readonly FoodLogItem[]> {
    const rows = await this.sql.query<FoodLogRow>(SELECT_FOOD_LOGS_BY_DAY_SQL, [userId, localDate]);
    return rows.map(rowToFoodLog);
  }

  async findById(userId: string, logId: string): Promise<FoodLogItem | null> {
    const rows = await this.sql.query<FoodLogRow>(SELECT_FOOD_LOG_BY_ID_SQL, [userId, logId]);
    const row = rows[0];
    return row === undefined ? null : rowToFoodLog(row);
  }

  async listRecentProductVersionIds(userId: string, limit: number): Promise<readonly string[]> {
    const rows = await this.sql.query<{ product_version_id: string }>(
      SELECT_RECENT_PRODUCT_VERSIONS_SQL,
      [userId, limit],
    );
    return rows.map((r) => r.product_version_id);
  }
}
