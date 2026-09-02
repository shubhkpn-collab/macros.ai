import type { ProductVersion } from '@macros/contracts';
import { calculateNutrition } from '@macros/domain-nutrition';
import type { Grams } from '@macros/contracts';

/**
 * NUTRITIONAL ROLE — what part a food plays in a meal.
 *
 * Derived from authoritative nutrition only. There is no name matching and no
 * blacklist: the role of a food is a fact about its macros, so any food with
 * chicken's profile plays chicken's role.
 *
 * Roles exist so the planner can reason about COMPLEMENT. INT-3's structural
 * limit was that a single food had to solve every macro gap at once, which is
 * why mathematically optimal but odd records kept winning. Two ordinary foods
 * with complementary roles usually serve a real person better.
 */
export const ROLE_MODEL_VERSION = 'nutritional-role@1.0.0';

export type NutritionalRole =
  | 'protein_forward'
  | 'carbohydrate_forward'
  | 'fat_forward'
  | 'balanced'
  /** Low energy density; fills a plate without spending much budget. */
  | 'light_accompaniment'
  | 'unknown';

export interface RoleAssessment {
  readonly role: NutritionalRole;
  /** Share of macro energy from each macro, for auditability. */
  readonly shares: { protein: number; carbohydrate: number; fat: number };
  readonly kcalPer100g: number;
  readonly version: string;
}

/** A macro must carry at least this share of energy to define the role. */
const DOMINANCE = 0.45;
/** Below this energy density a food is an accompaniment, whatever its shares. */
const LIGHT_KCAL_PER_100G = 60;

/**
 * Classify a food's role.
 *
 * Energy comes from `calculateNutrition`, never from local arithmetic — the
 * engine must not become a second nutrition calculator, which is exactly the
 * defect INT-3 corrected.
 */
export function assessRole(v: ProductVersion): RoleAssessment {
  const totals = calculateNutrition(v.basis, 100 as unknown as Grams).totals;
  const kcal = totals.kcal as unknown as number;
  const p = (totals.proteinG as unknown as number) * 4;
  const c = (totals.carbohydrateG as unknown as number) * 4;
  const f = (totals.fatG as unknown as number) * 9;
  const total = p + c + f;

  if (!Number.isFinite(total) || total <= 0) {
    return {
      role: 'unknown', shares: { protein: 0, carbohydrate: 0, fat: 0 },
      kcalPer100g: Number.isFinite(kcal) ? kcal : 0, version: ROLE_MODEL_VERSION,
    };
  }

  const shares = { protein: p / total, carbohydrate: c / total, fat: f / total };

  // Density is checked BEFORE dominance: a lettuce leaf is technically
  // carbohydrate-forward, but calling it a carbohydrate component would be
  // misleading when it supplies almost no energy.
  if (kcal < LIGHT_KCAL_PER_100G) {
    return { role: 'light_accompaniment', shares, kcalPer100g: kcal, version: ROLE_MODEL_VERSION };
  }

  const role: NutritionalRole =
    shares.protein >= DOMINANCE ? 'protein_forward'
    : shares.carbohydrate >= DOMINANCE ? 'carbohydrate_forward'
    : shares.fat >= DOMINANCE ? 'fat_forward'
    : 'balanced';

  return { role, shares, kcalPer100g: kcal, version: ROLE_MODEL_VERSION };
}

/** The role that would address a given macro gap. */
export const roleForMacro = (macro: 'protein' | 'carbohydrate' | 'fat'): NutritionalRole =>
  macro === 'protein' ? 'protein_forward'
  : macro === 'carbohydrate' ? 'carbohydrate_forward' : 'fat_forward';
