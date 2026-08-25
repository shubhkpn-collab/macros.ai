import type {
  EnergyGoalVersion,
  FoodLogItem,
  ProductCatalogHead,
  ProductVersion,
  UserProfileSnapshot,
} from '@macros/contracts';
import type { AppendOutcome } from '@macros/domain-food-log';

/**
 * NARROW REPOSITORY CONTRACTS.
 *
 * No generic repository framework, no Active Record, no query builder. Each
 * interface exposes exactly the operations the deterministic spine needs, and
 * DB row shapes never leak past this boundary — callers see domain objects only.
 *
 * Arithmetic is NEVER performed here. The pure domain remains authoritative.
 */

export interface AppendFoodLogResult {
  readonly outcome: AppendOutcome;
  /** ALWAYS the canonical stored row — the existing one on replay or conflict. */
  readonly item: FoodLogItem;
}

export interface FoodLogRepository {
  /**
   * Idempotent, concurrency-safe append keyed by `(userId, logId)`.
   *
   * Never a read-then-write race: the underlying store must reject a duplicate
   * identity atomically, and the loser of that race reads the winner's row and
   * compares immutable payloads.
   */
  append(item: FoodLogItem): Promise<AppendFoodLogResult>;

  /** One user, one local calendar day. Never crosses users. */
  listByLocalDate(userId: string, localDate: string): Promise<readonly FoodLogItem[]>;

  findById(userId: string, logId: string): Promise<FoodLogItem | null>;

  /**
   * Product versions this user logged most recently, de-duplicated and bounded.
   *
   * A search-ranking signal only — no nutrition is recalculated. Scoped to one
   * user by contract: one person's history must never bias another's search.
   */
  listRecentProductVersionIds(userId: string, limit: number): Promise<readonly string[]>;
}

export interface ProductVersionRepository {
  getVersion(productVersionId: string): Promise<ProductVersion | null>;
  getHead(productId: string): Promise<ProductCatalogHead | null>;
  /** Resolves a product's CURRENT version through the mutable head. */
  getCurrentVersion(productId: string): Promise<ProductVersion | null>;

  /**
   * Every version reachable through an ACTIVE catalog head — the searchable
   * set. De-listed products stay resolvable by id, so historical logs keep
   * meaning, but they never appear in search results.
   */
  listSearchable(): Promise<readonly ProductVersion[]>;
}

export interface UserProfileRepository {
  /** The profile version in force for this user at this instant. */
  getEffective(userId: string, atIso: string): Promise<UserProfileSnapshot | null>;
  append(profile: UserProfileSnapshot): Promise<UserProfileSnapshot>;
}

export interface EnergyGoalRepository {
  getEffective(userId: string, atIso: string): Promise<EnergyGoalVersion | null>;
  append(goal: EnergyGoalVersion): Promise<EnergyGoalVersion>;
}
