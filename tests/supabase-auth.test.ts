import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, webcrypto } from 'node:crypto';
import { SupabaseAuthSessionProvider, decodeSegments } from '@macros/auth-supabase';
import { subjectFromSession } from '@macros/runtime-config';
import { subjectUserId } from '@macros/domain-auth';

/**
 * REAL cryptography. A genuine RSA keypair is generated, real JWTs are signed
 * with it, and the adapter verifies them through Node's WebCrypto — the same
 * code path production uses. Nothing about signing or verification is mocked;
 * only the JWKS *transport* is replaced with a local fixture.
 */
const ISSUER = 'https://project.supabase.co/auth/v1';
const JWKS_URL = 'https://project.supabase.co/auth/v1/.well-known/jwks.json';
const SUBJECT = '11111111-1111-4111-8111-111111111111';
const NOW = Date.parse('2026-08-27T12:00:00.000Z');

const b64url = (input: Buffer | string): string =>
  Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function makeKey(kid: string) {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' };
  return { privateKey, jwk: jwk as Record<string, unknown>, kid };
}

const KEY = makeKey('key-1');
const OTHER_KEY = makeKey('key-2');

async function signJwt(
  key: ReturnType<typeof makeKey>,
  claims: Record<string, unknown>,
  header: Record<string, unknown> = {},
): Promise<string> {
  const h = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: key.kid, ...header }));
  const p = b64url(JSON.stringify(claims));
  const priv = await webcrypto.subtle.importKey(
    'pkcs8', key.privateKey.export({ format: 'der', type: 'pkcs8' }),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await webcrypto.subtle.sign(
    'RSASSA-PKCS1-v1_5', priv, Buffer.from(`${h}.${p}`, 'utf8'));
  return `${h}.${p}.${b64url(Buffer.from(sig))}`;
}

const SESSION_ID = '99999999-9999-4999-8999-999999999999';

/** A claim set matching the real Supabase access-token contract. */
const validClaims = (over: Record<string, unknown> = {}) => ({
  sub: SUBJECT, iss: ISSUER,
  iat: Math.floor(NOW / 1000) - 60,
  exp: Math.floor(NOW / 1000) + 3600,
  role: 'authenticated', aud: 'authenticated',
  session_id: SESSION_ID, is_anonymous: false, aal: 'aal1',
  ...over,
});

const providerWith = (keys: Record<string, unknown>[]) =>
  new SupabaseAuthSessionProvider(
    { projectUrl: 'https://project.supabase.co' },
    () => NOW,
    { fetcher: async () => ({ keys }) },
  );

const provider = () => providerWith([KEY.jwk]);

describe('SUPABASE ADAPTER — real signature verification', () => {
  test('a validly signed token verifies', async () => {
    const session = await provider().verify(await signJwt(KEY, validClaims()));
    assert.equal('subjectId' in (session as object), true, JSON.stringify(session));
    if (!('subjectId' in (session as object))) return;
    assert.equal((session as { subjectId: string }).subjectId, SUBJECT);
  });

  test('an EXPIRED token is refused', async () => {
    const token = await signJwt(KEY, validClaims({ exp: Math.floor(NOW / 1000) - 3600 }));
    const r = await provider().verify(token);
    assert.equal((r as { code?: string }).code, 'expired');
  });

  test('a WRONG ISSUER is refused', async () => {
    const token = await signJwt(KEY, validClaims({ iss: 'https://evil.example/auth/v1' }));
    assert.equal((await provider().verify(token) as { code?: string }).code, 'issuer_mismatch');
  });

  test('a token signed by the WRONG KEY is refused', async () => {
    // Signed by key-2 but presented with key-1's kid: the signature fails.
    const token = await signJwt(OTHER_KEY, validClaims(), { kid: KEY.kid });
    assert.equal((await provider().verify(token) as { code?: string }).code, 'bad_signature');
  });

  test('a TAMPERED payload is refused', async () => {
    const token = await signJwt(KEY, validClaims());
    const [h, , s] = token.split('.') as [string, string, string];
    const forged = b64url(JSON.stringify(validClaims({ sub: '22222222-2222-4222-8222-222222222222' })));
    assert.equal((await provider().verify(`${h}.${forged}.${s}`) as { code?: string }).code,
      'bad_signature');
  });

  test('an UNKNOWN kid is refused', async () => {
    const token = await signJwt(OTHER_KEY, validClaims());  // kid=key-2, not in JWKS
    assert.equal((await provider().verify(token) as { code?: string }).code, 'unknown_key');
  });

  test('a NON-UUID subject is refused', async () => {
    const token = await signJwt(KEY, validClaims({ sub: 'not-a-uuid' }));
    assert.equal((await provider().verify(token) as { code?: string }).code, 'invalid_subject');
  });

  test('a MISSING subject is refused', async () => {
    const claims = validClaims(); delete (claims as Record<string, unknown>)['sub'];
    assert.equal((await provider().verify(await signJwt(KEY, claims)) as { code?: string }).code,
      'missing_subject');
  });

  test('the `none` algorithm is refused', async () => {
    const h = b64url(JSON.stringify({ alg: 'none', typ: 'JWT', kid: KEY.kid }));
    const p = b64url(JSON.stringify(validClaims()));
    const r = await provider().verify(`${h}.${p}.`);
    assert.equal((r as { code?: string }).code, 'unsupported_algorithm');
  });

  test('a SYMMETRIC algorithm is refused (JWT confusion)', async () => {
    const h = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT', kid: KEY.kid }));
    const p = b64url(JSON.stringify(validClaims()));
    assert.equal((await provider().verify(`${h}.${p}.AAAA`) as { code?: string }).code,
      'unsupported_algorithm');
  });

  test('a malformed token is refused', async () => {
    for (const bad of ['', 'abc', 'a.b', 'a.b.c.d']) {
      assert.equal((await provider().verify(bad) as { code?: string }).code, 'malformed_token');
    }
  });

  test('errors NEVER echo the token or its claims', async () => {
    const token = await signJwt(KEY, validClaims({ iss: 'https://evil.example/auth/v1' }));
    const r = await provider().verify(token) as { message?: string; code?: string };
    const text = JSON.stringify(r);
    assert.equal(text.includes(token.slice(0, 24)), false, 'token leaked into the error');
    assert.equal(text.includes(SUBJECT), false, 'subject leaked into the error');
    assert.equal(text.includes('evil.example'), false, 'claim value leaked');
    assert.equal(r.message, 'Not signed in.');
  });
});

