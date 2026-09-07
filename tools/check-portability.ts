/**
 * FILESYSTEM PORTABILITY GUARD.
 *
 * The same checkout must run identically on a Linux sandbox, on macOS and in
 * CI. Tests once resolved architecture documents through `/mnt/user-data/...`,
 * which passed in the authoring environment and failed everywhere else — the
 * failure surfaced only when the repository was cloned onto a real machine.
 *
 * This checks EXECUTABLE source and config. Prose and recorded provenance are
 * deliberately not rewritten: history is evidence, not a defect.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { REPO_ROOT } from './repo-paths.js';

/** Environment-specific roots that executable code must never require. */
const FORBIDDEN = [/\/mnt\/user-data\//, /\/home\/claude\//, /\/Users\/[a-z]/i];

/** Executable surfaces only. */
const SCAN_DIRS = ['tests', 'tools', 'packages', 'db', 'apps', 'scripts'];
const SCAN_FILES = ['package.json', 'tsconfig.json'];
const CODE = new Set(['.ts', '.tsx', '.js', '.mjs', '.py', '.sql', '.json']);

/**
 * The path helpers necessarily NAME these roots in order to avoid them, and the
 * guard names them to detect them. Both are the mechanism, not a dependency.
 */
const ALLOWED = new Set([
  'tools/repo-paths.ts',
  'tools/repo_paths.py',
  'tools/check-portability.ts',
  // Asserts the helpers do NOT return these roots, so it must name them.
  'tests/repo-portability.test.ts',
  // Recorded ingestion provenance: where an archive was read on a given day.
  // Rewriting it would falsify evidence, and nothing executes from it.
  'data/usda-import-report.json',
]);

const violations: string[] = [];

const check = (abs: string): void => {
  const rel = relative(REPO_ROOT, abs).split('\\').join('/');
  if (ALLOWED.has(rel)) return;
  if (!CODE.has(extname(abs))) return;

  const text = readFileSync(abs, 'utf8');
  text.split('\n').forEach((line, i) => {
    // A comment explaining the absence of such a path is not a dependency.
    const stripped = line.replace(/^\s*(\/\/|#|--|\*).*$/, '');
    for (const pattern of FORBIDDEN) {
      if (pattern.test(stripped)) {
        violations.push(`${rel}:${i + 1}  ${line.trim().slice(0, 90)}`);
      }
    }
  });
};

/**
 * GENERATED Android build output.
 *
 * Gradle and CMake bake machine-specific absolute paths into their artifacts —
 * that is correct behaviour for a build cache, not a portability defect, and it
 * is not executable source authority. These directories are scoped precisely:
 * `apps/tablet/android/**` as a whole stays protected, so the manifest, Gradle
 * files and Kotlin/Java sources beneath it are still scanned.
 */
const GENERATED_BUILD_DIRS = new Set(['.cxx', 'build', '.gradle', '.idea']);

const isGeneratedAndroidOutput = (absolutePath: string): boolean => {
  const rel = relative(REPO_ROOT, absolutePath).split('\\').join('/');
  if (!rel.startsWith('apps/tablet/android/')) return false;
  return rel.split('/').some((segment) => GENERATED_BUILD_DIRS.has(segment));
};

const walk = (dir: string): void => {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return; }
  for (const e of entries) {
    if (e === 'node_modules' || e === '.git') continue;
    const p = join(dir, e);
    if (isGeneratedAndroidOutput(p)) continue;
    if (statSync(p).isDirectory()) walk(p); else check(p);
  }
};

export { isGeneratedAndroidOutput };

for (const d of SCAN_DIRS) walk(join(REPO_ROOT, d));
for (const f of SCAN_FILES) {
  try { check(join(REPO_ROOT, f)); } catch { /* absent is fine */ }
}

if (violations.length > 0) {
  console.error('Filesystem portability violations (executable code must be repo-relative):');
  for (const v of violations) console.error(`  ${v}`);
  console.error('\nUse tools/repo-paths.ts (or repo_paths.py) instead.');
  process.exit(1);
}
console.log('Filesystem portability: OK');
console.log('  no executable dependency on /mnt/user-data, /home/claude or /Users');
