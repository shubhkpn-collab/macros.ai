/**
 * RENDERER PURITY GUARD.
 *
 * The renderer may not compute nutrition or energy. A component that can do
 * arithmetic can disagree with the food log, and the log is the truth — a
 * discrepancy there would be invisible until someone noticed their day did not
 * add up.
 *
 * Layout geometry (bar widths, clamping) is not nutrition and is allowed, but
 * only inside the view model where it is reviewable.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { REPO_ROOT } from './repo-paths.js';

/** Nutrition and energy identifiers that must never be operated on in the UI. */
const DOMAIN_QUANTITIES = [
  'kcal', 'Kcal', 'proteinG', 'carbohydrateG', 'fatG', 'grams', 'Grams',
  'balanceKcal', 'expenditure', 'basal', 'tef', 'Tef',
];

/** Domains a renderer must never reach into directly. */
const FORBIDDEN_IMPORTS = [
  '@macros/domain-nutrition', '@macros/domain-energy', '@macros/domain-macros',
  '@macros/core-loop', '@macros/persistence', '@macros/postgres-driver',
];

const SCAN_ROOTS = [join(REPO_ROOT, 'apps')];

/**
 * A HOST legitimately wires repositories and adapters — that is precisely its
 * job, and it lives outside the component tree for that reason. Components must
 * never do so. The arithmetic rule below still applies to these files: a host
 * may construct a repository, but it may not compute nutrition.
 */
const HOST_FILES = new Set([
  'apps/tablet/src/development-host.ts',
  'apps/tablet/src/composition.ts',
]);
const violations: string[] = [];

const check = (abs: string): void => {
  if (!['.ts', '.tsx'].includes(extname(abs))) return;
  const rel = relative(REPO_ROOT, abs).split('\\').join('/');
  const text = readFileSync(abs, 'utf8');
  const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  if (!HOST_FILES.has(rel)) {
    for (const banned of FORBIDDEN_IMPORTS) {
      if (code.includes(banned)) {
        violations.push(`${rel}: imports ${banned} — render the view model instead`);
      }
    }
  }

  code.split('\n').forEach((line, i) => {
    for (const q of DOMAIN_QUANTITIES) {
      // An arithmetic operator applied to a domain quantity.
      const arith = new RegExp(`\\b${q}\\b\\s*[*/+-]|[*/+-]\\s*\\b${q}\\b`);
      if (arith.test(line) && !/^\s*[*|/]/.test(line)) {
        violations.push(`${rel}:${i + 1}  arithmetic on ${q}: ${line.trim().slice(0, 70)}`);
      }
    }
  });
};

const walk = (dir: string): void => {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return; }
  for (const e of entries) {
    if (e === 'node_modules' || e === '.git' || e === 'build') continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p); else check(p);
  }
};

for (const root of SCAN_ROOTS) walk(root);

if (violations.length > 0) {
  console.error('Renderer purity violations:');
  for (const v of violations) console.error(`  ${v}`);
  console.error('\nNutrition and energy come from the view model, already computed.');
  process.exit(1);
}
console.log('Renderer purity: OK');
console.log('  no nutrition/energy arithmetic and no deep domain imports in apps/');
