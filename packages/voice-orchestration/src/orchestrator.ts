import {
  CLARIFICATION_SPEECH,
  DeterministicVoiceParser,
  INVALID_SPEECH,
  speakGrams,
  speakGramsOf,
  speakKcal,
  type VoiceOption,
  type VoiceIntent,
  type VoiceParser,
  type VoiceResponse,
  type VoiceUtterance,
} from '@macros/domain-voice';
import type { AssistantInterpreter } from '@macros/assistant-core';
import type { CorrelatedVoiceDelivery } from '@macros/domain-voice';
import type { TabletAppController } from '@macros/tablet-app-core';
import { AssistantRouter, type AssistantTrace } from './assistant-router.js';
import {
  DELIVERY_REJECTION_SPEECH,
  VoiceDeliveryGuard,
  type DeliveryContext,
} from './delivery-guard.js';

export const VOICE_ORCHESTRATION_VERSION = 'voice-orchestration@1.0.0';

/**
 * VOICE ORCHESTRATION.
 *
 * VOICE IS NOT A NUTRITION SOURCE. Every number this layer speaks was produced
 * by the nutrition, macro or energy engines and read out of existing
 * application state. Nothing here computes, estimates or invents a value.
 *
 * There is no second state machine. Legal next actions are DERIVED from
 * `TabletAppController` state, so voice and touch cannot drift apart: they are
 * two input adapters onto the same application intents.
 *
 * The only voice-owned state is which options were last read aloud, so
 * "repeat the options" can work — and even that is re-derived from the
 * controller rather than cached independently.
 */
export class VoiceOrchestrator {
  /** Transport safety. Owns no application state — see VoiceDeliveryGuard. */
  private readonly guard = new VoiceDeliveryGuard();

  /**
   * Optional. When absent, MACROS.AI runs fully offline on the deterministic
   * parser alone — known commands must never depend on a cloud model.
   */
  private readonly router: AssistantRouter;

  /** Diagnostics for the most recent turn. Non-authoritative, not persisted. */
  private trace: AssistantTrace = { path: 'deterministic', parserVersion: 'unset' };

  constructor(
    private readonly app: TabletAppController,
    private readonly parser: VoiceParser = new DeterministicVoiceParser(),
    interpreter: AssistantInterpreter | null = null,
  ) {
    this.router = new AssistantRouter(app, interpreter);
  }

  /** The decision trail for the last turn — for tests and debugging only. */
  lastTrace(): AssistantTrace {
    return this.trace;
  }

  get parserVersion(): string {
    return this.parser.version;
  }

  async handle(delivery: CorrelatedVoiceDelivery): Promise<VoiceResponse> {
    const context = this.deliveryContext();

    // Admit AND reserve synchronously — no await may occur before the identity
    // and the turn number are claimed.
    const admitted = this.guard.admitAndReserve(delivery, context);
    if (admitted.kind === 'replay') return admitted.response;
    if (admitted.kind === 'reject') {
      return {
        kind: 'error',
        speech: DELIVERY_REJECTION_SPEECH[admitted.reason],
        reason: admitted.reason,
      };
    }

    // From here the reservation exists, so it must always be settled.
    let response: VoiceResponse;
    try {
      response = await this.execute(delivery);
    } catch {
      response = {
        kind: 'error',
        speech: "Something went wrong handling that.",
        reason: 'internal',
      };
    }
    this.guard.complete(delivery, response);
    return response;
  }

  private async execute(delivery: CorrelatedVoiceDelivery): Promise<VoiceResponse> {
    const parsed = this.parser.parse({
      transcript: delivery.transcript,
      receivedAt: delivery.receivedAt,
      userId: delivery.userId,
    });

    if (parsed.status === 'invalid') {
      return { kind: 'error', speech: INVALID_SPEECH[parsed.reason], reason: parsed.reason };
    }
    if (parsed.status === 'needs_clarification') {
      return { kind: 'clarification', speech: CLARIFICATION_SPEECH[parsed.reason], reason: parsed.reason };
    }

    if (parsed.status === 'unsupported') {
      // The grammar could not cover this phrasing. This is the ONLY point where
      // a richer interpreter is consulted — and whatever it returns is still an
      // untrusted proposal that must survive validation.
      if (this.router.shouldConsult(parsed)) {
        const proposed = await this.router.propose(delivery.transcript);
        this.trace = proposed.trace;
        if (proposed.kind === 'refused') return proposed.response;
        return this.executeIntent(proposed.intent, delivery);
      }

      return {
        kind: 'error',
        speech: "I can't do that yet. Try naming a food, choosing an option, or asking about today.",
        reason: 'unsupported',
      };
    }

    this.trace = { path: 'deterministic', parserVersion: this.parser.version };
    return this.executeIntent(parsed.intent, delivery);
  }

