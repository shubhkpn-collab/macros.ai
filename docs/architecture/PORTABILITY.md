# Repository portability

The same checkout must run identically on a Linux sandbox, on macOS and in CI.

## What went wrong

Tests resolved architecture documents through absolute authoring-environment
paths (`/mnt/user-data/outputs/...`). They passed where they were written and
failed with `ENOENT` the moment the repository was cloned onto a real machine.
The defect was invisible until someone ran it elsewhere.

## Canonical locations

| Concern | Location |
|---|---|
| Architecture documents | `docs/architecture/` (tracked) |
| Path helpers | `tools/repo-paths.ts`, `tools/repo_paths.py` |
| Source archives | `data/sources/` (gitignored) or `MACROS_SOURCE_DIR` |

Paths resolve from `import.meta.url` / `__file__`, **not** `process.cwd()` —
the working directory varies by how a tool is invoked; a module's position in
the repository does not.

## Generated documentation

`tools/gen-catalog-doc.ts` writes to `docs/architecture/` by default, creating
the directory if needed. `MACROS_DOCS_OUT` optionally redirects an artifact
export. A plain checkout works with **no environment variable set**, and tests
never depend on the override.

## Source archives

USDA archives are multi-GB and stay out of Git. Point the tooling at them:

```bash
export MACROS_SOURCE_DIR=~/Downloads/usda
```

## Guard

`npm run check:portability` fails the build if executable source or config under
`tests/`, `tools/`, `packages/`, `db/`, `apps/` or `scripts/` requires
`/mnt/user-data`, `/home/claude` or `/Users/...`. It runs as part of
`npm run verify`.

Prose and recorded ingestion provenance are deliberately exempt: history is
evidence, and rewriting it to satisfy a linter would falsify the record.


## Toolchain reproducibility

`package.json` once declared scripts that invoke `tsc` and `tsx` but declared no
devDependencies. A fresh clone therefore had to guess: a Mac installing "latest"
received a TypeScript generation that had **removed** `baseUrl`, and `npm run
typecheck` failed with `TS5102` plus 28 `TS5090` errors on every `paths` entry —
while the authoring environment passed. Same commit, different result.

### Declared tooling

| Tool | Pin |
|---|---|
| `typescript` | `6.0.3` (exact) |
| `tsx` | `4.21.0` (exact) |
| `@types/node` | `25.6.0` (exact) |
| Node | `>=22.0.0` (`engines`, `.nvmrc`) |

Exact pins, not ranges: a caret would reproduce the same class of drift.

### Install policy

```bash
npm ci        # preferred once package-lock.json exists
npm install   # generates the lockfile; commit it
```

**No global `tsc` or `tsx` is required.** All scripts resolve binaries from the
repository's `node_modules`.

> **`package-lock.json` is now committed.** The September 30, 2026 recovery generated it against the npm registry, with resolved URLs and integrity hashes. Use `npm ci` for reproducible root installs. The tablet app remains a separate install.

### tsconfig decision

Modernized rather than pinned. `baseUrl` was removed and all 28 `paths` targets
made relative (`./packages/...`), which is the form supported by **both** the
current and newer compiler generations. `ignoreDeprecations: "6.0"` — the escape
hatch that was keeping `baseUrl` alive — is gone, since nothing deprecated
remains. Pinning to an older compiler would have preserved a config already on a
removal path.

Verified: all 28 aliases still resolve, all 25 packages pass the purity check,
and the full suite passes. `npm run check:toolchain` fails the build if the
installed tooling drifts from what is declared.
