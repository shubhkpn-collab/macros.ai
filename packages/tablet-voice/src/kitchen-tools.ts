/** Shared wire contract. No provider, native audio or nutrition arithmetic. */
const noArgs = { type: 'object', properties: {}, required: [], additionalProperties: false };
const tool = (name: string, description: string, properties: Record<string, unknown> = {}, required: string[] = []) => ({
  type: 'function', name, description,
  parameters: required.length ? {type:'object', properties, required, additionalProperties:false} : noArgs,
});
export const KITCHEN_TOOLS = [
  tool('get_kitchen_state', 'Read current energy, remaining macros, food options, portion review and scale state. Use these numbers; do not calculate nutrition yourself.'),
  tool('search_food', 'Search the food catalog for what the user is preparing. Returns actual options; ask about brand or raw/cooked preparation when ambiguous.', {query:{type:'string'}}, ['query']),
  tool('select_food', 'Select an actual productVersionId returned by search_food or validated guidance, after the user chooses it. Never invent an id.', {productVersionId:{type:'string'}}, ['productVersionId']),
  tool('set_spoken_portion', 'Use grams stated in the latest user audio transcript as a manual portion, never a scale measurement. The tool verifies the spoken number. Then read back the review and ask the user to say confirm.', {grams:{type:'number'}}, ['grams']),
  tool('capture_scale_portion', 'Capture the current stable scale weight, only when a real scale is connected and stable.'),
  tool('confirm_food_log', 'Commit only after the user says confirm or log it in a NEW audio turn while the same portion review is visible. Application checks independent transcription and refuses missing, stale or reused confirmation.'),
  tool('recommend_next_food', 'Ask MACROS for validated next-food guidance using the current nutritional state.'),
  tool('cancel_food', 'Cancel the current food selection or portion review. Keeps already logged food.'),
];
export function explicitFoodConfirmation(text: string): boolean {
  const normalized = text.toLowerCase().replace(/[.,!?]/g,'').replace(/\s+/g,' ').trim();
  return /^(?:yes[, ]+)?(?:confirm|log (?:it|that|this)|save it)(?: please)?$/.test(normalized);
}
export function spokenGrams(text: string): number | null {
  if (/\b(?:not|no|don't|do not|instead|actually)\b/i.test(text)) return null;
  const amounts = [...text.matchAll(/(?:^|\s)(\d+(?:\.\d+)?)\s*(?:grams?|g)\b/gi)];
  if (amounts.length !== 1) return null;
  const value = Number(amounts[0]?.[1]);
  return Number.isFinite(value) && value > 0 ? value : null;
}
