import {
  instant,
  type ActiveEnergyResolution,
  type Instant,
  type ProductVersion,
  type WeightCapture,
} from '@macros/contracts';
import { calculateNutrition } from '@macros/domain-nutrition';
import {
  buildGuidanceEnvelope, requestGuidance,
  type GuidanceEnvelope, type GuidanceProvider,
} from '@macros/guidance';
import {
  IDLE_GUIDANCE, type GuidanceCandidateView, type GuidancePhase, type GuidanceState,
} from './state.js';

/**
 * What the guidance intent needs from the host.
 *
 * Passed in rather than reached for, so the controller never owns a provider or
 * a clock and a test can supply either without touching production wiring.
 */
export interface GuidanceDeps {
  readonly provider: GuidanceProvider | null;
  eligibleCandidates(): Promise<readonly unknown[]>;
  nowIso(): string;
  readonly policy: unknown;
  readonly environment: string;
}
import {
  buildVocabulary, resilientSearch,
  type FoodSearchResult, type QueryConfidence,
} from '@macros/domain-food-search';
import { manualCapture, reduceCapture, initialState, type WeightCaptureState } from '@macros/domain-weight';
import type { WeightStabilityPolicy, WeightCaptureEvent } from '@macros/scale-protocol';
import {
  logFoodPersisted,
  recomputeDayFromStorage,
  type PersistedLoopRepositories,
} from '@macros/persistence';
import type { LoopPolicies } from '@macros/core-loop';
import { assertSubjectBinding, type AppSubject, type Clock, type IdGenerator } from './ports.js';
import {
  IDLE_ADD_FOOD,
  type AddFoodState,
  type AppError,
  type AppErrorCode,
  type AppState,
  type DashboardState,
  type ScaleViewState,
} from './state.js';

export const TABLET_APP_CORE_VERSION = 'tablet-app-core@1.0.0';

export interface AppEnvironment {
  readonly repositories: PersistedLoopRepositories;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly policies: LoopPolicies;
  readonly stabilityPolicy: WeightStabilityPolicy;
  readonly timezone: string;
  readonly rolloverHour?: number;
  /** Present while the run uses synthetic fixtures or simulated activity. */
  readonly developmentDataNotice?: string;
}

const err = (code: AppErrorCode, message: string, recoverable = true): AppError => ({
  code,
  message,
  recoverable,
});

const previewOf = (product: ProductVersion, capture: WeightCapture) => {
  // The preview is the SAME deterministic calculation the log will use.
  // No arithmetic is ever duplicated in presentation code.
  const totals = calculateNutrition(product.basis, capture.grams).totals;
  return {
    kcal: totals.kcal,
    proteinG: totals.proteinG,
    carbohydrateG: totals.carbohydrateG,
    fatG: totals.fatG,
  };
};

/**
 * THE TABLET APPLICATION CORE.
 *
 * Touch and future voice are two INPUT ADAPTERS onto these same intents. No
 * business rule may live in a button handler, and no screen may hold state the
 * controller does not own.
 *
 * Nothing here computes nutrition, macros or energy — it coordinates the closed
 * deterministic domains and the repository boundary, and nothing more.
 */
export class TabletAppController {
  private state: AppState;
  private captureState: WeightCaptureState;
  private flowCounter = 0;
  /** Only the NEWEST search in the current flow may update results. */
  private searchGeneration = 0;
  /** Confidence of the most recent search. Read by callers deciding whether to
   *  auto-select; never used to auto-select from inside the controller. */
  private lastSearchConfidence: QueryConfidence = 'unresolved';
  /** Only the NEWEST guidance request may update guidance state. */
  private guidanceGeneration = 0;
  /** Identifies the envelope currently on screen, for choice validation. */
  private activeEnvelope: { id: string; envelope: GuidanceEnvelope } | null = null;
  private lastSearchDidYouMean: string | null = null;

  constructor(
    private readonly env: AppEnvironment,
    subject: AppSubject,
    activity: ActiveEnergyResolution,
  ) {
    assertSubjectBinding(subject);
    this.captureState = initialState(env.stabilityPolicy);
    this.state = {
      subject,
      sessionGeneration: 1,
      guidance: IDLE_GUIDANCE,
      dashboard: null,
      addFood: IDLE_ADD_FOOD,
      scale: { connected: false, phase: 'disconnected', displayGrams: null, stableCandidateGrams: null, message: 'Scale not connected' },
      activity,
      requiresScaleClearForCurrentSubject: false,
    };
  }

