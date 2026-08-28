# MACROS.AI tablet app (RT-2)

React Native renderer for the 13.3" portrait kitchen appliance.

## Why this is a separate workspace

`react-native` could not be installed in the authoring sandbox (no npm registry
access), so this app is **excluded from the root `tsconfig.json`** and has its
own. That keeps `npm run verify` honest: it typechecks and tests everything that
can actually run here, and does not pretend the native layer compiled.

All decision logic lives in `@macros/tablet-view-model`, which IS covered by the
root verification. The components below only render it.

## Owner setup

```bash
cd apps/tablet
npm install          # generates apps/tablet/package-lock.json (tracked — commit once green)
npm run typecheck
```

Native shell (run from the repo root, requires network):

```bash
node tools/hydrate-android-shell.mjs
```

Full owner flow, SDK versions and emulator setup: `docs/architecture/34-tablet-renderer.md`.
