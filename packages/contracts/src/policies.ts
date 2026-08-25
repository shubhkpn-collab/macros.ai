/**
 * VERSIONED POLICIES.
 *
 * Every number that encodes physiology or product judgement lives in a policy
 * object, not in engine code. Policies are versioned and stamped onto every
 * persisted result so a coefficient change never silently rewrites history.
 */

/**
 * Provenance is the firewall between reviewed physiology and test fixtures.
 * A SYNTHETIC_TEST policy can never be mistaken for an approved one, because
 * production entry points reject it by discriminant, not by convention.
 */
export type PolicyProvenance = 'APPROVED_PRODUCTION' | 'SYNTHETIC_TEST';
export type ReviewStatus = 'PENDING_EXTERNAL_REVIEW' | 'APPROVED';

// ---------------------------------------------------------------------------
// BMR
// ---------------------------------------------------------------------------

export type BmrMethod = 'mifflin_st_jeor' | 'katch_mcardle';

/**
 * Mifflin-St Jeor is the locked default. The presence of a body-fat number is
 * NOT sufficient to switch equations: Katch-McArdle requires explicit policy
 * permission for the specific measurement source.
 */
export interface BmrPolicy {
  readonly version: string;
  readonly provenance: PolicyProvenance;
  readonly reviewStatus: ReviewStatus;
  readonly defaultMethod: BmrMethod;
  /** Measurement sources for which katch_mcardle is permitted. Empty = never. */
  readonly katchMcArdlePermittedSources: readonly string[];
}

// ---------------------------------------------------------------------------
// TEF
// ---------------------------------------------------------------------------

/**
 * Variables a CONTINUOUS adjustment rule may read. Sex is deliberately absent:
 * encoding it as a 0/1 continuous quantity would be a fake physiological
 * number. If a sex-specific adjustment is ever approved it uses a categorical
 * rule instead.
 */
export type TefContinuousInput = 'age' | 'bodyFatPercent' | 'fatFreeMass';
export type TefInputVariable = TefContinuousInput | 'sex';

export type VersionedAdjustmentRule =
  | { readonly kind: 'none' }
  | {
      readonly kind: 'linear';
      readonly input: TefContinuousInput;
      readonly slope: number;
      readonly intercept: number;
      readonly bounds: readonly [number, number];
    }
  | {
      readonly kind: 'piecewise';
      readonly input: TefContinuousInput;
      /** Strictly increasing `upTo` thresholds. Duplicates are rejected. */
      readonly breakpoints: readonly { readonly upTo: number; readonly kcal: number }[];
    }
  | {
      readonly kind: 'categorical';
      readonly input: 'sex';
      readonly cases: { readonly male: number; readonly female: number };
    };

export interface TefIndividualAdjustmentModel {
  readonly age: VersionedAdjustmentRule;
  readonly sex?: VersionedAdjustmentRule;
  readonly fatFreeMass?: VersionedAdjustmentRule;
  readonly bodyFatPercent?: VersionedAdjustmentRule;
}

export interface TefPolicy {
  readonly version: string;
  readonly provenance: PolicyProvenance;
  readonly reviewStatus: ReviewStatus;

  readonly macroCoefficients: {
    readonly protein: number;
    readonly carbohydrate: number;
    readonly fat: number;
    readonly alcohol?: number;
  };

  readonly individualAdjustmentModel: TefIndividualAdjustmentModel;

  /** Adjustments sum in kcal. They are never multiplied together. */
  readonly composition: 'additive_kcal';
  /** Hard cap on |adjustment| as a fraction of base macro TEF. */
  readonly adjustmentBoundFraction: number;
  /** Reserved. Must remain false until a defensible method exists. */
  readonly personalCalibrationEnabled: false;
}

/**
 * No approved production TEF policy exists yet. The loader returns this
 * discriminated result rather than a placeholder coefficient set, so the
 * absence is a state the system can reason about instead of a hidden default.
 *
 * "TEF policy unavailable" and "TEF estimate is zero" are DIFFERENT facts and
 * are never conflated.
 */
export type TefPolicyHandle =
  | { readonly status: 'available'; readonly policy: TefPolicy }
  | { readonly status: 'unavailable'; readonly reason: TefPolicyUnavailableReason };

export type TefPolicyUnavailableReason =
  | 'no_approved_policy_exists'
  | 'policy_pending_external_review';

// ---------------------------------------------------------------------------
// TEF projection and accrual
// ---------------------------------------------------------------------------

export interface TefProjectionPolicy {
  readonly version: string;
  readonly kind: 'logged_intake_only' | 'target_macro_projection';
}

/**
 * v1 = zero_accrued. This does NOT assert that real TEF is zero. It states that
 * MACROS.AI does not yet claim to know how much of today's estimated TEF has
 * already occurred at this instant.
 */
export interface TefAccrualPolicy {
  readonly version: string;
  readonly kind: 'zero_accrued' | 'intraday_curve';
}

// ---------------------------------------------------------------------------
// Activity projection
// ---------------------------------------------------------------------------

/**
 * How much further active energy today is forecast to produce.
 *
 * 'none' forecasts nothing beyond what has been observed (v1 default).
 * 'historical_median' uses ONLY the user's own past activity at this hour.
 *
 * There is deliberately no PAL-derived option: PAL is not part of this
 * architecture, in the forecast or anywhere else.
 */
export interface ActivityProjectionPolicy {
  readonly version: string;
  readonly kind: 'none' | 'historical_median';
}

// ---------------------------------------------------------------------------
// Macros
// ---------------------------------------------------------------------------

export interface MacroPolicy {
  readonly version: string;
  readonly provenance: PolicyProvenance;
  readonly reviewStatus: ReviewStatus;
  readonly proteinGPerKg: number;
  readonly fatGPerKgFloor: number;
  readonly fatMinFractionOfKcal: number;
}

export interface GuardrailPolicy {
  readonly version: string;
  readonly provenance: PolicyProvenance;
  readonly reviewStatus: ReviewStatus;
  readonly absoluteFloorKcal: { readonly male: number; readonly female: number };
  readonly bmrFloorFraction: number;
  readonly maxDeficitKcal: number;
  readonly maxSurplusKcal: number;
}
