import { isNutrientId, type NutrientId } from './registry.js';

/**
 * USER NUTRIENT VIEW PREFERENCES.
 *
 * What the user SEES, never what the system TRACKS. Hiding a nutrient changes
 * the dashboard only — MACROS.AI keeps preserving every trustworthy value, so a
 * user who enables sodium next month gets their real history, not a gap.
 */
export const NUTRIENT_VIEW_VERSION = 'nutrient-view@1.0.0';

/**
 * The default daily view. Energy and current balance remain the PRIMARY KPI
 * above these and are not part of this list.
 */
export const DEFAULT_VISIBLE_NUTRIENTS: readonly NutrientId[] = [
  'protein', 'carbohydrate', 'fat', 'fiber',
];

/** Keeps the dashboard readable. Data capability is not limited by this. */
export const MAX_VISIBLE_NUTRIENTS = 12;

export interface NutrientViewPreferences {
  readonly userId: string;
  readonly visibleNutrients: readonly NutrientId[];
  readonly version: string;
}

export type ViewPreferenceError =
  | { readonly kind: 'unknown_nutrient'; readonly value: string }
  | { readonly kind: 'too_many'; readonly max: number };

export type ViewPreferenceResult =
  | { readonly ok: true; readonly preferences: NutrientViewPreferences }
  | { readonly ok: false; readonly error: ViewPreferenceError };

export const defaultViewPreferences = (userId: string): NutrientViewPreferences => ({
  userId,
  visibleNutrients: [...DEFAULT_VISIBLE_NUTRIENTS],
  version: NUTRIENT_VIEW_VERSION,
});

/**
 * Validate a user's selection. Only known canonical nutrients are selectable —
 * an arbitrary string is rejected rather than stored and later failing to
 * resolve.
 */
export function setVisibleNutrients(
  userId: string,
  requested: readonly string[],
): ViewPreferenceResult {
  const seen = new Set<NutrientId>();
  for (const value of requested) {
    if (!isNutrientId(value)) {
      return { ok: false, error: { kind: 'unknown_nutrient', value } };
    }
    seen.add(value);
  }
  if (seen.size > MAX_VISIBLE_NUTRIENTS) {
    return { ok: false, error: { kind: 'too_many', max: MAX_VISIBLE_NUTRIENTS } };
  }
  return {
    ok: true,
    preferences: { userId, visibleNutrients: [...seen], version: NUTRIENT_VIEW_VERSION },
  };
}

/** Preferences apply ONLY to their own subject. */
export const visibleFor = (
  userId: string,
  preferences: NutrientViewPreferences | null,
): readonly NutrientId[] =>
  preferences !== null && preferences.userId === userId
    ? preferences.visibleNutrients
    : DEFAULT_VISIBLE_NUTRIENTS;
