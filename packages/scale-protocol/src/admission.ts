import { err, issue, ok, type Result, type ValidationIssue } from '@macros/contracts';
import { SCALE_PROTOCOL_VERSION, type ScaleReading } from './messages.js';

/**
 * SEQUENCE AND SESSION SAFETY.
 *
 * Prevents a stale or duplicated frame from producing a food capture. Every
 * outcome is deterministic and named, so a rejection is always explainable.
 */
export type ReadingAdmission =
  | 'accepted'
  | 'ignored_duplicate'
  | 'rejected_out_of_order'
  | 'rejected_unknown_device'
  | 'rejected_boot_mismatch'
  | 'rejected_old_tare_generation'
  | 'rejected_unexpected_tare_generation'
  | 'rejected_protocol_version'
  | 'rejected_malformed';

export interface ScaleSession {
  readonly deviceId: string;
  readonly bootId: string;
  readonly lastSequence: number | null;
  readonly tareGeneration: number;
}

export interface AdmissionResult {
  readonly admission: ReadingAdmission;
  readonly session: ScaleSession;
  readonly reason?: string;
}

export function validateReading(reading: ScaleReading): Result<ScaleReading> {
  const out: ValidationIssue[] = [];
  if (!Number.isFinite(reading.netWeightGrams)) {
    out.push(issue('netWeightGrams', 'not_finite', 'must be a finite number'));
  }
  if (!Number.isInteger(reading.sequence) || reading.sequence < 0) {
    out.push(issue('sequence', 'out_of_range', 'must be a non-negative integer'));
  }
  if (!Number.isInteger(reading.tareGeneration) || reading.tareGeneration < 0) {
    out.push(issue('tareGeneration', 'out_of_range', 'must be a non-negative integer'));
  }
  if (reading.deviceUptimeMs !== undefined) {
    // Sequence remains authoritative for ordering; uptime is provenance only.
    if (!Number.isFinite(reading.deviceUptimeMs)) {
      out.push(issue('deviceUptimeMs', 'not_finite', 'must be a finite number'));
    } else if (reading.deviceUptimeMs < 0) {
      out.push(issue('deviceUptimeMs', 'out_of_range', 'must not be negative'));
    }
  }
  if (reading.deviceId.length === 0) out.push(issue('deviceId', 'required', 'is required'));
  if (reading.bootId.length === 0) out.push(issue('bootId', 'required', 'is required'));
  return out.length ? err(out) : ok(reading);
}

/**
 * Decide whether a reading may influence capture, and advance the session.
 *
 * THE RULE IS SIMPLE: a `connected` event establishes the current boot, and
 * readings must match it. A reading carrying an unknown boot id does NOT
 * authorize a reboot transition — only a validated connection event does.
 *
 * TARE GENERATION MUST NOT SILENTLY JUMP. During an established session an
 * ordinary reading must carry exactly the session's generation. A higher one is
 * adopted only through a matched, validated tare acknowledgement or a new
 * validated connection — which is what keeps "tare is explicit and
 * acknowledged" true.
 */
export function admitReading(session: ScaleSession, reading: ScaleReading): AdmissionResult {
  if (reading.protocolVersion !== SCALE_PROTOCOL_VERSION) {
    return { admission: 'rejected_protocol_version', session };
  }
  if (!validateReading(reading).ok) {
    return { admission: 'rejected_malformed', session };
  }
  if (reading.deviceId !== session.deviceId) {
    return { admission: 'rejected_unknown_device', session };
  }
  if (reading.bootId !== session.bootId) {
    return { admission: 'rejected_boot_mismatch', session };
  }
  if (reading.tareGeneration < session.tareGeneration) {
    return { admission: 'rejected_old_tare_generation', session };
  }
  if (reading.tareGeneration > session.tareGeneration) {
    return { admission: 'rejected_unexpected_tare_generation', session };
  }

  if (session.lastSequence !== null) {
    if (reading.sequence === session.lastSequence) {
      return { admission: 'ignored_duplicate', session };
    }
    if (reading.sequence < session.lastSequence) {
      return { admission: 'rejected_out_of_order', session };
    }
  }

  return {
    admission: 'accepted',
    session: { ...session, lastSequence: reading.sequence },
  };
}
