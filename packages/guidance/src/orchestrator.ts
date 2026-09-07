import type {
  GuidanceEnvelope, GuidanceIntent, GuidanceOutcome, GuidanceProvider,
  GuidanceRequest, GuidanceRejection,
} from './contracts.js';
import { deterministicGuidance } from './fallback.js';
import { renderGuidanceText, validateGuidance } from './validator.js';

/**
 * GUIDANCE ORCHESTRATION.
 *
 *   trusted state → envelope → provider → validator → user-facing guidance
 *
 * The provider is the only untrusted step, and it is fenced on both sides: it
 * receives only the envelope, and nothing it returns reaches a user without
 * passing validation. Any failure — unavailable, slow, malformed, unsafe —
 * lands in the same place: deterministic guidance from the trusted planner.
 */
export const ORCHESTRATOR_VERSION = 'guidance-orchestrator@1.0.0';

export interface GuidanceOptions {
  readonly provider: GuidanceProvider | null;
  /** Beyond this the appliance answers itself rather than keeping a user waiting. */
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 2500;

const withTimeout = async <T>(p: Promise<T>, ms: number): Promise<T | null> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), ms); }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

export async function requestGuidance(
  envelope: GuidanceEnvelope,
  intent: GuidanceIntent,
  options: GuidanceOptions,
  context: { readonly recentTurns?: GuidanceRequest['recentTurns'];
    readonly chosenProductVersionId?: string } = {},
): Promise<GuidanceOutcome> {
  const { provider } = options;
  if (provider === null) return deterministicGuidance(envelope, intent);

  /**
   * A named choice must exist in the envelope. Checking here rather than
   * trusting the provider means an unoffered food is refused even if the model
   * would happily have accepted it.
   */
  if (context.chosenProductVersionId !== undefined) {
    const known = [...envelope.planComponents, ...envelope.alternatives]
      .some((c) => c.productVersionId === context.chosenProductVersionId);
    if (!known) {
      return {
        text: "I don't have that as an option right now. Which of the ones I suggested?",
        intent: 'clarification_needed',
        candidates: [],
        nextAction: 'await_clarification',
        usedFallback: true,
        rejections: ['unknown_candidate'],
        providerName: provider.name,
      };
    }
  }

  const request: GuidanceRequest = {
    envelope,
    intent,
    // Session-scoped only; there is no long-term memory in this milestone.
    recentTurns: context.recentTurns ?? [],
    ...(context.chosenProductVersionId !== undefined
      ? { chosenProductVersionId: context.chosenProductVersionId } : {}),
  };

  let result = null;
  let unavailable: GuidanceRejection | null = null;
  try {
    result = await withTimeout(provider.generate(request),
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    if (result === null) unavailable = 'provider_unavailable';
  } catch {
    unavailable = 'provider_unavailable';
  }

  if (unavailable !== null) {
    const fallback = deterministicGuidance(envelope, intent);
    return { ...fallback, rejections: [unavailable], providerName: provider.name };
  }

  const validation = validateGuidance(result, envelope);
  if (!validation.ok) {
    // Invalid output never reaches the user; it is replaced, not repaired.
    const fallback = deterministicGuidance(envelope, intent);
    return { ...fallback, rejections: validation.rejections, providerName: provider.name };
  }

  return {
    // Substitution happens only after validation passed.
    text: renderGuidanceText(result!.text, envelope),
    intent: result!.intent,
    candidates: validation.candidates,
    nextAction: validation.nextAction,
    usedFallback: false,
    rejections: [],
    providerName: provider.name,
  };
}
