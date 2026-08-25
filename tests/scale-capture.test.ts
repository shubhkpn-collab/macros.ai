import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  initialState,
  manualCapture,
  reduceAll,
  reduceCapture,
  evaluateStability,
  pushSample,
  isClear,
  EMPTY_WINDOW,
  type WeightCaptureState,
} from '@macros/domain-weight';
import {
  admitReading,
  loadProductionStabilityPolicy,
  REQUIRED_CORNER_LOAD_POSITIONS,
  SCALE_PROTOCOL_VERSION,
  validateReading,
  validateCapabilities,
  validateCommandAck,
  validateScaleCommand,
  quantizeToResolution,
  type ScaleSession,
  type WeightCaptureEvent,
} from '@macros/scale-protocol';
import { ScaleSimulator } from '@macros/scale-simulator';
import {
  instant,
  unwrap,
  validateWeightCapture,
  type Instant,
  type WeightCapture,
} from '@macros/contracts';
import { SYNTHETIC_STABILITY_POLICY, approx } from '@macros/testkit';

const POLICY = SYNTHETIC_STABILITY_POLICY;

const fresh = (): { sim: ScaleSimulator; state: WeightCaptureState } => {
  const sim = new ScaleSimulator();
  const start = initialState(POLICY);
  const { state } = reduceAll(start, [sim.connect()], POLICY);
  return { sim, state };
};

const run = (state: WeightCaptureState, events: WeightCaptureEvent[]) =>
  reduceAll(state, events, POLICY);

let requestCounter = 0;
const requestCapture = (at: Instant, requestId?: string): WeightCaptureEvent => ({
  kind: 'capture_requested',
  requestId: requestId ?? `req-${++requestCounter}`,
  at,
});
const cancelCapture = (requestId: string, at: Instant): WeightCaptureEvent => ({
  kind: 'capture_cancelled', requestId, at,
});
/** The instant just after the last emitted event, for intent timing. */
const nowOf = (events: WeightCaptureEvent[]): Instant => events[events.length - 1]!.at;

/** Place a weight and hold it steady long enough to satisfy the policy. */
const placeAndSettle = (sim: ScaleSimulator, grams: number, jitter: readonly number[] = [0]) => {
  sim.setGross(grams);
  return sim.emitSteady(6, jitter);
};

/** Settle a portion, then explicitly ask for it — the full product flow. */
const settleAndRequest = (sim: ScaleSimulator, state: WeightCaptureState, grams: number) => {
  const events = placeAndSettle(sim, grams);
  const settled = run(state, events);
  return run(settled.state, [requestCapture(nowOf(events))]);
};

// ---------------------------------------------------------------------------

describe('protocol contracts', () => {
  test('capabilities reflect the target nominal range and resolution', () => {
    const { sim } = fresh();
    assert.equal(sim.capabilities.maxWeightGrams, 5000);
    assert.equal(sim.capabilities.resolutionGrams, 1);
    assert.equal(sim.capabilities.supportsTare, true);
    assert.equal(sim.capabilities.supportsCalibration, true);
    assert.equal(sim.capabilities.protocolVersion, SCALE_PROTOCOL_VERSION);
    assert.ok(sim.capabilities.firmwareVersion, 'firmware provenance travels with capabilities');
  });

  test('no validated production stability policy ships', () => {
    const handle = loadProductionStabilityPolicy();
    assert.equal(handle.status, 'unavailable');
    if (handle.status === 'unavailable') assert.equal(handle.reason, 'pending_hardware_validation');
  });

  test('the synthetic policy is explicitly marked pending hardware validation', () => {
    assert.equal(POLICY.provenance, 'SYNTHETIC_TEST');
    assert.equal(POLICY.validationStatus, 'PENDING_HARDWARE_VALIDATION');
  });

  test('malformed readings are rejected', () => {
    const { sim } = fresh();
    const event = sim.emit();
    if (event.kind !== 'reading') throw new Error('expected a reading');
    assert.equal(validateReading(event.reading).ok, true);
    assert.equal(validateReading({ ...event.reading, netWeightGrams: Number.NaN }).ok, false);
    assert.equal(validateReading({ ...event.reading, sequence: -1 }).ok, false);
    assert.equal(validateReading({ ...event.reading, tareGeneration: 1.5 }).ok, false);
  });

  test('corner-load qualification positions are recorded as a hardware requirement', () => {
    assert.deepEqual(
      [...REQUIRED_CORNER_LOAD_POSITIONS],
      ['center', 'front_left', 'front_right', 'rear_left', 'rear_right'],
    );
  });
});

describe('stability requires a WINDOW, not one matching sample', () => {
  test('two identical consecutive readings are not stable', () => {
    let w = EMPTY_WINDOW;
    w = pushSample(w, { atMs: 0, grams: 250, tareGeneration: 0 }, POLICY);
    w = pushSample(w, { atMs: 200, grams: 250, tareGeneration: 0 }, POLICY);
    const e = evaluateStability(w, POLICY);
    assert.equal(e.stable, false);
    assert.equal(e.reason, 'insufficient_samples');
  });

  test('enough samples but not enough elapsed time is not stable', () => {
    let w = EMPTY_WINDOW;
    for (const atMs of [0, 50, 100]) w = pushSample(w, { atMs, grams: 250, tareGeneration: 0 }, POLICY);
    assert.equal(evaluateStability(w, POLICY).reason, 'insufficient_duration');
  });

  test('a wide spread is not stable', () => {
    let w = EMPTY_WINDOW;
    for (const [atMs, g] of [[0, 250], [300, 251], [700, 253.5]] as const) {
      w = pushSample(w, { atMs, grams: g, tareGeneration: 0 }, POLICY);
    }
    assert.equal(evaluateStability(w, POLICY).reason, 'spread_too_large');
  });

  test('a settled window above the minimum is stable', () => {
    let w = EMPTY_WINDOW;
    for (const [atMs, g] of [[0, 250], [300, 250.5], [700, 250]] as const) {
      w = pushSample(w, { atMs, grams: g, tareGeneration: 0 }, POLICY);
    }
    const e = evaluateStability(w, POLICY);
    assert.equal(e.stable, true);
    assert.ok(approx(e.representativeGrams, 250, 1e-9));
  });

  test('the clear band decides when the platform counts as empty', () => {
    assert.equal(isClear(0, POLICY), true);
    assert.equal(isClear(-1.5, POLICY), true, 'small negative drift is still clear');
    assert.equal(isClear(50, POLICY), false);
  });
});

