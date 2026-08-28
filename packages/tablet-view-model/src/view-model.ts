import type { AppState } from '@macros/tablet-app-core';
import type { OfflineCapabilities } from '@macros/domain-offline-sync';
import type { SwitchState } from '@macros/domain-household';

/**
 * TABLET VIEW MODEL.
 *
 * domain/application state → view model → React Native renderer.
 *
 * This layer decides WHAT IS SHOWN. Components decide only how it looks. Every
 * number here is copied from a trusted domain result: nothing is added,
 * scaled, converted or rounded into existence. A renderer that could do
 * arithmetic could disagree with the food log, and the log is the truth.
 */
export const VIEW_MODEL_VERSION = 'tablet-view-model@1.0.0';

export type Screen =
  | 'locked' | 'home' | 'food_search' | 'food_options'
  | 'weighing' | 'review' | 'logged';

/** Voice presence, mapped from application state — never invented by the UI. */
export type VoicePresence =
  | 'idle' | 'listening' | 'interpreting' | 'needs_choice'
  | 'waiting_for_weight' | 'review' | 'logging' | 'completed'
  | 'refused' | 'offline';

export interface IdentityView {
  readonly displayName: string;
  readonly userId: string;
  /** True only while a switch is authenticating; A stays visible meanwhile. */
  readonly switchPending: boolean;
  readonly pendingTargetName: string | null;
}

export interface EnergyBalanceView {
  /** Negative = deficit, positive = surplus. Copied, never computed. */
  readonly balanceKcal: number;
  /** "327 kcal deficit right now" — semantic, not "calories remaining". */
  readonly semantic: string;
  readonly direction: 'deficit' | 'surplus' | 'even';
  /** Visually subordinate projection, when the energy engine supplies one. */
  readonly projectionNote: string | null;
  /** True when any input is missing; the number must not look authoritative. */
  readonly incomplete: boolean;
  readonly gaps: readonly string[];
}

export interface MacroView {
  readonly label: string;
  readonly consumedG: number;
  readonly goalG: number;
  readonly remainingG: number;
  /** 0..1, clamped for layout only. Null when no goal exists. */
  readonly fraction: number | null;
}

export interface FoodOptionView {
  /** MUST equal the orchestration label: spoken "Option B" selects this row. */
  readonly optionLabel: string;
  readonly productVersionId: string;
  readonly displayName: string;
  readonly brand: string | null;
  readonly preparationState: string;
  /** True when preparation is what distinguishes this from a sibling. */
  readonly preparationMatters: boolean;
}

export interface ScaleView {
  readonly connected: boolean;
  readonly phase: string;
  readonly displayGrams: number | null;
  readonly message: string;
  /** ONLY a settled candidate may be committed. Unstable never qualifies. */
  readonly canCommitWeight: boolean;
}

export interface ReviewView {
  readonly displayName: string;
  readonly brand: string | null;
  readonly preparationState: string;
  readonly grams: number;
  readonly kcal: number;
  readonly proteinG: number;
  readonly carbohydrateG: number;
  readonly fatG: number;
}

export interface OfflineView {
  readonly offline: boolean;
  readonly canLog: boolean;
  readonly pendingCount: number;
  /** Truthful wording: queued is NOT persisted. */
  readonly message: string | null;
}

export interface TabletViewModel {
  readonly screen: Screen;
  /** Echoed so the search field can show what was actually searched for. */
  readonly searchQuery: string;
  readonly identity: IdentityView | null;
  readonly voice: VoicePresence;
  readonly energy: EnergyBalanceView | null;
  readonly macros: readonly MacroView[];
  readonly recent: readonly { readonly displayName: string; readonly kcal: number }[];
  readonly options: readonly FoodOptionView[];
  readonly scale: ScaleView;
  readonly review: ReviewView | null;
  readonly offline: OfflineView;
  readonly error: { readonly message: string; readonly recoverable: boolean } | null;
  /** Guards a spoken "Option B" against a flow that has since moved on. */
  readonly flowId: string;
  readonly sessionGeneration: number;
}

