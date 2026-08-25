import type { Grams, Instant } from './primitives.js';

/**
 * A RAW SCALE READING IS NOT A WEIGHT CAPTURE.
 *
 *   ScaleReading  — sensor/device data. May be slightly negative from load-cell
 *                   drift. Never enters the nutrition flow.
 *   WeightCapture — an ACCEPTED food weight, suitable for nutrition
 *                   calculation. Must be finite and greater than zero.
 *
 * Only a WeightCapture may reach food logging.
 */
export type WeightSource = 'scale' | 'manual';

/** Evidence behind a stable capture, retained so a number can be defended. */
export interface WeightCaptureEvidence {
  readonly sampleCount: number;
  readonly minGrams: number;
  readonly maxGrams: number;
  readonly spreadGrams: number;
  readonly durationMs: number;
}

/**
 * A STABLE WEIGHT IS NOT AN ACCEPTED FOOD CAPTURE.
 *
 * A candidate says only: "the platform currently holds a settled mass, and here
 * is the evidence." It may be a container, an unrelated object, a portion the
 * user is still adjusting, or food whose identity has not been chosen yet.
 *
 * It becomes a WeightCapture only when the application explicitly asks for it.
 */
export interface StableWeightCandidate {
  readonly grams: Grams;
  readonly observedAt: Instant;
  readonly deviceId: string;
  readonly bootId: string;
  readonly sequence: number;
  readonly tareGeneration: number;
  readonly stabilityPolicyVersion: string;
  readonly representativeMethod: string;
  readonly resolutionGrams: number;
  readonly resolutionQuantization: string;
  readonly evidence: WeightCaptureEvidence;
}

export interface WeightCapture {
  readonly grams: Grams;
  /** Scale and manual captures remain distinguishable forever. */
  readonly source: WeightSource;
  readonly capturedAt: Instant;

  /** Device provenance. Absent for a manual entry. */
  readonly deviceId?: string;
  readonly bootId?: string;
  readonly sequence?: number;
  readonly tareGeneration?: number;

  /** Present only for a scale capture — a manual entry never used a policy. */
  readonly stabilityPolicyVersion?: string;
  readonly representativeMethod?: string;
  /** How the accepted grams were reduced to the device's usable resolution. */
  readonly resolutionGrams?: number;
  readonly resolutionQuantization?: string;
  readonly calibrationId?: string;
  /** Stability evidence. Never fabricated for a manual entry. */
  readonly evidence?: WeightCaptureEvidence;
  /** When the underlying stable candidate was observed, if from a candidate. */
  readonly candidateObservedAt?: Instant;
}

/** Target nominal range. Supplier tolerances remain PENDING_HARDWARE_VALIDATION. */
export const SCALE_RANGE_G = { min: 0, max: 5000 } as const;
export const MAX_WEIGHT_AGE_SECONDS = 30;
