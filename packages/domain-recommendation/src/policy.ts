/**
 * RECOMMENDATION POLICY.
 *
 * Every weight and threshold lives here, versioned and typed. These are
 * PRODUCT POLICY — deliberate choices about what MACROS.AI suggests — and not
 * physiological truth. Nothing here is a clinical claim.
 */
/**
 * Bumped for INT-2. v1.0.0 scored macro fit by ENERGY SHARE, which measures a
 * food's composition rather than what it contributes to the user's actual
 * deficit — so trace protein in black coffee scored a perfect protein fit.
 * v2.0.0 scores absolute contribution against the remaining gap.
 */
export const RECOMMENDATION_POLICY_VERSION = 'recommendation-policy@3.0.0';

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
    /**
     * CONSUMER ACTIONABILITY. Bounded well below `macroFit` on purpose: a
     * familiar food with a materially poor nutritional fit must never beat a
     * nutritionally strong one just for being ordinary. It breaks ties among
     * candidates that all solve the user's state reasonably well.
     */
    readonly actionability: number;
  };

  /**
   * RANKING COMPARISON BASIS — NOT a portion.
   *
   * Every catalog food carries an authoritative per-100 g nutrient basis, which
   * makes candidates comparable even when no defensible serving mass exists.
   * Using it to RANK is legitimate; presenting it as an amount to eat is not,
   * and the two must never be conflated. A `portionProposal` still requires
   * source-backed serving grams or sufficient user history.
   */
  readonly comparison: {
    /** Standard mass used only to compare candidates against each other. */
    readonly basisGrams: number;
    /**
     * Grams of a macro, per comparison basis, below which a contribution is
     * treated as nutritionally negligible. This is what stops trace amounts
     * masquerading as a strong fit — expressed per macro because 3 g of fat and
     * 3 g of carbohydrate are not equally meaningful.
     */
    readonly minMeaningfulGrams: {
      readonly protein: number;
      readonly carbohydrate: number;
      readonly fat: number;
    };
    /**
     * Fraction of a remaining gap that a comparison-basis amount must close to
     * count as fully addressing it. Closure saturates here, so an enormous
     * nutrient amount cannot produce an unbounded score.
     */
    readonly fullClosureFraction: number;
    /**
     * Fraction of the remaining energy budget a candidate should use to be
     * considered fully useful. Prevents "fewest calories wins": a zero-energy
     * food makes no progress and scores zero, not maximum.
     */
    readonly usefulEnergyFraction: number;
  };

  /** Penalties, subtracted after weighting. */
  readonly penalties: {
    /** Applied proportionally when a proposed portion exceeds remaining energy. */
    readonly energyOvershoot: number;
    /** Applied when a proposed portion exceeds a remaining macro. */
    readonly macroOvershoot: number;
    /** Discourages proposing the same food the user just logged repeatedly. */
    readonly repetition: number;
    /**
     * Applied when a candidate adds a material amount of a macro the user has
     * already exhausted. Scaled by the macro TARGET rather than the remaining
     * amount, because remaining is zero or negative here and dividing by it
     * would be a divide-by-zero hack rather than a bounded rule.
     */
    readonly exhaustedMacro: number;
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
    /**
     * How nutritionally close an actionable candidate must be to a
     * low-actionability leader before it is promoted. At 0.85 a food must
     * deliver at least 85% of the leader's score, so a familiar food with a
     * materially worse fit can never displace a strong one. MEASURED TENSION: at 0.85 every hard closure
     * requirement passes and independent macro fit is 85%; at 0.93 macro fit
     * recovers to 86.7% but low-actionability winners return at 3.1%. Hard
     * requirements win, so 0.85 stands and the residual cost is reported.
     */
    readonly actionabilityPromotionRatio: number;
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
  weights: {
    macroFit: 1.0, energyFit: 0.4, historyNudge: 0.12,
    preferenceNudge: 0.15,
    // A small tie-breaker ONLY. The heavy lifting is done by the actionability
    // GATE in the ranking step; blending a large weight here was measured to
    // degrade nutritional fit, which the milestone forbids.
    actionability: 0.08,
  },
  comparison: {
    basisGrams: 100,
    // A food supplying under these amounts per 100 g does not meaningfully move
    // that macro. Black coffee carries ~0.1 g protein per 100 g.
    minMeaningfulGrams: { protein: 3, carbohydrate: 5, fat: 2 },
    fullClosureFraction: 0.5,
    usefulEnergyFraction: 0.25,
  },
  penalties: {
        energyOvershoot: 0.8, macroOvershoot: 0.3, repetition: 0.2,
    // Decisive rather than merely discouraging: macroFit is weighted 1.0, so a
    // food that closes the dominant gap perfectly would otherwise still win
    // while piling onto a macro the user has already exhausted.
    exhaustedMacro: 1.4,
  },
  bounds: {
    maxEnergyOvershootRatio: 1.25, minPortionGrams: 5, maxPortionGrams: 500,
    actionabilityPromotionRatio: 0.85,
  },
  history: { minPortionSamples: 3, windowDays: 30, recencyWindowDays: 7 },
  servingMultiples: [0.5, 1, 1.5, 2],
  maxResults: 5,
};