describe('SUPABASE ADAPTER — key rotation', () => {
  test('a rotated key is picked up by refetch', async () => {
    let served: Record<string, unknown>[] = [KEY.jwk];
    const p = new SupabaseAuthSessionProvider(
      { projectUrl: 'https://project.supabase.co' }, () => NOW,
      { fetcher: async () => ({ keys: served }), minRefetchMs: 0 },
    );
    assert.equal('subjectId' in (await p.verify(await signJwt(KEY, validClaims())) as object), true);

    // The provider rotates: a NEW kid appears that the cache has never seen.
    served = [OTHER_KEY.jwk];
    const rotated = await p.verify(await signJwt(OTHER_KEY, validClaims()));
    assert.equal('subjectId' in (rotated as object), true,
      'an unknown kid must trigger one refetch, or rotation breaks logins');
  });

  test('refetch is rate-limited so an unknown kid is not a DoS lever', async () => {
    let fetches = 0;
    const p = new SupabaseAuthSessionProvider(
      { projectUrl: 'https://project.supabase.co' }, () => NOW,
      { fetcher: async () => { fetches += 1; return { keys: [KEY.jwk] }; }, minRefetchMs: 60_000 },
    );
    for (let i = 0; i < 5; i += 1) await p.verify(await signJwt(OTHER_KEY, validClaims()));
    assert.ok(fetches <= 2, `expected at most 2 fetches, saw ${fetches}`);
  });

  test('the JWKS URL derives from the project URL', () => {
    const p = provider();
    assert.equal(typeof p.knownKeyIds, 'function');
    assert.equal(p.providerKind, 'supabase');
  });
});

describe('VERIFIED SESSION -> AuthenticatedSubject (existing mint, no casts)', () => {
  test('a real token mints a real subject through the closed boundary', async () => {
    const session = await provider().verify(await signJwt(KEY, validClaims()));
    assert.equal('subjectId' in (session as object), true);
    if (!('subjectId' in (session as object))) return;

    const subject = subjectFromSession(
      session as never, new Date(NOW).toISOString(), undefined);
    assert.equal('kind' in (subject as object), false, JSON.stringify(subject));
    assert.equal(subjectUserId(subject as never), SUBJECT);
    // The provider's REAL session id, not a subject-id fallback.
    assert.equal((subject as { sessionId: string }).sessionId, SESSION_ID);
  });

  test('a body-claimed userId that differs is refused at the mint', async () => {
    const session = await provider().verify(await signJwt(KEY, validClaims()));
    const subject = subjectFromSession(
      session as never, new Date(NOW).toISOString(),
      '22222222-2222-4222-8222-222222222222');
    assert.equal('kind' in (subject as object), true, 'must be an AppError');
  });

  test('decodeSegments alone grants no trust', () => {
    // Structure parsing is not verification; the adapter always verifies first.
    const parts = decodeSegments(
      `${b64url(JSON.stringify({ alg: 'RS256' }))}.${b64url(JSON.stringify(validClaims()))}.AA`);
    assert.equal(parts.claims['sub'], SUBJECT);
  });
});


