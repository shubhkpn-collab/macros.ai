import type { AppState } from '@macros/tablet-app-core';
import type { OfflineCapabilities } from '@macros/domain-offline-sync';
import type { SwitchState } from '@macros/domain-household';
import {
  describeBalanceCopy, formatGrams, formatGramsWithUnit, formatKcal,
  formatProjection, progressFraction,
} from './format.js';

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
  /** DISPLAY-READY: "-1,505". Whole kcal, grouped, signed. */
  readonly displayValue: string;
  /** "1,505 kcal deficit right now" — semantic, not "calories remaining". */
  readonly semantic: string;
  readonly direction: 'deficit' | 'surplus' | 'even';
  /** Visually subordinate projection, already formatted. */
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
  /** DISPLAY-READY grams — no floating-point artifacts reach the screen. */
  readonly displayConsumed: string;
  readonly displayGoal: string;
  readonly displayRemaining: string;
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
  /** DISPLAY-READY weight, or null when nothing is on the scale. */
  readonly displayWeight: string | null;
  readonly message: string;
  /** ONLY a settled candidate may be committed. Unstable never qualifies. */
  readonly canCommitWeight: boolean;
}

/**
 * The chosen food, available from selection onward.
 *
 * The weighing screen needs identity BEFORE a weight exists — deriving it from
 * `review` meant the screen said "Selected food —" for the whole of weighing,
 * which is precisely when knowing what you are weighing matters most.
 */
export interface SelectedFoodView {
  readonly productVersionId: string;
  readonly displayName: string;
  readonly brand: string | null;
  readonly preparationState: string;
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
  /** DISPLAY-READY. Same values, formatted — never recalculated. */
  readonly displayGrams: string;
  readonly displayKcal: string;
  readonly displayProtein: string;
  readonly displayCarbs: string;
  readonly displayFat: string;
}

export interface OfflineView {
  readonly offline: boolean;
  readonly canLog: boolean;
  readonly pendingCount: number;
  /** Truthful wording: queued is NOT persisted. */
  readonly message: string | null;
}

/**
 * GUIDANCE VIEW.
 *
 * Only what React Native needs to draw. The renderer never sees a provider
 * result, an envelope, or a nutrition figure it would have to interpret — the
 * text arrived already rendered from a validated template.
 */
export interface GuidanceView {
  readonly phase: string;
  readonly text: string;
  readonly candidates: readonly {
    readonly productVersionId: string;
    readonly displayName: string;
    readonly role: string;
  }[];
  /**
   * Bounded alternatives from the SAME envelope. Selecting one goes through
   * the identical validated intent — there is deliberately no second selection
   * path, and nothing here is searched for.
   */
  readonly alternatives: readonly {
    readonly productVersionId: string;
    readonly displayName: string;
    readonly role: string;
  }[];
  readonly envelopeId: string | null;
  readonly visible: boolean;
  readonly usedFallback: boolean;
}

export interface DailyView {
  readonly date: string;
  readonly displayCalories: string;
  readonly displayCalorieGoal: string;
  readonly calorieFraction: number | null;
  readonly displayRemainingCalories: string;
  readonly displayItems: string;
  readonly targetDeltaKcal: number;
  readonly displayDelta: string;
  readonly goalBelowFloor: boolean;
}

export interface TabletViewModel {
  readonly screen: Screen;
  readonly daily: DailyView | null;
  readonly guidance: GuidanceView;
  /** Echoed so the search field can show what was actually searched for. */
  readonly searchQuery: string;
  readonly identity: IdentityView | null;
  readonly voice: VoicePresence;
  readonly energy: EnergyBalanceView | null;
  readonly macros: readonly MacroView[];
  readonly recent: readonly {
    readonly displayName: string; readonly kcal: number; readonly displayKcal: string;
    readonly displayWeight?: string;
  }[];
  readonly options: readonly FoodOptionView[];
  readonly scale: ScaleView;
  readonly selectedFood: SelectedFoodView | null;
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
  readonly recent: readonly { readonly displayName: string; readonly kcal: number; readonly grams?: number }[];
}

