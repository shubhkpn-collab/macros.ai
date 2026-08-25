import {
  instant,
  kcal,
  type ActiveEnergyEstimate,
  type ActivityCoverage,
  type ActivitySourceKind,
  type EnergyActivityProvider,
  type Instant,
  type NormalizedActivitySample,
  type NormalizedActivityWindow,
  type TimeWindow,
} from '@macros/contracts';

export interface SimulatedActivityConfig {
  readonly totalActiveKcal: number;
  /** Simulated forecast of further activity today. Supplied, not derived from PAL. */
  readonly projectedRemainingActiveKcal: number;
  readonly sampleCount: number;
  readonly confidence: number;
  readonly isEstimated: boolean;
  readonly appearsWorn: boolean;
  readonly coverageRatio: number;
  readonly lastSampleAt?: Instant;
}

export const DEFAULT_SIMULATED_CONFIG: SimulatedActivityConfig = {
  totalActiveKcal: 450,
  projectedRemainingActiveKcal: 0,
  sampleCount: 6,
  confidence: 0.9,
  isEstimated: false,
  appearsWorn: true,
  coverageRatio: 1,
};

/**
 * Deterministic activity provider for MVP-0 and tests.
 *
 * Emits ACTIVE energy only, exactly like a real adapter must: no basal
 * component, no embedded TEF, and never a total-expenditure figure.
 *
 * MVP-0 runs the PRODUCTION equation — BMR + ACTIVE + TEF — with this provider
 * supplying the ACTIVE component. There is no temporary MVP-0 engine to
 * replace later.
 */
export class SimulatedActivityProvider implements EnergyActivityProvider {
  readonly id = 'simulated';
  readonly sourceKind: ActivitySourceKind = 'simulated';

  constructor(private readonly config: SimulatedActivityConfig = DEFAULT_SIMULATED_CONFIG) {}

  buildWindow(window: TimeWindow): NormalizedActivityWindow {
    const { totalActiveKcal, sampleCount } = this.config;
    const startMs = Date.parse(window.start);
    const endMs = Date.parse(window.end);
    const span = Math.max(0, endMs - startMs);
    const step = sampleCount > 0 ? span / sampleCount : 0;
    const per = sampleCount > 0 ? totalActiveKcal / sampleCount : 0;

    const samples: NormalizedActivitySample[] = [];
    for (let i = 0; i < sampleCount; i++) {
      samples.push({
        start: instant(new Date(startMs + step * i).toISOString()),
        end: instant(new Date(startMs + step * (i + 1)).toISOString()),
        activeKcal: kcal(per),
        providerId: this.id,
        sourceDevice: 'simulator',
        confidence: this.config.confidence,
        isEstimated: this.config.isEstimated,
        appearsWorn: this.config.appearsWorn,
      });
    }

    const last = samples[samples.length - 1];
    const coverage: ActivityCoverage = {
      windowStart: window.start,
      windowEnd: window.end,
      lastSampleAt: this.config.lastSampleAt ?? (last ? last.end : null),
      coveredMinutes: (span / 60000) * this.config.coverageRatio,
      gaps: [],
      coverageRatio: this.config.coverageRatio,
    };

    return { samples, coverage };
  }

  /**
   * Convenience for MVP-0 and tests: the ACTIVE ENERGY input the engine takes.
   * The simulator supplies full coverage, so the estimate is complete.
   */
  buildEstimate(window: TimeWindow): ActiveEnergyEstimate {
    const w = this.buildWindow(window);
    const observed = w.samples.reduce((sum, s) => sum + s.activeKcal, 0);
    return {
      activeKcalSoFar: kcal(observed),
      projectedRemainingActiveKcal: kcal(this.config.projectedRemainingActiveKcal),
      source: this.sourceKind,
      quality: this.config.isEstimated ? 'partially_estimated' : 'observed',
      qualityReasons: this.config.isEstimated ? ['provider_estimated_samples'] : [],
      completeness: 'complete',
      completenessGaps: [],
      unresolvedIntervals: [],
      unresolvedMinutes: 0,
      confidence: this.config.confidence,
      coverage: w.coverage,
      providerId: this.id,
      projectionPolicyVersion: 'simulated-projection@1.0.0',
      gapFillPolicyVersion: 'activity-gap-fill@1.0.0-none',
    };
  }

  async getActivity(_userId: string, window: TimeWindow): Promise<NormalizedActivityWindow> {
    return this.buildWindow(window);
  }
}

/**
 * RESERVED — contract only, deliberately not implemented.
 *
 * Users without usable wearable data get an explicit estimated-activity
 * provider, NOT a hidden PAL fallback. It will eventually consume structured
 * onboarding inputs (occupation pattern, typical steps, exercise frequency,
 * duration and type) plus the user's own history collected by MACROS.AI, and
 * will supply activeKcalSoFar and projectedRemainingActiveKcal like any other
 * provider. No physiological activity coefficients are invented here.
 */
export interface EstimatedActivityProviderContract extends EnergyActivityProvider {
  readonly sourceKind: 'onboarding_estimate' | 'historical_estimate';
}
