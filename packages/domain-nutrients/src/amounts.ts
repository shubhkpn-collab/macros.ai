import {
  convertAmount, isNutrientId, nutrientDefinition,
  type NutrientId, type NutrientUnit,
} from './registry.js';

/**
 * A canonical nutrient amount, with its ORIGINAL source fact retained.
 *
 * Normalization never destroys evidence: if a mapping is later found wrong, the
 * original number, unit and source nutrient identity are still on record, so
 * the error is auditable instead of invisible.
 */
export interface NutrientAmount {
  readonly nutrientId: NutrientId;
  readonly amount: number;
  readonly unit: NutrientUnit;
  readonly source?: NutrientSourceFact;
}

export interface NutrientSourceFact {
  readonly sourceNutrientId: string;
  readonly sourceNutrientName: string;
  readonly sourceUnit: string;
  readonly sourceAmount: number;
  /** Describes any conversion applied, e.g. 'mg->g'. Absent when none. */
  readonly conversion?: string;
}

/**
 * A food's extended nutrients, per canonical basis (per 100 g).
 *
 * ABSENT MEANS UNKNOWN. There is deliberately no zero-filling: a food with no
 * recorded Vitamin D does not contain zero Vitamin D, and storing a zero would
 * make an unmeasured food indistinguishable from a measured one that truly has
 * none.
 */
export type NutrientMap = Readonly<Partial<Record<NutrientId, NutrientAmount>>>;

export const hasNutrient = (map: NutrientMap | undefined, id: NutrientId): boolean =>
  map?.[id] !== undefined;

/** Reads a value only when genuinely present. Never substitutes zero. */
export const nutrientValue = (map: NutrientMap | undefined, id: NutrientId): number | null =>
  map?.[id]?.amount ?? null;

export type NutrientBuildIssue =
  | { readonly kind: 'unknown_nutrient'; readonly sourceNutrientId: string }
  | { readonly kind: 'unit_conflict'; readonly nutrientId: NutrientId; readonly sourceUnit: string }
  | { readonly kind: 'duplicate_conflict'; readonly nutrientId: NutrientId; readonly kept: number; readonly discarded: number }
  | { readonly kind: 'invalid_amount'; readonly nutrientId: NutrientId };

export interface NutrientBuildResult {
  readonly map: NutrientMap;
  /** Never silently swallowed — the caller decides whether to curate or fail. */
  readonly issues: readonly NutrientBuildIssue[];
}

export interface RawNutrientReading {
  readonly nutrientId: NutrientId;
  readonly amount: number;
  readonly unit: string;
  readonly source: NutrientSourceFact;
  /** Higher wins when two source rows map to the same canonical nutrient. */
  readonly precedence?: number;
}

/**
 * Canonicalize source readings into a nutrient map.
 *
 * Two source rows can legitimately map to one canonical nutrient (USDA carries
 * both "Total Sugars" and the older "Sugars, Total"). Rather than silently
 * picking one, precedence decides and any genuine disagreement is REPORTED.
 */
export function buildNutrientMap(
  readings: readonly RawNutrientReading[],
): NutrientBuildResult {
  const out: Record<string, NutrientAmount> = {};
  const chosenPrecedence: Record<string, number> = {};
  const issues: NutrientBuildIssue[] = [];

  for (const r of readings) {
    if (!isNutrientId(r.nutrientId)) {
      issues.push({ kind: 'unknown_nutrient', sourceNutrientId: r.source.sourceNutrientId });
      continue;
    }
    if (!Number.isFinite(r.amount) || r.amount < 0) {
      issues.push({ kind: 'invalid_amount', nutrientId: r.nutrientId });
      continue;
    }

    const definition = nutrientDefinition(r.nutrientId);
    const from = normalizeUnit(r.unit);
    if (from === null) {
      issues.push({ kind: 'unit_conflict', nutrientId: r.nutrientId, sourceUnit: r.unit });
      continue;
    }

    const converted = convertAmount(r.amount, from, definition.unit);
    if (!converted.ok) {
      // An unconvertible unit is a curation problem, never a guess.
      issues.push({ kind: 'unit_conflict', nutrientId: r.nutrientId, sourceUnit: r.unit });
      continue;
    }

    const precedence = r.precedence ?? 0;
    const existing = out[r.nutrientId];
    if (existing !== undefined) {
      const keptPrecedence = chosenPrecedence[r.nutrientId] ?? 0;
      if (precedence <= keptPrecedence) {
        if (Math.abs(existing.amount - converted.amount) > 1e-6) {
          issues.push({
            kind: 'duplicate_conflict', nutrientId: r.nutrientId,
            kept: existing.amount, discarded: converted.amount,
          });
        }
        continue;
      }
      if (Math.abs(existing.amount - converted.amount) > 1e-6) {
        issues.push({
          kind: 'duplicate_conflict', nutrientId: r.nutrientId,
          kept: converted.amount, discarded: existing.amount,
        });
      }
    }

    chosenPrecedence[r.nutrientId] = precedence;
    out[r.nutrientId] = {
      nutrientId: r.nutrientId,
      amount: converted.amount,
      unit: definition.unit,
      source: from === definition.unit
        ? r.source
        : { ...r.source, conversion: `${from}->${definition.unit}` },
    };
  }

  return { map: out as NutrientMap, issues };
}

/** Scale a per-100 g nutrient map to an actual consumed mass. */
export function scaleNutrientMap(map: NutrientMap, grams: number): NutrientMap {
  const factor = grams / 100;
  const out: Record<string, NutrientAmount> = {};
  for (const [id, amount] of Object.entries(map)) {
    if (amount === undefined) continue;
    out[id] = { ...amount, amount: round6(amount.amount * factor) };
  }
  return out as NutrientMap;
}

const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;

const UNIT_ALIASES: Readonly<Record<string, NutrientUnit>> = {
  kcal: 'kcal', g: 'g', mg: 'mg',
  ug: 'ug', 'µg': 'ug', mcg: 'ug', 'μg': 'ug',
  iu: 'IU',
};

export const normalizeUnit = (unit: string): NutrientUnit | null =>
  UNIT_ALIASES[unit.trim().toLowerCase()] ?? null;