  getState(): AppState {
    return this.state;
  }

  /** How much the last search could be trusted, and what we corrected. */
  getGuidanceState(): GuidanceState {
    return this.state.guidance;
  }

  /**
   * THE guidance intent.
   *
   * The development "What should I eat?" button and, later, voice both call
   * exactly this — there is deliberately no UI-only recommendation path, or the
   * two would drift apart the moment either changed.
   *
   * A fresh envelope is built from CURRENT trusted state on every call. Reusing
   * a previous envelope would answer a question about a day that has since
   * changed, which is precisely what makes the post-log recommendation wrong.
   */
  async requestFoodGuidance(deps: GuidanceDeps): Promise<GuidanceState> {
    this.guidanceGeneration += 1;
    const generation = this.guidanceGeneration;
    const sessionGeneration = this.state.sessionGeneration;

    this.patchGuidance({ phase: 'thinking', text: '', candidates: [], alternatives: [] });

    const dashboard = await this.refreshDashboard();
    const candidates = await deps.eligibleCandidates();

    // A switch or a newer request during the await invalidates this result.
    if (generation !== this.guidanceGeneration
        || sessionGeneration !== this.state.sessionGeneration) {
      return this.state.guidance;
    }

    if (dashboard === null) {
      this.patchGuidance({ phase: 'fallback', text: 'I need a bit more information first.' });
      return this.state.guidance;
    }

    const envelope = buildGuidanceEnvelope({
      userId: this.state.subject.userId,
      nowIso: deps.nowIso(),
      localDate: dashboard.localDate,
      energy: dashboard.energy,
      macros: dashboard.macros,
      candidates,
      history: { userId: this.state.subject.userId, observations: [] },
      preferences: null,
      policy: deps.policy,
      environment: deps.environment,
    } as never, {
      subjectId: this.state.subject.userId,
      sessionId: this.state.subject.sessionId,
    });

    const outcome = await requestGuidance(envelope, 'what_should_i_eat',
      { provider: deps.provider });

    // Re-checked AFTER the provider await: a slow result must never overwrite
    // newer state, and must never surface to a different member.
    if (generation !== this.guidanceGeneration
        || sessionGeneration !== this.state.sessionGeneration) {
      return this.state.guidance;
    }

    const envelopeId = `env-${generation}`;
    this.activeEnvelope = { id: envelopeId, envelope };

    const view = (c: { productId: string; productVersionId: string;
      displayName: string; role: string }): GuidanceCandidateView => ({
      productId: c.productId, productVersionId: c.productVersionId,
      displayName: c.displayName, role: c.role,
    });

    const phase: GuidancePhase = outcome.candidates.length === 0
      ? (outcome.usedFallback ? 'fallback' : 'guidance_available')
      : outcome.nextAction === 'await_clarification' ? 'awaiting_clarification'
      : 'awaiting_choice';

    this.patchGuidance({
      phase,
      text: outcome.text,
      candidates: outcome.candidates.map(view),
      alternatives: envelope.alternatives.map(view),
      envelopeId,
      sessionGeneration,
      usedFallback: outcome.usedFallback,
    });
    return this.state.guidance;
  }

  /**
   * Choose a food the guidance actually offered.
   *
   * The id must belong to the CURRENTLY ACTIVE envelope. Anything else — an id
   * from a superseded envelope, from another member, or invented — is refused
   * rather than searched for, because a food we did not offer has no trusted
   * recommendation behind it.
   */
  async chooseGuidanceCandidate(
    productVersionId: string,
    envelopeId: string,
  ): Promise<GuidanceState> {
    const active = this.activeEnvelope;
    const stale = active === null || active.id !== envelopeId
      || this.state.guidance.envelopeId !== envelopeId
      || this.state.guidance.sessionGeneration !== this.state.sessionGeneration;

    const offered = active === null ? false
      : [...active.envelope.planComponents, ...active.envelope.alternatives]
        .some((c) => c.productVersionId === productVersionId);

    if (stale || !offered) {
      this.patchGuidance({
        phase: 'awaiting_clarification',
        text: "I don't have that as an option right now.",
        candidates: [], alternatives: [],
      });
      return this.state.guidance;
    }

    // HANDOFF into the EXISTING weighing flow. No second food logger exists:
    // selectProduct is the same path the touch flow uses.
    this.beginAddFood();
    await this.selectProduct(productVersionId);

    this.patchGuidance({
      phase: 'awaiting_weight',
      text: 'Put it on the scale when you\'re ready.',
    });
    return this.state.guidance;
  }