describe('PRODUCT FLOW — stable weight is not a food capture', () => {
  test('a settled portion produces a CANDIDATE, not a capture', () => {
    const { sim, state } = fresh();
    const { captures, state: final } = run(state, placeAndSettle(sim, 250));
    assert.equal(captures.length, 0, 'nothing is captured without explicit intent');
    assert.equal(final.phase, 'stable');
    assert.ok(final.candidate !== null);
    assert.ok(approx(final.candidate!.grams, 250, 1e-9));
  });

  test('FLOW A — stable before food selection, then capture is immediate', () => {
    const { sim, state } = fresh();
    const events = placeAndSettle(sim, 250);
    const settled = run(state, events);
    assert.equal(settled.captures.length, 0);

    // The user identifies the food only now. They must not have to lift and
    // replace it just because it settled first.
    const requested = run(settled.state, [requestCapture(nowOf(events))]);
    assert.equal(requested.captures.length, 1);
    assert.ok(approx(requested.captures[0]!.grams, 250, 1e-9));
    assert.equal(requested.state.phase, 'awaiting_clear');
  });

  test('FLOW B — request before stable, capture fires when it settles', () => {
    const { sim, state } = fresh();
    const armed = run(state, [requestCapture(instant('2026-08-12T09:00:00.000Z'))]);
    assert.equal(armed.captures.length, 0);
    assert.equal(armed.outputs[0]!.captureRejection, 'no_candidate');

    const settled = run(armed.state, placeAndSettle(sim, 250));
    assert.equal(settled.captures.length, 1, 'exactly one capture when it settles');
    assert.ok(approx(settled.captures[0]!.grams, 250, 1e-9));
    assert.equal(settled.state.phase, 'awaiting_clear');
  });

  test('stable but never requested — 60 readings, zero captures', () => {
    const { sim, state } = fresh();
    sim.setGross(250);
    const { captures, state: final } = run(state, sim.emitSteady(60));
    assert.equal(captures.length, 0);
    assert.equal(final.phase, 'stable', 'it stays stable, holding a candidate');
    assert.ok(final.candidate !== null);
  });

  test('the candidate refreshes while the portion stays put', () => {
    const { sim, state } = fresh();
    const first = run(state, placeAndSettle(sim, 250));
    const firstObserved = first.state.candidate!.observedAt;
    const later = run(first.state, sim.emitSteady(4));
    assert.notEqual(later.state.candidate!.observedAt, firstObserved);
  });

  test('the capture carries defensible evidence and full provenance', () => {
    const { sim, state } = fresh();
    const { captures } = settleAndRequest(sim, state, 250);
    const capture = captures[0]!;
    assert.ok(capture.evidence !== undefined);
    assert.ok(capture.evidence!.sampleCount >= POLICY.minSampleCount);
    assert.ok(capture.evidence!.durationMs >= POLICY.minStableDurationMs);
    assert.equal(capture.deviceId, 'sim-scale-001');
    assert.equal(capture.stabilityPolicyVersion, POLICY.version);
    assert.equal(capture.representativeMethod, 'median');
    assert.ok(capture.candidateObservedAt !== undefined);
    assert.equal(validateWeightCapture(capture, { nowIso: capture.capturedAt }).ok, true);
  });
});

describe('CAPTURE INTENT — idempotency and cancellation', () => {
  test('the same requestId twice produces exactly one capture', () => {
    const { sim, state } = fresh();
    const events = placeAndSettle(sim, 250);
    const settled = run(state, events);
    const at = nowOf(events);

    const first = run(settled.state, [requestCapture(at, 'req-dup')]);
    assert.equal(first.captures.length, 1);

    const second = run(first.state, [requestCapture(at, 'req-dup')]);
    assert.equal(second.captures.length, 0, 'the repeat is idempotent');
    assert.equal(second.outputs[0]!.captureRejection, 'duplicate_request');
  });

  test('a cancelled request never captures, even once stability arrives', () => {
    const { sim, state } = fresh();
    const at = instant('2026-08-12T09:00:00.000Z');
    const armed = run(state, [requestCapture(at, 'req-cancel')]);
    const cancelled = run(armed.state, [cancelCapture('req-cancel', at)]);

    const settled = run(cancelled.state, placeAndSettle(sim, 250));
    assert.equal(settled.captures.length, 0);
    assert.equal(settled.state.phase, 'stable', 'the candidate exists but nobody wants it');
  });

  test('cancelling an unknown or completed request changes nothing', () => {
    const { sim, state } = fresh();
    const done = settleAndRequest(sim, state, 250);
    const after = run(done.state, [cancelCapture('never-existed', instant('2026-08-12T09:10:00.000Z'))]);
    assert.equal(after.captures.length, 0);
  });

  test('terminal request history stays bounded, and never evicts the pending one', () => {
    const { sim, state } = fresh();
    let current = state;
    // Complete many captures so terminal history grows.
    for (let i = 0; i < 25; i++) {
      sim.clearPlatform();
      current = reduceAll(current, sim.emitSteady(2), POLICY).state;
      const events = placeAndSettle(sim, 100 + i);
      current = reduceAll(current, events, POLICY).state;
      current = reduceCapture(current, requestCapture(nowOf(events), `r-${i}`), POLICY).state;
    }
    assert.ok(current.terminalRequests.length <= 16, 'terminal history is bounded');

    sim.clearPlatform();
    current = reduceAll(current, sim.emitSteady(2), POLICY).state;
    const armed = reduceCapture(current, requestCapture(instant('2026-08-12T20:00:00.000Z'), 'still-pending'), POLICY);
    assert.equal(armed.state.pendingCaptureRequest!.requestId, 'still-pending');
  });
});

