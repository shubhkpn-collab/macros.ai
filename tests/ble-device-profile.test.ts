import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  BLUETOOTH_SIG_WEIGHT_SCALE, decodeSigWeightMeasurement, resolveProfile,
  sigWeightScaleProfile, type BleReadingContext,
} from '@macros/scale-protocol';

const context: BleReadingContext = {
  protocolVersion: 'scale-protocol@1.0.0',
  deviceId: 'scale-1',
  bootId: 'boot-1',
  sequence: 7,
  tareGeneration: 2,
  status: 'ok' as BleReadingContext['status'],
};

describe('DEMO — BLE device profile', () => {
  test('a SI measurement decodes to grams', () => {
    // flags 0x00 = SI. The spec's resolution is 0.005 KILOGRAMS, i.e. 5 g per
    // count, so 40 counts is 200 g. Reading it as 0.005 g would be out by a
    // factor of a thousand.
    const reading = decodeSigWeightMeasurement(
      new Uint8Array([0x00, 0x28, 0x00]), context);
    assert.notEqual(reading, null);
    assert.equal(reading!.netWeightGrams, 200);
  });

  test('an imperial measurement is converted once, at the edge', () => {
    // flags 0x01 = imperial. Everything downstream works in grams only.
    const reading = decodeSigWeightMeasurement(
      new Uint8Array([0x01, 0x64, 0x00]), context);
    assert.notEqual(reading, null);
    assert.ok(Math.abs(reading!.netWeightGrams - 453.6) < 0.2);
  });

  test('session context is carried, not invented', () => {
    const reading = decodeSigWeightMeasurement(
      new Uint8Array([0x00, 0x28, 0x00]), context)!;
    assert.equal(reading.bootId, 'boot-1');
    assert.equal(reading.sequence, 7);
    assert.equal(reading.tareGeneration, 2);
    assert.equal(reading.deviceId, 'scale-1');
  });

  test('a short or malformed payload yields NO reading', () => {
    // An invented number here would flow into a food log as though a scale had
    // measured it.
    assert.equal(decodeSigWeightMeasurement(new Uint8Array([]), context), null);
    assert.equal(decodeSigWeightMeasurement(new Uint8Array([0x00]), context), null);
    assert.equal(decodeSigWeightMeasurement(new Uint8Array([0x00, 0x01]), context), null);
  });

  test('no firmware stability flag is asserted', () => {
    const reading = decodeSigWeightMeasurement(
      new Uint8Array([0x00, 0x28, 0x00]), context)!;
    // The host runs its own deterministic stability policy; a device flag must
    // never decide capture eligibility.
    assert.equal((reading as { stable?: unknown }).stable, undefined);
  });

  test('a matching advertised service resolves', () => {
    const r = resolveProfile([BLUETOOTH_SIG_WEIGHT_SCALE.serviceUuid]);
    assert.equal(r.resolved, true);
    assert.equal(r.resolved && r.profile.weightCharacteristicUuid,
      BLUETOOTH_SIG_WEIGHT_SCALE.weightMeasurementUuid);
  });

  test('an unknown device is REFUSED, never guessed', () => {
    // A guessed UUID produces a scale that appears to work and reports
    // fabricated weights — worse than one that says it is unsupported.
    const r = resolveProfile(['0000fff0-0000-1000-8000-00805f9b34fb']);
    assert.equal(r.resolved, false);
    assert.equal(r.resolved === false && r.reason, 'unknown_device_profile');
  });

  test('a supplied vendor profile takes precedence', () => {
    const vendor = {
      ...sigWeightScaleProfile(),
      name: 'Owner scale',
      serviceUuid: '0000fff0-0000-1000-8000-00805f9b34fb',
      weightCharacteristicUuid: '0000fff1-0000-1000-8000-00805f9b34fb',
    };
    const r = resolveProfile([vendor.serviceUuid], [vendor]);
    assert.equal(r.resolved, true);
    assert.equal(r.resolved && r.profile.name, 'Owner scale');
  });

  test('the profile is the ONLY place hardware detail lives', async () => {
    const { readFileSync } = await import('node:fs');
    const { repoPath } = await import('../tools/repo-paths.js');
    // Stability, capture and the food flow must not learn Bluetooth exists.
    for (const f of ['stability-policy.ts', 'messages.ts', 'admission.ts']) {
      // Comments may DISCUSS transports; the code must carry no UUID or
      // characteristic handling.
      const code = readFileSync(repoPath('packages', 'scale-protocol', 'src', f), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      for (const banned of ['serviceUuid', 'characteristic', 'gatt']) {
        assert.equal(code.toLowerCase().includes(banned.toLowerCase()), false,
          `${f} contains transport detail: ${banned}`);
      }
    }
  });
});