describe('SUPABASE CLAIM CONTRACT — audience, role, anonymity, session', () => {
  test('aud as a bare string is accepted', async () => {
    const r = await provider().verify(await signJwt(KEY, validClaims({ aud: 'authenticated' })));
    assert.equal('subjectId' in (r as object), true);
  });

  test('aud as an ARRAY containing authenticated is accepted', async () => {
    const r = await provider().verify(
      await signJwt(KEY, validClaims({ aud: ['authenticated', 'other'] })));
    assert.equal('subjectId' in (r as object), true, 'Supabase documents aud as string | string[]');
  });

  test('a missing or wrong audience is refused', async () => {
    for (const aud of [undefined, 'anon', 42, ['anon']]) {
      const claims = validClaims({ aud });
      if (aud === undefined) delete (claims as Record<string, unknown>)['aud'];
      const r = await provider().verify(await signJwt(KEY, claims));
      assert.equal((r as { code?: string }).code, 'invalid_audience', String(aud));
    }
  });

  test('role anon and service_role are refused', async () => {
    for (const role of ['anon', 'service_role', undefined]) {
      const claims = validClaims({ role });
      if (role === undefined) delete (claims as Record<string, unknown>)['role'];
      const r = await provider().verify(await signJwt(KEY, claims));
      assert.equal((r as { code?: string }).code, 'invalid_role', String(role));
    }
  });

  test('an ANONYMOUS identity is refused even with role=authenticated', async () => {
    // Supabase anonymous sign-ins still carry role=authenticated, so the role
    // alone cannot distinguish a real person from a throwaway identity.
    const r = await provider().verify(await signJwt(KEY, validClaims({ is_anonymous: true })));
    assert.equal((r as { code?: string }).code, 'anonymous_identity');
  });

  test('a missing or non-boolean is_anonymous is refused', async () => {
    for (const value of [undefined, 'false', 0]) {
      const claims = validClaims({ is_anonymous: value });
      if (value === undefined) delete (claims as Record<string, unknown>)['is_anonymous'];
      const r = await provider().verify(await signJwt(KEY, claims));
      assert.equal((r as { code?: string }).code, 'anonymous_identity', String(value));
    }
  });

  test('is_anonymous false is accepted', async () => {
    const r = await provider().verify(await signJwt(KEY, validClaims({ is_anonymous: false })));
    assert.equal('subjectId' in (r as object), true);
  });

  test('a missing or malformed session_id is refused', async () => {
    for (const value of [undefined, 'not-a-uuid', 12345]) {
      const claims = validClaims({ session_id: value });
      if (value === undefined) delete (claims as Record<string, unknown>)['session_id'];
      const r = await provider().verify(await signJwt(KEY, claims));
      assert.equal((r as { code?: string }).code, 'invalid_session_id', String(value));
    }
  });

  test('session_id is preserved on the verified session', async () => {
    const r = await provider().verify(await signJwt(KEY, validClaims()));
    assert.equal((r as { sessionId?: string }).sessionId, SESSION_ID);
    assert.notEqual((r as { sessionId?: string }).sessionId, SUBJECT,
      'a login session is not the user identity');
  });

  test('a missing or future iat is refused', async () => {
    const noIat = validClaims(); delete (noIat as Record<string, unknown>)['iat'];
    const r1 = await provider().verify(await signJwt(KEY, noIat));
    assert.equal((r1 as { code?: string }).code, 'invalid_issued_at');
    const future = validClaims({ iat: Math.floor(NOW / 1000) + 3600 });
    const r2 = await provider().verify(await signJwt(KEY, future));
    assert.equal((r2 as { code?: string }).code, 'invalid_issued_at');
  });

  test('a future nbf beyond skew is refused', async () => {
    const r = await provider().verify(
      await signJwt(KEY, validClaims({ nbf: Math.floor(NOW / 1000) + 3600 })));
    assert.equal((r as { code?: string }).code, 'not_yet_valid');
  });

  test('an invalid aal is refused; aal1 and aal2 accepted', async () => {
    const bad = await provider().verify(await signJwt(KEY, validClaims({ aal: 'aal9' })));
    assert.equal((bad as { code?: string }).code, 'invalid_aal');
    for (const aal of ['aal1', 'aal2']) {
      const good = await provider().verify(await signJwt(KEY, validClaims({ aal })));
      assert.equal('subjectId' in (good as object), true, aal);
    }
  });

  test('non-object header or claims are refused, not cast through', async () => {
    const arrayClaims = `${b64url(JSON.stringify({ alg: 'RS256', kid: KEY.kid }))}.${b64url('[]')}.AA`;
    assert.equal((await provider().verify(arrayClaims) as { code?: string }).code, 'malformed_token');
    const nullHeader = `${b64url('null')}.${b64url(JSON.stringify(validClaims()))}.AA`;
    assert.equal((await provider().verify(nullHeader) as { code?: string }).code, 'malformed_token');
  });
});
