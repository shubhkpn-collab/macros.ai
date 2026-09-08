/**
 * Types declared LOCALLY rather than imported from `@macros/runtime-api`.
 *
 * Importing them dragged the runtime-api barrel — and with it `node:http` and
 * Buffer — into the React Native type graph through persistence, which the
 * tablet does import. Structural typing means this adapter still satisfies the
 * route's `GuidanceAdmission` port exactly, without the tablet inheriting a
 * server dependency.
 */
export interface AdmissionPolicy {
  readonly maxRequestsPerWindow: number;
  readonly windowMs: number;
  readonly leaseTtlMs: number;
  readonly inMemoryEntryTtlMs: number;
}

export interface AdmissionLease {
  readonly subjectId: string;
  readonly leaseId: string;
}

export type AdmissionResult =
  | { readonly admitted: true; readonly lease: AdmissionLease }
  | { readonly admitted: false; readonly reason: 'in_flight' | 'quota_exceeded' };

export interface GuidanceAdmission {
  acquire(subjectId: string): Promise<AdmissionResult>;
  release(lease: AdmissionLease): Promise<void>;
}

/**
 * POSTGRESQL GUIDANCE ADMISSION — multi-instance safe.
 *
 * The in-memory guard is honest but single-process: two replicas each admit
 * their own quota, so a deployment could make two paid calls for one subject.
 * Correctness here rests on a single atomic statement rather than a
 * read-then-write, because between a SELECT and an UPDATE two instances can
 * both decide they are first.
 *
 * A lease carries an expiry, so an instance that crashes mid-call cannot lock
 * the subject out: the next acquire sees the lease as expired and takes it.
 */
export const POSTGRES_ADMISSION_VERSION = 'postgres-guidance-admission@1.0.0';

/** Minimal shape needed here, matching the existing driver convention. */
export interface AdmissionSql {
  query<T = Record<string, unknown>>(
    text: string, values?: readonly unknown[],
  ): Promise<{ rows: T[] }>;
}

export class PostgresGuidanceAdmission implements GuidanceAdmission {
  constructor(
    private readonly sql: AdmissionSql,
    private readonly policy: AdmissionPolicy,
    private readonly newLeaseId: () => string,
  ) {}

  /**
   * Acquire in ONE statement.
   *
   * The upsert both resets an elapsed window and takes the lease only when no
   * live lease exists. Whether the row was actually claimed is decided by
   * comparing the returned lease id, so a losing instance cannot mistake
   * another's lease for its own.
   */
  async acquire(subjectId: string): Promise<AdmissionResult> {
    const leaseId = this.newLeaseId();

    /**
     * POSTGRESQL IS THE SERIALIZATION POINT.
     *
     * The previous statement computed its verdict in a CTE and then inserted
     * "where the verdict allowed". For a subject with no row yet, two instances
     * both read nothing, both computed "admit", one inserted, and the other's
     * unconditional DO UPDATE ran on conflict — so BOTH reported admission and
     * two paid calls could start.
     *
     * The decision now lives in the `DO UPDATE ... WHERE`, which PostgreSQL
     * evaluates against the LOCKED conflicting row after the conflict resolves.
     * Exactly one statement can satisfy it. A returned row means admitted; no
     * row means refused, and nothing else can grant admission.
     */
    const { rows } = await this.sql.query<{ lease_id: string }>(
      `
      INSERT INTO guidance_admission AS a (
        subject_id, lease_id, lease_expires_at,
        window_started_at, window_request_count, updated_at
      )
      VALUES (
        $1::uuid, $2::uuid,
        now() + ($3::bigint * interval '1 millisecond'),
        now(), 1, now()
      )
      ON CONFLICT (subject_id) DO UPDATE SET
        lease_id         = EXCLUDED.lease_id,
        lease_expires_at = EXCLUDED.lease_expires_at,
        window_started_at = CASE
          WHEN now() - a.window_started_at >= ($4::bigint * interval '1 millisecond')
          THEN now() ELSE a.window_started_at END,
        -- A new window restarts at 1; otherwise this admitted call is the next.
        window_request_count = CASE
          WHEN now() - a.window_started_at >= ($4::bigint * interval '1 millisecond')
          THEN 1 ELSE a.window_request_count + 1 END,
        updated_at = now()
      WHERE
        -- No LIVE lease on the locked row. An expired lease counts as absent.
        (a.lease_id IS NULL OR a.lease_expires_at <= now())
        -- And quota available, either by reset or by headroom.
        AND (
          now() - a.window_started_at >= ($4::bigint * interval '1 millisecond')
          OR a.window_request_count < $5::int
        )
      RETURNING a.lease_id
      `,
      [subjectId, leaseId, this.policy.leaseTtlMs,
        this.policy.windowMs, this.policy.maxRequestsPerWindow],
    );

    if (rows.length === 1) return { admitted: true, lease: { subjectId, leaseId } };

    /**
     * Refused. This read only CLASSIFIES the refusal for the caller's log — it
     * cannot grant admission, so a race here changes a label and nothing more.
     */
    const { rows: state } = await this.sql.query<{ live_lease: boolean }>(
      `SELECT (lease_id IS NOT NULL AND lease_expires_at > now()) AS live_lease
         FROM guidance_admission WHERE subject_id = $1::uuid`,
      [subjectId],
    );
    return {
      admitted: false,
      reason: state[0]?.live_lease === true ? 'in_flight' : 'quota_exceeded',
    };
  }

  /**
   * Release, matched on lease id.
   *
   * Idempotent, and a late release cannot clear a NEWER lease taken after this
   * one expired — the `lease_id =` predicate is what enforces that.
   */
  async release(lease: AdmissionLease): Promise<void> {
    await this.sql.query(
      `UPDATE guidance_admission
          SET lease_id = NULL, lease_expires_at = NULL, updated_at = now()
        WHERE subject_id = $1::uuid AND lease_id = $2::uuid`,
      [lease.subjectId, lease.leaseId],
    );
  }
}
