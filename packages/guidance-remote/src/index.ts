import type {
  GuidanceProvider, GuidanceProviderResult, GuidanceRequest,
} from '@macros/guidance';

/**
 * TABLET-SIDE REMOTE PROVIDER.
 *
 * The appliance's entire knowledge of remote guidance. It speaks only to the
 * MACROS backend over an authenticated session, and it does not know that a
 * language model exists anywhere in the system.
 *
 * That ignorance is the security property: a device in a kitchen, physically
 * accessible to anyone in the household, must never hold a model credential.
 * The only secret it carries is the member's own session, which is already
 * scoped, revocable and useless elsewhere.
 */
export const REMOTE_PROVIDER_VERSION = 'remote-guidance-provider@1.0.0';

/** Minimal transport seam so tests exercise serialization without a network. */
export interface HttpTransport {
  send(request: {
    readonly url: string;
    readonly method: 'POST';
    readonly headers: Readonly<Record<string, string>>;
    readonly body: string;
    readonly timeoutMs: number;
  }): Promise<{ readonly status: number; readonly body: string }>;
}

export interface RemoteGuidanceProviderOptions {
  readonly baseUrl: string;
  /** Supplies the MACROS session credential. Never a provider secret. */
  bearerToken(): Promise<string> | string;
  readonly transport: HttpTransport;
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 4000;

/** Closed vocabularies. An enum the backend does not use is a protocol error. */
const INTENTS = new Set([
  'what_should_i_eat', 'request_alternative', 'choose_candidate',
  'prefer_quick', 'prefer_meal', 'decline', 'clarification_needed',
]);
const TEMPLATES = new Set([
  'single_option', 'two_options', 'option_with_objective',
  'confirm_choice_await_weight', 'ask_quick_or_meal', 'offer_alternative',
  'need_clarification', 'budget_exhausted', 'no_suggestion', 'declined',
]);
const ACTIONS = new Set(['await_choice', 'await_weight', 'await_clarification', 'none']);
const TONES = new Set(['neutral', 'brief', 'encouraging']);

const RESULT_KEYS = new Set([
  'intent', 'templateId', 'selectedProductVersionIds', 'slotRefs',
  'objectiveIndex', 'tone', 'clarificationNeeded', 'suggestedNextAction',
  'alternativeProductVersionIds',
]);

/** Network hygiene bounds. Independent of, and no substitute for, INT-5B. */
export const REMOTE_BOUNDS = {
  maxBodyBytes: 64 * 1024,
  maxSelected: 3,
  maxAlternatives: 4,
  maxSlotRefs: 6,
  maxIdLength: 128,
  maxObjectiveIndex: 5,
} as const;

const boundedIdArray = (v: unknown, max: number): boolean =>
  Array.isArray(v) && v.length <= max
  && v.every((x) => typeof x === 'string' && x.length > 0
    && x.length <= REMOTE_BOUNDS.maxIdLength);

/**
 * Decode the backend response.
 *
 * Strict about SHAPE and vocabulary; silent about meaning. Whether a candidate
 * was actually offered is decided by the INT-5B validator on the way out,
 * which remains the single authority and is not duplicated here.
 */
function decodeResult(raw: unknown): GuidanceProviderResult | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;

  for (const key of Object.keys(o)) if (!RESULT_KEYS.has(key)) return null;

  if (typeof o['intent'] !== 'string' || !INTENTS.has(o['intent'])) return null;
  if (typeof o['templateId'] !== 'string' || !TEMPLATES.has(o['templateId'])) return null;
  if (typeof o['suggestedNextAction'] !== 'string'
      || !ACTIONS.has(o['suggestedNextAction'])) return null;
  if (typeof o['clarificationNeeded'] !== 'boolean') return null;
  if (!boundedIdArray(o['selectedProductVersionIds'], REMOTE_BOUNDS.maxSelected)) return null;

  if (o['alternativeProductVersionIds'] !== undefined
      && !boundedIdArray(o['alternativeProductVersionIds'], REMOTE_BOUNDS.maxAlternatives)) {
    return null;
  }
  if (o['slotRefs'] !== undefined
      && !boundedIdArray(o['slotRefs'], REMOTE_BOUNDS.maxSlotRefs)) return null;

