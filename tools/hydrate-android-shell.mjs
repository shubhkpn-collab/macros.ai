#!/usr/bin/env node
/**
 * ANDROID NATIVE SHELL HYDRATION.
 *
 * The repository does NOT contain a generated Android project — it could not
 * be, because `react-native` cannot be installed in the authoring sandbox.
 * Rather than ask the owner to guess which Gradle files to copy after a failed
 * build, this generates the official RN 0.81.1 template in a scratch directory
 * and syncs the complete native shell across.
 *
 * PROPERTIES:
 *   - idempotent: safe to re-run; already-correct files are left alone
 *   - REFUSES to overwrite MACROS-specific files (the manifest above all)
 *   - removes the scratch directory on success
 *   - fails loudly rather than half-hydrating
 *
 * Run from anywhere:  node tools/hydrate-android-shell.mjs
 */
import { execFileSync } from 'node:child_process';
import {
  cpSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const APP_DIR = join(REPO_ROOT, 'apps', 'tablet');
const ANDROID_DIR = join(APP_DIR, 'android');

const RN_VERSION = '0.81.1';
const CLI_VERSION = '20.0.1';
const APP_NAME = 'MacrosTablet';

/**
 * Files this repository owns. The template also produces them, so hydration
 * must never clobber them — the manifest carries the portrait lock and
 * keepScreenOn that make this a kitchen appliance rather than a phone app.
 */
const MACROS_OWNED = [
  'android/app/src/main/AndroidManifest.xml',
  // Debug-only local cleartext policy. The RN template ships its own debug
  // manifest, so these must survive hydration or the acceptance run silently
  // loses its network permission.
  'android/app/src/debug/AndroidManifest.xml',
  'android/app/src/debug/res/xml/network_security.xml',
  // MACROS-owned native modules. The RN template does not create these, and a
  // hydrate that dropped them would silently remove voice from the build.
  'android/app/src/main/java/com/macrostablet/MacrosSpeechModule.kt',
  'android/app/src/main/java/com/macrostablet/MacrosSpeechPackage.kt',
];

const say = (m) => console.log(m);
const fail = (m) => { console.error(`\nHYDRATION FAILED: ${m}`); process.exit(1); };

if (!existsSync(APP_DIR)) fail(`apps/tablet not found at ${APP_DIR}`);

// --- 1. Verify the owned files are present and record their content --------
const owned = new Map();
for (const rel of MACROS_OWNED) {
  const abs = join(APP_DIR, rel);
  if (!existsSync(abs)) fail(`expected MACROS-owned file is missing: ${rel}`);
  owned.set(rel, readFileSync(abs, 'utf8'));
}
say(`Protected MACROS-owned files: ${MACROS_OWNED.length}`);

// --- 2. Generate the official template in a scratch directory --------------
const scratch = mkdtempSync(join(tmpdir(), 'macros-rn-'));
say(`Generating React Native ${RN_VERSION} template in ${scratch} …`);
try {
  execFileSync('npx', [
    `@react-native-community/cli@${CLI_VERSION}`, 'init', APP_NAME,
    '--version', RN_VERSION,
    '--directory', join(scratch, APP_NAME),
    // --pm npm: do not depend on whichever package manager happens to be
    // installed on the owner's machine.
    '--pm', 'npm',
    '--skip-install', '--skip-git-init', '--install-pods', 'false',
  ], { stdio: 'inherit' });
} catch (e) {
  // --- 6. Register the MACROS speech package in the GENERATED MainApplication --
//
// The RN template writes MainApplication.kt, so MACROS cannot simply own the
// file. Patching it here means the owner never edits generated Kotlin before a
// demo, and a missed manual edit cannot silently remove voice from the build.
const mainApp = join(APP_DIR, 'android/app/src/main/java/com/macrostablet/MainApplication.kt');
if (!existsSync(mainApp)) {
  fail(`hydration incomplete — MainApplication.kt not generated at ${mainApp}`);
}

let mainSource = readFileSync(mainApp, 'utf8');
const REGISTRATION = 'add(MacrosSpeechPackage())';

if (mainSource.includes(REGISTRATION)) {
  // Idempotent: a second hydrate must not register the package twice.
  say('MainApplication already registers MacrosSpeechPackage — left unchanged.');
} else {
  /**
   * The template's getPackages() returns the autolinked list and then adds
   * manual packages inside an apply block. Anchoring on that comment is how the
   * upstream template documents the insertion point.
   */
  const anchor = /(PackageList\(this\)\.packages\.apply\s*\{)/;
  if (!anchor.test(mainSource)) {
    fail('hydration cannot register MacrosSpeechPackage: MainApplication.kt '
      + 'does not match the expected RN template shape. Inspect it manually '
      + 'rather than letting the build ship without voice.');
  }
  mainSource = mainSource.replace(anchor,
    `$1\n              // MACROS speech bridge (STT + TTS). Registered by\n`
    + `              // tools/hydrate-android-shell.mjs; do not edit by hand.\n`
    + `              ${REGISTRATION}`);
  writeFileSync(mainApp, mainSource);
  say('MainApplication patched to register MacrosSpeechPackage.');
}

// Prove it, rather than assuming the replace worked.
if (!readFileSync(mainApp, 'utf8').includes(REGISTRATION)) {
  fail('MacrosSpeechPackage registration missing after patch');
}

rmSync(scratch, { recursive: true, force: true });
  fail(`template generation failed — is the network reachable? (${String(e).slice(0, 120)})`);
}

const templateAndroid = join(scratch, APP_NAME, 'android');
if (!existsSync(templateAndroid)) {
  // --- 6. Register the MACROS speech package in the GENERATED MainApplication --
//
// The RN template writes MainApplication.kt, so MACROS cannot simply own the
// file. Patching it here means the owner never edits generated Kotlin before a
// demo, and a missed manual edit cannot silently remove voice from the build.
const mainApp = join(APP_DIR, 'android/app/src/main/java/com/macrostablet/MainApplication.kt');
if (!existsSync(mainApp)) {
  fail(`hydration incomplete — MainApplication.kt not generated at ${mainApp}`);
}

let mainSource = readFileSync(mainApp, 'utf8');
const REGISTRATION = 'add(MacrosSpeechPackage())';

if (mainSource.includes(REGISTRATION)) {
  // Idempotent: a second hydrate must not register the package twice.
  say('MainApplication already registers MacrosSpeechPackage — left unchanged.');
} else {
  /**
   * The template's getPackages() returns the autolinked list and then adds
   * manual packages inside an apply block. Anchoring on that comment is how the
   * upstream template documents the insertion point.
   */
  const anchor = /(PackageList\(this\)\.packages\.apply\s*\{)/;
  if (!anchor.test(mainSource)) {
    fail('hydration cannot register MacrosSpeechPackage: MainApplication.kt '
      + 'does not match the expected RN template shape. Inspect it manually '
      + 'rather than letting the build ship without voice.');
  }
  mainSource = mainSource.replace(anchor,
    `$1\n              // MACROS speech bridge (STT + TTS). Registered by\n`
    + `              // tools/hydrate-android-shell.mjs; do not edit by hand.\n`
    + `              ${REGISTRATION}`);
  writeFileSync(mainApp, mainSource);
  say('MainApplication patched to register MacrosSpeechPackage.');
}

// Prove it, rather than assuming the replace worked.
if (!readFileSync(mainApp, 'utf8').includes(REGISTRATION)) {
  fail('MacrosSpeechPackage registration missing after patch');
}

rmSync(scratch, { recursive: true, force: true });
  fail('the generated template contains no android/ directory');
}

// --- 3. Sync the native shell, refusing to touch owned files ---------------
say('Syncing native Android shell …');
let copied = 0;
let skipped = 0;
cpSync(templateAndroid, ANDROID_DIR, {
  recursive: true,
  filter: (src) => {
    if (statSync(src).isDirectory()) return true;
    const rel = join('android', relative(templateAndroid, src)).split('\\').join('/');
    if (owned.has(rel)) {
      // Refuse rather than overwrite. This is the whole point of the script.
      skipped += 1;
      return false;
    }
    copied += 1;
    return true;
  },
});

// --- 4. Prove the owned files survived byte-for-byte -----------------------
for (const [rel, before] of owned) {
  const after = readFileSync(join(APP_DIR, rel), 'utf8');
  if (after !== before) {
    fail(`MACROS-owned file was modified during hydration: ${rel}`);
  }
}

// --- 5. Verify the shell is actually buildable-looking ---------------------
const REQUIRED = [
  'android/gradlew',
  'android/settings.gradle',
  'android/build.gradle',
  'android/app/build.gradle',
];
const missing = REQUIRED.filter((r) => !existsSync(join(APP_DIR, r)));
if (missing.length > 0) {
  fail(`hydration incomplete — missing: ${missing.join(', ')}`);
}

// --- 6. Register the MACROS speech package in the GENERATED MainApplication --
//
// The RN template writes MainApplication.kt, so MACROS cannot simply own the
// file. Patching it here means the owner never edits generated Kotlin before a
// demo, and a missed manual edit cannot silently remove voice from the build.
const mainApp = join(APP_DIR, 'android/app/src/main/java/com/macrostablet/MainApplication.kt');
if (!existsSync(mainApp)) {
  fail(`hydration incomplete — MainApplication.kt not generated at ${mainApp}`);
}

let mainSource = readFileSync(mainApp, 'utf8');
const REGISTRATION = 'add(MacrosSpeechPackage())';

if (mainSource.includes(REGISTRATION)) {
  // Idempotent: a second hydrate must not register the package twice.
  say('MainApplication already registers MacrosSpeechPackage — left unchanged.');
} else {
  /**
   * The template's getPackages() returns the autolinked list and then adds
   * manual packages inside an apply block. Anchoring on that comment is how the
   * upstream template documents the insertion point.
   */
  const anchor = /(PackageList\(this\)\.packages\.apply\s*\{)/;
  if (!anchor.test(mainSource)) {
    fail('hydration cannot register MacrosSpeechPackage: MainApplication.kt '
      + 'does not match the expected RN template shape. Inspect it manually '
      + 'rather than letting the build ship without voice.');
  }
  mainSource = mainSource.replace(anchor,
    `$1\n              // MACROS speech bridge (STT + TTS). Registered by\n`
    + `              // tools/hydrate-android-shell.mjs; do not edit by hand.\n`
    + `              ${REGISTRATION}`);
  writeFileSync(mainApp, mainSource);
  say('MainApplication patched to register MacrosSpeechPackage.');
}

// Prove it, rather than assuming the replace worked.
if (!readFileSync(mainApp, 'utf8').includes(REGISTRATION)) {
  fail('MacrosSpeechPackage registration missing after patch');
}

rmSync(scratch, { recursive: true, force: true });

say('');
say(`Android shell hydrated: ${copied} file(s) copied, ${skipped} MACROS-owned file(s) preserved.`);
say('Scratch directory removed.');
say('');
say('Next:');
say('  cd apps/tablet && npm install && npm run typecheck');
say('');
say('Voice: MacrosSpeechPackage is registered automatically. No manual edit.');
