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
  /** Provider session handle, when the provider supplies one. */
  readonly sessionId?: string;
  readonly displayName?: string;
  readonly householdId?: string | null;
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
  const minted = mintSubject(
    { subjectId: session.subjectId, sessionId: session.sessionId ?? session.subjectId,
      issuedAt: session.issuedAt, expiresAt: session.expiresAt },
    { displayName: session.displayName ?? 'Member', householdId: session.householdId ?? null,
      nowIso, authorized: true, deviceBound: true },
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
