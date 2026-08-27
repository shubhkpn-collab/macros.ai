import { appError, type AppError, type AuthSession, type AuthSessionProvider } from '@macros/runtime-config';
import { JwksCache, type JwksCacheOptions } from './jwks.js';
import {
  decodeSegments, isSupportedAlg, JwtVerificationError, validateClaims, verifySignature,
  type ClaimPolicy,
} from './jwt.js';

/**
 * SUPABASE AUTH ADAPTER — production IO edge.
 *
 * Implements the EXISTING `AuthSessionProvider` contract, so nothing downstream
 * changes: the verified session still flows through `subjectFromSession` into
 * the same unforgeable `AuthenticatedSubject`. No Supabase SDK or JWT logic
 * exists in any domain package.
 *
 * Verification uses only PUBLIC asymmetric key material. The service-role key,
 * the database URL and any JWT signing secret are NOT required and must never
 * be configured here.
 */
export interface SupabaseAuthConfig {
  /** e.g. `https://<project>.supabase.co` */
  readonly projectUrl: string;
  /** Defaults to `<projectUrl>/auth/v1` — the issuer Supabase stamps. */
  readonly issuer?: string;
  /** Defaults to `<projectUrl>/auth/v1/.well-known/jwks.json`. */
  readonly jwksUrl?: string;
  readonly clockSkewSeconds?: number;
}

export class SupabaseAuthSessionProvider implements AuthSessionProvider {
  readonly providerKind = 'supabase';
  private readonly jwks: JwksCache;
  private readonly policy: ClaimPolicy;

  constructor(
    config: SupabaseAuthConfig,
    private readonly now: () => number = Date.now,
    cacheOptions: Partial<JwksCacheOptions> = {},
  ) {
    const base = config.projectUrl.replace(/\/+$/, '');
    this.policy = {
      issuer: config.issuer ?? `${base}/auth/v1`,
      ...(config.clockSkewSeconds !== undefined
        ? { clockSkewSeconds: config.clockSkewSeconds } : {}),
    };
    this.jwks = new JwksCache({
      jwksUrl: config.jwksUrl ?? `${base}/auth/v1/.well-known/jwks.json`,
      now: this.now,
      ...cacheOptions,
    });
  }

  /**
   * Verify a Bearer access token.
   *
   * Returns a typed AppError rather than throwing, and the error NEVER contains
   * the token, a claim value or a header — only a stable reason code.
   */
  async verify(credential: string): Promise<AuthSession | AppError> {
    try {
      const { header, claims, signingInput, signature } = decodeSegments(credential);

      if (typeof header.alg !== 'string' || !isSupportedAlg(header.alg)) {
        // `none` and symmetric algorithms are refused outright: accepting them
        // is the classic JWT confusion attack.
        throw new JwtVerificationError('unsupported_algorithm', 'algorithm not accepted');
      }

      const { key, alg } = await this.jwks.keyFor(header.kid);
      if (alg !== header.alg) {
        throw new JwtVerificationError('unsupported_algorithm', 'header alg does not match the key');
      }

      const signatureValid = await verifySignature(key, header.alg, signingInput, signature);
      if (!signatureValid) {
        throw new JwtVerificationError('bad_signature', 'signature did not verify');
      }

      // Claims are validated only AFTER the signature, so an attacker-supplied
      // payload never influences a decision.
      const verified = validateClaims(claims, this.policy, this.now());

      return {
        subjectId: verified.subjectId,
        // The provider's REAL session id — never a subject-id fallback.
        sessionId: verified.sessionId,
        issuedAt: verified.issuedAtIso,
        expiresAt: verified.expiresAtIso,
        // Surfaced, never gated on. See AuthSession.assuranceLevel.
        assuranceLevel: verified.aal,
      };
    } catch (thrown) {
      const reason = thrown instanceof JwtVerificationError ? thrown.reason : 'verification_failed';
      return appError('authentication', reason, 'Not signed in.');
    }
  }

  /** Diagnostic only — never returns key material or tokens. */
  knownKeyIds(): readonly string[] { return this.jwks.knownKeyIds(); }
}
