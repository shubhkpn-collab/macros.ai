# Repository recovery — September 30, 2026

## Sources and selection

Recovered the existing project from the owner's Downloads and Documents/MACROS.AI exports. Inspected 55 top-level Git bundles containing 76 advertised heads. The latest downloaded snapshot, `macros-reference-home.bundle`, contains the selected `master` head `67b7df23b2d291ead26dad4bea5f5dbb7aefdab4` and 466 tracked files.

Thirteen advertised heads were absent from that bundle's history. Those bundles were imported as local archive references and preserved in the recovery bundle. They include alternate AI, speech, and investor-demo work. They were not merged automatically: the selected source is a coherent, verified snapshot, while divergent work requires separate review.

The older numbered Documents folders contain earlier incremental exports. They were used to identify the project and progression; they were not overlaid onto the newer complete Git snapshot.

## Verification

The recovered snapshot passed `npm run verify` on macOS with Node.js 26.7.0:

- Toolchain and architecture guards passed.
- TypeScript typechecking passed.
- 2,204 tests passed, nine skipped, zero failures (2,213 total; 456 suites).

No Android build, emulator launch, live PostgreSQL/Supabase acceptance, physical scale, or paid AI/voice request was run. Claude desktop displayed the Macros.AI chat entry, but navigation failed; the complete chat was not read. This recovery therefore uses the actual exported source and history as evidence.

## Repository preparation

The stale Phase 0 README was replaced with current project setup and layout instructions. A root npm lockfile was generated using the project's existing pinned dependencies and is now tracked. A GitHub Actions workflow runs root verification on Node.js 22 for pushes and pull requests. The initial GitHub README commit is retained as a merge parent.

A credential-pattern scan of 1,803 recovered historical objects found no matching private-key, GitHub-token, AI-provider-key, or AWS-access-key patterns. This is a bounded pattern check, not a guarantee that every possible sensitive value was identified. Local credentials, dependencies, generated catalogs, and unrelated personal files are excluded.

Existing historical documentation sometimes describes earlier phases; it is retained as project history. The root README describes the recovered tree.
