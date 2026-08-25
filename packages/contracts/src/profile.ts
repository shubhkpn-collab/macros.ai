import type { Centimetres, Instant, Kilograms, Sex, Years } from './primitives.js';

/**
 * Effective-dated snapshot of the user's body profile.
 *
 * SINGLE SOURCE. BMR and TEF are both derived from this one snapshot so that
 * age, sex, weight and height cannot disagree between the two calculations
 * inside a single engine call.
 */
export interface UserProfileSnapshot {
  /**
   * The subject this profile describes. Binding identity here — rather than
   * passing a userId alongside a model — makes it structurally impossible to
   * run user A's food through user B's metabolic profile.
   */
  readonly userId: string;
  readonly profileVersionId: string;
  readonly effectiveFrom: Instant;
  readonly ageYears: Years;
  readonly sex: Sex;
  readonly bodyWeightKg: Kilograms;
  readonly heightCm: Centimetres;

  /** Optional. Presence alone never changes the BMR equation — see BmrPolicy. */
  readonly bodyFatPercent?: number;
  readonly bodyFatMeasurementSource?: BodyFatMeasurementSource;
}

export type BodyFatMeasurementSource =
  | 'self_reported'
  | 'bioimpedance_consumer'
  | 'bioimpedance_clinical'
  | 'skinfold'
  | 'dexa'
  | 'bodpod';

/** Plausibility band. Values outside are rejected, never clamped. */
export const BODY_FAT_VALID_PERCENT = { min: 3, max: 60 } as const;

export const AGE_VALID_YEARS = { min: 18, max: 120 } as const;
export const WEIGHT_VALID_KG = { min: 25, max: 400 } as const;
export const HEIGHT_VALID_CM = { min: 100, max: 250 } as const;

/**
 * The subset of the profile the TEF model may consider.
 * Derived internally from UserProfileSnapshot — never passed independently.
 */
export interface TefProfile {
  readonly ageYears: Years;
  readonly sex: Sex;
  readonly bodyWeightKg: Kilograms;
  readonly heightCm: Centimetres;
  readonly bodyFatPercent?: number;
  /** Derived only when body fat is present and valid. Undefined, never zero. */
  readonly fatFreeMassKg?: Kilograms;
  /** Reserved for future evidence-supported personalisation. Unused. */
  readonly metabolicProfile?: Readonly<Record<string, never>>;
}
