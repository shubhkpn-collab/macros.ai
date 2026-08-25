import {
  kcal,
  unwrap,
  validateNormalizedActivityWindow,
  type ActiveEnergyEstimate,
  type ActiveEnergyResolution,
  type ActivityCompletenessGap,
  type ActivityGapFillPolicy,
  type ActivityHistorySummary,
  type ActivityPlausibilityPolicy,
  type ActivityProjectionPolicy,
  type ActivityQuality,
  type ActivityQualityReason,
  type ActivitySourceKind,
  type Instant,
  type NormalizedActivitySample,
  type NormalizedActivityWindow,
} from '@macros/contracts';
import {
  ACTIVITY_GAP_FILL_V1,
  ACTIVITY_PROJECTION_V1,
  fillActivityGap,
  projectRemainingActiveKcal,
} from './projection.js';
import { clip, subtract, toSpan, toWindow, totalMinutes, union, type Span } from './intervals.js';

export interface ActiveEnergyBuildOptions {
  readonly source: ActivitySourceKind;
  readonly localHour: number;
  readonly asOf: Instant;
  readonly projectionPolicy?: ActivityProjectionPolicy;
  readonly gapFillPolicy?: ActivityGapFillPolicy;
  /** Physiological bounds. Without an approved policy, no filtering is applied. */
  readonly plausibilityPolicy?: ActivityPlausibilityPolicy;
  readonly bodyWeightKg?: number;
  readonly history?: ActivityHistorySummary | undefined;
}

/**
 * Resolve observed samples into the single ACTIVE ENERGY input the engine takes.
 *
 * INTERVAL ACCOUNTING IS EXACT. A rejected sample does not merely lose its
 * calories — the time it covered becomes unresolved, unless another accepted
 * sample covers the same minutes. Unresolved time is:
 *
 *     provider gaps  ∪  rejected-sample intervals  ∪  stale tail
 *       minus  accepted-sample intervals,   clipped to the elapsed window
 *
 * unioned and deduplicated, so overlapping gaps are never counted twice.
 *
 * A partial day is NEVER discarded in favour of a whole-day population
 * estimate. Observed energy is always retained; only the missing interval is a
 * candidate for the gap-fill policy.
 *
 * MISSING IS NOT ZERO: if nothing usable survives and the gap-fill policy
 * supplies no replacement, the result is UNAVAILABLE rather than an estimate
 * of zero activity.
 */
