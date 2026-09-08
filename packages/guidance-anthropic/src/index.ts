import type {
  GuidanceProvider, GuidanceProviderResult, GuidanceRequest,
} from '@macros/guidance';
import { decodeToolInput } from './decode.js';

/**
 * SERVER-ONLY ANTHROPIC ADAPTER.
 *
 * Vendor code lives here and nowhere else: not on the tablet, not in guidance
 * core, not in recommendation or nutrition. Swapping vendors, or removing one,
 * should touch this file alone.
 *
 * The model is never asked to write. It is asked to CHOOSE — one template, one
 * or more already-offered candidates — through a single structured tool. Free
 * assistant prose can never become a GuidanceProviderResult, which is what
 * keeps INT-5B's guarantee intact across a network boundary.
 */
export const ANTHROPIC_ADAPTER_VERSION = 'anthropic-guidance-adapter@1.0.0';

export interface AnthropicHttpTransport {
  send(request: {
    readonly url: string;
    readonly method: 'POST';
    readonly headers: Readonly<Record<string, string>>;
    readonly body: string;
    readonly timeoutMs: number;
  }): Promise<{ readonly status: number; readonly body: string }>;
}

export interface AnthropicGuidanceProviderOptions {
  /**
   * Supplied by the server composition edge. This adapter never reads
   * process.env: a component that fetches its own secrets can be constructed
   * accidentally, in a test or a script, and reach for production credentials.
   */
  readonly apiKey: string;
  /** Injected, never baked in, so a model change is configuration only. */
  readonly model: string;
  readonly transport: AnthropicHttpTransport;
  readonly timeoutMs?: number;
  readonly maxTokens?: number;
  readonly baseUrl?: string;
}

const TOOL_NAME = 'submit_guidance_decision';
const DEFAULT_TIMEOUT_MS = 6000;

/**
 * The ONLY way a decision may be expressed.
 *
 * The schema mirrors GuidanceProviderResult exactly, with closed enums, so an
 * invented template or action fails here before it can reach the validator.
 */
export const GUIDANCE_TOOL_SCHEMA = {
  name: TOOL_NAME,
  description:
    'Record the guidance decision. Choose one response template and the '
    + 'candidates to reference. You may only reference candidates supplied in '
    + 'the request. Do not write prose, quantities or nutrition figures.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['intent', 'templateId', 'selectedProductVersionIds',
      'clarificationNeeded', 'suggestedNextAction'],
    properties: {
      intent: {
        type: 'string',
        enum: ['what_should_i_eat', 'request_alternative', 'choose_candidate',
          'prefer_quick', 'prefer_meal', 'decline', 'clarification_needed'],
      },
      templateId: {
        type: 'string',
        enum: ['single_option', 'two_options', 'option_with_objective',
          'confirm_choice_await_weight', 'ask_quick_or_meal', 'offer_alternative',
          'need_clarification', 'budget_exhausted', 'no_suggestion', 'declined'],
      },
      selectedProductVersionIds: { type: 'array', items: { type: 'string' }, maxItems: 3 },
      slotRefs: { type: 'array', items: { type: 'string' }, maxItems: 6 },
      objectiveIndex: { type: 'integer', minimum: 0, maximum: 5 },
      tone: { type: 'string', enum: ['neutral', 'brief', 'encouraging'] },
      clarificationNeeded: { type: 'boolean' },
      suggestedNextAction: {
        type: 'string',
        enum: ['await_choice', 'await_weight', 'await_clarification', 'none'],
      },
      alternativeProductVersionIds: {
        type: 'array', items: { type: 'string' }, maxItems: 4,
      },
    },
  },
} as const;

const SYSTEM_PROMPT =
  'You help someone choose what to eat from options that have ALREADY been '
  + 'selected by a deterministic nutrition system. You do not decide what is '
  + 'nutritionally appropriate — that decision is made. Your job is to pick the '
  + `response template that fits, and reference the supplied candidates. Always `
  + `respond by calling ${TOOL_NAME}. Never write prose, food names, quantities `
  + 'or nutrition figures yourself.';

export class AnthropicGuidanceProvider implements GuidanceProvider {
  readonly name = 'anthropic';

  constructor(private readonly options: AnthropicGuidanceProviderOptions) {}

  async generate(request: GuidanceRequest): Promise<GuidanceProviderResult> {
    /**
     * The model receives ONLY the provider-facing projection, which INT-5B
     * already stripped of subject and session identity. Nothing is added here.
     */
    const body = JSON.stringify({
      model: this.options.model,
      max_tokens: this.options.maxTokens ?? 512,
      system: SYSTEM_PROMPT,
      tools: [GUIDANCE_TOOL_SCHEMA],
      // Force the structured path: assistant text is not an acceptable answer.
      tool_choice: { type: 'tool', name: TOOL_NAME },
      messages: [{
        role: 'user',
        content: JSON.stringify({
          intent: request.intent,
          envelope: request.envelope,
          recentTurns: request.recentTurns,
          ...(request.chosenProductVersionId !== undefined
            ? { chosenProductVersionId: request.chosenProductVersionId } : {}),
        }),
      }],
    });

    const response = await this.options.transport.send({
      url: `${(this.options.baseUrl ?? 'https://api.anthropic.com').replace(/\/$/, '')}/v1/messages`,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.options.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body,
      timeoutMs: this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });

    if (response.status !== 200) throw new Error('provider_error');

    let parsed: unknown;
    try {
      parsed = JSON.parse(response.body);
    } catch {
      throw new Error('provider_malformed');
    }

    const content = (parsed as { content?: unknown }).content;
    if (!Array.isArray(content)) throw new Error('provider_malformed');

    const decisions = content.filter((block): block is { name: string; input: unknown } =>
      block !== null && typeof block === 'object'
      && (block as { type?: unknown }).type === 'tool_use'
      && (block as { name?: unknown }).name === TOOL_NAME);

    // No decision, or several conflicting ones, is a refusal — not something to
    // reconcile by guessing which the model meant.
    if (decisions.length !== 1) throw new Error('provider_no_decision');

    /**
     * STRUCTURALLY decoded, not cast. `as GuidanceProviderResult` asserted a
     * shape nobody had checked, so a tool input with a bad template or a
     * missing field travelled on as though it were valid.
     *
     * This proves wire structure only. The tablet's INT-5B validator remains
     * the authority on semantic safety — whether the candidate was offered,
     * the slot exists, the arity matches.
     */
    const decoded = decodeToolInput(decisions[0]!.input);
    if (decoded === null) throw new Error('provider_malformed');
    return decoded;
  }
}

export * from './decode.js';
export * from './fetch-transport.js';
export * from './composition.js';
export * from './demo-profile.js';
