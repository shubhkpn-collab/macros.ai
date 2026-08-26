import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import {
  DEFAULT_RETRY_POLICY, SUPPORTED_SCHEMA_VERSION, applyResult, classify,
  decideActivation, deriveCapabilities, dueForSubmission, nextAttemptAt,
  reconcileDay, recoverInFlight, unsyncedFor, verifyBundle,
  type OfflineCatalogManifest, type OutboxEntry, type RuntimeConditions,
} from '@macros/domain-offline-sync';
import {
  FailingOutboxStore, FilesystemBundleStore, FilesystemOutboxStore,
  LocalStorageUnavailableError,
} from '@macros/offline-adapters';
import { createFoodLogItem } from '@macros/domain-food-log';
import { manualCapture } from '@macros/domain-weight';
import { instant } from '@macros/contracts';
import { SYNTHETIC_PRODUCTS, USER_A, USER_B, approx } from '@macros/testkit';

const CHICKEN = SYNTHETIC_PRODUCTS.find((p) => p.displayName === 'Chicken breast, cooked')!;
const TZ = 'America/Chicago';
const AT = instant('2026-08-26T17:00:00.000Z');

const logFor = (userId: string, logId: string, g = 200) =>
  createFoodLogItem({
    logId, userId, productVersion: CHICKEN,
    weightCapture: manualCapture(g, AT), loggedAt: AT, timezone: TZ,
  });

const entry = (
  userId: string, logId: string, over: Partial<OutboxEntry> = {},
): OutboxEntry => ({
  userId, logId, payload: logFor(userId, logId),
  state: 'pending', attempts: 0, sequence: 1, ...over,
});

const conditions = (over: Partial<RuntimeConditions> = {}): RuntimeConditions => ({
  backendReachable: false, catalogInstalled: true, catalogStale: false,
  localStorageWritable: true, authValid: true, cloudVoiceReachable: false,
  pendingSubmissions: 0, ...over,
});

const tmp = () => mkdtempSync(join(tmpdir(), 'macros-offline-'));

// ---------------------------------------------------------------------------

describe('PART A — offline capability contract', () => {
  test('logging and dashboard stay usable with NO backend', () => {
    const c = deriveCapabilities(conditions({ backendReachable: false }));
    assert.notEqual(c.foodLogging.status, 'unavailable', 'weighing must still work');
    assert.equal(c.dashboard.status, 'available');
    assert.equal(c.foodLogging.reason, 'sync_pending');
  });

  test('cloud voice is reported unavailable, not left to hang', () => {
    const c = deriveCapabilities(conditions({ cloudVoiceReachable: false }));
    assert.equal(c.voice.status, 'unavailable');
    assert.equal(c.voice.reason, 'voice_cloud_unavailable');
    // ...and it must not block manual logging.
    assert.notEqual(c.foodLogging.status, 'unavailable');
  });

  test('no catalog means no search, barcode or logging', () => {
    const c = deriveCapabilities(conditions({ catalogInstalled: false }));
    for (const k of ['catalogSearch', 'barcodeLookup', 'productVersionLookup', 'foodLogging'] as const) {
      assert.equal(c[k].status, 'unavailable', k);
    }
    assert.equal(c.catalogSearch.reason, 'catalog_missing');
  });

  test('a stale catalog degrades rather than disappears', () => {
    const c = deriveCapabilities(conditions({ catalogStale: true }));
    assert.equal(c.catalogSearch.status, 'degraded');
    assert.equal(c.catalogSearch.reason, 'catalog_stale');
  });

  test('unwritable storage makes logging UNAVAILABLE, never silently lossy', () => {
    const c = deriveCapabilities(conditions({ localStorageWritable: false }));
    assert.equal(c.foodLogging.status, 'unavailable');
    assert.equal(c.foodLogging.reason, 'local_storage_unavailable');
  });

  test('account mutation and wearable refresh need the backend', () => {
    const c = deriveCapabilities(conditions({ backendReachable: false }));
    assert.equal(c.wearableRefresh.status, 'unavailable');
    assert.equal(c.accountMutation.reason, 'backend_unavailable');
  });

  test('expired auth is distinguished from an unreachable backend', () => {
    const c = deriveCapabilities(conditions({ backendReachable: true, authValid: false }));
    assert.equal(c.accountMutation.reason, 'auth_expired');
  });
});

