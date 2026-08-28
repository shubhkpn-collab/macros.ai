# 34 — RT-2 Tablet Renderer and Composition

> **RT-2 TABLET RENDERER — ENGINEERING COMPLETE (JS/TS VALIDATED)**
> **RT-2 PRODUCTION COMPOSITION — ENGINEERING COMPLETE**
> **REAL ANDROID EXECUTION — PENDING OWNER RUN**

## 1. Where the line is drawn

```
domain / application state  →  @macros/tablet-view-model  →  React Native
```

The view model decides **what is shown**. Components decide only how it looks.

That split is not stylistic. A component that can do arithmetic can disagree
with the food log, and the log is the truth — a discrepancy would be invisible
until someone noticed their day did not add up. `tools/check-renderer-purity.ts`
fails the build on arithmetic over `kcal`, `proteinG`, `carbohydrateG`, `fatG`
or `balanceKcal` anywhere under `apps/`, and on any import of a nutrition,
energy, macro, loop or persistence package.

The view model is plain TypeScript with no React Native import, so it is covered
by the root `npm run verify` and is where every behavioural test runs.

## 2. Why the RN app is a separate workspace

`react-native` could not be installed here — the sandbox has no npm registry
access. Rather than fake a native build, `apps/tablet` has its own
`tsconfig.json` and is excluded from the root one.

The consequence is stated plainly: **root verification proves the view model,
the guards and every interaction rule. It does not prove the native app
compiles.** That happens on the owner's Mac.

## 3. Information architecture

| Tier | Content |
|---|---|
| Top | active household user · voice presence |
| **Primary** | **current energy balance**, e.g. `-327` with *"327 kcal deficit right now"* |
| Subordinate | projection: *"If no more food: -800 kcal"* |
| Secondary | protein / carbs / fat — consumed, goal, remaining |
| Tertiary | today's foods, offline status |

"Calories remaining" is deliberately **not** the primary concept, and a test
asserts the phrasing never uses it.

## 4. Kitchen usability

72pt minimum touch targets — roughly double a phone's — for a fingertip that may
be wet or greasy. 96pt hero type legible from two to four feet. One dominant
action per screen. Portrait only, `keepScreenOn`, no hamburger navigation, no
dense tables, nothing important behind hover.

## 5. Voice presence, not a transcript

A restrained aura and one line of terse copy. Ten application states map to
fixed strings (*"Place it on the scale"*, *"Logged"*). A scrolling conversation
would dominate a screen whose job is to show one number clearly — this is a
calculator with a personality, not a chatbot.

## 6. Safety rules the renderer enforces

- **Locked state** is built by `lockedViewModel()` **without reading app state
  at all**, so there is no field of the previous occupant's day available to
  leak. Pruning an active model would have left that one refactor away.
- **Unstable weight** is displayed but not committable; `canCommitWeight`
  requires a settled candidate *and* no pending scale clear after a user switch.
- **Option labels** are carried through verbatim, so spoken "Option B" and the
  B on screen are the same B by construction.
- **A stays visible** — identity and dashboard — for the whole of B's
  authentication.
- **Offline copy never claims persistence**: "waiting to sync", never "saved".
- The **session generation is adopted**, never minted.

## 7. Composition and remaining ports

`apps/tablet/src/composition.ts` wires the real `TabletAppController`,
`SharedDeviceAuthCoordinator` and offline capabilities. Three ports remain,
declared at the boundary so what is real and what is not stays obvious:

| Port | Awaiting |
|---|---|
| `voiceInput` | physical mic, wake word, STT |
| `scaleTransport` | Android BLE radio (`scale-protocol` itself is real) |
| `connectivity` | live reachability signal |

No component contains a stub pretending to be a device.

## 8. Performance instrumentation

`TransitionTimer` records real elapsed time for five named transitions: voice
feedback, scale sample to visible grams, confirmation to logging, repository
result to dashboard, activation to private dashboard. Development only — no
production timing is claimed until it runs on hardware.

## 9. Owner execution

Deterministic. The owner never chooses which Gradle files to copy — the
hydration script does that from the official template.

```bash
# 1. Root workspace
cd ~/macros-local
npm ci
npm run verify                        # expect 1611 tests, 0 failures

# 2. Generate the native Android shell (requires network)
node tools/hydrate-android-shell.mjs

# 3. Tablet dependencies and the FIRST real compile of the RN sources
cd apps/tablet
npm install                           # generates apps/tablet/package-lock.json
npm run typecheck
```

`apps/tablet/package-lock.json` is **not** gitignored: commit it once typecheck
and the native launch are green.

### What hydration does

Generates React Native **0.81.1** via **@react-native-community/cli 20.0.1**
(`--pm npm`, `--skip-install`, `--install-pods false`) in a scratch directory,
syncs the **complete** Android shell — Gradle wrapper, `settings.gradle`,
`build.gradle`, `MainActivity`, `MainApplication` — then verifies the
MACROS-owned `AndroidManifest.xml` survived byte-for-byte and removes the
scratch directory. It is idempotent and **refuses to overwrite** MACROS-owned
files rather than clobbering the portrait lock and `keepScreenOn`.

### Android Studio (free)

Download from `developer.android.com/studio`, then in **SDK Manager** install:

- **Android SDK Platform 35**
- **Android SDK Build-Tools 36.0.0**
- **JDK 17** (recommended for RN 0.81)

```bash
export ANDROID_HOME="$HOME/Library/Android/sdk"
export PATH="$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH"
```

### Emulator — 13" portrait tablet

**Device Manager → Create Virtual Device**. A large tablet profile (Pixel
Tablet is the closest stock device), or a custom hardware profile at
`1600 x 2560`, `~240 dpi`. Start it and rotate to **portrait**.

The emulator profile is a *display* choice and is independent of the
Platform/Build-Tools versions above, which are compile requirements.

### Launch

```bash
cd ~/macros-local/apps/tablet
npm start                             # Metro, leave running
# second terminal:
npm run android
```

### Metro monorepo resolution

`metro.config.js` sets `resolver.enableGlobalPackages = true` with the workspace
in `watchFolders`, so `@macros/*` resolves by package name. This repository is
**not** an npm workspace and there are no root symlinks for Metro to follow;
`watchFolders` alone would make the source visible but not resolvable. The
app's own `node_modules` is listed first so React and React Native resolve from
one place — two copies of React in a bundle is a crash, not a warning.

### Development host

The renderer currently launches against a **development host**: in-memory
repositories, synthetic fixtures, no real account, and a permanent on-screen
banner. It is RN-safe by construction — it imports no `@macros/testkit` and no
Node built-in, because Metro cannot bundle `node:fs`.

**Nothing here has been executed.** If the first launch fails, send the error
and I will fix it rather than guess.