describe('CANDIDATE INVALIDATION', () => {
  test('a material portion change invalidates the candidate', () => {
    const { sim, state } = fresh();
    const first = run(state, placeAndSettle(sim, 150));
    assert.equal(first.state.phase, 'stable');
    assert.ok(approx(first.state.candidate!.grams, 150, 1e-9));

    sim.setGross(250);
    const changed = run(first.state, sim.emitSteady(2));
    assert.equal(changed.state.phase, 'stabilizing');
    assert.equal(changed.state.candidate, null, 'the 150 g candidate is gone');

    const resettled = run(changed.state, sim.emitSteady(5));
    assert.ok(approx(resettled.state.candidate!.grams, 250, 1e-9));
  });

  test('clearing the platform invalidates the candidate', () => {
    const { sim, state } = fresh();
    const settled = run(state, placeAndSettle(sim, 250));
    sim.clearPlatform();
    const cleared = run(settled.state, sim.emitSteady(2));
    assert.equal(cleared.state.phase, 'ready');
    assert.equal(cleared.state.candidate, null);
  });

  test('a tare invalidates the candidate', () => {
    const { sim, state } = fresh();
    const settled = run(state, placeAndSettle(sim, 250));
    assert.ok(settled.state.candidate !== null);
    const tared = run(settled.state, sim.tare());
    assert.equal(tared.state.candidate, null);
    assert.equal(tared.state.phase, 'ready');
  });

  test('a stale candidate before a tare cannot be captured after it', () => {
    const { sim, state } = fresh();
    const events = placeAndSettle(sim, 250);
    const settled = run(state, events);
    const tared = run(settled.state, sim.tare());
    const requested = run(tared.state, [requestCapture(nowOf(events))]);
    assert.equal(requested.captures.length, 0);
  });

  for (const status of ['overload', 'calibration_required', 'fault'] as const) {
    test(`${status} invalidates the candidate and blocks capture`, () => {
      const { sim, state } = fresh();
      const settled = run(state, placeAndSettle(sim, 250));
      assert.ok(settled.state.candidate !== null);

      sim.setStatus(status);
      const blocked = run(settled.state, sim.emitSteady(3));
      assert.equal(blocked.state.phase, status);
      assert.equal(blocked.state.candidate, null);

      const requested = run(blocked.state, [requestCapture(instant('2026-08-12T09:30:00.000Z'))]);
      assert.equal(requested.captures.length, 0);
      assert.equal(requested.outputs[0]!.captureRejection, 'device_not_ready');
    });
  }

  test('a disconnect invalidates the candidate, and it does not survive reconnect', () => {
    const { sim, state } = fresh();
    const settled = run(state, placeAndSettle(sim, 250));
    const dropped = run(settled.state, [sim.disconnect()]);
    assert.equal(dropped.state.candidate, null);

    const reconnected = run(dropped.state, [sim.connect()]);
    assert.equal(reconnected.state.candidate, null);
    assert.equal(reconnected.state.phase, 'ready');

    const requested = run(reconnected.state, [requestCapture(instant('2026-08-12T09:30:00.000Z'))]);
    assert.equal(requested.captures.length, 0);
  });

  test('a stale candidate is not used by a late capture request', () => {
    const { sim, state } = fresh();
    const events = placeAndSettle(sim, 250);
    const settled = run(state, events);

    // Far beyond maxStableCandidateAgeMs, with no fresh readings since.
    const late = run(settled.state, [requestCapture(instant('2026-08-12T10:00:00.000Z'), 'req-late')]);
    assert.equal(late.captures.length, 0);
    assert.equal(late.outputs[0]!.captureRejection, 'candidate_stale');

    // The intent stays armed and fires on the next fresh candidate.
    const refreshed = run(late.state, sim.emitSteady(4));
    assert.equal(refreshed.captures.length, 1);
  });
});

describe('SCENARIO — unstable portion', () => {
  test('large deterministic jitter never produces a candidate', () => {
    const { sim, state } = fresh();
    sim.setGross(250);
    const { captures, state: final } = run(state, sim.emitSteady(12, [0, 6, -5, 8, -7, 4]));
    assert.equal(captures.length, 0);
    assert.equal(final.phase, 'stabilizing');
    assert.equal(final.candidate, null);
  });
});

describe('SCENARIO — slow settling', () => {
  test('a ramp becomes capturable only once fully settled', () => {
    const { sim, state } = fresh();
    const armed = run(state, [requestCapture(instant('2026-08-12T09:00:00.000Z'))]);
    const mid = run(armed.state, sim.emitRamp(300, 8));
    assert.equal(mid.captures.length, 0, 'a moving load is never captured');

    const settled = run(mid.state, sim.emitSteady(5));
    assert.equal(settled.captures.length, 1);
    assert.ok(approx(settled.captures[0]!.grams, 300, 1e-9));
  });
});

describe('SCENARIO — duplicate capture prevention', () => {
  test('leaving 250 g on the scale cannot satisfy another request', () => {
    const { sim, state } = fresh();
    const first = settleAndRequest(sim, state, 250);
    assert.equal(first.captures.length, 1);
    assert.equal(first.state.phase, 'awaiting_clear');

    const stillThere = run(first.state, sim.emitSteady(20));
    assert.equal(stillThere.captures.length, 0);
    assert.equal(stillThere.state.phase, 'awaiting_clear');

    const asked = run(stillThere.state, [requestCapture(instant('2026-08-12T09:40:00.000Z'), 'req-again')]);
    assert.equal(asked.captures.length, 0, 'the same portion cannot be captured twice');
    assert.equal(asked.outputs[0]!.captureRejection, 'awaiting_clear');
  });

  test('removing the food re-arms the scale for the next portion', () => {
    const { sim, state } = fresh();
    const first = settleAndRequest(sim, state, 250);

    sim.clearPlatform();
    const cleared = run(first.state, sim.emitSteady(2));
    assert.equal(cleared.state.phase, 'ready');

    const second = settleAndRequest(sim, cleared.state, 120);
    assert.equal(second.captures.length, 1);
    assert.ok(approx(second.captures[0]!.grams, 120, 1e-9));
  });
});

describe('REPRESENTATIVE METHOD and RESOLUTION', () => {
  test('median resists an isolated edge-of-window jitter value', () => {
    let w = EMPTY_WINDOW;
    for (const [atMs, g] of [[0, 250], [300, 250], [700, 251]] as const) {
      w = pushSample(w, { atMs, grams: g, tareGeneration: 0 }, POLICY);
    }
    const e = evaluateStability(w, POLICY);
    assert.equal(e.stable, true);
    assert.equal(e.representativeGrams, 250, 'median, not the trailing 251');
  });

  test('the method is policy-driven, not hard-coded', () => {
    const latestPolicy = { ...POLICY, representativeMethod: 'latest' as const };
    let w = EMPTY_WINDOW;
    for (const [atMs, g] of [[0, 250], [300, 250], [700, 251]] as const) {
      w = pushSample(w, { atMs, grams: g, tareGeneration: 0 }, latestPolicy);
    }
    assert.equal(evaluateStability(w, latestPolicy).representativeGrams, 251);
  });

  test('the accepted value respects the declared device resolution', () => {
    assert.equal(quantizeToResolution(250.5, 1, 'nearest_resolution'), 251);
    assert.equal(quantizeToResolution(250.4, 1, 'nearest_resolution'), 250);
    assert.equal(quantizeToResolution(250.5, 5, 'nearest_resolution'), 250);
    assert.equal(quantizeToResolution(253, 5, 'nearest_resolution'), 255);
    assert.equal(quantizeToResolution(250.5, 1, 'none'), 250.5);
  });

  test('a candidate is quantized to whole grams on 1 g hardware', () => {
    const { sim, state } = fresh();
    sim.setGross(250);
    const settled = run(state, sim.emitSteady(6, [0.4, -0.3, 0.2]));
    const candidate = settled.state.candidate!;
    assert.equal(Number.isInteger(candidate.grams), true, `got ${candidate.grams}`);
    assert.equal(candidate.resolutionGrams, 1);
  });
});

