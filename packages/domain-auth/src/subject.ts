/**
 * AUTHENTICATED SUBJECT — AN UNFORGEABLE CAPABILITY.
 *
 * The previous boundary was a naming convention: `switchActiveUser` accepted a
 * caller-constructed `AppSubject`, so any code path that could name a userId
 * could act as that user. Nothing in the type system prevented it.
 *
 * An `AuthenticatedSubject` therefore carries a PRIVATE BRAND that only this
 * module can attach. It cannot be constructed by an object literal, a cast is
 * defeated by the unique symbol, and there is no public constructor — the only
 * way to obtain one is to verify a credential.
 */
export const AUTH_SUBJECT_VERSION = 'auth-subject@1.0.0';

/** Unique, module-private. Not exported, so no external code can produce it. */
declare const AUTHENTICATED_BRAND: unique symbol;

export interface AuthenticatedSubject {
  readonly [AUTHENTICATED_BRAND]: true;
  readonly userId: string;
  readonly displayName: string;
  /** The session this subject was minted from. */
  readonly sessionId: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  /**
   * Provider assurance level. AUTHENTICATION METADATA — never an authorization
   * input. No code path may branch on it without an explicit, reviewed policy.
   */
  readonly assuranceLevel?: string;
}

/**
 * AUTHENTICATION failures only.
 *
 * `device_not_bound` and `no_active_membership` are gone: they are
 * AUTHORIZATION questions and belong to household activation. Requiring them to
 * mint a subject made the generic HTTP path dishonest — it had to pass
 * `authorized: true` it had never proven.
 */
export type SubjectMintFailure =
  | 'invalid_credential'
  | 'session_expired'
  | 'invalid_subject_id'
  | 'invalid_session_id'
  | 'invalid_session_times';

export type SubjectMintResult =
  | { readonly ok: true; readonly subject: AuthenticatedSubject }
  | { readonly ok: false; readonly reason: SubjectMintFailure };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * The verified assertion an auth provider returns. Deliberately NOT a subject:
 * it must still pass household and device checks before becoming one.
 */
export interface VerifiedSession {
  readonly subjectId: string;
  readonly sessionId: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

/**
 * Trusted inputs to minting. Presentation metadata only — nothing here decides
 * whether the person may use a particular device.
 */
export interface MintContext {
  readonly displayName: string;
  readonly nowIso: string;
  readonly assuranceLevel?: string;
}

/**
 * THE ONLY WAY to obtain an AuthenticatedSubject.
 *
 * Every failure mode returns a reason instead of a subject; there is no partial
 * or "probably fine" subject.
 */
export function mintSubject(
  session: VerifiedSession,
  context: MintContext,
): SubjectMintResult {
  if (!UUID.test(session.subjectId)) {
    return { ok: false, reason: 'invalid_subject_id' };
  }
  // A login session is a different identity from the person. Supabase supplies
  // `session_id`; falling back to the subject id would conflate the two.
  if (typeof session.sessionId !== 'string' || session.sessionId.length === 0) {
    return { ok: false, reason: 'invalid_session_id' };
  }
  const now = Date.parse(context.nowIso);
  const issued = Date.parse(session.issuedAt);
  const expires = Date.parse(session.expiresAt);
  if (!Number.isFinite(now) || !Number.isFinite(expires) || !Number.isFinite(issued)) {
    return { ok: false, reason: 'invalid_session_times' };
  }
  if (issued > expires) return { ok: false, reason: 'invalid_session_times' };
  if (now >= expires) return { ok: false, reason: 'session_expired' };

  return {
    ok: true,
    subject: {
      userId: session.subjectId,
      displayName: context.displayName,
      sessionId: session.sessionId,
      issuedAt: session.issuedAt,
      expiresAt: session.expiresAt,
      ...(context.assuranceLevel !== undefined
        ? { assuranceLevel: context.assuranceLevel } : {}),
    } as AuthenticatedSubject,
  };
}

/** Read the subject id. There is deliberately no setter and no rebinder. */
export const subjectUserId = (s: AuthenticatedSubject): string => s.userId;

export const subjectExpired = (s: AuthenticatedSubject, nowIso: string): boolean =>
  Date.parse(nowIso) >= Date.parse(s.expiresAt);

/**
 * TEST-ONLY minting.
 *
 * Deliberately named so its use is obvious in review and greppable in CI. It
 * exists because tests must construct subjects; production code paths that call
 * it are a defect, and a test asserts no production package does.
 */
export function mintSubjectForTests(
  userId: string,
  over: Partial<Omit<AuthenticatedSubject, typeof AUTHENTICATED_BRAND>> = {},
): AuthenticatedSubject {
  return {
    userId,
    displayName: over.displayName ?? 'Test User',
    sessionId: over.sessionId ?? `test-session-${userId}`,
    issuedAt: over.issuedAt ?? '2026-01-01T00:00:00.000Z',
    expiresAt: over.expiresAt ?? '2099-01-01T00:00:00.000Z',
  } as AuthenticatedSubject;
}