  /** Invalidate guidance. Called on log, switch, lock and cancellation. */
  clearGuidance(): void {
    this.guidanceGeneration += 1;
    this.activeEnvelope = null;
    this.state = { ...this.state, guidance: IDLE_GUIDANCE };
  }

  private patchGuidance(patch: Partial<GuidanceState>): void {
    this.state = { ...this.state, guidance: { ...this.state.guidance, ...patch } };
  }

  getSearchConfidence(): {
    readonly confidence: QueryConfidence;
    readonly didYouMean: string | null;
  } {
    return { confidence: this.lastSearchConfidence, didYouMean: this.lastSearchDidYouMean };
  }

  getCaptureState(): WeightCaptureState {
    return this.captureState;
  }

  private patch(next: Partial<AppState>): void {
    this.state = { ...this.state, ...next };
  }

  private patchFlow(next: Partial<AddFoodState>): void {
    this.patch({ addFood: { ...this.state.addFood, ...next } });
  }

  // -------------------------------------------------------------------------
  // Dashboard
  // -------------------------------------------------------------------------

  /**
   * Rebuild the dashboard from the repository. Energy inputs may be missing or
   * degraded; that is reported honestly and NEVER blocks food logging.
   */
  async refreshDashboard(): Promise<DashboardState | null> {
    const generation = this.state.sessionGeneration;
    const at = this.env.clock.now();

    let result;
    try {
      result = await recomputeDayFromStorage(this.env.repositories, {
        userId: this.state.subject.userId,
        at,
        timezone: this.env.timezone,
        ...(this.env.rolloverHour !== undefined ? { rolloverHour: this.env.rolloverHour } : {}),
        activity: this.state.activity,
        policies: this.env.policies,
      });
    } catch (cause) {
      if (generation !== this.state.sessionGeneration) return this.state.dashboard;
      const message = cause instanceof Error ? cause.message : String(cause);
      const code: AppErrorCode = message.includes('profile')
        ? 'profile_missing'
        : message.includes('goal')
          ? 'goal_missing'
          : 'repository_failure';
      this.patchFlow({ error: err(code, message, false) });
      return null;
    }

    // A result for a user who is no longer active must never land.
    if (generation !== this.state.sessionGeneration) return this.state.dashboard;

    const dashboard: DashboardState = {
      localDate: result.localDate,
      intake: result.intake,
      macros: result.macros,
      guardrails: result.guardrails,
      energy: result.energy,
      energyIncomplete: result.energy.energyCompleteness !== 'complete',
      energyGaps: result.energy.completenessGaps,
      activitySource: result.energy.activitySource,
      developmentDataNotice: this.env.developmentDataNotice ?? null,
    };
    this.patch({ dashboard });
    return dashboard;
  }

  // -------------------------------------------------------------------------
  // Add-food intents
  // -------------------------------------------------------------------------

  beginAddFood(): void {
    this.flowCounter += 1;
    this.patch({
      addFood: { ...IDLE_ADD_FOOD, phase: 'searching', flowId: `flow-${this.flowCounter}` },
    });
  }

  async searchFood(query: string): Promise<readonly FoodSearchResult[]> {
    if (this.state.addFood.phase === 'idle') this.beginAddFood();
    const { flowId } = this.state.addFood;
    const generation = this.state.sessionGeneration;
    // Two searches inside the SAME flow race: "chi" then "chicken". Whichever
    // resolves last must not win — only the newest request may land.
    this.searchGeneration += 1;
    const searchGeneration = this.searchGeneration;

    const [catalog, recentProductVersionIds] = await Promise.all([
      this.env.repositories.products.listSearchable(),
      this.env.repositories.foodLogs.listRecentProductVersionIds(this.state.subject.userId, 20),
    ]);

    // A result from a cancelled flow, a previous user, or a superseded query
    // must not land.
    if (
      this.state.addFood.flowId !== flowId ||
      generation !== this.state.sessionGeneration ||
      searchGeneration !== this.searchGeneration
    ) {
      return this.state.addFood.results;
    }

    // THE AUTHORITATIVE PATH. Touch and future voice both arrive here, so both
    // inherit identical resilience and confidence semantics. The vocabulary is
    // rebuilt from the same catalog snapshot the ranker sees, so a correction
    // can never reference a term the search set does not contain.
    const vocabulary = buildVocabulary(catalog);
    const response = resilientSearch(catalog, vocabulary, {
      text: query, limit: 4, recentProductVersionIds,
    });
    const results = response.results;

    // A corrected or uncertain query must never be silently promoted into a
    // confident different food. The flow records what happened so the UI can
    // ask; it does not decide on the person's behalf.
    this.lastSearchConfidence = response.confidence;
    this.lastSearchDidYouMean = response.didYouMean;

    this.patchFlow({
      query,
      results,
      phase: 'searching',
      error: results.length === 0 && query.trim().length > 0
        ? err('no_results', `No match for "${query}". Try a different word.`)
        : null,
    });
    return results;
  }

