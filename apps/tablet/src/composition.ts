import type { TabletAppController } from '@macros/tablet-app-core';
import type { OfflineCapabilities } from '@macros/domain-offline-sync';
import type { SharedDeviceAuthCoordinator } from '@macros/runtime-api';
import {
  buildViewModel, lockedViewModel, type TabletViewModel,
} from '@macros/tablet-view-model';

/**
 * PRODUCTION COMPOSITION ROOT.
 *
 * Wires the real application capabilities that exist today and names, as
 * explicit ports, the ones that need hardware. Nothing here decides nutrition,
 * energy or authorization — it observes the systems that already do.
 */
export const COMPOSITION_VERSION = 'tablet-composition@1.0.0';

/**
 * PORTS still awaiting hardware. Declared at the composition boundary so it is
 * obvious what is real and what is not — and so no component ever contains a
 * stub pretending to be a device.
 */
export interface TabletPorts {
  /** Physical mic + wake word + STT. Absent until the voice hardware milestone. */
  readonly voiceInput: {
    start(): void;
    stop(): void;
    readonly available: boolean;
  };
  /** BLE scale transport. `scale-protocol` is real; the Android radio is not. */
  readonly scaleTransport: {
    connect(): void;
    disconnect(): void;
    readonly available: boolean;
  };
  /** Reports live connectivity so offline status is truthful, not guessed. */
  readonly connectivity: {
    readonly backendReachable: boolean;
  };
}

export interface TabletComposition {
  readonly controller: TabletAppController;
  readonly coordinator: SharedDeviceAuthCoordinator;
  readonly ports: TabletPorts;
  /** Capabilities derived by the offline domain — never inferred in the UI. */
  capabilities(): OfflineCapabilities;
  recentFoods(): readonly { readonly displayName: string; readonly kcal: number }[];
  /** Active-energy resolution passed through on a user switch. */
  currentActivity(): Parameters<TabletAppController['switchActiveUser']>[1];
}

/**
 * Produce the view model for the current instant.
 *
 * `hasActiveSession` comes from the auth boundary. When it is false the LOCKED
 * model is returned and application state is never read — the previous
 * occupant's data has no path to the screen.
 */
export function renderModel(
  composition: TabletComposition,
  hasActiveSession: boolean,
): TabletViewModel {
  if (!hasActiveSession) return lockedViewModel();
  return buildViewModel({
    app: composition.controller.getState(),
    capabilities: composition.capabilities(),
    switchState: composition.coordinator.getState(),
    recent: composition.recentFoods(),
  });
}

/**
 * DEVELOPMENT LATENCY INSTRUMENTATION.
 *
 * Records real elapsed time for the transitions that decide whether this feels
 * like an appliance. Development only: no production performance is claimed
 * until it runs on the device.
 */
export class TransitionTimer {
  private readonly marks = new Map<string, number>();
  private readonly samples: { readonly label: string; readonly ms: number }[] = [];

  constructor(private readonly now: () => number = () => Date.now()) {}

  begin(label: string): void { this.marks.set(label, this.now()); }

  end(label: string): number | null {
    const started = this.marks.get(label);
    if (started === undefined) return null;
    this.marks.delete(label);
    const ms = this.now() - started;
    this.samples.push({ label, ms });
    return ms;
  }

  report(): readonly { readonly label: string; readonly ms: number }[] {
    return [...this.samples];
  }
}

/** The transitions worth measuring, named so they cannot drift apart. */
export const TRANSITIONS = {
  voiceFeedback: 'voice_state_to_visible_feedback',
  scaleSample: 'scale_sample_to_visible_grams',
  confirmToLogging: 'confirmation_to_logging_state',
  repositoryToDashboard: 'repository_result_to_dashboard',
  activationToDashboard: 'user_activation_to_private_dashboard',
} as const;
