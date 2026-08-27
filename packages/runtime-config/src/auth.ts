import { mintSubject, type AuthenticatedSubject } from '@macros/domain-auth';
import { appError, type AppError } from './errors.js';

/**
 * AUTH BOUNDARY.
 *
 * > AUTH CONTRACT IMPLEMENTED — REAL AUTH PROVIDER PENDING.
 *
 * The invariant this closes: an authenticated subject's identity comes from a
 * VERIFIED SESSION, never from a caller-supplied field. Before this, any code
 * path could construct an `AppSubject` for an arbitrary user id; now the only
 * way to obtain one is through a verified session, so "act as another user" is
 * not expressible rather than merely discouraged.
 */

export interface AuthSession {
  /** Identity as asserted by the auth provider. */
  readonly subjectId: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  /**
   * The provider's real session identifier. REQUIRED: a user identity and a
   * login session are different things, and falling back to the subject id
   * would silently conflate them.
   */
  readonly sessionId: string;
  readonly displayName?: string;
  /**
   * Authenticator Assurance Level from the provider (`aal1` / `aal2`).
   *
   * AUTHENTICATION METADATA ONLY. Nothing in this product gates on it today,
   * and it must NOT become a silent authorization input. It is surfaced so a
   * downgrade — an aal2-capable account presenting an aal1 token — is at least
   * observable, and so a future step-up policy has something to read.
   */
  readonly assuranceLevel?: string | null;
}

export interface AuthSessionProvider {
  readonly providerKind: string;
  /** Verify a bearer credential. Returns a session or an auth error. */
  verify(credential: string): Promise<AuthSession | AppError>;
}

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Bind a verified session to a domain subject.
 *
 * The three identities must coincide: auth subject, `authenticatedSubjectId`
 * and domain `userId`. A caller-supplied id is accepted ONLY as a claim to
 * check against the session — never as a source of identity.
 */
export function subjectFromSession(
  session: AuthSession,
  nowIso: string,
  claimedUserId?: string,
): AuthenticatedSubject | AppError {
  if (!UUID_SHAPE.test(session.subjectId)) {
    return appError('authentication', 'invalid_subject', 'Session subject is not a valid identity.');
  }
  const now = Date.parse(nowIso);
  const expires = Date.parse(session.expiresAt);
  if (!Number.isFinite(now) || !Number.isFinite(expires)) {
    return appError('authentication', 'invalid_session_time', 'Session validity could not be determined.');
  }
  if (now >= expires) {
    return appError('authentication', 'session_expired', 'Your session has expired.');
  }
  // A client asking to act as someone else is refused outright, not silently
  // downgraded to its own identity.
  if (claimedUserId !== undefined && claimedUserId !== session.subjectId) {
    return appError('authorization', 'subject_mismatch', 'Not permitted for this profile.');
  }
  // ONE derivation path. Previously this returned its own subject-shaped
  // literal, which was a second place identity could be constructed; it now
  // mints through the same branded routine everything else uses.
  // No hard-coded authorization booleans. This path establishes AUTHENTICATED
  // IDENTITY only; whether that person may activate on a particular kitchen
  // device is decided later by household activation, which has the facts.
  const minted = mintSubject(
    {
      subjectId: session.subjectId,
      sessionId: session.sessionId,
      issuedAt: session.issuedAt,
      expiresAt: session.expiresAt,
    },
    {
      displayName: session.displayName ?? 'Member',
      nowIso,
      ...(session.assuranceLevel !== undefined && session.assuranceLevel !== null
        ? { assuranceLevel: session.assuranceLevel } : {}),
    },
  );
  if (!minted.ok) {
    return appError('authentication', minted.reason, 'Your session could not be verified.');
  }
  return minted.subject;
}

/** Test/development only. Rejected in production by the composition root. */
export class FakeAuthSessionProvider implements AuthSessionProvider {
  readonly providerKind = 'fake';
  constructor(private readonly sessions: Readonly<Record<string, AuthSession>>) {}
  verify(credential: string): Promise<AuthSession | AppError> {
    const s = this.sessions[credential];
    return Promise.resolve(
      s ?? appError('authentication', 'invalid_credential', 'Not signed in.'),
    );
  }
}
