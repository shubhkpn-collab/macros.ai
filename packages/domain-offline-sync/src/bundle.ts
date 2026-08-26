/**
 * OFFLINE CATALOG BUNDLE VERIFICATION AND ACTIVATION.
 *
 * PURE decision logic: given a manifest and observed shard digests, decide
 * whether a bundle may become active. Actual file movement lives in an adapter.
 *
 * Corrupt nutrition is a correctness failure, not an inconvenience, so a bundle
 * is activated only when EVERY shard verifies. There is no partial activation
 * and no "mostly fine" state.
 */
export const OFFLINE_BUNDLE_POLICY = 'offline-bundle-policy@1.0.0';

/** The manifest schema this build understands. */
export const SUPPORTED_SCHEMA_VERSION = 1;

export interface ShardDescriptor {
  readonly file: string;
  readonly records: number;
  readonly bytes: number;
  readonly sha256: string;
}

export interface OfflineCatalogManifest {
  readonly bundleVersion: string;
  readonly requiredSchemaVersion: number;
  readonly buildComplete: boolean;
  readonly generatedFromCatalogDigests: Readonly<Record<string, unknown>>;
  readonly policyVersions: Readonly<Record<string, string>>;
  readonly counts: Readonly<Record<string, number>>;
  readonly shards: readonly ShardDescriptor[];
  readonly totalBytes: number;
}

export type BundleRejection =
  | 'build_incomplete'
  | 'unsupported_schema_version'
  | 'shard_missing'
  | 'shard_hash_mismatch'
  | 'shard_unexpected'
  | 'empty_manifest';

export type BundleVerification =
  | { readonly ok: true; readonly manifest: OfflineCatalogManifest }
  | { readonly ok: false; readonly reason: BundleRejection; readonly detail?: string };

/** What the adapter actually observed on disk: file → digest. */
export type ObservedShards = ReadonlyMap<string, string>;

export function verifyBundle(
  manifest: OfflineCatalogManifest,
  observed: ObservedShards,
): BundleVerification {
  // A partially written bundle must never activate — this is the marker a
  // crashed or interrupted build leaves behind.
  if (manifest.buildComplete !== true) {
    return { ok: false, reason: 'build_incomplete' };
  }
  // An older app must refuse a newer bundle rather than half-interpret it.
  if (manifest.requiredSchemaVersion > SUPPORTED_SCHEMA_VERSION) {
    return {
      ok: false, reason: 'unsupported_schema_version',
      detail: `bundle requires ${manifest.requiredSchemaVersion}, app supports ${SUPPORTED_SCHEMA_VERSION}`,
    };
  }
  if (manifest.shards.length === 0) return { ok: false, reason: 'empty_manifest' };

  for (const shard of manifest.shards) {
    const digest = observed.get(shard.file);
    if (digest === undefined) {
      return { ok: false, reason: 'shard_missing', detail: shard.file };
    }
    if (digest !== shard.sha256) {
      return { ok: false, reason: 'shard_hash_mismatch', detail: shard.file };
    }
  }
  // A stray shard means mixed-version artifacts — old and new interleaved is
  // exactly the state atomic activation exists to prevent.
  for (const file of observed.keys()) {
    if (!manifest.shards.some((s) => s.file === file)) {
      return { ok: false, reason: 'shard_unexpected', detail: file };
    }
  }
  return { ok: true, manifest };
}

export type ActivationOutcome =
  | { readonly kind: 'activated'; readonly active: OfflineCatalogManifest }
  | {
      readonly kind: 'rejected_kept_previous';
      readonly reason: BundleRejection;
      readonly detail?: string;
      /** Null only when there was no previous bundle to fall back to. */
      readonly active: OfflineCatalogManifest | null;
    };

/**
 * Decide activation, always preserving last-known-good.
 *
 * A failed update must never leave the appliance worse off than before it
 * started: the previously active bundle stays active, untouched.
 */
export function decideActivation(
  candidate: OfflineCatalogManifest,
  observed: ObservedShards,
  currentlyActive: OfflineCatalogManifest | null,
): ActivationOutcome {
  const verified = verifyBundle(candidate, observed);
  if (verified.ok) return { kind: 'activated', active: verified.manifest };
  return {
    kind: 'rejected_kept_previous',
    reason: verified.reason,
    ...(verified.detail !== undefined ? { detail: verified.detail } : {}),
    active: currentlyActive,
  };
}

/**
 * Catalog staleness and miss semantics.
 *
 * "Not in the cached catalog" is a different statement from "this product does
 * not exist" — the first is about our copy, the second about reality, and only
 * a check-digit failure is definitive about the barcode itself.
 */
export type OfflineLookupMiss =
  | 'not_found_in_cached_catalog'
  | 'invalid_identifier'
  | 'catalog_missing';

export interface CatalogFreshness {
  readonly bundleVersion: string;
  readonly generatedFrom: Readonly<Record<string, unknown>>;
  readonly stale: boolean;
}
