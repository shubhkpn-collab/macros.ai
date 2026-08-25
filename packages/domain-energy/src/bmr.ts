import {
  deriveFatFreeMassKg,
  kcal,
  unwrap,
  validateUserProfile,
  type BmrMethod,
  type BmrPolicy,
  type Kcal,
  type UserProfileSnapshot,
} from '@macros/contracts';

/**
 * LOCKED: Mifflin-St Jeor is the default production BMR method.
 *
 * The presence of a body-fat number is NOT sufficient to switch equations.
 * Katch-McArdle is implemented and tested, but is selected only when the
 * versioned policy explicitly permits it for that measurement source.
 */
/**
 * Development default. Locked equation selection, not an externally reviewed
 * production policy — see reviewStatus below.
 */
export const DEFAULT_BMR_POLICY: BmrPolicy = {
  version: 'bmr@1.0.0',
  provenance: 'APPROVED_PRODUCTION',
  // NOT self-approved. Mifflin-St Jeor is the equation SELECTED for
  // implementation; that is a different fact from the production product policy
  // having been reviewed by a qualified external reviewer. It therefore stays
  // PENDING_EXTERNAL_REVIEW and does not pass the production policy firewall.
  reviewStatus: 'PENDING_EXTERNAL_REVIEW',
  defaultMethod: 'mifflin_st_jeor',
  // Empty: no measurement source currently permits Katch-McArdle in production.
  katchMcArdlePermittedSources: [],
};

export interface BmrResult {
  readonly bmrKcal: Kcal;
  readonly method: BmrMethod;
  readonly policyVersion: string;
  /** True when body fat was present but policy declined to switch equations. */
  readonly bodyFatAvailableButUnused: boolean;
}

export function mifflinStJeor(p: UserProfileSnapshot): number {
  const base = 10 * p.bodyWeightKg + 6.25 * p.heightCm - 5 * p.ageYears;
  return p.sex === 'male' ? base + 5 : base - 161;
}

export function katchMcArdle(fatFreeMassKg: number): number {
  return 370 + 21.6 * fatFreeMassKg;
}

export function selectBmrMethod(p: UserProfileSnapshot, policy: BmrPolicy): BmrMethod {
  if (policy.defaultMethod === 'katch_mcardle') return 'katch_mcardle';
  const source = p.bodyFatMeasurementSource;
  const ffm = deriveFatFreeMassKg(p);
  if (ffm !== undefined && source !== undefined && policy.katchMcArdlePermittedSources.includes(source)) {
    return 'katch_mcardle';
  }
  return 'mifflin_st_jeor';
}

export function calculateBmr(
  profile: UserProfileSnapshot,
  policy: BmrPolicy = DEFAULT_BMR_POLICY,
): BmrResult {
  unwrap(validateUserProfile(profile));
  const method = selectBmrMethod(profile, policy);
  const ffm = deriveFatFreeMassKg(profile);

  let value: number;
  if (method === 'katch_mcardle') {
    if (ffm === undefined) {
      throw new Error('calculateBmr: katch_mcardle selected without valid fat-free mass');
    }
    value = katchMcArdle(ffm);
  } else {
    value = mifflinStJeor(profile);
  }

  return {
    bmrKcal: kcal(value),
    method,
    policyVersion: policy.version,
    bodyFatAvailableButUnused: ffm !== undefined && method !== 'katch_mcardle',
  };
}
