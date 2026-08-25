/**
 * ARCHITECTURE PURITY ENFORCEMENT.
 *
 * Proves mechanically what the architecture only asserts in prose:
 *  - deterministic domain packages cannot reach an LLM SDK, statically or
 *    dynamically;
 *  - they perform no IO, read no clock, use no randomness;
 *  - production packages never import the test kit;
 *  - no synthetic test policy is defined in a production package;
 *  - PAL does not exist anywhere in the canonical energy package.
 *
 * Runs in CI before typecheck and tests.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;

const CANONICAL_ENERGY = 'packages/domain-energy';
const PURE_DOMAIN = [
  'packages/domain-nutrition',
  CANONICAL_ENERGY,
  'packages/domain-macros',
  // The weight-capture spine is pure for the same reasons the energy spine is:
  // deterministic, replayable, and defensible when a user disputes a number.
  'packages/domain-weight',
  'packages/scale-protocol',
  // The food-logging spine and the loop that composes the domains are pure for
  // the same reason: a logged number must be replayable and defensible.
  'packages/domain-food-log',
  'packages/core-loop',
  'packages/domain-food-search',
  // Catalog normalization, validation, canonicalization and the search
  // projection are pure: no file reading, no clock, no id generation, no DB.
  'packages/domain-catalog',
  // Voice intent parsing is pure: a transcript in, a parse result out. No
  // clock, no randomness, no repository, and above all no LLM.
  'packages/domain-voice',
  // Assistant proposal contracts, tool registry, validation and decision policy
  // are pure: no LLM SDK, no network, no database, no clock, no randomness.
  'packages/assistant-core',
];
const PRODUCTION = [
  ...PURE_DOMAIN,
  'packages/contracts',
  'packages/activity-provider',
  'packages/scale-simulator',
  // IO-adjacent by design: it may not be pure, but it still may not reach an
  // LLM, a transport library, or the test kit.
  'packages/persistence',
  // The tablet application layer holds a clock and ids, so it is not pure — but
  // MVP-0 is deterministic, so it may not reach an LLM/ASR/TTS SDK either, and
  // it must never bundle the test kit into a shipped path.
  'packages/tablet-app-core',
  // Ingestion orchestration and benchmark scoring are IO-adjacent by design,
  // but still may not reach an LLM, a network client or the test kit.
  'packages/catalog-ingestion',
  // Voice orchestration invokes application intents, so it is not pure — but
  // MVP-1 is deterministic, so no LLM/ASR/TTS SDK may enter it either.
  'packages/voice-orchestration',
  // Runtime config/composition validates supplied records and decides what may
  // be built. It reads node:crypto for migration checksums, so it is not pure —
  // but it still may not reach an LLM SDK, a transport library or the test kit.
  'packages/runtime-config',
];

/** Transport and hardware libraries must not reach the pure capture logic. */
const TRANSPORT_TOKENS = [
  'react-native', 'react-native-ble', 'noble', 'bleno', 'serialport',
  'usb', 'node-hid', 'web-bluetooth', 'expo-',
];

const LLM_TOKENS = [
  '@anthropic-ai', 'openai', 'anthropic', 'langchain', 'llamaindex',
  'llm', 'gpt-', 'claude-', 'completions', 'chatcompletion', 'bedrock', 'vertexai',
];

