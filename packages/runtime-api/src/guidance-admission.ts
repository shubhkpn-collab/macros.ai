/**
 * GUIDANCE ADMISSION — cost protection for a paid provider.
 *
 * An authenticated client can call the endpoint directly, so the bound must sit
 * at the boundary itself, keyed by the verified subject and checked BEFORE the
 * provider is reached: a refused request has to cost nothing.
 *
 * This is a narrow ASYNC port. The route depends on the interface and contains
 * no SQL; the durable implementation lives with the other PostgreSQL adapters.
 */
export const ADMISSION_VERSION = 'guidance-admission@2.0.0';

export interface AdmissionPolicy {
  /**
   * Admitted provider calls permitted per window.
   *
   * There is deliberately no `maxInFlightPerSubject`. The durable schema holds
   * ONE lease per subject, so any value above 1 would be a knob the
   * implementation silently ignored — and a policy field that lies is worse
   * than a missing one. MACROS wants exactly one paid call per subject at a
   * time; multi-slot leases are not a goal.
   */
  readonly maxRequestsPerWindow: number;
  readonly windowMs: number;
  /**
   * How long a lease survives without release. This is what makes a crashed
   * instance recoverable — without it, one dead process locks a subject out
   * permanently.
   */
  readonly leaseTtlMs: number;
  /**
   * IN-MEMORY ONLY. Bounds map growth in a long-lived process.
   *
   * The durable table has no equivalent sweep and needs none: it holds one
   * bounded row per authenticated subject — the same cardinality as the user
   * table — of a few fixed-width columns. A cleanup job would add moving parts
   * to solve a problem that does not exist.
   */
  readonly inMemoryEntryTtlMs: number;
}

export const DEFAULT_ADMISSION_POLICY: AdmissionPolicy = {
  maxRequestsPerWindow: 20,
  windowMs: 60_000,
  leaseTtlMs: 30_000,
  inMemoryEntryTtlMs: 300_000,
};

export type AdmissionRefusal = 'in_flight' | 'quota_exceeded';

export interface AdmissionLease {
  readonly subjectId: string;
  readonly leaseId: string;
}

export type AdmissionResult =
  | { readonly admitted: true; readonly lease: AdmissionLease }
  | { readonly admitted: false; readonly reason: AdmissionRefusal };

/**
 * The port the route depends on.
 *
 * `release` never rejects: a failure to release must not turn a successful
 * guidance response into an error for the person waiting. The lease TTL is the
 * backstop.
 */
export interface GuidanceAdmission {
  acquire(subjectId: string): Promise<AdmissionResult>;
  release(lease: AdmissionLease): Promise<void>;
}

/**
 * IN-MEMORY implementation.
 *
 * Deterministic and suitable for unit tests and single-instance development.
 * It is NOT multi-instance safe and does not claim to be — two replicas each
 * admit their own quota. Use the PostgreSQL implementation in deployment.
 */
export class InMemoryGuidanceAdmission implements GuidanceAdmission {
  private readonly entries = new Map<string, {
    leaseId: string | null;
    leaseExpiresAt: number;
    windowStart: number;
    count: number;
    lastSeen: number;
  }>();

  private sequence = 0;

  constructor(
    private readonly now: () => number,
    private readonly policy: AdmissionPolicy = DEFAULT_ADMISSION_POLICY,
  ) {}

  acquire(subjectId: string): Promise<AdmissionResult> {
    const t = this.now();
    this.evictExpired(t);

    const entry = this.entries.get(subjectId)
      ?? { leaseId: null, leaseExpiresAt: 0, windowStart: t, count: 0, lastSeen: t };
    entry.lastSeen = t;

    // An expired lease is treated as absent, so a crash cannot lock a subject.
    if (entry.leaseId !== null && t >= entry.leaseExpiresAt) entry.leaseId = null;

    if (t - entry.windowStart >= this.policy.windowMs) {
      entry.windowStart = t;
      entry.count = 0;
    }

    if (entry.leaseId !== null) {
      this.entries.set(subjectId, entry);
      return Promise.resolve({ admitted: false, reason: 'in_flight' });
    }
    if (entry.count >= this.policy.maxRequestsPerWindow) {
      this.entries.set(subjectId, entry);
      return Promise.resolve({ admitted: false, reason: 'quota_exceeded' });
    }

    this.sequence += 1;
    const leaseId = `lease-${this.sequence}`;
    entry.leaseId = leaseId;
    entry.leaseExpiresAt = t + this.policy.leaseTtlMs;
    entry.count += 1;
    this.entries.set(subjectId, entry);

    return Promise.resolve({ admitted: true, lease: { subjectId, leaseId } });
  }

  release(lease: AdmissionLease): Promise<void> {
    const entry = this.entries.get(lease.subjectId);
    // Matched on lease id so a late release cannot clear a NEWER lease.
    if (entry !== undefined && entry.leaseId === lease.leaseId) {
      entry.leaseId = null;
      entry.leaseExpiresAt = 0;
    }
    return Promise.resolve();
  }

  private evictExpired(t: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.leaseId === null && t - entry.lastSeen > this.policy.inMemoryEntryTtlMs) {
        this.entries.delete(key);
      }
    }
  }

  trackedSubjects(): number { return this.entries.size; }
}
