import type { ScaleDeviceStatus, ScaleReading } from './messages.js';

/**
 * Session facts a single notification cannot carry.
 *
 * A BLE payload knows a weight; it does not know which connection it belongs
 * to, how many packets preceded it, or how many tares have been applied. The
 * adapter owns that context and supplies it, so the decoder stays a pure
 * bytes-to-number function.
 */
export interface BleReadingContext {
  readonly protocolVersion: string;
  readonly deviceId: string;
  readonly bootId: string;
  readonly sequence: number;
  readonly tareGeneration: number;
  readonly status: ScaleDeviceStatus;
}

/**
 * BLE DEVICE PROFILE.
 *
 * The one place a specific scale's Bluetooth details live: service and
 * characteristic UUIDs, and how its notification bytes become a reading.
 *
 * Everything above this — stability, capture, the food flow — is already frozen
 * and must not learn that Bluetooth exists. Isolating the profile means the
 * unknown parts of a real device block ONLY this file, and a second scale model
 * later is a new profile rather than a new weighing implementation.
 *
 * Nothing here invents a protocol. A profile is supplied by whoever has the
 * hardware evidence; `decode` returning null is the honest answer to bytes we
 * do not understand.
 */
export const DEVICE_PROFILE_VERSION = 'ble-device-profile@1.0.0';

export interface BleDeviceProfile {
  /** Human name for logs and the connection UI. */
  readonly name: string;
  /** GATT service advertised by the scale. */
  readonly serviceUuid: string;
  /** Characteristic that notifies weight measurements. */
  readonly weightCharacteristicUuid: string;
  /** Optional characteristic for tare/zero, when the device supports one. */
  readonly commandCharacteristicUuid?: string;
  /** Advertised name prefix used to filter scan results. */
  readonly advertisedNamePrefix?: string;

  /**
   * Turn one notification payload into a reading.
   *
   * Returns null for a payload this profile does not recognise. A malformed or
   * unexpected packet must never become a weight: an invented number here would
   * flow into a food log as though a scale had measured it.
   */
  decode(payload: Uint8Array, context: BleReadingContext): ScaleReading | null;
}

/**
 * The standard Bluetooth SIG Weight Scale service.
 *
 * Published and stable, so it is safe to state. Whether a given scale actually
 * implements it — many kitchen scales use a vendor-specific service instead —
 * is a question only the hardware can answer.
 */
export const BLUETOOTH_SIG_WEIGHT_SCALE = {
  serviceUuid: '0000181d-0000-1000-8000-00805f9b34fb',
  weightMeasurementUuid: '00002a9d-0000-1000-8000-00805f9b34fb',
} as const;

/**
 * Decode a Bluetooth SIG Weight Measurement characteristic.
 *
 * Layout per the specification: a flags byte, then a little-endian uint16
 * weight. Bit 0 of flags selects units — 0 is SI (0.005 kg resolution), 1 is
 * imperial (0.01 lb).
 *
 * Exported separately from the profile so it can be tested against known byte
 * patterns without any Bluetooth stack present.
 */
export function decodeSigWeightMeasurement(
  payload: Uint8Array,
  context: BleReadingContext,
): ScaleReading | null {
  if (payload.length < 3) return null;

  const flags = payload[0]!;
  const raw = payload[1]! | (payload[2]! << 8);

  // Imperial readings are converted once, here, where the unit is known.
  // Everything downstream works in grams only.
  const imperial = (flags & 0x01) === 1;
  const grams = imperial
    // 0.01 lb resolution -> grams.
    ? raw * 0.01 * 453.59237
    // 0.005 kg resolution -> grams. The spec's unit is kilograms, so the
    // resolution already includes the kilo: 40000 * 0.005 kg = 200 kg would be
    // wrong by a thousand. It is 5 g per count.
    : raw * 5;

  if (!Number.isFinite(grams) || grams < 0) return null;

  return {
    protocolVersion: context.protocolVersion,
    deviceId: context.deviceId,
    bootId: context.bootId,
    sequence: context.sequence,
    netWeightGrams: Math.round(grams * 10) / 10,
    tareGeneration: context.tareGeneration,
    status: context.status,
    // The SIG characteristic carries no stability flag. Even if it did, the
    // host runs its own deterministic policy and never trusts a firmware flag
    // for capture eligibility — so none is asserted here.
  };
}

/**
 * A profile for a scale implementing the standard SIG service.
 *
 * Usable as-is IF the owner's scale advertises 0x181D. Most consumer kitchen
 * scales do not, which is why `resolveProfile` refuses rather than guesses.
 */
export function sigWeightScaleProfile(): BleDeviceProfile {
  return {
    name: 'Bluetooth SIG Weight Scale',
    serviceUuid: BLUETOOTH_SIG_WEIGHT_SCALE.serviceUuid,
    weightCharacteristicUuid: BLUETOOTH_SIG_WEIGHT_SCALE.weightMeasurementUuid,
    decode: (payload, context) => decodeSigWeightMeasurement(payload, context),
  };
}

export type ProfileResolution =
  | { readonly resolved: true; readonly profile: BleDeviceProfile }
  | { readonly resolved: false; readonly reason: 'unknown_device_profile' };

/**
 * Choose a profile for a discovered device.
 *
 * Refuses when no profile matches. Guessing UUIDs or packet layouts would
 * produce a scale that appears to work and reports fabricated weights, which is
 * far worse than a scale that plainly says it is unsupported.
 */
export function resolveProfile(
  advertisedServiceUuids: readonly string[],
  known: readonly BleDeviceProfile[] = [],
): ProfileResolution {
  const advertised = advertisedServiceUuids.map((u) => u.toLowerCase());

  for (const profile of known) {
    if (advertised.includes(profile.serviceUuid.toLowerCase())) {
      return { resolved: true, profile };
    }
  }
  if (advertised.includes(BLUETOOTH_SIG_WEIGHT_SCALE.serviceUuid)) {
    return { resolved: true, profile: sigWeightScaleProfile() };
  }
  return { resolved: false, reason: 'unknown_device_profile' };
}
