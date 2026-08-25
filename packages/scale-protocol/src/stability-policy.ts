/**
 * Stability thresholds are HARDWARE AND PRODUCT TUNING PARAMETERS, not physics.
 * They live in a versioned policy so the state machine survives retuning
 * without a logic rewrite.
 */
export type WeightPolicyValidationStatus = 'PENDING_HARDWARE_VALIDATION' | 'SUPPLIER_VALIDATED';
export type WeightPolicyProvenance = 'SYNTHETIC_TEST' | 'PRODUCTION';

export interface WeightStabilityPolicy {
  readonly version: string;
  readonly provenance: WeightPolicyProvenance;
  readonly validationStatus: WeightPolicyValidationStatus;

  /** Below this, a reading is not a food portion worth capturing. */
  readonly minCaptureGrams: number;
  /** |weight| within this band counts as clear/zeroed. */
  readonly clearBandGrams: number;

  /** Rolling window over which stability is judged. */
  readonly observationWindowMs: number;
  readonly minSampleCount: number;
  readonly minStableDurationMs: number;
  /** max - min across the window must not exceed this. */
  readonly maxSpreadGrams: number;
  /** A jump larger than this restarts stabilization at the new level. */
  readonly materialChangeGrams: number;
  /** Readings older than this are dropped from the window. */
  readonly maxSampleAgeMs: number;

  /**
   * How the accepted value is derived from the stable window.
   *
   * 'median' is preferred: a window of 250, 250, 251 should not become 251 g
   * merely because 251 arrived last. Median resists an isolated edge-of-window
   * jitter value. The UI shows the accepted candidate once stability is
   * reached, so the confirmed and captured weights still agree — raw
   * instantaneous display behaviour must not dictate calculation accuracy.
   */
  readonly representativeMethod: 'median' | 'latest';

  /**
   * How the representative value is reduced to the device's declared usable
   * resolution. 'nearest_resolution' rounds half-up to the nearest multiple of
   * ScaleCapabilities.resolutionGrams. 'none' keeps the sub-resolution value.
   */
  readonly resolutionQuantization: 'nearest_resolution' | 'none';

  /** A stable candidate older than this may not satisfy a capture request. */
  readonly maxStableCandidateAgeMs: number;
}

/**
 * Reduce a value to the device's declared usable resolution.
 * Deterministic, round-half-up, and versioned through the policy.
 */
export function quantizeToResolution(
  grams: number,
  resolutionGrams: number,
  mode: WeightStabilityPolicy['resolutionQuantization'],
): number {
  if (mode === 'none') return grams;
  if (!Number.isFinite(resolutionGrams) || resolutionGrams <= 0) return grams;
  const steps = grams / resolutionGrams;
  const rounded = steps >= 0 ? Math.floor(steps + 0.5) : -Math.floor(-steps + 0.5);
  return rounded * resolutionGrams;
}

/**
 * NO VALIDATED PRODUCTION POLICY EXISTS.
 *
 * Stability thresholds depend on real load-cell settling behaviour, mechanical
 * damping and temperature drift, none of which we have characterized. So this
 * package ships NO tuning values — the loader reports the absence as a state
 * rather than substituting plausible-looking numbers. Exactly the pattern used
 * for the TEF policy.
 *
 * A clearly marked SYNTHETIC policy lives in the testkit and is used to
 * exercise the state machine deterministically. It is never shippable.
 */
export type WeightStabilityPolicyHandle =
  | { readonly status: 'available'; readonly policy: WeightStabilityPolicy }
  | { readonly status: 'unavailable'; readonly reason: 'pending_hardware_validation' };

export function loadProductionStabilityPolicy(): WeightStabilityPolicyHandle {
  return { status: 'unavailable', reason: 'pending_hardware_validation' };
}