export interface ViewModelInput {
  readonly app: AppState | null;
  readonly capabilities: OfflineCapabilities;
  readonly switchState: SwitchState;
  readonly recent: readonly { readonly displayName: string; readonly kcal: number }[];
}

const EMPTY_SCALE: ScaleView = {
  connected: false, phase: 'idle', displayGrams: null,
  message: 'Scale not connected', canCommitWeight: false,
};

const LOCKED_OFFLINE: OfflineView = {
  offline: false, canLog: false, pendingCount: 0, message: null,
};

/**
 * THE LOCKED VIEW.
 *
 * Built without touching `app` at all, so no field of the previous occupant's
 * dashboard can reach the screen even by accident. Returning a pruned copy of
 * the active model would leave that one refactor away from a leak.
 */
export function lockedViewModel(): TabletViewModel {
  return {
    screen: 'locked',
    searchQuery: '',
    identity: null,
    voice: 'idle',
    energy: null,
    macros: [],
    recent: [],
    options: [],
    scale: EMPTY_SCALE,
    review: null,
    offline: LOCKED_OFFLINE,
    error: null,
    flowId: 'locked',
    sessionGeneration: 0,
  };
}

/**
 * All three numbers are COPIED from the macro domain, which already computes
 * `remaining`. Subtracting here would be renderer arithmetic and could disagree
 * with the domain the moment its rounding or policy changed.
 *
 * `fraction` is layout geometry only — a bar width, never a nutrition claim —
 * and is clamped so an overshoot cannot draw outside its track.
 */
const macroOf = (
  label: string, consumedG: number, goalG: number, remainingG: number,
): MacroView => ({
  label,
  consumedG,
  goalG,
  remainingG,
  fraction: goalG <= 0 ? null : Math.min(1, Math.max(0, consumedG / goalG)),
});

function voicePresenceOf(app: AppState, offline: boolean): VoicePresence {
  if (offline) return 'offline';
  if (app.addFood.error !== null) return 'refused';
  switch (app.addFood.phase) {
    case 'searching':
      // A freshly-opened, empty search box is NOT the assistant thinking.
      // Claiming otherwise made the first real launch look broken: the screen
      // said "Thinking" while nothing was happening and nothing could be typed.
      if (app.addFood.results.length > 0) return 'needs_choice';
      return app.addFood.query.length > 0 ? 'interpreting' : 'idle';
    case 'product_selected': return app.addFood.results.length > 1 ? 'needs_choice' : 'waiting_for_weight';
    case 'waiting_for_weight': return 'waiting_for_weight';
    case 'weight_captured':
    case 'reviewing': return 'review';
    case 'logging': return 'logging';
    case 'completed': return 'completed';
    default: return 'idle';
  }
}

function screenOf(app: AppState): Screen {
  switch (app.addFood.phase) {
    case 'searching':
      // Previously this sent a fresh flow straight back to Home, so "Add food"
      // looked like a no-op: the phase changed but the screen did not.
      return app.addFood.results.length > 0 ? 'food_options' : 'food_search';
    case 'product_selected': return app.addFood.results.length > 1 ? 'food_options' : 'weighing';
    case 'waiting_for_weight': return 'weighing';
    case 'weight_captured':
    case 'reviewing': return 'review';
    case 'logging': return 'review';
    case 'completed': return 'logged';
    default: return 'home';
  }
}

/**
 * Build the model for an ACTIVE, authenticated user.
 *
 * `app === null` means no securely authenticated active user, and the locked
 * view is returned — the renderer never has to decide that itself.
 */
