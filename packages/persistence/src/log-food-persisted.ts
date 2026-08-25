import { buildEnergyModel } from '@macros/domain-energy';
import type {
  ActiveEnergyResolution,
  EnergyModelSnapshot,
  Instant,
  WeightCapture,
} from '@macros/contracts';
import { unwrap, validateWeightCapture } from '@macros/contracts';
import { localDayOf } from '@macros/domain-food-log';
import { assertSubjectConsistency, recompute, type LoopPolicies, type RecomputeResult } from '@macros/core-loop';
import { createFoodLogItem } from '@macros/domain-food-log';
import type {
  AppendFoodLogResult,
  EnergyGoalRepository,
  FoodLogRepository,
  ProductVersionRepository,
  UserProfileRepository,
} from './repositories.js';

export interface PersistedLoopRepositories {
  readonly foodLogs: FoodLogRepository;
  readonly products: ProductVersionRepository;
  readonly profiles: UserProfileRepository;
  readonly goals: EnergyGoalRepository;
}

export interface LogFoodPersistedInput {
  readonly userId: string;
  readonly logId: string;
  readonly productVersionId: string;
  readonly weightCapture: WeightCapture;
  readonly loggedAt: Instant;
  readonly timezone: string;
  readonly rolloverHour?: number;
  readonly mealId?: string;
  readonly activity: ActiveEnergyResolution;
  readonly policies: LoopPolicies;
}

export interface LogFoodPersistedResult extends RecomputeResult {
  readonly item: AppendFoodLogResult['item'];
  readonly outcome: AppendFoodLogResult['outcome'];
  readonly energyModel: EnergyModelSnapshot;
}

/**
 * THE PERSISTED CORE LOOP — a thin IO service, nothing more.
 *
 *   resolve ProductVersion  →  resolve effective profile + goal
 *   →  validate ownership   →  validate WeightCapture
 *   →  build the item through the PURE domain
 *   →  append idempotently  →  read the canonical local day
 *   →  recompute through the PURE domain
 *
 * NO ARITHMETIC HAPPENS HERE, and none happens in SQL. The deterministic
 * domain remains the only authority on nutrition, macros and energy.
 *
 * EnergyState is never persisted: it is derived, and storing it would create a
 * second source of truth that could silently drift from the logs.
 */
export async function logFoodPersisted(
  repos: PersistedLoopRepositories,
  input: LogFoodPersistedInput,
): Promise<LogFoodPersistedResult> {
  if (input.userId.length === 0) throw new Error('logFoodPersisted: a userId is required');

  // External boundary: validate before anything touches the domain.
  unwrap(validateWeightCapture(input.weightCapture));

  const productVersion = await repos.products.getVersion(input.productVersionId);
  if (productVersion === null) {
    throw new Error(`logFoodPersisted: unknown product version "${input.productVersionId}"`);
  }

  const profile = await repos.profiles.getEffective(input.userId, input.loggedAt);
  if (profile === null) {
    throw new Error(`logFoodPersisted: no effective profile for user "${input.userId}"`);
  }
  const goal = await repos.goals.getEffective(input.userId, input.loggedAt);
  if (goal === null) {
    throw new Error(`logFoodPersisted: no effective goal for user "${input.userId}"`);
  }

  // OWNERSHIP: the resolved profile and goal must belong to the acting user.
  // Repositories are queried by userId, but this is the invariant that matters,
  // so it is asserted rather than assumed.
  if (profile.userId !== input.userId) {
    throw new Error('logFoodPersisted: resolved profile does not belong to the acting user');
  }
  if (goal.userId !== input.userId) {
    throw new Error('logFoodPersisted: resolved goal does not belong to the acting user');
  }

  const energyModel = buildEnergyModel(profile, {
    targetDeltaKcal: goal.targetDeltaKcal,
    goal: goal.goal,
  });
  assertSubjectConsistency(input.userId, energyModel);

  const candidate = createFoodLogItem({
    logId: input.logId,
    userId: input.userId,
    productVersion,
    weightCapture: input.weightCapture,
    loggedAt: input.loggedAt,
    timezone: input.timezone,
    ...(input.rolloverHour !== undefined ? { rolloverHour: input.rolloverHour } : {}),
    ...(input.mealId !== undefined ? { mealId: input.mealId } : {}),
  });

  const appended = await repos.foodLogs.append(candidate);

  // Recompute from what is actually STORED, not from the in-memory candidate.
  const day = localDayOf(input.loggedAt, input.timezone, input.rolloverHour ?? 0);
  const logs = await repos.foodLogs.listByLocalDate(input.userId, day.localDate);

  const state = recompute({
    logs,
    userId: input.userId,
    at: input.loggedAt,
    timezone: input.timezone,
    ...(input.rolloverHour !== undefined ? { rolloverHour: input.rolloverHour } : {}),
    energyModel,
    activity: input.activity,
    policies: input.policies,
  });

  return { ...state, item: appended.item, outcome: appended.outcome, energyModel };
}

export interface RecomputeDayInput {
  readonly userId: string;
  readonly at: Instant;
  readonly timezone: string;
  readonly rolloverHour?: number;
  readonly activity: ActiveEnergyResolution;
  readonly policies: LoopPolicies;
}

/**
 * Rebuild a user's current day purely from storage.
 *
 * This is the restart path: with no in-memory state at all, the same
 * deterministic result must come back out.
 */
export async function recomputeDayFromStorage(
  repos: PersistedLoopRepositories,
  input: RecomputeDayInput,
): Promise<RecomputeResult & { energyModel: EnergyModelSnapshot }> {
  const profile = await repos.profiles.getEffective(input.userId, input.at);
  if (profile === null) throw new Error(`recomputeDayFromStorage: no effective profile`);
  const goal = await repos.goals.getEffective(input.userId, input.at);
  if (goal === null) throw new Error(`recomputeDayFromStorage: no effective goal`);

  const energyModel = buildEnergyModel(profile, {
    targetDeltaKcal: goal.targetDeltaKcal,
    goal: goal.goal,
  });
  assertSubjectConsistency(input.userId, energyModel);

  const day = localDayOf(input.at, input.timezone, input.rolloverHour ?? 0);
  const logs = await repos.foodLogs.listByLocalDate(input.userId, day.localDate);

  return {
    ...recompute({
      logs,
      userId: input.userId,
      at: input.at,
      timezone: input.timezone,
      ...(input.rolloverHour !== undefined ? { rolloverHour: input.rolloverHour } : {}),
      energyModel,
      activity: input.activity,
      policies: input.policies,
    }),
    energyModel,
  };
}