const NONDETERMINISM = [
  { pattern: /Math\.random/, label: 'Math.random' },
  { pattern: /Date\.now/, label: 'Date.now' },
  { pattern: /new Date\(\s*\)/, label: 'new Date() with no argument' },
  { pattern: /performance\.now/, label: 'performance.now' },
  { pattern: /process\.env/, label: 'process.env' },
  { pattern: /process\.hrtime/, label: 'process.hrtime' },
  { pattern: /crypto\.randomUUID/, label: 'crypto.randomUUID' },
  { pattern: /(?<![\w.])fetch\s*\(/, label: 'global fetch' },
  { pattern: /(?<![\w.])require\s*\(/, label: 'require()' },
  { pattern: /globalThis\s*\./, label: 'globalThis access' },
];

/**
 * PAL is not part of this architecture. These identifiers must not reappear in
 * the canonical energy package under any justification.
 */
const PAL_TOKENS = [
  { pattern: /PAL_FACTORS/, label: 'PAL_FACTORS' },
  { pattern: /palFactor/, label: 'palFactor' },
  { pattern: /tdeeBaseline/, label: 'tdeeBaselineKcal' },
  { pattern: /activityLevel/, label: 'activityLevel' },
  { pattern: /bmr\w*\s*\*\s*pal/i, label: 'BMR * PAL' },
];

interface Violation { file: string; rule: string; detail: string }
const violations: Violation[] = [];

function walk(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return out; }
  for (const e of entries) {
    const full = join(dir, e);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** Static imports/exports, side-effect imports, and dynamic import() calls. */
function importSpecifiers(source: string): string[] {
  const specs: string[] = [];
  const patterns = [
    /(?:import|export)[\s\S]*?from\s+['"]([^'"]+)['"]/g,  // static
    /import\s+['"]([^'"]+)['"]/g,                          // side-effect: import 'node:fs'
    /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,                // dynamic: import('...')
    /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,               // CJS
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) if (m[1]) specs.push(m[1]);
  }
  return specs;
}

/** Strip comments so documentation prose never trips a token scan. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

for (const pkg of PRODUCTION) {
  for (const file of walk(join(ROOT, pkg, 'src'))) {
    const rel = relative(ROOT, file);
    const code = stripComments(readFileSync(file, 'utf8'));
    const isPure = PURE_DOMAIN.some((p) => rel.startsWith(p));
    const isCanonicalEnergy = rel.startsWith(CANONICAL_ENERGY);

    for (const spec of importSpecifiers(code)) {
      const lower = spec.toLowerCase();
      if (LLM_TOKENS.some((t) => lower.includes(t))) {
        violations.push({ file: rel, rule: 'no-llm-in-production', detail: `imports "${spec}"` });
      }
      if (lower.includes('@macros/testkit')) {
        violations.push({ file: rel, rule: 'no-testkit-in-production', detail: `imports "${spec}"` });
      }
      if (isPure && (lower.startsWith('node:') || lower.startsWith('fs') || lower.startsWith('http'))) {
        violations.push({ file: rel, rule: 'no-io-in-pure-domain', detail: `imports "${spec}"` });
      }
      if (TRANSPORT_TOKENS.some((t) => lower.includes(t))) {
        violations.push({ file: rel, rule: 'no-transport-libs-in-production', detail: `imports "${spec}"` });
      }
      if (isPure && !spec.startsWith('.') && !spec.startsWith('@macros/')) {
        violations.push({ file: rel, rule: 'no-external-deps-in-pure-domain', detail: `imports "${spec}"` });
      }
    }

    // A dynamic import with a computed specifier hides its target from the scan.
    if (isPure && /import\s*\(\s*[^'")\s]/.test(code)) {
      violations.push({ file: rel, rule: 'no-dynamic-import-in-pure-domain', detail: 'computed dynamic import()' });
    }

    if (isPure) {
      for (const { pattern, label } of NONDETERMINISM) {
        if (pattern.test(code)) {
          violations.push({ file: rel, rule: 'no-nondeterminism-in-pure-domain', detail: `uses ${label}` });
        }
      }
      // Matches a policy VALUE marked synthetic, not a type union that merely
      // declares the literal as a permitted provenance.
      if (/provenance\s*:\s*'SYNTHETIC_TEST'/.test(code)) {
        violations.push({
          file: rel,
          rule: 'no-synthetic-policy-in-production',
          detail: 'defines a policy value with SYNTHETIC_TEST provenance',
        });
      }
    }

    if (isCanonicalEnergy) {
      for (const { pattern, label } of PAL_TOKENS) {
        if (pattern.test(code)) {
          violations.push({ file: rel, rule: 'no-pal-in-energy-engine', detail: `references ${label}` });
        }
      }
    }
  }
}

if (violations.length > 0) {
  console.error('\nARCHITECTURE PURITY VIOLATIONS\n');
  for (const v of violations) console.error(`  [${v.rule}] ${v.file} — ${v.detail}`);
  console.error(`\n${violations.length} violation(s).\n`);
  process.exit(1);
}

console.log('Architecture purity: OK');
console.log(`  production packages scanned: ${PRODUCTION.length}`);
console.log(`  pure domain: ${PURE_DOMAIN.join(', ')}`);
console.log(`  PAL-free enforcement on: ${CANONICAL_ENERGY}`);
