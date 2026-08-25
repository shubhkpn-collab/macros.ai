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
import type { TabletAppController } from '@macros/tablet-app-core';

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
/**
 * How long an identical delivery counts as a replay rather than a new command.
 *
 * Deliberately short. A real user saying "log it" twice a few seconds apart is
 * ALREADY safe — the application's single submissionId per logical submission
 * makes a duplicate log impossible — so this window exists only to stop a
 * transport-level redelivery from being spoken and acted on twice.
 */
export const REPLAY_WINDOW_MS = 2000;

interface HandledUtterance {
  readonly key: string;
  readonly atMs: number;
  readonly response: VoiceResponse;
}

/** Bounded: this is a transport de-duplication guard, not an event store. */
const MAX_TRACKED_UTTERANCES = 8;

export class VoiceOrchestrator {
  /**
   * Recent deliveries, kept ONLY to recognise a replay. Voice still owns no
   * application state: nothing here influences what the next command may do.
   */
  private handled: HandledUtterance[] = [];
  /** Detects a subject change so replay memory can never cross users. */
  private lastSubjectId: string | null = null;

  constructor(
    private readonly app: TabletAppController,
    private readonly parser: VoiceParser = new DeterministicVoiceParser(),
  ) {}

  get parserVersion(): string {
    return this.parser.version;
  }

  async handle(utterance: VoiceUtterance): Promise<VoiceResponse> {
    // The utterance must belong to the active user. A transcript addressed to
    // another subject never drives this session.
    if (utterance.userId !== this.app.getState().subject.userId) {
      return { kind: 'error', speech: 'That request was for a different profile.', reason: 'subject_mismatch' };
    }

    // Replay memory is per-session. A user switch discards it, so one user's
    // delivery can never suppress or answer another user's command.
    const subjectId = this.app.getState().subject.userId;
    if (this.lastSubjectId !== null && this.lastSubjectId !== subjectId) {
      this.resetDeliveryMemory();
    }
    this.lastSubjectId = subjectId;

    // A redelivered utterance replays its original response and executes
    // NOTHING. The delivery identity is preferred; without one, an identical
    // transcript inside a short window is treated the same way.
    const replayed = this.findReplay(utterance);
    if (replayed !== undefined) return replayed.response;

    const parsed = this.parser.parse(utterance);

    if (parsed.status === 'invalid') {
      return { kind: 'error', speech: INVALID_SPEECH[parsed.reason], reason: parsed.reason };
    }
    if (parsed.status === 'needs_clarification') {
      return { kind: 'clarification', speech: CLARIFICATION_SPEECH[parsed.reason], reason: parsed.reason };
    }
    if (parsed.status === 'unsupported') {
      return {
        kind: 'error',
        speech: "I can't do that yet. Try naming a food, choosing an option, or asking about today.",
        reason: 'unsupported',
      };
    }

    const intent = parsed.intent;
    const response = await this.dispatch(intent);
    this.remember(utterance, response);
    return response;
  }

  private replayKey(utterance: VoiceUtterance): string {
    return utterance.utteranceId !== undefined
      ? `id:${utterance.utteranceId}`
      : `text:${utterance.userId}:${utterance.transcript.trim().toLowerCase()}`;
  }

  private findReplay(utterance: VoiceUtterance): HandledUtterance | undefined {
    const key = this.replayKey(utterance);
    const atMs = Date.parse(utterance.receivedAt);
    return this.handled.find((h) => {
      if (h.key !== key) return false;
      // A stable delivery id is authoritative regardless of timing.
      if (utterance.utteranceId !== undefined) return true;
      if (!Number.isFinite(atMs) || !Number.isFinite(h.atMs)) return false;
      const delta = atMs - h.atMs;
      return delta >= 0 && delta <= REPLAY_WINDOW_MS;
    });
  }

  private remember(utterance: VoiceUtterance, response: VoiceResponse): void {
    const atMs = Date.parse(utterance.receivedAt);
    this.handled = [
      { key: this.replayKey(utterance), atMs: Number.isFinite(atMs) ? atMs : 0, response },
      ...this.handled.filter((h) => h.key !== this.replayKey(utterance)),
    ].slice(0, MAX_TRACKED_UTTERANCES);
  }

  /** Clears replay memory. Called when the session subject changes. */
  resetDeliveryMemory(): void {
    this.handled = [];
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
