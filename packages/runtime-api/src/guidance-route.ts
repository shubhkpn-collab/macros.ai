import type { GuidanceProvider, GuidanceRequest } from '@macros/guidance';
import { appError, type AppError } from '@macros/runtime-config';
import { subjectUserId } from '@macros/domain-auth';
import type { AdmissionLease, GuidanceAdmission } from './guidance-admission.js';
import type { RequestContext, Route } from './server.js';

/**
 * AUTHENTICATED GUIDANCE ROUTE.
 *
 * The seam between a kitchen appliance and a paid model. Two properties matter
 * more than anything else here:
 *
 *   - identity comes from the VERIFIED session, never the body;
 *   - the body is decoded strictly, so a tablet cannot turn this into an
 *     arbitrary prompt relay. It accepts the existing bounded guidance
 *     contract and nothing else.
 */
export const GUIDANCE_ROUTE_VERSION = 'guidance-route@1.0.0';

/** Bounds. Every one caps something a caller would otherwise choose freely. */
export const GUIDANCE_LIMITS = {
  maxRecentTurns: 6,
  maxTurnTextLength: 400,
  maxObjectives: 6,
  maxPlanComponents: 3,
  maxAlternatives: 6,
  maxSlots: 12,
  maxIdLength: 128,
  maxNameLength: 200,
  maxRationaleCodes: 8,
} as const;

/**
 * Fields with a TRUE closed vocabulary are validated against it, not merely
 * length-bounded — a 200-character `plannerStatus` is still a field we do not
 * understand. Open strings such as food display names stay bounded only,
 * because inventing a sanitised name would misreport the catalog.
 */
const VALID_PLANNER_STATUSES = new Set([
  'available', 'energy_budget_exhausted', 'no_eligible_candidates',
  'insufficient_state', 'preferences_conflict',
]);
const VALID_OBJECTIVES = new Set(['protein', 'carbohydrate', 'fat', 'energy']);
const VALID_ROLES = new Set([
  'protein_forward', 'carbohydrate_forward', 'fat_forward', 'balanced',
  'light_accompaniment', 'unknown',
]);
const VALID_ACTIONABILITY = new Set([
  'ready_to_eat', 'meal_component', 'snack', 'treat', 'beverage',
  'ingredient', 'cooking_fat', 'condiment', 'requires_preparation',
  'specialty', 'unknown',
]);

const VALID_INTENTS = new Set([
  'what_should_i_eat', 'request_alternative', 'choose_candidate',
  'prefer_quick', 'prefer_meal', 'decline', 'clarification_needed',
]);

const REQUEST_KEYS = new Set(['envelope', 'intent', 'recentTurns', 'chosenProductVersionId']);
const ENVELOPE_KEYS = new Set([
  'envelopeVersion', 'plannerStatus', 'objectives', 'planComponents',
  'alternatives', 'slots', 'weighingRequired', 'moreGuidanceUsefulAfterWeighing',
]);
const CANDIDATE_KEYS = new Set([
  'productId', 'productVersionId', 'displayName', 'role', 'actionabilityClass',
  'rationaleCodes', 'rank', 'isPlanComponent', 'groundedPortionGrams',
]);

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

const boundedString = (v: unknown, max: number): boolean =>
  typeof v === 'string' && v.length <= max;

/** Unknown fields are REJECTED, not ignored: silent acceptance is how a relay begins. */
const noUnknownKeys = (o: Record<string, unknown>, allowed: ReadonlySet<string>): boolean =>
  Object.keys(o).every((k) => allowed.has(k));

function decodeCandidate(v: unknown): boolean {
  if (!isRecord(v) || !noUnknownKeys(v, CANDIDATE_KEYS)) return false;
  if (!boundedString(v['productId'], GUIDANCE_LIMITS.maxIdLength)) return false;
  if (!boundedString(v['productVersionId'], GUIDANCE_LIMITS.maxIdLength)) return false;
  if (!boundedString(v['displayName'], GUIDANCE_LIMITS.maxNameLength)) return false;
  if (typeof v['role'] !== 'string' || !VALID_ROLES.has(v['role'])) return false;
  if (typeof v['actionabilityClass'] !== 'string'
      || !VALID_ACTIONABILITY.has(v['actionabilityClass'])) return false;
  const codes = v['rationaleCodes'];
  if (!Array.isArray(codes) || codes.length > GUIDANCE_LIMITS.maxRationaleCodes) return false;
  if (codes.some((c) => !boundedString(c, GUIDANCE_LIMITS.maxNameLength))) return false;
  if (typeof v['rank'] !== 'number' || !Number.isFinite(v['rank'])) return false;
  if (typeof v['isPlanComponent'] !== 'boolean') return false;
  const grams = v['groundedPortionGrams'];
  if (grams !== null && (typeof grams !== 'number' || !Number.isFinite(grams))) return false;
  return true;
}