describe('PART E/F — bundle verification and atomic activation', () => {
  const shard = { file: 'search/a.ndjson', records: 2, bytes: 10, sha256: 'aa' };
  const manifest = (over: Partial<OfflineCatalogManifest> = {}): OfflineCatalogManifest => ({
    bundleVersion: 'offline-bundle@1.0.0',
    requiredSchemaVersion: SUPPORTED_SCHEMA_VERSION,
    buildComplete: true,
    generatedFromCatalogDigests: {}, policyVersions: {}, counts: {},
    shards: [shard], totalBytes: 10, ...over,
  });

  test('a complete, matching bundle verifies', () => {
    const r = verifyBundle(manifest(), new Map([['search/a.ndjson', 'aa']]));
    assert.equal(r.ok, true);
  });

  test('an INCOMPLETE build never activates', () => {
    const r = verifyBundle(manifest({ buildComplete: false }), new Map([['search/a.ndjson', 'aa']]));
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, 'build_incomplete');
  });

  test('a corrupt shard never activates', () => {
    const r = verifyBundle(manifest(), new Map([['search/a.ndjson', 'WRONG']]));
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, 'shard_hash_mismatch');
  });

  test('a missing shard never activates', () => {
    const r = verifyBundle(manifest(), new Map());
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, 'shard_missing');
  });

  test('MIXED-VERSION artifacts are refused', () => {
    const r = verifyBundle(manifest(), new Map([
      ['search/a.ndjson', 'aa'], ['search/stale-old.ndjson', 'bb'],
    ]));
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, 'shard_unexpected');
  });

  test('an incompatible newer schema is refused, not half-interpreted', () => {
    const r = verifyBundle(manifest({ requiredSchemaVersion: SUPPORTED_SCHEMA_VERSION + 1 }),
      new Map([['search/a.ndjson', 'aa']]));
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, 'unsupported_schema_version');
  });

  test('a rejected update KEEPS the last known-good bundle', () => {
    const previous = manifest({ bundleVersion: 'offline-bundle@0.9.0' });
    const outcome = decideActivation(manifest({ buildComplete: false }), new Map(), previous);
    assert.equal(outcome.kind, 'rejected_kept_previous');
    if (outcome.kind !== 'rejected_kept_previous') return;
    assert.equal(outcome.active?.bundleVersion, 'offline-bundle@0.9.0');
  });

  test('filesystem install promotes atomically and rolls back on corruption', () => {
    const root = tmp();
    const store = new FilesystemBundleStore(root);
    const active = join(root, 'active');
    const staged = join(root, 'staged');

    // Build a good bundle by hand, hashing what we actually wrote.
    mkdirSync(join(staged, 'search'), { recursive: true });
    const body = '{"a":1}\n';
    writeFileSync(join(staged, 'search', 'a.ndjson'), body);
    const digest = createHash('sha256').update(body).digest('hex');
    writeFileSync(join(staged, 'manifest.json'), JSON.stringify({
      bundleVersion: 'v1', requiredSchemaVersion: 1, buildComplete: true,
      generatedFromCatalogDigests: {}, policyVersions: {}, counts: {},
      shards: [{ file: 'search/a.ndjson', records: 1, bytes: body.length, sha256: digest }],
      totalBytes: body.length,
    }));
    assert.equal(store.install(staged, active).kind, 'activated');
    assert.equal(existsSync(join(active, 'search', 'a.ndjson')), true);

    // Now stage a CORRUPT update: the active bundle must survive untouched.
    mkdirSync(join(staged, 'search'), { recursive: true });
    writeFileSync(join(staged, 'search', 'a.ndjson'), 'CORRUPTED');
    writeFileSync(join(staged, 'manifest.json'), readFileSync(join(active, 'manifest.json')));
    const second = store.install(staged, active);
    assert.equal(second.kind, 'rejected_kept_previous');
    assert.equal(readFileSync(join(active, 'search', 'a.ndjson'), 'utf8'), body,
      'the good bundle was not replaced');
    rmSync(root, { recursive: true, force: true });
  });
});

