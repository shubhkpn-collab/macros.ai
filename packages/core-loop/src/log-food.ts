import type {
  ActiveEnergyResolution,
  EnergyModelSnapshot,
  EnergyState,
  FoodLogItem,
  GuardrailPolicy,
  Instant,
  IntakeTotals,
  MacroPolicy,
  MacroState,
  ProductVersion,
  TefAccrualPolicy,
  TefPolicyHandle,
  TefProjectionPolicy,
  WeightCapture,
} from '@macros/contracts';
import {
  aggregateDailyIntake,
  appendFoodLog,
  createFoodLogItem,
  localDayOf,
  type AppendOutcome,
} from '@macros/domain-food-log';
import { computeEnergyState } from '@macros/domain-energy';
import { computeMacroState, computeMacroTargets, assessGuardrails } from '@macros/domain-macros';
import type { GuardrailAssessment } from '@macros/contracts';

export const CORE_LOOP_VERSION = 'core-loop@1.1.0';

/**
 * USER IDENTITY BINDING.
 *
 * The metabolic model carries the subject it was built for. Running one user's
 * food through another user's profile would produce a confidently wrong energy
 * result with no outward sign of error, so it is refused structurally rather
 * than left to caller discipline.
 */
export function assertSubjectConsistency(userId: string, model: EnergyModelSnapshot): void {
  if (userId.length === 0) {
    throw new Error('core-loop: a userId is required');
  }
  if (model.profile.userId !== userId) {
    throw new Error(
      `core-loop: subject mismatch — energy model belongs to "${model.profile.userId}" ` +
        `but the operation is for "${userId}"`,
    );
  }
}

export interface LoopPolicies {
  readonly tefPolicy: TefPolicyHandle;
  readonly tefProjectionPolicy?: TefProjectionPolicy;
  readonly tefAccrualPolicy?: TefAccrualPolicy;
  readonly macroPolicy?: MacroPolicy;
  readonly guardrailPolicy?: GuardrailPolicy;
}

export interface LogFoodInput {
  readonly existingLogs: readonly FoodLogItem[];
  readonly logId: string;
  readonly userId: string;
  readonly selectedProductVersion: ProductVersion;
  readonly weightCapture: WeightCapture;
  readonly loggedAt: Instant;
  readonly timezone: string;
  readonly rolloverHour?: number;
  readonly energyModel: EnergyModelSnapshot;
  readonly activity: ActiveEnergyResolution;
  readonly policies: LoopPolicies;
  readonly mealId?: string;
}

export interface LogFoodResult {
  readonly item: FoodLogItem;
  readonly outcome: AppendOutcome;
  readonly logs: readonly FoodLogItem[];
  readonly localDate: string;
  readonly intake: IntakeTotals;
  readonly macros: MacroState;
  readonly guardrails: GuardrailAssessment;
  readonly energy: EnergyState;
}

/**
 * THE DETERMINISTIC CORE LOOP.
 *
 *   selected ProductVersion + WeightCapture
 *     → NutritionSnapshot → immutable FoodLogItem
 *     → daily IntakeTotals → MacroState + EnergyState
 *
 * PURE: no clock, no IO, no storage, no transport, no LLM. Every identifier,
 * instant and policy arrives as an input, so the whole loop is replayable.
 *
 * This exists so UI and API code never has to coordinate the domains by hand
 * and accidentally invent its own ordering or its own arithmetic.
 */
export function logFoodAndRecompute(input: LogFoodInput): LogFoodResult {
  assertSubjectConsistency(input.userId, input.energyModel);

  const created = createFoodLogItem({
    logId: input.logId,
    userId: input.userId,
    productVersion: input.selectedProductVersion,
    weightCapture: input.weightCapture,
    loggedAt: input.loggedAt,
    timezone: input.timezone,
    ...(input.rolloverHour !== undefined ? { rolloverHour: input.rolloverHour } : {}),
    ...(input.mealId !== undefined ? { mealId: input.mealId } : {}),
  });

  // The canonical stored item is returned on every path: on replay and on
  // conflict the caller receives what is actually stored, never the rejected
  // candidate it just constructed.
  const { logs, outcome, item } = appendFoodLog(input.existingLogs, created);

  return {
    item,
    outcome,
    logs,
    ...recompute({
      logs,
      userId: input.userId,
      at: input.loggedAt,
      timezone: input.timezone,
      ...(input.rolloverHour !== undefined ? { rolloverHour: input.rolloverHour } : {}),
      energyModel: input.energyModel,
      activity: input.activity,
      policies: input.policies,
    }),
  };
}

export interface RecomputeInput {
  readonly logs: readonly FoodLogItem[];
  readonly userId: string;
  readonly at: Instant;
  readonly timezone: string;
  readonly rolloverHour?: number;
  readonly energyModel: EnergyModelSnapshot;
  readonly activity: ActiveEnergyResolution;
  readonly policies: LoopPolicies;
}

export interface RecomputeResult {
  readonly localDate: string;
  readonly intake: IntakeTotals;
  readonly macros: MacroState;
  readonly guardrails: GuardrailAssessment;
  readonly energy: EnergyState;
}

/**
 * Recompute a user's day from stored snapshots. Deterministic and idempotent —
 * calling it twice with the same inputs yields the same result.
 */
export function recompute(input: RecomputeInput): RecomputeResult {
  assertSubjectConsistency(input.userId, input.energyModel);
  const rolloverHour = input.rolloverHour ?? 0;
  const day = localDayOf(input.at, input.timezone, rolloverHour);

  const intake = aggregateDailyIntake(input.logs, {
    userId: input.userId,
    localDate: day.localDate,
  });

  const energy = computeEnergyState({
    model: input.energyModel,
    intake,
    tefPolicy: input.policies.tefPolicy,
    activity: input.activity,
    ...(input.policies.tefProjectionPolicy !== undefined
      ? { tefProjectionPolicy: input.policies.tefProjectionPolicy }
      : {}),
    ...(input.policies.tefAccrualPolicy !== undefined
      ? { tefAccrualPolicy: input.policies.tefAccrualPolicy }
      : {}),
    asOf: input.at,
    day: { timezone: input.timezone, rolloverHour },
  });

  const targets = computeMacroTargets(
    {
      projectedTotalExpenditureKcal: energy.projectedTotalExpenditureKcal,
      targetDeltaKcal: energy.targetDeltaKcal,
      bodyWeightKg: input.energyModel.profile.bodyWeightKg,
    },
    input.policies.macroPolicy,
  );

  const macros = computeMacroState(targets, intake);

  const guardrails = assessGuardrails(
    targets.targetKcal,
    input.energyModel.bmrKcal,
    input.energyModel.profile.sex,
    energy.targetDeltaKcal,
    input.policies.guardrailPolicy,
  );

  return { localDate: day.localDate, intake, macros, guardrails, energy };
}
