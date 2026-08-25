/**
 * CATALOG PRODUCT POLICY.
 *
 * Three DIFFERENT questions, deliberately not collapsed:
 *   1. what we can ingest,
 *   2. what belongs in the default consumer catalog,
 *   3. what may be recommended to an adult user.
 *
 * This is product policy, not a medical judgement. Nothing here removes source
 * support: an excluded category remains ingestable and searchable-by-intent, it
 * simply does not populate the default adult experience.
 */
export const CATALOG_POLICY_VERSION = 'catalog-policy@1.0.0';

export type CategoryEligibility =
  | 'default_catalog'
  | 'searchable_not_recommended'
  | 'excluded_from_consumer'
  | 'needs_curation';

/**
 * MACROS.AI is an 18+ product. Baby foods and infant formula are technically
 * valid USDA records with real nutrition, but they must never surface as a
 * suggestion to an adult tracking macros — their macros can fit a gap perfectly
 * and still be an absurd recommendation.
 */
const EXCLUDED_CATEGORIES: readonly string[] = [
  'Baby Foods',
  'Infant Formula',
];

const SEARCHABLE_NOT_RECOMMENDED: readonly string[] = [
  // Real foods a user may look up and log, but which should not be proposed
  // as an answer to "what should I eat?".
  'Spices and Herbs',
  'Alcoholic Beverages',
  'Fats and Oils',
];

export function categoryEligibility(category: string | null): CategoryEligibility {
  if (category === null || category.trim().length === 0) return 'needs_curation';
  if (EXCLUDED_CATEGORIES.includes(category)) return 'excluded_from_consumer';
  if (SEARCHABLE_NOT_RECOMMENDED.includes(category)) return 'searchable_not_recommended';
  return 'default_catalog';
}

export const publishesToConsumerCatalog = (e: CategoryEligibility): boolean =>
  e === 'default_catalog' || e === 'searchable_not_recommended';

export const eligibleForRecommendation = (e: CategoryEligibility): boolean =>
  e === 'default_catalog';
