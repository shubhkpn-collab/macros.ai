/**
 * REMOTE GUIDANCE ACCEPTANCE CONFIGURATION.
 *
 * Lives at the acceptance composition edge, never in product or domain code.
 * `10.0.2.2` is how the Android emulator reaches the host machine; a physical
 * device on the same network would use the machine's LAN address instead.
 */
export const ACCEPTANCE_VERSION = 'guidance-acceptance-config@1.0.0';

/** The MACROS backend. Never a vendor endpoint. */
export const ACCEPTANCE_API_BASE_URL = 'http://10.0.2.2:8787';

export const ACCEPTANCE_BANNER =
  'DEVELOPMENT · REMOTE GUIDANCE ACCEPTANCE — synthetic data, no real account';

/**
 * A deterministic development credential shared with the acceptance backend.
 *
 * Not a vendor key, but it gets the same handling discipline: the backend never
 * prints it and it never enters a log. A credential in terminal output is a
 * credential in a scrollback, a screenshot and a bug report.
 */
const ACCEPTANCE_TOKEN = 'acceptance-session-token';

export const acceptanceBearerToken = (): string => ACCEPTANCE_TOKEN;
