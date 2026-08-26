# 30 — Offline Resilience, Local Catalog Cache and Pending Sync

> **OFFLINE CATALOG CACHE — ENGINEERING CLOSED.**
> **OFFLINE FOOD LOG DURABILITY — ENGINEERING CLOSED.**
> **PENDING FOOD LOG SYNC + IDEMPOTENT RECONCILIATION — ENGINEERING CLOSED.**
> **OFFLINE DASHBOARD RECONCILIATION — ENGINEERING CLOSED.**
> **OFFLINE USER ISOLATION — ENGINEERING CLOSED.**
>
> **PLATFORM SECURE LOCAL STORAGE — PENDING ANDROID DEVICE TOOLING.**
>
> **REFROZEN** after integrity corrections — see §14.

## 0. Integrity corrections (refreeze)

**Corrupt records are quarantined, not skipped.** A locally confirmed log was
already shown to the user as durable, so silently dropping it could make a food
vanish from their totals. Reads now return `validEntries` **and** `quarantined`
records carrying safe metadata only — storage id, reason, detection time — with
no invented nutrition. The dashboard exposes `localIntegrity: complete |
degraded`, and when degraded its totals are a **lower bound**, not authority.
Quarantined records are never synced, deleted or reassigned.

**Per-entry integrity.** Records carry `schemaVersion` and a payload checksum.
Reasons: `outbox_corrupt`, `outbox_checksum_mismatch`,
`outbox_schema_unsupported`. The first canonical encoding used a JSON replacer
array, which filters keys at *every* nesting level — nested nutrition fell
outside the checksum and tampering went undetected. Replaced with recursive key
sorting, proven by a test that alters a nested kcal value.

**Durability scope, stated honestly.** Temp-file + rename gives **logical**
atomicity: a reader never sees a half-written record. There is no `fsync`, so
**physical power-loss durability is not claimed** and remains pending Android
storage validation.

**Exact eligibility ledger** (mutually exclusive, summing to the population):

| | |
|---|---|
| Total current branded products | 434,714 |
| − discontinued | 1,813 |
| − identifier conflicted | 21,933 |
| − needs review | 1,416 |
| **= offline-eligible** | **409,552** |
| Authority pack | 409,552 |

The correct claim is **100% of offline-ELIGIBLE current branded products**, not
"full branded coverage". A deliberately excluded product is not a cache failure.

**Offline barcode outcomes are distinguished** rather than collapsed into
`not_found`: `invalid_identifier` (bad check digit), `product_discontinued`,
`identifier_conflicted`, `identifier_needs_review`,
`not_found_in_cached_catalog`, `catalog_missing`.

**Shard metrics, per class:**

| | |
|---|---|
| Authority shards | 257 |
| Authority total / average / largest | 615.1 MB / 2.4 MB / 14.8 MB |
| Search shards / largest | 12 / 12.7 MB |
| GTIN index | 22.8 MB |
| Manifest | 47,612 bytes |

**Corrected performance labels.** Earlier sub-millisecond figures reflected a
small fixture. Measured against the **real** bundle: authority shard parse
(2.4 MB average) **28.5 ms**; GTIN index parse (22.8 MB, cold) **383.5 ms**;
manifest parse 0.19 ms; checksummed outbox append 0.69 ms; outbox read with
integrity verification 0.59 ms. Development measurements only.

## 1. Doctrine

Offline is not a second nutrition system. It is **a versioned local replica, a
durable user-scoped outbox, and deterministic reconciliation**. Nutrition
authority remains the immutable ProductVersion and the existing engine; energy
authority remains the energy domain. No offline-specific calorie maths exists,
and a test asserts online and offline produce identical totals.

## 2. Capability tiers

A single `isOffline` boolean is useless to someone standing at a scale. Each
capability carries a status and a machine-readable reason.

| Capability | No backend | No catalog | Storage unwritable |
|---|---|---|---|
| catalog search / barcode / version lookup | available | **unavailable** (`catalog_missing`) | available |
| food logging | degraded (`sync_pending`) | unavailable | **unavailable** (`local_storage_unavailable`) |
| dashboard | available | unavailable | unavailable |
| voice | **unavailable** (`voice_cloud_unavailable`) | — | — |
| wearable refresh / account mutation | unavailable (`backend_unavailable`) | — | — |

There is no on-device ASR, so cloud voice is reported unavailable rather than
left to hang — and it never blocks manual logging.

## 3. Bundle architecture

Two artifact classes, deliberately separate:

- **Search projection** — retrieval only. It carries no nutrition; a projection
  with nutrition would be a second, unversioned source of truth. Asserted.
- **Authority pack** — the immutable facts needed to reproduce an exact
  NutritionSnapshot and ProductCard.