  /** Voice will call this with the same id after hearing "Option B". */
  async selectProduct(productVersionId: string): Promise<void> {
    const { flowId } = this.state.addFood;
    const generation = this.state.sessionGeneration;

    const product = await this.env.repositories.products.getVersion(productVersionId);

    // A product resolved for a cancelled flow or a previous user must not land.
    if (this.state.addFood.flowId !== flowId || generation !== this.state.sessionGeneration) return;

    if (product === null) {
      this.patchFlow({ error: err('product_not_found', 'That product no longer exists.') });
      return;
    }
    // A weight already captured for THIS flow survives selection. The kitchen
    // order is food-then-weight or weight-then-food, and the user must never be
    // made to lift and re-place food merely because they named it second.
    const held = this.state.addFood.weightCapture;
    if (held !== null) {
      this.patchFlow({
        selected: product,
        preview: previewOf(product, held),
        phase: 'reviewing',
        error: null,
      });
      return;
    }
    this.patchFlow({
      selected: product,
      phase: 'waiting_for_weight',
      weightCapture: null,
      preview: null,
      error: null,
    });
  }

  /** Resolve a spoken option label (A/B/C/D) to the exact product version. */
  selectOption(label: string): Promise<void> {
    const match = this.state.addFood.results.find(
      (r) => r.optionLabel.toUpperCase() === label.toUpperCase(),
    );
    if (match === undefined) {
      this.patchFlow({ error: err('product_not_found', `No option ${label}.`) });
      return Promise.resolve();
    }
    return this.selectProduct(match.productVersion.productVersionId);
  }

  // -------------------------------------------------------------------------
  // Weight
  // -------------------------------------------------------------------------

  /** Feed a device event through the CLOSED capture state machine. */
  applyScaleEvent(event: WeightCaptureEvent): void {
    const result = reduceCapture(this.captureState, event, this.env.stabilityPolicy);
    this.captureState = result.state;

    const scale: ScaleViewState = {
      connected: result.state.phase !== 'disconnected',
      phase: result.state.phase,
      displayGrams: result.state.lastGrams,
      stableCandidateGrams: result.state.candidate?.grams ?? null,
      message: describeScale(result.state.phase),
    };
    this.patch({ scale });

    // The gate lifts only when the host OBSERVES the platform genuinely clear.
    // We never fabricate a disconnect, and the scale domain stays user-agnostic.
    if (
      this.state.requiresScaleClearForCurrentSubject &&
      (result.state.phase === 'ready' || result.state.phase === 'disconnected')
    ) {
      this.patch({ requiresScaleClearForCurrentSubject: false });
    }

    // A capture only ever arrives because the application asked for one.
    if (result.capture !== null) this.acceptCapture(result.capture);

    if (result.state.phase === 'fault' || result.state.phase === 'overload') {
      const code: AppErrorCode = result.state.phase === 'fault' ? 'scale_fault' : 'scale_overload';
      if (this.state.addFood.phase === 'waiting_for_weight') {
        this.patchFlow({ error: err(code, describeScale(result.state.phase)) });
      }
    }
  }

