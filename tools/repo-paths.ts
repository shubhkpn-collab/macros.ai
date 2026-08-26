import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * REPOSITORY-RELATIVE PATHS.
 *
 * Resolved from this file's own location via `import.meta.url`, NOT from
 * `process.cwd()` — the working directory varies by how a test or tool is
 * invoked, whereas the module's position in the repository is fixed.
 *
 * Nothing here may reference an environment-specific absolute path: the same
 * checkout must run identically on a Linux sandbox, on macOS and in CI.
 */
const HERE = dirname(fileURLToPath(import.meta.url));

/** Repository root — `tools/` is always exactly one level below it. */
export const REPO_ROOT = resolve(HERE, '..');

/** Canonical, repository-owned architecture documentation. */
export const DOCS_ARCHITECTURE = join(REPO_ROOT, 'docs', 'architecture');

export const repoPath = (...segments: string[]): string => join(REPO_ROOT, ...segments);

export const architectureDoc = (filename: string): string =>
  join(DOCS_ARCHITECTURE, filename);

/**
 * Where generated documentation is written.
 *
 * Defaults to the repository so a plain checkout works with no environment
 * variable set. `MACROS_DOCS_OUT` optionally redirects an artifact export;
 * tests must never depend on that override.
 */
export const docsOutputDir = (): string =>
  process.env['MACROS_DOCS_OUT'] ?? DOCS_ARCHITECTURE;

/**
 * Where owner-supplied source archives are read from.
 *
 * Defaults to a repository-relative, gitignored directory. `MACROS_SOURCE_DIR`
 * points at wherever the archives actually live on a given machine.
 */
export const sourceDir = (): string =>
  process.env['MACROS_SOURCE_DIR'] ?? join(REPO_ROOT, 'data', 'sources');

export const sourceFile = (filename: string): string => join(sourceDir(), filename);