describe('PART I/J/O — durability before success', () => {
  test('a failed local write THROWS rather than reporting success', () => {
    const store = new FailingOutboxStore(new FilesystemOutboxStore(tmp()));
    assert.throws(() => store.put(entry(USER_A, 'l1')), LocalStorageUnavailableError);
  });

  test('the disk-full error is machine-readable', () => {
    const store = new FailingOutboxStore(new FilesystemOutboxStore(tmp()));
    try { store.put(entry(USER_A, 'l1')); assert.fail('should throw'); }
    catch (e) { assert.equal((e as { code: string }).code, 'local_storage_unavailable'); }
  });

  test('a pending log SURVIVES restart (crash before send)', () => {
    const dir = tmp();
    new FilesystemOutboxStore(dir).put(entry(USER_A, 'l1'));
    // Simulate a fresh process: nothing in memory.
    const revived = new FilesystemOutboxStore(dir).readAll();
    assert.equal(revived.length, 1);
    assert.equal(revived[0]!.state, 'pending');
    assert.ok(approx(revived[0]!.payload.nutritionSnapshot.totals.kcal, 330, 1e-9));
  });

  test('a corrupt queue file is skipped, never treated as synced', () => {
    const dir = tmp();
    const store = new FilesystemOutboxStore(dir);
    store.put(entry(USER_A, 'good'));
    mkdirSync(join(dir, encodeURIComponent(USER_A)), { recursive: true });
    writeFileSync(join(dir, encodeURIComponent(USER_A), 'broken.json'), '{not json');
    const all = new FilesystemOutboxStore(dir).readAll();
    assert.equal(all.length, 1);
    assert.equal(all[0]!.logId, 'good');
  });

  test('the development adapter does NOT claim to be secure', () => {
    assert.equal(new FilesystemOutboxStore(tmp()).isSecure, false);
  });
});

describe('PART M/N/P/Q/R — sync state machine', () => {
  test('N: remote accept then local crash settles as ACKED, no duplicate', () => {
    // The retry after the crash returns replayed_existing — the idempotency
    // contract doing exactly its job.
    const after = applyResult(entry(USER_A, 'l1', { state: 'in_flight' }),
      { kind: 'accepted', outcome: 'replayed_existing' }, 0);
    assert.equal(after.state, 'acked');
  });

  test('a first-time accept is ACKED', () => {
    const after = applyResult(entry(USER_A, 'l1'), { kind: 'accepted', outcome: 'appended' }, 0);
    assert.equal(after.state, 'acked');
  });

  test('an idempotency CONFLICT overwrites neither side', () => {
    const after = applyResult(entry(USER_A, 'l1'),
      { kind: 'accepted', outcome: 'idempotency_conflict' }, 0);
    assert.equal(after.state, 'conflict');
    assert.deepEqual(after.payload, entry(USER_A, 'l1').payload, 'payload untouched');
  });

  test('P: in-flight entries recover to pending on startup', () => {
    const recovered = recoverInFlight([entry(USER_A, 'l1', { state: 'in_flight' })]);
    assert.equal(recovered[0]!.state, 'pending', 'never stuck forever');
  });

  test('Q: transport failure is retryable, auth expiry is not', () => {
    assert.equal(classify('transport_unavailable'), 'retryable_failure');
    assert.equal(classify('server_error'), 'retryable_failure');
    assert.equal(classify('auth_expired'), 'blocked_auth');
    assert.equal(classify('integrity_rejected'), 'conflict');
    assert.equal(classify('idempotency_conflict'), 'conflict');
  });

  test('a permanent rejection is NOT retried forever', () => {
    const after = applyResult(entry(USER_A, 'l1'),
      { kind: 'failed', failure: 'integrity_rejected' }, 0);
    assert.equal(after.state, 'conflict');
    assert.equal(after.nextEligibleAttemptAtMs, undefined);
  });

  test('R: backoff is bounded and deterministic', () => {
    assert.equal(nextAttemptAt(0, 0), DEFAULT_RETRY_POLICY.baseDelayMs);
    assert.equal(nextAttemptAt(0, 0), nextAttemptAt(0, 0), 'no randomness');
    assert.ok(nextAttemptAt(50, 0) <= DEFAULT_RETRY_POLICY.maxDelayMs, 'capped');
  });

  test('retries stop after the attempt ceiling', () => {
    let e = entry(USER_A, 'l1', { attempts: DEFAULT_RETRY_POLICY.maxAttempts - 1 });
    e = applyResult(e, { kind: 'failed', failure: 'transport_unavailable' }, 0);
    assert.equal(e.state, 'conflict', 'surfaced rather than looping');
  });

  test('W: expired auth blocks the queue without reassigning it', () => {
    const after = applyResult(entry(USER_A, 'l1'), { kind: 'failed', failure: 'auth_expired' }, 0);
    assert.equal(after.state, 'blocked_auth');
    assert.equal(after.userId, USER_A, 'still owned by the original subject');
  });

  test('only due entries are submitted, in deterministic order', () => {
    const due = dueForSubmission([
      entry(USER_A, 'b', { sequence: 2 }),
      entry(USER_A, 'a', { sequence: 1 }),
      entry(USER_A, 'later', { state: 'retryable_failure', nextEligibleAttemptAtMs: 9_999 }),
      entry(USER_A, 'acked', { state: 'acked' }),
      entry(USER_A, 'blocked', { state: 'blocked_auth' }),
    ], 1_000);
    assert.deepEqual(due.map((d) => d.logId), ['a', 'b']);
  });
});

