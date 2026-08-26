# 31 — Household Identity, Multi-User and Device Sessions

> **HOUSEHOLD IDENTITY DOMAIN — ENGINEERING CLOSED.**
> **MULTI-USER PRIVACY BOUNDARY — ENGINEERING CLOSED.**
> **SHARED-DEVICE ACTIVE USER SESSIONS — ENGINEERING CLOSED.**
> **EXPLICIT USER SWITCHING — ENGINEERING CLOSED.**
> **HOUSEHOLD VOICE SWITCH SAFETY — ENGINEERING CLOSED.**
>
> **POSTGRESQL RLS RUNTIME VALIDATION — PENDING.** Migration 0005 is authored
> and statically tested; no policy has executed.

## 1. The governing invariant

> **ADMINISTRATIVE AUTHORITY IS NOT DATA ACCESS.**

An owner administers the household — devices, seats, invitations, removals. That
confers **no** visibility into another adult's nutrition. Conflating the two
would make the appliance unusable for anyone who does not want their eating
visible to whoever set the device up.

## 2. Identity model

A user is a **global identity** who joins a household through a membership. The
household does not own the person: joining or leaving changes a membership row,
never the user's identity and never their nutrition history. The relation is
capable of representing a user joining a different household over time; no
cross-household data sharing exists.

Roles: `owner`, `member`. **No minor role** — the product is 18+ only.
Membership status: `invited` → `active` → `removed`.

## 3. Privacy permission matrix

Default deny. Private resources — food logs, weight, goals, energy state,
recommendations, offline outbox, wearable data, personal preferences — are
readable **only by their own subject**. Role is not consulted for them at all.

| Actor → target | Private resources | Household metadata | Seat / device |
|---|---|---|---|
| self | read/write | read | — |
| owner → member | **denied** (`private_to_other_user`) | write | write |
| member → member | **denied** | read | denied (`requires_owner`) |
| removed member | **denied** (`no_active_membership`) | denied | denied |
| dissolved household | **denied** (`household_dissolved`) | denied | denied |

Every private resource is tested in both directions.

## 4. Lifecycle

Activation requires an **18+ attestation** and available seat capacity. Removal
ends household access and **never deletes food logs** — they belong to the user.
A household can never silently become ownerless: a sole owner must transfer
ownership before leaving, enforced in the domain and by a partial unique index
permitting at most one active owner. Dissolution ends memberships and unbinds
devices while preserving all personal history.

## 5. Seats without billing

`SeatEntitlement` is capacity and state only. There is no price, plan or payment
provider anywhere in the domain or the migration. A suspended seat blocks **new**
activation and never implies authority to delete an existing member; grace
periods and restrictions belong to a future billing domain.

## 6. Age gate

We store **that** eligibility was attested, under which policy version and when.
We deliberately do **not** store a date of birth — there is no other need for
it, so collecting it would be unjustified. A test asserts no DOB column exists.

## 7. Device binding and sessions

A tablet is bound to at most one household. Rebinding advances a binding
generation so stale household context cannot survive.

The device has **no active user or exactly one**. Activation checks binding,
active membership, the age gate and seat state, and fails closed. Knowing a
userId is never sufficient — identity comes from the auth boundary, and a
mismatch between the requested user and the authenticated subject is refused.

The session generation is the **existing** one shared with the voice delivery
boundary — not a second competing concept. It always advances, so A → B → A
yields a third distinct generation and work captured in A's first session can
never execute in A's second.

## 8. Neutral state

With no active user the screen shows household name and a member selector
carrying **display name and role only**. No calories, weight, goals, history,
recommendations or pending sync. A test scans the serialized neutral state for
leaked personal terms.

## 9. Switching

Explicit only: request → target visibly identified → confirmation → current
flow cancelled → generation advances → target activated → only their state
loaded. An unfinished flow (selected food, captured weight) is cancelled rather
than transferred, and is never auto-logged.

## 10. Voice switching (AS-5)

A model may recognise the **name** someone said. It may never supply a userId,
householdId, permission or authorisation — trusted membership resolution
supplies those. Resolution returns a candidate to confirm; it never activates.

Duplicate display names are real (two people called Alex), so a display name is
not identity: an ambiguous name returns candidates rather than a guess. A
confirmation must match both the target and the session generation.

**No voiceprints, no speaker recognition, no face recognition.** "I'm John" is a
switch request, not authentication.

## 11. Concurrency barriers

Proven with barrier-controlled tests:

- an in-flight assistant turn from A **cannot** execute after a switch to B;
- switching back to A **does not** revive it, because the generation moved on;
- a pending scale capture for A **cannot** populate B's flow when it settles;
- "Option B" after a switch **cannot** select A's old list;
- B's dashboard shows none of A's intake.

## 12. Offline interaction

A's confirmed pending log stays A's permanently. Switching users neither shows,
deletes, syncs nor reassigns it. Logout does not delete unsynced work, and
removing a membership leaves the queue untouched — the logs still belong to that
user.

Offline activation is permitted only for users already authorised on the device
by the last trusted membership snapshot, which carries an **explicit expiry**.
New members can never be added offline. We cannot learn offline that the server
removed someone, so cached authorisation is bounded rather than claiming instant
revocation — and the snapshot is emphatically not authentication.

## 13. Persistence and future RLS

Migration 0005 creates `households`, `household_memberships`, `household_devices`
and `household_seat_entitlements`, all with RLS enabled and forced, all policies
membership- or self-scoped. It touches **no personal table**.

When PostgreSQL is available, runtime validation must prove: an owner cannot
SELECT a member's food logs; a member cannot SELECT another's goals; members can
read permitted household metadata; a removed member cannot access shared rows;
and a device session principal sees only the active user's permitted rows.

## 14. Known limitations

- **No real auth provider** — the domain consumes a trusted subject from the
  existing auth boundary; only a fake provider exists.
- **No billing provider** — seats are capacity only.
- **No PostgreSQL execution** — policies are statically tested.
- Single active owner per household by design; multi-owner is not supported.
- Invitation delivery (email/SMS) is out of scope.
