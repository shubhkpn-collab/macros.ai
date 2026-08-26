import {
  appError, type AppError,
} from '@macros/runtime-config';
import { foodLogToRow, rowToFoodLog, PostgresFoodLogRepository } from '@macros/persistence';
import { withAuthenticatedDatabaseSubject, type PgPoolLike } from '@macros/postgres-driver';
import { subjectUserId, type AuthenticatedSubject } from '@macros/domain-auth';
import { validateFoodLogItem, type FoodLogItem } from '@macros/contracts';
import type { RequestContext, Route } from './server.js';

/**
 * THE AUTHENTICATED FOOD-LOG SUBMISSION PATH.
 *
 * Bearer → verified session → the SAME AuthenticatedSubject → transaction
 * identity → PostgresFoodLogRepository. The handler does transport only: no
 * SQL, no nutrition arithmetic, and it never sees a Pool or PoolClient.
 */

/**
 * Decode unknown network JSON into a FoodLogItem.
 *
 * Reuses the authoritative row codecs rather than hand-writing a second schema:
 * `foodLogToRow` applies the same shape and scale rules persistence uses, so a
 * malformed weightCapture, nutritionSnapshot, timezone or numeric field fails
 * HERE, before anything reaches the database.
 */
export function decodeFoodLogItem(body: Record<string, unknown>): FoodLogItem | AppError {
  const raw = body['foodLog'];
  if (raw === null || typeof raw !== 'object') {
    return appError('validation', 'missing_food_log', 'A food log payload is required.');
  }
  // Shape gate first: validateFoodLogItem reads typed fields, so unknown JSON
  // must be proven to have them before it can be handed over. Missing required
  // fields are rejected here rather than reaching a property access.
  const candidate = raw as Record<string, unknown>;
  for (const field of ['logId', 'userId', 'productId', 'productVersionId'] as const) {
    if (typeof candidate[field] !== 'string') {
      return appError('validation', 'invalid_food_log', `${field} is required.`);
    }
  }
  for (const field of ['weightCapture', 'nutritionSnapshot'] as const) {
    if (candidate[field] === null || typeof candidate[field] !== 'object') {
      return appError('validation', 'invalid_food_log', `${field} is required.`);
    }
  }

  // The AUTHORITATIVE validator, not a second hand-written schema. It reads
  // nested fields, so hostile input can make it throw rather than return —
  // which must still be a 400, never a 500.
  let validated;
  try {
    validated = validateFoodLogItem(raw as FoodLogItem);
  } catch {
    return appError('validation', 'invalid_food_log', 'The food log payload is not valid.');
  }
  if (!validated.ok) {
    return appError('validation', 'invalid_food_log', 'The food log payload is not valid.');
  }
  try {
    // Round-trip through the persistence codecs too: anything they cannot
    // express would fail at write time, and unknown fields are dropped here
    // rather than travelling on as authority.
    return rowToFoodLog(foodLogToRow(validated.value));
  } catch {
    return appError('validation', 'invalid_food_log', 'The food log payload is not persistable.');
  }
}

export interface FoodLogRouteDeps {
  readonly pool: PgPoolLike;
  readonly nowIso?: () => string;
}

/**
 * Build the route. The pool is captured in the closure, so a handler cannot
 * reach it and no privileged connection is available on this path.
 */
export function foodLogRoute(deps: FoodLogRouteDeps): Route {
  return {
    method: 'POST',
    path: '/food-logs',
    decode: (body) => decodeFoodLogItem(body),
    handler: async (ctx: RequestContext) => {
      const subject = ctx.subject;
      if (subject === undefined) {
        // Defensive: a non-public route always has one.
        return appError('authentication', 'missing_credential', 'Not signed in.');
      }
      const decoded = (ctx.body as { decoded?: FoodLogItem | AppError }).decoded;
      if (decoded === undefined) {
        return appError('validation', 'missing_food_log', 'A food log payload is required.');
      }
      if ('kind' in (decoded as object)) return decoded as AppError;
      const item = decoded as FoodLogItem;

      // The payload userId is at most a CLAIM. Authority is the subject.
      const authoritative = subjectUserId(subject);
      if (item.userId !== authoritative) {
        return appError('authorization', 'subject_mismatch', 'Not permitted for this profile.');
      }

      return submitFoodLog(deps.pool, subject, item);
    },
  };
}

/** Application service: transaction identity in, canonical result out. */
export async function submitFoodLog(
  pool: PgPoolLike,
  subject: AuthenticatedSubject,
  item: FoodLogItem,
): Promise<{ outcome: string; logId: string }> {
  const result = await withAuthenticatedDatabaseSubject(pool, subject, (sql) =>
    new PostgresFoodLogRepository(sql).append(item));

  // Only the canonical outcome and identity cross the boundary — never a row,
  // a driver message or anything about the connection.
  return { outcome: result.outcome, logId: result.item.logId };
}
