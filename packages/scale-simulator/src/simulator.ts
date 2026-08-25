import { instant, type Instant } from '@macros/contracts';
import {
  SCALE_PROTOCOL_VERSION,
  type ScaleCapabilities,
  type ScaleCommand,
  type ScaleCommandAck,
  type ScaleCommandKind,
  type WeightCaptureEvent,
  type ScaleDeviceStatus,
  type ScaleDisconnectReason,
  type ScaleEvent,
  type ScaleReading,
} from '@macros/scale-protocol';

/**
 * DETERMINISTIC IN-MEMORY SCALE SIMULATOR.
 *
 * Exercises the exact logical protocol real hardware will implement, so every
 * host-side capture flow is testable long before firmware or BLE exist.
 *
 * It simulates a physical scale and nothing else — it knows nothing about food,
 * nutrition or logging. No randomness: jitter is supplied explicitly by the
 * caller as a deterministic pattern. No clock: the caller advances time.
 */
export interface SimulatorConfig {
  readonly deviceId: string;
  readonly maxWeightGrams: number;
  readonly resolutionGrams: number;
  readonly sampleIntervalMs: number;
  readonly startAt: string;
  readonly firmwareVersion?: string;
  readonly hardwareRevision?: string;
}

export const DEFAULT_SIMULATOR_CONFIG: SimulatorConfig = {
  deviceId: 'sim-scale-001',
  // Target nominal values. Real supplier tolerances are PENDING_HARDWARE_VALIDATION.
  maxWeightGrams: 5000,
  resolutionGrams: 1,
  sampleIntervalMs: 200,
  startAt: '2026-08-12T09:00:00.000Z',
  firmwareVersion: 'sim-fw-0.0.0',
  hardwareRevision: 'sim-hw-A',
};

export class ScaleSimulator {
  private readonly config: SimulatorConfig;
  private bootCounter = 0;
  private bootId: string;
  private sequence = 0;
  private tareGeneration = 0;
  private tareOffsetGrams = 0;
  private status: ScaleDeviceStatus = 'ok';
  private grossGrams = 0;
  private clockMs: number;
  private connected = false;
  private commandCounter = 0;

  constructor(config: Partial<SimulatorConfig> = {}) {
    this.config = { ...DEFAULT_SIMULATOR_CONFIG, ...config };
    this.clockMs = Date.parse(this.config.startAt);
    this.bootId = `boot-${this.bootCounter}`;
  }

  get capabilities(): ScaleCapabilities {
    return {
      protocolVersion: SCALE_PROTOCOL_VERSION,
      deviceId: this.config.deviceId,
      maxWeightGrams: this.config.maxWeightGrams,
      resolutionGrams: this.config.resolutionGrams,
      supportsTare: true,
      supportsCalibration: true,
      ...(this.config.firmwareVersion !== undefined ? { firmwareVersion: this.config.firmwareVersion } : {}),
      ...(this.config.hardwareRevision !== undefined ? { hardwareRevision: this.config.hardwareRevision } : {}),
      hardwareModel: 'simulator',
    };
  }

  get currentBootId(): string { return this.bootId; }
  get currentTareGeneration(): number { return this.tareGeneration; }
  private now(): Instant { return instant(new Date(this.clockMs).toISOString()); }
  advance(ms: number): void { this.clockMs += ms; }

  connect(): ScaleEvent {
    this.connected = true;
    return {
      kind: 'connected',
      at: this.now(),
      capabilities: this.capabilities,
      bootId: this.bootId,
      tareGeneration: this.tareGeneration,
    };
  }

  disconnect(reason: ScaleDisconnectReason = 'link_lost'): ScaleEvent {
    this.connected = false;
    return { kind: 'disconnected', at: this.now(), deviceId: this.config.deviceId, reason };
  }

  /** A reboot mints a new bootId and resets sequence and tare state. */
  reboot(): void {
    this.bootCounter += 1;
    this.bootId = `boot-${this.bootCounter}`;
    this.sequence = 0;
    this.tareGeneration = 0;
    this.tareOffsetGrams = 0;
    this.status = 'ok';
  }

  setStatus(status: ScaleDeviceStatus): void { this.status = status; }
  /** Place, add, or remove mass. Gross weight, before tare. */
  setGross(grams: number): void { this.grossGrams = grams; }
  clearPlatform(): void { this.grossGrams = 0; }

