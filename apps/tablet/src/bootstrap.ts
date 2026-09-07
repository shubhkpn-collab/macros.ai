import type { TabletComposition } from './composition.js';
import type { AuthHostPort } from './actions.js';

/**
 * NATIVE BOOTSTRAP BOUNDARY.
 *
 * `AppRegistry.registerComponent(name, () => App)` renders `App` with no props,
 * but `App` requires a composition and an auth host — so the previous entry
 * point would have crashed on destructuring before drawing a pixel.
 *
 * There are two distinct things here, and conflating them is how a demo ends up
 * shipping:
 *
 *   A. `TabletHostFactory` — the PRODUCTION contract. A real host builds the
 *      controller against real repositories, the coordinator against the real
 *      Supabase provider, and the ports against real hardware.
 *
 *   B. `developmentHost()` — a DEVELOPMENT-ONLY fixture host that makes the
 *      renderer launchable on an emulator today. It is not persistence, not
 *      authentication and not hardware, and it says so on screen.
 */
export const BOOTSTRAP_VERSION = 'tablet-bootstrap@1.0.0';

export interface TabletHost {
  readonly composition: TabletComposition;
  readonly auth: AuthHostPort;
  readonly hasActiveSession: boolean;
  /**
   * Non-null ONLY for a development host. The shell renders it as a persistent
   * banner, so a fixture build can never be mistaken for a real one.
   */
  readonly developmentNotice: string | null;
  /**
   * Catalog QA browser. Present ONLY on a development host — a production host
   * returns null, so the surface cannot appear in a shipped configuration.
   */
  /** Guidance dependencies for the host. Absent disables the guidance intent. */
  readonly guidance?: unknown;
  readonly catalogBrowser: {
    search(query: string): Promise<readonly unknown[]>;
  } | null;
}

/**
 * The production seam. Implemented in a later milestone, when repositories,
 * credentials and hardware adapters exist on the device.
 */
export type TabletHostFactory = () => Promise<TabletHost>;

/**
 * A host that cannot pretend to be production.
 *
 * It refuses member selection with an explicit reason rather than silently
 * doing nothing, because the native credential surface does not exist yet —
 * and an honest refusal is what tells the owner that.
 */
export function developmentAuthHost(): AuthHostPort {
  return {
    credentialSurfaceAvailable: false,
    beginMemberSelection: async () => ({
      kind: 'refused',
      reason: 'native_credential_surface_unavailable',
    }),
  };
}
