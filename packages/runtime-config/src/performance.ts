/**
 * PERFORMANCE BUDGET FOUNDATION.
 *
 * Budgets are declared so regressions are measurable later. No optimization is
 * performed and no performance claim is made — these numbers are targets, not
 * measurements.
 */
export interface PerformanceBudget {
  readonly path: string;
  readonly budgetMs: number;
  readonly note: string;
}

export const PERFORMANCE_BUDGETS: readonly PerformanceBudget[] = [
  { path: 'food_search', budgetMs: 300, note: 'typed or spoken query to visible options' },
  { path: 'dashboard_refresh', budgetMs: 400, note: 'recompute and render the day' },
  { path: 'food_log_confirm', budgetMs: 600, note: 'confirmation to persisted log' },
  { path: 'voice_deterministic', budgetMs: 50, note: 'transcript to intent, no network' },
  { path: 'assistant_fallback', budgetMs: 2500, note: 'includes a future provider round trip' },
  { path: 'startup', budgetMs: 3000, note: 'process start to ready' },
];

/** Timing instrumentation seam. A no-op recorder is the default. */
export interface TimingRecorder {
  record(path: string, durationMs: number, result: 'ok' | 'error'): void;
}

export class NoopTimingRecorder implements TimingRecorder {
  record(): void { /* intentionally nothing */ }
}

export class MemoryTimingRecorder implements TimingRecorder {
  readonly samples: { path: string; durationMs: number; result: string }[] = [];
  record(path: string, durationMs: number, result: 'ok' | 'error'): void {
    this.samples.push({ path, durationMs, result });
  }
}

export const budgetFor = (path: string): PerformanceBudget | undefined =>
  PERFORMANCE_BUDGETS.find((b) => b.path === path);
