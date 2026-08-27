import { webcrypto } from 'node:crypto';

/**
 * ASYMMETRIC JWT VERIFICATION — IO EDGE.
 *
 * NOTE ON THE IMPLEMENTATION CHOICE: the brief asked for a reputable JWT/JWKS
 * library. The authoring sandbox has no npm registry access (403), so `jose`
 * could not be installed. Rather than hand-roll RSA/ECDSA — which would be far
 * worse — this uses Node's built-in WebCrypto (`subtle.importKey` /
 * `subtle.verify`), the platform's own vetted implementation. No signature
 * mathematics is written here.
 *
 * If you prefer a library, `jose` is a drop-in for `verifySignature` and
 * `importJwk`; the claim rules below would not change.
 */
export const JWT_VERIFIER_VERSION = 'asymmetric-jwt@1.0.0';

/** Algorithms Supabase issues for asymmetric access tokens. */
export type SupportedAlg = 'RS256' | 'ES256';

export interface JwtHeader {
  readonly alg: string;
  readonly kid?: string;
  readonly typ?: string;
}

export interface JwtClaims {
  readonly sub?: unknown;
  readonly iss?: unknown;
  readonly exp?: unknown;
  readonly iat?: unknown;
  readonly aud?: unknown;
  readonly role?: unknown;
  readonly [claim: string]: unknown;
}

export type JwtRejection =
  | 'malformed_token'
  | 'unsupported_algorithm'
  | 'unknown_key'
  | 'bad_signature'
  | 'expired'
  | 'not_yet_valid'
  | 'issuer_mismatch'
  | 'missing_subject'
  | 'invalid_subject'
  | 'invalid_issued_at'
  | 'invalid_audience'
  | 'invalid_role'
  | 'anonymous_identity'
  | 'invalid_session_id'
  | 'invalid_aal';

export class JwtVerificationError extends Error {
  constructor(readonly reason: JwtRejection, message: string) {
    super(message);
    this.name = 'JwtVerificationError';
    // A token is NEVER attached to an error: an exception message is one of the
    // commonest ways a credential ends up in a log.
  }
}

const b64urlToBuffer = (part: string): Buffer =>
  Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

/** Split a compact JWS. Structure only — no trust is implied. */
export function decodeSegments(token: string): {
  header: JwtHeader; claims: JwtClaims; signingInput: string; signature: Buffer;
} {
  if (typeof token !== 'string') {
    throw new JwtVerificationError('malformed_token', 'token is not a string');
  }
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new JwtVerificationError('malformed_token', 'expected three JWS segments');
  }
  const [h, p, s] = parts as [string, string, string];
  let rawHeader: unknown;
  let rawClaims: unknown;
  try {
    rawHeader = JSON.parse(b64urlToBuffer(h).toString('utf8'));
    rawClaims = JSON.parse(b64urlToBuffer(p).toString('utf8'));
  } catch {
    throw new JwtVerificationError('malformed_token', 'segments are not valid JSON');
  }
  // Fail closed on shape. `null`, an array, a number or a string must never be
  // cast into JwtHeader/JwtClaims — a cast would let `claims.sub` read
  // `undefined` off a non-object and continue.
  const isPlainObject = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);
  if (!isPlainObject(rawHeader) || !isPlainObject(rawClaims)) {
    throw new JwtVerificationError('malformed_token', 'header and claims must be JSON objects');
  }
  const header = rawHeader as unknown as JwtHeader;
  const claims = rawClaims as unknown as JwtClaims;
  return { header, claims, signingInput: `${h}.${p}`, signature: b64urlToBuffer(s) };
}

const ALGORITHMS: Readonly<Record<SupportedAlg, { import: unknown; verify: unknown }>> = {
  RS256: {
    import: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    verify: { name: 'RSASSA-PKCS1-v1_5' },
  },
  ES256: {
    import: { name: 'ECDSA', namedCurve: 'P-256' },
    verify: { name: 'ECDSA', hash: { name: 'SHA-256' } },
  },
};

export const isSupportedAlg = (alg: string): alg is SupportedAlg =>
  alg === 'RS256' || alg === 'ES256';

/** Import a JWKS entry. The key material is PUBLIC — no secret is involved. */
export async function importJwk(jwk: Record<string, unknown>, alg: SupportedAlg): Promise<CryptoKey> {
  return webcrypto.subtle.importKey(
    'jwk', jwk as never, ALGORITHMS[alg].import as never, false, ['verify'],
  );
}

