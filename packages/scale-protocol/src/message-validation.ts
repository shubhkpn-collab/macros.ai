import { err, issue, ok, type Result, type ValidationIssue } from '@macros/contracts';
import {
  SCALE_PROTOCOL_VERSION,
  type PendingScaleCommand,
  type ScaleCapabilities,
  type ScaleCommand,
  type ScaleCommandAck,
  type ScaleEvent,
} from './messages.js';

/**
 * RUNTIME VALIDATION AT THE DEVICE BOUNDARY.
 *
 * TypeScript types describe what we hope arrives. A transport carries whatever
 * the firmware actually sent, so every externally-originated message is checked
 * before it can influence state.
 */
const finitePositive = (v: number, path: string, out: ValidationIssue[]): void => {
  if (!Number.isFinite(v)) out.push(issue(path, 'not_finite', 'must be a finite number'));
  else if (v <= 0) out.push(issue(path, 'out_of_range', 'must be greater than zero'));
};

export function validateCapabilities(c: ScaleCapabilities): Result<ScaleCapabilities> {
  const out: ValidationIssue[] = [];
  if (c.protocolVersion !== SCALE_PROTOCOL_VERSION) {
    out.push(issue('protocolVersion', 'invalid_enum', 'unsupported scale protocol version'));
  }
  if (c.deviceId.length === 0) out.push(issue('deviceId', 'required', 'is required'));
  finitePositive(c.maxWeightGrams, 'maxWeightGrams', out);
  finitePositive(c.resolutionGrams, 'resolutionGrams', out);
  if (typeof c.supportsTare !== 'boolean') out.push(issue('supportsTare', 'required', 'is required'));
  if (typeof c.supportsCalibration !== 'boolean') {
    out.push(issue('supportsCalibration', 'required', 'is required'));
  }
  return out.length ? err(out) : ok(c);
}

const COMMAND_KINDS = ['tare', 'zero', 'start_calibration', 'identify'] as const;
const ACK_OUTCOMES = ['applied', 'rejected', 'failed'] as const;

/**
 * A command is host-originated, but a malformed one must still never enter the
 * protocol state machine.
 */
export function validateScaleCommand(command: ScaleCommand): Result<ScaleCommand> {
  const out: ValidationIssue[] = [];
  if (command.protocolVersion !== SCALE_PROTOCOL_VERSION) {
    out.push(issue('protocolVersion', 'invalid_enum', 'unsupported scale protocol version'));
  }
  if (command.commandId.length === 0) out.push(issue('commandId', 'required', 'is required'));
  if (command.deviceId.length === 0) out.push(issue('deviceId', 'required', 'is required'));
  if (!COMMAND_KINDS.includes(command.kind)) {
    out.push(issue('kind', 'invalid_enum', 'unsupported command kind'));
  }
  return out.length ? err(out) : ok(command);
}

export interface AckValidationContext {
  readonly deviceId: string;
  readonly bootId: string;
  readonly tareGeneration: number;
  readonly pendingCommand: PendingScaleCommand | null;
}

export type AckRejection =
  | 'protocol_version_mismatch'
  | 'device_mismatch'
  | 'boot_mismatch'
  | 'no_pending_command'
  | 'command_id_mismatch'
  | 'command_kind_mismatch'
  | 'missing_tare_generation'
  | 'invalid_tare_generation'
  | 'malformed_ack';

/**
 * An acknowledgement NEVER changes state merely because it claims
 * `outcome: 'applied'`. It must match a genuinely pending command on the
 * current device and boot, and an applied tare must carry exactly the next
 * generation — no missing value, no lower value, no arbitrary jump.
 */
export function validateCommandAck(
  ack: ScaleCommandAck,
  ctx: AckValidationContext,
): Result<ScaleCommandAck, AckRejection> {
  if (ack.protocolVersion !== SCALE_PROTOCOL_VERSION) {
    return { ok: false, error: 'protocol_version_mismatch' };
  }
  // Structural checks first: an unknown outcome or a malformed field must not
  // be able to resolve a pending command just because the types allow it.
  if (
    ack.commandId.length === 0 ||
    ack.deviceId.length === 0 ||
    ack.bootId.length === 0 ||
    !COMMAND_KINDS.includes(ack.kind) ||
    !ACK_OUTCOMES.includes(ack.outcome) ||
    (ack.tareGeneration !== undefined &&
      (!Number.isInteger(ack.tareGeneration) || ack.tareGeneration < 0))
  ) {
    return { ok: false, error: 'malformed_ack' };
  }
  if (ack.deviceId !== ctx.deviceId) return { ok: false, error: 'device_mismatch' };
  if (ack.bootId !== ctx.bootId) return { ok: false, error: 'boot_mismatch' };

  const pending = ctx.pendingCommand;
  if (pending === null) return { ok: false, error: 'no_pending_command' };
  if (pending.commandId !== ack.commandId) return { ok: false, error: 'command_id_mismatch' };
  if (pending.kind !== ack.kind) return { ok: false, error: 'command_kind_mismatch' };

  if ((ack.kind === 'tare' || ack.kind === 'zero') && ack.outcome === 'applied') {
    if (ack.tareGeneration === undefined) return { ok: false, error: 'missing_tare_generation' };
    if (ack.tareGeneration !== ctx.tareGeneration + 1) {
      return { ok: false, error: 'invalid_tare_generation' };
    }
  }

  return ok(ack);
}

export function validateConnectedEvent(
  event: Extract<ScaleEvent, { kind: 'connected' }>,
): Result<ScaleEvent> {
  const out: ValidationIssue[] = [];
  const caps = validateCapabilities(event.capabilities);
  if (!caps.ok) out.push(...caps.error);
  if (event.bootId.length === 0) out.push(issue('bootId', 'required', 'is required'));
  if (!Number.isInteger(event.tareGeneration) || event.tareGeneration < 0) {
    out.push(issue('tareGeneration', 'out_of_range', 'must be a non-negative integer'));
  }
  return out.length ? err(out) : ok(event);
}

export function validateDisconnectedEvent(
  event: Extract<ScaleEvent, { kind: 'disconnected' }>,
): Result<ScaleEvent> {
  const out: ValidationIssue[] = [];
  if (event.deviceId.length === 0) out.push(issue('deviceId', 'required', 'is required'));
  return out.length ? err(out) : ok(event);
}
