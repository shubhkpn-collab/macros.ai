import {
  buildNutrientMap, normalizeUnit,
  type NutrientBuildIssue, type NutrientId, type RawNutrientReading,
} from '@macros/domain-nutrients';

/**
 * USDA FoodData Central adapter — Foundation Foods and SR Legacy.
 *
 * Built against the ACTUAL inspected schema of the supplied archives, not from
 * remembered nutrient ids. Every mapping below was verified to exist, with the
 * unit the source really uses.
 *
 * LICENSING: FDC is U.S. Government public domain (CC0). Only FDC is ingested.
 */

export const USDA_ADAPTER_VERSION = 'usda-fdc-adapter@1.0.0';

export interface UsdaNutrientMapping {
  /** USDA `nutrient.id` — SOURCE identity, never MACROS.AI identity. */
  readonly usdaId: number;
  readonly usdaName: string;
  readonly sourceUnit: string;
  readonly canonical: NutrientId;
  /** Higher wins when two USDA rows map to one canonical nutrient. */
  readonly precedence: number;
  readonly note?: string;
}

/**
 * THE MAPPING TABLE.
 *
 * Deliberate exclusions:
 *  - USDA 1062 "Energy" is kJ. Only 1008 (kcal) is energy. Taking the wrong one
 *    would inflate every calorie by ~4.184×.
 *  - 1104 "Vitamin A, IU" and 1110 "Vitamin D, IU" are excluded: IU→µg differs
 *    per substance, so the µg rows (1106, 1114) are the only defensible source.
 *  - 1190 "Folate, DFE" is a different quantity from total folate; 1177 is used.
 */
