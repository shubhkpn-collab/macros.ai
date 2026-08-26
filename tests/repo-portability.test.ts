import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import {
  DOCS_ARCHITECTURE, REPO_ROOT, architectureDoc, docsOutputDir, repoPath, sourceFile,
} from '../tools/repo-paths.js';

describe('repository filesystem portability', () => {
  test('paths resolve from the module location, not the working directory', () => {
    // A test invoked from a different cwd must still find the repository.
    assert.equal(isAbsolute(REPO_ROOT), true);
    assert.equal(existsSync(repoPath('package.json')), true);
    assert.equal(existsSync(repoPath('db', 'migrations')), true);
  });

  test('canonical architecture docs live IN the repository', () => {
    assert.ok(DOCS_ARCHITECTURE.startsWith(REPO_ROOT));
    for (const doc of [
      '27-generic-catalog-semantic-integrity-and-search.md',
      '32-shared-device-authentication.md',
    ]) {
      assert.equal(existsSync(architectureDoc(doc)), true, `${doc} must be tracked`);
    }
  });

  test('every default resolves BENEATH the checkout, wherever that is', () => {
    // The real invariant. A directory blocklist is the wrong test twice over:
    // a macOS checkout legitimately sits under /Users, and this sandbox's
    // checkout legitimately sits under /home/claude. What matters is that
    // nothing defaults to a location OUTSIDE the repository.
    for (const p of [DOCS_ARCHITECTURE, docsOutputDir(), sourceFile('x.json')]) {
      assert.ok(p.startsWith(REPO_ROOT), `${p} must resolve beneath ${REPO_ROOT}`);
    }
  });

  test('no default points at an external artifact directory', () => {
    // /mnt/user-data/outputs was never part of any checkout — that specific
    // escape is what broke the Mac clone.
    for (const p of [DOCS_ARCHITECTURE, docsOutputDir()]) {
      assert.equal(p.includes('/mnt/user-data'), false, `${p} escapes the repository`);
    }
  });

  test('a runtime-resolved macOS path under /Users is VALID', () => {
    // The invariant is that paths derive from the checkout, not that they avoid
    // any particular directory name. On macOS the answer starts with /Users.
    assert.equal(isAbsolute(REPO_ROOT), true);
    assert.equal(existsSync(repoPath('package.json')), true);
    assert.ok(DOCS_ARCHITECTURE.startsWith(REPO_ROOT), 'docs resolve beneath the checkout');
    assert.ok(sourceFile('x.json').startsWith(REPO_ROOT) || process.env['MACROS_SOURCE_DIR'],
      'sources default beneath the checkout unless explicitly overridden');
  });

  test('the STATIC guard still rejects a hard-coded machine literal', () => {
    // Runtime resolution vs source literal is the whole distinction:
    //   VALID   → repoRoot resolving to /Users/someone/macros-local
    //   INVALID → const ROOT = '/Users/someone/macros-local'
    const guard = readFileSync(repoPath('tools', 'check-portability.ts'), 'utf8');
    assert.ok(/Users/.test(guard), 'the static guard must still screen /Users literals');
    assert.ok(guard.includes('user-data'), 'and the sandbox roots');
    // ...and it inspects SOURCE TEXT, never a resolved runtime value.
    assert.ok(guard.includes('readFileSync'));
  });

  test('generated docs default to the repository with NO env var set', () => {
    const saved = process.env['MACROS_DOCS_OUT'];
    delete process.env['MACROS_DOCS_OUT'];
    try {
      assert.equal(docsOutputDir(), DOCS_ARCHITECTURE);
    } finally {
      if (saved !== undefined) process.env['MACROS_DOCS_OUT'] = saved;
    }
  });

  test('the export override is honoured but never required', () => {
    const saved = process.env['MACROS_DOCS_OUT'];
    process.env['MACROS_DOCS_OUT'] = '/tmp/export-target';
    try {
      assert.equal(docsOutputDir(), '/tmp/export-target');
    } finally {
      if (saved === undefined) delete process.env['MACROS_DOCS_OUT'];
      else process.env['MACROS_DOCS_OUT'] = saved;
    }
  });

  test('the portability guard is wired into npm verify', () => {
    const pkg = JSON.parse(readFileSync(repoPath('package.json'), 'utf8'));
    assert.match(pkg.scripts.verify, /check:portability/);
    assert.ok(existsSync(repoPath('tools', 'check-portability.ts')));
  });
});

describe('toolchain reproducibility', () => {
  const pkg = JSON.parse(readFileSync(repoPath('package.json'), 'utf8'));
  const tsconfig = JSON.parse(readFileSync(repoPath('tsconfig.json'), 'utf8'));

  test('tooling versions are DECLARED, not left to whatever npm serves', () => {
    // Scripts invoked tsc and tsx with no devDependencies, so a fresh clone
    // installed "latest" and got a compiler that had removed baseUrl.
    for (const dep of ['typescript', 'tsx', '@types/node']) {
      assert.ok(pkg.devDependencies?.[dep], `${dep} must be declared`);
      assert.match(pkg.devDependencies[dep], /^\d+\.\d+\.\d+$/,
        `${dep} must be pinned exactly, not floated`);
    }
  });

  test('a supported Node generation is declared', () => {
    assert.ok(pkg.engines?.node, 'engines.node must be declared');
    assert.equal(existsSync(repoPath('.nvmrc')), true);
  });

  test('tsconfig does NOT use the removed baseUrl option', () => {
    // TS5102 on newer compilers. Its escape hatch, ignoreDeprecations, is gone
    // too — the config now uses the modern form that works on both generations.
    assert.equal('baseUrl' in tsconfig.compilerOptions, false);
    assert.equal('ignoreDeprecations' in tsconfig.compilerOptions, false);
  });

  test('every path mapping is relative, as required without baseUrl', () => {
    const paths = tsconfig.compilerOptions.paths as Record<string, string[]>;
    assert.ok(Object.keys(paths).length >= 25);
    for (const [alias, targets] of Object.entries(paths)) {
      assert.match(targets[0]!, /^\.\//, `${alias} must be relative (TS5090 otherwise)`);
      assert.equal(existsSync(repoPath(targets[0]!)), true, `${alias} must resolve`);
    }
  });

  test('the toolchain guard runs as part of verify', () => {
    assert.match(pkg.scripts.verify, /check:toolchain/);
    assert.ok(existsSync(repoPath('tools', 'check-toolchain.ts')));
  });
});
