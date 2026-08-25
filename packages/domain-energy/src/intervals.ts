import { instant, type Instant } from '@macros/contracts';
import type { TimeWindow } from '@macros/contracts';

/**
 * Pure interval algebra over millisecond ranges.
 *
 * Exists so activity coverage accounting is exact rather than approximate:
 * unresolved time is computed as a real set operation, and overlapping gaps
 * can never be counted twice.
 */
export interface Span {
  readonly start: number;
  readonly end: number;
}

export const toSpan = (w: TimeWindow): Span => ({
  start: Date.parse(w.start),
  end: Date.parse(w.end),
});

export const toWindow = (s: Span): TimeWindow => ({
  start: instant(new Date(s.start).toISOString()) as Instant,
  end: instant(new Date(s.end).toISOString()) as Instant,
});

/** Sort, drop empties, and merge every overlapping or touching span. */
export function union(spans: readonly Span[]): Span[] {
  const valid = spans
    .filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);

  const merged: Span[] = [];
  for (const s of valid) {
    const last = merged[merged.length - 1];
    if (last !== undefined && s.start <= last.end) {
      if (s.end > last.end) merged[merged.length - 1] = { start: last.start, end: s.end };
    } else {
      merged.push({ start: s.start, end: s.end });
    }
  }
  return merged;
}

/** a minus b, as a normalized union. */
export function subtract(a: readonly Span[], b: readonly Span[]): Span[] {
  const holes = union(b);
  let result = union(a);

  for (const hole of holes) {
    const next: Span[] = [];
    for (const span of result) {
      if (hole.end <= span.start || hole.start >= span.end) {
        next.push(span);
        continue;
      }
      if (hole.start > span.start) next.push({ start: span.start, end: hole.start });
      if (hole.end < span.end) next.push({ start: hole.end, end: span.end });
    }
    result = next;
  }
  return result;
}

/** Restrict spans to a bounding span. */
export function clip(spans: readonly Span[], bounds: Span): Span[] {
  const out: Span[] = [];
  for (const s of union(spans)) {
    const start = Math.max(s.start, bounds.start);
    const end = Math.min(s.end, bounds.end);
    if (end > start) out.push({ start, end });
  }
  return out;
}

export const totalMinutes = (spans: readonly Span[]): number =>
  union(spans).reduce((sum, s) => sum + (s.end - s.start) / 60000, 0);
