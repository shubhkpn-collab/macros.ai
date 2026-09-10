/**
 * TABLET RELATIVE-IMPORT GUARD.
 *
 * Root `npm run verify` type-checks the packages but deliberately excludes
 * `apps/tablet`, because compiling it needs React and React Native types the
 * root graph does not carry. That gap meant a misplaced relative import —
 * `./premium-transport.js` when the file lives in `./voice/` — survived every
 * root check and only surfaced on the owner's Mac, after an expensive Android
 * hydration.
 *
 * This is NOT a type checker. It answers one narrow question quickly: does
 * every relative import in the tablet source point at a file that exists? That
 * is the entire class of failure that was reaching the owner, and it can be
 * settled deterministically with no dependencies.
 *
 * Under the repository's bundler convention, source is `.ts`/`.tsx` while
 * imports are written with `.js`, so the extension is remapped before checking.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { REPO_ROOT } from './repo-paths.js';

const TABLET_SRC = join(REPO_ROOT, 'apps', 'tablet', 'src');

/** Every `from './x'` / `from "../x"` in a file, with its line number. */
const IMPORT_PATTERN = /from\s+['"](\.[^'"]*)['"]/g;

export interface ImportViolation {
  readonly file: string;
  readonly line: number;
  readonly specifier: string;
}

/**
 * Candidate source files for one import specifier.
 *
 * A `.js` specifier maps to `.ts`/`.tsx`; an extensionless one may be a file or
 * a directory index. Anything that resolves is accepted, so the guard stays
 * quiet about style and speaks only about existence.
 */
function candidatesFor(absolute: string): readonly string[] {
  const withoutJs = absolute.replace(/\.js$/, '');
  return [
    `${withoutJs}.ts`,
    `${withoutJs}.tsx`,
    join(withoutJs, 'index.ts'),
    join(withoutJs, 'index.tsx'),
    // A specifier may legitimately name a real asset directly.
    absolute,
  ];
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, out);
      continue;
    }
    if (/\.tsx?$/.test(full)) out.push(full);
  }
  return out;
}

/**
 * Check every relative import in the tablet source.
 *
 * Exported so a test can assert both directions — that a real misplacement is
 * caught, and that the current tree is clean.
 */
export function findUnresolvedTabletImports(root: string = TABLET_SRC): ImportViolation[] {
  if (!existsSync(root)) return [];
  const violations: ImportViolation[] = [];

  for (const file of walk(root)) {
    const source = readFileSync(file, 'utf8');
    const lines = source.split('\n');

    lines.forEach((text, index) => {
      // Comments may DISCUSS a path that does not exist.
      if (/^\s*(\*|\/\/)/.test(text)) return;

      for (const match of text.matchAll(IMPORT_PATTERN)) {
        const specifier = match[1]!;
        const absolute = resolve(dirname(file), specifier);
        if (candidatesFor(absolute).some((c) => existsSync(c))) continue;
        violations.push({
          file: file.slice(REPO_ROOT.length + 1),
          line: index + 1,
          specifier,
        });
      }
    });
  }
  return violations;
}

/**
 * CLI entry. Run directly it prints each unresolved import and exits non-zero,
 * so `npm run verify` fails on a bad path before anything is hydrated.
 */
if (process.argv[1] !== undefined && process.argv[1].endsWith('check-tablet-imports.ts')) {
  const violations = findUnresolvedTabletImports();
  if (violations.length > 0) {
    console.error('Unresolved relative imports in apps/tablet/src:');
    for (const v of violations) {
      console.error(`  ${v.file}:${String(v.line)}  ${v.specifier}`);
    }
    console.error('\nEach must resolve to a .ts/.tsx file or a directory index.');
    process.exit(1);
  }
  console.log('Tablet imports: OK');
  console.log('  every relative import in apps/tablet/src resolves to real source');
}