describe('SCENARIO — tare', () => {
  test('a tare zeroes the net weight and increments the generation exactly once', () => {
    const { sim, state } = fresh();
    sim.setGross(300);
    const withContainer = run(state, sim.emitSteady(2));
    const tared = run(withContainer.state, sim.tare());
    assert.equal(tared.state.session!.tareGeneration, 1);
    assert.equal(tared.state.phase, 'ready');

    sim.setGross(300 + 180);
    const foodEvents = sim.emitSteady(6);
    const settled = run(tared.state, foodEvents);
    assert.ok(approx(settled.state.candidate!.grams, 180, 1e-9), 'net food weight only');

    const captured = run(settled.state, [requestCapture(nowOf(foodEvents))]);
    assert.equal(captured.captures[0]!.tareGeneration, 1);
  });

  test('pre-tare samples are discarded from the window', () => {
    const { sim, state } = fresh();
    sim.setGross(200);
    const before = run(state, sim.emitSteady(2));
    assert.ok(before.state.window.samples.length > 0);
    const tared = run(before.state, sim.tare());
    assert.equal(tared.state.window.samples.length, 0);
  });

  test('tare failure is visible and changes nothing', () => {
    const { sim, state } = fresh();
    sim.setGross(300);
    const withContainer = run(state, sim.emitSteady(2));
    const failed = run(withContainer.state, sim.tare('failed'));
    assert.equal(failed.state.session!.tareGeneration, 0);
    assert.equal(failed.state.pendingCommand, null, 'the command is still resolved');
  });
});

describe('SCENARIO — negative drift', () => {
  test('slightly negative raw readings never become a negative food capture', () => {
    const { sim, state } = fresh();
    sim.setGross(0);
    const { captures, state: final } = run(state, sim.emitSteady(8, [-0.4, -1.2, -0.8, 0.3]));
    assert.equal(captures.length, 0);
    assert.equal(final.phase, 'ready');
  });

  test('a raw reading may be negative; a food capture may not', () => {
    const { sim } = fresh();
    sim.setGross(-1);
    const event = sim.emit();
    if (event.kind !== 'reading') throw new Error('expected reading');
    assert.ok(event.reading.netWeightGrams < 0, 'raw values are not clamped');
    assert.equal(validateReading(event.reading).ok, true);
  });
});

describe('SCENARIO — overload, calibration, fault recovery', () => {
  test('overload comes from the hardware flag, not a software gram threshold', () => {
    const { sim, state } = fresh();
    sim.setGross(1000);
    sim.setStatus('overload');
    const blocked = run(state, sim.emitSteady(6));
    assert.equal(blocked.state.phase, 'overload');
    assert.equal(blocked.captures.length, 0);
  });

  test('recovery requires an OK status and a clear platform', () => {
    const { sim, state } = fresh();
    sim.setGross(250);
    sim.setStatus('overload');
    const blocked = run(state, sim.emitSteady(3));

    sim.setStatus('ok');
    const stillLoaded = run(blocked.state, sim.emitSteady(2));
    assert.equal(stillLoaded.state.phase, 'awaiting_clear');

    sim.clearPlatform();
    const cleared = run(stillLoaded.state, sim.emitSteady(2));
    assert.equal(cleared.state.phase, 'ready');
  });
});

describe('SESSION AND PROTOCOL INTEGRITY', () => {
  test('a disconnect for a DIFFERENT device does not drop the current one', () => {
    const { sim, state } = fresh();
    const settled = run(state, placeAndSettle(sim, 250));
    const other = run(settled.state, [{
      kind: 'disconnected', at: instant('2026-08-12T09:30:00.000Z'),
      deviceId: 'some-other-scale', reason: 'link_lost',
    }]);
    assert.equal(other.state.phase, 'stable', 'device A is untouched');
    assert.ok(other.state.candidate !== null);
  });

  test('a reading while disconnected cannot produce a capture', () => {
    const { sim, state } = fresh();
    const settled = run(state, sim.emitSteady(5));
    const stray = sim.emit();
    const dropped = run(settled.state, [sim.disconnect()]);
    const orphan = reduceCapture(dropped.state, stray, POLICY);
    assert.equal(orphan.capture, null);
    assert.equal(orphan.admission, 'rejected_unknown_device');
  });

  test('reconnect cannot reuse a stale stable window', () => {
    const { sim, state } = fresh();
    sim.setGross(250);
    const almost = run(state, sim.emitSteady(2));
    const dropped = run(almost.state, [sim.disconnect()]);
    const reconnected = run(dropped.state, [sim.connect()]);
    assert.equal(reconnected.state.window.samples.length, 0);
    assert.equal(run(reconnected.state, sim.emitSteady(1)).captures.length, 0);
  });

  test('a reading with an unknown boot id does NOT authorize a reboot', () => {
    const { sim, state } = fresh();
    const connected = run(state, sim.emitSteady(1));
    sim.reboot();
    sim.setGross(250);
    const afterReboot = run(connected.state, sim.emitSteady(4));
    assert.equal(afterReboot.outputs[0]!.admission, 'rejected_boot_mismatch');
    assert.equal(afterReboot.state.session!.bootId, 'boot-0', 'only a connection changes the boot');
  });

  test('a validated connection establishes the new boot after a reboot', () => {
    const { sim, state } = fresh();
    const before = run(state, sim.emitSteady(2));
    sim.reboot();
    const after = run(before.state, [sim.connect()]);
    assert.equal(after.state.session!.bootId, 'boot-1');
    assert.equal(after.state.session!.lastSequence, null);
    assert.equal(after.state.session!.tareGeneration, 0);
  });

  test('a malformed capabilities payload does not establish a session', () => {
    const { sim, state } = fresh();
    const bad = run(state, [{
      kind: 'connected', at: instant('2026-08-12T09:00:00.000Z'), bootId: 'boot-x', tareGeneration: 0,
      capabilities: { ...sim.capabilities, resolutionGrams: 0 },
    }]);
    assert.equal(bad.state.session!.bootId, 'boot-0', 'the existing session is untouched');
  });

  test('an unsupported protocol version on connect is refused', () => {
    const { sim, state } = fresh();
    const bad = run(state, [{
      kind: 'connected', at: instant('2026-08-12T09:00:00.000Z'), bootId: 'boot-x', tareGeneration: 0,
      capabilities: { ...sim.capabilities, protocolVersion: 'scale-protocol@0.0.0' },
    }]);
    assert.equal(bad.state.session!.bootId, 'boot-0');
  });

  test('capabilities validation rejects malformed declarations', () => {
    const { sim } = fresh();
    assert.equal(validateCapabilities(sim.capabilities).ok, true);
    assert.equal(validateCapabilities({ ...sim.capabilities, deviceId: '' }).ok, false);
    assert.equal(validateCapabilities({ ...sim.capabilities, maxWeightGrams: 0 }).ok, false);
    assert.equal(validateCapabilities({ ...sim.capabilities, resolutionGrams: -1 }).ok, false);
  });

  test('a negative device uptime is rejected', () => {
    const { sim } = fresh();
    const event = sim.emit();
    if (event.kind !== 'reading') throw new Error('expected reading');
    assert.equal(validateReading({ ...event.reading, deviceUptimeMs: -5 }).ok, false);
  });
});

