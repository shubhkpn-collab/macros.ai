import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { repoPath } from '../tools/repo-paths.js';

const SQL_DIR = repoPath('tools', 'postgres-validation', 'sql');
const MIG_DIR = repoPath('db', 'migrations');
const runner = readFileSync(repoPath('tools', 'postgres-validation', 'run.sh'), 'utf8');

const harnessSql = (): string =>
  readdirSync(SQL_DIR).map((f) => readFileSync(join(SQL_DIR, f), 'utf8')).join('\n');
const migrations = (): string =>
  readdirSync(MIG_DIR).map((f) => readFileSync(join(MIG_DIR, f), 'utf8')).join('\n');

describe('postgres harness — static self-checks', () => {
  test('auth prerequisite installs BEFORE migrations', () => {
    // 0002 references auth.uid() and the authenticated role, so installing the
    // shim afterwards means 0002 cannot execute at all.
    const prereq = runner.indexOf('00-prereq.sql');
    const migrate = runner.indexOf('apply_migrations "run 1"');
    assert.ok(prereq > 0, 'the prerequisite must be installed');
    assert.ok(migrate > 0);
    assert.ok(prereq < migrate, 'prerequisite must come before migrations');
  });

  test('migration DDL and the ledger insert are ONE transaction', () => {
    // Two psql invocations are two transactions: a crash between them leaves
    // schema applied and ledger empty.
    const atomic = /BEGIN;[\s\S]{0,400}INSERT INTO schema_migrations[\s\S]{0,200}COMMIT;/.test(runner);
    assert.ok(atomic, 'DDL + ledger must be piped into a single psql transaction');
    assert.equal(
      /psql_owner -1 -f "\$file"[\s\S]{0,200}psql_owner -q -c "INSERT INTO schema_migrations/.test(runner),
      false, 'the two-process non-atomic pattern must not return',
    );
  });

  test('migrations contain NO embedded BEGIN/COMMIT', () => {
    // One layer owns transactions. Embedded ones would nest with the runner's.
    for (const f of readdirSync(MIG_DIR)) {
      const sql = readFileSync(join(MIG_DIR, f), 'utf8');
      assert.equal(/^BEGIN;/m.test(sql), false, `${f} must not open its own transaction`);
      assert.equal(/^COMMIT;/m.test(sql), false, `${f} must not commit`);
    }
  });

  test('the harness never grants broad table permissions', () => {
    // Granting here would mask a broken production grant and make the whole
    // permission model untested.
    // Strip comments: the harness EXPLAINS why it does not grant, and the
    // explanation must not itself trip the check.
    const sql = harnessSql().replace(/^\s*--.*$/gm, '');
    assert.equal(/GRANT[^;]*ON ALL TABLES IN SCHEMA public/i.test(sql), false,
      'business-table permissions must come from the migrations alone');
  });

  test('validation SQL uses no stale/removed column names', () => {
    const sql = harnessSql();
    // Each of these was a real mismatch against the actual schema.
    for (const [stale, real] of [
      ['current_version_id', 'current_product_version_id'],
      ['birth_year', 'age_years'],
      ['voided_at', 'recorded_at'],
    ] as const) {
      assert.equal(new RegExp(`\\b${stale}\\b`).test(sql), false,
        `${stale} was removed in favour of ${real}`);
    }
    // food_log_voids targets voids_log_id, not log_id.
    assert.equal(/food_log_voids[\s\S]{0,200}\blog_id\b(?!\s*=)/.test(sql), false);
  });

  test('every column referenced in fixtures exists in the migrations', () => {
    const mig = migrations();
    const fixtures = readFileSync(join(SQL_DIR, '10-fixtures.sql'), 'utf8');
    for (const m of fixtures.matchAll(/INSERT INTO (\w+)\s*\(([^)]+)\)/g)) {
      const table = m[1]!;
      assert.ok(new RegExp(`CREATE TABLE (IF NOT EXISTS )?${table}\\b`).test(mig),
        `fixtures reference unknown table ${table}`);
      for (const col of m[2]!.split(',').map((c) => c.trim()).filter(Boolean)) {
        assert.ok(new RegExp(`\\b${col}\\b`).test(mig),
          `${table}.${col} does not exist in any migration`);
      }
    }
  });

  test('household policies do NOT self-query household_memberships', () => {
    // That is the RLS recursion: a policy on a table querying the same table.
    const h = readFileSync(join(MIG_DIR, '0005_households.sql'), 'utf8');
    const policies = h.split('CREATE POLICY').slice(1);
    for (const p of policies) {
      const body = p.split(';')[0]!;
      assert.equal(/EXISTS\s*\(\s*SELECT[^)]*FROM\s+household_memberships/i.test(body), false,
        'policies must use the SECURITY DEFINER helper, not a self-query');
    }
    assert.match(h, /is_active_household_member/);
    assert.match(h, /is_active_household_owner/);
  });

  test('the membership helpers are safely constrained', () => {
    const h = readFileSync(join(MIG_DIR, '0005_households.sql'), 'utf8');
    assert.match(h, /SECURITY DEFINER/);
    assert.match(h, /SET search_path = public, pg_catalog/, 'locked search_path');
    assert.match(h, /REVOKE ALL ON FUNCTION public\.is_active_household_member/);
    // No userId argument: the subject comes from auth.uid() internally, so the
    // helper cannot be used to probe another user.
    assert.equal(/is_active_household_(member|owner)\(p_household_id text, p_user/.test(h), false);
    assert.equal(/EXECUTE format\(|EXECUTE '/.test(h), false, 'no dynamic SQL');
  });

  test('food_logs asserts JSON PRESENCE, not just equality', () => {
    // A CHECK yields UNKNOWN for an absent key, and UNKNOWN is accepted — so a
    // missing authoritative fact passed while a wrong value failed.
    const core = readFileSync(join(MIG_DIR, '0001_core_schema.sql'), 'utf8');
    assert.match(core, /food_logs_snapshot_shape/);
    for (const key of ['gramsConsumed', 'productVersionId', 'totals', 'kcal', 'proteinG',
                       'carbohydrateG', 'fatG']) {
      assert.ok(core.includes(`'${key}'`), `presence of ${key} must be asserted`);
    }
    assert.match(core, /jsonb_typeof/);
    assert.match(core, /food_logs_capture_shape/);
  });

  test('a catalog head can only point at its OWN product version', () => {
    const core = readFileSync(join(MIG_DIR, '0001_core_schema.sql'), 'utf8');
    assert.match(core, /FOREIGN KEY \(current_product_version_id, product_id\)/,
      'composite FK required; a bare version reference allows cross-product heads');
    assert.match(core, /REFERENCES product_versions \(product_version_id, product_id\)/);
  });

  test('constraint tests establish auth context first', () => {
    // Otherwise RLS denies before the constraint applies and an RLS rejection
    // masquerades as a constraint proof.
    const hh = readFileSync(join(SQL_DIR, '30-household-privacy.sql'), 'utf8');
    const idx = hh.indexOf('two-owners');
    assert.ok(idx > 0);
    assert.ok(hh.lastIndexOf('set_test_uid', idx) > 0, 'identity must be set before the attempt');
    assert.match(hh, /INCONCLUSIVE two-owners/, 'RLS denial must be distinguished');
  });

  test('assertions run as the non-privileged role via SET ROLE', () => {
    // A separate TCP login would depend on the owner's pg_hba.conf.
    assert.match(runner, /SET ROLE macros_app/);
    assert.equal(/PGUSER=macros_app/.test(runner), false,
      'must not depend on local login configuration');
    assert.match(runner, /rolsuper/, 'privilege must be asserted');
  });

  test('the safety guard refuses any database but macros_dev', () => {
    assert.match(runner, /macros_dev/);
    for (const bad of ['postgres', 'template0', 'template1', 'production', 'prod']) {
      assert.ok(runner.includes(bad), `${bad} must be explicitly refused`);
    }
    assert.equal(/DROP DATABASE|DROP SCHEMA/.test(runner + harnessSql()), false,
      'no unguarded destructive statement anywhere');
  });

  test('scope language does not overclaim what SQL alone proves', () => {
    assert.match(runner, /DATABASE uniqueness only/);
    assert.match(runner, /outbox settlement are NOT validated/);
  });
});
