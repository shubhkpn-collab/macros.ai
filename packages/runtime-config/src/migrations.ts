import { appError, type AppError } from './errors.js';

/**
 * MIGRATION RUNNER.
 *
 * Ordered, idempotent, checksum-verified, and fails closed. Deliberately small:
 * a commercial product needs migration tracking, but not an ORM to get it.
 *
 * The driver is an interface so the ordering, checksum and partial-application
 * logic is testable without a database. Executing real DDL still requires a
 * real PostgreSQL — see the unblock checklist.
 */

export interface MigrationFile {
  readonly name: string;
  readonly sql: string;
}

export interface AppliedMigration {
  readonly name: string;
  readonly checksum: string;
  readonly appliedAt: string;
  /** False when a previous run died mid-migration. */
  readonly succeeded: boolean;
}

export interface MigrationDriver {
  ensureTrackingTable(): Promise<void>;
  listApplied(): Promise<readonly AppliedMigration[]>;
  /** Must run the SQL and record the row in ONE transaction. */
  applyInTransaction(file: MigrationFile, checksum: string): Promise<void>;
}

/**
 * Deterministic content checksum (FNV-1a, hex).
 *
 * Detects an already-applied migration file being edited after the fact — a
 * silent schema drift that is otherwise invisible until data is wrong.
 */
export function checksumOf(sql: string): string {
  let h = 2166136261;
  for (let i = 0; i < sql.length; i++) {
    h ^= sql.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Migration order is lexicographic by numeric prefix, never directory order. */
export const orderMigrations = (files: readonly MigrationFile[]): readonly MigrationFile[] =>
  [...files].sort((a, b) => a.name.localeCompare(b.name));

export interface MigrationPlan {
  readonly pending: readonly MigrationFile[];
  readonly alreadyApplied: readonly string[];
}

export type MigrationOutcome =
  | { readonly ok: true; readonly applied: readonly string[]; readonly skipped: readonly string[] }
  | { readonly ok: false; readonly error: AppError };

export async function planMigrations(
  files: readonly MigrationFile[],
  driver: MigrationDriver,
): Promise<MigrationPlan | AppError> {
  const ordered = orderMigrations(files);
  const applied = await driver.listApplied();
  const byName = new Map(applied.map((a) => [a.name, a]));

  // A migration recorded as started but not succeeded means a previous run died
  // partway. Continuing could apply later migrations onto a half-built schema.
  const broken = applied.find((a) => !a.succeeded);
  if (broken !== undefined) {
    return appError(
      'dependency_unavailable',
      'migration_partially_applied',
      'The database is in a partially migrated state and needs manual repair.',
      `partial migration: ${broken.name}`,
    );
  }

  const pending: MigrationFile[] = [];
  const alreadyApplied: string[] = [];

  for (const file of ordered) {
    const record = byName.get(file.name);
    if (record === undefined) { pending.push(file); continue; }

    if (record.checksum !== checksumOf(file.sql)) {
      return appError(
        'dependency_unavailable',
        'migration_checksum_mismatch',
        'An applied migration no longer matches its recorded contents.',
        `checksum mismatch: ${file.name}`,
      );
    }
    alreadyApplied.push(file.name);
  }

  // An applied migration with no corresponding file means the database is ahead
  // of this build — usually a rollback onto a newer schema.
  const knownNames = new Set(ordered.map((f) => f.name));
  const unknown = applied.find((a) => !knownNames.has(a.name));
  if (unknown !== undefined) {
    return appError(
      'dependency_unavailable',
      'schema_ahead_of_build',
      'The database schema is newer than this application build.',
      `unknown applied migration: ${unknown.name}`,
    );
  }

  return { pending, alreadyApplied };
}

export async function runMigrations(
  files: readonly MigrationFile[],
  driver: MigrationDriver,
): Promise<MigrationOutcome> {
  try {
    await driver.ensureTrackingTable();
    const plan = await planMigrations(files, driver);
    if ('kind' in plan) return { ok: false, error: plan };

    const applied: string[] = [];
    for (const file of plan.pending) {
      // Sequential and transactional. A failure stops the run immediately
      // rather than attempting later migrations against a broken schema.
      await driver.applyInTransaction(file, checksumOf(file.sql));
      applied.push(file.name);
    }
    return { ok: true, applied, skipped: [...plan.alreadyApplied] };
  } catch (thrown) {
    return {
      ok: false,
      error: appError(
        'dependency_unavailable',
        'migration_failed',
        'Database migration failed.',
        thrown instanceof Error ? thrown.message : String(thrown),
      ),
    };
  }
}

/** DDL for the tracking table itself, applied before any migration runs. */
export const MIGRATION_TRACKING_DDL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
    name        text        NOT NULL PRIMARY KEY,
    checksum    text        NOT NULL,
    applied_at  timestamptz NOT NULL DEFAULT now(),
    succeeded   boolean     NOT NULL DEFAULT false
);
`.trim();