describe('COMMAND ACKNOWLEDGEMENT INTEGRITY', () => {
  const ackCtx = (overrides = {}) => ({
    deviceId: 'sim-scale-001',
    bootId: 'boot-0',
    tareGeneration: 0,
    pendingCommand: { commandId: 'cmd-1', kind: 'tare' as const, deviceId: 'sim-scale-001', bootId: 'boot-0' },
    ...overrides,
  });
  const baseAck = {
    protocolVersion: SCALE_PROTOCOL_VERSION,
    commandId: 'cmd-1',
    deviceId: 'sim-scale-001',
    bootId: 'boot-0',
    kind: 'tare' as const,
    outcome: 'applied' as const,
    tareGeneration: 1,
  };

  test('a valid next-generation tare ack is accepted', () => {
    assert.equal(validateCommandAck(baseAck, ackCtx()).ok, true);
  });

  const rejections: [string, Record<string, unknown>, string][] = [
    ['wrong protocol', { protocolVersion: 'v0' }, 'protocol_version_mismatch'],
    ['wrong device', { deviceId: 'other' }, 'device_mismatch'],
    ['wrong boot', { bootId: 'boot-9' }, 'boot_mismatch'],
    ['wrong commandId', { commandId: 'cmd-99' }, 'command_id_mismatch'],
    ['wrong kind', { kind: 'zero' }, 'command_kind_mismatch'],
    ['missing generation', { tareGeneration: undefined }, 'missing_tare_generation'],
    ['lower generation', { tareGeneration: 0 }, 'invalid_tare_generation'],
    ['arbitrary jump', { tareGeneration: 7 }, 'invalid_tare_generation'],
  ];

  for (const [name, overrides, expected] of rejections) {
    test(`${name} is rejected as ${expected}`, () => {
      const r = validateCommandAck({ ...baseAck, ...overrides } as never, ackCtx());
      assert.equal(r.ok, false);
      if (!r.ok) assert.equal(r.error, expected);
    });
  }

  test('an unsolicited ack has no pending command and is rejected', () => {
    const r = validateCommandAck(baseAck, ackCtx({ pendingCommand: null }));
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error, 'no_pending_command');
  });

  test('an unsolicited successful tare ack does not change scale state', () => {
    const { sim, state } = fresh();
    sim.setGross(300);
    const loaded = run(state, sim.emitSteady(2));
    const spoofed = run(loaded.state, [sim.unsolicitedTareAck()]);
    assert.equal(spoofed.state.session!.tareGeneration, 0, 'tare generation is unchanged');
    assert.equal(spoofed.outputs[0]!.ackRejection, 'no_pending_command');
  });

  test('a duplicate ack for an already-resolved command is rejected', () => {
    const { sim, state } = fresh();
    sim.setGross(300);
    const loaded = run(state, sim.emitSteady(2));
    const tareEvents = sim.tare();
    const tared = run(loaded.state, tareEvents);
    assert.equal(tared.state.session!.tareGeneration, 1);

    const replay = run(tared.state, [tareEvents[1]!]);
    assert.equal(replay.state.session!.tareGeneration, 1, 'no second increment');
    assert.equal(replay.outputs[0]!.ackRejection, 'no_pending_command');
  });
});

describe('TARE GENERATION SYNCHRONIZATION', () => {
  const session: ScaleSession = {
    deviceId: 'sim-scale-001', bootId: 'boot-0', lastSequence: 5, tareGeneration: 1,
  };
  const base = {
    protocolVersion: SCALE_PROTOCOL_VERSION,
    deviceId: 'sim-scale-001',
    bootId: 'boot-0',
    sequence: 6,
    netWeightGrams: 100,
    tareGeneration: 1,
    status: 'ok' as const,
  };

  test('a matching generation is accepted', () => {
    assert.equal(admitReading(session, base).admission, 'accepted');
  });

  test('an older generation is rejected', () => {
    assert.equal(admitReading(session, { ...base, tareGeneration: 0 }).admission, 'rejected_old_tare_generation');
  });

  test('a HIGHER generation never silently jumps the session', () => {
    const r = admitReading(session, { ...base, tareGeneration: 2 });
    assert.equal(r.admission, 'rejected_unexpected_tare_generation');
    assert.equal(r.session.tareGeneration, 1, 'the session is unchanged');
  });

  test('all admission outcomes are deterministic and named', () => {
    assert.equal(admitReading(session, { ...base, sequence: 5 }).admission, 'ignored_duplicate');
    assert.equal(admitReading(session, { ...base, sequence: 4 }).admission, 'rejected_out_of_order');
    assert.equal(admitReading(session, { ...base, bootId: 'boot-9' }).admission, 'rejected_boot_mismatch');
    assert.equal(admitReading(session, { ...base, deviceId: 'other' }).admission, 'rejected_unknown_device');
    assert.equal(admitReading(session, { ...base, protocolVersion: 'v0' }).admission, 'rejected_protocol_version');
    assert.equal(admitReading(session, { ...base, netWeightGrams: Number.NaN }).admission, 'rejected_malformed');
  });
});

describe('SCENARIO — duplicate and out-of-order packets', () => {
  test('a duplicate frame is ignored, not double processed', () => {
    const { sim, state } = fresh();
    sim.setGross(250);
    const first = sim.emit();
    const afterFirst = run(state, [first]);
    const before = afterFirst.state.window.samples.length;
    const dup = reduceCapture(afterFirst.state, sim.duplicateLast(first), POLICY);
    assert.equal(dup.admission, 'ignored_duplicate');
    assert.equal(dup.state.window.samples.length, before);
  });

  test('an out-of-order frame is rejected', () => {
    const { sim, state } = fresh();
    sim.setGross(250);
    const events = sim.emitSteady(3);
    const settled = run(state, events);
    const late = sim.outOfOrder(events[2]!, 2);
    assert.equal(reduceCapture(settled.state, late, POLICY).admission, 'rejected_out_of_order');
  });

  test('duplicate frames cannot manufacture a stable candidate', () => {
    const { sim, state } = fresh();
    sim.setGross(250);
    const first = sim.emit();
    let current = run(state, [first]).state;
    for (let i = 0; i < 10; i++) {
      const result = reduceCapture(current, sim.duplicateLast(first), POLICY);
      current = result.state;
      assert.equal(result.state.candidate, null);
    }
  });
});

describe('SCENARIO — manual override', () => {
  test('a manual entry carries truthful provenance only', () => {
    const { state } = fresh();
    const result = reduceCapture(
      state,
      { kind: 'manual_entry', at: instant('2026-08-12T09:05:00.000Z'), grams: 185 },
      POLICY,
    );
    const capture = result.capture!;
    assert.equal(capture.source, 'manual');
    assert.equal(capture.grams, 185);
    assert.equal(capture.deviceId, undefined);
    assert.equal(capture.evidence, undefined, 'no stability evidence is fabricated');
    assert.equal(capture.stabilityPolicyVersion, undefined, 'no policy produced this weight');
    assert.equal(validateWeightCapture(capture, { nowIso: '2026-08-12T09:05:00.000Z' }).ok, true);
  });

  test('a manual capture claiming stability evidence is rejected by the validator', () => {
    const dishonest: WeightCapture = {
      grams: manualCapture(185, instant('2026-08-12T09:05:00.000Z')).grams,
      source: 'manual',
      capturedAt: instant('2026-08-12T09:05:00.000Z'),
      stabilityPolicyVersion: POLICY.version,
    };
    assert.equal(validateWeightCapture(dishonest, { nowIso: '2026-08-12T09:05:00.000Z' }).ok, false);
  });

  test('a manual entry must be a positive food weight', () => {
    const { state } = fresh();
    for (const g of [0, -5, Number.NaN]) {
      const r = reduceCapture(state, { kind: 'manual_entry', at: instant('2026-08-12T09:05:00.000Z'), grams: g }, POLICY);
      assert.equal(r.capture, null);
    }
    assert.throws(() => manualCapture(0, instant('2026-08-12T09:05:00.000Z')));
  });

  test('downstream nutrition does not need to know how the weight was acquired', () => {
    const scaleCapture = (() => {
      const { sim, state } = fresh();
      return settleAndRequest(sim, state, 185).captures[0]!;
    })();
    const manual = manualCapture(185, instant('2026-08-12T09:05:00.000Z'));
    const consume = (c: WeightCapture): number => c.grams;
    assert.equal(consume(scaleCapture), consume(manual));
    assert.notEqual(scaleCapture.source, manual.source);
  });
});

