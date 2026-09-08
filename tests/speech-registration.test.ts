import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  REGISTRATION, countRegistrations, registerSpeechPackage,
} from '../tools/register-speech-package.mjs';
import { repoPath } from '../tools/repo-paths.js';

const read = (...p: string[]): string => readFileSync(repoPath(...p), 'utf8');

/** A representative RN 0.81 MainApplication, trimmed to the relevant shape. */
const TEMPLATE = `package com.macrostablet

import com.facebook.react.PackageList
import com.facebook.react.ReactApplication

class MainApplication : Application(), ReactApplication {
  override val reactNativeHost: ReactNativeHost =
    object : DefaultReactNativeHost(this) {
      override fun getPackages(): List<ReactPackage> =
        PackageList(this).packages.apply {
          // Packages that cannot be autolinked yet can be added manually here
        }
    }
}
`;

describe('DEMO — native speech registration', () => {
  test('a clean template gets exactly one registration', () => {
    const result = registerSpeechPackage(TEMPLATE);
    assert.equal(result.ok, true);
    assert.equal(result.changed, true);
    assert.equal(countRegistrations(result.source ?? ''), 1);
    // Inserted inside the package list, not appended somewhere harmless.
    assert.ok((result.source ?? '').indexOf(REGISTRATION)
      > (result.source ?? '').indexOf('PackageList(this).packages.apply'));
  });

  test('hydrating twice still leaves exactly one', () => {
    const once = registerSpeechPackage(TEMPLATE);
    assert.equal(once.ok, true);
    const twice = registerSpeechPackage(once.source ?? '');
    assert.equal(twice.ok, true);
    assert.equal(twice.changed, false, 'a second hydrate must be a no-op');
    assert.equal(countRegistrations(twice.source ?? ''), 1);
  });

  test('an unexpected template shape FAILS rather than no-ops', () => {
    // A silent skip here would ship a build with no voice, which is exactly the
    // failure the owner hit on device.
    const result = registerSpeechPackage('class MainApplication { }');
    assert.equal(result.ok, false);
    assert.match(result.reason ?? '', /PackageList/);
  });

  test('a pre-duplicated file is reported, not compounded', () => {
    const doubled = (registerSpeechPackage(TEMPLATE).source ?? '')
      .replace(REGISTRATION, `${REGISTRATION}\n              ${REGISTRATION}`);
    const result = registerSpeechPackage(doubled);
    assert.equal(result.ok, false);
    assert.match(result.reason ?? '', /2 existing registrations/);
  });

  test('no import is added — the package is in the same namespace', () => {
    const result = registerSpeechPackage(TEMPLATE);
    assert.equal((result.source ?? '').includes('import com.macrostablet.MacrosSpeechPackage'), false);
  });
});

describe('DEMO — the hydration script owns one registration step', () => {
  test('the script has exactly one registration implementation', () => {
    const script = read('tools', 'hydrate-android-shell.mjs');
    // It was duplicated three times, and two copies ran before the sync.
    assert.equal((script.match(/registerSpeechPackage\(/g) ?? []).length, 1);
    assert.equal(script.includes('add(MacrosSpeechPackage())'), false,
      'the literal belongs in the helper, not inline');
  });

  test('registration runs AFTER the template sync', () => {
    const script = read('tools', 'hydrate-android-shell.mjs');
    // Syncing replaces MainApplication.kt, so patching first was overwritten —
    // which is why NativeModules.MacrosSpeech was null.
    assert.ok(script.indexOf('Syncing native Android shell')
      < script.indexOf('registerSpeechPackage('));
  });

  test('the result is COUNTED, not merely present', () => {
    const script = read('tools', 'hydrate-android-shell.mjs');
    assert.match(script, /countRegistrations\(readFileSync\(mainApp, 'utf8'\)\)/);
    assert.match(script, /registrations !== 1/);
  });

  test('the native speech files are tracked and preserved', async () => {
    const { execFileSync } = await import('node:child_process');
    const tracked = execFileSync('git', ['ls-files'], { encoding: 'utf8' });
    assert.match(tracked, /MacrosSpeechModule\.kt/);
    assert.match(tracked, /MacrosSpeechPackage\.kt/);

    const script = read('tools', 'hydrate-android-shell.mjs');
    assert.match(script, /MacrosSpeechModule\.kt/);
    assert.match(script, /MacrosSpeechPackage\.kt/);
  });

  test('the module name matches what the adapter looks up', () => {
    const kotlin = read('apps', 'tablet', 'android', 'app', 'src', 'main', 'java',
      'com', 'macrostablet', 'MacrosSpeechModule.kt');
    assert.match(kotlin, /getName\(\) = "MacrosSpeech"/);
    const adapter = read('apps', 'tablet', 'src', 'voice', 'native-speech.ts');
    assert.match(adapter, /MacrosSpeech\?: NativeSpeech/);
  });
});
