import { ScaleSimulator } from '@macros/scale-simulator';
import type { WeightCaptureEvent } from '@macros/scale-protocol';
import type { MutableClock } from './ports.js';

/**
 * DEVELOPMENT SCALE ADAPTER.
 *
 * MVP-0's scale provider is the simulator, driven through the SAME logical
 * protocol real hardware will implement. When BLE firmware exists it replaces
 * this adapter and nothing above it changes.
 *
 * These controls are a hidden development panel. The consumer flow shows only
 * "Scale connected / Place food on scale / Stabilizing… / 250 g" — low-level
 * protocol controls are never part of the normal user experience.
 */
export class DevScaleAdapter {
  private readonly sim: ScaleSimulator;

  /**
   * Events are re-stamped with the APPLICATION clock. A transport adapter marks
   * when an event arrived at the tablet, and the tablet has exactly one clock —
   * the same one the capture intent is stamped with. Letting the simulator keep
   * its own timeline would make every capture request look like time travel.
   */
  constructor(startAt: string, private readonly clock: MutableClock, private readonly sampleIntervalMs = 200) {
    this.sim = new ScaleSimulator({ startAt });
  }

  private stamp(events: readonly WeightCaptureEvent[]): WeightCaptureEvent[] {
    return events.map((event) => {
      const at = this.clock.now();
      this.clock.advance(this.sampleIntervalMs);
      return { ...event, at } as WeightCaptureEvent;
    });
  }

  connect(): WeightCaptureEvent[] {
    return this.stamp([this.sim.connect()]);
  }

  disconnect(): WeightCaptureEvent[] {
    return this.stamp([this.sim.disconnect()]);
  }

  /** Place a load and emit enough samples for it to settle. */
  placeAndSettle(grams: number, samples = 6): WeightCaptureEvent[] {
    this.sim.setGross(grams);
    return this.stamp(this.sim.emitSteady(samples));
  }

  /** Emit without settling — the load is still moving. */
  placeUnsettled(grams: number, jitter: readonly number[] = [0, 6, -5]): WeightCaptureEvent[] {
    this.sim.setGross(grams);
    return this.stamp(this.sim.emitSteady(3, jitter));
  }

  remove(samples = 2): WeightCaptureEvent[] {
    this.sim.clearPlatform();
    return this.stamp(this.sim.emitSteady(samples));
  }

  tare(): WeightCaptureEvent[] {
    return this.stamp(this.sim.tare());
  }

  fault(samples = 2): WeightCaptureEvent[] {
    this.sim.setStatus('fault');
    return this.stamp(this.sim.emitSteady(samples));
  }

  overload(samples = 2): WeightCaptureEvent[] {
    this.sim.setStatus('overload');
    return this.stamp(this.sim.emitSteady(samples));
  }

  recover(): WeightCaptureEvent[] {
    this.sim.setStatus('ok');
    return this.remove();
  }

  /** Advance the shared timeline without emitting — used to age a candidate. */
  advance(ms: number): void {
    this.clock.advance(ms);
  }
}
