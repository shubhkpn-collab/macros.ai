import {
  instant,
  type ActiveEnergyResolution,
  type Instant,
  type ProductVersion,
  type WeightCapture,
} from '@macros/contracts';
import { calculateNutrition } from '@macros/domain-nutrition';
import { searchFood, type FoodSearchResult } from '@macros/domain-food-search';
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

    const results = searchFood(catalog, { text: query, limit: 4, recentProductVersionIds });
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
    });
  }

  /** Cancel leaves persisted logs untouched and commits nothing. */
  cancelFoodFlow(): void {
    this.cancelOutstandingCaptureIntent();
    this.flowCounter += 1;
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
  async switchActiveUser(subject: AppSubject, activity: ActiveEnergyResolution): Promise<void> {
    assertSubjectBinding(subject);
    this.cancelOutstandingCaptureIntent();
    this.flowCounter += 1;

    // If the platform is still loaded, the food on it belongs to the OUTGOING
    // user. The incoming user may not capture that placement, so scale capture
    // is gated until the platform is observed clear. Manual entry stays open.
    const platformLoaded =
      this.captureState.phase !== 'disconnected' && this.captureState.phase !== 'ready';

    this.patch({
      subject,
      activity,
      sessionGeneration: this.state.sessionGeneration + 1,
      dashboard: null,
      addFood: { ...IDLE_ADD_FOOD, flowId: `flow-${this.flowCounter}` },
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
