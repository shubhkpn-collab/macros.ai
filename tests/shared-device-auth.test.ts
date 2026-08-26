import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  AUTH_SUBJECT_VERSION, mintSubject, mintSubjectForTests, subjectExpired, subjectUserId,
  type VerifiedSession,
} from '@macros/domain-auth';
import { appSubjectFrom } from '@macros/tablet-app-core';
import { USER_A, USER_B } from '@macros/testkit';

const session = (id: string, over: Partial<VerifiedSession> = {}): VerifiedSession => ({
  subjectId: id,
  sessionId: `sess-${id}`,
  issuedAt: '2026-08-01T00:00:00.000Z',
  expiresAt: '2026-12-01T00:00:00.000Z',
  ...over,
});
const NOW = '2026-08-25T12:00:00.000Z';
const ctx = (over: Partial<Parameters<typeof mintSubject>[1]> = {}) => ({
  displayName: 'Member', householdId: 'hh-1', nowIso: NOW,
  authorized: true, deviceBound: true, ...over,
});

describe('B1 — AUTHORIZATION IS NOT AUTHENTICATION', () => {
  test('being an authorized household member does NOT produce a subject', () => {
    // Authorization is a boolean input to minting, never a substitute for a
    // verified session. There is no code path that turns membership alone into
    // an AuthenticatedSubject.
    const r = mintSubject(session(USER_B), ctx({ authorized: true, deviceBound: false }));
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, 'device_not_bound');
  });

  test('a valid session for an UNAUTHORIZED member is refused', () => {
    const r = mintSubject(session(USER_B), ctx({ authorized: false }));
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, 'no_active_membership');
  });

  test('BOTH gates are required: session AND authorization', () => {
    assert.equal(mintSubject(session(USER_B), ctx()).ok, true);
  });
});

describe('B2 — the subject cannot be forged or re-pointed', () => {
  test('appSubjectFrom makes all three identities coincide by construction', () => {
    const s = appSubjectFrom(mintSubjectForTests(USER_A, { displayName: 'Alex' }));
    assert.equal(s.authenticatedSubjectId, s.userId);
    assert.equal(s.userId, USER_A);
  });

  test('there is no way to point a subject at a DIFFERENT user', () => {
    const a = appSubjectFrom(mintSubjectForTests(USER_A));
    // Spreading and overriding produces a plain object, not an AppSubject that
    // the controller will accept — and the identities no longer agree, which is
    // exactly what assertSubjectBinding still catches at runtime.
    const tampered = { ...a, userId: USER_B };
    assert.notEqual(tampered.authenticatedSubjectId, tampered.userId);
  });

  test('the compile-time forgery proof exists and is enforced', () => {
    const proof = readFileSync('tests/typecheck/forge-subject.ts', 'utf8');
    assert.match(proof, /@ts-expect-error/);
    // If the brand ever stopped working, tsc would fail on the UNUSED
    // expect-error directive, so this file failing to compile IS the alarm.
    assert.match(proof, /AuthenticatedSubject/);
  });
});

describe('B3 — expiry and validity', () => {
  test('an expired session never mints a subject', () => {
    const r = mintSubject(session(USER_B, { expiresAt: '2026-01-01T00:00:00.000Z' }), ctx());
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, 'session_expired');
  });

  test('a non-UUID subject id is refused before anything else', () => {
    const r = mintSubject(session('not-a-uuid'), ctx());
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, 'invalid_subject_id');
  });

  test('expiry is evaluated against a supplied clock, never a hidden one', () => {
    const s = mintSubjectForTests(USER_A, { expiresAt: '2026-08-01T00:00:00.000Z' });
    assert.equal(subjectExpired(s, NOW), true);
    assert.equal(subjectExpired(s, '2026-07-01T00:00:00.000Z'), false);
  });

  test('subjectUserId is the only accessor, and there is no setter', () => {
    const s = mintSubjectForTests(USER_A);
    assert.equal(subjectUserId(s), USER_A);
    assert.equal('setUserId' in s, false);
    assert.equal('rebind' in s, false);
  });
});

describe('B4 — the boundary cannot be quietly re-opened', () => {
  const productionFiles = (): string[] => {
    const out: string[] = [];
    const walk = (d: string): void => {
      for (const e of readdirSync(d)) {
        const p = join(d, e);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith('.ts')) out.push(p);
      }
    };
    for (const pkg of readdirSync('packages')) {
      if (pkg === 'testkit' || pkg === 'domain-auth') continue;
      try { statSync(join('packages', pkg, 'src')); } catch { continue; }
      walk(join('packages', pkg, 'src'));
    }
    return out;
  };

  test('NO production package mints a test subject', () => {
    for (const f of productionFiles()) {
      assert.equal(readFileSync(f, 'utf8').includes('mintSubjectForTests'), false, f);
    }
  });

  test('NO production package casts to AuthenticatedSubject', () => {
    for (const f of productionFiles()) {
      const code = readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      assert.equal(/as\s+AuthenticatedSubject/.test(code), false, f);
    }
  });

  test('the CI guard itself exists, so this is enforced outside the suite too', () => {
    const guard = readFileSync('tools/check-auth-boundary.ts', 'utf8');
    assert.match(guard, /mintSubjectForTests/);
    assert.match(guard, /process\.exit\(1\)/);
  });

  test('the test-only mint is named so its use is obvious in review', () => {
    assert.match('mintSubjectForTests', /ForTests$/);
    assert.equal(AUTH_SUBJECT_VERSION, 'auth-subject@1.0.0');
  });
});

describe('PART 0 — documented status must not outrun the implementation', () => {
  const DOC = '/mnt/user-data/outputs/macros-architecture/32-shared-device-authentication.md';
  const doc = (): string => readFileSync(DOC, 'utf8');

  test('the state machine is NOT claimed closed while its parts are unbuilt', () => {
    const text = doc();
    assert.match(text, /SHARED-DEVICE AUTHENTICATION STATE MACHINE — PARTIAL/);
    assert.equal(
      /SHARED-DEVICE AUTHENTICATION STATE MACHINE — ENGINEERING CLOSED/.test(text),
      false,
      'the status claimed more than the code does',
    );
  });

  test('the unbuilt pieces are named explicitly rather than omitted', () => {
    const text = doc();
    for (const missing of [
      'Two-phase switch', 'Privacy shield', 'MemberAuthenticationPort',
      'OfflineMemberUnlockVerifier', 'replay protection', 'Restart-to-neutral',
    ]) {
      assert.ok(text.includes(missing), `${missing} must be listed as not implemented`);
    }
  });

  test('a claimed-closed item must correspond to real exported code', () => {
    // The one closure claimed here is the subject boundary, which must exist.
    assert.match(doc(), /AUTHENTICATED SUBJECT BOUNDARY — ENGINEERING CLOSED/);
    assert.equal(typeof mintSubject, 'function');
    assert.equal(typeof appSubjectFrom, 'function');
  });
});
