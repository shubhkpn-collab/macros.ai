import { mintSubject, type AuthenticatedSubject } from '@macros/domain-auth';
// Attempt 1: object literal — must not compile as AuthenticatedSubject.
const forgedLiteral = { userId: "x", displayName: "x", sessionId: "s", issuedAt: "", expiresAt: "", householdId: null };
// @ts-expect-error a branded subject cannot be produced by a cast from a literal
const forged: AuthenticatedSubject = forgedLiteral;
void forged; void mintSubject;
console.log('forgery attempts rejected at compile time');