describe('determinism', () => {
  test('replaying the same event sequence yields identical output', () => {
    const build = () => {
      const sim = new ScaleSimulator();
      const start = initialState(POLICY);
      const placement = [sim.connect(), ...placeAndSettle(sim, 250)];
      const events: WeightCaptureEvent[] = [...placement, requestCapture(nowOf(placement), 'fixed-req')];
      return reduceAll(start, events, POLICY).captures;
    };
    assert.equal(JSON.stringify(build()), JSON.stringify(build()));
  });

  test('the full lifecycle passes through every phase', () => {
    const { sim, state } = fresh();
    const phases = new Set<string>([state.phase]);
    let current = state;
    const record = (events: WeightCaptureEvent[]) => {
      for (const e of events) {
        const r = reduceCapture(current, e, POLICY);
        current = r.state;
        phases.add(current.phase);
      }
    };
    record([sim.connect()]);
    const placement = placeAndSettle(sim, 250);
    record(placement);
    record([requestCapture(nowOf(placement))]);
    sim.clearPlatform();
    record(sim.emitSteady(2));
    record([sim.disconnect()]);

    for (const expected of ['disconnected', 'ready', 'stabilizing', 'stable', 'awaiting_clear']) {
      assert.ok(phases.has(expected), `phase ${expected} was never reached`);
    }
  });

  test('every emitted capture passes the contract validator', () => {
    const { sim, state } = fresh();
    const { captures } = settleAndRequest(sim, state, 250);
    for (const c of captures) unwrap(validateWeightCapture(c, { nowIso: c.capturedAt }));
  });
});

describe('SINGLE ACTIVE INTENT — an intent for food A never attaches to food B', () => {
  test('a second request is refused while one is already pending', () => {
    const { state } = fresh();
    const a = run(state, [requestCapture(instant('2026-08-12T09:00:00.000Z'), 'req-A')]);
    assert.equal(a.state.pendingCaptureRequest!.requestId, 'req-A');

    const b = run(a.state, [requestCapture(instant('2026-08-12T09:00:01.000Z'), 'req-B')]);
    assert.equal(b.outputs[0]!.captureRejection, 'capture_request_already_pending');
    assert.equal(b.state.pendingCaptureRequest!.requestId, 'req-A', 'the first request is never superseded');
  });

  test('an intent does NOT leak to the next portion when the platform clears first', () => {
    const { sim, state } = fresh();
    sim.setGross(150);
    const armed = run(state, [...sim.emitSteady(2), requestCapture(instant('2026-08-12T09:00:00.000Z'), 'req-A')]);
    assert.ok(armed.state.pendingCaptureRequest !== null);

    // The user takes the food away before identifying it.
    sim.clearPlatform();
    const cleared = run(armed.state, sim.emitSteady(2));
    assert.equal(cleared.state.pendingCaptureRequest, null);
    assert.ok(cleared.outputs.some((o) => o.intentCancelled === 'platform_cleared'));

    // A completely different food is placed and settles.
    const next = run(cleared.state, placeAndSettle(sim, 400));
    assert.equal(next.captures.length, 0, 'food A intent must never capture food B');
    assert.equal(next.state.phase, 'stable');
  });

  test('a request rejected during awaiting_clear is NOT armed', () => {
    const { sim, state } = fresh();
    const captured = settleAndRequest(sim, state, 250);
    assert.equal(captured.state.phase, 'awaiting_clear');

    const refused = run(captured.state, [requestCapture(instant('2026-08-12T09:30:00.000Z'), 'req-B')]);
    assert.equal(refused.outputs[0]!.captureRejection, 'awaiting_clear');
    assert.equal(refused.state.pendingCaptureRequest, null, 'a refused request is never armed');

    sim.clearPlatform();
    const cleared = run(refused.state, sim.emitSteady(2));
    const foodC = run(cleared.state, placeAndSettle(sim, 300));
    assert.equal(foodC.captures.length, 0, 'req-B must not capture food C');
  });

  test('a fault does not preserve intent across recovery', () => {
    const { sim, state } = fresh();
    sim.setGross(150);
    const armed = run(state, [...sim.emitSteady(2), requestCapture(instant('2026-08-12T09:00:00.000Z'), 'req-A')]);

    sim.setStatus('fault');
    const faulted = run(armed.state, sim.emitSteady(2));
    assert.equal(faulted.state.pendingCaptureRequest, null);
    assert.ok(faulted.outputs.some((o) => o.intentCancelled === 'device_fault'));

    sim.setStatus('ok');
    sim.clearPlatform();
    const recovered = run(faulted.state, sim.emitSteady(2));
    const next = run(recovered.state, placeAndSettle(sim, 250));
    assert.equal(next.captures.length, 0);
  });

  test('a tare does not preserve intent', () => {
    const { sim, state } = fresh();
    sim.setGross(300);
    const armed = run(state, [...sim.emitSteady(2), requestCapture(instant('2026-08-12T09:00:00.000Z'), 'req-A')]);
    assert.ok(armed.state.pendingCaptureRequest !== null);

    const tared = run(armed.state, sim.tare());
    assert.equal(tared.state.pendingCaptureRequest, null);
    assert.ok(tared.outputs.some((o) => o.intentCancelled === 'tare_applied'));

    sim.setGross(300 + 200);
    const next = run(tared.state, sim.emitSteady(6));
    assert.equal(next.captures.length, 0, 'the pre-tare intent must not capture the new food');
  });

  test('a disconnect does not preserve intent', () => {
    const { sim, state } = fresh();
    sim.setGross(150);
    const armed = run(state, [...sim.emitSteady(2), requestCapture(instant('2026-08-12T09:00:00.000Z'), 'req-A')]);
    const dropped = run(armed.state, [sim.disconnect()]);
    assert.equal(dropped.state.pendingCaptureRequest, null);
    assert.ok(dropped.outputs.some((o) => o.intentCancelled === 'session_ended'));
  });

  test('a cancelled intent frees the slot for a new request', () => {
    const { state } = fresh();
    const a = run(state, [requestCapture(instant('2026-08-12T09:00:00.000Z'), 'req-A')]);
    const cancelled = run(a.state, [cancelCapture('req-A', instant('2026-08-12T09:00:01.000Z'))]);
    assert.equal(cancelled.state.pendingCaptureRequest, null);

    const b = run(cancelled.state, [requestCapture(instant('2026-08-12T09:00:02.000Z'), 'req-B')]);
    assert.equal(b.state.pendingCaptureRequest!.requestId, 'req-B');
  });
});