export const USDA_NUTRIENT_MAP: readonly UsdaNutrientMapping[] = [
  { usdaId: 1008, usdaName: 'Energy', sourceUnit: 'kcal', canonical: 'energy_kcal', precedence: 10 },
  { usdaId: 2047, usdaName: 'Energy (Atwater General Factors)', sourceUnit: 'kcal', canonical: 'energy_kcal', precedence: 1, note: 'fallback only' },
  { usdaId: 1003, usdaName: 'Protein', sourceUnit: 'g', canonical: 'protein', precedence: 10 },
  { usdaId: 1005, usdaName: 'Carbohydrate, by difference', sourceUnit: 'g', canonical: 'carbohydrate', precedence: 10 },
  { usdaId: 1004, usdaName: 'Total lipid (fat)', sourceUnit: 'g', canonical: 'fat', precedence: 10 },

  { usdaId: 1079, usdaName: 'Fiber, total dietary', sourceUnit: 'g', canonical: 'fiber', precedence: 10 },
  { usdaId: 2033, usdaName: 'Total dietary fiber (AOAC 2011.25)', sourceUnit: 'g', canonical: 'fiber', precedence: 5 },
  { usdaId: 2000, usdaName: 'Total Sugars', sourceUnit: 'g', canonical: 'total_sugars', precedence: 10 },
  { usdaId: 1063, usdaName: 'Sugars, Total', sourceUnit: 'g', canonical: 'total_sugars', precedence: 5 },
  { usdaId: 1258, usdaName: 'Fatty acids, total saturated', sourceUnit: 'g', canonical: 'saturated_fat', precedence: 10 },
  { usdaId: 1253, usdaName: 'Cholesterol', sourceUnit: 'mg', canonical: 'cholesterol', precedence: 10 },
  { usdaId: 1051, usdaName: 'Water', sourceUnit: 'g', canonical: 'water', precedence: 10 },

  { usdaId: 1093, usdaName: 'Sodium, Na', sourceUnit: 'mg', canonical: 'sodium', precedence: 10 },
  { usdaId: 1092, usdaName: 'Potassium, K', sourceUnit: 'mg', canonical: 'potassium', precedence: 10 },
  { usdaId: 1087, usdaName: 'Calcium, Ca', sourceUnit: 'mg', canonical: 'calcium', precedence: 10 },
  { usdaId: 1089, usdaName: 'Iron, Fe', sourceUnit: 'mg', canonical: 'iron', precedence: 10 },
  { usdaId: 1090, usdaName: 'Magnesium, Mg', sourceUnit: 'mg', canonical: 'magnesium', precedence: 10 },
  { usdaId: 1091, usdaName: 'Phosphorus, P', sourceUnit: 'mg', canonical: 'phosphorus', precedence: 10 },
  { usdaId: 1095, usdaName: 'Zinc, Zn', sourceUnit: 'mg', canonical: 'zinc', precedence: 10 },
  { usdaId: 1103, usdaName: 'Selenium, Se', sourceUnit: 'µg', canonical: 'selenium', precedence: 10 },
  { usdaId: 1098, usdaName: 'Copper, Cu', sourceUnit: 'mg', canonical: 'copper', precedence: 10 },
  { usdaId: 1101, usdaName: 'Manganese, Mn', sourceUnit: 'mg', canonical: 'manganese', precedence: 10 },

  { usdaId: 1106, usdaName: 'Vitamin A, RAE', sourceUnit: 'µg', canonical: 'vitamin_a', precedence: 10 },
  { usdaId: 1162, usdaName: 'Vitamin C, total ascorbic acid', sourceUnit: 'mg', canonical: 'vitamin_c', precedence: 10 },
  { usdaId: 1114, usdaName: 'Vitamin D (D2 + D3)', sourceUnit: 'µg', canonical: 'vitamin_d', precedence: 10 },
  { usdaId: 1109, usdaName: 'Vitamin E (alpha-tocopherol)', sourceUnit: 'mg', canonical: 'vitamin_e', precedence: 10 },
  { usdaId: 1185, usdaName: 'Vitamin K (phylloquinone)', sourceUnit: 'µg', canonical: 'vitamin_k', precedence: 10 },
  { usdaId: 1165, usdaName: 'Thiamin', sourceUnit: 'mg', canonical: 'thiamin', precedence: 10 },
  { usdaId: 1166, usdaName: 'Riboflavin', sourceUnit: 'mg', canonical: 'riboflavin', precedence: 10 },
  { usdaId: 1167, usdaName: 'Niacin', sourceUnit: 'mg', canonical: 'niacin', precedence: 10 },
  { usdaId: 1170, usdaName: 'Pantothenic acid', sourceUnit: 'mg', canonical: 'pantothenic_acid', precedence: 10 },
  { usdaId: 1175, usdaName: 'Vitamin B-6', sourceUnit: 'mg', canonical: 'vitamin_b6', precedence: 10 },
  { usdaId: 1177, usdaName: 'Folate, total', sourceUnit: 'µg', canonical: 'folate', precedence: 10 },
  { usdaId: 1178, usdaName: 'Vitamin B-12', sourceUnit: 'µg', canonical: 'vitamin_b12', precedence: 10 },
  { usdaId: 1180, usdaName: 'Choline, total', sourceUnit: 'mg', canonical: 'choline', precedence: 10 },
];

const BY_USDA_ID = new Map<number, UsdaNutrientMapping>(
  USDA_NUTRIENT_MAP.map((m) => [m.usdaId, m]),
);

/** USDA ids that exist but are deliberately NOT mapped, with the reason. */
export const DELIBERATELY_UNMAPPED: Readonly<Record<number, string>> = {
  1062: 'Energy in kJ — kcal (1008) is the canonical energy source',
  1104: 'Vitamin A in IU — IU to µg differs by substance; 1106 (RAE) is used',
  1110: 'Vitamin D in IU — IU to µg differs by D2/D3; 1114 (µg) is used',
  1190: 'Folate DFE — a different quantity from total folate (1177)',
  1187: 'Folate, food — a component of total folate (1177)',
  1105: 'Retinol — a component of Vitamin A RAE (1106)',
  1242: 'Vitamin E, added — a component, not total Vitamin E',
  1007: 'Ash — not a tracked nutrient',
};

export interface UsdaFoodNutrient {
  readonly nutrient?: {
    readonly id?: number;
    readonly number?: string;
    readonly name?: string;
    readonly unitName?: string;
  };
  readonly amount?: number;
}

