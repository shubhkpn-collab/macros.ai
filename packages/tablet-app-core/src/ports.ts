import type { AuthenticatedSubject } from '@macros/domain-auth';
import type { Instant } from '@macros/contracts';

/**
 * IDS AND CLOCKS LIVE AT THE EDGE.
 *
 * The deterministic domains never read a clock or generate an id. The
 * application layer is where non-determinism is allowed to enter, and it enters
 * only through these two named ports so tests can inject fixed implementations.
 */
export interface Clock {
  now(): Instant;
}

/**
 * A clock the development harness can advance. Device events are stamped with
 * the TABLET's arrival time, so the scale timeline and the application timeline
 * must be one timeline — two independent clocks make capture requests appear to
 * travel backwards relative to the candidate they are asking for.
 */
export interface MutableClock extends Clock {
  advance(ms: number): void;
}

export interface IdGenerator {
  /** Must be UUID-shaped: the production identity is a PostgreSQL uuid. */
  next(): string;
}

/**
 * APPLICATION IDENTITY BOUNDARY.
 *
 * Persistence stores `user_id uuid` and RLS compares it to `auth.uid()`, while
 * the pure domain treats a user id as an opaque string. This is the one place
 * those two meet. When real auth arrives, `authenticatedSubjectId` is filled
 * from the session and must equal the active domain `userId`; nothing else in
 * the application is allowed to invent a second identity system.
 *
 * Real auth/session binding is an MVP-1 / runtime-backend concern. This
 * milestone closes only the contract.
 */
/**
 * The active user, DERIVED from an AuthenticatedSubject.
 *
 * Previously this was a plain literal any caller could construct, so the
 * privilege boundary was a naming convention: anything that could name a userId
 * could act as that user. It is now obtainable only via `appSubjectFrom`, which
 * requires an unforgeable `AuthenticatedSubject`.
 */
export interface AppSubject {
  readonly authenticatedSubjectId: string;
  readonly userId: string;
  readonly displayName: string;
  /** Proof of provenance: which verified session this subject came from. */
  readonly sessionId: string;
}

/**
 * THE ONLY WAY to produce an AppSubject.
 *
 * The three identities coincide by construction rather than by assertion —
 * there is no field a caller could set to a different user.
 */
export function appSubjectFrom(authenticated: AuthenticatedSubject): AppSubject {
  return {
    authenticatedSubjectId: authenticated.userId,
    userId: authenticated.userId,
    displayName: authenticated.displayName,
    sessionId: authenticated.sessionId,
  };
}

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function assertSubjectBinding(subject: AppSubject): void {
  if (subject.authenticatedSubjectId !== subject.userId) {
    throw new Error(
      'tablet-app-core: authenticated subject does not match the active domain user',
    );
  }
  if (!UUID_SHAPE.test(subject.userId)) {
    // Synthetic development users are UUID-shaped too, so the application never
    // develops assumptions incompatible with the PostgreSQL/RLS boundary.
    throw new Error(`tablet-app-core: userId must be UUID-shaped, got "${subject.userId}"`);
  }
}
