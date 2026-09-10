import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { findUnresolvedTabletImports } from '../tools/check-tablet-imports.js';
import { repoPath } from '../tools/repo-paths.js';

/** A throwaway source tree, so the guard is tested on shapes not just the repo. */
function scratch(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'macros-imports-'));
  for (const [rel, contents] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, contents);
  }
  return root;
}

describe('TABLET IMPORTS — the guard catches misplaced relative paths', () => {
  test('the exact reported failure is caught', () => {
    // ./premium-transport.js when the file lives in ./voice/ — this survived
    // every root check and only appeared after the owner hydrated Android.
    const root = scratch({
      'host-selection.acceptance.ts':
        "import { x } from './premium-transport.js';\n",
      'voice/premium-transport.ts': 'export const x = 1;\n',
    });
    try {
      const found = findUnresolvedTabletImports(root);
      assert.equal(found.length, 1);
      assert.equal(found[0]?.specifier, './premium-transport.js');
      assert.equal(found[0]?.line, 1);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('the corrected path passes', () => {
    const root = scratch({
      'host-selection.acceptance.ts':
        "import { x } from './voice/premium-transport.js';\n",
      'voice/premium-transport.ts': 'export const x = 1;\n',
    });
    try {
      assert.deepEqual(findUnresolvedTabletImports(root), []);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('it is not brittle — it catches ANY misplaced relative import', () => {
    // The point is the class of error, not one filename.
    const root = scratch({
      'a.ts': "import { x } from './missing-sibling.js';\n",
      'nested/b.tsx': "import { y } from '../also-missing.js';\n",
      'nested/c.ts': "import { z } from './deep/gone.js';\n",
    });
    try {
      const found = findUnresolvedTabletImports(root);
      assert.equal(found.length, 3);
      assert.deepEqual(found.map((v) => v.specifier).sort(), [
        '../also-missing.js', './deep/gone.js', './missing-sibling.js',
      ]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('it accepts every legitimate shape', () => {
    const root = scratch({
      'entry.ts': [
        "import { a } from './sibling.js';",
        "import { b } from './folder/index.js';",
        "import { c } from './folder';",
        "import { d } from './component.js';",
        "import { e } from '../up/one.js';",
        '',
      ].join('\n'),
      'sibling.ts': 'export const a = 1;\n',
      'folder/index.ts': 'export const b = 1;\n',
      'component.tsx': 'export const d = 1;\n',
      '../up/one.ts': 'export const e = 1;\n',
    });
    try {
      assert.deepEqual(findUnresolvedTabletImports(root), []);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('package imports are ignored — only relative paths are its business', () => {
    const root = scratch({
      'a.ts': [
        "import { x } from '@macros/tablet-voice';",
        "import { View } from 'react-native';",
        '',
      ].join('\n'),
    });
    try {
      assert.deepEqual(findUnresolvedTabletImports(root), []);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('a path mentioned only in a comment is not a violation', () => {
    const root = scratch({
      'a.ts': [
        '// Previously imported from \'./old-location.js\'.',
        " * moved from './another-old.js'",
        "import { x } from './real.js';",
        '',
      ].join('\n'),
      'real.ts': 'export const x = 1;\n',
    });
    try {
      assert.deepEqual(findUnresolvedTabletImports(root), []);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('TABLET IMPORTS — the real tree and the pipeline', () => {
  test('every relative import in apps/tablet/src resolves', () => {
    const found = findUnresolvedTabletImports();
    assert.deepEqual(found, [],
      found.map((v) => `${v.file}:${String(v.line)} ${v.specifier}`).join('\n'));
  });

  test('the guard runs inside npm run verify', () => {
    // The whole point is finding this before an Android hydration is paid for.
    const pkg = JSON.parse(
      readFileSync(repoPath('package.json'), 'utf8')) as {
        scripts: Record<string, string>;
      };
    assert.match(pkg.scripts['check:tablet-imports'] ?? '', /check-tablet-imports/);
    assert.match(pkg.scripts['verify'] ?? '', /check:tablet-imports/);
    // Ahead of typecheck and tests: a bad path is the cheapest failure to find.
    const verify = pkg.scripts['verify'] ?? '';
    assert.ok(verify.indexOf('check:tablet-imports') < verify.indexOf('npm run test'));
  });

  test('the guard is dependency-free and is not a type checker', () => {
    const code = readFileSync(repoPath('tools', 'check-tablet-imports.ts'), 'utf8');
    assert.equal(/from 'typescript'|require\(/.test(code), false);
    assert.match(code, /This is NOT a type checker/);
  });
});