/**
 * Decode network JSON into a GuidanceRequest.
 *
 * A TypeScript interface is a compile-time claim; this is the runtime check
 * that actually protects the endpoint.
 */
/**
 * A decoded, TRUSTED guidance request.
 *
 * Tagged so the handler can narrow it normally. Returning a bare
 * `GuidanceRequest` forced the handler to re-assert the network object it had
 * already validated, which is exactly the assertion this milestone removes.
 */
export interface DecodedGuidanceRequest {
  readonly kind: 'decoded_guidance_request';
  readonly value: GuidanceRequest;
}

export function decodeGuidanceRequest(
  body: Record<string, unknown>,
): DecodedGuidanceRequest | AppError {
  const invalid = (why: string): AppError =>
    appError('validation', 'invalid_guidance_request', why);

  if (!noUnknownKeys(body, REQUEST_KEYS)) return invalid('Unexpected fields in the request.');
  if (typeof body['intent'] !== 'string' || !VALID_INTENTS.has(body['intent'])) {
    return invalid('Unsupported guidance intent.');
  }

  const envelope = body['envelope'];
  if (!isRecord(envelope) || !noUnknownKeys(envelope, ENVELOPE_KEYS)) {
    return invalid('Unexpected fields in the envelope.');
  }
  if (!boundedString(envelope['envelopeVersion'], GUIDANCE_LIMITS.maxNameLength)) {
    return invalid('Invalid envelope version.');
  }
  if (typeof envelope['plannerStatus'] !== 'string'
      || !VALID_PLANNER_STATUSES.has(envelope['plannerStatus'])) {
    return invalid('Invalid planner status.');
  }

  const objectives = envelope['objectives'];
  if (!Array.isArray(objectives) || objectives.length > GUIDANCE_LIMITS.maxObjectives) {
    return invalid('Too many objectives.');
  }
  if (objectives.some((o) => typeof o !== 'string' || !VALID_OBJECTIVES.has(o))) {
    return invalid('Invalid objective.');
  }

  const components = envelope['planComponents'];
  if (!Array.isArray(components) || components.length > GUIDANCE_LIMITS.maxPlanComponents) {
    return invalid('Too many plan components.');
  }
  if (!components.every(decodeCandidate)) return invalid('Invalid plan component.');

  const alternatives = envelope['alternatives'];
  if (!Array.isArray(alternatives) || alternatives.length > GUIDANCE_LIMITS.maxAlternatives) {
    return invalid('Too many alternatives.');
  }
  if (!alternatives.every(decodeCandidate)) return invalid('Invalid alternative.');

  const slots = envelope['slots'];
  if (!isRecord(slots)) return invalid('Invalid slots.');
  const slotKeys = Object.keys(slots);
  if (slotKeys.length > GUIDANCE_LIMITS.maxSlots) return invalid('Too many slots.');
  if (slotKeys.some((k) => !boundedString(slots[k], GUIDANCE_LIMITS.maxNameLength))) {
    return invalid('Invalid slot value.');
  }

  if (typeof envelope['weighingRequired'] !== 'boolean') return invalid('Invalid envelope.');
  if (typeof envelope['moreGuidanceUsefulAfterWeighing'] !== 'boolean') {
    return invalid('Invalid envelope.');
  }

  const turns = body['recentTurns'];
  if (!Array.isArray(turns) || turns.length > GUIDANCE_LIMITS.maxRecentTurns) {
    return invalid('Too many conversation turns.');
  }
  for (const t of turns) {
    if (!isRecord(t) || !noUnknownKeys(t, new Set(['role', 'text']))) {
      return invalid('Invalid conversation turn.');
    }
    if (t['role'] !== 'user' && t['role'] !== 'macros') return invalid('Invalid turn role.');
    if (!boundedString(t['text'], GUIDANCE_LIMITS.maxTurnTextLength)) {
      return invalid('Conversation turn is too long.');
    }
  }

  const chosen = body['chosenProductVersionId'];
  if (chosen !== undefined && !boundedString(chosen, GUIDANCE_LIMITS.maxIdLength)) {
    return invalid('Invalid chosen candidate.');
  }

  /**
   * Built field by field from values just validated. Asserting the whole body
   * would claim correctness for fields nobody checked, and would keep claiming
   * it after the contract grew.
   */
  const envelopeOut: GuidanceRequest['envelope'] = {
    envelopeVersion: envelope['envelopeVersion'] as string,
    plannerStatus: envelope['plannerStatus'] as GuidanceRequest['envelope']['plannerStatus'],
    objectives: [...(objectives as string[])],
    planComponents: (components as Record<string, unknown>[]).map(toCandidate),
    alternatives: (alternatives as Record<string, unknown>[]).map(toCandidate),
    slots: { ...(slots as Record<string, string>) },
    weighingRequired: envelope['weighingRequired'] as boolean,
    moreGuidanceUsefulAfterWeighing: envelope['moreGuidanceUsefulAfterWeighing'] as boolean,
  };

  return {
    kind: 'decoded_guidance_request',
    value: {
      envelope: envelopeOut,
      intent: body['intent'] as GuidanceRequest['intent'],
      recentTurns: (turns as Record<string, unknown>[]).map((t) => ({
        role: t['role'] as 'user' | 'macros',
        text: t['text'] as string,
      })),
      ...(chosen !== undefined ? { chosenProductVersionId: chosen as string } : {}),
    },
  };
}

