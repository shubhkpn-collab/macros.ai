import { developmentAuthHost } from './bootstrap.js';
import { createDevelopmentHost } from './development-host.js';
import type { TabletHost } from './bootstrap.js';

/**
 * DEFAULT host selection: synthetic guidance, no backend required.
 *
 * `npm run android` resolves to this file. The acceptance variant is selected
 * by Metro at build time — see metro.config.js — so which host boots is decided
 * by WHICH COMMAND was run, never by editing a source file before or after a
 * test run.
 */
export const HOST_SELECTION = 'synthetic' as const;

export function createSelectedHost(): Promise<TabletHost> {
  return createDevelopmentHost({ auth: developmentAuthHost() });
}
