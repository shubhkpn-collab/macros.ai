import {
  TOOL_REGISTRY,
  shouldConsultAssistant,
  validateProposals,
  type AssistantInterpretationInput,
  type AssistantInterpreter,
  type ProposalKind,
  type ProposalRejection,
  type ProposalValidation,
} from '@macros/assistant-core';
import type { ParseResult, VoiceIntent, VoiceResponse } from '@macros/domain-voice';
import type { TabletAppController } from '@macros/tablet-app-core';

/**
 * THE TRUSTED TOOL ROUTER.
 *
 * Sits between untrusted model output and the application. Everything reaching
 * it is a PROPOSAL; nothing reaching it is an instruction. It validates, then
 * dispatches through an explicit mapping to the same `TabletAppController`
 * intents that touch and deterministic voice already use.
 *
 * The router adds no capability. A model can reach exactly the surface a user
 * can reach by tapping, and no more.
 */

export type AssistantPath = 'deterministic' | 'assistant_fallback' | 'assistant_unavailable';

/**
 * Engineering diagnostics only — non-authoritative, not persisted, no analytics.
 * It exists so a test can prove WHY something executed or did not.
 */
export interface AssistantTrace {
  readonly path: AssistantPath;
  readonly parserVersion: string;
  readonly interpreterVersion?: string;
  readonly proposalSummary?: string;
  readonly validation?: 'accepted' | ProposalRejection;
  readonly executedIntent?: ProposalKind;
}

/** The structured result the product trusts. Model prose is never authoritative. */
export interface AssistantToolResult {
  readonly tool: ProposalKind;
  readonly status: 'ok' | 'refused';
  readonly authoritativeData?: Readonly<Record<string, number | string>>;
  readonly nextAllowedActions: readonly ProposalKind[];
}

export interface AssistantOutcome {
  readonly response: VoiceResponse;
  readonly trace: AssistantTrace;
  readonly toolResult?: AssistantToolResult;
}

const CLARIFY: VoiceResponse = {
  kind: 'clarification',
  speech: "I didn't understand that. Try naming the food, or choosing an option.",
  reason: 'ambiguous_food_reference',
};

export class AssistantRouter {
  constructor(
    private readonly app: TabletAppController,
    private readonly interpreter: AssistantInterpreter | null,
  ) {}

  /** Legal actions derived from application state — never from the model. */
  allowedActions(): readonly ProposalKind[] {
    const flow = this.app.getState().addFood;
    const readOnly: ProposalKind[] = [
      'ask_consumed', 'ask_remaining', 'ask_macros', 'help',
      // Read-only: it returns candidates the user must still choose from.
      'recommend_food',
      // Read-only nutrient query; trusted state supplies the number.
      'ask_nutrient',
    ];
    const actions: ProposalKind[] = ['search_food', 'cancel', ...readOnly];

    if (flow.results.length > 0) {
      actions.push('select_option', 'repeat_options');
    }
    if (flow.selected !== null) {
      actions.push('request_stable_weight', 'manual_weight');
    }
    if (flow.phase === 'reviewing') {
      actions.push('confirm_log');
    }
    return actions;
  }

  /**
   * MINIMUM CONTEXT, assembled from the CURRENT user's state only.
   *
   * No food-log history, no dashboard numbers, no repository objects, no ids.
   * Another user's state is unreachable here by construction: everything comes
   * from `getState()`, which is already scoped to the active subject.
   */
  buildInput(transcript: string): AssistantInterpretationInput {
    const flow = this.app.getState().addFood;
    return {
      transcript,
      appPhase: flow.phase,
      optionLabels: flow.results.map((r) => r.optionLabel),
      optionDisplayNames: flow.results.map((r) => r.productVersion.displayName),
      selectedDisplayName: flow.selected?.displayName ?? null,
      hasWeightCapture: flow.weightCapture !== null,
      allowedActions: this.allowedActions(),
    };
  }

  shouldConsult(parsed: ParseResult): boolean {
    if (this.interpreter === null) return false;
    return shouldConsultAssistant(parsed).use;
  }

  /**
   * Consult the interpreter and validate what comes back.
   *
   * Returns an intent ONLY if it survived validation. Any failure — a throw, a
   * malformed payload, an unknown tool, a fabricated number — degrades to a
   * clarification with zero mutation.
   */
  async propose(transcript: string): Promise<
    | { readonly kind: 'intent'; readonly intent: VoiceIntent; readonly trace: AssistantTrace }
    | { readonly kind: 'refused'; readonly response: VoiceResponse; readonly trace: AssistantTrace }
  > {
    const parserVersion = 'deterministic-fast-path';
    if (this.interpreter === null) {
      return {
        kind: 'refused',
        response: CLARIFY,
        trace: { path: 'assistant_unavailable', parserVersion },
      };
    }

    const base = {
      path: 'assistant_fallback' as const,
      parserVersion,
      interpreterVersion: `${this.interpreter.providerKind}@${this.interpreter.modelVersion}`,
    };

    let result;
    try {
      result = await this.interpreter.interpret(this.buildInput(transcript));
    } catch {
      // A provider that throws must never leave the app changed.
      return { kind: 'refused', response: CLARIFY, trace: { ...base, validation: 'no_proposal' } };
    }

    if (
      result === null || result === undefined || typeof result !== 'object' ||
      !('status' in result) || result.status !== 'proposed' ||
      !Array.isArray((result as { proposals?: unknown }).proposals)
    ) {
      return { kind: 'refused', response: CLARIFY, trace: { ...base, validation: 'no_proposal' } };
    }

    const proposals = result.proposals;
    const validation: ProposalValidation = validateProposals(proposals, {
      input: this.buildInput(transcript),
    });

    const summary = proposals.map((p) => String(p?.intentKind)).join('+');

    if (validation.status === 'rejected') {
      return {
        kind: 'refused',
        response: CLARIFY,
        trace: { ...base, proposalSummary: summary, validation: validation.reason },
      };
    }

    return {
      kind: 'intent',
      intent: validation.intent,
      trace: {
        ...base,
        proposalSummary: summary,
        validation: 'accepted',
        executedIntent: validation.intent.kind,
      },
    };
  }

  /** Structured, trusted result built from application state after execution. */
  toolResult(intent: VoiceIntent, response: VoiceResponse): AssistantToolResult {
    const data =
      response.kind === 'informational' || response.kind === 'success'
        ? response.data
        : undefined;
    return {
      tool: intent.kind,
      status: response.kind === 'error' ? 'refused' : 'ok',
      ...(data !== undefined ? { authoritativeData: data } : {}),
      nextAllowedActions: this.allowedActions(),
    };
  }

  static isStateChanging(kind: ProposalKind): boolean {
    return TOOL_REGISTRY[kind].stateChanging;
  }
}
