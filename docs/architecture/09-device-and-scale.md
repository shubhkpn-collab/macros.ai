# 09 — Device & Scale Communication Architecture

> **PARTIALLY SUPERSEDED — owner rulings A–H, 2026-08-10.** Where this document conflicts with `DECISION-LOCK.md`, the Decision Lock governs. See `CHANGE-REPORT.md`.


## 0. Tablet hardware (LOCKED — ruling F)

13.3" portrait display, ~2K resolution · 4 GB RAM minimum, 6 GB preferred · ~32 GB local storage preferred · Wi-Fi · Bluetooth 5.x · strong multi-microphone array with AEC/noise suppression · clear speakers · **no front-facing camera** · mains powered, no consumer battery · no user-facing USB (internal service port permitted) · aluminum or premium durable polymer enclosure, rugged for kitchen use · chemically strengthened/tempered cover glass with oleophobic coating · physical microphone mute control with clear indicator · ambient light sensor preferred · portrait-first industrial design · counter stand / mounting capability · CPU/RAM headroom reserved for a future small offline command model.

**Barcode:** not a reason to add a front camera. MVP-1 handles barcode through the companion phone. A discreet rear-facing scanner or dedicated 2D barcode module may be evaluated on supplier cost, reliability and industrial design — **not a Phase 0 blocker.**

## 1. Scale hardware

### LOCKED requirements (owner ruling F)

Wireless BLE · 0–5 kg target range · 1 g resolution target · high repeatability · tare · overload handling · stability detection · calibration support · **corner-load error controlled mechanically and qualified by test**.

### REFERENCE / TO EVALUATE — not locked

The following are **engineering and supplier decisions**, not owner-locked component selections. They are recorded as starting points for supplier conversations only:

| Area | Candidates to evaluate |
|---|---|
| Load-cell topology | single cell vs. four-cell bridge |
| ADC | 24-bit sigma-delta (HX711-class and alternatives) |
| MCU / radio | BLE 5.x SoC (nRF52-class and alternatives) |
| RTOS / framework | Zephyr, vendor SDK, bare metal |
| Power | rechargeable cell vs. replaceable vs. mains |
| Firmware storage | vendor NVS, external flash |

None of these is committed. Selection follows supplier characterization, particularly of settling behaviour and corner-load performance, which also determine the real stability policy values.

## 2. Transport-independent scale protocol (IMPLEMENTED)

> **Milestone status.** `packages/scale-protocol`, `packages/domain-weight` and `packages/scale-simulator` are implemented and verified. **No BLE, no firmware, no load-cell drivers** — the protocol is deliberately not bound to a transport yet.

`SCALE_PROTOCOL_VERSION = 'scale-protocol@1.0.0'`

The protocol is **logical, not wire-level**, so real BLE, a USB/service transport and the in-memory simulator can all carry the same messages and the capture logic is written once.

**Device messages:** `ScaleCapabilities` · `ScaleReading` · `ScaleCommand` · `ScaleCommandAck`.

**Event streams are separated by origin:**

```
ScaleEvent               connected · disconnected · reading · command_ack
ScaleCommandLifecycle    command_issued
CaptureIntentEvent       capture_requested · capture_cancelled · manual_entry
                              ↓
                       WeightCaptureEvent
                              ↓
                        state machine
```

The scale has no idea what food is selected; capture intent is host-originated and never arrives from the device.

**Design constraints the shape satisfies:**
- the scale needs **no wall clock** — ordering comes from `sequence`;
- **grams are canonical**; pounds and ounces convert at the presentation boundary only;
- `bootId` distinguishes **reconnect from reboot**;
- `tareGeneration` lets readings taken before a tare be invalidated afterwards;
- overload and fault are **explicit device status**, never inferred;
- `protocolVersion` travels with every message.

**Firmware stability flags are advisory.** `ScaleReading.firmwareStable` is retained for diagnostics and supplier comparison, but MACROS.AI never trusts it for capture eligibility — the host runs its own deterministic policy so behaviour is consistent across suppliers.

## 3. Reading vs capture — the pipeline

```
raw scale readings
  → validation
  → session admission
  → deterministic stability
  → StableWeightCandidate
  → explicit capture intent
  → WeightCapture
```

**A STABLE WEIGHT IS NOT AN ACCEPTED FOOD CAPTURE.** A settled mass may be a container, an unrelated object, a portion still being adjusted, or food whose identity has not been chosen yet. Stability therefore produces a `StableWeightCandidate`; only explicit host intent turns one into a `WeightCapture`.

A **`ScaleReading`** is sensor data and may be slightly negative from load-cell drift — raw values are never clamped. A **`WeightCapture`** is an accepted food weight, finite and greater than zero, and is the **only** thing permitted to enter the food/nutrition flow.

`WeightCapture` preserves provenance forever: `source` (`scale` | `manual`), and for a scale capture `deviceId`, `bootId`, `sequence`, `tareGeneration`, `stabilityPolicyVersion`, `representativeMethod`, `candidateObservedAt` and `evidence`. **A manual entry carries none of those** — it never used a stability policy, so claiming one would be a lie, and the validator rejects it.

## 4. Stability semantics

Thresholds are hardware and product tuning parameters held in a versioned `WeightStabilityPolicy`: minimum capture weight, clear band, observation window, minimum sample count, minimum stable duration, maximum spread, material-change threshold, maximum sample age, **representative method**, **resolution quantization**, and **maximum stable-candidate age**.

**No validated production policy ships.** `loadProductionStabilityPolicy()` returns `unavailable / pending_hardware_validation`. A clearly marked synthetic policy lives in the testkit.

Stability requires a **window, not one matching sample**. A material change restarts stabilization at the new level.

