import type { Instant } from '@macros/contracts';

/**
 * TRANSPORT-INDEPENDENT LOGICAL SCALE PROTOCOL.
 *
 * Deliberately not bound to BLE GATT. Real BLE, a USB/service transport, or the
 * in-memory simulator must all be able to carry these same logical messages, so
 * the weight-capture logic is written once and never re-derived per transport.
 *
 * Design constraints this shape satisfies:
 *  - the scale needs no wall clock; ordering comes from `sequence`;
 *  - grams are canonical — no pounds or ounces cross this boundary;
 *  - reboot and reconnect are distinguishable via `bootId`;
 *  - readings taken before a tare can be invalidated afterwards;
 *  - overload and fault are explicit device status, not inferred;
 *  - the protocol version travels with every message.
 */
export const SCALE_PROTOCOL_VERSION = 'scale-protocol@1.0.0';

/** Authoritative device status. Reported by hardware, never guessed by the host. */
export type ScaleDeviceStatus = 'ok' | 'overload' | 'calibration_required' | 'fault';

export interface ScaleCapabilities {
  readonly protocolVersion: string;
  readonly deviceId: string;
  readonly maxWeightGrams: number;
  readonly resolutionGrams: number;
  readonly supportsTare: boolean;
  readonly supportsCalibration: boolean;
  /** Provenance. Suppliers will not share firmware; never assume they do. */
  readonly firmwareVersion?: string;
  readonly hardwareRevision?: string;
  readonly hardwareModel?: string;
}

export interface ScaleReading {
  readonly protocolVersion: string;
  readonly deviceId: string;
  /** Changes on every device boot. Distinguishes reconnect from reboot. */
  readonly bootId: string;
  /** Monotonic within a boot. Establishes ordering without a device clock. */
  readonly sequence: number;
  /** Canonical unit. May be slightly negative from load-cell drift. */
  readonly netWeightGrams: number;
  readonly deviceUptimeMs?: number;
  /** Increments on every applied tare. Invalidates earlier readings. */
  readonly tareGeneration: number;
  readonly status: ScaleDeviceStatus;
  /**
   * ADVISORY ONLY. Firmware stability flags differ between suppliers, so
   * MACROS.AI never trusts one for capture eligibility — the host runs its own
   * deterministic policy. Retained for diagnostics and supplier comparison.
   */
  readonly firmwareStable?: boolean;
}

export type ScaleCommandKind = 'tare' | 'zero' | 'start_calibration' | 'identify';

export interface ScaleCommand {
  readonly protocolVersion: string;
  readonly commandId: string;
  readonly deviceId: string;
  readonly kind: ScaleCommandKind;
}

export type ScaleCommandOutcome = 'applied' | 'rejected' | 'failed';

/** Tare failure is visible. Success is never faked. */
export interface ScaleCommandAck {
  readonly protocolVersion: string;
  readonly commandId: string;
  readonly deviceId: string;
  readonly bootId: string;
  readonly kind: ScaleCommandKind;
  readonly outcome: ScaleCommandOutcome;
  /** Present when a tare was applied. The host adopts this generation. */
  readonly tareGeneration?: number;
  readonly reason?: string;
}

export type ScaleDisconnectReason = 'user' | 'link_lost' | 'device_shutdown' | 'error';

/**
 * Normalized events the state machine consumes. A transport adapter converts
 * its wire format into these; the state machine knows nothing else.
 */
export type ScaleEvent =
  | { readonly kind: 'connected'; readonly at: Instant; readonly capabilities: ScaleCapabilities; readonly bootId: string; readonly tareGeneration: number }
  | { readonly kind: 'disconnected'; readonly at: Instant; readonly deviceId: string; readonly reason: ScaleDisconnectReason }
  | { readonly kind: 'reading'; readonly at: Instant; readonly reading: ScaleReading }
  | { readonly kind: 'command_ack'; readonly at: Instant; readonly ack: ScaleCommandAck };

/** A command the host has issued and is awaiting acknowledgement for. */
export interface PendingScaleCommand {
  readonly commandId: string;
  readonly kind: ScaleCommandKind;
  readonly deviceId: string;
  readonly bootId: string;
}

/** Host-side command lifecycle. Only a genuinely pending command can complete. */
export type ScaleCommandLifecycleEvent = {
  readonly kind: 'command_issued';
  readonly at: Instant;
  readonly command: ScaleCommand;
  readonly bootId: string;
};

/**
 * HOST INTENT — separate from device events.
 *
 * The scale has no idea what food is selected. The application decides when a
 * settled weight is actually wanted, which is what lets the user identify food
 * after the weight has already stabilized.
 */
export type CaptureIntentEvent =
  | { readonly kind: 'capture_requested'; readonly requestId: string; readonly at: Instant }
  | { readonly kind: 'capture_cancelled'; readonly requestId: string; readonly at: Instant }
  | { readonly kind: 'manual_entry'; readonly at: Instant; readonly grams: number };

export type WeightCaptureEvent = ScaleEvent | ScaleCommandLifecycleEvent | CaptureIntentEvent;

/**
 * TRANSPORT BOUNDARY — types only.
 *
 * Lives outside the pure capture logic. No BLE library is chosen, no vendor
 * UUIDs are defined, and nothing here is implemented in this milestone.
 */
export interface ScaleTransport {
  connect(deviceId: string): Promise<ScaleCapabilities>;
  disconnect(deviceId: string): Promise<void>;
  sendCommand(command: ScaleCommand): Promise<void>;
  subscribe(listener: (event: ScaleEvent) => void): () => void;
}