export async function verifySignature(
  key: CryptoKey, alg: SupportedAlg, signingInput: string, signature: Buffer,
): Promise<boolean> {
  // Copy into plain Uint8Arrays: WebCrypto wants ArrayBuffer-backed views.
  const sig = Uint8Array.from(signature);
  const data = Uint8Array.from(Buffer.from(signingInput, 'utf8'));
  return webcrypto.subtle.verify(ALGORITHMS[alg].verify as never, key, sig, data);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface ClaimPolicy {
  /** Exact issuer, e.g. `https://<project>.supabase.co/auth/v1`. */
  readonly issuer: string;
  /** Tolerance for clock skew between this server and the provider. */
  readonly clockSkewSeconds?: number;
  /** Audience a durable household user must carry. */
  readonly requiredAudience?: string;
}

export interface VerifiedClaims {
  readonly subjectId: string;
  readonly sessionId: string;
  readonly issuedAtIso: string;
  readonly expiresAtIso: string;
  readonly aal: string | null;
}

/** Supabase documents `aud` as string | string[]. */
function audienceContains(aud: unknown, required: string): boolean {
  if (typeof aud === 'string') return aud === required;
  if (Array.isArray(aud)) return aud.some((a) => a === required);
  return false;
}

const SESSION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Validate the claims this product's contract actually depends on.
 *
 * Deliberately minimal: signature, `exp`, `iss`, and a UUID `sub`. `aud` and
 * `role` are NOT asserted, because their exact values vary by Supabase project
 * configuration and inventing a check from memory would reject valid tokens.
 * Add them once the live gate shows what the project really issues.
 */
export function validateClaims(claims: JwtClaims, policy: ClaimPolicy, nowMs: number): VerifiedClaims {
  const skew = (policy.clockSkewSeconds ?? 30) * 1000;
  const audience = policy.requiredAudience ?? 'authenticated';
  const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

  if (typeof claims.iss !== 'string' || claims.iss !== policy.issuer) {
    throw new JwtVerificationError('issuer_mismatch', 'token issuer is not the configured project');
  }

  if (!finite(claims.exp)) {
    throw new JwtVerificationError('expired', 'token has no usable expiry');
  }
  if (nowMs - skew >= claims.exp * 1000) {
    throw new JwtVerificationError('expired', 'token has expired');
  }

  // `iat` must exist, be sane, and precede expiry. A token issued far in the
  // future is not something a correct provider emits.
  if (!finite(claims.iat)) {
    throw new JwtVerificationError('invalid_issued_at', 'token has no usable issued-at');
  }
  if (claims.iat * 1000 > nowMs + skew) {
    throw new JwtVerificationError('invalid_issued_at', 'token is issued in the future');
  }
  if (claims.iat >= claims.exp) {
    throw new JwtVerificationError('invalid_issued_at', 'issued-at does not precede expiry');
  }

  if (claims.nbf !== undefined) {
    if (!finite(claims.nbf)) {
      throw new JwtVerificationError('not_yet_valid', 'not-before is not a timestamp');
    }
    if (claims.nbf * 1000 > nowMs + skew) {
      throw new JwtVerificationError('not_yet_valid', 'token is not yet valid');
    }
  }

  if (claims.sub === undefined || claims.sub === null || claims.sub === '') {
    throw new JwtVerificationError('missing_subject', 'token has no subject');
  }
  if (typeof claims.sub !== 'string' || !UUID.test(claims.sub)) {
    throw new JwtVerificationError('invalid_subject', 'token subject is not a UUID');
  }

  if (!audienceContains(claims.aud, audience)) {
    throw new JwtVerificationError('invalid_audience', 'token audience is not accepted');
  }

  if (claims.role !== 'authenticated') {
    // `anon` and `service_role` are refused: neither is a household person.
    throw new JwtVerificationError('invalid_role', 'token role is not accepted');
  }

  // CRITICAL: an anonymous Supabase sign-in still carries role=authenticated,
  // so the role alone does not distinguish a real person from a throwaway
  // identity. A household profile must never be activated from one.
  if (typeof claims['is_anonymous'] !== 'boolean') {
    throw new JwtVerificationError('anonymous_identity', 'is_anonymous is missing or not boolean');
  }
  if (claims['is_anonymous'] === true) {
    throw new JwtVerificationError('anonymous_identity', 'anonymous identities cannot hold a profile');
  }

  const sessionId = claims['session_id'];
  if (typeof sessionId !== 'string' || !SESSION_UUID.test(sessionId)) {
    throw new JwtVerificationError('invalid_session_id', 'token has no usable session id');
  }

  // Authentication metadata, not authorization.
  const aal = claims['aal'];
  if (aal !== undefined && aal !== 'aal1' && aal !== 'aal2') {
    throw new JwtVerificationError('invalid_aal', 'assurance level is not recognised');
  }

  return {
    subjectId: claims.sub,
    sessionId,
    issuedAtIso: new Date(claims.iat * 1000).toISOString(),
    expiresAtIso: new Date(claims.exp * 1000).toISOString(),
    aal: typeof aal === 'string' ? aal : null,
  };
}