export interface UsdaFoodRecord {
  readonly fdcId?: number;
  readonly description?: string;
  readonly dataType?: string;
  readonly foodCategory?: { readonly description?: string };
  readonly publicationDate?: string;
  readonly foodNutrients?: readonly UsdaFoodNutrient[];
  readonly ndbNumber?: number;
}

export interface UsdaExtraction {
  readonly fdcId: number;
  readonly description: string;
  readonly dataType: string;
  readonly category: string | null;
  readonly publicationDate: string | null;
  readonly readings: readonly RawNutrientReading[];
  readonly unmappedUsdaIds: readonly number[];
  readonly issues: readonly NutrientBuildIssue[];
}

export type UsdaExtractionOutcome =
  | { readonly ok: true; readonly extraction: UsdaExtraction }
  | { readonly ok: false; readonly reason: 'malformed_record' | 'missing_identity' };

/**
 * Extract one USDA record into canonical readings.
 *
 * Records are real-world data: the archives contain null entries and records
 * with absent nutrient blocks, so every field is checked rather than assumed.
 */
export function extractUsdaRecord(record: unknown): UsdaExtractionOutcome {
  if (record === null || typeof record !== 'object') {
    return { ok: false, reason: 'malformed_record' };
  }
  const r = record as UsdaFoodRecord;
  if (typeof r.fdcId !== 'number' || typeof r.description !== 'string' || r.description.length === 0) {
    return { ok: false, reason: 'missing_identity' };
  }

  const readings: RawNutrientReading[] = [];
  const unmapped: number[] = [];

  for (const fn of r.foodNutrients ?? []) {
    const n = fn?.nutrient;
    if (n === undefined || typeof n.id !== 'number') continue;
    if (typeof fn.amount !== 'number' || !Number.isFinite(fn.amount)) continue;

    const mapping = BY_USDA_ID.get(n.id);
    if (mapping === undefined) {
      if (DELIBERATELY_UNMAPPED[n.id] === undefined) unmapped.push(n.id);
      continue;
    }

    const sourceUnit = n.unitName ?? mapping.sourceUnit;
    // The unit the archive actually carries must match what we mapped against.
    // A source that silently changes units is a curation event, not a guess.
    if (normalizeUnit(sourceUnit) !== normalizeUnit(mapping.sourceUnit)) {
      continue;
    }

    readings.push({
      nutrientId: mapping.canonical,
      amount: fn.amount,
      unit: sourceUnit,
      precedence: mapping.precedence,
      source: {
        sourceNutrientId: String(n.id),
        sourceNutrientName: n.name ?? mapping.usdaName,
        sourceUnit,
        sourceAmount: fn.amount,
      },
    });
  }

  const { issues } = buildNutrientMap(readings);

  return {
    ok: true,
    extraction: {
      fdcId: r.fdcId,
      description: r.description,
      dataType: r.dataType ?? 'unknown',
      category: r.foodCategory?.description ?? null,
      publicationDate: r.publicationDate ?? null,
      readings,
      unmappedUsdaIds: unmapped,
      issues,
    },
  };
}

/**
 * Preparation state, inferred ONLY from explicit description wording.
 *
 * USDA descriptions state preparation plainly ("raw", "cooked, boiled"). When
 * the description says nothing, the answer is `unresolved` — routed to curation
 * rather than guessed, because raw and cooked differ materially per 100 g and
 * MACROS.AI never applies a yield conversion.
 */
export function inferPreparationState(
  description: string,
): 'raw' | 'cooked' | 'unresolved' {
  const d = description.toLowerCase();
  if (/\braw\b/.test(d)) return 'raw';
  if (/\b(cooked|boiled|roasted|grilled|baked|braised|steamed|broiled|fried|stewed)\b/.test(d)) {
    return 'cooked';
  }
  return 'unresolved';
}

export const coreNutrientsPresent = (
  readings: readonly RawNutrientReading[],
): boolean => {
  const ids = new Set(readings.map((r) => r.nutrientId));
  return ['energy_kcal', 'protein', 'carbohydrate', 'fat'].every((c) => ids.has(c as NutrientId));
};