  /**
   * Explicit capture intent. A stable candidate is NOT a capture — the
   * application must ask, which is what lets the user identify food after the
   * weight has already settled.
   */
  requestStableWeight(): void {
    if (this.captureState.phase === 'disconnected') {
      this.patchFlow({ error: err('scale_disconnected', 'Scale is not connected.') });
      return;
    }
    if (this.state.requiresScaleClearForCurrentSubject) {
      // The platform still holds the previous user's placement.
      this.patchFlow({
        error: err('scale_requires_clear', 'Clear the scale before weighing for this user.'),
      });
      return;
    }
    // ONE id per logical weight attempt. Pressing again while it settles is an
    // idempotent retry, not a second request — and never the submission id,
    // which identifies a different operation entirely.
    const requestId = this.state.addFood.captureRequestId ?? this.env.ids.next();
    if (this.state.addFood.captureRequestId === null) this.patchFlow({ captureRequestId: requestId });
    const result = reduceCapture(
      this.captureState,
      { kind: 'capture_requested', requestId, at: this.env.clock.now() },
      this.env.stabilityPolicy,
    );
    this.captureState = result.state;

    if (result.capture !== null) {
      this.acceptCapture(result.capture);
      return;
    }
    if (result.captureRejection === 'candidate_stale') {
      this.patchFlow({ error: err('candidate_stale', 'That reading is stale. Waiting for a fresh one.') });
      return;
    }
    if (result.captureRejection === 'duplicate_request') {
      // The same attempt asked twice. Idempotent, not an error.
      return;
    }
    if (result.captureRejection !== null && result.captureRejection !== 'no_candidate') {
      this.patchFlow({ error: err('capture_rejected', `Cannot capture right now (${result.captureRejection}).`) });
    }
    // 'no_candidate' means the intent is armed and will fire when it settles.
  }

  /** Manual fallback. Never fabricates scale provenance. */
  enterManualWeight(grams: number): void {
    if (!Number.isFinite(grams) || grams <= 0) {
      this.patchFlow({ error: err('invalid_manual_weight', 'Enter a weight greater than zero.') });
      return;
    }
    // The user has chosen manual. An armed scale intent must not fire later and
    // silently replace that choice when the platform happens to settle.
    this.cancelOutstandingCaptureIntent();
    this.patchFlow({ captureRequestId: null });
    this.acceptCapture(manualCapture(grams, this.env.clock.now()));
  }

  private acceptCapture(capture: WeightCapture): void {
    // The weight attempt is over; the next placement gets a fresh id.
    if (this.state.addFood.captureRequestId !== null) this.patchFlow({ captureRequestId: null });
    const selected = this.state.addFood.selected;
    if (selected === null) {
      // Weight first, food not chosen yet: hold it and keep searching.
      this.patchFlow({ weightCapture: capture, error: null });
      return;
    }
    this.patchFlow({
      weightCapture: capture,
      preview: previewOf(selected, capture),
      phase: 'reviewing',
      error: null,
    });
  }

  /**
   * Abandon the weight attempt but keep the chosen food.
   *
   * The armed capture intent MUST be cancelled too: otherwise the scale settles
   * a moment later and the abandoned attempt captures anyway.
   */
  cancelWeight(): void {
    this.cancelOutstandingCaptureIntent();
    this.patchFlow({
      weightCapture: null,
      preview: null,
      captureRequestId: null,
      phase: 'waiting_for_weight',
      error: null,
    });
  }

  // -------------------------------------------------------------------------
  // Commit
  // -------------------------------------------------------------------------

  /**
   * Idempotent submission. One logical submission holds ONE id, so a double tap
   * or a retry reuses it and cannot create a second log.
   */
  async confirmFoodLog(): Promise<void> {
    const flow = this.state.addFood;
    if (flow.selected === null) {
      this.patchFlow({ error: err('product_not_found', 'Choose a food first.') });
      return;
    }
    if (flow.weightCapture === null) {
      this.patchFlow({ error: err('no_weight', 'Capture a weight first.') });
      return;
    }
    if (flow.phase === 'logging') return; // a second tap while in flight is a no-op

    const submissionId = flow.submissionId ?? this.env.ids.next();
    const { flowId } = flow;
    const generation = this.state.sessionGeneration;
    this.patchFlow({ phase: 'logging', submissionId, error: null });

    let result;
    try {
      result = await logFoodPersisted(this.env.repositories, {
        userId: this.state.subject.userId,
        logId: submissionId,
        productVersionId: flow.selected.productVersionId,
        weightCapture: flow.weightCapture,
        loggedAt: this.env.clock.now(),
        timezone: this.env.timezone,
        ...(this.env.rolloverHour !== undefined ? { rolloverHour: this.env.rolloverHour } : {}),
        activity: this.state.activity,
        policies: this.env.policies,
      });
    } catch (cause) {
      if (this.state.addFood.flowId !== flowId || generation !== this.state.sessionGeneration) return;
      this.patchFlow({
        phase: 'error',
        error: err('repository_failure', cause instanceof Error ? cause.message : String(cause)),
      });
      return;
    }

    // A response for a cancelled flow or a previous user must never land.
    if (this.state.addFood.flowId !== flowId || generation !== this.state.sessionGeneration) return;

    if (result.outcome === 'idempotency_conflict') {
      // Never reported as success: a genuinely different log would be lost.
      this.patchFlow({
        phase: 'error',
        outcome: result.outcome,
        error: err('idempotency_conflict', 'This entry conflicts with one already recorded.', false),
      });
      return;
    }

    this.patch({
      dashboard: {
        localDate: result.localDate,
        intake: result.intake,
        macros: result.macros,
        guardrails: result.guardrails,
        energy: result.energy,
        energyIncomplete: result.energy.energyCompleteness !== 'complete',
        energyGaps: result.energy.completenessGaps,
        activitySource: result.energy.activitySource,
        developmentDataNotice: this.env.developmentDataNotice ?? null,
      },
      addFood: { ...this.state.addFood, phase: 'completed', outcome: result.outcome, error: null },
      /**
       * The logged food changed today's intake, so guidance built on the
       * PREVIOUS state is now answering a question about a day that no longer
       * exists. Clearing here is what forces the next request to rebuild from
       * recomputed energy and macros.
       */
      guidance: IDLE_GUIDANCE,
    });
  }

