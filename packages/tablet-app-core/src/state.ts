import type {
  ActiveEnergyResolution,
  EnergyState,
  GuardrailAssessment,
  IntakeTotals,
  MacroState,
  ProductVersion,
  WeightCapture,
} from '@macros/contracts';
import type { FoodSearchResult } from '@macros/domain-food-search';
import type { AppendOutcome } from '@macros/domain-food-log';
import type { CapturePhase } from '@macros/domain-weight';
import type { AppSubject } from './ports.js';

/**
 * ADD-FOOD FLOW STATE.
 *
 * Business state lives here, never in screen navigation. Navigation is a
 * projection of this state, so the same flow can be driven by touch today and
 * by voice later without either becoming the source of truth.
 */
export type AddFoodPhase =
  | 'idle'
  | 'searching'
  | 'product_selected'
  | 'waiting_for_weight'
  | 'weight_captured'
  | 'reviewing'
  | 'logging'
  | 'completed'
  | 'error';

export type AppErrorCode =
  | 'no_results'
  | 'product_not_found'
  | 'product_unavailable'
  | 'invalid_manual_weight'
  | 'scale_disconnected'
  | 'scale_requires_clear'
  | 'scale_fault'
  | 'scale_overload'
  | 'candidate_stale'
  | 'capture_rejected'
  | 'no_weight'
  | 'profile_missing'
  | 'goal_missing'
  | 'idempotency_conflict'
  | 'repository_failure';

export interface AppError {
  readonly code: AppErrorCode;
  readonly message: string;
  /** True when the user can retry the same step without starting over. */
  readonly recoverable: boolean;
}

export interface NutritionPreview {
  readonly kcal: number;
  readonly proteinG: number;
  readonly carbohydrateG: number;
  readonly fatG: number;
}

export interface AddFoodState {
  readonly phase: AddFoodPhase;
  /** Identifies one logical add-food interaction; guards stale async results. */
  readonly flowId: string;
  readonly query: string;
  readonly results: readonly FoodSearchResult[];
  readonly selected: ProductVersion | null;
  readonly weightCapture: WeightCapture | null;
  readonly preview: NutritionPreview | null;
  /**
   * ONE id for one logical WEIGHT ATTEMPT. Tapping "use this weight" again
   * while the platform is still settling is an idempotent retry, not a second
   * request — a distinct operation from submitting the log.
   */
  readonly captureRequestId: string | null;
  /**
   * ONE id for one logical LOG SUBMISSION. A retry reuses it, so double-tapping
   * "Log Food" can never create two logs. Never shared with capture identity.
   */
  readonly submissionId: string | null;
  readonly outcome: AppendOutcome | null;
  readonly error: AppError | null;
}

export const IDLE_ADD_FOOD: AddFoodState = {
  phase: 'idle',
  flowId: 'flow-0',
  query: '',
  results: [],
  selected: null,
  weightCapture: null,
  preview: null,
  captureRequestId: null,
  submissionId: null,
  outcome: null,
  error: null,
};

/** What the dashboard renders. Every number comes from a domain result. */
export interface DashboardState {
  readonly localDate: string;
  readonly intake: IntakeTotals;
  readonly macros: MacroState;
  readonly guardrails: GuardrailAssessment;
  readonly energy: EnergyState;
  /** True while any input to the energy estimate is missing or degraded. */
  readonly energyIncomplete: boolean;
  readonly energyGaps: readonly string[];
  readonly activitySource: string | null;
  /** Set while the run uses synthetic fixtures or simulated activity. */
  readonly developmentDataNotice: string | null;
}

export interface ScaleViewState {
  readonly connected: boolean;
  readonly phase: CapturePhase;
  readonly displayGrams: number | null;
  readonly stableCandidateGrams: number | null;
  readonly message: string;
}

export interface AppState {
  readonly subject: AppSubject;
  /**
   * Set when the active user changes while the platform is still loaded. The
   * previous occupant's settled candidate must not be capturable by the new
   * subject, so scale capture is blocked until the host observes the platform
   * genuinely return to its clear/ready condition. Manual entry stays available.
   *
   * This lives at the session boundary on purpose: the scale domain is not, and
   * must not become, user-aware.
   */
  readonly requiresScaleClearForCurrentSubject: boolean;
  /** Increments on every user switch; stale work from an older one is dropped. */
  readonly sessionGeneration: number;
  readonly dashboard: DashboardState | null;
  readonly addFood: AddFoodState;
  readonly scale: ScaleViewState;
  readonly activity: ActiveEnergyResolution;
}