**Full coverage, no tiering.** Measurement came first, as instructed:

| Artifact | Size |
|---|---|
| Search projection | 130.5 MB |
| **Authority pack** | **615.1 MB** |
| GTIN index | 22.8 MB |
| **Total installed** | **768.4 MB** |
| Shards | 270 (largest 22.8 MB) |
| Manifest | 47,113 bytes |

Coverage: **6,877 generic** and **409,552 branded**
current products, with 397,737 GTINs. At 768 MB on a ~32 GB device,
degrading to a pinned-recents subset was unnecessary — every offline-eligible
product can be logged offline, because a product without local authority cannot
be safely logged at all.

Authority is bucketed by a hash of `productVersionId` into 256 shards, so a
lookup reads one ~15 MB shard rather than a 615 MB file. RAM, not disk, is the
binding constraint.

## 4. Manifest and atomic activation

The manifest carries `buildComplete`, required schema version, source digests,
policy versions, counts and a **per-shard SHA-256**. Activation is refused for:
an incomplete build, an unsupported schema version, a missing shard, a hash
mismatch, or an unexpected shard (mixed old/new artifacts).

**A rejected update keeps the last known-good bundle**, proven on the filesystem:
a corrupt staged shard leaves the previously active bundle byte-identical.

## 5. Stale versus missing

"Not in the cached catalog" is a claim about our copy; "invalid" is a claim
about the barcode. A structurally valid GTIN absent from the bundle returns
`not_found`, never `invalid_identifier` — only a check-digit failure is
definitive.

## 6. Outbox and sync

An entry is an **immutable confirmed payload plus mutable sync metadata**,
identified by the existing `(userId, logId)` idempotency contract. Nutrition is
never recomputed at sync time; synchronising transmits a decision already made.

States: `pending` → `in_flight` → `acked`, with `retryable_failure`,
`conflict` and `blocked_auth`.

| Failure | Classification |
|---|---|
| transport / server error | `retryable_failure` (bounded backoff, capped) |
| auth expired | `blocked_auth` — never re-sent under another subject |
| idempotency conflict | `conflict` — neither side overwritten |
| integrity rejected | `conflict` — not retried forever |

**Crash after remote accept** is the case the idempotency contract exists for:
the retry returns `replayed_existing`, which settles as ACKED with no duplicate.
**Crash before send** leaves the pending record on disk and still on the
dashboard. **In-flight** entries recover to `pending` at startup — never stuck
forever, and safe because server appends are idempotent.

## 7. Durability before success

Local confirmation writes durably *before* anything is shown as logged. A failed
write throws `local_storage_unavailable`; nothing reports success. Writes are
temp-file-plus-rename, so a crash mid-write cannot corrupt the queue, and a
corrupt entry is skipped rather than silently treated as synced.

## 8. Dashboard reconciliation

Pending logs count immediately with no backend. When the server returns, merge
is by `(userId, logId)`: a log present on both sides counts **once**; an acked
entry the server has not yet returned counts once; a payload divergence is
surfaced as a conflict rather than resolved silently; a conflicted entry is
excluded and reported.

## 9. Isolation and immutability

A pending log is private user data; the catalog is shared public data. B never
sees A's pending food, in either the dashboard or the queue. A user switch
neither exposes nor reassigns A's entries, and signing out does not delete
unsynced work — it stays locked to the original subject.

A catalog update that advances a head to V2 **cannot rewrite a pending V1 log**;
an ACK updates sync metadata only, never the weight, snapshot, time or version.

## 10. Storage security

Pending logs are private nutrition behaviour and belong in platform
keystore-backed storage. Implemented as a **port**, with a filesystem
development adapter that reports `isSecure: false` and is never described as
secure.

> **PLATFORM SECURE STORAGE VALIDATION — PENDING RENDERER/DEVICE TOOLING.**

Catalog artifacts are public and need no encryption — but they do need integrity
hashes and atomic activation, because corrupt nutrition is a correctness failure.

## 11. Telemetry

Operational events only: catalog install success/failure, pending count, retry,
conflict, storage failure. Food descriptions, nutrition, ingredient text and user
identity are excluded by default.

## 12. Performance (development)

Cold manifest load 0.2 ms · runtime catalog build 0.4 ms · search query 5.8 ms ·
GTIN lookup 0.1 ms · authority lookup <0.1 ms · durable outbox append 0.2 ms ·
startup recovery 0.2 ms. Development measurements only — no production claims.

## 13. Known limitations

- Secure storage is a port with a **development-only** filesystem adapter.
- No on-device ASR, so offline voice genuinely does not work.
- Offline **correction/void** transport is deferred; the outbox payload shape can
  carry typed operations later without a rewrite.
- Bundle download/staging is filesystem-only; no network update path yet.