**Representative method is `median` by default, not the trailing sample.** A window of 250, 250, 251 should not become 251 g merely because 251 arrived last; median resists an isolated edge-of-window jitter value. The UI shows the accepted candidate once stability is reached, so the confirmed and captured weights still agree — raw instantaneous display behaviour must not dictate calculation accuracy.

**Resolution is respected.** The representative value is quantized to the device's declared `resolutionGrams` by a deterministic, policy-versioned round-half-up rule. A 250.5 g capture is not produced for 1 g hardware.

## 5. Capture lifecycle

```
disconnected → ready → stabilizing → stable → awaiting_clear → ready
                            ↘ overload / calibration_required / fault
```

`stable` means **a valid StableWeightCandidate currently exists** — not that a food was captured.

**Two flows, both supported:**
- *Stable first:* food settles, the user then identifies it, `capture_requested` captures immediately. The user must never have to lift and replace food simply because it settled before selection finished.
- *Request first:* `capture_requested` arms the intent, and the capture fires the moment a candidate appears.

**At most ONE capture intent may be pending at any instant.** A second distinct request is rejected `capture_request_already_pending` — never silently superseding the first. The application must cancel explicitly before issuing another.

**A rejected request is never armed.** A request arriving during `awaiting_clear`, `disconnected`, `overload`, `calibration_required` or `fault` is refused and not stored, so it cannot resurface and capture some later, unrelated portion. Intents may be armed only in `ready`, `stabilizing`, or `stable`-with-a-stale-candidate.

**An unfulfilled intent belongs to the current placement** and is cancelled when that placement ends: platform cleared, tare applied, overload/calibration/fault, disconnect, new session. The invariant — *an intent for food A may never attach itself to food B* — is regression-tested.

**Capture requests are idempotent** by `requestId`, with terminal history bounded; the pending request is never evicted to satisfy that bound. A request timestamp preceding the candidate it would capture is refused as `invalid_request_time` — staleness is `0 ≤ requestAt − observedAt ≤ maxStableCandidateAgeMs`, not merely an upper bound.

**A pending command is never silently overwritten.** A second `command_issued` is a no-op until the first resolves, and malformed commands and acknowledgements never enter the state machine.

**A candidate is invalidated by:** material weight change · clearing · tare · overload · calibration_required · fault · disconnect · reboot · a new session. It also **expires**: a request arriving after `maxStableCandidateAgeMs` will not use it, and instead waits for a fresh one.

**Duplicate prevention:** after a capture the machine enters `awaiting_clear`. The same portion sitting on the platform cannot satisfy another request until the scale returns to the validated clear band.

**Tare** is a two-step lifecycle — the host issues a command, the device acknowledges it. An acknowledgement **never** changes state merely because it says `applied`: it must match a genuinely pending command on the current device and boot, and an applied tare must carry exactly `currentGeneration + 1`. No missing value, no lower value, no arbitrary jump. Tare failure is visible and changes nothing.

**Tare generation never silently jumps.** An ordinary reading must carry exactly the session's generation; lower is `rejected_old_tare_generation`, higher is `rejected_unexpected_tare_generation`. A higher generation is adopted only via a validated acknowledgement or a new validated connection.

**Sessions:** a validated `connected` event is the only thing that establishes the current boot. A reading with an unknown boot id does **not** authorize a reboot — it is `rejected_boot_mismatch`. A `disconnected` event for a different device does not drop the current one.

**Admission outcomes:** `accepted` · `ignored_duplicate` · `rejected_out_of_order` · `rejected_unknown_device` · `rejected_boot_mismatch` · `rejected_old_tare_generation` · `rejected_unexpected_tare_generation` · `rejected_protocol_version` · `rejected_malformed`.

**Runtime validation** covers capabilities, readings, acknowledgements, and connect/disconnect payloads. Malformed messages are rejected; none may silently modify state.

## 6. Transport boundary (types only)

```ts
interface ScaleTransport {
  connect(deviceId): Promise<ScaleCapabilities>;
  disconnect(deviceId): Promise<void>;
  sendCommand(command: ScaleCommand): Promise<void>;
  subscribe(listener: (event: ScaleEvent) => void): () => void;
}
```

Deliberately unimplemented. **No BLE library chosen, no vendor UUIDs defined.** CI fails the build if a transport or React Native library is imported into the pure capture packages.

## 7. Hardware validation requirements

**Corner-load qualification is a hardware requirement, not a software feature.** MACROS.AI ships **no corner-load compensation** — off-centre error must be controlled mechanically, and correcting it in software without supplier characterization data would be fiction.

Every certified reference mass must be tested at `center`, `front_left`, `front_right`, `rear_left`, `rear_right` and any supplier-defined points, recording: measured error, repeatability, position, load, temperature where relevant, firmware version and calibration version. `CornerLoadQualification` defines the record shape; results are `PENDING_HARDWARE_VALIDATION`.

**Calibration mathematics is not implemented.** Only status, commands, acknowledgements and state transitions are modelled. The real procedure arrives with hardware and supplier specifications.

## 8. Open hardware decisions

Load cell and ADC selection · mechanical damping and settling time · real stability thresholds · plausible negative-drift band · overload trip point · temperature coefficients · secure element and secure boot · BLE stack and vendor UUIDs.

---

## 9. Historical note

Earlier drafts of this document contained BLE GATT sketches, OTA and fleet-management plans, and an assertion that stability detection would live in firmware. Those are **superseded and contradicted** by the architecture above — firmware stability is advisory and host policy is canonical. They have been removed so there is exactly one actionable scale architecture. The history is preserved in `CHANGE-REPORT.md`.