  /** Cancel leaves persisted logs untouched and commits nothing. */
  cancelFoodFlow(): void {
    this.cancelOutstandingCaptureIntent();
    this.flowCounter += 1;
    /**
     * The outgoing member's guidance — text, offered candidates, envelope and
     * any pending weighing prompt — must not survive into the incoming
     * member's state. Bumping the generation also discards any request still
     * in flight for the previous member.
     */
    this.clearGuidance();
    this.patch({ addFood: { ...IDLE_ADD_FOOD, flowId: `flow-${this.flowCounter}` } });
  }

  private cancelOutstandingCaptureIntent(): void {
    const pending = this.captureState.pendingCaptureRequest;
    if (pending === null) return;
    this.captureState = reduceCapture(
      this.captureState,
      { kind: 'capture_cancelled', requestId: pending.requestId, at: this.env.clock.now() },
      this.env.stabilityPolicy,
    ).state;
  }

  // -------------------------------------------------------------------------
  // Session
  // -------------------------------------------------------------------------

  /**
   * Switching users abandons everything uncommitted. User A's selection and
   * weight may never be logged under user B.
   */
  async switchActiveUser(
    subject: AppSubject,
    activity: ActiveEnergyResolution,
    activeSession: { readonly userId: string; readonly sessionGeneration: number },
  ): Promise<void> {
    assertSubjectBinding(subject);
    // An authorized session is REQUIRED. The optional parameter and the
    // `+ 1` fallback let the controller mint a generation of its own, which
    // meant the single-writer rule held only when a caller opted in.
    if (activeSession === undefined || activeSession === null) {
      throw new Error('switchActiveUser: an authorized ActiveUserSession is required');
    }
    if (activeSession.userId !== subject.userId) {
      throw new Error('switchActiveUser: authorized session does not match the subject');
    }
    this.cancelOutstandingCaptureIntent();
    this.flowCounter += 1;
    /**
     * The outgoing member's guidance — text, offered candidates, envelope and
     * any pending weighing prompt — must not survive into the incoming
     * member's state. Bumping the generation also discards any request still
     * in flight for the previous member.
     */
    this.clearGuidance();

    // If the platform is still loaded, the food on it belongs to the OUTGOING
    // user. The incoming user may not capture that placement, so scale capture
    // is gated until the platform is observed clear. Manual entry stays open.
    const platformLoaded =
      this.captureState.phase !== 'disconnected' && this.captureState.phase !== 'ready';

    this.patch({
      subject,
      activity,
      // ALWAYS adopted. Household activation is the sole generation authority;
      // the switch machine adopts it, and so does this controller.
      sessionGeneration: activeSession.sessionGeneration,
      dashboard: null,
      addFood: { ...IDLE_ADD_FOOD, flowId: `flow-${this.flowCounter}` },
      guidance: IDLE_GUIDANCE,
      requiresScaleClearForCurrentSubject: platformLoaded,
    });
    await this.refreshDashboard();
  }
}

function describeScale(phase: WeightCaptureState['phase']): string {
  switch (phase) {
    case 'disconnected': return 'Scale not connected';
    case 'ready': return 'Place food on scale';
    case 'stabilizing': return 'Stabilizing…';
    case 'stable': return 'Ready to capture';
    case 'awaiting_clear': return 'Remove food to continue';
    case 'overload': return 'Too heavy for the scale';
    case 'calibration_required': return 'Scale needs calibration';
    case 'fault': return 'Scale fault';
  }
}

export { instant as _instant };
export type { Instant };
