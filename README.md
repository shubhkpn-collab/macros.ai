# MACROS.AI

A nutrition and food-logging project with a React Native Android tablet interface, deterministic nutrition and energy calculations, food catalog search, scale capture, voice orchestration, and AI guidance.

This repository restores the existing Claude-developed project from the downloaded Git bundles. The selected baseline is `67b7df23` from `macros-reference-home.bundle`.

## Install and verify

Requires Node.js 22 or newer and npm 10 or newer.

```sh
npm ci
npm run verify
```

The root verification covers the core TypeScript code and tests. The Android app has a separate dependency installation and build process.

## Project layout

| Directory | Contents |
| --- | --- |
| `apps/tablet/` | React Native tablet UI and Android integration |
| `packages/` | Nutrition, energy, food logging, catalogs, authentication, persistence, scale, voice, and AI guidance modules |
| `db/migrations/` | PostgreSQL schema migrations |
| `tests/` | Core, contract, orchestration, and regression tests |
| `tools/` | Validation, catalog ingestion, Android setup, and demo tools |
| `docs/architecture/` | Architecture, product decisions, and development reports |
| `data/` | Tracked fixtures and catalog manifests |

## Tablet and investor demo

See [tablet setup](apps/tablet/README.md) before building the Android application. The existing demo runner is:

```sh
npm run investor:demo
```

It needs the Android SDK and an emulator, the `macros_dev` PostgreSQL database, and Anthropic and OpenAI API credentials. It uses live services and can incur provider charges. The runner requests missing keys with hidden input. Keep credentials out of Git.

Core checks passing do not establish that the Android build, hardware scale, live database, authentication, or AI providers work on a new machine. These require their own acceptance runs.

## Data and decisions

Large USDA source archives and generated catalogs are intentionally excluded from Git; see [source data](data/sources/README.md). Existing constraints and unresolved decisions are retained in [DEFERRED-DECISIONS.md](DEFERRED-DECISIONS.md) and [the architecture decision lock](docs/architecture/DECISION-LOCK.md).

The canonical energy equation is `BMR + ACTIVE ENERGY + TEF`. Existing policy and completeness gates remain part of the recovered code.

## Recovery and verification

See [repository recovery](docs/REPOSITORY-RECOVERY.md) for the chosen snapshot, alternate histories, and validation scope. No license has been added; repository publication alone does not grant an open-source license.

### Kitchen voice on Android (USB preview)

See [the kitchen voice setup guide](docs/voice/KITCHEN-SETUP.md) for the private Mac backend, project API key setup, and phone test steps. The voice assistant reads synthetic demo state; food logging still uses the existing confirmation flow.
