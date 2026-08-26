/**
 * OFFLINE CAPABILITY CONTRACT.
 *
 * A single `isOffline` boolean is useless to a person standing at a kitchen
 * scale: they need to know that weighing and logging still work, that search is
 * answering from a catalog frozen at a known release, and that voice is not
 * coming back until the network does. Each capability therefore carries its own
 * status and a machine-readable reason.
 */
export const OFFLINE_CAPABILITY_VERSION = 'offline-capabilities@1.0.0';

export type CapabilityStatus = 'available' | 'degraded' | 'unavailable';

export type CapabilityReason =
  | 'ok'
  | 'catalog_ready'
  | 'catalog_stale'
  | 'catalog_missing'
  | 'backend_unavailable'
  | 'voice_cloud_unavailable'
  | 'local_storage_unavailable'
  | 'auth_expired'
  | 'sync_pending';

export interface Capability {
  readonly status: CapabilityStatus;
  readonly reason: CapabilityReason;
}

export interface OfflineCapabilities {
  readonly catalogSearch: Capability;
  readonly barcodeLookup: Capability;
  readonly productVersionLookup: Capability;
  readonly foodLogging: Capability;
  readonly dashboard: Capability;
  readonly voice: Capability;
  readonly wearableRefresh: Capability;
  readonly accountMutation: Capability;
  readonly pendingSubmissions: number;
}

export interface RuntimeConditions {
  readonly backendReachable: boolean;
  readonly catalogInstalled: boolean;
  /** True when the installed bundle is older than the freshness policy allows. */
  readonly catalogStale: boolean;
  readonly localStorageWritable: boolean;
  readonly authValid: boolean;
  /** Cloud interpreter/STT. There is no on-device ASR yet. */
  readonly cloudVoiceReachable: boolean;
  readonly pendingSubmissions: number;
}

const cap = (status: CapabilityStatus, reason: CapabilityReason): Capability => ({ status, reason });

/**
 * Derive capabilities. PURE — no clock, no IO.
 *
 * The governing rule: weighing and logging must keep working without a backend,
 * because the appliance's whole purpose is being usable at the moment food is
 * on the scale. Everything genuinely cloud-dependent is reported unavailable
 * rather than allowed to hang.
 */
export function deriveCapabilities(c: RuntimeConditions): OfflineCapabilities {
  const catalogReason: CapabilityReason = !c.catalogInstalled
    ? 'catalog_missing'
    : c.catalogStale ? 'catalog_stale' : 'catalog_ready';
  const catalogStatus: CapabilityStatus = !c.catalogInstalled
    ? 'unavailable'
    : c.catalogStale ? 'degraded' : 'available';

  // Logging needs BOTH an authoritative product and somewhere durable to put
  // the result. Without durable storage a "successful" log would be a lie.
  const canLog = c.catalogInstalled && c.localStorageWritable;
  const loggingReason: CapabilityReason = !c.localStorageWritable
    ? 'local_storage_unavailable'
    : !c.catalogInstalled ? 'catalog_missing'
    : c.backendReachable ? 'ok' : 'sync_pending';

  return {
    catalogSearch: cap(catalogStatus, catalogReason),
    barcodeLookup: cap(catalogStatus, catalogReason),
    productVersionLookup: cap(catalogStatus, catalogReason),
    foodLogging: cap(canLog ? (c.backendReachable ? 'available' : 'degraded') : 'unavailable',
                     loggingReason),
    // The dashboard is computed from stored snapshots, so it works offline —
    // it simply reflects local truth until sync completes.
    dashboard: cap(canLog ? 'available' : 'unavailable',
                   c.backendReachable ? 'ok' : 'sync_pending'),
    // No on-device ASR exists. Saying so beats hanging on a cloud call.
    voice: cap(c.cloudVoiceReachable ? 'available' : 'unavailable',
               c.cloudVoiceReachable ? 'ok' : 'voice_cloud_unavailable'),
    wearableRefresh: cap(c.backendReachable ? 'available' : 'unavailable',
                         c.backendReachable ? 'ok' : 'backend_unavailable'),
    accountMutation: cap(
      c.backendReachable && c.authValid ? 'available' : 'unavailable',
      !c.backendReachable ? 'backend_unavailable' : c.authValid ? 'ok' : 'auth_expired'),
    pendingSubmissions: c.pendingSubmissions,
  };
}
