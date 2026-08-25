import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync, writeFileSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const PURE_DOMAIN = ['packages/domain-nutrition', 'packages/domain-energy', 'packages/domain-macros'];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const full = join(dir, e);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

const runPurityCheck = (): { code: number; output: string } => {
  try {
    const output = execFileSync('node', ['--import', 'tsx', 'tools/check-purity.ts'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, output };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, output: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
};

describe('architecture purity — the checker passes today', () => {
  test('no violations in the current tree', () => {
    const { code, output } = runPurityCheck();
    assert.equal(code, 0, output);
    assert.match(output, /Architecture purity: OK/);
  });
});

describe('architecture purity — the checker actually catches violations', () => {
  const probe = join(ROOT, 'packages/domain-energy/src', '__purity_probe__.ts');
  const cleanup = () => { try { rmSync(probe); } catch { /* already gone */ } };

  const expectViolation = (source: string, rule: RegExp, dir = 'packages/domain-energy/src') => {
    const target = join(ROOT, dir, '__purity_probe__.ts');
    writeFileSync(target, source, 'utf8');
    try {
      const { code, output } = runPurityCheck();
      assert.equal(code, 1, `expected a violation, got:\n${output}`);
      assert.match(output, rule);
    } finally {
      try { rmSync(target); } catch { /* already gone */ }
      cleanup();
    }
  };

  test('CRITICAL: an LLM SDK import in a domain package fails the build', () => {
    expectViolation(
      `import { Anthropic } from '@anthropic-ai/sdk';\nexport const x = Anthropic;\n`,
      /no-llm-in-production/,
    );
  });

  test('a testkit import in a production package fails the build', () => {
    expectViolation(
      `import { TEST_TEF_POLICY } from '@macros/testkit';\nexport const x = TEST_TEF_POLICY;\n`,
      /no-testkit-in-production/,
    );
  });

  test('filesystem access in a pure domain package fails the build', () => {
    expectViolation(
      `import { readFileSync } from 'node:fs';\nexport const x = readFileSync;\n`,
      /no-(io|node-builtins)-in-pure-domain/,
    );
  });

  test('reading a clock in a pure domain package fails the build', () => {
    expectViolation(`export const now = () => Date.now();\n`, /no-nondeterminism-in-pure-domain/);
  });

  test('randomness in a pure domain package fails the build', () => {
    expectViolation(`export const r = () => Math.random();\n`, /no-nondeterminism-in-pure-domain/);
  });

  test('CRITICAL: reintroducing PAL into the energy engine fails the build', () => {
    expectViolation(
      `export const PAL_FACTORS = { sedentary: 1.2 };\n`,
      /no-pal-in-energy-engine/,
    );
  });

  test('a palFactor field in the energy engine fails the build', () => {
    expectViolation(`export const m = { palFactor: 1.55 };\n`, /no-pal-in-energy-engine/);
  });

  test('a side-effect Node import in a pure domain package fails the build', () => {
    expectViolation(`import 'node:fs';\nexport const x = 1;\n`, /no-io-in-pure-domain/);
  });

  test('a dynamic LLM import in a pure domain package fails the build', () => {
    expectViolation(
      `export const load = async () => import('@anthropic-ai/sdk');\n`,
      /no-llm-in-production/,
    );
  });

  test('a computed dynamic import in a pure domain package fails the build', () => {
    expectViolation(
      `const name = 'x';\nexport const load = async () => import(name);\n`,
      /no-dynamic-import-in-pure-domain/,
    );
  });

  test('global fetch in a pure domain package fails the build', () => {
    expectViolation(`export const go = () => fetch('https://example.com');\n`, /no-nondeterminism-in-pure-domain/);
  });

  test('require() in a pure domain package fails the build', () => {
    expectViolation(`export const fs = require('fs');\n`, /no-(nondeterminism|io)-in-pure-domain/);
  });

  test('an external dependency in a pure domain package fails the build', () => {
    expectViolation(`import _ from 'lodash';\nexport const x = _;\n`, /no-external-deps-in-pure-domain/);
  });

  test('CRITICAL: a BLE library in the pure weight package fails the build', () => {
    expectViolation(
      `import { BleManager } from 'react-native-ble-plx';\nexport const x = BleManager;\n`,
      /no-(transport-libs-in-production|external-deps-in-pure-domain)/,
      'packages/domain-weight/src',
    );
  });

  test('React Native in the pure weight package fails the build', () => {
    expectViolation(
      `import { Platform } from 'react-native';\nexport const x = Platform;\n`,
      /no-(transport-libs-in-production|external-deps-in-pure-domain)/,
      'packages/domain-weight/src',
    );
  });

  test('a clock read in the weight-capture state machine fails the build', () => {
    expectViolation(
      `export const now = () => Date.now();\n`,
      /no-nondeterminism-in-pure-domain/,
      'packages/domain-weight/src',
    );
  });

  test('a synthetic stability policy shipping in the protocol package fails the build', () => {
    expectViolation(
      `export const p = { provenance: 'SYNTHETIC_TEST' as const };\n`,
      /no-synthetic-policy-in-production/,
      'packages/scale-protocol/src',
    );
  });

  test('CRITICAL: an LLM SDK in the tablet application layer fails the build', () => {
    expectViolation(
      `import OpenAI from 'openai';\nexport const x = OpenAI;\n`,
      /no-llm-in-production/,
      'packages/tablet-app-core/src',
    );
  });

  test('the test kit cannot be imported into the tablet application layer', () => {
    expectViolation(
      `import { USER_A } from '@macros/testkit';\nexport const x = USER_A;\n`,
      /no-testkit-in-production/,
      'packages/tablet-app-core/src',
    );
  });

  test('a synthetic test policy defined in a domain package fails the build', () => {
    expectViolation(
      `export const sneaky = { provenance: 'SYNTHETIC_TEST' as const };\n`,
      /no-synthetic-policy-in-production/,
    );
  });
});

describe('the deterministic engines are reachable only through pure code', () => {
  test('no domain source imports anything outside the workspace or its own package', () => {
    for (const pkg of PURE_DOMAIN) {
      for (const file of walk(join(ROOT, pkg, 'src'))) {
        const src = readFileSync(file, 'utf8');
        const re = /(?:import|export)[\s\S]*?from\s+['"]([^'"]+)['"]/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(src)) !== null) {
          const spec = m[1]!;
          const allowed = spec.startsWith('.') || spec.startsWith('@macros/');
          assert.ok(allowed, `${relative(ROOT, file)} imports disallowed "${spec}"`);
          assert.ok(!spec.includes('testkit'), `${relative(ROOT, file)} imports the test kit`);
        }
      }
    }
  });

  test('the testkit is never a runtime dependency of a production package', () => {
    for (const pkg of [...PURE_DOMAIN, 'packages/contracts', 'packages/activity-provider']) {
      const manifest = JSON.parse(readFileSync(join(ROOT, pkg, 'package.json'), 'utf8')) as {
        dependencies?: Record<string, string>;
      };
      const deps = Object.keys(manifest.dependencies ?? {});
      assert.ok(!deps.includes('@macros/testkit'), `${pkg} depends on the test kit`);
    }
  });
});

