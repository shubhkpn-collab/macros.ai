import {
  type EnergyGoalVersion,
  type FoodLogItem,
  type ProductCatalogHead,
  type ProductVersion,
  type UserProfileSnapshot,
} from '@macros/contracts';
import { foodLogFingerprint } from '@macros/domain-food-log';
import {
  foodLogToRow,
  goalToRow,
  productVersionToRow,
  profileToRow,
  rowToCatalogHead,
  rowToFoodLog,
  rowToGoal,
  rowToProductVersion,
  rowToProfile,
  type CatalogHeadRow,
  type FoodLogRow,
  type GoalRow,
  type ProductVersionRow,
  type ProfileRow,
} from './row-codec.js';
import type {
  AppendFoodLogResult,
  EnergyGoalRepository,
  FoodLogRepository,
  ProductVersionRepository,
  UserProfileRepository,
} from './repositories.js';

/**
 * IN-MEMORY REFERENCE ADAPTERS.
 *
 * These are not a convenience mock. They store ROWS, not domain objects, and
 * round-trip every read and write through the same codecs and validators the
 * Postgres adapter uses — so serialization defects, contradictory snapshots and
 * ownership mistakes surface here exactly as they would in the database.
 *
 * They also model the `(user_id, log_id)` primary key faithfully: a duplicate
 * identity is rejected by the store, never by a read-then-write check in
 * application code.
 */
export class InMemoryFoodLogRepository implements FoodLogRepository {
  private readonly rows = new Map<string, FoodLogRow>();

  private static key(userId: string, logId: string): string {
    return `${userId}\u0000${logId}`;
  }

  async append(item: FoodLogItem): Promise<AppendFoodLogResult> {
    const row = foodLogToRow(item);
    const key = InMemoryFoodLogRepository.key(item.userId, item.logId);

    const existingRow = this.rows.get(key);
    if (existingRow !== undefined) {
      // Identity collision: the stored row always wins, and is never rewritten.
      const existing = rowToFoodLog(existingRow);
      return {
        outcome:
          foodLogFingerprint(existing) === foodLogFingerprint(item)
            ? 'replayed_existing'
            : 'idempotency_conflict',
        item: existing,
      };
    }

    this.rows.set(key, row);
    // Read back through the codec: what the caller receives is what is stored.
    return { outcome: 'appended', item: rowToFoodLog(row) };
  }

  async listByLocalDate(userId: string, localDate: string): Promise<readonly FoodLogItem[]> {
    const out: FoodLogItem[] = [];
    for (const row of this.rows.values()) {
      if (row.user_id === userId && row.local_date === localDate) out.push(rowToFoodLog(row));
    }
    return out.sort((a, b) => a.loggedAt.localeCompare(b.loggedAt) || a.logId.localeCompare(b.logId));
  }

  async findById(userId: string, logId: string): Promise<FoodLogItem | null> {
    const row = this.rows.get(InMemoryFoodLogRepository.key(userId, logId));
    return row === undefined ? null : rowToFoodLog(row);
  }

  /** Test seam: inject a deliberately corrupted row to prove reads fail loudly. */
  seedRawRow(row: FoodLogRow): void {
    this.rows.set(InMemoryFoodLogRepository.key(row.user_id, row.log_id), row);
  }

  get size(): number {
    return this.rows.size;
  }

  async listRecentProductVersionIds(userId: string, limit: number): Promise<readonly string[]> {
    const mine = [...this.rows.values()]
      .filter((row) => row.user_id === userId)
      .sort((a, b) => (a.logged_at < b.logged_at ? 1 : a.logged_at > b.logged_at ? -1 : 0));

    const seen: string[] = [];
    for (const row of mine) {
      if (!seen.includes(row.product_version_id)) seen.push(row.product_version_id);
      if (seen.length >= limit) break;
    }
    return seen;
  }
}

