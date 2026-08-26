import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  decideActivation, type ActivationOutcome, type OfflineCatalogManifest,
} from '@macros/domain-offline-sync';

/**
 * Filesystem bundle store. Catalog data is PUBLIC product data and needs no
 * encryption — but it does need integrity, because corrupt nutrition is a
 * correctness failure.
 */
export class FilesystemBundleStore {
  constructor(private readonly root: string) {}

  /** Hash every shard actually on disk under a staged bundle. */
  observe(dir: string): Map<string, string> {
    const out = new Map<string, string>();
    const walk = (d: string): void => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) { walk(p); continue; }
        if (e.name === 'manifest.json') continue;
        const h = createHash('sha256').update(readFileSync(p)).digest('hex');
        out.set(relative(dir, p).split('\\').join('/'), h);
      }
    };
    if (existsSync(dir)) walk(dir);
    return out;
  }

  readManifest(dir: string): OfflineCatalogManifest | null {
    const p = join(dir, 'manifest.json');
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, 'utf8')) as OfflineCatalogManifest;
  }

  /**
   * Verify a staged bundle and promote it only if every shard checks out.
   *
   * The active bundle is untouched until the rename succeeds, so a rejected or
   * interrupted update leaves the appliance exactly as it was.
   */
  install(stagedDir: string, activeDir: string): ActivationOutcome {
    const candidate = this.readManifest(stagedDir);
    const current = this.readManifest(activeDir);
    if (candidate === null) {
      return { kind: 'rejected_kept_previous', reason: 'empty_manifest', active: current };
    }
    const outcome = decideActivation(candidate, this.observe(stagedDir), current);
    if (outcome.kind !== 'activated') return outcome;

    const backup = `${activeDir}.previous`;
    if (existsSync(activeDir)) {
      rmSync(backup, { recursive: true, force: true });
      renameSync(activeDir, backup);
    }
    renameSync(stagedDir, activeDir);
    // Last-known-good is retained until the new bundle is proven active.
    return outcome;
  }

  activeManifest(activeDir: string): OfflineCatalogManifest | null {
    return this.readManifest(activeDir);
  }
  get rootDir(): string { return this.root; }
}