  /**
   * Revalidate against CURRENT state, then dispatch.
   *
   * The context is re-read here rather than reused from admission: an
   * interpreter call may have outlived the session or the flow it began in.
   */
  private async executeIntent(
    intent: VoiceIntent,
    delivery: CorrelatedVoiceDelivery,
  ): Promise<VoiceResponse> {
    const current = this.deliveryContext();
    const revalidated = this.guard.revalidateForExecution(intent, delivery, current);
    if (revalidated.kind === 'reject') {
      return {
        kind: 'error',
        speech: DELIVERY_REJECTION_SPEECH[revalidated.reason],
        reason: revalidated.reason,
      };
    }
    return this.dispatch(intent);
  }

  private deliveryContext(): DeliveryContext {
    const state = this.app.getState();
    return {
      userId: state.subject.userId,
      sessionGeneration: state.sessionGeneration,
      flowId: state.addFood.flowId,
    };
  }





  private async dispatch(intent: VoiceIntent): Promise<VoiceResponse> {
    switch (intent.kind) {
      case 'search_food': return this.searchFood(intent.query);
      case 'select_option': return this.selectOption(intent.optionLabel);
      case 'request_stable_weight': return this.requestWeight();
      case 'manual_weight': return this.manualWeight(intent.grams);
      case 'confirm_log': return this.confirmLog();
      case 'cancel': return this.cancel();
      case 'ask_consumed': return this.askConsumed(intent.nutrient);
      case 'ask_remaining': return this.askRemaining(intent.nutrient);
      case 'ask_macros': return this.askMacros();
      case 'repeat_options': return this.repeatOptions();
      case 'help': return this.help();
    }
  }

  // -------------------------------------------------------------------------

  private currentOptions(): VoiceOption[] {
    return this.app.getState().addFood.results.map((r) => ({
      optionLabel: r.optionLabel,
      productVersionId: r.productVersion.productVersionId,
      displayName: r.productVersion.displayName,
      ...(r.productVersion.brandName !== undefined ? { brandName: r.productVersion.brandName } : {}),
      preparationState: r.productVersion.preparationState,
    }));
  }

  private describeOption(o: VoiceOption): string {
    const brand = o.brandName === undefined ? '' : `${o.brandName} `;
    const prep = o.preparationState === 'as_sold' ? '' : `, ${o.preparationState}`;
    return `Option ${o.optionLabel}: ${brand}${o.displayName}${prep}`;
  }

  private async searchFood(query: string): Promise<VoiceResponse> {
    this.app.beginAddFood();
    await this.app.searchFood(query);
    const options = this.currentOptions();

    // The catalog's refusal to guess is preserved verbatim: no results means no
    // food, never a fabricated one.
    if (options.length === 0) {
      return {
        kind: 'error',
        speech: `I couldn't find ${query}. Try another name.`,
        reason: 'not_found',
      };
    }

    // Even a single match is offered rather than auto-selected, so the user
    // always confirms which exact product they meant.
    return {
      kind: 'options',
      speech: `${options.map((o) => this.describeOption(o)).join('. ')}. Say the option you want.`,
      options,
    };
  }

