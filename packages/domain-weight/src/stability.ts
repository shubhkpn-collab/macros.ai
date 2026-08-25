import type { WeightStabilityPolicy } from '@macros/scale-protocol';

/** One admitted reading, reduced to what stability evaluation needs. */
export interface WeightSample {
  readonly atMs: number;
  readonly grams: number;
  readonly tareGeneration: number;
}

export interface StabilityWindow {
  readonly samples: readonly WeightSample[];
}

export const EMPTY_WINDOW: StabilityWindow = { samples: [] };

export interface StabilityEvaluation {
  readonly stable: boolean;
  readonly sampleCount: number;
  readonly minGrams: number;
  readonly maxGrams: number;
  readonly spreadGrams: number;
  readonly durationMs: number;
  readonly representativeGrams: number;
  readonly reason:
    | 'stable'
    | 'insufficient_samples'
    | 'insufficient_duration'
    | 'spread_too_large'
    | 'below_minimum_capture_weight'
    | 'empty';
}

/**
 * Append a sample, pruning by age, window length and tare generation.
 *
 * A MATERIAL CHANGE restarts the window at the new level rather than widening
 * the spread — this is what lets a user add food, remove food, or swap a
 * portion mid-stabilization and have the scale settle on the new amount.
 *
 * PURE: the current time arrives as `atMs`; nothing reads a clock.
 */
export function pushSample(
  window: StabilityWindow,
  sample: WeightSample,
  policy: WeightStabilityPolicy,
): StabilityWindow {
  const previous = window.samples[window.samples.length - 1];

  if (previous !== undefined) {
    const materiallyChanged = Math.abs(sample.grams - previous.grams) > policy.materialChangeGrams;
    const tareChanged = previous.tareGeneration !== sample.tareGeneration;
    if (materiallyChanged || tareChanged) {
      return { samples: [sample] };
    }
  }

  const cutoff = sample.atMs - Math.min(policy.observationWindowMs, policy.maxSampleAgeMs);
  const kept = window.samples.filter(
    (s) => s.atMs >= cutoff && s.tareGeneration === sample.tareGeneration,
  );
  return { samples: [...kept, sample] };
}

/**
 * Evaluate the rolling window.
 *
 * Stability is never granted because two consecutive readings matched: it
 * requires enough samples, over enough elapsed time, within a bounded spread,
 * above the minimum capture weight.
 */
function median(samples: readonly WeightSample[]): number {
  const sorted = [...samples].map((s) => s.grams).sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export function evaluateStability(
  window: StabilityWindow,
  policy: WeightStabilityPolicy,
): StabilityEvaluation {
  const samples = window.samples;
  if (samples.length === 0) {
    return {
      stable: false, sampleCount: 0, minGrams: 0, maxGrams: 0, spreadGrams: 0,
      durationMs: 0, representativeGrams: 0, reason: 'empty',
    };
  }

  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  let sum = 0;
  for (const s of samples) {
    if (s.grams < min) min = s.grams;
    if (s.grams > max) max = s.grams;
    sum += s.grams;
  }

  const first = samples[0]!;
  const last = samples[samples.length - 1]!;
  const durationMs = last.atMs - first.atMs;
  const spreadGrams = max - min;
  // The representative method is a POLICY choice, not a hard-coded rule.
  // Median is preferred: 250, 250, 251 should not become 251 g merely because
  // 251 arrived last. The UI shows the accepted candidate once stable, so the
  // confirmed and captured weights still agree.
  const representativeGrams =
    policy.representativeMethod === 'latest' ? last.grams : median(samples);

  const base = {
    sampleCount: samples.length,
    minGrams: min,
    maxGrams: max,
    spreadGrams,
    durationMs,
    representativeGrams,
  };

  if (samples.length < policy.minSampleCount) {
    return { ...base, stable: false, reason: 'insufficient_samples' };
  }
  if (durationMs < policy.minStableDurationMs) {
    return { ...base, stable: false, reason: 'insufficient_duration' };
  }
  if (spreadGrams > policy.maxSpreadGrams) {
    return { ...base, stable: false, reason: 'spread_too_large' };
  }
  if (representativeGrams < policy.minCaptureGrams) {
    return { ...base, stable: false, reason: 'below_minimum_capture_weight' };
  }

  void sum;
  return { ...base, stable: true, reason: 'stable' };
}

/** Within the clear band the platform is considered empty and re-armable. */
export const isClear = (grams: number, policy: WeightStabilityPolicy): boolean =>
  Math.abs(grams) <= policy.clearBandGrams;