describe('CAPTURE REQUEST VALIDATION', () => {
  test('an empty requestId is refused', () => {
    const { state } = fresh();
    const r = run(state, [requestCapture(instant('2026-08-12T09:00:00.000Z'), '')]);
    assert.equal(r.outputs[0]!.captureRejection, 'invalid_request');
    assert.equal(r.state.pendingCaptureRequest, null);
  });

  test('a malformed timestamp is refused', () => {
    const { state } = fresh();
    const r = reduceCapture(state, { kind: 'capture_requested', requestId: 'req-x', at: instant('not-a-time') }, POLICY);
    assert.equal(r.captureRejection, 'invalid_request_time', 'a bad time is distinguished from a bad id');
  });

  test('a request timestamp BEFORE the candidate is time travel, and is refused', () => {
    const { sim, state } = fresh();
    const events = placeAndSettle(sim, 250);
    const settled = run(state, events);
    const observedAt = settled.state.candidate!.observedAt;
    const earlier = instant(new Date(Date.parse(observedAt) - 60_000).toISOString());

    const r = run(settled.state, [requestCapture(earlier, 'req-past')]);
    assert.equal(r.captures.length, 0);
    assert.equal(r.outputs[0]!.captureRejection, 'invalid_request_time');
    assert.equal(r.state.pendingCaptureRequest, null, 'time travel is not armed either');
  });
});

describe('PENDING COMMAND LIFECYCLE', () => {
  test('a second command issuance does not overwrite the pending one', () => {
    const { sim, state } = fresh();
    const first = sim.tare();
    const issued = run(state, [first[0]!]);
    const pendingId = issued.state.pendingCommand!.commandId;

    const second = sim.tare();
    const afterSecond = run(issued.state, [second[0]!]);
    assert.equal(afterSecond.state.pendingCommand!.commandId, pendingId, 'the first command stays authoritative');
  });

  test('a malformed command never enters the state machine', () => {
    const { sim, state } = fresh();
    const [issued] = sim.tare();
    if (issued!.kind !== 'command_issued') throw new Error('expected command_issued');
    const bad = { ...issued!, command: { ...issued!.command, commandId: '' } };
    const r = run(state, [bad]);
    assert.equal(r.state.pendingCommand, null);
    assert.equal(validateScaleCommand(bad.command).ok, false);
  });

  test('an unknown ack outcome does not clear the pending command', () => {
    const { sim, state } = fresh();
    const [issued, ack] = sim.tare();
    const withPending = run(state, [issued!]);
    if (ack!.kind !== 'command_ack') throw new Error('expected ack');
    const weird = { ...ack!, ack: { ...ack!.ack, outcome: 'maybe' as never } };
    const r = run(withPending.state, [weird]);
    assert.ok(r.state.pendingCommand !== null, 'the command is still in flight');
    assert.equal(r.outputs[0]!.ackRejection, 'malformed_ack');
  });

  test('a malformed tare generation does not resolve the command', () => {
    const { sim, state } = fresh();
    const [issued, ack] = sim.tare();
    const withPending = run(state, [issued!]);
    if (ack!.kind !== 'command_ack') throw new Error('expected ack');
    const bad = { ...ack!, ack: { ...ack!.ack, tareGeneration: 1.5 } };
    const r = run(withPending.state, [bad]);
    assert.equal(r.outputs[0]!.ackRejection, 'malformed_ack');
    assert.equal(r.state.session!.tareGeneration, 0);
  });
});

describe('SCALE CAPTURE PROVENANCE', () => {
  test('a scale capture explains how the accepted grams were produced', () => {
    const { sim, state } = fresh();
    const capture = settleAndRequest(sim, state, 250).captures[0]!;
    assert.equal(capture.resolutionGrams, 1);
    assert.equal(capture.resolutionQuantization, 'nearest_resolution');
    assert.equal(capture.representativeMethod, 'median');
    assert.equal(capture.stabilityPolicyVersion, POLICY.version);
  });

  test('manual provenance stays minimal — no resolution fields', () => {
    const manual = manualCapture(185, instant('2026-08-12T09:05:00.000Z'));
    assert.equal(manual.resolutionGrams, undefined);
    assert.equal(manual.resolutionQuantization, undefined);
    assert.equal(validateWeightCapture(manual, { nowIso: '2026-08-12T09:05:00.000Z' }).ok, true);
  });
});

describe('SINGLE ACTIVE CAPTURE INTENT', () => {
  test('a second distinct request is rejected while one is pending', () => {
    const { state } = fresh();
    const at = instant('2026-08-12T09:00:00.000Z');
    const a = run(state, [requestCapture(at, 'req-A')]);
    assert.equal(a.state.pendingCaptureRequest?.requestId, 'req-A');

    const b = run(a.state, [requestCapture(at, 'req-B')]);
    assert.equal(b.outputs[0]!.captureRejection, 'capture_request_already_pending');
    assert.equal(b.state.pendingCaptureRequest?.requestId, 'req-A', 'A is never superseded');
  });

  test('the application must cancel before issuing another request', () => {
    const { sim, state } = fresh();
    const at = instant('2026-08-12T09:00:00.000Z');
    const a = run(state, [requestCapture(at, 'req-A')]);
    const cancelled = run(a.state, [cancelCapture('req-A', at)]);
    assert.equal(cancelled.state.pendingCaptureRequest, null);

    const b = run(cancelled.state, [requestCapture(at, 'req-B')]);
    assert.equal(b.state.pendingCaptureRequest?.requestId, 'req-B');

    const settled = run(b.state, placeAndSettle(sim, 250));
    assert.equal(settled.captures.length, 1, 'only the surviving request captures');
  });

  test('REGRESSION: an intent for food A never attaches to food B', () => {
    const { sim, state } = fresh();
    // Request A while food A is settling.
    sim.setGross(150);
    const settlingEvents = sim.emitSteady(2);
    const settling = run(state, settlingEvents);
    const requested = run(settling.state, [requestCapture(nowOf(settlingEvents), 'req-A')]);
    assert.equal(requested.state.pendingCaptureRequest?.requestId, 'req-A');

    // Food A is removed before it ever settled.
    sim.clearPlatform();
    const cleared = run(requested.state, sim.emitSteady(2));
    assert.equal(cleared.state.pendingCaptureRequest, null, 'the intent died with the placement');
    assert.equal(cleared.state.lastCancellation?.reason, 'platform_cleared');

    // A completely different food is placed and settles.
    const foodB = run(cleared.state, placeAndSettle(sim, 400));
    assert.equal(foodB.captures.length, 0, 'food B is NOT captured by food A intent');
    assert.equal(foodB.state.phase, 'stable');
  });
});

