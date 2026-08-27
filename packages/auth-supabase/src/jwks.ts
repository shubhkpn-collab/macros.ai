import { importJwk, isSupportedAlg, JwtVerificationError, type SupportedAlg } from './jwt.js';

/**
 * JWKS CACHE WITH ROTATION TOLERANCE.
 *
 * Providers rotate signing keys routinely, so pinning one key would break
 * authentication at an unpredictable moment. Keys are cached by `kid`; an
 * unknown `kid` triggers ONE refetch (rate-limited) before the token is
 * refused, which is what makes a rotation invisible to users.
 *
 * Only PUBLIC verification material is ever fetched or held here.
 */
export interface JwksFetcher {
  (url: string): Promise<{ keys: readonly Record<string, unknown>[] }>;
}

export interface JwksCacheOptions {
  readonly jwksUrl: string;
  readonly fetcher?: JwksFetcher;
  /** Minimum gap between refetches, so an unknown kid cannot be a DoS lever. */
  readonly minRefetchMs?: number;
  /**
   * POSITIVE TTL. Without one, a key set fetched at boot is trusted forever:
   * a key REVOKED at the provider stays valid here until the process restarts,
   * because a known kid never triggers a refetch.
   */
  readonly maxKeyAgeMs?: number;
  /**
   * NEGATIVE TTL. An unknown kid is remembered as unknown for this long, so a
   * burst of forged kids cannot each pay for a network round trip.
   */
  readonly negativeCacheMs?: number;
  /** Upper bound on remembered unknown kids — the cache must not grow freely. */
  readonly maxNegativeEntries?: number;
  readonly now?: () => number;
}

/** Monotonic counter identifying a fetched key set, for diagnostics. */
export interface KeySetInfo {
  readonly version: number;
  readonly fetchedAtMs: number;
  readonly keyIds: readonly string[];
}

const defaultFetcher: JwksFetcher = async (url) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`JWKS fetch failed with status ${res.status}`);
  return (await res.json()) as { keys: readonly Record<string, unknown>[] };
};

export class JwksCache {
  private keys = new Map<string, { key: CryptoKey; alg: SupportedAlg }>();
  private lastFetch = 0;
  private version = 0;
  /** kid -> time it was observed missing. Bounded; see `rememberUnknown`. */
  private readonly unknown = new Map<string, number>();
  private inFlight: Promise<void> | null = null;

  constructor(private readonly options: JwksCacheOptions) {}

  private get now(): number {
    return (this.options.now ?? Date.now)();
  }

  private async refresh(): Promise<void> {
    // Collapse concurrent misses into a single fetch.
    if (this.inFlight !== null) return this.inFlight;
    const fetcher = this.options.fetcher ?? defaultFetcher;
    this.inFlight = (async () => {
      const jwks = await fetcher(this.options.jwksUrl);
      const next = new Map<string, { key: CryptoKey; alg: SupportedAlg }>();
      for (const jwk of jwks.keys ?? []) {
        const kid = jwk['kid'];
        const alg = jwk['alg'];
        if (typeof kid !== 'string' || typeof alg !== 'string' || !isSupportedAlg(alg)) continue;
        try {
          next.set(kid, { key: await importJwk(jwk, alg), alg });
        } catch {
          // A single unusable key must not poison the whole key set.
          continue;
        }
      }
      this.keys = next;
      this.lastFetch = this.now;
      this.version += 1;
      // A fresh key set makes every remembered miss obsolete: a kid absent from
      // the OLD set may be present now.
      this.unknown.clear();
    })();
    try { await this.inFlight; } finally { this.inFlight = null; }
  }

  private rememberUnknown(kid: string): void {
    const cap = this.options.maxNegativeEntries ?? 256;
    if (this.unknown.size >= cap) {
      // Evict the oldest insertion. Forged kids are unbounded in principle, so
      // the cache must be too — bounded, that is.
      const oldest = this.unknown.keys().next();
      if (!oldest.done) this.unknown.delete(oldest.value);
    }
    this.unknown.set(kid, this.now);
  }

  private get stale(): boolean {
    // Keyed on WHETHER we have fetched, not on how many keys came back. Using
    // `keys.size === 0` meant a provider returning an empty or unusable set was
    // refetched on every single request.
    if (this.lastFetch === 0) return true;
    const maxAge = this.options.maxKeyAgeMs ?? 10 * 60_000;
    return this.now - this.lastFetch >= maxAge;
  }

  /**
   * Resolve a `kid`.
   *
   * A cached hit is used only while the key set is FRESH. Past the positive TTL
   * the set is refetched even for a known kid, so a key revoked at the provider
   * stops working here within one TTL rather than at the next restart.
   */
  async keyFor(kid: string | undefined): Promise<{ key: CryptoKey; alg: SupportedAlg }> {
    if (typeof kid !== 'string' || kid.length === 0) {
      throw new JwtVerificationError('unknown_key', 'token header carries no key id');
    }

    if (this.stale) {
      const minGap = this.options.minRefetchMs ?? 60_000;
      if (this.lastFetch === 0 || this.now - this.lastFetch >= minGap) {
        await this.refresh();
      }
    }

    const hit = this.keys.get(kid);
    if (hit !== undefined) return hit;

    // Negative cache: a kid recently proven absent is refused without a fetch.
    const missedAt = this.unknown.get(kid);
    const negativeTtl = this.options.negativeCacheMs ?? 30_000;
    if (missedAt !== undefined && this.now - missedAt < negativeTtl) {
      throw new JwtVerificationError('unknown_key', 'no signing key matches the token key id');
    }

    // Rotation: one refetch for a genuinely unknown kid, rate-limited.
    const minGap = this.options.minRefetchMs ?? 60_000;
    if (!this.stale && this.now - this.lastFetch >= minGap) {
      await this.refresh();
      const afterRefresh = this.keys.get(kid);
      if (afterRefresh !== undefined) return afterRefresh;
    }

    this.rememberUnknown(kid);
    throw new JwtVerificationError('unknown_key', 'no signing key matches the token key id');
  }

  /** Diagnostics only. Never returns key material. */
  keySetInfo(): KeySetInfo {
    return {
      version: this.version,
      fetchedAtMs: this.lastFetch,
      keyIds: [...this.keys.keys()].sort(),
    };
  }

  /** Bounded-growth check for tests. */
  negativeCacheSize(): number { return this.unknown.size; }

  /** Test/diagnostic only. Never exposes key material. */
  knownKeyIds(): readonly string[] { return [...this.keys.keys()].sort(); }
}
