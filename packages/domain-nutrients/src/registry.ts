/**
 * CANONICAL NUTRIENT REGISTRY.
 *
 * MACROS.AI is not a four-number tracker. Any nutrient an authoritative source
 * reports can be preserved, canonicalized and tracked; what the user SEES is a
 * separate choice from what the system KNOWS.
 *
 * Identity rules:
 *   - Internal ids are stable MACROS.AI strings, never display names and never
 *     a source's ids. A USDA nutrient id belongs in provenance, not identity —
 *     otherwise changing source would change the meaning of stored history.
 *   - Every nutrient declares ONE canonical unit. Values in different units are
 *     never summed or compared without an explicit, tested conversion.
 */

export const NUTRIENT_REGISTRY_VERSION = 'nutrient-registry@1.0.0';

/** Units MACROS.AI understands. No unit outside this set may be stored. */
export type NutrientUnit = 'kcal' | 'g' | 'mg' | 'ug' | 'IU';

export type NutrientClass = 'energy' | 'macro' | 'mineral' | 'vitamin' | 'other';

export interface NutrientDefinition {
  readonly id: NutrientId;
  readonly displayName: string;
  readonly unit: NutrientUnit;
  readonly nutrientClass: NutrientClass;
  /** Core nutrients drive energy/macro arithmetic and are always tracked. */
  readonly core: boolean;
}

export type NutrientId =
  | 'energy_kcal' | 'protein' | 'carbohydrate' | 'fat'
  | 'fiber' | 'total_sugars' | 'added_sugars' | 'saturated_fat' | 'cholesterol'
  | 'sodium' | 'potassium' | 'calcium' | 'iron' | 'magnesium' | 'phosphorus'
  | 'zinc' | 'selenium' | 'copper' | 'manganese'
  | 'vitamin_a' | 'vitamin_c' | 'vitamin_d' | 'vitamin_e' | 'vitamin_k'
  | 'thiamin' | 'riboflavin' | 'niacin' | 'pantothenic_acid'
  | 'vitamin_b6' | 'folate' | 'vitamin_b12' | 'choline'
  | 'water';

const def = (
  id: NutrientId, displayName: string, unit: NutrientUnit,
  nutrientClass: NutrientClass, core = false,
): NutrientDefinition => ({ id, displayName, unit, nutrientClass, core });

export const NUTRIENTS: readonly NutrientDefinition[] = [
  def('energy_kcal', 'Calories', 'kcal', 'energy', true),
  def('protein', 'Protein', 'g', 'macro', true),
  def('carbohydrate', 'Carbohydrates', 'g', 'macro', true),
  def('fat', 'Fat', 'g', 'macro', true),

  def('fiber', 'Fiber', 'g', 'macro'),
  def('total_sugars', 'Total sugars', 'g', 'macro'),
  // Registered but only ever populated where a source explicitly declares it.
  def('added_sugars', 'Added sugars', 'g', 'macro'),
  def('saturated_fat', 'Saturated fat', 'g', 'macro'),
  def('cholesterol', 'Cholesterol', 'mg', 'other'),
  def('water', 'Water', 'g', 'other'),

  def('sodium', 'Sodium', 'mg', 'mineral'),
  def('potassium', 'Potassium', 'mg', 'mineral'),
  def('calcium', 'Calcium', 'mg', 'mineral'),
  def('iron', 'Iron', 'mg', 'mineral'),
  def('magnesium', 'Magnesium', 'mg', 'mineral'),
  def('phosphorus', 'Phosphorus', 'mg', 'mineral'),
  def('zinc', 'Zinc', 'mg', 'mineral'),
  def('selenium', 'Selenium', 'ug', 'mineral'),
  def('copper', 'Copper', 'mg', 'mineral'),
  def('manganese', 'Manganese', 'mg', 'mineral'),

  def('vitamin_a', 'Vitamin A', 'ug', 'vitamin'),
  def('vitamin_c', 'Vitamin C', 'mg', 'vitamin'),
  def('vitamin_d', 'Vitamin D', 'ug', 'vitamin'),
  def('vitamin_e', 'Vitamin E', 'mg', 'vitamin'),
  def('vitamin_k', 'Vitamin K', 'ug', 'vitamin'),
  def('thiamin', 'Thiamin (B1)', 'mg', 'vitamin'),
  def('riboflavin', 'Riboflavin (B2)', 'mg', 'vitamin'),
  def('niacin', 'Niacin (B3)', 'mg', 'vitamin'),
  def('pantothenic_acid', 'Pantothenic acid (B5)', 'mg', 'vitamin'),
  def('vitamin_b6', 'Vitamin B6', 'mg', 'vitamin'),
  def('folate', 'Folate (B9)', 'ug', 'vitamin'),
  def('vitamin_b12', 'Vitamin B12', 'ug', 'vitamin'),
  def('choline', 'Choline', 'mg', 'vitamin'),
];

const BY_ID = new Map<string, NutrientDefinition>(NUTRIENTS.map((n) => [n.id, n]));

export const isNutrientId = (v: unknown): v is NutrientId =>
  typeof v === 'string' && BY_ID.has(v);

export const nutrientDefinition = (id: NutrientId): NutrientDefinition => {
  const d = BY_ID.get(id);
  if (d === undefined) throw new Error(`unknown nutrient id: ${id}`);
  return d;
};

export const CORE_NUTRIENTS: readonly NutrientId[] =
  NUTRIENTS.filter((n) => n.core).map((n) => n.id);

/**
 * UNIT CONVERSION.
 *
 * Only mass conversions within the metric ladder are permitted, and only
 * between explicitly related units. IU is deliberately NOT convertible: the
 * IU→µg factor differs per substance (vitamin A from retinol vs beta-carotene,
 * D2 vs D3), so a generic conversion would silently fabricate values.
 */
const MASS_IN_GRAMS: Readonly<Record<string, number>> = { g: 1, mg: 1e-3, ug: 1e-6 };

export type ConversionResult =
  | { readonly ok: true; readonly amount: number }
  | { readonly ok: false; readonly reason: 'incompatible_units' | 'unsupported_unit' };

export function convertAmount(
  amount: number,
  from: NutrientUnit,
  to: NutrientUnit,
): ConversionResult {
  if (from === to) return { ok: true, amount };
  if (from === 'kcal' || to === 'kcal') return { ok: false, reason: 'incompatible_units' };
  // Refused on purpose — see the note above.
  if (from === 'IU' || to === 'IU') return { ok: false, reason: 'incompatible_units' };

  const f = MASS_IN_GRAMS[from];
  const t = MASS_IN_GRAMS[to];
  if (f === undefined || t === undefined) return { ok: false, reason: 'unsupported_unit' };

  // Round to a stable precision so repeated conversions do not drift.
  const converted = (amount * f) / t;
  return { ok: true, amount: Math.round(converted * 1e9) / 1e9 };
}
