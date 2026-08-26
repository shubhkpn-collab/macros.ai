# 23 — Production Runtime Foundation

> **PRODUCTION RUNTIME FOUNDATION — ENGINEERING CLOSED.**
> **REAL RUNTIME VALIDATION — PARTIALLY BLOCKED BY EXTERNAL TOOLING.**
>
> The HTTP boundary was executed for real against a live localhost server.
> PostgreSQL, React Native and package installation are unavailable in this
> environment — see the unblock checklist. Nothing here claims database runtime
> validation.

## 1. Topology

```
MACROS.AI Tablet  ──HTTPS, Bearer session──▶  Backend modular monolith
                                                 ├── PostgreSQL (app user, RLS)
                                                 ├── PostgreSQL (privileged, server only)
                                                 ├── catalog / curation
                                                 ├── profile / goals / logs
                                                 └── provider adapters
```

The tablet holds **no database credential**. A disassembled or compromised
appliance can reach only the signed-in user's data, because it has nothing else
to present. The phone companion will later use the same contracts.

## 2. Trust boundary

| Operation | Where |
|---|---|
| Read/write own profile, goals, logs, corrections | Client, under RLS as the authenticated user |
| Catalog reads | Client, read-only |
| Catalog ingestion, product version publication, curation | **Server-privileged only** |
| Device provisioning, billing, provider secrets | **Server-privileged only** |

## 3. Composition root

Dependencies are assembled in one place at the edge. Domain and application
packages never read `process.env`, never construct a database client and never
instantiate a provider SDK — enforced by a test that scans every non-`runtime-`
package for `process.env`.

## 4. Configuration and the production guardrail

Typed, validated, fail-fast. Four environments; `development` and `test` may run
simulated implementations, `staging` and `production` may not.

**Two independent guards**, because config states what was *requested* while
construction reveals what is actually *instantiated*:

1. `loadRuntimeConfig` refuses `synthetic` for any component outside dev/test.
2. `assertImplementationAllowed` refuses a known synthetic class by name at
   construction, catching a miswired factory that returns a simulator despite
   `real` config.

Production also refuses `debug` logging, since debug output is where personal
data leaks.

## 5. Secrets

Values never appear in errors, health output, logs or client responses.
Redaction matches on key name **and** on connection-string shape — a DSN carries
its password inline, so redacting "the url" is what protects it. No secret may
enter a pure package, catalog data, a FoodLog, a VoiceResponse or an
`AssistantInterpretationInput`.

## 6. Auth binding

> **AUTH CONTRACT IMPLEMENTED — REAL AUTH PROVIDER PENDING.**

Identity comes from a verified session only. `subjectFromSession` is the sole
way to obtain a subject, binding auth subject = `authenticatedSubjectId` =
domain `userId`. A client-supplied `userId` is treated as a **claim to check**,
never a source of identity: a mismatch is a 403, not a silent downgrade.
Verified end-to-end over real HTTP.

## 7. Migration lifecycle

Ordered by numeric prefix, idempotent, checksum-verified, fails closed. Detects:
an edited already-applied migration (silent schema drift), a partially applied
migration from a run that died mid-way, and a database **ahead** of the build
(a rollback onto a newer schema). A failure stops the run immediately rather
than applying later migrations onto a half-built schema.

## 8. API boundary

One modular monolith on Node's built-in server — no framework was installable,
and none was needed. Handlers do transport only: parse, validate, authenticate,
delegate, map errors. **No business arithmetic in HTTP handlers.**

Bodies are size-bounded; exceeding the limit **pauses** the stream rather than
destroying the socket, so the client receives a clean 400 instead of a
connection reset. Unknown fields are rejected rather than ignored — silently
dropping a field is how a client believes it set something it did not.

## 9. Error taxonomy

Nine kinds with machine-readable codes. `internalDetail` is retained
server-side and dropped from the wire form **by construction**, so a driver
message carrying a connection string cannot reach a client by oversight.
Verified: a thrown `ECONNREFUSED postgres://app:hunter2@db` yields a 500 with no
credential, no driver detail and no stack frames, while the detail is still in
the server log for diagnosis.

## 10. Observability

Structured events with request correlation and a **pseudonymous** subject
reference — stable for correlation, one-way so logs never become a user
directory. Transcripts, nutrition figures, weights, profile fields and
credentials are stripped **by the logger itself**, so a future call site cannot
leak them by forgetting.

## 11. Health and readiness

`processAlive` is distinguished from `ready`. A process whose config is invalid,
whose migrations did not apply, or whose database is unreachable is **not
ready** — reporting healthy in that state is how a partially functional
deployment takes traffic.

## 12. Offline tiers

Declared honestly. Scale weighing and deterministic voice work offline. The
dashboard shows a last-known day marked stale, never recomputed from partial
data. **Food search and food-log writes are `offline_unavailable` in this
milestone** — not cached, not queued. Local pending capture is a dedicated
future domain rather than something half-built, because a half-built sync loses
meals. Activity reports unavailable rather than assuming zero: MISSING is never
ZERO.

## 13. Provider seams

`auth`, `assistant`, `scale`, `activity` and `catalog` are selected by config
and constructed at the root. `DevScaleAdapter` and the fake interpreters cannot
reach staging or production. No vendor is chosen.

## 14. Defect found and fixed

The body size guard destroyed the socket before the 400 could flush, so an
oversized request surfaced as a network failure rather than a clear refusal.
Found by running a real server, not by reading the code.
