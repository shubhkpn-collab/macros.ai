import type { VoiceIntent } from '@macros/domain-voice';

/**
 * THE ASSISTANT BOUNDARY.
 *
 * A model may interpret LANGUAGE. It may never become the authority for food
 * identity, weight, nutrition, macros, energy, logging, user identity or
 * database access.
 *
 * Everything an interpreter returns is UNTRUSTED DATA. It is a proposal about
 * what the user probably meant — never an instruction, never a value the
 * product will repeat back as fact.
 */

/** Provider-neutral. No SDK, no network, no key, no model selection here. */
export interface AssistantInterpreter {
  readonly providerKind: string;
  readonly modelVersion: string;
  interpret(input: AssistantInterpretationInput): Promise<AssistantInterpretationResult>;
}

/**
 * MINIMUM CONTEXT.
 *
 * Only what is needed to understand ONE turn. Deliberately excluded: food-log
 * history, dashboard numbers, repository objects, raw rows, SQL, credentials,
 * and anything belonging to another user. A model does not need someone's
 * eating history to work out that "option B" means option B.
 *
 * Display names of the CURRENT options are included because resolving "the
 * yogurt one" against what is on screen is exactly the interpretation work
 * being delegated. Product IDs are NOT included — identity is resolved by the
 * catalog and confirmed by the user, never proposed by the model.
 */
export interface AssistantInterpretationInput {
  readonly transcript: string;
  readonly appPhase: string;
  readonly optionLabels: readonly string[];
  readonly optionDisplayNames: readonly string[];
  readonly selectedDisplayName: string | null;
  readonly hasWeightCapture: boolean;
  readonly allowedActions: readonly ProposalKind[];
}

export type ProposalKind = VoiceIntent['kind'];

/**
 * An UNTRUSTED structured proposal. Data, never code.
 *
 * `arguments` is intentionally a loose bag: a real provider will return
 * whatever it returns, including fields nobody allowed. The validator's job is
 * to reject that, so the type must be able to REPRESENT a hostile payload —
 * pretending it cannot is how unvalidated fields reach the router.
 */
export interface IntentProposal {
  readonly intentKind: string;
  readonly arguments?: Readonly<Record<string, unknown>>;
  readonly confidence?: number;
  /** Optional source span the model claims supports a numeric argument. */
  readonly evidence?: string;
}

export type AssistantInterpretationResult =
  | { readonly status: 'proposed'; readonly proposals: readonly IntentProposal[] }
  | { readonly status: 'no_understanding' }
  | { readonly status: 'unavailable'; readonly reason?: string };
