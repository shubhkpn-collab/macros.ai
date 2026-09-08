/**
 * MACROS speech package registration.
 *
 * Extracted from the hydration script so the logic can be tested against a
 * template fixture without downloading React Native — the previous inline
 * version was duplicated three times and two copies ran BEFORE the template
 * sync, so their work was overwritten and the native module came back null on
 * the device.
 *
 * Pure: source in, source out. The caller does the file I/O.
 */
export const REGISTRATION = 'add(MacrosSpeechPackage())';

/** Counts registrations. Presence is not enough — a duplicate must also fail. */
export function countRegistrations(source) {
  return source.split(REGISTRATION).length - 1;
}

/**
 * Insert the registration into the template's package list.
 *
 * `MacrosSpeechPackage` lives in the same `com.macrostablet` package as
 * MainApplication, so Kotlin resolves it without an import.
 *
 * Returns `{ ok: false }` rather than throwing when the template does not
 * match: the caller decides how loudly to fail, and a silent no-op here would
 * ship a build with no voice.
 */
export function registerSpeechPackage(source) {
  const existing = countRegistrations(source);
  if (existing === 1) return { ok: true, changed: false, source };
  if (existing > 1) {
    return { ok: false, reason: `found ${existing} existing registrations` };
  }

  const anchor = /(PackageList\(this\)\.packages\.apply\s*\{)/;
  if (!anchor.test(source)) {
    return {
      ok: false,
      reason: 'no PackageList(this).packages.apply { block was found',
    };
  }

  const patched = source.replace(anchor,
    `$1\n              // MACROS speech bridge (STT + TTS). Registered by\n`
    + `              // tools/hydrate-android-shell.mjs; do not edit by hand.\n`
    + `              ${REGISTRATION}`);

  // Replace once only; a second match would double-register.
  if (countRegistrations(patched) !== 1) {
    return { ok: false, reason: 'patch produced an unexpected registration count' };
  }
  return { ok: true, changed: true, source: patched };
}
