/**
 * DEGRADED RUNTIME STATES AND OFFLINE TIERS.
 *
 * Declared explicitly so the appliance states what still works instead of
 * silently substituting worse data. The governing rule: never present a number
 * that is not backed by the same authority as when everything is healthy. A
 * blank figure is recoverable; a wrong one is not.
 */

export type CapabilityTier = 'online_full' | 'offline_cached' | 'offline_unavailable';

export interface CapabilityState {
  readonly capability: string;
  readonly tier: CapabilityTier;
  readonly behaviour: string;
}

/**
 * MVP capability matrix. Anything not implemented is listed as unavailable
 * rather than promised — an appliance that claims an offline capability it does
 * not have will lose a user's meal.
 */
export const CAPABILITY_MATRIX: readonly CapabilityState[] = [
  { capability: 'scale_weighing', tier: 'online_full', behaviour: 'Local to the device; unaffected by backend loss.' },
  { capability: 'voice_deterministic', tier: 'online_full', behaviour: 'Parser is local and offline by design.' },
  { capability: 'dashboard_last_known', tier: 'offline_cached', behaviour: 'Shows the last computed day, explicitly marked stale. Never recomputed from partial data.' },
  { capability: 'food_search', tier: 'offline_unavailable', behaviour: 'NOT cached in this milestone. Returns a dependency_unavailable refusal.' },
  { capability: 'food_log_write', tier: 'offline_unavailable', behaviour: 'NOT queued in this milestone. Refused with a clear message; local pending capture is a dedicated future domain.' },
  { capability: 'assistant_fallback', tier: 'offline_unavailable', behaviour: 'Requires a provider. Deterministic commands continue to work.' },
  { capability: 'stt_tts', tier: 'offline_unavailable', behaviour: 'Not integrated. Text transcripts only.' },
  { capability: 'activity', tier: 'offline_unavailable', behaviour: 'Expenditure reports unavailable rather than assuming zero. MISSING is never ZERO.' },
];

export type DependencyState = 'ready' | 'degraded' | 'unavailable';

export interface RuntimeHealth {
  readonly processAlive: boolean;
  readonly configValid: boolean;
  readonly databaseReachable: DependencyState;
  readonly migrationsApplied: boolean;
  readonly ready: boolean;
}

/**
 * Readiness is deliberately strict: a process that started but whose config is
 * invalid or whose migrations did not apply is NOT ready. Reporting healthy in
 * that state is how a partially functional deployment takes traffic.
 */
export function computeHealth(input: Omit<RuntimeHealth, 'ready' | 'processAlive'>): RuntimeHealth {
  const ready =
    input.configValid && input.migrationsApplied && input.databaseReachable === 'ready';
  return { processAlive: true, ...input, ready };
}