  /**
   * A tare is a two-step lifecycle: the host issues a command, the device
   * acknowledges it. An unsolicited ack can never change state, so the
   * simulator must emit both.
   */
  tare(outcome: 'applied' | 'rejected' | 'failed' = 'applied'): WeightCaptureEvent[] {
    this.commandCounter += 1;
    const kind: ScaleCommandKind = 'tare';
    const commandId = `cmd-${this.commandCounter}`;
    const command: ScaleCommand = {
      protocolVersion: SCALE_PROTOCOL_VERSION,
      commandId,
      deviceId: this.config.deviceId,
      kind,
    };
    const issued: WeightCaptureEvent = {
      kind: 'command_issued', at: this.now(), command, bootId: this.bootId,
    };

    if (outcome === 'applied') {
      this.tareOffsetGrams = this.grossGrams;
      this.tareGeneration += 1;
    }
    const ack: ScaleCommandAck = {
      protocolVersion: SCALE_PROTOCOL_VERSION,
      commandId,
      deviceId: this.config.deviceId,
      bootId: this.bootId,
      kind,
      outcome,
      ...(outcome === 'applied' ? { tareGeneration: this.tareGeneration } : {}),
      ...(outcome !== 'applied' ? { reason: 'simulated tare failure' } : {}),
    };
    return [issued, { kind: 'command_ack', at: this.now(), ack }];
  }

  /** An acknowledgement with no matching issued command. */
  unsolicitedTareAck(tareGeneration = this.tareGeneration + 1): WeightCaptureEvent {
    this.commandCounter += 1;
    const ack: ScaleCommandAck = {
      protocolVersion: SCALE_PROTOCOL_VERSION,
      commandId: `cmd-unsolicited-${this.commandCounter}`,
      deviceId: this.config.deviceId,
      bootId: this.bootId,
      kind: 'tare',
      outcome: 'applied',
      tareGeneration,
    };
    return { kind: 'command_ack', at: this.now(), ack };
  }

  /**
   * Emit one reading and advance the simulated clock.
   * `deltaGrams` applies deterministic jitter supplied by the caller.
   */
  emit(deltaGrams = 0, options: { advanceMs?: number; firmwareStable?: boolean } = {}): ScaleEvent {
    if (!this.connected) throw new Error('ScaleSimulator: emit() while disconnected');
    const at = this.now();
    this.sequence += 1;
    const net = this.grossGrams + deltaGrams - this.tareOffsetGrams;
    const reading: ScaleReading = {
      protocolVersion: SCALE_PROTOCOL_VERSION,
      deviceId: this.config.deviceId,
      bootId: this.bootId,
      sequence: this.sequence,
      netWeightGrams: net,
      deviceUptimeMs: this.clockMs - Date.parse(this.config.startAt),
      tareGeneration: this.tareGeneration,
      status: this.status,
      ...(options.firmwareStable !== undefined ? { firmwareStable: options.firmwareStable } : {}),
    };
    this.advance(options.advanceMs ?? this.config.sampleIntervalMs);
    return { kind: 'reading', at, reading };
  }

  /** Emit `count` readings at the current weight, applying a jitter pattern. */
  emitSteady(count: number, jitter: readonly number[] = [0]): ScaleEvent[] {
    const events: ScaleEvent[] = [];
    for (let i = 0; i < count; i++) {
      events.push(this.emit(jitter[i % jitter.length] ?? 0));
    }
    return events;
  }

  /** Emit a ramp from the current gross weight to a target, then hold. */
  emitRamp(targetGrams: number, steps: number): ScaleEvent[] {
    const startGrams = this.grossGrams;
    const events: ScaleEvent[] = [];
    for (let i = 1; i <= steps; i++) {
      this.setGross(startGrams + ((targetGrams - startGrams) * i) / steps);
      events.push(this.emit());
    }
    return events;
  }

  /** Re-send the previous frame verbatim: a duplicate packet. */
  duplicateLast(previous: ScaleEvent): ScaleEvent {
    if (previous.kind !== 'reading') throw new Error('duplicateLast: not a reading event');
    return { kind: 'reading', at: this.now(), reading: previous.reading };
  }

  /** Emit a frame with an older sequence number: an out-of-order packet. */
  outOfOrder(previous: ScaleEvent, sequenceDelta = 2): ScaleEvent {
    if (previous.kind !== 'reading') throw new Error('outOfOrder: not a reading event');
    return {
      kind: 'reading',
      at: this.now(),
      reading: { ...previous.reading, sequence: Math.max(0, previous.reading.sequence - sequenceDelta) },
    };
  }
}