/** Narrow a validated candidate record into the contract shape. */
function toCandidate(v: Record<string, unknown>): GuidanceRequest['envelope']['planComponents'][number] {
  return {
    productId: v['productId'] as string,
    productVersionId: v['productVersionId'] as string,
    displayName: v['displayName'] as string,
    role: v['role'] as string,
    actionabilityClass: v['actionabilityClass'] as string,
    rationaleCodes: [...(v['rationaleCodes'] as string[])],
    rank: v['rank'] as number,
    isPlanComponent: v['isPlanComponent'] as boolean,
    groundedPortionGrams: v['groundedPortionGrams'] as number | null,
  };
}

export interface GuidanceRouteDeps {
  /** Configured at the composition edge. Null disables remote guidance. */
  readonly provider: GuidanceProvider | null;
  /** Cost guard. Omitted only in tests that assert the unguarded path. */
  readonly admission?: GuidanceAdmission;
}

export function guidanceRoute(deps: GuidanceRouteDeps): Route {
  return {
    method: 'POST',
    path: '/guidance/generate',
    decode: (body) => decodeGuidanceRequest(body),
    handler: async (ctx: RequestContext) => {
      // Authority is the verified session. The body carries no identity at all,
      // so there is nothing here to spoof.
      if (ctx.subject === undefined) {
        return appError('authentication', 'missing_credential', 'Not signed in.');
      }
      const decoded = (ctx.body as {
        decoded?: DecodedGuidanceRequest | AppError;
      }).decoded;
      if (decoded === undefined) {
        return appError('validation', 'missing_guidance_request', 'A request is required.');
      }
      // Narrowed on the tag, so the trusted value carries its own type and the
      // handler never re-asserts the network object.
      if (decoded.kind !== 'decoded_guidance_request') return decoded;

      if (deps.provider === null) {
        return appError('dependency_unavailable', 'guidance_provider_disabled',
          'Guidance is not available.');
      }

      /**
       * Admission is checked BEFORE the provider is reached, so a refused
       * request costs nothing. Keyed by the verified subject, never by anything
       * the caller supplied.
       */
      let lease: AdmissionLease | null = null;
      if (deps.admission !== undefined) {
        const decision = await deps.admission.acquire(subjectUserId(ctx.subject));
        if (!decision.admitted) {
          return appError('dependency_unavailable', 'guidance_rate_limited',
            'Guidance is busy. Try again in a moment.');
        }
        lease = decision.lease;
      }

      try {
        return await deps.provider.generate(decoded.value);
      } catch {
        // The vendor's message never crosses this boundary: it could carry
        // wording, or detail about our configuration, that must not reach a
        // device. The tablet falls back deterministically.
        return appError('dependency_unavailable', 'guidance_provider_failed',
          'Guidance is not available.');
      } finally {
        // Release never throws: a release failure must not turn a successful
        // answer into an error. The lease TTL is the backstop.
        if (lease !== null) await deps.admission?.release(lease).catch(() => undefined);
      }
    },
  };
}


/**
 * Register the guidance route on an API.
 *
 * An explicit composition helper: route registration belongs at the server
 * edge where the provider and its secrets are chosen, never hidden inside
 * domain code.
 */
export function registerGuidanceRoute(
  api: { route(route: Route): unknown },
  deps: GuidanceRouteDeps,
): void {
  api.route(guidanceRoute(deps));
}
