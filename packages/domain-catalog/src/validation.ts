import type { NormalizedCandidate } from './raw-record.js';

/**
 * A malformed record never crashes the batch and never silently publishes.
 * Every record lands in exactly one bucket, with a machine-readable reason.
 */
export type CandidateOutcome = 'accepted' | 'rejected' | 'needs_curation';

export type CandidateReason =
  | 'ok'
  | 'missing_required_macro'
  | 'missing_energy'
  | 'non_finite_nutrient'
  | 'negative_nutrient'
  | 'implausible_nutrient'
  | 'ambiguous_preparation_state'
  | 'invalid_source_identity'
  | 'missing_display_name'
  | 'mass_balance_exceeded'
  | 'atwater_discrepancy'
  | 'curator_rejected'
  | 'awaiting_curation'
  | 'identifier_conflict'
  | 'invalid_identifier'
  | 'missing_serving_mass'
  | 'source_conflict';

export interface CandidateAssessment {
  readonly outcome: CandidateOutcome;
  readonly reasons: readonly CandidateReason[];
  /** Advisory quality signals. NEVER used to overwrite source values. */
  readonly flags: readonly CandidateReason[];
}

const REQUIRED_MACROS = ['proteinG', 'carbohydrateG', 'fatG'] as const;

/** Atwater is a QUALITY FLAG. It never replaces source-declared energy. */
export function atwaterDeltaFraction(c: NormalizedCandidate): number | null {
  const { kcal, proteinG, carbohydrateG, fatG } = c.per100g;
  if (kcal === undefined || proteinG === undefined || carbohydrateG === undefined || fatG === undefined) {
    return null;
  }
  const implied = proteinG * 4 + carbohydrateG * 4 + fatG * 9;
  if (kcal <= 0) return implied > 0 ? 1 : 0;
  return Math.abs(kcal - implied) / kcal;
}

export function assessCandidate(c: NormalizedCandidate): CandidateAssessment {
  const reasons: CandidateReason[] = [];
  const flags: CandidateReason[] = [];

  if (c.raw.sourceRecordId.trim().length === 0) reasons.push('invalid_source_identity');
  if (c.displayName.trim().length === 0) reasons.push('missing_display_name');

  const values = Object.entries(c.per100g) as [string, number | undefined][];
  for (const [name, value] of values) {
    if (value === undefined) continue;
    if (!Number.isFinite(value)) {
      reasons.push('non_finite_nutrient');
    } else if (value < 0) {
      reasons.push('negative_nutrient');
    }
  }

  // A missing nutrient is missing. It is never defaulted to zero, because zero
  // is a claim about the food and absence is a claim about our knowledge.
  if (c.per100g.kcal === undefined) reasons.push('missing_energy');
  for (const macro of REQUIRED_MACROS) {
    if (c.per100g[macro] === undefined) {
      reasons.push('missing_required_macro');
      break;
    }
  }

  const mass =
    (c.per100g.proteinG ?? 0) + (c.per100g.carbohydrateG ?? 0) + (c.per100g.fatG ?? 0);
  if (Number.isFinite(mass) && mass > 100.5) reasons.push('mass_balance_exceeded');

  if ((c.per100g.kcal ?? 0) > 900) reasons.push('implausible_nutrient');

  const delta = atwaterDeltaFraction(c);
  if (delta !== null && delta > 0.25) flags.push('atwater_discrepancy');

  if (reasons.length > 0) {
    return { outcome: 'rejected', reasons, flags };
  }

  // An unresolved preparation state is never silently published as an assumption.
  if (c.preparationState === 'unresolved') {
    return { outcome: 'needs_curation', reasons: ['ambiguous_preparation_state'], flags };
  }

  return { outcome: 'accepted', reasons: ['ok'], flags };
}
