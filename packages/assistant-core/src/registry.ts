import type { ProposalKind } from './interpreter.js';

/**
 * THE CLOSED TOOL REGISTRY.
 *
 * An explicit allowlist. A proposal names a tool by string; that string is
 * looked up HERE and nowhere else. There is deliberately no
 * `controller[name]()` anywhere in the assistant path — dynamic dispatch on
 * model-supplied text is how a language model becomes a remote code execution
 * primitive.
 */

export interface ToolSpec {
  readonly kind: ProposalKind;
  /** Whether invoking this tool changes application state. */
  readonly stateChanging: boolean;
  /** Argument names this tool accepts. Anything else is rejected. */
  readonly allowedArguments: readonly string[];
}

export const TOOL_REGISTRY: Readonly<Record<ProposalKind, ToolSpec>> = {
  search_food: { kind: 'search_food', stateChanging: true, allowedArguments: ['query'] },
  select_option: { kind: 'select_option', stateChanging: true, allowedArguments: ['optionLabel'] },
  request_stable_weight: { kind: 'request_stable_weight', stateChanging: true, allowedArguments: [] },
  manual_weight: { kind: 'manual_weight', stateChanging: true, allowedArguments: ['grams'] },
  confirm_log: { kind: 'confirm_log', stateChanging: true, allowedArguments: [] },
  cancel: { kind: 'cancel', stateChanging: true, allowedArguments: [] },
  ask_consumed: { kind: 'ask_consumed', stateChanging: false, allowedArguments: ['nutrient'] },
  ask_remaining: { kind: 'ask_remaining', stateChanging: false, allowedArguments: ['nutrient'] },
  ask_macros: { kind: 'ask_macros', stateChanging: false, allowedArguments: [] },
  repeat_options: { kind: 'repeat_options', stateChanging: false, allowedArguments: [] },
  help: { kind: 'help', stateChanging: false, allowedArguments: [] },
};

export const isKnownTool = (name: string): name is ProposalKind =>
  Object.prototype.hasOwnProperty.call(TOOL_REGISTRY, name);

/**
 * Argument names that are NEVER acceptable from a model, on any tool.
 *
 * These are the authority fields: product identity, nutrition, energy, user
 * identity, and anything implying code, data access or IO. Listed explicitly so
 * a rejection names what was attempted instead of failing anonymously.
 */
export const PROHIBITED_ARGUMENTS: readonly string[] = [
  // Food identity — resolved by the catalog and confirmed by the user.
  'productid', 'productversionid', 'barcode', 'gtin', 'fdcid', 'productversion',
  // Nutrition and energy — produced by the domain engines only.
  'calories', 'kcal', 'protein', 'proteing', 'carbs', 'carbohydrate', 'carbohydrateg',
  'fat', 'fatg', 'fiber', 'sugar', 'sodium', 'nutrition', 'macros',
  'bmr', 'tdee', 'tef', 'expenditure', 'energyexpenditure', 'remainingintake', 'balance',
  // Identity and access.
  'userid', 'subjectid', 'authenticatedsubjectid', 'switchuser',
  // Execution and IO.
  'sql', 'query_sql', 'rawsql', 'url', 'endpoint', 'fetch', 'path', 'filepath',
  'file', 'command', 'exec', 'eval', 'script', 'method', 'function',
];

/** Signals of an injected payload rather than a spoken quantity. */
const SQL_SHAPE = /\b(select|insert|update|delete|drop|union|alter|truncate)\b[\s\S]*\b(from|into|table|where)\b/i;
const URL_SHAPE = /\b(https?:\/\/|file:\/\/|ftp:\/\/)/i;
const PATH_SHAPE = /(^|\s)(\/(etc|var|usr|home|root|proc)\/|\.\.\/)/;

export const looksLikeInjection = (value: string): boolean =>
  SQL_SHAPE.test(value) || URL_SHAPE.test(value) || PATH_SHAPE.test(value);
