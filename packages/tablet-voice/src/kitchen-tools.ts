/** Shared wire contract. No provider, native audio or nutrition arithmetic. */
const noArgs = { type: 'object', properties: {}, required: [], additionalProperties: false };
const tool = (name: string, description: string, properties: Record<string, unknown> = {}, required: string[] = []) => ({
  type: 'function', name, description,
  parameters: required.length ? {type:'object', properties, required, additionalProperties:false} : noArgs,
});
export const KITCHEN_TOOLS = [
  tool('start_meal_prep','Start the overnight-oats demo meal. Shows three Quaker oat variants. Continue naturally through ingredients the user names; do not force an interview.'),
  tool('set_bowl_baseline','Record the connected stable scale reading for the bowl BEFORE adding an ingredient. Subsequent scale captures use added weight, not total bowl weight. Never claim a hardware tare occurred.'),
  tool('finish_meal_prep','Finish the meal-prep session and return its confirmed ingredient totals. Does not delete saved food.'),
  tool('retrieve_nutrition_knowledge', 'Retrieve cited MACROS explanations of nutrition workflow, energy balance and macro policies. Use for explanatory questions. Not a source of personal values or food nutrient facts; no match means the curated knowledge does not cover the question.', {query:{type:'string'}}, ['query']),
  tool('get_kitchen_state', 'Read current energy, remaining macros, food options, portion review and scale state. Use these numbers; do not calculate nutrition yourself.'),
  tool('search_food', 'Look up actual food candidates when useful to the conversation. Refine the query with established details; a food mention alone is not logging intent. Clarify material differences such as cut, preparation and raw versus cooked weight before selecting.', {query:{type:'string'}}, ['query']),
  tool('select_food_option', 'Select the current displayed card A, B, C or D when the user says its letter or ordinal. The application verifies the latest spoken choice against the same visible options. This does not log food.', {optionLabel:{type:'string'}}, ['optionLabel']),
  tool('select_food', 'Select an actual productVersionId returned by search_food or validated guidance, after the user chooses it. Never invent an id.', {productVersionId:{type:'string'}}, ['productVersionId']),
  tool('set_spoken_portion', 'Use grams explicitly stated for this pending food as a manual portion, never a scale measurement. The tool verifies the latest transcript or a short-lived amount retained from the food search before card selection. Then read back the review and ask the user to say confirm.', {grams:{type:'number'}}, ['grams']),
  tool('capture_scale_portion', 'Capture the current stable scale weight, only when a real scale is connected and stable.'),
  tool('confirm_food_log', 'Commit only after the user says yes, confirm or log it in a NEW audio turn while the same portion review is visible. Application checks independent transcription and refuses missing, stale or reused confirmation.'),
  tool('recommend_next_food', 'Ask MACROS for validated next-food guidance using the current nutritional state.'),
  tool('cancel_food', 'Cancel the current food selection or portion review. Keeps already logged food.'),
];
export function explicitFoodConfirmation(text: string): boolean {
  const normalized = text.toLowerCase().replace(/[.,!?]/g,'').replace(/\s+/g,' ').trim();
  return /^(?:yes|yes please|(?:yes )?(?:confirm|log (?:it|that|this)|save it)(?: please)?)$/.test(normalized);
}
export function spokenGrams(text: string): number | null {
  if (/\b(?:not|no|don't|do not)\b/i.test(text)) return null;
  const amounts = [...text.matchAll(/(?:^|\s)(\d+(?:\.\d+)?)\s*(?:grams?|g)\b/gi)];
  if (amounts.length !== 1) return null;
  const value = Number(amounts[0]?.[1]);
  return Number.isFinite(value) && value > 0 ? value : null;
}
/** A spoken letter or ordinal selects only the currently displayed option, never a product invented by the model. */
export function spokenFoodOption(text:string):string|null {
  const normalized=text.toLowerCase().replace(/[.,!?]/g,'').replace(/\s+/g,' ').trim();
  if(/\b(?:not|no|don't|do not|cancel)\b/.test(normalized))return null;
  const match=/^(?:(?:please|yes|actually) )?(?:(?:select|choose|pick) )?(?:option )?(a|b|bee|c|see|d|dee|first|second|third|fourth)(?: one)?(?: please)?$/.exec(normalized)
    ?? /^(?:select |choose |pick )?the (first|second|third|fourth) one(?: please)?$/.exec(normalized);
  const map:Record<string,string>={a:'A',b:'B',bee:'B',c:'C',see:'C',d:'D',dee:'D',first:'A',second:'B',third:'C',fourth:'D'};
  return match?.[1] ? map[match[1]]??null : null;
}

/** Resolve a named brand/variant only when speech identifies one visible option. */
export function spokenNamedFood(text:string,options:readonly {productVersionId:string;displayName:string;brand:string|null}[]):string|null{
 if(/\b(?:not|no|don't|cancel)\b/i.test(text))return null;
 const ignored=new Set(['i','am','im','ill','will','would','like','want','have','having','take','use','choose','select','pick','please','the','a','an','some','this','that','one','brand','option','lets','let','s','actually','log','of','yes','okay','ok','go','with','d','ll']);
 const normalize=(value:string)=>value.toLowerCase().replace(/[’']/g,'').replace(/almondmilk/g,'almond milk').replace(/oatmilk/g,'oat milk').replace(/low[- ]?fat/g,'low fat');
 const clean=normalize(text).replace(/\d+(?:\.\d+)?\s*(?:grams?|g)\b/g,'');
 const tokens=(clean.match(/[a-z0-9]+/g)??[]).filter(t=>!ignored.has(t));if(!tokens.length)return null;
 const matches=options.filter(o=>{const words:readonly string[]=normalize(`${o.displayName} ${o.brand??''}`).match(/[a-z0-9]+/g)??[];return tokens.every(t=>words.includes(t));});
 return matches.length===1?matches[0]!.productVersionId:null;
}
