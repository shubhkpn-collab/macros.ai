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
  /** Household context is bound at mint time, never supplied by a caller. */
  readonly householdId: string | null;
}

export type SubjectMintFailure =
  | 'invalid_credential'
  | 'session_expired'
  | 'invalid_subject_id'
  | 'device_not_bound'
  | 'no_active_membership';

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

export interface MintContext {
  readonly displayName: string;
  readonly householdId: string | null;
  readonly nowIso: string;
  /** Result of the trusted household/device authorisation check. */
  readonly authorized: boolean;
  readonly deviceBound: boolean;
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
  const now = Date.parse(context.nowIso);
  const expires = Date.parse(session.expiresAt);
  if (!Number.isFinite(now) || !Number.isFinite(expires) || now >= expires) {
    return { ok: false, reason: 'session_expired' };
  }
  if (!context.deviceBound) return { ok: false, reason: 'device_not_bound' };
  if (!context.authorized) return { ok: false, reason: 'no_active_membership' };

  return {
    ok: true,
    subject: {
      userId: session.subjectId,
      displayName: context.displayName,
      sessionId: session.sessionId,
      issuedAt: session.issuedAt,
      expiresAt: session.expiresAt,
      householdId: context.householdId,
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
    householdId: over.householdId ?? null,
  } as AuthenticatedSubject;
}