  const objectiveIndex = o['objectiveIndex'];
  if (objectiveIndex !== undefined
      && (typeof objectiveIndex !== 'number' || !Number.isInteger(objectiveIndex)
        || objectiveIndex < 0 || objectiveIndex > REMOTE_BOUNDS.maxObjectiveIndex)) {
    return null;
  }

  const tone = o['tone'];
  if (tone !== undefined && (typeof tone !== 'string' || !TONES.has(tone))) return null;

  /**
   * Constructed FIELD BY FIELD from values just proven, rather than asserting
   * the whole untrusted object. A whole-object assertion claims every field is
   * correct on the strength of having checked some of them, and survives the
   * next field being added.
   */
  return {
    intent: o['intent'] as GuidanceProviderResult['intent'],
    templateId: o['templateId'] as GuidanceProviderResult['templateId'],
    selectedProductVersionIds: [...(o['selectedProductVersionIds'] as string[])],
    clarificationNeeded: o['clarificationNeeded'],
    suggestedNextAction:
      o['suggestedNextAction'] as GuidanceProviderResult['suggestedNextAction'],
    ...(o['slotRefs'] !== undefined
      ? { slotRefs: [...(o['slotRefs'] as string[])] } : {}),
    ...(objectiveIndex !== undefined ? { objectiveIndex } : {}),
    ...(tone !== undefined
      ? { tone: tone as NonNullable<GuidanceProviderResult['tone']> } : {}),
    ...(o['alternativeProductVersionIds'] !== undefined
      ? { alternativeProductVersionIds:
          [...(o['alternativeProductVersionIds'] as string[])] } : {}),
  };
}

/** Transport-level fields the API adds to every response. */
const TRANSPORT_KEYS = ['requestId'] as const;

function stripTransportEnvelope(raw: unknown): unknown {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const copy: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
  for (const key of TRANSPORT_KEYS) delete copy[key];
  return copy;
}

export class RemoteGuidanceProvider implements GuidanceProvider {
  readonly name = 'macros-backend';

  constructor(private readonly options: RemoteGuidanceProviderOptions) {}

  async generate(request: GuidanceRequest): Promise<GuidanceProviderResult> {
    const token = await this.options.bearerToken();

    /**
     * Exactly the projection the guidance package already built — no subject,
     * no session, no identity. The tablet adds nothing to it, so there is no
     * second place for private data to be introduced.
     */
    const payload = JSON.stringify({
      envelope: request.envelope,
      intent: request.intent,
      recentTurns: request.recentTurns,
      ...(request.chosenProductVersionId !== undefined
        ? { chosenProductVersionId: request.chosenProductVersionId } : {}),
    });

    const response = await this.options.transport.send({
      url: `${this.options.baseUrl.replace(/\/$/, '')}/guidance/generate`,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // The MEMBER's session. Never a provider credential.
        authorization: `Bearer ${token}`,
      },
      body: payload,
      timeoutMs: this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });

    if (response.status !== 200) {
      // Nothing from the wire is echoed: a backend or vendor message could
      // carry wording the user must never see, and the orchestrator's
      // deterministic fallback is the correct answer to any failure.
      throw new Error('guidance_unavailable');
    }

    // Bounded BEFORE parsing: an unbounded body is a denial-of-service vector
    // on an appliance with modest memory, whatever it contains.
    if (response.body.length > REMOTE_BOUNDS.maxBodyBytes) {
      throw new Error('guidance_unavailable');
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(response.body);
    } catch {
      throw new Error('guidance_unavailable');
    }

    /**
     * The API envelopes every response with transport metadata — `requestId`
     * for correlation. That wrapper is not part of the provider result, so it
     * is stripped before strict decoding; treating it as a payload field made
     * the decoder reject perfectly valid decisions.
     */
    const result = decodeResult(stripTransportEnvelope(parsed));
    if (result === null) throw new Error('guidance_unavailable');
    return result;
  }
}
export * from './fetch-transport.js';
export * from './composition.js';