export class InMemoryProductVersionRepository implements ProductVersionRepository {
  private readonly versions = new Map<string, ProductVersionRow>();
  private readonly heads = new Map<string, CatalogHeadRow>();

  constructor(versions: readonly ProductVersion[] = [], heads: readonly ProductCatalogHead[] = []) {
    for (const v of versions) this.putVersion(v);
    for (const h of heads) this.putHead(h);
  }

  /** Curation path. Versions are immutable: re-inserting an id is refused. */
  putVersion(v: ProductVersion): void {
    if (this.versions.has(v.productVersionId)) {
      throw new Error(`product version "${v.productVersionId}" already exists and is immutable`);
    }
    this.versions.set(v.productVersionId, productVersionToRow(v));
  }

  /** A correction repoints the head. It never rewrites a version. */
  putHead(h: ProductCatalogHead): void {
    this.heads.set(h.productId, {
      product_id: h.productId,
      current_product_version_id: h.currentProductVersionId,
      is_active: h.isActive,
      updated_at: h.updatedAt,
    });
  }

  async getVersion(productVersionId: string): Promise<ProductVersion | null> {
    const row = this.versions.get(productVersionId);
    return row === undefined ? null : rowToProductVersion(row);
  }

  async getHead(productId: string): Promise<ProductCatalogHead | null> {
    const row = this.heads.get(productId);
    return row === undefined ? null : rowToCatalogHead(row);
  }

  async getCurrentVersion(productId: string): Promise<ProductVersion | null> {
    const head = await this.getHead(productId);
    if (head === null) return null;
    return this.getVersion(head.currentProductVersionId);
  }

  /** Only versions reachable through an ACTIVE head are searchable. */
  async listSearchable(): Promise<readonly ProductVersion[]> {
    const out: ProductVersion[] = [];
    for (const head of this.heads.values()) {
      if (!head.is_active) continue;
      const row = this.versions.get(head.current_product_version_id);
      if (row !== undefined) out.push(rowToProductVersion(row));
    }
    return out.sort((a, b) => a.productVersionId.localeCompare(b.productVersionId));
  }
}

export class InMemoryUserProfileRepository implements UserProfileRepository {
  private readonly rows: ProfileRow[] = [];

  async append(profile: UserProfileSnapshot): Promise<UserProfileSnapshot> {
    const row = profileToRow(profile);
    if (this.rows.some((r) => r.profile_version_id === row.profile_version_id)) {
      throw new Error(`profile version "${row.profile_version_id}" already exists and is immutable`);
    }
    this.rows.push(row);
    return rowToProfile(row);
  }

  async getEffective(userId: string, atIso: string): Promise<UserProfileSnapshot | null> {
    const at = Date.parse(atIso);
    const candidates = this.rows
      .filter((r) => r.user_id === userId && Date.parse(r.effective_from) <= at)
      .sort((a, b) => Date.parse(b.effective_from) - Date.parse(a.effective_from));
    const row = candidates[0];
    return row === undefined ? null : rowToProfile(row);
  }
}

export class InMemoryEnergyGoalRepository implements EnergyGoalRepository {
  private readonly rows: GoalRow[] = [];

  async append(goal: EnergyGoalVersion): Promise<EnergyGoalVersion> {
    const row = goalToRow(goal);
    if (this.rows.some((r) => r.goal_version_id === row.goal_version_id)) {
      throw new Error(`goal version "${row.goal_version_id}" already exists and is immutable`);
    }
    this.rows.push(row);
    return rowToGoal(row);
  }

  async getEffective(userId: string, atIso: string): Promise<EnergyGoalVersion | null> {
    const at = Date.parse(atIso);
    const candidates = this.rows
      .filter((r) => r.user_id === userId && Date.parse(r.effective_from) <= at)
      .sort((a, b) => Date.parse(b.effective_from) - Date.parse(a.effective_from));
    const row = candidates[0];
    return row === undefined ? null : rowToGoal(row);
  }
}
