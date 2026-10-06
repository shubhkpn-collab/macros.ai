import type { GuidanceDeps, TabletAppController } from '@macros/tablet-app-core';

/**
 * RN ACTION ADAPTER.
 *
 * Maps screen intents onto the EXISTING public `TabletAppController` API. The
 * previous version called `logFood`, `restartSelection` and `cancelAddFood`,
 * none of which exist — a straight compile defect. No domain method is invented
 * here to suit React Native.
 *
 * KNOWN LIMITATION — "change food" cannot preserve a captured weight.
 * `cancelFoodFlow()` resets the whole flow and issues a new `flowId`; there is
 * no controller API for "keep the weight, choose a different food". Rather than
 * fabricate one or leave a half-reset flow behind, the safest existing
 * behaviour is used: the flow is cancelled cleanly and a new one begins, so the
 * user re-weighs. Losing a weight is recoverable; carrying a weight onto the
 * wrong food silently is not.
 */
export const ACTION_ADAPTER_VERSION = 'tablet-actions@1.0.0';

/** Every controller method this adapter is allowed to call. */
export const CONTROLLER_METHODS = [
  'beginAddFood', 'searchFood', 'selectProduct', 'selectOption',
  'requestStableWeight', 'enterManualWeight', 'cancelWeight',
  'confirmFoodLog', 'cancelFoodFlow', 'refreshDashboard', 'switchActiveUser', 'updateEnergyGoal',
] as const;

/**
 * The native host supplies member selection and credential collection. The
 * renderer must not contain auth logic, and a tap must not be a no-op.
 */
export interface AuthHostPort {
  /**
   * Begin member selection → confirmation → credential capture, driven by the
   * host through the existing SharedDeviceAuthCoordinator.
   *
   * Resolves once the coordinator has settled. `switched` means an authorized
   * ActiveUserSession exists and the caller must adopt it.
   */
  beginMemberSelection(): Promise<
    | { readonly kind: 'switched'; readonly session: { readonly userId: string; readonly sessionGeneration: number };
        readonly subject: Parameters<TabletAppController['switchActiveUser']>[0] }
    | { readonly kind: 'cancelled' }
    | { readonly kind: 'refused'; readonly reason: string }
  >;
  /** False until the native credential surface exists; rendered honestly. */
  readonly credentialSurfaceAvailable: boolean;
}

export interface ActionDeps {
  readonly controller: TabletAppController;
  /** Supplied by the host. Absent means guidance is unavailable on this build. */
  readonly guidance?: GuidanceDeps;
  readonly auth: AuthHostPort;
  readonly activity: () => Parameters<TabletAppController['switchActiveUser']>[1];
  readonly onChanged: () => void;
  /** How long the "Logged" confirmation is shown before returning home. */
  readonly loggedDwellMs?: number;
  readonly schedule?: (fn: () => void, ms: number) => void;
}

export interface TabletActions {
  onAddFood(): void;
  onSaveGoal(delta: number): Promise<boolean>;
  onRequestGuidance(): void;
  onChooseGuidanceCandidate(productVersionId: string, envelopeId: string): void;
  onSearchFood(query: string): void;
  onEnterManualWeight(grams: number): void;
  onSelectOption(productVersionId: string): void;
  onUseWeight(): void;
  onLog(): void;
  onChangeFood(): void;
  onChangeWeight(): void;
  onCancel(): void;
  onSelectMember(): void;
}

export function createActions(deps: ActionDeps): TabletActions {
  const { controller, onChanged } = deps;
  const after = <T,>(p: Promise<T>): void => { onChanged(); void p.then(onChanged, onChanged); };
  const schedule = deps.schedule ?? ((fn, ms) => { setTimeout(fn, ms); });

  return {
    onSaveGoal: async (delta) => {
      const saved = await controller.updateEnergyGoal(delta);
      onChanged();
      return saved;
    },
    onAddFood: () => { controller.beginAddFood(); onChanged(); },

    /**
     * THE guidance intent — the same one voice will call later. The component
     * knows nothing about envelopes, providers or recommendation; it invokes an
     * application intent and re-renders.
     */
    onRequestGuidance: () => {
      if (deps.guidance === undefined) return;
      after(controller.requestFoodGuidance(deps.guidance));
    },

    onChooseGuidanceCandidate: (productVersionId, envelopeId) => {
      after(controller.chooseGuidanceCandidate(productVersionId, envelopeId));
    },

    // Straight to the controller: its stale-search protection and error
    // handling are the authority, and duplicating search logic in RN would give
    // us two answers to the same question.
    onSearchFood: (query) => { after(controller.searchFood(query)); },

    onSelectOption: (productVersionId) => { after(controller.selectProduct(productVersionId)); },

    /**
     * Manual weight fallback, used when no scale is connected.
     *
     * The controller validates the value and records MANUAL provenance; the
     * renderer neither fabricates stability nor claims a device reading.
     */
    onEnterManualWeight: (grams) => { controller.enterManualWeight(grams); onChanged(); },

    onUseWeight: () => { controller.requestStableWeight(); onChanged(); },

    /**
     * Commit. `confirmFoodLog` is idempotent — one submission holds one id — so
     * a double tap cannot create a second log.
     *
     * After a brief confirmation the flow is cancelled to return home. That
     * resets only the UI flow; the persisted log is untouched, and the
     * dashboard is refreshed so home reflects it.
     */
    onLog: () => {
      const confirmation = controller.confirmFoodLog();
      onChanged();
      void confirmation.then(() => {
        onChanged();
        const state = controller.getState().addFood;
        // Only leave the confirmation when the log actually succeeded. A
        // failure must stay visible rather than being swept back to home.
        if (state.phase !== 'completed') return;
        schedule(() => {
          controller.cancelFoodFlow();
          void controller.refreshDashboard().then(onChanged, onChanged);
        }, deps.loggedDwellMs ?? 1200);
      }, onChanged);
    },

    // See the limitation note above: the weight cannot be carried across.
    onChangeFood: () => {
      controller.cancelFoodFlow();
      controller.beginAddFood();
      onChanged();
    },

    // This one DOES preserve the selected food: cancelWeight returns the flow
    // to waiting_for_weight with the product intact.
    onChangeWeight: () => { controller.cancelWeight(); onChanged(); },

    onCancel: () => { controller.cancelFoodFlow(); onChanged(); },

    /**
     * Member selection. Delegated to the host, which owns the coordinator.
     *
     * A refusal or cancellation leaves the current user active — the renderer
     * simply re-projects and A is still there.
     */
    onSelectMember: () => {
      void deps.auth.beginMemberSelection().then((outcome) => {
        if (outcome.kind !== 'switched') {
          onChanged(); return;
        }
        // The authorized session is passed through; the controller adopts its
        // generation and never mints one.
        void controller
          .switchActiveUser(outcome.subject, deps.activity(), outcome.session)
          .then(onChanged, onChanged);
      }, onChanged);
    },
  };
}
