/**
 * RECOMMENDATION POLICY.
 *
 * Every weight and threshold lives here, versioned and typed. These are
 * PRODUCT POLICY — deliberate choices about what MACROS.AI suggests — and not
 * physiological truth. Nothing here is a clinical claim.
 */
export const RECOMMENDATION_POLICY_VERSION = 'recommendation-policy@1.0.0';

export interface RecommendationPolicy {
  readonly version: string;

  /** Relative influence of each scoring component. Bounded and documented. */
  readonly weights: {
    /** How well the candidate's macro profile matches the day's macro gaps. */
    readonly macroFit: number;
    /** Whether a proposed portion fits the remaining energy budget. */
    readonly energyFit: number;
    /** Small nudge for foods this user has logged recently. */
    readonly historyNudge: number;
    /** Small nudge for explicitly preferred foods. */
    readonly preferenceNudge: number;
  };

  /** Penalties, subtracted after weighting. */
  readonly penalties: {
    /** Applied proportionally when a proposed portion exceeds remaining energy. */
    readonly energyOvershoot: number;
    /** Applied when a proposed portion exceeds a remaining macro. */
    readonly macroOvershoot: number;
    /** Discourages proposing the same food the user just logged repeatedly. */
    readonly repetition: number;
  };

  /**
   * HARD eligibility bounds — distinct from soft penalties above. A candidate
   * breaching these is removed, not merely ranked lower.
   */
  readonly bounds: {
    /** A proposed portion may not exceed remaining energy by more than this. */
    readonly maxEnergyOvershootRatio: number;
    /** Portion proposals are clamped to sane physical limits. */
    readonly minPortionGrams: number;
    readonly maxPortionGrams: number;
  };

  /** Portion proposals derived from the user's own logged history. */
  readonly history: {
    /** Below this many usable observations, no history portion is proposed. */
    readonly minPortionSamples: number;
    /** Only logs within this many days count. */
    readonly windowDays: number;
    /** Logs within this window count toward the recency nudge. */
    readonly recencyWindowDays: number;
  };

  /**
   * Deterministic multiples of a source-backed serving mass.
   * These are source-GROUNDED candidate quantities, not optimal amounts.
   */
  readonly servingMultiples: readonly number[];

  /** How many recommendations are returned for presentation. */
  readonly maxResults: number;
}

export const DEFAULT_RECOMMENDATION_POLICY: RecommendationPolicy = {
  version: RECOMMENDATION_POLICY_VERSION,
  weights: { macroFit: 1.0, energyFit: 0.4, historyNudge: 0.12, preferenceNudge: 0.15 },
  penalties: { energyOvershoot: 0.8, macroOvershoot: 0.3, repetition: 0.2 },
  bounds: { maxEnergyOvershootRatio: 1.25, minPortionGrams: 5, maxPortionGrams: 500 },
  history: { minPortionSamples: 3, windowDays: 30, recencyWindowDays: 7 },
  servingMultiples: [0.5, 1, 1.5, 2],
  maxResults: 5,
};