describe('REJECTED REQUESTS ARE NOT ARMED', () => {
  test('a request during awaiting_clear is rejected and never captures a later portion', () => {
    const { sim, state } = fresh();
    const first = settleAndRequest(sim, state, 250);
    assert.equal(first.state.phase, 'awaiting_clear');

    const rejected = run(first.state, [requestCapture(instant('2026-08-12T09:40:00.000Z'), 'req-B')]);
    assert.equal(rejected.outputs[0]!.captureRejection, 'awaiting_clear');
    assert.equal(rejected.state.pendingCaptureRequest, null, 'not stored as pending');

    sim.clearPlatform();
    const cleared = run(rejected.state, sim.emitSteady(2));
    const foodC = run(cleared.state, placeAndSettle(sim, 300));
    assert.equal(foodC.captures.length, 0, 'request B does not capture food C');
  });

  for (const status of ['overload', 'calibration_required', 'fault'] as const) {
    test(`a request during ${status} is rejected and not armed`, () => {
      const { sim, state } = fresh();
      sim.setStatus(status);
      const blocked = run(state, sim.emitSteady(2));
      const rejected = run(blocked.state, [requestCapture(instant('2026-08-12T09:20:00.000Z'), 'req-X')]);
      assert.equal(rejected.outputs[0]!.captureRejection, 'device_not_ready');
      assert.equal(rejected.state.pendingCaptureRequest, null);
    });
  }

  test('a request while disconnected is rejected and not armed', () => {
    const { sim, state } = fresh();
    const dropped = run(state, [sim.disconnect()]);
    const rejected = run(dropped.state, [requestCapture(instant('2026-08-12T09:20:00.000Z'), 'req-X')]);
    assert.equal(rejected.outputs[0]!.captureRejection, 'device_not_ready');
    assert.equal(rejected.state.pendingCaptureRequest, null);
  });
});

describe('INVALIDATING EVENTS CANCEL AN UNFULFILLED INTENT', () => {
  const armed = () => {
    const { sim, state } = fresh();
    sim.setGross(200);
    const settling = run(state, sim.emitSteady(2));
    const requested = run(settling.state, [requestCapture(instant('2026-08-12T09:00:00.100Z'), 'req-A')]);
    assert.equal(requested.state.pendingCaptureRequest?.requestId, 'req-A');
    return { sim, state: requested.state };
  };

  test('a fault cancels the intent, and recovery does not resurrect it', () => {
    const { sim, state } = armed();
    sim.setStatus('fault');
    const faulted = run(state, sim.emitSteady(2));
    assert.equal(faulted.state.pendingCaptureRequest, null);
    assert.equal(faulted.state.lastCancellation?.reason, 'device_fault');

    sim.setStatus('ok');
    sim.clearPlatform();
    const recovered = run(faulted.state, sim.emitSteady(2));
    const newFood = run(recovered.state, placeAndSettle(sim, 300));
    assert.equal(newFood.captures.length, 0);
  });

  test('a tare cancels the intent', () => {
    const { sim, state } = armed();
    const tared = run(state, sim.tare());
    assert.equal(tared.state.pendingCaptureRequest, null);
    assert.equal(tared.state.lastCancellation?.reason, 'tare_applied');

    sim.setGross(200 + 180);
    const placed = run(tared.state, sim.emitSteady(6));
    assert.equal(placed.captures.length, 0, 'the pre-tare intent cannot capture post-tare food');
  });

  test('a disconnect cancels the intent and it does not survive reconnect', () => {
    const { sim, state } = armed();
    const dropped = run(state, [sim.disconnect()]);
    assert.equal(dropped.state.pendingCaptureRequest, null);
    assert.equal(dropped.state.lastCancellation?.reason, 'session_ended');

    const reconnected = run(dropped.state, [sim.connect()]);
    const newFood = run(reconnected.state, placeAndSettle(sim, 250));
    assert.equal(newFood.captures.length, 0);
  });

  test('a new session clears intent history', () => {
    const { sim, state } = armed();
    const reconnected = run(state, [sim.connect()]);
    assert.equal(reconnected.state.pendingCaptureRequest, null);
    assert.equal(reconnected.state.terminalRequests.length, 0);
  });
});

describe('CANDIDATE FRESHNESS — no time travel', () => {
  test('a request predating the candidate is refused, not armed', () => {
    const { sim, state } = fresh();
    const events = placeAndSettle(sim, 250);
    const settled = run(state, events);
    const observed = settled.state.candidate!.observedAt;
    const before = instant(new Date(Date.parse(observed) - 60_000).toISOString());

    const result = run(settled.state, [requestCapture(before, 'req-past')]);
    assert.equal(result.captures.length, 0);
    assert.equal(result.outputs[0]!.captureRejection, 'invalid_request_time');
    assert.equal(result.state.pendingCaptureRequest, null, 'an incoherent request is not armed');
  });

  test('an empty requestId is rejected', () => {
    const { sim, state } = fresh();
    const settled = run(state, placeAndSettle(sim, 250));
    const result = run(settled.state, [{ kind: 'capture_requested', requestId: '', at: instant('2026-08-12T09:10:00.000Z') }]);
    assert.equal(result.captures.length, 0);
    assert.equal(result.outputs[0]!.captureRejection, 'invalid_request');
  });

});

describe('PENDING COMMAND IS NOT OVERWRITTEN', () => {
  test('a second command issuance is a no-op while one is in flight', () => {
    const { sim, state } = fresh();
    const [issuedA] = sim.tare();
    const a = run(state, [issuedA!]);
    const firstId = a.state.pendingCommand!.commandId;

    const [issuedB] = sim.tare();
    const b = run(a.state, [issuedB!]);
    assert.equal(b.state.pendingCommand!.commandId, firstId, 'the first command stays authoritative');
  });

  test('a malformed command never enters the state machine', () => {
    const { sim, state } = fresh();
    const bad = run(state, [{
      kind: 'command_issued',
      at: instant('2026-08-12T09:00:00.000Z'),
      bootId: sim.currentBootId,
      command: { protocolVersion: SCALE_PROTOCOL_VERSION, commandId: '', deviceId: 'sim-scale-001', kind: 'tare' },
    }]);
    assert.equal(bad.state.pendingCommand, null);
  });

  test('a malformed ack cannot resolve a pending command', () => {
    const { sim, state } = fresh();
    const [issued, ack] = sim.tare();
    const a = run(state, [issued!]);
    if (ack!.kind !== 'command_ack') throw new Error('expected ack');
    const malformed = run(a.state, [{ ...ack!, ack: { ...ack!.ack, outcome: 'weird' as never } }]);
    assert.notEqual(malformed.state.pendingCommand, null, 'the command stays pending');
    assert.equal(malformed.state.session!.tareGeneration, 0);
  });
});
