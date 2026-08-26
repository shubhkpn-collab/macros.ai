/**
 * TOOLCHAIN REPRODUCIBILITY GUARD.
 *
 * `package.json` declared scripts that invoke `tsc` and `tsx` but declared no
 * devDependencies, so a fresh clone had to guess versions. A Mac installing
 * "latest" got a compiler generation that had REMOVED `baseUrl`, and typecheck
 * failed with TS5102 plus 28 TS5090 errors — while the authoring environment
 * passed. The repository must state what it needs.
 *
 * This checks that the tooling actually in use matches what is declared. It
 * does not install anything.
 */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { REPO_ROOT, repoPath } from './repo-paths.js';

const require_ = createRequire(import.meta.url);
const pkg = JSON.parse(readFileSync(repoPath('package.json'), 'utf8')) as {
  devDependencies?: Record<string, string>;
  engines?: Record<string, string>;
};

const problems: string[] = [];
const notes: string[] = [];

// --- Node generation ---------------------------------------------------------
const required = pkg.engines?.['node'];
if (required === undefined) {
  problems.push('package.json declares no engines.node');
} else {
  const min = Number(/(\d+)/.exec(required)?.[1] ?? '0');
  const actual = Number(process.versions.node.split('.')[0]);
  if (actual < min) {
    problems.push(`Node ${process.versions.node} is below the required ${required}`);
  }
  notes.push(`node ${process.versions.node} (requires ${required})`);
}

// --- Declared dev tooling ----------------------------------------------------
const dev = pkg.devDependencies ?? {};
if (Object.keys(dev).length === 0) {
  problems.push('package.json declares no devDependencies, so tooling versions are a guess');
}

/**
 * Runtime dependencies the sandbox cannot install (no registry access) are
 * reported, not failed: their absence blocks the Mac integration run, never the
 * unit suite. The Mac closes this by running `npm ci`.
 */
const runtimeOnly = new Set([
  ...Object.keys((pkg as { dependencies?: Record<string, string> }).dependencies ?? {}),
  // Types for a runtime dependency share its availability.
  ...Object.keys(pkg.devDependencies ?? {}).filter((n) => n.startsWith('@types/pg')),
]);
for (const [name, declared] of Object.entries(
  { ...(pkg as { dependencies?: Record<string, string> }).dependencies ?? {}, ...dev },
)) {
  let installed: string | null = null;
  try {
    installed = (require_(`${name}/package.json`) as { version: string }).version;
  } catch {
    if (runtimeOnly.has(name)) {
      notes.push(`${name} ${declared} declared but NOT INSTALLED here — run \`npm ci\` before the integration suite`);
    } else {
      problems.push(`${name} is declared (${declared}) but not resolvable — run npm ci`);
    }
    continue;
  }
  // Exact pins: a mismatch is the very defect this guard exists to catch.
  if (/^\d/.test(declared) && installed !== declared) {
    problems.push(`${name}: declared ${declared}, resolved ${installed}`);
  } else {
    notes.push(`${name} ${installed} (declared ${declared})`);
  }
}

// --- Lockfile ----------------------------------------------------------------
// Advisory, not fatal: a lockfile can only be generated where the registry is
// reachable. Its ABSENCE is reported so it cannot be quietly forgotten.
if (!existsSync(repoPath('package-lock.json'))) {
  notes.push('package-lock.json ABSENT — run `npm install` on a machine with '
    + 'registry access and commit it, so `npm ci` becomes reproducible');
}

void REPO_ROOT;

if (problems.length > 0) {
  console.error('Toolchain problems:');
  for (const p of problems) console.error(`  ${p}`);
  console.error('\nRun `npm ci` (or `npm install`) to install repository-declared tooling.');
  process.exit(1);
}
console.log('Toolchain: OK');
for (const n of notes) console.log(`  ${n}`);