  private async selectOption(label: string): Promise<VoiceResponse> {
    const options = this.currentOptions();
    if (options.length === 0) {
      // No live options: a stale "Option B" must never resolve an old result.
      return {
        kind: 'clarification',
        speech: 'There are no options right now. Name a food first.',
        reason: 'ambiguous_food_reference',
      };
    }
    const match = options.find((o) => o.optionLabel === label);
    if (match === undefined) {
      return {
        kind: 'clarification',
        speech: `There's no option ${label}. ${options.map((o) => this.describeOption(o)).join('. ')}.`,
        reason: 'ambiguous_option',
      };
    }

    await this.app.selectOption(label);
    const selected = this.app.getState().addFood.selected;
    if (selected === null) {
      return { kind: 'error', speech: "I couldn't select that product.", reason: 'selection_failed' };
    }
    return this.reviewOrPrompt(`${selected.displayName} selected.`);
  }

  private requestWeight(): VoiceResponse {
    if (this.app.getState().addFood.selected === null) {
      return {
        kind: 'clarification',
        speech: 'Choose a food first, then I can take the weight.',
        reason: 'ambiguous_food_reference',
      };
    }
    // Delegates to the existing capture intent, which enforces the stable
    // candidate policy. Voice never reads a raw or unstable sample.
    this.app.requestStableWeight();
    const flow = this.app.getState().addFood;
    if (flow.error !== null && flow.weightCapture === null) {
      return { kind: 'error', speech: flow.error.message, reason: flow.error.code };
    }
    if (flow.weightCapture === null) {
      return { kind: 'informational', speech: 'Waiting for the scale to settle.' };
    }
    return this.reviewOrPrompt('Got it.');
  }

  private manualWeight(grams: number): VoiceResponse {
    if (this.app.getState().addFood.selected === null) {
      return {
        kind: 'clarification',
        speech: 'Choose a food first, then tell me the weight.',
        reason: 'ambiguous_food_reference',
      };
    }
    this.app.enterManualWeight(grams);
    const flow = this.app.getState().addFood;
    if (flow.weightCapture === null) {
      return {
        kind: 'error',
        speech: flow.error?.message ?? "I couldn't use that weight.",
        reason: flow.error?.code ?? 'manual_weight_rejected',
      };
    }
    return this.reviewOrPrompt(`${speakGrams(flow.weightCapture.grams)}.`);
  }

  /** Speak the review only when the application says it is reviewable. */
  private reviewOrPrompt(prefix: string): VoiceResponse {
    const flow = this.app.getState().addFood;
    if (flow.phase !== 'reviewing' || flow.selected === null || flow.weightCapture === null || flow.preview === null) {
      return { kind: 'informational', speech: `${prefix} Place it on the scale, or tell me the weight.` };
    }
    const p = flow.preview;
    return {
      kind: 'review',
      speech:
        `${prefix} ${flow.selected.displayName}, ${speakGrams(flow.weightCapture.grams)}. ` +
        `${speakKcal(p.kcal)}, ${speakGramsOf(p.proteinG, 'protein')}. Say "log it" to save.`,
      review: {
        productVersionId: flow.selected.productVersionId,
        displayName: flow.selected.displayName,
        // Exact domain values. The speech above rounds; these do not.
        grams: flow.weightCapture.grams,
        kcal: p.kcal,
        proteinG: p.proteinG,
        carbohydrateG: p.carbohydrateG,
        fatG: p.fatG,
        weightSource: flow.weightCapture.source,
      },
    };
  }

  private async confirmLog(): Promise<VoiceResponse> {
    const before = this.app.getState().addFood;

    // "Log it" may only succeed when the application already considers the log
    // reviewable. It can never bypass product selection or weight capture.
    if (before.selected === null) {
      return {
        kind: 'clarification',
        speech: 'Tell me what food first.',
        reason: 'ambiguous_food_reference',
      };
    }
    if (before.weightCapture === null) {
      return {
        kind: 'clarification',
        speech: 'I need a weight before I can log that.',
        reason: 'ambiguous_food_reference',
      };
    }
    // A repeat of an already-completed log is acknowledged, not re-submitted.
    if (before.phase === 'completed') {
      return { kind: 'success', speech: 'That one is already logged.' };
    }

    await this.app.confirmFoodLog();
    const after = this.app.getState().addFood;

    if (after.error !== null) {
      return { kind: 'error', speech: after.error.message, reason: after.error.code };
    }
    const dashboard = this.app.getState().dashboard;
    return {
      kind: 'success',
      speech: `Logged. ${speakKcal(dashboard?.intake.kcal ?? 0)} today.`,
      ...(dashboard !== null ? { data: { kcalToday: dashboard.intake.kcal } } : {}),
    };
  }

