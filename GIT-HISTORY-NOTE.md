# Git history note — 2026-08-20

The container filesystem was reset between sessions and `/home/claude/macros`
was destroyed, **including `.git`**.

The source tree survived only because it had been copied to the deliverable
directory — and that copy was made with `--exclude=.git`, so **the commit
history (`f742ffd` … `006f6e2`) is unrecoverable.**

The tree was restored from that copy and re-verified before any new work:

```
purity     OK (17 production packages, 10 pure)
typecheck  0 errors
tests      644 passed, 162 suites, 0 failures
```

Those figures match the last closure report exactly, so the restored content is
the same code — but the history is genuinely gone and is not reconstructed here.
This repository starts again from a single baseline commit.

**Process change:** the packaged deliverable must stop excluding `.git`, so a
container reset cannot destroy history again.
