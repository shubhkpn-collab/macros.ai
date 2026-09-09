/**
 * LIVE WAVEFORM LEVELS.
 *
 * Amplitude only. No audio is recorded, stored or transmitted for the
 * visualisation — the microphone level is a single number per callback and it
 * is used to draw, then discarded.
 *
 * Pure so the smoothing can be tested: the difference between "alive" and
 * "jittery" is entirely in these few lines.
 */
export const WAVEFORM_VERSION = 'voice-waveform@1.0.0';

/**
 * Strokes arranged around the circle. Bounded and fixed: enough to read as a
 * ring of light, few enough to animate cheaply on a wall-mounted tablet.
 */
export const SEGMENT_COUNT = 20;

/**
 * Android reports RMS roughly between -2 and 10 dB, but it is noisy and
 * occasionally out of range, so it is clamped rather than trusted.
 */
const RMS_FLOOR = -2;
const RMS_CEILING = 10;

export function normalizeRms(rmsDb: number): number {
  if (!Number.isFinite(rmsDb)) return 0;
  const clamped = Math.min(Math.max(rmsDb, RMS_FLOOR), RMS_CEILING);
  return (clamped - RMS_FLOOR) / (RMS_CEILING - RMS_FLOOR);
}

/**
 * Exponential smoothing over the CURRENT value only.
 *
 * Deliberately not a history buffer: an unbounded array on an always-on
 * appliance is a leak, and one smoothed number draws just as well.
 *
 * Rising quickly and falling slowly is what makes speech look like speech —
 * symmetric smoothing reads as a pulsing lamp.
 */
export class LevelSmoother {
  private value = 0;

  constructor(
    private readonly attack = 0.5,
    private readonly release = 0.12,
  ) {}

  push(normalized: number): number {
    const target = Math.min(Math.max(normalized, 0), 1);
    const rate = target > this.value ? this.attack : this.release;
    this.value += (target - this.value) * rate;
    // Snap tiny residues to silence so the orb actually settles.
    if (this.value < 0.01) this.value = 0;
    return this.value;
  }

  get current(): number { return this.value; }

  reset(): void { this.value = 0; }
}

/**
 * Segment heights for one level.
 *
 * Symmetric around the centre with a fixed shape, so the form stays stable and
 * only its amplitude moves — random per-segment values would read as an
 * equaliser rather than a voice.
 */
export function segmentHeights(level: number): readonly number[] {
  const clamped = Math.min(Math.max(level, 0), 1);
  const floor = 0.14;

  return Array.from({ length: SEGMENT_COUNT }, (_unused, index) => {
    /**
     * A fixed standing-wave shape around the ring, so the FORM is stable and
     * only its amplitude moves. Random per-stroke heights would read as a music
     * visualiser; a repeating deterministic figure reads as one voice.
     */
    const angle = (index / SEGMENT_COUNT) * Math.PI * 2;
    const shape = 0.55 + (0.45 * Math.abs(Math.sin(angle * 1.5)));
    return floor + (shape * clamped * (1 - floor));
  });
}

/** Rotation in degrees for each stroke. Deterministic, evenly spaced. */
export function segmentAngle(index: number): number {
  return (index / SEGMENT_COUNT) * 360;
}
