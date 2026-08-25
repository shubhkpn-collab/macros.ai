import type {
  ActiveEnergyEstimate,
  ActivityCoverage,
  NormalizedActivitySample,
  NormalizedActivityWindow,
} from './activity.js';
import { err, issue, ok, type Result, type ValidationIssue } from './result.js';

const finite = (v: number, path: string, out: ValidationIssue[]): boolean => {
  if (!Number.isFinite(v)) {
    out.push(issue(path, 'not_finite', 'must be a finite number'));
    return false;
  }
  return true;
};

const nonNegative = (v: number, path: string, out: ValidationIssue[]): void => {
  if (finite(v, path, out) && v < 0) out.push(issue(path, 'out_of_range', 'must not be negative'));
};

const confidenceInRange = (v: number, path: string, out: ValidationIssue[]): void => {
  if (finite(v, path, out) && (v < 0 || v > 1)) {
    out.push(issue(path, 'out_of_range', 'must be within [0, 1]'));
  }
};

const parsedInstant = (iso: string, path: string, out: ValidationIssue[]): number => {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) out.push(issue(path, 'not_finite', 'must be a valid instant'));
  return ms;
};

export function validateActivitySample(
  sample: NormalizedActivitySample,
  index = 0,
): Result<NormalizedActivitySample> {
  const out: ValidationIssue[] = [];
  const p = `samples[${index}]`;

  nonNegative(sample.activeKcal, `${p}.activeKcal`, out);
  confidenceInRange(sample.confidence, `${p}.confidence`, out);

  if (sample.exerciseKcal !== undefined) nonNegative(sample.exerciseKcal, `${p}.exerciseKcal`, out);
  if (sample.nonExerciseKcal !== undefined) {
    nonNegative(sample.nonExerciseKcal, `${p}.nonExerciseKcal`, out);
  }

  const start = parsedInstant(sample.start, `${p}.start`, out);
  const end = parsedInstant(sample.end, `${p}.end`, out);
  if (Number.isFinite(start) && Number.isFinite(end) && start >= end) {
    out.push(issue(`${p}.start`, 'invalid_combination', 'start must precede end'));
  }

  return out.length ? err(out) : ok(sample);
}

export function validateActivityCoverage(coverage: ActivityCoverage): Result<ActivityCoverage> {
  const out: ValidationIssue[] = [];

  nonNegative(coverage.coveredMinutes, 'coverage.coveredMinutes', out);
  if (finite(coverage.coverageRatio, 'coverage.coverageRatio', out)) {
    if (coverage.coverageRatio < 0 || coverage.coverageRatio > 1) {
      out.push(issue('coverage.coverageRatio', 'out_of_range', 'must be within [0, 1]'));
    }
  }

  const wStart = parsedInstant(coverage.windowStart, 'coverage.windowStart', out);
  const wEnd = parsedInstant(coverage.windowEnd, 'coverage.windowEnd', out);
  if (Number.isFinite(wStart) && Number.isFinite(wEnd) && wStart >= wEnd) {
    out.push(issue('coverage.windowStart', 'invalid_combination', 'window start must precede end'));
  }

  if (coverage.lastSampleAt !== null) {
    const last = parsedInstant(coverage.lastSampleAt, 'coverage.lastSampleAt', out);
    if (Number.isFinite(last) && Number.isFinite(wStart) && Number.isFinite(wEnd)) {
      if (last < wStart || last > wEnd) {
        out.push(issue('coverage.lastSampleAt', 'out_of_range', 'must lie inside the coverage window'));
      }
    }
  }

  for (const [i, gap] of coverage.gaps.entries()) {
    const gStart = parsedInstant(gap.start, `coverage.gaps[${i}].start`, out);
    const gEnd = parsedInstant(gap.end, `coverage.gaps[${i}].end`, out);
    if (Number.isFinite(gStart) && Number.isFinite(gEnd)) {
      if (gStart >= gEnd) {
        out.push(issue(`coverage.gaps[${i}].start`, 'invalid_combination', 'gap start must precede end'));
      }
      if (Number.isFinite(wStart) && Number.isFinite(wEnd) && (gStart < wStart || gEnd > wEnd)) {
        out.push(issue(`coverage.gaps[${i}]`, 'out_of_range', 'gap must lie inside the coverage window'));
      }
    }
  }

  return out.length ? err(out) : ok(coverage);
}

/**
 * THE NO-DOUBLE-COUNTING INVARIANT.
 *
 * A canonical NormalizedActivityWindow must contain deduplicated,
 * NON-OVERLAPPING activity intervals. Health platforms routinely hold records
 * from several devices covering the same minutes; summing them would inflate
 * active energy silently.
 *
 * Overlapping records are rejected with a structured error, never summed.
 * Source-priority and deduplication logic belongs in provider adapters, before
 * the window reaches this contract. Adjacent intervals (end === start) are
 * fine — they do not overlap.
 */
export function validateNormalizedActivityWindow(
  window: NormalizedActivityWindow,
): Result<NormalizedActivityWindow> {
  const out: ValidationIssue[] = [];

  for (const [i, sample] of window.samples.entries()) {
    const r = validateActivitySample(sample, i);
    if (!r.ok) out.push(...r.error);
  }

  const cov = validateActivityCoverage(window.coverage);
  if (!cov.ok) out.push(...cov.error);

  // A sample must lie inside its declared window. Provider adapters normalize
  // this before the canonical contract; we reject rather than silently clip.
  const wStart = Date.parse(window.coverage.windowStart);
  const wEnd = Date.parse(window.coverage.windowEnd);
  if (Number.isFinite(wStart) && Number.isFinite(wEnd)) {
    for (const [i, sample] of window.samples.entries()) {
      const sStart = Date.parse(sample.start);
      const sEnd = Date.parse(sample.end);
      if (!Number.isFinite(sStart) || !Number.isFinite(sEnd)) continue;
      if (sStart < wStart) {
        out.push(issue(`samples[${i}].start`, 'out_of_range', 'starts before the declared window'));
      }
      if (sEnd > wEnd) {
        out.push(issue(`samples[${i}].end`, 'out_of_range', 'ends after the declared window'));
      }
    }
  }

  const ordered = window.samples
    .map((s, i) => ({ i, start: Date.parse(s.start), end: Date.parse(s.end) }))
    .filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end))
    .sort((a, b) => a.start - b.start || a.end - b.end);

  for (let k = 1; k < ordered.length; k++) {
    const previous = ordered[k - 1]!;
    const current = ordered[k]!;
    if (current.start < previous.end) {
      const identical = current.start === previous.start && current.end === previous.end;
      out.push(
        issue(
          `samples[${current.i}]`,
          'invalid_combination',
          identical
            ? `duplicates the interval of samples[${previous.i}] — deduplicate in the provider adapter`
            : `overlaps samples[${previous.i}] — canonical activity intervals must not overlap`,
        ),
      );
    }
  }

  return out.length ? err(out) : ok(window);
}

export function validateActiveEnergyEstimate(
  estimate: ActiveEnergyEstimate,
): Result<ActiveEnergyEstimate> {
  const out: ValidationIssue[] = [];
  nonNegative(estimate.activeKcalSoFar, 'activeKcalSoFar', out);
  nonNegative(estimate.projectedRemainingActiveKcal, 'projectedRemainingActiveKcal', out);
  nonNegative(estimate.unresolvedMinutes, 'unresolvedMinutes', out);
  if (estimate.confidence !== undefined) confidenceInRange(estimate.confidence, 'confidence', out);
  return out.length ? err(out) : ok(estimate);
}
