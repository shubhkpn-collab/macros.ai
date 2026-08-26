import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  OUTBOX_SCHEMA_VERSION,
  type OutboxEntry, type OutboxReadResult, type QuarantinedEntry, type QuarantineReason,
} from '@macros/domain-offline-sync';

/**
 * Canonical encoding so the checksum is stable across processes.
 *
 * Recursive key sorting, NOT a replacer array: a replacer array filters keys at
 * every nesting level, so nested payload fields fell outside the checksum
 * entirely and tampering with a nutrition total went undetected.
 */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const parts = Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`);
  return `{${parts.join(',')}}`;
}

export const payloadChecksum = (entry: OutboxEntry): string =>
  createHash('sha256').update(canonical(entry), 'utf8').digest('hex');

/**
 * SECURE LOCAL STORAGE PORT.
 *
 * Pending food logs are private nutrition behaviour. In production they must
 * live in platform secure, keystore-backed application storage.
 *
 * > **PLATFORM SECURE STORAGE VALIDATION — PENDING RENDERER/DEVICE TOOLING.**
 *
 * The filesystem adapter below is DEVELOPMENT AND TEST ONLY. It is plain,
 * unencrypted disk and is deliberately not called secure anywhere.
 *
 * DURABILITY SCOPE: temp-file + rename provides LOGICAL atomicity — a reader
 * never observes a partially written record. It does not fsync, so
 * **physical power-loss durability is NOT claimed** and remains pending Android
 * storage validation.
 */
export interface SecureLocalStore {
  readonly isSecure: boolean;
  /**
   * Returns valid entries AND quarantined records.
   *
   * A corrupt record is never silently dropped: it was already presented to the
   * user as durably logged, so its loss must surface as degraded integrity.
   */
  read(): OutboxReadResult;
  /** Convenience for callers that only need the readable entries. */
  readAll(): readonly OutboxEntry[];
  /** Must be durable before it returns. A throw means NOT written. */
  put(entry: OutboxEntry): void;
  remove(userId: string, logId: string): void;
}

export class LocalStorageUnavailableError extends Error {
  readonly code = 'local_storage_unavailable';
  constructor(cause: string) {
    super(`local storage unavailable: ${cause}`);
    this.name = 'LocalStorageUnavailableError';
  }
}

/**
 * Development filesystem outbox. NOT SECURE — `isSecure` is false, and callers
 * that require secure storage must check it.
 *
 * Writes go to a temp file and are renamed into place, so a crash mid-write
 * cannot leave a half-parsed entry that would corrupt the queue.
 */
export class FilesystemOutboxStore implements SecureLocalStore {
  readonly isSecure = false;

  constructor(private readonly dir: string) {
    try {
      mkdirSync(dir, { recursive: true });
    } catch (e) {
      throw new LocalStorageUnavailableError(String(e));
    }
  }

  private path(userId: string, logId: string): string {
    // User-scoped directories: one user's queue is never enumerable as another's.
    return join(this.dir, encodeURIComponent(userId), `${encodeURIComponent(logId)}.json`);
  }

  read(): OutboxReadResult {
    if (!existsSync(this.dir)) return { validEntries: [], quarantined: [] };
    const valid: OutboxEntry[] = [];
    const quarantined: QuarantinedEntry[] = [];
    const detectedAt = new Date(0).toISOString();

    for (const userDir of readdirSync(this.dir)) {
      const full = join(this.dir, userDir);
      let files: string[] = [];
      try { files = readdirSync(full); } catch { continue; }
      for (const f of files) {
        if (!f.endsWith('.json')) continue;
        // Opaque handle: a digest of the slot, never the path (which encodes a
        // userId). Stable across reads so repair tooling can address it.
        const storageRef = createHash('sha256')
          .update(`${userDir}/${f}`, 'utf8').digest('hex').slice(0, 16);
        const quarantine = (reason: QuarantineReason, userId?: string): void => {
          quarantined.push({
            storageRef, reason, detectedAt,
            ...(userId !== undefined ? { userId } : {}),
          });
        };

        let parsed: unknown;
        try {
          parsed = JSON.parse(readFileSync(join(full, f), 'utf8'));
        } catch {
          quarantine('outbox_corrupt', decodeURIComponent(userDir));
          continue;
        }
        const env = parsed as { schemaVersion?: number; entry?: OutboxEntry; payloadSha256?: string };
        if (typeof env?.schemaVersion !== 'number' || env.entry === undefined) {
          quarantine('outbox_corrupt', decodeURIComponent(userDir));
          continue;
        }
        if (env.schemaVersion > OUTBOX_SCHEMA_VERSION) {
          // An older build must not half-interpret a newer record.
          quarantine('outbox_schema_unsupported', env.entry.userId);
          continue;
        }
        if (payloadChecksum(env.entry) !== env.payloadSha256) {
          // Detected truncation or partial write — never counted, never synced.
          quarantine('outbox_checksum_mismatch', env.entry.userId);
          continue;
        }
        valid.push(env.entry);
      }
    }
    valid.sort((a, b) => a.sequence - b.sequence || a.logId.localeCompare(b.logId));
    quarantined.sort((a, b) => a.storageRef.localeCompare(b.storageRef));
    return { validEntries: valid, quarantined };
  }

  readAll(): readonly OutboxEntry[] {
    return this.read().validEntries;
  }

  put(entry: OutboxEntry): void {
    const target = this.path(entry.userId, entry.logId);
    try {
      mkdirSync(dirname(target), { recursive: true });
      const tmp = `${target}.tmp`;
      const envelope = {
        schemaVersion: OUTBOX_SCHEMA_VERSION,
        entry,
        payloadSha256: payloadChecksum(entry),
      };
      // Temp-file + rename gives LOGICAL atomicity: a reader never sees a
      // half-written record. It does NOT fsync, so physical power-loss
      // durability is not claimed here — that is the platform adapter's job.
      writeFileSync(tmp, JSON.stringify(envelope), 'utf8');
      renameSync(tmp, target);
    } catch (e) {
      // The caller MUST NOT report success after this.
      throw new LocalStorageUnavailableError(String(e));
    }
  }

  remove(userId: string, logId: string): void {
    try { rmSync(this.path(userId, logId), { force: true }); }
    catch (e) { throw new LocalStorageUnavailableError(String(e)); }
  }
}

/** Simulates a full disk or a read-only volume. Test use only. */
export class FailingOutboxStore implements SecureLocalStore {
  readonly isSecure = false;
  constructor(private readonly backing: SecureLocalStore, public failWrites = true) {}
  read(): OutboxReadResult { return this.backing.read(); }
  readAll(): readonly OutboxEntry[] { return this.backing.readAll(); }
  put(entry: OutboxEntry): void {
    if (this.failWrites) throw new LocalStorageUnavailableError('no space left on device');
    this.backing.put(entry);
  }
  remove(u: string, l: string): void { this.backing.remove(u, l); }
}
