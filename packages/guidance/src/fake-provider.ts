import type {
  GuidanceProvider, GuidanceProviderResult, GuidanceRequest,
} from './contracts.js';

/**
 * DETERMINISTIC TEST PROVIDER.
 *
 * Stands in for a language model so the whole pipeline can be exercised with
 * zero cost and zero network. It is intentionally well-behaved; the adversarial
 * tests construct malicious results directly rather than trying to coax them
 * out of this.
 */
export class FakeGuidanceProvider implements GuidanceProvider {
  readonly name = 'fake-deterministic';

  constructor(private readonly override?: Partial<GuidanceProviderResult>) {}

  async generate(request: GuidanceRequest): Promise<GuidanceProviderResult> {
    const { envelope, intent } = request;
    const components = envelope.planComponents;

    if (envelope.plannerStatus !== 'available' || components.length === 0) {
      return {
        intent: 'clarification_needed',
        selectedProductVersionIds: [],
        templateId: envelope.plannerStatus === 'energy_budget_exhausted'
          ? 'budget_exhausted' : 'no_suggestion',
        clarificationNeeded: false,
        suggestedNextAction: 'none',
        ...this.override,
      };
    }

    if (intent === 'choose_candidate' && request.chosenProductVersionId !== undefined) {
      return {
        intent: 'choose_candidate',
        selectedProductVersionIds: [request.chosenProductVersionId],
        templateId: 'confirm_choice_await_weight',
        clarificationNeeded: false,
        suggestedNextAction: 'await_weight',
        ...this.override,
      };
    }

    return {
      intent,
      selectedProductVersionIds: components.slice(0, 2).map((c) => c.productVersionId),
      // The provider CHOOSES a template; it never writes a sentence.
      templateId: components.length >= 2 ? 'two_options' : 'option_with_objective',
      objectiveIndex: 0,
      clarificationNeeded: false,
      suggestedNextAction: envelope.weighingRequired ? 'await_weight' : 'await_choice',
      alternativeProductVersionIds: envelope.alternatives.map((a) => a.productVersionId),
      ...this.override,
    };
  }
}

/** A provider that is simply not there. Used to prove offline behaviour. */
export class UnavailableGuidanceProvider implements GuidanceProvider {
  readonly name = 'unavailable';
  async generate(): Promise<GuidanceProviderResult> {
    throw new Error('guidance provider unavailable');
  }
}
