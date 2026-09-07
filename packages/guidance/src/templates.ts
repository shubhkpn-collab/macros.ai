import type {
  EnvelopeCandidate, GuidanceEnvelope, GuidanceNextAction, GuidanceTemplateId,
  GuidanceTone,
} from './contracts.js';

/**
 * DETERMINISTIC RENDERING.
 *
 * The application owns every word the user hears. A template declares how many
 * candidates and slots it needs, and the renderer fills those from trusted data
 * only — so the worst a misbehaving provider can do is pick a template that
 * reads oddly, never one that states something untrue.
 */
export const TEMPLATE_VERSION = 'guidance-templates@1.0.0';

export interface TemplateSpec {
  readonly candidates: number;
  readonly slots: number;
  readonly usesObjective: boolean;
  readonly defaultAction: GuidanceNextAction;
  /** Allowed only when the planner produced nothing. */
  readonly requiresEmptyPlan?: boolean;
}

export const TEMPLATES: Readonly<Record<GuidanceTemplateId, TemplateSpec>> = {
  single_option: { candidates: 1, slots: 0, usesObjective: false, defaultAction: 'await_choice' },
  two_options: { candidates: 2, slots: 0, usesObjective: false, defaultAction: 'await_choice' },
  option_with_objective: {
    candidates: 1, slots: 0, usesObjective: true, defaultAction: 'await_choice',
  },
  confirm_choice_await_weight: {
    candidates: 1, slots: 0, usesObjective: false, defaultAction: 'await_weight',
  },
  ask_quick_or_meal: { candidates: 0, slots: 0, usesObjective: false, defaultAction: 'await_choice' },
  offer_alternative: { candidates: 1, slots: 0, usesObjective: false, defaultAction: 'await_choice' },
  need_clarification: {
    candidates: 0, slots: 0, usesObjective: false, defaultAction: 'await_clarification',
  },
  budget_exhausted: {
    candidates: 0, slots: 0, usesObjective: false, defaultAction: 'none', requiresEmptyPlan: true,
  },
  no_suggestion: {
    candidates: 0, slots: 0, usesObjective: false, defaultAction: 'none', requiresEmptyPlan: true,
  },
  declined: { candidates: 0, slots: 0, usesObjective: false, defaultAction: 'none' },
};

/** Human words for a planner objective. The provider picks an index, not a noun. */
const OBJECTIVE_WORD: Readonly<Record<string, string>> = {
  protein: 'Protein',
  carbohydrate: 'Carbohydrate',
  fat: 'Fat',
  energy: 'Energy',
};

/**
 * Render a validated template choice into user-facing text.
 *
 * Called ONLY after validation. Every name comes from the envelope and every
 * number from a trusted slot, so nothing here can assert a new fact.
 */
export function renderTemplate(
  templateId: GuidanceTemplateId,
  candidates: readonly EnvelopeCandidate[],
  envelope: GuidanceEnvelope,
  options: { readonly objectiveIndex?: number; readonly tone?: GuidanceTone } = {},
): string {
  const name = (i: number): string => candidates[i]?.displayName ?? '';
  const brief = options.tone === 'brief';

  switch (templateId) {
    case 'single_option':
      return brief ? `${name(0)}.` : `${name(0)} fits your current needs best.`;
    case 'two_options':
      return `${name(0)} and ${name(1)} are both good options.`;
    case 'option_with_objective': {
      const objective = envelope.objectives[options.objectiveIndex ?? 0];
      const word = objective === undefined ? null : OBJECTIVE_WORD[objective] ?? null;
      return word === null
        ? `${name(0)} fits your current needs best.`
        : `${word} is your biggest gap right now. ${name(0)} would help.`;
    }
    case 'confirm_choice_await_weight':
      // No grams are stated: the scale supplies the quantity.
      return `${name(0)}. Put it on the scale when you're ready.`;
    case 'ask_quick_or_meal':
      return 'Would you like something quick, or a proper meal?';
    case 'offer_alternative':
      return `You could have ${name(0)} instead.`;
    case 'need_clarification':
      return "I didn't catch that. Which of the options would you like?";
    case 'budget_exhausted':
      return "You're at your energy target for today.";
    case 'no_suggestion':
      return "I don't have a good suggestion right now.";
    case 'declined':
      return 'No problem.';
    default:
      return "I don't have a good suggestion right now.";
  }
}
