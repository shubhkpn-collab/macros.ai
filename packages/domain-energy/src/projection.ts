import type {
  ActivityGapFillPolicy,
  ActivityGapFillResult,
  ActivityHistorySummary,
  ActivityProjectionPolicy,
  TefProjectionPolicy,
} from '@macros/contracts';

/** v1: forecast nothing beyond what has been observed. */
export const ACTIVITY_PROJECTION_V1: ActivityProjectionPolicy = {
  version: 'activity-projection@1.0.0-none',
  kind: 'none',
};

/** Candidate: uses ONLY the user's own historical activity at this hour. */
export const ACTIVITY_PROJECTION_HISTORICAL_MEDIAN: ActivityProjectionPolicy = {
  version: 'activity-projection@1.0.0-historical-median',
  kind: 'historical_median',
};

export interface ActivityProjectionInput {
  readonly localHour: number;
  readonly history?: ActivityHistorySummary | undefined;
}

/**
 * Forecast further active energy today.
 *
 * There is no PAL term here. A PAL multiplier is not a permitted input to any
 * projection policy — the forecast uses observation and the user's own history,
 * never a population activity class.
 */
export function projectRemainingActiveKcal(
  policy: ActivityProjectionPolicy,
  input: ActivityProjectionInput,
): number {
  switch (policy.kind) {
    case 'none':
      return 0;
    case 'historical_median': {
      const median = input.history?.medianRemainingActiveKcalByHour[input.localHour];
      if (median === undefined || !Number.isFinite(median)) return 0;
      return Math.max(0, median);
    }
  }
}

/**
 * v1: unresolved intervals are NOT filled. We never discard a wearable day and
 * substitute a whole-day population estimate.
 */
export const ACTIVITY_GAP_FILL_V1: ActivityGapFillPolicy = {
  version: 'activity-gap-fill@1.0.0-none',
  provenance: 'APPROVED_PRODUCTION',
  reviewStatus: 'PENDING_EXTERNAL_REVIEW',
  kind: 'none',
};

/**
 * Returns a discriminated result, not a number.
 *
 * 0 kcal must never mean both "we estimated zero activity for this interval"
 * and "we have no estimate for this interval". Under v1 the answer is always
 * 'unfilled', which propagates to an INCOMPLETE activity estimate.
 */
export function fillActivityGap(
  policy: ActivityGapFillPolicy,
  gapMinutes: number,
): ActivityGapFillResult {
  switch (policy.kind) {
    case 'none':
      return { status: 'unfilled' };
    case 'constant_rate_per_minute': {
      const rate = policy.kcalPerMinute;
      if (rate === undefined || !Number.isFinite(rate) || rate < 0) {
        throw new Error('ActivityGapFillPolicy "constant_rate_per_minute" requires a valid kcalPerMinute');
      }
      return { status: 'filled', estimatedKcal: rate * Math.max(0, gapMinutes) };
    }
    case 'deterministic_interval_estimate':
      throw new Error(
        'ActivityGapFillPolicy "deterministic_interval_estimate" is reserved and not implemented: ' +
          'it must estimate ONLY the missing interval and be tested against double counting.',
      );
  }
}

export const TEF_PROJECTION_V1: TefProjectionPolicy = {
  version: 'tef-projection@1.0.0-logged-intake-only',
  kind: 'logged_intake_only',
};

/**
 * v1 uses LOGGED INTAKE ONLY. We do not forecast the thermic cost of food that
 * has not been eaten, which also avoids a circular definition of
 * remaining_intake. target_macro_projection is reserved: it needs a
 * deterministic fixed-point solve against the macro engine plus an APPROVED
 * TEF policy.
 */
export function projectTefKcal(policy: TefProjectionPolicy, loggedTefKcal: number): number {
  switch (policy.kind) {
    case 'logged_intake_only':
      return loggedTefKcal;
    case 'target_macro_projection':
      throw new Error(
        'TefProjectionPolicy "target_macro_projection" is reserved and not implemented: ' +
          'it requires a deterministic fixed-point solve and an approved TEF policy.',
      );
  }
}