export function resolveActiveEnergy(
  window: NormalizedActivityWindow,
  opts: ActiveEnergyBuildOptions,
): ActiveEnergyResolution {
  // Rejects overlapping or malformed samples loudly rather than summing them.
  unwrap(validateNormalizedActivityWindow(window));

  const projectionPolicy = opts.projectionPolicy ?? ACTIVITY_PROJECTION_V1;
  const gapFillPolicy = opts.gapFillPolicy ?? ACTIVITY_GAP_FILL_V1;
  const plausibility = opts.plausibilityPolicy;
  const reasons = new Set<ActivityQualityReason>();

  const accepted: NormalizedActivitySample[] = [];
  const rejected: NormalizedActivitySample[] = [];

  for (const s of window.samples) {
    if (s.appearsWorn === false) {
      reasons.add('not_worn_samples_excluded');
      rejected.push(s);
      continue;
    }
    if (plausibility !== undefined && s.confidence < plausibility.minSampleConfidence) {
      reasons.add('low_confidence_samples_excluded');
      rejected.push(s);
      continue;
    }
    if (s.isEstimated) reasons.add('provider_estimated_samples');
    accepted.push(s);
  }

  let usable = accepted;
  let observed = accepted.reduce((sum, s) => sum + s.activeKcal, 0);

  // Whole-window plausibility: an impossible daily total invalidates the set.
  if (plausibility !== undefined && opts.bodyWeightKg !== undefined) {
    const ceiling = plausibility.maxDailyActiveKcalPerKgBodyWeight * opts.bodyWeightKg;
    if (observed > ceiling) {
      reasons.add('implausible_samples_excluded');
      rejected.push(...accepted);
      usable = [];
      observed = 0;
    }
  }

  const windowSpan = toSpan({ start: window.coverage.windowStart, end: window.coverage.windowEnd });
  const elapsedEnd = Math.min(Date.parse(opts.asOf), windowSpan.end);
  const elapsed: Span = { start: windowSpan.start, end: Math.max(windowSpan.start, elapsedEnd) };

  const acceptedSpans = union(usable.map(toSpan));
  const rejectedSpans = union(rejected.map(toSpan));
  const providerGapSpans = union(window.coverage.gaps.map(toSpan));

  // Stale tail: elapsed time after the last usable observation.
  const lastCovered = acceptedSpans.reduce((max, s) => Math.max(max, s.end), windowSpan.start);
  const tailSpans: Span[] = [];
  if (plausibility !== undefined && elapsed.end > lastCovered) {
    const tailMinutes = (elapsed.end - lastCovered) / 60000;
    if (tailMinutes > plausibility.maxStalenessMinutes) {
      reasons.add('stale_data');
      tailSpans.push({ start: lastCovered, end: elapsed.end });
    }
  }

  const unresolvedSpans = clip(
    subtract(union([...providerGapSpans, ...rejectedSpans, ...tailSpans]), acceptedSpans),
    elapsed,
  );
  const unresolvedMinutes = totalMinutes(unresolvedSpans);
  if (unresolvedMinutes > 0) reasons.add('coverage_gap');

  const fill =
    unresolvedMinutes > 0 ? fillActivityGap(gapFillPolicy, unresolvedMinutes) : null;
  const filledKcal = fill?.status === 'filled' ? fill.estimatedKcal : 0;

  // Nothing usable and no replacement: MISSING, not zero.
  if (usable.length === 0 && fill?.status !== 'filled') {
    return {
      status: 'unavailable',
      reason: rejected.length > 0 ? 'all_samples_rejected' : 'no_usable_samples',
    };
  }

  const completenessGaps: ActivityCompletenessGap[] = [];
  if (fill?.status === 'unfilled') {
    if (providerGapSpans.length > 0) completenessGaps.push('coverage_gap_unfilled');
    if (rejectedSpans.length > 0) completenessGaps.push('rejected_sample_interval_unfilled');
    if (tailSpans.length > 0) completenessGaps.push('stale_tail_unfilled');
    if (completenessGaps.length === 0) completenessGaps.push('coverage_gap_unfilled');
  }

  const quality: ActivityQuality =
    completenessGaps.length > 0 ||
    fill?.status === 'filled' ||
    reasons.has('provider_estimated_samples')
      ? 'partially_estimated'
      : 'observed';

  const confidence = usable.length > 0 ? usable.reduce((m, s) => Math.min(m, s.confidence), 1) : 0;
  const providerId = usable[0]?.providerId ?? window.samples[0]?.providerId;

  const estimate: ActiveEnergyEstimate = {
    activeKcalSoFar: kcal(observed + filledKcal),
    projectedRemainingActiveKcal: kcal(
      projectRemainingActiveKcal(projectionPolicy, { localHour: opts.localHour, history: opts.history }),
    ),
    source: opts.source,
    quality,
    qualityReasons: [...reasons],
    completeness: completenessGaps.length > 0 ? 'incomplete' : 'complete',
    completenessGaps,
    unresolvedIntervals: completenessGaps.length > 0 ? unresolvedSpans.map(toWindow) : [],
    unresolvedMinutes: completenessGaps.length > 0 ? unresolvedMinutes : 0,
    confidence,
    coverage: window.coverage,
    ...(providerId !== undefined ? { providerId } : {}),
    projectionPolicyVersion: projectionPolicy.version,
    gapFillPolicyVersion: gapFillPolicy.version,
  };

  return { status: 'available', estimate };
}
