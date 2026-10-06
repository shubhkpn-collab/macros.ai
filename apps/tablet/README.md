# MACROS.AI Android tablet preview

The portrait tablet interface follows the supplied dark navy home and dashboard references: prismatic leaf orb, microphone, food cards, selected-state glow and progress rings. The dashboard shows actual logged portions and totals; reference-image numbers are not treated as nutrition data.

The preview supports catalog search, food selection, manual portion weight, review and confirmation, today's dashboard, and editing the energy goal adjustment. Food logs and effective-dated goal history survive app restarts through device-local AsyncStorage. Domain calculations and validation remain in the shared packages.

This is a development host with a synthetic catalog, simulated scale and no real account. Local demo storage is unencrypted. Physical Bluetooth scales, production authentication and live cloud guidance require their production adapters and configuration. Native voice uses the Android speech service when available; touch controls remain available.

Voice testing walkthrough: [tablet voice test](../../docs/tablet-voice-test.md).

## Installable preview

An ARM64 APK is provided separately as `macros-ai-tablet-preview.apk`. It includes its JavaScript bundle and runs without a development server. It is signed with the Android template's development key, not a Play Store release key.

## Build and verify

From the repository root:

```bash
npm ci
npm ci --prefix apps/tablet
npm run verify
npm run typecheck --prefix apps/tablet
node tools/hydrate-android-shell.mjs
```

With Java 17 and Android SDK configured:

```bash
apps/tablet/android/gradlew -p apps/tablet/android assembleRelease \
  -PreactNativeArchitectures=arm64-v8a \
  -Pkotlin.compiler.execution.strategy=in-process
```

The APK is at `apps/tablet/android/app/build/outputs/apk/release/app-release.apk`.
The shell is regenerated from the official React Native template and retains the project's native speech module. Native libraries use the shell's build-tools version. Generated shell files, dependency installations, local SDK paths and credentials are ignored by Git.

The tablet has a separate TypeScript configuration because it includes React Native dependencies; CI checks both the shared workspace and this renderer. See `docs/architecture/34-tablet-renderer.md` for the original hardware and host architecture.