describe('profile de-duplication — one snapshot, one source', () => {
  test('EnergyModelSnapshot carries no duplicated physiological fields', () => {
    const src = readFileSync(join(ROOT, 'packages/contracts/src/energy.ts'), 'utf8');
    const block = src.slice(
      src.indexOf('export interface EnergyModelSnapshot'),
      src.indexOf('}', src.indexOf('export interface EnergyModelSnapshot')),
    );
    for (const field of ['sex', 'bodyWeightKg', 'heightCm', 'ageYears', 'bodyFatPercent']) {
      assert.ok(
        !new RegExp(`readonly ${field}\\s*:`).test(block),
        `EnergyModelSnapshot duplicates profile field "${field}" — it must be read from model.profile`,
      );
    }
    assert.match(block, /readonly profile:/, 'the model must bind the profile snapshot');
  });

  test('a model cannot claim one body weight for BMR and another for TEF', () => {
    const src = readFileSync(join(ROOT, 'packages/domain-energy/src/energy-state.ts'), 'utf8');
    assert.match(src, /deriveTefProfile\(input\.model\.profile\)/, 'TEF must read the model profile');
  });
});

describe('no self-approved scientific policy', () => {
  test('the BMR production policy is NOT marked externally approved', async () => {
    const { DEFAULT_BMR_POLICY } = (await import('@macros/domain-energy')) as {
      DEFAULT_BMR_POLICY: { reviewStatus: string; provenance: string };
    };
    assert.equal(
      DEFAULT_BMR_POLICY.reviewStatus,
      'PENDING_EXTERNAL_REVIEW',
      'selecting an equation is not the same as an external reviewer approving the product policy',
    );
  });

  test('it therefore does not pass the production policy firewall', async () => {
    const { DEFAULT_BMR_POLICY } = await import('@macros/domain-energy');
    const { assertProductionPolicy } = await import('@macros/contracts');
    const r = assertProductionPolicy(DEFAULT_BMR_POLICY);
    assert.equal(r.ok, false);
  });

  test('no shipped policy claims APPROVED review status', () => {
    const walkAll = (dir: string): string[] => {
      const out: string[] = [];
      for (const e of readdirSync(dir)) {
        const full = join(dir, e);
        if (statSync(full).isDirectory()) out.push(...walkAll(full));
        else if (full.endsWith('.ts')) out.push(full);
      }
      return out;
    };
    for (const pkg of ['packages/domain-energy', 'packages/domain-macros', 'packages/activity-provider']) {
      for (const file of walkAll(join(ROOT, pkg, 'src'))) {
        const src = readFileSync(file, 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/^\s*\/\/.*$/gm, '');
        assert.ok(
          !/reviewStatus:\s*'APPROVED'/.test(src),
          `${file} ships a self-approved policy — external review is required`,
        );
      }
    }
  });
});
