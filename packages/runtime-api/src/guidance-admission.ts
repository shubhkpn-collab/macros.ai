/**
 * SERVER-SIDE ADMISSION GUARD.
 *
 * Controller-side coalescing protects the UI, but an authenticated client can
 * call the endpoint directly. Before any paid provider is enabled there must be
 * a bound at the boundary itself, keyed by the verified subject.
 *
 * LIMITATION, stated rather than glossed: this is PROCESS-LOCAL. It is a real
 * guard for a single server instance and honest protection against a runaway
 * client, but it is NOT multi-instance safe — two replicas each admit their own
 * quota. A shared store would fix that and is deliberately out of scope here.
 */
export const ADMISSION_VERSION = 'guidance-admission@1.0.0';

export interface AdmissionPolicy {
  /** Concurrent provider calls permitted per subject. */
  readonly maxInFlightPerSubject: number;
  readonly maxRequestsPerWindow: number;
  readonly windowMs: number;
  /** Entries idle longer than this are dropped, bounding memory. */
  readonly entryTtlMs: number;
}

export const DEFAULT_ADMISSION_POLICY: AdmissionPolicy = {
  maxInFlightPerSubject: 1,
  maxRequestsPerWindow: 20,
  windowMs: 60_000,
  entryTtlMs: 300_000,
};

export type AdmissionDecision =
  | { readonly admitted: true; readonly release: () => void }
  | { readonly admitted: false; readonly reason: 'in_flight' | 'quota_exceeded' };

interface Entry {
  inFlight: number;
  windowStart: number;
  count: number;
  lastSeen: number;
}

export class GuidanceAdmissionGuard {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly now: () => number,
    private readonly policy: AdmissionPolicy = DEFAULT_ADMISSION_POLICY,
  ) {}

  /**
   * Decide whether this subject may invoke the provider.
   *
   * A refusal must return BEFORE the provider is called — the entire point is
   * that a rejected request costs nothing.
   */
  admit(subjectId: string): AdmissionDecision {
    const t = this.now();
    this.evictExpired(t);

    const entry = this.entries.get(subjectId)
      ?? { inFlight: 0, windowStart: t, count: 0, lastSeen: t };
    entry.lastSeen = t;

    if (t - entry.windowStart >= this.policy.windowMs) {
      entry.windowStart = t;
      entry.count = 0;
    }

    if (entry.inFlight >= this.policy.maxInFlightPerSubject) {
      this.entries.set(subjectId, entry);
      return { admitted: false, reason: 'in_flight' };
    }
    if (entry.count >= this.policy.maxRequestsPerWindow) {
      this.entries.set(subjectId, entry);
      return { admitted: false, reason: 'quota_exceeded' };
    }

    entry.inFlight += 1;
    entry.count += 1;
    this.entries.set(subjectId, entry);

    let released = false;
    return {
      admitted: true,
      release: () => {
        // Idempotent: a double release would open a slot that was never taken.
        if (released) return;
        released = true;
        const current = this.entries.get(subjectId);
        if (current !== undefined && current.inFlight > 0) current.inFlight -= 1;
      },
    };
  }

  /** Bounded memory: idle subjects are forgotten. */
  private evictExpired(t: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.inFlight === 0 && t - entry.lastSeen > this.policy.entryTtlMs) {
        this.entries.delete(key);
      }
    }
  }

  /** Test/observability only. */
  trackedSubjects(): number { return this.entries.size; }
}