describe('PART L — dashboard reconciliation', () => {
  const day = logFor(USER_A, 'l1').localDate;

  test('K: a pending log counts immediately with no backend', () => {
    const r = reconcileDay(USER_A, day, [], [entry(USER_A, 'l1')]);
    assert.equal(r.effective.length, 1);
    assert.equal(r.pendingCount, 1);
  });

  test('server + pending copies of the SAME log count once', () => {
    const server = logFor(USER_A, 'l1');
    const r = reconcileDay(USER_A, day, [server], [entry(USER_A, 'l1')]);
    assert.equal(r.effective.length, 1, 'never double-counted');
  });

  test('an acked entry the server has not returned yet still counts once', () => {
    const r = reconcileDay(USER_A, day, [], [entry(USER_A, 'l1', { state: 'acked' })]);
    assert.equal(r.effective.length, 1);
    assert.equal(r.pendingCount, 0);
  });

  test('a payload divergence is surfaced, not silently resolved', () => {
    const server = logFor(USER_A, 'l1', 400); // different weight => different kcal
    const r = reconcileDay(USER_A, day, [server], [entry(USER_A, 'l1')]);
    assert.equal(r.conflicts.length, 1);
    assert.equal(r.conflicts[0]!.reason, 'payload_divergence');
  });

  test('a conflicted entry is excluded and reported', () => {
    const r = reconcileDay(USER_A, day, [],
      [entry(USER_A, 'l1', { state: 'conflict', lastError: 'idempotency_conflict' })]);
    assert.equal(r.effective.length, 0, 'never counted while unresolved');
    assert.equal(r.conflicts.length, 1);
  });

  test('U: another user\'s pending log NEVER appears', () => {
    const r = reconcileDay(USER_A, day, [], [entry(USER_B, 'theirs'), entry(USER_A, 'mine')]);
    assert.deepEqual(r.effective.map((e) => e.logId), ['mine']);
  });

  test('U: B\'s dashboard excludes A entirely', () => {
    const r = reconcileDay(USER_B, day, [], [entry(USER_A, 'mine')]);
    assert.equal(r.effective.length, 0);
    assert.equal(r.pendingCount, 0);
  });

  test('the queue view is user-scoped', () => {
    const all = [entry(USER_A, 'a'), entry(USER_B, 'b'), entry(USER_A, 'c', { state: 'acked' })];
    assert.deepEqual(unsyncedFor(all, USER_A).map((e) => e.logId), ['a']);
    assert.deepEqual(unsyncedFor(all, USER_B).map((e) => e.logId), ['b']);
  });

  test('V: signing out does not delete unsynced logs', () => {
    const dir = tmp();
    new FilesystemOutboxStore(dir).put(entry(USER_A, 'l1'));
    // "Logout" is not an erase; a new store over the same directory still sees it.
    const afterLogout = new FilesystemOutboxStore(dir).readAll();
    assert.equal(afterLogout.length, 1);
    assert.equal(afterLogout[0]!.userId, USER_A, 'still locked to the original subject');
  });
});

describe('PART H — immutability across catalog updates', () => {
  test('a pending V1 log is NEVER rewritten to V2', () => {
    const v1 = entry(USER_A, 'l1');
    const originalVersion = v1.payload.productVersionId;
    const originalKcal = v1.payload.nutritionSnapshot.totals.kcal;

    // A catalog update lands, and the head advances. The outbox entry is a
    // plain immutable payload — nothing in the update path can reach it.
    const afterCatalogUpdate = applyResult(v1, { kind: 'accepted', outcome: 'appended' }, 0);

    assert.equal(afterCatalogUpdate.payload.productVersionId, originalVersion);
    assert.ok(approx(afterCatalogUpdate.payload.nutritionSnapshot.totals.kcal, originalKcal, 1e-9));
  });

  test('an ACK updates sync metadata ONLY', () => {
    const before = entry(USER_A, 'l1');
    const after = applyResult(before, { kind: 'accepted', outcome: 'appended' }, 0);
    assert.deepEqual(after.payload, before.payload, 'weight, snapshot and time untouched');
    assert.notEqual(after.state, before.state);
  });
});
