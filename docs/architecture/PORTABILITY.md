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
