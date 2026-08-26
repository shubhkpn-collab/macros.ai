# 32 — The Authenticated Subject Boundary

> **AUTHENTICATED SUBJECT BOUNDARY — ENGINEERING CLOSED**
>
> **SHARED-DEVICE AUTHENTICATION STATE MACHINE — PARTIAL**
> **AUTHENTICATED USER SWITCHING — PARTIAL**
>
> **REAL ONLINE AUTH PROVIDER — PENDING**
> **PLATFORM SECURE OFFLINE MEMBER UNLOCK — PENDING ANDROID TOOLING**

## 0. Scope of this document — read first

This document covers **one** closure: the subject boundary. The earlier title
claimed the whole state machine was closed, which overstated what was built.

**What IS closed:** `AuthenticatedSubject` is unforgeable, `mintSubject` is the
only production path, `AppSubject` is derived solely by `appSubjectFrom`, and CI
enforces all three.

**What is NOT built** — and must not be read as closed:

| Item | State |
|---|---|
| Two-phase switch (REQUEST → AUTHENTICATE → ACTIVATE) | **not implemented** |
| Privacy shield on failed/cancelled switch | **not implemented** |
| `MemberAuthenticationPort` | **not implemented** |
| `OfflineMemberUnlockVerifier` | **not implemented** |
| Unlock challenge binding and replay protection | **not implemented** |
| Session-generation invalidation on authentication | **not implemented** |
| Restart-to-neutral / no implicit last-user reopen | **not implemented** |
| Authentication-aware permission matrix | **not implemented** |

The root cause — a forgeable subject — is fixed, which is what made the gap a
security hole. The surrounding state machine is future work.

## 1. The finding

Household membership answers **"may B use this device?"**. It never answered
**"is the person in front of the device B?"**.

`TabletAppController.switchActiveUser(subject, activity)` accepted a
caller-constructed `AppSubject`. `assertSubjectBinding` then checked that
`authenticatedSubjectId === userId` — but **both fields came from the caller**.
Any code path that could name a userId could act as that user. The privilege
boundary was a naming convention.

## 2. Authorization is an INPUT to authentication, never a substitute

| Question | Answered by | Sufficient to activate? |
|---|---|---|
| May B use this device? | `HouseholdMembershipSnapshot` | **No** |
| Is this device bound to the household? | `DeviceBinding` | **No** |
| Is this person B? | verified session → `mintSubject` | Only with the above |

`mintSubject` requires **all three** and returns a typed reason otherwise:
`invalid_subject_id`, `session_expired`, `device_not_bound`,
`no_active_membership`. There is no partial or "probably fine" subject.

## 3. The subject is unforgeable

```ts
declare const AUTHENTICATED_BRAND: unique symbol;
```

The symbol is module-private, so no code outside `@macros/domain-auth` can
produce a value of that type — not by object literal, not by cast.
`tests/typecheck/forge-subject.ts` attempts the forgery under
`@ts-expect-error`; if the brand ever weakened the directive would become
unused and **the build would fail**. The proof is load-bearing, not decorative.

`AppSubject` is produced only by `appSubjectFrom(authenticated)`, so its three
identities coincide **by construction**. The old runtime mismatch check now
tests something unrepresentable, and the test says exactly that.

## 4. One derivation path

`runtime-config` previously returned its own subject-shaped literal — a second
place identity could be constructed. It now mints through the same routine, so
there is exactly one way an identity comes into existence.

## 5. Enforced in CI, not by review

`tools/check-auth-boundary.ts` fails the build if any production package calls
`mintSubjectForTests` (deliberately greppable), casts `as AuthenticatedSubject`,
or constructs an `AppSubject` literal outside `ports.ts`. Type *declarations* are
not flagged — the rule targets construction, not description.

## 6. What is NOT claimed

- **No real online auth provider.** The port exists; the dev adapter is fake.
- **No offline member unlock.** Device-local credential verification needs
  platform secure storage (Android keystore), unavailable here. No plaintext PIN,
  password or biometric material is stored anywhere, and nothing in this
  environment may be called secure device unlock.
- **Voice is not authentication.** No voiceprint, no speaker recognition. "I'm
  John" remains target *selection*; the assistant still cannot emit an
  authenticated subject id.

The subject boundary and state machine are closed. The credential providers are
not, and are listed as pending.

## 7. Offline evidence refreeze (Part A)

| | |
|---|---|
| Authority shards | 257 |
| Authority total | 615.1 MB |
| Authority average shard | 2.4 MB |
| Authority largest shard | 14.8 MB |
| Search shards | 12 (largest 12.7 MB) |
| GTIN buckets | 100 |
| GTIN average bucket | 233 KB |
| GTIN largest bucket | 309 KB |
| Manifest | 61.7 KB |
| **Barcode scan parse** | **383.5 ms → 4.0 ms** |

All figures are read from `data/offline-bundle-manifest.json`; none are
hand-copied.

Quarantined records now carry an **opaque digest reference** rather than a path
embedding an encoded userId, and quarantine exclusion is enforced **inside
`dueForSubmission`** rather than by caller discipline: a failed-integrity payload
cannot be trusted to represent what the user confirmed, so it is never
transmitted regardless of how it is passed in.

Ownership transfer is atomic: `transferOwnership` validates that its returned
state contains exactly one active owner and fails closed otherwise, matching the
`household_single_active_owner` partial unique index, which would reject a
promote-then-demote ordering.
