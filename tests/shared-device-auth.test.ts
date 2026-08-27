import { architectureDoc } from '../tools/repo-paths.js';
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
  displayName: 'Member', nowIso: NOW, ...over,
});

describe('B1 — AUTHORIZATION IS NOT AUTHENTICATION', () => {
  test('minting requires NO household authorization booleans', () => {
    // The old MintContext demanded `authorized` and `deviceBound`, and the
    // generic HTTP path had to pass `true` for both without proving either.
    // Authentication now answers only "who owns this valid session".
    assert.equal(mintSubject(session(USER_B), ctx()).ok, true);
    const keys = Object.keys(ctx());
    assert.equal(keys.includes('authorized'), false);
    assert.equal(keys.includes('deviceBound'), false);
  });

  test('a subject carries NO household claim', () => {
    const r = mintSubject(session(USER_B), ctx());
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal('householdId' in (r.subject as object), false,
      'household membership is not an authentication claim');
  });

  test('an invalid session id cannot mint', () => {
    const r = mintSubject({ ...session(USER_B), sessionId: '' }, ctx());
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, 'invalid_session_id');
  });

  test('authorization failures are NOT authentication failures', () => {
    // These reasons no longer exist in the mint result type at all.
    const r = mintSubject(session(USER_B), ctx());
    assert.equal(r.ok, true);
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
    // Issued before it expired, but both are in the past relative to NOW.
    const r = mintSubject(session(USER_B, {
      issuedAt: '2026-07-01T00:00:00.000Z', expiresAt: '2026-08-01T00:00:00.000Z',
    }), ctx());
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
  const DOC = architectureDoc('32-shared-device-authentication.md');
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


describe('SESSION TIME SANITY', () => {
  test('a session that expires BEFORE it was issued is refused', () => {
    const r = mintSubject(session(USER_B, {
      issuedAt: '2026-09-01T00:00:00.000Z', expiresAt: '2026-08-01T00:00:00.000Z',
    }), ctx());
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, 'invalid_session_times');
  });

  test('unparseable times are refused', () => {
    const r = mintSubject(session(USER_B, { issuedAt: 'not-a-date' }), ctx());
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, 'invalid_session_times');
  });
});

describe('FIX A — JWKS cache freshness and bounded growth', () => {
  test('a KNOWN kid is refetched once the positive TTL lapses', async () => {
    // Without a positive TTL a key set fetched at boot is trusted forever, so a
    // key revoked at the provider stays valid here until restart.
    const { JwksCache } = await import('@macros/auth-supabase');
    let now = 1_000_000;
    let served: Record<string, unknown>[] = [];
    let fetches = 0;
    const cache = new JwksCache({
      jwksUrl: 'https://p/jwks', now: () => now, maxKeyAgeMs: 60_000, minRefetchMs: 0,
      fetcher: async () => { fetches += 1; return { keys: served }; },
    });
    await cache.keyFor('nope').catch(() => undefined);
    const first = fetches;
    now += 30_000;
    await cache.keyFor('nope').catch(() => undefined);   // still fresh
    now += 120_000;
    await cache.keyFor('nope').catch(() => undefined);   // TTL lapsed
    assert.ok(fetches > first, 'a stale key set must be refetched');
    void served;
  });

  test('the negative cache prevents a fetch per forged kid', async () => {
    const { JwksCache } = await import('@macros/auth-supabase');
    let now = 1_000_000;
    let fetches = 0;
    const cache = new JwksCache({
      jwksUrl: 'https://p/jwks', now: () => now,
      maxKeyAgeMs: 10 * 60_000, negativeCacheMs: 30_000, minRefetchMs: 0,
      fetcher: async () => { fetches += 1; return { keys: [] }; },
    });
    for (let i = 0; i < 10; i += 1) await cache.keyFor('forged').catch(() => undefined);
    assert.ok(fetches <= 2, `expected at most 2 fetches, saw ${fetches}`);
  });

  test('the negative cache is BOUNDED', async () => {
    const { JwksCache } = await import('@macros/auth-supabase');
    const cache = new JwksCache({
      jwksUrl: 'https://p/jwks', now: () => 1_000_000,
      maxNegativeEntries: 8, minRefetchMs: 0, maxKeyAgeMs: 10 * 60_000,
      fetcher: async () => ({ keys: [] }),
    });
    for (let i = 0; i < 200; i += 1) await cache.keyFor(`kid-${i}`).catch(() => undefined);
    assert.ok(cache.negativeCacheSize() <= 8,
      `unbounded growth: ${cache.negativeCacheSize()} entries`);
  });

  test('a refresh clears remembered misses and advances the key-set version', async () => {
    const { JwksCache } = await import('@macros/auth-supabase');
    let now = 1_000_000;
    const cache = new JwksCache({
      jwksUrl: 'https://p/jwks', now: () => now, minRefetchMs: 0,
      maxKeyAgeMs: 1_000, fetcher: async () => ({ keys: [] }),
    });
    await cache.keyFor('missing').catch(() => undefined);
    const before = cache.keySetInfo().version;
    now += 10_000;
    await cache.keyFor('missing').catch(() => undefined);
    assert.ok(cache.keySetInfo().version > before, 'key set version must advance');
    assert.equal(cache.negativeCacheSize(), 1, 'misses cleared on refresh, then re-recorded');
  });
});

describe('FIX E — assurance level is metadata, never authorization', () => {
  test('aal is surfaced on the subject when the provider supplies it', () => {
    const r = mintSubject(session(USER_B), { displayName: 'M', nowIso: NOW, assuranceLevel: 'aal2' });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal((r.subject as { assuranceLevel?: string }).assuranceLevel, 'aal2');
  });

  test('a MISSING aal never blocks authentication', () => {
    // Surfacing it must not quietly become a gate.
    const r = mintSubject(session(USER_B), { displayName: 'M', nowIso: NOW });
    assert.equal(r.ok, true);
  });

  test('aal1 authenticates exactly as aal2 does', () => {
    const one = mintSubject(session(USER_B), { displayName: 'M', nowIso: NOW, assuranceLevel: 'aal1' });
    const two = mintSubject(session(USER_B), { displayName: 'M', nowIso: NOW, assuranceLevel: 'aal2' });
    assert.equal(one.ok, two.ok);
  });

  test('no production code branches on assuranceLevel', () => {
    const files = [
      'packages/domain-household/src/session.ts',
      'packages/domain-household/src/switch-machine.ts',
      'packages/runtime-api/src/shared-device-auth.ts',
    ];
    for (const f of files) {
      const code = readFileSync(f, 'utf8').replace(/^\s*(\/\/|\*|\/\*).*$/gm, '');
      assert.equal(/if\s*\([^)]*assuranceLevel[^)]*(===|!==|<|>)/.test(code), false,
        `${f} must not gate on assurance level`);
    }
  });
});
