import type { ProductVersion } from '@macros/contracts';

/**
 * FOOD CARD — the presentation-safe projection of a catalog record.
 *
 * Every field is either backed by the catalog or EXPLICITLY absent. Nothing is
 * inferred, estimated or defaulted: a card that quietly invents a serving size
 * or a calorie figure would be indistinguishable from a real one, and the
 * person would have no way to know which they were looking at.
 *
 * Absence is therefore a first-class value, not `0` and not an empty string.
 */
export const FOOD_CARD_VERSION = 'food-card@1.0.0';

/** Why a field is missing. Distinguishes "not in the source" from "not loaded". */
export type MissingReason = 'not_in_source' | 'not_applicable' | 'unverified';

export interface CardValue<T> {
  readonly present: boolean;
  readonly value: T | null;
  readonly missingReason: MissingReason | null;
}

export const present = <T>(value: T): CardValue<T> =>
  ({ present: true, value, missingReason: null });

export const absent = <T>(reason: MissingReason): CardValue<T> =>
  ({ present: false, value: null, missingReason: reason });

/** How a serving may be expressed. Grams and label text are different facts. */
export interface ServingView {
  readonly grams: number | null;
  readonly householdText: string | null;
  /** True only when a gram weight exists — the only basis for weighing. */
  readonly weighable: boolean;
}

export type ImageKind = 'product' | 'representative' | 'fallback';
export type ImageStatus = 'available' | 'unverified' | 'none';

/**
 * IMAGE REFERENCE — metadata and provenance only.
 *
 * No binary is stored in PostgreSQL. Images are large, immutable and
 * CDN-shaped; putting them in the row store would bloat every backup and every
 * replica for data a URL already addresses. Licence terms also differ per
 * source, so provenance travels WITH the reference rather than being assumed.
 */
export interface FoodImageRef {
  readonly foodId: string;
  readonly url: string | null;
  readonly source: string | null;
  readonly externalSourceId: string | null;
  readonly kind: ImageKind;
  readonly status: ImageStatus;
  readonly licence: string | null;
  readonly attribution: string | null;
  readonly verifiedAt: string | null;
}

/**
 * The deterministic fallback when no image exists.
 *
 * Deterministic matters: the same food must produce the same placeholder on
 * every device and every render, or a shared appliance looks unstable.
 */
export function fallbackImage(foodId: string): FoodImageRef {
  return {
    foodId,
    url: null,
    source: null,
    externalSourceId: null,
    kind: 'fallback',
    status: 'none',
    licence: null,
    attribution: null,
    verifiedAt: null,
  };
}

/** Stable initials for a placeholder tile, derived from the name alone. */
export function fallbackInitials(displayName: string): string {
  const words = displayName.trim().split(/\s+/).filter((w) => /[A-Za-z]/.test(w));
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return `${words[0]![0]!}${words[1]![0]!}`.toUpperCase();
}

export interface FoodCard {
  readonly productId: string;
  readonly productVersionId: string;
  readonly displayName: string;
  readonly brand: CardValue<string>;
  readonly preparationState: string;
  readonly serving: ServingView;
  /** Per 100 g, copied from the catalog. Absent when the source lacks it. */
  readonly kcal: CardValue<number>;
  readonly proteinG: CardValue<number>;
  readonly carbohydrateG: CardValue<number>;
  readonly fatG: CardValue<number>;
  readonly image: FoodImageRef;
  readonly provenance: {
    readonly kind: string;
    readonly sourceId: string | null;
    readonly verificationStatus: string | null;
  };
  /**
   * False when the record is not fit to show a customer — missing energy, or
   * an impossible nutrient. Such records still exist in the catalog; they are
   * simply not offered as choices.
   */
  readonly displayable: boolean;
}

const MAX_KCAL_PER_100G = 900;
const MAX_MACRO_G_PER_100G = 100;

const numberOrAbsent = (v: unknown): CardValue<number> =>
  typeof v === 'number' && Number.isFinite(v) ? present(v) : absent('not_in_source');

/**
 * Project a catalog version into a card.
 *
 * This reads values across; it never computes one. Scaling to a portion is the
 * nutrition engine's job, and duplicating it here would create a second answer
 * to the same question.
 */
export function toFoodCard(
  version: ProductVersion,
  image: FoodImageRef | null = null,
): FoodCard {
  const v = version as unknown as Record<string, unknown>;
  const basis = (v['basis'] ?? v['per100g']) as Record<string, unknown> | undefined;

  const readMacro = (flat: string, nested: string): CardValue<number> => {
    if (basis === undefined) return absent('not_in_source');
    const direct = basis[flat];
    if (typeof direct === 'number') return numberOrAbsent(direct);
    const node = basis[nested];
    if (node !== null && typeof node === 'object') {
      return numberOrAbsent((node as Record<string, unknown>)['amount']);
    }
    return absent('not_in_source');
  };

  const kcal = readMacro('kcal', 'energy_kcal');
  const proteinG = readMacro('proteinG', 'protein');
  const carbohydrateG = readMacro('carbohydrateG', 'carbohydrate');
  const fatG = readMacro('fatG', 'fat');

  const brandName = v['brandName'];
  const grams = v['servingGrams'];
  const household = v['householdServingText'];
  const source = (v['source'] ?? {}) as Record<string, unknown>;

  const inRange = (c: CardValue<number>, max: number): boolean =>
    !c.present || (c.value! >= 0 && c.value! <= max);

  const displayable = kcal.present
    && inRange(kcal, MAX_KCAL_PER_100G)
    && inRange(proteinG, MAX_MACRO_G_PER_100G)
    && inRange(carbohydrateG, MAX_MACRO_G_PER_100G)
    && inRange(fatG, MAX_MACRO_G_PER_100G);

  const productId = String(v['productId'] ?? '');

  return {
    productId,
    productVersionId: String(v['productVersionId'] ?? ''),
    displayName: String(v['displayName'] ?? ''),
    brand: typeof brandName === 'string' && brandName.length > 0
      ? present(brandName) : absent('not_in_source'),
    preparationState: String(v['preparationState'] ?? 'as_sold'),
    serving: {
      grams: typeof grams === 'number' && Number.isFinite(grams) && grams > 0 ? grams : null,
      householdText: typeof household === 'string' && household.length > 0 ? household : null,
      weighable: typeof grams === 'number' && Number.isFinite(grams) && grams > 0,
    },
    kcal,
    proteinG,
    carbohydrateG,
    fatG,
    image: image ?? fallbackImage(productId),
    provenance: {
      kind: String(source['kind'] ?? 'unknown'),
      sourceId: typeof source['sourceId'] === 'string' ? source['sourceId'] : null,
      verificationStatus: typeof source['verificationStatus'] === 'string'
        ? source['verificationStatus'] : null,
    },
    displayable,
  };
}