  private cancel(): VoiceResponse {
    this.app.cancelFoodFlow();
    return { kind: 'informational', speech: 'Cancelled.' };
  }

  private askConsumed(nutrient: string): VoiceResponse {
    const d = this.app.getState().dashboard;
    if (d === null) return { kind: 'error', speech: "I don't have today's numbers yet.", reason: 'no_dashboard' };

    // Read straight from the dashboard. Voice never recomputes totals.
    switch (nutrient) {
      case 'calories':
        return { kind: 'informational', speech: `${speakKcal(d.intake.kcal)} so far today.`, data: { kcal: d.intake.kcal } };
      case 'protein':
        return { kind: 'informational', speech: `${speakGramsOf(d.intake.proteinG, 'protein')} so far.`, data: { proteinG: d.intake.proteinG } };
      case 'carbohydrate':
        return { kind: 'informational', speech: `${speakGramsOf(d.intake.carbohydrateG, 'carbs')} so far.`, data: { carbohydrateG: d.intake.carbohydrateG } };
      default:
        return { kind: 'informational', speech: `${speakGramsOf(d.intake.fatG, 'fat')} so far.`, data: { fatG: d.intake.fatG } };
    }
  }

  private askRemaining(nutrient: string): VoiceResponse {
    const d = this.app.getState().dashboard;
    if (d === null) return { kind: 'error', speech: "I don't have today's numbers yet.", reason: 'no_dashboard' };

    if (nutrient === 'calories') {
      // The existing energy engine's actionable number, not a voice calculation.
      return {
        kind: 'informational',
        speech: `About ${speakKcal(d.energy.remainingIntakeKcal)} left to hit your target.`,
        data: { remainingIntakeKcal: d.energy.remainingIntakeKcal },
      };
    }
    const m = d.macros;
    const remaining =
      nutrient === 'protein' ? m.remainingProteinG :
      nutrient === 'carbohydrate' ? m.remainingCarbohydrateG :
      m.remainingFatG;
    return {
      kind: 'informational',
      speech: `${speakGramsOf(remaining, nutrient === 'carbohydrate' ? 'carbs' : nutrient)} left.`,
      data: { remainingG: remaining },
    };
  }

  private askMacros(): VoiceResponse {
    const d = this.app.getState().dashboard;
    if (d === null) return { kind: 'error', speech: "I don't have today's numbers yet.", reason: 'no_dashboard' };
    const m = d.macros;
    return {
      kind: 'informational',
      speech:
        `${speakGramsOf(m.remainingProteinG, 'protein')}, ` +
        `${speakGramsOf(m.remainingCarbohydrateG, 'carbs')} and ` +
        `${speakGramsOf(m.remainingFatG, 'fat')} left.`,
      data: {
        remainingProteinG: m.remainingProteinG,
        remainingCarbohydrateG: m.remainingCarbohydrateG,
        remainingFatG: m.remainingFatG,
      },
    };
  }

  private repeatOptions(): VoiceResponse {
    const options = this.currentOptions();
    if (options.length === 0) {
      return { kind: 'informational', speech: 'There are no options right now. Name a food to search.' };
    }
    return {
      kind: 'options',
      speech: `${options.map((o) => this.describeOption(o)).join('. ')}.`,
      options,
    };
  }

  private help(): VoiceResponse {
    const flow = this.app.getState().addFood;
    // Valid next actions are derived from application state, not a script.
    if (flow.results.length > 0 && flow.selected === null) {
      return { kind: 'informational', speech: 'Say an option, or name a different food.' };
    }
    if (flow.selected !== null && flow.weightCapture === null) {
      return { kind: 'informational', speech: 'Say "weigh it", or tell me the weight in grams.' };
    }
    if (flow.phase === 'reviewing') {
      return { kind: 'informational', speech: 'Say "log it" to save, or "cancel".' };
    }
    return {
      kind: 'informational',
      speech: 'Name a food to log, or ask how many calories you have left.',
    };
  }
}