export function buildViewModel(input: ViewModelInput): TabletViewModel {
  const { app, capabilities, switchState } = input;
  if (app === null) return lockedViewModel();

  const offline = capabilities.foodLogging.reason === 'sync_pending'
    || capabilities.catalogSearch.status !== 'available';
  const canLog = capabilities.foodLogging.status !== 'unavailable';

  const dash = app.dashboard;
  const energy: EnergyBalanceView | null = dash === null ? null : {
    // COPIED from the energy domain. No arithmetic here.
    balanceKcal: dash.energy.currentBalanceKcal,
    semantic: describeBalance(dash.energy.currentBalanceKcal),
    direction: dash.energy.currentBalanceKcal < 0
      ? 'deficit' : dash.energy.currentBalanceKcal > 0 ? 'surplus' : 'even',
    // Subordinate projection, copied from the engine. `ifNoMoreFood` is the
    // honest phrasing: it is a projection, not a plan.
    projectionNote: `If no more food: ${dash.energy.ifNoMoreFoodBalanceKcal} kcal`,
    incomplete: dash.energyIncomplete,
    gaps: dash.energyGaps,
  };

  const macros: readonly MacroView[] = dash === null ? [] : [
    macroOf('Protein', dash.macros.consumedProteinG, dash.macros.targets.proteinG,
      dash.macros.remainingProteinG),
    macroOf('Carbs', dash.macros.consumedCarbohydrateG, dash.macros.targets.carbohydrateG,
      dash.macros.remainingCarbohydrateG),
    macroOf('Fat', dash.macros.consumedFatG, dash.macros.targets.fatG,
      dash.macros.remainingFatG),
  ];

  const options: readonly FoodOptionView[] = app.addFood.results.map((r) => ({
    // The label is carried through verbatim: spoken selection depends on it.
    optionLabel: r.optionLabel,
    productVersionId: r.productVersion.productVersionId,
    displayName: r.productVersion.displayName,
    brand: (r.productVersion as { brandName?: string | null }).brandName ?? null,
    preparationState: r.productVersion.preparationState,
    preparationMatters: r.preparationStateDisambiguates,
  }));

  const preview = app.addFood.preview;
  const selected = app.addFood.selected;
  const capture = app.addFood.weightCapture;
  const review: ReviewView | null = selected !== null && preview !== null && capture !== null
    ? {
        displayName: selected.displayName,
        brand: (selected as { brandName?: string | null }).brandName ?? null,
        preparationState: selected.preparationState,
        // Straight from the trusted snapshot — the renderer never scales.
        grams: capture.grams as unknown as number,
        kcal: preview.kcal,
        proteinG: preview.proteinG,
        carbohydrateG: preview.carbohydrateG,
        fatG: preview.fatG,
      }
    : null;

  const scale: ScaleView = {
    connected: app.scale.connected,
    phase: app.scale.phase,
    displayGrams: app.scale.displayGrams,
    message: app.scale.message,
    // A settled candidate is the ONLY thing that may be committed, and a
    // pending clear after a user switch blocks it too.
    canCommitWeight: app.scale.stableCandidateGrams !== null
      && !app.requiresScaleClearForCurrentSubject,
  };

  const pending = capabilities.pendingSubmissions;
  const offlineView: OfflineView = {
    offline,
    canLog,
    pendingCount: pending,
    message: !canLog
      ? 'Logging unavailable'
      : offline
        ? (pending > 0
            ? `Offline · ${pending} waiting to sync`
            : 'Offline · will sync automatically')
        : null,
  };

  const attempt = switchState.attempt;
  return {
    screen: screenOf(app),
    searchQuery: app.addFood.query,
    identity: {
      displayName: app.subject.displayName,
      userId: app.subject.userId,
      // A remains the identity on screen while B authenticates.
      switchPending: attempt !== null && switchState.phase !== 'active',
      pendingTargetName: attempt?.targetDisplayName ?? null,
    },
    voice: voicePresenceOf(app, offline),
    energy,
    macros,
    recent: input.recent,
    options,
    scale,
    review,
    offline: offlineView,
    error: app.addFood.error === null
      ? null
      : { message: app.addFood.error.message, recoverable: app.addFood.error.recoverable },
    flowId: app.addFood.flowId,
    sessionGeneration: app.sessionGeneration,
  };
}

/**
 * Phrase the balance the way a person would say it.
 *
 * Formatting only: `Math.abs` chooses a word, and the magnitude shown is the
 * domain's own number.
 */
export function describeBalance(balanceKcal: number): string {
  if (balanceKcal === 0) return 'Even right now';
  const magnitude = Math.abs(balanceKcal);
  return balanceKcal < 0
    ? `${magnitude} kcal deficit right now`
    : `${magnitude} kcal surplus right now`;
}
