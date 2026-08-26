import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { OutboxEntry } from '@macros/domain-offline-sync';

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
 */
export interface SecureLocalStore {
  readonly isSecure: boolean;
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

  readAll(): readonly OutboxEntry[] {
    if (!existsSync(this.dir)) return [];
    const out: OutboxEntry[] = [];
    for (const userDir of readdirSync(this.dir)) {
      const full = join(this.dir, userDir);
      let files: string[] = [];
      try { files = readdirSync(full); } catch { continue; }
      for (const f of files) {
        if (!f.endsWith('.json')) continue;
        try {
          out.push(JSON.parse(readFileSync(join(full, f), 'utf8')) as OutboxEntry);
        } catch {
          // A corrupt entry is skipped, never allowed to take down the queue —
          // and never silently treated as synced.
          continue;
        }
      }
    }
    return out.sort((a, b) => a.sequence - b.sequence || a.logId.localeCompare(b.logId));
  }

  put(entry: OutboxEntry): void {
    const target = this.path(entry.userId, entry.logId);
    try {
      mkdirSync(dirname(target), { recursive: true });
      const tmp = `${target}.tmp`;
      writeFileSync(tmp, JSON.stringify(entry), 'utf8');
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
  readAll(): readonly OutboxEntry[] { return this.backing.readAll(); }
  put(entry: OutboxEntry): void {
    if (this.failWrites) throw new LocalStorageUnavailableError('no space left on device');
    this.backing.put(entry);
  }
  remove(u: string, l: string): void { this.backing.remove(u, l); }
}
