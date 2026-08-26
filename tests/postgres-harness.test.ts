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

describe('postgres harness — payload validity and transfer path', () => {
  const runner2 = readFileSync(repoPath('tools', 'postgres-validation', 'run.sh'), 'utf8');
  const hh = readFileSync(join(SQL_DIR, '30-household-privacy.sql'), 'utf8');
  const rls = readFileSync(join(SQL_DIR, '20-rls-matrix.sql'), 'utf8');
  const conflict = readFileSync(join(SQL_DIR, '60-idempotency-conflict.sql'), 'utf8');
  const household = readFileSync(join(MIG_DIR, '0005_households.sql'), 'utf8');

  const REQUIRED = ['gramsConsumed', 'productVersionId', 'kcal', 'proteinG',
                    'carbohydrateG', 'fatG'];

  test('race and replay payloads carry a COMPLETE snapshot', () => {
    // 0001 now requires these keys to be PRESENT. An incomplete payload would
    // fail on the CHECK before the uniqueness behaviour was ever exercised.
    for (const key of REQUIRED) {
      assert.ok(runner2.includes(key), `race/replay payload is missing ${key}`);
    }
    assert.equal(/'\{\\"totals\\":\{\\"kcal\\":\d+\}\}'/.test(runner2), false,
      'the truncated snapshot shape must not return');
  });

  test('the CONFLICTING payload is structurally valid too', () => {
    // It must be refused for identity, never for malformed JSON — otherwise the
    // conflict test proves nothing about idempotency.
    for (const key of REQUIRED) {
      assert.ok(conflict.includes(key), `conflict payload is missing ${key}`);
    }
    assert.ok(conflict.includes('777'), 'conflict payload differs from the original');
  });

  test('the forged-user RLS probe uses a VALID payload', () => {
    const probe = rls.slice(rls.indexOf('forged'), rls.indexOf('forged') + 1400);
    for (const key of REQUIRED) {
      assert.ok(probe.includes(key), `forged probe payload is missing ${key}`);
    }
    assert.equal(/'\{\}'::jsonb, '\{\}'::jsonb/.test(rls), false,
      'empty payloads let a CHECK failure masquerade as an RLS pass');
  });

  test('check_violation can NEVER count as authorization success', () => {
    assert.match(rls, /INVALID TEST forged-insert/,
      'a constraint failure must be reported as an invalid test, not a pass');
    assert.equal(/WHEN insufficient_privilege OR check_violation THEN\s*\n\s*RAISE NOTICE 'PASS forged/.test(rls),
      false, 'the conflated exception handler must not return');
  });

  test('ownership transfer has a dedicated ATOMIC database operation', () => {
    // Two ordinary UPDATEs cannot work: demote-first is required by the unique
    // index, but the admin policy denies the promote once the caller is demoted.
    assert.match(household, /CREATE OR REPLACE FUNCTION public\.transfer_household_ownership/);
    assert.match(household, /FOR UPDATE/, 'competing transfers must be serialized');
    assert.match(hh, /transfer_household_ownership\('hh-test'/,
      'the legitimate transfer test must use the real operation');
  });

  test('the transfer function derives the actor from auth.uid()', () => {
    const fn = household.slice(household.indexOf('transfer_household_ownership'));
    assert.match(fn, /v_actor uuid := auth\.uid\(\)/);
    // No "from user" argument: a caller cannot transfer someone else's household.
    assert.equal(/transfer_household_ownership\(\s*p_household_id\s+text,\s*p_target_user_id\s+uuid,/.test(household),
      false, 'the signature must not accept a caller-supplied actor');
    assert.match(fn, /SET search_path = public, pg_catalog/);
    assert.equal(/EXECUTE format\(|EXECUTE '/.test(fn.slice(0, 3000)), false, 'no dynamic SQL');
  });

  test('the transfer function is not executable by PUBLIC', () => {
    assert.match(household, /REVOKE ALL ON FUNCTION public\.transfer_household_ownership\(text, uuid\) FROM PUBLIC/);
    assert.match(household, /GRANT EXECUTE ON FUNCTION public\.transfer_household_ownership\(text, uuid\) TO authenticated/);
  });

  test('transfer is adversarially tested from every wrong angle', () => {
    for (const probe of ['transfer-nonowner', 'transfer-outsider', 'transfer-outside-target',
                         'transfer-self', 'transfer-removed-target', 'transfer-rollback']) {
      assert.ok(hh.includes(probe), `missing adversarial case: ${probe}`);
    }
  });

  test('household nutrition privacy remains untouched', () => {
    // The transfer function must not have become a route to private data.
    const fn = household.slice(household.indexOf('transfer_household_ownership'),
                               household.indexOf('REVOKE ALL ON FUNCTION public.transfer'));
    for (const table of ['food_logs', 'user_profile_versions', 'energy_goal_versions']) {
      assert.equal(fn.includes(table), false, `transfer must not touch ${table}`);
    }
    assert.match(household, /RETURNS void/, 'it returns no data at all');
  });
});

describe('postgres harness — expected-negative accounting', () => {
  const runner3 = readFileSync(repoPath('tools', 'postgres-validation', 'run.sh'), 'utf8');
  const helper = runner3.slice(runner3.indexOf('apply_migrations() {'),
                               runner3.indexOf('MIG_START='));

  test('apply_migrations does NOT touch the global failure counter', () => {
    // THE BUG, proven by the first real run: the helper both incremented
    // FAILURES and returned nonzero on checksum drift. The deliberate drift
    // probe then reported PASS while the counter stayed incremented, so the
    // setup gate aborted a run that had actually succeeded.
    assert.equal(helper.includes('FAILURES'), false,
      'only the caller can know whether a nonzero result is a defect');
  });

  test('the helper distinguishes REFUSAL from ERROR by status code', () => {
    assert.match(helper, /return 3/, 'checksum drift must be distinguishable');
    assert.match(helper, /return 1/, 'a genuine apply failure must differ');
  });

  test('deliberate drift counts as PASS and increments nothing', () => {
    const probe = runner3.slice(runner3.indexOf('CHECKSUM DRIFT REFUSAL'),
                                runner3.indexOf('SCHEMA INVARIANTS'));
    assert.match(probe, /DRIFT_STATUS=\$\?/, 'the caller must capture the status');
    assert.match(probe, /-eq 3 \]/, 'refusal is the expected outcome');
    assert.match(probe, /runner refused the altered migration history/);
    // Only ACCEPTING the drift may count as a failure.
    const acceptBranch = probe.slice(probe.indexOf('else'), probe.indexOf('# Restoration'));
    assert.match(acceptBranch, /drifted checksum was ACCEPTED/);
    assert.match(acceptBranch, /FAILURES/);
  });

  test('the checksum is restored AND asserted afterwards', () => {
    const probe = runner3.slice(runner3.indexOf('CHECKSUM DRIFT REFUSAL'),
                                runner3.indexOf('SCHEMA INVARIANTS'));
    assert.match(probe, /RESTORED=/, 'restoration must be read back');
    assert.match(probe, /\[ "\$RESTORED" = "\$REAL1" \]/,
      'restored ledger checksum must equal the file SHA-256');
    assert.match(probe, /checksum NOT restored[\s\S]{0,120}FAILURES/,
      'a failed restoration is a REAL failure');
    assert.match(probe, /ledger consistent after restoration/);
  });

  test('unexpected migration failure is still a real failure', () => {
    // The fix must not have blunted genuine error detection.
    const setup = runner3.slice(runner3.indexOf('MIG_START='),
                                runner3.indexOf('CHECKSUM DRIFT REFUSAL'));
    assert.match(setup, /if ! apply_migrations "run 1"; then[\s\S]{0,160}FAILURES/);
    assert.match(setup, /if ! apply_migrations "run 2"; then[\s\S]{0,160}FAILURES/);
  });

  test('an already-migrated database is a valid starting state', () => {
    // After the first real execution, applied=0 skipped=5 on BOTH runs.
    const setup = runner3.slice(runner3.indexOf('MIG_START='),
                                runner3.indexOf('CHECKSUM DRIFT REFUSAL'));
    assert.match(setup, /already-migrated database is a VALID/i);
    assert.equal(/DROP DATABASE|DROP SCHEMA|dropdb/.test(runner3), false,
      'the harness must never reset the owner database');
  });
});

describe('postgres harness — round-2 real-execution fixes', () => {
  const runner4 = readFileSync(repoPath('tools', 'postgres-validation', 'run.sh'), 'utf8');
  const integrity = readFileSync(join(SQL_DIR, '15-data-integrity.sql'), 'utf8');

  test('malformed NUMERIC text is an expected rejection, not an abort', () => {
    // The real run died here: "one hundred" fails the ->>::numeric cast with
    // invalid_text_representation (22P02), the handler caught only
    // check_violation, and psql aborted the whole file.
    assert.match(integrity, /invalid_text_representation/);
    assert.match(integrity, /numeric_value_out_of_range/);
    assert.match(integrity, /check_violation/);
  });

  test('one expected rejection cannot terminate the probe matrix', () => {
    // Every probe runs in its own BEGIN/EXCEPTION block inside a loop, and each
    // uses a distinct log_id so a survivor is attributable.
    assert.match(integrity, /FOR i IN 1 \.\. array_length\(cases, 1\) LOOP/);
    assert.match(integrity, /'integrity-probe-' \|\| i/);
    assert.ok(integrity.includes('rejected := rejected + 1'));
  });

  test('the full adversarial matrix is present', () => {
    for (const label of ['missing gramsConsumed', 'missing productVersionId', 'missing totals',
                         'missing kcal', 'missing proteinG', 'missing carbohydrateG',
                         'missing fatG', 'non-numeric gramsConsumed', 'wrong gramsConsumed value',
                         'wrong kcal value', 'totals is not an object']) {
      assert.ok(integrity.includes(label), `missing probe: ${label}`);
    }
    assert.match(integrity, /missing weight_capture\.grams|weight_capture\.grams must be present/);
  });

  test('WHEN OTHERS is never treated as a pass', () => {
    // A blanket handler would be another false green: an unrelated error proves
    // nothing about the constraints under test.
    for (const m of integrity.matchAll(/WHEN OTHERS THEN([\s\S]{0,240}?)(?=WHEN |END;)/g)) {
      const body = m[1]!;
      assert.ok(/INVALID TEST|invalid := invalid \+ 1/.test(body),
        'WHEN OTHERS must record a failure, never a pass');
      assert.equal(/RAISE NOTICE 'PASS/.test(body), false);
    }
  });

  test('malformed probe rows are asserted ABSENT afterwards', () => {
    assert.match(integrity, /FAIL probe-persistence/);
    assert.match(integrity, /log_id LIKE 'integrity-probe%'/);
  });

  test('the role check does not compare rendered booleans', () => {
    // The real server printed "false/false"; the harness expected "f/f" and
    // failed a role that was in fact correct.
    assert.equal(/"\$ROLEPROPS" = "f\/f"/.test(runner4), false,
      'presentation-string comparison must not return');
    assert.match(runner4, /NOT rolsuper AND NOT rolbypassrls/,
      'the database must assert the invariant itself');
    assert.match(runner4, /can bypass RLS/);
  });

  test('current_user cannot consume a separator or header line', () => {
    // `sed -n '3p'` on aligned output picked up the `-----` separator.
    assert.equal(/sed -n '3p'/.test(runner4), false, 'line-number parsing must not return');
    assert.match(runner4, /IF current_user <> 'macros_app' THEN/,
      'asserted in-database inside the SET ROLE session');
  });

  test('every shell-consumed gate value is machine-readable', () => {
    for (const m of runner4.matchAll(/^[A-Z_]+=\$\(psql[^)]*\)/gm)) {
      assert.ok(m[0].includes('-tA'),
        `gate value must use tuples-only output: ${m[0].slice(0, 70)}`);
    }
  });

  test('psql_app supports -tA for machine-readable reads', () => {
    assert.match(runner4, /-tA\)\s*tuples="-tA"/);
  });

  test('migrations were NOT touched this round', () => {
    // This run produced no evidence requiring a production-schema change.
    const core = readFileSync(join(MIG_DIR, '0001_core_schema.sql'), 'utf8');
    assert.match(core, /food_logs_snapshot_shape/, 'integrity constraints intact');
    assert.match(core, /FOREIGN KEY \(current_product_version_id, product_id\)/);
    const household2 = readFileSync(join(MIG_DIR, '0005_households.sql'), 'utf8');
    assert.match(household2, /transfer_household_ownership/);
    assert.match(household2, /is_active_household_member/);
  });
});

describe('postgres harness — deferred FK evaluation', () => {
  const negativeProbe = readFileSync(join(SQL_DIR, '16-head-ownership-negative.sql'), 'utf8');
  const core2 = readFileSync(join(MIG_DIR, '0001_core_schema.sql'), 'utf8');

  test('the probe FORCES the deferred constraint to evaluate', () => {
    // The FK is INITIALLY DEFERRED, so an invalid UPDATE does not raise at the
    // statement — the violation waits for commit. SET CONSTRAINTS ... IMMEDIATE
    // makes it surface at a point the runner controls.
    assert.match(negativeProbe, /SET CONSTRAINTS catalog_products_head_fk IMMEDIATE/);
    const updateIdx = negativeProbe.indexOf('UPDATE catalog_products');
    const forceIdx = negativeProbe.indexOf('SET CONSTRAINTS');
    assert.ok(updateIdx < forceIdx, 'the invalid UPDATE must precede the forced check');
  });

  test('the probe never commits, so the invalid state cannot persist', () => {
    assert.match(negativeProbe, /BEGIN;/);
    assert.equal(/^COMMIT;/m.test(negativeProbe), false, 'it must never commit');
  });

  test('the production FK stays DEFERRABLE INITIALLY DEFERRED', () => {
    // Deferral is required: catalog_products and product_versions reference
    // each other cyclically. Making it immediate to satisfy a test would break
    // legitimate population.
    assert.match(core2, /FOREIGN KEY \(current_product_version_id, product_id\)/);
    assert.match(core2, /REFERENCES product_versions \(product_version_id, product_id\)/);
    assert.match(core2, /DEFERRABLE INITIALLY DEFERRED/);
  });
});

describe('postgres harness — expected-negative at the process boundary', () => {
  const runner5 = readFileSync(repoPath('tools', 'postgres-validation', 'run.sh'), 'utf8');
  const negative = readFileSync(join(SQL_DIR, '16-head-ownership-negative.sql'), 'utf8');
  const integrity3 = readFileSync(join(SQL_DIR, '15-data-integrity.sql'), 'utf8');
  const core3 = readFileSync(join(MIG_DIR, '0001_core_schema.sql'), 'utf8');

  test('the head-ownership probe runs in its OWN psql process', () => {
    // A deferred FK violation necessarily reaches psql as an error. Inside a
    // shared file that fails the entire step; at the process boundary the
    // runner can classify exit status and SQLSTATE instead.
    assert.match(runner5, /expect_fk_violation "head ownership" "\$SQL\/16-head-ownership-negative\.sql"/);
    assert.equal(/FINDING 2|head-ownership/.test(integrity3.replace(/^--.*$/gm, '')), false,
      'the negative probe must no longer live in 15-data-integrity.sql');
  });

  test('exit 0 is a FAILURE — acceptance means the FK did not reject', () => {
    const helper = runner5.slice(runner5.indexOf('expect_fk_violation() {'),
                                 runner5.indexOf('say "MACROS.AI'));
    assert.match(helper, /if \[ "\$status" -eq 0 \]/);
    assert.match(helper, /was ACCEPTED \(exit 0\)/);
    const zeroBranch = helper.slice(helper.indexOf('-eq 0 ]'), helper.indexOf('if grep -q'));
    assert.match(zeroBranch, /FAILURES=\$\(\(FAILURES \+ 1\)\)/);
  });

  test('23503 on catalog_products_head_fk is the PASS', () => {
    assert.match(runner5, /"23503" "catalog_products_head_fk"/);
    const helper = runner5.slice(runner5.indexOf('expect_fk_violation() {'),
                                 runner5.indexOf('say "MACROS.AI'));
    assert.match(helper, /SQLSTATE \$want_state/);
    assert.match(helper, /\$want_constraint/);
    assert.match(helper, /VERBOSITY=verbose/, 'SQLSTATE must be available in the output');
  });

  test('an unrelated SQL error is a FAILURE, not a pass', () => {
    const helper = runner5.slice(runner5.indexOf('expect_fk_violation() {'),
                                 runner5.indexOf('say "MACROS.AI'));
    assert.match(helper, /failed for an UNRELATED reason/);
    const elseBranch = helper.slice(helper.lastIndexOf('else'));
    assert.match(elseBranch, /FAILURES=\$\(\(FAILURES \+ 1\)\)/);
    // Never a blanket pass on any nonzero exit.
    assert.equal(/status" -ne 0 \][\s\S]{0,80}\[OK\]/.test(helper), false);
  });

  test('the original product head is asserted afterwards', () => {
    assert.match(runner5, /HEAD2=\$\(psql_owner -tAc/);
    assert.match(runner5, /\[ "\$HEAD2" = "prod-test-2@v1" \]/);
    assert.match(runner5, /head not preserved/);
    // The probe never commits, so the rollback is what preserves it.
    assert.match(negative, /BEGIN;/);
    assert.match(negative, /SET CONSTRAINTS catalog_products_head_fk IMMEDIATE/);
  });

  test('the fixtures create prod-test-2 for the probe', () => {
    const fixtures = readFileSync(join(SQL_DIR, '10-fixtures.sql'), 'utf8');
    assert.match(fixtures, /'prod-test-2'/);
    assert.match(fixtures, /'prod-test-2@v1'/);
  });

  test('migrations remain untouched and the FK stays deferred', () => {
    assert.match(core3, /FOREIGN KEY \(current_product_version_id, product_id\)/);
    assert.match(core3, /DEFERRABLE INITIALLY DEFERRED/);
    assert.match(core3, /food_logs_snapshot_shape/);
  });
});