const EMPTY_SCALE: ScaleView = {
  connected: false, phase: 'idle', displayGrams: null, displayWeight: null,
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
    daily: null,
    // Locked state carries no guidance: the previous member's suggestions must
    // not be readable from a locked screen.
    guidance: {
      phase: 'idle', text: '', candidates: [], alternatives: [], envelopeId: null,
      visible: false, usedFallback: false,
    },
    searchQuery: '',
    identity: null,
    voice: 'idle',
    energy: null,
    macros: [],
    recent: [],
    options: [],
    scale: EMPTY_SCALE,
    selectedFood: null,
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
  displayConsumed: formatGrams(consumedG),
  displayGoal: formatGrams(goalG),
  displayRemaining: formatGrams(remainingG),
  fraction: progressFraction(consumedG, goalG),
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
    displayValue: formatKcal(dash.energy.currentBalanceKcal, { sign: true }),
    semantic: describeBalanceCopy(dash.energy.currentBalanceKcal),
    direction: dash.energy.currentBalanceKcal < 0
      ? 'deficit' : dash.energy.currentBalanceKcal > 0 ? 'surplus' : 'even',
    // Subordinate projection, copied from the engine. `ifNoMoreFood` is the
    // honest phrasing: it is a projection, not a plan.
    projectionNote: formatProjection(dash.energy.ifNoMoreFoodBalanceKcal),
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
        displayGrams: formatGramsWithUnit(capture.grams as unknown as number),
        displayKcal: formatKcal(preview.kcal),
        displayProtein: formatGramsWithUnit(preview.proteinG),
        displayCarbs: formatGramsWithUnit(preview.carbohydrateG),
        displayFat: formatGramsWithUnit(preview.fatG),
      }
    : null;

  const scale: ScaleView = {
    connected: app.scale.connected,
    phase: app.scale.phase,
    displayGrams: app.scale.displayGrams,
    displayWeight: app.scale.displayGrams === null
      ? null : formatGramsWithUnit(app.scale.displayGrams),
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
    daily: dash === null ? null : {
      date: dash.localDate,
      displayCalories: formatKcal(dash.macros.consumedKcal),
      displayCalorieGoal: formatKcal(dash.macros.targets.targetKcal),
      calorieFraction: progressFraction(dash.macros.consumedKcal, dash.macros.targets.targetKcal),
      displayRemainingCalories: formatKcal(dash.macros.remainingKcal),
      displayItems: String(dash.intake.itemCount ?? input.recent.length),
      targetDeltaKcal: dash.energy.targetDeltaKcal ?? 0,
      displayDelta: formatKcal(dash.energy.targetDeltaKcal ?? 0, { sign: true }),
      goalBelowFloor: dash.guardrails.belowFloor === true,
    },
    guidance: {
      phase: app.guidance.phase,
      text: app.guidance.text,
      candidates: app.guidance.candidates.map((c) => ({
        productVersionId: c.productVersionId,
        displayName: c.displayName,
        role: c.role,
      })),
      alternatives: app.guidance.alternatives.slice(0, 3).map((c) => ({
        productVersionId: c.productVersionId,
        displayName: c.displayName,
        role: c.role,
      })),
      envelopeId: app.guidance.envelopeId,
      visible: app.guidance.phase !== 'idle',
      usedFallback: app.guidance.usedFallback,
    },
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
    recent: input.recent.map((r) => ({
      ...r, displayKcal: formatKcal(r.kcal),
      ...(r.grams === undefined ? {} : { displayWeight: formatGramsWithUnit(r.grams) }),
    })),
    options,
    scale,
    selectedFood: selected === null ? null : {
      productVersionId: selected.productVersionId,
      displayName: selected.displayName,
      brand: (selected as { brandName?: string | null }).brandName ?? null,
      preparationState: selected.preparationState,
    },
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
 * FOOD CARD VIEW — the QA browser's display projection.
 *
 * Formatting happens here for the same reason it does everywhere else: the
 * renderer must not decide how a number reads, and a missing value must say
 * "unknown" rather than silently render as nothing.
 */
export interface FoodCardView {
  readonly productVersionId: string;
  readonly displayName: string;
  readonly brandLine: string;
  readonly preparationLine: string;
  readonly servingLine: string;
  readonly nutritionLine: string;
  readonly macroLine: string;
  /**
   * IMAGE-READY. A real URL renders; null renders the deterministic
   * placeholder. Coverage is currently 0% — sourcing is a separate decision —
   * but the product no longer needs a code change once images exist.
   */
  readonly imageUrl: string | null;
  readonly imageInitials: string;
  /** Shown beside a real image. Licence terms differ per source. */
  readonly imageAttribution: string | null;
  readonly displayable: boolean;
  /** Why this record is not offerable, in plain words. Null when it is fine. */
  readonly dataWarning: string | null;
  readonly accessibilityLabel: string;
}

/**
 * Project a catalog FoodCard into its display form.
 *
 * Formatting happens here, as everywhere else: a missing value says "unknown"
 * rather than rendering as blank, so a data gap is visible instead of looking
 * like a design choice.
 */
export function toFoodCardView(card: {
  readonly productVersionId: string;
  readonly displayName: string;
  readonly brand: { readonly present: boolean; readonly value: string | null };
  readonly preparationState: string;
  readonly serving: {
    readonly grams: number | null; readonly householdText: string | null;
    readonly weighable: boolean;
  };
  readonly kcal: { readonly present: boolean; readonly value: number | null };
  readonly proteinG: { readonly present: boolean; readonly value: number | null };
  readonly carbohydrateG: { readonly present: boolean; readonly value: number | null };
  readonly fatG: { readonly present: boolean; readonly value: number | null };
  readonly image: {
    readonly url: string | null; readonly attribution: string | null;
    readonly status: string;
  };
  readonly displayable: boolean;
}, initials: string): FoodCardView {
  const brandLine = card.brand.present && card.brand.value !== null
    ? card.brand.value : 'No brand';

  const servingLine = card.serving.grams !== null
    ? `${formatGramsWithUnit(card.serving.grams)}${
      card.serving.householdText !== null ? ` · ${card.serving.householdText}` : ''}`
    : card.serving.householdText !== null
      ? `${card.serving.householdText} · no gram weight`
      : 'No serving information';

  const nutritionLine = card.kcal.present && card.kcal.value !== null
    ? `${formatKcal(card.kcal.value)} kcal / 100 g`
    : 'Energy unknown';

  const macroPart = (label: string, v: { present: boolean; value: number | null }): string =>
    v.present && v.value !== null ? `${label} ${formatGrams(v.value)}` : `${label} —`;
  const macroLine = [
    macroPart('P', card.proteinG),
    macroPart('C', card.carbohydrateG),
    macroPart('F', card.fatG),
  ].join(' · ');

  const dataWarning = card.displayable
    ? (card.serving.weighable ? null : 'No gram weight — needs manual weighing')
    : 'Not offerable: missing or implausible nutrition';

  return {
    productVersionId: card.productVersionId,
    displayName: card.displayName,
    brandLine,
    preparationLine: card.preparationState,
    servingLine,
    nutritionLine,
    macroLine,
    imageUrl: card.image.status === 'available' ? card.image.url : null,
    imageInitials: initials,
    imageAttribution: card.image.attribution,
    displayable: card.displayable,
    dataWarning,
    accessibilityLabel:
      `${card.displayName}. ${brandLine}. ${card.preparationState}. `
      + `${servingLine}. ${nutritionLine}. ${macroLine}`
      + `${dataWarning !== null ? `. ${dataWarning}` : ''}`,
  };
}
