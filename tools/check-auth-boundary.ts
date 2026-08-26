/**
 * AUTHENTICATED SUBJECT BOUNDARY CHECK.
 *
 * Enforces, in CI, that the privilege boundary cannot be re-opened:
 *
 *   1. No PRODUCTION package may call `mintSubjectForTests`.
 *   2. No production package outside `domain-auth` may cast to
 *      `AuthenticatedSubject` — the brand exists precisely to stop that.
 *   3. `AppSubject` may only be produced by `appSubjectFrom`.
 *
 * These are structural rules a reviewer cannot forget to apply.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const PACKAGES = join(ROOT, 'packages');

const violations: string[] = [];

const walk = (dir: string, visit: (p: string) => void): void => {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) { walk(p, visit); continue; }
    if (p.endsWith('.ts')) visit(p);
  }
};

for (const pkg of readdirSync(PACKAGES)) {
  // The test kit is not production; domain-auth defines the brand itself.
  if (pkg === 'testkit' || pkg === 'domain-auth') continue;
  const src = join(PACKAGES, pkg, 'src');
  try { statSync(src); } catch { continue; }

  walk(src, (file) => {
    const code = readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    const rel = file.slice(ROOT.length);

    if (/mintSubjectForTests/.test(code)) {
      violations.push(`${rel}: production code must never mint a test subject`);
    }
    if (/as\s+AuthenticatedSubject/.test(code)) {
      violations.push(`${rel}: casting to AuthenticatedSubject defeats the auth boundary`);
    }
    // An AppSubject object LITERAL re-opens exactly the hole this closed.
    // Type members (`readonly authenticatedSubjectId: string;`) are
    // declarations, not constructions, and are deliberately not flagged.
    const literalAssignment = /:\s*AppSubject\s*=\s*\{/.test(code);
    const literalField = /authenticatedSubjectId\s*:\s*(?!string|readonly)[A-Za-z_$'"`]/.test(code);
    if ((literalAssignment || literalField) && !rel.includes('tablet-app-core/src/ports.ts')) {
      violations.push(`${rel}: AppSubject must be produced by appSubjectFrom, not a literal`);
    }
  });
}

if (violations.length > 0) {
  console.error('Auth boundary violations:');
  for (const v of violations) console.error(`  ${v}`);
  process.exit(1);
}
console.log('Auth boundary: OK');
console.log('  no production mintSubjectForTests, no AuthenticatedSubject casts,');
console.log('  no AppSubject literals outside appSubjectFrom');
