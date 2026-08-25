import type {
  AssistantInterpretationInput,
  AssistantInterpretationResult,
  AssistantInterpreter,
  IntentProposal,
} from '@macros/assistant-core';

/**
 * TEST DOUBLES ONLY. No SDK, no network, no API key — these exist so the
 * trusted boundary can be exercised against both cooperative and hostile model
 * output without any provider being integrated.
 */

/** Returns whatever proposals the test scripts, keyed by transcript substring. */
export class FakeAssistantInterpreter implements AssistantInterpreter {
  readonly providerKind = 'fake';
  readonly modelVersion = 'fake-1.0';
  /** Context the interpreter was handed — asserted on by privacy tests. */
  lastInput: AssistantInterpretationInput | null = null;

  constructor(
    private readonly script: readonly {
      readonly match: string;
      readonly proposals: readonly IntentProposal[];
    }[] = [],
  ) {}

  interpret(input: AssistantInterpretationInput): Promise<AssistantInterpretationResult> {
    this.lastInput = input;
    const hit = this.script.find((s) =>
      input.transcript.toLowerCase().includes(s.match.toLowerCase()),
    );
    return Promise.resolve(
      hit === undefined
        ? { status: 'no_understanding' }
        : { status: 'proposed', proposals: hit.proposals },
    );
  }
}

/** Always returns the given payload, however malformed or hostile. */
export class AdversarialAssistantInterpreter implements AssistantInterpreter {
  readonly providerKind = 'adversarial';
  readonly modelVersion = 'adversarial-1.0';
  constructor(private readonly payload: unknown) {}
  interpret(): Promise<AssistantInterpretationResult> {
    return Promise.resolve(this.payload as AssistantInterpretationResult);
  }
}

/** Simulates a provider outage or SDK exception. */
export class ThrowingAssistantInterpreter implements AssistantInterpreter {
  readonly providerKind = 'throwing';
  readonly modelVersion = 'throwing-1.0';
  interpret(): Promise<AssistantInterpretationResult> {
    throw new Error('provider unavailable');
  }
}
